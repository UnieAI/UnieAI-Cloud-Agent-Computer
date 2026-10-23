/**
 * artifacts/persist.mjs — Workspace → S3 sweep.
 *
 * Diff workspace against the baseline manifest taken at allocate time,
 * upload changed/new files to S3 via packages/storage-engine, return signed
 * URLs that the client can use even after the sandbox is destroyed.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";

import { putObject, getSignedUrl } from "../../../../packages/storage-engine/src/index.mjs";

import { tenantObjectLocation } from "../workspace/tenant-store.mjs";

import { config } from "../config.mjs";
import { getBackend } from "../cube/index.mjs";
import { getActive } from "../pool/manager.mjs";
import { walkWorkspace, diffAgainstBaseline, safeArtifactKey } from "../files/walk.mjs";
import { SandboxError } from "../shared/error.mjs";
import { log } from "../shared/log.mjs";

const baselines = new Map(); // sandboxId -> baseline array

export async function captureBaseline(sandboxId) {
  const baseline = await walkWorkspace(sandboxId, "/");
  baselines.set(sandboxId, baseline);
  return baseline;
}

export function clearBaseline(sandboxId) {
  baselines.delete(sandboxId);
}

function inferContentType(filename) {
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".csv") || lower.endsWith(".log")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

export async function persistArtifacts({ sandboxId, userId, sessionId } = {}) {
  const entry = getActive(sandboxId);
  const effectiveUserId = userId || entry.userId;
  const effectiveSessionId = sessionId || entry.sessionId;
  const baseline = baselines.get(sandboxId) || [];
  const current = await walkWorkspace(sandboxId, "/");
  const changed = diffAgainstBaseline(current, baseline);

  const backend = getBackend(sandboxId);
  const maxBytes = config.artifact.maxBytes;
  const ttlSec = config.artifact.urlTtlSec;
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
  const ulid = randomUUID().replace(/-/g, "").slice(0, 16);

  const artifacts = [];
  const skipped = [];

  for (const change of changed) {
    if (Number(change.size) > maxBytes) {
      skipped.push({ ...change, reason: "exceeds_max_bytes" });
      continue;
    }
    let body;
    try {
      body = await backend.readFile(sandboxId, change.path);
    } catch (err) {
      skipped.push({ ...change, reason: `read_failed:${err?.message || err}` });
      continue;
    }
    const filename = path.posix.basename(change.path);
    const key = safeArtifactKey(effectiveUserId, effectiveSessionId, ulid, filename);
    // Artifacts are TENANT bytes, so they follow the tenant's bucket. They are
    // not under `workspace/` (the key is
    // `cm-agent-artifacts/<uid>/<sid>/<ulid>/<name>`), hence the object
    // constructor rather than the workspace one. For a tenant that has not
    // been isolated the location's bucket is null → the configured shared
    // bucket → byte-identical to what shipped before.
    const at = tenantObjectLocation(effectiveUserId, key);
    const contentType = inferContentType(filename);
    try {
      await putObject({ at, body, contentType });
    } catch (err) {
      skipped.push({ ...change, reason: `s3_upload_failed:${err?.message || err}` });
      continue;
    }
    let signedUrl;
    try {
      // Signed from the SAME location the bytes went to, so an isolated
      // tenant's URL cannot point at the shared bucket the write never touched.
      signedUrl = await getSignedUrl({ at, expiresIn: ttlSec });
    } catch (err) {
      skipped.push({ ...change, reason: `signed_url_failed:${err?.message || err}` });
      continue;
    }
    artifacts.push({
      name: filename,
      path: change.path,
      size: change.size,
      content_type: contentType,
      s3_key: key,
      signed_url: signedUrl,
      expires_at: expiresAt
    });
  }

  log("info", "artifacts.persisted", {
    sandboxId,
    sessionId: effectiveSessionId,
    count: artifacts.length,
    skipped: skipped.length
  });

  return { artifacts, skipped };
}

export function getBaselineCount(sandboxId) {
  return (baselines.get(sandboxId) || []).length;
}
