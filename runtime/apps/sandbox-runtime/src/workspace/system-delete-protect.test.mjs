import { test } from "node:test";
import assert from "node:assert/strict";
import { isSystemDeleteProtected } from "./userStore.mjs";

// Data-safety: the agent (or a stray panel action) must not be able to delete a
// SYSTEM container dir wholesale and take the user's skill/memory library + env
// with it. The container dirs are protected; a targeted single-leaf delete still
// works so the skill manager UI can remove one skill. Writes are NOT gated here.

test("protects the system container dirs from wholesale delete", () => {
  for (const p of [
    ".opencode", ".opencode/", "/.opencode",
    ".opencode/skills", ".opencode/memories",
    ".unieai", ".unieai/", ".unieai/env.json", ".unieai/restore.log",
  ]) {
    assert.equal(isSystemDeleteProtected(p), true, `expected ${JSON.stringify(p)} protected`);
  }
});

test("allows targeted leaf deletes (single skill / memory) + normal user files", () => {
  for (const p of [
    ".opencode/skills/my-skill",
    ".opencode/skills/my-skill/SKILL.md",
    ".opencode/skills/my-skill/scripts/run.py",
    ".opencode/memories/note.md",
    "客戶來料.xlsx",
    "AI/Chat 介面/截圖.png",
    "",
  ]) {
    assert.equal(isSystemDeleteProtected(p), false, `expected ${JSON.stringify(p)} allowed`);
  }
});
