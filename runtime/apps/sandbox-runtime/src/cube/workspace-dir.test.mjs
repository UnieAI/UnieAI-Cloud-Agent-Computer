/**
 * A tenant's `/workspace` must be WRITABLE by the sandbox's own user.
 *
 * It is not, for any tenant whose directory did not already exist. Measured
 * 2026-09-07 against production: a brand-new tenant's first sandbox reported
 * `/bin/bash: /workspace/.doorb: Permission denied`, and the directory docker
 * had just created for the bind source was `root:root 0755`. The image runs as
 * `USER user` (uid 1000), so it cannot write there — and cannot fix it either.
 *
 * The control run matters: the same failure happened with the tenant-parent
 * permissions reverted, so this is not a side effect of fencing the parents.
 * It is what docker does with a bind source that does not exist yet.
 *
 * On the live store this had already produced two populations in one bucket —
 * 7 directories at `ubuntu:ubuntu 0777` (usable) and 10 at `root:root 0771`
 * (not) — and the second set would have become the mounted ones the moment the
 * bucket convergence shipped. That is the shape of the bug: invisible until a
 * configuration change makes the wrong half live.
 *
 * The fix runs BEFORE the sandbox: a short root-privileged container that
 * creates the directory and hands it to the sandbox's uid. Root is not
 * borrowed for this — docker already runs as root and already creates this
 * directory; the only change is that it now creates it usable.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { workspaceFixupPlan, needsWorkspaceFixup } from "./workspace-dir.mjs";

test("a missing directory needs the fixup", () => {
  assert.equal(needsWorkspaceFixup({ exists: false }), true);
});

test("a directory the sandbox uid cannot write needs the fixup", () => {
  assert.equal(needsWorkspaceFixup({ exists: true, uid: 0, mode: 0o771 }), true, "root:root 0771 — the shape docker leaves");
  assert.equal(needsWorkspaceFixup({ exists: true, uid: 0, mode: 0o755 }), true);
});

test("a directory that is already usable is left alone", () => {
  // Idempotence is the point: this runs on the allocation path, and a fixup
  // that fired every time would put a container start in front of every
  // sandbox — the same cost that makes safety checks get disabled.
  assert.equal(needsWorkspaceFixup({ exists: true, uid: 1000, mode: 0o777 }), false);
  assert.equal(needsWorkspaceFixup({ exists: true, uid: 1000, mode: 0o770 }), false);
  // Owned by someone else but world-writable is still usable. Not our business
  // to normalise: touching it would rewrite metadata another product reads.
  assert.equal(needsWorkspaceFixup({ exists: true, uid: 0, mode: 0o777 }), false);
});

test("the plan binds the workspace path itself, never the tenant parent", () => {
  const plan = workspaceFixupPlan({
    hostPath: "/mnt/ava/cm-agent-artifacts/users/u-1/workspace",
    image: "sandbox:latest",
    uid: 1000,
    gid: 1000,
  });
  // Binding the PARENT would hand a container every sibling tenant. The
  // workspace path is the whole grant, and docker creates it if missing.
  assert.ok(plan.args.includes("-v"));
  const v = plan.args[plan.args.indexOf("-v") + 1];
  assert.equal(v, "/mnt/ava/cm-agent-artifacts/users/u-1/workspace:/w");
  assert.ok(!v.includes("/users:/"), "the tenant parent must never be bound");
  assert.ok(plan.args.includes("--rm"), "no leftover container per allocation");
  assert.deepEqual(plan.args.slice(0, 2), ["run", "--rm"]);
  assert.ok(plan.args.includes("--network"), "it needs no network; say so explicitly");
  assert.equal(plan.args[plan.args.indexOf("--network") + 1], "none");
  // The image has its own ENTRYPOINT (`agent-entrypoint.sh`), so a bare
  // `sh -c ...` arrives as ARGUMENTS to that script rather than as the command.
  // Measured: the first attempt failed with the entrypoint's own error,
  // "WORKSPACE_BUCKET required" — which is the entrypoint complaining, not the
  // fixup failing at what it was asked to do.
  assert.ok(plan.args.includes("--entrypoint"), "the image's entrypoint must be replaced, not fed arguments");
  assert.equal(plan.args[plan.args.indexOf("--entrypoint") + 1], "sh");
  assert.ok(plan.args.includes("--user"));
  assert.equal(plan.args[plan.args.indexOf("--user") + 1], "0:0");
  const script = plan.args[plan.args.length - 1];
  assert.match(script, /chown 1000:1000/);
  assert.match(script, /chmod/);
  // The bound path, not a computed one — the container must not be able to
  // walk out of what it was given.
  assert.doesNotMatch(script, /\.\./);
});

test("the uid comes from the image's user, not a constant", () => {
  const plan = workspaceFixupPlan({ hostPath: "/m/w", image: "i", uid: 1234, gid: 5678 });
  assert.match(plan.args[plan.args.length - 1], /chown 1234:5678/);
});

// ── the tenant ROOT of a per-tenant bucket (2026-09-26, F-GRP) ───────────────
//
// On a per-tenant bucket (`/mnt/ava/ws-<kind>-<id>`) the bucket root IS the
// tenant's root, and `s3.bucket.create` makes it 0777 root:root
// (weed/shell/command_s3_bucket_create.go:92 in the running 4.41). A host
// account can then walk into the tenant's workspace — and, with write on the
// root, rename `workspace` away and plant its own. The fence is the same shape
// as the tenant-parent fence in docs/ops/filer-auth.md: owned by root, nothing
// for "other". Group is filer gid 0, which the host mount shows as the
// workspace group (workspace-group.mjs) — nobody on the host is in it.

import { tenantRootFencePlan, tenantRootFenced } from "./workspace-dir.mjs";

test("the fence plan binds the tenant's OWN root and makes it root-owned 0770", () => {
  const plan = tenantRootFencePlan({ hostPath: "/mnt/ava/ws-user-u1", image: "sandbox:latest" });
  const v = plan.args[plan.args.indexOf("-v") + 1];
  assert.equal(v, "/mnt/ava/ws-user-u1:/b");
  assert.deepEqual(plan.args.slice(0, 2), ["run", "--rm"]);
  assert.equal(plan.args[plan.args.indexOf("--network") + 1], "none");
  assert.equal(plan.args[plan.args.indexOf("--user") + 1], "0:0");
  assert.equal(plan.args[plan.args.indexOf("--entrypoint") + 1], "sh");
  const script = plan.args[plan.args.length - 1];
  // chown FIRST: a root owned by uid 1000 keeps rwx for its owner after a bare
  // chmod — two production roots are exactly that (`ubuntu:ubuntu 0777`).
  assert.equal(script, "chown 0:0 /b && chmod 0770 /b");
  assert.doesNotMatch(script, /-R|\.\./, "the root only — never recursive, never outside the bind");
});

test("the fence plan refuses to run without a path or an image", () => {
  assert.throws(() => tenantRootFencePlan({ hostPath: "", image: "i" }));
  assert.throws(() => tenantRootFencePlan({ hostPath: "/mnt/ava/ws-user-u1", image: "" }));
});

test("the workspace fixup plan is unchanged by sharing the one-shot layout", () => {
  const plan = workspaceFixupPlan({ hostPath: "/m/w", image: "i" });
  assert.deepEqual(plan.args, [
    "run", "--rm", "--network", "none", "--entrypoint", "sh", "--user", "0:0", "-v", "/m/w:/w", "i", "-c",
    "chown 1000:1000 /w && chmod 0770 /w",
  ]);
});

test("fenced = root-owned, nothing for other, group root or the workspace group, and closed to THIS process", () => {
  const S = 0o040000;
  const fenced = (o) => tenantRootFenced({ workspaceGid: 2468, ...o });
  assert.equal(fenced({ uid: 0, gid: 2468, mode: S | 0o770, traversable: false }), true);
  assert.equal(fenced({ uid: 0, gid: 0, mode: S | 0o770, traversable: false }), true, "before the gid map is live");
  assert.equal(fenced({ uid: 0, gid: 0, mode: S | 0o750, traversable: false }), true);
  // Not fenced:
  assert.equal(fenced({ uid: 0, gid: 0, mode: S | 0o777, traversable: true }), false, "s3.bucket.create's 0777");
  assert.equal(fenced({ uid: 0, gid: 0, mode: S | 0o771, traversable: false }), false, "--x for other still walks in by name");
  assert.equal(fenced({ uid: 1000, gid: 1000, mode: S | 0o770, traversable: true }), false, "owned by a host account");
  assert.equal(fenced({ uid: 1000, gid: 1000, mode: S | 0o700, traversable: true }), false);
  // A group some host account IS in (docker, adm, the login account's own) is
  // not a fence even when this process happens not to be in it.
  assert.equal(fenced({ uid: 0, gid: 988, mode: S | 0o770, traversable: false }), false);
  // Everything right on paper but this process CAN get in → it is in the group.
  assert.equal(fenced({ uid: 0, gid: 2468, mode: S | 0o770, traversable: true }), false);
  // Could not ask → unknown, not a pass.
  assert.equal(fenced({ uid: 0, gid: 2468, mode: S | 0o770, traversable: null }), null);
});
