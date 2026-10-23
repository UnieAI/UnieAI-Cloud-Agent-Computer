/**
 * env-capture/sync.mjs — query the sandbox for current package state
 * and reconcile it into the workspace manifest.
 *
 * Phase 1 strategy: trust the package managers' own list commands and
 * record their output verbatim. We do NOT try to parse the install
 * command itself (`pip install pandas==2.2.1`) because that's brittle —
 * extras (`pkg[ext]`), VCS specifiers (`git+https://...`), editable
 * installs, and `-r requirements.txt` all confuse a regex. Reading
 * post-install state via `pip list --format=json` is the ground truth.
 *
 * Cost: ~500ms per ecosystem inside the sandbox. We run python + node
 * in parallel and only ecosystems that have a real binary available
 * (caught at the exec layer — exit code != 0 means "ecosystem absent
 * from this image", which we treat as "leave that section untouched").
 */

import { log } from "../shared/log.mjs";

import { appendCaptureLog, readManifest, writeManifest } from "./manifest.mjs";

const QUERY_TIMEOUT_MS = 15_000;

/**
 * Run a one-shot command and collect its stdout. Returns
 * `{ ok, stdout, stderr, code }`. Doesn't use the streams registry —
 * these are internal queries, not user-visible exec rows.
 */
async function quickExec({ backend, sandboxId, command }) {
  let handle;
  try {
    handle = await backend.execProcess(sandboxId, {
      kind: "bash",
      command,
      timeoutMs: QUERY_TIMEOUT_MS
    });
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

/**
 * Read the live Python package list as `[{name, version}]`. Falls back
 * across pip / pip3 / python -m pip / uv pip so we work on whichever
 * binary the user's image has. Returns null when no Python toolchain
 * is reachable, which signals the caller to leave manifest.python
 * alone (vs. wiping it to an empty list — that would lie about state).
 */
async function readPythonPackages({ backend, sandboxId }) {
  const candidates = [
    "pip list --format=json --disable-pip-version-check 2>/dev/null",
    "pip3 list --format=json --disable-pip-version-check 2>/dev/null",
    "python -m pip list --format=json --disable-pip-version-check 2>/dev/null",
    "python3 -m pip list --format=json --disable-pip-version-check 2>/dev/null",
    "uv pip list --format=json 2>/dev/null"
  ];
  for (const cmd of candidates) {
    const res = await quickExec({ backend, sandboxId, command: cmd });
    if (!res.ok || !res.stdout.trim()) continue;
    try {
      const parsed = JSON.parse(res.stdout);
      if (!Array.isArray(parsed)) continue;
      return parsed
        .filter((p) => p && typeof p.name === "string")
        .map((p) => ({
          name: String(p.name),
          version: typeof p.version === "string" ? p.version : null
        }));
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Read the live Node package list. We deliberately query LOCAL deps
 * (the project's `node_modules`) — global packages live outside the
 * workspace and don't deserve to live in the per-workspace manifest.
 * `npm ls --json --depth=0 --omit=dev` walks the immediate deps of
 * /workspace/package.json. Missing package.json → returns null.
 */
async function readNodePackages({ backend, sandboxId }) {
  // Probe for a package.json first; without one `npm ls` has nothing
  // meaningful to say and emits noisy errors.
  const probe = await quickExec({
    backend,
    sandboxId,
    command: "test -f /workspace/package.json && echo ok || echo no"
  });
  if (!probe.ok || !probe.stdout.includes("ok")) return null;

  const candidates = [
    "cd /workspace && npm ls --json --depth=0 --all 2>/dev/null",
    "cd /workspace && pnpm ls --json --depth 0 2>/dev/null",
    "cd /workspace && yarn list --json --depth=0 2>/dev/null"
  ];
  for (const cmd of candidates) {
    const res = await quickExec({ backend, sandboxId, command: cmd });
    if (!res.ok || !res.stdout.trim()) continue;
    const parsed = parseNodeLs(res.stdout);
    if (parsed && parsed.length > 0) return parsed;
  }
  return null;
}

/**
 * Parse the output of `npm ls --json` (or pnpm). npm shape:
 *   { "dependencies": { "axios": { "version": "1.6.7" }, ... } }
 * yarn shape (line-delimited JSON) is intentionally skipped here —
 * Phase 1 covers npm/pnpm well enough; yarn users tend to also have
 * a lockfile we can pivot to in Phase 2.
 */
function parseNodeLs(raw) {
  try {
    const obj = JSON.parse(raw);
    const deps = obj?.dependencies;
    if (!deps || typeof deps !== "object") return null;
    return Object.entries(deps)
      .filter(([_name, info]) => info && typeof info === "object")
      .map(([name, info]) => ({
        name: String(name),
        version: typeof info.version === "string" ? info.version : null
      }));
  } catch {
    return null;
  }
}

async function readRuntimeVersions({ backend, sandboxId }) {
  const [py, node] = await Promise.all([
    quickExec({ backend, sandboxId, command: "python3 --version 2>&1 || python --version 2>&1" }),
    quickExec({ backend, sandboxId, command: "node --version 2>&1" })
  ]);
  const pyOut = py.ok ? py.stdout.trim() : "";
  const nodeOut = node.ok ? node.stdout.trim() : "";
  // "Python 3.12.4" → "3.12.4"
  const pyMatch = pyOut.match(/(\d+\.\d+(?:\.\d+)?)/);
  // "v20.11.0" → "20.11.0"
  const nodeMatch = nodeOut.match(/v?(\d+\.\d+(?:\.\d+)?)/);
  return {
    python: pyMatch ? pyMatch[1] : null,
    node: nodeMatch ? nodeMatch[1] : null
  };
}

/**
 * Sync the workspace manifest with the sandbox's live package state.
 * Called by index.mjs after a debounced install command. Top-level
 * try/catch so a hiccup in any one query doesn't poison the others —
 * we keep whatever sections succeeded and roll back the failed ones
 * to their prior manifest values.
 */
export async function syncManifest({ backend, sandboxId, trigger }) {
  const startedAt = Date.now();
  let prior;
  try {
    prior = await readManifest({ backend, sandboxId });
  } catch (err) {
    log("warn", "env_capture.sync_aborted_read", {
      sandboxId,
      message: err?.message || String(err)
    });
    return;
  }
  const next = { ...prior };

  // Run all probes in parallel — each one is a separate exec inside the
  // sandbox, no shared state between them.
  const [versions, pyPackages, nodePackages] = await Promise.all([
    readRuntimeVersions({ backend, sandboxId }).catch(() => null),
    readPythonPackages({ backend, sandboxId }).catch(() => null),
    readNodePackages({ backend, sandboxId }).catch(() => null)
  ]);

  if (versions) {
    next.runtime = { ...next.runtime, ...versions };
  }
  let pythonChanged = false;
  let nodeChanged = false;
  if (Array.isArray(pyPackages)) {
    pythonChanged = !packageListsEqual(prior.python.packages, pyPackages);
    next.python = { packages: pyPackages };
  }
  if (Array.isArray(nodePackages)) {
    nodeChanged = !packageListsEqual(prior.node.packages, nodePackages);
    next.node = { packages: nodePackages };
  }

  try {
    await writeManifest({ backend, sandboxId, manifest: next });
  } catch (err) {
    log("warn", "env_capture.sync_write_failed", {
      sandboxId,
      message: err?.message || String(err)
    });
    return;
  }

  await appendCaptureLog({
    backend,
    sandboxId,
    entry: {
      trigger,
      durationMs: Date.now() - startedAt,
      pythonChanged,
      nodeChanged,
      pythonCount: next.python.packages.length,
      nodeCount: next.node.packages.length
    }
  });

  log("info", "env_capture.synced", {
    sandboxId,
    trigger,
    pythonChanged,
    nodeChanged,
    pythonCount: next.python.packages.length,
    nodeCount: next.node.packages.length,
    durationMs: Date.now() - startedAt
  });
}

function packageListsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const byName = new Map();
  for (const p of a) byName.set(p.name, p.version);
  for (const p of b) {
    if (!byName.has(p.name)) return false;
    if (byName.get(p.name) !== p.version) return false;
  }
  return true;
}
