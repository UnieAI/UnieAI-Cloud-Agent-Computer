/**
 * workspace/memorySync.mjs — Reverse-sync agent memory writes to copilot-v2.
 *
 * Durable memory lives in copilot-v2's `agent_memories` DB (the 外掛程式 → 記憶
 * UI reads it). When the agent writes/updates/deletes a memory FILE in its
 * workspace under `.opencode/memories/<path>`, that lands in S3 here — but the
 * DB wouldn't know. This fires a best-effort callback to copilot-v2 so the DB
 * (and thus the management UI) reflects what the agent did, in real time.
 *
 * Fire-and-forget: a callback failure NEVER affects the write that triggered it.
 * Configured via AGENT_MEMORY_SYNC_URL (copilot-v2's /api/agent-next/memory/
 * callback) + a bearer token (AGENT_MEMORY_SYNC_TOKEN, defaults to the shared
 * SANDBOX_INTERNAL_TOKEN). Disabled (no-op) when the URL is unset.
 */

import { config } from "../config.mjs";
import { log } from "../shared/log.mjs";

const MEM_PREFIX = ".opencode/memories/";

/** Map a workspace-relative path to its memory path, or null if not a memory. */
/** Whether a workspace path is a memory file (its writes are mirrored to copilot-v2). */
export function isMemoryPath(relPath) {
  return memPathOf(relPath) !== null;
}

function memPathOf(relPath) {
  if (!relPath || typeof relPath !== "string") return null;
  if (!relPath.startsWith(MEM_PREFIX)) return null;
  const p = relPath.slice(MEM_PREFIX.length).replace(/^\/+/, "");
  return p || null;
}

/**
 * Notify copilot-v2 of a memory file change. `op` is "upsert" | "delete".
 * For "upsert", pass the file bytes/string as `content`. No-op for non-memory
 * paths, when unconfigured, or on any error.
 */
export function notifyMemoryChange(userId, relPath, op, content, owner) {
  try {
    const memPath = memPathOf(relPath);
    if (!memPath || !userId) return;
    const url = config.memorySync?.url;
    if (!url) return;

    const payload = { userId, path: memPath, op };
    // In a shared 專案 (group) workspace, tell copilot-v2 the owning group so it
    // can auto-share the agent-written memory to that group (team-shared memory).
    if (typeof owner === "string" && owner.startsWith("group:")) payload.owner = owner;
    if (op === "upsert" && content != null) {
      payload.content = Buffer.isBuffer(content)
        ? content.toString("utf8")
        : String(content);
    }
    const headers = { "content-type": "application/json" };
    if (config.memorySync?.token) {
      headers.authorization = `Bearer ${config.memorySync.token}`;
    }
    void fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    })
      .then((res) => {
        // Surface non-2xx (e.g. 413 over-size, 409 quota) so DB-vs-S3 drift is
        // observable rather than silently swallowed.
        if (!res.ok) {
          log("warn", "memory_sync.rejected", { userId, path: memPath, op, status: res.status });
        }
      })
      .catch((err) => {
        log("warn", "memory_sync.post_failed", {
          userId,
          path: memPath,
          message: err?.message || String(err),
        });
      });
  } catch (err) {
    log("warn", "memory_sync.failed", { message: err?.message || String(err) });
  }
}

/**
 * Startup health probe. When memory reverse-sync is configured, POST a no-op
 * probe to copilot-v2 to verify the token is accepted. A token mismatch makes
 * EVERY later callback 401 silently — and the next session's staging then prunes
 * the agent's S3-only memories → silent memory loss. So a failed probe is logged
 * at ERROR (loud), not warn. No-op when the feature is unconfigured.
 */
export async function probeMemorySync() {
  const url = config.memorySync?.url;
  if (!url) return; // feature off — nothing to probe

  const headers = { "content-type": "application/json" };
  if (config.memorySync?.token) headers.authorization = `Bearer ${config.memorySync.token}`;

  // One attempt → { kind: "ok" | "auth" | "transient", status?, message? }.
  const attempt = async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ probe: true }),
      });
      if (res.ok) return { kind: "ok" };
      // 401 is a DEFINITIVE token mismatch — never a cold-start artifact.
      if (res.status === 401) return { kind: "auth", status: 401 };
      return { kind: "transient", status: res.status };
    } catch (err) {
      return { kind: "transient", message: err?.message || String(err) };
    }
  };

  let r = await attempt();
  // A non-auth failure at boot is often just the app not up yet — retry once
  // after a short delay before deciding, so simultaneous boot doesn't log a
  // spurious ERROR. A 401 mismatch is reported immediately (no retry).
  if (r.kind === "transient") {
    await new Promise((res) => setTimeout(res, 3000));
    r = await attempt();
  }

  if (r.kind === "ok") {
    log("info", "memory_sync.probe_ok", { url });
  } else if (r.kind === "auth") {
    log("error", "memory_sync.probe_failed", {
      url,
      status: 401,
      hint: "AGENT_MEMORY_SYNC_TOKEN / SANDBOX_INTERNAL_TOKEN mismatch — agent memory will be LOST after one session",
    });
  } else {
    log("error", "memory_sync.probe_failed", {
      url,
      status: r.status,
      message: r.message,
      hint: "copilot-v2 unreachable or rejected the memory-sync probe (still failing after retry)",
    });
  }
}
