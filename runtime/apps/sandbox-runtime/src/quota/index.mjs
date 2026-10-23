/**
 * quota/index.mjs —— 這個行程唯一的一份：上限值、用量服務。
 * （純邏輯在 limits／gate／usage／service；這裡只接真的相依。）
 */
import { createLimits } from "./limits.mjs";
import { createQuotaService } from "./service.mjs";
import { measureWorkspaceBytes } from "./usage.mjs";
import { loadManifest } from "../workspace/userStore.mjs";

export const limits = createLimits();

export const quotaService = createQuotaService({
  limits,
  measure: (owner) => measureWorkspaceBytes(owner),
  // 覆蓋既有檔案只算增量。manifest 讀不到就當 0（保守：整個大小都算增量）。
  existingSizeOf: async (owner, relPath) => {
    const m = await loadManifest(owner);
    return Number(m?.entries?.[relPath]?.size) || 0;
  },
});

import { clearManagedLocks, createEnforcer } from "./enforcer.mjs";
import { createWeedShellControl } from "./filer-control.mjs";
import { createTenantLister } from "./tenants.mjs";

/**
 * 啟動 filer 強制器（server.mjs 在開始監聽之後呼叫）。
 *
 * **預設關閉**（2026-10-02 owner 規則）：強制器改的是 uac2-seaweedfs 的 filer.conf —— 那是 EVE 的 compose 專案，Ava 只是共用，
 * 未經 owner 決定不能動。所以：
 *   · `WORKSPACE_QUOTA_ENFORCER` 沒設（或不是 `1`／`0`）：**什麼都不做，一次都不呼叫 weed shell**。應用層的門照常。
 *   · `=1`：啟動，立刻對帳一次，之後每 `WORKSPACE_QUOTA_INTERVAL_MS`（預設 30 秒）一輪。
 *   · `=0`：只做一次性的緊急清除（拿掉我們管的唯讀規則），不啟動週期工作 —— 這是明確的維運動作。
 * 回傳停止函式（沒啟動回 null）。
 */
export function startQuotaEnforcer({ log, env = process.env, control = null } = {}) {
  const mode = String(env.WORKSPACE_QUOTA_ENFORCER ?? "").trim();
  if (mode !== "1" && mode !== "0") return null;
  const filer = control ?? createWeedShellControl();
  if (mode === "0") {
    clearManagedLocks(filer, log).catch((e) => log("warn", "quota.enforcer_clear_failed", { error: e?.message || String(e) }));
    return null;
  }
  const enforcer = createEnforcer({
    log,
    listTenants: createTenantLister({ env, listIsolatedBuckets: () => filer.listBuckets() }),
    measure: (owner) => measureWorkspaceBytes(owner),
    limits,
    control: filer,
  });
  const intervalMs = Number(env.WORKSPACE_QUOTA_INTERVAL_MS) > 0 ? Number(env.WORKSPACE_QUOTA_INTERVAL_MS) : 30_000;
  return enforcer.start({ intervalMs });
}
