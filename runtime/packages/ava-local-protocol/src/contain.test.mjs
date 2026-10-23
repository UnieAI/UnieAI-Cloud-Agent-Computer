import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { containPath } from "./contain.mjs";

function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), "ava-contain-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, "src", "a.txt"), "a");
  writeFileSync(path.join(outside, "secret.txt"), "s");
  symlinkSync(outside, path.join(root, "escape"));
  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "src", "link.txt"));
  mkdirSync(`${root}-evil`, { recursive: true });
  return { root, outside };
}

test("paths inside the granted root resolve, relative or absolute", () => {
  const { root } = fixture();
  assert.equal(containPath(root, "src/a.txt").ok, true);
  assert.equal(containPath(root, path.join(root, "src", "a.txt")).ok, true);
  assert.equal(containPath(root, "./src/deep/../a.txt").resolved, realpathSync(path.join(root, "src", "a.txt")));
});

test("a not-yet-existing file is allowed when its deepest existing ancestor is inside", () => {
  const { root } = fixture();
  const r = containPath(root, "src/deep/new/file.txt");
  assert.equal(r.ok, true);
  assert.equal(r.resolved, path.join(realpathSync(root), "src", "deep", "new", "file.txt"));
});

test("dot-dot escapes are refused", () => {
  const { root } = fixture();
  const r = containPath(root, "../outside/secret.txt");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "outside_root");
});

test("symlinks that point outside are refused, for directories and files", () => {
  const { root } = fixture();
  assert.equal(containPath(root, "escape/secret.txt").ok, false);
  assert.equal(containPath(root, "src/link.txt").ok, false);
});

test("a sibling directory sharing the root's prefix is refused", () => {
  const { root } = fixture();
  assert.equal(containPath(root, `${root}-evil/x`).ok, false);
});

test("home-relative, NUL-bearing and empty paths are refused", () => {
  const { root } = fixture();
  assert.equal(containPath(root, "~/.ssh/authorized_keys").ok, false);
  assert.equal(containPath(root, "src/a" + String.fromCharCode(0) + ".txt").ok, false);
  assert.equal(containPath(root, "").ok, false);
});

// AGENT-484 (real Windows, 16.contain-string-level): Win32 strips trailing spaces and dots from a path segment, so a segment such
// as `.. ` or `.. .` is not the literal name the string says. Measured: nothing escaped (16.contain-no-escape: 35 cases, none), but
// containPath ACCEPTED these strings, and a path check that accepts a string the OS then reads differently is one platform quirk away
// from being a hole. Hardening: refuse any segment other than `.` / `..` that ends in a space or a dot. Only on Windows — on
// Linux/macOS a directory called ".. " is a legitimate name and refusing it would be a false refusal.
test("windows: a segment that ends in a space or a dot is not what it says — refused as bad_path", () => {
  const { root } = fixture();
  for (const requested of [
    ".. \\outside\\secret.txt",
    ".. .\\outside\\secret.txt",
    "src\\.. \\a.txt",
    "src/.. /a.txt",
    "src/.. ./a.txt",
    "src/deep ./a.txt",
    "src/deep /a.txt",
    "src/...",
    "src/a.txt ",
    "src/a.txt.",
    path.join(root, ".. ", "x"),
  ]) {
    const r = containPath(root, requested, { windows: true });
    assert.deepEqual([requested, r.ok, r.reason], [requested, false, "bad_path"]);
  }
});

test("windows: ordinary names — spaces and dots INSIDE a segment, dot-files, `.` and `..` — are untouched", () => {
  const { root } = fixture();
  for (const requested of ["src/a.txt", "src/my file.txt", "src/.hidden", "src/a.b.c", "src/deep/../a.txt", "./src/a.txt", "src/a b/c d.txt"]) {
    assert.equal(containPath(root, requested, { windows: true }).ok, true, requested);
  }
  // `..` is still judged by where it lands, not rejected as a name.
  assert.equal(containPath(root, "../outside/secret.txt", { windows: true }).reason, "outside_root");
});

test("not windows: the same segments are legal names and are judged only by where they resolve", () => {
  const { root } = fixture();
  const r = containPath(root, "src/.. /a.txt", { windows: false });
  assert.equal(r.ok, true, "a directory named '.. ' is legal on Linux/macOS and stays inside the root");
});

test("the default follows the platform this runs on", () => {
  const { root } = fixture();
  const onWindows = process.platform === "win32";
  assert.equal(containPath(root, "src/.. /a.txt").ok, !onWindows);
});

test("Windows grants are judged with Windows path rules even on a Linux server (2026-10-21: every Windows setup failed)", () => {
  const root = "C:\\Users\\Evan\\Downloads";
  const win = { realpath: (p) => p, windows: true, paths: path.win32 };
  for (const inside of [root, `${root}\\`, "C:/Users/Evan/Downloads", "c:\\users\\evan\\downloads", `${root}\\proj\\a.txt`, "proj\\a.txt"])
    assert.equal(containPath(root, inside, win).ok, true, inside);
  for (const outside of ["C:\\Users\\Evan\\Downloads-evil", `${root}\\..\\Desktop`, "D:\\Users\\Evan\\Downloads", "C:\\", "\\\\server\\share\\x"])
    assert.deepEqual(containPath(root, outside, win), { ok: false, reason: "outside_root" }, outside);
  assert.equal(containPath(root, `${root}\\.. \\x`, win).ok, false, "ambiguous Windows segments stay refused");
});

test("without the option, behaviour on this platform is unchanged", () => {
  const { root } = fixture();
  assert.equal(containPath(root, "src/a.txt").ok, true);
  assert.equal(containPath(root, "../outside").ok, false);
});
