/**
 * workspace/group-base-bound.test.mjs —— sandboxBase 這張表不能只寫不刪。
 *
 * `sandboxId → 這個沙盒同步到哪個 commit` 一列很小，所以它不會馬上出事 ——
 * 而那正是問題：一個永遠不縮小的 Map 是「用久了記憶體只漲不跌」唯一的來源形狀，
 * 而且不會有任何一行字說得出原因。
 *
 * 正解是回收（沙盒放掉就忘掉），上限只是後盾。兩個都驗。
 */
process.env.SANDBOX_GROUP_BASE_MAX = "3";

import test from "node:test";
import assert from "node:assert/strict";

const { getSandboxBase, setSandboxBase, forgetSandboxBase, _sandboxBaseSize } =
  await import("./groupGit.mjs");

test("沙盒放掉之後那一列就忘掉", () => {
  setSandboxBase("sb-a", "c0ffee");
  assert.equal(getSandboxBase("sb-a"), "c0ffee");

  assert.equal(forgetSandboxBase("sb-a"), true);

  assert.equal(getSandboxBase("sb-a"), "");
  assert.equal(forgetSandboxBase("sb-a"), false, "刪過的再刪是 no-op，不是錯誤");
});

test("上限是後盾：超過就淘汰最舊的，不會無限長大", () => {
  for (const id of ["sb-1", "sb-2", "sb-3", "sb-4", "sb-5"]) setSandboxBase(id, `c-${id}`);

  assert.equal(_sandboxBaseSize(), 3, "上限 3 就是 3");
  assert.equal(getSandboxBase("sb-1"), "", "最舊的被淘汰");
  assert.equal(getSandboxBase("sb-5"), "c-sb-5", "最新的留著");
});

test("重寫同一個沙盒會把它排到尾巴 —— 否則淘汰會挑到還活著的那個", () => {
  for (const id of ["sb-x", "sb-y", "sb-z"]) setSandboxBase(id, "c1");
  setSandboxBase("sb-x", "c2");           // sb-x 是最舊的，但它剛剛才被用到
  setSandboxBase("sb-new", "c1");         // 擠掉一個

  assert.equal(getSandboxBase("sb-x"), "c2", "剛用過的不該被當成最舊的丟掉");
  assert.equal(getSandboxBase("sb-y"), "", "真正最舊的才走");
});
