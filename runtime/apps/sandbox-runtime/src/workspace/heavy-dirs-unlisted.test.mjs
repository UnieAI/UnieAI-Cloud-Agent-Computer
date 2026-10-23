/**
 * 重目錄不列內容，但資料夾本身要看得到 —— 2026-09-26 UAT 軌道 B1，D13（`s5-06`）。
 *
 * AI 在 `uat0926-longjob/node_modules` 底下產生了 300 個檔，檔案樹裡**整個資料夾
 * 都不見了**，沒有任何提示。不下去（不花掉清單的預算）是對的 —— 那是 2026-09-16
 * 那個「排在 node_modules 後面的檔案消失」的修法；安靜消失不對。
 *
 * 所以：重目錄以 `{ kind: "dir", unlisted: true }` 出現，內容照舊不列。
 * `.git` 例外：它是版本庫的內部，大多數檔案瀏覽器預設就藏它。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "heavy-unlisted-"));
process.env.STORAGE_LOCAL_FS = "1";
process.env.STORAGE_LOCAL_FS_ROOT = path.join(tmpRoot, "s3");
process.env.STORAGE_LOCAL_FS_BUCKET = "test-bucket";

const { putObject, systemLocation } = await import("../../../../packages/storage-engine/src/index.mjs");
const { listWorkspaceManifest } = await import("./userStore.mjs");
const rawKey = (key) => systemLocation(key, "raw fixture at a literal legacy key");

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test("node_modules／__pycache__／.venv 以「不列內容」的資料夾出現；.git 不出現", async () => {
  const P = "users/u-heavy/workspace";
  for (let i = 0; i < 30; i += 1) {
    await putObject({ at: rawKey(`${P}/uat0926-longjob/node_modules/pkg${i}/index.js`), body: "x" });
  }
  await putObject({ at: rawKey(`${P}/uat0926-longjob/zz-after-node-modules.txt`), body: "done" });
  await putObject({ at: rawKey(`${P}/uat0926-longjob/__pycache__/m.cpython-311.pyc`), body: "p" });
  await putObject({ at: rawKey(`${P}/proj/.venv/bin/python`), body: "v" });
  await putObject({ at: rawKey(`${P}/proj/.git/HEAD`), body: "ref: refs/heads/main" });
  // 重目錄裡面的重目錄：外面那一層已經不下去了，裡面那一層不該冒出來。
  await putObject({ at: rawKey(`${P}/uat0926-longjob/node_modules/a/node_modules/b/i.js`), body: "n" });

  const m = await listWorkspaceManifest("user:u-heavy");
  const unlisted = Object.entries(m.entries).filter(([, v]) => v?.unlisted).map(([k]) => k).sort();
  assert.deepEqual(unlisted, ["proj/.venv", "uat0926-longjob/__pycache__", "uat0926-longjob/node_modules"]);
  for (const k of unlisted) assert.equal(m.entries[k].kind, "dir");
  assert.ok("uat0926-longjob/zz-after-node-modules.txt" in m.entries, "旁邊的檔案照舊列得出來");
  const keys = Object.keys(m.entries);
  assert.equal(keys.filter((k) => k.split("/").slice(0, -1).some((s) => ["node_modules", "__pycache__", ".venv", ".git"].includes(s))).length, 0,
    "重目錄的內容仍然不列");
  assert.ok(!keys.some((k) => k.split("/").includes(".git")), ".git 不出現");
});
