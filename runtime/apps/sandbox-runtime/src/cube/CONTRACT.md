# CubeSandbox Backend Contract

Source-of-truth interface that both `cube/stub.mjs` (dev backend, real `child_process`) and `cube/client.mjs` (production backend over E2B-compatible HTTP API) MUST implement. Changes here ripple through both backends + sandbox-runtime HTTP routes + the consuming `apps/llm-runtime/src/agent/sandbox/client.mjs`.

## Backend selection

`SANDBOX_MODE=stub` (default on macOS/dev) → `createStubClient()` from `cube/stub.mjs`.
`SANDBOX_MODE=cube` → `createCubeClient({ cubeApiUrl, cubeApiKey })` from `cube/client.mjs`.

`cube/index.mjs::getBackend()` memoizes the selected client; `resetBackend()` clears for tests.

### Self-hosted CubeMaster setup

Minimum env for `SANDBOX_MODE=cube` against a self-hosted CubeMaster cluster:

| Variable | Required | Notes |
|---|---|---|
| `SANDBOX_MODE=cube` | yes | Flips `cube/index.mjs::getBackend()` |
| `CUBE_API_URL` | yes | Control-plane base URL, e.g. `https://cube.internal/api`. Trailing slashes auto-stripped. |
| `CUBE_API_KEY` | yes | `X-API-Key` header for all control-plane calls |
| `CUBE_TEMPLATE_ID_BASH` | yes | Default template id; sandboxes created without an explicit `image` use this |
| `CUBE_TEMPLATE_ID_PYTHON` | optional | Used when caller requests `kind="python"` and a separate template was published |
| `CUBE_ENVD_URL_TEMPLATE` | optional | Override envd routing. Defaults to E2B subdomain pattern `https://{port}-{sandboxID}-{clientID}.{domain}`. Self-hosted clusters often need e.g. `https://envd.internal/{sandboxID}` |
| `CUBE_ENVD_PORT` | optional | Default `49983`; only used inside the default URL template |
| `CUBE_ENVD_USER` | optional | Default `user`; passed as `?username=` on file REST calls |
| `CUBE_DEFAULT_WORKDIR` | optional | Default `/home/user`; surfaced to callers as `workspaceDir` |

After setting env, smoke-test with `node scripts/verify-cube-sandbox.mjs` — it runs create → exec → write/read → list → destroy against the live cluster and exits non-zero on any failure. Without `CUBE_API_URL` it exits `2` (skip), so it's safe to wire into CI.

### Template requirements

The bash/python templates uploaded to CubeMaster must:
- run `envd` on `CUBE_ENVD_PORT` (default 49983) at boot
- have `/bin/bash` and `/usr/bin/env python3` on PATH (used by `cube/envd.mjs::execProcess`)
- accept `X-Access-Token` from the control plane's `envdAccessToken` field

Our canonical userspace rootfs lives at [`docker/cm-agent-sandbox/`](../../../../docker/cm-agent-sandbox/) — see the README there for what's baked in (LibreOffice, ffmpeg, pandoc, common Python wheels, …) and the publish flow. CubeSandbox supplies the envd shim on top; we own only the userspace tools.

## Sandbox lifecycle

| Method | Signature | Semantics |
|---|---|---|
| `createSandbox` | `({ userId, sessionId, image, resourceQuota, ttlSec, networkPolicy }) → { sandboxId, workspaceId, workspaceDir? }` | Allocate a fresh sandbox. `workspaceDir` only present for stub. Sandbox is identified by `sandboxId` for all subsequent calls. |
| `destroySandbox` | `(sandboxId, { keepWorkspace? }) → void` | Tear down. Kills all long-lived processes inside. Idempotent — no-op if already destroyed. |
| `pauseSandbox` | `(sandboxId) → void` | Snapshot in-memory state; freeze. Long-lived processes are checkpointed if the backend supports it; otherwise documented as "killed on pause" (stub falls back to no-op). |
| `resumeSandbox` | `(sandboxId) → void` | Inverse of pause. After resume, long-lived processes that survived pause are re-attachable via the same `processHandle`. If the backend killed them on pause, callers must re-spawn. |
| `listSandboxes` | `() → Array<{ sandboxId, workspaceId, createdAt }>` | Diagnostic. |

## File operations

| Method | Signature |
|---|---|
| `readFile` | `(sandboxId, path) → Buffer` |
| `writeFile` | `(sandboxId, path, content) → void` |
| `statFile` | `(sandboxId, path) → { path, size, mtimeMs, isFile, isDirectory } \| null` |
| `listFiles` | `(sandboxId, dirPath) → Array<{ name, path, isFile, isDirectory, size, mtimeMs }>` |
| `deleteFile` | `(sandboxId, path) → void` |

All paths are workspace-relative. Path-escape attempts throw `SandboxError("workspace_escape", ..., 400)`.

## One-shot process execution (existing)

```
execProcess(sandboxId, {
  kind: "bash" | "python" | "raw",
  command, args, env, cwd, timeoutMs, stdin
}) → ProcessHandle  // single-use, ends when subprocess exits
```

Used by bash/python/file tools. Subprocess is spawned per call, exits, handle is discarded.

## Long-lived process execution (M0 NEW)

The contract that makes stdio MCP servers + hook persistence possible.

```
spawnLongLivedProcess(sandboxId, {
  command,                  // e.g. "node" or "npx"
  args,                     // e.g. ["@modelcontextprotocol/server-filesystem", "/workspace"]
  env,                      // additional env vars (merged with sandbox defaults)
  cwd                       // workspace-relative; defaults to workspace root
}) → { processHandle, startedAt }
```

