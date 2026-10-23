/**
 * userStore tests — guards against the data-loss regressions B1 / B2 / D
 * documented in the workspace audit (May 2026).
 *
 *   B1  loadManifest distinguishes NotFound (returns empty) from other
 *       errors (throws). Pre-fix behaviour was silent empty on any error,
 *       which made subsequent writeManifest calls wipe S3.
 *   B2  writeManifest refuses to overwrite a non-empty manifest with an
 *       empty entries set. Defence-in-depth even with B1 in place.
 *   D   withUserManifestLock serialises read-modify-write per userId so
 *       parallel callers don't interleave between load and write.
 *
 * Strategy: force storage-engine into local-fs mode (STORAGE_LOCAL_FS=1)
 * pointed at a per-test tmpdir. That gives us a real-but-isolated storage
 * backend without needing module mocking (Node 20 lacks mock.module).
 * Corrupt-JSON test plants a bad file directly on disk to exercise the
 * non-NotFound error path of loadManifest.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "userStore-test-"));
process.env.STORAGE_LOCAL_FS = "1";
process.env.STORAGE_LOCAL_FS_ROOT = tmpRoot;
process.env.STORAGE_LOCAL_FS_BUCKET = "test-bucket";

const {
  loadManifest,
  writeManifest,
  withUserManifestLock,
  updateManifest,
  SKIP_WRITE,
  manifestKey,
  isProtectedRelPath,
  ProtectedPathError,
  writeFile,
  readFile,
  deleteFile,
} = await import("./userStore.mjs");

// Each test resets storage by removing the bucket dir.
async function reset() {
  await fs.rm(path.join(tmpRoot, "test-bucket"), { recursive: true, force: true });
}

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// Resolve the on-disk path the local-fs backend uses for an S3 key.
function diskPathFor(key) {
  return path.join(tmpRoot, "test-bucket", key);
}

// ---------------------------------------------------------------------------
// B1 — loadManifest error handling
// ---------------------------------------------------------------------------

test("B1: loadManifest returns empty for NotFound (first-time user)", async () => {
  await reset();
  const m = await loadManifest("user1");
  assert.equal(Object.keys(m.entries).length, 0);
  assert.equal(m.userId, "user1");
});

test("B1: loadManifest throws on JSON corruption (was silently empty)", async () => {
  await reset();
  // Plant a corrupt manifest (truncated JSON, like an interrupted write).
  const target = diskPathFor(manifestKey("user1"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "{ \"entries\": { \"foo.txt\": ");
  await assert.rejects(
    () => loadManifest("user1"),
    /JSON|SyntaxError|Unexpected/,
    "corrupt manifest must throw, not silently appear empty — otherwise a subsequent writeManifest would wipe S3",
  );
});

// ---------------------------------------------------------------------------
// B2 (regression — guard intentionally removed)
//
// An earlier draft of the audit refused non-empty → empty writes as
// defence-in-depth. It was reverted because B1's loadManifest-throws
// behaviour already prevents the original wipe scenario, and the guard
// false-positives on the legitimate "delete the last file in the
// workspace" path — which broke DELETE /v1/users/<id>/workspace/file
// in production. These tests pin the new behaviour.
// ---------------------------------------------------------------------------

test("B2: writeManifest allows non-empty → empty (delete last entry)", async () => {
  await reset();
  await writeManifest("user1", {
    entries: { "a.txt": { size: 1, sha256: "aa", mtimeMs: 1 } },
  });
  // Caller drops their only entry and writes — this is what the DELETE
  // route does for the user's final file. Must NOT throw.
  const result = await writeManifest("user1", { entries: {} });
  assert.equal(Object.keys(result.entries).length, 0);
  const reloaded = await loadManifest("user1");
  assert.equal(Object.keys(reloaded.entries).length, 0);
});

test("B2: writeManifest allows empty when prior is also empty (first-time user)", async () => {
  await reset();
  const result = await writeManifest("user1", { entries: {} });
  assert.equal(Object.keys(result.entries).length, 0);
});

test("B2: writeManifest allows non-empty → empty even when prior had many entries (full sweep)", async () => {
  await reset();
  await writeManifest("user1", {
    entries: {
      "a.txt": { size: 1, sha256: "aa", mtimeMs: 1 },
      "b.txt": { size: 1, sha256: "bb", mtimeMs: 1 },
      "c.txt": { size: 1, sha256: "cc", mtimeMs: 1 },
    },
  });
  // Caller sweeps all three. With B1 in place this can only happen on
  // an intentional bulk-delete, which is allowed. The original threat
  // (transient load returns empty → blind write wipes) was solved at
  // the read side: loadManifest now throws on errors instead of
  // returning empty, so a buggy caller can no longer reach this path
  // by accident.
  const result = await writeManifest("user1", { entries: {} });
  assert.equal(Object.keys(result.entries).length, 0);
});

// ---------------------------------------------------------------------------
// D — per-userId mutex
// ---------------------------------------------------------------------------

test("D: withUserManifestLock serialises parallel callers for same userId", async () => {
  await reset();
  // Three parallel "add an entry" RMW. Without the lock, all three load
  // the same baseline (empty), each adds one entry, last write wins =
  // we see only 1 entry. With the lock, they run sequentially = 3 entries.
  const adder = (key) => withUserManifestLock("user1", async () => {
    const m = await loadManifest("user1");
    m.entries = m.entries || {};
    // Yield to the event loop so an unlocked second caller could see this
    // stale-load state. The lock must prevent that.
    await new Promise((r) => setImmediate(r));
    m.entries[key] = { size: 1, sha256: key, mtimeMs: Date.now() };
    await writeManifest("user1", m);
  });

  await Promise.all([adder("a.txt"), adder("b.txt"), adder("c.txt")]);

  const m = await loadManifest("user1");
  assert.equal(
    Object.keys(m.entries).length, 3,
    "all three entries must survive — if not, parallel RMW is dropping writes",
  );
  assert.ok(m.entries["a.txt"]);
  assert.ok(m.entries["b.txt"]);
  assert.ok(m.entries["c.txt"]);
});

test("D: withUserManifestLock does not serialise across different userIds", async () => {
  await reset();
  let inFlight = 0;
  let maxInFlight = 0;
  const op = (userId) => withUserManifestLock(userId, async () => {
    inFlight += 1;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
  });
  await Promise.all([op("alice"), op("bob"), op("carol")]);
  assert.equal(maxInFlight, 3, "different userIds must NOT serialise");
});

test("D: withUserManifestLock survives a failing predecessor", async () => {
  await reset();
  const ok = withUserManifestLock("user1", async () => "first").catch(() => "first-rejected");
  const bad = withUserManifestLock("user1", async () => { throw new Error("boom"); }).catch((e) => e.message);
  const ok2 = withUserManifestLock("user1", async () => "third");
  const [a, b, c] = await Promise.all([ok, bad, ok2]);
  assert.equal(a, "first");
  assert.equal(b, "boom");
  assert.equal(c, "third", "a rejected predecessor must NOT block the next caller");
});

// ---------------------------------------------------------------------------
// Integration: B1 alone is enough — the exact regression that motivated the
// audit. B2 was removed (false-positive on legit delete-last-entry), so B1's
// throwing loadManifest now carries the full weight of preventing the wipe.
// ---------------------------------------------------------------------------

test("integration: B1 throw prevents the original wipe scenario without B2", async () => {
  await reset();
  // Plant a real workspace with 3 entries.
  await writeManifest("user1", {
    entries: {
      "a.txt": { size: 1, sha256: "aa", mtimeMs: 1 },
      "b.txt": { size: 1, sha256: "bb", mtimeMs: 1 },
      "c.txt": { size: 1, sha256: "cc", mtimeMs: 1 },
    },
  });

  // Simulate the original bug: caller corrupts the manifest mid-flight
  // (or a flaky S3 returns junk for a read). Old behaviour: loadManifest
  // returns empty, the caller's add-then-write wipes all 3 entries.
  // New behaviour: loadManifest throws → caller propagates the error,
  // never reaches writeManifest, S3 stays intact.
  const target = diskPathFor(manifestKey("user1"));
  await fs.writeFile(target, "{ not json");

  // The "buggy caller" pattern: load → modify → write.
  const buggy = async () => {
    const m = await loadManifest("user1"); // throws now
    m.entries["new.txt"] = { size: 1, sha256: "dd", mtimeMs: 1 };
    await writeManifest("user1", m);
  };
  await assert.rejects(buggy, /JSON|SyntaxError|Unexpected/);

  // Restore the manifest (simulate operator repair / next clean write).
  await writeManifest("user1", {
    entries: {
      "a.txt": { size: 1, sha256: "aa", mtimeMs: 1 },
      "b.txt": { size: 1, sha256: "bb", mtimeMs: 1 },
      "c.txt": { size: 1, sha256: "cc", mtimeMs: 1 },
    },
  });
  const restored = await loadManifest("user1");
  assert.equal(Object.keys(restored.entries).length, 3);
});

// ---------------------------------------------------------------------------
// Protected system files — `.manifest.json` / `blobs/` must never be deleted or
// overwritten through the public per-file API (deleting the manifest orphans
// the whole tree). The system's own writers use putObject(manifestKey/blobKey)
// directly and bypass this guard.
// ---------------------------------------------------------------------------

test("isProtectedRelPath: manifest + blobs are protected, normal files are not", () => {
  assert.equal(isProtectedRelPath(".manifest.json"), true);
  assert.equal(isProtectedRelPath("/.manifest.json"), true); // leading slash tolerated
  assert.equal(isProtectedRelPath("blobs"), true);
  assert.equal(isProtectedRelPath("blobs/ab/cd"), true);
  assert.equal(isProtectedRelPath("notes.md"), false);
  assert.equal(isProtectedRelPath("src/app.ts"), false);
  assert.equal(isProtectedRelPath("blobsy.txt"), false); // not the blobs/ dir
});

test("deleteFile refuses to delete a protected file (and never hits storage)", async () => {
  await reset();
  await assert.rejects(
    () => deleteFile("user1", ".manifest.json"),
    (e) => e instanceof ProtectedPathError && e.code === "protected_path",
  );
  await assert.rejects(
    () => deleteFile("user1", "blobs/aa/bb"),
    (e) => e instanceof ProtectedPathError,
  );
});

test("writeFile refuses to overwrite a protected file", async () => {
  await reset();
  await assert.rejects(
    () => writeFile("user1", ".manifest.json", Buffer.from("{}")),
    (e) => e instanceof ProtectedPathError && e.code === "protected_path",
  );
});

test("guard does NOT block normal files (write/read/delete round-trip)", async () => {
  await reset();
  await writeFile("user1", "notes/todo.md", Buffer.from("hello"));
  const buf = await readFile("user1", "notes/todo.md");
  assert.equal(buf.toString(), "hello");
  await deleteFile("user1", "notes/todo.md"); // should not throw
});

// ---------------------------------------------------------------------------
// CAS — the mechanism that replaces the single-writer POLICY.
//
// `withUserManifestLock` only serialises writers INSIDE ONE PROCESS. Its
// correctness argument was "the per-user-singleton sandbox-runtime policy means
// one process owns one user's manifest at a time" — a deployment arrangement,
// not something the code enforces. These tests exercise the case the lock
// cannot see: a writer that never took it.
// ---------------------------------------------------------------------------

/** A writer from "another process": same store, no shared in-memory lock. */
async function foreignWrite(userId, mutate) {
  const m = await loadManifest(userId);
  m.entries = m.entries || {};
  mutate(m.entries);
  await writeManifest(userId, m, m.__etag ? { ifMatch: m.__etag } : { ifNoneMatch: "*" });
}

