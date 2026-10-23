/**
 * exec/runner.mjs — POST /v1/sandboxes/:id/exec dispatcher.
 *
 * Dispatches by `kind` into the right adapter, registers the resulting
 * handle into the streams registry, and returns the immediate-202 payload
 * { exec_id, stream_url, status }.
 */

import { config } from "../config.mjs";
import { SandboxError } from "../shared/error.mjs";
import { getActive, touchActivity } from "../pool/manager.mjs";
import { registerExec } from "./streams.mjs";
import { startBashExec } from "./bash.mjs";
import { startPythonExec } from "./python.mjs";
import { startFileOpExec } from "./file_ops.mjs";
import { officialHarnessHold } from "./official-hold.mjs";

function clampTimeout(value) {
  const max = Math.max(1000, config.exec.maxMs);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return max;
  return Math.min(parsed, max);
}

export async function dispatchExec({ sandboxId, kind, payload = {}, timeoutMs }) {
  let poolEntry;
  try {
    poolEntry = getActive(sandboxId);
  } catch (err) {
    // Fix #3 (additive, non-breaking): if the sandbox is gone (e.g. it was
    // idle-reaped between turns) but the underlying durable workspace lives on
    // in S3, surface a typed `recoverable` signal so the client can re-allocate
    // over the same workspace + retry the turn instead of hard-failing on a
    // bare 404. We can't see the workspace from here (the entry is gone), so we
    // can't *prove* a durable workspace exists — but for the sandbox-runtime
    // deployment every exec target is a user-mode workspace_mode="user" session
    // whose bytes outlive the container, so re-allocation is always the right
    // recovery. The code/status stay identical; we only enrich `details`, which
    // older clients ignore. New clients branch on details.recoverable.
    if (err instanceof SandboxError && err.code === "sandbox_not_found") {
      throw new SandboxError(err.code, err.message, err.status, {
        ...(err.details || {}),
        recoverable: true,
        reason: "sandbox_gone",
        // Hint for the client: re-allocate with the same session/user, then
        // replay this exec. The workspace re-hydrates from S3 on alloc.
        action: "reallocate_and_retry"
      });
    }
    throw err;
  }
  const officialHold = kind === "official_harness_hold" ? officialHarnessHold(payload) : null;
  const effectiveTimeout = officialHold ? officialHold.timeoutMs : clampTimeout(timeoutMs);

  // Phase 2 env restore gate. allocateSandbox stashes `restorePromise`
  // on freshly-minted entries; we await it here so the first tool call
  // sees a fully-restored environment. The promise never rejects (it's
  // wrapped at the allocation site), and clears to null once settled so
  // subsequent execs short-circuit without paying any await overhead.
  // Reused sandboxes never have a promise — env carried over from the
  // prior lease.
  if (poolEntry.restorePromise) {
    try {
      await poolEntry.restorePromise;
    } catch {
      /* restoreFromManifest never rejects, but be defensive */
    }
  }

  // (Removed: pre-exec stub materialization.) The workspace is a weed-mount
  // FUSE view where `/workspace` IS the S3 store, so the shell already sees
  // every file's real bytes — there are no zero-byte placeholders to pull.
  // The old refreshStubsFromManifest/materializePendingStubs path existed for
  // the snapshot/stub model and, in FUSE, was a no-op at best and a clobber at
  // worst. See docs/plan-remove-stub-subsystem.md.

  let handle;
  switch (kind) {
    case "official_harness_hold":
      handle = await startBashExec({sandboxId, ...officialHold});
      break;
    case "bash":
      handle = await startBashExec({ sandboxId, payload, timeoutMs: effectiveTimeout });
      break;
    case "python":
      handle = await startPythonExec({ sandboxId, payload, timeoutMs: effectiveTimeout });
      break;
    case "file_read":
    case "file_write":
    case "file_edit":
      handle = await startFileOpExec({ sandboxId, payload, kind });
      break;
    default:
      throw new SandboxError("bad_request", `Unsupported exec kind: ${kind}`, 400);
  }

  const entry = registerExec({
    sandboxId, handle, kind, command: payload?.command || null, timeoutMs: effectiveTimeout,
    // Identity for the exec-finished workspace-change hint (see streams.mjs).
    userId: poolEntry?.userId || null,
    workspaceOwner: poolEntry?.workspaceOwner || null
  });
  touchActivity(sandboxId);

  return {
    exec_id: entry.execId,
    status: "running",
    stream_url: `/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec/${encodeURIComponent(entry.execId)}/stream`
  };
}
