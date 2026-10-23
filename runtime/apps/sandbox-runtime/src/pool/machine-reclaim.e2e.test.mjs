/**
 * pool/machine-reclaim.e2e.test.mjs —— 綁在使用者機器上的那一列，怎麼失效。
 *
 * **這一支是端到端的，不是 stub 對 stub。** 它 import 真正的 `server.mjs`（真的
 * 路由表、真的 internal-token 驗證、真的 1 秒回收器），在一個臨時埠上聽，然後
 * 全部用 HTTP 驅動：
 *
 *   daemon  ──GET  /v1/relay/connect───────────►  真的 SSE，真的 relay/registry
 *   app     ──POST /v1/sandboxes { machine }──►  真的 pool/manager ＋ 真的 cube/relay 後端
 *   app     ──POST /v1/relay/machines/:id/revoke
 *   app     ──GET  /v1/sandboxes──────────────►  那一列還在不在
 *
 * 唯一假的是 daemon 本身（一段 fetch），而那本來就是對面那台電腦。
 *
 * 為什麼要有這一支：這兩條鏈都跨層，而**兩層各自都是綠的**——
 *   · 撤銷：app 停用 DB 那一列（綠），runtime 關掉 relay 連線（綠），
 *     但 runtime 的沙盒池從頭到尾沒被通知過。
 *   · 斷線：daemon 掉線（綠），registry 刪掉連線（綠），
 *     而池裡那一列永遠留著，還計入總量。
 * 只在單層測，這兩個洞都測不出來。
 *
 * 環境變數在 import 之前設定：node --test 每個檔案一個子行程，所以這裡的設定
 * 不會外溢到別的測試檔。
 */

// cube 模式：不是為了跑 cube，是為了讓 server.mjs 的開機守門滿意，並且**跳過
// docker 模式的孤兒容器回收** —— 那一步會去 docker ps 然後殺掉容器，在開發機上
// 跑測試絕對不能碰它。機器綁定的分派根本不會走到預設後端。
process.env.SANDBOX_MODE = "cube";
process.env.SANDBOX_PORT = "0";              // 臨時埠，用完就關
process.env.SANDBOX_INTERNAL_TOKEN = "e2e-internal-token";
process.env.SANDBOX_ENFORCE_OWNERSHIP = "";
process.env.SANDBOX_USER_MAX_ACTIVE = "0";
process.env.SANDBOX_POOL_TOTAL_MAX = "100";
// 寬限期 0：測試不等五分鐘。**寬限期本身**由下面 "寬限期沒到就不收" 那條驗。
process.env.SANDBOX_MACHINE_OFFLINE_GRACE_SEC = "0";

import test, { after } from "node:test";
import assert from "node:assert/strict";

const { config } = await import("../config.mjs");
const cube = await import("../cube/index.mjs");
// **唯一的替身，而且只在雲端那條路上。** 機器綁定的分派走的是真的
// `cube/relay.mjs`（`backendForMachine` 挑的），這個假後端只服務最後一條測試裡的
// 雲端分派 —— 那一條問的是「機器綁定的列有沒有吃掉主機的額度」，跟容器怎麼開無關，
// 而真的 cube/docker 後端在測試機上不是開不起來就是會去碰別人的容器。
cube.setBackend({
  createSandbox: async ({ userId, sessionId }) => ({
    sandboxId: `cloud-${Math.random().toString(36).slice(2, 10)}`,
    workspaceId: `ws-${sessionId || "x"}`,
    workspaceDir: "/tmp/e2e",
    userId,
    sessionId,
  }),
  destroySandbox: async () => undefined,
});
const { server, assertSandboxModeSafe } = await import("../server.mjs");
assertSandboxModeSafe();
server.listen(0, "127.0.0.1");
const { startReaper, stopReaper, countMachineSandboxes } = await import("./manager.mjs");
startReaper();

// 這台 runtime 的 enforceOwnership 由部署環境決定，測試不去改它 —— 而是照 app
// 真正的做法送上 on-behalf-of 身分。這樣不論 enforce 開著或關著，這條路都一樣走得通。
const TOKEN = {
  authorization: `Bearer ${process.env.SANDBOX_INTERNAL_TOKEN}`,
  "x-sandbox-user-id": "u-e2e",
};

const base = await new Promise((resolve) => {
  if (server.listening) return resolve(`http://127.0.0.1:${server.address().port}`);
  server.once("listening", () => resolve(`http://127.0.0.1:${server.address().port}`));
});

after(() => {
  stopReaper();
  server.close();
});

/** 一個最小的 daemon：開 SSE、把 frame 排隊、想關就關。 */
async function connectDaemon(machineId, userId = "u-e2e") {
  const res = await fetch(`${base}/v1/relay/connect`, {
    headers: { ...TOKEN, "x-machine-id": machineId, "x-machine-user-id": userId },
  });
  assert.equal(res.status, 200, "daemon 連得上");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const frames = [];
  let ended = false;
  (async () => {
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { ended = true; break; }
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        if (block.startsWith(":")) continue;
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (data) { try { frames.push(JSON.parse(data)); } catch { /* 不是我們要看的 */ } }
      }
    }
  })().catch(() => { ended = true; });
  return {
    frames,
    isEnded: () => ended,
    close: () => reader.cancel().catch(() => {}),
  };
}

const api = (path, init = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...TOKEN, ...(init.headers || {}) } });

