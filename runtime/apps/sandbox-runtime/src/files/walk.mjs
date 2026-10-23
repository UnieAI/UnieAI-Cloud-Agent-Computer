/**
 * files/walk.mjs — Recursive workspace enumeration and baseline diff.
 *
 * Used by artifacts/persist.mjs to find changed files since allocate time.
 * Implementation walks via backend.listFiles depth-first (no special-casing
 * symlinks in Phase 1; trust the backend).
 */

import path from "node:path";

import { getBackend } from "../cube/index.mjs";

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", ".cache", ".npm", ".yarn"]);

/**
 * Recursively enumerate workspace files. When `includeEmptyDirs` is true,
 * also emit `{ path, isDir: true, mtimeMs }` for directories that have no
 * file descendants anywhere in their subtree — those are the only
 * directories that need explicit manifest entries to survive a sync /
 * hydrate cycle. Non-empty directories are implied by their file
 * contents and don't need recording.
 */
export async function walkWorkspace(sandboxId, root = "/", { includeEmptyDirs = false } = {}) {
  const backend = getBackend(sandboxId);
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await backend.listFiles(sandboxId, dir);
    } catch {
      return 0;
    }
    let descendantFileCount = 0;
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue;
        descendantFileCount += await walk(entry.path);
      } else if (entry.isFile) {
        out.push({ path: entry.path, size: entry.size, mtimeMs: entry.mtimeMs });
        descendantFileCount += 1;
      }
    }
    // Only emit the dir entry when (a) we were asked for empty dirs,
    // (b) the dir is NOT the root we started at (the root always
    // exists), and (c) the dir has no file descendants in its subtree
    // — i.e. it would be invisible to sync otherwise.
    if (includeEmptyDirs && descendantFileCount === 0 && dir !== root && entries.length === 0) {
      let mtimeMs = 0;
      try {
        const st = await backend.statFile(sandboxId, dir);
        mtimeMs = st?.mtimeMs || 0;
      } catch { /* best-effort */ }
      out.push({ path: dir, isDir: true, mtimeMs });
    }
    return descendantFileCount;
  }
  await walk(root);
  return out;
}

export function diffAgainstBaseline(current, baseline) {
  const baselineByPath = new Map((baseline || []).map((entry) => [entry.path, entry]));
  const changed = [];
  for (const entry of current) {
    const prior = baselineByPath.get(entry.path);
    if (!prior || prior.size !== entry.size || prior.mtimeMs !== entry.mtimeMs) {
      changed.push(entry);
    }
  }
  return changed;
}

export function safeArtifactKey(userId, sessionId, ulid, filename) {
  const safeName = String(filename || "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 180) || "artifact";
  const base = path.posix.basename(safeName);
  return `cm-agent-artifacts/${encodeURIComponent(userId || "anonymous")}/${encodeURIComponent(sessionId || "no-session")}/${ulid}/${base}`;
}
