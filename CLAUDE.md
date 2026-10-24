# CLAUDE.md

Guidance for agents working in UnieAI Cloud Agent Computer (CAC). Read the
"Mistakes already made" section before changing code or tests.

Plan, contracts and phases: https://claude.ai/artifact/KMM8Kwt88bC7x2hukQ4RY7

## Before you say "done"

```bash
npm run check        # self-check (scripts/self-check.mjs) + the whole suite
COPILOT_V2_ROOT=<copilot-v2 checkout matching production> npm test   # also runs the cross-repo contracts
scripts/s3-mount-it.sh <runner image> <rclone binary>   # STORE=minio|seaweedfs; the real S3 mount
scripts/bundle-smoke.sh   # the bundle end to end (needs the two images built — ask first)
```

The first two must be green. "Green" means 0 fail. Read the skip count too:
standalone skips 11 (3 cross-repo contracts, the Docker round trip, the 7 real
S3-mount tests), with `COPILOT_V2_ROOT` it skips 8. A different number means a
test started skipping silently.

`COPILOT_V2_ROOT` must be a checkout of what production runs (origin/ava, e.g.
`~/worktrees/composer-desktop`), not the shared `~/service/copilot-v2`, which
can be on any branch: pointed there, the entrypoint contract failed against a
months-old `entrypoint.sh`.

When you change anything under `cube/host-mount*.mjs`, `workspace/userStore.mjs`
or the storage doctor, run `scripts/s3-mount-it.sh` against both stores.

When a test fails and the cause is a mistake that could happen again, do two
things. Fix it, then make it impossible to repeat: add a rule to
`scripts/self-check.mjs` and a fixture for it in `scripts/self-check.test.mjs`.
If it cannot be checked by code, add it to the list below.

## Layout

The layout keeps copilot-v2's paths (`runtime/apps/sandbox-runtime`,
`runtime/packages/*`) so relative imports resolve unchanged. Flattening it is
a separate change, not something to do on the side.

- `runtime/apps/sandbox-runtime/src/server.mjs`: the route table and
  `handleRequest`. Every request passes the same door: auth, caller namespace,
  ownership.
- `shared/auth.mjs`: the shared token, signed identity and namespaced caller keys.
- `shared/callers.mjs`: caller namespaces (P1). Read its header before
  touching identity.
- `pool/manager.mjs`: sandboxes, keyed by user, session and owner slot.
- `workspace/tenant-store.mjs` + `packages/storage-engine`: owner → S3 prefix or bucket.
- `cube/host-mount.mjs`: the sandbox's /workspace. Driver `weed` (production,
  SeaweedFS filer only) or `s3` (rclone, any S3 API; P2).
- `doctor/storage-doctor.mjs`: is the configured store usable. The bundle runs
  it before the server.
- `deploy/compose/`: the single-host bundle. `docker/sandbox-template/`: a
  generic sandbox image for it.

## Storage (P2)

- The object store is always S3, configured by the operator (`S3_ENDPOINT`,
  `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`,
  `S3_FORCE_PATH_STYLE`). There is no local-directory mode: workspaces must
  outlive the host and be reachable from every host. storage-engine still has a
  local-fs fallback for tests; the doctor refuses it.
- The bucket is `S3_BUCKET`, for the store and the mount alike. Never read
  `WEED_S3_BUCKET` (self-check `single-bucket`).
- With the `s3` driver, every write or delete that goes through `userStore`
  drops the mount's cached directory before the reply (`onWorkspaceObjectChange`
  → `invalidateObject`). A new path that writes workspace objects without going
  through `userStore` breaks "write, then run": route it through `userStore`.

## Callers and namespaces (P1)

- The shared `SANDBOX_INTERNAL_TOKEN` is the legacy caller (copilot-v2).
  Its namespace is empty and its ids are raw. That is what keeps production
  data where it is.
- Every other caller is in `CAC_CALLERS`, as id + namespace + sha256 of its key.
- Never store the key itself.
- A namespaced caller's identity is rewritten to `<ns>--<id>` at the door, and
  stripped again in `writeJson`.
- New code reading identity must read it from `req.headers` or `ctx.params`
  after the door, or from `readJsonBody`. Never reparse the raw URL or body,
  or you get the raw id back.
- A namespaced caller always has ownership enforced, whatever
  `SANDBOX_ENFORCE_OWNERSHIP` says.
- A namespaced caller only reaches the route allowlist in `callers.mjs`.
- New routes are operator-only by default. Allowlisting one is a decision:
  check that the route reads identity only through the door.
- SSE and streaming responses do not go through `writeJson`. If one ever
  carries a user or session id, strip it by hand.

## Mistakes already made

