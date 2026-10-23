/**
 * 快照庫唯讀的時候，沙盒這一端有沒有喊 —— 2026-10-08 A2。
 *
 * 線上實況（唯讀量到的）：41 個使用者工作區裡 21 個有 `.snapshots/.git`，其中
 * 17 個是 **uid 0 擁有、mode 0755** —— 沙盒改用 uid 1000 之後，群組只有 `r-x`，
 * 所以 git 連 config 都鎖不住：
 *
 *   git init failed: error: could not lock config file
 *   /snapshots/.git/config: Permission denied
 *
 * `git init` 那條路本來就會丟（`snapshot_init_failed`，500），所以它是吵的。
 * 安靜的是**第二段**：寫 `refs/heads/snapshots` 那一筆 commit。它原本是
 *
 *     await runShell(sandboxId, commitCmd).catch(() => {});       // ← 吞掉例外
 *     …… `fi || true`                                             // ← 連 exit code 都蓋成 0
 *
 * 而那一筆 commit **就是版本歷史那張清單**：tree 拍到了、API 回 200、engine
 * 很開心，而 ref 不動 → 面板永遠「尚無版本記錄」。零日誌、零回傳、零畫面。
 *
 * 這一道閘門用**真的 git、真的 EACCES**（chmod 掉測試用的 objects/refs），
 * 不用假的 exit code：假的只能證明 if 判斷寫對了，證不出 git 在這個權限下
 * 真的會失敗。
 *
 * 跑法：node --test runtime/apps/sandbox-runtime/src/snapshot/readonly-store-alarm.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { snapshotCreate, _internal } from "./index.mjs";

const run = promisify(execFile);

/**
 * 一個「沙盒」的替身：真的在主機上跑 bash，GIT_DIR / GIT_WORK_TREE 用臨時目錄
 * 取代 /snapshots/.git 與 /workspace。替換的只有那兩個路徑字串 —— git 的行為、
 * 權限檢查、exit code、stderr 全都是真的。
 */
function hostShell(gitDir, workTree) {
  return async (_sandboxId, command, { timeoutMs = 30_000 } = {}) => {
    const rewritten = command
      .split(_internal.SNAPSHOT_GIT_DIR).join(gitDir)
      .split(_internal.SNAPSHOT_WORK_TREE).join(workTree);
    try {
      const { stdout, stderr } = await run("bash", ["-c", rewritten], {
        timeout: timeoutMs,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
      });
      return { stdout, stderr, code: 0 };
    } catch (err) {
      return { stdout: String(err?.stdout || ""), stderr: String(err?.stderr || err?.message || ""), code: err?.code ?? -1 };
    }
  };
}

/** 收 shared/log.mjs 吐出的那幾行 JSON。 */
function captureLog() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    for (const a of args) {
      if (typeof a !== "string") continue;
      try { lines.push(JSON.parse(a)); } catch { /* 非 JSON 的就不是事件 */ }
    }
  };
  return { lines, restore: () => { console.log = original; } };
}

async function makeStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "snap-ro-"));
  const gitDir = path.join(root, "snapshots", ".git");
  const workTree = path.join(root, "workspace");
  await fs.mkdir(workTree, { recursive: true });
  await fs.writeFile(path.join(workTree, "report.md"), "# 第一版\n");
  return { root, gitDir, workTree };
}

test("快照庫可寫的時候：拍得成、ref 真的移動、回報 committed", async (t) => {
  const { root, gitDir, workTree } = await makeStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const shell = hostShell(gitDir, workTree);

  const first = await snapshotCreate("sb-test", { shell });
  assert.match(first.hash, /^[0-9a-f]{40}$/);
  assert.equal(first.committed, true, "可寫的庫必須回報有寫進去");

  const { stdout } = await run("git", ["--git-dir", gitDir, "log", "--format=%H", "refs/heads/snapshots"]);
  assert.equal(stdout.trim().split("\n").filter(Boolean).length, 1, "ref 應該真的有一筆 commit");

  // 同一棵樹再拍一次 → 去重，不多一列，但仍然算「歷史是健康的」。
  const again = await snapshotCreate("sb-test", { shell });
  assert.equal(again.committed, true, "去重不是失敗");
  const after = await run("git", ["--git-dir", gitDir, "log", "--format=%H", "refs/heads/snapshots"]);
  assert.equal(after.stdout.trim().split("\n").filter(Boolean).length, 1, "閒置的輪次不該堆出重複的列");
});

