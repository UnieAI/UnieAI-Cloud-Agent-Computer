/**
 * 雲端沙盒的「活多久、開幾個」（pool/policy.mjs、host-admission.mjs、manager 的閒置回收）。
 * roy 2026-10-21：一直在用就不要關、沒在動才倒數；全平台上限在平台設定；依 CPU／RAM／磁碟動態調整。
 */
process.env.SANDBOX_ALLOW_ANONYMOUS_FILER = "1";
process.env.SANDBOX_USER_MAX_ACTIVE = "0";
process.env.SANDBOX_POOL_TOTAL_MAX = "100";
process.env.SANDBOX_BACKGROUND_PROBE_MS = "20";

import test from "node:test";
import assert from "node:assert/strict";

const cube = await import("../cube/index.mjs");
let ctr = 0;
let cpu = new Map();   // sandboxId → usage µs (what the fake backend reports)
cube.resetBackend();
cube.setBackend({
  createSandbox: async ({ userId, sessionId }) => ({ sandboxId: `pol_${++ctr}`, workspaceId: `ws_${ctr}`, workspaceDir: `/tmp/p_${ctr}`, userId, sessionId }),
  destroySandbox: async () => undefined,
  cpuUsageUsec: async (id) => (cpu.has(id) ? cpu.get(id) : null),
});
const { allocateSandbox, releaseSandbox, getActive, _runReaperPass, touchActivity, _setHostReadersForTests } = await import("./manager.mjs");
const { setPoolPolicy, getPoolPolicy, resetPoolPolicyForTests, effectiveTotalMax } = await import("./policy.mjs");
const { hostAdmission, readMemAvailableMb, readLoadPerCore, readDiskFreePct } = await import("./host-admission.mjs");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function reapUntil(id, predicate, rounds = 40) {
  for (let i = 0; i < rounds; i += 1) {
    const released = _runReaperPass();
    if (predicate(released.find((r) => r.sandboxId === id))) return true;
    await wait(15);
  }
  return false;
}

test("activity resets the idle clock; an idle sandbox is reaped only after the window", async () => {
  const a = await allocateSandbox({ userId: "u-idle", sessionId: "idle-1", idleTimeoutSec: 15 });
  const id = a.entry.sandboxId;
  const entry = getActive(id);
  entry.lastActivityAt = Date.now() - 14_000;
  touchActivity(id, "bash");
  assert.ok(entry.idleAt > Date.now() + 14_000, "活動沒有把閒置窗往後推");
  assert.equal(_runReaperPass().find((r) => r.sandboxId === id), undefined);
  entry.idleAt = Date.now() - 1;   // window passed, no CPU reader for this one → reap
  assert.ok(await reapUntil(id, (r) => r?.reason === "idle"), "閒置窗過了卻沒回收");
});

test("a background process using CPU defers the idle reap; a quiet one is reaped", async () => {
  const a = await allocateSandbox({ userId: "u-bg", sessionId: "bg-1", idleTimeoutSec: 15 });
  const id = a.entry.sandboxId;
  // busy: 每次量 CPU 都多了 1 秒（20ms 的窗 ≫ 每分鐘 3 秒的門檻）
  let usage = 0;
  cpu.set(id, 0);
  const entry = getActive(id);
  entry.idleAt = Date.now() - 1;
  const ticker = setInterval(() => { usage += 1_000_000; cpu.set(id, usage); }, 5);
  try {
    for (let i = 0; i < 20; i += 1) { assert.equal(_runReaperPass().find((r) => r.sandboxId === id), undefined, "背景還在跑就被回收了"); await wait(10); }
    assert.ok(getActive(id).idleAt > Date.now(), "量到 CPU 之後應該重新起算閒置窗");
  } finally { clearInterval(ticker); }
  // quiet: CPU 不再增加 → 下一個窗之後回收
  getActive(id).idleAt = Date.now() - 1;
  assert.ok(await reapUntil(id, (r) => r?.reason === "idle"), "背景安靜下來之後沒有回收");
  cpu.delete(id);
});

