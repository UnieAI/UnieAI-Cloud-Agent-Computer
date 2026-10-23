import test from "node:test";
import assert from "node:assert/strict";

import {
  assertLegacyIdentity, callerForToken, callerOwnsEntry, isNamespacedRoute, namespaceBody,
  namespaceOfId, namespaceRequest, nsOwner, parseCallers, sha256Hex, stripNsId, stripResponse,
} from "./callers.mjs";

const KEY = "studio-test-key";
const callers = parseCallers(JSON.stringify([{ id: "studio", namespace: "studio", key_sha256: sha256Hex(KEY) }]));
const studio = callers[0];

test("a malformed registry refuses to load instead of booting with no callers", () => {
  assert.throws(() => parseCallers("{"), /not valid JSON/);
  assert.throws(() => parseCallers("{}"), /JSON array/);
  assert.throws(() => parseCallers(JSON.stringify([{ id: "s", namespace: "Studio", key_sha256: sha256Hex("k") }])), /namespace/);
  assert.throws(() => parseCallers(JSON.stringify([{ id: "s", namespace: "studio", key_sha256: "plaintext-key" }])), /64 hex/);
  const h = sha256Hex("k");
  assert.throws(() => parseCallers(JSON.stringify([{ id: "a", namespace: "aa", key_sha256: h }, { id: "b", namespace: "bb", key_sha256: h }])), /share one key/);
  assert.throws(() => parseCallers(JSON.stringify([{ id: "a", namespace: "aa", key_sha256: h }, { id: "b", namespace: "aa", key_sha256: sha256Hex("x") }])), /duplicate namespace/);
  assert.deepEqual(parseCallers(""), []);
});

test("a key resolves to its caller; anything else to null", () => {
  assert.equal(callerForToken(KEY, callers)?.id, "studio");
  assert.equal(callerForToken("nope", callers), null);
  assert.equal(callerForToken("", callers), null);
  assert.equal(callerForToken(KEY, []), null);
});

test("ids and owners round-trip through the namespace", () => {
  assert.equal(nsOwner(studio, "group:g1"), "group:studio--g1");
  assert.equal(nsOwner(studio, "u1"), "studio--u1");
  assert.equal(stripNsId(studio, "studio--u1"), "u1");
  assert.equal(stripNsId(studio, "group:studio--g1"), "group:g1");
  assert.equal(stripNsId(studio, "other"), "other");
  // An id that itself contains the separator stays unambiguous: only the leading prefix is the namespace.
  assert.equal(stripNsId(studio, "studio--a--b"), "a--b");
  assert.equal(namespaceOfId("group:studio--g1", callers), "studio");
  assert.equal(namespaceOfId("u1", callers), "");
});

test("the request door rewrites identity and drops app-only headers", () => {
  const req = { headers: { "x-sandbox-user-id": "u1", "x-workspace-owner": "org:o1", "x-sandbox-user-jwt": "x.y.z", "x-sandbox-admin": "1" } };
  const params = { userId: "u1", sessionId: "s1", id: "sbx" };
  namespaceRequest(req, params, studio);
  assert.deepEqual(params, { userId: "studio--u1", sessionId: "studio--s1", id: "sbx" });
  assert.equal(req.headers["x-sandbox-user-id"], "studio--u1");
  assert.equal(req.headers["x-workspace-owner"], "org:studio--o1");
  assert.equal(req.headers["x-sandbox-user-jwt"], undefined);
  assert.equal(req.headers["x-sandbox-admin"], undefined);
});

test("a body is namespaced; operator-only fields are refused", () => {
  assert.deepEqual(namespaceBody({ user_id: "u1", session_id: "s1", workspace_owner: "group:g", image: "x" }, studio),
    { user_id: "studio--u1", session_id: "studio--s1", workspace_owner: "group:studio--g", image: "x" });
  assert.throws(() => namespaceBody({ user_id: "u1", workspace_mount_path: "/etc" }, studio), (e) => e.status === 403 && e.details.reason === "caller_field_forbidden");
  assert.throws(() => namespaceBody({ user_id: "u1", machine: { id: "m", kind: "local" } }, studio), (e) => e.status === 403);
});

test("the shared token may not name an id inside a caller namespace", () => {
  const ok = { req: { headers: { "x-sandbox-user-id": "u1" } }, params: { userId: "u1" } };
  assert.doesNotThrow(() => assertLegacyIdentity(ok, callers));
  for (const probe of [
    { req: { headers: { "x-sandbox-user-id": "studio--u1" } }, params: {} },
    { req: { headers: {} }, params: { userId: "studio--u1" } },
    { req: { headers: { "x-workspace-owner": "group:studio--g" } }, params: {} },
    { req: { headers: {} }, params: {}, body: { user_id: "studio--u1" } },
  ]) {
    assert.throws(() => assertLegacyIdentity(probe, callers), (e) => e.status === 403 && e.details.reason === "namespaced_id_from_legacy_caller");
  }
  // With no callers configured nothing is reserved: copilot-v2's ids are never refused.
  assert.doesNotThrow(() => assertLegacyIdentity({ req: { headers: { "x-sandbox-user-id": "studio--u1" } }, params: {} }, []));
});

test("an entry belongs to the namespace its user id carries", () => {
  assert.equal(callerOwnsEntry(studio, { userId: "studio--u1" }, callers), true);
  assert.equal(callerOwnsEntry(studio, { userId: "u1" }, callers), false);
  assert.equal(callerOwnsEntry(null, { userId: "u1" }, callers), true);
  assert.equal(callerOwnsEntry(null, { userId: "studio--u1" }, callers), false);
  assert.equal(callerOwnsEntry(null, { userId: null }, callers), true);
});

test("responses lose the prefix everywhere, including nested lists", () => {
  assert.deepEqual(stripResponse({ items: [{ user_id: "studio--u1", session_id: "studio--s", sandbox_id: "studio--keep" }], owner: "group:studio--g" }, studio),
    { items: [{ user_id: "u1", session_id: "s", sandbox_id: "studio--keep" }], owner: "group:g" });
});

test("operator routes stay off the namespaced allowlist", () => {
  for (const p of ["/healthz", "/v1/sandboxes", "/v1/sandboxes/abc", "/v1/sandboxes/abc/exec", "/v1/sessions/s/sandbox", "/v1/users/u/sandbox", "/v1/users/u/workspace/file"]) {
    assert.equal(isNamespacedRoute(p), true, p);
  }
  for (const p of ["/metrics", "/v1/sandboxes/stream", "/v1/pool/policy", "/v1/workspace-quota/limits", "/v1/ssh/check", "/v1/relay/connect"]) {
    assert.equal(isNamespacedRoute(p), false, p);
  }
});
