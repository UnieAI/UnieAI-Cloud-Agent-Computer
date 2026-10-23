/**
 * quota/limits.mjs —— 雲端工作區空間上限的**值**：個人一個鍵、組織／群組共用一個鍵，預設 50 MiB。
 *
 * 來源優先序：app 推送（管理後台 admin_settings，`POST /v1/workspace-quota/limits`）＞ 環境變數
 * （`WORKSPACE_USER_QUOTA_BYTES`／`WORKSPACE_SHARED_QUOTA_BYTES`）＞ 預設。sandbox-runtime 是 config-only
 * （沒有資料庫），所以 admin_settings 的值由 app 推進來；重啟後在 app 下一次推送之前用環境變數／預設。
 * `0` ＝ 這一類不設限。**只認合法的非負整數**：一個亂寫的值不能把全站上限變成 0 或負數。
 *
 * **依方案的覆寫（2026-10-15）**：方案（plans.quotas.storageBytesMax）可以給某個 owner 不同的上限。runtime 沒有資料庫，
 * 所以由 app 解析「這個 owner 適用哪個方案」後，用**同一個推送端點**送 `owners: { "<kind>:<id>": bytes | null }` 進來
 * （null ＝ 拿掉覆寫、回到全站預設）。選這條而不是「每個請求帶一個上限 header」：寫入工作區的不只 app
 * （ava-engine、collab-runtime、filer 強制器都會用 forOwner），header 得穿過每一個呼叫端，而且每一個拿著內部 token
 * 的服務都能替自己報上限；推送端點只有 app 在呼叫、本來就驗內部 token —— 沒有新增任何信任面。
 * 覆寫只在記憶體：runtime 重啟後回到全站值，直到 app 下一次推送（app 每 60 秒的全站推送會一併重送它記得的覆寫）。
 */
export const DEFAULT_QUOTA_BYTES = 50 * 1024 * 1024;

function parseBytes(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** 這個 owner 是個人（user）還是共用（group／org）。裸的值是舊版個人 userId。 */
export function isPersonalOwner(owner) {
  const s = String(owner ?? "");
  return !(s.startsWith("group:") || s.startsWith("org:"));
}

/** 覆寫表的鍵：`user:<id>`／`group:<id>`／`org:<id>`；裸的 userId 視同 `user:<id>`。不合格式回 null（不收）。 */
const OWNER_KEY_RE = /^(?:user|group|org):[A-Za-z0-9_-]{1,128}$/;
export function canonicalOwner(owner) {
  const s = String(owner ?? "").trim();
  if (!s) return null;
  const key = s.includes(":") ? s : `user:${s}`;
  return OWNER_KEY_RE.test(key) ? key : null;
}

/** 覆寫表的大小上限：超過就丟最舊的（最壞是那個 owner 回到全站值，下一次 app 推送又補回）。 */
export const MAX_OWNER_OVERRIDES = 20_000;

export function createLimits({ env = process.env, maxOverrides = MAX_OWNER_OVERRIDES } = {}) {
  let pushed = null;
  const overrides = new Map(); // canonical owner → bytes（0 ＝ 不設限）
  const fromEnv = () => ({
    personal: parseBytes(env?.WORKSPACE_USER_QUOTA_BYTES) ?? DEFAULT_QUOTA_BYTES,
    shared: parseBytes(env?.WORKSPACE_SHARED_QUOTA_BYTES) ?? DEFAULT_QUOTA_BYTES,
  });
  return {
    /** 這個 owner 的上限（位元組）；0 ＝ 不設限。 */
    forOwner(owner) {
      const key = canonicalOwner(owner);
      if (key !== null && overrides.has(key)) return overrides.get(key);
      const v = pushed ?? fromEnv();
      return isPersonalOwner(owner) ? v.personal : v.shared;
    },
    /**
     * app 推送。全站值（personalBytes＋sharedBytes）與 owners 覆寫都可選，但至少要有一樣；
     * 送了的部分**整包合法才收**（全站兩個值要一起合法；owners 裡任一筆不合法就整個 owners 不收），回是否收下。
     */
    set({ personalBytes, sharedBytes, owners } = {}) {
      const hasGlobal = personalBytes !== undefined || sharedBytes !== undefined;
      const hasOwners = owners !== undefined && owners !== null;
      if (!hasGlobal && !hasOwners) return false;
      let global = null;
      if (hasGlobal) {
        const p = parseBytes(personalBytes);
        const s = parseBytes(sharedBytes);
        if (p === null || s === null) return false;
        global = { personal: p, shared: s };
      }
      const updates = [];
      if (hasOwners) {
        if (typeof owners !== "object" || Array.isArray(owners)) return false;
        for (const [raw, value] of Object.entries(owners)) {
          const key = canonicalOwner(raw);
          if (key === null) return false;
          if (value === null) { updates.push([key, null]); continue; }
          const b = parseBytes(value);
          if (b === null) return false;
          updates.push([key, b]);
        }
      }
      if (global) pushed = global;
      for (const [key, b] of updates) {
        overrides.delete(key); // 重新插入 → 移到最新（丟最舊的時候用）
        if (b !== null) overrides.set(key, b);
      }
      while (overrides.size > maxOverrides) overrides.delete(overrides.keys().next().value);
      return true;
    },
    snapshot() {
      const v = pushed ?? fromEnv();
      return { personalBytes: v.personal, sharedBytes: v.shared, source: pushed ? "app" : "env", ownerOverrides: overrides.size };
    },
  };
}
