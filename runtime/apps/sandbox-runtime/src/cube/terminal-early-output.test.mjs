/**
 * terminal-early-output.test.mjs —— 開場的輸出（MOTD ＋ 第一個提示字元）不能掉在 grace 窗裡。
 *
 * 2026-10-02 實測（線上引擎映像＋真的 daemon）：開一個地端終端機，黑框是空的，要打字之後才看到提示字元。
 * `relay.openTerminal` 先等 `LONG_LIVED_START_GRACE_MS`（1.5 秒）確認 daemon 沒有拒絕，之後才把 handle 交給
 * terminal/registry.mjs，registry 才 `handle.on("data")`。daemon 在那 1.5 秒內推回來的 PTY 位元組，打在一個
 * 沒有 data 聽眾的 EventEmitter 上 —— 直接掉了。registry 的「開場重播環」只蓋 POST→GET 那一個來回，
 * 蓋不到這一段，因為這一段在它**接上之前**。
 *
 * 修法在 handle 這一層：第一個 data 聽眾出現之前先存起來（有上限），聽眾一掛上就補發。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createRelayClient } from "./relay.mjs";

function keepAlive(maxMs = 15_000) {
  const t = setInterval(() => {}, 50);
  const bail = setTimeout(() => clearInterval(t), maxMs);
  bail.unref?.();
  return () => { clearInterval(t); clearTimeout(bail); };
}

function harness() {
  let onEvent = null;
  let finish = null;
  const invoke = async (frame) => {
    if (frame.op === "terminalOpen") {
      onEvent = frame.onEvent;
      return new Promise((resolve) => { finish = resolve; });
    }
    return { ok: true, output: {} };
  };
  return {
    invoke,
    online: () => true,
    supportsOp: () => true,
    daemonVersion: () => "0.2.27",
    /** daemon 推回一段 PTY 輸出（base64，跟協定一樣）。 */
    pty: (text) => onEvent?.({ dataBase64: Buffer.from(text).toString("base64") }),
    exit: () => finish?.({ ok: true, output: { exit: { code: 0 } } }),
  };
}

async function open(h) {
  const backend = createRelayClient({ invoke: h.invoke, online: h.online, supportsOp: h.supportsOp, daemonVersion: h.daemonVersion });
  const { sandboxId } = await backend.createSandbox({ userId: "u1", sessionId: "s1", machine: { id: "m1", kind: "local", root: "/tmp/granted" } });
  return { backend, sandboxId };
}

test("grace 窗內 daemon 推回來的輸出：聽眾一掛上就補發，內容與順序不變", async () => {
  const stop = keepAlive();
  const h = harness();
  const { backend, sandboxId } = await open(h);
  const opening = backend.openTerminal(sandboxId, { cwd: "/tmp/granted", cols: 80, rows: 24 });
  // 開場：shell 在 grace 窗內印了 MOTD 與第一個提示字元。
  await new Promise((r) => setTimeout(r, 30));
  h.pty("Welcome to roy-macbook\r\n");
  h.pty("roy@mac:~$ ");
  const handle = await opening;
  const seen = [];
  handle.on("data", (buf) => seen.push(Buffer.from(buf).toString("utf8")));
  assert.equal(seen.join(""), "Welcome to roy-macbook\r\nroy@mac:~$ ", "開場輸出整段遺失 —— 使用者看到的是一個空的黑框");
  // 之後的輸出照常即時送，不重複補發。
  h.pty("echo hi\r\n");
  assert.equal(seen.join(""), "Welcome to roy-macbook\r\nroy@mac:~$ echo hi\r\n");
  h.exit();
  stop();
});

test("聽眾掛上之後的輸出不會被存起來又補發第二次", async () => {
  const stop = keepAlive();
  const h = harness();
  const { backend, sandboxId } = await open(h);
  const opening = backend.openTerminal(sandboxId, { cwd: "/tmp/granted" });
  await new Promise((r) => setTimeout(r, 30));
  const handle = await opening;
  const first = [];
  handle.on("data", (buf) => first.push(Buffer.from(buf).toString()));
  h.pty("A");
  const second = [];
  handle.on("data", (buf) => second.push(Buffer.from(buf).toString()));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(first, ["A"]);
  assert.deepEqual(second, [], "第二個聽眾不該收到已經交給第一個的開場輸出");
  h.exit();
  stop();
});

test("開場輸出有上限（64 KB）：沒有人接上的終端機不能無限吃記憶體，留下的是最後那一段", async () => {
  const stop = keepAlive();
  const h = harness();
  const { backend, sandboxId } = await open(h);
  const opening = backend.openTerminal(sandboxId, { cwd: "/tmp/granted" });
  await new Promise((r) => setTimeout(r, 30));
  for (let i = 0; i < 100; i++) h.pty(`${String(i).padStart(3, "0")}${"x".repeat(1021)}`); // 100 × 1 KB
  const handle = await opening;
  const seen = [];
  handle.on("data", (buf) => seen.push(Buffer.from(buf).toString()));
  await new Promise((r) => setImmediate(r));
  const total = seen.reduce((n, s) => n + s.length, 0);
  assert.ok(total <= 64 * 1024, `補發了 ${total} 位元組，超過上限`);
  assert.ok(seen.at(-1).startsWith("099"), "留下的應該是最後的輸出，不是最早的");
  h.exit();
  stop();
});

test("補發一定排在之後的即時輸出之前（聽眾剛掛上、下一個位元組馬上到也不亂序）", async () => {
  const stop = keepAlive();
  const h = harness();
  const { backend, sandboxId } = await open(h);
  const opening = backend.openTerminal(sandboxId, { cwd: "/tmp/granted" });
  await new Promise((r) => setTimeout(r, 30));
  h.pty("EARLY-");
  const handle = await opening;
  const seen = [];
  handle.on("data", (buf) => seen.push(Buffer.from(buf).toString()));
  h.pty("LIVE");            // 同一個 tick 內
  assert.equal(seen.join(""), "EARLY-LIVE");
  h.exit();
  stop();
});
