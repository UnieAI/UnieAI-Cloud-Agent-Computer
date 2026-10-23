/**
 * files/upload.mjs — Single-file raw upload.
 *
 * POST /v1/sandboxes/:id/upload?path=relative/path.ext
 * Body: raw bytes (any content-type). Target path goes through workspace/guard.
 *
 * Phase 2 will add multipart (multi-file batch) as a separate endpoint.
 */

import { getBackend } from "../cube/index.mjs";
import { getActive, touchActivity } from "../pool/manager.mjs";
import { toWorkspaceRelativePath } from "../workspace/guard.mjs";
import { SandboxError } from "../shared/error.mjs";
import { config } from "../config.mjs";

const MAX_UPLOAD_BYTES = Math.max(1, config.artifact.maxBytes);

async function readBodyToBuffer(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        reject(new SandboxError("payload_too_large", `Upload exceeds ${MAX_UPLOAD_BYTES} bytes`, 413));
        try { req.destroy(); } catch { /* noop */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function handleUpload({ sandboxId, req, url }) {
  getActive(sandboxId);
  const targetPathRaw = url.searchParams.get("path") || "";
  if (!targetPathRaw) {
    throw new SandboxError("bad_request", "upload requires ?path=<relative path>", 400);
  }
  const entry = getActive(sandboxId);
  const workdir = entry.workspaceDir || "/workspace";
  const relPath = toWorkspaceRelativePath(targetPathRaw, workdir, { allowEmpty: false, label: "path" });
  const body = await readBodyToBuffer(req);
  const backend = getBackend(sandboxId);
  // backend.writeFile lands the bytes at the weed-mount path, i.e. DIRECTLY in
  // the S3 store (`/workspace` IS S3) — no write-through sync needed; the panel
  // reads the same store. (Removed: syncSandboxToUser write-through, a no-op
  // under FUSE. See docs/plan-remove-stub-subsystem.md.)
  await backend.writeFile(sandboxId, relPath, body);
  touchActivity(sandboxId);

  return { path: relPath, size: body.length };
}
