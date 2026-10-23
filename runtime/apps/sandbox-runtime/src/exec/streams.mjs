/**
 * exec/streams.mjs — Exec event registry, ring buffer, SSE fan-out.
 *
 * Core of the "long-running task without breaking SSE" promise. Every exec
 * has an execId-keyed registry entry. Backend events (stdout/stderr/exit) get
 * appended to a ring buffer AND fanned out to attached SSE listeners. Late
 * subscribers replay the ring before joining live. Heartbeats every N seconds
 * keep upstream proxies from killing idle SSE connections.
 */

import { randomUUID } from "node:crypto";

import { config } from "../config.mjs";
import { notifyWorkspaceChange } from "../shared/workspace-notify.mjs";
import { scheduleDirSync } from "../workspace/dir-sync.mjs";
import { log } from "../shared/log.mjs";
import { writeSseEvent, writeSseHeartbeat, writeSseHeaders, closeSse } from "../shared/sse.mjs";
import { touchActivity } from "../pool/manager.mjs";
import { notifyExecFinished } from "../env-capture/index.mjs";

const execs = new Map(); // execId -> entry

/** Test seam: drop every registered exec (mirrors relay/registry.mjs). */
export function _resetExecsForTest() {
  execs.clear();
}

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

function finalizeExec(entry, { exitCode, signal, error } = {}) {
  if (entry.status !== "running") return;
  entry.status = "exited";
  entry.exitCode = exitCode === undefined ? null : exitCode;
  entry.signal = signal || null;
  entry.exitError = error || null;
  entry.finishedAt = nowMs();
  clearHeartbeat(entry);
  const event = {
    type: "exit",
    seq: ++entry.seq,
    ts: entry.finishedAt,
    exit_code: entry.exitCode,
    signal: entry.signal,
    error: entry.exitError,
    truncated: entry.ring.truncated
  };
  pushRing(entry.ring, event);
  fanOut(entry, event);
  for (const res of entry.listeners) {
    closeSse(res);
  }
  entry.listeners.clear();
  // Phase 1 env capture: best-effort, async, never blocks the exec
  // result. Lives behind its own try/catch — see env-capture/index.mjs
  // for why this is fire-and-forget.
  notifyExecFinished({
    sandboxId: entry.sandboxId,
    kind: entry.kind,
    command: entry.command,
    exitCode: entry.exitCode
  });
  // Panel freshness hint: a finished mutating exec may have changed workspace
  // files (bash writes go straight to S3 via the FUSE mount, invisible to the
  // app's event routes). Coarse signal — empty path just means "re-list".
  if (entry.kind !== "file_read" && entry.userId) {
    notifyWorkspaceChange({
      owner: entry.workspaceOwner || entry.userId,
      userId: entry.userId,
      path: "",
      op: "exec",
    });
    // Empty dirs created by this exec are invisible to the S3 listing (no
    // marker objects) — reconcile them into the manifest from the container's
    // own view. Debounced + best-effort (see workspace/dir-sync.mjs).
    scheduleDirSync({
      sandboxId: entry.sandboxId,
      userId: entry.userId,
      owner: entry.workspaceOwner || entry.userId,
    });
  }
  // (Removed: post-exec sync. Under the weed-mount FUSE workspace, shell-created
  // files are already in S3 the moment the command writes them — `/workspace`
  // IS the store — so there is nothing to push. See docs/plan-remove-stub-subsystem.md.)
}

export function registerExec({ sandboxId, handle, kind, command, timeoutMs, userId = null, workspaceOwner = null }) {
  const execId = handle?.execId || `exec-${randomUUID().slice(0, 8)}`;
  const entry = {
    execId,
    sandboxId,
    kind,
    command,
    userId,
    workspaceOwner,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : null,
    status: "running",
    seq: 0,
    startedAt: nowMs(),
    lastChunkAt: nowMs(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    exitError: null,
    ring: makeRing(Math.max(64 * 1024, config.exec.ringBytes)),
    listeners: new Set(),
    handle,
    heartbeatTimer: null
  };
  execs.set(execId, entry);

  const emit = (type, payload) => {
    const ev = { type, seq: ++entry.seq, ts: nowMs(), ...payload };
    entry.lastChunkAt = ev.ts;
    pushRing(entry.ring, ev);
    fanOut(entry, ev);
    // Pass the exec kind so the pool can attribute WHICH tools kept the sandbox
    // alive (surfaced in the admin Sandbox Center timeline hover).
    touchActivity(sandboxId, entry.kind);
  };

  handle.on("stdout", (chunk) => {
    emit("stdout", { data: Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk) });
  });
  handle.on("stderr", (chunk) => {
    emit("stderr", { data: Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk) });
  });
  handle.on("exit", (info = {}) => {
    finalizeExec(entry, { exitCode: info.code, signal: info.signal, error: info.error });
  });
  handle.on("error", (err) => {
    log("warn", "exec.handle_error", { execId, message: err?.message || String(err) });
  });

  // Docker-backed commands may have completed before these listeners were
  // attached. Drain their buffered stdout/stderr/exit events only after every
  // handler above is registered.
  handle.drainBufferedEvents?.();

  scheduleHeartbeat(entry);
  log("info", "exec.registered", { execId, sandboxId, kind });
  return entry;
}

/**
 * Look up an exec **within one sandbox**.
 *
 * `scope.sandboxId` is REQUIRED and there is deliberately no wildcard: an
 * execId alone is not an authorization, it is just a 32-bit label that the
 * runtime hands back to the caller in the 202 body. Before this scoping, a
 * caller who legitimately owned sandbox B could stream and kill an exec
 * running in sandbox A simply by naming A's execId under B's path — the
 * dispatcher's ownership check validated B (which the caller really did own)
 * and the handler then ignored it. Verified live on 2026-09-02.
 *
 * Fails closed: no scope, empty scope, or a mismatch → null.
 */
export function getExec(execId, scope) {
  const entry = execs.get(execId);
  if (!entry) return null;
  const want = scope && typeof scope.sandboxId === "string" ? scope.sandboxId : "";
  if (!want || entry.sandboxId !== want) return null;
  return entry;
}

/** Attach an SSE listener to an exec. Scoped exactly like {@link getExec}. */
export function attachListener(execId, res, scope) {
  const entry = getExec(execId, scope);
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

/** Cancel a running exec. Scoped exactly like {@link getExec}. */
export function cancelExec(execId, scope) {
  const entry = getExec(execId, scope);
  if (!entry) return false;
  if (entry.status !== "running") return false;
  try {
    entry.handle?.cancel?.();
  } catch (err) {
    log("warn", "exec.cancel_failed", { execId, message: err?.message || String(err) });
  }
  finalizeExec(entry, { exitCode: null, signal: "SIGTERM", error: "cancelled" });
  return true;
}

export function listExecs(sandboxId) {
  const out = [];
  for (const entry of execs.values()) {
    if (sandboxId && entry.sandboxId !== sandboxId) continue;
    out.push({
      execId: entry.execId,
      sandboxId: entry.sandboxId,
      kind: entry.kind,
      status: entry.status,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      exitCode: entry.exitCode
    });
  }
  return out;
}

export function gcFinishedExecs(maxAgeMs = 30 * 60 * 1000) {
  const cutoff = nowMs() - maxAgeMs;
  for (const [execId, entry] of execs) {
    if (entry.status === "exited" && entry.finishedAt && entry.finishedAt < cutoff) {
      execs.delete(execId);
    }
  }
}
