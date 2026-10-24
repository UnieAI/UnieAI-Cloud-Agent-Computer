/**
 * cube/docker.mjs — Docker backend orchestrator.
 *
 * Spawns the cm-agent-sandbox image (docker/cm-agent-sandbox/) inside a
 * local Docker daemon. The image's entrypoint reads workspace coordinates
 * from envVars (WORKSPACE_BUCKET, WORKSPACE_PATH, S3_ENDPOINT, ...) and
 * weed-mounts SeaweedFS over /workspace at boot — the host is *not*
 * expected to bind-mount anything (per audit #60 workaround #4).
 *
 * Selection:
 *   SANDBOX_MODE=docker → this backend (default)
 *   SANDBOX_MODE=cube   → cube/client.mjs (production CubeMaster cluster)
 *
 * Self-host / dev / staging use case (10-20 users, single Linux box). Mac
 * dev typically uses stub because Docker-on-Mac doesn't expose /dev/fuse
 * in a useful way, but smoke-tests in Phase F can still drive it.
 *
 * Contract: see cube/CONTRACT.md. Mirrors the shape of stub.mjs and
 * client.mjs so pool/manager.mjs and exec/runner.mjs stay backend-agnostic.
 *
 * Implementation note: we shell out to `docker` CLI rather than depend on
 * `dockerode` because the dependency tree of the broader runtime is
 * deliberately minimal and Docker CLI subprocess is well-understood across
 * Mac / Linux dev setups. If/when the runtime acquires `dockerode` for
 * another reason, this file is a single-source swap.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { SandboxError } from "../shared/error.mjs";
import { resolveDiskLimits, fsizeLimitBytes as fsizeBytes } from "../pool/disk-guard.mjs";
import { log } from "../shared/log.mjs";
import { config, sanitizeDockerRuntime } from "../config.mjs";
import { applyS3CredentialPolicy, isS3CredentialOmitMode } from "./s3-credentials.mjs";
import { legacyPrefix, resolveTenantStore } from "../workspace/tenant-store.mjs";
import {
  WORKSPACE_MOUNT_HOST,
  WORKSPACE_MOUNT_HOST_PREMOUNTED,
  HOST_MOUNT_DRIVER_S3,
  resolveWorkspaceMountMode,
} from "./host-mount.mjs";
import { resolveWorkspaceGid } from "./workspace-group.mjs";
import { officialHomeMount } from "./official-home.mjs";
import { openDockerTerminal } from "./docker-pty.mjs";
import { officialAuthIntent } from "../../../../packages/ava-local-protocol/src/official-auth.mjs";

// Default image tag — overridable for testing alternate builds. Image is
// expected to follow the contract baked in docker/cm-agent-sandbox/Dockerfile
// (entrypoint.sh weed-mounts /workspace before exec'ing the agent process).
const DEFAULT_DOCKER_IMAGE = "cm-agent-sandbox:weed-mount";

// Small env parser (config.mjs has its own; docker.mjs reads a couple of knobs
// directly to stay self-contained like the image/network defaults below).
function parseIntEnv(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
// Same, but keeps the fraction: `--cpus` is a fractional core count (0.5, 1.5).
function parseFloatEnv(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve ONE resource-quota field: what the caller asked for, else the
 * deployment default, else uncapped.
 *
 * Exists because `requested ?? deploymentDefault` was wrong in a way that
 * removed the cap rather than tightening it. `??` only catches null/undefined,
 * so `{ cpus: 0, memMb: 0, pids: 0 }` in an allocate body passed straight
 * through and then evaporated at the `if (memoryMb)` guard downstream — a
 * request could switch its own container's ceiling off, which is the exact
 * outcome the ceiling exists to prevent. Non-numbers were worse: `--cpus lots`
 * is not a cap, it is a container that never starts.
 *
 * So a REQUEST only ever supplies a usable positive number; anything else means
 * "didn't say" and falls back. Zero keeps its meaning for the OPERATOR only
 * (SANDBOX_DEFAULT_*=0 → deliberately unlimited), because that is a deployment
 * decision made once, not a per-call one.
 *
 * Raising IS allowed: a legitimate heavy job must be able to ask for more, or
 * whoever is on call at 3am deletes the whole mechanism instead of tuning it.
 * A raise is logged so it stays visible rather than silent.
 */
export function resolveQuotaField(name, requested, deploymentDefault) {
  const asked = Number(requested);
  if (Number.isFinite(asked) && asked > 0) {
    if (deploymentDefault > 0 && asked > deploymentDefault) {
      log("info", "docker.quota_raised", {
        field: name, requested: asked, deploymentDefault,
        note: "caller asked for more than the deployment default — honoured, and logged so a heavy job is visible rather than silent",
      });
    }
    return asked;
  }
  if (requested !== undefined && requested !== null) {
    log("warn", "docker.quota_field_ignored", {
      field: name, requested, deploymentDefault,
      note: "a resource_quota field must be a positive number; falling back to the deployment default rather than running uncapped",
    });
  }
  return deploymentDefault > 0 ? deploymentDefault : undefined;
}
// Max wait for the in-guest weed-mount of /workspace before an exec is allowed.
// Slightly above the entrypoint's own 30s weed-mount readiness deadline.
const WORKSPACE_READY_TIMEOUT_MS = 40_000;

// `docker run` flags that every cm-agent-sandbox container requires:
//   --cap-add SYS_ADMIN   FUSE mount needs CAP_SYS_ADMIN
//   --device /dev/fuse    expose fuse device to the container
//   --security-opt apparmor:unconfined  some hosts ship apparmor that
//                                       blocks FUSE in containers
//   --shm-size 512m       Phase 5v — chromium (browser-harness) needs
//                                       a sizeable /dev/shm; Docker's
//                                       default 64m causes "Target
//                                       page, context or browser has
//                                       been closed" errors on
//                                       moderately heavy pages. 512m
//                                       matches the Playwright recipe.
// These are NOT controllable per-caller — they're a property of "this
// image needs to weed-mount + run chromium". Caller-controllable knobs
// (cpus / memory / network) flow through opts.
const FUSE_DOCKER_FLAGS = [
  "--cap-add", "SYS_ADMIN",
  "--device", "/dev/fuse",
  "--security-opt", "apparmor:unconfined",
  "--shm-size", "512m",
];

// Everything in FUSE_DOCKER_FLAGS except the three grants that exist only so
// the guest can mount its own workspace. Used when the host mounts instead.
const NON_FUSE_DOCKER_FLAGS = ["--shm-size", "512m"];

// ---- container hardening ----
//
// All four knobs below were sized against MEASUREMENTS taken on the live host
// on 2026-09-05 (docker 29.1.3, containerd `overlayfs` snapshotter, data root
// on ext4) using the real cm-agent-sandbox:weed-mount image. Two of those
// measurements overturned the obvious choice, so they are recorded here:
//
//   (1) The image is `USER user` (uid 1000) and `capsh --print` inside it
//       reports `Current: =` — the agent process holds NO effective
//       capabilities at all. The FUSE mount does NOT come from --cap-add
//       reaching the process; it comes from setuid-root /usr/bin/fusermount
//       raising to euid 0 and then drawing CAP_SYS_ADMIN from the BOUNDING
//       set. So the only thing a capability change can affect in this image is
//       its setuid binaries (fusermount, mount, umount, su, passwd, chsh,
//       newgrp, gpasswd, ssh-keysign — there is no sudo).
//
//   (2) Consequently `--security-opt no-new-privileges` BREAKS EVERY SANDBOX.
//       no_new_privs disables setuid escalation, fusermount stays uid 1000 and
//       dies with "mount failed: Operation not permitted", /workspace never
//       mounts and createSandbox times out. Verified directly against the real
//       image and the live filer. It is therefore available but DEFAULT-OFF —
//       the one knob here that is opt-in, because switching it on is an
//       outage, not a hardening. Revisit only if the image stops needing an
//       in-guest FUSE mount (e.g. the workspace is bind-mounted or proxied).
//
// `--cap-drop ALL` combined with the existing `--cap-add SYS_ADMIN` WAS
// verified working: the real image mounted /workspace in 200ms. Dropping ALL
// *without* re-adding SYS_ADMIN fails the same way as (2). That pairing is the
// empirically-established minimum, not a guess.

// Docker storage drivers on which `--storage-opt size=` is actually ENFORCED.
//
// MEASURED: this host reports driver `overlayfs` (the containerd snapshotter)
// with the data root on ext4. `docker run --storage-opt size=16M` exits 0 and
// the value is faithfully recorded in HostConfig.StorageOpt — but a container
// then wrote a 64MB file into its rootfs without error and `df /` reported the
// full 990G host filesystem. The flag is ACCEPTED AND SILENTLY IGNORED here.
// That is the dangerous case: it does not break `docker run` (so nothing
// alerts) while producing a disk cap that caps nothing. We therefore probe the
// driver and only emit the flag where it bites.
//
// `overlay2` is deliberately NOT in this list: it enforces a quota only when
// the backing filesystem is xfs mounted with `pquota`, which cannot be
// established from the driver name alone. Listing it would reintroduce exactly
// the silent-no-op above. An operator on xfs+pquota can still force the flag on
// via SANDBOX_STORAGE_QUOTA_FORCE=1.
const STORAGE_QUOTA_DRIVERS = new Set(["btrfs", "zfs", "devicemapper", "windowsfilter"]);

