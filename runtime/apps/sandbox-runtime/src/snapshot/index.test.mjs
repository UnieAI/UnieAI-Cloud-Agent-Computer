// A1.4 — sandbox snapshot module tests. Focus on the pure pieces +
// command-string shape (regression pin for the env-var scoping audit
// finding) since the actual git invocation needs a sandbox with git
// installed.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { snapshotCreate, snapshotRestore, _internal } from "./index.mjs";

test("internal constants: paths use opencode-port layout", () => {
  assert.equal(_internal.SNAPSHOT_GIT_DIR, "/snapshots/.git");
  assert.equal(_internal.SNAPSHOT_WORK_TREE, "/workspace");
});

test("runShell is exposed for tests (callable function)", () => {
  assert.equal(typeof _internal.runShell, "function");
});

test("snapshotRestore rejects invalid hash without touching sandbox", async () => {
  try {
    await snapshotRestore("any-sandbox", "not-a-real-hash");
    assert.fail("should have thrown");
  } catch (err) {
    assert.match(err?.message || "", /40-char/);
    assert.equal(err?.status, 400);
  }
});

test("snapshotRestore rejects empty hash", async () => {
  try {
    await snapshotRestore("any-sandbox", "");
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal(err?.status, 400);
  }
});

test("snapshotRestore rejects short hash (refuses to truncate)", async () => {
  try {
    await snapshotRestore("any-sandbox", "abc");
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal(err?.status, 400);
  }
});

// ── Source pins (regression for the audit finding about env-var scoping) ──

test("source pin — uses GIT_ENV_HEADER (export-once) pattern, not per-command prefix", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = await fs.readFile(path.join(here, "index.mjs"), "utf8");
  // The audit-prevention pattern: env exported ONCE at the top of each
  // shell invocation. If a future refactor reintroduces the per-command
  // `GIT_DIR=... GIT_WORK_TREE=... git ...` inline style, this pin
  // fails to remind the reviewer why we did it.
  assert.ok(/GIT_ENV_HEADER/.test(src), "must use GIT_ENV_HEADER constant");
  assert.ok(/export GIT_DIR=/.test(src), "must export GIT_DIR once at top");
  assert.ok(/export GIT_WORK_TREE=/.test(src), "must export GIT_WORK_TREE once at top");
  // No remnant of the old fragile pattern.
  assert.ok(
    !/GIT_ENV_PREFIX/.test(src),
    "remove obsolete GIT_ENV_PREFIX references"
  );
});

test("source pin — snapshotCreate uses 'git add -A && git write-tree' (no env inlined per command)", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = await fs.readFile(path.join(here, "index.mjs"), "utf8");
  // The actual command string must NOT have `GIT_DIR=... git write-tree`
  // (the fragile inline-assignment shape the audit flagged).
  assert.ok(
    !/GIT_DIR=.+ git write-tree/.test(src),
    "git write-tree must NOT have inline GIT_DIR= prefix"
  );
  assert.ok(
    /git add -A && git write-tree/.test(src),
    "snapshotCreate must run add then write-tree"
  );
});

test("source pin — snapshotRestore uses git clean scoped to /workspace", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = await fs.readFile(path.join(here, "index.mjs"), "utf8");
  assert.ok(
    /git clean -fd -- \/workspace|git clean -fd -- \$\{SNAPSHOT_WORK_TREE\}/.test(src),
    "git clean must be scoped to /workspace (never bare)"
  );
});

test("source pin — hash validation is strict (40 hex chars only)", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = await fs.readFile(path.join(here, "index.mjs"), "utf8");
  assert.ok(
    /\/\^\[0-9a-f\]\{40\}\$\//.test(src),
    "hash regex must be 40-char hex"
  );
});

// Note: actual git invocation tests would need a sandbox with git
// installed (a Linux CI runner with git pre-installed) — out of scope here.
