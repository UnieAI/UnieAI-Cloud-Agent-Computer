/**
 * exec/bash.mjs — bash kind adapter.
 *
 * Translates POST /v1/sandboxes/:id/exec {kind:"bash"} into backend.execProcess.
 * Payload shape:
 *   { command: string, env?: Record<string,string>, cwd?: string, stdin?: string }
 * Plus the top-level timeout_ms.
 */

import { getBackend } from "../cube/index.mjs";
import { SandboxError } from "../shared/error.mjs";

export async function startBashExec({ sandboxId, payload = {}, timeoutMs }) {
  const command = typeof payload.command === "string" ? payload.command : "";
  if (!command.trim()) {
    throw new SandboxError("bad_request", "bash exec requires payload.command (non-empty string)", 400);
  }
  const backend = getBackend(sandboxId);
  const handle = await backend.execProcess(sandboxId, {
    kind: "bash",
    command,
    env: payload.env && typeof payload.env === "object" ? payload.env : {},
    cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
    stdin: typeof payload.stdin === "string" ? payload.stdin : undefined,
    // Rabi Local approval token (relay backend only; others ignore it).
    approval: typeof payload.approval === "string" ? payload.approval : null,
    // Opt-in container on the user's OWN machine, asked for per command by the
    // agent. A cloud sandbox is already a container, so it ignores this.
    sandbox: payload.sandbox === true,
    timeoutMs
  });
  return handle;
}
