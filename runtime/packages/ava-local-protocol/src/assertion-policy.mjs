/**
 * assertion-policy.mjs — 一張 WebAuthn 斷言**本身**可不可以收。三個入口共用這一份：
 *
 *   · `verifyDeviceApproval`（單一動作核准）
 *   · `verifyEnrollment`（註冊／撤銷的簽署者）
 *   · `session-authorization.activate`（登入授權）
 *
 * ## 為什麼要共用
 *
 * 以前只有登入授權比 `origin`／`rpIdHash`／`crossOrigin`，另外兩個入口沒有 —— 同一條規則兩份
 * 實作、只做了一份（2026-10-02 評估）。這裡把它收成一個函式，三個入口只負責「把斷言交進來、
 * 說自己的底線是什麼」，**不再各自判斷**。`apps/ava-local/test/assertion-policy-parity.test.ts`
 * 用同一組斷言打三個真入口，釘住判斷一致。
 *
 * ## 三種強度（刻意分開）
 *
 *   1. **永遠拒絕**：`clientData.crossOrigin === true`。沒有任何合法流程走跨來源 iframe。
 *   2. **底線**（`enforceOrigin`）：origin 與 rpIdHash 必須等於配對時的 app。只有登入授權有這條底線
 *      （它原本就比），共用之後不可以變鬆，所以是參數而不是預設。
 *   3. **strict**（使用者在自己電腦上用 `ava-local devices strict on` 明確開）：UV 必須亮，
 *      並且 origin／rpIdHash 精確一致。預設關。
 *
 * ## 為什麼 UV 預設不是門
 *
 * 2026-09-20：同一把同步的 passkey，手機做 UV（UV=1）、桌機的 Google 密碼管理工具回 UV=0，
 * 使用者被鎖在「一直回到同一個畫面」。我們沒有歷史資料知道有多少人是這樣，所以預設只**記錄**
 * （`evidence`），要不要當門由使用者本人決定。也**不做**「看過 UV=1 就從此要求」的自動收緊 ——
 * 那會在同一個情境重現鎖死。
 *
 * 這支檔案是純函式：不讀檔、不看時間、不記狀態。
 */
import { createHash } from "node:crypto";

const sha256 = (buf) => createHash("sha256").update(buf).digest();

/** 稽核列用的簽章事實。 */
/** @typedef {{ uv: boolean, rpIdMatches: boolean | null, originMatches: boolean | null, crossOrigin: boolean, origin: string | null }} AssertionEvidence */

const STRICT_OFF = "要關掉這個模式：在這台電腦上執行 ava-local devices strict off，再重開 daemon（ava-local stop && ava-local run）。";

function appParts(appOrigin) {
  if (!appOrigin) return null;
  try {
    const u = new URL(String(appOrigin));
    return { origin: u.origin, hostname: u.hostname };
  } catch {
    return null;
  }
}

/**
 * 只讀事實：不下判斷。`appOrigin` 沒給（或讀不懂）時，rpId／origin 兩格是 `null`（不是 false）。
 *
 * @param {Buffer} authData      已經解 base64url 的 authenticatorData
 * @param {object} clientData    已經解析的 clientDataJSON
 * @param {string | undefined} appOrigin
 * @returns {AssertionEvidence}
 */
export function inspectAssertion(authData, clientData, appOrigin) {
  const app = appParts(appOrigin);
  const origin = typeof clientData?.origin === "string" ? clientData.origin.slice(0, 200) : null;
  const rpIdHash = authData.subarray(0, 32);
  return {
    uv: (authData[32] & 0x04) === 0x04,
    rpIdMatches: app ? rpIdHash.equals(sha256(Buffer.from(app.hostname))) : null,
    originMatches: app ? clientData?.origin === app.origin : null,
    crossOrigin: clientData?.crossOrigin === true,
    origin,
  };
}

/**
 * 拿已經取得的事實（`inspectAssertion`）按政策下判斷。分開匯出是因為 daemon 的「strict 試簽」要對
 * **已經收下的**斷言問「如果當時是 strict 會不會過」—— 同一份規則，不另寫一份。
 *
 * @param {AssertionEvidence} evidence
 * @param {{ appOrigin?: string, strict?: boolean, enforceOrigin?: boolean }} policy
 * @returns {{ ok: true } | { ok: false, reason: string, message: string }}
 */
export function judgeEvidence(evidence, policy = {}) {
  if (evidence.crossOrigin) {
    return { ok: false, reason: "approval_cross_origin", message: "這張簽章是在跨來源的 iframe 裡簽的；Ava 沒有任何流程這樣做，所以不收。" };
  }

  const mustMatchOrigin = policy.strict === true || policy.enforceOrigin === true;
  if (mustMatchOrigin) {
    const app = appParts(policy.appOrigin);
    if (!app) {
      // 要比卻沒有東西可比：判斷不出來就拒絕，不是放行。
      return { ok: false, reason: "approval_origin_unknown", message: `這台電腦不知道它配對的 Ava 網址，所以無法確認簽章來自哪裡。${STRICT_OFF}` };
    }
    if (evidence.originMatches === false) {
      return {
        ok: false, reason: "approval_origin_mismatch",
        message: `簽章來自 ${evidence.origin ?? "(未知來源)"}，這台電腦配對的是 ${app.origin}。${policy.strict ? STRICT_OFF : ""}`.trim(),
      };
    }
    if (evidence.rpIdMatches === false) {
      return {
        ok: false, reason: "approval_origin_mismatch",
        message: `這把 passkey 簽的網域（rpId）不是 ${app.hostname}。${policy.strict ? STRICT_OFF : ""}`.trim(),
      };
    }
  }

  if (policy.strict === true && !evidence.uv) {
    return {
      ok: false, reason: "approval_not_verified",
      message: `strict 模式要求每一次核准都做使用者驗證（PIN／生物辨識），但這張簽章沒有。${STRICT_OFF}`,
    };
  }
  return { ok: true };
}

/**
 * 這張斷言本身收不收。
 *
 * @param {Buffer} authData
 * @param {object} clientData
 * @param {{ appOrigin?: string, strict?: boolean, enforceOrigin?: boolean }} policy
 * @returns {{ ok: true, evidence: AssertionEvidence } | { ok: false, reason: string, message: string, evidence: AssertionEvidence | null }}
 */
export function checkAssertion(authData, clientData, policy = {}) {
  // 37 ＝ rpIdHash(32) + flags(1) + signCount(4)。真的驗證器不會更短；登入授權原本就要求這個長度。
  if (!Buffer.isBuffer(authData) || authData.length < 37) {
    return { ok: false, reason: "auth_data_unreadable", message: "authenticatorData 太短，不是合法的 WebAuthn 斷言。", evidence: null };
  }
  const evidence = inspectAssertion(authData, clientData, policy.appOrigin);
  const verdict = judgeEvidence(evidence, policy);
  return verdict.ok ? { ok: true, evidence } : { ...verdict, evidence };
}

/**
 * 稽核列的後綴：`uv=1 rp=ok origin=ok`。**只有三個短標記**（跨來源才多一個 `cross=1`）——
 * 不含 origin 全文、claims、簽章或 credentialId。
 *
 * @param {AssertionEvidence | null | undefined} e
 */
export function formatEvidence(e) {
  if (!e) return "";
  const tri = (v) => (v === null || v === undefined ? "-" : v ? "ok" : "bad");
  return `uv=${e.uv ? 1 : 0} rp=${tri(e.rpIdMatches)} origin=${tri(e.originMatches)}${e.crossOrigin ? " cross=1" : ""}`;
}
