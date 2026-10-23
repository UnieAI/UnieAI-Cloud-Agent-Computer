/**
 * local-fs.test.mjs — Validate the local-fs fallback put/get/list/delete cycle.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const TMP_ROOT = path.join(os.tmpdir(), `unieai-storage-test-${process.pid}-${Date.now()}`);
process.env.STORAGE_LOCAL_FS_ROOT = TMP_ROOT;
process.env.STORAGE_LOCAL_FS_BUCKET = "test-bucket";
process.env.STORAGE_LOCAL_FS = "1";
// Wipe any S3 env vars so the fallback wins.
delete process.env.S3_ENDPOINT;
delete process.env.S3_BUCKET;
delete process.env.S3_ACCESS_KEY;
delete process.env.S3_SECRET_KEY;

const storage = await import("./index.mjs");

// These objects have no tenant — the fallback backend's own round-trip is what
// is under test — so they say so explicitly rather than relying on a default.
const at = (key) => storage.systemLocation(key, "local-fs backend test fixture");

test.after(async () => {
  try { await fs.rm(TMP_ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

test("describeStorageBackend reports local-fs when no S3 + forced", async () => {
  assert.equal(await storage.describeStorageBackend(), "local-fs");
});

test("putObject + getObject round-trip", async () => {
  await storage.putObject({
    at: at("plugins/abc/plugin.json"),
    body: Buffer.from('{"name":"x"}'),
    contentType: "application/json"
  });
  const result = await storage.getObject({ at: at("plugins/abc/plugin.json") });
  assert.ok(Buffer.isBuffer(result.Body));
  assert.equal(result.Body.toString("utf8"), '{"name":"x"}');
});

test("listObjectsByPrefix returns keys under the prefix only", async () => {
  await storage.putObject({ at: at("plugins/abc/skill.md"), body: "body" });
  await storage.putObject({ at: at("plugins/xyz/foo.md"), body: "other" });
  await storage.putObject({ at: at("other/path/file.txt"), body: "noise" });
  const list = await storage.listObjectsByPrefix({ at: at("plugins/") });
  const keys = list.map((o) => o.key).sort();
  assert.ok(keys.includes("plugins/abc/plugin.json"));
  assert.ok(keys.includes("plugins/abc/skill.md"));
  assert.ok(keys.includes("plugins/xyz/foo.md"));
  assert.ok(!keys.includes("other/path/file.txt"));
});

test("deletePrefix removes everything under the prefix", async () => {
  await storage.deletePrefix({ at: at("plugins/abc/") });
  const list = await storage.listObjectsByPrefix({ at: at("plugins/abc/") });
  assert.equal(list.length, 0);
  // Sibling untouched
  const xyz = await storage.listObjectsByPrefix({ at: at("plugins/xyz/") });
  assert.equal(xyz.length, 1);
});

test("getObject for missing key throws", async () => {
  await assert.rejects(
    () => storage.getObject({ at: at("plugins/abc/plugin.json") }),
    /not found/
  );
});

// Large uploads (200 MB) stream into storage instead of being buffered in the
// sandbox-runtime process. The local-fs backend used to JSON.stringify any
// non-Buffer body — a stream would have been stored as "{}".
test("putObject accepts a stream body and stores its bytes", async () => {
  const { Readable } = await import("node:stream");
  const chunks = Array.from({ length: 50 }, (_, i) => Buffer.alloc(64 * 1024, 65 + (i % 26)));
  const whole = Buffer.concat(chunks);
  const res = await storage.putObject({ at: at("streams/big.bin"), body: Readable.from(chunks), contentLength: whole.length });
  assert.ok(res.etag);
  const got = await storage.getObject({ at: at("streams/big.bin") });
  const back = Buffer.concat(await got.Body.toArray?.() ?? [await streamToBuf(got.Body)]);
  assert.equal(Buffer.compare(back, whole), 0);
});

test("a stream that fails midway leaves no object behind", async () => {
  const { Readable } = await import("node:stream");
  async function* boom() { yield Buffer.from("partial"); throw new Error("client went away"); }
  await assert.rejects(storage.putObject({ at: at("streams/broken.bin"), body: Readable.from(boom()), contentLength: 100 }));
  await assert.rejects(storage.getObject({ at: at("streams/broken.bin") }));
});

async function streamToBuf(body) {
  if (Buffer.isBuffer(body)) return body;
  const parts = [];
  for await (const c of body) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}
