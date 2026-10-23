import { test } from "node:test";
import assert from "node:assert/strict";
import { mintApprovalToken, verifyApprovalToken, createNonceRegistry } from "./approval.mjs";
import { payloadHash, approvalSubject } from "./canonical.mjs";

const KEY = "k".repeat(32);
const subject = approvalSubject("exec", { command: "echo hi > out.txt" });
const base = {
  invokeId: "inv-1",
  machineId: "m-1",
  userId: "u-1",
  sessionId: "s-1",
  tool: "exec",
  payloadHash: payloadHash(subject),
};

function expectFor(over = {}) {
  return { machineId: "m-1", invokeId: "inv-1", tool: "exec", subject, ...over };
}

test("round trip: a token minted for exactly this action verifies", () => {
  const tok = mintApprovalToken(KEY, base, { now: 1000 });
  const v = verifyApprovalToken(KEY, tok, expectFor(), { now: 1000 + 60_000 });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.claims.userId, "u-1");
});

test("tampered command (hash mismatch) is refused", () => {
  const tok = mintApprovalToken(KEY, base, { now: 1000 });
  const evil = approvalSubject("exec", { command: "echo hi > out.txt; rm -rf ~" });
  const v = verifyApprovalToken(KEY, tok, expectFor({ subject: evil }), { now: 2000 });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "payload_mismatch");
});

test("a token for another machine, tool or invoke is refused", () => {
  const tok = mintApprovalToken(KEY, base, { now: 1000 });
  assert.equal(verifyApprovalToken(KEY, tok, expectFor({ machineId: "m-2" }), { now: 2000 }).reason, "machine_mismatch");
  assert.equal(verifyApprovalToken(KEY, tok, expectFor({ tool: "writeFile" }), { now: 2000 }).reason, "tool_mismatch");
  assert.equal(verifyApprovalToken(KEY, tok, expectFor({ invokeId: "inv-9" }), { now: 2000 }).reason, "invoke_mismatch");
});

test("expired tokens and tokens signed with another key are refused", () => {
  const tok = mintApprovalToken(KEY, base, { now: 1000, ttlMs: 120_000 });
  assert.equal(verifyApprovalToken(KEY, tok, expectFor(), { now: 1000 + 120_001 }).reason, "expired");
  assert.equal(verifyApprovalToken("x".repeat(32), tok, expectFor(), { now: 2000 }).reason, "bad_signature");
  assert.equal(verifyApprovalToken(KEY, tok + "a", expectFor(), { now: 2000 }).reason, "bad_signature");
  assert.equal(verifyApprovalToken(KEY, "garbage", expectFor(), { now: 2000 }).reason, "malformed");
});

test("nonce replay: the same token cannot authorise twice", () => {
  const nonces = createNonceRegistry({ ttlMs: 300_000 });
  const tok = mintApprovalToken(KEY, base, { now: 1000 });
  const first = verifyApprovalToken(KEY, tok, expectFor(), { now: 2000, nonces });
  const second = verifyApprovalToken(KEY, tok, expectFor(), { now: 2001, nonces });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "replayed");
});

test("mint refuses to bind an approval without a subject hash", () => {
  assert.throws(() => mintApprovalToken(KEY, { ...base, payloadHash: "" }), /payloadHash/);
});
