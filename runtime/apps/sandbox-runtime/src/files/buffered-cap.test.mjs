/**
 * The BUFFERED upload path keeps its old cap (security review 2026-09-27, HIGH).
 *
 * Raising the upload entry to 200 MB is only safe where the body streams. The
 * buffered path is still reached — with no `x-upload-size` (the agent's own
 * file-write tools call this endpoint that way: lib/agent-code/coding-tools-core.ts,
 * run-file-ops.ts) and always for memory, skill and conditional (editor save)
 * paths — and it holds the whole body in this shared, multi-tenant process.
 * So it stays at artifact.maxBytes (100 MB by default), and a declared size
 * over that on a must-buffer path is refused before a byte is read.
 *
 * The cap is set to 1 MiB here (its own process under node --test) so the test
 * stays small; the default is asserted from the config source.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile as readFsFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const root = await mkdtemp(join(tmpdir(), "ava-buffered-cap-"));
process.env.STORAGE_LOCAL_FS = "1";
process.env.STORAGE_LOCAL_FS_ROOT = root;
process.env.STORAGE_LOCAL_FS_BUCKET = "buffered-cap";
process.env.AGENT_WORKSPACE_S3 = "1";
process.env.SANDBOX_ARTIFACT_MAX_BYTES = String(1024 * 1024);
const { readFile } = await import("../workspace/userStore.mjs");
const { handleUserWorkspaceUpload, BUFFERED_UPLOAD_MAX_BYTES, USER_UPLOAD_MAX_BYTES } = await import("./user-workspace-upload.mjs");
test.after(() => rm(root, { recursive: true, force: true }));

const MB = 1024 * 1024;
function request(bytes, headers = {}) {
  let pulled = 0;
  const req = Readable.from((async function* () { for (let i = 0; i < bytes; i += 256 * 1024) { pulled++; yield Buffer.alloc(Math.min(256 * 1024, bytes - i), 7); } })());
  req.headers = { "content-type": "application/octet-stream", ...headers };
  req.pulled = () => pulled;
  return req;
}
const url = (p, conditional = false) => new URL(`http://localhost/v1/users/u1/workspace/${conditional ? "file-conditional" : "file"}?path=${encodeURIComponent(p)}`);

test("the buffered cap follows artifact.maxBytes; only the streamed path gets 400 MB", async () => {
  assert.equal(BUFFERED_UPLOAD_MAX_BYTES, MB);
  assert.equal(USER_UPLOAD_MAX_BYTES, 400 * MB);
  const cfg = await readFsFile(new URL("../config.mjs", import.meta.url), "utf8");
  assert.match(cfg, /bufferedUploadMaxBytes: envInt\("SANDBOX_USER_BUFFERED_UPLOAD_MAX_BYTES", artifactMaxBytes\)/);
  assert.match(cfg, /const artifactMaxBytes = envInt\("SANDBOX_ARTIFACT_MAX_BYTES", 100_000_000\)/);
});

test("no x-upload-size (the agent's own writes): over the buffered cap is 413, nothing stored", async () => {
  await assert.rejects(handleUserWorkspaceUpload({ userId: "u1", req: request(2 * MB), url: url("agent-out.bin") }), (e) => e.status === 413);
  await assert.rejects(readFile("u1", "agent-out.bin"));
});

for (const [label, p, conditional] of [
  ["memory file", ".opencode/memories/big.md", false],
  ["skill file", ".opencode/skills/x/big.md", false],
  ["conditional editor save", "notes.md", true],
]) {
  test(`${label} declaring more than the buffered cap is refused before a byte is read`, async () => {
    const req = request(2 * MB, { "x-upload-size": String(2 * MB) });
    await assert.rejects(handleUserWorkspaceUpload({ userId: "u1", req, url: url(p, conditional) }), (e) => e.status === 413);
    assert.equal(req.pulled(), 0);
  });
}

test("a declared-size upload on an ordinary path still streams past the buffered cap", async () => {
  const out = await handleUserWorkspaceUpload({ userId: "u1", req: request(3 * MB, { "x-upload-size": String(3 * MB) }), url: url("big.bin") });
  assert.equal(out.size, 3 * MB);
});
