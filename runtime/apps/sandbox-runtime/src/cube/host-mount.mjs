/**
 * cube/host-mount.mjs — host-side per-workspace SeaweedFS mount, so the
 * sandbox does not have to reach the filer itself.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The cm-agent-sandbox image mounts its own /workspace: agent-entrypoint.sh
 * runs `weed mount --filer=<filer>:8888` (FUSE) before exec'ing the agent. That
 * makes a route to the filer a HARD REQUIREMENT of every sandbox — and the
 * filer answers ANONYMOUSLY. Measured from a real sandbox: `GET /buckets/` →
 * HTTP 200 with the full listing of every tenant's workspace, while the S3
 * gateway on :8333 correctly 403s the same anonymous caller. Any code the model
 * runs therefore reaches every tenant's files with no credential at all.
 *
 * Authenticating that mount is not available: `weed mount` has no JWT flag
 * (independently re-verified here against both weed 3.71, the version in the
 * image, and 4.41, the version the cluster runs — `weed mount -h | grep -c jwt`
 * is 0 for both), and it talks the filer's gRPC on :18888, which carries no
 * authorization at all.
 *
 * So the fix is to remove the requirement rather than try to satisfy it
 * safely: mount on the HOST, hand the guest a bind mount. The guest then holds
 * no filer address, no credential and no need for `weed` — which in turn lets
 * the container drop CAP_SYS_ADMIN, /dev/fuse and the apparmor escape, turn on
 * no-new-privileges, and (the point of the exercise) run with no route to the
 * filer at all.
 *
 * ── Why not @unieai/agent-fs ───────────────────────────────────────────────
 *
 * `runtime/packages/agent-fs` implemented almost exactly this — refcounted
 * per-(user, project) host mounts with idle unmount, an LRU cap and a startup
 * reconcile (nothing ever imported it; it was deleted on 2026-09-24). It was
 * NOT reused here, for three reasons, all of them checked in the source rather
 * than the README:
 *
 *   1. It is TypeScript with `"main": "./src/index.ts"`. sandbox-runtime is
 *      plain .mjs started directly by node with no loader and no build step, so
 *      importing it would be a runtime `ERR_UNKNOWN_FILE_EXTENSION` in
 *      production while every test that stubs it stays green.
 *   2. Its key space is (userId, projectId) — `resolveMountPath` rejects a `/`
 *      in either — and it mounts `/buckets/<bucket>/<userId>/<projectId>`. The
 *      sandbox's workspace is `/buckets/<bucket>/users/<uid>/workspace`, three
 *      segments deep, which that key space cannot express.
 *   3. `buildWeedMountArgs` hard-codes `-volumeServerAccess=filerProxy`, which
 *      its own comment records as breaking EVERY READ on weed 3.71.
 *
 *   And one defect it would have imported: `reconcileExistingMounts` decides a
 *   mount is live purely from /proc/mounts. MEASURED on this host — `kill -9`
 *   on the weed process leaves the `fuse.seaweedfs` line in /proc/mounts, every
 *   I/O then returns ENOTCONN, and a container bind-mounted onto it sees
 *   "Socket not connected". agent-fs adopts that as `state: 'ready'` and hands
 *   it to the next caller. `reconcile()` below probes liveness, not the mount
 *   table. The shared concepts are cheap; the shared bugs are not.
 *
 * ── Host prerequisites (checked at acquire time, not assumed) ──────────────
 *
 *   · `user_allow_other` in /etc/fuse.conf. MEASURED: without it, fusermount
 *     refuses `-allowOthers` for a non-root mounter ("option allow_other only
 *     allowed if 'user_allow_other' is set"), and WITHOUT allow_other the
 *     docker daemon — which is root, and is not the mount owner — cannot
 *     traverse the mount, so `docker run -v <mount>:/workspace` dies with the
 *     misleading `error while creating mount source path ...: file exists`.
 *   · a `weed` binary on the host (SANDBOX_HOST_MOUNT_WEED_BINARY).
 *   · a filer address the HOST can reach (SANDBOX_HOST_MOUNT_FILER). Note this
 *     is a different vantage point from the guest's: on this box the guest
 *     resolves `seaweedfs:8888` over the docker network and the host does not
 *     resolve that name at all.
 *   · a volume-server access mode that works from the host. `direct` makes the
 *     FUSE client dial the address the master advertises (`seaweedfs-volume:8080`),
 *     which the host cannot resolve — and the failure is SILENT: writes appear
 *     to succeed and land as 0-byte files. Hence the default here is
 *     `filerProxy`, which needs nothing but the filer. filerProxy's broken-read
 *     bug is a weed 3.71 bug; verified round-tripping on 4.41.
 */

