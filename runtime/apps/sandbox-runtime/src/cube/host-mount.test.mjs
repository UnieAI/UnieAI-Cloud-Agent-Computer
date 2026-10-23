/**
 * cube/host-mount.test.mjs — host-side workspace mount manager.
 *
 * Every test here injects seams (spawn / probeMounts / isMountLive /
 * externalUnmount / fs) so the suite runs with no weed binary, no filer and
 * no root. The end-to-end proof that the mechanism actually works lives in
 * docs/ops/host-workspace-mount.md (measured on the live host).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHostWeedMountArgs,
  createHostMountManager,
  hostMountPathFor,
  resolveHostMountConfig,
  resolveWorkspaceMountMode,
} from "./host-mount.mjs";
import { SandboxError } from "../shared/error.mjs";

// ---- mode resolution: the default is TODAY'S behaviour ----

test("resolveWorkspaceMountMode: defaults to in-guest when the env is unset", () => {
  assert.equal(resolveWorkspaceMountMode({}), "in-guest");
});

test("resolveWorkspaceMountMode: SANDBOX_WORKSPACE_MOUNT=host opts in", () => {
  assert.equal(resolveWorkspaceMountMode({ SANDBOX_WORKSPACE_MOUNT: "host" }), "host");
});

test("resolveWorkspaceMountMode: an unrecognised value falls back to in-guest, not host", () => {
  // Fail SAFE toward the path that is known to work. A typo in a deploy env
  // must not silently switch a live data path onto the new mechanism.
  assert.equal(resolveWorkspaceMountMode({ SANDBOX_WORKSPACE_MOUNT: "hsot" }), "in-guest");
  assert.equal(resolveWorkspaceMountMode({ SANDBOX_WORKSPACE_MOUNT: "" }), "in-guest");
});

// ---- path composition ----

test("hostMountPathFor: composes <mountRoot>/<bucket>/<subpath>", () => {
  assert.equal(
    hostMountPathFor("/mnt", "agent-fs", "users/u1/workspace"),
    "/mnt/agent-fs/users/u1/workspace",
  );
});

test("hostMountPathFor: rejects a `..` climb in subpath", () => {
  assert.throws(
    () => hostMountPathFor("/mnt", "agent-fs", "users/../../etc"),
    (err) => err instanceof SandboxError && err.code === "bad_request",
  );
});

test("hostMountPathFor: rejects a `..` or `/` in bucket", () => {
  assert.throws(() => hostMountPathFor("/mnt", "..", "a/b"), (err) => err instanceof SandboxError);
  assert.throws(() => hostMountPathFor("/mnt", "a/b", "c"), (err) => err instanceof SandboxError);
});

test("hostMountPathFor: rejects an absolute or empty subpath", () => {
  assert.throws(() => hostMountPathFor("/mnt", "agent-fs", "/etc"), (err) => err instanceof SandboxError);
  assert.throws(() => hostMountPathFor("/mnt", "agent-fs", ""), (err) => err instanceof SandboxError);
});

// ---- weed argv ----

test("buildHostWeedMountArgs: mounts the bucket subtree the sandbox would have mounted", () => {
  const cfg = resolveHostMountConfig({ SANDBOX_HOST_MOUNT_FILER: "10.0.0.1:8888" });
  const argv = buildHostWeedMountArgs(cfg, {
    bucket: "agent-fs",
    subpath: "users/u1/workspace",
    mountPath: "/mnt/agent-fs/users/u1/workspace",
  });
  assert.equal(argv[0], "mount");
  assert.ok(argv.includes("-filer=10.0.0.1:8888"), argv.join(" "));
  assert.ok(argv.includes("-filer.path=/buckets/agent-fs/users/u1/workspace"), argv.join(" "));
  assert.ok(argv.includes("-dir=/mnt/agent-fs/users/u1/workspace"), argv.join(" "));
  assert.ok(argv.includes("-dirAutoCreate"), argv.join(" "));
});

test("buildHostWeedMountArgs: allowOthers is ON — dockerd (root) must traverse the mount", () => {
  // MEASURED on this host: with `-allowOthers=false` the mount works for the
  // owning uid but `docker run -v <mount>:/workspace` fails with
  // "error while creating mount source path ... file exists" (dockerd is root
  // and the kernel denies it the FUSE mount). This flag is load-bearing for
  // the whole bind-mount design, so it is asserted, not merely defaulted.
  const cfg = resolveHostMountConfig({});
  const argv = buildHostWeedMountArgs(cfg, {
    bucket: "b", subpath: "s", mountPath: "/mnt/b/s",
  });
  assert.ok(argv.includes("-allowOthers=true"), argv.join(" "));
});

/**
 * 2026-09-26: this test used to assert `-map.uid=1000:0 -map.gid=1000:0` —
 * "like the in-guest mount does". Inside a guest uid 1000 is the sandbox user;
 * on the HOST it is the login account, and a host mount that maps it becomes
 * that account's to read (the incident a142cae6 reverted for the premounted
 * script). Host mode mounts on the host too, so it gets the same rule: only the
 * group, only the dedicated gid — see cube/workspace-group.mjs.
 */
