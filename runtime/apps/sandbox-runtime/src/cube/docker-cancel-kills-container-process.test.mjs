/**
 * **取消／逾時必須把容器裡的行程殺掉 —— 不只是殺掉本機的 `docker exec` 客戶端。**
 *
 * ## 它在修什麼
 *
 * 2026-10-08 盤點量到：`spawnDockerExec` 的 `handle.cancel` 只 `child.kill()`
 * 本機那個 `docker exec` **客戶端**行程。而 `docker exec` 起的行程是
 * containerd-shim 的小孩，不是 CLI 的小孩 —— 殺掉 CLI 之後它照樣活著。實測
 * （alpine，殺掉 exec client 之後）：
 *
 *     --- BEFORE killing the exec client ---  1
 *     --- AFTER  killing the exec client ---  7 sleep 500
 *
 * 而 `processManager.mjs` 隨後回報 `signal: "SIGTERM", error: "killed"`。
 * 於是 `job_kill`／面板的停止鍵／`timeoutMs` 三條路**都說「殺掉了」**，
 * 而 `npm run dev` 那一類行程在容器裡活得好好的，佔著 port 與那 2048MB 額度，
 * 直到整個沙盒被回收。這是「在使用者面前說謊」＋「漏算力」兩件事一起。
 *
 * **對照組就在隔壁**：`cube/ssh.mjs` 的 `remoteKill()` 寫的是
 * `kill -SIG -"$P" || kill -SIG "$P"` —— 先殺整個 process group，拿不到就退回
 * 單一 pid；本機那條也做對了（`tool-host.ts` 的 `detached: OWN_PROCESS_GROUP`
 * ＋ `child-guard.ts` 連 Windows job object 都有）。只有 docker 這條沒做。
 * 所以這不是「沒想到」，是三個後端裡漏了一個。
 *
 * ## 為什麼 `-"$P"` 在 docker 底下有效（量過，不是假設）
 *
 *     $ docker exec <cid> sh -c 'cat /proc/$$/stat | ...'
 *     pid=7 pgid=7 sid=7
 *
 * `docker exec` 的行程自己就是 process group 與 session 的 leader，所以
 * `kill -TERM -$$` 會打到它底下**整棵樹**。退路那一半照 ssh 留著：哪天
 * runtime 換了行為，至少直接那一個還是會死。
 *
 * ## 兩腿，刻意分開
 *
 * A 腿（**永遠跑得動**，不需要 docker）：argv 與 kill 指令是純函式，這裡斷言
 *   它們真的帶著容器端的 pid 檔與 `kill -SIG -"$P"`。這一腿存在的理由是
 *   B 腿在沒有 docker 的機器上會跳過 —— 而「跳過」正是這個缺陷活下來的方式。
 * B 腿（需要真的 docker）：起一個容器、跑一個會留小孩的指令、cancel，然後
 *   **在容器裡 `ps`**。本機沒有 docker 時跳過但大聲吵；`CI` 有值或
 *   `DOCKER_REQUIRED=1` 時是 **FAIL**（照 ava-engine 的 `dsh-required.mjs` 那條規則）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import {
  CONTAINER_RUN_DIR,
  containerExecWrapper,
  containerKillArgs,
  createDockerClient,
} from "./docker.mjs";

const execFile = promisify(execFileCb);

/* ── A 腿：不需要 docker ──────────────────────────────────────────────── */

test("A：exec 的 argv 把容器端的 pid 記下來，而且原本的 argv 一個字都沒變形", () => {
  const wrapper = containerExecWrapper("exec-abc123");
  assert.deepEqual(wrapper.slice(0, 2), ["sh", "-c"]);
  const script = wrapper[2];
  assert.ok(
    script.includes(`${CONTAINER_RUN_DIR}/exec-abc123.pid`),
    `pid 檔要帶 execId，否則兩個同時在跑的指令會互相殺：${script}`,
  );
  assert.match(script, /echo \$\$ >/, "要記的是 wrapper 自己的 pid（$$）");
  // `exec "$0" "$@"` 是這裡唯一能同時做到三件事的寫法：不經過第二層引號
  // （所以使用者指令裡的空白／引號不會被重新剖析）、PID 不變（$$ 記的就是
  // 真正那支指令的 pid）、離開碼直接是指令的離開碼。
  assert.ok(
    script.trim().endsWith('exec "$0" "$@"'),
    `原本的 cmd/args 必須原封不動地接上去（exec "$0" "$@"）：${script}`,
  );
  assert.equal(wrapper.length, 3, "wrapper 自己只占 sh -c <script> 三格");
});

test("A：取消是在容器裡殺整個 process group，拿不到才退回單一 pid", () => {
  const args = containerKillArgs("container-xyz", "exec-abc123", "TERM");
  assert.deepEqual(args.slice(0, 3), ["exec", "container-xyz", "sh"]);
  const script = args[args.length - 1];
  assert.ok(
    script.includes(`${CONTAINER_RUN_DIR}/exec-abc123.pid`),
    "要讀的是這一個 exec 自己的 pid 檔",
  );
  assert.match(script, /kill -TERM -"\$P"/, '先殺整個 process group（-"$P"）');
  assert.match(script, /\|\|\s*kill -TERM "\$P"/, "拿不到 group 要退回單一 pid —— 跟 ssh.mjs 同一條規則");
  // 遠端／容器端腳本永遠 exit 0：非 0 的離開碼就一定來自客戶端（容器不在了、
  // daemon 不理我們），而不是「pid 已經不在了」這種正常情況。
  assert.match(script, /exit 0\s*$/, "腳本自己要 exit 0，否則正常情況會被當成失敗");
});

