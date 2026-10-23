# UnieAI Cloud Agent Computer (CAC)

Per-tenant agent sandboxes as a service: exec + streaming, files, PTY terminals,
long-running processes, snapshots and workspace storage, behind one `/v1` HTTP API.
No database. State lives in Docker and in S3 (SeaweedFS) or on local disk.

Plan, contracts and phases: https://claude.ai/artifact/KMM8Kwt88bC7x2hukQ4RY7

## Status: P0 (extracted, not yet the source of truth)

Extracted from UnieAI/copilot-v2 at `23e3ce864da25fe6f7d0f2bf963ce3765cfc522d`
(branch `ava`). The paths keep copilot-v2's layout (`runtime/apps/…`,
`runtime/packages/…`) so every relative import resolves unchanged; flattening
the layout is a later, separate change.

| Path | What |
| --- | --- |
| `runtime/apps/sandbox-runtime` | the service (today's control plane + Docker backend in one process) |
| `runtime/packages/storage-engine` | S3 / local-FS workspace storage |
| `runtime/packages/ava-local-protocol` | relay protocol for machines that dial in (Rabi Local today; the host agent later) |
| `runtime/packages/shared-types` | env loading and shared helpers |
| `runtime/package.json` | the four npm deps the image installs |
| `docker/sandbox-runtime/Dockerfile` | the service image (build context = repo root) |
| `deploy/`, `scripts/` | two files the tests read |

Not here on purpose: the sandbox **template image**. copilot-v2's
`docker/cm-agent-sandbox` bundles its own agent harness (`harness-server.cjs`,
built from copilot-v2's `runtime/apps/ava-local`), so it belongs to that caller.
CAC runs whatever image the caller configures (`SANDBOX_DOCKER_IMAGE`).

## Callers (P1)

The shared `SANDBOX_INTERNAL_TOKEN` is the legacy caller (copilot-v2); its ids are
used as they are. Every other caller gets its own key and namespace:

```bash
KEY=$(openssl rand -base64 32)
echo -n "$KEY" | sha256sum   # configure the hash, hand the key to the caller
CAC_CALLERS='[{"id":"studio","namespace":"studio","key_sha256":"<that hash>"}]'
```

A namespaced caller's users, sessions and workspace owners are kept apart from
every other caller's, even when the ids collide. Ownership is always enforced
for it, and operator routes (pool policy, quota limits, the all-tenant event
stream, SSH checks, the Rabi Local relay) stay with the shared token.
See `runtime/apps/sandbox-runtime/src/shared/callers.mjs`.

## Run

```bash
docker build -f docker/sandbox-runtime/Dockerfile -t cac/sandbox-runtime .
# offline / single node: local disk instead of S3
STORAGE_LOCAL_FS=1 STORAGE_LOCAL_FS_ROOT=/var/lib/cac SANDBOX_INTERNAL_TOKEN=… node runtime/apps/sandbox-runtime/src/server.mjs
```

## Test

```bash
npm install && (cd runtime && npm install)
npm run check        # self-check + every test
```

Three tests are cross-repo contracts with copilot-v2: the engine's terminal grace
period, the daemon's redaction kinds, and the sandbox template image's entrypoint.
Standalone they **skip with a reason**. Point `COPILOT_V2_ROOT` at a copilot-v2
checkout to run them:

```bash
COPILOT_V2_ROOT=~/worktrees/copilot-v2 npm test
```

The Docker round-trip test runs only with `DOCKER_INTEGRATION=1`.