import { spawn as nodeSpawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { promises as fsp, constants as fsConstants } from "node:fs";
import path from "node:path";

import { s3ForcePathStyle } from "../../../../packages/storage-engine/src/index.mjs";
import { SandboxError } from "../shared/error.mjs";
import { log } from "../shared/log.mjs";
import { isTenantBucketName } from "../workspace/tenant-store.mjs";
import { needsWorkspaceFixup, tenantRootFencePlan, tenantRootFenced, workspaceFixupPlan } from "./workspace-dir.mjs";
import { resolveWorkspaceGid, workspaceGidMapFlag } from "./workspace-group.mjs";

/** The two workspace-mount mechanisms. `in-guest` is today's behaviour. */
export const WORKSPACE_MOUNT_IN_GUEST = "in-guest";
export const WORKSPACE_MOUNT_HOST = "host";
/**
 * The tree is mounted ONCE, by root, outside this process — a systemd unit —
 * and this runtime only binds subpaths of it into containers.
 *
 * WHY THIS MODE EXISTS AT ALL. `host` has this process do the mounting, and
 * this process runs unprivileged (`CapEff: 0`). A FUSE mount is readable only
 * by the user who made it, so an unprivileged mount that dockerd (root) and a
 * non-root container user must both read needs `allow_other` — and a non-root
 * user may only pass `allow_other` if `/etc/fuse.conf` carries
 * `user_allow_other`. That line was written up as "a hard prerequisite of
 * host-mount mode". MEASURED 2026-09-06, it is not:
 *
 *   ubuntu mounts, -allowOthers=true, fuse.conf untouched  → REFUSED
 *     "option allow_other only allowed if 'user_allow_other' is set"
 *   root   mounts, -allowOthers=true, fuse.conf untouched  → mounts; ubuntu
 *     reads it; dockerd binds it into a container that reads real content
 *   root   mounts, -allowOthers=false                      → mounts; only a
 *     ROOT container user can read it (this image runs USER=user, so the
 *     option is still needed — from root, where it is free)
 *
 * So the prerequisite belongs to "an unprivileged process does the mounting",
 * not to host mounting. That matters beyond convenience: `user_allow_other`
 * lets ANY unprivileged local user create a filesystem root will read, and a
 * FUSE server answers every syscall — it can return different bytes on
 * successive reads, or hang one forever, against a root process that walks the
 * filesystem. On a host whose only shell user already has passwordless sudo
 * that is close to a no-op, but this project runs on hosts we do not enumerate,
 * and one of them will have an unprivileged internet-facing daemon. Asking
 * every such host to loosen a global policy, for a requirement that turns out
 * to be avoidable, is the wrong trade.
 *
 * This mode also makes the runtime need NO privilege of its own: it mounts
 * nothing, so there is no helper to call, no sudoers rule, and no per-sandbox
 * FUSE mount to refcount.
 */
export const WORKSPACE_MOUNT_HOST_PREMOUNTED = "host-premounted";

/**
 * Which mechanism this deployment uses. DEFAULT IS UNCHANGED BEHAVIOUR.
 *
 * An unrecognised value falls back to `in-guest` rather than throwing or
 * guessing `host`: the fail-safe direction for a live data path is the
 * mechanism that is known to work, and a typo in a deploy env must not flip it.
 */
export function resolveWorkspaceMountMode(env = process.env) {
  const raw = String(env?.SANDBOX_WORKSPACE_MOUNT ?? "").trim().toLowerCase();
  if (raw === WORKSPACE_MOUNT_HOST_PREMOUNTED) return WORKSPACE_MOUNT_HOST_PREMOUNTED;
  if (raw === WORKSPACE_MOUNT_HOST) return WORKSPACE_MOUNT_HOST;
  if (raw && raw !== WORKSPACE_MOUNT_IN_GUEST) {
    log("warn", "host_mount.unknown_mode", {
      value: raw,
      note: `SANDBOX_WORKSPACE_MOUNT="${raw}" is not a mount mode; using "${WORKSPACE_MOUNT_IN_GUEST}"`,
    });
  }
  return WORKSPACE_MOUNT_IN_GUEST;
}

function intEnv(raw, fallback) {
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

/**
 * WHICH PROGRAM MOUNTS a workspace in `host` mode (CAC P2).
 *
 *   · `weed`  (default) — `weed mount` against a SeaweedFS filer. Everything in
 *     the header above is about this one; production runs it.
 *   · `s3`    — `rclone mount` against any S3 API: the operator's own MinIO,
 *     AWS, R2, or the SeaweedFS S3 gateway. It is what lets a self-hosted
 *     deployment bring its own object store: `weed mount` speaks only the
 *     filer's gRPC, so with any other store the file panel (plain S3 through
 *     storage-engine) worked while every sandbox saw an empty /workspace.
 *
 * Same keys, same layout on both: the mount names `<bucket>/<subpath>`, which
 * is exactly the S3 key storage-engine writes, so the file panel and the
 * sandbox look at the same objects.
 *
 * An unknown value is a config error, not a fallback to weed: a deployment that
 * asked for its own S3 and silently got a weed mount would hand every sandbox an
 * empty workspace (no filer answers) instead of an error.
 */
export const HOST_MOUNT_DRIVER_WEED = "weed";
export const HOST_MOUNT_DRIVER_S3 = "s3";

export function resolveHostMountDriver(env = process.env) {
  const raw = String(env?.SANDBOX_HOST_MOUNT_DRIVER ?? "").trim().toLowerCase();
  if (raw === "" || raw === HOST_MOUNT_DRIVER_WEED) return HOST_MOUNT_DRIVER_WEED;
  if (raw === HOST_MOUNT_DRIVER_S3) return HOST_MOUNT_DRIVER_S3;
  throw new SandboxError(
    "config_error",
    `SANDBOX_HOST_MOUNT_DRIVER="${raw}" is not a mount driver; use "${HOST_MOUNT_DRIVER_WEED}" (SeaweedFS filer) or "${HOST_MOUNT_DRIVER_S3}" (any S3 API, via rclone)`,
    500,
  );
}

/**
 * Directory holding one control socket per rclone mount. A unix socket path is
 * capped at 107 bytes by the kernel (sun_path) and rclone then dies with a bare
 * "bind: invalid argument" — measured with a socket under the scratchpad — so a
 * long directory is refused here, at config time, with the reason.
 */
const RC_SOCKET_NAME_LEN = 22; // "<16 hex>.sock" plus the separator, rounded up
function resolveRcDir(env) {
  const dir = String(env?.SANDBOX_HOST_MOUNT_RCLONE_RC_DIR ?? "").trim() || "/run/cac-rclone";
  if (!path.isAbsolute(dir) || dir.length + RC_SOCKET_NAME_LEN > 107) {
    throw new SandboxError(
      "config_error",
      `SANDBOX_HOST_MOUNT_RCLONE_RC_DIR must be an absolute path short enough for a unix socket (≤ ${107 - RC_SOCKET_NAME_LEN} bytes); got ${JSON.stringify(dir)}`,
      500,
    );
  }
  return dir;
}

/** The control socket of the rclone mount at `mountPath`. Derived, so a mount
 *  adopted from a previous process (reconcile) is still reachable. */
export function rcSocketFor(cfg, mountPath) {
  const id = createHash("sha256").update(path.resolve(mountPath)).digest("hex").slice(0, 16);
  return path.join(cfg.s3.rcDir, `${id}.sock`);
}

/**
 * The uid every file on an `s3` mount belongs to, and the uid the sandbox runs
 * as (docker.mjs passes `--user <uid>:<workspace gid>`). They must be the same
 * number: rclone stores no owner, so every file shows as `--uid`, and with
 * default_permissions the kernel lets only the owner chmod — git chmods its
 * lock files on every config write, so a sandbox that is not the owner cannot
 * `git init` (measured: "chmod on .git/config.lock failed: Operation not
 * permitted", bundle smoke 2026-10-24). rclone itself ignores the mode change.
 *
 * NOT 1000 and never 0: like the workspace gid (workspace-group.mjs), it must
 * be a number no host account has, because the owner of a tenant's files can
 * read them from the host. uid 1000 is the login account on a stock Ubuntu
 * host — that exact mapping was reverted once already (a142cae6).
 */
export const DEFAULT_S3_MOUNT_UID = 2468;

function resolveS3MountUid(env) {
  const raw = String(env?.SANDBOX_HOST_MOUNT_S3_UID ?? "").trim();
  if (!raw) return DEFAULT_S3_MOUNT_UID;
  const uid = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new SandboxError(
      "config_error",
      `SANDBOX_HOST_MOUNT_S3_UID=${JSON.stringify(raw)} must be a positive uid that no host account has (the sandbox runs as it; 0 would make the sandbox root)`,
      500,
    );
  }
  return uid;
}

/** Env → host-mount config. Pure; every field is overridable for tests. */
export function resolveHostMountConfig(env = process.env) {
  return {
    mode: resolveWorkspaceMountMode(env),
    driver: resolveHostMountDriver(env),
    rcloneBinary: String(env?.SANDBOX_HOST_MOUNT_RCLONE_BINARY ?? "rclone").trim() || "rclone",
    /** Where the object store is. NO credentials here: inspect() returns this
     *  object, and the keys reach rclone only through its environment. */
    s3: {
      endpoint: String(env?.S3_ENDPOINT ?? "").trim(),
      region: String(env?.S3_REGION ?? "").trim(),
      forcePathStyle: s3ForcePathStyle(env),
      /** What a location with `bucket: null` means: storage-engine's default,
       *  S3_BUCKET and nothing else. NOT `WEED_S3_BUCKET || S3_BUCKET` — that
       *  exact fallback is how the sandbox and the file panel once used two
       *  different buckets (resolveWorkspaceLocation in docker.mjs, 2026-09-07). */
      defaultBucket: String(env?.S3_BUCKET ?? "").trim(),
      /** Backstop only, for writes that do not pass through this process (another
       *  host, the caller writing S3 directly). Writes that do are made visible
       *  at once by invalidateObject. */
      dirCacheSec: intEnv(env?.SANDBOX_HOST_MOUNT_S3_DIR_CACHE_SEC, 5),
      rcDir: resolveRcDir(env),
      /** Owner of every file on the mount AND the sandbox's uid. See above. */
      uid: resolveS3MountUid(env),
    },
    /** Host directory that holds every mount. Mirrors the /mnt/<bucket>/<path>
     *  convention the allocate API already speaks. */
    mountRoot: String(env?.SANDBOX_HOST_MOUNT_ROOT ?? "/mnt").trim() || "/mnt",
    /** `host:port` of the filer AS THE HOST REACHES IT (not as the guest does). */
    filer: String(env?.SANDBOX_HOST_MOUNT_FILER ?? "127.0.0.1:8888").trim(),
    weedBinary: String(env?.SANDBOX_HOST_MOUNT_WEED_BINARY ?? "weed").trim() || "weed",
    /** See the header note: `direct` fails SILENTLY from the host on this box. */
    volumeServerAccess:
      String(env?.SANDBOX_HOST_MOUNT_VOLUME_ACCESS ?? "filerProxy").trim() || "filerProxy",
    extraArgs: String(env?.SANDBOX_HOST_MOUNT_WEED_EXTRA_ARGS ?? "").trim().split(/\s+/).filter(Boolean),
    readyTimeoutMs: intEnv(env?.SANDBOX_HOST_MOUNT_READY_TIMEOUT_MS, 20_000),
    /** Seconds a refcount-0 mount is kept warm before unmounting. 0 = at once. */
    idleUnmountSec: intEnv(env?.SANDBOX_HOST_MOUNT_IDLE_SEC, 300),
    /** The group S3-written files are shown to (filer gid 0 → this gid), or null.
     *  See cube/workspace-group.mjs. */
    workspaceGid: resolveWorkspaceGid(env),
  };
}

const SEGMENT_OK = /^[A-Za-z0-9._@:+-]+$/;

/**
 * `<mountRoot>/<bucket>/<subpath>`, with the path-escape guard that becomes
 * load-bearing the moment the mount moves to the host: this process can reach
 * EVERY tenant, so a bad path here mounts the wrong subtree for everyone.
 */
/**
 * How long a successful fixup stands in for a look this process cannot take.
 *
 * Since the tenant-root fence (F-GRP) this process gets EACCES on every isolated
 * tenant's `workspace` and `.snapshots`, so it can never SEE that a directory it
 * prepared is still fine. Without a memo it re-ran the root one-shot on every
 * allocation — two containers per sandbox, measured 2026-09-30 at 13–22 s per
 * allocation on the test tenant (AGENT-577). Bounded rather than for the life of
 * the process because what the memo cannot see is a directory deleted and
 * recreated behind it: dockerd would recreate a missing bind source as
 * `root:root 0755`, unwritable for the sandbox, and this caps how long that can
 * last.
 */
export const WORKSPACE_PREPARED_TTL_MS = 15 * 60_000;

/**
 * Create the tenant's workspace directory, owned by the sandbox's uid, when it
 * is missing or unusable. No-op otherwise — this is on the allocation path, and
 * a check that started a container every time would make the cost of the fence
 * proportional to traffic.
 *
 * Failures are logged, not thrown: an unusable workspace is a degraded sandbox,
 * while refusing to allocate is no sandbox at all, and the error the agent then
 * sees ("Permission denied" on a path) is more actionable than a 503 with no
 * path in it.
 */
async function ensureWorkspaceUsable(mountPath, deps = {}) {
  const stat = deps.stat ?? ((p) => fsp.stat(p));
  const runDocker = deps.runDocker ?? defaultRunDocker;
  const prepared = deps.prepared ?? null; // Map<mountPath, preparedAtMs> | null
  const now = deps.now ?? Date.now;
  let facts = { exists: false };
  let examined = true;
  try {
    const st = await stat(mountPath);
    facts = { exists: true, uid: st.uid, mode: st.mode & 0o777 };
  } catch (err) {
    if (err?.code !== "ENOENT") {
      // EACCES here is this process being fenced out of the tenant's tree —
      // true of every legacy tenant (`users/` is 0770 root) and, since the
      // tenant-root fence (2026-09-26, F-GRP), of every isolated one too. It
      // cannot tell whether the workspace is usable, so the one-shot runs —
      // unless it already ran recently (see WORKSPACE_PREPARED_TTL_MS).
      // NOT "absent": that label went into the log for directories full of the
      // tenant's files and sent AGENT-577's investigation looking for a
      // destructive mkdir that never happened.
      examined = false;
      // EACCES is the fence doing its job, on every allocation: info, not warn.
      // Anything else (EIO, ENOTCONN, …) is still worth a warning.
      log(err?.code === "EACCES" ? "info" : "warn", "host_mount.workspace_stat_failed", {
        mountPath,
        code: err?.code,
        ...(err?.code === "EACCES" ? { note: "expected: this process is fenced out of the tenant's root; the directory is not known to be missing" } : {}),
      });
    }
  }
  if (!needsWorkspaceFixup(facts)) return;
  if (!examined && prepared) {
    const at = prepared.get(mountPath);
    if (at != null && now() - at < WORKSPACE_PREPARED_TTL_MS) return;
  }
  const image = "image" in deps ? deps.image : process.env.SANDBOX_DOCKER_IMAGE;
  if (!image) {
    log("warn", "host_mount.workspace_fixup_skipped", { mountPath, reason: "SANDBOX_DOCKER_IMAGE unset" });
    return;
  }
  const plan = workspaceFixupPlan({ hostPath: mountPath, image });
  try {
    await runDocker(plan.args);
    prepared?.set(mountPath, now());
    const was = !examined
      ? "unexamined (this process cannot look inside the tenant's root)"
      : facts.exists ? `uid=${facts.uid} mode=${(facts.mode ?? 0).toString(8)}` : "absent";
    log("info", "host_mount.workspace_prepared", { mountPath, was });
  } catch (e) {
    prepared?.delete(mountPath);
    log("warn", "host_mount.workspace_fixup_failed", { mountPath, error: String(e?.message ?? e) });
  }
}

/** `docker <args>`, resolved and bounded. Rejects on a non-zero exit. */
function defaultRunDocker(args) {
  return new Promise((resolve, reject) => {
    execFile(process.env.DOCKER_BIN || "docker", args, { timeout: 30_000 }, (err, _out, stderr) =>
      err ? reject(new Error(String(stderr || err.message).slice(0, 300))) : resolve(),
    );
  });
}

export function hostMountPathFor(mountRoot, bucket, subpath) {
  const bad = (why) =>
    new SandboxError("bad_request", `host mount path rejected: ${why}`, 400);
  const b = String(bucket ?? "");
  const s = String(subpath ?? "");
  if (!b || !SEGMENT_OK.test(b) || b === "." || b === "..") throw bad(`bucket ${JSON.stringify(b)}`);
  if (!s || s.startsWith("/")) throw bad(`subpath ${JSON.stringify(s)}`);
  const segments = s.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === ".." || !SEGMENT_OK.test(seg)) {
      throw bad(`subpath segment ${JSON.stringify(seg)} in ${JSON.stringify(s)}`);
    }
  }
  const root = path.resolve(String(mountRoot || "/mnt"));
  const full = path.resolve(root, b, ...segments);
  // Belt and braces: even with the segment guard, never return a path outside
  // the root. Two independent checks because one of them is the whole security
  // property of this file.
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw bad(`${full} escapes ${root}`);
  }
  return full;
}

