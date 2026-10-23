/**
 * store-bucket-on-the-wire.test.mjs — what `Bucket:` does the store actually
 * put on the S3 request?
 *
 * The sibling test (store-bucket-isolation.test.mjs) proves two isolated
 * tenants land on different OBJECTS, using the local-fs backend. This one
 * covers the code path the defect literally lived on: `new PutObjectCommand({
 * Bucket: config.bucket, ... })` in storage-engine. A backend-level test cannot
 * see that line, and neither can a test that compares two resolvers — so the
 * assertions here read the command the SDK was handed.
 *
 * The client is a stand-in, not a mock of the store: every layer between
 * `userStore.writeFile` and the S3 command is the real one.
 */

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// S3 path, not the local-fs fallback: `STORAGE_LOCAL_FS` stays unset and the
// four S3 vars are present so `getStorageConfigFromEnv` returns a config.
delete process.env.STORAGE_LOCAL_FS;
process.env.S3_ENDPOINT = "http://s3.invalid:8333";
process.env.S3_BUCKET = "shared-bucket";
process.env.S3_ACCESS_KEY = "test-access-key-id";
process.env.S3_SECRET_KEY = "test-secret-key";

const storage = await import("../../../../packages/storage-engine/src/index.mjs");
const { writeFile, readFile, deleteFile, listWorkspaceManifest } = await import("./userStore.mjs");

/** Every command the store sent, as `{ op, Bucket, Key, Prefix }`. */
const sent = [];

before(() => {
  storage.__setS3ClientForTests({
    async send(command) {
      const op = command.constructor.name;
      sent.push({ op, ...command.input });
      if (op === "GetObjectCommand") return { Body: Buffer.from("bytes"), ETag: '"e"' };
      if (op === "ListObjectsV2Command") return { Contents: [], IsTruncated: false };
      return { ETag: '"e"' };
    },
  });
});

beforeEach(() => {
  sent.length = 0;
});

after(() => {
  storage.__setS3ClientForTests(null);
  delete process.env.SANDBOX_ISOLATED_TENANTS;
});

const OWNER_A = "user:tenant-a";
const OWNER_B = "user:tenant-b";

/** The buckets used by the commands of one op. */
const bucketsFor = (op) => [...new Set(sent.filter((c) => c.op === op).map((c) => c.Bucket))];

test("an ISOLATED tenant's every operation names that tenant's bucket", async () => {
  process.env.SANDBOX_ISOLATED_TENANTS = `${OWNER_A},${OWNER_B}`;

  await writeFile(OWNER_A, "notes.txt", Buffer.from("A"));
  await readFile(OWNER_A, "notes.txt");
  await deleteFile(OWNER_A, "notes.txt");
  await listWorkspaceManifest(OWNER_A);

  assert.ok(sent.length >= 4, `expected commands to reach the client, got ${sent.length}`);
  for (const command of sent) {
    assert.equal(
      command.Bucket,
      "ws-user-tenant-a",
      `${command.op} went to ${command.Bucket} instead of the tenant's own bucket`,
    );
  }
  // And the collapsed prefix really is the ambiguous one, which is WHY the
  // bucket has to carry the identity: asserted, not assumed.
  const put = sent.find((c) => c.op === "PutObjectCommand");
  assert.equal(put.Key, "workspace/notes.txt");
});

test("two ISOLATED tenants never share a bucket for the same key", async () => {
  process.env.SANDBOX_ISOLATED_TENANTS = `${OWNER_A},${OWNER_B}`;

  await writeFile(OWNER_A, "notes.txt", Buffer.from("A"));
  await writeFile(OWNER_B, "notes.txt", Buffer.from("B"));

  const puts = sent.filter((c) => c.op === "PutObjectCommand");
  assert.equal(puts.length, 2);
  assert.equal(puts[0].Key, puts[1].Key, "the collapsed keys are identical — that is the hazard");
  assert.notEqual(
    puts[0].Bucket,
    puts[1].Bucket,
    "identical keys in an identical bucket: tenant B's write would destroy tenant A's file",
  );
  assert.deepEqual(
    puts.map((p) => p.Bucket).sort(),
    ["ws-user-tenant-a", "ws-user-tenant-b"],
  );
});

