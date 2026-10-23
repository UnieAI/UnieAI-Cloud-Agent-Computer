/**
 * Tests for the HOST-side filer exposure check.
 *
 * One test in this file ("no unprivileged process on THIS host …") is a LIVE
 * measurement of the machine it runs on — see docs/ops/filer-auth.md and, for
 * the per-tenant bucket roots, docs/ops/ava-workspace-group-access.md. Every
 * other test injects its I/O. The live one is written so that it is green where there is
 * genuinely nothing to measure (CI, a laptop): a host with no
 * `fuse.seaweedfs` mount under the mount root mounts no tenant data and has no
 * exposure to have. It is never green because a probe failed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  HOST_ACK_ENV,
  checkHostFilerExposure,
  discoverTenantNames,
  hostExposureVerdict,
  parseSeaweedMounts,
  probeAnonymousFilerRead,
  probeTenantTreeAccessible,
} from "./host-filer-exposure.mjs";

// ── parseSeaweedMounts ────────────────────────────────────────────────────

const PROC_MOUNTS = [
  "sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0",
  "172.20.0.4:8888:/buckets/cm-agent-artifacts /mnt/ava/cm-agent-artifacts fuse.seaweedfs rw,nosuid,nodev,relatime,user_id=0,group_id=0,default_permissions,allow_other 0 0",
  "172.20.0.4:8888:/buckets/agent-fs /mnt/ava/agent-fs fuse.seaweedfs rw,nosuid,nodev,relatime,user_id=0,group_id=0,default_permissions,allow_other 0 0",
  "/dev/sda1 /mnt/other ext4 rw,relatime 0 0",
  "",
].join("\n");

test("parseSeaweedMounts reads the filer address the running mount really uses", () => {
  const mounts = parseSeaweedMounts(PROC_MOUNTS, "/mnt/ava");
  assert.equal(mounts.length, 2);
  assert.deepEqual(mounts[0], {
    host: "172.20.0.4",
    port: 8888,
    remotePath: "/buckets/cm-agent-artifacts",
    mountPoint: "/mnt/ava/cm-agent-artifacts",
  });
  assert.equal(mounts[1].mountPoint, "/mnt/ava/agent-fs");
});

test("parseSeaweedMounts ignores non-seaweed filesystems and mounts outside the root", () => {
  assert.equal(parseSeaweedMounts(PROC_MOUNTS, "/mnt/other").length, 0);
  assert.equal(parseSeaweedMounts("", "/mnt/ava").length, 0);
  assert.equal(parseSeaweedMounts(null, "/mnt/ava").length, 0);
});

test("parseSeaweedMounts does not treat a sibling directory as being under the root", () => {
  // /mnt/ava-backup must not match a /mnt/ava root. String prefix matching
  // without the separator is how that bug is written.
  const line =
    "172.20.0.4:8888:/buckets/b /mnt/ava-backup/b fuse.seaweedfs rw 0 0";
  assert.equal(parseSeaweedMounts(line, "/mnt/ava").length, 0);
});

// ── hostExposureVerdict ───────────────────────────────────────────────────

test("no workspace tree on this host is a genuine pass, not a measurement", () => {
  const v = hostExposureVerdict({ applicable: false });
  assert.equal(v.ok, true);
  assert.equal(v.applicable, false);
});

test("both doors shut is the only clean pass", () => {
  const v = hostExposureVerdict({
    applicable: true,
    privileged: false,
    filerAnonymousRead: false,
    tenantTreeAccessible: false,
    filerAddress: { host: "172.20.0.4", port: 8888 },
  });
  assert.equal(v.ok, true);
  assert.ok(!v.accepted);
});

test("an open filer port alone refuses", () => {
  const v = hostExposureVerdict({
    applicable: true,
    filerAnonymousRead: true,
    tenantTreeAccessible: false,
    filerAddress: { host: "172.20.0.4", port: 8888 },
  });
  assert.equal(v.ok, false);
  assert.equal(v.code, "host_exposure_refused");
  assert.equal(v.doors, 1);
  assert.match(v.reason, /anonymous GET/);
});

test("an open tenant tree alone refuses — closing the port is not sufficient", () => {
  // This is the case the whole file exists for. The filer port can be shut
  // while `users/<uuid>/workspace` stays 0777 under a `--x` parent, and a
  // check that only watched the port would call that fixed.
  const v = hostExposureVerdict({
    applicable: true,
    filerAnonymousRead: false,
    tenantTreeAccessible: true,
  });
  assert.equal(v.ok, false);
  assert.equal(v.code, "host_exposure_refused");
  assert.equal(v.doors, 1);
  assert.match(v.reason, /closing the filer port alone would not shut this/);
});

test("both doors open names both", () => {
  const v = hostExposureVerdict({
    applicable: true,
    filerAnonymousRead: true,
    tenantTreeAccessible: true,
  });
  assert.equal(v.doors, 2);
});

test("an unanswerable probe is never a pass", () => {
  const v = hostExposureVerdict({
    applicable: true,
    filerAnonymousRead: null,
    tenantTreeAccessible: false,
  });
  assert.equal(v.ok, false);
  assert.equal(v.code, "host_exposure_unknown");
});

test("running as root is refused as the wrong vantage point, not passed", () => {
  // The fix deliberately keeps root's access. Measuring root measures the
  // exception; reporting it as a pass is how this check would become a lie.
  const v = hostExposureVerdict({ applicable: true, privileged: true });
  assert.equal(v.ok, false);
  assert.equal(v.code, "host_exposure_wrong_vantage_point");
});

test("root is refused even when the acknowledgement is set", () => {
  const v = hostExposureVerdict({ applicable: true, privileged: true, acknowledged: true });
  assert.equal(v.ok, false);
  assert.equal(v.code, "host_exposure_wrong_vantage_point");
});

test("acknowledgement passes but says so every time", () => {
  const v = hostExposureVerdict({
    applicable: true,
    filerAnonymousRead: true,
    tenantTreeAccessible: true,
    acknowledged: true,
  });
  assert.equal(v.ok, true);
  assert.equal(v.accepted, true);
  assert.match(v.note, new RegExp(HOST_ACK_ENV));
});

// ── probeAnonymousFilerRead ───────────────────────────────────────────────

test("a listing served to an anonymous caller is the exposure", async () => {
  const res = await probeAnonymousFilerRead(
    { filerAddress: { host: "h", port: 8888 } },
    async () => ({ ok: true, status: 200, json: async () => ({ Entries: [{ FullPath: "/buckets/x" }] }) }),
  );
  assert.equal(res, true);
});

test("401/403 counts as closed", async () => {
  for (const status of [401, 403]) {
    const res = await probeAnonymousFilerRead(
      { filerAddress: { host: "h", port: 8888 } },
      async () => ({ ok: false, status, json: async () => ({}) }),
    );
    assert.equal(res, false, `status ${status}`);
  }
});

test("a refused connection counts as closed", async () => {
  const res = await probeAnonymousFilerRead({ filerAddress: { host: "h", port: 8888 } }, async () => {
    const err = new Error("connect ECONNREFUSED");
    err.cause = { code: "ECONNREFUSED" };
    throw err;
  });
  assert.equal(res, false);
});

test("an EMPTY listing served anonymously is still the exposure", async () => {
  // `{"Path":"/buckets","Entries":null}` is what an empty directory returns.
  // Scoring that as "closed" would hide the door behind an accident of content.
  const res = await probeAnonymousFilerRead(
    { filerAddress: { host: "h", port: 8888 } },
    async () => ({ ok: true, status: 200, json: async () => ({ Path: "/buckets", Entries: null }) }),
  );
  assert.equal(res, true);
});

test("an unexpected 200 shape is unknown, not a pass", async () => {
  const res = await probeAnonymousFilerRead(
    { filerAddress: { host: "h", port: 8888 } },
    async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }),
  );
  assert.equal(res, null);
});

test("a 500 is unknown, not closed", async () => {
  const res = await probeAnonymousFilerRead(
    { filerAddress: { host: "h", port: 8888 } },
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
  );
  assert.equal(res, null);
});

// ── probeTenantTreeAccessible ─────────────────────────────────────────────

const eacces = () => Object.assign(new Error("EACCES"), { code: "EACCES" });
const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
const okDir = async () => ({ close: async () => {} });

test("a listable tenant parent is open, no tenant name needed", async () => {
  const res = await probeTenantTreeAccessible(
    { mountPoints: ["/mnt/ava/b"], tenantNames: [] },
    { opendir: okDir, access: async () => {} },
  );
  assert.equal(res, true);
});

test("EACCES on the parent but a known name walks through — the 0771/0777 case", async () => {
  const res = await probeTenantTreeAccessible(
    { mountPoints: ["/mnt/ava/b"], tenantNames: ["uuid-1"], parents: ["users"] },
    {
      opendir: async (p) => {
        if (p === "/mnt/ava/b/users") throw eacces();
        if (p === "/mnt/ava/b/users/uuid-1/workspace") return { close: async () => {} };
        throw eacces();
      },
      // 0771 GRANTS `--x`: traversal succeeds, writing does not. The stub used
      // to throw for every mode, which modelled 0770 while the test's name says
      // 0771 — harmless until the probe started asking about X_OK, and then it
      // asserted the opposite of what it describes.
      access: async (_p, mode) => {
        if (mode === 0o1) return; // X_OK
        throw eacces();
      },
    },
  );
  assert.equal(res, true);
});

test("EACCES everywhere with names tried is genuinely closed", async () => {
  const res = await probeTenantTreeAccessible(
    { mountPoints: ["/mnt/ava/b"], tenantNames: ["uuid-1"], parents: ["users"] },
    {
      opendir: async () => {
        throw eacces();
      },
      access: async () => {
        throw eacces();
      },
    },
  );
  assert.equal(res, false);
});

test("EACCES with NO names to try is unknown, not closed", async () => {
  // Once the filer port is shut, tenant names stop being discoverable by this
  // route. Calling that "closed" would let the filesystem half go dark exactly
  // when the other half was fixed.
  //
  // This is the 0771 shape specifically — traversal still allowed — because
  // that is the case where a name WOULD have worked and we have none. When the
  // parent denies traversal as well (0770), no name could help and the answer
  // is a measured `false`; that case is asserted separately below.
  const res = await probeTenantTreeAccessible(
    { mountPoints: ["/mnt/ava/b"], tenantNames: [], parents: ["users"] },
    {
      opendir: async () => {
        throw eacces();
      },
      access: async (_p, mode) => {
        if (mode === 0o1) return; // X_OK — 0771
        throw eacces();
      },
    },
  );
  assert.equal(res, null);
});

test("a write-only path counts as open even when it cannot be listed", async () => {
  const res = await probeTenantTreeAccessible(
    { mountPoints: ["/mnt/ava/b"], tenantNames: ["uuid-1"], parents: ["users"] },
    {
      opendir: async () => {
        throw eacces();
      },
      access: async () => {}, // W_OK granted
    },
  );
  assert.equal(res, true);
});

test("a missing tenant parent is skipped, not treated as closed", async () => {
  const res = await probeTenantTreeAccessible(
    { mountPoints: ["/mnt/ava/b"], tenantNames: [], parents: ["users"] },
    {
      opendir: async () => {
        throw enoent();
      },
      access: async () => {
        throw enoent();
      },
    },
  );
  assert.equal(res, null);
});

test("no mount points is unknown, not closed", async () => {
  assert.equal(await probeTenantTreeAccessible({ mountPoints: [] }), null);
});

test("discoverTenantNames returns nothing once the filer door is shut", async () => {
  const names = await discoverTenantNames(
    { filerAddress: { host: "h", port: 8888 }, mountPoints: ["/mnt/ava/b"] },
    async () => ({ ok: false, status: 403, json: async () => ({}) }),
  );
  assert.deepEqual(names, []);
});

// ── the live one ──────────────────────────────────────────────────────────

test("no unprivileged process on THIS host can read another tenant's workspace", async (t) => {
  const verdict = await checkHostFilerExposure();

  if (verdict.applicable === false) {
    t.diagnostic("no SeaweedFS workspace tree is mounted here — nothing to measure");
    return;
  }
  if (verdict.code === "host_exposure_wrong_vantage_point") {
    // Running the suite as root cannot answer this question. Skip rather than
    // pass: a green from the wrong uid is worse than no result.
    t.skip(verdict.reason);
    return;
  }

  assert.equal(verdict.ok, true, verdict.reason ?? verdict.note);
});

test("a parent that denies TRAVERSAL is decisive without any tenant name", async () => {
  // The fence puts the tenant parents at 0770 root:root. That shuts the name
  // route as well as the listing route — and it also shuts the probe's own way
  // of discovering names, so before this case the check could only answer
  // "unknown" once it was working. Success that cannot be recognised is a false
  // red, and a false red gets made green the easy way.
  const deps = {
    opendir: async () => { const e = new Error("EACCES"); e.code = "EACCES"; throw e },
    access: async (_p, mode) => {
      // 0o1 = X_OK. Denied → nothing a name could do.
      if (mode === 0o1) { const e = new Error("EACCES"); e.code = "EACCES"; throw e }
      const e = new Error("EACCES"); e.code = "EACCES"; throw e
    },
  };
  const r = await probeTenantTreeAccessible({ mountPoints: ["/mnt/ava/cm-agent-artifacts"], tenantNames: [] }, deps);
  assert.equal(r, false, "traversal denied on every parent is a measured 'shut', not an unknown");
});

test("a parent that still grants --x is NOT decisive without names", async () => {
  // The other half, so the case above cannot be satisfied by an `access` stub
  // that always throws: at 0771 a known name walks through, so with no names to
  // try the honest answer is still `null`.
  const deps = {
    opendir: async () => { const e = new Error("EACCES"); e.code = "EACCES"; throw e },
    access: async () => {}, // traversal allowed
  };
  const r = await probeTenantTreeAccessible({ mountPoints: ["/mnt/ava/cm-agent-artifacts"], tenantNames: [] }, deps);
  assert.equal(r, null, "traversable parent + no names = nothing was asked");
});

// ── the scan roots, under both mount topologies ─────────────────────────────
//
// The probe looks for `users|orgs|groups` directly under each mount point.
// That was right while every bucket had its OWN mount
// (`-filer.path=/buckets/<bucket>` → `/mnt/ava/<bucket>`), and it stopped
// answering the moment one mount served them all
// (`-filer.path=/buckets` → `/mnt/ava`), because the tenant parents are then a
// level deeper: `/mnt/ava/<bucket>/users`.
//
// MEASURED 2026-09-07: after the topology change this check reported
// `filer=closed, tenant tree=unknown` and went red — while the property it
// guards was still HOLDING (`/mnt/ava/cm-agent-artifacts/users` is
// `0770 root:root`, and an unprivileged shell can neither list nor traverse
// it). A security check that cannot reach a conclusion is the one that gets
// made green the easy way, so it has to learn the new shape rather than be
// silenced.

import { tenantParentRoots } from "./host-filer-exposure.mjs";

test("per-bucket mounts: the mount point itself holds the tenant parents", () => {
  const mounts = [{ mountPoint: "/mnt/ava/cm-agent-artifacts", remotePath: "/buckets/cm-agent-artifacts" }];
  assert.deepEqual(tenantParentRoots(mounts, () => []), ["/mnt/ava/cm-agent-artifacts"]);
});

test("a ROOT mount: every bucket under it is a scan root", () => {
  const mounts = [{ mountPoint: "/mnt/ava", remotePath: "/buckets" }];
  const readdir = (p) => (p === "/mnt/ava" ? ["cm-agent-artifacts", "ws-user-abc", "agent-fs"] : []);
  assert.deepEqual(
    tenantParentRoots(mounts, readdir).sort(),
    ["/mnt/ava/agent-fs", "/mnt/ava/cm-agent-artifacts", "/mnt/ava/ws-user-abc"],
  );
});

test("a root mount whose buckets cannot be listed is NOT silently empty", () => {
  // An unprivileged process may be denied the listing. Returning [] would make
  // the probe report "nothing to check", which reads as safe — the exact
  // unknown-vs-closed confusion the verdict function refuses elsewhere. Fall
  // back to the mount point so the scan still asks about SOMETHING, and let
  // the per-parent ENOENT/EACCES logic answer.
  const mounts = [{ mountPoint: "/mnt/ava", remotePath: "/buckets" }];
  const readdir = () => { const e = new Error("EACCES"); e.code = "EACCES"; throw e; };
  assert.deepEqual(tenantParentRoots(mounts, readdir), ["/mnt/ava"]);
});

test("both topologies at once — a per-bucket mount beside a root mount", () => {
  // Not hypothetical: the deployment ran a second per-bucket unit beside the
  // main one for half a day.
  const mounts = [
    { mountPoint: "/mnt/ava", remotePath: "/buckets" },
    { mountPoint: "/mnt/other/agent-fs", remotePath: "/buckets/agent-fs" },
  ];
  const readdir = (p) => (p === "/mnt/ava" ? ["b1"] : []);
  assert.deepEqual(tenantParentRoots(mounts, readdir).sort(), ["/mnt/ava/b1", "/mnt/other/agent-fs"]);
});

// ── per-tenant buckets: the bucket ROOT is the tenant's root (2026-09-26, F-GRP) ──
//
// 09-07/09-09 moved tenants onto their own buckets, `/mnt/ava/ws-<kind>-<id>`.
// There is no `users/` parent there to fence: the bucket root IS the tenant's
// root. And every one of them was open — measured with `ls -ld` on the live
// host 2026-09-26: 22 `ws-*` roots, all `drwxrwxrwx`, two of them owned by uid
// 1000 (`s3.bucket.create` hardcodes 0777; weed shell has no chmod). The
// sandbox creates its files as uid 1000, which on this host is the login
// account, so a process running as it walked into every isolated tenant's
// workspace and owned what it found there.
//
// This check looked for `users|orgs|groups` under every bucket, got ENOENT
// under each `ws-*` one, skipped it, and stayed GREEN on the strength of the
// fenced `cm-agent-artifacts/users`. These tests feed the real modes through the
// same `checkHostFilerExposure` the live test calls, on a fake tree.

import { tenantBucketRoots } from "./host-filer-exposure.mjs";
import nodePath from "node:path";

const dirE = (uid, gid, mode, children = []) => ({ uid, gid, mode, children });

/** The host tree as seen by `who` — search on every ancestor, then owner/group/other on the target. */
function fakeHost(entries, { uid = 1000, groups = [1000, 4, 27, 988] } = {}) {
  const X = 1, W = 2, R = 4;
  const gs = new Set(groups);
  const allows = (e, bit) => {
    if (uid === 0) return true;
    const shift = e.uid === uid ? 6 : gs.has(e.gid) ? 3 : 0;
    return (((e.mode & 0o777) >> shift) & bit) === bit;
  };
  const fail = (code, p) => Object.assign(new Error(`${code}: ${p}`), { code });
  const find = (p) => {
    let cur = "/";
    for (const part of nodePath.resolve(p).split("/").filter(Boolean)) {
      if (entries[cur] && !allows(entries[cur], X)) throw fail("EACCES", p);
      cur = nodePath.posix.join(cur, part);
    }
    if (!entries[cur]) throw fail("ENOENT", p);
    return entries[cur];
  };
  return {
    readProcMounts: async () =>
      "172.20.0.4:8888:/buckets /mnt/ava fuse.seaweedfs rw,nosuid,nodev,relatime,user_id=0,group_id=0,default_permissions,allow_other 0 0\n",
    readdir: (p) => {
      const e = find(p);
      if (!allows(e, R)) throw fail("EACCES", p);
      return [...e.children];
    },
    opendir: async (p) => {
      if (!allows(find(p), R)) throw fail("EACCES", p);
      return { close: async () => {} };
    },
    access: async (p, mode) => {
      const e = find(p);
      for (const bit of [X, W, R]) if (mode & bit && !allows(e, bit)) throw fail("EACCES", p);
    },
    // The filer's ports are fenced for uid != 0 (ava-filer-fence.service).
    fetch: async () => {
      const e = new Error("connect ECONNREFUSED");
      e.cause = { code: "ECONNREFUSED" };
      throw e;
    },
  };
}

