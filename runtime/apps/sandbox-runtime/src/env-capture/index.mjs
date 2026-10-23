/**
 * env-capture/index.mjs — Phase 1 entry point.
 *
 * Called from exec/streams.mjs when a bash exec finishes. We inspect
 * the command, and if it looks like a package install we schedule a
 * manifest sync. Multiple installs in quick succession coalesce into
 * a single sync — `pip install pkg1 && pip install pkg2 && pip install pkg3`
 * shouldn't fire 3 separate `pip list` reads.
 *
 * Design notes:
 *   · Pure side-effect: this module never throws back into the caller.
 *     Phase 1 is opt-in observability — a bug here must not affect the
 *     user's exec result.
 *   · Per-sandbox debounce: 5s delay after the last detected install,
 *     anchored to the sandbox id. Different sandboxes never interfere.
 *   · No state on disk in this module — state lives in the workspace
 *     manifest itself (read every time before write, so a fresh process
 *     picks up where the prior one left off).
 *
 * Wired up: exec/streams.mjs registers a `notifyInstallCommand` call
 * inside `finalizeExec`. The hook is async-fire-and-forget; we never
 * await it from the exec path.
 */

import { log } from "../shared/log.mjs";
import { getBackend } from "../cube/index.mjs";
import { isLocalMachineSandbox } from "../pool/machine-kind.mjs";

import { detectInstall } from "./detect.mjs";
import { syncManifest } from "./sync.mjs";

const DEBOUNCE_MS = 5_000;

// One pending sync per sandbox. The value is `{ timer, lastDetection }`
// so subsequent installs reset the timer and overwrite the detection
// label (the most recent install is what we ship in capture.log).
const pending = new Map();

/**
 * Public hook. Always returns immediately; the actual sync runs on
 * the debounce timer. Caller passes the bash exec's recorded command
 * and final exit code. Non-zero exits get a chance to sync too —
 * `pip install` can fail late (network blip after some deps already
 * installed) and the partial state still matters.
 */
export function notifyExecFinished({ sandboxId, kind, command, exitCode }) {
  // No package manifest is kept for a user's own machine (Rabi Local).
  if (isLocalMachineSandbox(sandboxId)) return;
  try {
    if (!sandboxId) return;
    if (kind !== "bash") return;
    if (typeof command !== "string" || !command.trim()) return;

    const detection = detectInstall(command);
    if (!detection) return;

    // exit code -1 means "we never got an exit event" (handle error /
    // sandbox died); skip — there's no point reading state from a
    // sandbox we can't talk to.
    if (exitCode === -1) return;

    schedule(sandboxId, { detection, exitCode });
  } catch (err) {
    // Truly defensive — capture's whole job is to silently observe.
    log("warn", "env_capture.notify_threw", {
      sandboxId,
      message: err?.message || String(err)
    });
  }
}

function schedule(sandboxId, payload) {
  const existing = pending.get(sandboxId);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => {
    pending.delete(sandboxId);
    void runSync(sandboxId, payload);
  }, DEBOUNCE_MS);
  // Don't keep the event loop alive just for a capture sync. If the
  // process is shutting down, we'd rather lose this manifest update
  // than block exit. Next start re-reads state fresh anyway.
  timer.unref?.();
  pending.set(sandboxId, { timer, lastDetection: payload.detection });
}

async function runSync(sandboxId, payload) {
  try {
    const backend = getBackend(sandboxId);
    await syncManifest({
      backend,
      sandboxId,
      trigger: {
        ecosystem: payload.detection.ecosystem,
        tool: payload.detection.tool,
        verb: payload.detection.verb,
        exitCode: payload.exitCode
      }
    });
  } catch (err) {
    log("warn", "env_capture.sync_threw", {
      sandboxId,
      message: err?.message || String(err)
    });
  }
}

/**
 * Test hook — flushes any pending debounce timers and awaits the
 * underlying sync. Production code does not need this; tests use it
 * to deterministically drain captures before assertions.
 */
export async function flushPendingForTest() {
  const entries = Array.from(pending.entries());
  pending.clear();
  for (const [sandboxId, info] of entries) {
    if (info.timer) clearTimeout(info.timer);
    await runSync(sandboxId, { detection: info.lastDetection, exitCode: 0 });
  }
}
