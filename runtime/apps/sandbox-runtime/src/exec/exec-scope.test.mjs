/**
 * exec/exec-scope.test.mjs — an execId belongs to ONE sandbox.
 *
 * Found live on 2026-09-02 against the running :4021, with
 * SANDBOX_ENFORCE_OWNERSHIP=1 and two different users:
 *
 *   POST /v1/sandboxes/<victim>/exec              → exec-b4d4da37
 *   GET  /v1/sandboxes/<ATTACKER>/exec/exec-b4d4da37/stream
 *        → "VICTIM_SECRET_abc123"          (the victim's stdout, replayed)
 *   DELETE /v1/sandboxes/<ATTACKER>/exec/exec-b4d4da37
 *        → {"cancelled":true}              (the victim's command, killed)
 *
 * The route pattern captures `id`, and the dispatcher's ownership check
 * validated it — so the attacker passing their OWN sandbox id sailed through
 * it. The handler then threw the id away and looked the exec up in a single
 * process-wide `execId -> entry` map. Ownership enforcement was never wrong;
 * it was checking a different object than the one the handler used.
 *
 * That is the shape of the bug, and it is why the fix belongs HERE rather
 * than in the dispatcher: the object being addressed is the exec, so the
 * exec lookup is what has to be scoped. `attachProcess` in processManager.mjs
 * already keys on (sandboxId, handle) — this brings execs in line with it.
 *
 * execIds are 8 hex characters (`exec-${randomUUID().slice(0, 8)}`), so
 * "unguessable" was never the defence either.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { registerExec, attachListener, cancelExec, getExec, _resetExecsForTest } =
  await import("./streams.mjs");

/** A stub exec handle: enough surface for register/finalize/cancel. */
function fakeHandle(execId) {
  const listeners = {};
  return {
    execId,
    on(event, fn) { (listeners[event] ||= []).push(fn); return this; },
    emit(event, ...args) { for (const fn of listeners[event] || []) fn(...args); },
    cancel() { this.cancelled = true; },
    cancelled: false,
  };
}

function register(sandboxId, execId, userId) {
  return registerExec({
    sandboxId,
    handle: fakeHandle(execId),
    kind: "bash",
    command: "echo hi",
    timeoutMs: 30_000,
    userId,
    workspaceOwner: `user:${userId}`,
  });
}

test("attachListener refuses an execId that belongs to another sandbox", () => {
  _resetExecsForTest?.();
  register("sbx-victim", "exec-aaaa1111", "victim");

  const res = { write() {}, writeHead() {}, end() {}, on() {}, writableEnded: false };
  assert.equal(
    attachListener("exec-aaaa1111", res, { sandboxId: "sbx-attacker" }),
    null,
    "another sandbox must not attach to this exec's stream",
  );
});

test("attachListener still works for the owning sandbox", () => {
  _resetExecsForTest?.();
  register("sbx-victim", "exec-aaaa2222", "victim");

  const written = [];
  const res = { write(c) { written.push(String(c)); }, writeHead() {}, end() {}, on() {}, writableEnded: false };
  assert.ok(
    attachListener("exec-aaaa2222", res, { sandboxId: "sbx-victim" }),
    "the owning sandbox attaches normally",
  );
});

test("cancelExec refuses an execId that belongs to another sandbox", () => {
  _resetExecsForTest?.();
  const entry = register("sbx-victim", "exec-aaaa3333", "victim");

  assert.equal(cancelExec("exec-aaaa3333", { sandboxId: "sbx-attacker" }), false, "not cancellable from elsewhere");
  assert.equal(entry.status, "running", "the victim's command is still running");
  assert.equal(entry.handle.cancelled, false, "and its handle was never touched");
});

test("cancelExec still works for the owning sandbox", () => {
  _resetExecsForTest?.();
  const entry = register("sbx-victim", "exec-aaaa4444", "victim");
  assert.equal(cancelExec("exec-aaaa4444", { sandboxId: "sbx-victim" }), true);
  assert.equal(entry.handle.cancelled, true);
});

test("an unknown sandbox scope is refused, not treated as a wildcard", () => {
  _resetExecsForTest?.();
  register("sbx-victim", "exec-aaaa5555", "victim");
  const res = { write() {}, writeHead() {}, end() {}, on() {}, writableEnded: false };

  // A missing/empty scope must fail closed. Callers that genuinely have no
  // sandbox context have no business reading an exec stream.
  assert.equal(attachListener("exec-aaaa5555", res, { sandboxId: "" }), null);
  assert.equal(attachListener("exec-aaaa5555", res, {}), null);
  assert.equal(cancelExec("exec-aaaa5555", { sandboxId: null }), false);
});

test("getExec is scoped the same way", () => {
  _resetExecsForTest?.();
  register("sbx-victim", "exec-aaaa6666", "victim");
  assert.ok(getExec("exec-aaaa6666", { sandboxId: "sbx-victim" }), "owner reads it");
  assert.equal(getExec("exec-aaaa6666", { sandboxId: "sbx-attacker" }), null, "nobody else does");
});