test("buildHostWeedMountArgs: maps only the workspace group, never a uid", () => {
  const cfg = resolveHostMountConfig({});
  const argv = buildHostWeedMountArgs(cfg, { bucket: "b", subpath: "s", mountPath: "/mnt/b/s" });
  assert.equal(argv.some((a) => a.startsWith("-map.uid")), false, argv.join(" "));
  assert.deepEqual(argv.filter((a) => a.startsWith("-map.gid")), ["-map.gid=2468:0"], argv.join(" "));
});

test("buildHostWeedMountArgs: a configured workspace gid is the one mapped; disabled maps nothing", () => {
  const custom = buildHostWeedMountArgs(resolveHostMountConfig({ SANDBOX_WORKSPACE_GID: "3001" }), {
    bucket: "b", subpath: "s", mountPath: "/mnt/b/s",
  });
  assert.deepEqual(custom.filter((a) => a.startsWith("-map.")), ["-map.gid=3001:0"]);
  const off = buildHostWeedMountArgs(resolveHostMountConfig({ SANDBOX_WORKSPACE_GID: "off" }), {
    bucket: "b", subpath: "s", mountPath: "/mnt/b/s",
  });
  assert.deepEqual(off.filter((a) => a.startsWith("-map.")), []);
});

/**
 * The premounted topology does not call buildHostWeedMountArgs: root mounts the
 * whole tree ONCE, host-wide, from deploy/systemd/ava-workspace-mount.sh. That
 * script must NEVER map a uid.
 *
 * 2026-09-26: `-map.uid=1000:0` was installed so the sandbox user could read
 * S3-written files (UAT B1-D1). On this host uid 1000 is also the login account
 * that runs ava-app and ava-sandbox, so the map made it the OWNER of every
 * tenant's workspace — owner bits beat the 0770 tenant-parent fence, and the
 * live isolation check (host-filer-exposure.test.mjs) blocked the deploy. The
 * sandbox's access belongs in a dedicated group, not a uid map — the script now
 * maps only the group, and workspace-group.test.mjs executes it to prove that.
 * (The per-sandbox `host` mode follows the same rule; see the tests above.)
 */
test("premounted host-wide script never maps a uid onto a host account", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(new URL("../../../../../deploy/systemd/ava-workspace-mount.sh", import.meta.url), "utf8");
  const code = script.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /-map\.uid/, "deploy/systemd/ava-workspace-mount.sh maps a uid — see the comment in that script");
});

test("buildHostWeedMountArgs: readOnly adds -readOnly", () => {
  const cfg = resolveHostMountConfig({});
  const argv = buildHostWeedMountArgs(cfg, {
    bucket: "b", subpath: "s", mountPath: "/mnt/b/s", readOnly: true,
  });
  assert.ok(argv.includes("-readOnly"), argv.join(" "));
});

// ---- manager: refcounting ----

/** Minimal spawn seam: a fake child whose mount "appears" in the probe set. */
function makeHarness({ readyAfter = 0, liveByDefault = true } = {}) {
  const mounted = new Set();
  const spawned = [];
  const unmounted = [];
  const dead = new Set();
  let calls = 0;
  const harness = {
    mounted, spawned, unmounted, dead,
    spawn({ binary, argv, mountPath }) {
      spawned.push({ binary, argv, mountPath });
      const listeners = [];
      const child = {
        pid: 1000 + spawned.length,
        killed: false,
        kill() { this.killed = true; mounted.delete(mountPath); for (const l of listeners) l(0); return true; },
        on(_ev, l) { listeners.push(l); return child; },
      };
      calls += 1;
      // A fresh weed process replaces whatever corpse was there: the mount is
      // both listed AND serving again.
      if (calls > readyAfter) { mounted.add(mountPath); dead.delete(mountPath); }
      return child;
    },
    async probeMounts() { return new Set(mounted); },
    async isMountLive(p) { return liveByDefault && !dead.has(p); },
    async externalUnmount(p) { unmounted.push(p); mounted.delete(p); dead.delete(p); return true; },
    async mkdirp() {},
    async rmdir() {},
    async readLeafDirs() { return []; },
  };
  return harness;
}

function managerWith(harness, envOverrides = {}) {
  const config = resolveHostMountConfig({
    SANDBOX_HOST_MOUNT_ROOT: "/mnt",
    SANDBOX_HOST_MOUNT_FILER: "10.0.0.1:8888",
    SANDBOX_HOST_MOUNT_IDLE_SEC: "0",
    ...envOverrides,
  });
  return createHostMountManager({ config, ...harness, readyIntervalMs: 1 });
}

