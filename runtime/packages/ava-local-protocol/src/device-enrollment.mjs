/**
 * device-enrollment.mjs — 誰可以把一把新的公鑰加進這台機器的信任清單。
 *
 * ## 這是整個方案的死穴
 *
 * `device-approval.mjs` 的性質是「雲端偽造不出核准，因為它沒有私鑰」。那個性質
 * **完全取決於這支檔案**：如果雲端能自己把一把公鑰加進信任清單，攻擊者根本
 * 不用偽造簽章 —— 註冊一把自己的，然後光明正大地簽。方案等於白做。
 *
 * 所以這裡的規則只有一條，而且沒有例外：
 *
 *   **一把新的公鑰，要嘛由一把已經信任的公鑰簽過，要嘛在那台電腦上當面確認。**
 *
 * app 的角色只有郵差。它看得到、改不了、加不進去。
 *
 * ## 第一把怎麼來
 *
 * 雞生蛋的問題只有一次：配對的時候。那一刻使用者**人就在那台電腦前面**
 * （他剛剛才打開那個檔案或貼了那行指令），所以第一把由 daemon 在本機接受，
 * 這跟「當面確認」是同一件事，不是例外。
 *
 * 第一把之後，新增與撤銷都要走簽章。
 *
 * ## 撤銷比新增更重要
 *
 * 手機掉了要能拔掉那一把。而**撤銷不能由雲端說了算** —— 否則被攻破的雲端
 * 只要把使用者所有的金鑰撤掉，就回到「只有 HMAC」的世界，也就是它自己說了算。
 * 所以撤銷跟新增同一條規則。
 *
 * 全部的金鑰都掉了就回那台電腦重新配對。雲端沒有後門是刻意的：有後門的話，
 * 雲端被攻破就等於有一條現成的路。
 */

import { createHash, createVerify } from "node:crypto";

import { checkAssertion } from "./assertion-policy.mjs";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const fromB64url = (s) => Buffer.from(String(s), "base64url");
const sha256 = (buf) => createHash("sha256").update(buf).digest();

/**
 * 一次註冊／撤銷的意圖，簽章要蓋的就是這一串。
 *
 * `op` 只有兩種，而且**撤銷也要簽** —— 見檔頭。
 *
 * @param {object} req { op: "add"|"remove", machineId, credentialId, publicKey?, label?, iat, exp }
 */
export function encodeEnrollment(req) {
  if (req?.op !== "add" && req?.op !== "remove") throw new Error("encodeEnrollment: op must be add|remove");
  for (const f of ["machineId", "credentialId"]) {
    if (!req?.[f] || typeof req[f] !== "string") throw new Error(`encodeEnrollment: ${f} is required`);
  }
  if (req.op === "add" && !req.publicKey) throw new Error("encodeEnrollment: add needs publicKey");
  const now = Number(req.iat ?? Date.now());
  return b64url(
    JSON.stringify({
      v: 1,
      op: req.op,
      machineId: req.machineId,
      credentialId: req.credentialId,
      // SPKI（瀏覽器 getPublicKey() 給的就是這個）。撤銷不需要。
      publicKey: req.op === "add" ? String(req.publicKey) : null,
      label: req.label ?? null,
      iat: now,
      exp: Number(req.exp ?? now + 600_000),
    }),
  );
}

/** 簽註冊請求的那個裝置，要把這一串放進 WebAuthn 的 challenge。 */
export function enrollmentChallenge(enrollB64) {
  return b64url(sha256(Buffer.from(String(enrollB64), "utf8")));
}

/**
 * 這次註冊／撤銷算不算數。
 *
 * @param {string} enrollB64  encodeEnrollment 的輸出
 * @param {object} by         { credentialId, authenticatorData, clientDataJSON, signature }
 *                            —— 由**一把已經信任的**裝置簽；`null` 代表這是本機當面確認
 * @param {object} deps       { machineId, keys: Map<credId, spki>, localConfirm?: boolean, now?,
 *                              appOrigin?, strict?, enforceOrigin? }  —— 後三個交給 `assertion-policy.mjs`
 * @returns {{ ok: true, req: object, evidence?: object } | { ok: false, reason: string, message?: string, evidence?: object | null }}
 */
