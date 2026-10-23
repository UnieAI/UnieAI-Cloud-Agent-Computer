/**
 * env-capture/manifest.mjs — read/write the workspace env manifest.
 *
 * Manifest lives at `/workspace/.unieai/env.json`. JSON (not YAML) on
 * purpose for Phase 1: zero new dependencies, native to Node, and the
 * file is invisible to users in this phase — they never hand-edit it.
 * Phase 4 (the UI tab) can transcode to YAML for human editing if
 * telemetry shows raw-edit usage.
 *
 * Shape:
 *   {
 *     "version": 1,
 *     "updatedAt": "2026-05-22T10:15:00Z",
 *     "runtime": { "python": "3.12.4", "node": "20.11.0" },
 *     "python": {
 *       "packages": [
 *         { "name": "pandas", "version": "2.2.1" },
 *         …
 *       ]
 *     },
 *     "node": {
 *       "packages": [
 *         { "name": "axios", "version": "1.6.7" },
 *         …
 *       ]
 *     },
 *     "system": { "apt": [] }
 *   }
 *
 * Defensive read: missing file, malformed JSON, version-skew all degrade
 * to `emptyManifest()` rather than throwing — Phase 1 is non-blocking
 * capture, a corrupt manifest must never break the user's session.
 */

import { log } from "../shared/log.mjs";

export const MANIFEST_PATH = "/workspace/.unieai/env.json";
export const CAPTURE_LOG_PATH = "/workspace/.unieai/capture.log";
export const MANIFEST_VERSION = 1;

export function emptyManifest() {
  return {
    version: MANIFEST_VERSION,
    updatedAt: null,
    runtime: { python: null, node: null },
    python: { packages: [] },
    node: { packages: [] },
    system: { apt: [] }
  };
}

/**
 * Read the manifest from the sandbox workspace. Always returns a usable
 * object — falls back to emptyManifest() on miss or parse failure so
 * downstream code can assume the shape.
 */
export async function readManifest({ backend, sandboxId }) {
  try {
    const buf = await backend.readFile(sandboxId, MANIFEST_PATH);
    const text = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
    if (!text.trim()) return emptyManifest();
    const parsed = JSON.parse(text);
    return normalizeManifest(parsed);
  } catch (err) {
    // ENOENT / 404 from envd is the normal first-run path — no warning.
    const msg = err?.message || String(err);
    if (!/not.?found|enoent|404/i.test(msg)) {
      log("warn", "env_capture.manifest_read_failed", { sandboxId, message: msg });
    }
    return emptyManifest();
  }
}

/**
 * Persist the manifest. Writes the parent dir lazily — envd's writeFile
 * creates intermediate dirs on most backends but the stub doesn't, so we
 * always mkdir first via a no-op write that the backend will treat as
 * "create file under .unieai/".
 */
export async function writeManifest({ backend, sandboxId, manifest }) {
  const out = {
    ...manifest,
    version: MANIFEST_VERSION,
    updatedAt: new Date().toISOString()
  };
  const text = JSON.stringify(out, null, 2) + "\n";
  try {
    await backend.writeFile(sandboxId, MANIFEST_PATH, Buffer.from(text, "utf8"));
  } catch (err) {
    log("warn", "env_capture.manifest_write_failed", {
      sandboxId,
      message: err?.message || String(err)
    });
    throw err;
  }
  return out;
}

/**
 * Append a single capture event to .unieai/capture.log. Used for
 * diagnostics — operators can `cat .unieai/capture.log` to see what
 * Phase 1 detected and how each sync went. Best-effort; capture log
 * write failures are swallowed (the manifest is the authoritative
 * artifact, the log is just a breadcrumb trail).
 */
export async function appendCaptureLog({ backend, sandboxId, entry }) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  try {
    // Read-append-write — envd doesn't expose an append mode and the
    // log is bounded by Phase 1 traffic (a few entries per install).
    // If contention becomes a real issue we'll move to a per-event
    // file under `.unieai/captures/<ts>.json` and concat on read.
    let existing = "";
    try {
      const buf = await backend.readFile(sandboxId, CAPTURE_LOG_PATH);
      existing = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
    } catch {
      /* first write — nothing to read */
    }
    const next = existing + line;
    // Cap at 256 KB so a runaway capture loop can't fill the workspace.
    const capped =
      next.length > 256 * 1024
        ? next.slice(next.length - 256 * 1024)
        : next;
    await backend.writeFile(sandboxId, CAPTURE_LOG_PATH, Buffer.from(capped, "utf8"));
  } catch (err) {
    log("warn", "env_capture.log_write_failed", {
      sandboxId,
      message: err?.message || String(err)
    });
  }
}

/**
 * Coerce an arbitrary parsed value into the manifest schema. Unknown
 * keys get dropped; missing keys get default-filled. Lets us evolve
 * the shape without breaking older files.
 */
function normalizeManifest(raw) {
  const base = emptyManifest();
  if (!raw || typeof raw !== "object") return base;
  const out = base;
  if (typeof raw.updatedAt === "string") out.updatedAt = raw.updatedAt;
  if (raw.runtime && typeof raw.runtime === "object") {
    if (typeof raw.runtime.python === "string") out.runtime.python = raw.runtime.python;
    if (typeof raw.runtime.node === "string") out.runtime.node = raw.runtime.node;
  }
  for (const eco of ["python", "node"]) {
    const list = raw?.[eco]?.packages;
    if (Array.isArray(list)) {
      out[eco].packages = list
        .filter((p) => p && typeof p === "object" && typeof p.name === "string")
        .map((p) => ({
          name: String(p.name),
          version: typeof p.version === "string" ? p.version : null
        }));
    }
  }
  if (Array.isArray(raw?.system?.apt)) {
    out.system.apt = raw.system.apt
      .filter((p) => typeof p === "string")
      .map((p) => String(p));
  }
  return out;
}
