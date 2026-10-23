/**
 * SSH 的 host key 釘在哪裡。
 *
 * 2026-09-11 的資安審查第 7 條：`StrictHostKeyChecking=accept-new` 代表**每一次
 * 對一台沒見過的機器的連線都可能被中間人接走**，而且共用一個 known_hosts 讓
 * 「哪一把金鑰屬於哪一台」混在一起。
 *
 * 這個檔案盯的是那條規則：一個目標一個檔，見過之後就不准換。
 *
 * Run: node --test runtime/apps/sandbox-runtime/src/cube/ssh-hostkey.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "ssh-kh-"));
process.env.SSH_CONTROL_DIR = dir;
const { sshArgs } = await import("./ssh.mjs");

const opt = (args, name) => String(args.find((a) => String(a).startsWith(`${name}=`)) ?? "");
const T = (host) => ({ host, user: "u", port: 22, root: "/x" });

test("known_hosts 是每個目標一個檔 —— 共用會讓金鑰混在一起", () => {
  const a = opt(sshArgs(T("alpha")), "UserKnownHostsFile");
  const b = opt(sshArgs(T("beta")), "UserKnownHostsFile");
  assert.ok(a && b, "根本沒有指定 known_hosts");
  assert.notEqual(a, b, "兩台機器共用同一個 known_hosts");
  assert.ok(a.includes(dir), "沒有放在控制目錄底下");
});

test("同一個目標算出同一個檔 —— 不然每次連線都像第一次", () => {
  assert.equal(opt(sshArgs(T("alpha")), "UserKnownHostsFile"), opt(sshArgs(T("alpha")), "UserKnownHostsFile"));
});

test("沒見過的機器才 accept-new", () => {
  assert.equal(opt(sshArgs(T("fresh")), "StrictHostKeyChecking"), "StrictHostKeyChecking=accept-new");
});

test("見過之後金鑰換了就要連不上，不是印一句警告", () => {
  const target = T("seen");
  const file = opt(sshArgs(target), "UserKnownHostsFile").split("=")[1];
  writeFileSync(file, "seen ssh-ed25519 AAAA...\n");
  assert.equal(
    opt(sshArgs(target), "StrictHostKeyChecking"),
    "StrictHostKeyChecking=yes",
    "已經記過金鑰卻還在 accept-new —— 中間人換掉金鑰時會被默默接受",
  );
});

test("空檔案不算見過 —— 建了檔卻沒寫進去的那次不該把後面鎖死", () => {
  const target = T("empty");
  const file = opt(sshArgs(target), "UserKnownHostsFile").split("=")[1];
  writeFileSync(file, "");
  assert.equal(opt(sshArgs(target), "StrictHostKeyChecking"), "StrictHostKeyChecking=accept-new");
});

test("BatchMode 還在 —— 少了它，要密碼的機器會讓程式無聲卡死", () => {
  assert.ok(sshArgs(T("x")).includes("BatchMode=yes"));
});
