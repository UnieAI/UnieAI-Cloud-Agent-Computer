/**
 * cube/docker.test.mjs — Unit tests for the Docker backend orchestrator.
 *
 * Most tests inject a fake `dockerRunner` so the suite passes without a
 * Docker daemon. A separate, opt-in integration smoke (gated by
 * DOCKER_INTEGRATION=1) shells out to the real daemon — see bottom of file.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildContainerEnv,
  buildDockerRunArgs,
  createDockerClient,
  parseWorkspaceMountPath,
  storageQuotaSupported,
} from "./docker.mjs";
import { SandboxError } from "../shared/error.mjs";

// ---- parseWorkspaceMountPath ----

test("parseWorkspaceMountPath: parses /mnt/<bucket>/<subpath>", () => {
  const { bucket, subpath } = parseWorkspaceMountPath("/mnt/agent-fs/u-alice/p-myproject");
  assert.equal(bucket, "agent-fs");
  assert.equal(subpath, "u-alice/p-myproject");
});

test("parseWorkspaceMountPath: strips a trailing slash", () => {
  const { bucket, subpath } = parseWorkspaceMountPath("/mnt/agent-fs/u-bob/sess-1/");
  assert.equal(bucket, "agent-fs");
  assert.equal(subpath, "u-bob/sess-1");
});

test("parseWorkspaceMountPath: rejects empty path", () => {
  assert.throws(() => parseWorkspaceMountPath(""), (err) => {
    assert.ok(err instanceof SandboxError);
    assert.equal(err.code, "bad_request");
    return true;
  });
});

test("parseWorkspaceMountPath: rejects non-/mnt path", () => {
  assert.throws(() => parseWorkspaceMountPath("/tmp/sandbox/abc"), (err) => {
    assert.ok(err instanceof SandboxError);
    assert.equal(err.code, "bad_request");
    return true;
  });
});

test("parseWorkspaceMountPath: rejects /mnt with no subpath", () => {
  assert.throws(() => parseWorkspaceMountPath("/mnt/agent-fs"), (err) => {
    assert.ok(err instanceof SandboxError);
    return true;
  });
});

// ---- buildDockerRunArgs ----

test("buildDockerRunArgs: always sets --cap-add SYS_ADMIN and --device /dev/fuse", () => {
  const args = buildDockerRunArgs({
    image: "cm-agent-sandbox:weed-mount",
    env: {},
  });
  assert.ok(args.includes("--cap-add"));
  const capIdx = args.indexOf("--cap-add");
  assert.equal(args[capIdx + 1], "SYS_ADMIN");
  assert.ok(args.includes("--device"));
  const devIdx = args.indexOf("--device");
  assert.equal(args[devIdx + 1], "/dev/fuse");
});

test("buildDockerRunArgs: sets --shm-size 512m for chromium (Phase 5v)", () => {
  const args = buildDockerRunArgs({
    image: "cm-agent-sandbox:weed-mount",
    env: {},
  });
  assert.ok(args.includes("--shm-size"));
  assert.equal(args[args.indexOf("--shm-size") + 1], "512m");
});

test("buildDockerRunArgs: appends image last", () => {
  const args = buildDockerRunArgs({
    image: "cm-agent-sandbox:test",
    env: { FOO: "bar" },
    network: "host",
  });
  assert.equal(args[args.length - 1], "cm-agent-sandbox:test");
});

test("buildDockerRunArgs: no memoryMb → no --memory / --memory-swap (uncapped)", () => {
  const args = buildDockerRunArgs({ image: "x", env: {} });
  assert.ok(!args.includes("--memory"));
  assert.ok(!args.includes("--memory-swap"));
});

test("buildDockerRunArgs: memoryMb pins --memory-swap to the RAM limit (no host swap)", () => {
  const args = buildDockerRunArgs({ image: "x", env: {}, memoryMb: 2048 });
  assert.equal(args[args.indexOf("--memory") + 1], "2048m");
  // swap total defaults to == memory, i.e. the container gets ZERO swap.
  assert.equal(args[args.indexOf("--memory-swap") + 1], "2048m");
});

test("buildDockerRunArgs: explicit memorySwapMb ≥ memory is honored", () => {
  const args = buildDockerRunArgs({ image: "x", env: {}, memoryMb: 2048, memorySwapMb: 3072 });
  assert.equal(args[args.indexOf("--memory-swap") + 1], "3072m");
});

test("buildDockerRunArgs: memorySwapMb < memory falls back to memory (docker requires swap ≥ memory)", () => {
  const args = buildDockerRunArgs({ image: "x", env: {}, memoryMb: 2048, memorySwapMb: 512 });
  assert.equal(args[args.indexOf("--memory-swap") + 1], "2048m");
});

test("buildDockerRunArgs: serializes env vars as -e KEY=VALUE", () => {
  const args = buildDockerRunArgs({
    image: "x",
    env: { WORKSPACE_BUCKET: "agent-fs", WORKSPACE_PATH: "u/p", S3_ENDPOINT: "http://h:8333" },
  });
  // Find -e entries
  const envFlags = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-e") envFlags.push(args[i + 1]);
  }
  assert.ok(envFlags.includes("WORKSPACE_BUCKET=agent-fs"));
  assert.ok(envFlags.includes("WORKSPACE_PATH=u/p"));
  assert.ok(envFlags.includes("S3_ENDPOINT=http://h:8333"));
});

test("buildDockerRunArgs: applies --cpus and --memory when resource quota given", () => {
  const args = buildDockerRunArgs({
    image: "x", env: {}, cpus: 2, memoryMb: 1024,
  });
  assert.ok(args.includes("--cpus"));
  assert.equal(args[args.indexOf("--cpus") + 1], "2");
  assert.ok(args.includes("--memory"));
  assert.equal(args[args.indexOf("--memory") + 1], "1024m");
});

test("buildDockerRunArgs: passes --network when provided", () => {
  const args = buildDockerRunArgs({ image: "x", env: {}, network: "agent-net" });
  assert.equal(args[args.indexOf("--network") + 1], "agent-net");
});

// ---- createSandbox / destroySandbox via mocked dockerRunner ----

function makeRecorder({ runOutput = "container-abc123def456\n" } = {}) {
  const calls = [];
  const runner = async (args, opts) => {
    calls.push({ args: [...args], opts });
    if (args[0] === "run") return runOutput;
    return "";
  };
  return { runner, calls };
}

test("createSandbox: invokes docker run with merged env including workspace coords", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner });

  const out = await client.createSandbox({
    userId: "u-1",
    sessionId: "sess-1",
    workspaceMountPath: "/mnt/agent-fs/u-1/p-foo",
    env: { CUSTOM_VAR: "hello" },
  });

  assert.ok(out.sandboxId.startsWith("docker-"));
  assert.equal(out.workspaceDir, "/workspace");

  const runCall = calls.find((c) => c.args[0] === "run");
  assert.ok(runCall, "docker run was invoked");

  // Find env flags in the run argv.
  const envFlags = [];
  for (let i = 0; i < runCall.args.length; i++) {
    if (runCall.args[i] === "-e") envFlags.push(runCall.args[i + 1]);
  }
  assert.ok(envFlags.includes("WORKSPACE_BUCKET=agent-fs"));
  assert.ok(envFlags.includes("WORKSPACE_PATH=u-1/p-foo"));
  assert.ok(envFlags.includes("CUSTOM_VAR=hello"), "caller env merged");
  assert.ok(envFlags.some((e) => e.startsWith("S3_ENDPOINT=")));
  // S3 憑證**不在這裡斷言**。它由 applyS3CredentialPolicy 決定，而那個決定
  // 讀的是 SANDBOX_S3_CREDENTIALS —— 正式環境設的是 `omit`（.env），刻意不把
  // 共用的 Admin 憑證送進每一個沙盒。這一條在載入 .env 的跑法下因此一直是紅的，
  // 紅在一個**已經被刻意改掉的行為**上。憑證的兩個分支改由下面那兩條 hermetic
  // 的測試釘住，注入 mode 而不是繼承環境。
});

// ---- S3 憑證策略：注入 mode，不繼承環境 ----

test("buildContainerEnv: inject 模式把憑證送進沙盒", () => {
  const env = buildContainerEnv({
    bucket: "agent-fs",
    subpath: "u-1/p-foo",
    s3CredentialMode: "inject",
    s3AccessKey: "AK-test",
    s3SecretKey: "SK-test",
  });
  assert.equal(env.S3_ACCESS_KEY, "AK-test");
  assert.equal(env.S3_SECRET_KEY, "SK-test");
});

test("buildContainerEnv: omit 模式**移除**憑證，連呼叫端自己塞的也一起 —— 正式環境走的是這一條", () => {
  const env = buildContainerEnv({
    bucket: "agent-fs",
    subpath: "u-1/p-foo",
    s3CredentialMode: "omit",
    s3AccessKey: "AK-test",
    s3SecretKey: "SK-test",
    env: { S3_ACCESS_KEY: "smuggled", S3_SECRET_KEY: "smuggled" },
  });
  assert.equal("S3_ACCESS_KEY" in env, false, "omit 要 strip，不是只有 skip");
  assert.equal("S3_SECRET_KEY" in env, false);
});

test("createSandbox: runs docker with FUSE flags (SYS_ADMIN + /dev/fuse)", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner });

  await client.createSandbox({
    userId: "u-x",
    sessionId: "sess-x",
    workspaceMountPath: "/mnt/agent-fs/u-x/sess-x",
  });

  const runCall = calls.find((c) => c.args[0] === "run");
  assert.ok(runCall);
  assert.ok(runCall.args.includes("--cap-add"));
  assert.equal(runCall.args[runCall.args.indexOf("--cap-add") + 1], "SYS_ADMIN");
  assert.ok(runCall.args.includes("--device"));
  assert.equal(runCall.args[runCall.args.indexOf("--device") + 1], "/dev/fuse");
});

test("createSandbox: fails clear when workspaceMountPath is missing", async () => {
  const { runner } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner });
  await assert.rejects(
    () => client.createSandbox({ userId: "u-2" }),
    (err) => {
      assert.ok(err instanceof SandboxError);
      assert.equal(err.code, "bad_request");
      return true;
    },
  );
});

test("destroySandbox: calls docker kill + docker rm -f and is idempotent", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner });

  const out = await client.createSandbox({
    userId: "u-d",
    sessionId: "sess-d",
    workspaceMountPath: "/mnt/agent-fs/u-d/sess-d",
  });

  calls.length = 0;
  await client.destroySandbox(out.sandboxId);

  const ops = calls.map((c) => c.args[0]);
  assert.deepEqual(ops, ["kill", "rm"]);

  // Idempotent: 2nd destroy with same id is a silent no-op.
  calls.length = 0;
  await client.destroySandbox(out.sandboxId);
  assert.equal(calls.length, 0);
});

test("listSandboxes: returns created sandboxes", async () => {
  const { runner } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner });

  await client.createSandbox({
    userId: "u-l",
    sessionId: "sess-l1",
    workspaceMountPath: "/mnt/agent-fs/u-l/sess-l1",
  });
  await client.createSandbox({
    userId: "u-l",
    sessionId: "sess-l2",
    workspaceMountPath: "/mnt/agent-fs/u-l/sess-l2",
  });

  const list = await client.listSandboxes();
  assert.equal(list.length, 2);
  for (const row of list) {
    assert.ok(row.sandboxId.startsWith("docker-"));
    assert.ok(typeof row.createdAt === "number");
  }
});

test("createSandbox: applies cpu/memory limits from resourceQuota", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner });

  await client.createSandbox({
    userId: "u-r",
    sessionId: "sess-r",
    workspaceMountPath: "/mnt/agent-fs/u-r/sess-r",
    resourceQuota: { cpus: 4, memMb: 2048 },
  });

  const runCall = calls.find((c) => c.args[0] === "run");
  assert.equal(runCall.args[runCall.args.indexOf("--cpus") + 1], "4");
  assert.equal(runCall.args[runCall.args.indexOf("--memory") + 1], "2048m");
});

// ---- resource quota: the deployment cap must survive an unset env and a
// caller who asks for "no limit" ------------------------------------------
//
// These four exist because the FIRST of them was red: memory and pids were
// safe-by-default while CPU was not, and a caller-supplied 0 fell through
// `?? default` (which only catches null/undefined) into `if (cpus)` and
// removed the cap entirely. Both paths end at the same place — a container
// with no ceiling on a box that is shared with production.

/** Run one createSandbox with the quota envs forced to a known state. */
async function runWithQuotaEnv(envPatch, createArgs = {}) {
  const KEYS = [
    "SANDBOX_DEFAULT_CPUS",
    "SANDBOX_DEFAULT_MEMORY_MB",
    "SANDBOX_DEFAULT_MEMORY_SWAP_MB",
    "SANDBOX_DEFAULT_PIDS_LIMIT",
  ];
  const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(envPatch)) process.env[k] = v;
  try {
    const { runner, calls } = makeRecorder();
    const client = createDockerClient({ dockerRunner: runner });
    await client.createSandbox({
      userId: "u-q",
      sessionId: "sess-q",
      workspaceMountPath: "/mnt/agent-fs/u-q/sess-q",
      ...createArgs,
    });
    const runCall = calls.find((c) => c.args[0] === "run");
    const flag = (name) => {
      const i = runCall.args.indexOf(name);
      return i === -1 ? null : runCall.args[i + 1];
    };
    return { args: runCall.args, flag };
  } finally {
    for (const k of KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("createSandbox: CPU is capped even when SANDBOX_DEFAULT_CPUS is unset", async () => {
  const { flag } = await runWithQuotaEnv({});
  const cpus = Number(flag("--cpus"));
  assert.ok(
    Number.isFinite(cpus) && cpus > 0,
    "an unset SANDBOX_DEFAULT_CPUS must not mean unlimited CPU — memory and pids "
      + "already default safe, and a deploy that forgets one env is exactly how a "
      + "single tenant takes the whole box",
  );
});

test("createSandbox: a caller quota of 0 does NOT remove the deployment cap", async () => {
  const { flag } = await runWithQuotaEnv({}, { resourceQuota: { cpus: 0, memMb: 0, pids: 0 } });
  assert.ok(Number(flag("--cpus")) > 0, "cpus:0 from a request must fall back to the default cap");
  assert.equal(flag("--memory"), "2048m", "memMb:0 from a request must fall back to the default cap");
  assert.ok(Number(flag("--pids-limit")) > 0, "pids:0 from a request must fall back to the default cap");
});

test("createSandbox: an unusable caller quota falls back instead of emitting a bad flag", async () => {
  const { flag } = await runWithQuotaEnv(
    {},
    { resourceQuota: { cpus: "lots", memMb: -1, pids: Number.NaN } },
  );
  // `docker run --cpus lots` does not start a container; a quota that cannot be
  // parsed must degrade to the default cap, never to a boot failure and never
  // to no cap at all.
  assert.ok(Number(flag("--cpus")) > 0);
  assert.equal(flag("--memory"), "2048m");
  assert.ok(Number(flag("--pids-limit")) > 0);
});

test("createSandbox: a caller may still RAISE the caps for a heavy job", async () => {
  const { flag } = await runWithQuotaEnv(
    { SANDBOX_DEFAULT_CPUS: "2", SANDBOX_DEFAULT_MEMORY_MB: "2048" },
    { resourceQuota: { cpus: 6, memMb: 8192, pids: 4096 } },
  );
  assert.equal(flag("--cpus"), "6");
  assert.equal(flag("--memory"), "8192m");
  assert.equal(flag("--pids-limit"), "4096");
  // Swap must follow the raised ceiling, not stay pinned to the (lower) default,
  // or docker refuses the run with "Minimum memoryswap limit should be larger
  // than memory limit".
  assert.equal(flag("--memory-swap"), "8192m");
});

test("createDockerClient: SANDBOX_DEFAULT_CPUS=0 is the operator's opt-in to unlimited", async () => {
  const { args } = await runWithQuotaEnv({ SANDBOX_DEFAULT_CPUS: "0" });
  assert.equal(args.includes("--cpus"), false, "an EXPLICIT 0 env still means unlimited");
});

test("snapshotSandbox / restoreSnapshot: throw not_supported", async () => {
  const { runner } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner });
  await assert.rejects(() => client.snapshotSandbox("any"), (err) => {
    assert.ok(err instanceof SandboxError);
    assert.equal(err.code, "not_supported");
    return true;
  });
  await assert.rejects(() => client.restoreSnapshot("any"), (err) => {
    assert.ok(err instanceof SandboxError);
    assert.equal(err.code, "not_supported");
    return true;
  });
});