export function verifyEnrollment(enrollB64, by, deps) {
  let req;
  try {
    req = JSON.parse(fromB64url(enrollB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (req?.v !== 1) return { ok: false, reason: "unsupported" };
  if (req.machineId !== deps?.machineId) return { ok: false, reason: "wrong_machine" };

  const now = Number(deps?.now ?? Date.now());
  if (!Number.isFinite(req.exp) || now > req.exp) return { ok: false, reason: "expired" };

  const known = deps?.keys instanceof Map ? deps.keys : new Map();

  // ── 第一把：本機當面確認 ────────────────────────────────────────────
  //
  // 只有在**還沒有任何一把**的時候才成立。清單上已經有金鑰之後，本機確認
  // 不再是一條捷徑 —— 否則一個能在那台機器上跑程式的人就能替自己加一把，
  // 而那正是我們假設會發生的事（使用者的電腦不是可信環境，它只是**他的**）。
  if (!by) {
    if (!deps?.localConfirm) return { ok: false, reason: "unsigned" };
    if (known.size > 0) return { ok: false, reason: "local_confirm_not_allowed_after_first" };
    if (req.op !== "add") return { ok: false, reason: "local_confirm_add_only" };
    return { ok: true, req };
  }

  // ── 其餘：要由一把已經信任的金鑰簽 ──────────────────────────────────
  const signerId = String(by?.credentialId ?? "");
  const signerKey = known.get(signerId);
  if (!signerKey) return { ok: false, reason: "signer_not_trusted" };

  // **不可以自己簽自己進來。** 少了這一條，任何人送一對自產的金鑰＋自簽的
  // 請求就進得來，而那就是把整條信任鏈接到一個外人手上。
  if (req.op === "add" && signerId === req.credentialId) return { ok: false, reason: "self_signed" };

  // 也不可以自己把自己撤掉之外的最後一把撤掉 —— 撤到零把，下一次註冊就會
  // 落回「本機當面確認」那條，等於任何能在那台機器上跑程式的人都能接管。
  if (req.op === "remove" && known.size <= 1) return { ok: false, reason: "would_leave_none" };

  let clientDataRaw;
  let clientData;
  try {
    clientDataRaw = fromB64url(by.clientDataJSON);
    clientData = JSON.parse(clientDataRaw.toString("utf8"));
  } catch {
    return { ok: false, reason: "client_data_unreadable" };
  }
  if (clientData?.type !== "webauthn.get") return { ok: false, reason: "wrong_ceremony" };
  if (clientData?.challenge !== enrollmentChallenge(enrollB64)) return { ok: false, reason: "challenge_mismatch" };

  let authData;
  try {
    authData = fromB64url(by.authenticatorData);
  } catch {
    return { ok: false, reason: "auth_data_unreadable" };
  }
  if (authData.length < 33 || (authData[32] & 0x01) !== 0x01) return { ok: false, reason: "user_not_present" };

  let good = false;
  try {
    const v = createVerify("sha256");
    v.update(Buffer.concat([authData, sha256(clientDataRaw)]));
    v.end();
    good = v.verify(signerKey, fromB64url(by.signature));
  } catch {
    return { ok: false, reason: "bad_key" };
  }
  if (!good) return { ok: false, reason: "bad_signature" };

  // 簽署者的斷言跟單一動作核准走同一份政策（`assertion-policy.mjs`）。
  const policy = checkAssertion(authData, clientData, {
    appOrigin: deps?.appOrigin, strict: deps?.strict, enforceOrigin: deps?.enforceOrigin,
  });
  if (!policy.ok) return { ok: false, reason: policy.reason, message: policy.message, evidence: policy.evidence };

  return { ok: true, req, evidence: policy.evidence };
}
