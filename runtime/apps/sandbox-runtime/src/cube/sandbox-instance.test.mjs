/**
 * cube/sandbox-instance.test.mjs — a deployment removes only its own sandboxes.
 *
 * Several deployments share one dockerd on a real host (copilot-v2 production
 * next to a CAC bundle), and every one labels its sandboxes unieai.sandbox=1.
 * The reaper once removed all of them, at boot and nowhere else.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { SANDBOX_INSTANCE_LABEL, buildDockerRunArgs, reapOrphanContainers, resolveSandboxInstance } from "./docker.mjs";
import { SandboxError } from "../shared/error.mjs";

/** A fake dockerd: `ps` ANDs its label filters, `rm` removes. */
function daemon(containers) {
  const removed = [];
  const runner = async (args) => {
    if (args[0] === "ps") {
      const filters = args.flatMap((a, i) => (args[i - 1] === "--filter" ? [a] : [])).map((f) => {
        const eq = f.indexOf("=", "label=".length);
        return [f.slice("label=".length, eq), f.slice(eq + 1)];
      });
      assert.ok(filters.length >= 2, "never a filter on the sandbox label alone");
      return Object.entries(containers).filter(([, l]) => filters.every(([k, v]) => l[k] === v)).map(([id]) => id).join("\n");
    }
    if (args[0] === "rm") { removed.push(args.at(-1)); return ""; }
    throw new Error(`unexpected: ${args.join(" ")}`);
  };
  return { runner, removed };
}

const HOST = {
  "mine-1": { "unieai.sandbox": "1", [SANDBOX_INSTANCE_LABEL]: "cac-a" },
  "mine-2": { "unieai.sandbox": "1", [SANDBOX_INSTANCE_LABEL]: "cac-a" },
  "other-bundle": { "unieai.sandbox": "1", [SANDBOX_INSTANCE_LABEL]: "cac-b" },
  "copilot-prod": { "unieai.sandbox": "1" }, // labelled before instances existed
};

test("the reaper removes this instance's sandboxes and nobody else's", async () => {
  const d = daemon(HOST);
  const r = await reapOrphanContainers({ dockerRunner: d.runner, instance: "cac-a" });
  assert.deepEqual(d.removed.sort(), ["mine-1", "mine-2"]);
  assert.equal(r.reaped, 2);
});

test("the default instance is 'cac', so an unconfigured CAC still leaves copilot-v2's sandboxes alone", async () => {
  assert.equal(resolveSandboxInstance({}), "cac");
  const d = daemon(HOST);
  await reapOrphanContainers({ dockerRunner: d.runner, instance: resolveSandboxInstance({}) });
  assert.deepEqual(d.removed, []);
});

test("every sandbox carries the instance label", () => {
  const args = buildDockerRunArgs({ image: "img", name: "n", instance: "cac-a" });
  const labels = args.filter((_, i) => args[i - 1] === "--label");
  assert.ok(labels.includes("unieai.sandbox=1"));
  assert.ok(labels.includes(`${SANDBOX_INSTANCE_LABEL}=cac-a`));
});

test("an instance name that is not a valid label value is a config error", () => {
  for (const bad of ["a b", "-x", "x=y", "x".repeat(64)]) {
    assert.throws(() => resolveSandboxInstance({ SANDBOX_INSTANCE: bad }), (e) => e instanceof SandboxError && e.code === "config_error", bad);
  }
  assert.equal(resolveSandboxInstance({ SANDBOX_INSTANCE: "cac-smoke-123" }), "cac-smoke-123");
});
