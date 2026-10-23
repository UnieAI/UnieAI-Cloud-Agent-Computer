/**
 * terminal/grace-matches-engine.test.mjs —— 兩層的寬限期必須講同一句話。
 *
 * 一個終端機在使用者眼裡是一個東西，在程式裡是**兩層**各記一列：
 *
 *   ava-engine/src/terminal-operator.mjs   政策層（scrollback、每張表幾個、誰在看）
 *   sandbox-runtime/src/terminal/registry.mjs  傳輸層（PTY handle、開場重播環）
 *
 * 兩層各自都有「結束的那一列留多久」。**兩邊不一致的後果不是慢一點，是一個
 * 只在某些時候出現的 bug**：runtime 先回收的話，引擎那一列還列得出來，但
 * attach 上去是 404 —— 使用者看到「有時候重連得回來、有時候不行」，而兩層各自的
 * 測試都是綠的（這正是今天要防的那種「一半上線」）。
 *
 * 所以釘住兩件事：同一個環境變數名（一起調），同一個預設值（沒調的時候一致）。
 * 這是結構性測試 —— 它讀的是原始碼文字，因為要抓的正是「有人只改了一邊」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_REGISTRY = path.join(here, "registry.mjs");
// 跨 repo 契約：引擎在 copilot-v2。CAC 單獨跑時設 COPILOT_V2_ROOT 指向那份 checkout，
// 沒有就明說 skip —— 不讀到東西就算過，等於沒有這個測試。
const ENGINE_OPERATOR = process.env.COPILOT_V2_ROOT
  ? path.join(process.env.COPILOT_V2_ROOT, "runtime/apps/ava-engine/src/terminal-operator.mjs")
  : path.resolve(here, "../../../ava-engine/src/terminal-operator.mjs");
const ENGINE_MISSING = existsSync(ENGINE_OPERATOR) ? false : "copilot-v2 的 ava-engine 不在這裡；設 COPILOT_V2_ROOT 才跑得到這個跨 repo 契約";

/** `const X = Number(process.env.AVA_TERMINAL_REAP_GRACE_MS || <預設>)` 裡的那兩個東西。 */
function graceDeclaration(file) {
  const src = readFileSync(file, "utf8");
  const m = src.match(/process\.env\.(AVA_[A-Z_]*REAP_GRACE_MS)\s*\|\|\s*([^)]+)\)/);
  assert.ok(m, `${path.basename(file)} 裡找不到回收寬限期的宣告 —— 是不是被拿掉了？`);
  // 預設值寫成 `5 * 60_000` 這種可讀的形式，比對前先算成數字。
  const literal = m[2].trim();
  assert.match(literal, /^[\d_*\s]+$/, `${path.basename(file)} 的寬限期預設值要是一個常數，實際是 ${literal}`);
  // eslint-disable-next-line no-new-func
  const value = Number(new Function(`return (${literal.replace(/_/g, "")})`)());
  return { envVar: m[1], defaultMs: value };
}

test("引擎與 runtime 用同一個環境變數、同一個預設寬限期", { skip: ENGINE_MISSING }, () => {
  const engine = graceDeclaration(ENGINE_OPERATOR);
  const runtime = graceDeclaration(RUNTIME_REGISTRY);

  assert.equal(
    runtime.envVar, engine.envVar,
    "兩層要能被同一個環境變數一起調 —— 各有各的名字等於保證有一天會被調歪",
  );
  assert.equal(
    runtime.defaultMs, engine.defaultMs,
    `沒調的時候兩層必須一致（引擎 ${engine.defaultMs}ms vs runtime ${runtime.defaultMs}ms）`,
  );
  assert.ok(runtime.defaultMs > 0, "寬限期是 0 等於一結束就 404，重連拿不回任何東西");
});
