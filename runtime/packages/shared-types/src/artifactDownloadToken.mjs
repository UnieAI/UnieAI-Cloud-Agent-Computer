/**
 * artifactDownloadToken.mjs — HMAC-signed artifact download tokens.
 *
 * The cm-agent stream advertises artifacts via an opaque studio URL —
 * `${STUDIO_BASE_URL}/api/agent/artifacts/:token` — instead of a raw S3
 * signed URL. The studio-web handler verifies this token, looks up the
 * artifact inside the session's persisted list (cm_agent_sessions.
 * settings_json.artifacts) and streams the bytes out from S3 server-side.
 * The underlying S3 URL is never exposed to the client.
 *
 * Shared between llm-runtime (mints on artifact persist) and studio-web
 * (verifies on user download). Both resolve the HMAC secret from the same
 * env cascade so a token minted by either side round-trips cleanly.
 *
 * Token shape:
 *   base64url(json({ sid, aid, exp })) + "." + base64url(hmac256(payload, secret))
 *
 * Secret resolution (cascade):
 *   1. `AGENT_ARTIFACT_DOWNLOAD_SECRET` — operator override
 *   2. `USER_API_KEY_ENCRYPTION_KEY`    — reuse the studio-wide secret so
 *                                         dev / Docker installs work with
 *                                         no additional config
 *   3. `RUNTIME_INTERNAL_TOKEN`         — last-ditch fallback
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const TTL_OVERRIDE_MS = Number(process.env.AGENT_ARTIFACT_DOWNLOAD_TTL_MS) || DEFAULT_TTL_MS;

function getSecret() {
  const v =
    process.env.AGENT_ARTIFACT_DOWNLOAD_SECRET ||
    process.env.USER_API_KEY_ENCRYPTION_KEY ||
    process.env.RUNTIME_INTERNAL_TOKEN ||
    // Guaranteed-present fallback: NextAuth's secret is required for the app
    // to run at all, and both sides (llm-runtime mints, copilot-v2 web
    // verifies) load the same root .env — so this "just works" with zero
    // extra config in dev / Docker. Keep it LAST so an explicit override
    // still wins when an operator wants a dedicated key.
    process.env.NEXTAUTH_SECRET ||
    "";
  if (!v) {
    throw new Error("artifact_download: no signing secret available (set AGENT_ARTIFACT_DOWNLOAD_SECRET or NEXTAUTH_SECRET)");
  }
  return v;
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/**
 * Mint a download token. Returns the string to embed in the URL.
 *
 * @param sessionId   {string} owning session
 * @param artifactId  {string} per-session artifact identifier (see
 *                             storage/artifacts.mjs ensureArtifactId)
 * @param ttlMs       {number} override TTL; defaults to 1 hour
 */
export function mintDownloadToken({ sessionId, artifactId, ttlMs = TTL_OVERRIDE_MS } = {}) {
  if (!sessionId) throw new Error("mintDownloadToken: sessionId required");
  if (!artifactId) throw new Error("mintDownloadToken: artifactId required");
  const exp = Date.now() + Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS);
  const payload = JSON.stringify({ sid: sessionId, aid: artifactId, exp });
  const payloadB64 = base64url(payload);
  const sig = createHmac("sha256", getSecret()).update(payloadB64).digest();
  return `${payloadB64}.${base64url(sig)}`;
}

/**
 * Verify a token. Returns `{ sessionId, artifactId }` on success, throws on
 * any failure (invalid signature, expired, malformed).
 */
export function verifyDownloadToken(token) {
  if (typeof token !== "string" || !token.includes(".")) {
    throw new Error("invalid_token");
  }
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) throw new Error("invalid_token");

  const expectedSig = createHmac("sha256", getSecret()).update(payloadB64).digest();
  const givenSig = fromBase64url(sigB64);
  if (givenSig.length !== expectedSig.length || !timingSafeEqual(givenSig, expectedSig)) {
    throw new Error("signature_mismatch");
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64url(payloadB64).toString("utf8"));
  } catch {
    throw new Error("malformed_payload");
  }
  if (!payload?.sid || !payload?.aid || !payload?.exp) throw new Error("malformed_payload");
  if (Number(payload.exp) < Date.now()) throw new Error("token_expired");

  return { sessionId: String(payload.sid), artifactId: String(payload.aid) };
}
