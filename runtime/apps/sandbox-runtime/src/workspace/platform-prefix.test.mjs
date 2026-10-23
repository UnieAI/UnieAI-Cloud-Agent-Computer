/**
 * 平台自己的檔案必須待在使用者的工作區「外面」。
 *
 * 沙盒的 /workspace 就是 `<owner>/workspace/` 這個 S3 前綴的 weed-mount，所以
 * 「模型在 `ls -la /workspace` 看不看得到平台檔案」這件事，在 S3 這一層是可以
 * 精確斷言的：**只要 key 不在 `<owner>/workspace/` 底下，沙盒裡就不存在**。
 * 這支測試就是釘這條不變量，加上搬家期間的兩個安全網（舊路徑還讀得到、遷移
 * 腳本可以重跑）。
 *
 * 跟其他 workspace 測試一樣強制走 local-fs 儲存（tmpdir），不需要 S3/SeaweedFS。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "platform-prefix-test-"));
// 一定要在 import storage-engine 之前設 —— 它在 module load 時就讀這幾個值。
// 也順便確保底下 import 的遷移腳本（它會 dotenv 載入 .env）絕對打不到真的 S3。
process.env.STORAGE_LOCAL_FS = "1";
process.env.STORAGE_LOCAL_FS_ROOT = path.join(tmpRoot, "s3");
process.env.STORAGE_LOCAL_FS_BUCKET = "test-bucket";

const { putObject, listObjectsByPrefix, systemLocation } = await import(
  "../../../../packages/storage-engine/src/index.mjs"
);

/**
 * A literal key in the default bucket.
 *
 * The store takes LOCATIONS, not keys, so that a tenant's bucket and its key
 * always come out of the same `owner`. This file is the exception the type is
 * designed to allow: it asserts on the RAW KEYS themselves — "the sandbox sees
 * exactly these" is the whole point — so the fixtures are placed at literal
 * legacy keys in the default bucket and `systemLocation` is the sanctioned,
 * greppable way to say so out loud. Every test here runs without
 * SANDBOX_ISOLATED_TENANTS, so the default bucket IS where userStore writes.
 */
const rawKey = (key) => systemLocation(key, "raw fixture at a literal legacy key");
const {
  fileKey,
  legacyFileKey,
  manifestKey,
  legacyManifestKey,
  platformRelOf,
  readFile,
  writeFile,
  deleteFile,
  loadManifest,
  updateManifest,
  listWorkspaceManifest,
} = await import("./userStore.mjs");
const { main: runMigration } = await import("../../../../../scripts/migrate-platform-prefix.mjs");

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** 沙盒真正看得到的東西：`<owner>/workspace/` 底下的所有 key（相對路徑）。 */
async function whatTheSandboxSees(userId) {
  const prefix = `users/${userId}/workspace/`;
  const objs = await listObjectsByPrefix({ at: rawKey(prefix), maxItems: 5000 });
  return objs.map((o) => String(o.key).slice(prefix.length)).sort();
}

// ---------------------------------------------------------------------------
// 1. 沙盒裡看不到平台檔案
// ---------------------------------------------------------------------------

test("平台檔案不落在 /workspace 掛載範圍內", async () => {
  const uid = "u-hidden";
  const owner = `user:${uid}`;

  // 使用者自己的檔案 + 平台的兩樣東西，都用正常的 API 寫。
  await writeFile(owner, "report.md", Buffer.from("# hi"), "text/markdown");
  await writeFile(owner, ".opencode/skills/charts/SKILL.md", Buffer.from("# charts"));
  await writeFile(owner, ".opencode/memories/note.md", Buffer.from("remember"));
  await updateManifest(owner, (m) => {
    m.entries["report.md"] = { size: 4, mtimeMs: 0 };
  });

  const seen = await whatTheSandboxSees(uid);
  assert.deepEqual(seen, ["report.md"], `沙盒只該看到使用者的檔案，實際看到：${JSON.stringify(seen)}`);
  assert.ok(!seen.some((k) => k.startsWith(".opencode")), ".opencode 不該出現在工作區");
  assert.ok(!seen.includes(".manifest.json"), ".manifest.json 不該出現在工作區");

  // 而且真的搬到了 `.platform` 兄弟路徑，不是被丟掉。
  assert.equal(manifestKey(owner), "users/u-hidden/.platform/manifest.json");
  assert.equal(
    fileKey(owner, ".opencode/skills/charts/SKILL.md"),
    "users/u-hidden/.platform/agent/skills/charts/SKILL.md",
  );
  const back = await readFile(owner, ".opencode/skills/charts/SKILL.md");
  assert.equal(back.toString(), "# charts");
});

