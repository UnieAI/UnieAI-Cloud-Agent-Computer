/**
 * policy.mjs — 雲端沙盒的「活多久、開幾個」政策。值來自 app（管理後台 ▸ 平台設定），
 * 由 app 推過來（POST /v1/pool/policy，跟 /v1/workspace-quota/limits 同一個形狀：
 * sandbox-runtime 是 config-only，租戶與設定都住在 app 那一層）。沒推過就是環境變數的值。
 *
 * roy 2026-10-21：
 *   「沙箱如果一直在用可以不要關？應該是沒有在動時開始倒數計時，時間到了再關」
 *   「也要有整平台的沙箱上限，在平台設定可以設置」
 *   「可以根據 CPU、RAM、disk 狀態去動態調整？」
 *
 * 所以：
 *   - 回收只看**閒置**（idleMinutes，任何活動都會重新起算；有指令或背景程序在跑就不算閒置）。
 *     以前還有一條「安靜的沙盒最多活 1 小時」（ttl），而它在 14:20 把 roy 一個每分鐘都在
 *     工作的沙盒砍掉了（pool.reap_ttl aliveMs=3600923）—— 那一刻剛好兩個指令之間沒有在跑。
 *   - 絕對壽命（maxLifetime）只剩**選用**的保險：開關＋小時數，預設關。
 *   - 全平台上限（cap）：開關＋數字；沒開就是部署的 SANDBOX_POOL_TOTAL_MAX。
 *   - 依主機資源（adaptive）：開關＋三個門檻；開了，新沙盒要主機還有餘裕才放行。
 *
 * 設定一律是「開關＋開了才有的數值」，沒有「0＝不限」這種魔術值（roy 的規則）。
 */
import { config } from "../config.mjs";

const clampInt = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
};
const clampNum = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
};

export const ADAPTIVE_DEFAULTS = Object.freeze({ minFreeMemMb: 3072, maxLoadPerCore: 1.5, minDiskFreePct: 10 });

function envPolicy() {
  return {
    idleMinutes: Math.max(1, Math.round((config.pool.idleTimeoutSec || 900) / 60)),
    maxLifetime: { enabled: config.pool.maxLifetimeEnabled === true, hours: Math.max(1, Math.round((config.pool.maxLifetimeSec || 43200) / 3600)) },
    cap: { enabled: false, max: config.pool.totalMax },
    adaptive: { enabled: false, ...ADAPTIVE_DEFAULTS },
  };
}

let pushed = null;

/** 現在生效的政策（推過的值，否則環境變數）。 */
export function getPoolPolicy() {
  return pushed ?? envPolicy();
}

/**
 * 收 app 推來的政策。整包驗過才換；任何一格不合法就整包不收（回 false），維持現狀 ——
 * 跟 workspace-quota 的 limits 同一個規矩：半套的政策比舊的政策危險。
 */
export function setPoolPolicy(input) {
  if (!input || typeof input !== "object") return false;
  const base = envPolicy();
  const bool = (v, fallback) => (v === undefined ? fallback : typeof v === "boolean" ? v : null);
  const idleMinutes = input.idleMinutes === undefined ? base.idleMinutes : clampInt(input.idleMinutes, 1, 24 * 60);
  const ml = input.maxLifetime ?? {};
  const cap = input.cap ?? {};
  const ad = input.adaptive ?? {};
  const next = {
    idleMinutes,
    maxLifetime: { enabled: bool(ml.enabled, base.maxLifetime.enabled), hours: ml.hours === undefined ? base.maxLifetime.hours : clampInt(ml.hours, 1, 24 * 14) },
    cap: { enabled: bool(cap.enabled, false), max: cap.max === undefined ? base.cap.max : clampInt(cap.max, 1, 10_000) },
    adaptive: {
      enabled: bool(ad.enabled, false),
      minFreeMemMb: ad.minFreeMemMb === undefined ? ADAPTIVE_DEFAULTS.minFreeMemMb : clampInt(ad.minFreeMemMb, 0, 1024 * 1024),
      maxLoadPerCore: ad.maxLoadPerCore === undefined ? ADAPTIVE_DEFAULTS.maxLoadPerCore : clampNum(ad.maxLoadPerCore, 0.1, 64),
      minDiskFreePct: ad.minDiskFreePct === undefined ? ADAPTIVE_DEFAULTS.minDiskFreePct : clampNum(ad.minDiskFreePct, 0, 90),
    },
  };
  const bad = next.idleMinutes === null || next.maxLifetime.enabled === null || next.maxLifetime.hours === null
    || next.cap.enabled === null || next.cap.max === null || next.adaptive.enabled === null
    || next.adaptive.minFreeMemMb === null || next.adaptive.maxLoadPerCore === null || next.adaptive.minDiskFreePct === null;
  if (bad) return false;
  pushed = next;
  return true;
}

/** 測試用：回到環境變數的值。 */
export function resetPoolPolicyForTests() { pushed = null; }

/** 這一刻的全平台上限：開了就是管理後台的數字，否則部署的 SANDBOX_POOL_TOTAL_MAX。 */
export function effectiveTotalMax(policy = getPoolPolicy()) {
  if (policy.cap.enabled) return policy.cap.max;
  // 「依主機資源自動調整」開著、手動上限關著：數量交給主機的餘裕決定（manager.mjs 的
  // hostAdmission），部署預設（正式站 6）不再是天花板 —— 不然「自動調整」只會往下收、
  // 從來不會在主機閒的時候多開（roy 2026-10-21：「根據 CPU ram disk 狀態去動態調整」）。
  // 留一個安全天花板，防量測失靈時無限開。
  if (policy.adaptive.enabled) return Math.max(config.pool.totalMax, config.pool.adaptiveCeiling);
  return config.pool.totalMax;
}
