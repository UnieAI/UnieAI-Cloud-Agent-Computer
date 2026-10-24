/**
 * doctor/storage-doctor.test.mjs — every branch says what to fix, and none
 * prints a key. The real-store run is in scripts/s3-mount-it.sh.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runStorageDoctor } from "./storage-doctor.mjs";
import { PreconditionFailedError, isPreconditionFailed, s3ForcePathStyle, systemLocation } from "../../../../packages/storage-engine/src/index.mjs";

const ENV = {
  S3_ENDPOINT: "http://minio:9000", S3_BUCKET: "cac", S3_ACCESS_KEY: "AKIA-TEST", S3_SECRET_KEY: "the-secret",
  SANDBOX_WORKSPACE_MOUNT: "host", SANDBOX_HOST_MOUNT_DRIVER: "s3",
};

/** An in-memory store that behaves like a good S3, with knobs to break it. */
function store({ backend = "s3", headError = null, ignoresConditions = false } = {}) {
  const objects = new Map();
  return {
    s3ForcePathStyle, systemLocation, isPreconditionFailed,
    async describeStorageBackend() { return backend; },
    async headBucket() { if (headError) throw headError; },
    async putObject({ at, body, ifNoneMatch }) {
      if (ifNoneMatch === "*" && objects.has(at.key) && !ignoresConditions) throw new PreconditionFailedError(at.key);
      objects.set(at.key, String(body));
    },
    async getObject({ at }) { return { Body: [Buffer.from(objects.get(at.key))] }; },
    async deleteObject({ at }) { objects.delete(at.key); },
    objects,
  };
}
const tools = (present = ["rclone", "fusermount3"], fuse = true) => ({
  which: async (b) => present.includes(b),
  version: async () => "rclone v1.68.2\n- os",
  exists: (p) => (p === "/dev/fuse" ? fuse : false),
});
const doctor = (env, s, t = tools()) => runStorageDoctor({ env, deps: { storage: s, ...t } });
const byCheck = (rs) => Object.fromEntries(rs.map((r) => [r.check, r]));

test("a good store and a complete mount toolchain pass every check, and the probe is cleaned up", async () => {
  const s = store();
  const rs = await doctor(ENV, s);
  assert.deepEqual(rs.filter((r) => !r.ok), [], JSON.stringify(rs));
  assert.deepEqual(rs.map((r) => r.check), ["storage-configured", "bucket", "read-write", "conditional-write", "mount"]);
  assert.equal(s.objects.size, 0, "no probe object left behind");
});

test("no output ever carries a key", async () => {
  for (const s of [store(), store({ backend: "local-fs" }), store({ headError: Object.assign(new Error("x"), { $metadata: { httpStatusCode: 403 } }) })]) {
    assert.doesNotMatch(JSON.stringify(await doctor(ENV, s)), /the-secret|AKIA-TEST/);
  }
});

test("the local-directory fallback is refused, and says how to configure S3", async () => {
  const r = byCheck(await doctor(ENV, store({ backend: "local-fs" })))["storage-configured"];
  assert.equal(r.ok, false);
  assert.match(r.detail, /LOCAL DIRECTORY/);
  assert.match(r.detail, /S3_ENDPOINT/);
});

test("a missing bucket and refused keys are told apart", async () => {
  const missing = byCheck(await doctor(ENV, store({ headError: Object.assign(new Error("NotFound"), { $metadata: { httpStatusCode: 404 } }) }))).bucket;
  assert.match(missing.detail, /does not exist/);
  const refused = byCheck(await doctor(ENV, store({ headError: Object.assign(new Error("Forbidden"), { $metadata: { httpStatusCode: 403 } }) }))).bucket;
  assert.match(refused.detail, /403/);
});

test("a store that ignores If-None-Match fails: the manifest would lose updates", async () => {
  const r = byCheck(await doctor(ENV, store({ ignoresConditions: true })))["conditional-write"];
  assert.equal(r.ok, false);
  assert.match(r.detail, /ignores conditional headers/);
});

test("driver s3 without host mount mode fails: the image would weed-mount an empty /workspace", async () => {
  const r = byCheck(await doctor({ ...ENV, SANDBOX_WORKSPACE_MOUNT: "" }, store())).mount;
  assert.equal(r.ok, false);
  assert.match(r.detail, /SANDBOX_WORKSPACE_MOUNT=host/);
});

test("a missing fusermount3 or /dev/fuse is named, with the fix", async () => {
  const r = byCheck(await doctor(ENV, store(), tools(["rclone"], false))).mount;
  assert.equal(r.ok, false);
  assert.match(r.detail, /fusermount3 \(package fuse3\)/);
  assert.match(r.detail, /--device \/dev\/fuse/);
});

test("an unknown driver is a config error, reported rather than thrown", async () => {
  const r = byCheck(await doctor({ ...ENV, SANDBOX_HOST_MOUNT_DRIVER: "minio" }, store())).mount;
  assert.equal(r.ok, false);
  assert.match(r.detail, /not a mount driver/);
});
