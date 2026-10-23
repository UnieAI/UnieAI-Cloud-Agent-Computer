/**
 * 強制器預設關閉（rabi／owner 2026-10-02）：filer 強制器改的是 uac2-seaweedfs（EVE 的 compose 專案，Ava 只是共用它），
 * 依規則未經 owner 決定不能動。所以 `WORKSPACE_QUOTA_ENFORCER` 沒設 ＝ 關；要明確設成 `1` 才啟動。
 * 關的時候**一次都不呼叫 weed shell**（連「清除」都不做）；只有明確設成 `0` 才執行一次性的緊急清除。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { startQuotaEnforcer } from "./index.mjs";

function spyControl() {
  const calls = [];
  return {
    calls,
    control: {
      current: async () => { calls.push("current"); return new Set(); },
      apply: async () => { calls.push("apply"); },
      listBuckets: async () => { calls.push("listBuckets"); return []; },
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

test("沒設 WORKSPACE_QUOTA_ENFORCER：不啟動、一次都不碰 weed shell（current／apply／listBuckets 都沒被叫）", async () => {
  for (const env of [{}, { WORKSPACE_QUOTA_ENFORCER: "" }, { WORKSPACE_QUOTA_ENFORCER: "true" }, { WORKSPACE_QUOTA_ENFORCER: "yes" }, { WORKSPACE_QUOTA_ENFORCER: "2" }]) {
    const s = spyControl();
    const stop = startQuotaEnforcer({ log: () => {}, env, control: s.control });
    await tick();
    assert.equal(stop, null, JSON.stringify(env));
    assert.deepEqual(s.calls, [], `${JSON.stringify(env)} 不該碰 filer`);
  }
});

test("明確設成 1：啟動（立刻對帳一次，會讀 filer 現況）", async () => {
  const s = spyControl();
  const stop = startQuotaEnforcer({ log: () => {}, env: { WORKSPACE_QUOTA_ENFORCER: "1", S3_BUCKET: "shared" }, control: s.control });
  await tick();
  assert.equal(typeof stop, "function");
  assert.ok(s.calls.includes("current"));
  stop();
});

test("明確設成 0：只做一次性緊急清除（讀現況，沒有我們管的規則就不寫），不啟動週期工作", async () => {
  const s = spyControl();
  const stop = startQuotaEnforcer({ log: () => {}, env: { WORKSPACE_QUOTA_ENFORCER: "0" }, control: s.control });
  await tick();
  assert.equal(stop, null);
  assert.deepEqual(s.calls, ["current"]);
});

test("server.mjs 的啟動呼叫沒有繞過這個預設（不另外判斷、不傳 control）", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(src, /startQuotaEnforcer\(\{ log \}\)/);
});
