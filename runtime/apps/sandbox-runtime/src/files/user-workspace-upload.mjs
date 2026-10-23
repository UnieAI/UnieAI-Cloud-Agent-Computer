/**
 * files/user-workspace-upload.mjs — Per-user workspace upload, no sandbox.
 *
 * POST /v1/users/:userId/workspace/file?path=relative/path.ext
 * Body: raw bytes. Content-Type from req headers is recorded on the blob.
 *
 * Why a separate endpoint from /v1/sandboxes/:id/upload:
 *   - We want users to be able to upload to their persistent workspace
 *     without first standing up a session sandbox (the file panel on
 *     /ap/<id> works pre-session). The sandbox-bound /upload allocates
 *     a sandbox via getActive(); this one bypasses that entirely.
 *   - Bytes go into S3 directly via the content-addressed blob layout
 *     (userStore.writeBlob), and the manifest is updated to expose the
 *     new entry to subsequent sandbox hydrations.
 *
 * Auth: enforced upstream by the Next.js proxy (the userId in the path
 * MUST match the authenticated session's user). This endpoint trusts
 * the path-userId — same posture as /workspace/manifest.
 */

import crypto from "node:crypto";
import { Readable } from "node:stream";

import { config } from "../config.mjs";
import { isPreconditionFailed } from "../../../../packages/storage-engine/src/index.mjs";
import { writeFile, deleteFile, fileKey, updateManifest, ownerKind } from "../workspace/userStore.mjs";
import { toWorkspaceRelativePath } from "../workspace/guard.mjs";
import { isMemoryPath, notifyMemoryChange } from "../workspace/memorySync.mjs";
import { notifySkillChange, skillNameOf } from "../workspace/skillSync.mjs";
import { SandboxError } from "../shared/error.mjs";
import { log } from "../shared/log.mjs";
import { notifyWorkspaceChange } from "../shared/workspace-notify.mjs";
import { quotaService } from "../quota/index.mjs";

/** Per-file cap for a STREAMED upload (config.workspace.userUploadMaxBytes, default 400 MB). */
export const USER_UPLOAD_MAX_BYTES = Math.max(1, Number(config.workspace?.userUploadMaxBytes) || 400 * 1024 * 1024);
/**
 * Per-file cap for a BUFFERED upload — the whole body is held in this shared,
 * multi-tenant process. Defaults to artifact.maxBytes (100 MB), what it was
 * before uploads went to 200 MB. Reached with no `x-upload-size` (the agent's
 * own file writes) and always for memory, skill and conditional-save paths.
 */
export const BUFFERED_UPLOAD_MAX_BYTES = Math.max(1, Number(config.workspace?.bufferedUploadMaxBytes) || Number(config.artifact?.maxBytes) || 100_000_000);
const MAX_UPLOAD_BYTES = BUFFERED_UPLOAD_MAX_BYTES;

/**
 * The size the caller declared (`x-upload-size`, the browser's Content-Length
 * passed through by the app). Null when absent — the buffered path then applies.
 */
function declaredSize(req) {
  const raw = req.headers?.["x-upload-size"];
  if (raw === undefined) return null;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new SandboxError("bad_request", "x-upload-size must be a non-negative integer", 400);
  return n;
}

/**
 * The request body as a stream that hashes and counts as it passes, and fails
 * the moment it carries more than `declared` bytes or ends with fewer. Storage
 * reads it chunk by chunk; nothing here holds the whole file.
 */
function meteredBody(req, declared) {
  const hash = crypto.createHash("sha256");
  let total = 0;
  const stats = { sha256: null, size: 0 };
  async function* gen() {
    for await (const chunk of req) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (total > declared) {
        try { req.destroy?.(); } catch { /* noop */ }
        throw new SandboxError("payload_too_large", `Upload is larger than the declared ${declared} bytes`, 413);
      }
      hash.update(b);
      yield b;
    }
    if (total !== declared) {
      throw new SandboxError("bad_request", `Upload ended after ${total} of ${declared} bytes`, 400);
    }
    stats.sha256 = hash.digest("hex");
    stats.size = total;
  }
  return { body: Readable.from(gen(), { objectMode: false }), stats };
}

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

