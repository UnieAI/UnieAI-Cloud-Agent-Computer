// Tests for the batch file-write helper. Stub backend captures
// writeFile calls so we can verify decoding + partial-success semantics
// without touching the real fs.

import test from "node:test";
import assert from "node:assert/strict";

import { processBatchWrite, _internal } from "./batch.mjs";

function stubBackend({ writeFileImpl } = {}) {
  const calls = [];
  return {
    calls,
    writeFile: writeFileImpl || (async (sandboxId, filePath, content) => {
      calls.push({ sandboxId, filePath, content });
    })
  };
}

test("rejects missing sandboxId", async () => {
  await assert.rejects(
    () => processBatchWrite({ body: { files: [] }, backend: stubBackend() }),
    /sandboxId required/
  );
});

test("rejects missing backend.writeFile", async () => {
  await assert.rejects(
    () => processBatchWrite({ sandboxId: "s1", body: { files: [] }, backend: {} }),
    /backend.writeFile unavailable/
  );
});

test("rejects body without files array", async () => {
  await assert.rejects(
    () => processBatchWrite({ sandboxId: "s1", body: {}, backend: stubBackend() }),
    /files: array/
  );
  await assert.rejects(
    () => processBatchWrite({ sandboxId: "s1", body: { files: "nope" }, backend: stubBackend() }),
    /files: array/
  );
});

test("rejects batch over MAX_BATCH", async () => {
  const huge = Array.from({ length: _internal.MAX_BATCH + 1 }, (_, i) => ({
    path: `f${i}.txt`,
    content: ""
  }));
  await assert.rejects(
    () => processBatchWrite({ sandboxId: "s1", body: { files: huge }, backend: stubBackend() }),
    /batch capped/
  );
});

test("writes all files when valid + utf-8 default", async () => {
  const backend = stubBackend();
  const out = await processBatchWrite({
    sandboxId: "s1",
    body: {
      files: [
        { path: "AGENT.md", content: "# AGENT" },
        { path: ".unieai/memory/auto.md", content: "auto memory" }
      ]
    },
    backend
  });
  assert.equal(out.ok, true);
  assert.equal(out.written, 2);
  assert.equal(out.total, 2);
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[0].size, Buffer.byteLength("# AGENT"));
  assert.equal(backend.calls.length, 2);
  assert.equal(backend.calls[0].filePath, "AGENT.md");
  assert.equal(backend.calls[0].content, "# AGENT");
});

test("base64 entries decoded to Buffer", async () => {
  const backend = stubBackend();
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
  const out = await processBatchWrite({
    sandboxId: "s1",
    body: {
      files: [
        { path: ".unieai/skills/x/cover.png", content: png.toString("base64"), encoding: "base64" }
      ]
    },
    backend
  });
  assert.equal(out.ok, true);
  assert.equal(out.results[0].size, png.length);
  assert.ok(Buffer.isBuffer(backend.calls[0].content));
  assert.deepEqual(Buffer.from(backend.calls[0].content), png);
});

test("partial success: invalid entries get per-row error, valid ones still write", async () => {
  const backend = stubBackend();
  const out = await processBatchWrite({
    sandboxId: "s1",
    body: {
      files: [
        { path: "ok.txt", content: "hi" },
        { /* no path */ content: "lost" },
        { path: "bad-enc.bin", content: "x", encoding: "rot13" },
        { path: "ok2.txt", content: "bye" }
      ]
    },
    backend
  });
  assert.equal(out.ok, false);
  assert.equal(out.written, 2);
  assert.equal(out.total, 4);
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[1].ok, false);
  assert.equal(out.results[1].error, "path required");
  assert.equal(out.results[2].ok, false);
  assert.match(out.results[2].error, /unsupported encoding/);
  assert.equal(out.results[3].ok, true);
  // Only the 2 valid entries actually hit the backend.
  assert.equal(backend.calls.length, 2);
});

test("writeFile throw is captured per-entry (other files still write)", async () => {
  const backend = stubBackend({
    writeFileImpl: async (sandboxId, filePath) => {
      if (filePath.includes("blocked")) {
        const err = new Error("path forbidden");
        err.code = "EACCES";
        throw err;
      }
    }
  });
  const out = await processBatchWrite({
    sandboxId: "s1",
    body: {
      files: [
        { path: "/safe/a.md", content: "a" },
        { path: "/blocked/b.md", content: "b" },
        { path: "/safe/c.md", content: "c" }
      ]
    },
    backend
  });
  assert.equal(out.ok, false);
  assert.equal(out.written, 2);
  const blocked = out.results.find((r) => r.path === "/blocked/b.md");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "EACCES");
  assert.match(blocked.error, /forbidden/);
});

test("empty files array is valid (no-op success)", async () => {
  const backend = stubBackend();
  const out = await processBatchWrite({ sandboxId: "s1", body: { files: [] }, backend });
  assert.equal(out.ok, true);
  assert.equal(out.written, 0);
  assert.equal(out.total, 0);
  assert.equal(backend.calls.length, 0);
});

test("null/undefined content treated as empty string for utf-8", async () => {
  const backend = stubBackend();
  const out = await processBatchWrite({
    sandboxId: "s1",
    body: { files: [{ path: "empty.md", content: null }] },
    backend
  });
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[0].size, 0);
  assert.equal(backend.calls[0].content, "");
});

test("utf8 alias is accepted (same as utf-8)", async () => {
  const backend = stubBackend();
  const out = await processBatchWrite({
    sandboxId: "s1",
    body: { files: [{ path: "x.md", content: "hi", encoding: "utf8" }] },
    backend
  });
  assert.equal(out.results[0].ok, true);
});

test("decodeEntry sanity (internal)", () => {
  assert.equal(_internal.decodeEntry({ path: "", content: "x" }).ok, false);
  assert.equal(_internal.decodeEntry({ path: "a.md" }).ok, true);
  assert.equal(_internal.decodeEntry({ path: "a.md", encoding: "weird" }).ok, false);
});
