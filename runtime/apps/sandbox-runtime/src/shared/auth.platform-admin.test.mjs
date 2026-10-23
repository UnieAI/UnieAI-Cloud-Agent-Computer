/**
 * 後台管理員身分（resolveCallerIsPlatformAdmin）。
 *
 * 這組測試守的是一件很容易靜靜壞掉的事：開了 SANDBOX_ENFORCE_OWNERSHIP 之後，
 * `GET /v1/sandboxes` 認不出管理員時**不會回 403** —— 它會把清單濾成呼叫者自己的，
 * 也就是回一個空陣列。後台看起來就只是「現在沒有人在用」。所以「誰算管理員」
 * 一定要有測試釘住。
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SANDBOX_INTERNAL_TOKEN = "internal-test-token";
process.env.SANDBOX_IDENTITY_SECRET = "identity-secret-for-tests";

const { resolveCallerIsPlatformAdmin } = await import("./auth.mjs");

const b64url = (buf) => buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/** 照 app 的 signSandboxAdminIdentity 簽一張，可以指定 secret 與 payload。 */
function mint(payload, secret = "identity-secret-for-tests") {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify({
    iss: "copilot-app",
    aud: "sandbox-runtime",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 120,
    ...payload,
  })));
  const sig = b64url(crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

const req = (headers) => ({ headers });

test("app 簽的 platform-admin JWT 算管理員", () => {
  const jwt = mint({ scope: "platform-admin", user_id: "admin-1" });
  assert.equal(resolveCallerIsPlatformAdmin(req({ "x-sandbox-user-jwt": jwt })), true);
});

test("一般使用者身分不算管理員（就算簽章是對的）", () => {
  const jwt = mint({ user_id: "u1" });
  assert.equal(resolveCallerIsPlatformAdmin(req({ "x-sandbox-user-jwt": jwt })), false);
});

test("別人簽的 platform-admin 不算 —— 簽章錯就是不算", () => {
  const jwt = mint({ scope: "platform-admin", user_id: "attacker" }, "not-our-secret");
  assert.equal(resolveCallerIsPlatformAdmin(req({ "x-sandbox-user-jwt": jwt })), false);
});

test("有設 secret 時，明文 x-sandbox-admin 一律不算", () => {
  // 這是重點：管理員權限不該有沒簽章的退路。持有 internal token 的服務（例如引擎）
  // 可以設任何 header，但它拿不到 SANDBOX_IDENTITY_SECRET。
  assert.equal(resolveCallerIsPlatformAdmin(req({ "x-sandbox-admin": "1" })), false);
});

test("aud 不是 sandbox-runtime 的 token 不算", () => {
  const jwt = mint({ scope: "platform-admin", user_id: "admin-1", aud: "somewhere-else" });
  assert.equal(resolveCallerIsPlatformAdmin(req({ "x-sandbox-user-jwt": jwt })), false);
});

test("過期的 token 不算", () => {
  const now = Math.floor(Date.now() / 1000);
  const jwt = mint({ scope: "platform-admin", user_id: "admin-1", iat: now - 600, exp: now - 300 });
  assert.equal(resolveCallerIsPlatformAdmin(req({ "x-sandbox-user-jwt": jwt })), false);
});

test("沒有任何 header 不算", () => {
  assert.equal(resolveCallerIsPlatformAdmin(req({})), false);
  assert.equal(resolveCallerIsPlatformAdmin(undefined), false);
});
