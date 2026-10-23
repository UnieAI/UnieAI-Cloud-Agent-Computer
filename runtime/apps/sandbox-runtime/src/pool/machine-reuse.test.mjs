/**
 * pool/machine-reuse.test.mjs — a sandbox is reused only for the SAME machine.
 *
 * Seen live (e2e, 2026-09-01): the per-user singleton handed a session the
 * sandbox bound to a machine that had since been revoked, so every tool call
 * answered machine_offline. The cloud → local → other-local → cloud walk below
 * pins the rule for both reuse paths (by session and by user slot).
 */
// The filer guard (cube/filer-exposure.mjs) refuses CLOUD sandboxes on a host
// where a sandbox can reach an unauthenticated filer — or where the probe
// cannot answer, which is every test runner. These suites are about the pool,
// not about the filer, so they declare the acceptance the same way a
// deployment would.
//
// Set here rather than deleted from the guard on purpose: the guard's own
// refusals are asserted in cube/filer-exposure.test.mjs and in the three
// allocation tests at the end of machine-lifecycle.test.mjs. A blanket
// "tests are exempt" would have removed the only thing that fails when the
// guard stops working.
process.env.SANDBOX_ALLOW_ANONYMOUS_FILER = "1";

process.env.SANDBOX_USER_MAX_ACTIVE = "0";
process.env.SANDBOX_POOL_TOTAL_MAX = "100";

import test from "node:test";
import assert from "node:assert/strict";

const cube = await import("../cube/index.mjs");
let _ctr = 0;
const cloud = {
  createSandbox: async ({ userId, sessionId }) => ({ sandboxId: `cloud_${++_ctr}`, workspaceId: `ws_${_ctr}`, workspaceDir: `/tmp/fake_${_ctr}`, userId, sessionId }),
  destroySandbox: async () => undefined,
};
cube.resetBackend();
cube.setBackend(cloud);

const { registerMachineConnection, _resetForTest } = await import("../relay/registry.mjs");
const { allocateSandbox } = await import("./manager.mjs");

test("switching machines never reuses a sandbox bound to another machine", async () => {
  _resetForTest();
  registerMachineConnection({ machineId: "m1", userId: "u9", send() {} });
  registerMachineConnection({ machineId: "m2", userId: "u9", send() {} });

  const a = await allocateSandbox({ userId: "u9", sessionId: "s1", workspaceMode: "user" });
  assert.match(a.entry.sandboxId, /^cloud_/);
  assert.equal(a.entry.machineId, null);

  const b = await allocateSandbox({ userId: "u9", sessionId: "s1", workspaceMode: "user", machine: { id: "m1", kind: "local", root: "/w" } });
  assert.match(b.entry.sandboxId, /^local-/, "a local machine gets its own relay-backed sandbox");
  assert.equal(b.reconnect, false);
  assert.equal(b.entry.machineId, "m1");

  const b2 = await allocateSandbox({ userId: "u9", sessionId: "s1", workspaceMode: "user", machine: { id: "m1", kind: "local", root: "/w" } });
  assert.equal(b2.entry.sandboxId, b.entry.sandboxId, "same machine → reused");
  assert.equal(b2.reconnect, true);

  const c = await allocateSandbox({ userId: "u9", sessionId: "s2", workspaceMode: "user", machine: { id: "m2", kind: "local", root: "/w2" } });
  assert.notEqual(c.entry.sandboxId, b.entry.sandboxId, "another machine → another sandbox");
  assert.equal(c.entry.machineId, "m2");

  const d = await allocateSandbox({ userId: "u9", sessionId: "s3", workspaceMode: "user" });
  assert.match(d.entry.sandboxId, /^cloud_/, "back to the cloud → not a machine-bound sandbox");
});

test("a local machine skips the manifest restore and reports it", async () => {
  _resetForTest();
  registerMachineConnection({ machineId: "m3", userId: "u10", send() {} });
  const r = await allocateSandbox({ userId: "u10", sessionId: "s10", workspaceMode: "user", machine: { id: "m3", kind: "local", root: "/w" } });
  assert.equal(r.entry.machineKind, "local");
  assert.deepEqual(await r.entry.restorePromise, { status: "skipped", reason: "local_machine" });
});

/**
 * Seen live (2026-09-04): the user picked a different folder on the SAME
 * machine, the file panel updated — it reads the current value on every open,
 * through `workspace-bridge` — and `ls` kept listing the previous folder's
 * contents. Right machine, right chip, stale answer, no error anywhere.
 *
 * The reuse predicate compared `machineId` only. A sandbox records the picked
 * folder as its `root` at creation (`cube/relay.mjs` createSandbox) and every
 * path and the default cwd resolve against THAT, so reusing one after the pick
 * changed keeps serving the old folder for the life of the session.
 *
 * The machine-switch rule above was written for exactly this failure and named
 * only half of the target: a sandbox is bound to one machine AND one folder.
 */
test("picking a different folder on the same machine does not reuse the sandbox", async () => {
  _resetForTest();
  registerMachineConnection({ machineId: "m4", userId: "u11", send() {} });

  const first = await allocateSandbox({
    userId: "u11", sessionId: "s-folder", workspaceMode: "user",
    machine: { id: "m4", kind: "local", root: "/home/ubuntu/docs-work" },
  });
  assert.equal(first.entry.machineId, "m4");

  const same = await allocateSandbox({
    userId: "u11", sessionId: "s-folder", workspaceMode: "user",
    machine: { id: "m4", kind: "local", root: "/home/ubuntu/docs-work" },
  });
  assert.equal(same.entry.sandboxId, first.entry.sandboxId, "same machine AND same folder → reused");

  const moved = await allocateSandbox({
    userId: "u11", sessionId: "s-folder", workspaceMode: "user",
    machine: { id: "m4", kind: "local", root: "/home/ubuntu/other-folder" },
  });
  assert.notEqual(moved.entry.sandboxId, first.entry.sandboxId, "different folder → a sandbox rooted at it");
});

/** The per-user singleton is the second reuse path and needs the same rule. */
test("the per-user slot also refuses a sandbox rooted at a different folder", async () => {
  _resetForTest();
  registerMachineConnection({ machineId: "m5", userId: "u12", send() {} });

  const a = await allocateSandbox({
    userId: "u12", sessionId: "s-a", workspaceMode: "user",
    machine: { id: "m5", kind: "local", root: "/root-a" },
  });
  const b = await allocateSandbox({
    userId: "u12", sessionId: "s-b", workspaceMode: "user",
    machine: { id: "m5", kind: "local", root: "/root-b" },
  });
  assert.notEqual(b.entry.sandboxId, a.entry.sandboxId, "a different folder must not come back through the user slot");
});