// ---- index.mjs dispatch ----

test("cube/index.mjs: SANDBOX_MODE=docker selects the docker backend", async () => {
  const prev = process.env.SANDBOX_MODE;
  process.env.SANDBOX_MODE = "docker";
  try {
    // Force re-eval of config + reset memoized backend.
    const { resetBackend, getBackend } = await import("./index.mjs");
    const { config } = await import("../config.mjs");
    // config.mode reads at module load; override directly.
    config.mode = "docker";
    resetBackend();
    const backend = getBackend();
    assert.equal(backend.backend, "docker");
  } finally {
    if (prev === undefined) delete process.env.SANDBOX_MODE;
    else process.env.SANDBOX_MODE = prev;
    const { resetBackend } = await import("./index.mjs");
    const { config } = await import("../config.mjs");
    config.mode = prev || "docker";
    resetBackend();
  }
});

// ---- Integration smoke (opt-in, requires Docker daemon + cm-agent-sandbox image) ----

const INTEGRATION = process.env.DOCKER_INTEGRATION === "1";

test("integration: docker daemon round-trip (create → exec → destroy)", { skip: !INTEGRATION }, async () => {
  const client = createDockerClient({
    image: process.env.SANDBOX_DOCKER_IMAGE || "cm-agent-sandbox:weed-mount",
  });

  const out = await client.createSandbox({
    userId: "smoke",
    sessionId: "smoke-sess",
    workspaceMountPath: "/mnt/agent-fs/smoke/sess",
  });

  try {
    const handle = await client.execProcess(out.sandboxId, {
      kind: "bash",
      command: "echo hello-from-sandbox",
    });
    const chunks = [];
    await new Promise((resolve, reject) => {
      handle.on("stdout", (c) => chunks.push(c));
      handle.on("exit", resolve);
      handle.on("error", reject);
    });
    const text = Buffer.concat(chunks).toString("utf8").trim();
    assert.equal(text, "hello-from-sandbox");
  } finally {
    await client.destroySandbox(out.sandboxId);
  }
});

