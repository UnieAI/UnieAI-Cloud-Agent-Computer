import { callerForToken, loadCallers } from "./callers.mjs";
import crypto from "node:crypto";

import { config } from "../config.mjs";
import { log } from "./log.mjs";

/**
 * Constant-time string compare. `a !== b` exits at the first differing byte,
 * which lets a caller on the same network learn a valid signature or bearer
 * one byte at a time from response timing. Unequal lengths are rejected up
 * front (timingSafeEqual requires equal lengths) — length is not secret here.
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function getBearerToken(headers) {
  const raw = headers?.authorization || headers?.Authorization || "";
  if (!raw) return "";
  const match = String(raw).match(/^bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

/**
 * Decode + verify an HS256 JWT. Returns the decoded payload or throws.
 * Minimal in-house impl so sandbox-runtime stays dep-light (jsonwebtoken is
 * 100KB; we only need verify here).
 */
function verifyHs256Jwt(token, secret) {
  if (!token || typeof token !== "string") throw new Error("missing_token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed_jwt");
  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  if (!safeEqual(expected, sigB64)) throw new Error("invalid_signature");
  let payload;
  try {
    const padded = payloadB64 + "=".repeat((4 - payloadB64.length % 4) % 4);
    const decoded = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    payload = JSON.parse(decoded);
  } catch {
    throw new Error("malformed_payload");
  }
  if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error("expired");
  return payload;
}

/**
 * Verify caller auth + optionally enforce per-session ownership.
 *
 * Two acceptable token shapes:
 *   1. Plain `SANDBOX_INTERNAL_TOKEN` — operator-wide bearer. Single shared
 *      secret; what M0/M1 shipped.
 *   2. HS256 JWT signed with `SANDBOX_JWT_SECRET` carrying
 *      `{ tenant_id, custom_model_id, session_id, exp }`
 *      so the runtime can scope per-tenant. If `expectedSessionId` is
 *      supplied by the caller (from URL params) and the JWT carries a
 *      different session_id, the request is rejected.
 *
 * Returns: { ok: true, claims? } | { ok: false, reason }
 *
 * Operators can leave SANDBOX_JWT_SECRET unset; sandbox-runtime then accepts
 * bearer tokens only, and rejects every JWT.
 *
 * ## 為什麼 JWT 的金鑰**不會**退回共用的 internal token
 *
 * 那個退路以前存在（`SANDBOX_JWT_SECRET || config.internalToken`），而它把兩種
 * 完全不同的憑證合成一種：internal token 只證明「呼叫者是引擎」，JWT 裡的
 * `tenant_id` 說的是「這一次是替誰做的」。金鑰一樣的時候，任何拿到那個共用
 * bearer 的人都可以自己簽一張寫著別人 tenant 的票 —— 也就是說，一個本來只該
 * 讓人「以引擎身分呼叫」的祕密，順便變成了「冒充任何租戶」的祕密。
 *
 * 所以現在沒有退路：`SANDBOX_JWT_SECRET` 沒設就是不收 JWT。這個部署本來也沒有
 * 任何地方在簽這種票（2026-09-11 掃過，只有測試在用），所以拿掉它不影響任何
 * 正在跑的東西。
 */
export function verifyInternalToken(req, { expectedSessionId = null } = {}) {
  const callers = loadCallers();
  if (!config.internalToken && !callers.length) {
    return { ok: false, reason: "internal_token_not_configured" };
  }
  const bearer = getBearerToken(req.headers);
  const header = req.headers["x-sandbox-internal-token"];
  const supplied = bearer || (typeof header === "string" ? header.trim() : "");
  if (!supplied) {
    return { ok: false, reason: "missing_token" };
  }

  // Direct bearer match — pre-existing behaviour, allows ops scripts etc.
  if (config.internalToken && safeEqual(supplied, config.internalToken)) {
    return { ok: true };
  }

  // A namespaced caller's own key (shared/callers.mjs). Its identity is
  // rewritten into its namespace by the server before any route runs.
  const caller = callerForToken(supplied, callers);
  if (caller) return { ok: true, caller };

  // JWT path — useful when llm-runtime mints per-request tokens carrying
  // tenant context. **只有 SANDBOX_JWT_SECRET 有設才收**，見檔頭：拿共用的
  // internal token 當簽章金鑰，等於讓每一個知道那個 bearer 的人都能冒充任何租戶。
  const jwtSecret = String(process.env.SANDBOX_JWT_SECRET || "").trim();
  if (!jwtSecret) return { ok: false, reason: "invalid_token" };
  try {
    const claims = verifyHs256Jwt(supplied, jwtSecret);
    if (claims.aud && claims.aud !== "sandbox-runtime") {
      return { ok: false, reason: "wrong_audience" };
    }
    if (expectedSessionId && claims.session_id && claims.session_id !== expectedSessionId) {
      return { ok: false, reason: "session_mismatch" };
    }
    return { ok: true, claims };
  } catch (err) {
    return { ok: false, reason: err?.message || "invalid_token" };
  }
}

