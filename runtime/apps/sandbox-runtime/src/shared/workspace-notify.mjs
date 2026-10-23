/**
 * workspace-notify.mjs — fire-and-forget "files changed" webhook to the app.
 *
 * The app's workspace-events SSE (panel live-refresh) is fed ONLY by the app's
 * own HTTP routes — there is no S3 watcher, so files written by the AGENT
 * (direct-S3 file tools, bash over the weed mount) never produced a frame and
 * other viewers stayed stale until their next poll. sandbox-runtime is the one
 * component every agent write flows through, so it notifies the app here:
 *
 *   POST ${WORKSPACE_EVENTS_WEBHOOK_URL}  (Bearer SANDBOX_INTERNAL_TOKEN)
 *   body: { owner, by, events: [{ path, op }, ...] }
 *
 * Best-effort by design: no retry, short timeout, silent no-op when the env is
 * unset. Debounced per owner (trailing 300ms, max 10 distinct paths per flush)
 * so a burst — config staging, an agent writing many files — collapses into one
 * webhook instead of a frame per file. Losing a notification is always healed
 * by the panel's own turn-end refresh; this is a freshness hint, not a ledger.
 */

import { log } from "./log.mjs";

const WEBHOOK_URL = (process.env.WORKSPACE_EVENTS_WEBHOOK_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.SANDBOX_INTERNAL_TOKEN || "";
const DEBOUNCE_MS = 300;
const MAX_EVENTS_PER_FLUSH = 10;

// owner-channel key → { timer, byUser, events: Map<path, op> }
const pending = new Map();

/** Map the runtime's owner string (bare userId for personal) to the app's
 *  channel-key format (`user:<id>` / `group:<gid>` / `org:<oid>`). */
function channelOwner(owner) {
  const o = String(owner || "");
  if (!o) return "";
  return /^(group|org|user):/.test(o) ? o : `user:${o}`;
}

async function flush(key) {
  const q = pending.get(key);
  pending.delete(key);
  if (!q || q.events.size === 0) return;
  const events = Array.from(q.events, ([path, op]) => ({ path, op })).slice(0, MAX_EVENTS_PER_FLUSH);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify({ owner: key, by: q.byUser || null, events }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      log("warn", "workspace.notify_rejected", { status: res.status, owner: key });
    } else {
      log("info", "workspace.notify_sent", { owner: key, events: events.length });
    }
  } catch (err) {
    // Best-effort: log at debug-ish level; the panel's poll heals staleness.
    log("warn", "workspace.notify_failed", { owner: key, error: err?.message || String(err) });
  }
}

/**
 * Queue a change notification. `path` may be "" for a coarse "something may
 * have changed" signal (e.g. after a bash exec) — the client re-lists either
 * way. No-op when WORKSPACE_EVENTS_WEBHOOK_URL is unset.
 */
export function notifyWorkspaceChange({ owner, userId, path = "", op = "write" }) {
  if (!WEBHOOK_URL) return;
  const key = channelOwner(owner);
  if (!key) return;
  let q = pending.get(key);
  if (!q) {
    q = { timer: null, byUser: userId || null, events: new Map() };
    pending.set(key, q);
    q.timer = setTimeout(() => void flush(key), DEBOUNCE_MS);
    // Never keep the process alive just for a pending notification.
    q.timer.unref?.();
  }
  if (q.events.size < MAX_EVENTS_PER_FLUSH) q.events.set(String(path || ""), String(op || "write"));
}
