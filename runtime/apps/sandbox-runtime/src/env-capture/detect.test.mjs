import test from "node:test";
import assert from "node:assert/strict";

import { detectInstall } from "./detect.mjs";

test("pip install — bare", () => {
  assert.deepEqual(detectInstall("pip install pandas"), {
    ecosystem: "python", tool: "pip", verb: "install"
  });
});

test("pip3 install — versioned binary", () => {
  assert.deepEqual(detectInstall("pip3 install requests==2.31.0"), {
    ecosystem: "python", tool: "pip", verb: "install"
  });
});

test("python -m pip install — module form", () => {
  assert.deepEqual(detectInstall("python -m pip install scipy"), {
    ecosystem: "python", tool: "pip", verb: "install"
  });
});

test("python3.12 -m pip install — explicit minor version", () => {
  assert.deepEqual(detectInstall("python3.12 -m pip install numpy"), {
    ecosystem: "python", tool: "pip", verb: "install"
  });
});

test("uv pip install", () => {
  assert.deepEqual(detectInstall("uv pip install pandas"), {
    ecosystem: "python", tool: "uv", verb: "install"
  });
});

test("uv add", () => {
  assert.deepEqual(detectInstall("uv add httpx"), {
    ecosystem: "python", tool: "uv", verb: "add"
  });
});

test("poetry add", () => {
  assert.deepEqual(detectInstall("poetry add fastapi"), {
    ecosystem: "python", tool: "poetry", verb: "add"
  });
});

test("pipenv install", () => {
  assert.deepEqual(detectInstall("pipenv install"), {
    ecosystem: "python", tool: "pipenv", verb: "install"
  });
});

test("pip uninstall", () => {
  assert.deepEqual(detectInstall("pip uninstall -y pandas"), {
    ecosystem: "python", tool: "pip", verb: "uninstall"
  });
});

test("npm install — bare", () => {
  assert.deepEqual(detectInstall("npm install axios"), {
    ecosystem: "node", tool: "npm", verb: "install"
  });
});

test("npm i — short form", () => {
  assert.deepEqual(detectInstall("npm i react"), {
    ecosystem: "node", tool: "npm", verb: "i"
  });
});

test("pnpm add", () => {
  assert.deepEqual(detectInstall("pnpm add zod"), {
    ecosystem: "node", tool: "pnpm", verb: "add"
  });
});

test("yarn (bare)", () => {
  assert.deepEqual(detectInstall("yarn"), {
    ecosystem: "node", tool: "yarn", verb: "install"
  });
});

test("yarn add", () => {
  assert.deepEqual(detectInstall("yarn add lodash"), {
    ecosystem: "node", tool: "yarn", verb: "add"
  });
});

test("bun install", () => {
  assert.deepEqual(detectInstall("bun install"), {
    ecosystem: "node", tool: "bun", verb: "install"
  });
});

test("sudo prefix — strip and detect", () => {
  assert.deepEqual(detectInstall("sudo pip install foo"), {
    ecosystem: "python", tool: "pip", verb: "install"
  });
});

test("sudo -E prefix — strip flags and detect", () => {
  assert.deepEqual(detectInstall("sudo -E pip install foo"), {
    ecosystem: "python", tool: "pip", verb: "install"
  });
});

test("env var prefix — strip and detect", () => {
  assert.deepEqual(detectInstall("PIP_INDEX_URL=https://mirror.example.com pip install foo"), {
    ecosystem: "python", tool: "pip", verb: "install"
  });
});

test("compound command — second clause is install (&&)", () => {
  // The first clause (`cd /workspace`) is not an install — but
  // detectInstall by design only inspects the FIRST clause, so this
  // returns null. Documenting current behavior; if telemetry shows
  // significant `cd && install` traffic we'd extend the parser.
  assert.equal(detectInstall("cd /workspace && pip install foo"), null);
});

test("help flag — pip install --help", () => {
  assert.equal(detectInstall("pip install --help"), null);
});

test("version flag", () => {
  assert.equal(detectInstall("pip --version"), null);
});

test("unrelated command", () => {
  assert.equal(detectInstall("ls -la /workspace"), null);
});

test("empty / whitespace", () => {
  assert.equal(detectInstall(""), null);
  assert.equal(detectInstall("   "), null);
});

test("non-install pip subcommand — list", () => {
  assert.equal(detectInstall("pip list"), null);
});

test("non-install npm subcommand — run", () => {
  assert.equal(detectInstall("npm run build"), null);
});

test("pip download — not state-mutating", () => {
  // 'download' is not in our install-verbs set; matches current intent.
  assert.equal(detectInstall("pip download pandas -d ./wheels"), null);
});

test("quoted package spec preserved through tokenizer", () => {
  assert.deepEqual(detectInstall('pip install "django>=4,<5"'), {
    ecosystem: "python", tool: "pip", verb: "install"
  });
});

test("non-string input", () => {
  assert.equal(detectInstall(null), null);
  assert.equal(detectInstall(undefined), null);
  assert.equal(detectInstall(123), null);
  assert.equal(detectInstall({}), null);
});