/** True when `--storage-opt size=` is enforced (not merely accepted) by `driver`. */
export function storageQuotaSupported(driver) {
  return STORAGE_QUOTA_DRIVERS.has(String(driver || "").trim().toLowerCase());
}

// ---- network policy ----
//
// `networkPolicy` was DECLARED AND NEVER READ on this backend. VERIFIED before
// this change: createSandbox destructured it and copied it into `meta`, and
// `args.push` never saw it — the only network flag in the argv builder was
// `if (network) args.push("--network", network)` fed from
// SANDBOX_DOCKER_NETWORK. So a caller asking for `egress_deny` got a container
// with full access to the shared bridge (postgres, valkey, the engine, the
// seaweedfs master/filer/volume) plus a metadata field claiming otherwise,
// while the cube backend honoured the very same field (client.mjs:151).
//
// lib/agent-code/permission-gate.ts carries the rule, written after the 唯讀
// incident where a permission mode the adapter dropped let `rm` run anyway:
// "A control that cannot be enforced should not be offered", and "a mode we
// cannot enforce must not be silently downgraded to one that runs."
//
// Which is why enforcement here has two halves. `egress_deny` maps to
// `--network none`, and in the in-guest mount mode — where the sandbox MUST
// reach the filer to mount /workspace at all, so `--network none` would mean
// no sandbox ever boots — the request is REFUSED rather than ignored.

export const NETWORK_POLICY_DENY = "egress_deny";

/** `egress_deny` | `egress_allow` | null (caller said nothing). */
export function normalizeNetworkPolicy(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "egress_deny") return "egress_deny";
  if (raw === "egress_allow") return "egress_allow";
  // An unrecognised policy is not "allow". Same direction as the gate above:
  // refuse rather than quietly pick the permissive reading.
  throw new SandboxError(
    "bad_request",
    `network_policy ${JSON.stringify(value)} is not recognised (egress_deny | egress_allow)`,
    400,
  );
}

// ---- host-mount boot command ----

/**
 * In host-mount mode the image's own entrypoint must NOT run: its first act is
 * `weed mount`, which is exactly the filer dependency we are removing. This
 * replaces it with the one non-mounting thing that entrypoint also did and that
 * the agent depends on — the `__personal__` anchor symlink, which makes the
 * engine's host-anchored paths and the sandbox's /workspace resolve to the same
 * tree (without it, agent-generated `cp /tmp/agent-fs/<uid>/__personal__/...`
 * commands fail with "No such file or directory").
 *
 * NOT replicated, and this is a real gap of host-mount mode rather than an
 * oversight: the `.opencode` read-only sub-mount and the durable `/snapshots`
 * mount are themselves weed mounts. `/snapshots` is covered by a second host
 * mount (see createSandbox); the `.opencode` bash-level write protection is
 * not, so in host mode the file-API delete guard (isSystemDeleteProtected) is
 * the only layer protecting the skill library. Recorded in
 * docs/ops/host-workspace-mount.md.
 */
export const HOST_MOUNT_ENTRYPOINT = "/bin/sh";
export const HOST_MOUNT_BOOT_COMMAND = [
  "-c",
  [
    "set -u",
    'case "${WORKSPACE_PATH:-}" in',
    "  users/*/workspace)",
    '    _u="${WORKSPACE_PATH#users/}"; _u="${_u%/workspace}";',
    '    _a="${AGENT_FS_MOUNT_ROOT:-/tmp/agent-fs}/${_u}";',
    '    mkdir -p "$_a" 2>/dev/null && ln -sfn /workspace "$_a/__personal__" 2>/dev/null || true;',
    "    ;;",
    "esac",
    "exec sleep infinity",
  ].join("\n"),
];

// ---- workspaceMountPath parsing ----

/**
 * Split a SeaweedFS-backed mount path into (bucket, subpath) for the image
 * entrypoint to consume as WORKSPACE_BUCKET / WORKSPACE_PATH.
 *
 * Expected shape: `/mnt/<bucket>/<rest...>` (the host mount convention of
 * the former runtime/packages/agent-fs). Anything else fails clear
 * — we don't synthesize a fake bucket from a tmpdir.
 */
export function parseWorkspaceMountPath(mountPath) {
  if (typeof mountPath !== "string" || mountPath.length === 0) {
    throw new SandboxError(
      "bad_request",
      "workspaceMountPath is required for SANDBOX_MODE=docker",
      400,
    );
  }
  // /mnt/agent-fs/u-alice/p-myproject → bucket="agent-fs", subpath="u-alice/p-myproject"
  const match = mountPath.match(/^\/mnt\/([^/]+)\/(.+?)\/?$/);
  if (!match) {
    throw new SandboxError(
      "bad_request",
      `workspaceMountPath unrecognized (expected /mnt/<bucket>/<path>): ${mountPath}`,
      400,
    );
  }
  return { bucket: match[1], subpath: match[2] };
}

// Owner → the LEGACY S3 key prefix, delegated to the one resolver that owns
// this rule (workspace/tenant-store.mjs).
//
// This used to be a hand-copy of `userStore.mjs::userPrefix`, kept in step by
// the comment above it saying they must agree. They did agree on the legacy
// layout and diverged the moment per-tenant buckets arrived: this copy never
// consulted `isolatedOwners`, so the FIRST tenant migrated to its own bucket
// would have had its sandbox mounted from the bucket the migration had just
// moved it off — an empty workspace, with the real one intact and unreachable.
// Nothing would have failed; the tenant would simply have lost their files.
//
// Kept as a named export because callers and tests use it, and kept LEGACY-only
// because that is what its name promises. Isolation-aware resolution is
// `resolveWorkspaceLocation` below, which asks `resolveTenantStore` for both
// halves at once — a prefix without its bucket is half an answer, and this
// function has no way to return the other half.
export function ownerToPrefix(owner) {
  const s = String(owner || "");
  return s ? legacyPrefix(s) : "";
}

// Resolve WHERE a sandbox's /workspace lives in S3. Prefer an explicit
// /mnt/<bucket>/<path> mount path (legacy / cube wiring); otherwise derive it
// from the per-user workspace OWNER. The agent-next engine's allocate sends
// `workspace_owner` (user:<id>) + `workspace_mode: "user"` and NO mount path, so
// owner-derivation is the normal path here. Bucket and prefix BOTH come from
// `resolveTenantStore`, the same resolver the runtime's workspace store uses, so
// the weed-mounted /workspace and the S3 layout agree — instant mount, no
// hydrate — and an isolated tenant lands in its own bucket rather than being
// mounted from the one it was migrated off.
export function resolveWorkspaceLocation({ workspaceMountPath, workspaceMode, workspaceOwner } = {}) {
  if (typeof workspaceMountPath === "string" && workspaceMountPath) {
    return parseWorkspaceMountPath(workspaceMountPath);
  }
  if (workspaceMode === "user" && workspaceOwner) {
    // ONE RESOLVER FOR BOTH HALVES. This block used to compute the bucket as
    // `WEED_S3_BUCKET || S3_BUCKET` and the prefix from a local copy of the
    // legacy rule, while the app's file panel asked `storage-engine` (S3_BUCKET
    // only). With both variables set to different values — which is exactly how
    // this deployment was configured — the sandbox mounted one bucket and the
    // panel read another, so anything written through the mount was invisible
    // forever and, worse, an empty `.snapshots` git skeleton created under the
    // mount SHADOWED a tenant's real history at the identical prefix in the
    // other bucket. Measured 2026-09-07: one tenant's 692 objects (166 files +
    // 526 snapshots) were hidden behind 22 empty ones.
    //
    // The comment this block used to carry — "the same bucket the runtime's
    // workspace store uses" — was the correct intent all along; the code simply
    // did not do it. `WEED_S3_BUCKET` belongs to the `agent-fs` package (whose
    // own manager defaults to it independently) and was picked up here by
    // accident. It is deliberately NOT read any more.
    const { bucket, prefix } = resolveTenantStore(workspaceOwner, {});
    if (!bucket || !prefix) {
      throw new SandboxError(
        "bad_request",
        `cannot derive workspace location (S3_BUCKET unset or bad owner "${workspaceOwner}")`,
        400,
      );
    }
    return { bucket, subpath: prefix };
  }
  // No mount path and not user-mode → let parseWorkspaceMountPath throw a clear
  // "required" error so a misconfigured ephemeral docker alloc fails loudly.
  return parseWorkspaceMountPath(workspaceMountPath);
}

// ---- docker CLI helpers ----

