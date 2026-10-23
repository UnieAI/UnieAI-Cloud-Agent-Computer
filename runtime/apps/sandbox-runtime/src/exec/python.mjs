/**
 * exec/python.mjs — python kind adapter.
 *
 * Mirror of bash.mjs but for `python3 -c "<code>"`. Backend (stub or
 * CubeSandbox) routes kind:"python" → spawn("python3", ["-c", code]) inside
 * the sandbox.
 */

import { getBackend } from "../cube/index.mjs";
import { SandboxError } from "../shared/error.mjs";

export async function startPythonExec({ sandboxId, payload = {}, timeoutMs }) {
  const code = typeof payload.code === "string" ? payload.code
    : typeof payload.command === "string" ? payload.command
    : "";
  if (!code.trim()) {
    throw new SandboxError("bad_request", "python exec requires payload.code (non-empty string)", 400);
  }
  const backend = getBackend(sandboxId);
  const handle = await backend.execProcess(sandboxId, {
    kind: "python",
    command: code,
    env: payload.env && typeof payload.env === "object" ? payload.env : {},
    cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
    stdin: typeof payload.stdin === "string" ? payload.stdin : undefined,
    timeoutMs
  });
  return handle;
}
