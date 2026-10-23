/** ACP sessions routed to a particular, already-authorized relay sandbox. */
import { randomUUID } from "node:crypto";
import { SandboxError } from "../shared/error.mjs";

export function createAgentRegistry({ maxBytes = 8 << 20, reapMs = 300000 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) throw new RangeError("maxBytes must be at least 256");
  const records = new Map();
  function get(sandboxId, id) {
    const r = records.get(id);
    if (!r || r.sandboxId !== sandboxId) throw new SandboxError("agent_gone", "Unknown local agent session", 404);
    return r;
  }
  function emit(r, event) {
    if (!r.live && !event.exit) return;
    const frame = { seq: ++r.seq, ...event };
    const line = `id: ${frame.seq}\ndata: ${JSON.stringify(frame)}\n\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > maxBytes) {
      // Do not create a sequence hole: replay must deliver the fatal error.
      r.seq--;
      emit(r, { error: "agent_frame_too_large" });
      finish(r, { code: null, signal: null });
      void Promise.resolve().then(() => r.handle.close()).catch(() => {});
    }
    else {
      r.frames.push({ frame, line, bytes }); r.bytes += bytes;
      while (r.bytes > maxBytes && r.frames.length > 1) r.bytes -= r.frames.shift().bytes;
      for (const res of r.clients) {
        if (res.writableLength > maxBytes) { res.destroy(); r.clients.delete(res); }
        else res.write(line);
      }
    }
  }
  function finish(r, exit) {
    if (!r.live) return;
    r.live = false;
    emit(r, { exit });
    for (const res of r.clients) res.end();
    r.clients.clear();
    r.timer = setTimeout(() => records.delete(r.id), reapMs);
    r.timer.unref?.();
  }
  return {
    describe(sandboxId, id) { const r = get(sandboxId, id); return { agentId: r.id, seq: r.seq, live: r.live }; },
    async open(sandboxId, backend, spec) {
      if (typeof backend.openAgentSession !== "function") throw new SandboxError("local_agent_unsupported", "This sandbox cannot host a native agent", 501);
      const handle = await backend.openAgentSession(sandboxId, spec);
      const r = { id: randomUUID(), sandboxId, handle, live: true, seq: 0, frames: [], bytes: 0, clients: new Set(), timer: null };
      records.set(r.id, r);
      handle.on("acp", acp => emit(r, { acp }));
      handle.on("note", note => emit(r, { note }));
      handle.on("error", error => {
        emit(r, { error: String(error.message ?? error) }); finish(r, { code: null, signal: null });
        void Promise.resolve().then(() => handle.close()).catch(() => {});
      });
      handle.on("exit", exit => finish(r, exit));
      return { agentId: r.id };
    },
    attach(sandboxId, id, after, res) {
      const r = get(sandboxId, id);
      if (!Number.isSafeInteger(after) || after < 0 || after > r.seq) throw new SandboxError("bad_cursor", "Invalid ACP sequence", 400);
      if (r.frames.length && after < r.frames[0].frame.seq - 1) throw new SandboxError("agent_replay_gap", "ACP replay window was exceeded", 409);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
      for (const f of r.frames) if (f.frame.seq > after) res.write(f.line);
      if (!r.live) { res.end(); return; }
      r.clients.add(res);
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
      heartbeat.unref?.();
      res.on("close", () => { clearInterval(heartbeat); r.clients.delete(res); });
    },
    async input(sandboxId, id, message) {
      const r = get(sandboxId, id);
      if (!r.live) throw new SandboxError("agent_exited", "Local agent has exited", 409);
      if (!message || typeof message !== "object" || Array.isArray(message) || Buffer.byteLength(JSON.stringify(message)) > maxBytes) throw new SandboxError("bad_message", "Invalid ACP message", 400);
      if (!await r.handle.send(message)) throw new SandboxError("agent_gone", "Local agent refused input", 409);
    },
    async close(sandboxId, id) {
      const r = get(sandboxId, id);
      try { await r.handle.close(); }
      finally { finish(r, { code: null, signal: null, closedByClient: true }); }
    },
    async release(sandboxId) {
      await Promise.allSettled([...records.values()].filter(r => r.sandboxId === sandboxId).map(async r => {
        try { await r.handle.close(); }
        finally {
          finish(r, { code: null, signal: null, closedByClient: true });
          clearTimeout(r.timer); records.delete(r.id);
        }
      }));
    },
  };
}

export const localAgentSessions = createAgentRegistry();
