/**
 * agent-session-relay.test.mjs — L3b：relay 把本機代理會話接出去。
 *
 * 這一支釘的是三件從終端機那條路學到、而且**付過代價**的事：
 *   1. 空 `error` 聽眾（少了它是一次全站中斷，不是一則錯誤）
 *   2. grace 窗（起不來要變成 HTTP 錯誤，不是一個馬上死掉的 session）
 *   3. 後續的 op 用**同一個 invokeId** 當把手（送別的東西，daemon 找不到）
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createRelayClient } from "./relay.mjs";

/**
 * 讓事件迴圈在測試期間活著。
 *
 * **為什麼需要這個：** `openAgentSession` 的 grace timer 有 `unref()`（跟
 * `openTerminal` 一樣，而那是對的 —— 正式環境不該為了一個 1.5 秒的窗把行程
 * 撐開，那裡有 HTTP server 撐著）。而**懸掛的 promise 不會讓事件迴圈活著**，
 * 所以在裸測試裡迴圈會空掉，node 直接說 `Promise resolution is still pending`。
 *
 * 那不是產品缺陷，是測試環境少了正式環境本來就有的東西。所以測試自己撐。
 */
function keepAlive(maxMs = 10_000) {
  const t = setInterval(() => {}, 50);   // 刻意**不** unref
  // **它自己有上限。** 第一版沒有，而我漏了四個 `stop()` → 整個測試檔掛住
  // 120 秒然後被殺掉。一個「忘了收尾就掛住整個套件」的 helper 是在製造
  // 間歇性的紅燈，而那種紅燈下一個人會用重跑來處理。
  const bail = setTimeout(() => clearInterval(t), maxMs);
  bail.unref?.();
  return () => { clearInterval(t); clearTimeout(bail) };
}

/** 一個假的 daemon 登記表 ＋ invoke，讓這一支不用真的機器。 */
function harness({ ops = ["agentSession", "agentSessionInput", "agentSessionClose"], onInvoke } = {}) {
  const calls = [];
  // 長駐的那個 invoke 要**可以被收尾**：node 的測試執行器不接受留著懸掛的
  // promise（`Promise resolution is still pending`），而真實的 session 也總會
  // 結束。所以 harness 給一個握把，每個測試最後自己收。
  let finish = null;
  let onEvent = null;
  const registry = {
    online: () => true,
    supportsOp: (_m, op) => ops.includes(op),
    daemonVersion: () => "0.2.4",
  };
  const invoke = async (frame) => {
    calls.push(frame);
    if (onInvoke) return onInvoke(frame);
    if (frame.op === "agentSession") {
      onEvent = frame.onEvent;
      return new Promise((resolve) => { finish = resolve });
    }
    return { ok: true, output: {} };
  };
  return {
    calls, registry, invoke,
    /** 讓長駐的 agentSession settle。 */
    finishSession: (r) => { if (finish) finish(r) },
    /** 推一個 partial frame 上去（模擬 daemon 送 ACP）。 */
    pushEvent: (ev) => { if (onEvent) onEvent(ev) },
  };
}

test("daemon 沒宣傳 agentSession → 501，而且訊息講得出下一步", async () => {
  const h = harness({ ops: [] });
  const backend = createRelayClient({ invoke: h.invoke, online: h.registry.online, supportsOp: h.registry.supportsOp, daemonVersion: h.registry.daemonVersion });
  const { sandboxId } = await backend.createSandbox({ userId: "u1", sessionId: "sess1", machine: { id: "m1", kind: "local", root: "/tmp/granted" } });
  await assert.rejects(
    () => backend.openAgentSession(sandboxId, { cwd: "/tmp/granted" }),
    (e) => {
      assert.equal(e.status, 501);
      assert.equal(e.code, "local_agent_unsupported");
      // 判斷依據是 ops 而不是版號 —— 版號從 daemon 誕生到今天都沒跟著功能改。
      assert.equal(e.details?.missingOp, "agentSession");
      // 兩種原因（沒更新／沒準備執行環境）都要講到，不然使用者會去做錯的那件事。
      assert.match(e.message, /更新/);
      assert.match(e.message, /300 MB/);
      return true;
    },
  );
});

