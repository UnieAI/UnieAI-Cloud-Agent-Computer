import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// dotenv is OPTIONAL — it only loads a local `.env` file in dev. In containers
// (sandbox-runtime / collab-runtime) env vars are injected directly by compose
// and dotenv isn't installed, so resolve it lazily and no-op if it's absent
// (a static `import` would crash the whole module at link time). dotenv is CJS,
// so a synchronous require keeps loadEnv() side-effect-before-env-read intact.
const require = createRequire(import.meta.url);
let dotenvConfig = null;
try {
  dotenvConfig = require("dotenv").config;
} catch {
  /* dotenv not installed — env is already in process.env */
}

let loaded = false;

/**
 * Walk up from process.cwd() looking for `.env` and load it via dotenv.
 *
 * Auto-loaded on import (see side-effect call at bottom of this file).
 * ES modules are evaluated top-down at import time, so any module that
 * reads `process.env.X` at top-level locks in the value at module-init.
 * dotenv MUST run before those reads — which means: `import` this module
 * (anywhere it's transitively reachable) before any module that reads
 * process.env at the top level. The auto-load below makes that automatic;
 * the `loaded` guard makes subsequent calls safe no-ops.
 *
 * In practice: import this file at the top of every config.mjs (or
 * equivalent process.env reader) so its first transitive import wins.
 * Calling `loadEnv()` explicitly afterwards is still safe.
 */
export function loadEnv() {
  if (loaded) {
    return;
  }
  // No dotenv (container / prod) → env is pre-injected; nothing to load.
  if (!dotenvConfig) {
    loaded = true;
    return;
  }

  let currentDir = process.cwd();
  let envPath = null;

  while (true) {
    const candidate = path.join(currentDir, ".env");
    if (fs.existsSync(candidate)) {
      envPath = candidate;
      break;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  if (envPath) {
    dotenvConfig({ path: envPath });
  } else {
    dotenvConfig();
  }

  loaded = true;
}

// Side-effect: load on import. Any module that reads process.env at
// top-level can `import "..../env.mjs"` first to guarantee the env is
// populated before it does so.
loadEnv();
