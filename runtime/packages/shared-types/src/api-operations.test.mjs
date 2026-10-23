/**
 * api-operations.test.mjs — an MCP tool we could not enumerate must not be
 * presented as a tool with nothing in it.
 *
 * WHAT THE USER SAW. An MCP tool is registered by URL; its operations are
 * discovered by fetching `<url>/openapi.json` at turn time. When that fetch
 * failed — the tool's own host down, a 401 because its API key had rotated, an
 * 8s timeout — `fetchApiOperationsFromConfig` answered `[]` for that tool.
 * `[]` is also what a spec with no paths produces, so the tool was registered
 * with ZERO callable operations and the agent, asked to use it, reported that
 * the tool had nothing it could do — confidently, and about a tool that was
 * fully functional an hour earlier. Nothing was logged.
 *
 * WHAT IT COST. Silent capability loss with a plausible-sounding explanation
 * attached, which is worse than an error: the user believes it.
 *
 * Run:
 *   node --test runtime/packages/shared-types/src/api-operations.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchApiOperationsFromConfig,
  fetchApiOperationsFromConfigDetailed,
} from "./api-operations.mjs";

const SPEC = {
  openapi: "3.0.0",
  paths: {
    "/echo": { get: { operationId: "echo", summary: "echo it back" } },
  },
};

/** A fetch that answers each URL from a table; anything else is a hard error. */
function fakeFetch(table) {
  return async (url) => {
    const hit = table[String(url)];
    if (!hit) throw new Error(`connect ECONNREFUSED for ${url}`);
    return hit;
  };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

const tool = (id, url) => ({ id, name: id, url, mode: "auto" });

function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return (async () => {
    try {
      return await fn();
    } finally {
      globalThis.fetch = original;
    }
  })();
}

// ─── The defect ─────────────────────────────────────────────────────────────

test("a tool whose spec could not be fetched is reported, not served as an empty tool", async () => {
  const detail = await withFetch(
    fakeFetch({ "https://good.example/openapi.json": ok(SPEC) }),
    () =>
      fetchApiOperationsFromConfigDetailed([
        tool("good", "https://good.example"),
        tool("dead", "https://dead.example"),
      ]),
  );

  assert.equal(detail.operations.length, 1, "the working tool still contributes its operations");
  assert.equal(detail.unavailable.length, 1, "…and the one we could not enumerate is NAMED, not silently emptied");
  assert.equal(detail.unavailable[0].toolId, "dead");
  assert.equal(detail.unavailable[0].status, null, "the request never landed");
  assert.match(detail.unavailable[0].url, /dead\.example/);
});

test("a 401 on the spec is 'we could not look', not 'this tool does nothing'", async () => {
  const detail = await withFetch(
    fakeFetch({ "https://x.example/openapi.json": { ok: false, status: 401, json: async () => ({}) } }),
    () => fetchApiOperationsFromConfigDetailed([tool("x", "https://x.example")]),
  );
  assert.deepEqual(detail.operations, []);
  assert.equal(detail.unavailable.length, 1);
  assert.equal(detail.unavailable[0].status, 401);
});

test("a 200 that is not a spec is not a spec with no operations", async () => {
  // A captive portal / proxy error page answers 200 with HTML.
  const detail = await withFetch(
    fakeFetch({ "https://y.example/openapi.json": { ok: true, status: 200, json: async () => "<html>502</html>" } }),
    () => fetchApiOperationsFromConfigDetailed([tool("y", "https://y.example")]),
  );
  assert.equal(detail.unavailable.length, 1, "a body that is not an object is not evidence about the tool's operations");
  assert.equal(detail.unavailable[0].status, 200, "it WAS a 200 — say so honestly");
});

test("the failure is loud: an operator can see WHICH tool lost WHAT", async () => {
  const lines = [];
  await withFetch(fakeFetch({}), () =>
    fetchApiOperationsFromConfigDetailed([tool("crm", "https://crm.example")], {
      log: { error: (m) => lines.push(String(m)) },
    }),
  );
  assert.equal(lines.length, 1, "the whole defect was that this line did not exist");
  assert.match(lines[0], /crm/, "name the tool");
  assert.match(lines[0], /crm\.example/, "name where we looked");
});

// ─── The near-miss: a tool that really exposes nothing must stay empty ───────

test("NEAR-MISS: a spec with no paths yields no operations and no complaint", async () => {
  const lines = [];
  const detail = await withFetch(
    fakeFetch({ "https://empty.example/openapi.json": ok({ openapi: "3.0.0", paths: {} }) }),
    () =>
      fetchApiOperationsFromConfigDetailed([tool("empty", "https://empty.example")], {
        log: { error: (m) => lines.push(String(m)) },
      }),
  );
  assert.deepEqual(detail.operations, [], "an empty spec really does mean no operations");
  assert.deepEqual(detail.unavailable, [], "nothing failed");
  assert.deepEqual(lines, [], "…so nothing may be logged as a failure");
});

test("NEAR-MISS: a working tool is unchanged", async () => {
  const detail = await withFetch(
    fakeFetch({ "https://good.example/openapi.json": ok(SPEC) }),
    () => fetchApiOperationsFromConfigDetailed([tool("good", "https://good.example")]),
  );
  assert.equal(detail.operations.length, 1);
  assert.deepEqual(detail.unavailable, []);
});

test("NEAR-MISS: a manual-mode tool never touches the network", async () => {
  const manual = { id: "m", name: "m", mode: "manual", method: "POST", manualPath: "/do" };
  const detail = await withFetch(
    () => {
      throw new Error("manual tools must not fetch a spec");
    },
    () => fetchApiOperationsFromConfigDetailed([manual]),
  );
  assert.equal(detail.operations.length, 1);
  assert.deepEqual(detail.unavailable, []);
});

test("the existing signature still returns just the operations, for callers that only want those", async () => {
  const ops = await withFetch(
    fakeFetch({ "https://good.example/openapi.json": ok(SPEC) }),
    () => fetchApiOperationsFromConfig([tool("good", "https://good.example"), tool("dead", "https://dead.example")]),
  );
  assert.ok(Array.isArray(ops));
  assert.equal(ops.length, 1);
});
