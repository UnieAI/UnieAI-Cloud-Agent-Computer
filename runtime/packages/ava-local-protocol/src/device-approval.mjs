/**
 * device-approval.mjs — **使用者的裝置**簽的核准，雲端偽造不出來。
 *
 * ## 這是在補哪一個洞
 *
 * `approval.mjs` 的註解自己寫著那個誠實的限制（ADR-0005）：HMAC 金鑰是 app 跟
 * daemon **共用**的，所以那張票證明的是「這個核准經過 app 之後沒有被改」，
 * 不是「app 本身是誠實的」。
 *
 * 換句話說：任何能在 app 行程裡執行程式碼的人，都可以對**任何一台已配對的
 * 機器**簽出一張合法的票，而使用者不必按任何東西。整條鏈的安全性因此等於
 * app 行程的安全性 —— 而 2026-07-09 那台正式站的 app 容器日誌裡，出現過完整
 * 的環境變數傾印和 RCE 探測指令。
 *
 * 那個 `alg` 欄位存在的理由就是這個。這支檔案把它接起來。
 *
 * ## 性質只有一句
 *
 * **私鑰從來沒有到過我們的伺服器。** 攻擊者拿到整台 app、整個資料庫，也偽造
 * 不出一張核准，因為他沒有那把私鑰。他能做的只剩下「發出請求」，而那一步會
 * 出現在使用者面前，使用者不按就沒有下文。
 *
 * ## 為什麼是 WebAuthn 而不是自己存一把金鑰
 *
 * 自己在 IndexedDB 放一把 ECDSA 也能達到「雲端沒有私鑰」，但有兩個實際問題：
 * 清掉網站資料就沒了，而且**換一台裝置就用不了** —— roy 第一個問的就是
 * 「我在手機上的 web UI 操作怎麼辦」。passkey 會跟著平台鑰匙圈同步，而且有
 * 硬體保護。代價是每次簽章都要一次生物辨識或 PIN，見下面「摩擦」。
 *
 * ## 這支檔案刻意**不**做的事
 *
 * 註冊（把一把新的公鑰加進這台機器的信任清單）**不在這裡**，而且不可以由
 * app 說了算。如果雲端能自己加一把公鑰，攻擊者不用偽造簽章，直接註冊自己的
 * 金鑰就好，方案等於白做。註冊必須由**已經註冊過的裝置**簽，或者在那台電腦
 * 上當面確認。那是另一支檔案的事，這裡只負責驗。
 *
 * ## 摩擦怎麼處理
 *
 * 不是每一筆請求都要交握。今天唯讀又在授權資料夾內的指令本來就自動放行，
 * 完全不受影響；付出代價的只有本來就要按的那些。嫌按太多次的話，可以簽一張
 * **有範圍的授權**（這個動詞、這台機器、N 分鐘內有效），那是拿爆炸半徑換
 * 摩擦，而且那個取捨是明講的、可以調的。這支檔案的 `scope` 欄位為它留位置。
 */

import { createHash, createVerify } from "node:crypto";

import { checkAssertion } from "./assertion-policy.mjs";

/** 一張裝置簽的核准最多活多久。比 HMAC 那張長一點 —— 生物辨識要花時間。 */
export const DEVICE_APPROVAL_TTL_MS = 300_000;

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const fromB64url = (s) => Buffer.from(String(s), "base64url");
const sha256 = (buf) => createHash("sha256").update(buf).digest();

/**
 * 要簽的東西。
 *
 * **這一串就是 challenge**：瀏覽器把它的雜湊放進 WebAuthn 的 challenge，
 * 所以那張 assertion 只對這一組 claims 有效。換一個指令、換一台機器、
 * 換一個 payload，雜湊就變了，assertion 對不上。
 *
 * @param {object} claims { invokeId, machineId, tool, payloadHash, scope?, iat, exp }
 * @returns {string} base64url 的 claims
 */
export function encodeDeviceClaims(claims) {
  for (const f of ["invokeId", "machineId", "tool", "payloadHash"]) {
    if (!claims?.[f] || typeof claims[f] !== "string") {
      throw new Error(`encodeDeviceClaims: ${f} is required`);
    }
  }
  const now = Number(claims.iat ?? Date.now());
  return b64url(
    JSON.stringify({
      v: 1,
      alg: "webauthn",
      invokeId: claims.invokeId,
      machineId: claims.machineId,
      tool: claims.tool,
      payloadHash: claims.payloadHash,
      // 有範圍的授權：留位置給「這個動詞、N 分鐘內」那種一次簽、多次用。
      // 沒有就是一次性的單一動作。
      scope: claims.scope ?? null,
      iat: now,
      exp: Number(claims.exp ?? now + DEVICE_APPROVAL_TTL_MS),
    }),
  );
}