/**
 * Run an arbitrary `docker` CLI invocation and capture stdout. Throws
 * SandboxError on non-zero exit with stderr in details. Used for short,
 * synchronous control-plane ops (run -d, kill, rm, exec for one-shot).
 */
function dockerCmd(args, { stdin = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timer = null;
    let settled = false;

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => settle(() => reject(
      new SandboxError("docker_cli_error", `docker CLI not invokable: ${err?.message}`, 500),
    )));
    child.on("close", (code) => settle(() => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new SandboxError(
          "docker_cli_failed",
          `docker ${args.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`,
          500,
          { code, stderr: stderr.trim(), stdout: stdout.trim() },
        ));
      }
    }));

    if (stdin != null) {
      try { child.stdin.end(stdin); } catch { /* ignore */ }
    } else {
      try { child.stdin.end(); } catch { /* ignore */ }
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        settle(() => reject(new SandboxError(
          "docker_cli_timeout",
          `docker ${args[0]} timed out after ${timeoutMs}ms`,
          500,
        )));
      }, timeoutMs).unref();
    }
  });
}

/**
 * Build the `docker run` argv for a fresh cm-agent-sandbox container.
 * Exposed (not just an inline helper) so tests can assert on the exact
 * shape without needing a live Docker daemon.
 */
export function buildDockerRunArgs({
  image,
  env,
  network,
  networkPolicy,
  cpus,
  memoryMb,
  memorySwapMb,
  name,
  labels = {},
  extraArgs = [],
  pidsLimit,
  fsizeLimitBytes = 0,
  capDropAll = false,
  noNewPrivileges = false,
  storageSizeGb,
  // Host-mount mode: bind mounts to attach, and the entrypoint/command that
  // replace the image's mounting entrypoint. Absent → unchanged behaviour.
  binds = [],
  entrypoint = null,
  command = [],
  // The guest only needs FUSE when it mounts its own workspace.
  fuseFlags = true,
  // 空字串（預設）＝ 不下 --runtime。見 config.mjs 的 dockerRuntime。
  runtime = "",
  // 額外加入的群組（數字 gid）。host 掛載模式下是工作區群組，見 workspace-group.mjs。
  groupAdd = [],
}) {
  const args = [
    "run", "-d", "--rm",
    // Ownership labels: sandboxes are --rm and the pool's session→sandbox map
    // is in-process memory, so after a sandbox-runtime restart running
    // containers become invisible orphans. Labels make them findable — the
    // boot-time reaper (reapOrphanContainers) and any external tooling filter
    // on unieai.sandbox=1 instead of guessing by name.
    "--label", "unieai.sandbox=1",
    // Cap this container's own log growth, independent of the daemon-wide
    // default (which only applies to containers created after a daemon
    // restart). Sandboxes are --rm so logs die on exit, but a long agent
    // session must not be able to fill the host disk via stdout/stderr spam.
    "--log-opt", "max-size=10m",
    "--log-opt", "max-file=3",
  ];
  // 為什麼在這裡再驗一次，而不是信任 config 已經驗過：這個函式是 argv 唯一的
  // 出口，也是測試唯一盯得到的地方。把守門放在出口上，任何新的呼叫路徑（測試
  // 注入、未來的 per-sandbox 覆寫）都自動受同一條規則保護，不會因為繞過 config
  // 就把原始字串接進命令列。
  const dockerRuntime = sanitizeDockerRuntime(runtime);
  if (dockerRuntime) args.push(`--runtime=${dockerRuntime}`);
  if (name) args.push("--name", name);
  for (const [k, v] of Object.entries(labels)) {
    if (v != null && v !== "") args.push("--label", `unieai.${k}=${String(v)}`);
  }
  // --cap-drop must precede the FUSE --cap-add so the argv reads drop-then-add
  // (docker applies drops before adds regardless of order, but a reader should
  // not have to know that). SYS_ADMIN is re-added by FUSE_DOCKER_FLAGS below and
  // is load-bearing — see the hardening notes above.
  if (capDropAll) args.push("--cap-drop", "ALL");
  // In host-mount mode the workspace arrives as a bind mount, so SYS_ADMIN,
  // /dev/fuse and the apparmor escape have no remaining purpose. /dev/shm still
  // does — chromium needs it whoever mounted the workspace.
  args.push(...(fuseFlags ? FUSE_DOCKER_FLAGS : NON_FUSE_DOCKER_FLAGS));
  // DEFAULT-OFF: proven to break the in-guest FUSE mount on this image. See (2).
  if (noNewPrivileges) args.push("--security-opt", "no-new-privileges");
  // Fork-bomb ceiling. The image ships no ulimit for this, so before now a
  // single `:(){ :|:& };:` in an agent bash call could exhaust host PIDs for
  // every co-located stack on the box, not just its own sandbox.
  if (pidsLimit) args.push("--pids-limit", String(pidsLimit));
  // 單一檔案的上限，核心強制。這是磁碟這一面**唯一**真的生效的硬上限 ——
  // `--storage-opt size=` 在這台主機的 driver 上量過是無效的（見
  // storageQuotaSupported），所以在此之前一個 `dd if=/dev/zero of=big` 就能把
  // 共用主機填滿，而這台上面還跑著別的產品。見 pool/disk-guard.mjs 的檔頭。
  //
  // 0 代表不設限，所以**不送那面旗標**：`--ulimit fsize=0` 是「一個位元組都
  // 不能寫」，跟「不限制」剛好相反。
  if (fsizeLimitBytes > 0) args.push("--ulimit", `fsize=${fsizeLimitBytes}`);
  // Only reached when the caller has confirmed the daemon's driver enforces it.
  if (storageSizeGb) args.push("--storage-opt", `size=${storageSizeGb}G`);
  // `egress_deny` wins over the deployment network — the whole point of the
  // policy is that this container reaches nothing. Callers who say nothing keep
  // the configured network exactly as before.
  if (normalizeNetworkPolicy(networkPolicy) === NETWORK_POLICY_DENY) {
    args.push("--network", "none");
  } else if (network) {
    args.push("--network", network);
  }
  // 2026-09-26 UAT B1-D1：S3 寫的檔在 filer 上是 gid 0、0660，主機掛載把它顯示成
  // 工作區群組。沙盒要**以群組**讀寫它們，所以容器加入那個 gid —— 用數字，映像裡
  // 不需要有這個群組。docker exec（bash 工具、終端機、快照）沿用容器的附加群組。
  for (const gid of groupAdd) args.push("--group-add", String(gid));
  for (const bind of binds) args.push("-v", bind);
  if (entrypoint) args.push("--entrypoint", entrypoint);
  if (cpus) args.push("--cpus", String(cpus));
  if (memoryMb) {
    args.push("--memory", `${memoryMb}m`);
    // --memory-swap caps total (RAM + swap) the container may use. Pin it to the
    // RAM limit by default so a runaway sandbox OOM-kills ITSELF instead of
    // spilling into HOST swap — docker's default of 2×memory lets one heavy
    // session thrash a swap-pressured, prod-shared box. Operators can allow some
    // swap headroom via SANDBOX_DEFAULT_MEMORY_SWAP_MB (must be ≥ memory).
    const swap = Number.isFinite(memorySwapMb) && memorySwapMb >= memoryMb
      ? memorySwapMb
      : memoryMb;
    args.push("--memory-swap", `${swap}m`);
  }
  for (const [key, value] of Object.entries(env || {})) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(...extraArgs);
  args.push(image);
  args.push(...command);
  return args;
}

// The object-store credential policy — which env vars carry the credential,
// what "omit" means, and why it is the fix — now lives in ./s3-credentials.mjs
// so the CubeMaster backend (client.mjs) enforces the SAME rule from the SAME
// code rather than a second copy that can drift. Read that file for the
// measurements behind it.


/**
 * Compose the env block passed to `docker run -e ...`.
 * Exported so tests can assert the credential policy without spawning Docker.
 */
export function buildContainerEnv({
  callerEnv,
  bucket,
  subpath,
  s3CredentialMode = process.env.SANDBOX_S3_CREDENTIALS ?? "inject",
  s3Endpoint = process.env.WEED_S3_ENDPOINT ?? "http://host.docker.internal:8333",
  s3AccessKey = process.env.WEED_S3_ACCESS_KEY ?? "",
  s3SecretKey = process.env.WEED_S3_SECRET_KEY ?? "",
}) {
  const env = {
    ...(callerEnv || {}),
    WORKSPACE_BUCKET: bucket,
    WORKSPACE_PATH: subpath,
    S3_ENDPOINT: s3Endpoint,
    // NOTE: S3_ACCESS_KEY / S3_SECRET_KEY are deliberately NOT set here. They
    // are applied at the bottom of this function by `applyS3CredentialPolicy`,
    // which is the one place that can also OMIT them — setting them in this
    // literal would put the shared Admin credential back into every sandbox in
    // omit mode, which is the exposure ./s3-credentials.mjs exists to close.
    // 代理人的技能／記憶庫已經搬離工作區（見 userStore.mjs 的 .platform 前綴），
    // /workspace/.opencode 底下已經沒有東西需要「唯讀保護」。留著保護反而更糟：
    // entrypoint 的 `mkdir -p /workspace/.opencode` 會把這次搬移要消滅的目錄
    // 再造一次，模型就會繼續把一個空的 .opencode/ 當成使用者的檔案回報。
    // 刻意在這裡設值而不是只改 entrypoint.sh：這個值送得進「已經建好的」
    // sandbox image，所以不必等 image 重建，工作區就會立刻乾淨。
    SANDBOX_PROTECT_SYSTEM_DIRS: process.env.SANDBOX_PROTECT_SYSTEM_DIRS ?? "0",
  };
  // callerEnv is spread above, so the policy is applied to the MERGED block —
  // in omit mode it strips rather than merely skips, otherwise a caller could
  // reintroduce the credential we just decided to withhold.
  return applyS3CredentialPolicy(env, {
    mode: s3CredentialMode,
    accessKey: s3AccessKey,
    secretKey: s3SecretKey,
  });
}

