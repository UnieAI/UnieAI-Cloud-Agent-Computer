#!/usr/bin/env node
/**
 * 把「平台自己的檔案」搬出使用者的工作區。
 *
 * 背景
 * ----
 * 沙盒的 /workspace 是 `<owner>/workspace/` 這個 S3 前綴的 weed-mount。平台有
 * 兩樣東西一直放在那底下，於是模型 `ls -la /workspace` 就會看到、拿去回報成
 * 使用者的檔案，甚至可能讀寫壞掉：
 *
 *   <owner>/workspace/.manifest.json      面板的檔案索引
 *   <owner>/workspace/.opencode/**        代理人的技能／記憶庫（已退役引擎的路徑慣例）
 *
 * 兩者現在都搬到 owner 底下沒有被掛載的 `.platform` 兄弟路徑（跟 `.snapshots`
 * 同一招）：
 *
 *   <owner>/.platform/manifest.json
 *   <owner>/.platform/agent/**            （`.opencode/x` → `agent/x`）
 *
 * 這支腳本負責把「已經存在 prod 的舊資料」複製到新路徑。程式碼那邊
 * （runtime/apps/sandbox-runtime/src/workspace/userStore.mjs）新舊路徑都讀得到，
 * 所以就算沒跑這支腳本也不會掉東西 —— 跑它是為了讓資料真的離開掛載範圍。
 *
 * 什麼情況下會掉資料
 * -----------------
 *   · 不加 --apply：完全不會。預設是 dry-run，只讀不寫。
 *   · 加 --apply（不加 --delete-legacy）：也不會。只做 copy，舊路徑原封不動；
 *     出錯最多是多了一份沒人讀的副本。可以重跑。
 *   · 加 --delete-legacy：這一步會刪掉舊路徑的物件，是唯一會掉資料的步驟。
 *     它有三道保險：(1) 必須同時給 --apply；(2) 每一個 key 都先驗證新路徑存在
 *     且「位元組數相同」才刪，對不上就跳過並記成 skipped；(3) 只刪這支腳本
 *     認得的兩種平台路徑，絕不碰使用者檔案。
 *     真正的風險是「複製之後、刪除之前，有人又寫了舊路徑」—— 所以請先讓新版
 *     程式碼上線（新寫入一律只寫新路徑）再跑 --delete-legacy，中間隔幾天。
 *
 * 用法
 * ----
 *   # 1) 看看會搬什麼（不寫任何東西）
 *   node scripts/migrate-platform-prefix.mjs
 *
 *   # 2) 真的複製到新路徑（可重複執行，第二次會全部 already-migrated）
 *   node scripts/migrate-platform-prefix.mjs --apply
 *
 *   # 3) 觀察幾天、確認面板／技能都正常之後，才清掉舊路徑
 *   node scripts/migrate-platform-prefix.mjs --delete-legacy            # dry-run
 *   node scripts/migrate-platform-prefix.mjs --delete-legacy --apply    # 真的刪
 *
 *   # 只處理一個 owner（除錯用）
 *   node scripts/migrate-platform-prefix.mjs --owner user:<uuid> --apply
 *   node scripts/migrate-platform-prefix.mjs --owner group:<gid>
 *
 * S3 設定沿用 sandbox-runtime 的環境變數：S3_ENDPOINT / S3_BUCKET /
 * S3_ACCESS_KEY / S3_SECRET_KEY。（Admin Panel 存在 DB 的那份設定這支腳本讀不到 ——
 * 它沒有 DB 連線 —— 所以請確認 env 有值，開頭的 backend 檢查會告訴你。）
 *
 * 範圍：只做「共用 bucket」這一份
 * ----------------------------
 * storage-engine 現在要求 LOCATION（bucket ＋ key 一起），不收裸 key。這支腳本
 * 全程用 `systemLocation` —— 也就是明著宣告「預設 bucket 裡的這個字面 key」。
 * 那是對的，因為它整支的定址方式就是 `users/<id>/…`、`groups/<id>/…` 這種共用
 * bucket 的舊版版面。
 *
 * ⚠️ 已經被 SANDBOX_ISOLATED_TENANTS 搬到自己 bucket 的租戶，這支腳本掃不到，
 * 也不該由它處理：那些租戶的根目錄裡沒有 `users/` 這一層。順序是**先跑這支**
 * （把平台檔案搬出掛載範圍），**再**用 `scripts/ops/migrate-tenant-store.mjs`
 * 把整棵子樹複製到租戶自己的 bucket；反過來的話搬過去的是舊版面。
 */

import { config as loadEnv } from "dotenv";