const LEGACY_FENCED = {
  "/mnt/ava/agent-fs": dirE(0, 0, 0o755),
  "/mnt/ava/cm-agent-artifacts": dirE(0, 0, 0o777, ["users", "orgs", "groups"]),
  "/mnt/ava/cm-agent-artifacts/users": dirE(0, 0, 0o770, ["u-legacy"]),
  "/mnt/ava/cm-agent-artifacts/orgs": dirE(0, 0, 0o770),
  "/mnt/ava/cm-agent-artifacts/groups": dirE(0, 0, 0o770),
};
const BUCKETS = ["agent-fs", "cm-agent-artifacts", "ws-user-aaaa", "ws-org-bbbb"];

/** Production as measured on 2026-09-26, before any runbook. */
const TODAY = {
  "/mnt/ava": dirE(0, 0, 0o755, BUCKETS),
  ...LEGACY_FENCED,
  "/mnt/ava/ws-user-aaaa": dirE(0, 0, 0o777, ["workspace", ".snapshots"]),
  "/mnt/ava/ws-user-aaaa/workspace": dirE(0, 0, 0o777),
  "/mnt/ava/ws-user-aaaa/.snapshots": dirE(0, 0, 0o777),
  "/mnt/ava/ws-org-bbbb": dirE(1000, 1000, 0o777, ["workspace"]),
  "/mnt/ava/ws-org-bbbb/workspace": dirE(1000, 1000, 0o770),
};

