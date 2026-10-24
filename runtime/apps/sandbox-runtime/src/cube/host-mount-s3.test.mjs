/**
 * cube/host-mount-s3.test.mjs — the `s3` host-mount driver (rclone), unit level.
 *
 * Seams only: no rclone, no FUSE, no S3. What these cannot see (the mount's
 * real behaviour) is in host-mount-s3.integration.test.mjs; every assertion
 * here pins a decision that integration test found necessary.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  HOST_MOUNT_DRIVER_S3,
  buildHostS3MountArgs,
  createHostMountManager,
  hostMountChildEnv,
  hostMountCommand,
  rcSocketFor,
  resolveHostMountConfig,
  resolveHostMountDriver,
} from "./host-mount.mjs";
import { createDockerClient, withGitSafeDirectory } from "./docker.mjs";
import { s3ForcePathStyle } from "../../../../packages/storage-engine/src/index.mjs";
import { SandboxError } from "../shared/error.mjs";

const S3_ENV = {
  SANDBOX_WORKSPACE_MOUNT: "host",
  SANDBOX_HOST_MOUNT_DRIVER: "s3",
  SANDBOX_HOST_MOUNT_ROOT: "/mnt/cac",
  SANDBOX_HOST_MOUNT_IDLE_SEC: "0",
  S3_ENDPOINT: "http://minio:9000",
  S3_BUCKET: "cac",
  S3_ACCESS_KEY: "AKIA-TEST",
  S3_SECRET_KEY: "the-secret",
  S3_REGION: "us-east-1",
};
const cfg = resolveHostMountConfig(S3_ENV);
const target = { bucket: "cac", subpath: "users/u1/workspace", mountPath: "/mnt/cac/cac/users/u1/workspace" };

test("driver: unset is weed (production unchanged), s3 is opt-in, a typo is an error", () => {
  assert.equal(resolveHostMountDriver({}), "weed");
  assert.equal(resolveHostMountDriver({ SANDBOX_HOST_MOUNT_DRIVER: "S3" }), "s3");
  assert.throws(() => resolveHostMountDriver({ SANDBOX_HOST_MOUNT_DRIVER: "minio" }), (e) => e instanceof SandboxError && e.code === "config_error");
});

test("the config never holds the S3 keys (inspect() returns it)", () => {
  const text = JSON.stringify(cfg);
  assert.doesNotMatch(text, /the-secret|AKIA-TEST/);
});

test("argv: the remote is <bucket>/<subpath>, the same key storage-engine writes", () => {
  const { binary, argv } = hostMountCommand(cfg, target);
  assert.equal(binary, "rclone");
  assert.equal(argv[0], "mount");
  assert.equal(argv[1], ":s3:cac/users/u1/workspace");
  assert.equal(argv[2], target.mountPath);
});

test("argv: no endpoint and no key on the command line (it is world-readable in /proc)", () => {
  const text = buildHostS3MountArgs(cfg, target).join(" ");
  assert.doesNotMatch(text, /the-secret|AKIA-TEST|minio:9000/);
});

test("argv: owned by the sandbox's uid, group-shared 0660/0770, umask 007, kernel-enforced", () => {
  const argv = buildHostS3MountArgs(cfg, target);
  const val = (flag) => argv[argv.indexOf(flag) + 1];
  assert.ok(argv.includes("--allow-other"), "dockerd (root) must traverse the mount");
  assert.ok(argv.includes("--default-permissions"), "allow_other without it opens every tenant to every host account");
  assert.equal(val("--uid"), "2468", "the sandbox's uid: only the owner may chmod, and git chmods (bundle smoke 2026-10-24)");
  assert.equal(val("--gid"), String(cfg.workspaceGid));
  assert.equal(val("--file-perms"), "0660");
  assert.equal(val("--dir-perms"), "0770");
  assert.equal(val("--umask"), "007", "measured: the default umask made files 0640");
  assert.equal(val("--vfs-cache-mode"), "writes", "editors, sed -i and git need read+write opens");
});

test("argv: a control socket per mount, at a short derived path", () => {
  const argv = buildHostS3MountArgs(cfg, target);
  const addr = argv[argv.indexOf("--rc-addr") + 1];
  assert.equal(addr, `unix://${rcSocketFor(cfg, target.mountPath)}`);
  assert.ok(rcSocketFor(cfg, target.mountPath).length <= 107, "sun_path limit");
  assert.notEqual(rcSocketFor(cfg, "/mnt/cac/a"), rcSocketFor(cfg, "/mnt/cac/b"));
});

test("the mount uid: 2468 by default, overridable, never 0 and never garbage", () => {
  assert.equal(cfg.s3.uid, 2468);
  assert.equal(resolveHostMountConfig({ ...S3_ENV, SANDBOX_HOST_MOUNT_S3_UID: "3000" }).s3.uid, 3000);
  for (const bad of ["0", "-1", "abc", "1.5"]) {
    assert.throws(
      () => resolveHostMountConfig({ ...S3_ENV, SANDBOX_HOST_MOUNT_S3_UID: bad }),
      (e) => e instanceof SandboxError && e.code === "config_error",
      bad,
    );
  }
});

test("a socket directory too long for sun_path is refused at config time", () => {
  assert.throws(
    () => resolveHostMountConfig({ ...S3_ENV, SANDBOX_HOST_MOUNT_RCLONE_RC_DIR: `/${"x".repeat(100)}` }),
    (e) => e instanceof SandboxError && e.code === "config_error",
  );
});

test("child env: carries the store and keys, and nothing else from this process", () => {
  const env = hostMountChildEnv(cfg, { ...S3_ENV, PATH: "/bin", SANDBOX_INTERNAL_TOKEN: "do-not-pass" });
  assert.equal(env.RCLONE_S3_ENDPOINT, "http://minio:9000");
  assert.equal(env.RCLONE_S3_ACCESS_KEY_ID, "AKIA-TEST");
  assert.equal(env.RCLONE_S3_SECRET_ACCESS_KEY, "the-secret");
  assert.equal(env.RCLONE_S3_REGION, "us-east-1");
  assert.equal(env.RCLONE_S3_NO_CHECK_BUCKET, "true", "a mount never creates a bucket");
  assert.equal(env.SANDBOX_INTERNAL_TOKEN, undefined);
});

test("path style: one parser, shared by the file panel and the mount", () => {
  assert.equal(s3ForcePathStyle({}), true);
  assert.equal(s3ForcePathStyle({ S3_FORCE_PATH_STYLE: "0" }), false);
  assert.equal(resolveHostMountConfig({ ...S3_ENV, S3_FORCE_PATH_STYLE: "off" }).s3.forcePathStyle, false);
  assert.equal(hostMountChildEnv(resolveHostMountConfig({ ...S3_ENV, S3_FORCE_PATH_STYLE: "off" }), S3_ENV).RCLONE_S3_FORCE_PATH_STYLE, "false");
});

// ---- invalidation ----------------------------------------------------------

function harness() {
  const mounted = new Set();
  const rc = [];
  return {
    rc,
    spawn({ mountPath }) { mounted.add(mountPath); return { pid: 1, killed: false, kill() { this.killed = true; return true; }, on() { return this; } }; },
    async probeMounts() { return new Set(mounted); },
    async isMountLive() { return true; },
    async externalUnmount(p) { mounted.delete(p); return true; },
    async mkdirp() {},
    async rmdir() {},
    async readLeafDirs() { return []; },
    async prepareRcDir() {},
    async removeFile() {},
    async rcCall(socket, command, params) { rc.push({ socket, command, params }); return "{}"; },
  };
}

test("invalidateObject: forgets the written file's directory on the mount that covers it", async () => {
  const h = harness();
  const m = createHostMountManager({ config: cfg, ...h, readyIntervalMs: 1 });
  const hold = await m.acquire({ bucket: "cac", subpath: "users/u1/workspace" });
  await m.acquire({ bucket: "cac", subpath: "users/u2/workspace" });
  const done = await m.invalidateObject({ bucket: "cac", key: "users/u1/workspace/docs/a.md" });
  assert.deepEqual(done, [hold.mountPath]);
  assert.deepEqual(h.rc, [{ socket: rcSocketFor(cfg, hold.mountPath), command: "vfs/forget", params: { dir: "docs" } }]);
  await m.shutdown();
});

test("invalidateObject: a file at the workspace root forgets the root", async () => {
  const h = harness();
  const m = createHostMountManager({ config: cfg, ...h, readyIntervalMs: 1 });
  await m.acquire({ bucket: "cac", subpath: "users/u1/workspace" });
  await m.invalidateObject({ bucket: null, key: "users/u1/workspace/top.txt" });
  assert.deepEqual(h.rc.map((c) => c.params), [{}], "bucket null means the configured default bucket");
  await m.shutdown();
});

test("the default bucket is S3_BUCKET only — never WEED_S3_BUCKET (the two-bucket incident)", () => {
  assert.equal(resolveHostMountConfig({ ...S3_ENV, WEED_S3_BUCKET: "other" }).s3.defaultBucket, "cac");
});

test("invalidateObject: a sibling prefix is not a match (users/u1 vs users/u10)", async () => {
  const h = harness();
  const m = createHostMountManager({ config: cfg, ...h, readyIntervalMs: 1 });
  await m.acquire({ bucket: "cac", subpath: "users/u1/workspace" });
  await m.invalidateObject({ bucket: "cac", key: "users/u10/workspace/a.md" });
  await m.invalidateObject({ bucket: "other", key: "users/u1/workspace/a.md" });
  assert.deepEqual(h.rc, []);
  await m.shutdown();
});

test("invalidateObject: an rc failure is logged, never thrown — the object is already stored", async () => {
  const h = harness();
  h.rcCall = async () => { throw new Error("no answer"); };
  const m = createHostMountManager({ config: cfg, ...h, readyIntervalMs: 1 });
  await m.acquire({ bucket: "cac", subpath: "users/u1/workspace" });
  assert.deepEqual(await m.invalidateObject({ bucket: "cac", key: "users/u1/workspace/a.md" }), []);
  await m.shutdown();
});

test("invalidateObject: the weed driver does nothing (the filer streams its own metadata)", async () => {
  const h = harness();
  const m = createHostMountManager({ config: resolveHostMountConfig({ ...S3_ENV, SANDBOX_HOST_MOUNT_DRIVER: "weed" }), ...h, readyIntervalMs: 1 });
  await m.acquire({ bucket: "cac", subpath: "users/u1/workspace" });
  await m.invalidateObject({ bucket: "cac", key: "users/u1/workspace/a.md" });
  assert.deepEqual(h.rc, []);
  await m.shutdown();
});

test("reconcile never adopts the mount root, even when the root is itself a mount (the bundle's rshared bind)", async () => {
  const h = harness();
  const root = cfg.mountRoot;
  const unmounted = [];
  const removed = [];
  const m = createHostMountManager({
    config: cfg, ...h, readyIntervalMs: 1,
    probeMounts: async () => new Set([root]),
    readLeafDirs: async () => [root],
    externalUnmount: async (p) => { unmounted.push(p); return true; },
    rmdir: async (p) => { removed.push(p); },
  });
  const r = await m.reconcile();
  assert.deepEqual(r.adopted, []);
  assert.deepEqual(unmounted, [], "the root bind is never unmounted");
  assert.deepEqual(removed, []);
  await m.invalidateObject({ bucket: "cac", key: "users/u1/workspace/a.md" });
  assert.deepEqual(h.rc, [], "and it never matches an invalidation");
  await m.shutdown();
  assert.deepEqual(unmounted, []);
});

// ---- the guest -------------------------------------------------------------

test("withGitSafeDirectory: appends after the caller's own git config entries", () => {
  assert.deepEqual(withGitSafeDirectory({ A: "1" }), { A: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" });
  const env = withGitSafeDirectory({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.editor", GIT_CONFIG_VALUE_0: "vi" });
  assert.equal(env.GIT_CONFIG_KEY_0, "core.editor", "the caller's entry is kept");
  assert.equal(env.GIT_CONFIG_KEY_1, "safe.directory");
  assert.equal(env.GIT_CONFIG_COUNT, "2");
});

async function runArgsFor(hostMount) {
  const calls = [];
  const runner = async (args) => { calls.push(args); return args[0] === "run" ? "cid123\n" : ""; };
  const client = createDockerClient({ dockerRunner: runner, workspaceMountMode: "host", hostMount });
  await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/users/u1/workspace" });
  return calls.find((a) => a[0] === "run");
}
async function runEnvFor(hostMount) {
  const run = await runArgsFor(hostMount);
  return run.filter((_, i) => run[i - 1] === "-e");
}
const fakeMount = (driver) => ({
  driver,
  sandboxUid: driver === HOST_MOUNT_DRIVER_S3 ? 2468 : null,
  async acquire({ bucket, subpath }) { return { mountPath: `/mnt/${bucket}/${subpath}`, release() {} }; },
});

test("an s3-driver sandbox runs as the mount's owner, primary group the workspace group; a weed one keeps the image's USER", async () => {
  const s3 = await runArgsFor(fakeMount(HOST_MOUNT_DRIVER_S3));
  assert.equal(s3[s3.indexOf("--user") + 1], "2468:2468");
  assert.ok(!(await runArgsFor(fakeMount("weed"))).includes("--user"));
});

test("the manager tells docker.mjs which uid to run as only for s3", async () => {
  const h = harness();
  assert.equal(createHostMountManager({ config: cfg, ...h }).sandboxUid, 2468);
  assert.equal(createHostMountManager({ config: resolveHostMountConfig({ ...S3_ENV, SANDBOX_HOST_MOUNT_DRIVER: "weed" }), ...h }).sandboxUid, null);
});

test("an s3-driver sandbox trusts its repositories; a weed-driver one is unchanged", async () => {
  assert.ok((await runEnvFor(fakeMount(HOST_MOUNT_DRIVER_S3))).includes("GIT_CONFIG_KEY_0=safe.directory"));
  assert.ok(!(await runEnvFor(fakeMount("weed"))).some((e) => e.startsWith("GIT_CONFIG_")));
});
