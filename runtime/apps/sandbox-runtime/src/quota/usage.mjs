/**
 * quota/usage.mjs —— 一個 owner 的 workspace/ 用了多少（logical 大小，物件大小加總）。
 *
 * **只量 workspace/**，不量它的兄弟 `.platform/`、`.snapshots/`（owner 決定：計算使用者看得到、刪得掉的）。
 * 用 S3 列表加總（`listObjectsByPrefix`）而不是 manifest：bash 經掛載寫的檔案不進 manifest，而那正是要擋的路徑。
 * 列表有上限（maxItems）；到上限就**回 truncated，不假裝量準** —— 呼叫端把它當成「至少這麼多」。
 */
import { listObjectsByPrefix } from "../../../../packages/storage-engine/src/index.mjs";
import { tenantWorkspaceLocation } from "../workspace/tenant-store.mjs";

export const USAGE_MAX_ITEMS = 200_000;

export async function measureWorkspaceBytes(owner, { list = listObjectsByPrefix, maxItems = USAGE_MAX_ITEMS } = {}) {
  const at = tenantWorkspaceLocation(owner, "");
  const rows = await list({ at, maxItems });
  let bytes = 0;
  for (const r of rows) bytes += Number(r.sizeBytes) || 0;
  return { bytes, objects: rows.length, truncated: rows.length >= maxItems };
}
