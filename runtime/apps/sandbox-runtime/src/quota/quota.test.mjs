/**
 * quota/quota.test.mjs —— 雲端工作區空間上限（owner 2026-10-02 決定）：
 *   ① 只計 workspace/（使用者看得到、刪得掉的）；.platform/ 不算也不擋
 *   ② 超過 ＝ 唯讀＋可刪＋提示（刪除永遠放行）
 *   ④ 個人與組織／群組各一個上限鍵，預設 50 MiB，可由環境變數與 app 推送設定
 *   ⑤ 上傳先比對剩餘空間，直接說「這個檔案 X MB，超過雲端剩餘空間 Y MB」
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_QUOTA_BYTES, createLimits } from "./limits.mjs";
import { assertWithinQuota, quotaState } from "./gate.mjs";
import { measureWorkspaceBytes } from "./usage.mjs";

const MB = 1024 * 1024;

test("預設 50 MiB，個人與共用各一個鍵；環境變數覆蓋；0 ＝ 不設限；亂寫的值退回預設", () => {
  const d = createLimits({ env: {} });
  assert.equal(DEFAULT_QUOTA_BYTES, 50 * MB);
  assert.equal(d.forOwner("user:u1"), 50 * MB);
  assert.equal(d.forOwner("u1"), 50 * MB, "裸 userId 是個人");
  assert.equal(d.forOwner("group:g1"), 50 * MB);
  assert.equal(d.forOwner("org:o1"), 50 * MB);
  const e = createLimits({ env: { WORKSPACE_USER_QUOTA_BYTES: "1048576", WORKSPACE_SHARED_QUOTA_BYTES: "0" } });
  assert.equal(e.forOwner("user:u1"), 1 * MB);
  assert.equal(e.forOwner("org:o1"), 0, "0 ＝ 這一類不設限");
  const bad = createLimits({ env: { WORKSPACE_USER_QUOTA_BYTES: "lots", WORKSPACE_SHARED_QUOTA_BYTES: "-5" } });
  assert.equal(bad.forOwner("user:u1"), 50 * MB);
  assert.equal(bad.forOwner("org:o1"), 50 * MB);
});

test("app 推送的設定優先於環境變數，且只認合法的非負整數（亂值不會把全站設成 0）", () => {
  const l = createLimits({ env: { WORKSPACE_USER_QUOTA_BYTES: String(10 * MB) } });
  assert.equal(l.set({ personalBytes: 20 * MB, sharedBytes: 30 * MB }), true);
  assert.equal(l.forOwner("user:u1"), 20 * MB);
  assert.equal(l.forOwner("group:g"), 30 * MB);
  assert.equal(l.set({ personalBytes: "x", sharedBytes: -1 }), false, "整包拒絕，不收一半");
  assert.equal(l.forOwner("user:u1"), 20 * MB);
});

test("閘：用量＋這次寫入的增量超過上限 → 413 workspace_quota_exceeded，帶已用／上限／剩餘／這次大小", () => {
  assert.throws(
    () => assertWithinQuota({ relPath: "a.bin", incomingBytes: 8 * MB, existingBytes: 0, usedBytes: 45 * MB, limitBytes: 50 * MB }),
    (e) => {
      assert.equal(e.code, "workspace_quota_exceeded");
      assert.equal(e.status, 413);
      assert.deepEqual(e.details, { usedBytes: 45 * MB, limitBytes: 50 * MB, remainingBytes: 5 * MB, incomingBytes: 8 * MB, path: "a.bin" });
      assert.match(e.message, /8(\.0)? MB/);
      assert.match(e.message, /5(\.0)? MB/);
      assert.match(e.message, /地端/);
      return true;
    },
  );
});

test("閘：覆蓋既有檔案只算增量；放得下就放行；沒有上限（0）不擋", () => {
  assertWithinQuota({ relPath: "a.bin", incomingBytes: 10 * MB, existingBytes: 9 * MB, usedBytes: 49 * MB, limitBytes: 50 * MB });
  assertWithinQuota({ relPath: "a.bin", incomingBytes: 5 * MB, existingBytes: 0, usedBytes: 45 * MB, limitBytes: 50 * MB });
  assertWithinQuota({ relPath: "a.bin", incomingBytes: 500 * MB, existingBytes: 0, usedBytes: 99 * MB, limitBytes: 0 });
});

test("閘：已經超過上限的人（唯讀）：變大的寫入擋下；縮小或不變的寫入放行（讓他能改小檔案釋放空間）", () => {
  const over = { usedBytes: 60 * MB, limitBytes: 50 * MB };
  assert.throws(() => assertWithinQuota({ relPath: "a.txt", incomingBytes: 2 * MB, existingBytes: 1 * MB, ...over }), (e) => e.code === "workspace_quota_exceeded");
  assertWithinQuota({ relPath: "a.txt", incomingBytes: 1 * MB, existingBytes: 2 * MB, ...over });
  assertWithinQuota({ relPath: "a.txt", incomingBytes: 1 * MB, existingBytes: 1 * MB, ...over });
});

test("閘：平台自己的狀態（.opencode／memory／skills 轉成的 .platform 路徑）不算也不擋", () => {
  for (const rel of [".opencode/memories/x.md", ".opencode/skills/s/SKILL.md"]) {
    assertWithinQuota({ relPath: rel, incomingBytes: 10 * MB, existingBytes: 0, usedBytes: 100 * MB, limitBytes: 50 * MB });
  }
});

test("quotaState：回給面板／app 的一個物件（已用、上限、剩餘、是否超過）", () => {
  assert.deepEqual(quotaState({ usedBytes: 12 * MB, limitBytes: 50 * MB }), { usedBytes: 12 * MB, limitBytes: 50 * MB, remainingBytes: 38 * MB, over: false, unlimited: false });
  assert.deepEqual(quotaState({ usedBytes: 60 * MB, limitBytes: 50 * MB }), { usedBytes: 60 * MB, limitBytes: 50 * MB, remainingBytes: 0, over: true, unlimited: false });
  assert.deepEqual(quotaState({ usedBytes: 60 * MB, limitBytes: 0 }), { usedBytes: 60 * MB, limitBytes: 0, remainingBytes: null, over: false, unlimited: true });
});

test("用量：加總 workspace/ 底下每個物件的 logical 大小；列表上限到了不假裝量準（回 truncated）", async () => {
  const seen = [];
  const list = async ({ at, maxItems }) => { seen.push({ key: at.key, maxItems }); return [{ key: "x", sizeBytes: 3 * MB }, { key: "y", sizeBytes: 4 * MB }]; };
  const u = await measureWorkspaceBytes("user:u1", { list });
  assert.deepEqual({ bytes: u.bytes, truncated: u.truncated }, { bytes: 7 * MB, truncated: false });
  assert.match(seen[0].key, /workspace\/$/, "只量 workspace/，不量它的兄弟 .platform／.snapshots");
  const big = await measureWorkspaceBytes("user:u1", { list: async ({ maxItems }) => Array.from({ length: maxItems }, (_, i) => ({ key: `k${i}`, sizeBytes: 1 })), maxItems: 10 });
  assert.equal(big.truncated, true);
});

import { createQuotaService } from "./service.mjs";

test("服務：用量快取（TTL 內不重量）、同時在飛的同一個 owner 只量一次、寫入後增量進快取", async () => {
  let measures = 0;
  let t = 0;
  const limits = createLimits({ env: {} });
  const svc = createQuotaService({ limits, now: () => t, ttlMs: 1000, measure: async () => { measures++; await new Promise((r) => setTimeout(r, 5)); return { bytes: 10 * MB, truncated: false }; } });
  await Promise.all([svc.state("user:u1"), svc.state("user:u1"), svc.state("user:u1")]);
  assert.equal(measures, 1, "singleflight");
  await svc.state("user:u1");
  assert.equal(measures, 1, "TTL 內用快取");
  svc.noteWrite("user:u1", 41 * MB);
  await assert.rejects(() => svc.check({ owner: "user:u1", relPath: "x.bin", incomingBytes: 1 * MB }), (e) => e.code === "workspace_quota_exceeded", "快取的增量要讓連續上傳不會一路超過上限");
  t = 2000;
  await svc.state("user:u1");
  assert.equal(measures, 2, "過了 TTL 重量");
});

test("服務：沒有上限（0）連量都不量；覆蓋既有檔案用 existingSizeOf 的大小", async () => {
  let measures = 0;
  const limits = createLimits({ env: { WORKSPACE_SHARED_QUOTA_BYTES: "0" } });
  const svc = createQuotaService({ limits, measure: async () => { measures++; return { bytes: 49 * MB }; }, existingSizeOf: async () => 9 * MB });
  await svc.check({ owner: "org:o1", relPath: "a", incomingBytes: 900 * MB });
  assert.equal(measures, 0);
  await svc.check({ owner: "user:u1", relPath: "a", incomingBytes: 10 * MB }); // 49 + (10-9) = 50 → 剛好放行
  await assert.rejects(() => svc.check({ owner: "user:u1", relPath: "b", incomingBytes: 10 * MB }).then(() => svc.check({ owner: "user:u1", relPath: "a", incomingBytes: 11 * MB })), (e) => e.code === "workspace_quota_exceeded");
});

test("依方案的 owner 覆寫：優先於全站值；裸 userId 與 user:<id> 同一個鍵；null 拿掉覆寫；全站推送不清掉覆寫", () => {
  const l = createLimits({ env: {} });
  assert.equal(l.set({ owners: { "user:u1": 200 * MB, "org:o1": 0, "group:g1": 1 * MB } }), true, "只送 owners 也收");
  assert.equal(l.forOwner("user:u1"), 200 * MB);
  assert.equal(l.forOwner("u1"), 200 * MB, "runtime 的個人 owner 是裸 userId");
  assert.equal(l.forOwner("org:o1"), 0, "0 ＝ 這個方案不設限");
  assert.equal(l.forOwner("group:g1"), 1 * MB);
  assert.equal(l.forOwner("user:u2"), 50 * MB, "沒有覆寫 → 全站值");
  assert.equal(l.set({ personalBytes: 10 * MB, sharedBytes: 20 * MB }), true);
  assert.equal(l.forOwner("user:u1"), 200 * MB, "全站推送不動覆寫");
  assert.equal(l.forOwner("user:u2"), 10 * MB);
  assert.equal(l.set({ owners: { "user:u1": null } }), true);
  assert.equal(l.forOwner("u1"), 10 * MB, "null → 回到全站值");
  assert.equal(l.snapshot().ownerOverrides, 2);
});

test("owner 覆寫只認合法的整包：壞的鍵或值整個 owners 不收，全站值也不動", () => {
  const l = createLimits({ env: {} });
  assert.equal(l.set({ owners: { "user:u1": 5 * MB, "user:u2": -1 } }), false);
  assert.equal(l.forOwner("user:u1"), 50 * MB, "不收一半");
  assert.equal(l.set({ owners: { "weird/../x": 5 * MB } }), false);
  assert.equal(l.set({ owners: ["user:u1"] }), false);
  assert.equal(l.set({ personalBytes: 1, sharedBytes: 1, owners: { "user:u1": "x" } }), false);
  assert.equal(l.forOwner("user:u9"), 50 * MB, "同一包裡的全站值也不收");
  assert.equal(l.set({}), false);
});

test("owner 覆寫表有上限：超過丟最舊的", () => {
  const l = createLimits({ env: {}, maxOverrides: 2 });
  l.set({ owners: { "user:a": 1 } });
  l.set({ owners: { "user:b": 2 } });
  l.set({ owners: { "user:a": 1 } }); // 重送 → a 變成最新
  l.set({ owners: { "user:c": 3 } });
  assert.equal(l.forOwner("user:b"), 50 * MB, "b 最舊，被丟掉");
  assert.equal(l.forOwner("user:a"), 1);
  assert.equal(l.forOwner("user:c"), 3);
});

test("服務：寫入的 413 跟著 owner 自己的方案上限走（同樣的用量，方案大的放行、全站值的擋下）", async () => {
  const limits = createLimits({ env: {} });
  limits.set({ owners: { "user:pro": 500 * MB } });
  const svc = createQuotaService({ limits, measure: async () => ({ bytes: 49 * MB }) });
  await svc.check({ owner: "pro", relPath: "big.bin", incomingBytes: 100 * MB });
  await assert.rejects(() => svc.check({ owner: "free", relPath: "big.bin", incomingBytes: 100 * MB }), (e) => e.code === "workspace_quota_exceeded" && e.details.limitBytes === 50 * MB);
  await assert.rejects(() => svc.check({ owner: "pro", relPath: "huge.bin", incomingBytes: 460 * MB }), (e) => e.code === "workspace_quota_exceeded" && e.details.limitBytes === 500 * MB);
  assert.equal((await svc.state("pro")).limitBytes, 500 * MB, "面板讀到的上限也是方案的");
});
