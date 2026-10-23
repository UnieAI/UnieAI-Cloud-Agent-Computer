/**
 * quota/enforcer.test.mjs —— filer 層的強制器（bash 經掛載寫入的最後一道）。
 *
 * 設計約束（owner／rabi 2026-10-02）：
 *   · 每 30 秒用 **logical** 大小判斷；超過 → 對 workspace/ 前綴設 readOnly；低於（含刪檔後）→ 拿掉，最多 30 秒恢復可寫。
 *   · fs.configure 唯讀是改正式 filer 設定：**強制器當掉或重啟時不能讓某個前綴永遠卡在唯讀** —— 規則存在 filer 裡不在行程裡，
 *     所以每一輪（含啟動第一輪）都從「真相」重算並對帳：該拿掉的拿掉。
 *   · 絕不動不是我們管的規則；讀不到現況就什麼都不寫（盲寫會覆蓋別人的設定）；列舉失敗不准當成「沒有租戶」去解除所有規則。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isManagedPrefix, planReconcile, createEnforcer, clearManagedLocks } from "./enforcer.mjs";

const MB = 1024 * 1024;
const P = (id) => `/buckets/ws-user-${id}/workspace/`;
const L = (id) => `/buckets/cm-agent-artifacts/users/${id}/workspace/`;

test("只管 workspace/ 前綴（個人 bucket、舊共用 bucket、組織、群組）；其他規則（.platform、別人的設定）一律不是我們的", () => {
  for (const p of [P("a"), L("a"), "/buckets/ws-org-o1/workspace/", "/buckets/ws-group-g1/workspace/", "/buckets/cm-agent-artifacts/orgs/o1/workspace/", "/buckets/cm-agent-artifacts/groups/g1/workspace/"]) {
    assert.equal(isManagedPrefix(p), true, p);
  }
  for (const p of ["/buckets/ws-user-a/", "/buckets/ws-user-a/.platform/", "/buckets/ws-user-a/workspace", "/etc/", "/buckets/x/y/z/", "/buckets/ws-user-a/workspace/sub/", "/buckets/a b/workspace/", "/buckets/ws-user-a/workspace/;rm -rf/"]) {
    assert.equal(isManagedPrefix(p), false, p);
  }
});

test("計畫：超過 → 加；回到上限以下 → 拿掉；沒變 → 不動（冪等）", () => {
  const tenants = [
    { prefix: P("over"), usedBytes: 51 * MB, limitBytes: 50 * MB },
    { prefix: P("ok"), usedBytes: 10 * MB, limitBytes: 50 * MB },
    { prefix: P("was-locked"), usedBytes: 20 * MB, limitBytes: 50 * MB },   // 刪檔後回到以下
    { prefix: P("still-locked"), usedBytes: 60 * MB, limitBytes: 50 * MB },
    { prefix: P("exact"), usedBytes: 50 * MB, limitBytes: 50 * MB },         // 剛好等於：不鎖（app 閘擋變大）
  ];
  const plan = planReconcile({ tenants, locked: new Set([P("was-locked"), P("still-locked")]) });
  assert.deepEqual(plan.add, [P("over")]);
  assert.deepEqual(plan.remove, [P("was-locked")]);
  assert.deepEqual(planReconcile({ tenants, locked: new Set([P("over"), P("still-locked")]) }), { add: [], remove: [] });
});

test("計畫：上限 0（不設限，或管理員關掉）→ 一律拿掉我們管的唯讀規則；不設限的 tenant 不會被加", () => {
  const plan = planReconcile({ tenants: [{ prefix: P("a"), usedBytes: 999 * MB, limitBytes: 0 }], locked: new Set([P("a")]) });
  assert.deepEqual(plan, { add: [], remove: [P("a")] });
});

test("計畫：量測失敗的 tenant 維持現狀（不鎖也不解）；量測被列表上限截斷時，下限已超過才鎖，否則維持現狀", () => {
  const plan = planReconcile({
    tenants: [
      { prefix: P("err"), usedBytes: null, limitBytes: 50 * MB },
      { prefix: P("trunc-over"), usedBytes: 80 * MB, truncated: true, limitBytes: 50 * MB },
      { prefix: P("trunc-unknown"), usedBytes: 10 * MB, truncated: true, limitBytes: 50 * MB },
    ],
    locked: new Set([P("err"), P("trunc-unknown")]),
  });
  assert.deepEqual(plan, { add: [P("trunc-over")], remove: [] });
});

test("計畫：不再被列舉到的 tenant（已刪除／改名）留下的我們管的規則要拿掉，不能永遠卡著", () => {
  const plan = planReconcile({ tenants: [{ prefix: P("a"), usedBytes: 1, limitBytes: 50 * MB }], locked: new Set([P("ghost"), L("ghost2")]), enumerated: true });
  assert.deepEqual(plan.remove.sort(), [P("ghost"), L("ghost2")].sort());
});

test("計畫：不是我們管的唯讀規則永遠不碰，即使它不在任何 tenant 清單裡", () => {
  const plan = planReconcile({ tenants: [], locked: new Set(["/buckets/ws-user-a/.platform/", "/etc/x/", "/buckets/other/dir/"]), enumerated: true });
  assert.deepEqual(plan, { add: [], remove: [] });
});

function harness({ tenants, locked = [], failCurrent = false, failList = false, failApply = false, limit = 50 * MB } = {}) {
  const state = { locked: new Set(locked), applied: [], logs: [] };
  const enforcer = createEnforcer({
    log: (level, event, f) => state.logs.push({ level, event, ...f }),
    listTenants: async () => { if (failList) throw new Error("s3 down"); return tenants.map((t) => ({ owner: t.owner ?? `user:${t.id}`, prefix: P(t.id) })); },
    measure: async (owner) => { const t = tenants.find((x) => (x.owner ?? `user:${x.id}`) === owner); if (t.fail) throw new Error("boom"); return { bytes: t.bytes, truncated: t.truncated === true }; },
    limits: { forOwner: () => limit },
    control: {
      current: async () => { if (failCurrent) throw new Error("filer down"); return new Set(state.locked); },
      apply: async ({ add, remove }) => { if (failApply) throw new Error("shell failed"); state.applied.push({ add, remove }); for (const p of add) state.locked.add(p); for (const p of remove) state.locked.delete(p); },
    },
  });
  return { enforcer, state };
}

test("tick：超過的鎖、刪檔後的解；第二輪沒變就不再呼叫 apply", async () => {
  const h = harness({ tenants: [{ id: "a", bytes: 60 * MB }, { id: "b", bytes: 1 * MB }] });
  await h.enforcer.tick();
  assert.deepEqual(h.state.applied, [{ add: [P("a")], remove: [] }]);
  await h.enforcer.tick();
  assert.equal(h.state.applied.length, 1, "沒變不該再寫 filer 設定");
  h.state.locked.add(P("b")); // 模擬 b 之前被鎖（例如上一個行程留下的）
  await h.enforcer.tick();
  assert.deepEqual(h.state.applied.at(-1), { add: [], remove: [P("b")] }, "重啟後第一輪就對帳：留下的規則該拿掉的拿掉");
});

test("讀不到現況（filer 當掉）→ 什麼都不寫；列舉失敗 → 不解除任何規則；apply 失敗 → 記 log、下一輪再試", async () => {
  const a = harness({ tenants: [{ id: "a", bytes: 60 * MB }], failCurrent: true });
  await a.enforcer.tick();
  assert.deepEqual(a.state.applied, []);
  assert.ok(a.state.logs.some((l) => l.level === "warn"));

  const b = harness({ tenants: [{ id: "a", bytes: 1 * MB }], locked: [P("a")], failList: true });
  await b.enforcer.tick();
  assert.deepEqual(b.state.applied, [], "列舉失敗不能被當成『沒有租戶』而把所有規則解掉");
  assert.ok(b.state.locked.has(P("a")));

  const c = harness({ tenants: [{ id: "a", bytes: 60 * MB }], failApply: true });
  await c.enforcer.tick();
  assert.ok(c.state.logs.some((l) => l.event === "quota.enforcer_apply_failed"));
  c.state.locked.clear();
  const c2 = c; // 同一個 enforcer 下一輪會再試（沒有「已經試過」的記憶）
  assert.equal(typeof c2.enforcer.tick, "function");
});

test("單一 tenant 量測失敗不影響其他 tenant；tick 不重疊", async () => {
  const h = harness({ tenants: [{ id: "bad", bytes: 0, fail: true }, { id: "a", bytes: 60 * MB }] });
  await h.enforcer.tick();
  assert.deepEqual(h.state.applied, [{ add: [P("a")], remove: [] }]);
  let release;
  let calls = 0;
  const slow = createEnforcer({
    log: () => {}, listTenants: async () => { calls++; await new Promise((r) => { release = r; }); return []; },
    measure: async () => ({ bytes: 0 }), limits: { forOwner: () => 1 }, control: { current: async () => new Set(), apply: async () => {} },
  });
  const t1 = slow.tick();
  const t2 = slow.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1, "上一輪還沒結束，下一輪不開");
  release(); await t1; await t2;
});

test("上限 0（管理員關掉）：整批解除，不需要重啟", async () => {
  const h = harness({ tenants: [{ id: "a", bytes: 60 * MB }], locked: [P("a")], limit: 0 });
  await h.enforcer.tick();
  assert.deepEqual(h.state.applied, [{ add: [], remove: [P("a")] }]);
});

test("緊急出口 clearManagedLocks：只拿掉我們管的規則，別人的不動；讀不到現況就丟、不寫", async () => {
  const applied = [];
  const control = { current: async () => new Set([P("a"), "/etc/other/", "/buckets/ws-user-a/.platform/"]), apply: async (p) => applied.push(p) };
  assert.deepEqual(await clearManagedLocks(control), [P("a")]);
  assert.deepEqual(applied, [{ add: [], remove: [P("a")] }]);
  await assert.rejects(clearManagedLocks({ current: async () => { throw new Error("down"); }, apply: async () => applied.push("x") }));
  assert.equal(applied.length, 1);
});

test("同一個警告連續出現只記一次（沒有 SeaweedFS 容器的機器不會每 30 秒洗一行）；恢復後再壞會再記", async () => {
  const h = harness({ tenants: [{ id: "a", bytes: 1 }], failCurrent: true });
  await h.enforcer.tick(); await h.enforcer.tick(); await h.enforcer.tick();
  assert.equal(h.state.logs.filter((l) => l.event === "quota.enforcer_filer_unreadable").length, 1);
});
