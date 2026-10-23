/**
 * quota/tenants.mjs —— 列出每一個要管的 tenant：它的 owner（算用量用）與 filer 前綴（設唯讀用）。
 *
 * 兩種版面（見 workspace/tenant-store.mjs）：
 *   · 隔離（SANDBOX_ISOLATED_TENANTS 的白名單，或 all）：`/buckets/ws-<kind>-<id>/workspace/`
 *   · 舊共用 bucket：`/buckets/<bucket>/{users|groups|orgs}/<id>/workspace/`，用 delimiter 列表枚舉（一個 tenant 一列，列舉是完整的）
 * 被隔離的租戶在舊 bucket 裡可能還留著舊的一份 —— 那一份不再被使用，**不列**（不然會對一個沒人在用的前綴設唯讀）。
 *
 * bucket 只看 `S3_BUCKET`：沙盒掛載（cube/docker.mjs 的 `resolveWorkspaceLocation`）自 2026-09-07 起走 `resolveTenantStore`，
 * **不再讀 `WEED_S3_BUCKET`**，store 也只讀 `S3_BUCKET`，所以兩邊是同一個 bucket。這裡以前還讀 `WEED_S3_BUCKET` 並把
 * 兩邊的前綴都列，那是過時的假設：一旦有人在環境裡設了它（`.env` 就有，值是 `agent-fs`），強制器會把唯讀鎖上在一個
 * 沒有人寫的 bucket（agent-fs 套件自己的資料）。adapters.test.mjs 有一條拿真的掛載解析器對照這件事。
 */
import { listCommonPrefixes as realListCommonPrefixes } from "../../../../packages/storage-engine/src/index.mjs";
import { systemLocation } from "../../../../packages/storage-engine/src/location.mjs";
import { isolatedOwners, parseOwner, tenantBucketName } from "../workspace/tenant-store.mjs";

const LEGACY_KINDS = [["users", "user"], ["groups", "group"], ["orgs", "org"]];

export function createTenantLister({ env = process.env, listCommonPrefixes = realListCommonPrefixes, listIsolatedBuckets = async () => [] } = {}) {
  return async function listTenants() {
    const store = String(env.S3_BUCKET || "").trim();
    const legacyBuckets = store ? [store] : [];
    const { all, set } = isolatedOwners(env);
    const out = [];
    const isolatedSeen = new Set();

    for (const key of set) {
      const { kind, id } = parseOwner(key);
      isolatedSeen.add(`${kind}:${id}`);
      out.push({ owner: `${kind}:${id}`, prefix: `/buckets/${tenantBucketName({ kind, id })}/workspace/` });
    }
    // `all`：每個 ws-<kind>-<id> bucket 都是一個隔離租戶（bucket 名稱是小寫的；id 是 uuid，本來就小寫）。
    if (all) {
      for (const name of await listIsolatedBuckets()) {
        const m = /^ws-(user|org|group)-(.+)$/.exec(String(name));
        if (!m) continue;
        isolatedSeen.add(`${m[1]}:${m[2]}`);
        out.push({ owner: `${m[1]}:${m[2]}`, prefix: `/buckets/${name}/workspace/` });
      }
    }

    for (const [dir, kind] of LEGACY_KINDS) {
      const prefixes = await listCommonPrefixes({ at: systemLocation(`${dir}/`, "quota: enumerate legacy tenants") });
      for (const p of prefixes) {
        const id = String(p).slice(dir.length + 1).replace(/\/$/, "");
        if (!id) continue;
        if (isolatedSeen.has(`${kind}:${id}`)) continue;
        for (const bucket of legacyBuckets) out.push({ owner: `${kind}:${id}`, prefix: `/buckets/${bucket}/${dir}/${id}/workspace/` });
      }
    }
    return out;
  };
}
