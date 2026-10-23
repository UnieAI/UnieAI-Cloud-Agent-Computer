/**
 * env-capture/restore.mjs — Phase 2: replay a workspace manifest onto a
 * freshly-allocated sandbox so the user sees "my environment is still
 * there" even though the underlying container is brand new.
 *
 * Flow:
 *   1. Read `/workspace/.unieai/env.json` (the Phase 1 manifest).
 *   2. Compute a hash of the package lists. If it matches the hash
 *      stored at `/workspace/.unieai/.restored-hash`, the previous
 *      restore covered this exact manifest — short-circuit.
 *   3. Batch install: `pip install pkg1==v1 pkg2==v2 ...` (one call,
 *      not per-package — pip handles deps internally and a single call
 *      is dramatically faster than N). Same for npm.
 *   4. Write `.unieai/.restored-hash` on success; append a structured
 *      entry to `.unieai/restore.log`.
 *
 * Non-blocking by design: callers (pool/manager.allocateSandbox) start
 * the promise and stash it on the entry. The first downstream exec
 * (runner/dispatchExec) awaits it before dispatching. Background-warm
 * is Phase 3 — for now, the first tool call may wait up to a minute
 * if the manifest is large. Subsequent calls are free.
 *
 * Failure mode: per-package install errors are tolerated (logged but
 * don't fail the whole restore). Catastrophic failures (manifest read
 * threw, pip not present at all) get logged and the restore quietly
 * gives up — user falls back to "install packages as the agent needs
 * them" which is exactly the pre-Phase-2 behavior.
 */

import crypto from "node:crypto";

import { log } from "../shared/log.mjs";

import { readManifest, MANIFEST_PATH } from "./manifest.mjs";

const RESTORE_HASH_PATH = "/workspace/.unieai/.restored-hash";
const RESTORE_LOG_PATH = "/workspace/.unieai/restore.log";
const PIP_TIMEOUT_MS = 5 * 60_000;   // 5 min — big envs like ML stacks
const NPM_TIMEOUT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Public entry. Called by pool/manager when a brand-new sandbox is
 * allocated. Returns a promise that resolves when restore is done (or
 * skipped, or failed) — never rejects. Callers can `await` it from
 * the first exec, or fire-and-forget if they don't care.
 *
 * The opts.force flag bypasses the hash short-circuit — useful for
 * "Restore environment" buttons in the UI (Phase 4), or for tests.
 */
export async function restoreFromManifest({ backend, sandboxId, force = false }) {
  const startedAt = Date.now();
  let manifest;
  try {
    manifest = await readManifest({ backend, sandboxId });
  } catch (err) {
    log("info", "env_restore.no_manifest", {
      sandboxId,
      message: err?.message || String(err)
    });
    return { status: "skipped", reason: "no_manifest" };
  }

  const pyPkgs = Array.isArray(manifest.python?.packages) ? manifest.python.packages : [];
  const nodePkgs = Array.isArray(manifest.node?.packages) ? manifest.node.packages : [];
  if (pyPkgs.length === 0 && nodePkgs.length === 0) {
    return { status: "skipped", reason: "empty_manifest" };
  }

  const hash = manifestHash(manifest);
  if (!force) {
    const prior = await readPriorHash({ backend, sandboxId });
    if (prior === hash) {
      log("info", "env_restore.hash_hit", { sandboxId, hash });
      return { status: "skipped", reason: "hash_match" };
    }
  }

  const summary = {
    sandboxId,
    pythonCount: pyPkgs.length,
    nodeCount: nodePkgs.length,
    pythonInstalled: 0,
    nodeInstalled: 0,
    pythonFailed: 0,
    nodeFailed: 0,
    durationMs: 0
  };

  if (pyPkgs.length > 0) {
    const result = await restorePython({ backend, sandboxId, packages: pyPkgs });
    summary.pythonInstalled = result.installed;
    summary.pythonFailed = result.failed;
  }
  if (nodePkgs.length > 0) {
    const result = await restoreNode({ backend, sandboxId, packages: nodePkgs });
    summary.nodeInstalled = result.installed;
    summary.nodeFailed = result.failed;
  }
  summary.durationMs = Date.now() - startedAt;

  // Only stamp the hash when nothing failed — partial restore should
  // re-attempt next time. Users who re-run with the same broken package
  // pay the cost again, which is correct: skipping silently would hide
  // the failure forever.
  if (summary.pythonFailed === 0 && summary.nodeFailed === 0) {
    await writeHash({ backend, sandboxId, hash });
  }
  await appendRestoreLog({ backend, sandboxId, summary });

  log("info", "env_restore.completed", summary);
  return { status: "ok", summary };
}

