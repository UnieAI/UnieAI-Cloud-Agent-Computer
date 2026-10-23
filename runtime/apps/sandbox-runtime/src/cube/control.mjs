/**
 * cube/control.mjs — CubeAPI / E2B control-plane HTTP client.
 *
 * Endpoints (from e2b-dev/infra spec/openapi.yml — CubeAPI is wire-compatible):
 *
 *   POST   /sandboxes                      create from template (NewSandbox → Sandbox)
 *   DELETE /sandboxes/{sandboxID}          kill
 *   POST   /sandboxes/{sandboxID}/pause    pause
 *   POST   /sandboxes/{sandboxID}/resume   resume
 *   GET    /v2/sandboxes                   list (paginated)
 *   POST   /sandboxes/{sandboxID}/snapshots create snapshot (when supported)
 *
 * Authentication: X-API-Key header.
 *
 * Returned Sandbox shape (subset we use):
 *   {
 *     sandboxID: "i-abc123",
 *     templateID: "...",
 *     clientID: "...",
 *     envdVersion: "...",
 *     envdAccessToken: "<secure-token>",
 *     trafficAccessToken: "<token>" | null,
 *     domain: "<base-domain>" | null
 *   }
 *
 * The envd is reachable at the per-sandbox URL constructed in cube/envd.mjs
 * from `sandboxID`, `clientID` and `domain`.
 */

import { SandboxError } from "../shared/error.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;

function headers(apiKey, extra) {
  const h = {
    "content-type": "application/json",
    accept: "application/json",
    ...(extra || {})
  };
  if (apiKey) h["x-api-key"] = apiKey;
  return h;
}

async function expectOk(res, label) {
  if (res.ok) return res;
  let payload = null;
  try { payload = await res.json(); } catch { /* ignore */ }
  throw new SandboxError(
    payload?.code || "cube_api_error",
    payload?.message || `${label} failed: HTTP ${res.status}`,
    res.status,
    { label, body: payload }
  );
}

export function createControlClient({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const normalizedBase = String(baseUrl || "").replace(/\/+$/, "");
  if (!normalizedBase) {
    throw new SandboxError("invalid_config", "CUBE_API_URL is required when SANDBOX_MODE=cube", 500);
  }

  // Build an abort-with-deadline signal AND a `cancel()` callback the caller
  // must invoke after fetch resolves so the timer doesn't keep the event
  // loop alive for the full timeoutMs after each successful request.
  function withTimeout(signal) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { signal, cancel() {} };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("cube_api_timeout")), timeoutMs);
    if (signal) {
      signal.addEventListener("abort", () => ctrl.abort(signal.reason), { once: true });
    }
    return {
      signal: ctrl.signal,
      cancel() { clearTimeout(timer); }
    };
  }

  // Small wrapper to ensure the deadline timer is cleared whether fetch
  // resolves OR rejects. Without this, a successful fetch keeps a 30s
  // ref-counted timer alive — fine in long-running services, but nasty
  // for tests / short-lived scripts.
  async function fetchWithDeadline(url, opts = {}, callerSignal) {
    const { signal, cancel } = withTimeout(callerSignal);
    try {
      return await fetchImpl(url, { ...opts, signal });
    } finally {
      cancel();
    }
  }

  async function createSandboxRaw({ templateId, timeoutSec = 900, autoPause = false, envVars, metadata, network, signal } = {}) {
    if (!templateId) throw new SandboxError("invalid_request", "templateId is required", 400);
    const body = {
      templateID: String(templateId),
      timeout: Math.max(1, Number(timeoutSec) || 900),
      autoPause: Boolean(autoPause)
    };
    if (envVars && typeof envVars === "object") body.envVars = envVars;
    if (metadata && typeof metadata === "object") body.metadata = metadata;
    if (network && typeof network === "object") body.network = network;

    const res = await fetchWithDeadline(`${normalizedBase}/sandboxes`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body)
    }, signal);
    await expectOk(res, "createSandbox");
    return res.json();
  }

  async function destroySandbox(sandboxId, { signal } = {}) {
    const res = await fetchWithDeadline(`${normalizedBase}/sandboxes/${encodeURIComponent(sandboxId)}`, {
      method: "DELETE",
      headers: headers(apiKey)
    }, signal);
    if (res.status === 404) return; // already gone
    await expectOk(res, "destroySandbox");
  }

  async function pauseSandbox(sandboxId, { signal } = {}) {
    const res = await fetchWithDeadline(`${normalizedBase}/sandboxes/${encodeURIComponent(sandboxId)}/pause`, {
      method: "POST",
      headers: headers(apiKey)
    }, signal);
    await expectOk(res, "pauseSandbox");
  }

  async function resumeSandbox(sandboxId, { timeoutSec = 900, autoPause = false, signal } = {}) {
    const res = await fetchWithDeadline(`${normalizedBase}/sandboxes/${encodeURIComponent(sandboxId)}/resume`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ timeout: timeoutSec, autoPause })
    }, signal);
    await expectOk(res, "resumeSandbox");
    return res.json().catch(() => ({}));
  }

  async function listSandboxes({ metadata, state, nextToken, limit, signal } = {}) {
    const params = new URLSearchParams();
    if (metadata) params.set("metadata", metadata);
    if (state) {
      const states = Array.isArray(state) ? state.join(",") : String(state);
      params.set("state", states);
    }
    if (nextToken) params.set("nextToken", nextToken);
    if (limit) params.set("limit", String(limit));
    const url = `${normalizedBase}/v2/sandboxes${params.toString() ? `?${params}` : ""}`;
    const res = await fetchWithDeadline(url, { headers: headers(apiKey) }, signal);
    await expectOk(res, "listSandboxes");
    return res.json();
  }

  async function snapshotSandbox(sandboxId, { signal } = {}) {
    const res = await fetchWithDeadline(`${normalizedBase}/sandboxes/${encodeURIComponent(sandboxId)}/snapshots`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({})
    }, signal);
    if (res.status === 404 || res.status === 501) {
      // CubeSandbox ships snapshot support incrementally — caller falls back
      // to volume-only preservation when this endpoint is absent.
      throw new SandboxError("snapshot_not_supported", "Snapshot is not available on this CubeAPI cluster", 501);
    }
    await expectOk(res, "snapshotSandbox");
    return res.json().catch(() => ({}));
  }

  return {
    createSandboxRaw,
    destroySandbox,
    pauseSandbox,
    resumeSandbox,
    listSandboxes,
    snapshotSandbox,
    baseUrl: normalizedBase
  };
}
