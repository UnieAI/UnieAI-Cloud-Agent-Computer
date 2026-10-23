import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, payloadHash, approvalSubject, sha256Hex } from "./canonical.mjs";

test("canonicalJson sorts object keys at every depth and is stable", () => {
  const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } });
  const b = canonicalJson({ a: { c: "x", d: [3, { y: 2, z: 1 }] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
});

test("canonicalJson drops undefined values and keeps null", () => {
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

test("payloadHash is key-order independent and value sensitive", () => {
  const h1 = payloadHash({ tool: "exec", command: "ls -la", cwd: "." });
  const h2 = payloadHash({ cwd: ".", command: "ls -la", tool: "exec" });
  const h3 = payloadHash({ tool: "exec", command: "ls -la ..", cwd: "." });
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test("approvalSubject binds exactly what the daemon will execute", () => {
  // exec: everything that decides what the command MEANS. This used to be the
  // command string alone, on the reasoning that "cwd is always the granted root
  // on the daemon" — an invariant the daemon had already stopped honouring
  // (tool-host.ts resolves `args.cwd` when one is sent). See the attack tests
  // below for what that left open.
  assert.deepEqual(approvalSubject("exec", { command: "npm test" }), {
    v: 2, tool: "exec", command: "npm test", kind: "bash", cwd: null, env: {}, sandbox: false,
  });
  // writeFile: the path plus a digest of the content, never the content itself
  const s = approvalSubject("writeFile", { path: "src/a.ts", content: "hello" });
  assert.equal(s.tool, "writeFile");
  assert.equal(s.path, "src/a.ts");
  assert.match(s.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal("content" in s, false);
  assert.deepEqual(approvalSubject("deleteFile", { path: "x" }), { v: 2, tool: "deleteFile", path: "x" });
  assert.throws(() => approvalSubject("readFile", { path: "x" }), /does not require approval/);
});

/**
 * What an approval is allowed to become between "Allow" and the syscall.
 *
 * The daemon's whole trust model is that it does NOT trust the caller: the app
 * mints a token over what the user saw, and the daemon recomputes the subject
 * from the invoke frame it received and compares digests. That only holds for
 * fields the subject actually covers. `exec` covered the command string alone,
 * and the daemon read FOUR other fields off the same frame — after verifying:
 *
 *   · `env`     — the app never sends one, so nothing legitimate is lost by
 *                 binding it. Adding `PATH=/tmp/x` turns an approved `npm test`
 *                 into someone else's `npm`, with the user's own credentials.
 *   · `cwd`     — a different folder inside the granted root. The card named a
 *                 command, not a place.
 *   · `kind`    — the same string run through `python3 -c` instead of `bash -lc`
 *                 is a different program.
 *   · `sandbox` — the sharpest one, because the approval CARD promises it in
 *                 words ("在你的電腦的沙盒中執行"). Unbound, anything between
 *                 the app and the daemon could drop the container the person
 *                 was shown, and the machine would honour the token.
 *
 * These are not replays — the nonce still holds. It is the FIRST use of a
 * genuine token with different surroundings, by the one component the daemon
 * was designed to distrust.
 */
test("adding an env to an approved command invalidates the approval", () => {
  const approved = payloadHash(approvalSubject("exec", { command: "npm test" }));
  const hijacked = payloadHash(approvalSubject("exec", { command: "npm test", env: { PATH: "/tmp/evil" } }));
  assert.notEqual(hijacked, approved, "an injected PATH must not ride an approval the user gave for `npm test`");
});

test("moving an approved command to another directory invalidates it", () => {
  const approved = payloadHash(approvalSubject("exec", { command: "rm -rf build" }));
  const elsewhere = payloadHash(approvalSubject("exec", { command: "rm -rf build", cwd: "../other-project" }));
  assert.notEqual(elsewhere, approved);
});

test("running an approved string through a different interpreter invalidates it", () => {
  const asBash = payloadHash(approvalSubject("exec", { command: "print(1)", kind: "bash" }));
  const asPython = payloadHash(approvalSubject("exec", { command: "print(1)", kind: "python" }));
  assert.notEqual(asBash, asPython);
});

test("dropping the sandbox the card promised invalidates the approval", () => {
  // The user was shown "in a sandbox on your computer" and clicked Allow.
  const inSandbox = payloadHash(approvalSubject("exec", { command: "npm i", sandbox: true }));
  const onTheHost = payloadHash(approvalSubject("exec", { command: "npm i", sandbox: false }));
  assert.notEqual(onTheHost, inSandbox, "the promise on the card has to be the promise in the token");
});

test("env binding is order-independent — canonicalisation, not luck", () => {
  const a = payloadHash(approvalSubject("exec", { command: "x", env: { A: "1", B: "2" } }));
  const b = payloadHash(approvalSubject("exec", { command: "x", env: { B: "2", A: "1" } }));
  assert.equal(a, b, "two sides serialising the same env must agree, whatever key order they built it in");
});

test("the subject carries its version, so an old daemon can never collide with a new app", () => {
  // A v1 daemon computes {tool, command}; a v2 app computes {v:2, ...}. Without
  // the tag, a future subject that happened to reduce to the same fields would
  // silently be accepted by both. With it, the mismatch is total and loud.
  for (const tool of ["exec", "writeFile", "deleteFile", "ensureDir"]) {
    assert.equal(approvalSubject(tool, { command: "x", path: "p", content: "c" }).v, 2, `${tool} must carry the version`);
  }
});

/**
 * A signer that never sees the bytes.
 *
 * The engine holds the content; the app holds the key. Sending the content to
 * the app just to sign it would move megabytes twice and put the user's file
 * through a component that has no reason to read it — so the app is handed the
 * digest. This only works if the digest route and the bytes route produce the
 * SAME subject; the day they diverge, every approved write on a user's own
 * computer fails with "payload_mismatch" and nothing says why.
 */
test("a digest-only signer derives the same subject as one holding the bytes", () => {
  const bytes = Buffer.from("hello", "utf8");
  const withBytes = approvalSubject("writeFile", { path: "src/a.ts", content: bytes });
  const withDigest = approvalSubject("writeFile", { path: "src/a.ts", contentSha256: sha256Hex(bytes) });
  assert.deepEqual(withDigest, withBytes);
  assert.equal(payloadHash(withDigest), payloadHash(withBytes));
});

test("the bytes win over a digest handed in alongside them", () => {
  // Otherwise a stray field decides what gets signed, and the approval would
  // cover content nobody wrote.
  const s = approvalSubject("writeFile", { path: "a", content: "real", contentSha256: sha256Hex("other") });
  assert.equal(s.contentSha256, sha256Hex(Buffer.from("real", "utf8")));
});

test("a malformed digest is refused rather than signed", () => {
  assert.throws(() => approvalSubject("writeFile", { path: "a", contentSha256: "nope" }), /64 lowercase hex/);
});
