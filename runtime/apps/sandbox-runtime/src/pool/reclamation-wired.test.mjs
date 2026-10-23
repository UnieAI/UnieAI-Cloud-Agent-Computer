/**
 * pool/reclamation-wired.test.mjs —— 每一個「回收」都要有真的呼叫端。
 *
 * 這一批修的四個缺口有同一個形狀：**清理函式寫好了，呼叫端沒有（或掉了）**。
 *
 *   · `cube/ssh-ca.mjs` 的 `forget()` —— 註解寫著什麼時候該叫，零個呼叫端。
 *   · `cube/index.mjs` 的 `releaseSandboxBackend()` —— 甚至**一直被 import 在
 *     manager.mjs 最上面**，只是沒有人呼叫。這正是 2026-08-05 那批的形狀：
 *     重構掉呼叫點、import 留著，tsc／lint／既有測試全綠。
 *   · `terminal/registry.mjs` 的回收 —— 根本沒寫。
 *   · `workspace/groupGit.mjs` 的 sandboxBase —— 只寫不刪。
 *
 * 型別檢查與單元測試抓不到「沒有人呼叫」，所以這裡讀原始碼。醜，但它是唯一在
 * 下一次重構把呼叫點弄丟時會叫的東西。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!name.endsWith(".mjs") || name.endsWith(".test.mjs")) continue;
      out.push({ file: path.relative(SRC, p), src: readFileSync(p, "utf8") });
    }
  };
  walk(SRC);
  return out;
}
const FILES = sources();

/** 這個名字在哪些**非定義**的地方被呼叫。 */
function callSites(name) {
  const call = new RegExp(`(?<![.\\w])${name}\\s*\\(`);
  const define = new RegExp(`(?:function|const|let|var)\\s+${name}\\b|${name}\\s*[:(]\\s*(?:function|\\()`);
  const hits = [];
  for (const { file, src } of FILES) {
    for (const line of src.split("\n")) {
      const t = line.trim();
      if (t.startsWith("*") || t.startsWith("//")) continue;   // 註解裡提到不算
      if (!call.test(t) || define.test(t)) continue;
      hits.push({ file, line: t });
    }
  }
  return hits;
}

const MUST_BE_CALLED = [
  ["releaseSandboxBackend", "沙盒銷毀後要把 id→後端 那一列解除，否則那張表只會長大"],
  ["forgetSandboxBase", "沙盒回收後要忘掉它的 group base commit"],
  ["releaseMachineSandboxes", "撤銷一台機器要放掉池裡指向它的登記列"],
  ["forgetMachineCredentials", "撤銷一台機器要忘掉為它簽過的 SSH 憑證快取"],
  ["scheduleReap", "終端機結束後要排進回收"],
  ["gcExitedProcesses", "已結束的長命行程要被定期清掉（既有的對照組）"],
];

for (const [name, why] of MUST_BE_CALLED) {
  test(`${name}() 有真的呼叫端 —— ${why}`, () => {
    const hits = callSites(name);
    assert.ok(
      hits.length > 0,
      `${name}() 在 src/ 裡找不到任何呼叫端。清理函式沒有人呼叫 = 沒有清理，`
      + `而型別檢查與單元測試都不會叫。`,
    );
  });
}

test("ssh-ca 的 forget() 在 ssh.mjs 裡被呼叫", () => {
  const ssh = FILES.find((f) => f.file === path.join("cube", "ssh.mjs"));
  assert.ok(ssh, "找不到 cube/ssh.mjs");
  assert.match(
    ssh.src, /minter\.forget\(/,
    "ssh-ca 的 forget() 必須在這裡被呼叫 —— 它的註解說「DB 那側停止授權後呼叫」，"
    + "而在這次修改之前那句話沒有任何程式對應。",
  );
});

test("撤銷那條路由三件事都做：關連線、放池、忘憑證", () => {
  const routes = FILES.find((f) => f.file === path.join("relay", "routes.mjs"));
  assert.ok(routes, "找不到 relay/routes.mjs");
  const revoke = routes.src.slice(routes.src.indexOf("export async function handleRelayRevoke"));
  assert.ok(revoke, "找不到 handleRelayRevoke");
  for (const fn of ["revokeMachine(", "releaseMachineSandboxes(", "forgetMachineCredentials("]) {
    assert.ok(revoke.includes(fn), `撤銷少了 ${fn} —— 只做其中一件，撤銷就只生效三分之一`);
  }
});

test("回收器對機器綁定的列有出口，不是無條件 continue", () => {
  const mgr = FILES.find((f) => f.file === path.join("pool", "manager.mjs"));
  assert.ok(mgr, "找不到 pool/manager.mjs");
  // 只看回收器那一段：配額那個迴圈裡也有一個 `if (entry.machineKind) continue;`，
  // 而**那一個是對的**（本機不吃我們的容量，見它旁邊的註解）。
  const reaperStart = mgr.src.indexOf("export function _runReaperPass");
  assert.ok(reaperStart > 0, "找不到 _runReaperPass");
  const reaper = mgr.src.slice(reaperStart, mgr.src.indexOf("export function startReaper"));
  assert.doesNotMatch(
    reaper, /if\s*\(entry\.machineKind\)\s*continue;/,
    "機器綁定的列被無條件跳過了 —— 那正是「永遠不回收」的來源。"
    + "它要有一個失效條件（machineLinkLost），不是沒有出口。",
  );
  assert.match(reaper, /machineLinkLost\s*\(/, "失效條件不見了");
});
