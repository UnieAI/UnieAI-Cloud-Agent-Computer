/**
 * registry.test.mjs — relay registry invoke/result correlation, keyed by
 * machineId. No HTTP: drives registry.mjs directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  registerMachineConnection,
  setMachineInfo,
  getMachineConnection,
  isMachineOnline,
  invoke,
  resolveInvocation,
  closeConnection,
  _resetForTest,
} from "./registry.mjs";

function connect(machineId, userId = "u1") {
  const sent = [];
  const conn = registerMachineConnection({ machineId, userId, send: (frame) => sent.push(frame) });
  return { conn, sent };
}

test("invoke → result correlates by id and returns the daemon output", async () => {
  _resetForTest();
  const { conn, sent } = connect("m1");
  const p = invoke({ machineId: "m1", op: "readFile", args: { path: "a.txt" }, timeoutMs: 1000 });
  const frame = sent.at(-1);
  assert.equal(frame.type, "invoke");
  assert.equal(frame.op, "readFile");
  assert.equal(resolveInvocation({ machineId: "m1", id: frame.id, ok: true, output: { contentBase64: "aGk=" } }), true);
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.output.contentBase64, "aGk=");
  assert.equal(conn.pending.size, 0);
});

test("a machine that is not connected answers machine_offline without rejecting", async () => {
  _resetForTest();
  const r = await invoke({ machineId: "nope", op: "exec", args: { command: "ls" }, timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.output.error.code, "machine_offline");
});

test("an invocation times out into a retryable structured error", async () => {
  _resetForTest();
  connect("m2");
  const r = await invoke({ machineId: "m2", op: "exec", args: { command: "sleep 9" }, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.output.error.code, "machine_timeout");
  assert.equal(r.output.error.retryable, true);
});

test("partial results stream to onEvent and reset the idle timer; the final result resolves", async () => {
  _resetForTest();
  const { sent } = connect("m3");
  const events = [];
  const p = invoke({
    machineId: "m3", op: "exec", args: { command: "npm test" }, timeoutMs: 60, onEvent: (e) => events.push(e),
  });
  const id = sent.at(-1).id;
  await new Promise((r) => setTimeout(r, 40));
  resolveInvocation({ machineId: "m3", id, ok: true, partial: true, output: { stream: "stdout", data: "one\n" } });
  await new Promise((r) => setTimeout(r, 40));
  resolveInvocation({ machineId: "m3", id, ok: true, partial: true, output: { stream: "stderr", data: "warn\n" } });
  resolveInvocation({ machineId: "m3", id, ok: true, output: { exit: { code: 0, signal: null } } });
  const r = await p;
  assert.equal(r.ok, true, "partials kept the invocation alive past the idle timeout");
  assert.deepEqual(events.map((e) => e.stream), ["stdout", "stderr"]);
  assert.equal(r.output.exit.code, 0);
});

test("closing a connection fails every in-flight invocation and marks the machine offline", async () => {
  _resetForTest();
  const { conn } = connect("m4");
  const p = invoke({ machineId: "m4", op: "exec", args: { command: "x" }, timeoutMs: 5000 });
  closeConnection(conn, "test");
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.output.error.code, "machine_disconnected");
  assert.equal(isMachineOnline("m4"), false);
});

test("hello records machine info; a newer connection for the same machine supersedes the old one", () => {
  _resetForTest();
  const first = connect("m5");
  setMachineInfo(first.conn, { platform: "linux", arch: "x64", daemonVersion: "0.1.0", grantedRoot: "/w" }, ["exec"]);
  assert.equal(getMachineConnection("m5").info.platform, "linux");
  const second = connect("m5");
  assert.equal(first.conn.closed, true);
  assert.equal(getMachineConnection("m5"), second.conn);
});

test("a result for an unknown invocation id or another machine is ignored", () => {
  _resetForTest();
  const { sent } = connect("m6");
  connect("m7");
  invoke({ machineId: "m6", op: "statFile", args: { path: "x" }, timeoutMs: 1000 });
  const id = sent.at(-1).id;
  assert.equal(resolveInvocation({ machineId: "m7", id, ok: true, output: {} }), false);
  assert.equal(resolveInvocation({ machineId: "m6", id: "nope", ok: true, output: {} }), false);
  assert.equal(resolveInvocation({ machineId: "m6", id, ok: true, output: {} }), true);
});

/**
 * ── 輸出比「跑完了」晚到 ────────────────────────────────────────────────────
 *
 * daemon 把輸出與結果分兩發獨立的 HTTP 送回來（`ava-local/src/transport.ts`：
 * partial 是 `void post(...)` 射後不理，最終結果是 `await post(...)`），兩發之間
 * 沒有順序保證。指令越快、結果那一發越容易超車。
 *
 * 2026-09-06 在 roy-linux-box 上直接打這一層重現：連五次 `echo`，兩次 stdout
 * 整個不見、exit 照樣 0。使用者那端看到的是「指令跑完了，什麼都沒印」，
 * 而模型會開始猜環境。
 */