test("機器離線 → 503，不是 501", async () => {
  // `createSandbox` 自己也檢查 online，所以要**先建再斷線** —— 這正是真實的
  // 順序（使用者開著 session，然後闔上筆電）。
  const h = harness();
  let up = true;
  const backend = createRelayClient({ invoke: h.invoke, online: () => up, supportsOp: h.registry.supportsOp, daemonVersion: h.registry.daemonVersion });
  const { sandboxId } = await backend.createSandbox({ userId: "u1", sessionId: "sess1", machine: { id: "m1", kind: "local", root: "/tmp/granted" } });
  up = false;
  await assert.rejects(
    () => backend.openAgentSession(sandboxId, { cwd: "/tmp/granted" }),
    (e) => { assert.equal(e.status, 503); assert.equal(e.code, "machine_offline"); return true },
  );
});

test("daemon 在 grace 窗內拒絕 → 丟出來，而不是交出一個馬上死掉的 session", async () => {
  // daemon 在 spawn 之前就分級、驗票、檢查 DSH 裝了沒，所以這些都是一個來回
  // 就回得來的。交出一個 handle 然後讓它立刻 exit，使用者看到的是「開起來了
  // 但沒反應」—— 那正是終端機那條路付過代價的形狀。
  // daemon 的碼 → 合約的碼（ERROR_MAP）。狀態碼刻意不同：使用者做得到的
  // 前置條件是 409，而「我們送錯了憑證種類」是 500 —— 把後者變成 4xx 會讓人
  // 去改他自己那邊，而錯在雲端這一側。
  for (const [code, want, status] of [
    ["approval_required", "approval_required", 403],
    ["dsh_not_installed", "local_agent_not_prepared", 409],
    ["model_credential_not_scoped", "model_credential_not_scoped", 500],
    ["agents_at_limit", "local_agent_at_limit", 429],
  ]) {
    const h = harness({ onInvoke: async () => ({ ok: false, output: { error: { code, message: "nope" } } }) });
    const backend = createRelayClient({ invoke: h.invoke, online: h.registry.online, supportsOp: h.registry.supportsOp, daemonVersion: h.registry.daemonVersion });
    const { sandboxId } = await backend.createSandbox({ userId: "u1", sessionId: "sess1", machine: { id: "m1", kind: "local", root: "/tmp/granted" } });
    await assert.rejects(
      () => backend.openAgentSession(sandboxId, { cwd: "/tmp/granted" }),
      (e) => {
        assert.equal(e.code, want, `${code} 應該對到 ${want}`);
        assert.equal(e.status, status, `${code} 的狀態碼應該是 ${status}`);
        // 原始的 daemon 碼要留著 —— 診斷時那是唯一指得出源頭的東西。
        assert.equal(e.details?.machineCode, code);
        return true;
      },
      `${code} 應該變成一個錯誤而不是一個 handle`,
    );
  }
});

test("ACP 訊息原樣往上送，而且不在這一層解釋語意", async () => {
  const stop = keepAlive();
  const h = harness();
  const backend = createRelayClient({ invoke: h.invoke, online: h.registry.online, supportsOp: h.registry.supportsOp, daemonVersion: h.registry.daemonVersion });
  const { sandboxId } = await backend.createSandbox({ userId: "u1", sessionId: "sess1", machine: { id: "m1", kind: "local", root: "/tmp/granted" } });
  const handle = await backend.openAgentSession(sandboxId, { cwd: "/tmp/granted" });
  const seen = [];
  handle.on("acp", (m) => seen.push({ acp: m }));
  handle.on("note", (n) => seen.push({ note: n }));
  h.pushEvent({ agent: { acp: { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } } } });
  h.pushEvent({ agent: { note: "warning: something" } });
  assert.deepEqual(seen, [
    { acp: { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } } },
    { note: "warning: something" },
  ]);
  // `done.then(...)` 在 grace 窗贏的時候仍然懸掛著（那是長駐設計本身），
  // 所以要等它真的收完 —— 不等的話 node 的測試執行器會說
  // `Promise resolution is still pending`，而那不是缺陷，是我沒有收尾。
  const ended = new Promise((r) => handle.on("exit", r));
  h.finishSession({ ok: true, output: { exitCode: 0 } });
  await ended;
  stop();
});