/** The filer subtree a (bucket, subpath) names. Same shape the guest used. */
export function remoteFilerPath(bucket, subpath) {
  return `/buckets/${bucket}/${subpath}`;
}

/**
 * `weed mount` argv for one workspace. Deliberately NOT shared with the
 * former agent-fs's buildWeedMountArgs — see the header.
 */
export function buildHostWeedMountArgs(cfg, { bucket, subpath, mountPath, readOnly = false }) {
  const argv = [
    "mount",
    `-filer=${cfg.filer}`,
    `-dir=${mountPath}`,
    `-filer.path=${remoteFilerPath(bucket, subpath)}`,
    "-dirAutoCreate",
    // Load-bearing, and measured — see the header. Without it dockerd cannot
    // bind the mount and the whole mechanism fails at `docker run`.
    "-allowOthers=true",
    `-volumeServerAccess=${cfg.volumeServerAccess}`,
    // Files written through the S3 API are uid 0 / gid 0, mode 0660 on the filer
    // while the agent runs as uid 1000. This used to copy the in-guest
    // entrypoint's `-map.uid=1000:0 -map.gid=1000:0` — "the mapping has to move
    // with the mount". It must not: inside a guest uid 1000 is the sandbox user,
    // but this mount is on the HOST, where uid 1000 is the login account, and
    // the map made that account the owner of the tenant's files (the same
    // mistake a142cae6 reverted for the premounted unit, 2026-09-26). Only the
    // group is mapped, to a gid no host account is in, and the container joins
    // it with --group-add (docker.mjs). See cube/workspace-group.mjs.
    ...(cfg.workspaceGid ? [workspaceGidMapFlag(cfg.workspaceGid)] : []),
  ];
  if (readOnly) argv.push("-readOnly");
  argv.push(...cfg.extraArgs);
  return argv;
}

