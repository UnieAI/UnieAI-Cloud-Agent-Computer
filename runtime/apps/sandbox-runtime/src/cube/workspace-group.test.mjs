/**
 * The workspace group: how a sandbox reads what the S3 API wrote, without any
 * host account being able to.
 *
 * 2026-09-26 UAT 第 1 週 B1-D1（P0）：上傳的 CSV、AI 用 write／edit 寫的檔，在雲端
 * 沙盒裡是 `root:root 0660`，沙盒的 bash（uid 1000）讀不到。當天在主機的整棵掛載上
 * 加了 `-map.uid=1000:0` —— 而這台主機的 uid 1000 就是登入帳號 `ubuntu`，於是它變成
 * 每個租戶檔案的擁有者，現場隔離檢查擋下部署，a142cae6 還原。
 *
 * 這一支測的是替代方案的那條規則：**只對應 gid**，對應到一個主機上沒有人在的專用
 * gid，沙盒容器用 `--group-add` 加入它。規則只有一份（workspace-group.mjs），三個
 * 地方用它：repo 的掛載腳本（這裡直接執行它）、verify-storage（量正在跑的掛載）、
 * sandbox-runtime（`--group-add`、host 模式的 argv）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_WORKSPACE_GID,
  parseGroupFacts,
  resolveWorkspaceGid,
  workspaceGidMapFlag,
  workspaceMountIdentityChecks,
} from "./workspace-group.mjs";

const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

const GOOD_FACTS = { members: [], primaryOf: [] };
const GOOD_OPTIONS = "rw,nosuid,nodev,relatime,user_id=0,group_id=0,default_permissions,allow_other,max_read=1048576";

// ── resolveWorkspaceGid ─────────────────────────────────────────────────────

test("the workspace gid defaults to the dedicated one, so no deploy has to remember a value", () => {
  assert.equal(resolveWorkspaceGid({}), DEFAULT_WORKSPACE_GID);
  assert.equal(DEFAULT_WORKSPACE_GID, 2468);
});

test("an explicit gid is honoured; off disables; gid 0 and garbage are refused, not guessed", () => {
  assert.equal(resolveWorkspaceGid({ SANDBOX_WORKSPACE_GID: "3001" }), 3001);
  assert.equal(resolveWorkspaceGid({ SANDBOX_WORKSPACE_GID: "off" }), null);
  // gid 0 is `root`. cloud-sandbox-policy.md §4a measured 1,789 root:root
  // group-writable paths inside the image, /bin among them — joining it would
  // trade a read problem for "can overwrite system binaries".
  assert.equal(resolveWorkspaceGid({ SANDBOX_WORKSPACE_GID: "0" }), null);
  assert.equal(resolveWorkspaceGid({ SANDBOX_WORKSPACE_GID: "2468x" }), null);
  assert.equal(resolveWorkspaceGid({ SANDBOX_WORKSPACE_GID: "-5" }), null);
});

test("the map flag is <local>:<filer> — filer gid 0 (what S3 writes) shown locally as the workspace gid", () => {
  // weed 4.41 `mount -h`: "map local gid to gid on filer, comma-separated
  // <local_gid>:<filer_gid>"; parsed in weed/mount/meta_cache/id_mapper.go
  // (pair[0] local, pair[1] filer) independently of -map.uid.
  assert.equal(workspaceGidMapFlag(2468), "-map.gid=2468:0");
});

// ── workspaceMountIdentityChecks ─────────────────────────────────────────────

const MOUNT_ARGV = [
  "/home/ubuntu/.local/bin/weed", "mount", "-filer=172.20.0.4:8888", "-filer.path=/buckets", "-dir=/mnt/ava",
  "-allowOthers=true", "-volumeServerAccess=filerProxy", "-defaultPermissions=true", "-map.gid=2468:0", "-dirAutoCreate",
];

test("the intended mount passes every property", () => {
  const checks = workspaceMountIdentityChecks({
    argv: MOUNT_ARGV, mountOptions: GOOD_OPTIONS, expectedGid: 2468, groupFacts: GOOD_FACTS,
  });
  for (const c of checks) assert.equal(c.ok, true, `${c.id}: ${c.detail}`);
  assert.deepEqual(checks.map((c) => c.id).sort(), ["default-permissions", "gid-map", "group-has-no-host-members", "no-uid-map"]);
});

test("today's installed mount (no map at all) fails on the gid map — that is B1-D1", () => {
  const argv = MOUNT_ARGV.filter((a) => !a.startsWith("-map."));
  const c = byId(workspaceMountIdentityChecks({ argv, mountOptions: GOOD_OPTIONS, expectedGid: 2468, groupFacts: GOOD_FACTS }));
  assert.equal(c["no-uid-map"].ok, true);
  assert.equal(c["gid-map"].ok, false);
  assert.match(c["gid-map"].detail, /S3/);
});

test("a uid map fails, whatever else is right — the 2026-09-26 incident", () => {
  const argv = [...MOUNT_ARGV, "-map.uid=1000:0"];
  const c = byId(workspaceMountIdentityChecks({ argv, mountOptions: GOOD_OPTIONS, expectedGid: 2468, groupFacts: GOOD_FACTS }));
  assert.equal(c["no-uid-map"].ok, false);
  assert.match(c["no-uid-map"].detail, /-map\.uid=1000:0/);
});

test("the space-separated flag form is read too — Go's flag package accepts both", () => {
  const argv = ["weed", "mount", "-map.uid", "1000:0", "--map.gid", "2468:0"];
  const c = byId(workspaceMountIdentityChecks({ argv, mountOptions: GOOD_OPTIONS, expectedGid: 2468, groupFacts: GOOD_FACTS }));
  assert.equal(c["no-uid-map"].ok, false);
  assert.equal(c["gid-map"].ok, true, c["gid-map"].detail);
});

test("the gid map must be EXACTLY <workspace gid>:0 — another pair or another gid is a fail", () => {
  for (const flag of ["-map.gid=1000:0", "-map.gid=2468:0,1000:5", "-map.gid=2468:1", "-map.gid=3001:0"]) {
    const argv = [...MOUNT_ARGV.filter((a) => !a.startsWith("-map.gid")), flag];
    const c = byId(workspaceMountIdentityChecks({ argv, mountOptions: GOOD_OPTIONS, expectedGid: 2468, groupFacts: GOOD_FACTS }));
    assert.equal(c["gid-map"].ok, false, flag);
  }
});

test("no configured workspace gid is a fail, not a skip", () => {
  const c = byId(workspaceMountIdentityChecks({ argv: MOUNT_ARGV, mountOptions: GOOD_OPTIONS, expectedGid: null, groupFacts: GOOD_FACTS }));
  assert.equal(c["gid-map"].ok, false);
});

test("without default_permissions the container's --group-add is invisible, so that is a fail", () => {
  // weed/mount/weedfs_file_mkrm.go:339 and weedfs_filehandle.go:52 (4.41,
  // de34a1a87): with default_permissions OFF, weed checks access itself and
  // resolves the caller's supplementary groups with user.LookupId() against the
  // HOST's group database — which has never heard of a container's --group-add.
  const off = byId(workspaceMountIdentityChecks({
    argv: MOUNT_ARGV, mountOptions: "rw,nosuid,nodev,allow_other", expectedGid: 2468, groupFacts: GOOD_FACTS,
  }));
  assert.equal(off["default-permissions"].ok, false);
  const flagOff = byId(workspaceMountIdentityChecks({
    argv: [...MOUNT_ARGV, "-defaultPermissions=false"], mountOptions: GOOD_OPTIONS, expectedGid: 2468, groupFacts: GOOD_FACTS,
  }));
  assert.equal(flagOff["default-permissions"].ok, false);
  const unknown = byId(workspaceMountIdentityChecks({ argv: MOUNT_ARGV, mountOptions: null, expectedGid: 2468, groupFacts: GOOD_FACTS }));
  assert.equal(unknown["default-permissions"].ok, false, "an unreadable mount table is not a pass");
});

test("a host account in the workspace group — as member or primary group — is a fail; unknown is too", () => {
  // The whole design is "a host account is OTHER". The day somebody runs
  // `usermod -aG <group> ubuntu`, the map turns back into today's incident.
  const member = byId(workspaceMountIdentityChecks({
    argv: MOUNT_ARGV, mountOptions: GOOD_OPTIONS, expectedGid: 2468, groupFacts: { members: ["ubuntu"], primaryOf: [] },
  }));
  assert.equal(member["group-has-no-host-members"].ok, false);
  assert.match(member["group-has-no-host-members"].detail, /ubuntu/);
  const primary = byId(workspaceMountIdentityChecks({
    argv: MOUNT_ARGV, mountOptions: GOOD_OPTIONS, expectedGid: 2468, groupFacts: { members: [], primaryOf: ["svc"] },
  }));
  assert.equal(primary["group-has-no-host-members"].ok, false);
  const unknown = byId(workspaceMountIdentityChecks({ argv: MOUNT_ARGV, mountOptions: GOOD_OPTIONS, expectedGid: 2468, groupFacts: null }));
  assert.equal(unknown["group-has-no-host-members"].ok, false);
});

test("parseGroupFacts reads getent output: members from the group line, accounts whose primary gid it is", () => {
  const passwd = [
    "root:x:0:0:root:/root:/bin/bash",
    "ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash",
    "svc:x:1500:2468::/nonexistent:/usr/sbin/nologin",
  ].join("\n");
  assert.deepEqual(parseGroupFacts({ gid: 2468, groupLine: "ava-ws:x:2468:", passwdText: passwd }), { members: [], primaryOf: ["svc"] });
  assert.deepEqual(parseGroupFacts({ gid: 2468, groupLine: "", passwdText: "root:x:0:0::/root:/bin/sh" }), { members: [], primaryOf: [] });
  assert.deepEqual(parseGroupFacts({ gid: 988, groupLine: "docker:x:988:ubuntu,deploy", passwdText: "" }), { members: ["ubuntu", "deploy"], primaryOf: [] });
});

// ── the repo's mount script, executed ──────────────────────────────────────
//
// Not a regex over the file: the script is run with a stub `weed` that prints
// the argv it was exec'd with, so what is asserted is exactly what the root
// unit would pass to the real binary — including the guard's decision.

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../deploy/systemd/ava-workspace-mount.sh",
);

function runMountScript(extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ava-mount-script-"));
  try {
    const stub = path.join(dir, "weed");
    writeFileSync(stub, '#!/bin/sh\necho ARGV\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n');
    chmodSync(stub, 0o755);
    const env = {
      PATH: process.env.PATH,
      AVA_FILER: "127.0.0.1:1", // skips the `docker inspect` lookup
      AVA_WEED: stub,
      MOUNT_ROOT: path.join(dir, "mnt"),
      ...extraEnv,
    };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
    const r = spawnSync("sh", [SCRIPT], { env, encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 0, `script exited ${r.status}: ${r.stderr}`);
    const lines = r.stdout.split("\n");
    const argv = lines.slice(lines.indexOf("ARGV") + 1).filter(Boolean);
    return { argv, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the repo mount script maps filer gid 0 to the workspace group and maps no uid", () => {
  const { argv } = runMountScript();
  const c = byId(workspaceMountIdentityChecks({
    argv: ["weed", ...argv], mountOptions: GOOD_OPTIONS, expectedGid: DEFAULT_WORKSPACE_GID, groupFacts: GOOD_FACTS,
  }));
  assert.equal(c["no-uid-map"].ok, true, c["no-uid-map"].detail);
  assert.equal(c["gid-map"].ok, true, `${c["gid-map"].detail} — argv: ${argv.join(" ")}`);
  assert.equal(c["default-permissions"].ok, true, c["default-permissions"].detail);
  assert.equal(argv[0], "mount");
});

test("the mount script refuses to map a gid that a host account already has", () => {
  // The process running this test is a host account; its primary gid is the
  // exact shape of today's mistake. (As root in CI it is gid 0, refused too.)
  const { argv, stderr } = runMountScript({ AVA_WORKSPACE_GID: String(process.getgid()) });
  assert.equal(argv.some((a) => a.startsWith("-map.")), false, argv.join(" "));
  assert.match(stderr, /NOT mapping/);
});

test("the mount script refuses a gid that is not a plain positive integer", () => {
  for (const bad of ["abc", "0", "007", ""]) {
    const { argv, stderr } = runMountScript({ AVA_WORKSPACE_GID: bad });
    if (bad === "") {
      // Empty means "unset" to `${VAR:-default}` — the default applies.
      assert.ok(argv.includes(`-map.gid=${DEFAULT_WORKSPACE_GID}:0`), argv.join(" "));
      continue;
    }
    assert.equal(argv.some((a) => a.startsWith("-map.")), false, `${bad}: ${argv.join(" ")}`);
    assert.match(stderr, /NOT mapping/, bad);
  }
});