/** After docs/ops/ava-workspace-group-access.md: roots 0:0 0770, filer gid 0 shown as 2468. */
const AFTER_RUNBOOK = {
  ...TODAY,
  "/mnt/ava/cm-agent-artifacts/users": dirE(0, 2468, 0o770, ["u-legacy"]),
  "/mnt/ava/cm-agent-artifacts/orgs": dirE(0, 2468, 0o770),
  "/mnt/ava/cm-agent-artifacts/groups": dirE(0, 2468, 0o770),
  "/mnt/ava/ws-user-aaaa": dirE(0, 2468, 0o770, ["workspace", ".snapshots"]),
  "/mnt/ava/ws-org-bbbb": dirE(0, 2468, 0o770, ["workspace"]),
};

const check = (entries, who) =>
  checkHostFilerExposure({ mountRoot: "/mnt/ava", uid: who?.uid ?? 1000, env: {}, deps: fakeHost(entries, who) });

test("TODAY's open per-tenant roots are an exposure — the check must go red, not skip them", async () => {
  const v = await check(TODAY);
  assert.equal(v.ok, false, v.note);
  assert.equal(v.code, "host_exposure_refused");
  assert.match(v.reason, /workspace tree/);
});

test("after the runbook (0:0 0770 roots, the group nobody on the host is in) the check is green", async () => {
  const v = await check(AFTER_RUNBOOK);
  assert.equal(v.ok, true, v.reason);
  assert.ok(!v.accepted);
});