/**
 * Add `safe.directory=*` to a container env through git's environment config
 * (GIT_CONFIG_COUNT/KEY_n/VALUE_n), after whatever entries the caller set.
 *
 * Needed for an S3-driver mount (rclone): every file shows as uid 0 there, the
 * agent runs as uid 1000, and git refuses every repository with "detected
 * dubious ownership" — measured, `git commit` exits 128. Mapping the uid
 * instead would make a host account the owner of tenant files (see
 * buildHostWeedMountArgs). Environment config counts as command-line scope,
 * which git honours for safe.directory; measured on the sandbox image's git
 * 2.39.5 with `*` (the `/path/*` form needs a newer git, so it is not used).
 * `*` gives nothing away inside a sandbox: every repository in it is the
 * tenant's own, which is the only thing safe.directory protects against.
 */
export function withGitSafeDirectory(env) {
  const raw = env?.GIT_CONFIG_COUNT;
  const n = /^[0-9]+$/.test(String(raw ?? "")) ? Number(raw) : 0;
  return { ...env, GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: "safe.directory", [`GIT_CONFIG_VALUE_${n}`]: "*" };
}

/**
 * Boot-time orphan reap: kill any sandbox container left over from a previous
 * sandbox-runtime process. The pool's session→sandbox map is in-process only,
 * so containers surviving a runtime restart are unreachable (no route can ever
 * address them again) yet keep consuming RAM on the shared host. State loss is
 * safe: the workspace is durable in S3 (live weed-mount) and the next allocate
 * simply opens a fresh container. Best-effort — a reap failure must never block
 * boot; unlabeled pre-upgrade containers are skipped (they drain via their own
 * TTL/exit).
 */
export async function reapOrphanContainers({ dockerRunner = dockerCmd } = {}) {
  let ids = [];
  try {
    const out = await dockerRunner(["ps", "-q", "--filter", "label=unieai.sandbox=1"]);
    ids = String(out || "").split("\n").map((x) => x.trim()).filter(Boolean);
  } catch (err) {
    log("warn", "docker.orphan_scan_failed", { error: err?.message });
    return { reaped: 0 };
  }
  if (ids.length === 0) return { reaped: 0 };
  let reaped = 0;
  for (const id of ids) {
    try {
      await dockerRunner(["rm", "-f", id], { timeoutMs: 20_000 });
      reaped += 1;
    } catch (err) {
      log("warn", "docker.orphan_reap_failed", { containerId: id, error: err?.message });
    }
  }
  log("info", "docker.orphans_reaped", { found: ids.length, reaped });
  return { reaped };
}

// ---- backend implementation ----

