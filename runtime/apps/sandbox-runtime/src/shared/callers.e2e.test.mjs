/**
 * shared/callers.e2e.test.mjs — two callers, one user id, no crossing (CAC P1).
 *
 * End to end like pool/machine-reclaim.e2e.test.mjs: the real server.mjs (real
 * route table, real token check, real pool), on an ephemeral port, driven over
 * HTTP. The only stand-in is the container backend, because a real docker or
 * cube backend either cannot start on a test box or would touch other people's
 * containers.
 *
 * The question every test asks is the one unit tests cannot: does the rewrite
 * at the door actually reach every place that reads identity? Two layers that
 * are each green (callers.mjs rewrites; the pool keys by user) can still leave
 * one route reading the raw value.
 */
import { createHash } from "node:crypto";

const STUDIO_KEY = "studio-e2e-key";
const OTHER_KEY = "other-e2e-key";
const sha = (s) => createHash("sha256").update(s).digest("hex");

process.env.SANDBOX_MODE = "cube";
process.env.SANDBOX_PORT = "0";
process.env.SANDBOX_INTERNAL_TOKEN = "legacy-e2e-token";
// Off on purpose: namespaced callers must be held to ownership even when the
// shared-token path is still in warn-only mode.
process.env.SANDBOX_ENFORCE_OWNERSHIP = "";
process.env.SANDBOX_USER_MAX_ACTIVE = "0";
process.env.SANDBOX_POOL_TOTAL_MAX = "100";
// The filer-exposure probe runs `docker run` before any cloud allocation and
// refuses (503 filer_exposure_unknown) when it cannot answer, which on a test
// box it cannot. It is not what this file tests (pool/filer-verdict-staleness
// does), so accept it the way the other pool tests do.
process.env.SANDBOX_ALLOW_ANONYMOUS_FILER = "1";
process.env.CAC_CALLERS = JSON.stringify([
  { id: "studio", namespace: "studio", key_sha256: sha(STUDIO_KEY) },
  { id: "other", namespace: "other", key_sha256: sha(OTHER_KEY) },
]);

import test, { after } from "node:test";
import assert from "node:assert/strict";

const cube = await import("../cube/index.mjs");
const created = [];
cube.setBackend({
  createSandbox: async ({ userId, sessionId }) => {
    const sandboxId = `sbx-${Math.random().toString(36).slice(2, 10)}`;
    created.push({ sandboxId, userId, sessionId });
    return { sandboxId, workspaceId: `ws-${sandboxId}`, workspaceDir: "/tmp/cac-e2e", userId, sessionId };
  },
  destroySandbox: async () => undefined,
});
const { server, assertSandboxModeSafe, matchRoute } = await import("../server.mjs");
assertSandboxModeSafe();
server.listen(0, "127.0.0.1");
const base = await new Promise((resolve) => {
  if (server.listening) return resolve(`http://127.0.0.1:${server.address().port}`);
  server.once("listening", () => resolve(`http://127.0.0.1:${server.address().port}`));
});
after(() => server.close());

const as = (key, user) => ({ authorization: `Bearer ${key}`, ...(user ? { "x-sandbox-user-id": user } : {}), "content-type": "application/json" });
const LEGACY = process.env.SANDBOX_INTERNAL_TOKEN;

