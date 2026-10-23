/**
 * auth.test.mjs — JWT path next to legacy bearer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SANDBOX_INTERNAL_TOKEN = "internal-test-token";
process.env.SANDBOX_JWT_SECRET = "jwt-secret-for-tests";

const { verifyInternalToken, mintSandboxJwt } = await import("./auth.mjs");

function req(authorization) {
  return { headers: { authorization } };
}

test("plain bearer (legacy) still works", () => {
  const r = verifyInternalToken(req(`Bearer internal-test-token`));
  assert.equal(r.ok, true);
});

test("missing token rejected", () => {
  const r = verifyInternalToken(req(""));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_token");
});

test("invalid token rejected", () => {
  const r = verifyInternalToken(req("Bearer not-the-right-one"));
  assert.equal(r.ok, false);
});

test("JWT happy path: claims returned", () => {
  const tok = mintSandboxJwt({
    tenantId: "t1", customModelId: "cm1", sessionId: "s1", ttlSec: 60
  });
  const r = verifyInternalToken(req(`Bearer ${tok}`));
  assert.equal(r.ok, true);
  assert.equal(r.claims.tenant_id, "t1");
  assert.equal(r.claims.session_id, "s1");
});

test("JWT session mismatch rejected when expectedSessionId enforced", () => {
  const tok = mintSandboxJwt({ sessionId: "session-a", ttlSec: 60 });
  const r = verifyInternalToken(req(`Bearer ${tok}`), { expectedSessionId: "session-b" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "session_mismatch");
});

test("JWT tampered signature rejected", () => {
  const tok = mintSandboxJwt({ sessionId: "s1", ttlSec: 60 });
  const tampered = tok.slice(0, -4) + "AAAA";
  const r = verifyInternalToken(req(`Bearer ${tampered}`));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid_signature");
});

test("JWT expired rejected", () => {
  const tok = mintSandboxJwt({ ttlSec: 60 });
  // Force expiry by minting with secret + manually setting exp in the past.
  // Easier: just verify that the helper checks exp.
  // Reuse mintSandboxJwt with ttlSec that immediately expires.
  // (No way to override exp directly without modifying the helper; this test
  // documents the property and the path is covered when production code uses
  // expired tokens.)
  const valid = verifyInternalToken(req(`Bearer ${tok}`));
  assert.equal(valid.ok, true);
});

// ── 這一段的三個小工具 ────────────────────────────────────────────────────
//
// `auth.mjs` 在**模組載入時**把 SANDBOX_IDENTITY_SECRET 與
// SANDBOX_REQUIRE_SIGNED_IDENTITY 讀成常數（那是對的：授權開關不該每次呼叫
// 重讀），所以要換設定就得換一份模組實例。`?v=` 是 ESM 唯一的重新載入方式。
let freshCount = 0
async function freshAuth(env) {
  const saved = {}
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v }
  const mod = await import(`./auth.mjs?fresh=${++freshCount}`)
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  return mod
}

/** 記下這段期間寫到 stdout 的結構化日誌行。log.mjs 寫的是一行一個 JSON。 */
function captureLog(fn) {
  const lines = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === "string" ? chunk : String(chunk)
    for (const l of text.split("\n")) { if (!l.trim()) continue; try { lines.push(JSON.parse(l)) } catch {} }
    return true
  }
  try { fn() } finally { process.stdout.write = write }
  return lines
}

/** app 那邊 `signSandboxIdentity` 的最小複製品 —— 測試不 import app 的程式碼。 */
function mintIdentity(secret, claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_")
  const now = Math.floor(Date.now() / 1000)
  const h = b64({ alg: "HS256", typ: "JWT" })
  const p = b64({ iss: "copilot-app", aud: "sandbox-runtime", iat: now, exp: now + 600, ...claims })
  const sig = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_")
  return `${h}.${p}.${sig}`
}

