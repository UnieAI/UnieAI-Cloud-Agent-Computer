import { test } from "node:test";
import assert from "node:assert/strict";
import { isReadOnlyCommand, bashDestructiveRisk, isHardDenied, classifyCommand } from "./shell-policy.mjs";

test("read-only allow-list: reads pass, writes and unknown words fail", () => {
  assert.equal(isReadOnlyCommand("git status"), true);
  assert.equal(isReadOnlyCommand("rg TODO src/"), true);
  assert.equal(isReadOnlyCommand("ls -la; rm x"), false);
  assert.equal(isReadOnlyCommand("echo hi > out.txt"), false);
  assert.equal(isReadOnlyCommand("npm test"), false);
  assert.equal(isReadOnlyCommand("sed -i s/a/b/ f"), false);
  assert.equal(isReadOnlyCommand("sed s/a/b/ f"), true);
  assert.equal(isReadOnlyCommand(""), false);
});

test("destructive risk is a one-sentence warning, or null", () => {
  assert.match(bashDestructiveRisk("rm -rf build") || "", /deletes/);
  assert.match(bashDestructiveRisk("git push --force origin main") || "", /Force-push/);
  assert.equal(bashDestructiveRisk("npm test"), null);
});

test("hard deny-list refuses catastrophic one-liners even with approval", () => {
  assert.equal(isHardDenied("rm -rf /"), true);
  assert.equal(isHardDenied("rm -rf / --no-preserve-root"), true);
  assert.equal(isHardDenied("mkfs.ext4 /dev/sda1"), true);
  assert.equal(isHardDenied("dd if=/dev/zero of=/dev/sda"), true);
  assert.equal(isHardDenied(":(){ :|:& };:"), true);
  assert.equal(isHardDenied("shutdown -h now"), true);
  assert.equal(isHardDenied("rm -rf build"), false);
  assert.equal(isHardDenied("git status"), false);
});

test("classifyCommand collapses the three checks into one verdict", () => {
  assert.deepEqual(classifyCommand("git status"), { verdict: "read_only", risk: null });
  assert.deepEqual(classifyCommand("npm test"), { verdict: "needs_approval", risk: null });
  assert.equal(classifyCommand("rm -rf build").verdict, "needs_approval");
  assert.match(classifyCommand("rm -rf build").risk, /deletes/);
  assert.equal(classifyCommand("rm -rf /").verdict, "denied");
});

/* ── 硬性拒絕要說得出理由（F-28） ─────────────────────────────────────────
 *
 * 2026-09-11 實測：`reboot` 被擋下來時，使用者讀到的是
 * 「這個指令被目前的權限模式擋下來：」後面**一個字都沒有** —— 因為
 * `classifyCommand` 對 denied 一律回 `risk: null`，而兩個呼叫端都寫
 * `${gate.risk ?? ""}`。也就是說**最嚴重的那一類拒絕，正好是唯一不說理由的**。
 *
 * 這條測試釘的是「每一個硬性拒絕都帶得出一句人看得懂的話」，不是釘字面。
 */
test("每一個硬性拒絕的指令都說得出理由", () => {
  const denied = [
    "rm -rf /",
    "rm -rf ~",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    "reboot",
    "sudo shutdown -h now",
    "echo x > /dev/sda1",
    ":(){ :|:& };:",
  ];
  for (const cmd of denied) {
    const v = classifyCommand(cmd);
    assert.equal(v.verdict, "denied", `${cmd} 應該是 denied`);
    assert.equal(typeof v.risk, "string", `${cmd} 的 risk 應該是一句話，不是 ${v.risk}`);
    assert.ok(v.risk.length >= 4, `${cmd} 的理由太短：${v.risk}`);
  }
});

test("拒絕的理由要分得出是哪一種，不是同一句罐頭", () => {
  const reasons = new Set(
    ["rm -rf /", "mkfs.ext4 /dev/sda1", "reboot", ":(){ :|:& };:"].map((c) => classifyCommand(c).risk),
  );
  // 四種完全不同的災難，不該共用一句話 —— 使用者要知道我們擋的是什麼。
  assert.equal(reasons.size, 4);
});