test("結果先到、輸出後到 —— 輸出照樣送得出去，而且順序不變", async () => {
  _resetForTest();
  const { sent } = connect("m-late");
  const seen = [];
  const p = invoke({
    machineId: "m-late", op: "exec", args: { command: "echo hi" }, timeoutMs: 5000,
    onEvent: (ev) => seen.push(ev),
  });
  const id = sent.at(-1).id;

  // 結果超車：exit 先到。
  assert.equal(resolveInvocation({ machineId: "m-late", id, ok: true, output: { exit: { code: 0 } } }), true);
  // 輸出隨後才到 —— 以前這裡的 pending 已經被刪掉，這一段就掉了。
  assert.equal(resolveInvocation({ machineId: "m-late", id, ok: true, partial: true, output: { stream: "stdout", data: "hi\n" } }), true);
  assert.equal(resolveInvocation({ machineId: "m-late", id, ok: true, partial: true, output: { stream: "stderr", data: "warn\n" } }), true);

  const r = await p;
  assert.deepEqual(r, { ok: true, output: { exit: { code: 0 } } }, "最終結果不能被寬限窗改掉");
  assert.deepEqual(seen, [
    { stream: "stdout", data: "hi\n" },
    { stream: "stderr", data: "warn\n" },
  ], "順序變了或少了一段 —— 使用者看到的輸出就是錯的");
});

test("沒有輸出串流的呼叫不必等 —— 檔案操作照舊立刻結算", async () => {
  _resetForTest();
  const { sent } = connect("m-file");
  const started = Date.now();
  const p = invoke({ machineId: "m-file", op: "readFile", args: { path: "a" }, timeoutMs: 5000 });
  const id = sent.at(-1).id;
  resolveInvocation({ machineId: "m-file", id, ok: true, output: { contentBase64: "aGk=" } });
  await p;
  // 寬限窗預設 120ms；檔案操作沒有 onEvent，所以不該付那個延遲。
  assert.ok(Date.now() - started < 100, `檔案操作被寬限窗拖慢了：${Date.now() - started}ms`);
});

test("窗關了之後才到的輸出：丟掉，但要留下痕跡", async () => {
  _resetForTest();
  const { sent } = connect("m-toolate");
  const p = invoke({
    machineId: "m-toolate", op: "exec", args: { command: "echo hi" }, timeoutMs: 5000,
    onEvent: () => { throw new Error("窗已經關了，不該再送出去") },
  });
  const id = sent.at(-1).id;
  resolveInvocation({ machineId: "m-toolate", id, ok: true, output: { exit: { code: 0 } } });
  await p;   // 窗關了
  // 回 false ＝ 沒有歸屬。呼叫端因此知道「這一段真的掉了」，而 registry 會記一行
  // `relay.late_output_dropped` —— 這條 bug 活這麼久就是因為它從頭到尾不出聲。
  assert.equal(
    resolveInvocation({ machineId: "m-toolate", id, ok: true, partial: true, output: { stream: "stdout", data: "hi\n" } }),
    false,
  );
});

test("等輸出的時候連線斷了 —— 結果已經在手上，不可以改寫成「機器斷線」", async () => {
  _resetForTest();
  const { conn, sent } = connect("m-drop");
  const p = invoke({
    machineId: "m-drop", op: "exec", args: { command: "echo hi" }, timeoutMs: 5000,
    onEvent: () => {},
  });
  const id = sent.at(-1).id;
  resolveInvocation({ machineId: "m-drop", id, ok: true, output: { exit: { code: 0 } } });
  closeConnection(conn, "test");
  const r = await p;
  assert.deepEqual(r, { ok: true, output: { exit: { code: 0 } } },
    "一條跑完的指令被說成失敗 —— 而使用者的檔案已經改了");
});