test("policy: switches + values; a bad value rejects the whole push and keeps the old policy", () => {
  resetPoolPolicyForTests();
  assert.equal(getPoolPolicy().maxLifetime.enabled, false, "絕對壽命預設要是關的");
  assert.equal(getPoolPolicy().cap.enabled, false);
  assert.equal(effectiveTotalMax(), 100, "沒開上限＝部署的 SANDBOX_POOL_TOTAL_MAX");
  assert.equal(setPoolPolicy({ cap: { enabled: true, max: 4 }, idleMinutes: 20 }), true);
  assert.equal(effectiveTotalMax(), 4);
  assert.equal(getPoolPolicy().idleMinutes, 20);
  assert.equal(setPoolPolicy({ cap: { enabled: "yes", max: 4 } }), false, "不是布林的開關要整包拒收");
  assert.equal(effectiveTotalMax(), 4, "拒收之後要維持原本的政策");
  // 自動調整開、手動上限關：部署預設不再是天花板，改由主機餘裕決定（安全天花板 SANDBOX_POOL_ADAPTIVE_CEILING）。
  assert.equal(setPoolPolicy({ cap: { enabled: false, max: 4 }, adaptive: { enabled: true } }), true);
  assert.equal(effectiveTotalMax(), Math.max(100, 40), "自動調整開著，數量不該被部署預設卡住");
  // 兩個都開：手動上限優先。
  assert.equal(setPoolPolicy({ cap: { enabled: true, max: 4 }, adaptive: { enabled: true } }), true);
  assert.equal(effectiveTotalMax(), 4);
  resetPoolPolicyForTests();
});

test("the platform cap from settings refuses the next cloud sandbox with pool_exhausted", async () => {
  setPoolPolicy({ cap: { enabled: true, max: 1 } });
  const held = [];
  try {
    // 先把現有的都算進去：上限 1，前面測試留下的也算
    let refused = null;
    for (let i = 0; i < 5 && !refused; i += 1) {
      try { held.push((await allocateSandbox({ userId: `u-cap-${i}`, sessionId: `cap-${i}` })).entry.sandboxId); }
      catch (e) { refused = e; }
    }
    assert.ok(refused, "上限 1 卻一直開得出新的");
    assert.equal(refused.code, "pool_exhausted");
    assert.equal(refused.details?.limit, 1);
  } finally { for (const id of held) await releaseSandbox(id); resetPoolPolicyForTests(); }
});

test("adaptive: low RAM, high load or low disk refuses with host_busy; headroom admits", async () => {
  setPoolPolicy({ adaptive: { enabled: true, minFreeMemMb: 3072, maxLoadPerCore: 1.5, minDiskFreePct: 10 } });
  try {
    for (const [name, readers] of [
      ["memory", { mem: () => 1024, load: () => 0.2, disk: () => 50 }],
      ["cpu", { mem: () => 16_000, load: () => 3, disk: () => 50 }],
      ["disk", { mem: () => 16_000, load: () => 0.2, disk: () => 2 }],
    ]) {
      _setHostReadersForTests(readers);
      await assert.rejects(allocateSandbox({ userId: `u-ad-${name}`, sessionId: `ad-${name}` }), (e) => {
        assert.equal(e.code, "host_busy"); assert.deepEqual(e.details?.reasons, [name]); return true;
      });
    }
    _setHostReadersForTests({ mem: () => 16_000, load: () => 0.2, disk: () => 50 });
    const ok = await allocateSandbox({ userId: "u-ad-ok", sessionId: "ad-ok" });
    await releaseSandbox(ok.entry.sandboxId);
    // 量不到的那一樣放行（擋下等於全平台停擺）
    _setHostReadersForTests({ mem: () => null, load: () => null, disk: () => null });
    const unknown = await allocateSandbox({ userId: "u-ad-unk", sessionId: "ad-unk" });
    await releaseSandbox(unknown.entry.sandboxId);
  } finally { _setHostReadersForTests(null); resetPoolPolicyForTests(); }
});

test("adaptive off (default): host readings are not consulted", async () => {
  _setHostReadersForTests({ mem: () => 1, load: () => 99, disk: () => 0 });
  try {
    const a = await allocateSandbox({ userId: "u-ad-off", sessionId: "ad-off" });
    await releaseSandbox(a.entry.sandboxId);
  } finally { _setHostReadersForTests(null); }
});

test("host readers parse /proc and statfs", () => {
  assert.equal(readMemAvailableMb(() => "MemTotal: 32000000 kB\nMemAvailable:    4194304 kB\n"), 4096);
  assert.equal(readLoadPerCore(() => "8.00 7.00 6.00 3/900 1234\n", 16), 0.5);
  assert.equal(Math.round(readDiskFreePct("/", () => ({ blocks: 100, bavail: 25, bsize: 4096 }))), 25);
  assert.equal(readMemAvailableMb(() => { throw new Error("no proc"); }), null);
  assert.deepEqual(hostAdmission({ minFreeMemMb: 3072, maxLoadPerCore: 1.5, minDiskFreePct: 10 }, { memAvailableMb: 4096, loadPerCore: 0.5, diskFreePct: 25 }).allow, true);
});
