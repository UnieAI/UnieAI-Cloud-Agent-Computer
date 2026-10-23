/**
 * terminal/reap.test.mjs —— 結束的終端機要被回收，但不能立刻。
 *
 * 在此之前 `exit` 只把 `live` 翻成 false：紀錄、後端 handle、重播環都留在表上，
 * 而沒有任何東西會把它們拿掉。「開 → 自己 exit → 再開」可以無限重複，這張表
 * 只會單向長大。同一個 runtime 裡的對照組（exec/processManager.mjs 的
 * gcExitedProcesses，掛在 server.mjs 的定期 tick 上）早就在做這件事。
 *
 * 寬限期用 120ms 跑（正式是 5 分鐘，見 registry.mjs 的 REAP_GRACE_MS）：測試要驗的
 * 是**兩段語意都在** —— 結束後還讀得到、過了才不見 —— 不是那個數字本身。
 * 數字跟引擎那一層對不對得上，由 grace-matches-engine.test.mjs 釘。
 */
process.env.AVA_TERMINAL_REAP_GRACE_MS = "120";

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const {
  openTerminal, listTerminals, closeTerminal, writeTerminal,
  _terminalCount, _hasReaper, _resetTerminals,
} = await import("./registry.mjs");

function fakeBackend() {
  const handles = [];
  return {
    handles,
    async openTerminal() {
      const h = new EventEmitter();
      h.write = async () => true;
      h.close = async () => { h.closed = true; };
      h.resize = async () => true;
      handles.push(h);
      return h;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("結束之後還讀得到（寬限期內），寬限期過了才真的不見", async () => {
  _resetTerminals();
  const backend = fakeBackend();
  const { terminalId } = await openTerminal({ sandboxId: "sb-1", backend, spec: { cwd: "/w" } });
  assert.equal(_terminalCount(), 1);

  backend.handles[0].emit("exit", { code: 0 });

  // 寬限期內：面板關掉再打開、換 wifi 重連，都要還能讀到「它是怎麼結束的」。
  const listed = listTerminals("sb-1");
  assert.equal(listed.length, 1, "結束的那一列還在");
  assert.equal(listed[0].live, false);
  assert.equal(listed[0].exit_code, 0);
  assert.equal(_hasReaper(terminalId), true, "回收已經排進去了");
  // 已經結束的還是不收輸入 —— 回收不該把這條規則弄丟。
  await assert.rejects(() => writeTerminal("sb-1", terminalId, "aGk="), /has exited/);

  await sleep(300);

  assert.equal(_terminalCount(), 0, "寬限期過了，紀錄被回收");
  assert.equal(listTerminals("sb-1").length, 0);
  assert.equal(_hasReaper(terminalId), false, "計時器也清掉了");
});

test("反向：還活著的終端機永遠不會被回收器碰到", async () => {
  _resetTerminals();
  const backend = fakeBackend();
  await openTerminal({ sandboxId: "sb-2", backend, spec: {} });

  await sleep(300); // 比寬限期久得多

  assert.equal(_terminalCount(), 1, "沒有 exit 就沒有回收");
  assert.equal(listTerminals("sb-2")[0].live, true);
});

test("主動關掉：紀錄立刻走，計時器不留在記憶體裡多躺一個寬限期", async () => {
  _resetTerminals();
  const backend = fakeBackend();
  const { terminalId } = await openTerminal({ sandboxId: "sb-3", backend, spec: {} });
  backend.handles[0].emit("exit", { code: 1 });
  assert.equal(_hasReaper(terminalId), true);

  await closeTerminal("sb-3", terminalId);

  assert.equal(_terminalCount(), 0);
  assert.equal(_hasReaper(terminalId), false, "close 要把排好的回收拆掉");
});

test("開開關關一整天不會讓這張表長大", async () => {
  _resetTerminals();
  const backend = fakeBackend();
  for (let i = 0; i < 25; i += 1) {
    await openTerminal({ sandboxId: "sb-4", backend, spec: {} });
    backend.handles[i].emit("exit", { code: 0 });
  }
  assert.equal(_terminalCount(), 25, "寬限期內都還在（這是刻意的）");
  await sleep(300);
  assert.equal(_terminalCount(), 0, "然後一列都不剩 —— 這才是修好的樣子");
});
