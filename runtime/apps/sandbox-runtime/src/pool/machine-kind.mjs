/**
 * pool/machine-kind.mjs — "is this sandbox on the user's own machine?"
 *
 * Kept apart from manager.mjs so the cloud-only subsystems that hook the exec
 * lifecycle (env-capture, dir-sync) can ask without importing the whole pool
 * (manager.mjs imports env-capture/restore; a direct import back would be a
 * cycle). Lazy import for the same reason.
 */
let _getActive = null;

export function isLocalMachineSandbox(sandboxId) {
  try {
    if (!_getActive) return false;
    return _getActive(sandboxId)?.machineKind === "local";
  } catch {
    return false;
  }
}

/** Called once by pool/manager.mjs at module init to wire the lookup. */
export function _bindActiveLookup(fn) {
  _getActive = fn;
}
