/**
 * 大檔上傳（200 MB）直接串流進儲存，不在這個行程裡抱成一個 Buffer。
 *
 * app 那一端送 `x-upload-size`（瀏覽器的 Content-Length），這裡照它：
 *   · 超過上限 → 413，一個位元組都不讀；
 *   · 實際比宣告多 → 中止，什麼都不留；
 *   · 實際比宣告少（傳到一半斷了）→ 400，什麼都不留；
 *   · 對得上 → 存檔、manifest 記下 size 與 sha256（邊傳邊算）。
 * 沒帶 `x-upload-size` 的舊呼叫端照舊走整包讀（小檔、編輯器存檔）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

const root = await mkdtemp(join(tmpdir(), "ava-stream-upload-"));
process.env.STORAGE_LOCAL_FS = "1";
process.env.STORAGE_LOCAL_FS_ROOT = root;
process.env.STORAGE_LOCAL_FS_BUCKET = "stream-upload";
process.env.AGENT_WORKSPACE_S3 = "1";
const { readFile, loadManifest } = await import("../workspace/userStore.mjs");
const { handleUserWorkspaceUpload, USER_UPLOAD_MAX_BYTES } = await import("./user-workspace-upload.mjs");
test.after(() => rm(root, { recursive: true, force: true }));

const sha = (b) => createHash("sha256").update(b).digest("hex");

function request(chunks, headers) {
  let pulled = 0;
  const req = Readable.from((async function* () { for (const c of chunks) { pulled++; yield c; } })());
  req.headers = { "content-type": "application/octet-stream", ...headers };
  req.pulled = () => pulled;
  return req;
}
const url = (p) => new URL(`http://localhost/v1/users/u1/workspace/file?path=${encodeURIComponent(p)}`);

test("the upload cap is 400 MB and is not the artifact cap", () => {
  assert.equal(USER_UPLOAD_MAX_BYTES, 400 * 1024 * 1024);
});

test("a declared-size upload streams into storage and the manifest records size and sha256", async () => {
  const chunks = Array.from({ length: 40 }, (_, i) => Buffer.alloc(512 * 1024, 97 + (i % 26)));
  const whole = Buffer.concat(chunks);
  const out = await handleUserWorkspaceUpload({ userId: "u1", req: request(chunks, { "x-upload-size": String(whole.length) }), url: url("data/big.bin") });
  assert.equal(out.size, whole.length);
  assert.equal(out.sha256, sha(whole));
  assert.equal(Buffer.compare(await readFile("u1", "data/big.bin"), whole), 0);
  const manifest = await loadManifest("u1");
  assert.deepEqual({ size: manifest.entries["data/big.bin"].size, sha256: manifest.entries["data/big.bin"].sha256 }, { size: whole.length, sha256: sha(whole) });
});

test("a declared size over the cap is refused before a byte is read", async () => {
  const req = request([Buffer.from("x")], { "x-upload-size": String(USER_UPLOAD_MAX_BYTES + 1) });
  await assert.rejects(handleUserWorkspaceUpload({ userId: "u1", req, url: url("huge.bin") }), (e) => e.status === 413);
  assert.equal(req.pulled(), 0);
});

test("more bytes than declared: aborted, nothing stored", async () => {
  const req = request([Buffer.alloc(10 * 1024 * 1024, 1), Buffer.alloc(10 * 1024 * 1024, 2)], { "x-upload-size": String(12 * 1024 * 1024) });
  await assert.rejects(handleUserWorkspaceUpload({ userId: "u1", req, url: url("liar.bin") }), (e) => e.status === 413);
  await assert.rejects(readFile("u1", "liar.bin"));
  assert.equal((await loadManifest("u1")).entries["liar.bin"], undefined);
});

test("fewer bytes than declared (connection dropped): refused, nothing stored", async () => {
  const req = request([Buffer.alloc(9 * 1024 * 1024, 3)], { "x-upload-size": String(20 * 1024 * 1024) });
  await assert.rejects(handleUserWorkspaceUpload({ userId: "u1", req, url: url("short.bin") }), (e) => e.status === 400);
  await assert.rejects(readFile("u1", "short.bin"));
  assert.equal((await loadManifest("u1")).entries["short.bin"], undefined);
});

test("without x-upload-size the old buffered path still works", async () => {
  const out = await handleUserWorkspaceUpload({ userId: "u1", req: request([Buffer.from("hello")], {}), url: url("small.txt") });
  assert.equal(out.size, 5);
  assert.equal((await readFile("u1", "small.txt")).toString(), "hello");
});
