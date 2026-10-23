/**
 * agentPermissionServer.mjs — Server-only helpers for the permission protocol.
 *
 * Split out from agentPermission.mjs because these helpers use node:crypto,
 * which webpack refuses to bundle for the browser. The client bundle imports
 * only the pure-data parts from agentPermission.mjs; the runtime + Next.js
 * server routes import from here when they need to hash or mint IDs.
 */

import crypto from "node:crypto";

/**
 * Stable hash of tool args for audit logging. Used by permission_grants.args_hash
 * so the audit row stays size-bounded even when args are large.
 */
export function hashToolArgs(args) {
  let serialised;
  try {
    serialised = typeof args === "string" ? args : JSON.stringify(args ?? null);
  } catch {
    serialised = String(args ?? "");
  }
  return crypto.createHash("sha256").update(serialised).digest("hex").slice(0, 32);
}

/**
 * Generate a permission request id. ULID-like (timestamp prefix + random) so
 * sort order is request-order across replicas without a coordinator.
 */
export function newPermissionRequestId() {
  const ts = Date.now().toString(36).padStart(10, "0");
  const rnd = crypto.randomBytes(8).toString("hex");
  return `perm_${ts}${rnd}`;
}