test("CAS: a stale write is REFUSED, not silently applied", async () => {
  await reset();
  await updateManifest("user1", (m) => { m.entries.a = { size: 1, sha256: "a" }; });
  const stale = await loadManifest("user1"); // read...
  await foreignWrite("user1", (e) => { e.b = { size: 1, sha256: "b" }; }); // ...someone commits
  await assert.rejects(
    () => writeManifest("user1", stale, { ifMatch: stale.__etag }),
    (err) => /precondition/i.test(String(err?.message || err)) || err?.name === "PreconditionFailedError",
    "a write carrying a superseded version token must not land",
  );
  const now = await loadManifest("user1");
  assert.deepEqual(Object.keys(now.entries).sort(), ["a", "b"]);
});

test("CAS: updateManifest re-applies on top of a concurrent writer, losing nothing", async () => {
  await reset();
  await updateManifest("user1", (m) => { m.entries.base = { size: 1, sha256: "base" }; });

  // Land a foreign write on the FIRST attempt only, i.e. exactly in the window
  // between this updater's read and its write. Without CAS, `mine` would be
  // written over a stale baseline and `theirs` would vanish.
  let injected = false;
  await updateManifest("user1", async (m) => {
    if (!injected) {
      injected = true;
      await foreignWrite("user1", (e) => { e.theirs = { size: 1, sha256: "t" }; });
    }
    m.entries.mine = { size: 1, sha256: "m" };
  });

  const final = await loadManifest("user1");
  assert.deepEqual(Object.keys(final.entries).sort(), ["base", "mine", "theirs"]);
});

