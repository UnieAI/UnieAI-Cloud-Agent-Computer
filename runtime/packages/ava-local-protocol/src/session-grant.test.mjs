import test from "node:test";
import assert from "node:assert/strict";

import { APPROVAL_OPS } from "./canonical.mjs";
import { LEGACY_SESSION_GRANT_TOOLS, SESSION_GRANT_TOOLS, sessionGrantTools } from "./session-grant.mjs";

/**
 * 登入授權（passkey 一次、24 小時）能簽哪些動作。
 *
 * 2026-09-24：使用者在「略過核准」模式、連線條寫著「已授權 · 剩 24 小時」，啟動本機代理
 * 還是跳出指紋／臉部辨識。這份清單以前寫死成 exec／writeFile／ensureDir，而且**三個地方
 * 各寫一份**（daemon 的 verifyAction、瀏覽器的 signApproval、伺服器的核准路由）——
 * agentSession、terminalOpen、deleteFile、mcpCall 每一次都要 passkey。
 */
test("新 daemon：每一種要核准的動作都在登入授權裡 —— 跟 APPROVAL_OPS 一模一樣（多一種動作這裡先紅）", () => {
  assert.deepEqual([...sessionGrantTools("0.2.14")].sort(), [...APPROVAL_OPS].sort());
  assert.deepEqual([...SESSION_GRANT_TOOLS].sort(), [...APPROVAL_OPS].sort());
  for (const tool of ["agentSession", "terminalOpen", "deleteFile", "mcpCall"]) assert.ok(sessionGrantTools("0.3.0").includes(tool), tool);
});

test("舊 daemon 只認三種 —— 對它簽別的會被拒，所以瀏覽器要走 passkey", () => {
  assert.deepEqual([...sessionGrantTools("0.2.13")], ["exec", "writeFile", "ensureDir"]);
  assert.deepEqual([...LEGACY_SESSION_GRANT_TOOLS], ["exec", "writeFile", "ensureDir"]);
  for (const v of [null, undefined, "", "garbage", "0.2.9"]) assert.deepEqual([...sessionGrantTools(v)], ["exec", "writeFile", "ensureDir"], String(v));
});
