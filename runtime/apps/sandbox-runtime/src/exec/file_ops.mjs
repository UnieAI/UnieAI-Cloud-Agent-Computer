/**
 * exec/file_ops.mjs — file_read / file_write / file_edit kind adapters.
 * Phase 1: not wired through /exec (use /upload + /files endpoints instead).
 * Phase 2 will expose them as exec kinds so the agent can call them as tools.
 */

import { SandboxError } from "../shared/error.mjs";

export async function startFileOpExec(/* { sandboxId, payload, kind } */) {
  throw new SandboxError("not_implemented", "file_ops exec is not wired in Phase 1 (use /files endpoints)", 501);
}
