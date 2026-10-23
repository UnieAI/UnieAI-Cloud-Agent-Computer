/**
 * bucket-agreement.test.mjs — the sandbox MOUNT and the workspace STORE must
 * name the same (bucket, prefix) for the same tenant.
 *
 * WHY THIS EXISTS. Two independent resolvers answer "where does this tenant's
 * workspace live", and nothing made them agree:
 *
 *   MOUNT   cube/docker.mjs::resolveWorkspaceLocation  → WEED_S3_BUCKET || S3_BUCKET
 *                                                        + its own ownerToPrefix
 *   STORE   workspace/userStore.mjs → storage-engine   → S3_BUCKET
 *
 * CORRECTION, 2026-09-07 — the parenthetical that used to stand here called
 * `resolveTenantStore` "a faithful stand-in for the store's answer without a
 * live S3 client". It was not. `storage-engine` took no bucket at all and
 * hardcoded `Bucket: config.bucket`, so it consulted NEITHER resolver, and two
 * resolvers agreeing with each other could never detect that. The measured cost
 * of the gap: with two tenants isolated their prefixes both collapse to
 * `workspace/...`, both land in the shared bucket, and the second tenant's
 * write DESTROYS the first tenant's file.
 *
 * The store now takes a `(bucket, key)` location it cannot be called without;
 * what this file asserts is genuinely mount-vs-resolver agreement, and nothing
 * more. The store's own behaviour is asserted against the bytes it writes and
 * the commands it sends, in store-bucket-isolation.test.mjs and
 * store-bucket-on-the-wire.test.mjs — including a direct mount-vs-STORE check
 * that does not go through a stand-in.
 *
 * MEASURED on this deployment 2026-09-07: `.env` sets WEED_S3_BUCKET=agent-fs
 * and S3_BUCKET=cm-agent-artifacts, so the sandbox bind-mounted
 * /mnt/ava/agent-fs/users/<id>/workspace — EMPTY for the active tenant — while
 * the file panel read and wrote users/<id>/workspace in cm-agent-artifacts
 * (10 objects, newest 02:39 the same morning). One tenant additionally got a
 * freshly `git init`-ed .snapshots repo in agent-fs shadowing 526 objects of
 * real snapshot history in cm-agent-artifacts, so 版本歷史 read as empty.
 *
 * Neither resolver is wrong on its own terms, and both have their own passing
 * unit tests. The defect only exists BETWEEN them, which is why the assertion
 * has to compare them directly rather than each against a literal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveWorkspaceLocation } from "../cube/docker.mjs";
import { resolveTenantStore } from "./tenant-store.mjs";

const UID = "4469db50-6fa7-4a11-a1c5-f10f680ab0df";
const OWNER = `user:${UID}`;

/**
 * `resolveWorkspaceLocation` reads `process.env` directly (it takes no env
 * argument), so the only way to ask it about a deployment's config is to BE
 * that deployment for the length of the call. Restored in a finally so one
 * failing case cannot leak its env into the next test.
 */
function withEnv(vars, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Both halves of the location, from both resolvers, for one owner. */
function bothAnswers(owner, env) {
  return withEnv(env, () => {
    const mount = resolveWorkspaceLocation({ workspaceMode: "user", workspaceOwner: owner });
    const store = resolveTenantStore(owner);
    return {
      mount: { bucket: mount.bucket, path: mount.subpath },
      store: { bucket: store.bucket, path: store.prefix },
    };
  });
}

test("mount and store agree when only S3_BUCKET is set", () => {
  // The baseline. This one passes today, and it is here so a regression that
  // breaks the SIMPLE config is distinguishable from the divergence below.
  const { mount, store } = bothAnswers(OWNER, {
    S3_BUCKET: "cm-agent-artifacts",
    WEED_S3_BUCKET: undefined,
    SANDBOX_ISOLATED_TENANTS: undefined,
  });
  assert.deepEqual(mount, store);
});

test("mount and store agree when WEED_S3_BUCKET is ALSO set (the live config)", () => {
  // RED as of 2026-09-07: mount says agent-fs, store says cm-agent-artifacts.
  // `WEED_S3_BUCKET` belongs to runtime/packages/agent-fs — a package nothing
  // in production imports — and docker.mjs picking it up as a preference is
  // what split the two trees.
  const { mount, store } = bothAnswers(OWNER, {
    S3_BUCKET: "cm-agent-artifacts",
    WEED_S3_BUCKET: "agent-fs",
    SANDBOX_ISOLATED_TENANTS: undefined,
  });
  assert.deepEqual(
    mount,
    store,
    "the sandbox would bind-mount a different bucket than the file panel reads",
  );
});

test("mount and store agree for a tenant that has been ISOLATED", () => {
  // RED as of 2026-09-07, and independently of WEED_S3_BUCKET: docker.mjs's
  // `ownerToPrefix` is a hand-copy of `legacyPrefix` that never consults
  // `isolatedOwners`, so the first tenant moved to its own bucket would be
  // mounted from the SHARED one at its pre-migration prefix. Asserted now, in
  // advance, because the migration tooling exists and the flag is one env var
  // away from being set.
  const { mount, store } = bothAnswers(OWNER, {
    S3_BUCKET: "cm-agent-artifacts",
    WEED_S3_BUCKET: undefined,
    SANDBOX_ISOLATED_TENANTS: OWNER,
  });
  assert.deepEqual(
    mount,
    store,
    "an isolated tenant's sandbox would mount the shared bucket the migration moved it off",
  );
});
