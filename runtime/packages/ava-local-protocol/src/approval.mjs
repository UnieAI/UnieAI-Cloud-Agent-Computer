/**
 * approval.mjs — the one-shot, tamper-evident "the user said yes to THIS".
 *
 * Shape: `base64url(claims).base64url(hmac_sha256(key, base64url(claims)))`.
 * The claims bind the approval to one invoke on one machine for one tool with
 * one payload digest, and expire in two minutes. The daemon verifies with the
 * key it received at pairing; a relay that rewrites the command, replays an
 * old token, or forwards a token meant for another machine gets a named
 * refusal, never an execution.
 *
 * Honest limit (ADR-0005): the key is shared with the app, so this proves the
 * approval passed through the app unchanged — it does not prove the app itself
 * was honest. That needs a signature the user's device makes (WebAuthn), which
 * is the `alg` field's reason to exist.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { payloadHash } from "./canonical.mjs";

export const APPROVAL_TTL_MS = 120_000;

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function sign(key, claimsB64) {
  return createHmac("sha256", key).update(claimsB64).digest();
}

/**
 * @param {string|Buffer} key  the per-machine HMAC key established at pairing
 * @param {object} claims      { invokeId, machineId, userId, sessionId, tool, payloadHash }
 * @param {{ now?: number, ttlMs?: number }} [opts]
 * @returns {string} token
 */
export function mintApprovalToken(key, claims, { now = Date.now(), ttlMs = APPROVAL_TTL_MS } = {}) {
  for (const field of ["invokeId", "machineId", "tool", "payloadHash"]) {
    if (!claims?.[field] || typeof claims[field] !== "string") {
      throw new Error(`mintApprovalToken: ${field} is required`);
    }
  }
  const body = {
    v: 1,
    alg: "hmac",
    invokeId: claims.invokeId,
    machineId: claims.machineId,
    userId: claims.userId ?? null,
    sessionId: claims.sessionId ?? null,
    tool: claims.tool,
    payloadHash: claims.payloadHash,
    iat: now,
    exp: now + ttlMs,
    nonce: randomBytes(12).toString("base64url"),
  };
  const claimsB64 = b64url(JSON.stringify(body));
  return `${claimsB64}.${b64url(sign(key, claimsB64))}`;
}

function decode(token) {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const claimsB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let claims;
  try {
    claims = JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object") return null;
  return { claimsB64, sigB64, claims };
}

/**
 * Verify a token against what the daemon is about to do.
 *
 * @param {string|Buffer} key
 * @param {string} token
 * @param {{ machineId: string, invokeId: string, tool: string, subject?: object, payloadHash?: string }} expect
 * @param {{ now?: number, nonces?: ReturnType<typeof createNonceRegistry> }} [opts]
 * @returns {{ ok: true, claims: object } | { ok: false, reason: string }}
 */
export function verifyApprovalToken(key, token, expect, { now = Date.now(), nonces = null } = {}) {
  const parsed = decode(token);
  if (!parsed) return { ok: false, reason: "malformed" };
  const { claimsB64, sigB64, claims } = parsed;

  const expected = sign(key, claimsB64);
  const given = Buffer.from(sigB64, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }
  if (typeof claims.exp !== "number" || now > claims.exp) return { ok: false, reason: "expired" };
  if (claims.machineId !== expect.machineId) return { ok: false, reason: "machine_mismatch" };
  if (claims.tool !== expect.tool) return { ok: false, reason: "tool_mismatch" };
  // invokeId is optional on the verifying side: the app mints the token before
  // sandbox-runtime assigns the relay's invoke id, so the daemon binds by
  // machine + tool + payload hash + nonce, and checks invokeId only when the
  // caller has one to compare (the audit row does).
  if (expect.invokeId !== undefined && claims.invokeId !== expect.invokeId) return { ok: false, reason: "invoke_mismatch" };

  const wantHash = expect.payloadHash ?? (expect.subject ? payloadHash(expect.subject) : "");
  if (!wantHash || claims.payloadHash !== wantHash) return { ok: false, reason: "payload_mismatch" };

  if (nonces) {
    if (nonces.has(claims.nonce, now)) return { ok: false, reason: "replayed" };
    nonces.add(claims.nonce, claims.exp, now);
  }
  return { ok: true, claims };
}

/**
 * Remembers nonces until their token would have expired anyway, so the set is
 * bounded by "approvals in the last two minutes" rather than by uptime.
 */
export function createNonceRegistry({ ttlMs = APPROVAL_TTL_MS, now = Date.now } = {}) {
  const seen = new Map();
  // `at` lets the verifier's (possibly injected) clock drive pruning, so a test
  // running at t=1000 does not see its nonce evicted by the wall clock.
  const prune = (at) => {
    const t = typeof at === "number" ? at : now();
    for (const [nonce, exp] of seen) if (exp < t) seen.delete(nonce);
  };
  return {
    has(nonce, at) {
      prune(at);
      return seen.has(nonce);
    },
    add(nonce, exp, at) {
      prune(at);
      const t = typeof at === "number" ? at : now();
      seen.set(nonce, typeof exp === "number" ? exp : t + ttlMs);
    },
    get size() {
      return seen.size;
    },
  };
}