test("manager.acquire: two holders of the same workspace share ONE weed mount", async () => {
  const h = makeHarness();
  const m = managerWith(h);
  const a = await m.acquire({ bucket: "agent-fs", subpath: "users/u1/workspace" });
  const b = await m.acquire({ bucket: "agent-fs", subpath: "users/u1/workspace" });
  assert.equal(h.spawned.length, 1);
  assert.equal(a.mountPath, "/mnt/agent-fs/users/u1/workspace");
  assert.equal(b.mountPath, a.mountPath);
  await m.shutdown();
});

test("manager.acquire: distinct workspaces get distinct mounts", async () => {
  const h = makeHarness();
  const m = managerWith(h);
  await m.acquire({ bucket: "agent-fs", subpath: "users/u1/workspace" });
  await m.acquire({ bucket: "agent-fs", subpath: "users/u2/workspace" });
  assert.equal(h.spawned.length, 2);
  await m.shutdown();
});

test("manager: the mount survives the first release and drops on the last", async () => {
  const h = makeHarness();
  const m = managerWith(h);
  const a = await m.acquire({ bucket: "b", subpath: "s" });
  const b = await m.acquire({ bucket: "b", subpath: "s" });
  a.release();
  assert.equal(m.inspect().entries[0].refcount, 1);
  assert.ok(h.mounted.has("/mnt/b/s"));
  b.release();
  await m.drainForTest();
  assert.equal(m.inspect().entries.length, 0);
});

test("manager: release() twice does not double-decrement", async () => {
  const h = makeHarness();
  const m = managerWith(h);
  const a = await m.acquire({ bucket: "b", subpath: "s" });
  const b = await m.acquire({ bucket: "b", subpath: "s" });
  a.release();
  a.release();
  a.release();
  assert.equal(m.inspect().entries[0].refcount, 1, "b still holds it");
  b.release();
  await m.drainForTest();
  await m.shutdown();
});

// ---- manager: the stale-mount failure this design is famous for ----

test("manager.reconcile: a mount listed in /proc/mounts but DEAD is unmounted, not adopted", async () => {
  // MEASURED: `kill -9` on the weed process leaves the fuse.seaweedfs line in
  // /proc/mounts, so a probe that only reads the mount table reports it LIVE.
  // Every I/O then returns ENOTCONN ("Transport endpoint is not connected"),
  // and a container bind-mounted onto it sees "Socket not connected".
  // The former @unieai/agent-fs's reconcileExistingMounts adopted exactly this case as a
  // live mount with state 'ready' and hands it to the next caller — verified by
  // reading mount-registry.ts, and reproduced on this host. We must not.
  const h = makeHarness();
  h.mounted.add("/mnt/b/s");
  h.dead.add("/mnt/b/s");
  h.readLeafDirs = async () => ["/mnt/b/s"];
  const m = managerWith(h);
  const result = await m.reconcile();
  assert.deepEqual(h.unmounted, ["/mnt/b/s"]);
  assert.deepEqual(result.adopted, []);
  assert.deepEqual(result.staleUnmounted, ["/mnt/b/s"]);
});

test("manager.reconcile: a LIVE mount is adopted, not torn down", async () => {
  const h = makeHarness();
  h.mounted.add("/mnt/b/s");
  h.readLeafDirs = async () => ["/mnt/b/s"];
  // A non-zero idle window, because adoption hands the mount to the idle
  // policy: with SANDBOX_HOST_MOUNT_IDLE_SEC=0 that policy is "unmount now",
  // which is correct behaviour and would hide what this test is checking.
  const m = managerWith(h, { SANDBOX_HOST_MOUNT_IDLE_SEC: "60" });
  const result = await m.reconcile();
  assert.deepEqual(h.unmounted, []);
  assert.deepEqual(result.adopted, ["/mnt/b/s"]);
});

test("manager.reconcile: a leftover directory that is not mounted at all is removed", async () => {
  const h = makeHarness();
  const removed = [];
  h.readLeafDirs = async () => ["/mnt/b/s"];
  h.rmdir = async (p) => { removed.push(p); };
  const m = managerWith(h);
  const result = await m.reconcile();
  assert.deepEqual(removed, ["/mnt/b/s"]);
  assert.deepEqual(result.removedDirs, ["/mnt/b/s"]);
});

test("manager.acquire: an adopted mount that has since died is re-mounted, not handed out", async () => {
  const h = makeHarness();
  h.mounted.add("/mnt/b/s");
  h.readLeafDirs = async () => ["/mnt/b/s"];
  const m = managerWith(h, { SANDBOX_HOST_MOUNT_IDLE_SEC: "60" });
  await m.reconcile();
  h.dead.add("/mnt/b/s"); // it dies after adoption
  const handle = await m.acquire({ bucket: "b", subpath: "s" });
  assert.deepEqual(h.unmounted, ["/mnt/b/s"], "the dead mount was cleared first");
  assert.equal(h.spawned.length, 1, "and a fresh weed mount was spawned");
  assert.equal(handle.mountPath, "/mnt/b/s");
  await m.shutdown();
});

