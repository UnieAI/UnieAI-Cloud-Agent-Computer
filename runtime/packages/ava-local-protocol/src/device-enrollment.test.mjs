/**
 * device-enrollment.test.mjs —— 雲端能不能把自己的公鑰加進來？
 *
 * 這一支比 device-approval 那一支更重要。核准那邊的性質（雲端偽造不出來）
 * **完全取決於這裡**：只要雲端能註冊一把自己的金鑰，它就不必偽造，光明正大
 * 地簽就好。所以每一條都在問「這條路能不能被繞過」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, createHash, randomUUID } from "node:crypto";

import { encodeEnrollment, enrollmentChallenge, verifyEnrollment } from "./device-enrollment.mjs";

const b64url = (b) => Buffer.from(b).toString("base64url");
const sha256 = (b) => createHash("sha256").update(b).digest();

function makeCredential() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { id: randomUUID(), publicKey, privateKey };
}

function signBy(cred, enrollB64, { up = true, uv = false, challenge, origin, host, extra = {} } = {}) {
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge: challenge ?? enrollmentChallenge(enrollB64), ...(origin ? { origin } : {}), ...extra }),
  );
  const authData = Buffer.alloc(37);
  if (host) sha256(Buffer.from(host)).copy(authData, 0);
  authData[32] = (up ? 0x01 : 0x00) | (uv ? 0x04 : 0);
  const s = createSign("sha256");
  s.update(Buffer.concat([authData, sha256(clientDataJSON)]));
  s.end();
  return {
    credentialId: cred.id,
    authenticatorData: b64url(authData),
    clientDataJSON: b64url(clientDataJSON),
    signature: b64url(s.sign(cred.privateKey)),
  };
}

const MID = "m-1";
const add = (cred, over = {}) =>
  encodeEnrollment({ op: "add", machineId: MID, credentialId: cred.id, publicKey: cred.publicKey, ...over });

test("第一把:人就在那台電腦前面,本機確認就算數", () => {
  const first = makeCredential();
  const v = verifyEnrollment(add(first), null, { machineId: MID, keys: new Map(), localConfirm: true });
  assert.equal(v.ok, true);
});

test("已經有金鑰之後,本機確認**不再**是捷徑", () => {
  // 否則一個能在那台機器上跑程式的人就能替自己加一把。使用者的電腦不是可信
  // 環境,它只是「他的」。
  const existing = makeCredential();
  const attacker = makeCredential();
  const v = verifyEnrollment(add(attacker), null, {
    machineId: MID,
    keys: new Map([[existing.id, existing.publicKey]]),
    localConfirm: true,
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "local_confirm_not_allowed_after_first");
});

test("**被攻破的雲端加不進自己的金鑰** —— 這是整支檔案的重點", () => {
  const user = makeCredential();
  const attacker = makeCredential();
  // 雲端自己生一對,自己簽自己進來
  const req = add(attacker);
  const v = verifyEnrollment(req, signBy(attacker, req), {
    machineId: MID,
    keys: new Map([[user.id, user.publicKey]]),
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "signer_not_trusted");
});

test("拿已信任的 id 但用別的私鑰簽 → 簽章對不上", () => {
  const user = makeCredential();
  const attacker = makeCredential();
  const req = add(attacker);
  const forged = signBy(attacker, req);
  forged.credentialId = user.id;
  const v = verifyEnrollment(req, forged, { machineId: MID, keys: new Map([[user.id, user.publicKey]]) });
  assert.equal(v.reason, "bad_signature");
});

test("已信任的裝置可以加第二把（手機）", () => {
  const laptop = makeCredential();
  const phone = makeCredential();
  const req = add(phone);
  const v = verifyEnrollment(req, signBy(laptop, req), {
    machineId: MID,
    keys: new Map([[laptop.id, laptop.publicKey]]),
  });
  assert.equal(v.ok, true);
  assert.equal(v.req.credentialId, phone.id);
});

test("不可以自己簽自己進來", () => {
  const me = makeCredential();
  const req = add(me);
  const v = verifyEnrollment(req, signBy(me, req), { machineId: MID, keys: new Map([[me.id, me.publicKey]]) });
  assert.equal(v.reason, "self_signed");
});

test("撤銷也要簽 —— 雲端不能把使用者的金鑰全拔掉", () => {
  // 拔光了就回到「只有 HMAC」的世界,也就是雲端自己說了算。
  const laptop = makeCredential();
  const phone = makeCredential();
  const keys = new Map([[laptop.id, laptop.publicKey], [phone.id, phone.publicKey]]);
  const req = encodeEnrollment({ op: "remove", machineId: MID, credentialId: phone.id });
  // 本機確認走不通。兩條規則都會擋（「有金鑰之後本機確認不算」比「本機確認
  // 只能 add」先撞到），這裡只斷言**擋住了**：挑一個特定的理由會讓這條測試
  // 綁在檢查順序上，而順序不是它要守的東西。
  assert.equal(verifyEnrollment(req, null, { machineId: MID, keys, localConfirm: true }).ok, false);
  // 已信任的裝置簽過就算數。
  assert.equal(verifyEnrollment(req, signBy(laptop, req), { machineId: MID, keys }).ok, true);
});

test("一把都沒有的時候,本機確認只能用來 add", () => {
  const cred = makeCredential();
  const req = encodeEnrollment({ op: "remove", machineId: MID, credentialId: cred.id });
  const v = verifyEnrollment(req, null, { machineId: MID, keys: new Map(), localConfirm: true });
  assert.equal(v.reason, "local_confirm_add_only");
});

test("不可以撤到一把都不剩", () => {
  // 撤到零把,下一次註冊就落回本機確認那條,等於任何能在那台機器上跑程式的
  // 人都能接管。
  const only = makeCredential();
  const keys = new Map([[only.id, only.publicKey]]);
  const req = encodeEnrollment({ op: "remove", machineId: MID, credentialId: only.id });
  assert.equal(verifyEnrollment(req, signBy(only, req), { machineId: MID, keys }).reason, "would_leave_none");
});

test("別台機器的註冊請求不算數", () => {
  const cred = makeCredential();
  const req = add(cred, { machineId: "m-2" });
  assert.equal(verifyEnrollment(req, null, { machineId: MID, keys: new Map(), localConfirm: true }).reason, "wrong_machine");
});

test("沒有簽也沒有本機確認 → 什麼都不算", () => {
  const cred = makeCredential();
  assert.equal(verifyEnrollment(add(cred), null, { machineId: MID, keys: new Map() }).reason, "unsigned");
});

// ── 2026-10-02：簽署者的斷言也走共用的 assertion-policy ─────────────────────────

const APP = "https://agent.dev.unieai.com";
const APP_HOST = "agent.dev.unieai.com";

test("簽署者 crossOrigin:true → approval_cross_origin（沒開 strict 也是）", () => {
  const trusted = makeCredential();
  const phone = makeCredential();
  const e = add(phone);
  const r = verifyEnrollment(e, signBy(trusted, e, { extra: { crossOrigin: true } }), { machineId: MID, keys: new Map([[trusted.id, trusted.publicKey]]) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "approval_cross_origin");
});

test("沒開 strict：簽署者 UV=0／origin 不符照舊 ok，並帶 evidence", () => {
  const trusted = makeCredential();
  const phone = makeCredential();
  const e = add(phone);
  const r = verifyEnrollment(e, signBy(trusted, e, { origin: "https://sub.unieai.com", host: "elsewhere" }),
    { machineId: MID, keys: new Map([[trusted.id, trusted.publicKey]]), appOrigin: APP });
  assert.equal(r.ok, true);
  assert.equal(r.evidence.uv, false);
  assert.equal(r.evidence.originMatches, false);
});

test("strict：簽署者 UV=0 → approval_not_verified；origin 不符 → approval_origin_mismatch；全符合 → ok", () => {
  const trusted = makeCredential();
  const phone = makeCredential();
  const e = add(phone);
  const deps = { machineId: MID, keys: new Map([[trusted.id, trusted.publicKey]]), appOrigin: APP, strict: true };
  assert.equal(verifyEnrollment(e, signBy(trusted, e, { origin: APP, host: APP_HOST }), deps).reason, "approval_not_verified");
  assert.equal(verifyEnrollment(e, signBy(trusted, e, { uv: true, origin: "https://x.unieai.com", host: APP_HOST }), deps).reason, "approval_origin_mismatch");
  assert.equal(verifyEnrollment(e, signBy(trusted, e, { uv: true, origin: APP, host: APP_HOST }), deps).ok, true);
});

test("本機當面確認（第一把）沒有斷言，strict 不影響它", () => {
  const first = makeCredential();
  const r = verifyEnrollment(add(first), null, { machineId: MID, keys: new Map(), localConfirm: true, appOrigin: APP, strict: true });
  assert.equal(r.ok, true);
});
