/**
 * listWorkspaceManifest — the FUSE/weed-mount source-of-truth listing. Files
 * live at logical S3 paths under the owner prefix; bash + uploads write them
 * directly and never touch `.manifest.json`, so the panel must list S3 objects.
 *
 * Forces local-fs storage (a tmpdir) so the test needs no S3/SeaweedFS.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lwm-test-"));
process.env.STORAGE_LOCAL_FS = "1";
process.env.STORAGE_LOCAL_FS_ROOT = path.join(tmpRoot, "s3");
process.env.STORAGE_LOCAL_FS_BUCKET = "test-bucket";

const { putObject, systemLocation } = await import("../../../../packages/storage-engine/src/index.mjs");
const { listWorkspaceManifest } = await import("./userStore.mjs");

/**
 * Fixtures are written at the LITERAL legacy key, deliberately not through
 * `tenantWorkspaceLocation`: if the fixture and the code under test derived the
 * key from the same function, the test would pass for any prefix they both
 * agreed on. `systemLocation` here means "this raw key, in the default bucket"
 * — which is where a non-isolated tenant's bytes are.
 */
const rawKey = (key) => systemLocation(key, "raw fixture at a literal legacy key");

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const OWNER = "user:u-list";
const PREFIX = "users/u-list/workspace";

test("lists real files (incl. CJK + surfaced .opencode), excludes manifest/blobs/node_modules", async () => {
  // Real user content — a large upload, a script, a CJK-named folder, a skill.
  await putObject({ at: rawKey(`${PREFIX}/IMG_8433.JPG`), body: Buffer.alloc(100_000) });
  await putObject({ at: rawKey(`${PREFIX}/accton.py`), body: Buffer.from("print(1)") });
  await putObject({ at: rawKey(`${PREFIX}/截圖/a.png`), body: Buffer.alloc(50) });
  await putObject({ at: rawKey(`${PREFIX}/.opencode/skills/x/SKILL.md`), body: Buffer.from("# skill") });
  // System / noise — must be excluded from the panel listing.
  await putObject({ at: rawKey(`${PREFIX}/.manifest.json`), body: Buffer.from("{}") });
  await putObject({ at: rawKey(`${PREFIX}/blobs/ab/deadbeef`), body: Buffer.alloc(10) });
  await putObject({ at: rawKey(`${PREFIX}/node_modules/lib/index.js`), body: Buffer.from("x") });

  const m = await listWorkspaceManifest(OWNER);
  const keys = Object.keys(m.entries);

  assert.ok(keys.includes("IMG_8433.JPG"), "upload present");
  assert.ok(keys.includes("accton.py"), "script present");
  assert.ok(keys.includes("截圖/a.png"), "CJK folder file present");
  assert.ok(keys.includes(".opencode/skills/x/SKILL.md"), "surfaced skill present");

  assert.ok(!keys.includes(".manifest.json"), "manifest index excluded");
  assert.ok(!keys.some((k) => k === "blobs" || k.startsWith("blobs/")), "blobs excluded");
  // node_modules 的**內容**不進清單；資料夾本身以「不列內容」的目錄出現
  // （2026-09-26 UAT B1，D13：整個資料夾安靜消失、沒有任何提示）。見 heavy-dirs-unlisted.test.mjs。
  assert.ok(!keys.some((k) => k.split("/").slice(0, -1).includes("node_modules")), "node_modules contents excluded");
  assert.deepEqual(m.entries["node_modules"], { kind: "dir", unlisted: true, mtimeMs: 0 }, "the folder itself is shown as unlisted");

  // Size is carried through from the S3 object.
  assert.equal(m.entries["IMG_8433.JPG"].size, 100_000);
});