export async function handleUserWorkspaceUpload({ userId, owner, req, url }) {
  if (!userId) throw new SandboxError("invalid_request", "userId required", 400);
  if (!config.workspace?.userS3Enabled) {
    throw new SandboxError("not_applicable", "per-user workspace not enabled (AGENT_WORKSPACE_S3=0)", 400);
  }
  // S3 prefix owner (user:<id> personal | group:<gid> shared); defaults to the
  // user's own prefix. Memory reverse-sync is personal-only (skip for a group).
  const ownerKey = owner || userId;
  const syncMemory = ownerKind(ownerKey) === "user";

  const targetPathRaw = url.searchParams.get("path") || "";
  if (!targetPathRaw) {
    throw new SandboxError("bad_request", "upload requires ?path=<relative path>", 400);
  }
  const relPath = toWorkspaceRelativePath(targetPathRaw, "/workspace", { allowEmpty: false, label: "path" });

  // Large uploads stream straight into storage (a 200 MB file must not sit in
  // this process's memory). Only when the caller declared the size, and never
  // for the writes whose side effects need the bytes afterwards: conditional
  // editor saves (compare hashes), memory and skill files (mirrored elsewhere).
  const declared = declaredSize(req);
  const conditional = url.pathname.endsWith("file-conditional");
  if (declared !== null && declared > USER_UPLOAD_MAX_BYTES) {
    throw new SandboxError("payload_too_large", `Upload exceeds ${USER_UPLOAD_MAX_BYTES} bytes`, 413);
  }
  const mustBuffer = conditional || isMemoryPath(relPath) || !!skillNameOf(relPath);
  if (declared !== null && declared > 0 && !mustBuffer) {
    // 空間上限：宣告的大小在 header 就知道，**傳之前**就比對剩餘空間（不等傳完才失敗）。
    await quotaService.check({ owner: ownerKey, relPath, incomingBytes: declared });
    return await streamUpload({ userId, ownerKey, relPath, req, declared });
  }
  // Buffered from here on: refuse up front rather than read a body we will reject.
  if (declared !== null && declared > MAX_UPLOAD_BYTES) {
    throw new SandboxError("payload_too_large", `Upload exceeds ${MAX_UPLOAD_BYTES} bytes (this kind of file is held in memory)`, 413);
  }

  // 沒宣告大小（或必須 buffer 的那幾種）：宣告了就先比對；沒宣告的讀完再比對（這種路徑上限是 BUFFERED_UPLOAD_MAX_BYTES，很小）。
  if (declared !== null) await quotaService.check({ owner: ownerKey, relPath, incomingBytes: declared });
  const body = await readBodyToBuffer(req);
  if (declared === null) await quotaService.check({ owner: ownerKey, relPath, incomingBytes: body.length });
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const contentType = req.headers["content-type"] || "application/octet-stream";

  // A-bug guard: a 0-byte body almost always means the upstream BFF
  // serialized a stale File ref (clipboard/drag-drop bytes released
  // before fetch ran). Reject loudly so the caller surfaces a real
  // error instead of letting the manifest grow a 0-byte entry that
  // confuses every downstream reader.
  //
  // Exception: the file-panel "new file" action legitimately creates an
  // empty file and opts in with ?allowEmpty=1. Without this the create
  // 400s and the panel silently drops it ("新增檔案不顯示").
  const allowEmpty = url.searchParams.get("allowEmpty") === "1";
  if (body.length === 0 && !allowEmpty) {
    log("warn", "user_workspace_upload.empty_body", {
      userId, relPath, contentType,
      contentLengthHeader: req.headers["content-length"] || null,
    });
    throw new SandboxError("bad_request", "upload body is empty", 400);
  }

  // Plain-tree: store the bytes at the LOGICAL path so the same object is
  // weed-mountable + S3-API-addressable by name (flat-tree refactor). sha256 is
  // still recorded in the manifest index for change-detection.
  const expectedSha256 = req.headers["x-expected-content-sha256"];
  if (url.pathname.endsWith("file-conditional") && (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256))) {
    throw new SandboxError("bad_request", "conditional writes require a content hash", 400);
  }
  try { await writeFile(ownerKey, relPath, body, contentType, { expectedSha256 }); }
  catch (error) {
    if (isPreconditionFailed(error)) throw new SandboxError("file_conflict", "File changed since it was opened", 409);
    throw error;
  }

  // NFC/NFD twin cleanup: this write is NFC-normalized (guard.mjs), but a bash
  // write over the FUSE mount may have left the SAME visible name under an NFD
  // key — the classic "one file, two rows" duplicate. The bytes just written
  // are authoritative, so drop the stale twin. Best-effort.
  const nfdTwin = relPath.normalize("NFD");
  if (nfdTwin !== relPath) {
    deleteFile(ownerKey, nfdTwin).catch(() => {});
  }

  // Update the manifest so subsequent sandbox hydrations see the file.
  //
  // `updateManifest` is a compare-and-swap: it re-reads and re-applies if
  // another writer commits first, so a parallel upload (chat-input upload
  // racing a sync) cannot overwrite the other's new entry. The mutation below
  // adds ONE path and touches nothing else, which is what makes replaying it
  // on a newer baseline safe.
  const mtimeMs = Date.now();
  await updateManifest(ownerKey, (manifest) => {
    manifest.entries = manifest.entries || {};
    manifest.entries[relPath] = { size: body.length, sha256, mtimeMs };
  });
  quotaService.noteWrite(ownerKey, body.length);

  // (Removed: inject-into-running-sandbox stub. Under the weed-mount FUSE
  // workspace the upload above wrote straight to S3, which IS the sandbox's
  // `/workspace`, so a running sandbox already sees the file via glob/find/ls
  // with zero extra work. See docs/plan-remove-stub-subsystem.md.)

  // Reverse-sync to copilot-v2's memory DB if this write is a memory file
  // (no-op otherwise / when unconfigured). Best-effort, never blocks the upload.
  // Staging (DB→S3) sets x-skip-memory-sync to avoid a staging→callback loop.
  if (syncMemory && req.headers["x-skip-memory-sync"] !== "1") {
    notifyMemoryChange(userId, relPath, "upsert", body);
  }
  // Reverse-sync an authored skill file (personal-only, like memory). The
  // x-skip-skill-sync header lets a future DB→S3 skill staging avoid a loop.
  if (syncMemory && req.headers["x-skip-skill-sync"] !== "1") {
    const sn = skillNameOf(relPath);
    if (sn) notifySkillChange(userId, sn, ownerKey);
  }

  // Panel freshness hint → app workspace-events channel. Covers the ENGINE's
  // direct-S3 file writes (the agent's write/edit tools land here), which the
  // app's own event routes never see. Config-staging bursts opt out via the
  // same skip flags they already send.
  if (req.headers["x-skip-skill-sync"] !== "1" && req.headers["x-skip-memory-sync"] !== "1") {
    notifyWorkspaceChange({ owner: ownerKey, userId, path: relPath, op: "write" });
  }

  return {
    path: relPath,
    size: body.length,
    sha256,
    s3_key: fileKey(ownerKey, relPath),
    content_type: contentType,
  };
}