import {
  describeStorageBackend,
  getObject,
  putObject,
  deleteObject,
  listObjectsByPrefix,
  listCommonPrefixes,
  systemLocation,
} from "../runtime/packages/storage-engine/src/index.mjs";

loadEnv({ path: ".env" });
loadEnv({ path: ".env.local", override: false });

// 這幾個常數必須跟 userStore.mjs 對齊。測試 (migrate-platform-prefix.test.mjs)
// 會實際跑這支腳本再用 userStore 讀回來，所以走位了測試就會紅。
const OWNER_ROOTS = ["users/", "groups/", "orgs/"];
const PLATFORM_DIR = ".platform";
const LEGACY_AGENT_DIR = ".opencode";
const PLATFORM_AGENT_DIR = "agent";
const LEGACY_MANIFEST = ".manifest.json";
const PLATFORM_MANIFEST = "manifest.json";

/**
 * 一個共用 bucket 裡的字面 key。見檔頭「範圍」那一段：這支腳本只處理共用
 * bucket 的舊版版面，所以「預設 bucket」是它明著做的宣告，不是省略了參數。
 */
const sharedAt = (key) => systemLocation(key, "shared-bucket platform-prefix migration");

function parseArgs(argv) {
  const out = { apply: false, deleteLegacy: false, owner: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--delete-legacy") out.deleteLegacy = true;
    else if (a === "--owner") out.owner = argv[++i];
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else { console.error(`unknown arg: ${a}`); printHelp(); process.exit(2); }
  }
  return out;
}

function printHelp() {
  console.log(`
Usage: node scripts/migrate-platform-prefix.mjs [--owner <user:id|group:id|org:id>] [--apply] [--delete-legacy]

  (no flags)         dry-run：只列出會做什麼，不寫不刪
  --apply            真的執行（複製；配 --delete-legacy 時才會刪）
  --delete-legacy    第二階段：清掉舊路徑。只在新路徑已存在且大小相符時才刪。
  --owner <o>        只處理這一個 owner
`);
}

/** owner 字串 → S3 根前綴（`workspace/` 的父層）。對齊 userStore 的 userPrefix。 */
function rootOf(owner) {
  const s = String(owner || "");
  const colon = s.indexOf(":");
  if (colon !== -1) {
    const kind = s.slice(0, colon);
    const id = s.slice(colon + 1);
    if (kind === "group" && id) return `groups/${id}`;
    if (kind === "org" && id) return `orgs/${id}`;
    if (kind === "user" && id) return `users/${id}`;
  }
  return `users/${s}`;
}

/** 掃出 bucket 裡所有 owner 的根前綴（不含結尾斜線）。 */
async function discoverOwnerRoots() {
  const roots = [];
  for (const base of OWNER_ROOTS) {
    const prefixes = await listCommonPrefixes({ at: sharedAt(base), delimiter: "/" });
    for (const p of prefixes) roots.push(p.replace(/\/+$/, ""));
  }
  return roots;
}

/**
 * 一個 owner 要搬的 (from → to) 清單。
 *
 * 刻意「先列清單、再執行」：dry-run 印的東西和 --apply 做的事來自同一個函式，
 * 所以 dry-run 看到的就是真的會發生的事，不會兩邊各寫一次而走鐘。
 */
async function planFor(root) {
  const wsPrefix = `${root}/workspace/`;
  const platPrefix = `${root}/${PLATFORM_DIR}/`;
  const moves = [];

  // 1) 面板索引
  moves.push({
    kind: "manifest",
    from: `${wsPrefix}${LEGACY_MANIFEST}`,
    to: `${platPrefix}${PLATFORM_MANIFEST}`,
  });

  // 2) 代理人的技能／記憶庫（整棵 .opencode/）
  const agentLegacyPrefix = `${wsPrefix}${LEGACY_AGENT_DIR}/`;
  const objs = await listObjectsByPrefix({ at: sharedAt(agentLegacyPrefix), maxItems: 100_000 });
  for (const o of objs) {
    const key = String(o?.key || "");
    if (!key.startsWith(agentLegacyPrefix)) continue;
    const rest = key.slice(agentLegacyPrefix.length);
    if (!rest) continue;
    moves.push({
      kind: "agent",
      from: key,
      to: `${platPrefix}${PLATFORM_AGENT_DIR}/${rest}`,
      sizeBytes: Number(o?.sizeBytes || 0),
    });
  }
  return moves;
}