test("manager.acquire: a mount that never becomes ready kills the child and throws", async () => {
  const h = makeHarness({ readyAfter: 99 }); // never appears in the probe set
  const m = createHostMountManager({
    config: resolveHostMountConfig({
      SANDBOX_HOST_MOUNT_ROOT: "/mnt",
      SANDBOX_HOST_MOUNT_READY_TIMEOUT_MS: "30",
    }),
    ...h,
    readyIntervalMs: 1,
  });
  await assert.rejects(
    () => m.acquire({ bucket: "b", subpath: "s" }),
    (err) => err instanceof SandboxError && err.code === "host_mount_failed",
  );
  assert.equal(m.inspect().entries.length, 0, "the failed entry is not left behind");
});

// ── host-premounted: the runtime needs no privilege ──────────────────────────
//
// The mode exists because `host` mode's "hard prerequisite" was not one. Adding
// `user_allow_other` to /etc/fuse.conf lets ANY unprivileged local user create
// a filesystem root will read, and a FUSE server answers every syscall — it can
// return different bytes on successive reads, or hang one forever, against a
// root process walking the filesystem. Measured 2026-09-06: a root mount with
// -allowOthers needs no such change, so the whole trade was avoidable.

import { createPreMountedHostMountManager, WORKSPACE_MOUNT_HOST_PREMOUNTED } from "./host-mount.mjs";

const PRE_CFG = { mountRoot: "/mnt/ava", filer: "127.0.0.1:8888" };

test("resolveWorkspaceMountMode recognises host-premounted", () => {
  assert.equal(resolveWorkspaceMountMode({ SANDBOX_WORKSPACE_MOUNT: "host-premounted" }), WORKSPACE_MOUNT_HOST_PREMOUNTED);
  assert.equal(resolveWorkspaceMountMode({ SANDBOX_WORKSPACE_MOUNT: "HOST-PREMOUNTED" }), WORKSPACE_MOUNT_HOST_PREMOUNTED);
  // Still fails safe: a typo must not select a mount mechanism.
  assert.equal(resolveWorkspaceMountMode({ SANDBOX_WORKSPACE_MOUNT: "host-premounted " }), WORKSPACE_MOUNT_HOST_PREMOUNTED, "trimmed");
  assert.equal(resolveWorkspaceMountMode({ SANDBOX_WORKSPACE_MOUNT: "host-premont" }), "in-guest");
});

test("a live tree hands back the tenant's subpath and mounts nothing", async () => {
  const m = createPreMountedHostMountManager({
    config: PRE_CFG,
    probeMounts: async () => new Set(["/mnt/ava/cm-agent-artifacts"]),
    isMountLive: async () => true,
  });
  const hold = await m.acquire({ bucket: "cm-agent-artifacts", subpath: "users/u1/workspace" });
  assert.equal(hold.mountPath, "/mnt/ava/cm-agent-artifacts/users/u1/workspace");
  // release must exist even though it does nothing: the caller releases
  // unconditionally, often in a teardown that runs after something else failed,
  // and an absent method throws there.
  assert.equal(typeof hold.release, "function");
  await hold.release();
});

test("an UNMOUNTED tree refuses — binding the bare directory would hand out an empty workspace", async () => {
  const m = createPreMountedHostMountManager({
    config: PRE_CFG,
    probeMounts: async () => new Set(),   // the unit is not running
    isMountLive: async () => true,        // …and the directory exists and lists fine
  });
  await assert.rejects(
    () => m.acquire({ bucket: "cm-agent-artifacts", subpath: "users/u1/workspace" }),
    (err) => {
      assert.equal(err.code, "workspace_tree_not_mounted");
      assert.equal(err.status, 503);
      // The failure mode this guards is silent, not loud: the tenant's files
      // are intact on the store, they just cannot see them, and an agent given
      // an empty workspace starts recreating it.
      assert.match(String(err.message), /EMPTY workspace instead of an error/);
      return true;
    },
  );
});

test("a DEAD tree mount refuses too — a corpse stays in the mount table", async () => {
  const m = createPreMountedHostMountManager({
    config: PRE_CFG,
    probeMounts: async () => new Set(["/mnt/ava/cm-agent-artifacts"]),
    isMountLive: async () => false,       // listed, but ENOTCONN on every read
  });
  await assert.rejects(
    () => m.acquire({ bucket: "cm-agent-artifacts", subpath: "users/u1/workspace" }),
    (err) => {
      // Distinct from "not mounted": they need different fixes, and presence in
      // the mount table is exactly what makes this one look healthy.
      assert.equal(err.code, "workspace_tree_mount_dead");
      return true;
    },
  );
});

