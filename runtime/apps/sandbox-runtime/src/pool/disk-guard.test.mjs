/**
 * disk-guard.test.mjs — 雲端沙盒的磁碟上限。
 *
 * 為什麼需要它：`--storage-opt size=` 在這台主機上**量過是無效的**
 * （driver=overlayfs、backing fs=ext4，沒掛 prjquota），所以 cube/docker.mjs
 * 會探測後跳過那一面旗標。CPU、記憶體、PID 都有硬上限，磁碟是**唯一沒有的**：
 * 一個租戶 `dd if=/dev/zero` 就能把共用主機的 991G 填掉，而上面還跑著別的產品。
 *
 * 兩層，刻意重疊：
 *   · `fsizeLimitBytes` —— 單檔上限，核心強制，不用輪詢，立刻生效
 *   · `diskAdmission`   —— 主機剩餘空間低於保留量就不再開新沙盒
 *
 * 只對雲端沙盒成立。綁在使用者自己電腦上的那一列用的是**他們的**磁碟，
 * 在這裡設限只會讓他們無法工作而且一個位元組都沒省下。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { diskAdmission, fsizeLimitBytes, resolveDiskLimits } from "./disk-guard.mjs";

// ---- diskAdmission ----

test("空間夠：放行", () => {
  const v = diskAdmission({ freeMb: 100_000, totalMb: 1_000_000, reserveMb: 20_480, reservePct: 0.1 });
  assert.equal(v.allow, true);
});

test("低於絕對保留量：擋下，而且說得出數字", () => {
  const v = diskAdmission({ freeMb: 10_000, totalMb: 1_000_000, reserveMb: 20_480, reservePct: 0 });
  assert.equal(v.allow, false);
  assert.equal(v.freeMb, 10_000);
  assert.equal(v.requiredMb, 20_480);
  assert.match(v.reason, /disk/i);
});

test("低於百分比保留量：擋下 —— 大磁碟上絕對值不夠用", () => {
  // 1TB 的 10% = 100GB。剩 50GB 過得了 20GB 的絕對門檻，但過不了百分比。
  const v = diskAdmission({ freeMb: 51_200, totalMb: 1_024_000, reserveMb: 20_480, reservePct: 0.1 });
  assert.equal(v.allow, false);
  assert.equal(v.requiredMb, 102_400);
});

test("兩個門檻取較嚴的那一個", () => {
  // 小磁碟：百分比算出來比絕對值小，這時絕對值才是有效門檻。
  const v = diskAdmission({ freeMb: 15_000, totalMb: 100_000, reserveMb: 20_480, reservePct: 0.1 });
  assert.equal(v.allow, false);
  assert.equal(v.requiredMb, 20_480, "10% = 10GB < 20GB 的絕對值 → 取絕對值");
});

test("保留量設 0：明確關閉這道門，不是意外放行", () => {
  const v = diskAdmission({ freeMb: 1, totalMb: 1_000_000, reserveMb: 0, reservePct: 0 });
  assert.equal(v.allow, true);
});

test("量不到主機空間：fail-closed 不適用 —— 但要說出來，不能假裝通過", () => {
  const v = diskAdmission({ freeMb: null, totalMb: null, reserveMb: 20_480, reservePct: 0.1 });
  assert.equal(v.allow, true, "量不到就不擋 —— 擋下等於全平台停擺");
  assert.equal(v.measured, false, "但 measured=false，呼叫端才知道這一次沒有保護");
});

// ---- fsizeLimitBytes ----

test("單檔上限：GB 轉 bytes", () => {
  assert.equal(fsizeLimitBytes(20), 20 * 1024 * 1024 * 1024);
});

test("單檔上限 0 = 不設限（明確關閉）", () => {
  assert.equal(fsizeLimitBytes(0), 0);
});

test("負數或垃圾值 → 0，不要送出負的 rlimit", () => {
  assert.equal(fsizeLimitBytes(-5), 0);
  assert.equal(fsizeLimitBytes("abc"), 0);
  assert.equal(fsizeLimitBytes(undefined), 0);
});

// ---- resolveDiskLimits（env → 設定）----

test("預設值：20GB 單檔、20GB 絕對保留、10% 百分比保留", () => {
  const c = resolveDiskLimits({});
  assert.equal(c.fsizeGb, 20);
  assert.equal(c.reserveMb, 20_480);
  assert.equal(c.reservePct, 0.1);
});

test("env 覆寫得動，而且 0 是「關閉」不是「掉回預設」", () => {
  const c = resolveDiskLimits({
    SANDBOX_FSIZE_LIMIT_GB: "0",
    SANDBOX_DISK_RESERVE_MB: "0",
    SANDBOX_DISK_RESERVE_PCT: "0",
  });
  assert.equal(c.fsizeGb, 0);
  assert.equal(c.reserveMb, 0);
  assert.equal(c.reservePct, 0);
});