/**
 * `rclone mount` argv for one workspace (driver `s3`).
 *
 * Mirrors the weed argv decision for decision:
 *   · `--allow-other`: dockerd (root) binds the mount; see the header.
 *   · owner = the sandbox's own uid (DEFAULT_S3_MOUNT_UID, a number no host
 *     account has), group = the workspace group, files 0660 / dirs 0770. Not
 *     uid 0 as with weed: weed stores each file's owner, rclone shows every
 *     file as `--uid`, and a sandbox that owns nothing cannot chmod, so git
 *     cannot work. The container joins the group with --group-add.
 *   · `--vfs-cache-mode writes`: without it rclone refuses to open a file for
 *     read+write or to seek while writing, which is what editors, `sed -i`,
 *     git and sqlite do. A workspace that only takes sequential writes is not
 *     a workspace.
 *
 * No endpoint and no key on the argv: argv is world-readable in /proc. They go
 * in the child's environment (hostMountChildEnv), and the remote is the
 * on-the-fly `:s3:` backend, so no rclone.conf exists anywhere.
 */
export function buildHostS3MountArgs(cfg, { bucket, subpath, mountPath, readOnly = false }) {
  const gid = cfg.workspaceGid ?? 0;
  const argv = [
    "mount",
    `:s3:${bucket}/${subpath}`,
    mountPath,
    "--allow-other",
    "--uid", String(cfg.s3.uid),
    "--gid", String(gid),
    "--dir-perms", "0770",
    "--file-perms", "0660",
    // Without it the process umask (022) is applied on top: files came out
    // 0640 (measured), readable but not writable by the sandbox's group.
    "--umask", "007",
    "--vfs-cache-mode", "writes",
    // allow_other with NO permission check lets every account on the host read
    // every tenant's files: FUSE leaves access control to the server, and rclone
    // does none. This makes the kernel enforce the 0660 / 0770 + group above.
    "--default-permissions",
    "--dir-cache-time", `${cfg.s3.dirCacheSec}s`,
    // The control socket invalidateObject talks to. Unauthenticated, so it lives
    // in a 0700 directory (spawnMount): the socket itself is created 0775.
    "--rc", "--rc-no-auth", "--rc-addr", `unix://${rcSocketFor(cfg, mountPath)}`,
  ];
  if (readOnly) argv.push("--read-only");
  argv.push(...cfg.extraArgs);
  return argv;
}

/**
 * The environment the mount process gets. For `s3` it carries the store and
 * its keys, read from `env` at spawn time (never kept in cfg). Only what the
 * mounter needs: not this process's whole environment, which holds every other
 * secret the runtime was given.
 */
export function hostMountChildEnv(cfg, env = process.env) {
  const base = { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: env.HOME ?? "/root" };
  if (cfg.driver !== HOST_MOUNT_DRIVER_S3) return base;
  return {
    ...base,
    RCLONE_CONFIG: "/dev/null",
    RCLONE_S3_PROVIDER: "Other",
    RCLONE_S3_ENDPOINT: cfg.s3.endpoint,
    ...(cfg.s3.region ? { RCLONE_S3_REGION: cfg.s3.region } : {}),
    RCLONE_S3_ACCESS_KEY_ID: String(env.S3_ACCESS_KEY ?? ""),
    RCLONE_S3_SECRET_ACCESS_KEY: String(env.S3_SECRET_KEY ?? ""),
    RCLONE_S3_FORCE_PATH_STYLE: cfg.s3.forcePathStyle ? "true" : "false",
    // A bucket is never created by a mount: a typo in S3_BUCKET must fail, not
    // quietly make a second bucket nobody reads.
    RCLONE_S3_NO_CHECK_BUCKET: "true",
  };
}

/** The binary and argv that mount one workspace, for the configured driver. */
export function hostMountCommand(cfg, target) {
  if (cfg.driver === HOST_MOUNT_DRIVER_S3) {
    return { binary: cfg.rcloneBinary, argv: buildHostS3MountArgs(cfg, target) };
  }
  return { binary: cfg.weedBinary, argv: buildHostWeedMountArgs(cfg, target) };
}

// ---- default (real) seams ------------------------------------------------

const defaultSpawn = ({ binary, argv, mountPath, env }) => {
  const child = nodeSpawn(binary, argv, { stdio: ["ignore", "pipe", "pipe"], detached: false, ...(env ? { env } : {}) });
  const tag = `pid=${child.pid ?? "?"} dir=${mountPath}`;
  child.stderr?.on("data", (chunk) => {
    const line = String(chunk).split("\n")[0]?.slice(0, 240);
    if (line) log("warn", "host_mount.weed_stderr", { tag, line });
  });
  child.on("error", (err) => log("error", "host_mount.weed_spawn_error", { tag, error: err?.message }));
  return child;
};

