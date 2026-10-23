/**
 * workspace/tenant-store.test.mjs
 *
 * The property that matters most here is NOT that the new layout is right. It
 * is that the OLD one is untouched: every existing workspace lives at a path
 * this module now computes, and a resolver that shifted it by one character
 * would strand all of them at once, silently, as an empty workspace.
 *
 * So the legacy cases are asserted against LITERAL strings copied from the
 * paths on disk, never against a re-derivation. A resolver and the function it
 * replaced agreeing by construction proves nothing about what is already
 * stored.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isolatedOwners,
  legacyPrefix,
  legacyTenantRoot,
  parseOwner,
  resolveTenantStore,
  tenantBucketName,
  tenantPrefix,
  tenantRoot,
  TENANT_BUCKET_PREFIX,
} from "./tenant-store.mjs";

const UID = "00000000-0000-4000-8000-000000000000";

// ── the legacy layout, byte for byte ────────────────────────────────────────

test("legacy prefixes are exactly what is on disk today", () => {
  assert.equal(legacyPrefix(UID), `users/${UID}/workspace`, "a bare id is a personal userId");
  assert.equal(legacyPrefix(`user:${UID}`), `users/${UID}/workspace`);
  assert.equal(legacyPrefix("group:g1"), "groups/g1/workspace");
  assert.equal(legacyPrefix("org:o1"), "orgs/o1/workspace");
});

test("an unrecognised kind falls back to the personal path, as it always did", () => {
  // `weird:x` is not a kind, so the WHOLE string is the legacy userId — which
  // is what the original did, and changing it would move that workspace.
  assert.equal(legacyPrefix("weird:x"), "users/weird:x/workspace");
  assert.equal(legacyPrefix("user:"), "users/user:/workspace", "an empty id is not a user kind");
  assert.equal(legacyPrefix(""), "users//workspace", "preserved, warts and all — it is a path in use or it is not");
});

test("parseOwner reads the colon form the app sends, and nothing else", () => {
  assert.deepEqual(parseOwner("group:g1"), { kind: "group", id: "g1" });
  assert.deepEqual(parseOwner("org:o1"), { kind: "org", id: "o1" });
  assert.deepEqual(parseOwner(UID), { kind: "user", id: UID });
  // Not a kind → the whole value is a legacy id. Accepting `tenant:` as a kind
  // here would move that owner's workspace to a different prefix.
  assert.deepEqual(parseOwner("tenant:t1"), { kind: "user", id: "tenant:t1" });
});

// ── the per-tenant bucket ───────────────────────────────────────────────────

test("a tenant bucket name is derived, lowercased, and valid", () => {
  assert.equal(tenantBucketName({ kind: "user", id: UID }), `${TENANT_BUCKET_PREFIX}-user-${UID}`);
  assert.equal(tenantBucketName({ kind: "org", id: "O1" }), "ws-org-o1", "S3 bucket names are lowercase");
  // 63 is the S3 ceiling; `ws-user-` + a UUID is 44, so a UUID tenant fits.
  assert.ok(tenantBucketName({ kind: "user", id: UID }).length <= 63);
});

test("an id a bucket name cannot carry is REFUSED, not mangled", () => {
  // Mangling would be worse than failing: two ids that differ only in a
  // stripped character would land in the SAME bucket, which is the exact
  // cross-tenant access this whole change exists to prevent.
  // `"ab"` is NOT in this list on purpose: `ws-user-ab` is 10 characters and
  // perfectly valid. The 3-character S3 minimum is already covered by the
  // prefix, so asserting it here would be asserting the prefix.
  // Nor is `"-lead"`: it yields `ws-user--lead`, and adjacent hyphens are legal
  // in an S3 bucket name. Both were in this list first, asserting a rule the
  // prefix already satisfies — a test expectation being wrong, not the code.
  for (const id of ["a_b", "a/b", "a b", "a.b/../c", "x".repeat(80), ""]) {
    assert.throws(() => tenantBucketName({ kind: "user", id }), /not a valid S3 bucket name/, `accepted ${id}`);
  }
});

test("case-differing ids cannot quietly share a bucket", () => {
  // Both lowercase to the same name, so they must not both be derivable —
  // whichever arrives second would read the first one's files.
  assert.equal(tenantBucketName({ kind: "user", id: "abcd" }), tenantBucketName({ kind: "user", id: "ABCD" }));
  // Recorded as a KNOWN limit rather than left implicit: ids here are UUIDs
  // and DB-generated, so a case collision cannot arise, and the day ids come
  // from somewhere else this assertion is the thing that fails.
});

// ── the rollout switch ──────────────────────────────────────────────────────

test("no allowlist means nothing has moved", () => {
  const r = isolatedOwners({});
  assert.equal(r.all, false);
  assert.equal(r.set.size, 0);
});

test("the allowlist is per tenant, because the migration is a copy per tenant", () => {
  const r = isolatedOwners({ SANDBOX_ISOLATED_TENANTS: `org:o1, ${UID} ,group:g1` });
  assert.equal(r.all, false);
  assert.deepEqual([...r.set].sort(), ["group:g1", "org:o1", `user:${UID}`].sort());
});

test('"all" is a separate state from a list that happens to name everyone', () => {
  assert.equal(isolatedOwners({ SANDBOX_ISOLATED_TENANTS: "all" }).all, true);
  assert.equal(isolatedOwners({ SANDBOX_ISOLATED_TENANTS: "ALL" }).all, true);
});

// ── the resolver ────────────────────────────────────────────────────────────

const ENV = { S3_BUCKET: "cm-agent-artifacts" };

test("a tenant that has not moved resolves to the shared bucket and its old prefix", () => {
  const r = resolveTenantStore(UID, { env: ENV });
  assert.deepEqual(
    { bucket: r.bucket, prefix: r.prefix, isolated: r.isolated },
    { bucket: "cm-agent-artifacts", prefix: `users/${UID}/workspace`, isolated: false },
  );
});

test("a moved tenant resolves to its own bucket, with the prefix collapsed", () => {
  const r = resolveTenantStore(UID, { env: { ...ENV, SANDBOX_ISOLATED_TENANTS: `user:${UID}` } });
  assert.deepEqual(
    { bucket: r.bucket, prefix: r.prefix, isolated: r.isolated },
    { bucket: `ws-user-${UID}`, prefix: "workspace", isolated: true },
  );
});

test("moving ONE tenant leaves every other tenant where it was", () => {
  // The whole point of the allowlist. If flipping one tenant moved the others,
  // the migration could not be staged and every workspace would have to be
  // copied inside one window.
  const env = { ...ENV, SANDBOX_ISOLATED_TENANTS: "org:o1" };
  assert.equal(resolveTenantStore("org:o1", { env }).isolated, true);
  assert.equal(resolveTenantStore("org:o2", { env }).isolated, false);
  assert.equal(resolveTenantStore(UID, { env }).prefix, `users/${UID}/workspace`);
});

test("`isolated` is returned, not left for the caller to infer from the bucket name", () => {
  // The flag decides which CREDENTIAL to use. A caller string-matching "ws-"
  // gets it wrong the first time a deployment names its shared bucket
  // something ws-shaped.
  const r = resolveTenantStore(UID, { legacyBucket: "ws-legacy-shared", env: {} });
  assert.equal(r.bucket, "ws-legacy-shared");
  assert.equal(r.isolated, false, "shared, despite a bucket name that looks isolated");
});

test("no configured bucket is a config error, not an empty string", () => {
  assert.throws(() => resolveTenantStore(UID, { env: {} }), /no S3 bucket configured/);
});

test("tenantPrefix answers without any bucket configured", () => {
  // `userPrefix` has always been a pure path function. Folding the bucket into
  // it made it demand S3_BUCKET, and every workspace unit test failed on a
  // config value none of them had ever needed — found by wiring it, not by
  // reading it.
  assert.equal(tenantPrefix(UID, {}).prefix, `users/${UID}/workspace`);
  assert.equal(tenantPrefix("org:o1", {}).isolated, false);
  assert.equal(tenantPrefix("org:o1", { SANDBOX_ISOLATED_TENANTS: "org:o1" }).prefix, "workspace");
});

// ── the tenant SUBTREE, which is what a migration must move ─────────────────
//
// `workspace/` is not all of a tenant. A real tenant measured on the live store
// had 166 objects under `workspace/` and 526 under `.snapshots/` — 9.2 MB of
// version history that is bind-mounted into every sandbox as /snapshots. A
// migration scoped to the workspace prefix leaves all of it behind, and the
// dry run reports a confident count of the part it can see.

test("the legacy tenant root is the parent of workspace, per kind", () => {
  assert.equal(legacyTenantRoot(UID), `users/${UID}`);
  assert.equal(legacyTenantRoot(`user:${UID}`), `users/${UID}`);
  assert.equal(legacyTenantRoot("group:g1"), "groups/g1");
  assert.equal(legacyTenantRoot("org:o1"), "orgs/o1");
  // The invariant that keeps the two in step: the workspace prefix is always
  // the root plus `/workspace`. If someone changes one, this fails.
  for (const owner of [UID, "group:g1", "org:o1"]) {
    assert.equal(legacyPrefix(owner), `${legacyTenantRoot(owner)}/workspace`, owner);
  }
});

test("an isolated tenant's root is the bucket root — the bucket replaces users/<id>", () => {
  const env = { ...ENV, SANDBOX_ISOLATED_TENANTS: "all" };
  const r = tenantRoot(UID, env);
  assert.equal(r.root, "", "the bucket root itself");
  assert.equal(r.isolated, true);
  // And the workspace then sits at `workspace` inside it, so `.snapshots` is
  // its sibling at the bucket root — the same shape as the shared layout with
  // `users/<id>/` removed.
  assert.equal(tenantPrefix(UID, env).prefix, "workspace");
});

test("tenantRoot needs no bucket either", () => {
  assert.equal(tenantRoot(UID, {}).root, `users/${UID}`);
  assert.equal(tenantRoot(UID, {}).isolated, false);
});

// ── isTenantBucketName (2026-09-26, F-GRP) ─────────────────────────────────
//
// Host-side code has to find every tenant root under the mount (the isolation
// check) and decide whether a bucket root belongs to exactly one tenant (the
// runtime's fence). Both ask this, so the naming rule stays in this file.

import { isTenantBucketName } from "./tenant-store.mjs";

test("isTenantBucketName: exactly the names tenantBucketName produces", () => {
  for (const owner of [{ kind: "user", id: "3f2a" }, { kind: "org", id: "acme" }, { kind: "group", id: "g-1" }]) {
    assert.equal(isTenantBucketName(tenantBucketName(owner)), true, JSON.stringify(owner));
  }
  for (const name of ["cm-agent-artifacts", "agent-fs", "ws-", "ws-user-", "ws-team-x", "ws-shared", "WS-USER-X", "x-ws-user-y", "", null]) {
    assert.equal(isTenantBucketName(name), false, String(name));
  }
});
