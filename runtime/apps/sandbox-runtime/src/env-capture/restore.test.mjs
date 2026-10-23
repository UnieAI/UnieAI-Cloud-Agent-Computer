import test from "node:test";
import assert from "node:assert/strict";

import { _manifestHashForTest as manifestHash } from "./restore.mjs";

test("manifestHash — deterministic across key order", () => {
  const a = manifestHash({
    python: { packages: [{ name: "pandas", version: "2.2.1" }, { name: "numpy", version: "1.26.0" }] },
    node: { packages: [{ name: "axios", version: "1.6.7" }] }
  });
  const b = manifestHash({
    python: { packages: [{ name: "numpy", version: "1.26.0" }, { name: "pandas", version: "2.2.1" }] },
    node: { packages: [{ name: "axios", version: "1.6.7" }] }
  });
  assert.equal(a, b, "package order must not affect hash");
});

test("manifestHash — version change busts hash", () => {
  const a = manifestHash({
    python: { packages: [{ name: "pandas", version: "2.2.1" }] },
    node: { packages: [] }
  });
  const b = manifestHash({
    python: { packages: [{ name: "pandas", version: "2.2.0" }] },
    node: { packages: [] }
  });
  assert.notEqual(a, b);
});

test("manifestHash — added package busts hash", () => {
  const a = manifestHash({
    python: { packages: [{ name: "pandas", version: "2.2.1" }] },
    node: { packages: [] }
  });
  const b = manifestHash({
    python: { packages: [{ name: "pandas", version: "2.2.1" }, { name: "numpy", version: "1.26.0" }] },
    node: { packages: [] }
  });
  assert.notEqual(a, b);
});

test("manifestHash — null version coalesces to wildcard", () => {
  const a = manifestHash({
    python: { packages: [{ name: "pandas", version: null }] },
    node: { packages: [] }
  });
  const b = manifestHash({
    python: { packages: [{ name: "pandas", version: null }] },
    node: { packages: [] }
  });
  assert.equal(a, b);
});

test("manifestHash — empty equals empty (no python/node sections)", () => {
  const a = manifestHash({ python: { packages: [] }, node: { packages: [] } });
  const b = manifestHash({});
  assert.equal(a, b);
});

test("manifestHash — updatedAt does not affect hash", () => {
  const a = manifestHash({
    updatedAt: "2026-01-01T00:00:00Z",
    python: { packages: [{ name: "pandas", version: "2.2.1" }] },
    node: { packages: [] }
  });
  const b = manifestHash({
    updatedAt: "2026-05-22T10:15:00Z",
    python: { packages: [{ name: "pandas", version: "2.2.1" }] },
    node: { packages: [] }
  });
  assert.equal(a, b, "timestamp must not bust cache");
});
