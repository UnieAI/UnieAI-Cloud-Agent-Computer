#!/usr/bin/env node
/**
 * self-check.mjs — mechanical checks for mistakes this repo has already made.
 *
 * Every check here exists because the mistake happened once (see CLAUDE.md,
 * "Mistakes already made"). A check that can be written as code belongs here,
 * not only in prose: prose is read sometimes, `npm run check` runs every time.
 *
 * Exit code 1 on any finding. Each finding says what to do.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A directory argument checks another tree (scripts/self-check.test.mjs feeds it broken fixtures).
const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const rel = (p) => path.relative(ROOT, p);
const findings = [];
const fail = (check, file, msg) => findings.push(`[${check}] ${file}: ${msg}`);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// self-check.test.mjs holds the deliberately broken fixtures for every rule; it is
// the one file whose findings are the point.
const files = walk(ROOT).filter((f) => /\.(mjs|js|cjs|ts|mts)$/.test(f) && rel(f) !== "scripts/self-check.test.mjs");
const tests = files.filter((f) => /\.test\.mjs$/.test(f));
const read = (f) => fs.readFileSync(f, "utf8");

// 1. Every relative import resolves inside the repo.
//    (P0: the extraction left imports pointing at copilot-v2 files that were not copied.)
// Template strings are dropped first: an import inside one is a script handed to a
// child process (cube/docker-runtime-flag.test.mjs), resolved against its cwd.
const stripTemplates = (src) => src.replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``");
for (const f of files) {
  const src = stripTemplates(read(f));
  for (const m of src.matchAll(/(?:\bfrom\s+|\bimport\(\s*|\brequire\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
    const target = path.resolve(path.dirname(f), m[1]);
    if (![target, `${target}.mjs`, `${target}.js`].some((t) => fs.existsSync(t))) {
      fail("import-resolves", rel(f), `import "${m[1]}" does not resolve. Copy the file in, or drop the import.`);
    }
  }
}

// 2. A test that reads a copilot-v2-only file must go through COPILOT_V2_ROOT and skip with a reason.
//    (P0: three contract tests failed on ENOENT once the repo stood alone.)
// Only a path that is actually opened counts; naming the image in a string does not.
const COPILOT_ONLY_READ = /\b(?:join|resolve|readFile\w*|existsSync)\([^;]*?(?:apps\/ava-engine\/|apps\/ava-local\/|docker\/cm-agent-sandbox\/)/;
for (const f of tests) {
  const src = read(f);
  if (COPILOT_ONLY_READ.test(src) && !(/COPILOT_V2_ROOT/.test(src) && /skip:/.test(src))) {
    fail("cross-repo-guard", rel(f), "reads a copilot-v2 file without a COPILOT_V2_ROOT path and a { skip: <reason> } guard.");
  }
}

// 3. An e2e test that asserts a refusal (403/404) must prove the route exists with matchRoute.
//    (P1: two "forbidden" probes hit routes that do not exist and got 404 for everyone.)
for (const f of tests.filter((t) => /\.e2e\.test\.mjs$/.test(t))) {
  const src = read(f);
  if (/status,\s*40[34]\b/.test(src) && !/matchRoute\(/.test(src)) {
    fail("route-exists", rel(f), "asserts 403/404 without matchRoute(method, path); a missing route answers 404 for every caller.");
  }
}

// 4. A test that allocates a cloud sandbox must decide about the filer guard.
//    (P1: every allocation answered 503 filer_exposure_unknown on a test box.)
for (const f of tests) {
  const src = read(f);
  const allocates = /["'`]POST["'`],\s*["'`]\/v1\/sandboxes["'`]|allocateSandbox\(/.test(src);
  if (allocates && !/SANDBOX_ALLOW_ANONYMOUS_FILER|filerExposure|_resetFilerVerdictForTest|setBackend\(\{[\s\S]*?machine/.test(src)) {
    fail("filer-guard", rel(f), "allocates a sandbox but never sets SANDBOX_ALLOW_ANONYMOUS_FILER (or tests the filer guard itself).");
  }
}

// 5. Tampering a base64url value by its LAST character is a coin flip (padding bits).
//    (P0: license.test passed a tampered signature as valid about 1 run in 6.)
for (const f of tests) {
  const src = read(f);
  if (/slice\(0,\s*-1\)\}\$\{[^}]*endsWith\(/.test(src)) {
    fail("base64-tamper", rel(f), "flips the last base64url character; flip a middle one instead.");
  }
}

// 6. Routes without auth are a closed list. A new one must be reviewed for tenant data
//    and added here on purpose. (P1: /metrics turned out to take no token at all.)
const PUBLIC_ROUTES = new Set(["/^\\/healthz\\/?$/", "/^\\/metrics\\/?$/"]);
const server = path.join(ROOT, "runtime/apps/sandbox-runtime/src/server.mjs");
if (fs.existsSync(server)) {
  const lines = read(server).split("\n");
  lines.forEach((line, i) => {
    if (!/requiresAuth:\s*false/.test(line) || /^\s*(?:\/\/|\*)/.test(line)) return;
    const pattern = (lines.slice(Math.max(0, i - 3), i).join("\n").match(/pattern:\s*(\/\^[^\n]*?\/),?\s*$/m) || [])[1];
    if (!pattern || !PUBLIC_ROUTES.has(pattern)) {
      fail("public-routes", rel(server), `line ${i + 1}: route ${pattern || "(pattern not found)"} takes no token. Check it names no tenant, then add it to PUBLIC_ROUTES in scripts/self-check.mjs.`);
    }
  });
}

// 7. Caller keys are configured as hashes only.
for (const f of [path.join(ROOT, ".env"), ...walk(ROOT).filter((p) => /callers.*\.json$/.test(p))]) {
  if (!fs.existsSync(f)) continue;
  const src = read(f);
  if (/"key"\s*:/.test(src)) fail("caller-key-hash", rel(f), 'a caller entry carries "key"; configure "key_sha256" only.');
}

if (findings.length) {
  console.error(`self-check: ${findings.length} finding(s)\n`);
  for (const x of findings) console.error(`  ${x}`);
  process.exit(1);
}
console.log(`self-check: ok (${files.length} files, ${tests.length} tests, 7 checks)`);
