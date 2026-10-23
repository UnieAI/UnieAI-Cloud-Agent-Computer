/**
 * cube/control.test.mjs — Wire-format checks for the CubeAPI control-plane
 * client. No live cluster needed — every test stubs fetch and asserts what
 * URL / headers / body would be sent. If a self-hosted CubeMaster expects a
 * field we omitted (or vice versa), this file is where it'll be caught.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createControlClient } from "./control.mjs";

function mockFetch(handler) {
  const calls = [];
  const fakeFetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    return handler({ url, opts });
  };
  return { fakeFetch, calls };
}

function ok(json = {}) {
  return { ok: true, status: 200, async json() { return json; } };
}

test("createControlClient: throws fast when baseUrl is empty", () => {
  assert.throws(() => createControlClient({ baseUrl: "", apiKey: "k" }), /CUBE_API_URL is required/);
});

test("createControlClient: normalises trailing slashes on baseUrl", () => {
  const { fakeFetch } = mockFetch(() => ok({}));
  const c = createControlClient({ baseUrl: "https://cube.example.com///", apiKey: "k", fetchImpl: fakeFetch });
  assert.equal(c.baseUrl, "https://cube.example.com");
});

test("createSandboxRaw: POST /sandboxes with templateID, timeout, autoPause, optional fields", async () => {
  const { fakeFetch, calls } = mockFetch(() => ok({ sandboxID: "i-abc" }));
  const c = createControlClient({ baseUrl: "https://cube.example.com", apiKey: "k-1", fetchImpl: fakeFetch });
  const out = await c.createSandboxRaw({
    templateId: "tpl-1",
    timeoutSec: 1200,
    autoPause: true,
    envVars: { FOO: "bar" },
    metadata: { user_id: "u1", session_id: "s1" },
    network: { allow_internet_access: false }
  });
  assert.equal(out.sandboxID, "i-abc");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://cube.example.com/sandboxes");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers["x-api-key"], "k-1");
  assert.equal(calls[0].opts.headers["content-type"], "application/json");
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body, {
    templateID: "tpl-1",
    timeout: 1200,
    autoPause: true,
    envVars: { FOO: "bar" },
    metadata: { user_id: "u1", session_id: "s1" },
    network: { allow_internet_access: false }
  });
});

test("createSandboxRaw: throws invalid_request when templateId missing", async () => {
  const { fakeFetch } = mockFetch(() => ok({}));
  const c = createControlClient({ baseUrl: "https://cube.example.com", apiKey: "k", fetchImpl: fakeFetch });
  await assert.rejects(c.createSandboxRaw({}), /templateId is required/);
});

test("createSandboxRaw: surfaces server error code/message", async () => {
  const { fakeFetch } = mockFetch(() => ({
    ok: false,
    status: 402,
    async json() { return { code: "quota_exceeded", message: "out of credits" }; }
  }));
  const c = createControlClient({ baseUrl: "https://cube.example.com", apiKey: "k", fetchImpl: fakeFetch });
  await assert.rejects(
    c.createSandboxRaw({ templateId: "tpl-1" }),
    (err) => err.code === "quota_exceeded" && err.status === 402 && /out of credits/.test(err.message)
  );
});

test("destroySandbox: DELETE returns silently on 404 (already gone)", async () => {
  const { fakeFetch, calls } = mockFetch(() => ({ ok: false, status: 404, async json() { return {}; } }));
  const c = createControlClient({ baseUrl: "https://cube.example.com", apiKey: "k", fetchImpl: fakeFetch });
  await c.destroySandbox("i-abc"); // must not throw
  assert.equal(calls[0].url, "https://cube.example.com/sandboxes/i-abc");
  assert.equal(calls[0].opts.method, "DELETE");
});

test("destroySandbox: throws on non-404 errors", async () => {
  const { fakeFetch } = mockFetch(() => ({ ok: false, status: 500, async json() { return { code: "server_error", message: "boom" }; } }));
  const c = createControlClient({ baseUrl: "https://cube.example.com", apiKey: "k", fetchImpl: fakeFetch });
  await assert.rejects(c.destroySandbox("i-abc"), /boom/);
});

test("pauseSandbox / resumeSandbox: POST to /pause and /resume with auth", async () => {
  const { fakeFetch, calls } = mockFetch(({ url }) => {
    if (url.endsWith("/resume")) return ok({ sandboxID: "i-abc" });
    return ok({});
  });
  const c = createControlClient({ baseUrl: "https://cube.example.com", apiKey: "k", fetchImpl: fakeFetch });
  await c.pauseSandbox("i-abc");
  await c.resumeSandbox("i-abc", { timeoutSec: 600 });
  assert.equal(calls[0].url, "https://cube.example.com/sandboxes/i-abc/pause");
  assert.equal(calls[1].url, "https://cube.example.com/sandboxes/i-abc/resume");
  const resumeBody = JSON.parse(calls[1].opts.body);
  assert.equal(resumeBody.timeout, 600);
  assert.equal(resumeBody.autoPause, false);
});

test("listSandboxes: builds correct query string, default to /v2 endpoint", async () => {
  const { fakeFetch, calls } = mockFetch(() => ok([]));
  const c = createControlClient({ baseUrl: "https://cube.example.com", apiKey: "k", fetchImpl: fakeFetch });
  await c.listSandboxes({ state: ["running", "paused"], limit: 50, metadata: "user_id=u1" });
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/v2/sandboxes");
  assert.equal(u.searchParams.get("state"), "running,paused");
  assert.equal(u.searchParams.get("limit"), "50");
  assert.equal(u.searchParams.get("metadata"), "user_id=u1");
});

test("snapshotSandbox: 404/501 maps to snapshot_not_supported (graceful fallback path)", async () => {
  const { fakeFetch } = mockFetch(() => ({ ok: false, status: 501, async json() { return {}; } }));
  const c = createControlClient({ baseUrl: "https://cube.example.com", apiKey: "k", fetchImpl: fakeFetch });
  await assert.rejects(
    c.snapshotSandbox("i-abc"),
    (err) => err.code === "snapshot_not_supported"
  );
});

test("timeout abort is wired (passes a fresh signal)", async () => {
  // Call with extremely tight timeout, fetch never resolves — should abort.
  const slowFetch = (_url, opts) => new Promise((_, reject) => {
    opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const c = createControlClient({
    baseUrl: "https://cube.example.com",
    apiKey: "k",
    fetchImpl: slowFetch,
    timeoutMs: 10
  });
  await assert.rejects(c.createSandboxRaw({ templateId: "tpl-1" }), /aborted/);
});