/** POST one rclone remote-control command over the mount's unix socket. */
const defaultRcCall = (socketPath, command, params, timeoutMs = 1000) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify(params ?? {});
    const req = http.request(
      { socketPath, method: "POST", path: `/${command}`, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: timeoutMs },
      (res) => {
        let text = "";
        res.on("data", (c) => { text += c; });
        res.on("end", () => (res.statusCode === 200 ? resolve(text) : reject(new Error(`rc ${command}: HTTP ${res.statusCode} ${text.slice(0, 200)}`))));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`rc ${command}: no answer in ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(body);
  });

/** Absolute mount points under `root` that the kernel currently reports. */
/**
 * Is `treePath` covered by a live mount?
 *
 * TWO TOPOLOGIES, both legal, and the second is what makes per-tenant buckets
 * possible at all:
 *
 *   · PER-BUCKET — `-filer.path=/buckets/<bucket>` → `<root>/<bucket>`. One
 *     unit per bucket. This is what is deployed today.
 *   · ROOT — `-filer.path=/buckets` → `<root>`. Every bucket is then a
 *     subdirectory of one mount.
 *
 * The per-bucket shape does not scale to a bucket per tenant: the moment an
 * owner is added to `SANDBOX_ISOLATED_TENANTS` its bucket has no unit, and
 * allocation fails with `workspace_tree_not_mounted`. Measured in production on
 * 2026-09-07 — five migrated tenants, every listing verified identical, and
 * then every one of their sandboxes 503'd. The copies and the store were
 * correct; the mount topology was the half that did not follow.
 *
 * Accepting the root is not a relaxation: a mount AT the root genuinely serves
 * every path beneath it, which was verified against the live filer before this
 * function existed. What is still refused is an empty set and a mount somewhere
 * else — binding a bare directory would hand the tenant an EMPTY workspace
 * instead of an error, and that silent shape is what the whole check exists for.
 */
export function treeIsMounted({ mounts, root, treePath }) {
  return servingMount({ mounts, root, treePath }) !== null;
}

/**
 * WHICH mount serves `treePath`: the tree itself (per-bucket topology), or the
 * root that covers it (one mount for every bucket). `null` when neither.
 *
 * Split out of `treeIsMounted` (2026-09-26, F-GRP) because the answer is also
 * where liveness has to be asked. Under the root topology the tree is a
 * per-tenant bucket root, fenced against this process; the MOUNT is not.
 */
export function servingMount({ mounts, root, treePath }) {
  const r = path.resolve(root);
  const t = path.resolve(treePath);
  if (mounts.has(t)) return t;
  // The root itself covers everything under it.
  if (mounts.has(r) && (t === r || t.startsWith(r + path.sep))) return r;
  return null;
}

/**
 * Can this process walk into `p`? `true` / `false`, `null` if it could not ask.
 * An `access(X_OK)`: the kernel's own answer, owner, group and other included.
 */
const defaultCanTraverse = async (p) => {
  try {
    await fsp.access(p, fsConstants.X_OK);
    return true;
  } catch (err) {
    return err?.code === "EACCES" ? false : null;
  }
};

const defaultProbeMounts = async (root) => {
  const out = new Set();
  let raw;
  try {
    raw = await fsp.readFile("/proc/mounts", "utf8");
  } catch (err) {
    // An empty set here would look exactly like "nothing is mounted" and would
    // make reconcile rmdir live workspaces. Refuse instead.
    throw new SandboxError(
      "host_mount_failed",
      `cannot read /proc/mounts (host mount mode needs it): ${err?.message}`,
      500,
    );
  }
  const rootPath = path.resolve(root);
  const prefix = rootPath + path.sep;
  for (const line of raw.split("\n")) {
    const mp = line.split(/\s+/)[1];
    if (!mp) continue;
    const decoded = mp.replace(/\\040/g, " ");
    // The ROOT ITSELF is collected as well as everything below it: a single
    // mount of the filer's `/buckets` is the topology that makes one unit serve
    // every tenant bucket. It used to be excluded, which is why per-tenant
    // isolation 503'd on its first live attempt.
    const resolved = path.resolve(decoded);
    if (resolved === rootPath || decoded.startsWith(prefix)) out.add(resolved);
  }
  return out;
};

/**
 * Is this mount actually SERVING, as opposed to merely listed?
 *
 * The distinction is the whole point: a killed weed leaves the mount in
 * /proc/mounts and every syscall against it fails ENOTCONN. `opendir` is the
 * cheapest call that surfaces that.
 */
const defaultIsMountLive = async (mountPath) => {
  try {
    const dir = await fsp.opendir(mountPath);
    await dir.close();
    return true;
  } catch (err) {
    const code = err?.code;
    if (code === "ENOTCONN" || code === "EIO" || code === "EACCES" || code === "ENOENT") return false;
    // Anything unexpected: treat as not live rather than hand out a mount we
    // could not verify.
    log("warn", "host_mount.liveness_probe_error", { mountPath, code, error: err?.message });
    return false;
  }
};

const runTool = (bin, args) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: 15_000 }, (err) => resolve(!err));
  });

const defaultExternalUnmount = async (mountPath) => {
  if (await runTool("fusermount", ["-u", mountPath])) return true;
  if (await runTool("fusermount3", ["-u", mountPath])) return true;
  return runTool("umount", ["-l", mountPath]);
};

/** Leaf directories under `root` that look like `<bucket>/<...>` mount dirs. */
const defaultReadLeafDirs = async (root, knownMounts) => {
  // We cannot walk to arbitrary depth safely (a live FUSE mount would be
  // descended into), so the authoritative list of candidates is the mount table
  // plus one shallow scan for dirs that are NOT mounted.
  const leaves = new Set(knownMounts);
  const walk = async (dir, depth) => {
    if (depth > 4) return;
    let ents;
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      const full = path.join(dir, ent.name);
      if (knownMounts.has(full)) { leaves.add(full); continue; }
      const before = leaves.size;
      await walk(full, depth + 1);
      if (leaves.size === before) leaves.add(full); // a leaf with no mounted child
    }
  };
  await walk(path.resolve(root), 0);
  return Array.from(leaves);
};

// ---- the manager ---------------------------------------------------------

/**
 * Refcounted host mounts, one per (bucket, subpath).
 *
 * Every external dependency is a seam so the unit tests need no weed binary,
 * no filer and no root.
 */
export function createHostMountManager({
  config = resolveHostMountConfig(),
  spawn = defaultSpawn,
  probeMounts = defaultProbeMounts,
  isMountLive = defaultIsMountLive,
  externalUnmount = defaultExternalUnmount,
  mkdirp = (p) => fsp.mkdir(p, { recursive: true }),
  rmdir = (p) => fsp.rmdir(p),
  readLeafDirs = defaultReadLeafDirs,
  readyIntervalMs = 100,
  now = () => Date.now(),
  rcCall = defaultRcCall,
  prepareRcDir = (dir) => fsp.mkdir(dir, { recursive: true, mode: 0o700 }).then(() => fsp.chmod(dir, 0o700)),
  removeFile = (p) => fsp.rm(p, { force: true }),
} = {}) {
  /** mountPath -> entry */
  const entries = new Map();
  /** Unmounts in flight; awaited by drainForTest and shutdown. */
  const pending = new Set();
  let shuttingDown = false;

  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };

  async function waitReady(mountPath, deadline) {
    for (;;) {
      const mounts = await probeMounts(config.mountRoot);
      if (mounts.has(mountPath) && (await isMountLive(mountPath))) return true;
      if (now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, readyIntervalMs));
    }
  }

  /** Drop whatever is at mountPath, whether we own the process or not. */
  async function tearDown(entry) {
    if (entry.child) {
      try { if (!entry.child.killed) entry.child.kill("SIGTERM"); } catch { /* gone */ }
    }
    // Always follow with fusermount: SIGTERM on weed is not guaranteed to drop
    // the kernel mount, and an adopted mount has no child to signal at all.
    await externalUnmount(entry.mountPath).catch(() => false);
    try { await rmdir(entry.mountPath); } catch { /* non-empty or gone: fine */ }
    if (config.driver === HOST_MOUNT_DRIVER_S3) await removeFile(rcSocketFor(config, entry.mountPath)).catch(() => {});
  }

  async function spawnMount({ bucket, subpath, mountPath, readOnly }) {
    await mkdirp(mountPath);
    if (config.driver === HOST_MOUNT_DRIVER_S3) {
      await prepareRcDir(config.s3.rcDir);
      // A socket left by a killed rclone makes the new one fail to bind.
      await removeFile(rcSocketFor(config, mountPath)).catch(() => {});
    }
    const { binary, argv } = hostMountCommand(config, { bucket, subpath, mountPath, readOnly });
    const child = spawn({ binary, argv, mountPath, bucket, subpath, env: hostMountChildEnv(config) });
    const entry = entries.get(mountPath);
    if (entry) entry.child = child;
    const ok = await waitReady(mountPath, now() + config.readyTimeoutMs);
    if (!ok) {
      try { if (!child.killed) child.kill("SIGKILL"); } catch { /* gone */ }
      await externalUnmount(mountPath).catch(() => false);
      throw new SandboxError(
        "host_mount_failed",
        config.driver === HOST_MOUNT_DRIVER_S3
          ? `host rclone mount did not become usable within ${config.readyTimeoutMs}ms ` +
            `at ${mountPath} (s3 endpoint=${config.s3.endpoint || "(unset)"}, bucket=${bucket}). ` +
            `Run the storage doctor (node apps/sandbox-runtime/src/doctor/storage-doctor.mjs) for the reason.`
          : `host weed mount did not become usable within ${config.readyTimeoutMs}ms ` +
            `at ${mountPath} (filer=${config.filer}, volumeServerAccess=${config.volumeServerAccess})`,
        503,
      );
    }
    return child;
  }

  function scheduleIdleUnmount(entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const fire = () => {
      entry.idleTimer = null;
      if (entry.refcount !== 0 || entries.get(entry.mountPath) !== entry) return;
      entries.delete(entry.mountPath);
      track((async () => {
        await tearDown(entry);
        log("info", "host_mount.unmounted", { mountPath: entry.mountPath, reason: "idle" });
      })());
    };
    if (config.idleUnmountSec <= 0) { fire(); return; }
    entry.idleTimer = setTimeout(fire, config.idleUnmountSec * 1000);
    entry.idleTimer.unref?.();
  }

  function makeHandle(entry) {
    let released = false;
    return {
      mountPath: entry.mountPath,
      release() {
        if (released) return;
        released = true;
        if (entries.get(entry.mountPath) !== entry) return;
        if (entry.refcount > 0) entry.refcount -= 1;
        if (entry.refcount === 0) scheduleIdleUnmount(entry);
      },
    };
  }

  return {
    /** Which program mounts (weed | s3). docker.mjs reads it for the guest env. */
    driver: config.driver,
    /** The uid the sandbox must run as to own its files (s3), or null when the
     *  mount keeps each file's own owner (weed). See DEFAULT_S3_MOUNT_UID. */
    sandboxUid: config.driver === HOST_MOUNT_DRIVER_S3 ? config.s3.uid : null,

    /**
     * Take a hold on the host mount for one workspace, mounting it if needed.
     * Concurrent callers for the same workspace coalesce on one weed process.
     */
    async acquire({ bucket, subpath, readOnly = false } = {}) {
      if (shuttingDown) throw new SandboxError("host_mount_failed", "host mount manager is shutting down", 503);
      const mountPath = hostMountPathFor(config.mountRoot, bucket, subpath);

      const existing = entries.get(mountPath);
      if (existing) {
        existing.refcount += 1;
        if (existing.idleTimer) { clearTimeout(existing.idleTimer); existing.idleTimer = null; }
        try {
          await existing.ready;
        } catch (err) {
          existing.refcount -= 1;
          throw err;
        }
        // A mount can die between hand-outs. NEVER return one without checking
        // — that is precisely the stale-mount trap this design is known for.
        if (await isMountLive(mountPath)) return makeHandle(existing);
        log("warn", "host_mount.dead_mount_replaced", { mountPath });
        existing.refcount -= 1;
        entries.delete(mountPath);
        await tearDown(existing);
      }

      const entry = {
        mountPath, bucket, subpath, refcount: 1, child: null,
        idleTimer: null, createdAt: now(), ready: null,
      };
      entries.set(mountPath, entry);
      entry.ready = spawnMount({ bucket, subpath, mountPath, readOnly });
      try {
        await entry.ready;
      } catch (err) {
        if (entries.get(mountPath) === entry) entries.delete(mountPath);
        throw err;
      }
      log("info", "host_mount.mounted", { mountPath, bucket, subpath, readOnly });
      return makeHandle(entry);
    },

    /**
     * Make an object this process just wrote or deleted through S3 visible to
     * the mounts that cover it (driver `s3` only; weed follows the filer's own
     * metadata stream). Awaited by the write path — see userStore's
     * onWorkspaceObjectChange. Never throws: the object is already stored.
     *
     * Entries are matched by mountPath, not by their recorded bucket/subpath,
     * because a mount adopted at reconcile has neither.
     */
    async invalidateObject({ bucket, key } = {}) {
      if (config.driver !== HOST_MOUNT_DRIVER_S3) return [];
      const b = bucket || config.s3.defaultBucket;
      if (!b || !key) return [];
      const objectPath = path.resolve(config.mountRoot, b, String(key));
      const done = [];
      await Promise.all(Array.from(entries.values(), async (entry) => {
        const prefix = entry.mountPath + path.sep;
        if (!objectPath.startsWith(prefix)) return;
        const parent = path.posix.dirname(objectPath.slice(prefix.length).split(path.sep).join("/"));
        try {
          await rcCall(rcSocketFor(config, entry.mountPath), "vfs/forget", parent === "." ? {} : { dir: parent });
          done.push(entry.mountPath);
        } catch (err) {
          log("warn", "host_mount.invalidate_failed", {
            mountPath: entry.mountPath, error: err?.message,
            note: `the sandbox sees this change within ${config.s3.dirCacheSec}s (the mount's own cache expiry)`,
          });
        }
      }));
      return done;
    },

    /**
     * Startup reconcile. Unlike agent-fs's, a mount listed in /proc/mounts is
     * only adopted if it actually SERVES; a listed-but-dead mount is torn down
     * so the next acquire re-mounts it cleanly.
     */
    async reconcile() {
      const result = { adopted: [], staleUnmounted: [], removedDirs: [], errors: [] };
      let mounts;
      try {
        mounts = await probeMounts(config.mountRoot);
      } catch (err) {
        result.errors.push({ path: config.mountRoot, error: err?.message || String(err) });
        return result;
      }
      let leaves;
      try {
        leaves = await readLeafDirs(config.mountRoot, mounts);
      } catch (err) {
        result.errors.push({ path: config.mountRoot, error: err?.message || String(err) });
        return result;
      }
      const rootPath = path.resolve(config.mountRoot);
      for (const leaf of leaves) {
        // This manager mounts at <root>/<bucket>/<subpath>, never at the root.
        // The root shows up in /proc/mounts when it is itself a bind mount (the
        // compose bundle binds it rshared so the mounts reach dockerd). Adopted,
        // it got an idle timer that would have unmounted the bind — every
        // workspace with it — and it matched every invalidation (bundle smoke
        // 2026-10-24: "adopted":1 on an empty root).
        if (leaf === rootPath) continue;
        if (mounts.has(leaf)) {
          if (await isMountLive(leaf)) {
            const entry = {
              mountPath: leaf, bucket: null, subpath: null, refcount: 0, child: null,
              idleTimer: null, createdAt: now(), ready: Promise.resolve(),
            };
            entries.set(leaf, entry);
            result.adopted.push(leaf);
            scheduleIdleUnmount(entry);
          } else {
            // Listed but not serving: the classic unclean-shutdown remnant.
            await externalUnmount(leaf).catch(() => false);
            try { await rmdir(leaf); } catch { /* may be non-empty */ }
            result.staleUnmounted.push(leaf);
            log("warn", "host_mount.stale_unmounted", {
              mountPath: leaf,
              note: "mount was in /proc/mounts but ENOTCONN — a previous weed died uncleanly",
            });
          }
          continue;
        }
        try {
          await rmdir(leaf);
          result.removedDirs.push(leaf);
        } catch (err) {
          if (err?.code !== "ENOTEMPTY" && err?.code !== "ENOENT") {
            result.errors.push({ path: leaf, error: err?.message || String(err) });
          }
        }
      }
      if (result.adopted.length || result.staleUnmounted.length || result.removedDirs.length) {
        log("info", "host_mount.reconciled", {
          adopted: result.adopted.length,
          staleUnmounted: result.staleUnmounted.length,
          removedDirs: result.removedDirs.length,
        });
      }
      return result;
    },

    /** Await any unmount started by a release(). Test helper. */
    async drainForTest() {
      while (pending.size) await Promise.allSettled(Array.from(pending));
    },

    async shutdown() {
      shuttingDown = true;
      const all = Array.from(entries.values());
      entries.clear();
      for (const e of all) if (e.idleTimer) clearTimeout(e.idleTimer);
      await Promise.allSettled(all.map((e) => tearDown(e)));
      while (pending.size) await Promise.allSettled(Array.from(pending));
    },

    inspect() {
      return {
        config,
        entries: Array.from(entries.values()).map((e) => ({
          mountPath: e.mountPath, refcount: e.refcount, hasChild: Boolean(e.child),
        })),
      };
    },
  };
}

