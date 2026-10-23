/**
 * exec/processManager.mjs — Registry of long-lived sandbox processes.
 *
 * Backs the ProcessHandle abstraction so a process spawned by one HTTP request
 * stays reachable from subsequent requests targeting the same sandbox.
 *
 * Each entry holds:
 *   · processHandle (opaque string id, unique within a sandbox)
 *   · sandboxId (parent sandbox)
 *   · handle (EventEmitter from the backend with stdout/stderr/exit/error events
 *             and .write/.cancel/.kill methods — same shape as one-shot execProcess)
 *   · ring (event ring buffer for replay to late attachers)
 *   · listeners (set of SSE response objects currently attached)
 *   · status ("running" | "exited")
 *   · meta { command, args, startedAt, finishedAt, exitCode, signal, exitError }
 *
 * The registry survives across HTTP requests within a single sandbox-runtime
 * process. It does NOT survive process restart (which is intentional — when
 * sandbox-runtime restarts, all sandboxes are gone too, so the entries are
 * stale anyway).
 */

import { randomUUID } from "node:crypto";

import { config } from "../config.mjs";
import { log } from "../shared/log.mjs";
import { writeSseEvent, writeSseHeartbeat, writeSseHeaders, closeSse } from "../shared/sse.mjs";
import { touchActivity } from "../pool/manager.mjs";
import { SandboxError } from "../shared/error.mjs";

/** @type {Map<string, ProcessEntry>} keyed by `${sandboxId}:${processHandle}` */
const processes = new Map();
/** @type {Map<string, Set<string>>} sandboxId -> set of keys (for fast lookup by sandbox) */
const bySandbox = new Map();

function nowMs() { return Date.now(); }

function makeRing(maxBytes) {
  return { events: [], byteCount: 0, maxBytes, truncated: false };
}

function pushRing(ring, event) {
  const size = Buffer.byteLength(JSON.stringify(event));
  ring.events.push({ ...event, size });
  ring.byteCount += size;
  while (ring.byteCount > ring.maxBytes && ring.events.length > 0) {
    const dropped = ring.events.shift();
    ring.byteCount -= dropped.size;
    ring.truncated = true;
  }
}

function fanOut(entry, event) {
  for (const res of entry.listeners) {
    if (res.writableEnded) {
      entry.listeners.delete(res);
      continue;
    }
    writeSseEvent(res, { event: event.type, data: event, id: event.seq });
  }
}

function clearHeartbeat(entry) {
  if (entry.heartbeatTimer) {
    clearInterval(entry.heartbeatTimer);
    entry.heartbeatTimer = null;
  }
}

function scheduleHeartbeat(entry) {
  clearHeartbeat(entry);
  if (entry.status !== "running") return;
  const interval = Math.max(1000, config.exec.heartbeatMs);
  entry.heartbeatTimer = setInterval(() => {
    if (entry.status !== "running") {
      clearHeartbeat(entry);
      return;
    }
    if (nowMs() - entry.lastChunkAt < interval) return;
    const hb = { type: "heartbeat", seq: ++entry.seq, ts: nowMs() };
    pushRing(entry.ring, hb);
    fanOut(entry, hb);
    for (const res of entry.listeners) {
      writeSseHeartbeat(res);
    }
  }, interval);
  entry.heartbeatTimer.unref?.();
}

function key(sandboxId, processHandle) {
  return `${sandboxId}:${processHandle}`;
}

function finalize(entry, { exitCode, signal, error } = {}) {
  if (entry.status !== "running") return;
  entry.status = "exited";
  entry.meta.exitCode = exitCode === undefined ? null : exitCode;
  entry.meta.signal = signal || null;
  entry.meta.exitError = error || null;
  entry.meta.finishedAt = nowMs();
  clearHeartbeat(entry);
  const event = {
    type: "exit",
    seq: ++entry.seq,
    ts: entry.meta.finishedAt,
    code: entry.meta.exitCode,
    signal: entry.meta.signal,
    error: entry.meta.exitError,
    truncated: entry.ring.truncated
  };
  pushRing(entry.ring, event);
  fanOut(entry, event);
  for (const res of entry.listeners) {
    closeSse(res);
  }
  entry.listeners.clear();
}

/**
 * Register a freshly spawned long-lived process. The backend MUST provide a
 * handle that emits the same events as one-shot execProcess (stdout/stderr/
 * exit/error) and exposes .write/.cancel/.kill methods.
 */
