/**
 * cube/image-pin.test.mjs — the reconcile logic behind image-pin.mjs, tested
 * against a fake docker (no daemon needed) plus one cross-check against the
 * REAL orphan reaper (docker.mjs) so the two files cannot quietly disagree
 * about which label means what. See image-pin.mjs's header for the incident.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  PIN_CONTAINER_NAME,
  PIN_LABEL_KEY,
  PIN_LABEL_VALUE,
  ensureImagePin,
  rebuildCommand,
} from "./image-pin.mjs";

const IMAGE = "cm-agent-sandbox:weed-mount";

/**
 * A tiny in-memory stand-in for the slice of the docker CLI this module
 * calls (`image inspect`, `inspect`, `create`, `rm -f`). It is intentionally
 * NOT a general docker mock — it implements exactly the argv shapes
 * image-pin.mjs issues, so a test that fails here means either the module
 * changed its own contract or genuinely broke the reconcile, not that the
 * fake fell out of sync with something unrelated.
 *
 * `images` maps a tag to its current id; `containers` maps a name to
 * `{ image, labels }`. Mutated in place so a test can inspect state after
 * calling `ensureImagePin`.
 */
function makeFakeDocker({ images = {}, containers = {} } = {}) {
  const calls = [];
  let created = 0;

  async function runner({ args }) {
    calls.push(args);
    const [cmd] = args;

    if (cmd === "image" && args[1] === "inspect") {
      const tag = args.at(-1);
      const id = images[tag];
      if (!id) return { code: 1, stdout: "", stderr: `Error: No such image: ${tag}\n` };
      return { code: 0, stdout: `${id}\n`, stderr: "" };
    }

    if (cmd === "inspect") {
      const name = args.at(-1);
      const c = containers[name];
      if (!c) return { code: 1, stdout: "", stderr: `Error: No such object: ${name}\n` };
      return { code: 0, stdout: `${c.image}\n`, stderr: "" };
    }

    if (cmd === "rm") {
      const name = args.at(-1);
      delete containers[name];
      return { code: 0, stdout: "", stderr: "" };
    }

    if (cmd === "create") {
      const name = args[args.indexOf("--name") + 1];
      const labels = {};
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--label") {
          const eq = args[i + 1].indexOf("=");
          labels[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
        }
      }
      const entrypointIdx = args.indexOf("--entrypoint");
      const entrypoint = entrypointIdx >= 0 ? args[entrypointIdx + 1] : null;
      const imageId = args.at(-1);
      created += 1;
      containers[name] = { image: imageId, labels, entrypoint };
      return { code: 0, stdout: `pin-${created}\n`, stderr: "" };
    }

    throw new Error(`unexpected docker invocation in test: ${args.join(" ")}`);
  }

  runner.calls = calls;
  runner.containers = containers;
  return runner;
}

test("no pin exists yet: one gets created, bound to the image's CURRENT id", async () => {
  const runner = makeFakeDocker({ images: { [IMAGE]: "sha256:aaa" } });
  const result = await ensureImagePin({ image: IMAGE, runner });
  assert.equal(result.ok, true);
  assert.equal(result.action, "created");
  assert.equal(result.imageId, "sha256:aaa");

  const pin = runner.containers[PIN_CONTAINER_NAME];
  assert.ok(pin, "the pin container now exists under the fixed name");
  assert.equal(pin.image, "sha256:aaa", "created FROM THE ID, not the tag");
  assert.equal(pin.labels[PIN_LABEL_KEY], PIN_LABEL_VALUE);
});

test("the pin is created with a command that never runs, so an accidental start is harmless", async () => {
  const runner = makeFakeDocker({ images: { [IMAGE]: "sha256:aaa" } });
  await ensureImagePin({ image: IMAGE, runner });
  const pin = runner.containers[PIN_CONTAINER_NAME];
  // The image's OWN entrypoint (entrypoint.sh) weed-mounts a workspace and
  // demands WORKSPACE_BUCKET / WORKSPACE_PATH / S3_ENDPOINT be set (see
  // docker/cm-agent-sandbox/README.md) — exactly what a container that is
  // never meant to run must not attempt.
  assert.equal(pin.entrypoint, "/bin/true");
});

test("pin already matches the current id: left alone — no create, no rm", async () => {
  const runner = makeFakeDocker({
    images: { [IMAGE]: "sha256:aaa" },
    containers: { [PIN_CONTAINER_NAME]: { image: "sha256:aaa", labels: { [PIN_LABEL_KEY]: PIN_LABEL_VALUE } } },
  });
  const result = await ensureImagePin({ image: IMAGE, runner });
  assert.equal(result.action, "kept");
  assert.ok(!runner.calls.some((a) => a[0] === "create"), "steady state issues no create");
  assert.ok(!runner.calls.some((a) => a[0] === "rm"), "steady state issues no rm");
});