/**
 * The manager for `host-premounted`: same `acquire`/`release` shape as
 * `createHostMountManager`, but it mounts nothing.
 *
 * THE ONE CHECK THAT MATTERS is that the tree is really mounted. If the
 * systemd unit is not running, `<mountRoot>/<bucket>` still EXISTS — it is an
 * ordinary empty directory — and binding it into a container gives the tenant
 * a workspace that is silently empty rather than an error. Their files are
 * intact on the store; they just cannot see them, and the first thing an agent
 * does with an empty workspace is start recreating it.
 *
 * That is the same shape as two false signals hit while building this:
 * `mountpoint` run as a non-root user against a root-only mount reports "not a
 * mountpoint" (EACCES), and binding a non-mountpoint directory into a
 * container reads as success because an empty directory lists fine. So
 * liveness is checked with `isMountLive` (an `opendir`, which surfaces
 * ENOTCONN on a dead FUSE mount) AND against the mount table — presence in one
 * without the other is exactly the corpse state that hands out ENOTCONN on
 * every subsequent read.
 */
/** The bucket a tenant is mapped to does not exist (never migrated, or deleted). */
function missingTree(treePath) {
  return new SandboxError(
    "workspace_tree_missing",
    `${treePath} does not exist on the store. For a tenant in SANDBOX_ISOLATED_TENANTS that means its bucket was ` +
      `never created (docs/ops/tenant-migration.md). Binding it would make docker CREATE an empty directory and hand ` +
      `the tenant an empty workspace instead of an error, so allocation is refused.`,
    503,
  );
}