test("the path guard still applies — a tenant subpath cannot climb out of the tree", async () => {
  const m = createPreMountedHostMountManager({
    config: PRE_CFG,
    probeMounts: async () => new Set(["/mnt/ava/cm-agent-artifacts"]),
    isMountLive: async () => true,
  });
  // This process can reach EVERY tenant's directory, so the guard is what keeps
  // one tenant's bind out of another's subtree.
  for (const subpath of ["../other", "users/../../etc", "/etc/passwd", "users/u1/../../u2/workspace"]) {
    await assert.rejects(() => m.acquire({ bucket: "cm-agent-artifacts", subpath }), /rejected/, `escaped with ${subpath}`);
  }
});

/**
 * server.mjs's boot summary reads `adopted`, `staleUnmounted`, `removedDirs` and
 * `errors` off whatever manager is configured. The premounted manager answered
 * `{ reconciled, live }`, so on every boot since 2026-09-06 the summary threw
 * `Cannot read properties of undefined (reading 'length')` and logged
 * `sandbox.host_mount_reconcile_failed` (194 times in sandbox-4021.log) — a false
 * warning after a reconcile that had worked, which would hide a real one.
 */
test("the premounted reconcile answers the same shape the boot summary reads", async () => {
  const m = createPreMountedHostMountManager({
    config: PRE_CFG,
    probeMounts: async () => new Set(["/mnt/ava/cm-agent-artifacts"]),
    isMountLive: async () => true,
  });
  const r = await m.reconcile();
  for (const k of ["adopted", "staleUnmounted", "removedDirs", "errors"]) {
    assert.ok(Array.isArray(r[k]), `${k} must be an array, got ${JSON.stringify(r[k])}`);
  }
  assert.equal(r.live, 1);
});

test("reconcile reports at boot instead of throwing — the relay does not need a workspace tree", async () => {
  const missing = createPreMountedHostMountManager({
    config: PRE_CFG,
    probeMounts: async () => new Set(),
    isMountLive: async () => true,
  });
  // Must not throw: refusing to BOOT would also stop serving the relay and
  // machine endpoints, and a user's own computer needs no mount here. The
  // refusal belongs at cloud allocation, which `acquire` already does.
  const r = await missing.reconcile();
  assert.equal(r.live, 0);

  const present = createPreMountedHostMountManager({
    config: PRE_CFG,
    probeMounts: async () => new Set(["/mnt/ava/cm-agent-artifacts"]),
    isMountLive: async () => true,
  });
  assert.equal((await present.reconcile()).live, 1);

  // A corpse counts as absent: listed in the mount table, ENOTCONN on read.
  const dead = createPreMountedHostMountManager({
    config: PRE_CFG,
    probeMounts: async () => new Set(["/mnt/ava/cm-agent-artifacts"]),
    isMountLive: async () => false,
  });
  assert.equal((await dead.reconcile()).live, 0, "a dead mount must not report as a live tree");
});

// ── host-premounted, ROOT topology: allocation without entering a tenant's root ──
//
// 2026-09-26（F-GRP）：每租戶 bucket 是 `/mnt/ava/ws-<kind>-<id>`，整棵樹由 root 的
// 單一掛載提供。bucket 根目錄本身就是租戶的根，所以它要擋住主機帳號：
// `0770 root:<工作區群組>`。sandbox-runtime 以 uid 1000（`ubuntu`）跑在
// `systemctl --user` 的 unit 裡，**加不進那個群組** —— 實測
// `systemd-run --user -p SupplementaryGroups=2468 id` 直接 exit 216/GROUP。
//
// 所以配置沙盒這條路**不能**需要走進租戶的根目錄：
//   · 存活檢查以前 opendir `/mnt/ava/<bucket>` —— 圍籬之後是 EACCES，被當成
//     「掛載死了」，每個獨立租戶都會拿到 503。現在問的是掛載本身（`/mnt/ava`），
//     bucket 存不存在用 stat（只需要 `/mnt/ava` 的 x）。
//   · 看不進去的工作區照舊交給 root 的一次性容器處理（workspace-dir.mjs）。
// 而且 bucket 根目錄一出生是 0777（`s3.bucket.create` 寫死，
// weed/shell/command_s3_bucket_create.go:92），所以第一次配置前先把它圍起來。

const ROOT_CFG = { mountRoot: "/mnt/ava", filer: "127.0.0.1:8888", workspaceGid: 2468 };
const T_ROOT = "/mnt/ava/ws-user-u1";
const eaccesErr = (p) => Object.assign(new Error(`EACCES: ${p}`), { code: "EACCES" });
const enoentErr = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
const dirStat = (uid, gid, mode) => ({ uid, gid, mode: 0o040000 | mode, isDirectory: () => true });
const bindOf = (args) => args[args.indexOf("-v") + 1];

/**
 * A tenant root the way uid 1000 sees it. `fenced` flips when the fence
 * container runs, so a test can watch the order of events.
 */
