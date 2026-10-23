/**
 * Each self-check rule must fire on the mistake it was written for. A check that
 * only ever passes is indistinguishable from no check, so every rule gets a
 * fixture that breaks it on purpose.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "self-check.mjs");

function run(tree) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cac-selfcheck-"));
  try {
    for (const [file, body] of Object.entries(tree)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), body);
    }
    try {
      execFileSync(process.execPath, [SCRIPT, dir], { stdio: "pipe" });
      return { code: 0, out: "" };
    } catch (e) {
      return { code: e.status, out: String(e.stderr) };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SERVER = "runtime/apps/sandbox-runtime/src/server.mjs";

test("a clean tree passes", () => {
  assert.equal(run({ "a.mjs": 'import "./b.mjs";\n', "b.mjs": "", [SERVER]: "  {\n    pattern: /^\\/healthz\\/?$/,\n    requiresAuth: false,\n  }\n" }).code, 0);
});

const cases = {
  "import-resolves": { "a.mjs": 'import x from "./missing.mjs";\n' },
  "cross-repo-guard": { "t/x.test.mjs": 'readFileSync(path.join(HERE, "../apps/ava-local/src/redact.ts"));\n' },
  "route-exists": { "t/x.e2e.test.mjs": "assert.equal(r.status, 403);\n" },
  "filer-guard": { "t/x.test.mjs": 'await call("POST", "/v1/sandboxes", h, {});\n' },
  "base64-tamper": { "t/x.test.mjs": 'p = `${p.slice(0, -1)}${p.endsWith("A") ? "B" : "A"}`;\n' },
  "public-routes": { [SERVER]: "  {\n    pattern: /^\\/v1\\/debug\\/?$/,\n    requiresAuth: false,\n  }\n" },
  "caller-key-hash": { "callers.json": '[{"id":"s","namespace":"s","key":"plaintext"}]\n' },
};

for (const [rule, tree] of Object.entries(cases)) {
  test(`rule ${rule} fires on its mistake`, () => {
    const r = run(tree);
    assert.equal(r.code, 1, `expected a finding for ${rule}`);
    assert.match(r.out, new RegExp(`\\[${rule}\\]`), r.out);
  });
}
