/**
 * workspace/groupGit.mjs — per-GROUP git repo as the canonical merge store for a
 * shared (專案) workspace. sandbox-runtime OWNS these repos (it's where the S3
 * sync — and thus the conflict — happens); copilot-v2 only READS them for the
 * history/blame UI. Personal asset history stays app-side (version-git.ts).
 *
 * Strategy A (optimistic + git 3-way merge): each member's sandbox hydrates from
 * a BASE commit; on sync, every changed file is merged base→current(HEAD)→
 * incoming via `git merge-file`. Non-overlapping edits auto-merge; same-region
 * edits keep `current` and the incoming is saved as a `.conflict` sibling.
 *
 * Best-effort: a git failure must NOT break the sync. No-op when git is missing.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm, access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { log } from "../shared/log.mjs";

const execFileAsync = promisify(execFile);

// SAME root the app's version-git.ts uses, so copilot-v2 can read group history.
const GIT_ROOT = resolve(process.env.AGENT_GIT_ROOT || join(process.cwd(), ".agent-git"));

function groupRepoDir(gid) {
  const safe = String(gid || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(GIT_ROOT, `group-${safe}`);
}

/** Reject paths that escape the repo (keep workspace-relative, posix). */
function safeRel(rel) {
  const p = String(rel || "").replace(/^\/+/, "");
  if (!p || p.includes("..") || isAbsolute(p)) return null;
  // sandbox-runtime internals are never versioned.
  if (p.startsWith(".unieai/") || p === ".unieai") return null;
  return p;
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function git(repo, args) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "UnieAI Agent",
    GIT_AUTHOR_EMAIL: "agent@unieai.local",
    GIT_COMMITTER_NAME: "UnieAI Agent",
    GIT_COMMITTER_EMAIL: "agent@unieai.local",
    GIT_TERMINAL_PROMPT: "0",
  };
  const { stdout } = await execFileAsync("git", args, { cwd: repo, maxBuffer: 32 * 1024 * 1024, env });
  return stdout;
}

const ensured = new Map(); // gid → repoDir (or null when git unavailable)
export async function ensureGroupRepo(gid) {
  if (ensured.has(gid)) return ensured.get(gid);
  const repo = groupRepoDir(gid);
  try {
    if (!(await fileExists(join(repo, ".git")))) {
      await mkdir(repo, { recursive: true });
      await git(repo, ["init", "--quiet"]);
      await git(repo, ["config", "user.name", "UnieAI Agent"]);
      await git(repo, ["config", "user.email", "agent@unieai.local"]);
      await git(repo, ["config", "commit.gpgsign", "false"]);
    }
    ensured.set(gid, repo);
    return repo;
  } catch {
    ensured.set(gid, null);
    return null; // git missing → conflict merge silently disabled
  }
}

// Per-sandbox BASE commit — the group-repo HEAD this sandbox was last caught up
// to. Conflict = another member advanced HEAD past this base since. Captured on
// first sync, updated after each successful reconcile. (Approximation: a sandbox
// that hydrated then never synced uses its first-sync HEAD as base — fine for v1.)
const sandboxBase = new Map();
/**
 * 這張表的上限。**這是一張只寫不刪的表**的補救：一列 40 byte 級的字串不會馬上
 * 出事，但一個永遠不會縮小的 Map 是「用久了記憶體只漲不跌」那一類問題唯一的
 * 來源形狀，而它不會有任何一行字說得出原因。上限是後盾，正解是下面的
 * forgetSandboxBase —— 沙盒被回收時就刪掉。
 */