export function createDockerClient({
  image = process.env.SANDBOX_DOCKER_IMAGE ?? DEFAULT_DOCKER_IMAGE,
  network = process.env.SANDBOX_DOCKER_NETWORK ?? undefined,
  // 用哪一個 docker runtime（runsc / kata-runtime / …）。空字串＝維持現狀，
  // 不在指令上多加任何東西。沒有「失敗就退回預設 runtime」的補救路徑：runtime
  // 不存在時 docker run 直接失敗、沙盒開不起來，而那正是該發生的事。
  dockerRuntime = config.dockerRuntime,
  // Default per-sandbox resource caps applied when the caller's allocate
  // request omits resource_quota (the common case — the engine usually does).
  // SAFE-BY-DEFAULT: 2048MB RAM with swap pinned to RAM (zero swap) — the cap
  // previously existed only as a compose env, so any deploy that forgot to set
  // SANDBOX_DEFAULT_MEMORY_MB ran every sandbox UNCAPPED and a single runaway
  // could OOM the whole host (incl. co-located stacks on a shared box). Set the
  // env to 0 explicitly to opt back into unlimited.
  defaultMemoryMb = parseIntEnv(process.env.SANDBOX_DEFAULT_MEMORY_MB, 2048),
  defaultMemorySwapMb = parseIntEnv(
    process.env.SANDBOX_DEFAULT_MEMORY_SWAP_MB,
    parseIntEnv(process.env.SANDBOX_DEFAULT_MEMORY_MB, 2048),
  ),
  // SAFE-BY-DEFAULT, and it was the ONE knob here that wasn't: this read
  // `process.env.SANDBOX_DEFAULT_CPUS ?? ""`, so an unset env meant no --cpus
  // at all and one tenant's build could take every core on a box that is also
  // running production. (It also emitted a literal `--cpus 0` when the env was
  // "0", because "0" is a truthy string — an accidental flag, not an intent.)
  // 2 cores matches the deployed compose default and .env.example, is a quarter
  // of this 8-core host, and still lets a `npm ci` or a test run finish at a
  // sane speed. Set SANDBOX_DEFAULT_CPUS=0 to opt back into unlimited.
  defaultCpus = parseFloatEnv(process.env.SANDBOX_DEFAULT_CPUS, 2),
  // SAFE-BY-DEFAULT, same reasoning as defaultMemoryMb above: an unset env must
  // not mean "unlimited". A sandbox has no legitimate need for hundreds of
  // processes, and PidsLimit was measured as unset (<nil>) on this host, so a
  // fork bomb in one agent's bash tool could take down every co-located stack.
  // 512 is ~50x a busy agent session (node + weed + a build) and still a hard
  // ceiling. Set SANDBOX_DEFAULT_PIDS_LIMIT=0 to opt back into unlimited.
  defaultPidsLimit = parseIntEnv(process.env.SANDBOX_DEFAULT_PIDS_LIMIT, 512),
  // SAFE-BY-DEFAULT: verified against the real image (mounts in 200ms with
  // --cap-drop ALL --cap-add SYS_ADMIN). Set SANDBOX_CAP_DROP_ALL=0 to disable.
  capDropAll = process.env.SANDBOX_CAP_DROP_ALL !== "0",
  // OPT-IN ONLY — the sole exception to safe-by-default in this constructor,
  // because enabling it is an outage: it disables setuid escalation and the
  // uid-1000 sandbox reaches CAP_SYS_ADMIN for its FUSE mount ONLY through
  // setuid-root fusermount. Measured: /workspace never mounts. See note (2).
  noNewPrivileges = process.env.SANDBOX_NO_NEW_PRIVILEGES === "1",
  // Rootfs (scratch) ceiling in GB. NOTE this bounds only the container's own
  // writable layer — /workspace is a FUSE mount and is NOT covered. Emitted
  // only when the daemon's storage driver actually enforces it (see
  // storageQuotaSupported); on this host it is probed and skipped.
  // SANDBOX_DEFAULT_STORAGE_SIZE_GB=0 disables it entirely.
  defaultStorageSizeGb = parseIntEnv(process.env.SANDBOX_DEFAULT_STORAGE_SIZE_GB, 20),
  // Escape hatch for operators who KNOW their overlay2 is on xfs+pquota, which
  // the driver name alone cannot tell us.
  storageQuotaForce = process.env.SANDBOX_STORAGE_QUOTA_FORCE === "1",
  // 單檔上限（bytes）。磁碟這一面唯一真的生效的硬上限 —— `--storage-opt size=`
  // 在這台主機的 driver 上量過是無效的，所以它是 fail-open 的那一半，而這一個
  // 不依賴任何探測。見 pool/disk-guard.mjs 的檔頭。
  defaultFsizeBytes = fsizeBytes(resolveDiskLimits(process.env).fsizeGb),
  // WHERE /workspace is mounted. "in-guest" (the DEFAULT, and today's live
  // behaviour) = the image entrypoint weed-mounts it, which forces every
  // sandbox to hold a route to an anonymous filer. "host" = sandbox-runtime
  // mounts it on the host and the container gets a bind mount, which is what
  // lets the container lose CAP_SYS_ADMIN, /dev/fuse and — the point — its
  // route to the filer. Opt in with SANDBOX_WORKSPACE_MOUNT=host.
  workspaceMountMode = resolveWorkspaceMountMode(process.env),
  // The host-side mount manager (cube/host-mount.mjs). Injected rather than
  // constructed here so the argv tests need no weed binary and no filer.
  hostMount = null,
  // The group the host mount shows S3-written files to (filer gid 0 → this gid).
  // Joined by every host-mounted sandbox; see cube/workspace-group.mjs for why a
  // GROUP and never a uid (2026-09-26, UAT B1-D1 and the reverted uid map).
  workspaceGid = resolveWorkspaceGid(process.env),
  // Test seam — override the CLI runner to avoid spawning real Docker.
  dockerRunner = dockerCmd,
} = {}) {
  // BOTH host modes mean "the mount is not in the guest": `host` has this
  // process mount per sandbox, `host-premounted` binds subpaths of a tree a
  // root-owned unit already mounted. Everything downstream — no filer route
  // needed, no S3 credential in the guest, no-new-privileges safe, egress_deny
  // enforceable — follows from the mount being outside the guest, not from
  // which of the two put it there.
  const hostMountMode =
    workspaceMountMode === WORKSPACE_MOUNT_HOST || workspaceMountMode === WORKSPACE_MOUNT_HOST_PREMOUNTED;
  if (hostMountMode && !hostMount) {
    // Fail at construction, not at the first allocate: a deployment that asked
    // for host mounts and did not get a manager would otherwise fall back to
    // the in-guest path and quietly keep the filer route it thought it removed.
    throw new SandboxError(
      "config_error",
      `SANDBOX_WORKSPACE_MOUNT=${workspaceMountMode} requires a host mount manager `
        + `(createHostMountManager, or createPreMountedHostMountManager for host-premounted)`,
      500,
    );
  }
  // With the mount out of the guest there is no setuid fusermount left to
  // preserve, so the flag that BREAKS every in-guest sandbox becomes the safe
  // default here. SANDBOX_NO_NEW_PRIVILEGES=0 still forces it off.
  const effectiveNoNewPrivileges = hostMountMode
    ? process.env.SANDBOX_NO_NEW_PRIVILEGES !== "0"
    : noNewPrivileges;
  // Only the host modes: the in-guest entrypoint mounts inside the container and
  // maps its own ids there, so a host gid means nothing to it.
  const groupAdd = hostMountMode && workspaceGid ? [workspaceGid] : [];
  if (hostMountMode && !workspaceGid) {
    log("warn", "docker.workspace_group_disabled", {
      note: "no workspace gid — sandboxes join no group, so files written through S3 (uploads, the agent's write/edit) stay root 0660 and unreadable to the sandbox's shell. See cube/workspace-group.mjs",
    });
  }

  // sandboxId -> { containerId, meta, createdAt }
  const sandboxes = new Map();

  // Memoized one-shot probe of the daemon's storage driver. Cached because it
  // cannot change under a running daemon and createSandbox is on the hot path.
  // Fails CLOSED on the flag (skip the quota) and OPEN on the sandbox (still
  // create it) — a hardening flag must never be the reason a sandbox won't boot.
  if (isS3CredentialOmitMode(process.env.SANDBOX_S3_CREDENTIALS)) {
    log("info", "docker.s3_credentials_omitted", {
      note: "SANDBOX_S3_CREDENTIALS=omit — sandboxes will NOT receive S3_ACCESS_KEY/S3_SECRET_KEY. /workspace still mounts (weed mount uses the filer over gRPC). Unset the env to restore the previous behaviour.",
    });
  }

  let storageQuotaProbe = null;
  function probeStorageQuota() {
    if (storageQuotaProbe) return storageQuotaProbe;
    storageQuotaProbe = (async () => {
      if (storageQuotaForce) return true;
      try {
        const driver = String(
          await dockerRunner(["info", "--format", "{{.Driver}}"], { timeoutMs: 10_000 }),
        ).trim();
        const supported = storageQuotaSupported(driver);
        if (!supported) {
          log("info", "docker.storage_quota_skipped", {
            driver,
            note: "--storage-opt size= is not enforced by this storage driver (it may be silently accepted); skipping rather than shipping a cap that caps nothing. Set SANDBOX_STORAGE_QUOTA_FORCE=1 if this is overlay2 on xfs+pquota.",
          });
        }
        return supported;
      } catch (err) {
        log("warn", "docker.storage_quota_probe_failed", {
          error: err?.message,
          note: "could not read the daemon storage driver; skipping --storage-opt",
        });
        return false;
      }
    })();
    return storageQuotaProbe;
  }

  function getSandbox(sandboxId) {
    const entry = sandboxes.get(sandboxId);
    if (!entry) {
      throw new SandboxError("sandbox_not_found", `sandbox ${sandboxId} not found`, 404);
    }
    return entry;
  }

  return {
    backend: "docker",

    async createSandbox({
      userId, sessionId, image: imageOverride, resourceQuota, ttlSec, networkPolicy,
      workspaceMountPath, workspaceMode, workspaceOwner, env: callerEnv = {},
    } = {}) {
      const { bucket, subpath } = resolveWorkspaceLocation({
        workspaceMountPath, workspaceMode, workspaceOwner,
      });

      // Refuse an isolation request we cannot honour, rather than accepting it
      // and starting a fully-connected container (which is what happened
      // before). In-guest mode NEEDS the filer route; `--network none` there
      // means /workspace never mounts and no sandbox ever boots.
      const policy = normalizeNetworkPolicy(networkPolicy);
      if (policy === NETWORK_POLICY_DENY && !hostMountMode) {
        throw new SandboxError(
          "network_policy_unenforceable",
          "network_policy=egress_deny cannot be enforced while the sandbox mounts its own " +
            "/workspace (SANDBOX_WORKSPACE_MOUNT=in-guest): the guest must reach the SeaweedFS " +
            "filer to mount at all. Set SANDBOX_WORKSPACE_MOUNT=host to make it enforceable.",
          409,
        );
      }

      // In host-mount mode the object-store credential is pointless in the
      // guest (it has nothing to talk to) — never ship a credential a process
      // has no use for.
      const baseEnv = buildContainerEnv({
        callerEnv,
        bucket,
        subpath,
        ...(hostMountMode ? { s3CredentialMode: "omit" } : {}),
      });
      const containerEnv = hostMount?.driver === HOST_MOUNT_DRIVER_S3 ? withGitSafeDirectory(baseEnv) : baseEnv;
      const sandboxId = `docker-${randomUUID().slice(0, 8)}`;

      // Take the host-side mount BEFORE starting the container: a container
      // with no workspace is worse than no container.
      let workspaceHold = null;
      let snapshotHold = null;
      if (hostMountMode) {
        workspaceHold = await hostMount.acquire({ bucket, subpath });
        // The durable snapshot store the in-guest entrypoint mounts at
        // /snapshots is a SIBLING filer path, and losing it silently would turn
        // "版本歷史" into ephemeral state. Best-effort, exactly as the
        // entrypoint treats it: a failure degrades snapshots, it does not fail
        // the sandbox. Toggle with SANDBOX_DURABLE_SNAPSHOTS=0.
        if (process.env.SANDBOX_DURABLE_SNAPSHOTS !== "0") {
          // `.snapshots` is a SIBLING of `workspace`, and the anchor has to
          // cope with `workspace` being the whole subpath — which it is for a
          // tenant on its own bucket, where the bucket root plays the part
          // `users/<id>/` plays in the shared layout. The old form required a
          // preceding `/`, so an isolated tenant got `workspace/.snapshots`:
          // snapshots written INSIDE the workspace, visible to the agent, and
          // nowhere near what a migration copied. Found by running the
          // migration tool against a real tenant, not by reading this line.
          const snapSubpath = subpath.replace(/(^|\/)workspace$/, "$1.snapshots");
          try {
            snapshotHold = await hostMount.acquire({ bucket, subpath: snapSubpath });
          } catch (err) {
            log("warn", "docker.host_snapshot_mount_failed", {
              sandboxId, snapSubpath, error: err?.message,
              note: "snapshots fall back to ephemeral for this sandbox",
            });
          }
        }
      }
      const releaseHolds = () => {
        try { workspaceHold?.release(); } catch { /* best-effort */ }
        try { snapshotHold?.release(); } catch { /* best-effort */ }
      };

      // Resource quota → docker run flags. resourceQuota is the shared shape
      // used by stub (memMb / cpus / pids). `pids` USED to be dropped here with
      // the note "isn't translatable to docker run" — that was wrong: it maps
      // directly onto --pids-limit, and the measured consequence of dropping it
      // was containers running with PidsLimit=<nil> (unbounded). It is now
      // honored. Every field goes through resolveQuotaField, so a caller that
      // omits one — OR sends a 0 / a negative / a non-number, which used to
      // remove the cap entirely — falls back to the deployment-wide default and
      // no sandbox runs uncapped by accident (see createDockerClient defaults).
      const cpus = resolveQuotaField("cpus", resourceQuota?.cpus, defaultCpus);
      const memoryMb = resolveQuotaField("memMb", resourceQuota?.memMb, defaultMemoryMb);
      const memorySwapMb = defaultMemorySwapMb || undefined;
      const pidsLimit = resolveQuotaField("pids", resourceQuota?.pids, defaultPidsLimit);
      const storageSizeGb = defaultStorageSizeGb && (await probeStorageQuota())
        ? defaultStorageSizeGb
        : undefined;

      const runArgs = buildDockerRunArgs({
        image: imageOverride || image,
        env: containerEnv,
        network,
        networkPolicy,
        cpus,
        memoryMb,
        memorySwapMb,
        pidsLimit,
        fsizeLimitBytes: defaultFsizeBytes,
        capDropAll,
        noNewPrivileges: effectiveNoNewPrivileges,
        storageSizeGb,
        runtime: dockerRuntime,
        groupAdd,
        fuseFlags: !hostMountMode,
        binds: [...officialHomeMount(userId, workspaceOwner), ...(hostMountMode
          ? [
              `${workspaceHold.mountPath}:/workspace`,
              ...(snapshotHold ? [`${snapshotHold.mountPath}:/snapshots`] : []),
            ]
          : [])],
        entrypoint: hostMountMode ? HOST_MOUNT_ENTRYPOINT : null,
        command: hostMountMode ? HOST_MOUNT_BOOT_COMMAND : [],
        name: sandboxId,
        labels: {
          "sandbox-id": sandboxId,
          "user-id": userId || "",
          "session-id": sessionId || "",
          owner: workspaceOwner || "",
        },
      });

      let containerId;
      try {
        containerId = (await dockerRunner(runArgs)).trim();
      } catch (err) {
        releaseHolds();
        log("error", "docker.sandbox_create_failed", {
          sandboxId, error: err?.message, code: err?.code,
        });
        throw err;
      }

      // `docker run -d` returns once the entrypoint STARTS — not when the in-guest
      // weed-mount of /workspace is ready. Execing before then races the mount (or
      // silently hangs if the mount never completes). Poll until /workspace is a
      // real mountpoint; on timeout, tear down + surface the container logs as the
      // FAILURE STATUS so the caller reports "sandbox didn't start" instead of hanging.
      const readyStart = Date.now();
      let mounted = false;
      let lastErr = "";
      while (Date.now() - readyStart < WORKSPACE_READY_TIMEOUT_MS) {
        try {
          await dockerRunner(["exec", containerId, "sh", "-c", "mountpoint -q /workspace"], { timeoutMs: 5_000 });
          mounted = true;
          break;
        } catch (err) {
          lastErr = err?.message || String(err);
          // Bail early if the container already died (mount crash) — no point polling.
          try {
            const st = await dockerRunner(["inspect", "-f", "{{.State.Running}}", containerId], { timeoutMs: 5_000 });
            if (st.trim() !== "true") break;
          } catch { break; }
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      if (!mounted) {
        const logs = await dockerRunner(["logs", "--tail", "40", containerId], { timeoutMs: 5_000 }).catch(() => "");
        try { await dockerRunner(["rm", "-f", containerId], { timeoutMs: 10_000 }); } catch { /* best-effort */ }
        releaseHolds();
        log("error", "docker.sandbox_mount_timeout", { sandboxId, lastErr, logsTail: logs.slice(-800) });
        throw new SandboxError(
          "sandbox_not_ready",
          `sandbox /workspace did not mount within ${WORKSPACE_READY_TIMEOUT_MS}ms (${lastErr || "no error"}). Container logs:\n${logs.slice(-800)}`,
          503,
        );
      }
      // 這裡以前會再等一個 `/workspace/.opencode` 唯讀 sub-mount 上線（最多 8 秒）。
      // 技能／記憶庫搬到 owner 底下沒掛載的 `.platform` 之後，那個 sub-mount 已經
      // 沒有意義：沙盒裡根本沒有 `.opencode` 可以保護，等待只會替每次開機加上
      // 8 秒的空轉。刪掉等待，同時用上面 buildContainerEnv 的
      // SANDBOX_PROTECT_SYSTEM_DIRS=0 讓 entrypoint 不要再把那個目錄造出來。

      log("info", "docker.sandbox_ready", { sandboxId, mountMs: Date.now() - readyStart });

      sandboxes.set(sandboxId, {
        sandboxId,
        containerId,
        workspaceId: sandboxId, // Docker has no separate workspace id concept
        workspaceMountPath,
        meta: {
          userId, sessionId, image: imageOverride || image,
          resourceQuota, ttlSec, networkPolicy, workspaceMountPath,
          bucket, subpath,
          workspaceMountMode,
        },
        releaseHolds,
        createdAt: Date.now(),
      });

      log("info", "docker.sandbox_created", {
        sandboxId,
        containerId: containerId.slice(0, 12),
        bucket,
        subpath,
        workspaceMountPath,
        // Was hard-coded `false` with "image self-mounts via weed". It is now
        // whatever actually happened, because that line was the record a later
        // audit read to decide whether the guest still needs the filer.
        bindMountHonored: hostMountMode,
        weedMount: !hostMountMode,
        workspaceMountMode,
        networkPolicy: policy || "unset",
      });

      return {
        sandboxId,
        workspaceId: sandboxId,
        workspaceDir: "/workspace",
      };
    },

    async destroySandbox(sandboxId, { keepWorkspace = false } = {}) {
      const entry = sandboxes.get(sandboxId);
      if (!entry) return; // idempotent
      sandboxes.delete(sandboxId);
      // Drop the host mount hold FIRST: the container is going away either way,
      // and a hold leaked by a failing `docker kill` would pin a FUSE mount for
      // the life of the process.
      try { entry.releaseHolds?.(); } catch { /* best-effort */ }
      try {
        // --rm on run means kill is usually enough — fall back to rm -f for
        // belt-and-suspenders in case --rm racing.
        await dockerRunner(["kill", entry.containerId], { timeoutMs: 10_000 });
      } catch (err) {
        // Container may already be gone; try rm -f and log if both fail.
        log("warn", "docker.destroy_kill_failed", {
          sandboxId, message: err?.message,
        });
      }
      try {
        await dockerRunner(["rm", "-f", entry.containerId], { timeoutMs: 10_000 });
      } catch (err) {
        log("warn", "docker.destroy_rm_failed", {
          sandboxId, message: err?.message,
        });
      }
    },

    /**
     * 這個容器到現在總共用了多少 CPU（微秒）。閒置回收前量兩次，中間有在用 CPU 就不算閒置 ——
     * `nohup python render.py &` 這種背景工作讓指令立刻結束，之後沒有任何 exec 在跑，
     * 只看 exec 的話它會在閒置窗到期時被砍。讀的是容器自己的 cgroup（v2 的 cpu.stat，
     * 退回 v1 的 cpuacct.usage）；讀不到回 null，呼叫端就照原本的規則回收。
     */
    async cpuUsageUsec(sandboxId) {
      const entry = sandboxes.get(sandboxId);
      if (!entry) return null;
      try {
        const out = await dockerRunner([
          "exec", entry.containerId, "sh", "-c",
          "cat /sys/fs/cgroup/cpu.stat 2>/dev/null || echo cpuacct_ns $(cat /sys/fs/cgroup/cpuacct/cpuacct.usage 2>/dev/null)",
        ], { timeoutMs: 5_000 });
        const v2 = /^usage_usec\s+(\d+)/m.exec(out);
        if (v2) return Number(v2[1]);
        const v1 = /^cpuacct_ns\s+(\d+)/m.exec(out);
        return v1 ? Math.floor(Number(v1[1]) / 1000) : null;
      } catch {
        return null;
      }
    },

    async pauseSandbox(sandboxId) {
      const entry = getSandbox(sandboxId);
      await dockerRunner(["pause", entry.containerId], { timeoutMs: 10_000 });
    },

    async resumeSandbox(sandboxId) {
      const entry = getSandbox(sandboxId);
      await dockerRunner(["unpause", entry.containerId], { timeoutMs: 10_000 });
    },

    async listSandboxes() {
      return Array.from(sandboxes.values()).map((entry) => ({
        sandboxId: entry.sandboxId,
        workspaceId: entry.workspaceId,
        createdAt: entry.createdAt,
      }));
    },

    /**
     * One-shot exec inside the container. Returns an EventEmitter handle
     * with the shape stub.mjs / envd.mjs emit (stdout/stderr/exit/error
     * events + .write/.cancel/.kill).
     */
    async execProcess(sandboxId, {
      kind = "bash", command, args = [], env = {}, cwd, timeoutMs, stdin,
    } = {}) {
      const entry = getSandbox(sandboxId);

      let cmd;
      let cmdArgs;
      if (kind === "bash") {
        cmd = "/bin/bash";
        const rawCommand = typeof command === "string"
          ? command
          : (Array.isArray(args) && args.length ? args.join(" ") : "true");
        cmdArgs = ["-lc", rawCommand];
      } else if (kind === "python") {
        cmd = "/usr/bin/env";
        cmdArgs = ["python3", "-c", typeof command === "string" ? command : ""];
      } else {
        cmd = String(command || "true");
        cmdArgs = Array.isArray(args) ? args.map(String) : [];
      }

      // The sandbox user is uid 1000 with home /home/user (Dockerfile useradd).
      // A caller-supplied HOME (the engine runs as root, so its inherited
      // HOME=/root can leak into the exec env) is meaningless inside the sandbox
      // AND breaks `bash -lc`: a login shell sources $HOME/.bash_profile, and
      // uid 1000 cannot read root's /root/.bash_profile → "/bin/bash:
      // /root/.bash_profile: Permission denied" printed before every command.
      // Force the sandbox user's own HOME/USER (runtime values WIN over caller
      // env). Inline per-command overrides like `HOME=/tmp python3 ...` still
      // apply — they're in the command string, not here.
      if (env?.HOME && env.HOME !== "/home/user") {
        log("warn", "docker.exec_home_override", { sandboxId, callerHome: env.HOME });
      }
      const execEnv = { ...(env || {}), HOME: "/home/user", USER: "user" };

      // execId 要先算出來 —— 包在外面那一層 shell 會把它當成 pid 檔的名字
      // （containerExecWrapper），而取消時要靠同一個名字找回容器裡的 pid。
      const execId = `exec-${randomUUID().slice(0, 8)}`;

      const execArgs = ["exec", "-i"];
      if (cwd) execArgs.push("-w", cwd);
      for (const [k, v] of Object.entries(execEnv)) {
        execArgs.push("-e", `${k}=${v}`);
      }
      execArgs.push(entry.containerId, ...containerExecWrapper(execId), cmd, ...cmdArgs);

      return spawnDockerExec({
        args: execArgs,
        stdin,
        timeoutMs,
        execId,
        containerId: entry.containerId,
      });
    },

    /**
     * Long-lived process — same as execProcess but with no timeout and
     * stdin held open for later writeStdin via the returned handle.
     */
    async spawnLongLivedProcess(sandboxId, { command, args = [], env = {}, cwd } = {}) {
      const entry = getSandbox(sandboxId);
      const cmd = String(command || "");
      const cmdArgs = Array.isArray(args) ? args.map(String) : [];

      // Force the sandbox user's HOME/USER (see execProcess) so long-lived
      // procs (stdio MCP servers, hook daemons) don't inherit a meaningless
      // HOME=/root from the caller.
      const execEnv = { ...(env || {}), HOME: "/home/user", USER: "user" };

      // 長駐行程更需要這一層：它活得比任何一輪都久（stdio MCP server、
      // hook daemon、`npm run dev`），而殺不掉它的後果就是佔著 port 與記憶體
      // 直到整個沙盒被回收。
      const execId = `lproc-${randomUUID().slice(0, 8)}`;

      const execArgs = ["exec", "-i"];
      if (cwd) execArgs.push("-w", cwd);
      for (const [k, v] of Object.entries(execEnv)) {
        execArgs.push("-e", `${k}=${v}`);
      }
      execArgs.push(entry.containerId, ...containerExecWrapper(execId), cmd, ...cmdArgs);

      return spawnDockerExec({
        args: execArgs,
        stdin: null,        // long-lived: stdin stays open for writeStdin
        keepStdinOpen: true,
        timeoutMs: 0,
        execId,
        containerId: entry.containerId,
      });
    },

    /**
     * 互動式終端機 —— 人在打字的那一個，不是模型的工具。
     *
     * 為什麼不是 `docker exec -it`（CLI 會回 "the input device is not a TTY"）、
     * 為什麼不是容器裡的 `script`（改不了視窗大小），以及 resize／SIGINT 的
     * 實測輸出，全部寫在 docker-pty.mjs 的檔頭。
     */
    async openTerminal(sandboxId, { cwd, cols, rows, env } = {}) {
      const entry = getSandbox(sandboxId);
      const auth = officialAuthIntent(env);
      return openDockerTerminal({
        containerId: entry.containerId,
        // 沒指定就落在工作區根目錄 —— 跟 exec 一樣，人跟模型不該站在不同地方。
        cwd: cwd || "/workspace",
        cols, rows, env,
        ...(auth ? {argv: ['/usr/local/bin/ava-agent', auth.provider, auth.action]} : {}),
      });
    },

    async readFile(sandboxId, filePath) {
      const entry = getSandbox(sandboxId);
      // docker cp <id>:/workspace/<path> - → stdout (tar stream). Easier:
      // docker exec to cat the file. For now use exec — the cm-agent-sandbox
      // image bakes in cat, so this is a one-process cost.
      const handle = await spawnDockerExec({
        args: ["exec", entry.containerId, "cat", joinWorkspace(filePath)],
        timeoutMs: 30_000,
        execId: `read-${randomUUID().slice(0, 8)}`,
      });
      return await collectStdout(handle);
    },

    async writeFile(sandboxId, filePath, content) {
      const entry = getSandbox(sandboxId);
      const buf = Buffer.isBuffer(content)
        ? content
        : Buffer.from(typeof content === "string" ? content : JSON.stringify(content));
      // exec sh -c 'cat > /workspace/<path>' with content via stdin.
      const safe = joinWorkspace(filePath).replace(/'/g, `'\\''`);
      const handle = await spawnDockerExec({
        args: ["exec", "-i", entry.containerId, "sh", "-c", `mkdir -p "$(dirname '${safe}')" && cat > '${safe}'`],
        stdin: buf,
        timeoutMs: 60_000,
        execId: `write-${randomUUID().slice(0, 8)}`,
      });
      await collectExit(handle);
    },

    async statFile(sandboxId, filePath) {
      const entry = getSandbox(sandboxId);
      const safe = joinWorkspace(filePath);
      const handle = await spawnDockerExec({
        args: [
          "exec", entry.containerId, "sh", "-c",
          // size:mtimeMs:isFile:isDir
          `stat -c '%s:%Y:%F' "${safe.replace(/"/g, '\\"')}" 2>/dev/null || echo ::missing`,
        ],
        timeoutMs: 10_000,
        execId: `stat-${randomUUID().slice(0, 8)}`,
      });
      const out = (await collectStdout(handle)).toString("utf8").trim();
      if (!out || out.endsWith("missing")) return null;
      const [sizeStr, mtimeStr, typeStr] = out.split(":");
      if (typeStr === "missing") return null;
      return {
        path: filePath,
        size: Number(sizeStr) || 0,
        mtimeMs: (Number(mtimeStr) || 0) * 1000,
        isFile: /regular file/.test(typeStr || ""),
        isDirectory: /directory/.test(typeStr || ""),
      };
    },

    async listFiles(sandboxId, dirPath = "/") {
      const entry = getSandbox(sandboxId);
      const safe = joinWorkspace(dirPath);
      const handle = await spawnDockerExec({
        args: [
          "exec", entry.containerId, "sh", "-c",
          // name\ttype\tsize\tmtime per line
          `cd "${safe.replace(/"/g, '\\"')}" 2>/dev/null && ls -1A | while read n; do stat -c "%n	%F	%s	%Y" "$n"; done`,
        ],
        timeoutMs: 15_000,
        execId: `ls-${randomUUID().slice(0, 8)}`,
      });
      const out = (await collectStdout(handle)).toString("utf8").trim();
      if (!out) return [];
      return out.split("\n").map((line) => {
        const [name, type, sizeStr, mtimeStr] = line.split("\t");
        return {
          name,
          path: `${dirPath.replace(/\/+$/, "")}/${name}`.replace(/\/+/g, "/"),
          isFile: /regular file/.test(type || ""),
          isDirectory: /directory/.test(type || ""),
          size: Number(sizeStr) || 0,
          mtimeMs: (Number(mtimeStr) || 0) * 1000,
        };
      });
    },

    async deleteFile(sandboxId, filePath) {
      const entry = getSandbox(sandboxId);
      const safe = joinWorkspace(filePath);
      const handle = await spawnDockerExec({
        args: ["exec", entry.containerId, "rm", "-rf", safe],
        timeoutMs: 30_000,
        execId: `rm-${randomUUID().slice(0, 8)}`,
      });
      await collectExit(handle);
    },

    async ensureDir(sandboxId, dirPath) {
      const entry = getSandbox(sandboxId);
      const safe = joinWorkspace(dirPath);
      const handle = await spawnDockerExec({
        args: ["exec", entry.containerId, "mkdir", "-p", safe],
        timeoutMs: 15_000,
        execId: `mkdir-${randomUUID().slice(0, 8)}`,
      });
      await collectExit(handle);
    },

    async snapshotSandbox() {
      throw new SandboxError(
        "not_supported",
        "snapshot is not supported in docker mode (use CubeMaster for snapshot/restore)",
        501,
      );
    },

    async restoreSnapshot() {
      throw new SandboxError(
        "not_supported",
        "restore is not supported in docker mode",
        501,
      );
    },

    // Test seam — exposed under _internal so production code can't depend
    // on it (mirrors client.mjs pattern).
    _internal: {
      sandboxes,
      dockerRunner,
      buildDockerRunArgs,
      parseWorkspaceMountPath,
    },
  };
}

