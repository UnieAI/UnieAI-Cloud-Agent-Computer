/**
 * 單一路徑 stat 跟整份清單說的是同一件事（userStore.statWorkspacePath）。
 * 引擎拿 stat 的 size／mtimeMs 算版本、拿清單畫目錄 —— 兩邊一旦各說各話，
 * 同一個檔案就會 stat 說有、list 說沒有，或者防舊寫入的版本對不上。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ava-stat-path-"));
process.env.STORAGE_LOCAL_FS = "1";
process.env.STORAGE_LOCAL_FS_ROOT = root;
process.env.STORAGE_LOCAL_FS_BUCKET = "stat-bucket";
process.env.AGENT_WORKSPACE_S3 = "1";
const { writeFile, listWorkspaceManifest, statWorkspacePath } = await import("./userStore.mjs");
after(() => fs.rm(root, { recursive: true, force: true }));

const OWNER = "stat-user";
const nfd = "資料/café.md".normalize("NFD");

/** 清單的答案，用引擎 fs-target 的同一套規則讀。 */
function fromManifest(entries, rel) {
  const e = entries[rel];
  if (e) return e.kind === "dir" ? { type: "directory" } : { type: "file", size: Number(e.size) || 0, mtimeMs: e.mtimeMs ?? 0 };
  if (rel === "" || Object.keys(entries).some((k) => k.startsWith(`${rel}/`))) return { type: "directory" };
  return null;
}
const shape = (hit) => (hit ? (hit.type === "file" ? { type: "file", size: hit.size, mtimeMs: hit.mtimeMs } : { type: "directory" }) : null);

test("每一個路徑：stat 的答案 = 清單的答案", async () => {
  await writeFile(OWNER, "AGENTS.md", Buffer.from("# agents"));
  await writeFile(OWNER, "a.txt", Buffer.from("aaa"));
  await writeFile(OWNER, "a.txt.bak", Buffer.from("longer backup"));
  await writeFile(OWNER, "src/app/main.ts", Buffer.from("export {}"));
  await writeFile(OWNER, "proj/node_modules/x/index.js", Buffer.from("module.exports=1"));
  await writeFile(OWNER, "proj/.git/HEAD", Buffer.from("ref: refs/heads/main"));
  await writeFile(OWNER, nfd, Buffer.from("nfd bytes"));

  const { entries } = await listWorkspaceManifest(OWNER);
  for (const rel of ["", "AGENTS.md", "a.txt", "a.txt.bak", "a", "src", "src/app", "src/app/main.ts", "src/CLAUDE.md",
    "missing.md", "proj", "proj/node_modules", "proj/node_modules/x/index.js", "proj/.git", "proj/.git/HEAD", "資料", "資料/café.md".normalize("NFC")]) {
    assert.deepEqual(shape(await statWorkspacePath(OWNER, rel)), fromManifest(entries, rel), rel || "(root)");
  }
});

test("a.txt 不會被 a.txt.bak 冒充：大小是它自己的", async () => {
  assert.deepEqual(await statWorkspacePath(OWNER, "a.txt"), { type: "file", size: 3, mtimeMs: 0 });
});

test("NFD 鍵的檔案用 NFC 名字問得到（清單也是這樣呈現它）", async () => {
  const hit = await statWorkspacePath(OWNER, "資料/café.md".normalize("NFC"));
  assert.equal(hit?.type, "file");
  assert.equal(hit.size, Buffer.byteLength("nfd bytes"));
});

test("重目錄本身是資料夾（unlisted），裡面的東西跟清單一樣不存在", async () => {
  assert.deepEqual(await statWorkspacePath(OWNER, "proj/node_modules"), { type: "directory", mtimeMs: 0, unlisted: true });
  assert.equal(await statWorkspacePath(OWNER, "proj/node_modules/x/index.js"), null);
  assert.equal(await statWorkspacePath(OWNER, "proj/.git"), null);
});

test("stub 模式照索引回答", async () => {
  assert.equal(await statWorkspacePath(OWNER, "nothing-here.md", { live: false }), null);
  assert.deepEqual(await statWorkspacePath(OWNER, "", { live: false }), { type: "directory", mtimeMs: 0 });
});