test("使用者檔案沒有被搬走 —— 只有平台路徑會改寫", () => {
  const owner = "user:u-x";
  assert.equal(fileKey(owner, "a/b.csv"), "users/u-x/workspace/a/b.csv");
  // `.unieai/` 是**別人的**命名空間（環境擷取的 env.json、工作流產物、
  // agent-core 的 memory 投影），不是平台代理狀態 —— 它照樣是使用者檔案。
  assert.equal(fileKey(owner, ".unieai/env.json"), "users/u-x/workspace/.unieai/env.json");
  assert.equal(platformRelOf("a/b.csv"), null);
  assert.equal(platformRelOf(".opencodex/thing"), null, "只有正好是 .opencode 這一段才算");
  assert.equal(platformRelOf(".unieai/agentx/thing"), null, "只有正好是 .unieai/agent 這一段才算");
  // `.unieai/` 底下的其他戶（環境擷取、工作流產物）**不是**平台代理狀態：
  // 它們是沙盒直接寫進 /workspace 的一般檔案，映射過去就會找不到。
  assert.equal(platformRelOf(".unieai/env.json"), null, ".unieai/env.json 是使用者檔案");
  assert.equal(platformRelOf(".unieai/wf-runs/1"), null, "工作流產物是使用者檔案");
  // 兩個拼法都認：`.opencode` 存在於我們改不到的地方（使用者打過的路徑、
  // 產品內 git 的歷史提交、存下來的技能紀錄）。只認新的那一天，那些東西不會
  // 報錯 —— 它們會被當成一般使用者檔案寫到另一個前綴去，技能庫看起來就空了。
  assert.equal(platformRelOf(".opencode/skills/x"), "agent/skills/x");
  assert.equal(platformRelOf(".unieai/agent/skills/x"), "agent/skills/x");
  assert.equal(platformRelOf(".unieai/agent"), "agent");
});

test("group / org 也各自搬到自己的 .platform，不會跨租戶", () => {
  assert.equal(manifestKey("group:g1"), "groups/g1/.platform/manifest.json");
  assert.equal(fileKey("org:o1", ".opencode/skills/s/SKILL.md"), "orgs/o1/.platform/agent/skills/s/SKILL.md");
  assert.equal(legacyManifestKey("group:g1"), "groups/g1/workspace/.manifest.json");
});

test("沙盒 image 不會再把 /workspace/.opencode 造回來", async () => {
  // entrypoint.sh 的 `mkdir -p /workspace/.opencode` + 唯讀 sub-mount 一旦還在，
  // 就算 S3 那邊搬乾淨了，模型還是會看到一個空的 .opencode/（正是 roy 回報的畫面）。
  const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
  const entrypoint = await fs.readFile(path.join(repoRoot, "docker/cm-agent-sandbox/entrypoint.sh"), "utf8");
  assert.ok(
    !/mkdir\s+-p\s+"?\$MOUNT_POINT\/\.opencode/.test(entrypoint),
    "entrypoint.sh 還在 mkdir /workspace/.opencode",
  );
  assert.ok(
    !/filer\.path=\$\{REMOTE_PATH\}\/\.opencode/.test(entrypoint),
    "entrypoint.sh 還在對 .opencode 疊唯讀 sub-mount",
  );

  // 舊 image 還在跑，所以 runtime 必須主動把開關關掉送進容器。
  const docker = await fs.readFile(
    path.join(repoRoot, "runtime/apps/sandbox-runtime/src/cube/docker.mjs"),
    "utf8",
  );
  assert.match(
    docker,
    /SANDBOX_PROTECT_SYSTEM_DIRS:\s*process\.env\.SANDBOX_PROTECT_SYSTEM_DIRS\s*\?\?\s*"0"/,
    "docker.mjs 沒有把 SANDBOX_PROTECT_SYSTEM_DIRS=0 送進容器，舊 image 會繼續造出 .opencode",
  );
});

// ---------------------------------------------------------------------------
// 2. 舊路徑的資料還讀得到（沒跑遷移也不能掉東西）
// ---------------------------------------------------------------------------