// Signed-identity channel (the app is the only minter). SANDBOX_IDENTITY_SECRET
// is shared ONLY between the app and sandbox-runtime — the engine never sees it
// and can only FORWARD the x-sandbox-user-jwt the app minted, so a compromised
// engine can replay a recent expiry-bound assertion but not mint arbitrary
// identities. SANDBOX_REQUIRE_SIGNED_IDENTITY=1 flips fail-closed: the plain
// x-sandbox-user-id fallback stops being accepted (flip only after every
// caller path demonstrably sends the JWT — watch the auth.unsigned_identity
// log line for stragglers).
const IDENTITY_SECRET = String(process.env.SANDBOX_IDENTITY_SECRET || "").trim();
const REQUIRE_SIGNED_IDENTITY = /^(1|true)$/i.test(String(process.env.SANDBOX_REQUIRE_SIGNED_IDENTITY || ""));

/**
 * Resolve the user the caller is acting ON BEHALF OF, for cross-tenant
 * ownership checks. Sources, in order of trust:
 *
 *   1. A verified caller-auth JWT claim (`user_id` / legacy `tenant_id`).
 *   2. A verified `x-sandbox-user-jwt` — the APP-minted signed identity
 *      assertion (cannot be forged without SANDBOX_IDENTITY_SECRET).
 *   3. The plain `x-sandbox-user-id` header. NOT signed; trustworthy only
 *      because the shared internal token authenticated the caller as a trusted
 *      subsystem. Disabled when SANDBOX_REQUIRE_SIGNED_IDENTITY=1.
 *
 * Returns the userId string, or null when the caller asserted no identity.
 */
export function resolveCallerUserId(req, claims = null) {
  // A namespaced caller vouches for its own users with its key; the header was
  // already rewritten into its namespace (shared/callers.mjs namespaceRequest),
  // and any app-signed identity it sent was dropped there.
  if (req?.cacCaller) {
    const h = req.headers?.["x-sandbox-user-id"];
    return typeof h === "string" && h.trim() ? h.trim() : null;
  }
  const fromJwt = claims?.user_id || claims?.tenant_id || null;
  if (fromJwt) return String(fromJwt).trim() || null;

  const idJwt = req?.headers?.["x-sandbox-user-jwt"];
  if (IDENTITY_SECRET && typeof idJwt === "string" && idJwt.trim()) {
    try {
      const p = verifyHs256Jwt(idJwt.trim(), IDENTITY_SECRET);
      if ((!p.aud || p.aud === "sandbox-runtime") && p.user_id) {
        const uid = String(p.user_id).trim();
        if (uid) return uid;
      }
    } catch {
      // Invalid/expired signed assertion: under REQUIRE we fail closed below;
      // otherwise fall through to the legacy header (rollout compatibility).
    }
  }

  if (IDENTITY_SECRET && REQUIRE_SIGNED_IDENTITY) return null; // fail closed

  const header = req?.headers?.["x-sandbox-user-id"];
  if (typeof header === "string" && header.trim()) {
    // ── 誰還沒帶簽章 ────────────────────────────────────────────────────
    //
    // 上面那段註解一直寫著「翻旗標之前先盯 `auth.unsigned_identity` 找落單的
    // 呼叫端」——**而那行日誌從來沒有被發出過**。於是唯一一個能在翻旗標之前
    // 告訴你「還有誰會 403」的訊號，是一個不存在的東西；要知道答案只能真的翻
    // 下去，而翻下去的代價是整條引擎路徑斷線。這裡把它補上。
    //
    // 只在**設了 secret**的時候記：沒設 secret 的部署，明文是唯一的路，
    // 那不是落單，是正常。
    //
    // 同一條路徑只吵一次。這坐在每一個受保護請求的路徑上，而這則訊息的價值
    // 是「有哪些路徑」，不是「有幾次」—— 每次都印會把它自己埋掉。
    if (IDENTITY_SECRET) noteUnsignedIdentity(req, idJwt);
    return header.trim();
  }
  return null;
}