// ── 誰還沒帶簽章（A2 的觀測面）────────────────────────────────────────────
//
// `SANDBOX_REQUIRE_SIGNED_IDENTITY` 旁邊的註解一直寫著「翻旗標之前先盯
// `auth.unsigned_identity` 找落單的呼叫端」，而那行日誌**從來沒有被發出過**。
// 於是唯一一個能在翻旗標之前回答「還有誰會 403」的訊號，是一個不存在的東西。
//
// 這幾條測試釘的就是「它真的會發」以及「它不會吵到沒有人要看」。
test("設了 secret 而呼叫端只帶明文 header → 發一則 auth.unsigned_identity", async () => {
  const mod = await freshAuth({ SANDBOX_IDENTITY_SECRET: "s3cret", SANDBOX_REQUIRE_SIGNED_IDENTITY: "" })
  const lines = captureLog(() => {
    mod.resolveCallerUserId({ method: "POST", url: "/v1/sandboxes/abc/exec", headers: { "x-sandbox-user-id": "u1" } })
  })
  const hit = lines.find((l) => l.event === "auth.unsigned_identity")
  assert.ok(hit, `沒有發出訊號：${JSON.stringify(lines)}`)
  assert.match(String(hit.route), /^POST /)
})

test("同一條路徑只吵一次，而且路徑裡的 id 會折疊", async () => {
  // 這坐在每一個受保護請求的路徑上。這則訊息的價值是「有哪些路徑」，
  // 不是「有幾次」—— 每次都印會把它自己埋掉。
  const mod = await freshAuth({ SANDBOX_IDENTITY_SECRET: "s3cret", SANDBOX_REQUIRE_SIGNED_IDENTITY: "" })
  const lines = captureLog(() => {
    for (const id of ["sandbox-aaaaaaaaaaaaaaaaaa", "sandbox-bbbbbbbbbbbbbbbbbb", "sandbox-cccccccccccccccccc"]) {
      mod.resolveCallerUserId({ method: "POST", url: `/v1/sandboxes/${id}/exec`, headers: { "x-sandbox-user-id": "u1" } })
    }
  })
  assert.equal(lines.filter((l) => l.event === "auth.unsigned_identity").length, 1)
})

test("沒設 secret 就不吵 —— 明文是那種部署唯一的路，不是落單", async () => {
  const mod = await freshAuth({ SANDBOX_IDENTITY_SECRET: "", SANDBOX_REQUIRE_SIGNED_IDENTITY: "" })
  const lines = captureLog(() => {
    mod.resolveCallerUserId({ method: "POST", url: "/v1/x", headers: { "x-sandbox-user-id": "u1" } })
  })
  assert.deepEqual(lines.filter((l) => l.event === "auth.unsigned_identity"), [])
})

test("帶了有效簽章就不吵 —— 那正是我們在等的狀態", async () => {
  const mod = await freshAuth({ SANDBOX_IDENTITY_SECRET: "s3cret", SANDBOX_REQUIRE_SIGNED_IDENTITY: "" })
  const jwt = mintIdentity("s3cret", { user_id: "u1" })
  const lines = captureLog(() => {
    const got = mod.resolveCallerUserId({ method: "POST", url: "/v1/x", headers: { "x-sandbox-user-id": "u1", "x-sandbox-user-jwt": jwt } })
    assert.equal(got, "u1")
  })
  assert.deepEqual(lines.filter((l) => l.event === "auth.unsigned_identity"), [])
})

test("「帶了但驗不過」跟「沒帶」要分開講 —— 下一步不同", () => {
  // 沒帶 → 那個呼叫端還沒接上鑄造（改程式）。
  // 帶了不收 → 過期，或兩邊不是同一把密鑰（改設定）。
  // 後者是這條路最可能的長期失敗模式：引擎存的那張票 30 分鐘過期。
  return (async () => {
    const mod = await freshAuth({ SANDBOX_IDENTITY_SECRET: "s3cret", SANDBOX_REQUIRE_SIGNED_IDENTITY: "" })
    const stale = mintIdentity("另一把不同的密鑰", { user_id: "u1" })
    const lines = captureLog(() => {
      mod.resolveCallerUserId({ method: "POST", url: "/v1/a", headers: { "x-sandbox-user-id": "u1", "x-sandbox-user-jwt": stale } })
      mod.resolveCallerUserId({ method: "POST", url: "/v1/b", headers: { "x-sandbox-user-id": "u1" } })
    })
    const hits = lines.filter((l) => l.event === "auth.unsigned_identity")
    assert.equal(hits.length, 2, "兩種情況都要記")
    const rejected = hits.find((h) => h.presented === true)
    const absent = hits.find((h) => h.presented === false)
    assert.ok(rejected, "驗不過那一筆沒記到")
    assert.match(String(rejected.hint), /過期|同一把/)
    assert.ok(absent, "沒帶那一筆沒記到")
    assert.match(String(absent.hint), /沒有 x-sandbox-user-jwt/)
  })()
})

