/**
 * assertion-policy.test.mjs —— 三個入口（單一動作核准、註冊／撤銷的簽署者、登入授權）
 * 共用的那一份「這張 WebAuthn 斷言本身可不可以收」。
 *
 * 規矩（2026-10-02 UV／rpId／origin 評估）：
 *   · 預設只拒絕「沒有任何合法路徑」的東西（crossOrigin）；
 *   · UV、origin、rpId 預設只**記錄**（evidence），不當門 —— 2026-09-20 同一把同步 passkey
 *     在手機 UV=1、在桌機 UV=0，把使用者鎖死過；
 *   · strict（使用者在自己電腦上明確開）才把 UV／origin／rpId 變成門；
 *   · enforceOrigin 是登入授權那條**既有**的底線（本來就一律比 origin／rpId），不可以因為
 *     共用而變鬆。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { checkAssertion, formatEvidence } from "./assertion-policy.mjs";

const sha256 = (b) => createHash("sha256").update(b).digest();
const APP = "https://ava.example.com";

function authData({ up = true, uv = false, host = "ava.example.com", len = 37 } = {}) {
  const b = Buffer.alloc(len);
  sha256(Buffer.from(host)).copy(b, 0);
  b[32] = (up ? 1 : 0) | (uv ? 4 : 0);
  return b;
}
const cd = (over = {}) => ({ type: "webauthn.get", challenge: "x", origin: APP, ...over });

test("evidence：UV 位元、origin、rpId、crossOrigin 各自被如實記下", () => {
  const r = checkAssertion(authData({ uv: true }), cd(), { appOrigin: APP });
  assert.deepEqual(r.evidence, { uv: true, rpIdMatches: true, originMatches: true, crossOrigin: false, origin: APP });
  const r2 = checkAssertion(authData({ uv: false, host: "evil.example.com" }), cd({ origin: "https://x.example.com" }), { appOrigin: APP });
  assert.equal(r2.evidence.uv, false);
  assert.equal(r2.evidence.rpIdMatches, false);
  assert.equal(r2.evidence.originMatches, false);
});

test("沒有 appOrigin 可比 → rpIdMatches／originMatches 是 null，不是 false", () => {
  const r = checkAssertion(authData(), cd(), {});
  assert.equal(r.evidence.rpIdMatches, null);
  assert.equal(r.evidence.originMatches, null);
  assert.equal(r.ok, true);
});

test("預設（沒有 strict）：UV=0、origin 不符、rpId 不符都照舊放行 —— 只記錄", () => {
  const r = checkAssertion(authData({ uv: false, host: "other.example.com" }), cd({ origin: "https://sub.example.com" }), { appOrigin: APP });
  assert.equal(r.ok, true);
});

test("crossOrigin:true 一律拒絕（沒有任何合法流程走跨來源 iframe），不需要 strict", () => {
  const r = checkAssertion(authData({ uv: true }), cd({ crossOrigin: true }), { appOrigin: APP });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "approval_cross_origin");
  assert.equal(checkAssertion(authData(), cd({ crossOrigin: true }), {}).reason, "approval_cross_origin");
  // false／缺省照舊
  assert.equal(checkAssertion(authData(), cd({ crossOrigin: false }), { appOrigin: APP }).ok, true);
});

test("strict：UV=0 → approval_not_verified，訊息說得出怎麼辦", () => {
  const r = checkAssertion(authData({ uv: false }), cd(), { appOrigin: APP, strict: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "approval_not_verified");
  assert.match(r.message, /ava-local devices strict off/);
  assert.equal(checkAssertion(authData({ uv: true }), cd(), { appOrigin: APP, strict: true }).ok, true);
});

test("strict：origin 不符 → approval_origin_mismatch，訊息帶期望值與實際值", () => {
  const r = checkAssertion(authData({ uv: true }), cd({ origin: "https://sub.example.com" }), { appOrigin: APP, strict: true });
  assert.equal(r.reason, "approval_origin_mismatch");
  assert.match(r.message, /https:\/\/ava\.example\.com/);
  assert.match(r.message, /https:\/\/sub\.example\.com/);
  assert.match(r.message, /ava-local devices strict off/);
});

test("strict：rpIdHash 不符 → approval_origin_mismatch", () => {
  const r = checkAssertion(authData({ uv: true, host: "other.example.com" }), cd(), { appOrigin: APP, strict: true });
  assert.equal(r.reason, "approval_origin_mismatch");
  assert.match(r.message, /ava\.example\.com/);
});

test("strict 卻沒有 appOrigin → 判斷不出來就拒絕（不是放行）", () => {
  const r = checkAssertion(authData({ uv: true }), cd(), { strict: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "approval_origin_unknown");
});

test("enforceOrigin（登入授權的既有底線）：不開 strict 也比 origin／rpId，但 UV 不是門", () => {
  assert.equal(checkAssertion(authData({ uv: false }), cd(), { appOrigin: APP, enforceOrigin: true }).ok, true);
  assert.equal(checkAssertion(authData(), cd({ origin: "https://sub.example.com" }), { appOrigin: APP, enforceOrigin: true }).reason, "approval_origin_mismatch");
  assert.equal(checkAssertion(authData({ host: "other.example.com" }), cd(), { appOrigin: APP, enforceOrigin: true }).reason, "approval_origin_mismatch");
});

test("authenticatorData 短於 37 位元組 → 不收（跟登入授權原本的長度底線一致）", () => {
  const r = checkAssertion(authData({ len: 36 }), cd(), { appOrigin: APP });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "auth_data_unreadable");
});

test("子網域主機名不算同一個 rpId（精確比對，不做 allow-origin 清單）", () => {
  const r = checkAssertion(authData({ uv: true, host: "x.ava.example.com" }), cd({ origin: "https://x.ava.example.com" }), { appOrigin: APP, strict: true });
  assert.equal(r.reason, "approval_origin_mismatch");
});

test("formatEvidence：稽核列只放 uv／rp／origin 三個短標記，沒有 origin 全文", () => {
  assert.equal(formatEvidence({ uv: true, rpIdMatches: true, originMatches: true, crossOrigin: false, origin: APP }), "uv=1 rp=ok origin=ok");
  assert.equal(formatEvidence({ uv: false, rpIdMatches: false, originMatches: false, crossOrigin: false, origin: "https://x" }), "uv=0 rp=bad origin=bad");
  assert.equal(formatEvidence({ uv: false, rpIdMatches: null, originMatches: null, crossOrigin: false, origin: null }), "uv=0 rp=- origin=-");
  assert.equal(formatEvidence({ uv: true, rpIdMatches: true, originMatches: true, crossOrigin: true, origin: APP }), "uv=1 rp=ok origin=ok cross=1");
  assert.equal(formatEvidence(null), "");
});
