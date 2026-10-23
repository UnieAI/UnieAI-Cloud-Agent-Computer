/**
 * pool/lifecycle-telemetry.mjs — best-effort sandbox lifecycle reporting.
 *
 * Fires a fire-and-forget callback to copilot-v2 on each sandbox lifecycle
 * transition (start / active / idle / close) so the BFF can persist usage TIMES
 * — including sandboxes that start but are never used. Mirrors the memory/skill
 * reverse-sync pattern.
 *
 * Configured via SANDBOX_LIFECYCLE_CALLBACK_URL (copilot-v2's
 * /api/sandbox-lifecycle) + a bearer token (SANDBOX_LIFECYCLE_CALLBACK_TOKEN,
 * defaults to the shared SANDBOX_INTERNAL_TOKEN). No-op when the URL is unset.
 * A failure NEVER affects the sandbox it describes.
 */

import { log } from "../shared/log.mjs";

const CALLBACK_URL = (process.env.SANDBOX_LIFECYCLE_CALLBACK_URL || "").replace(/\/+$/, "");
const CALLBACK_TOKEN =
  process.env.SANDBOX_LIFECYCLE_CALLBACK_TOKEN || process.env.SANDBOX_INTERNAL_TOKEN || "";

/**
 * Report a lifecycle event. `event` is "start" | "active" | "idle" | "close".
 * `details` may carry userId, sessionId, workspaceMode, workspaceOwner,
 * durationMs, reason.
 */
export function emitLifecycleEvent(sandboxId, event, details = {}) {
  if (!CALLBACK_URL || !CALLBACK_TOKEN || !sandboxId || !event) return;
  try {
    void fetch(CALLBACK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CALLBACK_TOKEN}` },
      body: JSON.stringify({
        sandboxId,
        event,
        userId: details.userId ?? null,
        sessionId: details.sessionId ?? null,
        workspaceMode: details.workspaceMode ?? null,
        workspaceOwner: details.workspaceOwner ?? null,
        durationMs: typeof details.durationMs === "number" ? details.durationMs : null,
        reason: details.reason ?? null,
        // Distinct exec kinds that kept the sandbox alive (active events only).
        tools: Array.isArray(details.tools) && details.tools.length ? details.tools : null,
      }),
    })
      .then((res) => {
        if (!res.ok) log("warn", "lifecycle.rejected", { sandboxId, event, status: res.status });
      })
      .catch((err) => log("warn", "lifecycle.post_failed", { sandboxId, event, message: err?.message || String(err) }));
  } catch (err) {
    log("warn", "lifecycle.failed", { message: err?.message || String(err) });
  }
}
