// Batch file-write helper. Mirrors the multipart `handleUpload` route
// but takes a JSON body with N files in one round trip.
//
// Used by the agent runtime's workspace-projection step (Wave-4 Step 1)
// to land DB-resident config (skills / memory / AGENT.md) onto the
// workspace without paying N HTTP round trips per sandbox alloc.
//
// Contract: partial-success — every file gets a per-entry result row.
// Caller decides whether a partial failure is fatal (projection logs
// failures, proceeds with the successful files).

import { SandboxError } from "../shared/error.mjs";

const MAX_BATCH = 500;
const SUPPORTED_ENCODINGS = new Set(["utf-8", "utf8", "base64"]);

/**
 * Validate + decode a single file entry. Returns either
 *   { ok: true, content: Buffer|string, size }
 * or
 *   { ok: false, error }
 */
function decodeEntry(entry) {
  const filePath = typeof entry?.path === "string" ? entry.path : "";
  if (!filePath) {
    return { ok: false, error: "path required" };
  }
  const enc = typeof entry?.encoding === "string" && entry.encoding
    ? entry.encoding
    : "utf-8";
  if (!SUPPORTED_ENCODINGS.has(enc)) {
    return { ok: false, error: `unsupported encoding: ${enc}` };
  }
  try {
    if (enc === "base64") {
      const content = Buffer.from(String(entry?.content || ""), "base64");
      return { ok: true, content, size: content.length };
    }
    const content = String(entry?.content ?? "");
    return { ok: true, content, size: Buffer.byteLength(content) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Process the parsed batch body. Calls `backend.writeFile(sandboxId,
 * path, content)` for each valid entry; collects per-entry results.
 *
 * `backend` is the resolved sandbox-runtime backend (stub / docker /
 * cube envd). The route handler injects it; tests inject a stub
 * directly without touching getBackend().
 */
export async function processBatchWrite({ sandboxId, body, backend } = {}) {
  if (!sandboxId) {
    throw new SandboxError("bad_request", "sandboxId required", 400);
  }
  if (!backend || typeof backend.writeFile !== "function") {
    throw new SandboxError("backend_misconfigured", "backend.writeFile unavailable", 500);
  }
  const files = Array.isArray(body?.files) ? body.files : null;
  if (!files) {
    throw new SandboxError("bad_request", "files: array of {path, content} required", 400);
  }
  if (files.length > MAX_BATCH) {
    throw new SandboxError("bad_request", `batch capped at ${MAX_BATCH} files`, 400);
  }

  const results = [];
  for (const entry of files) {
    const decoded = decodeEntry(entry);
    const filePath = typeof entry?.path === "string" ? entry.path : "";
    if (!decoded.ok) {
      results.push({ path: filePath, ok: false, error: decoded.error });
      continue;
    }
    try {
      // `body.approval`: the Rabi Local approval token for this write (relay backend only).
      await backend.writeFile(sandboxId, filePath, decoded.content, { approval: typeof body?.approval === "string" ? body.approval : null });
      results.push({ path: filePath, ok: true, size: decoded.size });
    } catch (err) {
      results.push({
        path: filePath,
        ok: false,
        error: err?.message || String(err),
        code: err?.code || null
      });
    }
  }

  const okCount = results.filter((r) => r.ok).length;

  // (Removed: write-through sync to user S3. Each backend.writeFile above lands
  // its bytes on the weed-mount, i.e. DIRECTLY in S3 — the manifest API + Files
  // panel read that same store, so there is nothing to push. The old sync was a
  // no-op under FUSE. See docs/plan-remove-stub-subsystem.md.)

  return {
    ok: okCount === results.length,
    written: okCount,
    total: results.length,
    results
  };
}

// Exposed for tests + parity with other modules.
export const _internal = { MAX_BATCH, SUPPORTED_ENCODINGS, decodeEntry };