test("chmod 0770 WITHOUT chown leaves a root owned by uid 1000 open to its owner", async () => {
  const v = await check({ ...AFTER_RUNBOOK, "/mnt/ava/ws-org-bbbb": dirE(1000, 1000, 0o770, ["workspace"]) });
  assert.equal(v.ok, false, "owner bits beat the fence — the same shape as the reverted uid map");
});

test("a host account IN the workspace group gets back in — membership is the whole fence", async () => {
  const v = await check(AFTER_RUNBOOK, { uid: 1000, groups: [1000, 988, 2468] });
  assert.equal(v.ok, false);
});

test("a bucket straight from s3.bucket.create (0777) is open even before a sandbox writes to it", async () => {
  // Its children came from S3 (0771, root) and cannot be listed — but the root
  // is WRITABLE, so any host account can rename `workspace` away and plant its
  // own for the tenant's next sandbox to write into.
  const v = await check({
    ...AFTER_RUNBOOK,
    "/mnt/ava/ws-user-aaaa": dirE(0, 0, 0o777, ["workspace"]),
    "/mnt/ava/ws-user-aaaa/workspace": dirE(0, 0, 0o771),
    "/mnt/ava/ws-user-aaaa/.snapshots": dirE(0, 0, 0o771),
  });
  assert.equal(v.ok, false);
});