/**
 * `mountGid`: how the mount shows filer gid 0 (its `-map.gid`), which is what a
 * root reads as after `chown 0:0`. `fenceWorks`: true, false (docker fails), or
 * "noop" (docker exits 0 and nothing changes).
 */
function tenantWorld({ root = dirStat(0, 0, 0o777), fenceWorks = true, rootExists = true, mountGid = 2468 } = {}) {
  const state = { root, fenced: (root.mode & 0o007) === 0 && root.uid === 0 };
  const docker = [];
  const opened = [];
  const deps = {
    config: ROOT_CFG,
    probeMounts: async () => new Set(["/mnt/ava"]),
    // The real probe is an opendir; on a fenced root that is EACCES → "not live".
    isMountLive: async (p) => {
      opened.push(p);
      if (p === "/mnt/ava") return true;
      return p === T_ROOT && rootExists && !state.fenced;
    },
    statPath: async (p) => {
      if (p === T_ROOT) {
        if (!rootExists) throw enoentErr(p);
        return state.root;
      }
      if (p.startsWith(`${T_ROOT}/`)) {
        if (state.fenced) throw eaccesErr(p);
        return dirStat(0, 0, 0o777);
      }
      throw enoentErr(p);
    },
    canTraverse: async (p) => (p === T_ROOT ? !state.fenced : null),
    runDocker: async (args) => {
      docker.push(args);
      if (bindOf(args) === `${T_ROOT}:/b`) {
        if (!fenceWorks) throw new Error("docker: boom");
        if (fenceWorks === "noop") return;
        state.fenced = true;
        state.root = dirStat(0, mountGid, 0o770);
      }
    },
    image: "sandbox:test",
  };
  return { state, docker, opened, deps };
}

test("a FENCED tenant root still allocates — liveness is asked of the mount, not of the tenant's root", async () => {
  const w = tenantWorld({ root: dirStat(0, 2468, 0o770) });
  const m = createPreMountedHostMountManager(w.deps);
  const hold = await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  assert.equal(hold.mountPath, `${T_ROOT}/workspace`);
  assert.deepEqual(w.opened, ["/mnt/ava"], "only the mount itself is opened, never a tenant directory");
  assert.equal(w.docker.some((a) => bindOf(a) === `${T_ROOT}:/b`), false, "an already-fenced root costs no container");
});

test("a tenant bucket that does not exist is refused as MISSING, not as a dead mount", async () => {
  const w = tenantWorld({ rootExists: false });
  const m = createPreMountedHostMountManager(w.deps);
  await assert.rejects(
    () => m.acquire({ bucket: "ws-user-u1", subpath: "workspace" }),
    (err) => {
      assert.equal(err.code, "workspace_tree_missing");
      assert.equal(err.status, 503);
      return true;
    },
  );
  // Binding a path that is not there would make dockerd CREATE it — an empty
  // workspace instead of an error, the failure the tree check exists for.
  assert.equal(w.docker.length, 0, "nothing is created for a bucket that is not there");
});

test("a dead mount is still refused as dead, and nothing inside it is examined", async () => {
  const w = tenantWorld();
  const m = createPreMountedHostMountManager({ ...w.deps, isMountLive: async () => false });
  await assert.rejects(
    () => m.acquire({ bucket: "ws-user-u1", subpath: "workspace" }),
    (err) => err.code === "workspace_tree_mount_dead",
  );
  assert.equal(w.docker.length, 0);
});

test("an OPEN tenant root (0777, as s3.bucket.create makes it) is fenced BEFORE its workspace is prepared", async () => {
  // Order matters: the workspace fixup hands `workspace` to uid 1000, which on
  // this host is also the login account. Under an open root that makes the
  // account the owner of a directory it can reach.
  const w = tenantWorld({ root: dirStat(0, 0, 0o777) });
  const m = createPreMountedHostMountManager(w.deps);
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  const fenceAt = w.docker.findIndex((a) => bindOf(a) === `${T_ROOT}:/b`);
  const fixupAt = w.docker.findIndex((a) => bindOf(a) === `${T_ROOT}/workspace:/w`);
  assert.ok(fenceAt >= 0, `the root was not fenced: ${JSON.stringify(w.docker)}`);
  assert.ok(fixupAt > fenceAt, "the fence must come before the workspace is handed to uid 1000");
  const script = w.docker[fenceAt][w.docker[fenceAt].length - 1];
  assert.match(script, /chown 0:0 \/b/);
  assert.match(script, /chmod 0770 \/b/);
  assert.equal(w.state.fenced, true);
});