async function call(method, path, headers, body) {
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

const allocate = (key, user, session) => call("POST", "/v1/sandboxes", as(key, user), { user_id: user, session_id: session });

// Routes used below exist as written: there is no GET /v1/sandboxes/:id, and the
// allocate reply carries no user_id. A probe against a route that does not exist
// answers 404 for everyone and makes an isolation test pass on nothing.
const listFor = async (key, user) => (await call("GET", "/v1/sandboxes", as(key, user))).json.items;

test("the same user id in two callers gets two sandboxes, each named back in the caller's own terms", async () => {
  const s = await allocate(STUDIO_KEY, "u1", "sess-1");
  const l = await allocate(LEGACY, "u1", "sess-1");
  assert.equal(s.status, 200, s.text);
  assert.equal(l.status, 200, l.text);
  assert.notEqual(s.json.sandbox_id, l.json.sandbox_id, "one sandbox per caller, not one shared");
  // What the backend was asked for: the namespaced id for Studio, the raw one for the shared token.
  const users = created.map((c) => c.userId);
  assert.ok(users.includes("studio--u1"), JSON.stringify(users));
  assert.ok(users.includes("u1"), JSON.stringify(users));
  // And what Studio reads back: its own terms, no prefix.
  const mine = (await listFor(STUDIO_KEY, "u1")).find((i) => i.sandbox_id === s.json.sandbox_id);
  assert.ok(mine, "studio sees its sandbox");
  assert.equal(mine.user_id, "u1");
  assert.equal(mine.session_id, "sess-1");
});

test("each caller lists only its own sandboxes", async () => {
  const s = await listFor(STUDIO_KEY, "u1");
  const l = await listFor(LEGACY, "u1");
  assert.ok(s.length >= 1);
  assert.ok(s.every((i) => i.user_id === "u1"), "studio's list is studio's, stripped");
  assert.ok(l.every((i) => !String(i.user_id).includes("--")), "the shared token never sees a namespaced sandbox");
});

test("a sandbox id from another caller reads as unknown", async () => {
  const mine = await allocate(OTHER_KEY, "u9", "s9");
  assert.equal(mine.status, 200, mine.text);
  const id = mine.json.sandbox_id;
  assert.equal((await call("DELETE", `/v1/sandboxes/${id}`, as(STUDIO_KEY, "u9"))).status, 404, "studio cannot release other's sandbox");
  assert.equal((await call("DELETE", `/v1/sandboxes/${id}`, as(LEGACY, "u9"))).status, 404, "nor can the shared token");
  assert.ok((await listFor(OTHER_KEY, "u9")).some((i) => i.sandbox_id === id), "it is still alive");
  assert.equal((await call("DELETE", `/v1/sandboxes/${id}`, as(OTHER_KEY, "u9"))).status, 200, "its owner can");
});

test("within one caller, ownership is enforced even while the shared path is warn-only", async () => {
  const a = await allocate(STUDIO_KEY, "alice", "sa");
  assert.equal(a.status, 200, a.text);
  const r = await call("DELETE", `/v1/sandboxes/${a.json.sandbox_id}`, as(STUDIO_KEY, "bob"));
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json?.error?.details?.reason, "owner_mismatch", r.text);
  const noId = await call("DELETE", `/v1/sandboxes/${a.json.sandbox_id}`, as(STUDIO_KEY));
  assert.equal(noId.status, 403, `no identity, no access: ${noId.text}`);
  const bobAllocAsAlice = await call("POST", "/v1/sandboxes", as(STUDIO_KEY, "bob"), { user_id: "alice", session_id: "x" });
  assert.equal(bobAllocAsAlice.status, 403, bobAllocAsAlice.text);
});

test("the shared token cannot name an id inside a namespace", async () => {
  const viaHeader = await call("GET", "/v1/users/studio--u1/sandbox", as(LEGACY, "studio--u1"));
  assert.equal(viaHeader.status, 403, viaHeader.text);
  const viaBody = await allocate(LEGACY, "studio--u1", "x");
  assert.equal(viaBody.status, 403, viaBody.text);
});

test("operator routes and operator-only fields stay with the shared token", async () => {
  // /healthz and /metrics take no token at all (requiresAuth: false), so no
  // caller rule reaches them; what matters there is that they name no tenant.
  for (const path of ["/healthz", "/metrics"]) {
    const r = await call("GET", path, {});
    assert.equal(r.status, 200, path);
    assert.doesNotMatch(r.text, /studio--|other--|"user_id"|"session_id"/, `${path} must not name tenants`);
  }
  for (const [method, path] of [["GET", "/v1/pool/policy"], ["POST", "/v1/pool/policy"], ["GET", "/v1/sandboxes/stream"], ["POST", "/v1/workspace-quota/limits"], ["POST", "/v1/ssh/check"]]) {
    // Prove the route exists first: a missing one is a 404 for everybody and would pass on nothing.
    assert.ok(matchRoute(method, path), `${method} ${path} is not a route`);
    const r = await call(method, path, as(STUDIO_KEY, "u1"), method === "POST" ? {} : undefined);
    assert.equal(r.status, 403, `${method} ${path}: ${r.text}`);
    assert.equal(r.json?.error?.details?.reason, "caller_route_forbidden", r.text);
  }
  const mount = await call("POST", "/v1/sandboxes", as(STUDIO_KEY, "u1"), { user_id: "u1", workspace_mount_path: "/etc" });
  assert.equal(mount.status, 403, mount.text);
  const anon = await call("POST", "/v1/sandboxes", as(STUDIO_KEY, "u1"), { session_id: "anon" });
  assert.equal(anon.status, 400, anon.text);
  // The shared token still reaches operator routes.
  assert.equal((await call("GET", "/v1/pool/policy", as(LEGACY))).status, 200);
});

test("a namespaced caller cannot claim admin or an app-signed identity", async () => {
  const a = await allocate(STUDIO_KEY, "carol", "sc");
  assert.equal(a.status, 200, a.text);
  const r = await call("DELETE", `/v1/sandboxes/${a.json.sandbox_id}`, { ...as(STUDIO_KEY, "mallory"), "x-sandbox-admin": "1", "x-sandbox-user-jwt": "a.b.c" });
  assert.equal(r.status, 403, `admin bypass must not apply: ${r.text}`);
});

test("an unknown key is a 401, as before", async () => {
  assert.equal((await call("GET", "/v1/sandboxes", as("not-a-key", "u1"))).status, 401);
});