/** 已經吵過的 `方法 路徑`。行程級，重啟就重數 —— 那正是「翻旗標前觀察一段時間」的窗口。 */
const unsignedSeen = new Set();

function noteUnsignedIdentity(req, idJwt) {
  try {
    // query string 拿掉：`/v1/sandboxes/<id>/exec` 的 id 每次都不一樣，
    // 帶著它等於沒有去重。路徑裡的 id 也一併折疊。
    const raw = String(req?.url ?? "").split("?")[0];
    const route = raw.replace(/\/[^/]{16,}(?=\/|$)/g, "/:id");
    // 去重的 key 帶上種類：先發生的那一種會把另一種吃掉，而它們的下一步不同。
    const key = `${req?.method ?? "?"} ${route} ${typeof idJwt === "string" && idJwt.trim() ? "rejected" : "absent"}`;
    if (unsignedSeen.has(key)) return;
    unsignedSeen.add(key);
    // **「沒帶」跟「帶了但不收」要分開講。** 兩種都會在
    // SANDBOX_REQUIRE_SIGNED_IDENTITY=1 之後 403，但下一步完全不同：
    //   · 沒帶 → 那個呼叫端還沒接上鑄造（改程式）
    //   · 帶了不收 → 過期、或兩邊不是同一把密鑰（改設定）
    // 而後者是這條路最可能的長期失敗模式：引擎存的那張票 30 分鐘過期，
    // 一個閒置很久的對話再動作時帶的就是舊的。只寫「沒帶」會把人送去改程式。
    const presented = typeof idJwt === "string" && idJwt.trim().length > 0;
    log("warn", "auth.unsigned_identity", {
      route: key,
      presented,
      hint: presented
        ? "這個呼叫端帶了 x-sandbox-user-jwt，但驗不過（過期，或兩邊不是同一把 SANDBOX_IDENTITY_SECRET）。開了 SANDBOX_REQUIRE_SIGNED_IDENTITY=1 之後它會 403 caller_identity_required。"
        : "這個呼叫端只帶了 x-sandbox-user-id，沒有 x-sandbox-user-jwt。開了 SANDBOX_REQUIRE_SIGNED_IDENTITY=1 之後它會 403 caller_identity_required。",
    });
  } catch {
    // 記不到就算了 —— 這是觀測，不是授權。
  }
}

/**
 * 「這通呼叫是後台管理員發的嗎？」——只有**列出**與**釋放**沙盒這兩條路用得到。
 *
 * 為什麼需要它：開了 SANDBOX_ENFORCE_OWNERSHIP 之後，GET /v1/sandboxes 只回呼叫者
 * 自己那幾個、DELETE /v1/sandboxes/:id 只放行自己的。這對 agent 是對的，但後台的
 * 「現在有哪些沙盒活著」本來就是**跨租戶**的問題：管理員看不到配額被誰佔著，就沒
 * 辦法幫人放掉。（roy 2026-09-06 撞到的正是這件事：他被 429 擋住，後台卻什麼都
 * 看不到，模型只好自己編了一個不存在的頁面叫他去關沙盒。）
 *
 * 信任來源刻意跟 resolveCallerUserId 分開：
 *   1. app 用 SANDBOX_IDENTITY_SECRET 簽出來、帶 `scope:"platform-admin"` 的
 *      x-sandbox-user-jwt。有設 secret 時**只認這個** —— 這是管理員權限，不該
 *      退回一個沒有簽章的 header。
 *   2. 完全沒設 secret 的部署，才退回明文 `x-sandbox-admin: 1`。信任等級跟既有的
 *      x-sandbox-user-id 明文退路一樣（都只靠 internal token 證明「你是我們的
 *      服務」），不比現況弱；但只要設了 secret 就自動不再接受。
 *
 * 授權本身**不在這裡做** ——「這個人是不是管理員」是 app 那邊 requireCapability
 * 的事（多租戶身分一律歸 app，見 CLAUDE.md）。這裡只驗「這個 scope 是不是我們簽的」。
 */