test("a tenant that has NOT been isolated still uses the shared bucket at the legacy key", async () => {
  // The no-regression half. Every tenant is in this state today, so a change
  // that moved these bytes would strand every existing workspace.
  delete process.env.SANDBOX_ISOLATED_TENANTS;

  await writeFile(OWNER_A, "notes.txt", Buffer.from("A"));
  await listWorkspaceManifest(OWNER_A);

  assert.deepEqual(bucketsFor("PutObjectCommand"), ["shared-bucket"]);
  const put = sent.find((c) => c.op === "PutObjectCommand");
  assert.equal(put.Key, "users/tenant-a/workspace/notes.txt");
  const list = sent.find((c) => c.op === "ListObjectsV2Command");
  assert.equal(list.Bucket, "shared-bucket");
  assert.equal(list.Prefix, "users/tenant-a/workspace/");
});

test("the store REFUSES a bare key — the call that used to overwrite another tenant", async () => {
  for (const [op, call] of [
    ["putObject", () => storage.putObject({ key: "workspace/notes.txt", body: "x" })],
    ["getObject", () => storage.getObject({ key: "workspace/notes.txt" })],
    ["deleteObject", () => storage.deleteObject({ key: "workspace/notes.txt" })],
    ["listObjectsByPrefix", () => storage.listObjectsByPrefix({ prefix: "workspace/" })],
    ["deletePrefix", () => storage.deletePrefix({ prefix: "workspace/" })],
    ["getSignedUrl", () => storage.getSignedUrl({ key: "workspace/notes.txt" })],
    ["headBucket", () => storage.headBucket({})],
  ]) {
    await assert.rejects(
      async () => call(),
      (err) => err instanceof TypeError && /must be an ObjectLocation/.test(err.message),
      `${op} accepted a bare key`,
    );
  }
  assert.equal(sent.length, 0, "a refused call must not reach the store at all");
});

test("the bucket the store WRITES to is the bucket the sandbox MOUNTS", async () => {
  // bucket-agreement.test.mjs asserts mount == resolveTenantStore, using the
  // resolver "as a faithful stand-in for the store's answer". That stand-in was
  // the blind spot: the store consulted neither resolver. So this closes the
  // loop with the store's ACTUAL wire value on one side.
  process.env.SANDBOX_ISOLATED_TENANTS = OWNER_A;
  const { resolveWorkspaceLocation } = await import("../cube/docker.mjs");
  const mount = resolveWorkspaceLocation({ workspaceMode: "user", workspaceOwner: OWNER_A });

  await writeFile(OWNER_A, "notes.txt", Buffer.from("A"));
  const put = sent.find((c) => c.op === "PutObjectCommand");

  assert.equal(
    put.Bucket,
    mount.bucket,
    "the sandbox would mount one bucket while the file panel wrote to another",
  );
  assert.ok(
    put.Key.startsWith(`${mount.subpath}/`),
    `the store wrote ${put.Key}, outside the mounted subtree ${mount.subpath}/`,
  );
});

test("a location cannot be forged from a plain object", () => {
  // The brand is what makes `requireLocation` a gate rather than a shape check:
  // a hand-rolled `{bucket, key}` is exactly the two-independent-values shape
  // this design rejects.
  assert.equal(storage.isObjectLocation({ bucket: "ws-user-tenant-a", key: "workspace/x" }), false);
  assert.equal(
    storage.isObjectLocation(storage.systemLocation("plugins/x/plugin.json", "test")),
    true,
  );
});


test("conditional editor save sends the version returned by S3 as IfMatch", async () => {
  await writeFile("user-a", "editor.txt", Buffer.from("edited"), "text/plain", {
    expectedSha256: createHash("sha256").update("bytes").digest("hex"),
  });
  const put = sent.find((entry) => entry.op === "PutObjectCommand");
  assert.equal(put.IfMatch, '"e"');
  assert.equal(put.Body.toString(), "edited");
});
