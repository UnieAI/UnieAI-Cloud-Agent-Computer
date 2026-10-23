/**
 * dir-sync.mjs — reconcile EMPTY directories created by bash into the manifest.
 *
 * S3 has no real directories: a dir exists only while files imply it, and this
 * SeaweedFS filer's flat ListObjects does NOT emit marker entries for empty
 * FUSE-created dirs (verified live — `mkdir /workspace/empty-test` was
 * invisible to the panel). The container's own filesystem view is the ONE
 * place empty dirs are reliably observable, so after a mutating exec we run
 * `find /workspace -type d -empty` INSIDE the sandbox and record the result as
 * `kind:"dir"` manifest entries (the same convention the panel's New Folder
 * route writes).
 *
 * Reconcile semantics: this sync OWNS the bash-created empty-dir set — dirs it
 * saw before that are now gone (deleted, or no longer empty because files
 * imply them) are removed from the manifest, while panel-created dir entries
 * whose paths never appeared in a find result are left alone (they may belong
 * to a moment when no sandbox was live). To keep that distinction we tag
 * entries we write with `via:"exec"`.
 *
 * Best-effort + debounced per sandbox: a failure only means the panel misses
 * an empty folder until the next exec / manual create.
 */

import { getBackend } from "../cube/index.mjs";
import { isLocalMachineSandbox } from "../pool/machine-kind.mjs";
import { log } from "../shared/log.mjs";
import { updateManifest, SKIP_WRITE } from "./userStore.mjs";

const DEBOUNCE_MS = 500;
const MAX_DIRS = 200;
const pending = new Map(); // sandboxId → timer

function runFind(sandboxId) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        const backend = getBackend(sandboxId);
        const handle = await backend.execProcess(sandboxId, {
          kind: "bash",
          // -mindepth 1: never list /workspace itself. Exclude system dirs.
          command:
            "find /workspace -mindepth 1 -maxdepth 6 -type d -empty " +
            "-not -path '/workspace/.opencode*' -not -path '/workspace/.unieai*' 2>/dev/null | head -" +
            MAX_DIRS,
          timeoutMs: 15_000,
        });
        let out = "";
        handle.on("stdout", (c) => {
          out += String(c);
        });
        handle.on("exit", ({ error }) => (error ? reject(new Error(error)) : resolve(out)));
        handle.on("error", reject);
      } catch (err) {
        reject(err);
      }
    })();
  });
}

async function sync(sandboxId, owner) {
  const out = await runFind(sandboxId);
  const dirs = new Set(
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("/workspace/"))
      .map((l) => l.slice("/workspace/".length).replace(/\/+$/, ""))
      .filter((rel) => rel && !rel.split("/").some((s) => s === "." || s === "..")),
  );
  // Compare-and-swap: re-reads and re-applies if another writer commits first.
  // The mutation only adds/removes the exec-tagged EMPTY-dir entries this scan
  // observed, so replaying it against a newer baseline keeps whatever else
  // landed in between (an upload's new file, say) instead of stamping over it.
  await updateManifest(owner, (manifest) => {
    manifest.entries = manifest.entries || {};
    let changed = false;
    for (const rel of dirs) {
      const existing = manifest.entries[rel];
      if (existing && existing.kind !== "dir") continue; // a file wins
      if (!existing) {
        manifest.entries[rel] = { kind: "dir", mtimeMs: Date.now(), via: "exec" };
        changed = true;
      }
    }
    // Drop exec-tagged dir entries that no longer exist as EMPTY dirs (deleted,
    // or now implied by files — the S3 listing covers non-empty ones).
    for (const [rel, v] of Object.entries(manifest.entries)) {
      if (v && v.kind === "dir" && v.via === "exec" && !dirs.has(rel)) {
        delete manifest.entries[rel];
        changed = true;
      }
    }
    if (!changed) return SKIP_WRITE; // nothing observed — don't churn the object
    return manifest;
  });
  if (dirs.size > 0) log("info", "workspace.dir_sync", { sandboxId, owner, emptyDirs: dirs.size });
}

/** Debounced entrypoint — call after a mutating exec finishes. */
export function scheduleDirSync({ sandboxId, userId, owner }) {
  // The S3 manifest does not describe a user's own machine (Rabi Local).
  if (isLocalMachineSandbox(sandboxId)) return;
  const ownerKey = owner || userId;
  if (!sandboxId || !ownerKey) return;
  if (pending.has(sandboxId)) return;
  const timer = setTimeout(() => {
    pending.delete(sandboxId);
    sync(sandboxId, ownerKey).catch((err) =>
      log("warn", "workspace.dir_sync_failed", { sandboxId, error: err?.message || String(err) }),
    );
  }, DEBOUNCE_MS);
  timer.unref?.();
  pending.set(sandboxId, timer);
}