test("A：KILL 與 TERM 是同一條規則，只是訊號不同", () => {
  const kill = containerKillArgs("c", "exec-1", "KILL")[4];
  assert.match(kill, /kill -KILL -"\$P"/);
  assert.match(kill, /\|\|\s*kill -KILL "\$P"/);
});

/* ── B 腿：需要真的 docker ────────────────────────────────────────────── */

const IMAGE = process.env.DOCKER_CANCEL_TEST_IMAGE || "alpine:latest";

function dockerAvailable() {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      stdio: ["ignore", "ignore", "ignore"], timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

function dockerRequired(env = process.env) {
  if (String(env.DOCKER_REQUIRED ?? "").trim() === "1") return true;
  if (String(env.DOCKER_REQUIRED ?? "").trim() === "0") return false;
  return String(env.CI ?? "").trim() !== "";
}

const HAVE_DOCKER = dockerAvailable();
if (!HAVE_DOCKER) {
  const banner =
    "\n  ⚠ docker-cancel-kills-container-process.test.mjs：這一輪**沒有驗證過取消真的殺掉容器裡的行程**。\n"
    + `    需要一個能跑 ${IMAGE} 的 docker daemon。\n`;
  if (dockerRequired()) console.error(banner + "    CI 下這是 FAIL（CI 有值或 DOCKER_REQUIRED=1）。\n");
  else console.error(banner + "    本機開發放行成 skip。CI 上同樣的狀況是 FAIL。\n");
}

test("B 前置：這一輪真的有 docker 可以用", { skip: HAVE_DOCKER ? false : !dockerRequired() }, () => {
  assert.ok(HAVE_DOCKER, `找不到可用的 docker daemon —— 取消的行為這一輪沒有被驗證過（image ${IMAGE}）`);
});

test(
  "B：cancel 之後容器裡那棵行程樹是乾淨的（連背景小孩一起）",
  { skip: HAVE_DOCKER ? false : "沒有 docker" },
  async (t) => {
    // 一個只有這條測試認得的字串 —— 用它比對 `ps`，不會撞到機器上其他東西。
    const marker = `unieai-cancel-probe-${Date.now()}`;
    // **探針的 sleep 秒數必須跟容器自己的保活 sleep 不一樣。** 第一版兩邊都是
    // `sleep 600`，於是 `ps` 永遠會比到容器的 PID 1（它當然不該死），測試在
    // 修正已經生效之後還是紅的。秒數就是這裡的識別碼：`ps -o args=` 看不到
    // 環境變數，而 busybox 的 `exec` 沒有 `-a` 可以改 argv[0]。
    const PROBE_SLEEP = "7719";
    const KEEPALIVE_SLEEP = "3600";
    let containerId = "";

    t.after(async () => {
      if (containerId) {
        try { await execFile("docker", ["rm", "-f", containerId], { timeout: 30_000 }); } catch { /* 已經不在了 */ }
      }
    });

    const created = await execFile("docker", ["run", "-d", "--rm", IMAGE, "sleep", KEEPALIVE_SLEEP], { timeout: 120_000 });
    containerId = created.stdout.trim();
    assert.ok(containerId, "容器沒起來");

    const client = createDockerClient({ image: IMAGE });
    client._internal.sandboxes.set("sbx-cancel-probe", {
      sandboxId: "sbx-cancel-probe",
      containerId,
      workspaceId: "ws-cancel-probe",
      createdAt: Date.now(),
    });

    // 一個會留下小孩的指令：背景那支才是真正的受害者 —— 殺掉本機客戶端
    // 對它完全沒有作用，而使用者看到的「停止」就是它。
    const handle = await client.execProcess("sbx-cancel-probe", {
      kind: "raw",
      command: "sh",
      args: ["-c", `sleep ${PROBE_SLEEP} & echo ${marker}-ready; wait`],
    });

    // 等到它真的在跑（而不是 sleep 一個猜出來的秒數）。
    await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        if (String(chunk).includes(`${marker}-ready`)) { cleanup(); resolve(); }
      };
      const onExit = () => { cleanup(); reject(new Error("指令還沒開始跑就結束了")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("等不到指令開始跑")); }, 30_000);
      function cleanup() {
        clearTimeout(timer);
        handle.off("stdout", onData);
        handle.off("exit", onExit);
      }
      handle.on("stdout", onData);
      handle.on("exit", onExit);
    });

    const psInContainer = async () => {
      const { stdout } = await execFile("docker", ["exec", containerId, "ps", "-o", "args="], { timeout: 30_000 });
      return stdout.split("\n").map((l) => l.trim())
        .filter((l) => l.includes(marker) || l.includes(`sleep ${PROBE_SLEEP}`));
    };

    // 先證明真的有東西在跑 —— 一條「本來就沒有東西」的測試不會證明任何事。
    const before = await psInContainer();
    assert.ok(
      before.some((l) => l.includes(`sleep ${PROBE_SLEEP}`)),
      `取消之前容器裡應該有行程在跑，實際看到：${JSON.stringify(before)}`,
    );

    handle.cancel();

    // cancel 是「送出訊號」不是「等它死」。給它一小段時間收屍，但用輪詢而不是
    // 一個猜出來的 sleep —— 高負載下固定秒數會變成假紅。
    const deadline = Date.now() + 20_000;
    let after = before;
    while (Date.now() < deadline) {
      after = await psInContainer();
      if (after.length === 0) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    assert.deepEqual(
      after, [],
      "cancel 回報成功，但容器裡的行程還活著 —— 那正是「停止」在使用者面前說謊的樣子。\n"
      + `        還在跑的：${JSON.stringify(after)}`,
    );
  },
);
