/**
 * workspace/volumes.mjs — Workspace volume bookkeeping.
 *
 * Phase 1: trivial — Volume == backend's per-sandbox dir (stub) or per-sandbox
 * volume (cube). The backend owns lifecycle; this file just exposes a stable
 * `getWorkspaceInfo(sandboxId)` for /files/list and snapshot/restore paths.
 */

import { getActive } from "../pool/manager.mjs";

export function getWorkspaceInfo(sandboxId) {
  const entry = getActive(sandboxId);
  return {
    sandboxId: entry.sandboxId,
    workspaceId: entry.workspaceId,
    workspaceDir: entry.workspaceDir || null
  };
}