async function restorePython({ backend, sandboxId, packages }) {
  // Probe for any pip binary first — sandbox image without Python at
  // all (rare but possible) should leave restore as a no-op, not error.
  const probe = await quickExec({
    backend,
    sandboxId,
    command: "command -v pip3 || command -v pip || command -v uv",
    timeoutMs: PROBE_TIMEOUT_MS
  });
  if (!probe.ok || !probe.stdout.trim()) {
    log("info", "env_restore.no_python_toolchain", { sandboxId });
    return { installed: 0, failed: packages.length };
  }

  // Build the spec list. Packages with a known version pin → `name==version`,
  // unpinned → bare `name` (pip picks latest matching). Skip rows with
  // empty/weird names defensively.
  const specs = packages
    .filter((p) => p && typeof p.name === "string" && p.name.trim())
    .map((p) =>
      typeof p.version === "string" && p.version.trim()
        ? `${p.name}==${p.version}`
        : p.name
    );
  if (specs.length === 0) return { installed: 0, failed: 0 };

  // One pip-install call for everything. Shell-quote each spec — pkg
  // names are restricted to [A-Za-z0-9._-] but versions can include
  // `+`, `!`, etc. (PEP 440), and shells don't like those bare.
  const quoted = specs.map(shellQuote).join(" ");
  const cmd = `pip install --disable-pip-version-check --no-input ${quoted}`;
  const result = await quickExec({
    backend,
    sandboxId,
    command: cmd,
    timeoutMs: PIP_TIMEOUT_MS
  });
  if (result.ok) {
    return { installed: specs.length, failed: 0 };
  }
  // Batch failed — fall back to per-package so one bad spec doesn't
  // kill the whole restore. This is slow (N round trips) but only
  // happens on the batch-failure path, and any individual failure now
  // lands in the log with its own row.
  log("warn", "env_restore.python_batch_failed_falling_back", {
    sandboxId,
    code: result.code,
    stderrTail: result.stderr.slice(-500)
  });
  let installed = 0;
  let failed = 0;
  for (const spec of specs) {
    const one = await quickExec({
      backend,
      sandboxId,
      command: `pip install --disable-pip-version-check --no-input ${shellQuote(spec)}`,
      timeoutMs: PIP_TIMEOUT_MS
    });
    if (one.ok) installed += 1;
    else {
      failed += 1;
      log("warn", "env_restore.python_pkg_failed", {
        sandboxId, spec, code: one.code, stderrTail: one.stderr.slice(-200)
      });
    }
  }
  return { installed, failed };
}

