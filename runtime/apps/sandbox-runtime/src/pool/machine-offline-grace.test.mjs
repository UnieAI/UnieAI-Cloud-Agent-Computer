/**
 * pool/machine-offline-grace.test.mjs —— 「這一列還有沒有一台活著的機器」。
 *
 * 機器綁定的沙盒**不該**被閒置或 TTL 收掉（它不佔這台主機的資源，收了只是害
 * 使用者掉 session）。但「不佔資源」不等於「永遠有效」：使用者關掉 Rabi Local、
 * 闔上筆電、解除配對之後，那一列指向的是一條已經不存在的連線。
 *
 * 在此之前那一列是**永遠**留著的：回收器兩條路都 `continue`，而
 * `closeConnection`／`revokeMachine` 只收 relay 的連線表，碰不到這裡的 active。
 * 於是它一路累積，還計入 pool.totalMax —— 最後全平台的人都拿到「容量滿了」。
 *
 * 這一支釘的是**失效條件本身**（不是計時器，是連線不在了），以及它的兩個邊界：
 * 寬限期沒到不能收、機器回來要能取消。
 */
// 這一支會配一個**雲端**沙盒（容量那一條），而雲端配置現在要先過 filer 曝露
// 檢查（cube/filer-exposure.mjs，ava 那條線加的）。在測試機上那個檢查探不到
// docker，於是回 `filer_exposure_unknown` —— 「答不出來就拒絕」是它刻意的性質，
// 不是這一支要測的東西。同一行在 machine-lifecycle / machine-reuse /
// manager.test.mjs 上都有；這一支是 ava-roy 在那道檢查存在之前寫的，合併時才撞上。
process.env.SANDBOX_ALLOW_ANONYMOUS_FILER = "1";
process.env.SANDBOX_USER_MAX_ACTIVE = "0";
process.env.SANDBOX_POOL_TOTAL_MAX = "100";
process.env.SANDBOX_MACHINE_OFFLINE_GRACE_SEC = "60";

import test from "node:test";
import assert from "node:assert/strict";

const { config } = await import("../config.mjs");
const cube = await import("../cube/index.mjs");
let _ctr = 0;
cube.resetBackend();
cube.setBackend({
  createSandbox: async ({ userId, sessionId }) => ({
    sandboxId: `cloud_${++_ctr}`, workspaceId: `ws_${_ctr}`, workspaceDir: `/tmp/f_${_ctr}`, userId, sessionId,
  }),
  destroySandbox: async () => undefined,
});

const { registerMachineConnection, closeConnection, getMachineConnection, _resetForTest } =
  await import("../relay/registry.mjs");
const {
  allocateSandbox, getActive, listActive, _runReaperPass,
  releaseSandbox, releaseMachineSandboxes, countMachineSandboxes,
} = await import("./manager.mjs");

const LOCAL = (id) => ({ id, kind: "local", root: "/w" });