| What happened | Rule | Enforced by |
| --- | --- | --- |
| The extraction left imports pointing at files that stayed in copilot-v2 | Every relative import resolves inside the repo | self-check `import-resolves` |
| Three contract tests read copilot-v2 files and failed on ENOENT standalone | Go through `COPILOT_V2_ROOT`; `{ skip: <reason> }` when absent, never pass on nothing | self-check `cross-repo-guard` |
| `license.test` flipped the last base64url character, which also carries padding bits, so 1 run in 6 passed a "tampered" signature as valid | Tamper with a middle character | self-check `base64-tamper` |
| Every allocation in a new e2e test answered 503 `filer_exposure_unknown`, because the probe runs `docker run` and cannot answer on a test box | Set `SANDBOX_ALLOW_ANONYMOUS_FILER=1` unless the test is about the filer guard | self-check `filer-guard` |
| "Forbidden" probes hit `GET /v1/sandboxes/:id` and `GET /v1/workspace-quota/limits`, which do not exist, and got 404 for everyone (twice in a row) | Prove the route exists with `matchRoute(method, path)` before asserting a refusal | self-check `route-exists` |
| A test expected `/metrics` to refuse a namespaced caller, but it takes no token at all | Routes without auth are a closed list, each checked to name no tenant | self-check `public-routes` |
| The allocate reply was assumed to carry `user_id`; it does not | Read the handler's `writeJson` before asserting on a reply's shape | this file |
| A rewrite removed `repoRoot`, which the rest of the test still used, and the cross-repo run failed with `ReferenceError` | After narrowing a test, run it in BOTH modes (standalone and `COPILOT_V2_ROOT`) | this file |
| The self-check's first run flagged a template-string import, a comment and an image name as violations | A rule matches what the code DOES (opens a file, declares a route), not words that appear in it; every rule has a fixture proving it fires | `scripts/self-check.test.mjs` |
| The self-check then flagged its own fixtures | The fixture file is the one exclusion, by exact path | `scripts/self-check.mjs` |
| A file written through the API was still invisible in the rclone mount after 30 s (it caches listings for 5 min) | Every `userStore` write/delete invalidates the covering mount, awaited; proven by turning it off and watching two tests fail | `host-mount-s3.integration.test.mjs` |
| rclone applied the process umask over `--file-perms 0660`: files came out 0640, not writable by the sandbox's group | `--umask 007` | `host-mount-s3.test.mjs` + the integration test |
| On the rclone mount every file is uid 0, so git refused every repository ("dubious ownership") | `safe.directory=*` through `GIT_CONFIG_COUNT` for s3-driver sandboxes; never map the uid to a host account | `host-mount-s3.test.mjs` |
| `{ skip: null }` — a `why()` returning null for "run" — made node report six real, failing tests as SKIPPED | A skip value is `false` or a reason, never null | self-check `skip-null` |
| The first `skip-null` rule matched `skip: name` but not the shorthand `{ skip }`, which is how the mistake was written; its fixture passed only because it had both | A fixture is written the way the mistake was | `scripts/self-check.test.mjs` |
| The delete test passed with invalidation off: the file it deleted had never been visible, so "gone" was true from the start | An assertion of absence needs a precondition proving presence (same as `route-exists`) | this file |
| The S3 driver's default bucket was written `WEED_S3_BUCKET \|\| S3_BUCKET` — the fallback behind the 2026-09-07 two-bucket incident | One bucket variable | self-check `single-bucket` |
| `pkill -f "rclone … mount"` matched and killed the shell running it (exit 144) | Match processes by name (`pgrep -x rclone`), never by a command-line pattern your own shell contains | this file |
| rclone died with "bind: invalid argument" on a socket under the scratchpad: a unix socket path is ≤ 107 bytes | Sockets are named by hash under a short directory; a long one is refused at config time | `host-mount-s3.test.mjs` |
| The sandbox-runtime image had no `fusermount3`, and the host's cannot be borrowed (glibc mismatch) | `fuse3` in the Dockerfile; the doctor names what is missing | `storage-doctor.test.mjs` |
| `docker network create` failed: "all predefined address pools have been fully subnetted" | The bundle declares its subnets; test scripts join an existing container's network namespace instead of creating networks | `deploy/compose/`, `scripts/s3-mount-it.sh` |
| Compose did not create the sandbox network because no service joins it (and none may) | The cac container creates it at start | `deploy/compose/docker-compose.yml` |
| Shutdown never unmounted, so with mounts propagated to the host every `compose down` left dead FUSE mounts there | `shutdown()` unmounts first (capped at 5 s); the smoke fails on any mount left | `scripts/bundle-smoke.sh` |
| A doctor message claimed "SeaweedFS ≥ 3.80" supports conditional writes — never measured | User-facing claims name only what was measured (MinIO, SeaweedFS 4.41) | this file |
| "git works on the s3 mount" was reported after fixing only "dubious ownership"; `git init` had never run. The mount showed every file as uid 0, and with `--default-permissions` only the owner may chmod — git chmods `config.lock` on every config write. Found by the bundle smoke | The mount's `--uid` is the sandbox's uid (`SANDBOX_HOST_MOUNT_S3_UID`, 2468, never 1000 or 0) and the sandbox runs `--user 2468:<gid>`. A tool "works" only after it ran as the sandbox's uid: root may chmod anything | integration test "git … as the sandbox's uid" (red with `--uid 0`) |
| The per-workspace manager adopted the mount ROOT at reconcile: in the bundle the root is itself a bind mount, so it is in /proc/mounts. It got an idle timer (it would have unmounted every workspace) and matched every invalidation | Reconcile skips the root; only `<root>/<bucket>/<subpath>` is ever a workspace | unit test "reconcile never adopts the mount root" |
| `s3-mount-it.sh` exited 0 when the integration tests were skipped or failed: `node --test | tee` under `sh` (no pipefail) returns tee's status | The script greps `# fail 0` and `# skipped 0`; a skip there is a failure | `scripts/s3-mount-it.sh` |
| The git test first ran under the IT's 0700 temp root; git stats every parent, so it failed for a reason no sandbox has | Test from where the sandbox stands: bind the mount at an open path, as docker binds /workspace | integration test |
| `harness-server.cjs` looked like part of the sandbox image, but it is copilot-v2's agent harness, built from its `runtime/apps/ava-local` | The sandbox template image belongs to the caller. CAC runs whatever `SANDBOX_DOCKER_IMAGE` says | this file |

## Working on the shared machine

This repo is developed on the machine that also runs production for
agent.unieai.com and Studio.

- Ask the owner before any `docker build`.
- Never `docker system prune -a`: it deletes the on-demand sandbox template image.
- Do not run the full suite while a production deploy is building. It competes
  for the same CPU.
- Give every test run a timeout. Leave no servers or containers behind; the
  e2e tests close their server in `after()`.
