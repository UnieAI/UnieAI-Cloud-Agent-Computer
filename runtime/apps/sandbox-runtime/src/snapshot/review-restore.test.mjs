/**
 * snapshot/review-restore.test.mjs — 檢閱面板那一條路，用真的 git 跑一次。
 *
 * 2026-09-26 UAT 軌道 B1，D2。檢閱要做兩件事：列出「基準之後工作區改了什麼」，
 * 以及逐檔「還原回基準」。後者對**這個對話新增的檔案**從來沒有成功過：
 * `git checkout <base> -- <新檔>` 只會回 pathspec 不存在 —— 基準裡本來就沒有它，
 * 還原它的意思是刪掉它。`removeMissing` 讓呼叫端（審閱路由）明說要這個語意；
 * 版本歷史「找回被刪的檔」那條路不帶它，行為不變。
 *
 * 後端換成一個把 `/snapshots/.git`、`/workspace` 映到暫存資料夾、用真的 bash
 * 與 git 執行的替身 —— 指令字串照原樣送出去，錯的引號或路徑都會在這裡炸。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "review-restore-"));
const ws = join(root, "ws");
const gitDir = join(root, "snap", ".git");
await mkdir(ws, { recursive: true });

const cube = await import("../cube/index.mjs");
cube.resetBackend();
cube.setBackend({
  async execProcess(_sandboxId, { command }) {
    const mapped = command.split("/snapshots/.git").join(gitDir).split("/workspace").join(ws);
    const handle = new EventEmitter();
    const child = spawn("bash", ["-c", mapped], { env: { ...process.env, HOME: root } });
    child.stdout.on("data", (d) => handle.emit("stdout", d));
    child.stderr.on("data", (d) => handle.emit("stderr", d));
    child.on("error", (err) => handle.emit("error", err));
    child.on("close", (code) => handle.emit("exit", { code }));
    return handle;
  },
});

const { snapshotCreate, snapshotDiff, snapshotRestoreFile } = await import("./index.mjs");
const exists = (p) => access(p).then(() => true, () => false);

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("列得出基準之後的新增／修改／刪除，並且逐檔還原得回去（含這個對話新增的檔）", async () => {
  await writeFile(join(ws, "keep.txt"), "one\n");
  await writeFile(join(ws, "gone.txt"), "two\n");
  await mkdir(join(ws, "報告"), { recursive: true });
  const { hash } = await snapshotCreate("sb-test");
  assert.match(hash, /^[0-9a-f]{40}$/);

  // 這個對話做的事：改一個、刪一個、在中文資料夾裡新增一個帶空白的檔名。
  await writeFile(join(ws, "keep.txt"), "one\nchanged\n");
  await rm(join(ws, "gone.txt"));
  await writeFile(join(ws, "報告", "new file.py"), "print('hi')\n");

  const diff = await snapshotDiff("sb-test", hash);
  const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f.status]));
  assert.deepEqual(byPath, { "gone.txt": "D", "keep.txt": "M", "報告/new file.py": "A" });

  // 沒帶 removeMissing：新檔還原不了（舊行為，版本歷史那條路靠它不動別的檔）。
  await assert.rejects(snapshotRestoreFile("sb-test", hash, ["報告/new file.py"]), /git checkout failed/);
  assert.equal(await exists(join(ws, "報告", "new file.py")), true);

  // 審閱的還原：新檔 → 刪掉；改過的 → 回到基準；刪掉的 → 回來。
  await snapshotRestoreFile("sb-test", hash, ["報告/new file.py"], { removeMissing: true });
  assert.equal(await exists(join(ws, "報告", "new file.py")), false);
  await snapshotRestoreFile("sb-test", hash, ["keep.txt"], { removeMissing: true });
  assert.equal(await readFile(join(ws, "keep.txt"), "utf8"), "one\n");
  await snapshotRestoreFile("sb-test", hash, ["gone.txt"], { removeMissing: true });
  assert.equal(await readFile(join(ws, "gone.txt"), "utf8"), "two\n");

  assert.deepEqual((await snapshotDiff("sb-test", hash)).files, [], "全部還原之後跟基準一樣");
});

test("removeMissing 仍然擋掉越界的路徑", async () => {
  await assert.rejects(snapshotRestoreFile("sb-test", "a".repeat(40), ["../etc/passwd"], { removeMissing: true }), /illegal restore path/);
  await assert.rejects(snapshotRestoreFile("sb-test", "a".repeat(40), ["/etc/passwd"], { removeMissing: true }), /illegal restore path/);
});
