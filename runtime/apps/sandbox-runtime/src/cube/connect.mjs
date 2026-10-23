/**
 * cube/connect.mjs — Minimal Connect-RPC client helpers.
 *
 * CubeSandbox / E2B envd exposes its process + filesystem APIs as Connect-RPC
 * services. Connect is gRPC-compatible but also speaks plain HTTP+JSON which
 * is all we need here (no proto codegen required).
 *
 * Wire formats supported:
 *
 *   Unary (request → single response):
 *     POST {base}/{service}/{method}
 *     Headers:
 *       Content-Type: application/json
 *       Connect-Protocol-Version: 1
 *       (Auth header supplied by caller, e.g. X-Access-Token)
 *     Body: JSON-encoded request message
 *     Response: 200 with JSON-encoded response message OR error envelope.
 *
 *   Server-streaming (request → stream of responses):
 *     POST {base}/{service}/{method}
 *     Headers:
 *       Content-Type: application/connect+json
 *       Connect-Protocol-Version: 1
 *     Body: JSON-encoded request message
 *     Response: 200, body is a sequence of length-prefixed envelopes:
 *
 *         | flags (1B) | length (4B BE) | payload (length bytes) |
 *
 *       flags bit 0 = end-of-stream marker (payload is trailer JSON
 *       with "error" and "metadata" fields).
 *
 *       Messages with flags=0 are normal stream items (response proto JSON).
 *
 * References:
 *   · https://connectrpc.com/docs/protocol
 *   · packages/envd/spec/process/process.proto (e2b-dev/infra)
 */

import { ConnectError } from "../shared/error.mjs";

const PROTOCOL_VERSION = "1";

function buildHeaders({ contentType, auth, extra }) {
  const headers = {
    "content-type": contentType,
    "connect-protocol-version": PROTOCOL_VERSION,
    ...(extra || {})
  };
  if (auth) Object.assign(headers, auth);
  return headers;
}

/**
 * Call a unary Connect-RPC method. Returns the parsed JSON response.
 * Throws ConnectError on transport / non-200 / Connect error envelope.
 */
export async function connectUnary({ baseUrl, service, method, body = {}, auth, fetchImpl = fetch, signal } = {}) {
  const url = `${String(baseUrl || "").replace(/\/+$/, "")}/${service}/${method}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: buildHeaders({ contentType: "application/json", auth }),
    body: JSON.stringify(body || {}),
    signal
  });

  // Connect always uses status 200 for application-level outcomes, but
  // proxies and HTTP-layer issues still surface as non-200. Handle both.
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* ignore */ }
    throw new ConnectError(
      payload?.code || "http_error",
      payload?.message || `Connect unary failed: HTTP ${res.status}`,
      res.status,
      { service, method, raw: payload }
    );
  }
  return res.json();
}

/**
 * Async generator yielding parsed JSON messages from a server-streaming RPC.
 *
 * Caller receives one yield per stream item, plus a final trailer object of
 * shape `{ __trailer: true, error?: {...} }`. Caller should treat the trailer
 * as end-of-stream; the iterator naturally stops afterwards.
 *
 * If the server responds with non-200 BEFORE streaming starts, we throw a
 * ConnectError synchronously. Mid-stream errors arrive in the trailer.
 */
export async function* connectServerStream({ baseUrl, service, method, body = {}, auth, fetchImpl = fetch, signal } = {}) {
  const url = `${String(baseUrl || "").replace(/\/+$/, "")}/${service}/${method}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: buildHeaders({ contentType: "application/connect+json", auth }),
    body: JSON.stringify(body || {}),
    signal
  });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* ignore */ }
    throw new ConnectError(
      payload?.code || "http_error",
      payload?.message || `Connect stream failed: HTTP ${res.status}`,
      res.status,
      { service, method, raw: payload }
    );
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    throw new ConnectError("no_body", "Stream response had no body reader", 500, { service, method });
  }

  let leftover = new Uint8Array(0);

  while (true) {
    let next;
    try { next = await reader.read(); }
    catch (err) {
      if (signal?.aborted) return;
      throw new ConnectError("stream_read_failed", err?.message || String(err), 500, { service, method });
    }
    if (next.done) return;
    const chunk = next.value;

    const merged = new Uint8Array(leftover.length + chunk.length);
    merged.set(leftover, 0);
    merged.set(chunk, leftover.length);
    leftover = merged;

    while (leftover.length >= 5) {
      const flags = leftover[0];
      const length = (leftover[1] << 24 | leftover[2] << 16 | leftover[3] << 8 | leftover[4]) >>> 0;
      if (leftover.length < 5 + length) break;
      const payloadBytes = leftover.slice(5, 5 + length);
      leftover = leftover.slice(5 + length);

      const text = new TextDecoder("utf-8").decode(payloadBytes);
      let payload = null;
      try { payload = text.length ? JSON.parse(text) : {}; }
      catch (err) {
        throw new ConnectError("parse_failed", `Failed to parse Connect envelope: ${err?.message || err}`, 500, { service, method });
      }

      // flags bit 0 (LSB) set → trailer / end-of-stream metadata.
      if (flags & 0x01) {
        if (payload?.error) {
          throw new ConnectError(
            payload.error.code || "rpc_error",
            payload.error.message || "RPC error",
            502,
            { service, method, raw: payload }
          );
        }
        yield { __trailer: true, metadata: payload?.metadata || null };
        return;
      }
      yield payload;
    }
  }
}