export function resolveCallerIsPlatformAdmin(req) {
  if (req?.cacCaller) return false; // operator powers stay with the shared token
  if (IDENTITY_SECRET) {
    const raw = req?.headers?.["x-sandbox-user-jwt"];
    if (typeof raw !== "string" || !raw.trim()) return false;
    try {
      const p = verifyHs256Jwt(raw.trim(), IDENTITY_SECRET);
      if (p.aud && p.aud !== "sandbox-runtime") return false;
      return p.scope === "platform-admin";
    } catch {
      return false;
    }
  }
  const header = req?.headers?.["x-sandbox-admin"];
  return typeof header === "string" && /^(1|true)$/i.test(header.trim());
}

/**
 * STRICT identity: only a valid app-minted `x-sandbox-user-jwt` counts.
 *
 * `resolveCallerUserId` deliberately falls back to the plain `x-sandbox-user-id`
 * header, and that is safe THERE because those routes already required the
 * shared internal token — the header is only trusted because the caller was
 * proven to be a trusted subsystem.
 *
 * The desktop relay routes have neither property: they are reachable by the
 * user's own laptop, which must NOT hold the internal token (that credential
 * authenticates the BFF; handing it to end-user machines would let any of them
 * impersonate it). So those routes run with `requiresAuth: false`, and on an
 * unauthenticated route the header fallback would mean *anyone who can reach
 * the port may claim any userId*. This helper removes the fallback: no secret
 * configured or no valid signature → null, no exceptions.
 *
 * Returns the asserted userId, or null.
 *
 * **UNUSED ON THIS BRANCH — do not wire a new route to it without reading this.**
 * It arrived with eve@92e8e434's /v1/desktop/relay/* routes, which this branch
 * does not serve. Its trust unit is the USER, not the machine: the caller proves
 * "I am user X" and then names any machineId it likes in a query parameter. Ava
 * Local instead gives every machine its own bearer device token that the app
 * resolves to one user_machines row before it ever proxies (lib/machines/
 * relay-auth.ts), so a machineId is never something a caller gets to assert.
 * Kept only so future merges from eve stay conflict-free.
 */
export function verifySignedIdentity(req) {
  if (!IDENTITY_SECRET) return null;
  const raw = req?.headers?.["x-sandbox-user-jwt"];
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const p = verifyHs256Jwt(raw.trim(), IDENTITY_SECRET);
    if (p.aud && p.aud !== "sandbox-runtime") return null;
    const uid = String(p.user_id || "").trim();
    return uid || null;
  } catch {
    return null;
  }
}

/**
 * Mint a sandbox JWT. Called from llm-runtime when issuing per-session
 * requests. Convenience helper here so the verification + signing rules
 * stay co-located.
 */
export function mintSandboxJwt({
  tenantId = null,
  customModelId = null,
  sessionId = null,
  ttlSec = 1_800,
  // 簽的金鑰跟驗的必須是同一條規則 —— 這裡如果還退回 internal token，
  // 那麼「不收沒有 SANDBOX_JWT_SECRET 的 JWT」那一條就只擋得住別人，擋不住
  // 我們自己簽出來的票，而它們一樣是用共用 bearer 簽的。
  secret = String(process.env.SANDBOX_JWT_SECRET || "").trim()
} = {}) {
  if (!secret) throw new Error("mintSandboxJwt: SANDBOX_JWT_SECRET 沒有設 —— 不會用共用的 internal token 代替");
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "llm-runtime",
    aud: "sandbox-runtime",
    iat: now,
    exp: now + Math.max(60, Number(ttlSec) || 1800),
    tenant_id: tenantId,
    custom_model_id: customModelId,
    session_id: sessionId
  };
  const b64 = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=+$/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${signingInput}.${sig}`;
}