export function registerLongLivedProcess({ sandboxId, handle, command, args }) {
  const processHandle = handle?.processHandle || `lproc-${randomUUID().slice(0, 8)}`;
  const k = key(sandboxId, processHandle);
  if (processes.has(k)) {
    throw new SandboxError("process_already_exists", `process ${processHandle} already registered`, 409);
  }

  const entry = {
    processHandle,
    sandboxId,
    status: "running",
    seq: 0,
    lastChunkAt: nowMs(),
    ring: makeRing(Math.max(64 * 1024, config.exec.ringBytes)),
    listeners: new Set(),
    handle,
    heartbeatTimer: null,
    meta: {
      command,
      args: Array.isArray(args) ? args.slice() : [],
      startedAt: nowMs(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      exitError: null
    }
  };

  processes.set(k, entry);
  let set = bySandbox.get(sandboxId);
  if (!set) {
    set = new Set();
    bySandbox.set(sandboxId, set);
  }
  set.add(k);

  const emit = (type, payload) => {
    const ev = { type, seq: ++entry.seq, ts: nowMs(), ...payload };
    entry.lastChunkAt = ev.ts;
    pushRing(entry.ring, ev);
    fanOut(entry, ev);
    try { touchActivity(sandboxId); } catch { /* sandbox may have been released */ }
  };

  handle.on("stdout", (chunk) => {
    emit("stdout", { data: Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk) });
  });
  handle.on("stderr", (chunk) => {
    emit("stderr", { data: Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk) });
  });
  handle.on("exit", (info = {}) => {
    finalize(entry, { exitCode: info.code, signal: info.signal, error: info.error });
  });
  handle.on("error", (err) => {
    log("warn", "lproc.handle_error", { processHandle, sandboxId, message: err?.message || String(err) });
  });

  // A short-lived "long-lived" process (or one that crashes on spawn) can emit
  // stdout/exit before the listeners above attach; replay buffered events so the
  // process doesn't stay stuck "running" with its exit lost.
  handle.drainBufferedEvents?.();

  scheduleHeartbeat(entry);
  log("info", "lproc.registered", { processHandle, sandboxId, command });
  return { processHandle, startedAt: entry.meta.startedAt };
}

export function getProcess(sandboxId, processHandle) {
  return processes.get(key(sandboxId, processHandle)) || null;
}

export function listProcesses(sandboxId) {
  const set = bySandbox.get(sandboxId);
  if (!set) return [];
  const out = [];
  for (const k of set) {
    const entry = processes.get(k);
    if (!entry) continue;
    out.push({
      processHandle: entry.processHandle,
      command: entry.meta.command,
      args: entry.meta.args,
      status: entry.status,
      startedAt: entry.meta.startedAt,
      finishedAt: entry.meta.finishedAt,
      exitCode: entry.meta.exitCode,
      signal: entry.meta.signal
    });
  }
  return out;
}

/**
 * Attach an SSE response stream. Replays the ring buffer first, then joins
 * live. If the process has already exited, replay + close.
 */
export function attachProcess(sandboxId, processHandle, res) {
  const entry = processes.get(key(sandboxId, processHandle));
  if (!entry) return null;
  writeSseHeaders(res);
  for (const event of entry.ring.events) {
    writeSseEvent(res, { event: event.type, data: event, id: event.seq });
  }
  if (entry.status === "exited") {
    closeSse(res);
    return entry;
  }
  entry.listeners.add(res);
  res.on("close", () => entry.listeners.delete(res));
  return entry;
}

/**
 * Write raw bytes to the process stdin. Errors if the process has exited.
 */
export function writeProcessStdin(sandboxId, processHandle, data) {
  const entry = processes.get(key(sandboxId, processHandle));
  if (!entry) {
    throw new SandboxError("process_not_found", `process ${processHandle} not found`, 404);
  }
  if (entry.status !== "running") {
    throw new SandboxError("process_exited", `process ${processHandle} has exited`, 409);
  }
  try {
    entry.handle.write(data);
  } catch (err) {
    throw new SandboxError("stdin_write_failed", `stdin write failed: ${err?.message || String(err)}`, 500);
  }
}

/**
 * Kill the process. SIGTERM then SIGKILL escalation handled by the backend
 * handle's .cancel()/.kill() method. Returns true if the process was running,
 * false if it had already exited or didn't exist.
 */
export function killProcess(sandboxId, processHandle) {
  const entry = processes.get(key(sandboxId, processHandle));
  if (!entry) return false;
  if (entry.status !== "running") return false;
  try {
    entry.handle?.cancel?.();
  } catch (err) {
    log("warn", "lproc.kill_failed", { processHandle, sandboxId, message: err?.message || String(err) });
  }
  // finalize is also invoked when the underlying child emits "exit", but cancel
  // signals "I asked for termination" which we record immediately so a client
  // GET sees the right status even if the OS hasn't reaped yet.
  finalize(entry, { exitCode: null, signal: "SIGTERM", error: "killed" });
  return true;
}

/**
 * Tear down every process belonging to a sandbox. Called from
 * pool/manager.mjs::releaseSandbox so processes don't leak past their parent.
 */
export function killAllForSandbox(sandboxId) {
  const set = bySandbox.get(sandboxId);
  if (!set) return 0;
  let killed = 0;
  for (const k of Array.from(set)) {
    const entry = processes.get(k);
    if (entry && entry.status === "running") {
      try { entry.handle?.cancel?.(); } catch { /* ignore */ }
      finalize(entry, { exitCode: null, signal: "SIGTERM", error: "sandbox_destroyed" });
      killed += 1;
    }
    processes.delete(k);
    set.delete(k);
  }
  if (set.size === 0) bySandbox.delete(sandboxId);
  return killed;
}

/**
 * Reap long-exited process entries to bound memory. Called from a periodic
 * timer in server.mjs (alongside gcFinishedExecs).
 */
export function gcExitedProcesses(maxAgeMs = 30 * 60 * 1000) {
  const cutoff = nowMs() - maxAgeMs;
  for (const [k, entry] of processes) {
    if (entry.status === "exited" && entry.meta.finishedAt && entry.meta.finishedAt < cutoff) {
      processes.delete(k);
      const set = bySandbox.get(entry.sandboxId);
      if (set) {
        set.delete(k);
        if (set.size === 0) bySandbox.delete(entry.sandboxId);
      }
    }
  }
}