test("舊路徑的技能檔案照樣讀得到、列得到", async () => {
  const uid = "u-legacy";
  const owner = `user:${uid}`;
  // 模擬「還沒跑遷移」的 prod：位元組只存在舊的、工作區內的路徑。
  await putObject({
    at: rawKey(legacyFileKey(owner, ".opencode/skills/old-skill/SKILL.md")),
    body: Buffer.from("# 舊技能"),
  });
  await putObject({
    at: rawKey(legacyManifestKey(owner)),
    body: Buffer.from(JSON.stringify({ version: 1, entries: { "keep/": { kind: "dir" } } })),
  });

  const buf = await readFile(owner, ".opencode/skills/old-skill/SKILL.md");
  assert.equal(buf.toString(), "# 舊技能", "舊路徑的技能讀不到 = 使用者的技能消失");

  const listed = await listWorkspaceManifest(owner);
  assert.ok(
    Object.keys(listed.entries).includes(".opencode/skills/old-skill/SKILL.md"),
    "面板的 skill/ 虛擬資料夾靠這個 entry 才看得到舊技能",
  );

  const m = await loadManifest(owner);
  assert.deepEqual(m.entries["keep/"], { kind: "dir" }, "舊 manifest 索引要讀得到");
  assert.equal(m.__etag, undefined, "從舊路徑讀來的 manifest 不可以帶 etag（新 key 還不存在）");
});

test("舊 manifest 讀進來之後，下一次寫入會落在新路徑（CAS 不會卡死）", async () => {
  const uid = "u-legacy-write";
  const owner = `user:${uid}`;
  await putObject({
    at: rawKey(legacyManifestKey(owner)),
    body: Buffer.from(JSON.stringify({ version: 1, entries: { "a.txt": { size: 1 } } })),
  });

  await updateManifest(owner, (m) => {
    m.entries["b.txt"] = { size: 2 };
  });

  const after = await loadManifest(owner);
  assert.ok(after.entries["a.txt"], "舊內容要被帶上來");
  assert.ok(after.entries["b.txt"], "新內容要寫進去");
  const written = await listObjectsByPrefix({ at: rawKey(`users/${uid}/.platform/`), maxItems: 10 });
  assert.deepEqual(
    written.map((o) => o.key),
    [`users/${uid}/.platform/manifest.json`],
    "寫入必須落在新路徑",
  );
});

test("刪一個技能會把新舊兩份都清掉（不然 dual-read 會把它復活）", async () => {
  const uid = "u-del";
  const owner = `user:${uid}`;
  const rel = ".opencode/skills/gone/SKILL.md";
  await putObject({ at: rawKey(legacyFileKey(owner, rel)), body: Buffer.from("legacy") });
  await writeFile(owner, rel, Buffer.from("new"));

  await deleteFile(owner, rel);

  await assert.rejects(() => readFile(owner, rel), "刪掉之後就不該再讀得到");
});

// ---------------------------------------------------------------------------
// 3. 遷移腳本：搬得動、可以重跑、dry-run 不寫東西
// ---------------------------------------------------------------------------

/** 佈置一個「完全沒搬過」的 owner。 */
async function seedLegacyOwner(uid, { files = 2 } = {}) {
  const owner = `user:${uid}`;
  await putObject({
    at: rawKey(legacyManifestKey(owner)),
    body: Buffer.from(JSON.stringify({ version: 1, entries: {} })),
  });
  for (let i = 0; i < files; i += 1) {
    await putObject({
      at: rawKey(legacyFileKey(owner, `.opencode/skills/s${i}/SKILL.md`)),
      body: Buffer.from(`# skill ${i}`),
    });
  }
  // 使用者自己的檔案 —— 遷移絕對不可以碰它。
  await putObject({ at: rawKey(legacyFileKey(owner, "mine.csv")), body: Buffer.from("a,b\n") });
  return owner;
}

test("遷移：dry-run 不寫任何東西", async () => {
  const uid = "u-mig-dry";
  await seedLegacyOwner(uid);

  const totals = await runMigration(["--owner", `user:${uid}`]);
  assert.equal(totals.copied, 3, "dry-run 要算出 1 個 manifest + 2 個技能檔");

  const platform = await listObjectsByPrefix({ at: rawKey(`users/${uid}/.platform/`), maxItems: 100 });
  assert.equal(platform.length, 0, "dry-run 竟然真的寫了東西");
});