// ---- container hardening (pids / caps / storage quota / no-new-privileges) ----
//
// Every expectation below is anchored to a measurement taken against the live
// host + the real cm-agent-sandbox:weed-mount image on 2026-09-05 (docker
// 29.1.3, containerd `overlayfs` snapshotter, data root on ext4). The image
// runs as USER user (uid 1000) and holds NO effective capabilities
// (`capsh --print` → `Current: =`), so the ONLY thing a capability change can
// affect is the setuid-root binaries in the image (fusermount, mount, umount,
// su, passwd, ...). See docker.mjs for the per-flag rationale.

test("buildDockerRunArgs: --pids-limit is applied (fork-bomb ceiling)", () => {
  const args = buildDockerRunArgs({ image: "x", env: {}, pidsLimit: 512 });
  assert.ok(args.includes("--pids-limit"), "--pids-limit present");
  assert.equal(args[args.indexOf("--pids-limit") + 1], "512");
});

test("buildDockerRunArgs: pidsLimit 0 / undefined → no --pids-limit (explicit opt-out)", () => {
  assert.ok(!buildDockerRunArgs({ image: "x", env: {} }).includes("--pids-limit"));
  assert.ok(!buildDockerRunArgs({ image: "x", env: {}, pidsLimit: 0 }).includes("--pids-limit"));
});

