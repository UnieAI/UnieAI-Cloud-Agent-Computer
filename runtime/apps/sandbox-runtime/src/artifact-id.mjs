/**
 * The sandbox-runtime artifact id: one hash over every source file the service
 * runs, so a deploy can tell whether the running process is stale.
 *
 * It used to hash four hand-picked files (server.mjs, agent/registry.mjs,
 * cube/relay.mjs, native-capability.mjs). vibeubi-deploy reuses the running
 * sandbox when the engine image and this id are unchanged, so a change anywhere
 * else in the service (relay routes, quota, terminal reconcile) shipped as a
 * no-op: the commit was "deployed" while the old process kept serving
 * (2026-10-08). Now the id covers the whole src tree plus the three packages the
 * service imports; tests are excluded so a test-only change does not restart it.
 *
 * The server computes it once at boot and reports it on /healthz; the deploy
 * computes it from the tree and waits for /healthz to match. Both call this.
 */
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "../../../..")
/** Repo-relative roots: the service and the three packages it imports. */
export const SANDBOX_ARTIFACT_ROOTS = [
  "runtime/apps/sandbox-runtime/src",
  "runtime/packages/ava-local-protocol/src",
  "runtime/packages/storage-engine/src",
  "runtime/packages/shared-types/src",
]
const SOURCE = /\.(mjs|js|cjs|json)$/
const TEST = /\.test\.(mjs|js|cjs)$|(^|\/)(__tests__|test|fixtures)(\/|$)/

/** Every runtime source file, repo-relative, sorted — exported so a test can pin the set. */
export function sandboxArtifactFiles(repoRoot = REPO) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules" || name.startsWith(".")) continue
      const full = path.join(dir, name)
      const rel = path.relative(repoRoot, full)
      if (statSync(full).isDirectory()) { if (!TEST.test(rel + "/")) walk(full) }
      else if (SOURCE.test(name) && !TEST.test(rel)) out.push(rel)
    }
  }
  for (const r of SANDBOX_ARTIFACT_ROOTS) walk(path.join(repoRoot, r))
  return out.sort()
}

/** sha256 over (path, bytes) of every file above. A rename changes the id too. */
export function sandboxArtifactId(repoRoot = REPO) {
  const h = createHash("sha256")
  for (const rel of sandboxArtifactFiles(repoRoot)) {
    h.update(rel); h.update("\0"); h.update(readFileSync(path.join(repoRoot, rel))); h.update("\0")
  }
  return h.digest("hex")
}
