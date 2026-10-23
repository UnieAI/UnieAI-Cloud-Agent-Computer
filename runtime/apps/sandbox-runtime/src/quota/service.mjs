/**
 * quota/service.mjs —— 把「上限值」「用量」「閘」接在一起，並且把量用量的成本壓住。
 *
 * 用量是 S3 列表（workspace/ 底下每個物件），所以每個 owner 的結果快取 `ttlMs`（預設 5 秒），
 * 同時在飛的同一個 owner 只量一次（singleflight）。寫入成功後 `noteWrite` 把增量加進快取，
 * 這樣連續上傳不必每一檔都重量，也不會因為快取而一路超過上限。
 */
import { assertWithinQuota, quotaState } from "./gate.mjs";

export function createQuotaService({ limits, measure, existingSizeOf = async () => 0, ttlMs = 5_000, now = Date.now }) {
  const cache = new Map(); // owner → { at, bytes, truncated }
  const inflight = new Map();

  async function used(owner, { fresh = false } = {}) {
    const hit = cache.get(owner);
    if (hit && !fresh && now() - hit.at < ttlMs) return hit;
    if (inflight.has(owner)) return inflight.get(owner);
    const p = (async () => {
      try {
        const m = await measure(owner);
        const entry = { at: now(), bytes: m.bytes, truncated: m.truncated === true };
        cache.set(owner, entry);
        return entry;
      } finally {
        inflight.delete(owner);
      }
    })();
    inflight.set(owner, p);
    return p;
  }

  return {
    /** 面板／app 要看的狀態。 */
    async state(owner, opts) {
      const u = await used(owner, opts);
      return { ...quotaState({ usedBytes: u.bytes, limitBytes: limits.forOwner(owner) }), truncated: u.truncated };
    },
    /** 寫入前：放不下就丟 413。沒有上限（0）時連量都不量。 */
    async check({ owner, relPath, incomingBytes }) {
      const limitBytes = limits.forOwner(owner);
      if (!(limitBytes > 0)) return;
      const u = await used(owner);
      const existingBytes = await existingSizeOf(owner, relPath).catch(() => 0);
      assertWithinQuota({ relPath, incomingBytes, existingBytes, usedBytes: u.bytes, limitBytes });
    },
    /** 寫入成功後：把增量記進快取（沒有快取就什麼都不做，下一次會重量）。 */
    noteWrite(owner, deltaBytes) {
      const hit = cache.get(owner);
      if (hit) hit.bytes = Math.max(0, hit.bytes + deltaBytes);
    },
    forget(owner) { cache.delete(owner); },
  };
}
