/**
 * quota/gate.mjs —— 寫入前的即時門（上傳、檔案面板、agent 的 write/edit 都走 user-workspace-upload）。
 *
 * 規則（owner 2026-10-02）：
 *   · 只計 workspace/ —— 平台自己的狀態（.opencode／memory／skills，實際放在 .platform/）不算也不擋。
 *   · 超過 ＝ 唯讀＋可刪＋提示：**變大的寫入擋下；縮小或不變的放行**（使用者要能改小檔案釋放空間），刪除不經過這裡。
 *   · 上傳先比對剩餘空間，直接說「這個檔案 X MB，超過雲端剩餘空間 Y MB」，不等傳完才失敗（大小在 header 就知道）。
 */
import { SandboxError } from "../shared/error.mjs";
import { platformRelOf } from "../workspace/userStore.mjs";

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** 回給 app／面板的狀態物件。 */
export function quotaState({ usedBytes, limitBytes }) {
  const unlimited = !(limitBytes > 0);
  return {
    usedBytes,
    limitBytes,
    remainingBytes: unlimited ? null : Math.max(0, limitBytes - usedBytes),
    over: !unlimited && usedBytes > limitBytes,
    unlimited,
  };
}

/**
 * 放不下就丟 413 `workspace_quota_exceeded`。
 * `existingBytes`：這個路徑現有檔案的大小（覆蓋只算增量）。
 */
export function assertWithinQuota({ relPath, incomingBytes, existingBytes = 0, usedBytes, limitBytes }) {
  if (!(limitBytes > 0)) return;
  if (platformRelOf(relPath)) return;
  const delta = incomingBytes - existingBytes;
  if (delta <= 0) return; // 縮小或不變：永遠放行
  if (usedBytes + delta <= limitBytes) return;
  const remaining = Math.max(0, limitBytes - usedBytes);
  throw new SandboxError(
    "workspace_quota_exceeded",
    `這個檔案 ${mb(incomingBytes)}，超過雲端剩餘空間 ${mb(remaining)}（已用 ${mb(usedBytes)} / ${mb(limitBytes)}）。請改用地端沙盒（Rabi Local），或先刪除一些檔案。`,
    413,
    { usedBytes, limitBytes, remainingBytes: remaining, incomingBytes, path: relPath },
  );
}
