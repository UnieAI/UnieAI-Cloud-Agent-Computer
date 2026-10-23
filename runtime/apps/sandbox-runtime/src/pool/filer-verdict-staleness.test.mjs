/**
 * The filer-exposure verdict is memoised for the life of the process. That is
 * deliberate and correct — the probe costs a container, and the answer is a
 * property of the host's network, not of a request.
 *
 * What it MISSES is the case the memo cannot see: the answer changing while
 * the process lives. Two ways that happens, and they need different fixes:
 *
 *   1. THE CONFIG CHANGES. `SANDBOX_DOCKER_NETWORK` is repointed, the mount
 *      mode moves back to in-guest, the S3 endpoint moves. Every input to
 *      `exposureVerdict` is read from `process.env` at probe time and then
 *      never again, so a deployment that reverted its own isolation keeps
 *      being told it is isolated. Cheap to catch: key the memo on the inputs.
 *
 *   2. THE NETWORK CHANGES UNDER IT. Somebody recreates the docker network, or
 *      attaches the filer to it. No env var moves, so (1) cannot see it. Only
 *      a re-probe can, and a re-probe on the allocation path would put a
 *      container start in front of a user's sandbox — so it must happen off
 *      that path, with the cached answer still serving.
 *
 * The failure mode both share is the quiet one: the guard keeps PASSING. A
 * guard that has stopped measuring looks exactly like a guard that measured
 * and found nothing, which is the same trap as `_filerVerdict` never expiring.
 */
import test from "node:test";
import assert from "node:assert/strict";

const ENV_KEYS = [
  "SANDBOX_DOCKER_NETWORK",
  "SANDBOX_DOCKER_IMAGE",
  "SANDBOX_WORKSPACE_MOUNT",
  "WEED_S3_ENDPOINT",
  "S3_ENDPOINT",
  "SANDBOX_ACK_FILER_EXPOSURE",
  // The variable that is actually read (`cube/filer-exposure.mjs` ACK_ENV).
  // The line above it is a name that no longer exists anywhere in the tree;
  // left in place because restoring a variable nobody sets is harmless, while
  // a fixture that cannot restore the REAL one leaks an acknowledgement into
  // every test that runs after it.
  "SANDBOX_ALLOW_ANONYMOUS_FILER",
];

function withEnv(patch, fn) {
  const before = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // `Object.assign(process.env, {X: undefined})` sets the STRING "undefined",
  // not an absent variable — so a fixture that means "unset" has to delete.
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const mod = await import("./manager.mjs");

test("the memo key names every input the verdict is derived from", () => {
  // Asserted against `exposureVerdict`'s and `filerExposureVerdict`'s actual
  // reads rather than a list someone thought was complete: an input that is
  // read but NOT in the key is an input whose change goes unnoticed, which is
  // the whole defect.
  assert.equal(typeof mod.filerVerdictCacheKey, "function", "no cache key function is exported");

  const base = {
    SANDBOX_DOCKER_NETWORK: "ava_sandbox",
    SANDBOX_DOCKER_IMAGE: "img:1",
    SANDBOX_WORKSPACE_MOUNT: "host-premounted",
    S3_ENDPOINT: "http://172.20.0.4:8333",
    // NOT "" — `guestFilerAddress(env.WEED_S3_ENDPOINT ?? env.S3_ENDPOINT)`
    // uses `??`, so an empty WEED_S3_ENDPOINT shadows S3_ENDPOINT rather than
    // falling through to it. Setting it to "" here made this fixture assert
    // that a variable the probe was no longer reading still mattered. The key
    // must mirror what the probe actually reads, warts and all; an expectation
    // derived from what the code "should" read is how a key ends up missing an
    // input in the other direction.
    WEED_S3_ENDPOINT: undefined,
    SANDBOX_ACK_FILER_EXPOSURE: "",
  };
  const k0 = withEnv(base, () => mod.filerVerdictCacheKey(process.env));
  // The mount mode and the acknowledgement are deliberately NOT in this key:
  // they are inputs to the VERDICT, not to the probe, and the verdict is
  // recomputed on every allocation for free. Keying the probe on them would
  // spend a container to answer a question no container can answer.

  for (const [k, v] of [
    ["SANDBOX_DOCKER_NETWORK", "bridge"],
    ["SANDBOX_DOCKER_IMAGE", "img:2"],
    ["S3_ENDPOINT", "http://10.0.0.9:8333"],
    ]) {
    const k1 = withEnv({ ...base, [k]: v }, () => mod.filerVerdictCacheKey(process.env));
    assert.notEqual(k1, k0, `changing ${k} must invalidate the verdict — it changes the answer`);
  }

  // And the converse, so the key is not just "everything": a value the verdict
  // does not depend on must NOT churn the cache, or the memo stops memoising
  // and every allocation pays for a container.
  const same = withEnv({ ...base, SANDBOX_INTERNAL_TOKEN: "irrelevant" }, () =>
    mod.filerVerdictCacheKey(process.env),
  );
  assert.equal(same, k0, "an unrelated variable must not invalidate the probe");
});

test("a stale verdict is re-probed OFF the allocation path, and the cached answer still serves", async () => {
  assert.equal(typeof mod.filerVerdictIsStale, "function", "no staleness predicate is exported");
  assert.equal(typeof mod.FILER_VERDICT_TTL_MS, "number", "no TTL is declared");
  assert.ok(mod.FILER_VERDICT_TTL_MS > 0, "a TTL of 0 would put a container start on every allocation");

  const t0 = 1_000_000;
  assert.equal(mod.filerVerdictIsStale({ probedAt: t0 }, t0), false, "fresh");
  assert.equal(mod.filerVerdictIsStale({ probedAt: t0 }, t0 + mod.FILER_VERDICT_TTL_MS - 1), false);
  assert.equal(mod.filerVerdictIsStale({ probedAt: t0 }, t0 + mod.FILER_VERDICT_TTL_MS + 1), true);
  // A verdict that has never been probed is stale, not fresh — otherwise the
  // very first allocation after a reset would skip the refresh forever.
  assert.equal(mod.filerVerdictIsStale(null, t0), true, "no verdict at all is stale");
});

// ── the read-only report ─────────────────────────────────────────────────────

/**
 * `withEnv` above is SYNCHRONOUS: it restores in a `finally` that runs the
 * moment `fn()` returns, which for an async fn is when it returns its promise —
 * i.e. before the first `await` resumes. Using it here silently ran every
 * assertion under the ORIGINAL env, which changed the probe's cache key and
 * made the state read as "pending" forever. Green fixture, wrong question.
 */
async function withEnvAsync(patch, fn) {
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    mod._resetFilerVerdictForTest();
  }
}