test("buildDockerRunArgs: capDropAll emits --cap-drop ALL and KEEPS --cap-add SYS_ADMIN", () => {
  // MEASURED: `--cap-drop ALL` with no re-add breaks the sandbox —
  //   /usr/bin/fusermount: mount failed: Operation not permitted
  // because setuid-root fusermount inherits an EMPTY bounding set. With
  // SYS_ADMIN re-added the real image mounted /workspace in 200ms.
  const args = buildDockerRunArgs({ image: "x", env: {}, capDropAll: true });
  assert.ok(args.includes("--cap-drop"), "--cap-drop present");
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.equal(args[args.indexOf("--cap-add") + 1], "SYS_ADMIN",
    "SYS_ADMIN must survive the drop or FUSE cannot mount");
});

test("buildDockerRunArgs: capDropAll=false leaves the pre-hardening argv untouched", () => {
  const args = buildDockerRunArgs({ image: "x", env: {}, capDropAll: false });
  assert.ok(!args.includes("--cap-drop"));
});

test("buildDockerRunArgs: noNewPrivileges emits --security-opt no-new-privileges", () => {
  const args = buildDockerRunArgs({ image: "x", env: {}, noNewPrivileges: true });
  const idxs = args.reduce((a, v, i) => (v === "--security-opt" ? [...a, i] : a), []);
  assert.ok(idxs.some((i) => args[i + 1] === "no-new-privileges"));
});

test("buildDockerRunArgs: noNewPrivileges defaults OFF — it BREAKS FUSE on this image", () => {
  // MEASURED: with --security-opt no-new-privileges the real image fails at
  //   /usr/bin/fusermount: mount failed: Operation not permitted
  // The container is uid 1000 and reaches CAP_SYS_ADMIN only through the
  // setuid-root fusermount binary; no_new_privs disables setuid escalation, so
  // /workspace never mounts and EVERY sandbox dies at boot. This test encodes
  // "must not be on unless an operator opts in", not a style preference.
  const args = buildDockerRunArgs({ image: "x", env: {} });
  const idxs = args.reduce((a, v, i) => (v === "--security-opt" ? [...a, i] : a), []);
  assert.ok(!idxs.some((i) => args[i + 1] === "no-new-privileges"));
});

test("buildDockerRunArgs: storageSizeGb emits --storage-opt size=", () => {
  const args = buildDockerRunArgs({ image: "x", env: {}, storageSizeGb: 20 });
  assert.ok(args.includes("--storage-opt"));
  assert.equal(args[args.indexOf("--storage-opt") + 1], "size=20G");
});

test("buildDockerRunArgs: no storageSizeGb → no --storage-opt", () => {
  assert.ok(!buildDockerRunArgs({ image: "x", env: {} }).includes("--storage-opt"));
});

test("storageQuotaSupported: only drivers that ENFORCE a rootfs quota", () => {
  // MEASURED on this host: driver `overlayfs` (containerd snapshotter), data
  // root on ext4. `docker run --storage-opt size=16M` exits 0 and the value is
  // recorded in HostConfig.StorageOpt, but a container then wrote a 64MB file
  // into its rootfs and `df /` reported the full 990G host filesystem. The flag
  // is ACCEPTED AND SILENTLY IGNORED — shipping it here would be a disk cap
  // that caps nothing, so we must not pretend it applies.
  assert.equal(storageQuotaSupported("overlayfs"), false, "containerd overlayfs snapshotter: not enforced");
  assert.equal(storageQuotaSupported("overlay2"), false, "overlay2 needs xfs+pquota, which we cannot detect from the driver name alone");
  assert.equal(storageQuotaSupported("btrfs"), true);
  assert.equal(storageQuotaSupported("zfs"), true);
  assert.equal(storageQuotaSupported("devicemapper"), true);
  assert.equal(storageQuotaSupported(""), false);
  assert.equal(storageQuotaSupported(undefined), false);
});

test("createSandbox: applies pids-limit + cap-drop by DEFAULT (safe-by-default, no env set)", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner });
  await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/u-1/p-1" });
  const run = calls.find((c) => c.args[0] === "run");
  assert.equal(run.args[run.args.indexOf("--pids-limit") + 1], "512");
  assert.equal(run.args[run.args.indexOf("--cap-drop") + 1], "ALL");
  assert.equal(run.args[run.args.indexOf("--cap-add") + 1], "SYS_ADMIN");
});

test("createSandbox: SKIPS --storage-opt when the daemon driver cannot enforce it", async () => {
  const calls = [];
  const runner = async (args) => {
    calls.push({ args: [...args] });
    if (args[0] === "info") return "overlayfs";
    if (args[0] === "run") return "cid-1\n";
    return "";
  };
  const client = createDockerClient({ dockerRunner: runner, defaultStorageSizeGb: 20 });
  await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/u-1/p-1" });
  const run = calls.find((c) => c.args[0] === "run");
  assert.ok(!run.args.includes("--storage-opt"),
    "a rootfs quota that the driver ignores must not be emitted as if it applied");
});

test("createSandbox: EMITS --storage-opt on a driver that enforces it", async () => {
  const calls = [];
  const runner = async (args) => {
    calls.push({ args: [...args] });
    if (args[0] === "info") return "btrfs";
    if (args[0] === "run") return "cid-1\n";
    return "";
  };
  const client = createDockerClient({ dockerRunner: runner, defaultStorageSizeGb: 20 });
  await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/u-1/p-1" });
  const run = calls.find((c) => c.args[0] === "run");
  assert.equal(run.args[run.args.indexOf("--storage-opt") + 1], "size=20G");
});