`processHandle` is an opaque string ID (e.g. `lproc-abc123`). **It MUST be addressable across multiple stateless HTTP requests** — the registry survives between `spawnLongLivedProcess` returning and a later `attachToProcess` call.

```
attachToProcess(sandboxId, processHandle) → AsyncIterable<ProcessEvent>
```

Returns a fresh subscriber to the process's event stream. Late subscribers receive a replay of the ring buffer (recent stdout/stderr) before joining live. Multiple concurrent attaches are allowed (e.g. one for the MCP JSON-RPC reader, another for diagnostic streaming).

```
ProcessEvent shape:
  { type: "stdout", data: string, ts: number, seq: number }
  { type: "stderr", data: string, ts: number, seq: number }
  { type: "exit",   code: number|null, signal: string|null, error: string|null, seq: number, ts: number }
  { type: "error",  message: string, seq: number, ts: number }
  { type: "heartbeat", seq: number, ts: number }  // emitted every config.exec.heartbeatMs of inactivity
```

```
writeStdin(sandboxId, processHandle, data) → void
```

Writes raw bytes to the subprocess stdin. Used by stdio MCP transport to send JSON-RPC frames (with `Content-Length: ...\r\n\r\n` header per LSP-style framing).

```
killProcess(sandboxId, processHandle, { signal? = "SIGTERM" }) → void
```

Sends signal. If process doesn't exit in 2s, escalates to SIGKILL. Subsequent `attachToProcess` returns the final `exit` event (preserved in ring).

```
listProcesses(sandboxId) → Array<{ processHandle, command, args, status, startedAt, exitCode? }>
```

Diagnostic. Used for sandbox-bound cleanup (kill all on destroy).

### Long-lived process lifecycle invariants

1. Process lives until: explicit `killProcess`, parent `destroySandbox`, OR backend-internal timeout (configurable, default 24h).
2. `processHandle` is unique within a sandbox; reusing across sandboxes is undefined.
3. Stdout/stderr ring buffer holds last `config.exec.ringBytes` bytes (default 2MB) — older output dropped, `truncated:true` flagged.
4. `attachToProcess` MUST send replay first, then live events, in the same iterable. Order is preserved by monotonic `seq`.
5. `writeStdin` after `exit` throws `SandboxError("process_exited", ..., 409)`.
6. Backend MUST treat the process registry as in-sandbox state — survives between HTTP requests but does not survive `destroySandbox` or container restart. Backends with snapshot/restore (production Cube) MAY preserve process registry across pause/resume; if they cannot, they MUST emit `exit` for surviving processes on pause and require respawn after resume.

## Snapshot / restore (production Cube only)

| Method | Signature |
|---|---|
| `snapshotSandbox` | `(sandboxId) → { snapshotId }` |
| `restoreSnapshot` | `(snapshotId) → { sandboxId }` |

Stub throws `not_supported`. Used by M2 warm-pool (deferred).

## Error codes

All backends throw `SandboxError(code, message, status, details?)` where `status` is HTTP-friendly:

- `sandbox_not_found` 404
- `process_not_found` 404
- `process_exited` 409 — stdin write after exit
- `workspace_escape` 400
- `payload_too_large` 413
- `not_implemented` 501 — Cube methods that vendor hasn't shipped
- `not_supported` 501 — stub explicitly doesn't support
- `bad_request` 400

## HTTP surface (sandbox-runtime routes)

| Route | Backend method |
|---|---|
| `POST /v1/sandboxes` | `createSandbox` |
| `DELETE /v1/sandboxes/:id` | `destroySandbox` |
| `POST /v1/sandboxes/:id/exec` | one-shot exec via `runner.mjs` → `execProcess` |
| `GET /v1/sandboxes/:id/exec/:execId/stream` | SSE-attach to one-shot exec |
| `DELETE /v1/sandboxes/:id/exec/:execId` | cancel one-shot exec |
| **`POST /v1/sandboxes/:id/processes`** | `spawnLongLivedProcess` (M0 NEW) |
| **`GET /v1/sandboxes/:id/processes/:handle/attach`** | `attachToProcess` (M0 NEW) |
| **`POST /v1/sandboxes/:id/processes/:handle/stdin`** | `writeStdin` (M0 NEW) |
| **`DELETE /v1/sandboxes/:id/processes/:handle`** | `killProcess` (M0 NEW) |
| **`GET /v1/sandboxes/:id/processes`** | `listProcesses` (M0 NEW) |
| `POST /v1/sandboxes/:id/upload` | file upload (multipart) |
| `GET /v1/sandboxes/:id/files` | file download |
| `GET /v1/sandboxes/:id/files/list` | dir listing |
| `POST /v1/sandboxes/:id/snapshot` | M2 |
| `POST /v1/sandboxes/:id/resume` | M2 |

## Vendor capability spike (block before M1)

Before contracting a Cube/E2B vendor:

1. Verify the vendor exposes per-sandbox subprocess registry survivable across stateless HTTP roundtrips (not just "execute command synchronously and return output").
2. Verify subprocess stdin remains writable across separate HTTP requests targeting the same sandbox.
3. Verify subprocess stdout/stderr are buffered server-side and streamable to a late attach.
4. Verify subprocess survives e.g. 30+ minute idle periods without being garbage-collected.

If the vendor only supports one-shot exec, fallback plan = spawn MCP per tool call (10-50× latency penalty, kills the per-call permission UX). In that case, re-cost M1 and surface the regression to the user.
