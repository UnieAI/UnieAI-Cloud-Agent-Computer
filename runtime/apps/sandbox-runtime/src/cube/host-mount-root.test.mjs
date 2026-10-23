/**
 * ONE mount at the filer's `/buckets` must satisfy every bucket under it.
 *
 * The mount unit gives each bucket its own FUSE mount
 * (`-filer.path=/buckets/<bucket>` → `/mnt/ava/<bucket>`), and `assertTreeLive`
 * asks `/proc/mounts` whether `<root>/<bucket>` is a mountpoint. That works for
 * one bucket and does not scale to per-tenant ones: the moment a tenant is
 * isolated into `ws-user-<id>`, its bucket has no mount and allocation fails
 * with `workspace_tree_not_mounted`.
 *
 * MEASURED 2026-09-07, in production: five tenants were migrated and added to
 * `SANDBOX_ISOLATED_TENANTS`, every workspace listing verified identical — and
 * then every sandbox for those tenants returned 503. Rolled back within a
 * minute. The store was right, the copies were right; the MOUNT TOPOLOGY was
 * the thing that did not follow.
 *
 * Also measured, on the live filer: `weed mount -filer.path=/buckets
 * -dir=/mnt/ava-test-root` lists every bucket as a subdirectory and resolves
 * `ws-user-<id>/workspace` directly. So one mount is enough — but only if the
 * liveness check accepts the ROOT ITSELF as the mount, which `probeMounts`
 * deliberately excludes today (it collects only entries strictly BELOW root).
 *
 * Both topologies must work: per-bucket mounts are what is deployed right now,
 * and a check that accepted only the new shape would refuse the running one.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { treeIsMounted } from "./host-mount.mjs";

const ROOT = "/mnt/ava";

test("a per-bucket mount satisfies that bucket — the topology deployed today", () => {
  const mounts = new Set(["/mnt/ava/cm-agent-artifacts"]);
  assert.equal(treeIsMounted({ mounts, root: ROOT, treePath: "/mnt/ava/cm-agent-artifacts" }), true);
  // And says nothing about a bucket it does not cover.
  assert.equal(treeIsMounted({ mounts, root: ROOT, treePath: "/mnt/ava/ws-user-abc" }), false);
});

test("a single mount AT THE ROOT satisfies every bucket under it", () => {
  const mounts = new Set(["/mnt/ava"]);
  assert.equal(treeIsMounted({ mounts, root: ROOT, treePath: "/mnt/ava/cm-agent-artifacts" }), true);
  assert.equal(treeIsMounted({ mounts, root: ROOT, treePath: "/mnt/ava/ws-user-abc" }), true);
  // This is the whole point: N tenants, one mount.
  assert.equal(treeIsMounted({ mounts, root: ROOT, treePath: "/mnt/ava/ws-org-xyz" }), true);
});

test("nothing mounted is still nothing — an empty set never satisfies", () => {
  // The refusal exists because binding a bare directory hands the tenant an
  // EMPTY workspace instead of an error, which is the silent failure this
  // whole path is built to avoid.
  assert.equal(treeIsMounted({ mounts: new Set(), root: ROOT, treePath: "/mnt/ava/cm-agent-artifacts" }), false);
});

test("a mount elsewhere does not count", () => {
  // A mount at a DIFFERENT root says nothing about this one; accepting it
  // would be the same "looks mounted and is not" the ENOTCONN branch exists for.
  const mounts = new Set(["/mnt/other", "/mnt/ava-test-root"]);
  assert.equal(treeIsMounted({ mounts, root: ROOT, treePath: "/mnt/ava/cm-agent-artifacts" }), false);
});