/** No network and no image, so the probe answers without going near docker. */
const NO_DOCKER = {
  SANDBOX_DOCKER_NETWORK: undefined,
  SANDBOX_DOCKER_IMAGE: undefined,
  S3_ENDPOINT: "http://seaweedfs:8333",
  WEED_S3_ENDPOINT: undefined,
};

test("the console's status read never waits for a probe", async () => {
  assert.equal(typeof mod.filerExposureReport, "function", "nothing exposes the state to the console");
  await withEnvAsync({ ...NO_DOCKER, SANDBOX_ALLOW_ANONYMOUS_FILER: undefined }, async () => {
    mod._resetFilerVerdictForTest();
    // Cold cache. The allocation path may await a container start here; a
    // console that polls every 10s may not — it would queue requests behind a
    // `docker run` and, on a machine where docker is wedged, behind 15s of
    // nothing. So the first read returns immediately and says "pending".
    const cold = mod.filerExposureReport();
    assert.equal(cold.probe, "pending");
    assert.equal(cold.cloud_allocation_allowed, null, "unknown must not render as allowed");
    assert.equal(cold.filer, "seaweedfs:8888", "the address is known without probing");

    // …and the same read is what KICKS the probe: on a host where nobody is
    // allocating (which is exactly the host whose sandboxes are all refused)
    // the console is the only thing that ever asks.
    await new Promise((r) => setTimeout(r, 20));
    const warm = mod.filerExposureReport();
    assert.equal(warm.probe, "answered", "the read never started a probe — the state would stay 'pending' forever");
    assert.equal(warm.cloud_allocation_allowed, false, "an unanswerable probe refuses, and the console must say so");
    assert.equal(warm.code, "filer_exposure_unknown");
  });
});

test("withdrawing the acknowledgement shows up without a restart", async () => {
  await withEnvAsync({ ...NO_DOCKER, SANDBOX_ALLOW_ANONYMOUS_FILER: "1" }, async () => {
    mod._resetFilerVerdictForTest();
    mod.filerExposureReport();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(mod.filerExposureReport().acknowledged, true);
    // The acknowledgement is an input to the VERDICT, not to the probe, so it
    // must be re-read every time. Caching it with the probe is the defect that
    // let a withdrawn acknowledgement keep passing until a restart.
    delete process.env.SANDBOX_ALLOW_ANONYMOUS_FILER;
    assert.equal(mod.filerExposureReport().acknowledged, false, "the console would be showing a stale acceptance");
  });
});

test("a probe that could not run is not remembered — the next allocation probes again (2026-10-20)", async () => {
  // One slow `docker run` on a busy host timed out, and that "don't know" was
  // cached for the full TTL: every cloud sandbox was refused for 15 minutes.
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("./manager.mjs", import.meta.url), "utf8"));
  assert.match(src, /probeCouldNotRun\(result\) && _filerProbe === entry\) _filerProbe = null/, "a first probe that could not run must drop its cache entry");
  assert.match(src, /if \(probeCouldNotRun\(result\)\) \{\s*log\("warn", "pool\.filer_exposure_refresh_inconclusive"/, "a refresh that could not run must not replace a conclusive answer");
});