test("createSandbox: driver probe is made ONCE and cached across sandboxes", async () => {
  const calls = [];
  const runner = async (args) => {
    calls.push({ args: [...args] });
    if (args[0] === "info") return "btrfs";
    if (args[0] === "run") return "cid\n";
    return "";
  };
  const client = createDockerClient({ dockerRunner: runner, defaultStorageSizeGb: 10 });
  await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/u/p1" });
  await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/u/p2" });
  assert.equal(calls.filter((c) => c.args[0] === "info").length, 1);
});

test("createSandbox: a failing driver probe must not break sandbox creation", async () => {
  const calls = [];
  const runner = async (args) => {
    calls.push({ args: [...args] });
    if (args[0] === "info") throw new Error("daemon busy");
    if (args[0] === "run") return "cid\n";
    return "";
  };
  const client = createDockerClient({ dockerRunner: runner, defaultStorageSizeGb: 20 });
  const out = await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/u/p1" });
  assert.ok(out.sandboxId, "sandbox still created");
  const run = calls.find((c) => c.args[0] === "run");
  assert.ok(!run.args.includes("--storage-opt"), "fail closed on the FLAG, open on the sandbox");
});

// ---- S3 credential scoping (buildContainerEnv) ----
//
// MEASURED 2026-09-05. The seaweedfs identity config in container
// uac2-seaweedfs (/etc/seaweedfs/s3.json) holds exactly ONE identity, actions
// ["Admin","Read","Write","List","Tagging"], with no bucket and no prefix
// restriction. That credential was being injected into EVERY sandbox as
// S3_ACCESS_KEY / S3_SECRET_KEY. Proven exploitable: a process inside a real
// cm-agent-sandbox container, given only those two env vars, signed a SigV4
// ListBuckets against the gateway and got back every bucket
// (['agent-fs','cm-agent-artifacts']) — while an unauthenticated request from
// the same container got 403. WORKSPACE_PATH scopes where the agent should
// look; the credential did not scope what it could reach.
//
// Established by reading the image, not the README: the sandbox has NO
// consumer for these vars. entrypoint.sh's only use is re-exporting them as
// AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY "for any tooling that needs them",
// and the image ships no such tooling (aws, s3cmd, mc, rclone, boto3 and any
// aws-sdk are all absent). `weed mount` authenticates to the filer over gRPC,
// not S3 — verified by mounting /workspace successfully against the live filer
// with NO S3 credentials in the environment at all.

test("buildContainerEnv: DEFAULT is today's behaviour — credentials are injected", () => {
  // This default is deliberate and must not be "tidied" to the safe value: the
  // live data path is not being changed in this pass. Flipping it is an
  // operator decision (SANDBOX_S3_CREDENTIALS=omit), not a code cleanup.
  const env = buildContainerEnv({
    callerEnv: {}, bucket: "agent-fs", subpath: "users/u1/workspace",
    s3CredentialMode: "inject",
    s3AccessKey: "AKIAFAKE", s3SecretKey: "shh",
  });
  assert.equal(env.S3_ACCESS_KEY, "AKIAFAKE");
  assert.equal(env.S3_SECRET_KEY, "shh");
});

test("buildContainerEnv: omit mode removes S3 credentials entirely", () => {
  const env = buildContainerEnv({
    callerEnv: {}, bucket: "agent-fs", subpath: "users/u1/workspace",
    s3CredentialMode: "omit",
    s3AccessKey: "AKIAFAKE", s3SecretKey: "shh",
  });
  assert.ok(!("S3_ACCESS_KEY" in env), "S3_ACCESS_KEY must not be present at all");
  assert.ok(!("S3_SECRET_KEY" in env), "S3_SECRET_KEY must not be present at all");
});

test("buildContainerEnv: omit mode still delivers the workspace coordinates + endpoint", () => {
  // The mount must keep working — it uses the filer over gRPC, not S3 auth.
  const env = buildContainerEnv({
    callerEnv: {}, bucket: "agent-fs", subpath: "users/u1/workspace",
    s3CredentialMode: "omit", s3Endpoint: "http://seaweedfs:8333",
    s3AccessKey: "AKIAFAKE", s3SecretKey: "shh",
  });
  assert.equal(env.WORKSPACE_BUCKET, "agent-fs");
  assert.equal(env.WORKSPACE_PATH, "users/u1/workspace");
  assert.equal(env.S3_ENDPOINT, "http://seaweedfs:8333");
});

