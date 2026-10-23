/**
 * env-capture/detect.mjs — heuristic detection of package-install commands.
 *
 * Phase 1 of the long-term env manifest plan: classify a finished bash
 * exec's command line as "install-ish" so the dispatcher knows to refresh
 * the workspace manifest. We deliberately err on the side of triggering
 * a sync — false positives cost one extra `pip list --format=json` (~500ms
 * inside the sandbox), false negatives miss real installs which is the
 * thing we're trying to prevent. This is the detection equivalent of
 * "compile after any save" vs "compile only on .ts saves".
 *
 * What counts as an install:
 *   · Python: pip / pip3 / python -m pip / uv pip / uv add / poetry add /
 *             poetry install / pipenv install — install OR uninstall
 *             (uninstall must trigger sync too: the manifest needs to drop
 *             the row, otherwise restore reinstalls a package the user
 *             explicitly removed).
 *   · Node:   npm / pnpm / yarn / bun — install / i / add / remove / uninstall.
 *             Bare `yarn` (no subcommand) is npm-install-equivalent —
 *             classify as install.
 *
 * What we DON'T capture in Phase 1:
 *   · apt / apt-get (root, needs Phase 6)
 *   · cargo / go / gem / cabal (low-frequency; revisit when telemetry
 *     shows demand)
 *   · `pip download`, `pip wheel` (no env mutation)
 *   · `--help` / `--version` style sub-calls — filtered below
 *
 * We parse only the FIRST clause of a shell command (split on `;`, `&&`,
 * `||`, `|`). `cd ~/proj && pip install foo` matches because the second
 * clause is the install. We also strip leading sudo / env-var prefixes
 * like `PIP_INDEX_URL=… pip install foo` so users who set per-call
 * mirrors still get captured.
 */

const PY_INSTALL_VERBS = new Set([
  "install",
  "i",
  "uninstall",
  "remove",
  "add",
  "sync"
]);

const JS_INSTALL_VERBS = new Set([
  "install",
  "i",
  "add",
  "remove",
  "uninstall",
  "ci"
]);

const HELP_FLAGS = /^(--help|-h|--version|-V)$/;

/**
 * Split a compound shell command into the first executable clause.
 * Naïve — does NOT respect quoted operators (`pip install "a && b"`
 * would split inside the string). Acceptable for Phase 1: the only
 * place this matters is when the user has a literal `&&` inside a
 * package version specifier, which doesn't exist.
 */
function firstClause(line) {
  const m = line.match(/^([^;&|]+)/);
  return (m ? m[1] : line).trim();
}

/**
 * Drop the leading `env VAR=… VAR=…` prefix or `sudo`/`sudo -E` so the
 * tokens we examine start with the actual binary name.
 */
function stripPrefix(tokens) {
  let i = 0;
  // sudo (with optional -E / -H flags)
  if (tokens[i] === "sudo") {
    i += 1;
    while (i < tokens.length && /^-[A-Za-z]+$/.test(tokens[i])) i += 1;
  }
  // env command
  if (tokens[i] === "env") {
    i += 1;
    while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i += 1;
  }
  // Bare VAR=value prefix(es)
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i += 1;
  return tokens.slice(i);
}

/**
 * Tokenize on whitespace. Quoted strings collapse to a single token so
 * `pip install "django>=4"` reads as 3 tokens. This is a one-pass scan,
 * good enough for the patterns we need.
 */
