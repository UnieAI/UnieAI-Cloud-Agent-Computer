/**
 * store-bucket-isolation.test.mjs — the STORE must put a tenant's bytes in the
 * tenant's BUCKET, not just at the tenant's prefix.
 *
 * WHY THIS AND NOT bucket-agreement.test.mjs. That test compares
 * `resolveWorkspaceLocation` (the mount) against `resolveTenantStore` (a
 * "faithful stand-in for the store's answer", in its own words). Both
 * resolvers agreed, and the defect was still live in production, because the
 * STORE CONSULTED NEITHER: storage-engine's `putObject`/`getObject`/... took no
 * bucket at all and hardcoded `Bucket: config.bucket` (= `S3_BUCKET`). Two
 * resolvers agreeing with each other cannot detect a third party ignoring them
 * both. So every assertion here goes through `userStore` → `storage-engine`
 * and inspects WHERE THE BYTES LANDED, never a resolver's return value.
 *
 * The measured consequence, and the first assertion below: with two tenants
 * isolated their prefixes both COLLAPSE to `workspace/...` (the per-tenant
 * bucket is supposed to carry the identity that the prefix drops), so before
 * the fix tenant B's write to `notes.txt` overwrote tenant A's `notes.txt` —
 * silent data destruction across a tenant boundary.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "store-bucket-iso-"));

// local-fs backend, so the test needs no S3/SeaweedFS. It is a REAL backend
// (the one dev and on-prem run on), not a mock of the store: it lays objects
// out as <root>/<bucket>/<key>, so "did these two writes land on different
// objects" is answered by looking at the filesystem.
process.env.STORAGE_LOCAL_FS = "1";
process.env.STORAGE_LOCAL_FS_ROOT = path.join(tmpRoot, "objects");
process.env.STORAGE_LOCAL_FS_BUCKET = "shared-bucket";
delete process.env.S3_ENDPOINT;
delete process.env.S3_ACCESS_KEY;
delete process.env.S3_SECRET_KEY;
process.env.S3_BUCKET = "shared-bucket";

const OWNER_A = "user:tenant-a";
const OWNER_B = "user:tenant-b";

const { writeFile, readFile, listWorkspaceManifest } = await import("./userStore.mjs");

/** Every object the local-fs backend holds, as "<bucket>/<key>". */
async function allObjects() {
  const root = process.env.STORAGE_LOCAL_FS_ROOT;
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return out.sort();
}

before(() => {
  process.env.SANDBOX_ISOLATED_TENANTS = `${OWNER_A},${OWNER_B}`;
});

after(async () => {
  delete process.env.SANDBOX_ISOLATED_TENANTS;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test("two ISOLATED tenants writing the same relPath land on DIFFERENT objects", async () => {
  await writeFile(OWNER_A, "notes.txt", Buffer.from("A's secret"));
  await writeFile(OWNER_B, "notes.txt", Buffer.from("B's secret"));

  const objects = (await allObjects()).filter((o) => o.endsWith("notes.txt"));
  assert.equal(
    objects.length,
    2,
    `both tenants' writes collapsed onto ${objects.length} object(s): ${JSON.stringify(objects)}`,
  );

  // And the bytes survive: A can still read what A wrote.
  assert.equal((await readFile(OWNER_A, "notes.txt")).toString("utf8"), "A's secret");
  assert.equal((await readFile(OWNER_B, "notes.txt")).toString("utf8"), "B's secret");
});

test("an isolated tenant's listing shows only its OWN files", async () => {
  await writeFile(OWNER_A, "only-a.txt", Buffer.from("a"));
  await writeFile(OWNER_B, "only-b.txt", Buffer.from("b"));

  const a = Object.keys((await listWorkspaceManifest(OWNER_A)).entries);
  const b = Object.keys((await listWorkspaceManifest(OWNER_B)).entries);

  assert.ok(a.includes("only-a.txt"), "A sees its own file");
  assert.ok(!a.includes("only-b.txt"), "A must not see B's file");
  assert.ok(b.includes("only-b.txt"), "B sees its own file");
  assert.ok(!b.includes("only-a.txt"), "B must not see A's file");
});
