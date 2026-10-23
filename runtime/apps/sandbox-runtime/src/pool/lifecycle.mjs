/**
 * pool/lifecycle.mjs — Future idle-snapshot hibernate (Phase 2+).
 *
 * Layer-2 audit G is now handled inside pool/manager.mjs startReaper(),
 * which checks both `entry.ttlAt` (hard 1h cap) AND `entry.idleAt` (per-
 * sandbox quiet-period, default 120s after last touchActivity). Releases
 * trigger a final S3 sync before destroy, so workspace state survives
 * across re-allocs.
 *
 * This file remains as a placeholder for the eventual snapshot-based
 * hibernate path: instead of releaseSandbox on idle, call
 * backend.snapshotSandbox() and resume on next exec — preserves
 * long-running processes (MCP servers, hook daemons) across quiet
 * periods. Requires a Cube vendor feature that the stub backend can't
 * provide, so it stays unwired for now.
 */

export function startHibernateLoop() {
  // No-op: idle reaping is handled by pool/manager.mjs startReaper().
  // Wire this up only when a snapshot-capable backend is present.
}

export function stopHibernateLoop() {
  // No-op: see startHibernateLoop.
}