function tokenize(line) {
  const out = [];
  let cur = "";
  let quote = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Tell whether `tokens` represents a `python -m pip <verb>` invocation.
 * `tokens[0]` is the binary name (already past stripPrefix).
 */
function matchPythonModulePip(tokens) {
  if (tokens.length < 4) return null;
  const [bin, dashM, mod, verb] = tokens;
  if (!/^python3?(\.\d+)?$/.test(bin)) return null;
  if (dashM !== "-m") return null;
  if (mod !== "pip") return null;
  if (!PY_INSTALL_VERBS.has(verb)) return null;
  return { ecosystem: "python", tool: "pip", verb };
}

function matchPipDirect(tokens) {
  const [bin, verb] = tokens;
  if (!/^pip3?$/.test(bin)) return null;
  if (!verb || !PY_INSTALL_VERBS.has(verb)) return null;
  return { ecosystem: "python", tool: "pip", verb };
}

function matchUv(tokens) {
  if (tokens[0] !== "uv") return null;
  // `uv pip <verb>`
  if (tokens[1] === "pip" && PY_INSTALL_VERBS.has(tokens[2])) {
    return { ecosystem: "python", tool: "uv", verb: tokens[2] };
  }
  // `uv add` / `uv remove` / `uv sync`
  if (PY_INSTALL_VERBS.has(tokens[1])) {
    return { ecosystem: "python", tool: "uv", verb: tokens[1] };
  }
  return null;
}

function matchPoetry(tokens) {
  if (tokens[0] !== "poetry") return null;
  if (!["add", "remove", "install", "sync", "update"].includes(tokens[1])) return null;
  return { ecosystem: "python", tool: "poetry", verb: tokens[1] };
}

function matchPipenv(tokens) {
  if (tokens[0] !== "pipenv") return null;
  if (!["install", "uninstall", "sync", "update"].includes(tokens[1])) return null;
  return { ecosystem: "python", tool: "pipenv", verb: tokens[1] };
}

function matchNodePM(tokens) {
  const bin = tokens[0];
  if (!["npm", "pnpm", "yarn", "bun"].includes(bin)) return null;
  // Bare `yarn` (no second token) is install-equivalent. Bare `npm` /
  // `pnpm` / `bun` are usage prints — skip those.
  if (tokens.length === 1) {
    return bin === "yarn" ? { ecosystem: "node", tool: "yarn", verb: "install" } : null;
  }
  const verb = tokens[1];
  if (!JS_INSTALL_VERBS.has(verb)) return null;
  // Filter help/version on the verb itself (`npm install --help`).
  if (tokens.slice(2).some((t) => HELP_FLAGS.test(t))) return null;
  return { ecosystem: "node", tool: bin, verb };
}

/**
 * Inspect a finished bash command and decide whether to refresh the
 * env manifest. Returns null when the command is uninteresting, or an
 * `{ ecosystem, tool, verb }` descriptor when it matters.
 *
 * The descriptor is metadata for telemetry / capture.log — the
 * dispatcher always runs the same `sync everything` step regardless of
 * which tool fired, because tools can call each other (poetry shells
 * out to pip, uv writes to the same site-packages, etc.) and a unified
 * `pip list` / `npm ls` read is the single source of truth.
 */
export function detectInstall(rawCommand) {
  if (typeof rawCommand !== "string") return null;
  const trimmed = rawCommand.trim();
  if (!trimmed) return null;

  const clause = firstClause(trimmed);
  const rawTokens = tokenize(clause);
  if (rawTokens.length === 0) return null;

  // Filter pure help/version invocations — these are not state changes.
  if (rawTokens.some((t) => HELP_FLAGS.test(t))) {
    // BUT a real install can include --help-style flags as values for
    // arguments. Quick guard: only short-circuit if ANY of the first
    // three positional tokens is the help flag (covers `pip --help`,
    // `pip install --help`, but not `pip install some-pkg --some-arg=help`).
    if (rawTokens.slice(0, 3).some((t) => HELP_FLAGS.test(t))) return null;
  }

  const tokens = stripPrefix(rawTokens);
  if (tokens.length === 0) return null;

  return (
    matchPythonModulePip(tokens) ||
    matchPipDirect(tokens) ||
    matchUv(tokens) ||
    matchPoetry(tokens) ||
    matchPipenv(tokens) ||
    matchNodePM(tokens) ||
    null
  );
}