test("buildContainerEnv: omit mode strips credentials smuggled in via callerEnv", () => {
  // callerEnv is spread first, so without an explicit strip a caller (or a
  // compromised upstream) could reintroduce the very credential we removed.
  const env = buildContainerEnv({
    callerEnv: { S3_ACCESS_KEY: "sneaky", S3_SECRET_KEY: "sneaky", AWS_ACCESS_KEY_ID: "sneaky", AWS_SECRET_ACCESS_KEY: "sneaky" },
    bucket: "b", subpath: "p", s3CredentialMode: "omit",
    s3AccessKey: "AKIAFAKE", s3SecretKey: "shh",
  });
  for (const k of ["S3_ACCESS_KEY", "S3_SECRET_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
    assert.ok(!(k in env), `${k} must be stripped in omit mode`);
  }
});

test("buildContainerEnv: unknown mode fails closed to inject (no silent lockout)", () => {
  // A typo in the env must not silently break every sandbox's tooling; it must
  // behave as today. The dangerous direction is the one we refuse to guess.
  const env = buildContainerEnv({
    callerEnv: {}, bucket: "b", subpath: "p", s3CredentialMode: "wat",
    s3AccessKey: "AKIAFAKE", s3SecretKey: "shh",
  });
  assert.equal(env.S3_ACCESS_KEY, "AKIAFAKE");
});

test("createSandbox: injects S3 credentials by DEFAULT (unchanged live behaviour)", async () => {
  const prevMode = process.env.SANDBOX_S3_CREDENTIALS;
  const prevAk = process.env.WEED_S3_ACCESS_KEY;
  delete process.env.SANDBOX_S3_CREDENTIALS;
  process.env.WEED_S3_ACCESS_KEY = "AKIAFAKE";
  try {
    const { runner, calls } = makeRecorder();
    const client = createDockerClient({ dockerRunner: runner });
    await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/u-1/p-1" });
    const run = calls.find((c) => c.args[0] === "run");
    const envFlags = run.args.filter((_, i) => run.args[i - 1] === "-e");
    assert.ok(envFlags.includes("S3_ACCESS_KEY=AKIAFAKE"));
  } finally {
    if (prevMode === undefined) delete process.env.SANDBOX_S3_CREDENTIALS; else process.env.SANDBOX_S3_CREDENTIALS = prevMode;
    if (prevAk === undefined) delete process.env.WEED_S3_ACCESS_KEY; else process.env.WEED_S3_ACCESS_KEY = prevAk;
  }
});

test("createSandbox: SANDBOX_S3_CREDENTIALS=omit keeps the admin key out of the container", async () => {
  const prevMode = process.env.SANDBOX_S3_CREDENTIALS;
  const prevAk = process.env.WEED_S3_ACCESS_KEY;
  process.env.SANDBOX_S3_CREDENTIALS = "omit";
  process.env.WEED_S3_ACCESS_KEY = "AKIAFAKE";
  try {
    const { runner, calls } = makeRecorder();
    const client = createDockerClient({ dockerRunner: runner });
    await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/u-1/p-1" });
    const run = calls.find((c) => c.args[0] === "run");
    const envFlags = run.args.filter((_, i) => run.args[i - 1] === "-e");
    assert.ok(!envFlags.some((e) => e.startsWith("S3_ACCESS_KEY=")), "no S3_ACCESS_KEY reaches the container");
    assert.ok(!envFlags.some((e) => e.startsWith("S3_SECRET_KEY=")), "no S3_SECRET_KEY reaches the container");
    assert.ok(envFlags.some((e) => e.startsWith("WORKSPACE_BUCKET=")), "workspace coords still delivered");
  } finally {
    if (prevMode === undefined) delete process.env.SANDBOX_S3_CREDENTIALS; else process.env.SANDBOX_S3_CREDENTIALS = prevMode;
    if (prevAk === undefined) delete process.env.WEED_S3_ACCESS_KEY; else process.env.WEED_S3_ACCESS_KEY = prevAk;
  }
});

// ---- networkPolicy: a control that cannot be enforced must not be offered ----
//
// VERIFIED BEFORE THIS CHANGE: `networkPolicy` was destructured in
// createSandbox and copied into `meta`, and `args.push` never saw it. A caller
// asking for `egress_deny` got a container with FULL access to `eve_default`
// (postgres, valkey, the engine, the seaweedfs master/filer/volume) plus a
// metadata field claiming otherwise. The cube backend honours the same field.
// lib/agent-code/permission-gate.ts carries the rule this restores, written
// after the 唯讀 incident: "A control that cannot be enforced should not be
// offered", and "a mode we cannot enforce must not be silently downgraded to
// one that runs."

test("buildDockerRunArgs: no networkPolicy → the configured network, unchanged", () => {
  const args = buildDockerRunArgs({ image: "x", env: {}, network: "eve_default" });
  assert.equal(args[args.indexOf("--network") + 1], "eve_default");
});

test("buildDockerRunArgs: networkPolicy egress_deny → --network none, overriding the shared network", () => {
  const args = buildDockerRunArgs({
    image: "x", env: {}, network: "eve_default", networkPolicy: "egress_deny",
  });
  const idxs = args.reduce((acc, a, i) => (a === "--network" ? [...acc, i] : acc), []);
  assert.equal(idxs.length, 1, "exactly one --network flag");
  assert.equal(args[idxs[0] + 1], "none");
  assert.ok(!args.includes("eve_default"), "the shared network is not also passed");
});

test("buildDockerRunArgs: networkPolicy egress_allow is the explicit unchanged case", () => {
  const args = buildDockerRunArgs({
    image: "x", env: {}, network: "eve_default", networkPolicy: "egress_allow",
  });
  assert.equal(args[args.indexOf("--network") + 1], "eve_default");
});

test("createSandbox: egress_deny is REFUSED in in-guest mount mode instead of silently ignored", async () => {
  // In-guest mode needs a route to the filer to mount /workspace at all, so
  // `--network none` would make every sandbox fail to boot. The old code
  // resolved that by ignoring the request. Refusing is the fail-safe direction:
  // the caller learns their isolation request was not honoured.
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner, workspaceMountMode: "in-guest" });
  await assert.rejects(
    () => client.createSandbox({
      workspaceMountPath: "/mnt/agent-fs/u-1/p-1",
      networkPolicy: "egress_deny",
    }),
    (err) => {
      assert.ok(err instanceof SandboxError);
      assert.equal(err.code, "network_policy_unenforceable");
      return true;
    },
  );
  assert.equal(calls.filter((c) => c.args[0] === "run").length, 0, "no container was started");
});

test("createSandbox: egress_deny IS enforced in host mount mode", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({
    dockerRunner: runner,
    workspaceMountMode: "host",
    hostMount: makeFakeHostMount(),
    network: "eve_default",
  });
  await client.createSandbox({
    workspaceMountPath: "/mnt/agent-fs/u-1/p-1",
    networkPolicy: "egress_deny",
  });
  const run = calls.find((c) => c.args[0] === "run");
  assert.equal(run.args[run.args.indexOf("--network") + 1], "none");
});

// ---- host-side workspace mount (SANDBOX_WORKSPACE_MOUNT=host) ----

function makeFakeHostMount() {
  const acquired = [];
  const released = [];
  return {
    acquired,
    released,
    async acquire({ bucket, subpath }) {
      const mountPath = `/mnt/${bucket}/${subpath}`;
      acquired.push(mountPath);
      return { mountPath, release: () => released.push(mountPath) };
    },
  };
}

test("createSandbox: DEFAULT mount mode is in-guest — no bind mount, FUSE flags intact", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner });
  await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/u-1/p-1" });
  const run = calls.find((c) => c.args[0] === "run");
  assert.ok(!run.args.includes("-v"), "no bind mount by default");
  assert.ok(run.args.includes("--device"), "in-guest mount still gets /dev/fuse");
  assert.ok(!run.args.includes("--entrypoint"), "the image entrypoint still mounts");
});