// ---- docker exec subprocess wrapper ----

/**
 * 容器裡放 pid 檔的地方。
 *
 * `/tmp` 而不是工作區：工作區是 FUSE 掛上來的 S3，寫一個每個指令都會產生的
 * 小檔案進去等於把它同步到物件儲存，而且使用者會在自己的檔案面板裡看到它。
 * 這些 pid 檔的壽命就是一個指令，容器死了它們也不該留下來。
 */
export const CONTAINER_RUN_DIR = "/tmp/.unieai-run";

/**
 * 包在使用者指令外面的那一層 —— 它唯一的工作是把**容器裡**的 pid 記下來。
 *
 * 為什麼需要它：`docker exec` 起的行程是 containerd-shim 的小孩，不是
 * `docker` CLI 的小孩。殺掉 CLI 完全不影響它（量過，見
 * docker-cancel-kills-container-process.test.mjs 的檔頭）。所以要在容器裡殺，
 * 而要在容器裡殺就得先知道容器裡的 pid —— 跟 `cube/ssh.mjs` 的
 * `REMOTE_RUN_DIR` 是同一個手法，這是第二次做同一件事。
 *
 * `exec "$0" "$@"` 同時做到三件事，所以不要改成 `sh -c "$*"` 之類的寫法：
 *   · 不經過第二層引號 —— 使用者指令裡的空白與引號不會被重新剖析；
 *   · PID 不變 —— `$$` 記下來的就是真正那支指令的 pid（shell 被 exec 取代）；
 *   · 離開碼就是指令的離開碼，沒有多一層 shell 把它吃掉。
 */
