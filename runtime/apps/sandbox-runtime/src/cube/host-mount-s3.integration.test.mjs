/**
 * cube/host-mount-s3.integration.test.mjs — the S3 mount driver against a real
 * S3 server and a real rclone (CAC P2).
 *
 * The unit tests (host-mount.test.mjs) prove the argv. They cannot prove what
 * was found only by mounting: that a file written through the S3 API stays
 * invisible to the mount for minutes, that every file shows as uid 0, that the
 * control socket path has a length limit. This file runs the production
 * manager (real spawn, real /proc/mounts, real rc socket) and the production
 * write path (userStore → storage-engine → S3).
 *
 * It needs root (allow_other), /dev/fuse, fusermount3, rclone and an S3
 * endpoint, so it runs where those exist and skips everywhere else, saying why:
 *
 *   CAC_S3_IT=1 S3_ENDPOINT=… S3_BUCKET=… S3_ACCESS_KEY=… S3_SECRET_KEY=… \
 *     node --test runtime/apps/sandbox-runtime/src/cube/host-mount-s3.integration.test.mjs
 *
 * scripts/s3-mount-it.sh runs it in a throwaway container against a throwaway
 * MinIO.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

function why() {
  if (process.env.CAC_S3_IT !== "1") return "set CAC_S3_IT=1 to run (needs root, /dev/fuse, fusermount3, rclone, an S3 endpoint)";
  if (process.getuid?.() !== 0) return "needs root: allow_other is refused to an unprivileged mounter";
  if (!existsSync("/dev/fuse")) return "no /dev/fuse";
  for (const bin of ["rclone", "fusermount3", "git", "setpriv"]) {
    try { execFileSync("sh", ["-c", `command -v ${bin}`]); } catch { return `${bin} is not installed`; }
  }
  for (const v of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"]) if (!process.env[v]) return `${v} is unset`;
  return null;
}
// `?? false`, never null: node reports `{ skip: null }` as SKIPPED while running
// the test anyway (measured), so a failing test reads as a skip.
const skip = why() ?? false;

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cac-s3it-"));
process.env.SANDBOX_WORKSPACE_MOUNT = "host";
process.env.SANDBOX_HOST_MOUNT_DRIVER = "s3";
process.env.SANDBOX_HOST_MOUNT_ROOT = root;
process.env.SANDBOX_HOST_MOUNT_IDLE_SEC = "0";
process.env.SANDBOX_HOST_MOUNT_RCLONE_RC_DIR = "/run/cac-rclone-it";
// Long enough that only the invalidation can explain a file showing up at once.
process.env.SANDBOX_HOST_MOUNT_S3_DIR_CACHE_SEC = "300";

const { createHostMountManager, resolveHostMountConfig, rcSocketFor } = await import("./host-mount.mjs");
const { writeFile, readFile, deleteFile, onWorkspaceObjectChange } = await import("../workspace/userStore.mjs");

const config = resolveHostMountConfig();
const manager = createHostMountManager({ config });
const unsubscribe = onWorkspaceObjectChange((c) => manager.invalidateObject(c));
const owner = `s3it${Date.now().toString(36)}`;
const subpath = `users/${owner}/workspace`;
let hold = null;

after(async () => {
  unsubscribe();
  hold?.release();
  await manager.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

const ls = async (dir) => (await fs.readdir(dir)).sort();
const waitFor = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
};

test("a prefix that holds no object yet mounts, as an empty directory", { skip }, async () => {
  hold = await manager.acquire({ bucket: config.s3.defaultBucket, subpath });
  assert.equal(hold.mountPath, path.join(root, config.s3.defaultBucket, subpath));
  assert.deepEqual(await ls(hold.mountPath), []);
  assert.ok(existsSync(rcSocketFor(config, hold.mountPath)), "the control socket is up");
  const rcDir = await fs.stat(config.s3.rcDir);
  assert.equal(rcDir.mode & 0o777, 0o700, "the unauthenticated socket sits in a root-only directory");
});

test("a file written through the API is in the mount when the write returns", { skip }, async () => {
  await fs.mkdir(path.join(hold.mountPath, "docs"));
  await ls(path.join(hold.mountPath, "docs")); // the listing is now cached
  await ls(hold.mountPath);
  await writeFile(owner, "docs/report.md", "from the panel", "text/markdown");
  await writeFile(owner, "top.txt", "at the root", "text/plain");
  assert.deepEqual(await ls(path.join(hold.mountPath, "docs")), ["report.md"]);
  assert.equal(await fs.readFile(path.join(hold.mountPath, "docs/report.md"), "utf8"), "from the panel");
  assert.ok((await ls(hold.mountPath)).includes("top.txt"), "the mount root is invalidated too");
});

test("a delete through the API is gone from the mount when it returns", { skip }, async () => {
  // Written through the MOUNT, so it is visible without any invalidation — the
  // delete is the only thing under test. (The first version deleted the file
  // the previous test wrote; with invalidation off that file was never visible,
  // so "gone" passed on nothing.)
  await fs.mkdir(path.join(hold.mountPath, "trash"));
  await fs.writeFile(path.join(hold.mountPath, "trash/doomed.txt"), "x");
  assert.ok(await waitFor(async () => {
    try { return String(await readFile(owner, "trash/doomed.txt")) === "x"; } catch { return false; }
  }, 15_000), "precondition: the object reached S3");
  assert.deepEqual(await ls(path.join(hold.mountPath, "trash")), ["doomed.txt"], "precondition: listed and cached");
  await deleteFile(owner, "trash/doomed.txt");
  assert.deepEqual(await ls(path.join(hold.mountPath, "trash")), []);
});

test("a file the sandbox writes reaches S3, where the file panel reads it", { skip }, async () => {
  await fs.writeFile(path.join(hold.mountPath, "from-agent.txt"), "agent bytes");
  const landed = await waitFor(async () => {
    try { return String(await readFile(owner, "from-agent.txt")) === "agent bytes"; } catch { return false; }
  }, 15_000);
  assert.ok(landed, "the object exists on S3 within 15 s");
});

test("files belong to the sandbox's uid, group-shared, and closed to everyone else", { skip }, async () => {
  const st = await fs.stat(path.join(hold.mountPath, "from-agent.txt"));
  assert.equal(st.uid, config.s3.uid);
  assert.equal(st.gid, config.workspaceGid);
  assert.equal(st.mode & 0o777, 0o660);
});

// As the sandbox, not as root: root may chmod anything, so a root-run git
// passes on a mount where the sandbox's git cannot even `init`. That is how
// "git works" was once reported without ever having been true (bundle smoke
// 2026-10-24: "chmod on .git/config.lock failed: Operation not permitted").
test("git init, add and commit work as the sandbox's uid", { skip }, async () => {
  const uid = config.s3.uid;
  const gid = config.workspaceGid || uid;
  const script = [
    "set -e",
    "git init -q repo && cd repo",
    "echo x > f && chmod 755 f && git add f",
    "git -c user.email=it@cac -c user.name=it commit -qm first",
    "git log --oneline | wc -l",
  ].join("\n");
  // Bound where every parent is open, as docker binds it at /workspace: the
  // temp root above the mount is 0700, and git stats every parent of its
  // repository (measured: "Invalid path …: Permission denied").
  const ws = await fs.mkdtemp("/cac-s3it-ws-");
  execFileSync("mount", ["--bind", hold.mountPath, ws]);
  try {
    const out = execFileSync(
      "setpriv",
      [`--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "--", "env", "HOME=/tmp", "sh", "-c", script],
      { cwd: ws, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
    );
    assert.equal(out.trim(), "1");
  } finally {
    execFileSync("umount", [ws]);
    await fs.rmdir(ws);
  }
});

test("the last release unmounts and removes the socket", { skip }, async () => {
  const mountPath = hold.mountPath;
  hold.release();
  hold = null;
  await manager.drainForTest();
  const mounts = await fs.readFile("/proc/mounts", "utf8");
  assert.ok(!mounts.includes(mountPath), "no longer in /proc/mounts");
  assert.ok(!existsSync(rcSocketFor(config, mountPath)), "the socket is gone");
});
