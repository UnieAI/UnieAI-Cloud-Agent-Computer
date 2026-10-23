/**
 * permission-rules.test.mjs —— pattern 的語意，表格釘死。
 *
 * 這是整件事**最容易默默錯掉**的地方（owner 2026-10-08 點名）：一條規則多命中
 * 一點點，使用者會發現他的 agent 突然什麼都做不了；少命中一點點，他以為自己
 * 擋住了而其實沒有 —— 而後者不會有任何錯誤訊息。
 *
 * 所以表格裡**一半是「看起來會中、但不該中」的案例**：
 *   · `bash:rm *` 不該命中 `rmdir`（前綴像、分界不同）
 *   · `bash:rm *` 不該命中 `sudo rm -rf x`（glob 兩端錨定）
 *   · `*` 是 glob 不是正規式，所以 `bash:a.b` 不該命中 `axb`
 *   · 多打幾個空白不該繞過（正規化）
 *
 * Run: node --test runtime/packages/ava-local-protocol/src/permission-rules.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluatePermissionRules,
  normalizeRuleTool,
  parsePermissionRule,
  ruleMatches,
  ruleSpecificity,
  ruleTargetOf,
  usablePermissionRules,
} from "./permission-rules.mjs";

// ── 解析 ─────────────────────────────────────────────────────────────────────

test("parsePermissionRule：工具名、參數 glob、以及認不出來的那些", () => {
  const cases = [
    ["bash", { tool: "bash", arg: null }],
    ["bash:rm *", { tool: "bash", arg: "rm *" }],
    // 冒號後面空的 = 整把工具，不是「命中空字串」
    ["bash:", { tool: "bash", arg: null }],
    ["bash:   ", { tool: "bash", arg: null }],
    // 大小寫不分（cc-haha 寫 Bash）
    ["Bash:rm *", { tool: "bash", arg: "rm *" }],
    // MCP 前綴先剝掉
    ["mcp__ava_app__tables_query", { tool: "tables_query", arg: null }],
    // glob 自己也正規化空白
    ["bash:rm   -rf  *", { tool: "bash", arg: "rm -rf *" }],
    // 第二個冒號屬於參數（MCP 工具名裡有冒號的寫法不會被切兩次）
    ["bash:ssh host:/path", { tool: "bash", arg: "ssh host:/path" }],
    // 認不出來
    ["", null],
    ["   ", null],
    [":rm *", null],
    [null, null],
    [undefined, null],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(parsePermissionRule(input), expected, JSON.stringify(input));
  }
});

test("normalizeRuleTool 剝前綴、轉小寫、trim", () => {
  assert.equal(normalizeRuleTool("  mcp__ava_app__Slides_Set "), "slides_set");
  assert.equal(normalizeRuleTool("BASH"), "bash");
  assert.equal(normalizeRuleTool(""), "");
});

// ── 比對：會中的 ─────────────────────────────────────────────────────────────

const HITS = [
  ["bash", "bash", "anything at all", "只寫工具名 = 每一次呼叫"],
  ["bash", "bash", "", "只寫工具名，連目標都不看"],
  ["bash:rm *", "bash", "rm -rf build", "最典型的那一條"],
  ["bash:rm *", "bash", "rm   -rf   build", "多打的空白被正規化掉"],
  ["bash:rm *", "bash", "  rm -rf build  ", "前後空白被 trim"],
  ["bash:*", "bash", "echo hi", "單一個 * 命中任何參數"],
  ["bash:*", "bash", "", "單一個 * 也命中空目標（* 可以是零個字元）"],
  ["bash:*rm *", "bash", "sudo rm -rf x", "想包住前綴要自己寫 *"],
  ["Bash:RM *", "bash", "RM -rf x", "工具名不分大小寫（參數分）"],
  ["file_write:/etc/*", "file_write", "/etc/passwd", "設定頁文案裡的那個例子"],
  ["tables_query", "mcp__ava_app__tables_query", "", "模型看到的前綴名也要命中"],
  ["bash:git push*", "bash", "git push --force", "glob 接在字面後面"],
];

for (const [pattern, tool, target, why] of HITS) {
  test(`命中：${JSON.stringify(pattern)} ← ${tool}(${JSON.stringify(target)}) —— ${why}`, () => {
    assert.equal(ruleMatches(pattern, tool, target), true);
  });
}

// ── 比對：看起來會中、但不該中的 ──────────────────────────────────────────────

const MISSES = [
  ["bash:rm *", "bash", "rmdir -p x", "rm 是 rmdir 的前綴 —— 分界不同，不該中"],
  ["bash:rm *", "bash", "rm", "`rm *` 要求那個空白；只有 rm 不中"],
  ["bash:rm *", "bash", "sudo rm -rf x", "glob 兩端錨定，開頭不是 rm "],
  ["bash:rm *", "bash", "echo rm -rf x", "同上，開頭不對"],
  ["bash:rm *", "grep", "rm -rf x", "工具名不對，參數對也不中"],
  ["bash:a.b", "bash", "axb", "`.` 是字面，不是正規式的任意字元"],
  ["bash:a+", "bash", "aaa", "`+` 是字面，不是正規式的量詞"],
  ["bash:(x)", "bash", "x", "括號是字面，不是群組"],
  ["bash:rm|mv", "bash", "rm", "`|` 是字面，不是選擇"],
  ["grep", "grep_files", "x", "工具名要整個相等，不是前綴"],
  ["", "bash", "x", "空 pattern 什麼都不中（壞掉的規則不是一道牆）"],
  [":rm *", "bash", "rm -rf x", "沒有工具名的 pattern 什麼都不中"],
];

for (const [pattern, tool, target, why] of MISSES) {
  test(`不中：${JSON.stringify(pattern)} ← ${tool}(${JSON.stringify(target)}) —— ${why}`, () => {
    assert.equal(ruleMatches(pattern, tool, target), false);
  });
}

// ── specificity：哪一條贏 ────────────────────────────────────────────────────

test("帶參數 glob 的贏過只寫工具名的", () => {
  assert.ok(ruleSpecificity("bash:rm *") > ruleSpecificity("bash"));
});

test("兩個都帶 glob 時，字面字元多的贏（`*` 不算）", () => {
  assert.ok(ruleSpecificity("bash:rm -rf *") > ruleSpecificity("bash:rm *"));
  assert.ok(ruleSpecificity("bash:rm *") > ruleSpecificity("bash:*"));
});

test("認不出來的 pattern specificity 最低，不會贏過任何真的規則", () => {
  assert.ok(ruleSpecificity("") < ruleSpecificity("bash"));
});

test("具體的規則贏過一般的 —— 設定頁文案承諾的就是這一句", () => {
  const rules = [
    { pattern: "bash", behavior: "ask" },
    { pattern: "bash:ls *", behavior: "allow" },
  ];
  assert.deepEqual(evaluatePermissionRules(rules, "bash", "ls -la"), { behavior: "allow", pattern: "bash:ls *" });
  // 同一組規則，另一條指令落回那條一般的
  assert.deepEqual(evaluatePermissionRules(rules, "bash", "rm -rf x"), { behavior: "ask", pattern: "bash" });
});

test("完全同分時，嚴格的贏（deny > ask > allow）—— 同分不可以是一枚硬幣", () => {
  const both = [
    { pattern: "bash:rm *", behavior: "allow" },
    { pattern: "bash:rm *", behavior: "deny" },
  ];
  assert.equal(evaluatePermissionRules(both, "bash", "rm -rf x").behavior, "deny");
  // 順序反過來也一樣（不是「最後一條贏」）
  assert.equal(evaluatePermissionRules([...both].reverse(), "bash", "rm -rf x").behavior, "deny");

  const askVsAllow = [
    { pattern: "bash", behavior: "allow" },
    { pattern: "bash", behavior: "ask" },
  ];
  assert.equal(evaluatePermissionRules(askVsAllow, "bash", "x").behavior, "ask");
});

test("沒有命中 → null（照模式的預設走，一個字都不改）", () => {
  assert.equal(evaluatePermissionRules([{ pattern: "bash:rm *", behavior: "deny" }], "bash", "ls"), null);
  assert.equal(evaluatePermissionRules([], "bash", "rm -rf x"), null);
  assert.equal(evaluatePermissionRules(null, "bash", "rm -rf x"), null);
  assert.equal(evaluatePermissionRules(undefined, "bash", "rm -rf x"), null);
});

test("行為欄位認不得的列被忽略，不會變成一條命中一切的規則", () => {
  const rules = [
    { pattern: "bash", behavior: "DENY" },
    { pattern: "bash", behavior: "block" },
    { pattern: "bash", behavior: "" },
    { pattern: "bash", behavior: null },
  ];
  assert.equal(evaluatePermissionRules(rules, "bash", "rm -rf x"), null);
});

// ── 目標字串 ─────────────────────────────────────────────────────────────────

test("ruleTargetOf：bash 取指令，檔案類取路徑，取不到是空字串", () => {
  assert.equal(ruleTargetOf("bash", { cmd: "rm  -rf x" }), "rm -rf x");
  assert.equal(ruleTargetOf("write", { filePath: "/etc/passwd" }), "/etc/passwd");
  assert.equal(ruleTargetOf("write", { file_path: "/etc/passwd" }), "/etc/passwd");
  assert.equal(ruleTargetOf("read", { path: "a.txt" }), "a.txt");
  assert.equal(ruleTargetOf("fetch", { url: "https://x/y" }), "https://x/y");
  assert.equal(ruleTargetOf("noargs", {}), "");
  assert.equal(ruleTargetOf("noargs", null), "");
  assert.equal(ruleTargetOf("noargs", "not an object"), "");
  // 空白字串不算「有目標」—— 不然 `{cmd:"  "}` 會蓋掉後面真的欄位
  assert.equal(ruleTargetOf("write", { cmd: "   ", filePath: "/a" }), "/a");
});

test("取不到目標時，`<工具>:<glob>` 不會意外命中，`<工具>` 與 `<工具>:*` 會", () => {
  assert.equal(ruleMatches("write:/etc/*", "write", ruleTargetOf("write", {})), false);
  assert.equal(ruleMatches("write", "write", ruleTargetOf("write", {})), true);
  assert.equal(ruleMatches("write:*", "write", ruleTargetOf("write", {})), true);
});

// ── 從資料庫讀出來的列 ───────────────────────────────────────────────────────

test("usablePermissionRules 丟掉解析不出來與行為認不得的列", () => {
  const rows = [
    { pattern: " bash:rm * ", behavior: "deny", source: "userSettings" },
    { pattern: "", behavior: "deny" },
    { pattern: ":bad", behavior: "deny" },
    { pattern: "bash", behavior: "nope" },
    { pattern: "grep", behavior: "allow" },
  ];
  assert.deepEqual(usablePermissionRules(rows), [
    { pattern: "bash:rm *", behavior: "deny" },
    { pattern: "grep", behavior: "allow" },
  ]);
  assert.deepEqual(usablePermissionRules(null), []);
  assert.deepEqual(usablePermissionRules("x"), []);
});