async function restoreNode({ backend, sandboxId, packages }) {
  // Probe for npm. We deliberately install via npm (not pnpm/yarn) for
  // the restore path — the manifest stores plain `{ name, version }`
  // pairs, no lockfile assumptions. If the workspace happens to have
  // a `package-lock.json` or `pnpm-lock.yaml`, the user's own install
  // will eventually rewrite node_modules anyway; for first-time
  // restore the goal is just "these libs are importable".
  const probe = await quickExec({
    backend,
    sandboxId,
    command: "command -v npm",
    timeoutMs: PROBE_TIMEOUT_MS
  });
  if (!probe.ok || !probe.stdout.trim()) {
    log("info", "env_restore.no_node_toolchain", { sandboxId });
    return { installed: 0, failed: packages.length };
  }
  // Need a package.json to install local deps into. If the workspace
  // doesn't have one, initialise a minimal placeholder so npm-install
  // doesn't refuse. The placeholder is harmless — the user's own
  // package.json (if any) survives, we only touch what's missing.
  await quickExec({
    backend,
    sandboxId,
    command: 'test -f /workspace/package.json || echo \'{"name":"unieai-workspace","private":true,"version":"0.0.0"}\' > /workspace/package.json',
    timeoutMs: PROBE_TIMEOUT_MS
  });

  const specs = packages
    .filter((p) => p && typeof p.name === "string" && p.name.trim())
    .map((p) =>
      typeof p.version === "string" && p.version.trim()
        ? `${p.name}@${p.version}`
        : p.name
    );
  if (specs.length === 0) return { installed: 0, failed: 0 };

  const quoted = specs.map(shellQuote).join(" ");
  const cmd = `cd /workspace && npm install --no-fund --no-audit ${quoted}`;
  const result = await quickExec({
    backend,
    sandboxId,
    command: cmd,
    timeoutMs: NPM_TIMEOUT_MS
  });
  if (result.ok) {
    return { installed: specs.length, failed: 0 };
  }
  // Same fallback pattern as python: per-package retry on batch fail.
  log("warn", "env_restore.node_batch_failed_falling_back", {
    sandboxId,
    code: result.code,
    stderrTail: result.stderr.slice(-500)
  });
  let installed = 0;
  let failed = 0;
  for (const spec of specs) {
    const one = await quickExec({
      backend,
      sandboxId,
      command: `cd /workspace && npm install --no-fund --no-audit ${shellQuote(spec)}`,
      timeoutMs: NPM_TIMEOUT_MS
    });
    if (one.ok) installed += 1;
    else {
      failed += 1;
      log("warn", "env_restore.node_pkg_failed", {
        sandboxId, spec, code: one.code, stderrTail: one.stderr.slice(-200)
      });
    }
  }
  return { installed, failed };
}

function manifestHash(manifest) {
  // Hash only the bits restore actually replays — version pins and
  // package names, in deterministic order. Timestamp / metadata
  // changes mustn't bust the cache.
  const py = (manifest.python?.packages || [])
    .map((p) => `${p.name}==${p.version || "*"}`)
    .sort();
  const node = (manifest.node?.packages || [])
    .map((p) => `${p.name}@${p.version || "*"}`)
    .sort();
  const payload = JSON.stringify({ python: py, node });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

async function readPriorHash({ backend, sandboxId }) {
  try {
    const buf = await backend.readFile(sandboxId, RESTORE_HASH_PATH);
    return (Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "")).trim();
  } catch {
    return null;
  }
}

async function writeHash({ backend, sandboxId, hash }) {
  try {
    await backend.writeFile(sandboxId, RESTORE_HASH_PATH, Buffer.from(hash + "\n", "utf8"));
  } catch (err) {
    log("warn", "env_restore.hash_write_failed", {
      sandboxId,
      message: err?.message || String(err)
    });
  }
}

async function appendRestoreLog({ backend, sandboxId, summary }) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...summary }) + "\n";
  try {
    let existing = "";
    try {
      const buf = await backend.readFile(sandboxId, RESTORE_LOG_PATH);
      existing = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
    } catch {
      /* first write */
    }
    const next = existing + line;
    const capped = next.length > 128 * 1024 ? next.slice(next.length - 128 * 1024) : next;
    await backend.writeFile(sandboxId, RESTORE_LOG_PATH, Buffer.from(capped, "utf8"));
  } catch (err) {
    log("warn", "env_restore.log_write_failed", {
      sandboxId, message: err?.message || String(err)
    });
  }
}

async function quickExec({ backend, sandboxId, command, timeoutMs }) {
  let handle;
  try {
    handle = await backend.execProcess(sandboxId, { kind: "bash", command, timeoutMs });
  } catch (err) {
    return { ok: false, stdout: "", stderr: err?.message || String(err), code: -1 };
  }
  let stdout = "";
  let stderr = "";
  return await new Promise((resolve) => {
    handle.on("stdout", (chunk) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    handle.on("stderr", (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    handle.on("exit", (info = {}) => {
      const code = typeof info.code === "number" ? info.code : -1;
      resolve({ ok: code === 0, stdout, stderr, code });
    });
    handle.on("error", (err) => {
      resolve({ ok: false, stdout, stderr: err?.message || String(err), code: -1 });
    });
  });
}

function shellQuote(s) {
  // Single-quote and escape internal single quotes by closing/reopening.
  // Good enough for package specs which never contain control chars.
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

export { manifestHash as _manifestHashForTest };