test("快照庫唯讀（真的 EACCES）→ 版本歷史寫不進去，而且這件事會響", async (t) => {
  const { root, gitDir, workTree } = await makeStore();
  t.after(async () => {
    // 先把權限還原，不然 rm 自己也進不去。
    await run("chmod", ["-R", "u+rwX", root]).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const shell = hostShell(gitDir, workTree);

  // 先在可寫的狀態拍一張，讓庫與 ref 存在（＝線上那 17 個目錄的狀態：
  // 庫是舊 ownership 建好的，然後才變成寫不進去）。
  const good = await snapshotCreate("sb-test", { shell });
  assert.equal(good.committed, true);

  // 現在只讓「移動 ref」失敗：refs/ 拿掉寫權限，objects/index/config 留著。
  // 所以 `git init` / `git add -A` / `git write-tree` / `git commit-tree` 全都
  // 還過得去，只有 `git update-ref` 進不去 —— 這正是那個安靜的情況：tree 拍到
  // 了、API 回 200、engine 很開心，而版本歷史那張清單一列都不會多。
  //
  // （objects/ 也拿掉寫權限的話 `git add -A` 就先爆了，那是吵的那一半：
  // snapshot_create_failed 500，app 本來就看得到。這個案例要釘的是另一半。）
  await fs.writeFile(path.join(workTree, "report.md"), "# 第二版\n");
  await run("chmod", ["-R", "a-w", path.join(gitDir, "refs")]);
  await run("chmod", ["a-w", path.join(gitDir, "logs")]).catch(() => {});

  const cap = captureLog();
  let out;
  try {
    out = await snapshotCreate("sb-test", { shell });
  } finally {
    cap.restore();
  }

  assert.equal(out.committed, false, "歷史沒有累積，回傳就必須說沒有 —— 不然 app 無法告訴使用者");
  assert.ok(
    /Permission denied|denied|cannot|unable|error/i.test(String(out.commit_error || "")),
    `commit_error 要帶著 git 的原話；實際：${JSON.stringify(out.commit_error)}`,
  );
  const events = cap.lines.filter((l) => l?.event === "snapshot.history_commit_failed");
  assert.equal(
    events.length,
    1,
    `唯讀的快照庫必須留下一行 snapshot.history_commit_failed；實際收到：${JSON.stringify(cap.lines.map((l) => l?.event))}`,
  );
  assert.equal(events[0].sandboxId, "sb-test");
  assert.ok(events[0].message, "事件要帶訊息，不然 grep 到也不知道為什麼");

  // 而且 ref 真的沒有動 —— 證明這不是一個假警報。
  const log = await run("git", ["--git-dir", gitDir, "log", "--format=%H", "refs/heads/snapshots"]);
  assert.equal(
    log.stdout.trim().split("\n").filter(Boolean).length,
    1,
    "唯讀的庫不可能多一筆 commit；如果多了，上面那個 false 就是誤報",
  );
});

test("source pin：commit 那一段不可以再被 `|| true` 或 `.catch(() => {})` 蓋成成功", async () => {
  const src = await fs.readFile(new URL("./index.mjs", import.meta.url), "utf8");
  const from = src.indexOf("let committed = true;");
  const to = src.indexOf("history_commit_failed");
  assert.ok(from > 0 && to > from, "找不到 commit 那一段 —— 這道 pin 的窗口要跟著改");
  // 註解拿掉再看 —— 不然「No trailing `|| true`」這句解釋本身就會讓 pin 紅。
  const commitBlock = src.slice(from, to).replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !/\|\|\s*true/.test(commitBlock),
    "`|| true` 會把 exit code 蓋成 0 —— 那正是這個失敗當初為什麼沒有人看見",
  );
  assert.ok(
    !/\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(commitBlock),
    "空的 .catch 等於把版本歷史的失敗靜音；要接起來但要上報",
  );
});