test("createSandbox: host mount mode bind-mounts the host path at /workspace", async () => {
  const { runner, calls } = makeRecorder();
  const hostMount = makeFakeHostMount();
  const client = createDockerClient({
    dockerRunner: runner, workspaceMountMode: "host", hostMount,
  });
  const out = await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/users/u1/workspace" });
  assert.equal(out.workspaceDir, "/workspace");
  const run = calls.find((c) => c.args[0] === "run");
  const binds = run.args.filter((_, i) => run.args[i - 1] === "-v");
  assert.ok(
    binds.includes("/mnt/agent-fs/users/u1/workspace:/workspace"),
    `expected a /workspace bind, got ${JSON.stringify(binds)}`,
  );
});

test("createSandbox: host mount mode also mounts the durable /snapshots sibling", async () => {
  // The in-guest entrypoint weed-mounts BOTH /workspace and its `.snapshots`
  // sibling. Moving only /workspace to the host would silently downgrade
  // 版本歷史 to ephemeral state — the snapshot store would simply not exist in
  // the container, and snapshotCreate would write into the throwaway rootfs.
  const { runner, calls } = makeRecorder();
  const hostMount = makeFakeHostMount();
  const client = createDockerClient({
    dockerRunner: runner, workspaceMountMode: "host", hostMount,
  });
  await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/users/u1/workspace" });
  assert.deepEqual(hostMount.acquired, [
    "/mnt/agent-fs/users/u1/workspace",
    "/mnt/agent-fs/users/u1/.snapshots",
  ]);
  const run = calls.find((c) => c.args[0] === "run");
  const binds = run.args.filter((_, i) => run.args[i - 1] === "-v");
  assert.ok(binds.includes("/mnt/agent-fs/users/u1/.snapshots:/snapshots"), JSON.stringify(binds));
});

test("createSandbox: a failed snapshot mount degrades snapshots, it does not fail the sandbox", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({
    dockerRunner: runner,
    workspaceMountMode: "host",
    hostMount: {
      calls: 0,
      async acquire({ bucket, subpath }) {
        if (subpath.endsWith("/.snapshots")) throw new SandboxError("host_mount_failed", "nope", 503);
        return { mountPath: `/mnt/${bucket}/${subpath}`, release: () => {} };
      },
    },
  });
  await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/users/u1/workspace" });
  const run = calls.find((c) => c.args[0] === "run");
  const binds = run.args.filter((_, i) => run.args[i - 1] === "-v");
  assert.deepEqual(binds, ["/mnt/agent-fs/users/u1/workspace:/workspace"]);
});

test("createSandbox: host mount mode drops the FUSE grants the guest no longer needs", async () => {
  // The guest does not mount anything any more, so CAP_SYS_ADMIN, /dev/fuse and
  // the apparmor escape are pure attack surface. Measured on this host: an
  // alpine container with --network none, no SYS_ADMIN and no /dev/fuse read
  // AND wrote the bind-mounted workspace, and the write reached the filer.
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({
    dockerRunner: runner, workspaceMountMode: "host", hostMount: makeFakeHostMount(),
  });
  await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/users/u1/workspace" });
  const run = calls.find((c) => c.args[0] === "run");
  assert.ok(!run.args.includes("SYS_ADMIN"), "no --cap-add SYS_ADMIN");
  assert.ok(!run.args.includes("/dev/fuse"), "no --device /dev/fuse");
  assert.ok(!run.args.includes("apparmor:unconfined"), "no apparmor escape");
  assert.ok(run.args.includes("--shm-size"), "chromium still needs /dev/shm");
});

test("createSandbox: host mount mode turns no-new-privileges ON by default", async () => {
  // It BREAKS every in-guest sandbox (setuid fusermount is how uid 1000 reaches
  // CAP_SYS_ADMIN) and is therefore opt-in there. With the mount gone from the
  // guest there is no setuid escalation left to preserve.
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({
    dockerRunner: runner, workspaceMountMode: "host", hostMount: makeFakeHostMount(),
  });
  await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/users/u1/workspace" });
  const run = calls.find((c) => c.args[0] === "run");
  assert.ok(run.args.includes("no-new-privileges"), run.args.join(" "));
});

test("createSandbox: in-guest mode keeps no-new-privileges OFF by default", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner });
  await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/u-1/p-1" });
  const run = calls.find((c) => c.args[0] === "run");
  assert.ok(!run.args.includes("no-new-privileges"), run.args.join(" "));
});

test("createSandbox: host mount mode overrides the mounting entrypoint", async () => {
  // The image entrypoint's first act is `weed mount`. Left in place it would
  // still need the filer, which is the whole thing we are removing.
  const { runner, calls } = makeRecorder();
  const image = "ava-test:explicit-host-mount";
  const client = createDockerClient({
    image, dockerRunner: runner, workspaceMountMode: "host", hostMount: makeFakeHostMount(),
  });
  await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/users/u1/workspace" });
  const run = calls.find((c) => c.args[0] === "run");
  assert.ok(run.args.includes("--entrypoint"), "entrypoint overridden");
  const tail = run.args.slice(run.args.indexOf(image));
  assert.ok(tail.length > 1, "a command follows the image");
});

test("destroySandbox: host mount mode releases the mount hold", async () => {
  const { runner } = makeRecorder();
  const hostMount = makeFakeHostMount();
  const client = createDockerClient({
    dockerRunner: runner, workspaceMountMode: "host", hostMount,
  });
  const out = await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/users/u1/workspace" });
  assert.deepEqual(hostMount.released, []);
  await client.destroySandbox(out.sandboxId);
  assert.deepEqual(hostMount.released, [
    "/mnt/agent-fs/users/u1/workspace",
    "/mnt/agent-fs/users/u1/.snapshots",
  ]);
});

test("createSandbox: host mount mode fails closed when the host mount cannot be taken", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({
    dockerRunner: runner,
    workspaceMountMode: "host",
    hostMount: { async acquire() { throw new SandboxError("host_mount_failed", "nope", 503); } },
  });
  await assert.rejects(
    () => client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/users/u1/workspace" }),
    (err) => err instanceof SandboxError && err.code === "host_mount_failed",
  );
  assert.equal(calls.filter((c) => c.args[0] === "run").length, 0, "no container without a workspace");
});

