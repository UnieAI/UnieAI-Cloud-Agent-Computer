/**
 * terminal/unattached-reap.test.mjs —— 開好卻從來沒人 attach 的 PTY 要被回收。
 *
 * 跟 reap.test.mjs 是兩件事：那一份管**結束之後**的那一列留多久；這一份管**還活著、
 * 但從沒有人接上過**的（2026-09-30 的孤兒：冷啟動期間開了 3 個、2 個沒人接、也沒人收）。
 *
 * 期限用 40ms 跑（正式是 120 秒）：要驗的是語意 —— 沒接過就關、接過一次就永遠不碰、
 * 計時器會拆 —— 不是那個數字。期限經由 openTerminal 的 `attachDeadlineMs` 注入，
 * 不靠環境變數（這張登記表是模組單例，環境變數只在載入時讀一次，測試改不動）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const {
  openTerminal, attachTerminal, closeTerminal, listTerminals,
  _terminalCount, _hasAttachDeadline, _resetTerminals,
} = await import("./registry.mjs");

const DEADLINE_MS = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeBackend() {
  const handles = [];
  return {
    handles,
    async openTerminal() {
      const h = new EventEmitter();
      h.closes = 0;
      h.write = async () => true;
      h.close = async () => { h.closes += 1; };
      h.resize = async () => true;
      handles.push(h);
      return h;
    },
  };
}

/** attachTerminal 要的最小 SSE response。`disconnect()` 模擬對面走了。 */
function fakeRes() {
  const res = new EventEmitter();
  res.writeHead = () => {};
  res.write = () => true;
  res.on = res.addListener.bind(res);
  res.disconnect = () => res.emit("close");
  return res;
}

/** 截下 log() 寫出的 JSON 行（這個模組的日誌就是 console.log 一行 JSON）。 */
function captureLogs(t) {
  const lines = [];
  t.mock.method(console, "log", (line) => {
    try { lines.push(JSON.parse(String(line))); } catch { /* 不是我們的行 */ }
  });
  return lines;
}

test("從沒 attach 過的終端機，過了期限就被關掉、移出表、並留下紀錄", async (t) => {
  _resetTerminals();
  const lines = captureLogs(t);
  const backend = fakeBackend();
  const { terminalId } = await openTerminal({
    sandboxId: "sb-u1", backend, spec: {}, attachDeadlineMs: DEADLINE_MS,
  });
  assert.equal(_hasAttachDeadline(terminalId), true, "開好就要排期限");

  await sleep(150);

  assert.equal(backend.handles[0].closes, 1, "孤兒 PTY 沒有被關掉 —— 容器裡的 shell 會一直活著");
  assert.equal(_terminalCount(), 0, "紀錄也要移出表");
  assert.equal(_hasAttachDeadline(terminalId), false);
  const line = lines.find((l) => l.event === "terminal.unattached_reaped");
  assert.ok(line, "回收了卻沒有 terminal.unattached_reaped 這一行");
  assert.equal(line.terminalId, terminalId);
  assert.equal(line.sandboxId, "sb-u1");
});

test("attach 過一次、之後斷線的終端機，過了期限也不會被關", async () => {
  _resetTerminals();
  const backend = fakeBackend();
  const { terminalId } = await openTerminal({
    sandboxId: "sb-u2", backend, spec: {}, attachDeadlineMs: DEADLINE_MS,
  });
  const res = fakeRes();
  attachTerminal("sb-u2", terminalId, res);
  res.disconnect();                          // 面板關掉／換 wifi

  await sleep(150);

  assert.equal(backend.handles[0].closes, 0, "用過的終端機被回收了 —— 使用者斷線回來它就不見了");
  assert.equal(listTerminals("sb-u2").length, 1);
  assert.equal(listTerminals("sb-u2")[0].live, true);
});

test("期限前就被關掉：計時器拆掉，再關一次也不出錯、不重複關", async (t) => {
  _resetTerminals();
  const lines = captureLogs(t);
  const backend = fakeBackend();
  const { terminalId } = await openTerminal({
    sandboxId: "sb-u3", backend, spec: {}, attachDeadlineMs: DEADLINE_MS,
  });

  assert.deepEqual(await closeTerminal("sb-u3", terminalId), { closed: true });
  assert.equal(_hasAttachDeadline(terminalId), false, "close 要把期限計時器拆掉");
  assert.deepEqual(await closeTerminal("sb-u3", terminalId), { closed: false }, "第二次 close 要安靜地回 false");

  await sleep(150);

  assert.equal(backend.handles[0].closes, 1, "期限計時器又關了一次");
  assert.equal(lines.some((l) => l.event === "terminal.unattached_reaped"), false);
});

test("自己 exit 的終端機：計時器拆掉，期限不會對它開火", async (t) => {
  _resetTerminals();
  const lines = captureLogs(t);
  const backend = fakeBackend();
  const { terminalId } = await openTerminal({
    sandboxId: "sb-u4", backend, spec: {}, attachDeadlineMs: DEADLINE_MS,
  });

  backend.handles[0].emit("exit", { code: 0 });
  assert.equal(_hasAttachDeadline(terminalId), false, "exit 之後它不是孤兒，是在等寬限期回收");

  await sleep(150);

  assert.equal(backend.handles[0].closes, 0, "已經結束的終端機被期限計時器關了一次");
  assert.equal(lines.some((l) => l.event === "terminal.unattached_reaped"), false);
  assert.equal(listTerminals("sb-u4").length, 1, "結束的那一列還在寬限期裡（那是 reap.test.mjs 管的）");
});

test("期限 <= 0 代表不回收；_resetTerminals 也會拆掉還沒開火的計時器", async () => {
  _resetTerminals();
  const off = fakeBackend();
  const a = await openTerminal({ sandboxId: "sb-u5", backend: off, spec: {}, attachDeadlineMs: 0 });
  assert.equal(_hasAttachDeadline(a.terminalId), false);
  await sleep(80);
  assert.equal(off.handles[0].closes, 0);

  const on = fakeBackend();
  const b = await openTerminal({ sandboxId: "sb-u5", backend: on, spec: {}, attachDeadlineMs: DEADLINE_MS });
  assert.equal(_hasAttachDeadline(b.terminalId), true);
  _resetTerminals();
  assert.equal(_hasAttachDeadline(b.terminalId), false);
  await sleep(120);
  assert.equal(on.handles[0].closes, 0, "reset 之後計時器還在開火");
});