function isNotFound(err) {
  const msg = String(err?.message || err);
  const status = err?.$metadata?.httpStatusCode;
  const name = err?.name || err?.Code;
  return name === "NoSuchKey" || status === 404 || /not found|NoSuchKey|404|does not exist/i.test(msg);
}

async function readOrNull(key) {
  try {
    const obj = await getObject({ at: sharedAt(key) });
    const body = obj?.Body || obj?.body || obj;
    if (Buffer.isBuffer(body)) return body;
    if (body && typeof body.transformToByteArray === "function") {
      return Buffer.from(await body.transformToByteArray());
    }
    if (body && typeof body[Symbol.asyncIterator] === "function") {
      const chunks = [];
      for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      return Buffer.concat(chunks);
    }
    throw new Error(`unsupported S3 body type for ${key}`);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * 回傳 totals，讓測試可以直接斷言「第二次跑是 already-migrated 而不是又複製一次」。
 * 測試在 runtime/apps/sandbox-runtime/src/workspace/platform-prefix.test.mjs。
 */
async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const backend = await describeStorageBackend();
  console.log(`storage backend: ${backend}`);
  if (backend === "unavailable") {
    console.error("S3 未設定（S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY）。中止。");
    process.exit(1);
  }
  if (!args.apply) {
    console.log("DRY RUN — 什麼都不會寫。要真的執行請加 --apply\n");
  } else if (args.deleteLegacy) {
    console.log("APPLY + DELETE-LEGACY — 會刪除舊路徑的物件\n");
  } else {
    console.log("APPLY — 只複製，舊路徑保留不動\n");
  }

  const roots = args.owner ? [rootOf(args.owner)] : await discoverOwnerRoots();
  console.log(`owners: ${roots.length}\n`);

  const totals = { copied: 0, already: 0, missing: 0, deleted: 0, skippedDelete: 0, failed: 0 };

  for (const root of roots) {
    const moves = await planFor(root);
    const lines = [];
    for (const mv of moves) {
      try {
        const src = await readOrNull(mv.from);
        if (src == null) {
          // 舊路徑沒東西 —— 沒搬過的新使用者，或已經跑過 --delete-legacy。
          totals.missing += 1;
          continue;
        }
        const dst = await readOrNull(mv.to);
        const same = dst != null && dst.length === src.length;

        if (!same) {
          if (args.apply) {
            await putObject({ at: sharedAt(mv.to), body: src, contentType: contentTypeFor(mv.to) });
          }
          totals.copied += 1;
          lines.push(`  copy  ${mv.from}\n     -> ${mv.to}  (${src.length}B)`);
        } else {
          totals.already += 1;
        }

        if (args.deleteLegacy) {
          // 只有在新路徑「確定存在且大小相符」時才刪舊的。dry-run 時 same 可能
          // 還是 false（因為上面的 copy 沒真的寫），此時一律不刪、記成 skipped。
          const verified = args.apply ? (await readOrNull(mv.to)) : dst;
          if (verified != null && verified.length === src.length) {
            if (args.apply) await deleteObject({ at: sharedAt(mv.from) });
            totals.deleted += 1;
            lines.push(`  del   ${mv.from}`);
          } else {
            totals.skippedDelete += 1;
            lines.push(`  SKIP-DEL ${mv.from}  (新路徑尚未就緒，保留舊檔)`);
          }
        }
      } catch (err) {
        totals.failed += 1;
        lines.push(`  FAIL  ${mv.from}: ${err?.message || err}`);
      }
    }
    if (lines.length > 0) {
      console.log(root);
      for (const l of lines) console.log(l);
      console.log("");
    }
  }

  console.log("---");
  console.log(`copied            ${totals.copied}`);
  console.log(`already migrated  ${totals.already}`);
  console.log(`nothing to move   ${totals.missing}`);
  if (args.deleteLegacy) {
    console.log(`legacy deleted    ${totals.deleted}`);
    console.log(`delete skipped    ${totals.skippedDelete}`);
  }
  console.log(`failed            ${totals.failed}`);
  if (!args.apply) console.log("\n(DRY RUN — 以上都沒有真的執行)");
  // 退出碼由下面的 CLI wrapper 決定 —— main() 被 import 呼叫時（測試）不該
  // 偷偷把整個 process 標成失敗。
  return totals;
}

function contentTypeFor(key) {
  if (key.endsWith(".json")) return "application/json; charset=utf-8";
  if (key.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "application/octet-stream";
}

// 被 import 時（測試）不自動執行。
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("migrate-platform-prefix.mjs");
if (invokedDirectly) {
  main()
    .then((totals) => {
      if (totals?.failed > 0) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { main, planFor, rootOf, discoverOwnerRoots };
