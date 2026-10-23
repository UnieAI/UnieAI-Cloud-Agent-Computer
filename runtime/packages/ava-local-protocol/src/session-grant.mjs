/**
 * 登入授權（passkey 一次、最長 1 週、整台機器）能簽哪些動作 —— daemon、伺服器、瀏覽器
 * **共用這一份**。
 *
 * 2026-09-24：使用者在「略過核准」模式、連線條寫著「已授權 · 剩 24 小時」，啟動本機代理
 * 還是跳出指紋／臉部辨識。這份清單以前寫死成 exec／writeFile／ensureDir，而且三個地方
 * 各寫一份；agentSession、terminalOpen、deleteFile、mcpCall 每一次都要 passkey。
 *
 * 全部放進來不是放寬：exec 本來就在裡面，而能跑任意指令的授權已經做得到刪檔、開 shell、
 * 起行程。多要一次指紋擋不住任何 exec 擋不住的事，只擋掉了「登入授權一次」這個承諾。
 *
 * **寫成字面值，而不是從 APPROVAL_OPS 展開**：瀏覽器也要讀這一份，而 canonical.mjs 用
 * node:crypto，進不了前端的包。它跟 APPROVAL_OPS 一模一樣由 session-grant.test.mjs 綁住 ——
 * 以後多一種要核准的動作，那條測試會先紅。
 */

/** 0.2.14 起的 daemon：每一種要核准的動作（＝ APPROVAL_OPS）。 */
export const SESSION_GRANT_TOOLS = Object.freeze(["exec", "writeFile", "deleteFile", "ensureDir", "terminalOpen", "mcpCall", "agentSession"]);

/** 0.2.13 以前的 daemon 只認這三種；對它們簽別的會被拒（grant_action_rejected）。 */
export const LEGACY_SESSION_GRANT_TOOLS = Object.freeze(["exec", "writeFile", "ensureDir"]);

/** 第一個收得下完整清單的 daemon。 */
export const FULL_SESSION_GRANT_DAEMON = "0.2.14";

/** 這台 daemon 的登入授權能簽哪些動作。認不出版本 ＝ 當成舊的（簽了會被拒比多問一次糟）。 */
export function sessionGrantTools(daemonVersion) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(daemonVersion ?? ""));
  if (!m) return LEGACY_SESSION_GRANT_TOOLS;
  const [major, minor, patch] = m.slice(1).map(Number);
  const full = major > 0 || minor > 2 || (minor === 2 && patch >= 14);
  return full ? SESSION_GRANT_TOOLS : LEGACY_SESSION_GRANT_TOOLS;
}
