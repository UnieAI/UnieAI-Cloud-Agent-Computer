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

## Run (single host, P2)

The object store is always S3, and you choose which: the bundled SeaweedFS, or
your own MinIO / AWS S3 / any S3 API. There is no local-directory mode.

```bash
docker build -f docker/sandbox-runtime/Dockerfile -t cac/runtime:local .
docker build -f docker/sandbox-template/Dockerfile -t cac-sandbox:local .   # or your own template
cd deploy/compose && cp .env.example .env    # the store, its keys, a caller key
docker compose --profile bundled-s3 up -d    # bundled SeaweedFS
docker compose up -d                         # your own S3 (set S3_ENDPOINT)
```

Before the server starts, the storage doctor checks the store: it is S3, the
bucket exists, the keys can write, read and delete, conditional writes are
honoured, and the S3 mount can run. It names the setting to fix and never
prints a key. To run it by hand:

```bash
docker compose run --rm cac node apps/sandbox-runtime/src/doctor/storage-doctor.mjs
```

Each sandbox's `/workspace` is an rclone mount of `<bucket>/<owner>/workspace`.
The cac container makes the mount and binds it in, so the sandbox holds no S3
key and has no route to the store. Host requirements: Docker with compose v2,
`/dev/fuse`, and a shared root mount (the systemd default).

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
COPILOT_V2_ROOT=<checkout of what production runs> npm test
```

The Docker round-trip test runs only with `DOCKER_INTEGRATION=1`. The real S3
mount (rclone against MinIO and SeaweedFS, in throwaway containers, building
nothing) and the whole bundle have their own scripts:

```bash
STORE=minio     scripts/s3-mount-it.sh <image with node 22 + apt> <rclone binary>
STORE=seaweedfs scripts/s3-mount-it.sh <image with node 22 + apt> <rclone binary>
scripts/bundle-smoke.sh      # needs cac/runtime:local and cac-sandbox:local
```
