/**
 * device-approval.test.mjs —— 雲端偽造得出核准嗎？
 *
 * 每一條都對著一個**具體的攻擊**寫，不是對著函式簽名寫。這支檔案的價值全在
 * 「壞的簽不進來」，所以失敗的案例比成功的案例多，而且每一條都說得出它擋的
 * 是誰。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, createHash, randomUUID } from "node:crypto";

import { encodeDeviceClaims, challengeFor, verifyDeviceApproval } from "./device-approval.mjs";

const b64url = (b) => Buffer.from(b).toString("base64url");
const sha256 = (b) => createHash("sha256").update(b).digest();

/** 一把假的 passkey。瀏覽器的 getPublicKey() 給的就是 SPKI。 */
function makeCredential() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { id: randomUUID(), publicKey, privateKey };
}

/** 模擬驗證器：簽 authenticatorData || sha256(clientDataJSON)。 */
function assertFor(cred, claimsB64, { up = true, uv = false, challenge, origin = "https://agent.dev.unieai.com", host = "rpid", extra = {} } = {}) {
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge: challenge ?? challengeFor(claimsB64), origin, ...extra }),
  );
  const authData = Buffer.alloc(37);
  sha256(Buffer.from(host)).copy(authData, 0);
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

const CLAIMS = { invokeId: "act-1", machineId: "m-1", tool: "exec", payloadHash: "ph-1" };
const expect_ = { machineId: "m-1", tool: "exec", payloadHash: "ph-1" };
const keysFor = (cred) => new Map([[cred.id, cred.publicKey]]);

test("使用者裝置簽的核准驗得過", () => {
  const cred = makeCredential();
  const c = encodeDeviceClaims(CLAIMS);
  const v = verifyDeviceApproval(c, assertFor(cred, c), expect_, { keys: keysFor(cred) });
  assert.equal(v.ok, true);
});

test("**雲端沒有私鑰,所以偽造不出來** —— 這是整個方案的重點", () => {
  const real = makeCredential();
  const attacker = makeCredential(); // 被攻破的 app 自己生一把
  const c = encodeDeviceClaims(CLAIMS);
  // 用攻擊者的金鑰簽，但冒用使用者註冊過的 credentialId
  const forged = assertFor(attacker, c);
  forged.credentialId = real.id;
  const v = verifyDeviceApproval(c, forged, expect_, { keys: keysFor(real) });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "bad_signature");
});

test("沒註冊過的憑證一律不認 —— 雲端不能自己加一把公鑰", () => {
  const other = makeCredential();
  const c = encodeDeviceClaims(CLAIMS);
  const v = verifyDeviceApproval(c, assertFor(other, c), expect_, { keys: keysFor(makeCredential()) });
  assert.equal(v.reason, "unknown_credential");
});

test("換了指令就對不上 —— assertion 綁的是這一組 claims", () => {
  const cred = makeCredential();
  const c = encodeDeviceClaims(CLAIMS);
  const a = assertFor(cred, c);
  // app 想把同一張核准套到別的 payload 上
  const v = verifyDeviceApproval(c, a, { ...expect_, payloadHash: "ph-2" }, { keys: keysFor(cred) });
  assert.equal(v.reason, "payload_mismatch");
});

test("拿別處取得的合法 assertion 來用 → challenge 對不上", () => {
  const cred = makeCredential();
  const c = encodeDeviceClaims(CLAIMS);
  const a = assertFor(cred, c, { challenge: b64url(Buffer.from("別的東西")) });
  assert.equal(verifyDeviceApproval(c, a, expect_, { keys: keysFor(cred) }).reason, "challenge_mismatch");
});

test("別台機器的票不能用在這一台", () => {
  const cred = makeCredential();
  const c = encodeDeviceClaims({ ...CLAIMS, machineId: "m-2" });
  assert.equal(verifyDeviceApproval(c, assertFor(cred, c), expect_, { keys: keysFor(cred) }).reason, "wrong_machine");
});

test("過期的不收", () => {
  const cred = makeCredential();
  const c = encodeDeviceClaims({ ...CLAIMS, iat: 1000, exp: 2000 });
  assert.equal(verifyDeviceApproval(c, assertFor(cred, c), expect_, { keys: keysFor(cred), now: 3000 }).reason, "expired");
});

test("使用者不在場（UP 沒亮）不算同意", () => {
  const cred = makeCredential();
  const c = encodeDeviceClaims(CLAIMS);
  const a = assertFor(cred, c, { up: false });
  assert.equal(verifyDeviceApproval(c, a, expect_, { keys: keysFor(cred) }).reason, "user_not_present");
});

test("同一張票不能用第二次", () => {
  const cred = makeCredential();
  const c = encodeDeviceClaims(CLAIMS);
  const a = assertFor(cred, c);
  const seen = new Set();
  const nonces = { seen: (id) => seen.has(id), remember: (id) => seen.add(id) };
  assert.equal(verifyDeviceApproval(c, a, expect_, { keys: keysFor(cred), nonces }).ok, true);
  assert.equal(verifyDeviceApproval(c, a, expect_, { keys: keysFor(cred), nonces }).reason, "replayed");
});