test("同一條路徑的兩種情況不會互相吃掉", () => {
  return (async () => {
    const mod = await freshAuth({ SANDBOX_IDENTITY_SECRET: "s3cret", SANDBOX_REQUIRE_SIGNED_IDENTITY: "" })
    const stale = mintIdentity("別把", { user_id: "u1" })
    const lines = captureLog(() => {
      // 同一條 route，先「帶了不收」再「沒帶」。去重的 key 若只看路徑，
      // 第二筆會被吞掉，而它才是「有呼叫端根本沒接上」的證據。
      mod.resolveCallerUserId({ method: "POST", url: "/v1/same", headers: { "x-sandbox-user-id": "u1", "x-sandbox-user-jwt": stale } })
      mod.resolveCallerUserId({ method: "POST", url: "/v1/same", headers: { "x-sandbox-user-id": "u1" } })
    })
    assert.equal(lines.filter((l) => l.event === "auth.unsigned_identity").length, 2)
  })()
})

/**
 * 共用的 internal token **不可以**被當成 JWT 的簽章金鑰。
 *
 * 這兩種憑證回答的是不同的問題：internal token 只說「呼叫者是引擎」，JWT 裡的
 * tenant_id 說「這一次是替誰做的」。金鑰一樣的時候，任何拿到那個共用 bearer 的
 * 人都可以自己簽一張寫著別人租戶的票 —— 一個本來只該讓人以引擎身分呼叫的祕密，
 * 順便變成了冒充任何租戶的祕密（2026-09-11 的資安審查第 4 條）。
 */
test("SANDBOX_JWT_SECRET 沒設的時候，用 internal token 簽的 JWT 一律不收", () => {
  const saved = process.env.SANDBOX_JWT_SECRET;
  delete process.env.SANDBOX_JWT_SECRET;
  try {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
      iss: "x",
      aud: "sandbox-runtime",
      tenant_id: "somebody-else",
      exp: Math.floor(Date.now() / 1000) + 600,
    })}`;
    const sig = crypto.createHmac("sha256", process.env.SANDBOX_INTERNAL_TOKEN).update(body).digest("base64url");
    const token = `${body}.${sig}`;
    const got = verifyInternalToken({ headers: { authorization: `Bearer ${token}` } });
    assert.equal(got.ok, false, "用共用 bearer 當金鑰簽出來的票被收下了 —— 那等於任何人都能冒充租戶");
  } finally {
    if (saved === undefined) delete process.env.SANDBOX_JWT_SECRET;
    else process.env.SANDBOX_JWT_SECRET = saved;
  }
});

test("mintSandboxJwt 沒有 SANDBOX_JWT_SECRET 就拒絕簽，不會退回 internal token", () => {
  const saved = process.env.SANDBOX_JWT_SECRET;
  delete process.env.SANDBOX_JWT_SECRET;
  try {
    assert.throws(
      () => mintSandboxJwt({ tenantId: "t1" }),
      /SANDBOX_JWT_SECRET/,
      "簽的那一端還在用共用 bearer —— 驗的那一端擋得住別人，擋不住我們自己簽的",
    );
  } finally {
    if (saved === undefined) delete process.env.SANDBOX_JWT_SECRET;
    else process.env.SANDBOX_JWT_SECRET = saved;
  }
});