/** The streaming half of handleUserWorkspaceUpload — same result shape. */
async function streamUpload({ userId, ownerKey, relPath, req, declared }) {
  const contentType = req.headers["content-type"] || "application/octet-stream";
  const { body, stats } = meteredBody(req, declared);
  await writeFile(ownerKey, relPath, body, contentType, { contentLength: declared });
  // The storage write only completes after the generator finished cleanly, so a
  // missing hash here means the stream was cut short without an error surfacing.
  if (!stats.sha256) throw new SandboxError("bad_request", "upload did not complete", 400);

  const nfdTwin = relPath.normalize("NFD");
  if (nfdTwin !== relPath) deleteFile(ownerKey, nfdTwin).catch(() => {});

  const mtimeMs = Date.now();
  await updateManifest(ownerKey, (manifest) => {
    manifest.entries = manifest.entries || {};
    manifest.entries[relPath] = { size: stats.size, sha256: stats.sha256, mtimeMs };
  });
  quotaService.noteWrite(ownerKey, stats.size);
  if (req.headers["x-skip-skill-sync"] !== "1" && req.headers["x-skip-memory-sync"] !== "1") {
    notifyWorkspaceChange({ owner: ownerKey, userId, path: relPath, op: "write" });
  }
  log("info", "user_workspace_upload.streamed", { userId, relPath, size: stats.size });
  return {
    path: relPath,
    size: stats.size,
    sha256: stats.sha256,
    s3_key: fileKey(ownerKey, relPath),
    content_type: contentType,
  };
}
