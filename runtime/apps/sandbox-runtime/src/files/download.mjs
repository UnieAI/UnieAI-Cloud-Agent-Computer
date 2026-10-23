/**
 * files/download.mjs — Read a workspace file out as the HTTP response.
 *
 * GET /v1/sandboxes/:id/files?path=relative/path.ext
 */

import { getBackend } from "../cube/index.mjs";
import { getActive, touchActivity } from "../pool/manager.mjs";
import { toWorkspaceRelativePath } from "../workspace/guard.mjs";
import { SandboxError } from "../shared/error.mjs";

function inferMime(filePath) {
  const lower = String(filePath || "").toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".csv") || lower.endsWith(".log")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

export async function handleDownload({ sandboxId, res, url, requestId }) {
  getActive(sandboxId);
  const targetPathRaw = url.searchParams.get("path") || "";
  if (!targetPathRaw) {
    throw new SandboxError("bad_request", "files read requires ?path=<relative path>", 400);
  }
  const entry = getActive(sandboxId);
  const workdir = entry.workspaceDir || "/workspace";
  const relPath = toWorkspaceRelativePath(targetPathRaw, workdir, { allowEmpty: false, label: "path" });

  // Read the bytes straight from the backend. Under the weed-mount FUSE
  // workspace (`/workspace` IS the S3 store) and the host-exec stub backend
  // alike, the backend FS is the live store — there is no separate snapshot to
  // lazy-materialize from, so no stub overlay / manifest indirection is needed.
  const backend = getBackend(sandboxId);
  let buf;
  try {
    buf = await backend.readFile(sandboxId, relPath);
  } catch (err) {
    if (err?.code === "ENOENT" || /not.*found/i.test(err?.message || "")) {
      throw new SandboxError("not_found", `file not found: ${relPath}`, 404);
    }
    throw err;
  }
  touchActivity(sandboxId);
  res.writeHead(200, {
    "content-type": inferMime(relPath),
    "content-length": String(buf.length),
    "x-request-id": requestId || ""
  });
  res.end(buf);
}

export async function handleList({ sandboxId, res, url, requestId }) {
  getActive(sandboxId);
  const rawArg = url.searchParams.get("path");
  const targetPathRaw = rawArg === null || rawArg === "" || rawArg === "/" ? "" : rawArg;
  let relPath = "";
  if (targetPathRaw) {
    const entry = getActive(sandboxId);
    const workdir = entry.workspaceDir || "/workspace";
    relPath = toWorkspaceRelativePath(targetPathRaw, workdir, { allowEmpty: true, label: "path" });
  }
  const backend = getBackend(sandboxId);
  // The backend FS is the live store (weed-mount = S3, or stub host-exec FS),
  // so listFiles reports real sizes directly — no stub-size overlay needed.
  const entries = await backend.listFiles(sandboxId, relPath || "/");
  touchActivity(sandboxId);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "x-request-id": requestId || "" });
  res.end(JSON.stringify({ path: relPath || "/", entries }));
}
