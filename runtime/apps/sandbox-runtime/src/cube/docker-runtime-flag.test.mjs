/**
 * cube/docker-runtime-flag.test.mjs — SANDBOX_DOCKER_RUNTIME 這個接縫的測試。
 *
 * 為什麼盯 argv 而不是盯設定值：這個 repo 已經被「宣告了但沒有人呼叫」咬過好幾次
 * （networkPolicy 曾經被讀進 meta 卻從來沒進 args.push，見 docker.mjs 的
 * network policy 註解）。一個只斷言 config.dockerRuntime === "runsc" 的測試，在
 * 旗標根本沒接上 docker 指令的情況下一樣會綠。所以這裡每一條都拆真正送給 docker
 * 的那個陣列。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

import { buildDockerRunArgs, createDockerClient } from "./docker.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../../..");

/** --runtime 在 argv 裡的位置；-1 代表沒有。 */
function runtimeFlagIndex(args) {
  return args.findIndex((a) => a === "--runtime" || a.startsWith("--runtime="));
}

// ---- 沒設定＝一個位元組都不變 ----

test("buildDockerRunArgs: 沒給 runtime → argv 裡完全沒有 --runtime", () => {
  const args = buildDockerRunArgs({ image: "cm-agent-sandbox:weed-mount", env: {} });
  assert.equal(runtimeFlagIndex(args), -1);
});

test("buildDockerRunArgs: runtime 是空字串／空白 → 一樣沒有 --runtime", () => {
  for (const blank of ["", "   ", null, undefined]) {
    const args = buildDockerRunArgs({ image: "x", env: {}, runtime: blank });
    assert.equal(runtimeFlagIndex(args), -1, `blank=${JSON.stringify(blank)}`);
  }
});

// ---- 設了合法值 ----

test("buildDockerRunArgs: 合法 runtime → --runtime=<值> 出現在旗標區（image 之前）", () => {
  const args = buildDockerRunArgs({ image: "cm-agent-sandbox:weed-mount", env: {}, runtime: "runsc" });
  const at = runtimeFlagIndex(args);
  assert.notEqual(at, -1, "--runtime 必須真的出現在 argv 裡");
  assert.equal(args[at], "--runtime=runsc");
  // 位置正確性：run 子命令之後、image 之前。放到 image 後面的話 docker 會把它
  // 當成容器裡要執行的參數，旗標靜靜失效 —— 那正是這條斷言要擋的事。
  assert.equal(args[0], "run");
  assert.ok(at > 0, "不能蓋掉 run 子命令");
  assert.ok(at < args.indexOf("cm-agent-sandbox:weed-mount"), "--runtime 必須在 image 之前");
});

test("buildDockerRunArgs: 其他 runtime 名稱（kata-runtime / crun / 帶點帶底線）照樣通過", () => {
  for (const name of ["kata-runtime", "crun", "io.containerd.runsc.v1", "my_runtime2"]) {
    const args = buildDockerRunArgs({ image: "x", env: {}, runtime: name });
    assert.ok(args.includes(`--runtime=${name}`), `${name} 應該被接受`);
  }
});

// ---- 不合法的值＝當成沒設 ----

test("buildDockerRunArgs: 含分號／空白／引號／斜線的值 → argv 裡沒有 --runtime", () => {
  const hostile = [
    "runsc; rm -rf /",
    "runsc --privileged",
    "runsc\ttab",
    'runsc"quoted"',
    "runsc'quoted'",
    "run sc",
    "$(id)",
    "`id`",
    "--privileged",
    "/usr/local/bin/runsc",
    "runsc\nrunc",
    "runsc|runc",
  ];
  for (const value of hostile) {
    const args = buildDockerRunArgs({ image: "x", env: {}, runtime: value });
    assert.equal(runtimeFlagIndex(args), -1, `${JSON.stringify(value)} 不該進到 argv`);
    // 更強的一條：那段字串不該以任何形式出現在指令裡。
    assert.ok(
      !args.some((a) => a.includes(value.trim())),
      `${JSON.stringify(value)} 完全不該出現在 argv 裡`,
    );
  }
});

// ---- 真的有接到 createSandbox 這條路上 ----

function makeRecorder() {
  const calls = [];
  const runner = async (args) => {
    calls.push([...args]);
    return args[0] === "run" ? "container-abc123def456\n" : "";
  };
  return { runner, calls };
}

