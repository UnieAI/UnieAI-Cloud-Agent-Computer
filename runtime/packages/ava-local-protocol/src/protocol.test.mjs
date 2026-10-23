import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, encodeFrame, parseFrame, FRAME_TYPES } from "./protocol.mjs";

test("frames are newline-terminated JSON with a version and a known type", () => {
  const line = encodeFrame({ type: "ping", ts: 1 });
  assert.equal(line.endsWith("\n"), true);
  const f = JSON.parse(line);
  assert.equal(f.v, PROTOCOL_VERSION);
  assert.equal(f.type, "ping");
});

test("parseFrame validates the shape of each frame type", () => {
  assert.equal(parseFrame(encodeFrame({ type: "invoke", id: "i1", op: "exec", args: { command: "ls" }, deadlineMs: 5000 })).ok, true);
  assert.equal(parseFrame(encodeFrame({ type: "invoke", id: "i1", op: "teleport", args: {} })).ok, false);
  assert.equal(parseFrame('{"v":1,"type":"nope"}\n').ok, false);
  assert.equal(parseFrame("not json").ok, false);
  assert.equal(parseFrame(encodeFrame({ type: "result", id: "i1", ok: true, output: { exit_code: 0 } })).ok, true);
  assert.equal(parseFrame(encodeFrame({ type: "hello", machine: { platform: "linux", arch: "x64", daemonVersion: "0.1.0", grantedRoot: "/w" }, ops: ["exec"] })).ok, true);
  assert.equal(parseFrame(encodeFrame({ type: "revoke", reason: "user" })).ok, true);
  assert.ok(FRAME_TYPES.includes("invoke"));
});

test("a frame from a newer protocol version is rejected with a clear reason", () => {
  const line = JSON.stringify({ v: PROTOCOL_VERSION + 1, type: "ping" }) + "\n";
  const r = parseFrame(line);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unsupported_version");
});