test("a tenant root OWNED by a host account is fenced too — chmod alone would leave the owner in", async () => {
  // Production, 2026-09-26: two ws-org-* roots are `ubuntu:ubuntu 0777`. After a
  // bare `chmod 0770` they would be 0770 and STILL rwx for `ubuntu`, the owner.
  for (const root of [dirStat(1000, 1000, 0o777), dirStat(1000, 1000, 0o770)]) {
    const w = tenantWorld({ root });
    const m = createPreMountedHostMountManager(w.deps);
    await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
    const fence = w.docker.find((a) => bindOf(a) === `${T_ROOT}:/b`);
    assert.ok(fence, `mode ${(root.mode & 0o777).toString(8)} owned by uid 1000 was left as it was`);
    assert.match(fence[fence.length - 1], /chown 0:0 \/b/);
  }
});

test("a SHARED bucket's root is never fenced — it holds every legacy tenant", async () => {
  const docker = [];
  const m = createPreMountedHostMountManager({
    config: ROOT_CFG,
    probeMounts: async () => new Set(["/mnt/ava"]),
    isMountLive: async (p) => p === "/mnt/ava",
    statPath: async (p) => (p === "/mnt/ava/cm-agent-artifacts" ? dirStat(0, 0, 0o777) : Promise.reject(eaccesErr(p))),
    canTraverse: async () => true,
    runDocker: async (args) => { docker.push(args); },
    image: "sandbox:test",
  });
  const hold = await m.acquire({ bucket: "cm-agent-artifacts", subpath: "users/u1/workspace" });
  assert.equal(hold.mountPath, "/mnt/ava/cm-agent-artifacts/users/u1/workspace");
  assert.equal(docker.some((a) => bindOf(a) === "/mnt/ava/cm-agent-artifacts:/b"), false);
});

test("a ws-shaped bucket reached through a deeper subpath is not taken for one tenant's bucket", async () => {
  // tenant-store.mjs warns against inferring isolation from a bucket NAME: a
  // shared bucket could be named ws-something. One tenant per bucket is the
  // name AND a single-segment subpath (`workspace`, `.snapshots`).
  const w = tenantWorld({ root: dirStat(0, 0, 0o777) });
  const m = createPreMountedHostMountManager(w.deps);
  await m.acquire({ bucket: "ws-user-u1", subpath: "users/u2/workspace" });
  assert.equal(w.docker.some((a) => bindOf(a) === `${T_ROOT}:/b`), false);
});

test("a fence that fails is logged and the sandbox is still allocated", async () => {
  // Same trade as the workspace fixup: a degraded sandbox beats no sandbox, and
  // the exposure is what the live isolation check (host-filer-exposure) is for.
  const w = tenantWorld({ root: dirStat(0, 0, 0o777), fenceWorks: false });
  const m = createPreMountedHostMountManager(w.deps);
  const hold = await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  assert.equal(hold.mountPath, `${T_ROOT}/workspace`);
});

test("the snapshot sibling of an isolated tenant goes through the same checks", async () => {
  const w = tenantWorld({ root: dirStat(0, 2468, 0o770) });
  const m = createPreMountedHostMountManager(w.deps);
  const hold = await m.acquire({ bucket: "ws-user-u1", subpath: ".snapshots" });
  assert.equal(hold.mountPath, `${T_ROOT}/.snapshots`);
  assert.deepEqual(w.opened, ["/mnt/ava"]);
});

// ── a workspace gid the runtime and the mount disagree on (review of F-GRP) ──
//
// The mount unit reads AVA_WORKSPACE_GID, this process SANDBOX_WORKSPACE_GID;
// both default to 2468. If an operator sets one and not the other, a fenced
// root reads as `root:<the mount's gid> 0770`, the predicate says "not fenced"
// (the group is not the one this process knows), and rerunning `chown 0:0`
// cannot change how the MOUNT shows filer gid 0. Before: a container and an
// ERROR "still reachable" on EVERY allocation — for a root that is shut — which
// teaches people to ignore the one log line meant to catch a real open root.

const fenceCalls = (w) => w.docker.filter((a) => bindOf(a) === `${T_ROOT}:/b`).length;

test("a gid mismatch between runtime and mount is diagnosed once, not re-fenced on every allocation", async () => {
  const w = tenantWorld({ root: dirStat(0, 0, 0o777), mountGid: 3001 }); // config says 2468
  const m = createPreMountedHostMountManager(w.deps);
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  assert.equal(fenceCalls(w), 1, "the open root is fenced");
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  await m.acquire({ bucket: "ws-user-u1", subpath: ".snapshots" });
  assert.equal(fenceCalls(w), 1, "a root that is shut but shows another gid is not fenced again");
});

test("a root still OPEN after a fence that exited 0 is retried every time — a security failure is never memoized", async () => {
  const w = tenantWorld({ root: dirStat(0, 0, 0o777), fenceWorks: "noop" });
  const m = createPreMountedHostMountManager(w.deps);
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  assert.equal(fenceCalls(w), 2);
});

test("a fence that FAILED is retried on the next allocation too", async () => {
  const w = tenantWorld({ root: dirStat(0, 0, 0o777), fenceWorks: false });
  const m = createPreMountedHostMountManager(w.deps);
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  assert.equal(fenceCalls(w), 2);
});