test("createSandbox: an ISOLATED tenant's snapshots are a sibling, not nested inside the workspace", async () => {
  // A tenant on its own bucket has subpath `workspace` — the bucket root plays
  // the part `users/<id>/` plays in the shared layout. The derivation used to
  // anchor on `/workspace`, which does not match when `workspace` IS the whole
  // subpath, so snapshots landed at `workspace/.snapshots`: inside the
  // workspace, visible to the agent, and outside anything a migration copied.
  // Found by running the migration tool against a real tenant.
  const { runner, calls } = makeRecorder();
  const hostMount = makeFakeHostMount();
  const client = createDockerClient({
    dockerRunner: runner, workspaceMountMode: "host", hostMount,
  });
  await client.createSandbox({ workspaceMountPath: "/mnt/ws-user-u1/workspace" });
  assert.deepEqual(hostMount.acquired, [
    "/mnt/ws-user-u1/workspace",
    "/mnt/ws-user-u1/.snapshots",
  ], JSON.stringify(hostMount.acquired));
  const run = calls.find((c) => c.args[0] === "run");
  const binds = run.args.filter((_, i) => run.args[i - 1] === "-v");
  assert.ok(binds.includes("/mnt/ws-user-u1/.snapshots:/snapshots"), JSON.stringify(binds));
  assert.equal(
    binds.some((b) => b.includes("workspace/.snapshots")),
    false,
    "snapshots must not be nested inside the workspace",
  );
});

// ---- 磁碟：單檔 rlimit ----
//
// 為什麼在這裡而不只在 disk-guard.test.mjs：那一支證明「算得對」，這一支證明
// 「真的送出去了」。宣告了沒人讀的設定值在這個 repo 裡抓到過四次。

test("buildDockerRunArgs: 送出 --ulimit fsize（bytes），因為 --storage-opt 在這台主機無效", () => {
  const args = buildDockerRunArgs({ image: "img", fsizeLimitBytes: 20 * 1024 * 1024 * 1024 });
  const i = args.indexOf("--ulimit");
  assert.ok(i >= 0, "--ulimit 必須出現");
  assert.equal(args[i + 1], `fsize=${20 * 1024 * 1024 * 1024}`);
});

test("buildDockerRunArgs: fsize 為 0 就完全不送那面旗標（0 會被核心當成「一個位元組都不能寫」）", () => {
  const args = buildDockerRunArgs({ image: "img", fsizeLimitBytes: 0 });
  assert.equal(args.includes("--ulimit"), false);
});

test("buildDockerRunArgs: 沒給 fsize 時不送 —— 預設值由 createDockerClient 決定，不是這一層", () => {
  const args = buildDockerRunArgs({ image: "img" });
  assert.equal(args.includes("--ulimit"), false);
});

test("createDockerClient: 預設就送 --ulimit fsize —— 「宣告了沒人讀」在這個 repo 抓到過四次", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner });
  await client.createSandbox({
    userId: "u-fs",
    sessionId: "sess-fs",
    workspaceMountPath: "/mnt/agent-fs/u-fs/sess-fs",
  });
  const runCall = calls.find((c) => c.args[0] === "run");
  const i = runCall.args.indexOf("--ulimit");
  assert.ok(i >= 0, "預設設定下這面旗標必須真的出現在 argv 上");
  assert.match(runCall.args[i + 1], /^fsize=\d+$/);
  assert.ok(Number(runCall.args[i + 1].split("=")[1]) > 0);
});

// ---- 工作區群組（2026-09-26 UAT 第 1 週 B1-D1，P0）----
//
// 上傳的檔與 AI 用 write／edit 寫的檔走 S3，在 filer 上是 uid 0／gid 0、0660，
// 沙盒的 bash（uid 1000）讀不到。修法是主機掛載把 filer gid 0 對應到一個主機上
// 沒有人在的專用 gid（workspace-group.mjs），而沙盒容器用 `--group-add` 加入它 ——
// 這一段證明容器**真的**拿到那個群組。沒有這一面旗標，掛載那一半做完了，沙盒還是
// 讀不到，而且什麼都不會紅：宣告了卻沒有人消費，這個 repo 抓到過四次。

import { DEFAULT_WORKSPACE_GID } from "./workspace-group.mjs";

test("buildDockerRunArgs: groupAdd emits one --group-add per gid", () => {
  const args = buildDockerRunArgs({ image: "img", groupAdd: [2468] });
  const i = args.indexOf("--group-add");
  assert.ok(i >= 0, args.join(" "));
  assert.equal(args[i + 1], "2468");
  assert.ok(i < args.indexOf("img"), "a docker flag, so it must come before the image");
  assert.equal(buildDockerRunArgs({ image: "img" }).includes("--group-add"), false, "absent by default");
});

test("createSandbox: a host-premounted sandbox joins the workspace group by default — B1-D1", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({
    dockerRunner: runner, workspaceMountMode: "host-premounted", hostMount: makeFakeHostMount(),
  });
  await client.createSandbox({ workspaceMountPath: "/mnt/ws-user-u1/workspace" });
  const run = calls.find((c) => c.args[0] === "run");
  const i = run.args.indexOf("--group-add");
  assert.ok(i >= 0, `no --group-add, so S3-written files stay unreadable: ${run.args.join(" ")}`);
  assert.equal(run.args[i + 1], String(DEFAULT_WORKSPACE_GID));
});

test("createSandbox: host mode joins the same group — its per-sandbox mount maps the same gid", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({
    dockerRunner: runner, workspaceMountMode: "host", hostMount: makeFakeHostMount(), workspaceGid: 3001,
  });
  await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/users/u1/workspace" });
  const run = calls.find((c) => c.args[0] === "run");
  assert.equal(run.args[run.args.indexOf("--group-add") + 1], "3001");
});

test("createSandbox: in-guest mode joins no workspace group — its own mount maps the ids inside the guest", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner, workspaceGid: 2468 });
  await client.createSandbox({ workspaceMountPath: "/mnt/agent-fs/u-1/p-1" });
  const run = calls.find((c) => c.args[0] === "run");
  assert.equal(run.args.includes("--group-add"), false, run.args.join(" "));
});

test("createSandbox: a disabled workspace gid adds no group rather than a bogus one", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({
    dockerRunner: runner, workspaceMountMode: "host-premounted", hostMount: makeFakeHostMount(), workspaceGid: null,
  });
  await client.createSandbox({ workspaceMountPath: "/mnt/ws-user-u1/workspace" });
  const run = calls.find((c) => c.args[0] === "run");
  assert.equal(run.args.includes("--group-add"), false, run.args.join(" "));
});
