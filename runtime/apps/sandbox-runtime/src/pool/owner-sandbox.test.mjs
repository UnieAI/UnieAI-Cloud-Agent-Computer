/**
 * pool/owner-sandbox.test.mjs — 「這個工作區擁有者現在那一台」要找得到。
 *
 * 2026-09-26 UAT 軌道 B1，D2：審閱面板永遠「沒有變更」。app 拿自己的對話 id
 * 去問 `/v1/sessions/:id/sandbox`，而沙盒是引擎用它自己的 `s_…` 配的，所以問不到。
 * app 的退路是問擁有者的那一台（user 模式是一個擁有者一台）—— 這條路的查法
 * 必須跟配置時算 slot 的方法一致。
 *
 * 配置時個人工作區的 owner 是 `user:<id>`（server.mjs 的 allocate 路由），而
 * `resolveWorkspaceOwner` 對個人工作區回的是**裸的** userId。兩個拼法以前落在
 * 不同的 slot（`u::user:u` 對 `u::u`），所以用後者去查永遠查不到 ——
 * `/v1/users/:id/workspace/sync` 因此對每一個個人工作區都回 no_live_sandbox。
 */
process.env.SANDBOX_ALLOW_ANONYMOUS_FILER = "1";
process.env.SANDBOX_USER_MAX_ACTIVE = "0";
process.env.SANDBOX_POOL_TOTAL_MAX = "100";

import test from "node:test";
import assert from "node:assert/strict";

const cube = await import("../cube/index.mjs");
let _ctr = 0;
cube.resetBackend();
cube.setBackend({
  createSandbox: async ({ userId, sessionId }) => ({ sandboxId: `cloud_${++_ctr}`, workspaceId: `ws_${_ctr}`, workspaceDir: `/tmp/fake_${_ctr}`, userId, sessionId }),
  destroySandbox: async () => undefined,
});

const { _resetForTest } = await import("../relay/registry.mjs");
const { allocateSandbox, findUserSandbox, findSessionSandbox } = await import("./manager.mjs");

test("個人工作區：裸的 userId 與 user:<id> 兩種拼法找到同一台", async () => {
  _resetForTest();
  const a = await allocateSandbox({ userId: "u-own", sessionId: "s_eng_1", workspaceMode: "user", workspaceOwner: "user:u-own" });
  assert.equal(findUserSandbox("u-own", "user:u-own")?.sandboxId, a.entry.sandboxId);
  assert.equal(findUserSandbox("u-own", "u-own")?.sandboxId, a.entry.sandboxId, "resolveWorkspaceOwner 給的是裸 id");
  assert.equal(findUserSandbox("u-own")?.sandboxId, a.entry.sandboxId);
});

test("群組工作區是另一台；別人的 id 找不到", async () => {
  _resetForTest();
  const mine = await allocateSandbox({ userId: "u-g", sessionId: "s_1", workspaceMode: "user", workspaceOwner: "user:u-g" });
  const group = await allocateSandbox({ userId: "u-g", sessionId: "s_2", workspaceMode: "user", workspaceOwner: "group:g-1" });
  assert.notEqual(mine.entry.sandboxId, group.entry.sandboxId);
  assert.equal(findUserSandbox("u-g", "group:g-1")?.sandboxId, group.entry.sandboxId);
  assert.equal(findUserSandbox("u-g", "u-g")?.sandboxId, mine.entry.sandboxId);
  assert.equal(findUserSandbox("someone-else", "someone-else"), null);
});

test("引擎配的沙盒只登記在引擎的 session id 底下 —— app 的對話 id 查不到（所以才需要擁有者這條路）", async () => {
  _resetForTest();
  const a = await allocateSandbox({ userId: "u-e", sessionId: "s_engine", workspaceMode: "user", workspaceOwner: "user:u-e" });
  assert.equal(findSessionSandbox("s_engine")?.sandboxId, a.entry.sandboxId);
  assert.equal(findSessionSandbox("ses_app"), null);
  assert.equal(findUserSandbox("u-e", "u-e")?.sandboxId, a.entry.sandboxId);
});
