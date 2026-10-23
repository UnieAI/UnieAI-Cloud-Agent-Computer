/**
 * workspace.test.mjs — the picked folder joins, the granted folder still bounds.
 *
 * `workspacePath` is the ONE rule two components have to agree on character for
 * character: sandbox-runtime builds the invoke frame with it, and the app hashes
 * the same value into the approval token the daemon verifies. A copy of this
 * rule that drifts by a trailing slash does not read as a bug — it reads as
 * "approval token refused: payload_mismatch" on the user's own computer.
 *
 * The last two tests run the result through the real `containPath`, on a real
 * temp tree, because the whole point is that the join does NOT widen the
 * boundary the daemon enforces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { workspacePath } from "./workspace.mjs";
import { containPath } from "./contain.mjs";

test("a workspace-relative path lands under the picked folder", () => {
  assert.equal(workspacePath("/home/ubuntu/evan", "README.md"), "/home/ubuntu/evan/README.md");
  assert.equal(workspacePath("/home/ubuntu/evan", "notes/todo.md"), "/home/ubuntu/evan/notes/todo.md");
  assert.equal(workspacePath("/home/ubuntu/evan", "./src/index.ts"), "/home/ubuntu/evan/src/index.ts");
});

test("the empty path, \".\" and \"/\" all mean the picked folder itself", () => {
  for (const p of ["", ".", "/", "./", undefined, null]) {
    assert.equal(workspacePath("/home/ubuntu/evan", p), "/home/ubuntu/evan", `for ${JSON.stringify(p)}`);
  }
});

test("the answer is stable no matter how the stored folder was spelled", () => {
  // `last_workspace` is whatever the folder picker wrote. Both sides of the
  // approval hash this string, so a trailing slash on one side and not the
  // other is a refused write on someone's laptop.
  const want = "/home/ubuntu/evan/README.md";
  for (const root of ["/home/ubuntu/evan", "/home/ubuntu/evan/", "/home/ubuntu//evan", "/home/ubuntu/./evan"]) {
    assert.equal(workspacePath(root, "README.md"), want, `for root ${root}`);
  }
});

test("a leading slash means \"relative to the workspace\", as it does on the ssh backend", () => {
  // cube/ssh.mjs `joinRoot` strips leading slashes rather than treating the
  // path as absolute. Same contract, same backend family — and it contains
  // more, not less.
  assert.equal(workspacePath("/home/ubuntu/evan", "/README.md"), "/home/ubuntu/evan/README.md");
  assert.equal(workspacePath("/home/ubuntu/evan", "/etc/passwd"), "/home/ubuntu/evan/etc/passwd");
});

test("climbing out of the picked folder answers null, so the caller can refuse it", () => {
  assert.equal(workspacePath("/home/ubuntu/evan", "../secrets.env"), null);
  assert.equal(workspacePath("/home/ubuntu/evan", "a/../../b"), null);
  assert.equal(workspacePath("/home/ubuntu/evan", ".."), null);
});

test("NEAR MISS: no folder chosen leaves the path exactly as it was", () => {
  // No workspace root = nothing to join to. Returning an absolute "/README.md"
  // here would be worse than doing nothing: the daemon resolves an absolute
  // path as given, so it would land outside the granted root and be refused.
  for (const root of ["", "/", null, undefined]) {
    assert.equal(workspacePath(root, "README.md"), "README.md", `for root ${JSON.stringify(root)}`);
    assert.equal(workspacePath(root, ""), "", `for root ${JSON.stringify(root)}`);
  }
});

test("NEAR MISS: picking the granted folder itself resolves to exactly the same file as before", () => {
  const base = mkdtempSync(path.join(tmpdir(), "ava-ws-"));
  const granted = path.join(base, "granted");
  mkdirSync(granted, { recursive: true });
  writeFileSync(path.join(granted, "README.md"), "x");

  const before = containPath(granted, "README.md");
  const after = containPath(granted, workspacePath(granted, "README.md"));
  assert.equal(before.ok, true);
  assert.equal(after.ok, true);
  assert.equal(after.resolved, before.resolved);
});

test("NEAR MISS: a picked folder outside the granted root is still refused by the device", () => {
  const base = mkdtempSync(path.join(tmpdir(), "ava-ws-"));
  const granted = path.join(base, "granted");
  const elsewhere = path.join(base, "elsewhere");
  mkdirSync(granted, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(path.join(elsewhere, "secret.txt"), "s3cr3t");

  // Nothing stops `last_workspace` naming a folder outside the grant (the
  // machines route does not check it). Joining happily produces that path —
  // and the daemon, which is the only party that knows the grant, refuses it.
  const joined = workspacePath(elsewhere, "secret.txt");
  assert.equal(joined, path.join(elsewhere, "secret.txt"));
  const verdict = containPath(granted, joined);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "outside_root");
});
