/**
 * workspace/guard.mjs — Path sanitation, ported from
 *   external/copilot-v2/lib/agent/workspace-guard.ts
 *
 * Goal: prevent path escapes when callers supply user-influenced paths.
 * Keeps only the subset we use in Phase 1 (relative-path normalisation +
 * single-root readable resolver). Full multi-root readable variants live in
 * copilot-v2; if/when needed, port them verbatim here.
 */

import path from "node:path";

import { SandboxError } from "../shared/error.mjs";

function normalizeRoot(root) {
  const normalized = path.posix.normalize(root || "/workspace");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function invalidPathError(label) {
  return new SandboxError("invalid_path", `invalid ${label}`, 400);
}

export function toWorkspaceRelativePath(input, workdir, { allowEmpty = true, label = "path" } = {}) {
  const normalizedWorkdir = normalizeRoot(workdir);
  // Unicode-normalize to NFC. Filenames with CJK/accented chars can arrive in
  // NFD (e.g. macOS) on upload but NFC when the model re-emits the path in a
  // read/write tool call (LLMs normalize to NFC). Without this, the WRITE key
  // and the READ lookup differ for the same visible name → "file not found".
  // Both write and read flow through here, so normalizing once keeps them in
  // lockstep on NFC.
  const rawValue = String(input || "").trim().normalize("NFC");
  const normalizedInput = path.posix.normalize(rawValue || "");

  if (!normalizedInput || normalizedInput === ".") {
    if (allowEmpty) return "";
    throw invalidPathError(label);
  }

  if (normalizedInput === normalizedWorkdir) {
    if (allowEmpty) return "";
    throw invalidPathError(label);
  }

  if (normalizedInput.startsWith(`${normalizedWorkdir}/`)) {
    return normalizedInput.slice(normalizedWorkdir.length + 1);
  }

  // The agent (and any browser proxy in front of it) refers to the
  // workspace by its canonical mount path `/workspace`, regardless
  // of where the sandbox backend's filesystem actually puts it. The
  // stub backend mounts it under /tmp/stub-sandboxes/<id>/workspace,
  // so a path like "/workspace/foo.png" coming from the FE wouldn't
  // match the actual workdir and would be rejected as
  // invalid_path (400). Accept the canonical alias and strip it.
  if (normalizedInput === "/workspace") {
    if (allowEmpty) return "";
    throw invalidPathError(label);
  }
  if (normalizedInput.startsWith("/workspace/")) {
    return normalizedInput.slice("/workspace/".length);
  }

  if (normalizedInput.startsWith("/")) {
    throw invalidPathError(label);
  }

  const trimmed = normalizedInput.replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!trimmed || trimmed === ".") {
    if (allowEmpty) return "";
    throw invalidPathError(label);
  }

  if (
    trimmed === ".." ||
    trimmed.startsWith("../") ||
    trimmed.includes("/../") ||
    trimmed.endsWith("/..")
  ) {
    throw invalidPathError(label);
  }

  return trimmed;
}

export function toWorkspaceAbsolutePath(input, workdir, options) {
  const relativePath = toWorkspaceRelativePath(input, workdir, options);
  const normalizedWorkdir = normalizeRoot(workdir);
  return relativePath ? path.posix.join(normalizedWorkdir, relativePath) : normalizedWorkdir;
}

export function getSandboxWritablePaths(workdir) {
  return [normalizeRoot(workdir)];
}
