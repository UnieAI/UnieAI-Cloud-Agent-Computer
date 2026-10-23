/**
 * contain.mjs — is this path inside the folder the user granted?
 *
 * String prefix checks are not enough: `..` normalises away, but a symlink
 * inside the root can point anywhere, and `/root-evil` starts with `/root`.
 * So the answer is computed on the real path of the deepest ancestor that
 * exists, with the not-yet-existing tail appended — that is exactly the file
 * the operating system would create.
 */

import fs from "node:fs";
import path from "node:path";

const HOME_RELATIVE = /^~(?:[/\\]|$)/;

function realpathOrNull(p, realpath) {
  try {
    return realpath(p);
  } catch {
    return null;
  }
}

/** Real path of `abs` if it exists, else real path of its deepest existing ancestor plus the rest. */
function resolveExisting(abs, realpath, paths = path) {
  const missing = [];
  let cursor = abs;
  for (;;) {
    const real = realpathOrNull(cursor, realpath);
    if (real) return missing.length ? paths.join(real, ...missing) : real;
    const parent = paths.dirname(cursor);
    if (parent === cursor) return null;
    missing.unshift(paths.basename(cursor));
    cursor = parent;
  }
}

/**
 * Win32 strips trailing spaces and dots from a path segment, so `.. ` and `.. .` are not the names the string spells —
 * what the check approves and what the OS opens can differ (AGENT-484, real Windows: nothing escaped in 35 cases, but
 * the string-level check accepted these). Any segment other than `.` and `..` that ends in a space or a dot is refused.
 * Both separators, because a Windows path may arrive with either.
 */
function hasWindowsAmbiguousSegment(requested) {
  return requested.split(/[\\/]/).some((seg) => seg !== "." && seg !== ".." && /[ .]$/.test(seg));
}

function isInside(resolved, rootReal, paths = path) {
  const fold = paths === path.win32 || process.platform === "win32";
  const a = fold ? resolved.toLowerCase() : resolved;
  const b = fold ? rootReal.toLowerCase() : rootReal;
  return a === b || a.startsWith(b.endsWith(paths.sep) ? b : b + paths.sep);
}

/**
 * @param {string} root       the granted folder
 * @param {string} requested  relative (to root) or absolute path
 * @param {{ realpath?: (p: string) => string, windows?: boolean, paths?: typeof path }} [opts]  `windows` defaults to the platform; tests pass it explicitly.
 *   `paths` is the path flavour to judge with (default: this platform's). The cloud judges a Windows
 *   machine's folder on Linux, where `path` would read `C:\\x` as a relative name (2026-10-21: every Windows
 *   setup was refused as outside its own grant), so it passes `path.win32` there.
 * @returns {{ ok: true, resolved: string } | { ok: false, reason: "bad_path"|"home_relative"|"root_missing"|"outside_root" }}
 */
export function containPath(root, requested, { realpath = fs.realpathSync, windows = process.platform === "win32", paths = path } = {}) {
  if (typeof requested !== "string" || !requested || requested.includes("\0")) {
    return { ok: false, reason: "bad_path" };
  }
  if (windows && hasWindowsAmbiguousSegment(requested)) return { ok: false, reason: "bad_path" };
  if (HOME_RELATIVE.test(requested)) return { ok: false, reason: "home_relative" };
  const rootReal = realpathOrNull(root, realpath);
  if (!rootReal) return { ok: false, reason: "root_missing" };

  const abs = paths.resolve(rootReal, requested);
  const resolved = resolveExisting(abs, realpath, paths);
  if (!resolved || !isInside(resolved, rootReal, paths)) return { ok: false, reason: "outside_root" };
  return { ok: true, resolved };
}