test("send / close 用**同一個 invokeId** 當把手", async () => {
  const stop = keepAlive();
  const h = harness();
  const backend = createRelayClient({ invoke: h.invoke, online: h.registry.online, supportsOp: h.registry.supportsOp, daemonVersion: h.registry.daemonVersion });
  const { sandboxId } = await backend.createSandbox({ userId: "u1", sessionId: "sess1", machine: { id: "m1", kind: "local", root: "/tmp/granted" } });
  const handle = await backend.openAgentSession(sandboxId, { cwd: "/tmp/granted" });
  const openId = h.calls.find((c) => c.op === "agentSession").invokeId;
  assert.equal(handle.sessionId, openId);
  // **聽眾要在 close 之前掛。** `close()` 自己就 emit `exit`，掛在它之後的
  // 聽眾永遠等不到，而症狀是測試被取消（不是失敗）—— 我踩了一次。
  const ended = new Promise((r) => handle.on("exit", r));
  await handle.send({ jsonrpc: "2.0", id: 2, method: "session/prompt" });
  const input = h.calls.find((c) => c.op === "agentSessionInput");
  // 送別的東西（一個本地短標籤）的話，daemon 找不到任何東西，而使用者看到的
  // 是訊息靜靜地消失。
  assert.equal(input.args.sessionId, openId);
  await handle.close();
  assert.equal(h.calls.find((c) => c.op === "agentSessionClose").args.sessionId, openId);
  const info = await ended;
  assert.equal(info.closedByClient, true);
  // 長駐那個 invoke 也要收 —— 不然 `done.then(...)` 懸著。
  h.finishSession({ ok: true, output: { exitCode: 0 } });
  await new Promise((r) => setTimeout(r, 0));
  stop();
});

test("**掛著一個空的 error 聽眾** —— 少了它是一次全站中斷", async () => {
  // 2026-09-08 實測：daemon 拒絕 → `.then()` 裡 emit("error") 沒有聽眾 →
  // sandbox-runtime **整個行程崩潰重啟**，掉的是當下所有連著的機器，
  // 而每一台看到的都是「連線被意外關閉」。
  const stop = keepAlive();
  const h = harness();
  const backend = createRelayClient({ invoke: h.invoke, online: h.registry.online, supportsOp: h.registry.supportsOp, daemonVersion: h.registry.daemonVersion });
  const { sandboxId } = await backend.createSandbox({ userId: "u1", sessionId: "sess1", machine: { id: "m1", kind: "local", root: "/tmp/granted" } });
  const handle = await backend.openAgentSession(sandboxId, { cwd: "/tmp/granted" });
  // 沒有人聽 "error"。讓 done 以失敗 settle —— 這一步不該讓行程死掉。
  const exited = new Promise((r) => handle.on("exit", r));
  h.finishSession({ ok: false, output: { error: { code: "machine_error", message: "late failure" } } });
  const info = await exited;
  assert.equal(info.code, null);
  assert.equal(info.closedByClient, false);
  stop();
});

test("session 結束時從 running 移除 —— 不然取消表會被死掉的 session 佔住", async () => {
  const stop = keepAlive();
  const h = harness();
  const backend = createRelayClient({ invoke: h.invoke, online: h.registry.online, supportsOp: h.registry.supportsOp, daemonVersion: h.registry.daemonVersion });
  const { sandboxId } = await backend.createSandbox({ userId: "u1", sessionId: "sess1", machine: { id: "m1", kind: "local", root: "/tmp/granted" } });
  const handle = await backend.openAgentSession(sandboxId, { cwd: "/tmp/granted" });
  const exited = new Promise((r) => handle.on("exit", r));
  h.finishSession({ ok: true, output: { exitCode: 0, signal: null } });
  const info = await exited;
  assert.equal(info.code, 0);
  stop();
});