test("CAS: the very first write is create-only, so two first-writers cannot both win", async () => {
  await reset();
  let injected = false;
  await updateManifest("user1", async (m) => {
    if (!injected) {
      injected = true;
      await foreignWrite("user1", (e) => { e.first = { size: 1, sha256: "f" }; });
    }
    m.entries.second = { size: 1, sha256: "s" };
  });
  const final = await loadManifest("user1");
  assert.deepEqual(Object.keys(final.entries).sort(), ["first", "second"]);
});

test("CAS: SKIP_WRITE performs no write at all", async () => {
  await reset();
  await updateManifest("user1", (m) => { m.entries.a = { size: 1, sha256: "a" }; });
  const before = (await loadManifest("user1")).__etag;
  const out = await updateManifest("user1", () => SKIP_WRITE);
  assert.equal(out, SKIP_WRITE);
  assert.equal((await loadManifest("user1")).__etag, before, "an unchanged manifest must not be rewritten");
});

test("CAS: a mutator that keeps losing eventually throws rather than overwriting", async () => {
  await reset();
  await updateManifest("user1", (m) => { m.entries.a = { size: 1, sha256: "a" }; });
  let n = 0;
  await assert.rejects(
    () => updateManifest("user1", async (m) => {
      // A foreign writer commits before EVERY attempt — the CAS can never win.
      await foreignWrite("user1", (e) => { e[`x${n++}`] = { size: 1, sha256: "x" }; });
      m.entries.never = { size: 1, sha256: "n" };
    }),
    (err) => /precondition/i.test(String(err?.message || err)),
    "giving up loudly beats forcing the write through",
  );
  const final = await loadManifest("user1");
  assert.ok(!("never" in final.entries), "the losing write must not have landed");
});

test("local-fs etag identifies CONTENT, not length", async () => {
  await reset();
  await updateManifest("user1", (m) => { m.entries.aa = { size: 1, sha256: "1" }; });
  const first = (await loadManifest("user1")).__etag;
  await updateManifest("user1", (m) => { delete m.entries.aa; m.entries.bb = { size: 1, sha256: "1" }; });
  const second = (await loadManifest("user1")).__etag;
  // Same-length manifests used to share the etag `local-<length>`, which made
  // every CAS against this backend a coin flip that usually said "unchanged".
  assert.notEqual(first, second);
});