// ── a workspace this process cannot look into (AGENT-577) ────────────────────
//
// Since the tenant-root fence (F-GRP) this process gets EACCES on every isolated
// tenant's `workspace` and `.snapshots`. ensureWorkspaceUsable read that as
// "absent": it logged `workspace_prepared was:"absent"` for a directory full of
// the tenant's files, and ran the root one-shot container AGAIN on every
// allocation — two of them per sandbox. Measured on production 2026-09-30:
// allocations of the test tenant took 13–22 s (10 runs), and PMS run 1's turn
// waited 12 s (08:31:48 → 08:32:00) for its sandbox, most of it these two
// containers re-doing a chown that was already in place.

const fixupCalls = (w, sub = "workspace") => w.docker.filter((a) => bindOf(a) === `${T_ROOT}/${sub}:/w`).length;
const logged = (calls, event) =>
  calls.map((c) => { try { return JSON.parse(c.arguments[0]); } catch { return null; } }).filter((l) => l?.event === event);

test("EACCES on the workspace is logged as UNEXAMINED, never as absent", async (t) => {
  const out = t.mock.method(console, "log", () => {});
  const w = tenantWorld({ root: dirStat(0, 2468, 0o770) }); // fenced: workspace stat is EACCES
  const m = createPreMountedHostMountManager(w.deps);
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  const prepared = logged(out.mock.calls, "host_mount.workspace_prepared");
  assert.equal(prepared.length, 1);
  assert.notEqual(prepared[0].was, "absent", "EACCES is not ENOENT — the directory was not seen to be missing");
  assert.match(prepared[0].was, /unexamined/);
  // Expected under the fence on every allocation — not a warning. A WARN here
  // on every sandbox is what made AGENT-577's investigation chase it.
  const statFailed = logged(out.mock.calls, "host_mount.workspace_stat_failed");
  assert.equal(statFailed.length, 1);
  assert.equal(statFailed[0].level, "info");
});

test("a workspace prepared once is not re-prepared on every allocation", async () => {
  let clock = 1_000_000;
  const w = tenantWorld({ root: dirStat(0, 2468, 0o770) });
  const m = createPreMountedHostMountManager({ ...w.deps, now: () => clock });
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  await m.acquire({ bucket: "ws-user-u1", subpath: ".snapshots" });
  assert.equal(fixupCalls(w), 1);
  assert.equal(fixupCalls(w, ".snapshots"), 1);
  clock += 60_000;
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  await m.acquire({ bucket: "ws-user-u1", subpath: ".snapshots" });
  assert.equal(fixupCalls(w), 1, "a second sandbox a minute later costs no container");
  assert.equal(fixupCalls(w, ".snapshots"), 1);
});

test("the memo is bounded: after the TTL an unexaminable workspace is prepared again", async () => {
  // Bounded on purpose: this process cannot SEE whether the directory was
  // deleted and recreated (dockerd would recreate a bind source root:root 0755,
  // unwritable for the sandbox). The TTL caps how long a stale "prepared" can hold.
  let clock = 1_000_000;
  const w = tenantWorld({ root: dirStat(0, 2468, 0o770) });
  const m = createPreMountedHostMountManager({ ...w.deps, now: () => clock });
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  clock += 16 * 60_000;
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  assert.equal(fixupCalls(w), 2);
});

test("a fixup that FAILED is not memoized", async () => {
  const w = tenantWorld({ root: dirStat(0, 2468, 0o770) });
  const failing = {
    ...w.deps,
    runDocker: async (args) => {
      w.docker.push(args);
      if (bindOf(args) === `${T_ROOT}/workspace:/w`) throw new Error("docker: boom");
    },
  };
  const m = createPreMountedHostMountManager(failing);
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  assert.equal(fixupCalls(w), 2);
});

test("a workspace this process CAN see and that needs fixing is fixed every time, memo or not", async () => {
  // The memo only stands in for a look this process cannot take. When it can
  // look and the directory is wrong (docker left it root:root 0755), it acts.
  let clock = 1_000_000;
  const docker = [];
  const m = createPreMountedHostMountManager({
    config: ROOT_CFG,
    probeMounts: async () => new Set(["/mnt/ava"]),
    isMountLive: async (p) => p === "/mnt/ava",
    statPath: async (p) => (p === T_ROOT ? dirStat(0, 2468, 0o770) : dirStat(0, 0, 0o755)),
    canTraverse: async (p) => (p === T_ROOT ? false : null),
    runDocker: async (args) => { docker.push(args); },
    image: "sandbox:test",
    now: () => clock,
  });
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  clock += 1000;
  await m.acquire({ bucket: "ws-user-u1", subpath: "workspace" });
  assert.equal(docker.filter((a) => bindOf(a) === `${T_ROOT}/workspace:/w`).length, 2);
});
