import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

const root = await mkdtemp(join(tmpdir(), "ava-file-cas-"));
process.env.STORAGE_LOCAL_FS = "1";
process.env.STORAGE_LOCAL_FS_ROOT = root;
process.env.STORAGE_LOCAL_FS_BUCKET = "file-review";
process.env.AGENT_WORKSPACE_S3 = "1";
const { writeFile, readFile, loadManifest } = await import("../workspace/userStore.mjs");
const { handleUserWorkspaceUpload } = await import("./user-workspace-upload.mjs");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const upload = (path, content, expected = undefined) => {
  const req = Readable.from([Buffer.from(content)]);
  req.headers = { "content-type": "text/plain", ...(expected === undefined ? {} : { "x-expected-content-sha256": hash(expected) }) };
  return handleUserWorkspaceUpload({ userId: "test-user", req, url: new URL(`http://localhost/v1/users/test-user/workspace/file-conditional?allowEmpty=1&path=${path}`) });
};
test.after(() => rm(root, { recursive: true, force: true }));

test("two editors with the same baseline cannot both overwrite the file", async () => {
  await writeFile("test-user", "race.txt", Buffer.from("baseline"));
  const results = await Promise.allSettled([upload("race.txt", "editor A", "baseline"), upload("race.txt", "editor B", "baseline")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const loser = results.find((r) => r.status === "rejected");
  assert.equal(loser.reason.status, 409);
  const content = (await readFile("test-user", "race.txt")).toString();
  assert.ok(["editor A", "editor B"].includes(content));
  const manifest = await loadManifest("test-user");
  assert.equal(manifest.entries["race.txt"].sha256, hash(content));
});

test("stale editor and deleted files conflict without recreating or replacing bytes", async () => {
  await writeFile("test-user", "external.txt", "agent changes");
  await assert.rejects(upload("external.txt", "draft", "old"), (e) => e.status === 409);
  assert.equal((await readFile("test-user", "external.txt")).toString(), "agent changes");
  await assert.rejects(upload("missing.txt", "draft", "old"), (e) => e.status === 409);
});

test("empty file edits work and conditional endpoint cannot bypass the baseline", async () => {
  await writeFile("test-user", "empty.txt", "");
  await upload("empty.txt", "new", "");
  assert.equal((await readFile("test-user", "empty.txt")).toString(), "new");
  await assert.rejects(upload("empty.txt", "replacement"), (e) => e.status === 400);
  assert.equal((await readFile("test-user", "empty.txt")).toString(), "new");
});
