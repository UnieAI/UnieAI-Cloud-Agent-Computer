/**
 * auth.timing-safe.test.mjs — signature and bearer comparisons must not leak
 * timing. Run: node --test runtime/apps/sandbox-runtime/src/shared/auth.timing-safe.test.mjs
 *
 * The HS256 verify compared `expected !== sigB64` — a byte-by-byte early-exit
 * compare that lets a network-adjacent caller learn a valid signature prefix
 * one byte at a time. Same for the plain shared-bearer path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SANDBOX_INTERNAL_TOKEN = "internal-test-token";
process.env.SANDBOX_JWT_SECRET = "jwt-secret-for-tests";

const { verifyInternalToken, mintSandboxJwt } = await import("./auth.mjs");
const src = readFileSync(new URL("./auth.mjs", import.meta.url), "utf8");

const req = (authorization) => ({ headers: { authorization } });

test("source pin: comparisons go through crypto.timingSafeEqual, no `!==`/`===` on the signature or bearer", () => {
  assert.match(src, /timingSafeEqual\(/);
  assert.doesNotMatch(src, /expected\s*!==\s*sigB64/);
  assert.doesNotMatch(src, /supplied\s*===\s*config\.internalToken/);
});

test("a signature of the wrong LENGTH is rejected without throwing (timingSafeEqual requires equal lengths)", () => {
  const tok = mintSandboxJwt({ sessionId: "s1", ttlSec: 60 });
  const [h, p] = tok.split(".");
  assert.equal(verifyInternalToken(req(`Bearer ${h}.${p}.short`)).ok, false);
  assert.equal(verifyInternalToken(req(`Bearer ${h}.${p}.`)).ok, false);
  assert.equal(verifyInternalToken(req(`Bearer ${h}.${p}.${"A".repeat(200)}`)).ok, false);
});

test("a tampered signature of the RIGHT length is rejected; the real one still passes", () => {
  const tok = mintSandboxJwt({ sessionId: "s1", ttlSec: 60 });
  const parts = tok.split(".");
  const flipped = parts[2].slice(0, -1) + (parts[2].endsWith("A") ? "B" : "A");
  assert.equal(verifyInternalToken(req(`Bearer ${parts[0]}.${parts[1]}.${flipped}`)).ok, false);
  assert.equal(verifyInternalToken(req(`Bearer ${tok}`)).ok, true);
});

test("plain bearer: exact match passes, prefix / wrong length / different token fail", () => {
  assert.equal(verifyInternalToken(req("Bearer internal-test-token")).ok, true);
  assert.equal(verifyInternalToken(req("Bearer internal-test-toke")).ok, false);
  assert.equal(verifyInternalToken(req("Bearer internal-test-token-and-more")).ok, false);
  assert.equal(verifyInternalToken(req("Bearer xnternal-test-token")).ok, false);
});