test("a root that can be walked through but not written, with shut children, is not an exposure", async () => {
  // Pins the precise rule rather than "any traversal is red": what matters is
  // reaching content or being able to swap it.
  const v = await check({
    ...AFTER_RUNBOOK,
    "/mnt/ava/ws-user-aaaa": dirE(0, 0, 0o751, ["workspace", ".snapshots"]),
    "/mnt/ava/ws-user-aaaa/workspace": dirE(0, 2468, 0o770),
    "/mnt/ava/ws-user-aaaa/.snapshots": dirE(0, 2468, 0o770),
  });
  assert.equal(v.ok, true, v.reason);
});

test("a mount root that cannot be LISTED but can be walked is unknown, not closed", async () => {
  // The bucket names are tenant ids — not secrets — so a walkable root with
  // names we could not enumerate is a question we did not answer.
  const v = await check({ ...AFTER_RUNBOOK, "/mnt/ava": dirE(0, 0, 0o711, BUCKETS) });
  assert.equal(v.ok, false);
  assert.equal(v.code, "host_exposure_unknown");
});

test("a mount root that cannot even be walked shuts everything under it", async () => {
  const v = await check({ ...TODAY, "/mnt/ava": dirE(0, 0, 0o700, BUCKETS) });
  assert.equal(v.ok, true, v.reason);
});

test("tenantBucketRoots: only buckets tenantBucketName could have made, under either topology", () => {
  const root = [{ mountPoint: "/mnt/ava", remotePath: "/buckets" }];
  const listed = tenantBucketRoots(root, () => ["agent-fs", "cm-agent-artifacts", "ws-user-a1", "ws-org-o1", "ws-group-g1", "ws-shared"]);
  assert.deepEqual(listed.roots.sort(), ["/mnt/ava/ws-group-g1", "/mnt/ava/ws-org-o1", "/mnt/ava/ws-user-a1"]);
  assert.deepEqual(listed.unlisted, []);

  const denied = tenantBucketRoots(root, () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); });
  assert.deepEqual(denied, { roots: [], unlisted: ["/mnt/ava"] }, "a failed listing is reported, never an empty answer");

  const perBucket = tenantBucketRoots([
    { mountPoint: "/mnt/x/ws-user-a1", remotePath: "/buckets/ws-user-a1" },
    { mountPoint: "/mnt/ava/cm-agent-artifacts", remotePath: "/buckets/cm-agent-artifacts" },
  ], () => []);
  assert.deepEqual(perBucket, { roots: ["/mnt/x/ws-user-a1"], unlisted: [] });
});
