/**
 * The deploy reuses the running sandbox-runtime when its artifact id is unchanged. The id used
 * to cover four hand-picked files, so a change to relay/routes.mjs (or quota, or terminal
 * reconcile) shipped without restarting the service. These pin the fix.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sandboxArtifactFiles, sandboxArtifactId, SANDBOX_ARTIFACT_ROOTS } from "./artifact-id.mjs"

const REPO = path.resolve(import.meta.dirname, "../../../..")

test("the artifact covers modules outside the four the id used to hash", () => {
  const files = sandboxArtifactFiles()
  for (const f of ["runtime/apps/sandbox-runtime/src/server.mjs", "runtime/apps/sandbox-runtime/src/relay/routes.mjs",
    "runtime/apps/sandbox-runtime/src/quota/enforcer.mjs", "runtime/packages/ava-local-protocol/src/native-capability.mjs"]) {
    assert.ok(files.includes(f), `${f} is not part of the sandbox artifact — a change to it would deploy as a no-op`)
  }
  assert.ok(!files.some((f) => /\.test\.(mjs|js|cjs)$/.test(f)), "test files must not restart the service")
})

test("changing any covered file changes the id; changing a test does not", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sbx-artifact-"))
  try {
    for (const r of SANDBOX_ARTIFACT_ROOTS) cpSync(path.join(REPO, r), path.join(root, r), { recursive: true })
    const before = sandboxArtifactId(root)
    writeFileSync(path.join(root, "runtime/apps/sandbox-runtime/src/artifact-id.test.mjs"), "// edited test\n")
    assert.equal(sandboxArtifactId(root), before, "a test-only edit must not change the id")
    writeFileSync(path.join(root, "runtime/apps/sandbox-runtime/src/relay/routes.mjs"), "// edited\n", { flag: "a" })
    assert.notEqual(sandboxArtifactId(root), before, "editing relay/routes.mjs must change the id")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