async function allocate(machineId, sessionId, userId = "u-e2e") {
  const res = await api("/v1/sandboxes", {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      session_id: sessionId,
      workspace_mode: "user",
      machine: { id: machineId, kind: "local", root: "/w" },
    }),
  });
  const body = await res.json();
  assert.equal(res.status < 300, true, `allocate 應該成功，實際 ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function listIds() {
  const res = await api("/v1/sandboxes");
  const body = await res.json();
  return (body.items || []).map((i) => i.sandbox_id || i.sandboxId || i.id);
}

/** 等一個條件成立；到期就把最後看到的狀態講出來（沉默的逾時最難查）。 */
async function until(label, fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) assert.fail(`等不到：${label}（最後一次的值：${JSON.stringify(last)}）`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("撤銷一台機器：連線關掉、池裡那一列放掉、憑證快取忘掉 —— 一趟 HTTP 全做完", async () => {
  const mid = "m-e2e-revoke";
  const daemon = await connectDaemon(mid);
  await until("daemon 收到 ready", () => daemon.frames.some((f) => f.type === "ready"));

  const alloc = await allocate(mid, "s-e2e-revoke");
  const sid = alloc.sandbox_id || alloc.sandboxId;
  assert.ok(String(sid).startsWith("local-"), `應該走 relay 後端，實際 ${sid}`);
  assert.equal(countMachineSandboxes(mid), 1, "池裡有一列綁在這台機器上");
  assert.ok((await listIds()).includes(sid), "列表看得到它");

  const rv = await api(`/v1/relay/machines/${mid}/revoke`, {
    method: "POST",
    body: JSON.stringify({ reason: "user clicked remove" }),
  });
  const body = await rv.json();
  // 撤銷要回報三件事。`revoked` 只說了連線那一件 —— 在這個修法之前，
  // 那也是它唯一做的一件。
  assert.equal(body.revoked, true, "連線被關掉");
  assert.equal(body.sandboxes_released, 1, "池裡那一列被放掉");
  assert.equal(typeof body.cert_principals_forgotten, "number", "憑證快取這一件有被回報");

  await until("daemon 收到 revoke frame", () => daemon.frames.some((f) => f.type === "revoke"));
  await until("SSE 收掉", () => daemon.isEnded());
  await until("池裡不再有這台機器的列", async () => countMachineSandboxes(mid) === 0);
  assert.ok(!(await listIds()).includes(sid), "列表上也不見了");
});

test("關掉 Rabi Local：真的回收器（1 秒 tick）會把那一列收掉", async () => {
  const mid = "m-e2e-offline";
  const daemon = await connectDaemon(mid);
  await until("daemon 收到 ready", () => daemon.frames.some((f) => f.type === "ready"));

  const alloc = await allocate(mid, "s-e2e-offline");
  const sid = alloc.sandbox_id || alloc.sandboxId;
  assert.equal(countMachineSandboxes(mid), 1);

  // 使用者關掉 Rabi Local ＝ SSE 斷掉。沒有人打 revoke，沒有人打 DELETE。
  await daemon.close();

  // 這裡**沒有**呼叫任何 `_run…` 測試入口：等的是 server.mjs 開機時
  // `startReaper()` 同一個真的 1 秒計時器（匯入不再啟動全域維護）。
  await until("回收器把那一列收掉", async () => countMachineSandboxes(mid) === 0, 15000);
  assert.ok(!(await listIds()).includes(sid), "列表上不見了");
});

test("反向：daemon 還連著的時候，回收器一列都不能動", async () => {
  const mid = "m-e2e-online";
  const daemon = await connectDaemon(mid);
  await until("daemon 收到 ready", () => daemon.frames.some((f) => f.type === "ready"));
  const alloc = await allocate(mid, "s-e2e-online");
  const sid = alloc.sandbox_id || alloc.sandboxId;

  // 上面那條證明離線 ≤ 15 秒就會被收。這裡讓連著的機器躺同樣久 ——
  // 寬限期是 0，所以差別只可能來自「連線還在」這一件事。
  await new Promise((r) => setTimeout(r, 3000));

  assert.equal(countMachineSandboxes(mid), 1, "連著的機器不該被收");
  assert.ok((await listIds()).includes(sid), "列表上還在");
  await daemon.close();
});

test("容量：機器綁定的登記列不佔主機容量，也不該讓別人拿到「容量滿了」", async () => {
  const mid = "m-e2e-quota";
  const daemon = await connectDaemon(mid);
  await until("daemon 收到 ready", () => daemon.frames.some((f) => f.type === "ready"));

  const before = config.pool.totalMax;
  try {
    // 主機上限壓到 1，然後開一列**機器綁定**的。它跑在使用者自己的電腦上，
    // 這台主機一個位元組都沒少 —— 所以不該把主機的額度吃掉。
    config.pool.totalMax = 1;
    const alloc = await allocate(mid, "s-e2e-quota");
    const sid = alloc.sandbox_id || alloc.sandboxId;
    assert.ok(String(sid).startsWith("local-"));

    // 舊行為：active.size(=1) >= totalMax(=1) → 下一個雲端分派拿到 503
    //「沙盒容量暫時滿了」，而主機上其實一個容器都沒有。那句話是假的。
    const res = await api("/v1/sandboxes", {
      method: "POST",
      headers: { "x-sandbox-user-id": "u-e2e-other" },
      body: JSON.stringify({ user_id: "u-e2e-other", session_id: "s-e2e-cloud" }),
    });
    const body = await res.json().catch(() => ({}));
    assert.notEqual(
      body?.error?.code, "pool_exhausted",
      `機器綁定的列不該擋住雲端分派（回了 ${res.status} ${JSON.stringify(body)}）`,
    );
  } finally {
    config.pool.totalMax = before;
    await daemon.close();
  }
});