test("createSandbox: 設了 dockerRuntime → 真正送出的 docker run argv 帶著 --runtime", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner, dockerRuntime: "runsc" });

  await client.createSandbox({
    userId: "u-1",
    sessionId: "sess-1",
    workspaceMountPath: "/mnt/agent-fs/u-1/p-foo",
  });

  const runCall = calls.find((c) => c[0] === "run");
  assert.ok(runCall, "docker run 有被呼叫");
  assert.ok(runCall.includes("--runtime=runsc"));
  // image 是 `docker run` 的最後一個參數。不能拿字面的 tag 去找：機器上有 cm-agent-sandbox:weed-mount 這個映像時，
  // image-pin 會把它換成 `sha256:…`（lastIndexOf 回 -1，於是這條只在沒裝映像的機器上才綠）。
  assert.ok(
    runtimeFlagIndex(runCall) > -1 && runtimeFlagIndex(runCall) < runCall.length - 1,
    "--runtime 在 image 之前（image 是最後一個參數）",
  );
});

test("createSandbox: 沒設 dockerRuntime → argv 與改動之前一模一樣（沒有 --runtime）", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner, dockerRuntime: "" });

  await client.createSandbox({
    userId: "u-2",
    sessionId: "sess-2",
    workspaceMountPath: "/mnt/agent-fs/u-2/p-foo",
  });

  const runCall = calls.find((c) => c[0] === "run");
  assert.ok(runCall);
  assert.equal(runtimeFlagIndex(runCall), -1);
});

test("createSandbox: 不合法的 dockerRuntime → 照樣開得起來，但沒有 --runtime", async () => {
  const { runner, calls } = makeRecorder();
  const client = createDockerClient({ dockerRunner: runner, dockerRuntime: "runsc; id" });

  await client.createSandbox({
    userId: "u-3",
    sessionId: "sess-3",
    workspaceMountPath: "/mnt/agent-fs/u-3/p-foo",
  });

  const runCall = calls.find((c) => c[0] === "run");
  assert.ok(runCall);
  assert.equal(runtimeFlagIndex(runCall), -1);
  assert.ok(!runCall.some((a) => a.includes("runsc")));
});

// ---- env 變數的名字本身 ----
//
// config.mjs 在 module-init 讀 env，同一個行程裡改 process.env 已經來不及，所以
// 這一條開子行程跑。它擋的是「旗標接對了、但 env 變數名字打錯」這種只有真的從
// 環境變數走一次才看得到的斷線。

async function argvWithEnv(env) {
  const script = `
    const { createDockerClient } = await import("./runtime/apps/sandbox-runtime/src/cube/docker.mjs");
    const calls = [];
    const client = createDockerClient({
      dockerRunner: async (args) => { calls.push([...args]); return args[0] === "run" ? "cid\\n" : ""; },
    });
    await client.createSandbox({
      userId: "u-env", sessionId: "sess-env",
      workspaceMountPath: "/mnt/agent-fs/u-env/p-foo",
    });
    console.log("ARGV:" + JSON.stringify(calls.find((c) => c[0] === "run")));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: REPO_ROOT, env: { ...process.env, ...env } },
  );
  const line = stdout.split("\n").find((l) => l.startsWith("ARGV:"));
  return JSON.parse(line.slice("ARGV:".length));
}

test("SANDBOX_DOCKER_RUNTIME=runsc → docker run argv 帶 --runtime=runsc", async () => {
  const args = await argvWithEnv({ SANDBOX_DOCKER_RUNTIME: "runsc" });
  assert.ok(args.includes("--runtime=runsc"));
});

test("SANDBOX_DOCKER_RUNTIME 未設 → docker run argv 沒有 --runtime", async () => {
  const args = await argvWithEnv({ SANDBOX_DOCKER_RUNTIME: "" });
  assert.equal(runtimeFlagIndex(args), -1);
});

test("SANDBOX_DOCKER_RUNTIME 帶注入字元 → docker run argv 沒有 --runtime", async () => {
  const args = await argvWithEnv({ SANDBOX_DOCKER_RUNTIME: "runsc; touch /tmp/pwned" });
  assert.equal(runtimeFlagIndex(args), -1);
  assert.ok(!args.some((a) => a.includes("pwned")));
});
