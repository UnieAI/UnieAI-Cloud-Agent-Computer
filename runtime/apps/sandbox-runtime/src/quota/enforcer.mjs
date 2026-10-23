/**
 * quota/enforcer.mjs —— filer 層的空間上限強制器。
 *
 * 為什麼需要：沙盒裡 bash 經 weed mount 直接寫（掛載的 filer），應用層的閘（gate.mjs）看不到。SeaweedFS 內建的
 * bucket quota 不夠用（實測 2026-10-02：①非即時，enforce 之前能超量 15 倍；②用量是實體大小，刪光檔案後仍唯讀到 vacuum；
 * ③只認整個 bucket，舊共用 bucket 的使用者不是 bucket）。所以自己做：每 30 秒用 **logical** 大小判斷，超過就對
 * `…/workspace/` 前綴設 filer 的 readOnly（`fs.configure -locationPrefix=… -readOnly=true`），回到上限以下就拿掉。
 * 實測：唯讀前綴上 HTTP 寫入 507、FUSE 寫入 I/O error、**刪除仍成功**、同 bucket 的 `.platform/` 不受影響、拿掉規則立刻恢復。
 *
 * ## 安全性（這是在改正式 filer 的設定）
 *   · 規則存在 filer 裡、不在這個行程裡 —— 所以行程當掉不會「忘記」鎖，但也**不會自己解鎖**。因此每一輪（包含啟動後第一輪）
 *     都從真相重算並對帳：該拿掉的拿掉（上一個行程留下的、tenant 已不存在的、上限被調成 0 的）。
 *   · 只動 `isManagedPrefix` 認得的前綴（workspace/ 本身）。別人的規則、`.platform/`、整個 bucket 的規則一律不碰。
 *   · 讀不到現況就什麼都不寫（盲寫會蓋掉別人的設定）；列舉 tenant 失敗就整輪放棄（不能把「列不出來」當成「沒有租戶」去解鎖）；
 *     單一 tenant 量測失敗只讓那一個維持現狀。
 *   · 管理員把上限設成 0 → 下一輪整批解除；`WORKSPACE_QUOTA_ENFORCER=0` 關掉強制器（server.mjs 啟動時做一次清除再停）。
 */

const SEG = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const MANAGED = [
  new RegExp(`^/buckets/ws-(?:user|org|group)-${SEG}/workspace/$`),
  new RegExp(`^/buckets/${SEG}/(?:users|groups|orgs)/${SEG}/workspace/$`),
];

/** 這個前綴是不是我們管的（也是送去 shell 之前的白名單：不合就不可能被組進指令）。 */
export function isManagedPrefix(prefix) {
  return typeof prefix === "string" && MANAGED.some((re) => re.test(prefix));
}

/**
 * 純計畫。`tenants`：`{ prefix, usedBytes|null, truncated?, limitBytes }`；`locked`：現在 filer 裡 readOnly 的前綴。
 * 回 `{ add, remove }`，只含我們管的前綴。
 */
export function planReconcile({ tenants, locked, enumerated = true }) {
  const add = [];
  const remove = [];
  const known = new Set();
  for (const t of tenants) {
    if (!isManagedPrefix(t.prefix)) continue;
    known.add(t.prefix);
    const isLocked = locked.has(t.prefix);
    const limited = t.limitBytes > 0;
    if (!limited) { if (isLocked) remove.push(t.prefix); continue; }
    if (t.usedBytes === null || t.usedBytes === undefined) continue; // 量測失敗：維持現狀
    const over = t.usedBytes > t.limitBytes;
    if (t.truncated && !over) continue; // 只量到下限且還沒超過：不知道，維持現狀
    if (over && !isLocked) add.push(t.prefix);
    else if (!over && isLocked) remove.push(t.prefix);
  }
  if (enumerated) {
    for (const p of locked) if (isManagedPrefix(p) && !known.has(p)) remove.push(p);
  }
  return { add, remove };
}

export function createEnforcer({ listTenants, measure, limits, control, log: rawLog = () => {}, concurrency = 4 }) {
  let running = null;
  // 同一個警告連續出現（例如這台機器沒有 SeaweedFS 容器，每 30 秒一次）只記第一次，成功一輪後重置。
  let lastWarn = "";
  const log = (level, event, fields) => {
    if (level === "warn") {
      const key = `${event}:${fields?.error ?? ""}:${fields?.owner ?? ""}`;
      if (key === lastWarn) return;
      lastWarn = key;
    }
    rawLog(level, event, fields);
  };

  async function runOnce() {
    let locked;
    try {
      locked = await control.current();
    } catch (e) {
      log("warn", "quota.enforcer_filer_unreadable", { error: e?.message || String(e) });
      return { skipped: "filer_unreadable" };
    }
    let listed;
    try {
      listed = await listTenants();
    } catch (e) {
      log("warn", "quota.enforcer_enumeration_failed", { error: e?.message || String(e) });
      return { skipped: "enumeration_failed" };
    }
    const tenants = new Array(listed.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, listed.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= listed.length) return;
        const t = listed[i];
        const limitBytes = limits.forOwner(t.owner);
        if (!(limitBytes > 0)) { tenants[i] = { prefix: t.prefix, usedBytes: 0, limitBytes }; continue; }
        try {
          const m = await measure(t.owner);
          tenants[i] = { prefix: t.prefix, usedBytes: m.bytes, truncated: m.truncated === true, limitBytes };
        } catch (e) {
          log("warn", "quota.enforcer_measure_failed", { owner: t.owner, error: e?.message || String(e) });
          tenants[i] = { prefix: t.prefix, usedBytes: null, limitBytes };
        }
      }
    }));
    lastWarn = "";
    const plan = planReconcile({ tenants, locked, enumerated: true });
    if (!plan.add.length && !plan.remove.length) return { changed: false };
    try {
      await control.apply(plan);
      log("info", "quota.enforcer_applied", { locked: plan.add.length, unlocked: plan.remove.length });
      return { changed: true, ...plan };
    } catch (e) {
      log("warn", "quota.enforcer_apply_failed", { error: e?.message || String(e) });
      return { skipped: "apply_failed" };
    }
  }

  return {
    /** 一輪。上一輪還沒結束就回同一個 promise（不重疊）。 */
    tick() {
      if (!running) running = runOnce().finally(() => { running = null; });
      return running;
    },
    /** 啟動：立刻對帳一次（重啟後清掉上一個行程留下的規則），之後每 `intervalMs` 一輪。 */
    start({ intervalMs = 30_000 } = {}) {
      void this.tick();
      const timer = setInterval(() => { void this.tick(); }, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

/**
 * 一次性清除：把 filer 裡**我們管的**唯讀規則全部拿掉（關閉強制器時啟動用；維運的緊急出口）。
 * 讀不到現況就丟（不盲寫）。
 */
export async function clearManagedLocks(control, log = () => {}) {
  const locked = await control.current();
  const remove = [...locked].filter(isManagedPrefix);
  if (remove.length) {
    await control.apply({ add: [], remove });
    log("info", "quota.enforcer_cleared", { unlocked: remove.length });
  }
  return remove;
}
