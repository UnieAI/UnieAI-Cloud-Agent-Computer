// A1.4 — opencode-port step snapshot (sandbox side).
//
// Two ops:
//   snapshotCreate(sandboxId)         → { hash }   git write-tree
//   snapshotRestore(sandboxId, hash)  → { ok }     git read-tree + checkout-index
//
// Storage convention (matches opencode's snapshot/index.ts:56-131):
//   GIT_DIR=/snapshots/.git GIT_WORK_TREE=/workspace
//
// The .git directory is intentionally OUTSIDE /workspace so the user's
// real project (if any) keeps its own .git untouched, and so a
// `rm -rf /workspace/*` revert via checkout-index never wipes our
// snapshot history. The directory is created lazily on first
// snapshotCreate call.
//
// Sandbox image requirement: `git` must be on PATH. The cm-agent
// Dockerfile ships it; stub mode uses the host git.

import { getBackend } from "../cube/index.mjs";
import { SandboxError } from "../shared/error.mjs";
import { log } from "../shared/log.mjs";

const SNAPSHOT_GIT_DIR = "/snapshots/.git";
const SNAPSHOT_WORK_TREE = "/workspace";

// Single `export` block prepended to every snapshot command. Using
// `export` instead of per-command `KEY=VAL git ...` inline assignments
// means subsequent git commands in the same bash invocation inherit
// the env automatically — refactors that drop the explicit prefix on
// one command won't silently produce hashes from the WRONG GIT_DIR.
//
// Reviewers: keep this as a constant header that every snapshot
// command starts with. opencode's snapshot/index.ts uses the same
// pattern.
const GIT_ENV_HEADER =
  `export GIT_DIR=${SNAPSHOT_GIT_DIR}; ` +
  `export GIT_WORK_TREE=${SNAPSHOT_WORK_TREE}; `;

/**
 * Run a sandbox bash command, capture stdout, wait for exit. Resolves
 * `{ stdout, stderr, code }`. Rejects on backend error.
 *
 * Not exposed — purely an internal helper for the snapshot ops below.
 */