test("遷移：--apply 搬過去，而且可以重跑", async () => {
  const uid = "u-mig-apply";
  const owner = await seedLegacyOwner(uid);

  const first = await runMigration(["--owner", owner, "--apply"]);
  assert.equal(first.copied, 3);
  assert.equal(first.already, 0);

  // 搬過去了 —— 而且是完整的內容，不是空檔。
  const moved = await readFile(owner, ".opencode/skills/s1/SKILL.md");
  assert.equal(moved.toString(), "# skill 1");
  const platform = (await listObjectsByPrefix({ at: rawKey(`users/${uid}/.platform/`), maxItems: 100 }))
    .map((o) => o.key)
    .sort();
  assert.deepEqual(platform, [
    `users/${uid}/.platform/agent/skills/s0/SKILL.md`,
    `users/${uid}/.platform/agent/skills/s1/SKILL.md`,
    `users/${uid}/.platform/manifest.json`,
  ]);

  // 重跑：全部認出是已經搬過的，不再複製一次。
  const second = await runMigration(["--owner", owner, "--apply"]);
  assert.equal(second.copied, 0, "重跑不該再複製");
  assert.equal(second.already, 3, "重跑要認出三個都已經搬過");
  assert.equal(second.failed, 0);

  // 使用者的檔案原封不動。
  const mine = await readFile(owner, "mine.csv");
  assert.equal(mine.toString(), "a,b\n");
});

test("遷移：--delete-legacy 沒有 --apply 時一個都不刪", async () => {
  const uid = "u-mig-del-dry";
  const owner = await seedLegacyOwner(uid);
  await runMigration(["--owner", owner, "--apply"]);

  await runMigration(["--owner", owner, "--delete-legacy"]); // 沒有 --apply
  const legacyLeft = await listObjectsByPrefix({ at: rawKey(`users/${uid}/workspace/.opencode/`),
    maxItems: 100,
  });
  assert.equal(legacyLeft.length, 2, "dry-run 竟然刪了舊檔");
});

test("遷移：--delete-legacy --apply 只刪已經驗證搬好的，使用者檔案不動", async () => {
  const uid = "u-mig-del";
  const owner = await seedLegacyOwner(uid);
  await runMigration(["--owner", owner, "--apply"]);

  const totals = await runMigration(["--owner", owner, "--delete-legacy", "--apply"]);
  assert.equal(totals.deleted, 3);
  assert.equal(totals.skippedDelete, 0);

  const seen = await whatTheSandboxSees(uid);
  assert.deepEqual(seen, ["mine.csv"], "刪完之後沙盒裡只剩使用者自己的檔案");

  // 資料還在（只是換了地方）。
  const still = await readFile(owner, ".opencode/skills/s0/SKILL.md");
  assert.equal(still.toString(), "# skill 0");
});

test("遷移：複製失敗時絕不刪舊檔（唯一會掉資料的路徑要擋死）", async () => {
  const uid = "u-mig-guard";
  const owner = await seedLegacyOwner(uid, { files: 1 });

  // 讓「寫到新路徑」一定失敗：在目的 key 的位置先放一個目錄，local-fs 的
  // writeFile 就會 EISDIR。這模擬的是「搬過去失敗了」——如果腳本還是照刪，
  // 使用者的技能就人間蒸發。
  const bucketRoot = path.join(process.env.STORAGE_LOCAL_FS_ROOT, "test-bucket");
  await fs.mkdir(path.join(bucketRoot, `users/${uid}/.platform/agent/skills/s0/SKILL.md`), {
    recursive: true,
  });

  const totals = await runMigration(["--owner", owner, "--delete-legacy", "--apply"]);
  assert.ok(totals.failed >= 1, "複製失敗要被記成 failed");

  // 舊檔必須還在。
  const legacy = await listObjectsByPrefix({ at: rawKey(`users/${uid}/workspace/.opencode/skills/s0/`),
    maxItems: 10,
  });
  assert.equal(legacy.length, 1, "複製失敗卻把舊檔刪了 = 使用者的技能不見了");
});

test("遷移：掃描找得到所有 owner（不必逐一指定）", async () => {
  const uid = "u-mig-scan";
  const owner = await seedLegacyOwner(uid, { files: 1 });
  const totals = await runMigration([]); // 全掃、dry-run
  assert.ok(totals.copied > 0, "全掃應該看得到還沒搬的 owner");
  // dry-run，什麼都沒動
  const platform = await listObjectsByPrefix({ at: rawKey(`users/${uid}/.platform/`), maxItems: 10 });
  assert.equal(platform.length, 0);
  assert.ok(owner);
});