const SANDBOX_BASE_MAX = Number(process.env.SANDBOX_GROUP_BASE_MAX || 5000);
export function getSandboxBase(sandboxId) {
  return sandboxBase.get(sandboxId) || "";
}
export function setSandboxBase(sandboxId, commit) {
  if (!sandboxId || !commit) return;
  // 重寫同一個 id 時先刪再寫，讓它排到插入序的尾巴 —— 否則下面的淘汰會挑到
  // 一個還活著、只是很早建立的沙盒。
  sandboxBase.delete(sandboxId);
  sandboxBase.set(sandboxId, commit);
  while (sandboxBase.size > SANDBOX_BASE_MAX) {
    const oldest = sandboxBase.keys().next().value;
    if (oldest === undefined) break;
    sandboxBase.delete(oldest);
    log("warn", "groupGit.base_evicted", { sandboxId: oldest, size: sandboxBase.size, max: SANDBOX_BASE_MAX });
  }
}
/**
 * 沙盒被回收時把它的 base 一起忘掉。pool/manager.mjs 的 releaseSandbox 呼叫。
 * @returns {boolean} 有沒有真的刪掉一列（測試用得到）。
 */
export function forgetSandboxBase(sandboxId) {
  return sandboxBase.delete(String(sandboxId || ""));
}
/** 測試/診斷用：現在記著幾列。 */
export function _sandboxBaseSize() {
  return sandboxBase.size;
}

/** Current HEAD commit sha, or "" if the repo has no commits yet. */
export async function groupHead(gid) {
  const repo = await ensureGroupRepo(gid);
  if (!repo) return "";
  try {
    return (await git(repo, ["rev-parse", "HEAD"])).trim();
  } catch {
    return ""; // unborn branch (no commits)
  }
}

/** Content of `rel` at commit `ref` (default HEAD), or null if absent there. */
export async function showAt(gid, ref, rel) {
  const p = safeRel(rel);
  if (!p) return null;
  const repo = await ensureGroupRepo(gid);
  if (!repo) return null;
  try {
    return await git(repo, ["show", `${ref || "HEAD"}:${p}`]);
  } catch {
    return null; // didn't exist at that ref
  }
}

/**
 * 3-way merge `incoming` into `current` against `base`. Returns
 * { content, conflict } — clean edits auto-merge; same-region → markers +
 * conflict:true. Pure (no repo writes); the caller decides what to persist.
 */
export async function merge3(base, current, incoming, labels = {}) {
  if (current === incoming) return { content: incoming, conflict: false };
  if (base === current) return { content: incoming, conflict: false };
  if (base === incoming) return { content: current, conflict: false };

  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "group-merge-"));
    const cur = join(dir, "cur");
    const baseF = join(dir, "base");
    const inc = join(dir, "inc");
    await Promise.all([
      writeFile(cur, current ?? "", "utf8"),
      writeFile(baseF, base ?? "", "utf8"),
      writeFile(inc, incoming ?? "", "utf8"),
    ]);
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["merge-file", "-p", "-L", labels.current || "current", "-L", "base", "-L", labels.incoming || "incoming", cur, baseF, inc],
        { maxBuffer: 32 * 1024 * 1024 },
      );
      return { content: stdout, conflict: false };
    } catch (e) {
      if (typeof e?.code === "number" && e.code > 0 && typeof e.stdout === "string") {
        return { content: e.stdout, conflict: true };
      }
      return { content: current, conflict: true }; // tooling error → don't lose data
    }
  } catch (err) {
    log("warn", "group_git.merge_failed", { gid: undefined, message: err?.message || String(err) });
    return { content: current, conflict: true };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Stage `files` ([{rel, content}] upserts and {rel, deleted:true}) into the
 * group repo working tree and commit. Returns the new commit sha (or "" on
 * no-op / failure). Best-effort.
 */
export async function commitGroupFiles(gid, files, message) {
  const repo = await ensureGroupRepo(gid);
  if (!repo || !Array.isArray(files) || files.length === 0) return "";
  try {
    for (const f of files) {
      const p = safeRel(f?.rel);
      if (!p) continue;
      const abs = join(repo, p);
      if (f.deleted) {
        await rm(abs, { force: true }).catch(() => {});
      } else {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, f.content ?? "", "utf8");
      }
    }
    await git(repo, ["add", "-A"]);
    const status = await git(repo, ["status", "--porcelain"]);
    if (!status.trim()) return "";
    await git(repo, ["commit", "--quiet", "-m", message || "workspace sync"]);
    return (await git(repo, ["rev-parse", "HEAD"])).trim();
  } catch (err) {
    log("warn", "group_git.commit_failed", { gid, message: err?.message || String(err) });
    return "";
  }
}
