# CLAUDE.md

Guidance for agents working in UnieAI Cloud Agent Computer (CAC). Read the
"Mistakes already made" section before changing code or tests.

Plan, contracts and phases: https://claude.ai/artifact/KMM8Kwt88bC7x2hukQ4RY7

## Before you say "done"

```bash
npm run check        # self-check (scripts/self-check.mjs) + the whole suite
COPILOT_V2_ROOT=<copilot-v2 checkout> npm test   # also runs the cross-repo contracts
```

Both must be green. "Green" means 0 fail. Read the skip count too: standalone
skips 4 (3 cross-repo contracts + the Docker round trip), with
`COPILOT_V2_ROOT` it skips 1. A different number means a test started skipping
silently.

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