export function containerExecWrapper(execId) {
  return [
    "sh",
    "-c",
    `mkdir -p ${CONTAINER_RUN_DIR} 2>/dev/null; `
    + `echo $$ > ${CONTAINER_RUN_DIR}/${execId}.pid 2>/dev/null; `
    + 'exec "$0" "$@"',
  ];
}

/**
 * 在容器裡殺掉一個 exec 的整棵行程樹。回的是 `docker` 的 argv。
 *
 * 先 `kill -SIG -"$P"`（整個 process group）才是重點 —— 使用者按停止的時候
 * 想停的是 `npm run dev`**和它起的那個 server**，不是只有最上面那一支。
 * 量過：`docker exec` 的行程自己就是 process group 與 session 的 leader
 * （`pid=7 pgid=7 sid=7`），所以負號打得到整棵樹。
 *
 * 退回單一 pid 那一半照 `ssh.mjs` 留著：哪天 runtime 換了行為（不再給新的
 * process group），至少直接那一支還是會死，而不是整個取消功能無聲地失效。
 *
 * 腳本自己永遠 `exit 0`：非 0 的離開碼就一定來自客戶端（容器不在了、daemon
 * 不理我們），而不是「pid 已經不在了」這種完全正常的情況。
 */
export function containerKillArgs(containerId, execId, sig = "TERM") {
  return [
    "exec",
    containerId,
    "sh",
    "-c",
    `P=$(cat ${CONTAINER_RUN_DIR}/${execId}.pid 2>/dev/null); `
    + `[ -n "$P" ] && { kill -${sig} -"$P" 2>/dev/null || kill -${sig} "$P" 2>/dev/null; }; `
    + `exit 0`,
  ];
}