test("the tag now points at a different id (a rebuild happened): the stale pin is replaced", async () => {
  const runner = makeFakeDocker({
    images: { [IMAGE]: "sha256:bbb" }, // rebuilt since the pin was created
    containers: { [PIN_CONTAINER_NAME]: { image: "sha256:aaa", labels: { [PIN_LABEL_KEY]: PIN_LABEL_VALUE } } },
  });
  const result = await ensureImagePin({ image: IMAGE, runner });
  assert.equal(result.action, "replaced");
  assert.equal(result.imageId, "sha256:bbb");

  const pin = runner.containers[PIN_CONTAINER_NAME];
  assert.equal(pin.image, "sha256:bbb", "now bound to the NEW id, protecting the image actually in use");

  const rmCall = runner.calls.find((a) => a[0] === "rm");
  assert.ok(rmCall, "the old pin was removed rather than left to accumulate");
  assert.ok(rmCall.includes(PIN_CONTAINER_NAME));
});

test("the image is missing entirely (the 2026-09-26/27 shape): reported honestly, nothing to bind a pin to", async () => {
  const runner = makeFakeDocker({ images: {} }); // `docker image inspect` finds no such tag
  const result = await ensureImagePin({ image: IMAGE, runner });
  assert.equal(result.ok, false);
  assert.equal(result.action, "image_missing");
  assert.ok(!runner.calls.some((a) => a[0] === "create"), "nothing to pin when there is no image id");
});

test("rebuildCommand names the exact command this deployment's README documents", () => {
  assert.equal(
    rebuildCommand(IMAGE),
    "docker build -t cm-agent-sandbox:weed-mount ./docker/cm-agent-sandbox/",
    "docker/cm-agent-sandbox/README.md's own build line, not a hand-typed approximation",
  );
  // Generalises to a deployment override, since the tag is a parameter, not a
  // literal baked into the message.
  assert.equal(rebuildCommand("cm-agent-sandbox:custom"), "docker build -t cm-agent-sandbox:custom ./docker/cm-agent-sandbox/");
});

test("the pin never carries unieai.sandbox=1 — that exact label is the orphan reaper's kill filter", async () => {
  const runner = makeFakeDocker({ images: { [IMAGE]: "sha256:aaa" } });
  await ensureImagePin({ image: IMAGE, runner });
  const pin = runner.containers[PIN_CONTAINER_NAME];
  assert.equal(pin.labels["unieai.sandbox"], undefined);
  // And the marker this module DOES use is a different namespace on purpose —
  // asserted here so a future rename of one does not silently converge on the
  // other and reopen the exact hole this file exists to close.
  assert.notEqual(PIN_LABEL_KEY, "unieai.sandbox");
});

test("a create failure is reported and left for the next reconcile tick — boot must never throw", async () => {
  const runner = async ({ args }) => {
    if (args[0] === "image" && args[1] === "inspect") return { code: 0, stdout: "sha256:aaa\n", stderr: "" };
    if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "Error: No such object\n" };
    if (args[0] === "create") return { code: 1, stdout: "", stderr: "Error: Conflict, name in use\n" };
    throw new Error(`unexpected: ${args.join(" ")}`);
  };
  const result = await ensureImagePin({ image: IMAGE, runner });
  assert.equal(result.ok, false);
  assert.equal(result.action, "create_failed");
});

// ── cross-check against the REAL reaper, not a redrawn copy of its filter ───
//
// The rule that matters is "reapOrphanContainers never matches the pin". A
// test that merely compares two string constants by hand can drift from the
// actual filter the SAME way the two things it is checking could — see the
// project's own history of a rule re-implemented twice and only one copy
// getting fixed. This calls docker.mjs's real reapOrphanContainers with a
// fake that implements label filtering the way `docker ps --filter` does,
// so the assertion is about behaviour, not about two constants matching.

test("reapOrphanContainers' own filter does not sweep up the pin, using ITS real implementation", async () => {
  const { reapOrphanContainers } = await import("./docker.mjs");
  const containers = {
    "sandbox-abc": { labels: { "unieai.sandbox": "1", "unieai.instance": "cac" } },
    [PIN_CONTAINER_NAME]: { labels: { [PIN_LABEL_KEY]: PIN_LABEL_VALUE } },
  };
  const removed = [];
  const dockerRunner = async (args) => {
    if (args[0] === "ps") {
      // Every --filter must match, as `docker ps` ANDs label filters.
      const filters = args.flatMap((a, i) => (args[i - 1] === "--filter" ? [a] : [])).map((f) => {
        const eq = f.indexOf("=", "label=".length);
        return [f.slice("label=".length, eq), f.slice(eq + 1)];
      });
      return Object.entries(containers)
        .filter(([, c]) => filters.every(([k, v]) => c.labels[k] === v))
        .map(([name]) => name)
        .join("\n");
    }
    if (args[0] === "rm") {
      removed.push(args.at(-1));
      return "";
    }
    throw new Error(`unexpected docker invocation in test: ${args.join(" ")}`);
  };

  const result = await reapOrphanContainers({ dockerRunner });
  assert.deepEqual(removed, ["sandbox-abc"], "only the sandbox is swept — the pin must never appear here");
  assert.equal(result.reaped, 1);
});