test("註冊儀式的 assertion 不能拿來當核准", () => {
  const cred = makeCredential();
  const c = encodeDeviceClaims(CLAIMS);
  const a = assertFor(cred, c);
  const cd = JSON.parse(Buffer.from(a.clientDataJSON, "base64url").toString());
  cd.type = "webauthn.create";
  a.clientDataJSON = b64url(Buffer.from(JSON.stringify(cd)));
  assert.equal(verifyDeviceApproval(c, a, expect_, { keys: keysFor(cred) }).reason, "wrong_ceremony");
});

// ── 2026-10-02：UV／rpId／origin 加固（assertion-policy.mjs 共用）──────────────

const APP = "https://agent.dev.unieai.com";
const APP_HOST = "agent.dev.unieai.com";

test("evidence：ok 與失敗兩種結果都帶著 UV／rpId／origin 的事實", () => {
  const cred = makeCredential();
  const c = encodeDeviceClaims(CLAIMS);
  const ok = verifyDeviceApproval(c, assertFor(cred, c, { uv: true, host: APP_HOST }), expect_, { keys: keysFor(cred), appOrigin: APP });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.evidence, { uv: true, rpIdMatches: true, originMatches: true, crossOrigin: false, origin: APP });
  const noOrigin = verifyDeviceApproval(c, assertFor(cred, c), expect_, { keys: keysFor(cred) });
  assert.equal(noOrigin.ok, true);
  assert.equal(noOrigin.evidence.uv, false);
  assert.equal(noOrigin.evidence.rpIdMatches, null);
});

test("沒開 strict：UV=0／origin 不符／rpId 不符的結果與加固前逐字相同（ok）", () => {
  const cred = makeCredential();
  const c = encodeDeviceClaims(CLAIMS);
  const a = assertFor(cred, c, { uv: false, origin: "https://sub.unieai.com", host: "somewhere-else" });
  const v = verifyDeviceApproval(c, a, expect_, { keys: keysFor(cred), appOrigin: APP });
  assert.equal(v.ok, true);
  assert.equal(v.evidence.originMatches, false);
  assert.equal(v.evidence.rpIdMatches, false);
});

test("crossOrigin:true 一律拒絕，沒開 strict 也是", () => {
  const cred = makeCredential();
  const c = encodeDeviceClaims(CLAIMS);
  const v = verifyDeviceApproval(c, assertFor(cred, c, { uv: true, host: APP_HOST, extra: { crossOrigin: true } }), expect_, { keys: keysFor(cred), appOrigin: APP });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "approval_cross_origin");
  // 拒絕的那一次不能燒掉 nonce（還沒簽過就被擋，不該影響重試）
  const seen = new Set();
  const nonces = { seen: (id) => seen.has(id), remember: (id) => seen.add(id) };
  verifyDeviceApproval(c, assertFor(cred, c, { extra: { crossOrigin: true } }), expect_, { keys: keysFor(cred), nonces });
  assert.equal(seen.size, 0);
  // false／缺省照舊
  assert.equal(verifyDeviceApproval(c, assertFor(cred, c, { extra: { crossOrigin: false } }), expect_, { keys: keysFor(cred) }).ok, true);
});

test("strict：UV=0 → approval_not_verified；origin／rpId 不符 → approval_origin_mismatch；全符合 → ok", () => {
  const cred = makeCredential();
  const c = encodeDeviceClaims(CLAIMS);
  const deps = { keys: keysFor(cred), appOrigin: APP, strict: true };
  const noUv = verifyDeviceApproval(c, assertFor(cred, c, { uv: false, host: APP_HOST }), expect_, deps);
  assert.equal(noUv.reason, "approval_not_verified");
  assert.match(noUv.message, /ava-local devices strict off/);
  assert.equal(noUv.evidence.uv, false);
  const badOrigin = verifyDeviceApproval(c, assertFor(cred, c, { uv: true, host: APP_HOST, origin: "https://sub.unieai.com" }), expect_, deps);
  assert.equal(badOrigin.reason, "approval_origin_mismatch");
  assert.match(badOrigin.message, /agent\.dev\.unieai\.com/);
  assert.match(badOrigin.message, /sub\.unieai\.com/);
  const badRp = verifyDeviceApproval(c, assertFor(cred, c, { uv: true, origin: APP, host: "elsewhere" }), expect_, deps);
  assert.equal(badRp.reason, "approval_origin_mismatch");
  assert.equal(verifyDeviceApproval(c, assertFor(cred, c, { uv: true, host: APP_HOST }), expect_, deps).ok, true);
});

test("enforceOrigin（登入授權的底線）不需要 strict，UV 也不是門", () => {
  const cred = makeCredential();
  const c = encodeDeviceClaims(CLAIMS);
  const deps = { keys: keysFor(cred), appOrigin: APP, enforceOrigin: true };
  assert.equal(verifyDeviceApproval(c, assertFor(cred, c, { uv: false, host: APP_HOST }), expect_, deps).ok, true);
  assert.equal(verifyDeviceApproval(c, assertFor(cred, c, { host: APP_HOST, origin: "https://x.unieai.com" }), expect_, deps).reason, "approval_origin_mismatch");
});

test("政策拒絕發生在簽章通過之後：簽章不對的斷言仍然先報 bad_signature", () => {
  const real = makeCredential();
  const attacker = makeCredential();
  const c = encodeDeviceClaims(CLAIMS);
  const forged = assertFor(attacker, c, { uv: true, host: APP_HOST, extra: { crossOrigin: true } });
  forged.credentialId = real.id;
  assert.equal(verifyDeviceApproval(c, forged, expect_, { keys: keysFor(real), appOrigin: APP }).reason, "bad_signature");
});