async function settle(machineId, expected) {
  for (let i = 0; i < 200; i += 1) {
    if (countMachineSandboxes(machineId) === expected) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(countMachineSandboxes(machineId), expected, `等不到 ${machineId} 剩下 ${expected} 列`);
}

/** 讓這台機器離線的方式跟正式一樣：關掉那條連線（daemon 掉線走的就是這裡）。 */
function dropConnection(machineId) {
  const conn = getMachineConnection(machineId);
  assert.ok(conn, `${machineId} 應該還連著`);
  closeConnection(conn, "daemon went away");
}

test("機器離線但寬限期還沒到 —— 一列都不收", async () => {
  _resetForTest();
  config.pool.machineOfflineGraceSec = 60;
  registerMachineConnection({ machineId: "m-g1", userId: "u-g1", send() {} });
  const a = await allocateSandbox({ userId: "u-g1", sessionId: "s-g1", workspaceMode: "user", machine: LOCAL("m-g1") });

  dropConnection("m-g1");

  // 第一趟只是記下「從這一刻開始不見」；之後幾趟都還在寬限期裡。
  for (let i = 0; i < 3; i += 1) {
    const released = _runReaperPass();
    assert.ok(!released.some((r) => r.sandboxId === a.entry.sandboxId), `第 ${i + 1} 趟不該收`);
  }
  assert.equal(countMachineSandboxes("m-g1"), 1);
  assert.ok(getActive(a.entry.sandboxId).machineOfflineSince > 0, "離線的起點有被記下來");

  await releaseSandbox(a.entry.sandboxId);
});

test("寬限期過了就收，而且理由講的是「機器不在了」不是「閒置」", async () => {
  _resetForTest();
  config.pool.machineOfflineGraceSec = 60;
  registerMachineConnection({ machineId: "m-g2", userId: "u-g2", send() {} });
  const a = await allocateSandbox({ userId: "u-g2", sessionId: "s-g2", workspaceMode: "user", machine: LOCAL("m-g2") });
  dropConnection("m-g2");
  _runReaperPass(); // 記下離線起點

  // 把起點推到寬限期之前 —— 等同「使用者關機一小時」。
  getActive(a.entry.sandboxId).machineOfflineSince = Date.now() - 3_600_000;
  const released = _runReaperPass();

  const mine = released.find((r) => r.sandboxId === a.entry.sandboxId);
  assert.ok(mine, "該收了");
  assert.equal(mine.reason, "machine_gone", "理由要說得出是機器不在了");
  await settle("m-g2", 0);
});

test("機器回來就取消 —— 斷斷續續的網路不會累積成一次回收", async () => {
  _resetForTest();
  config.pool.machineOfflineGraceSec = 60;
  registerMachineConnection({ machineId: "m-g3", userId: "u-g3", send() {} });
  const a = await allocateSandbox({ userId: "u-g3", sessionId: "s-g3", workspaceMode: "user", machine: LOCAL("m-g3") });

  dropConnection("m-g3");
  _runReaperPass();
  const firstSeen = getActive(a.entry.sandboxId).machineOfflineSince;
  assert.ok(firstSeen > 0);

  // daemon 退避重連上來了。
  registerMachineConnection({ machineId: "m-g3", userId: "u-g3", send() {} });
  _runReaperPass();
  assert.equal(getActive(a.entry.sandboxId).machineOfflineSince, null, "回來就把離線起點清掉");

  // 再斷一次，起點必須是**新的** —— 否則兩次短暫斷線會加起來變成一次回收。
  dropConnection("m-g3");
  _runReaperPass();
  assert.ok(getActive(a.entry.sandboxId).machineOfflineSince >= firstSeen, "起點重新計算");
  assert.equal(countMachineSandboxes("m-g3"), 1);

  await releaseSandbox(a.entry.sandboxId);
});

test("SSH 機器不走這條 —— 那條路上「離線」不可觀測，用計時器猜會把好機器判死", async () => {
  _resetForTest();
  config.pool.machineOfflineGraceSec = 0;
  const a = await allocateSandbox({
    userId: "u-g4", sessionId: "s-g4", workspaceMode: "user",
    machine: { id: "m-g4", kind: "ssh", host: "h", user: "u", root: "/r" },
  });
  // relay registry 裡從來不會有 SSH 機器的連線（我們是撥出去的那一方）。
  for (let i = 0; i < 3; i += 1) {
    const released = _runReaperPass();
    assert.ok(!released.some((r) => r.sandboxId === a.entry.sandboxId), "SSH 不該被離線規則收掉");
  }
  assert.equal(countMachineSandboxes("m-g4"), 1);
  await releaseSandbox(a.entry.sandboxId);
});

test("撤銷不等寬限期 —— 授權事件是立刻的", async () => {
  _resetForTest();
  config.pool.machineOfflineGraceSec = 86_400; // 一整天，證明撤銷根本不看它
  registerMachineConnection({ machineId: "m-g5", userId: "u-g5", send() {} });
  const a = await allocateSandbox({ userId: "u-g5", sessionId: "s-g5", workspaceMode: "user", machine: LOCAL("m-g5") });
  // 另一台機器的列不能被誤傷。
  registerMachineConnection({ machineId: "m-g5b", userId: "u-g5", send() {} });
  const b = await allocateSandbox({ userId: "u-g5", sessionId: "s-g5b", workspaceMode: "user", machine: LOCAL("m-g5b") });

  const { released } = await releaseMachineSandboxes("m-g5", { reason: "revoked" });

  assert.deepEqual(released, [a.entry.sandboxId]);
  await settle("m-g5", 0);
  assert.equal(countMachineSandboxes("m-g5b"), 1, "只收被撤銷的那一台");
  assert.ok(listActive().some((e) => e.sandboxId === b.entry.sandboxId));

  await releaseSandbox(b.entry.sandboxId);
});

test("容量：機器綁定的列不計入主機上限，撞到自己的上限時說的是另一句話", async () => {
  _resetForTest();
  config.pool.machineOfflineGraceSec = 86_400;
  const savedTotal = config.pool.totalMax;
  const savedMachine = config.pool.machineMax;
  const opened = [];
  try {
    config.pool.totalMax = 1;
    registerMachineConnection({ machineId: "m-g6", userId: "u-g6", send() {} });
    opened.push((await allocateSandbox({ userId: "u-g6", sessionId: "s-g6", workspaceMode: "user", machine: LOCAL("m-g6") })).entry.sandboxId);

    // 主機上限是 1，而那一列不在主機上 —— 雲端分派必須還能過。
    const cloud = await allocateSandbox({ userId: "u-g6c", sessionId: "s-g6c" });
    opened.push(cloud.entry.sandboxId);

    // 現在主機上真的有一個了，第二個雲端才該被擋，而且訊息要說得出主機上有幾個。
    await assert.rejects(
      () => allocateSandbox({ userId: "u-g6d", sessionId: "s-g6d" }),
      (err) => {
        assert.equal(err.code, "pool_exhausted");
        assert.match(err.message, /running on this host/);
        assert.equal(err.details.host_active, 1);
        assert.equal(err.details.machine_bound, 1, "死列佔著的時候，那個數字看得見");
        return true;
      },
    );

    // 登記表自己的上限撞到的時候，說的必須是另一件事。
    config.pool.machineMax = 1;
    registerMachineConnection({ machineId: "m-g6b", userId: "u-g6", send() {} });
    await assert.rejects(
      () => allocateSandbox({ userId: "u-g6", sessionId: "s-g6b", workspaceMode: "user", machine: LOCAL("m-g6b") }),
      (err) => {
        assert.equal(err.code, "machine_pool_exhausted");
        assert.match(err.message, /bookkeeping limit/);
        return true;
      },
    );
  } finally {
    config.pool.totalMax = savedTotal;
    config.pool.machineMax = savedMachine;
    for (const id of opened) await releaseSandbox(id);
  }
});