/** 瀏覽器要放進 WebAuthn challenge 的那串 —— claims 的雜湊，不是 claims 本身。 */
export function challengeFor(claimsB64) {
  return b64url(sha256(Buffer.from(String(claimsB64), "utf8")));
}

/**
 * 驗一張裝置簽的核准。
 *
 * @param {string} claimsB64  encodeDeviceClaims 的輸出
 * @param {object} assertion  { credentialId, authenticatorData, clientDataJSON, signature }（都是 base64url）
 * @param {object} expect     { machineId, tool, subject }  —— subject 由呼叫端自己算，這裡只比雜湊
 * @param {object} deps       { keys: Map<credentialId, spkiPemOrDer>, now?, nonces?,
 *                              appOrigin?, strict?, enforceOrigin? }  —— 後三個交給 `assertion-policy.mjs`
 * @returns {{ ok: true, claims: object, evidence: object } | { ok: false, reason: string, message?: string, evidence?: object | null }}
 */
export function verifyDeviceApproval(claimsB64, assertion, expect, deps) {
  let claims;
  try {
    claims = JSON.parse(fromB64url(claimsB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "claims_unreadable" };
  }
  if (claims?.v !== 1 || claims?.alg !== "webauthn") return { ok: false, reason: "claims_unsupported" };

  const now = Number(deps?.now ?? Date.now());
  if (!Number.isFinite(claims.exp) || now > claims.exp) return { ok: false, reason: "expired" };
  // 未來的票也不收 —— 時鐘歪掉或有人想把有效期往後推。
  if (Number.isFinite(claims.iat) && claims.iat - 60_000 > now) return { ok: false, reason: "not_yet_valid" };

  if (claims.machineId !== expect?.machineId) return { ok: false, reason: "wrong_machine" };
  if (claims.tool !== expect?.tool) return { ok: false, reason: "wrong_tool" };
  if (claims.payloadHash !== expect?.payloadHash) return { ok: false, reason: "payload_mismatch" };

  const credId = String(assertion?.credentialId ?? "");
  const key = deps?.keys?.get?.(credId);
  // 不認得的憑證就是不認得 —— **這一條是整個方案的支點**：雲端沒有辦法
  // 把自己的公鑰加進這張表（註冊不由它決定，見檔頭）。
  if (!key) return { ok: false, reason: "unknown_credential" };

  let clientData;
  let clientDataRaw;
  try {
    clientDataRaw = fromB64url(assertion.clientDataJSON);
    clientData = JSON.parse(clientDataRaw.toString("utf8"));
  } catch {
    return { ok: false, reason: "client_data_unreadable" };
  }
  if (clientData?.type !== "webauthn.get") return { ok: false, reason: "wrong_ceremony" };
  // **challenge 綁的是這一組 claims。** 少了這一條，一張在別處取得的合法
  // assertion 可以被拿來核准任何東西。
  if (clientData?.challenge !== challengeFor(claimsB64)) return { ok: false, reason: "challenge_mismatch" };

  let authData;
  try {
    authData = fromB64url(assertion.authenticatorData);
  } catch {
    return { ok: false, reason: "auth_data_unreadable" };
  }
  // UP（使用者真的在場）那個 bit 一定要亮。沒有它，這張簽章可能來自一個
  // 沒有人碰過的驗證器 —— 那就不再是「使用者按了同意」。
  if (authData.length < 33 || (authData[32] & 0x01) !== 0x01) return { ok: false, reason: "user_not_present" };

  const signed = Buffer.concat([authData, sha256(clientDataRaw)]);
  let good = false;
  try {
    const v = createVerify("sha256");
    v.update(signed);
    v.end();
    good = v.verify(key, fromB64url(assertion.signature));
  } catch {
    return { ok: false, reason: "bad_key" };
  }
  if (!good) return { ok: false, reason: "bad_signature" };

  // 簽章對了才看斷言本身（crossOrigin／strict 的 UV、origin、rpId）：規則在
  // `assertion-policy.mjs`，三個入口共用同一份。放在 nonce 之前 —— 被政策擋下的
  // 斷言不該燒掉一次性登記。
  const policy = checkAssertion(authData, clientData, {
    appOrigin: deps?.appOrigin, strict: deps?.strict, enforceOrigin: deps?.enforceOrigin,
  });
  if (!policy.ok) return { ok: false, reason: policy.reason, message: policy.message, evidence: policy.evidence };

  // 一次性：同一張票不可以用第二次。呼叫端沒給登記表就跳過（測試用），
  // 但正式路徑一定要給 —— 重放是這條路最便宜的攻擊。
  if (deps?.nonces) {
    const id = `${claims.invokeId}:${credId}`;
    if (deps.nonces.seen?.(id)) return { ok: false, reason: "replayed" };
    deps.nonces.remember?.(id, claims.exp);
  }

  return { ok: true, claims, evidence: policy.evidence };
}