function runShell(sandboxId, command, { timeoutMs = 30_000 } = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const backend = getBackend(sandboxId);
      const handle = await backend.execProcess(sandboxId, {
        kind: "bash",
        command,
        timeoutMs
      });
      let stdout = "";
      let stderr = "";
      handle.on("stdout", (c) => { stdout += String(c); });
      handle.on("stderr", (c) => { stderr += String(c); });
      handle.on("exit", ({ code, error }) => {
        if (error) return reject(new Error(error));
        resolve({ stdout, stderr, code: code === null ? -1 : Number(code) });
      });
      handle.on("error", (err) => reject(err));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Ensure the snapshot git store is initialized. Idempotent: subsequent
 * calls are no-ops because `git init -q` short-circuits on an existing
 * directory.
 */
async function ensureSnapshotInit(sandboxId, shell = runShell) {
  // mkdir + init + initial config so write-tree always has a base.
  // The whole thing runs in one shell call so the round-trip cost is one
  // exec, not three. Env is set via `export` once at the top
  // (GIT_ENV_HEADER) so every subsequent git command inherits it —
  // robust against future copy-paste refactors that might drop one.
  const cmd =
    GIT_ENV_HEADER +
    [
      `mkdir -p ${SNAPSHOT_GIT_DIR} ${SNAPSHOT_WORK_TREE}`,
      `git init -q`,
      // Identity is required by some git versions for write-tree, even
      // though we never commit. Set hidden ones so user-visible git in
      // /workspace stays untouched.
      `git config user.name "agent-snapshot" >/dev/null`,
      `git config user.email "agent@snapshot.local" >/dev/null`
    ].join(" && ");
  const r = await shell(sandboxId, cmd);
  if (r.code !== 0) {
    throw new SandboxError(
      "snapshot_init_failed",
      `git init failed: ${r.stderr || `exit ${r.code}`}`,
      500
    );
  }
}

/** The commit step reports which of the three things happened, by echoing one. */
const COMMITTED_MARKER = "__snapshot_committed__";
const DEDUPE_MARKER = "__snapshot_dedupe__";

/**
 * Capture a tree snapshot. Returns the git tree hash (40-char hex).
 * Caller persists the hash as part of the tool's emit frame so a
 * future revert can pin to this state.
 */
export async function snapshotCreate(sandboxId, { shell = runShell } = {}) {
  await ensureSnapshotInit(sandboxId, shell);
  // `add -A` stages everything (creates / modifies / deletes).
  // `write-tree` then snapshots the index AS a tree object. No commit —
  // we don't need history (orphan trees are fine; periodic git gc
  // cleans up untreed objects every N days, see snapshot/gc.mjs).
  const cmd = GIT_ENV_HEADER + "git add -A && git write-tree";
  const r = await shell(sandboxId, cmd);
  if (r.code !== 0) {
    throw new SandboxError(
      "snapshot_create_failed",
      `git write-tree failed: ${r.stderr || `exit ${r.code}`}`,
      500
    );
  }
  const hash = String(r.stdout || "").trim();
  // Also record the tree as a COMMIT on refs/heads/snapshots so the history is
  // browsable/restorable with plain git (`git log snapshots`,
  // `git checkout <hash> -- <file>`) — both by the file-panel restore UI and by
  // the agent itself inside the sandbox (the /snapshots store is now durable).
  //
  // THIS BLOCK *IS* THE 版本歷史 LIST. The engine only consumes the write-tree
  // hash above, so a failure here leaves a valid snapshot — which is why it was
  // written as `.catch(() => {}) … || true` and never failed the call. But what
  // the USER loses when it fails is the whole feature: the ref stops moving, so
  // the panel lists nothing new and says "尚無版本記錄", forever, in silence.
  // That is what happened on prod for the 17 snapshot stores still owned by
  // root at mode 0755 (2026-10-08 A2). So: still never throws, but it now
  // REPORTS — one structured log line here, plus `committed` in the response so
  // the app can tell the user the history is not accumulating.
  let committed = true;
  let commitError = null;
  if (/^[0-9a-f]{40}$/.test(hash)) {
    const commitCmd =
      GIT_ENV_HEADER +
      // parent = current tip (if any); message carries an ISO-ish stamp built
      // in-shell (the sandbox clock) so the UI can label turns without a schema.
      // Dedupe: the app triggers a snapshot at EVERY turn boundary, so skip the
      // commit when the tip already points at this exact tree — otherwise idle
      // turns pile up identical entries in the 版本歷史 list.
      // NB: `\${_p...}` / `\$_p` are escaped so JS leaves the shell expansion
      // intact; only `${hash}` is a JS interpolation.
      //
      // The two markers are how "nothing to do" is told apart from "it failed":
      // without them the dedupe branch and a swallowed error both exit 0. And
      // `2>/dev/null` is deliberately NOT on commit-tree/update-ref any more —
      // their stderr ("Permission denied") is the only thing that names the
      // cause. No trailing `|| true`, for the same reason.
      `_p=$(git rev-parse -q --verify refs/heads/snapshots 2>/dev/null); ` +
      `if [ -n "\$_p" ] && [ "$(git rev-parse -q --verify "\$_p^{tree}" 2>/dev/null)" = "${hash}" ]; then echo ${DEDUPE_MARKER}; else ` +
      `_c=$(git commit-tree ${hash} \${_p:+-p \$_p} -m "snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)") && ` +
      `git update-ref refs/heads/snapshots "$_c" && echo ${COMMITTED_MARKER}; fi`;
    // Never throws: a commit hiccup must not break the engine's per-step
    // capture (the tree hash above is already valid and restorable).
    const c = await shell(sandboxId, commitCmd).catch((err) => ({
      stdout: "",
      stderr: String(err?.message || err),
      code: -1
    }));
    const out = String(c?.stdout || "");
    const moved = out.includes(COMMITTED_MARKER) || out.includes(DEDUPE_MARKER);
    if (c?.code !== 0 || !moved) {
      committed = false;
      commitError =
        String(c?.stderr || "").trim() ||
        `refs/heads/snapshots not updated (exit ${c?.code})`;
      log("warn", "snapshot.history_commit_failed", {
        sandboxId,
        tree: hash,
        exitCode: c?.code ?? null,
        message: commitError.slice(0, 500)
      });
    }
  }
  // SHA-1 only for now (40 hex chars). Git is transitioning to SHA-256
  // (64 hex chars) but we'll widen this regex when we encounter a
  // sandbox image that ships git with `--object-format=sha256`.
  if (!/^[0-9a-f]{40}$/.test(hash)) {
    throw new SandboxError(
      "snapshot_create_failed",
      `git write-tree returned invalid hash: ${hash.slice(0, 64)}`,
      500
    );
  }
  // `committed` is additive: the engine reads only `hash`. The app reads
  // `committed` to decide whether to tell the user their version history has
  // stopped accumulating (lib/agent-next/workspace-snapshot.ts).
  return commitError ? { hash, committed, commit_error: commitError } : { hash, committed };
}

/**
 * Restore the working tree to the given snapshot hash. Strategy:
 *   1. `git read-tree HASH` updates the index in place.
 *   2. `git checkout-index -f -a` writes the index back to /workspace,
 *      overwriting any unstaged changes. Files present in /workspace
 *      that don't exist in the snapshot tree are NOT removed — we add a
 *      `git clean -fd /workspace` follow-up to handle that.
 *
 * Destructive: any uncommitted file in /workspace that's not in the
 * snapshot is removed. UI must confirm before invoking.
 */
export async function snapshotRestore(sandboxId, hash) {
  if (!/^[0-9a-f]{40}$/.test(String(hash || ""))) {
    throw new SandboxError(
      "bad_request",
      "snapshot restore requires a 40-char git tree hash",
      400
    );
  }
  // Note: we don't call ensureSnapshotInit — restore requires the .git
  // dir to already exist (otherwise the hash couldn't have been minted).
  // If it's missing, git itself errors out clearly.
  const cmd =
    GIT_ENV_HEADER +
    [
      `git read-tree ${hash}`,
      `git checkout-index -f -a`,
      `git clean -fd -- ${SNAPSHOT_WORK_TREE}`
    ].join(" && ");
  const r = await runShell(sandboxId, cmd, { timeoutMs: 60_000 });
  if (r.code !== 0) {
    throw new SandboxError(
      "snapshot_restore_failed",
      `git restore failed: ${r.stderr || `exit ${r.code}`}`,
      500
    );
  }
  return { ok: true, hash };
}

/**
 * Restore SPECIFIC file(s) from a snapshot into /workspace, WITHOUT resetting
 * the rest of the tree and WITHOUT touching the conversation — the "recover an
 * accidentally-deleted file" path (contrast snapshotRestore, which resets the
 * whole work tree and pairs with a session revert).
 *
 * `hash` is a snapshot tree- or commit-ish (the engine records tree hashes per
 * step; refs/heads/snapshots commits also work). `paths` are workspace-relative.
 * `git checkout <hash> -- <path>` writes each path's snapshot version back
 * (recreating a deleted file / reverting a modified one), leaving every other
 * file — and files not present in that snapshot — untouched.
 *
 * `removeMissing`：那張快照裡**沒有**這個路徑時，把工作區裡那一份刪掉 ——
 * 「還原回基準」對一個基準之後才新增的檔案，意思就是它不該存在。檢閱面板的
 * 逐檔還原要的是這個語意（2026-09-26 UAT B1，D2：沒有它，對話新增的檔一按
 * 還原就是 pathspec 不存在）。版本歷史「找回被刪的檔」不帶它，行為不變。
 */
export async function snapshotRestoreFile(sandboxId, hash, paths, { removeMissing = false } = {}) {
  if (!/^[0-9a-f]{40}$/.test(String(hash || ""))) {
    throw new SandboxError(
      "bad_request",
      "restore-file requires a 40-char git tree/commit hash",
      400
    );
  }
  const list = (Array.isArray(paths) ? paths : [paths]).filter(
    (p) => typeof p === "string" && p.trim()
  );
  if (list.length === 0) {
    throw new SandboxError("bad_request", "restore-file requires at least one path", 400);
  }
  // Everything is workspace-relative under /workspace (GIT_WORK_TREE). Reject
  // absolute paths and `..` traversal so a leaked path can't aim git outside it.
  for (const p of list) {
    if (p.startsWith("/") || p.split("/").includes("..")) {
      throw new SandboxError("bad_request", `illegal restore path: ${p}`, 400);
    }
  }
  // Single-quote each pathspec (escaping embedded quotes) so filenames with
  // spaces / CJK / shell metacharacters are passed literally.
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const quoted = list.map(q).join(" ");
  const cmd = removeMissing
    // 逐檔判斷：`cat-file -e <hash>:<path>` 說基準裡有 → checkout；沒有 → 刪掉。
    // `set -e` 讓任何一個 checkout 失敗都照實回非零，不會被下一個檔蓋掉。
    ? GIT_ENV_HEADER + "set -e; " + list
      .map((p) => `if git cat-file -e ${hash}:${q(p)} 2>/dev/null; then git checkout ${hash} -- ${q(p)}; else rm -f -- ${q(`${SNAPSHOT_WORK_TREE}/${p}`)}; fi`)
      .join("; ")
    : GIT_ENV_HEADER + `git checkout ${hash} -- ${quoted}`;
  const r = await runShell(sandboxId, cmd, { timeoutMs: 60_000 });
  if (r.code !== 0) {
    throw new SandboxError(
      "snapshot_restore_file_failed",
      `git checkout failed: ${r.stderr || `exit ${r.code}`}`,
      500
    );
  }
  return { ok: true, hash, restored: list };
}

/**
 * List recent snapshots from refs/heads/snapshots (newest first). Because
 * /snapshots is weed-mounted per WORKSPACE OWNER (users/<id>/.snapshots), this
 * ref accumulates the owner's snapshots ACROSS sessions — so the file panel can
 * browse the full history, not just the current session. Returns
 * `[{ commit, tree, time, subject }]`; the app uses `tree` for restore-file.
 * Empty array if the ref doesn't exist yet (no snapshot taken).
 */
export async function snapshotList(sandboxId, limit = 100, path = "") {
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  // Optional per-file filter: only versions in which <path> existed/changed.
  // Without it the panel listed EVERY workspace snapshot, so picking one taken
  // before the file was created made restore-file fail with "pathspec did not
  // match" (observed live on 版本歷史). --diff-filter=d drops the commit that
  // DELETED the file (its tree no longer has it → unrestorable from there);
  // --follow keeps history across renames. Path is shell-quoted below.
  const rel = String(path || "").replace(/^\/+/, "").replace(/^workspace\//, "");
  if (rel && (rel.startsWith("/") || rel.split("/").includes(".."))) {
    throw new SandboxError("bad_request", `illegal snapshot filter path: ${path}`, 400);
  }
  const quotedRel = rel ? `'${rel.replace(/'/g, "'\\''")}'` : "";
  const pathFilter = quotedRel ? ` --diff-filter=d --follow -- ${quotedRel}` : "";
  // %H commit, %T tree, %cI committer ISO date, %s subject. `-z`-free: subjects
  // are our own "snapshot <iso>" strings (no newlines), so line-splitting is safe.
  const cmd =
    GIT_ENV_HEADER +
    `git rev-parse -q --verify refs/heads/snapshots >/dev/null 2>&1 && ` +
    `git log refs/heads/snapshots -n ${n} --format='%H|%T|%cI|%s'${pathFilter} || true`;
  const r = await runShell(sandboxId, cmd);
  if (r.code !== 0) {
    throw new SandboxError(
      "snapshot_list_failed",
      `git log failed: ${r.stderr || `exit ${r.code}`}`,
      500
    );
  }
  const items = [];
  for (const line of String(r.stdout || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const [commit, tree, time, ...rest] = t.split("|");
    if (/^[0-9a-f]{40}$/.test(commit || "") && /^[0-9a-f]{40}$/.test(tree || "")) {
      items.push({ commit, tree, time: time || "", subject: rest.join("|") });
    }
  }
  return { snapshots: items };
}

/**
 * 一次 diff 用的臨時索引檔。
 *
 * 為什麼不用共用的那個 index：`snapshotCreate` 是 `git add -A && git write-tree`、
 * `snapshotRestore` 是 `git read-tree`，兩者都把 `/snapshots/.git/index` 當成自己的
 * 工作區。審閱面板是使用者隨時會按的東西 —— 它如果也去 `git add -A` 同一個 index，
 * 就可能在一次快照或還原的中間把索引換掉。`GIT_INDEX_FILE` 讓這次比較有自己的
 * 索引，用完就刪，兩邊互不相干（已實測：跑完之後共用 index 仍停在 base）。
 *
 * `$$` 是遠端 shell 自己的 pid，所以兩個併發的請求不會共用同一個檔名。
 */
const DIFF_INDEX = `${SNAPSHOT_GIT_DIR}/.uac2-diff-index.$$`;

/**
 * 一段前綴：確認 base 真的存在，指到臨時索引，然後把工作區當下的狀態整個 stage 起來。
 *
 * 三件事都是必要的：
 *
 * · **base 要先驗**。指向不存在的物件時 git 會直接 `fatal: bad object` ——
 *   而「這個 session 還沒有 baseline」是完全正常的狀態（第一個工具還沒跑），
 *   不該變成一個錯誤畫面。驗不過就印 nobase 記號並正常結束，讓上層回空清單。
 *
 * · **要 `git add -A`**，因為「現在」不是某個 commit 而是工作區當下。不 stage 的話
 *   `git diff --cached` 看到的是空的，而新建的檔案會完全不出現在結果裡 ——
 *   偏偏「agent 新增了哪些檔案」正是審閱最想看的東西。
 *
 * · **`core.quotePath=false`**，否則含中文或空白的檔名會被跳脫成
 *   `"dir/\346\252\224..."`，使用者在面板上看到的會是亂碼。
 *
 * 已知邊界：`git add -A` 會遵守 `.gitignore`，所以被專案忽略的檔案不會出現在
 * 審閱清單裡。這跟 `snapshotCreate` 的規則一致（base 和現在用同一把尺），
 * 所以結果是自洽的，只是它講的是「會被版控的那些檔案」。
 */
function diffPrelude(base, nobaseMark) {
  return (
    `export GIT_INDEX_FILE=${DIFF_INDEX}; rm -f "$GIT_INDEX_FILE"; ` +
    `git rev-parse -q --verify '${base}^{tree}' >/dev/null 2>&1 || ` +
    `{ printf '%s' '${nobaseMark}'; rm -f "$GIT_INDEX_FILE"; exit 0; }; ` +
    `git add -A >/dev/null 2>&1; `
  );
}

/** 40 hex 才放得進指令。base 是外面傳進來的，這是它進到 shell 之前唯一的一道。 */
function assertHash(hash, what) {
  if (!/^[0-9a-f]{40}$/.test(String(hash || ""))) {
    throw new SandboxError("bad_request", `${what} requires a 40-char git tree/commit hash`, 400);
  }
}

/** 工作區相對路徑；擋掉絕對路徑與 `..`，跟 snapshotRestoreFile 同一套規則。 */
function assertRelPath(path) {
  const rel = String(path || "").replace(/^\/+/, "").replace(/^workspace\//, "");
  if (!rel) throw new SandboxError("bad_request", "path is required", 400);
  if (rel.split("/").includes("..")) {
    throw new SandboxError("bad_request", `illegal diff path: ${path}`, 400);
  }
  return rel;
}

/**
 * 解析 `--numstat -z` 的輸出。格式（實測確認）：
 *
 *   一般   `<add>\t<del>\t<path>\0`
 *   二進位 `-\t-\t<path>\0`            → 行數用 null，不是 0：
 *                                          「不知道」和「沒有變」是兩件事
 *   改名   `<add>\t<del>\t\0<src>\0<dst>\0`   ← 第三欄是空的，後面接兩個路徑
 */
function parseNumstat(raw) {
  const parts = String(raw || "").split("\0");
  const out = new Map();
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const tab1 = rec.indexOf("\t");
    if (tab1 < 0) continue;
    const tab2 = rec.indexOf("\t", tab1 + 1);
    if (tab2 < 0) continue;
    const add = rec.slice(0, tab1);
    const del = rec.slice(tab1 + 1, tab2);
    let path = rec.slice(tab2 + 1);
    if (path === "") {
      // 改名：路徑在後面兩個欄位，記在新名字底下（使用者要點開的是新的那個）。
      const src = parts[++i];
      const dst = parts[++i];
      if (!dst) continue;
      out.set(dst, { additions: num(add), deletions: num(del), from: src || null });
      continue;
    }
    out.set(path, { additions: num(add), deletions: num(del), from: null });
  }
  return out;
}

function num(v) {
  return v === "-" ? null : Number(v) || 0;
}

/**
 * 解析 `--name-status -z`：`<status>\0<path>\0`，改名是 `R100\0<src>\0<dst>\0`。
 * 狀態只留第一個字母 —— R100 / R087 的相似度對面板沒有意義。
 */
function parseNameStatus(raw) {
  const parts = String(raw || "").split("\0").filter((x) => x !== "");
  const out = new Map();
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (!/^[A-Z]/.test(status)) continue;
    const letter = status[0];
    if (letter === "R" || letter === "C") {
      const src = parts[++i];
      const dst = parts[++i];
      if (dst) out.set(dst, { status: letter, from: src || null });
    } else {
      const path = parts[++i];
      if (path) out.set(path, { status: letter, from: null });
    }
  }
  return out;
}

/**
 * 這個 base 之後，工作區到現在改了哪些檔案。
 *
 * 兩個 git 呼叫塞在同一次 exec 裡，用一個**每次隨機產生**的分隔記號切開 ——
 * 兩次 round trip 在 SSH 模式下是實打實的兩次網路往返，而隨機記號是唯一不可能
 * 跟檔名撞到的分隔（固定字串如 `__SPLIT__` 會被一個剛好叫那個名字的檔案騙過去）。
 *
 * 回 `{ base, files: [{ path, status, additions, deletions, from }] }`。
 * base 還不存在時回空清單而不是錯誤 —— 那是「這個 session 還沒動過任何東西」。
 */
export async function snapshotDiff(sandboxId, base) {
  assertHash(base, "snapshot diff");
  const nonce = `--uac2-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}--`;
  const nobase = `${nonce}NOBASE`;
  const cmd =
    GIT_ENV_HEADER +
    diffPrelude(base, nobase) +
    `git -c core.quotePath=false diff --cached --numstat -z --find-renames ${base}; ` +
    `printf '%s' '${nonce}'; ` +
    `git -c core.quotePath=false diff --cached --name-status -z --find-renames ${base}; ` +
    `rm -f "$GIT_INDEX_FILE"`;
  const r = await runShell(sandboxId, cmd, { timeoutMs: 60_000 });
  if (r.code !== 0) {
    throw new SandboxError(
      "snapshot_diff_failed",
      `git diff failed: ${r.stderr || `exit ${r.code}`}`,
      500
    );
  }
  const stdout = String(r.stdout || "");
  if (stdout.startsWith(nobase)) return { base, files: [] };

  const cut = stdout.indexOf(nonce);
  const numstat = parseNumstat(cut < 0 ? stdout : stdout.slice(0, cut));
  const status = parseNameStatus(cut < 0 ? "" : stdout.slice(cut + nonce.length));

  const files = [];
  for (const [path, st] of status) {
    const n = numstat.get(path);
    files.push({
      path,
      status: st.status,
      // 二進位檔的 additions/deletions 是 null（git 給 `-`）。面板要顯示
      // 「二進位」而不是「+0 −0」，所以這個區別不能在這裡被壓平成 0。
      additions: n ? n.additions : null,
      deletions: n ? n.deletions : null,
      from: st.from ?? (n ? n.from : null),
    });
  }
  // numstat 有、name-status 沒有的（理論上不該發生）也補進去，寧可多列一個檔案
  // 也不要讓使用者以為某個改動沒發生。
  for (const [path, n] of numstat) {
    if (!status.has(path)) {
      files.push({ path, status: "M", additions: n.additions, deletions: n.deletions, from: n.from });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { base, files };
}

/**
 * 單一檔案從 base 到現在的 unified diff 文字。
 *
 * 二進位檔 git 只會說 `Binary files ... differ` —— 就照原樣回去，讓面板顯示
 * 那句話，而不是在這裡編一段假的 diff。
 */
export async function snapshotFileDiff(sandboxId, base, path) {
  assertHash(base, "snapshot file diff");
  const rel = assertRelPath(path);
  const quoted = `'${rel.replace(/'/g, "'\\''")}'`;
  const nonce = `--uac2-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}--`;
  const nobase = `${nonce}NOBASE`;
  const cmd =
    GIT_ENV_HEADER +
    diffPrelude(base, nobase) +
    `git -c core.quotePath=false diff --cached --name-status -z --find-renames ${base} -- ${quoted}; ` +
    `printf '%s' '${nonce}'; ` +
    `git -c core.quotePath=false diff --cached --find-renames ${base} -- ${quoted}; ` +
    `rm -f "$GIT_INDEX_FILE"`;
  const r = await runShell(sandboxId, cmd, { timeoutMs: 60_000 });
  if (r.code !== 0) {
    throw new SandboxError(
      "snapshot_diff_failed",
      `git diff failed: ${r.stderr || `exit ${r.code}`}`,
      500
    );
  }
  const stdout = String(r.stdout || "");
  if (stdout.startsWith(nobase)) return { path: rel, status: null, diff: "" };
  const cut = stdout.indexOf(nonce);
  const status = parseNameStatus(cut < 0 ? "" : stdout.slice(0, cut));
  return {
    path: rel,
    status: status.get(rel)?.status ?? null,
    diff: cut < 0 ? stdout : stdout.slice(cut + nonce.length),
  };
}

export const _internal = {
  SNAPSHOT_GIT_DIR,
  SNAPSHOT_WORK_TREE,
  runShell,
  parseNumstat,
  parseNameStatus,
  COMMITTED_MARKER,
  DEDUPE_MARKER
};