/**
 * Spawn `docker <args...>` and return an EventEmitter handle matching the
 * shape stub/envd emit (stdout/stderr/exit/error + .write/.cancel/.kill).
 * Used both for one-shot exec and long-lived process spawning.
 */
/**
 * 在容器裡送一個訊號給這個 exec 的整棵行程樹。射後不理。
 *
 * 失敗只記一行：這條路是「盡力把它停下來」，而呼叫端已經在關客戶端了 ——
 * 這裡丟例外會把取消變成一個會炸的操作，而取消本來就常常在「它剛好自己
 * 結束了」的瞬間被呼叫。`containerId` 沒帶（舊的呼叫端、或測試裡直接用
 * spawnDockerExec）就安靜跳過，不要在這裡假裝做了。
 */
function killInContainer(containerId, execId, sig) {
  if (!containerId || !execId) return;
  try {
    const p = spawn("docker", containerKillArgs(containerId, execId, sig), {
      stdio: ["ignore", "ignore", "ignore"],
    });
    p.on("error", (err) => {
      log("warn", "docker.container_kill_failed", { containerId, execId, sig, error: err?.message || String(err) });
    });
    p.unref?.();
  } catch (err) {
    log("warn", "docker.container_kill_failed", { containerId, execId, sig, error: err?.message || String(err) });
  }
}

function spawnDockerExec({
  args, stdin = null, keepStdinOpen = false, timeoutMs = 0, execId, containerId = "",
}) {
  const handle = new EventEmitter();
  const pendingEvents = [];
  let exitEmitted = false;
  let timer = null;

  // Very short commands can finish before dispatchExec registers stream
  // listeners. Buffer those early events so the registry can replay them;
  // otherwise the exec remains "running" forever after losing its exit event.
  const emitOrBuffer = (type, ...values) => {
    if (handle.listenerCount(type) > 0) handle.emit(type, ...values);
    else pendingEvents.push([type, values]);
  };

  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });

  if (stdin != null) {
    try { child.stdin.write(stdin); } catch { /* ignore */ }
  }
  if (!keepStdinOpen) {
    try { child.stdin.end(); } catch { /* ignore */ }
  }

  child.stdout.on("data", (chunk) => emitOrBuffer("stdout", chunk));
  child.stderr.on("data", (chunk) => emitOrBuffer("stderr", chunk));

  const emitExit = (code, signal, errorMessage) => {
    if (exitEmitted) return;
    exitEmitted = true;
    if (timer) clearTimeout(timer);
    emitOrBuffer("exit", {
      execId,
      code: code === null ? null : Number(code),
      signal: signal || null,
      error: errorMessage || null,
    });
  };

  child.on("error", (err) => {
    emitOrBuffer("error", err);
    emitExit(null, null, err?.message || String(err));
  });
  child.on("close", (code, signal) => emitExit(code, signal, null));

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      // 兩件事都要做，而且缺一不可（跟 ssh.mjs 同一條規則）：關掉客戶端才會
      // 釋放呼叫端的串流並結算，但真正讓工作停下來的是**容器裡**那個訊號。
      // 只做前者就是回報 `signal: "SIGTERM"` 而指令還在跑 —— 逾時說了謊。
      killInContainer(containerId, execId, "TERM");
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => {
        if (!exitEmitted) {
          killInContainer(containerId, execId, "KILL");
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, 2000).unref();
    }, timeoutMs).unref();
  }

  handle.execId = execId;
  handle.pid = child.pid;
  handle.drainBufferedEvents = () => {
    for (const [type, values] of pendingEvents.splice(0)) handle.emit(type, ...values);
  };
  handle.write = (data) => {
    try { child.stdin.write(data); } catch (err) { handle.emit("error", err); }
  };
  handle.cancel = () => {
    // 容器裡先 —— 那才是真的在跑的東西。順序反過來也能work，但先殺客戶端
    // 會讓「已經結束」的視窗提早打開，日後讀這段的人會以為容器那一步可省。
    killInContainer(containerId, execId, "TERM");
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    setTimeout(() => {
      if (!exitEmitted) {
        killInContainer(containerId, execId, "KILL");
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }, 2000).unref();
  };
  handle.kill = handle.cancel;

  return handle;
}

// ---- helpers ----

function joinWorkspace(filePath) {
  const p = String(filePath || "").replace(/^\/workspace(\/|$)/, "/").replace(/^\/+/, "");
  return `/workspace/${p}`.replace(/\/+/g, "/");
}

function collectStdout(handle) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    handle.on("stdout", (c) => chunks.push(c));
    handle.on("exit", (evt) => {
      if (evt?.code === 0 || evt?.code == null) resolve(Buffer.concat(chunks));
      else reject(new SandboxError("docker_exec_failed", `docker exec exited ${evt?.code}`, 500, evt));
    });
    handle.on("error", reject);
    // Fast one-shot commands (readFile/statFile/listFiles) can finish before
    // these listeners attach; replay any buffered stdout/exit so the promise
    // resolves instead of hanging forever.
    handle.drainBufferedEvents?.();
  });
}

function collectExit(handle) {
  return new Promise((resolve, reject) => {
    handle.on("exit", (evt) => {
      if (evt?.code === 0 || evt?.code == null) resolve(evt);
      else reject(new SandboxError("docker_exec_failed", `docker exec exited ${evt?.code}`, 500, evt));
    });
    handle.on("error", reject);
    // Same race as collectStdout — a fast writeFile/deleteFile/ensureDir may
    // have already exited before this listener attached.
    handle.drainBufferedEvents?.();
  });
}