export function createPreMountedHostMountManager({
  config = resolveHostMountConfig(),
  probeMounts = defaultProbeMounts,
  isMountLive = defaultIsMountLive,
  // 2026-09-26 (F-GRP): the seams below exist because this process may no
  // longer look inside a tenant's root — see assertTreeLive and fenceTenantRoot.
  statPath = (p) => fsp.stat(p),
  canTraverse = defaultCanTraverse,
  runDocker = defaultRunDocker,
  image = process.env.SANDBOX_DOCKER_IMAGE,
  now = Date.now,
} = {}) {
  /** mountPath → when its workspace fixup last succeeded. See WORKSPACE_PREPARED_TTL_MS. */
  const preparedAt = new Map();

  /**
   * The tree is mounted, the mount answers, and the tree exists.
   *
   * WHERE LIVENESS IS ASKED (2026-09-26, F-GRP). This used to `opendir` the tree
   * itself, `<root>/<bucket>`. Under the root topology that directory is a
   * per-tenant bucket root, and those are fenced `0770 root:<workspace gid>` so
   * no host account can walk in — this process included: it runs as uid 1000 in
   * a `systemctl --user` unit, and a user unit cannot join the group (measured:
   * `systemd-run --user -p SupplementaryGroups=2468 id` exits 216/GROUP). The
   * opendir would be EACCES, read as "mount dead", and every isolated tenant
   * would get a 503. So liveness is asked of the MOUNT that serves the tree —
   * same FUSE server, and `/mnt/ava` itself is 0755 — and existence of the tree
   * with a `stat`, which needs only search permission on the parent.
   */
  async function assertTreeLive(treePath) {
    const mounts = await probeMounts(config.mountRoot);
    const serving = servingMount({ mounts, root: config.mountRoot, treePath });
    if (!serving) {
      throw new SandboxError(
        "workspace_tree_not_mounted",
        `the workspace tree is not mounted at ${treePath}. In host-premounted mode a root-owned unit mounts it ` +
          `(see docs/ops/host-workspace-mount.md); this process mounts nothing. Binding the bare directory would ` +
          `hand the tenant an EMPTY workspace instead of an error, so allocation is refused.`,
        503,
      );
    }
    if (!(await isMountLive(serving))) {
      throw new SandboxError(
        "workspace_tree_mount_dead",
        `${serving} is listed as mounted but does not answer — a FUSE mount whose server died stays in the mount ` +
          `table and returns ENOTCONN on every read. Restart the mount unit.`,
        503,
      );
    }
    // Per-bucket topology: the opendir above was of the tree itself.
    if (serving === path.resolve(treePath)) return;
    let st;
    try {
      st = await statPath(treePath);
    } catch (err) {
      if (err?.code === "ENOENT") throw missingTree(treePath);
      throw new SandboxError(
        "workspace_tree_mount_dead",
        `${treePath} could not be examined (${err?.code ?? err?.message}) although ${serving} answers.`,
        503,
      );
    }
    if (!st?.isDirectory?.()) throw missingTree(treePath);
  }

  /**
   * Fence a per-tenant bucket root before its workspace is used (2026-09-26,
   * F-GRP). A root is born 0777 (`s3.bucket.create`) and some were owned by
   * uid 1000; either way a host account walks in. Once per root: a fenced root
   * costs two syscalls and no container.
   *
   * Only when the bucket holds exactly ONE tenant: a tenant bucket name AND a
   * single-segment subpath (`workspace`, `.snapshots`). tenant-store.mjs warns
   * that a name alone is not proof — a shared bucket could be ws-shaped — and
   * a shared bucket's root must stay as it is.
   *
   * A failure is logged, not thrown: same trade as ensureWorkspaceUsable, and
   * the exposure is exactly what the live isolation check reports.
   */
  // Roots that were fenced and are shut in every respect but their GROUP — see
  // where this is filled. Only that case is remembered: a root that is still
  // reachable, or a fence that failed, is retried on every allocation.
  const gidMismatched = new Set();

  async function fenceTenantRoot(rootPath) {
    const look = async () => {
      const st = await statPath(rootPath);
      const traversable = await canTraverse(rootPath);
      return {
        st,
        fenced: tenantRootFenced({ uid: st.uid, gid: st.gid, mode: st.mode, traversable, workspaceGid: config.workspaceGid }),
        // Root-owned, nothing for other, closed to this process: all but the group.
        allButGroup: st.uid === 0 && (Number(st.mode) & 0o007) === 0 && traversable === false,
      };
    };
    let before;
    try {
      before = await look();
    } catch (err) {
      log("warn", "host_mount.tenant_root_unexamined", { rootPath, code: err?.code, error: err?.message });
      return;
    }
    if (before.fenced === true) return;
    if (before.fenced === null) {
      log("warn", "host_mount.tenant_root_unexamined", { rootPath, note: "could not ask whether this process can enter it" });
      return;
    }
    if (before.allButGroup && gidMismatched.has(rootPath)) return;
    if (!image) {
      log("error", "host_mount.tenant_root_open", { rootPath, reason: "SANDBOX_DOCKER_IMAGE unset — cannot run the fence" });
      return;
    }
    try {
      await runDocker(tenantRootFencePlan({ hostPath: rootPath, image }).args);
      const after = await look();
      if (after.fenced === true) {
        log("info", "host_mount.tenant_root_fenced", { rootPath });
      } else if (after.allButGroup) {
        // `chown 0:0` sets filer gid 0, so the group shown now is how the MOUNT
        // maps filer gid 0 — and it is not the gid this process was configured
        // with: SANDBOX_WORKSPACE_GID here and AVA_WORKSPACE_GID in the mount unit
        // disagree (both default to 2468). Rerunning the fence cannot change the
        // mount, so this is said once per root rather than as a container and an
        // ERROR on every allocation — the same line that must stay meaningful for
        // a root that is really open. Sandboxes also join the wrong group, so
        // S3-written files stay unreadable to them until the two agree.
        gidMismatched.add(rootPath);
        log("error", "host_mount.tenant_root_gid_mismatch", {
          rootPath,
          shownGid: after.st.gid,
          configuredGid: config.workspaceGid,
          note: "root-owned 0770 and closed to this process, but its group is not SANDBOX_WORKSPACE_GID — make it equal the mount's AVA_WORKSPACE_GID (verify-storage shows the mount's -map.gid)",
        });
      } else {
        log("error", "host_mount.tenant_root_open", { rootPath, reason: "still reachable after the fence" });
      }
    } catch (err) {
      log("error", "host_mount.tenant_root_fence_failed", { rootPath, error: String(err?.message ?? err).slice(0, 300) });
    }
  }

  return {
    mode: WORKSPACE_MOUNT_HOST_PREMOUNTED,

    /**
     * Validate the tenant's subpath, check the tree, and hand back the bind
     * source. Nothing is mounted, so nothing is refcounted.
     */
    async acquire({ bucket, subpath }) {
      // The tenant path goes through the guard first, and the TREE path is
      // then derived from the validated result rather than assembled again
      // from the raw bucket. Two independent constructions of the same path is
      // how one of them ends up with a different escape rule; deriving means
      // the bucket segment has already passed the guard.
      const mountPath = hostMountPathFor(config.mountRoot, bucket, subpath);
      const root = config.mountRoot.endsWith("/") ? config.mountRoot.slice(0, -1) : config.mountRoot;
      const treePath = `${root}/${mountPath.slice(root.length + 1).split("/")[0]}`;
      await assertTreeLive(treePath);
      // BEFORE the workspace fixup: that hands `workspace` to uid 1000, which on
      // this host is also the login account — under an open root, a directory
      // that account both owns and can reach.
      if (isTenantBucketName(bucket) && !String(subpath).includes("/")) {
        await fenceTenantRoot(treePath);
      }
      // A tenant directory that does not exist yet, or that exists in the state
      // docker leaves behind (`root:root 0755`), is not writable by the image's
      // uid — so the first thing an agent does with bash in a NEW tenant's
      // sandbox fails with "Permission denied", while its file tools keep
      // working because they go through S3. Measured in production; the
      // reasoning and the container plan are in cube/workspace-dir.mjs.
      //
      // Deliberately here rather than at container start: this process cannot
      // create the directory itself (it is uid 1000 and the tenant parents are
      // root-only by design), and the sandbox image runs as uid 1000 too, so it
      // cannot fix its own workspace either.
      await ensureWorkspaceUsable(mountPath, { stat: statPath, runDocker, image, prepared: preparedAt, now });
      return {
        mountPath,
        // A no-op with a name, rather than an absent method: the caller
        // releases unconditionally, and an undefined `release` would throw in
        // a teardown path that runs after something else has already failed.
        async release() {},
      };
    },

    /**
     * Boot check. This manager owns no mounts, so there is nothing to
     * reconcile — but the boot path calls it, and that is the right moment to
     * say whether the tree is there.
     *
     * Reporting rather than throwing: a runtime that refused to BOOT would
     * also stop serving relay and machine endpoints, which have nothing to do
     * with the workspace tree — the user's own computer needs no mount here.
     * The refusal belongs at cloud allocation, where `acquire` puts it. What
     * this adds is that the operator learns at startup instead of when the
     * first tenant is handed an error.
     */
    async reconcile() {
      const root = config.mountRoot.endsWith("/") ? config.mountRoot.slice(0, -1) : config.mountRoot;
      const mounts = await probeMounts(root).catch(() => new Set());
      const live = [];
      for (const m of mounts) {
        if (await isMountLive(m).catch(() => false)) live.push(m);
      }
      log(live.length ? "info" : "warn", "host_mount.premounted_reconcile", {
        mountRoot: root,
        mounted: [...mounts].length,
        live: live.length,
        note: live.length
          ? "workspace tree(s) present; this process mounts nothing"
          : `no live mount under ${root} — cloud sandbox allocation will be refused until the root-owned mount unit is running`,
      });
      // The same shape as the self-mounting manager's reconcile — server.mjs's boot
      // summary reads these four lists off whichever manager is configured. Returning
      // only `{ reconciled, live }` made that summary throw on every boot since
      // 2026-09-06 and log a false `sandbox.host_mount_reconcile_failed`.
      return { adopted: [], staleUnmounted: [], removedDirs: [], errors: [], reconciled: 0, live: live.length };
    },

    /** Nothing to drain: this manager owns no mounts and no timers. */
    async shutdown() {},
    async drainForTest() {},
  };
}
