/**
 * cube/machine-forget.test.mjs —— 撤銷一台機器之後，憑證簽發器要忘掉它。
 *
 * `ssh-ca.mjs` 的 `forget()` 註解寫著「DB 那側停止授權後呼叫」，而在這次修改之前
 * 它**除了自己的定義以外零個呼叫端**。
 *
 * 而且缺口不是「多撐一個憑證有效期」那麼小：`ensureCert` 過期會**自己重簽**，
 * 它從頭到尾不回頭問 DB。所以只要這個行程裡還有一筆用得到它的登記，它就會一直
 * 簽下去 —— 窗口的長度是「那筆登記還在多久」，而機器綁定的登記在修好之前是永遠。
 * 下面第三條就是在釘這一點。
 */
import test from "node:test";
import assert from "node:assert/strict";

const { createSshClient } = await import("./ssh.mjs");

function spyMinter() {
  const minted = [];
  const forgotten = [];
  return {
    minted, forgotten,
    isConfigured: () => true,
    async ensureCert(principal) { minted.push(principal); return { identityFile: "/k", certFile: "/c" }; },
    forget(principal) { forgotten.push(principal); },
    destroy() {},
  };
}

const target = { host: "h", user: "u", root: "/r", principal: "alice", port: 22 };

test("撤銷之後，這台機器簽過的 principal 被忘掉", async () => {
  const minter = spyMinter();
  const ssh = createSshClient({ resolveTarget: async () => ({ ...target }), certMinter: minter });
  await ssh.createSandbox({ userId: "u1", sessionId: "s1", machine: { id: "m-ssh", kind: "ssh" } });
  assert.deepEqual(minter.minted, ["alice"], "開的時候先簽了一張");

  const r = ssh.forgetMachine("m-ssh");

  assert.deepEqual(r.principals, ["alice"]);
  assert.deepEqual(minter.forgotten, ["alice"], "forget() 真的被呼叫了");
});

test("就算這個行程從沒為它開過 sandbox，帶著 principal 也忘得掉", async () => {
  const minter = spyMinter();
  const ssh = createSshClient({ resolveTarget: async () => ({ ...target }), certMinter: minter });

  const r = ssh.forgetMachine("m-never-used", { principal: "bob" });

  assert.deepEqual(r.principals, ["bob"]);
  assert.deepEqual(minter.forgotten, ["bob"]);
});

test("反向：別台機器的憑證不能被誤清", async () => {
  const minter = spyMinter();
  const ssh = createSshClient({
    resolveTarget: async ({ machine }) => ({ ...target, principal: machine.id === "m-a" ? "alice" : "carol" }),
    certMinter: minter,
  });
  await ssh.createSandbox({ userId: "u1", sessionId: "sa", machine: { id: "m-a", kind: "ssh" } });
  await ssh.createSandbox({ userId: "u1", sessionId: "sb", machine: { id: "m-b", kind: "ssh" } });

  ssh.forgetMachine("m-a");

  assert.deepEqual(minter.forgotten, ["alice"], "只忘掉被撤銷的那一台");
});

test("忘掉快取還不夠：真正的窗口是「那筆登記還在多久」", async () => {
  // 這一條不驗程式，驗的是**兩半都在**。快取清掉之後 ensureCert 會重簽 ——
  // 下面這幾行就是在示範那個行為，所以撤銷必須同時放掉池裡的登記
  // （pool/manager.mjs 的 releaseMachineSandboxes，由 relay/routes.mjs 一起呼叫）。
  const minter = spyMinter();
  const ssh = createSshClient({ resolveTarget: async () => ({ ...target }), certMinter: minter });
  const { sandboxId } = await ssh.createSandbox({ userId: "u1", sessionId: "s1", machine: { id: "m-ssh", kind: "ssh" } });

  ssh.forgetMachine("m-ssh");
  // 登記還在 → 下一次操作照樣簽得出新的一張。撤銷靠 forget 一件事是不夠的。
  assert.ok(ssh._internal.sandboxes.has(sandboxId), "forgetMachine 不動登記（那是 pool 的職責）");
  await minter.ensureCert("alice");
  assert.equal(minter.minted.length, 2, "快取清掉只是讓它重簽一張新的");
});