/**
 * ── 排在重目錄後面的檔案不能消失 ────────────────────────────────────────────
 *
 * 這一條是 2026-09-16 那個線上缺陷的複現，而它是**用一個可否證的預測**找到的，
 * 不是讀程式碼讀出來的：同一個工作區、同一秒、同一個寫入呼叫 ——
 *
 *     寫 aaa-order-probe.md（字典序排在 ava-e2e/ 之前）→ 面板看得到
 *     寫 zzz-order-probe.md（字典序排在 ava-e2e/ 之後）→ 面板看不到
 *
 * 唯一的差別是檔名的位置。根因是**上限套在過濾之前**：扁平列舉先把 5000 個鍵
 * 拉回來（全部花在 `ava-e2e/**\/node_modules/**` 的兩萬個鍵裡），`LISTING_SKIP_DIRS`
 * 才在迴圈裡生效。使用者上傳的文件因此在面板與 agent 的 read/list 工具眼裡都
 * 不存在，而上傳回 200、位元組真的在 S3 上，模型於是請使用者「把內容貼上來」。
 *
 * 承重的性質不是「node_modules 被排除」（舊版也做到了），而是**排除發生在花掉
 * 預算之前**。所以斷言要對「字典序排在重目錄後面的那個檔案」下 —— 那正是舊版
 * 會漏掉、而讀程式碼看不出來的那一個。
 */
test("字典序排在一個巨大 node_modules 後面的檔案，仍然列得出來", async () => {
  const OWNER2 = "user:u-order";
  const P2 = "users/u-order/workspace";
  // 一個重目錄，名字排在使用者檔案的中間。鍵數要多到足以吃掉舊版的上限。
  for (let i = 0; i < 6000; i += 1) {
    await putObject({ at: rawKey(`${P2}/ava-e2e/p07/node_modules/pkg${String(i).padStart(5, "0")}/index.js`), body: "x" });
  }
  await putObject({ at: rawKey(`${P2}/aaa-order-probe.md`), body: "before" });
  await putObject({ at: rawKey(`${P2}/zzz-order-probe.md`), body: "after" });
  await putObject({ at: rawKey(`${P2}/留存率折線圖.png`), body: "cjk-after" });

  const m = await listWorkspaceManifest(OWNER2);
  const keys = Object.keys(m.entries);

  assert.ok(keys.includes("aaa-order-probe.md"), "排在前面的那個本來就看得到");
  // ↓ 舊版在這一行紅
  assert.ok(keys.includes("zzz-order-probe.md"),
    `排在 node_modules 後面的檔案消失了 —— 這就是線上那個缺陷。列到的根層檔案：${keys.filter((k) => !k.includes("/")).join(", ")}`);
  assert.ok(keys.includes("留存率折線圖.png"), "非 ASCII 檔名排得更後面，也不能消失");
  // node_modules 仍然不該出現 —— 修法是「不下去」，不是「多列一點」。
  //
  // 判準是**路徑段**，不是子字串。我第一版寫 `includes("node_modules")`，在
  // 線上驗證時對 `.next/server/chunks/ssr/node_modules_next_dist_*.js` 這種
  // 建置產物的**檔名**報了 18 個假警報 —— 排除規則從來就是按段判斷的，
  // 是我的斷言寫成了另一條規則。
  assert.equal(keys.filter((k) => k.split("/").slice(0, -1).includes("node_modules")).length, 0,
    "node_modules 這一段底下的內容不該進清單");
  // 資料夾本身留一個「不列內容」的目錄，面板才說得出它在那裡（D13）。
  assert.equal(m.entries["ava-e2e/p07/node_modules"]?.unlisted, true);
});

test("走不完的時候要說出來，不要安靜截斷", async () => {
  const OWNER3 = "user:u-trunc";
  const P3 = "users/u-trunc/workspace";
  // 一個**不在跳過清單裡**的目錄，塞到超過預算 —— 這是真的走不完的情況。
  for (let i = 0; i < 120; i += 1) {
    await putObject({ at: rawKey(`${P3}/data/f${String(i).padStart(4, "0")}.txt`), body: "y" });
  }
  const { walkForTests } = await import("./userStore.mjs");
  const walked = await walkForTests(OWNER3, { maxFiles: 25 });
  assert.equal(walked.truncated, true, "超過預算就要把 truncated 說出來");
  assert.ok(walked.objs.length <= 25, "留下來的檔案數不能超過預算");

  // 沒超過的時候**不能**誤報 —— 一個永遠說「我截斷了」的旗標等於沒有旗標。
  const full = await walkForTests(OWNER3, { maxFiles: 5000 });
  assert.equal(full.truncated, false, "走得完就不該說截斷");
});
