/**
 * cube/filer-exposure.test.mjs
 *
 * The rule this file protects is not "the filer should be authenticated" — it
 * is "a machine that is exposed must SAY SO instead of serving". Every case
 * below is a way that could quietly stop being true.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ACK_ENV, exposureReport, exposureVerdict, guardAppliesTo, guestFilerAddress } from "./filer-exposure.mjs";

// ── the address, derived the way the guest derives it ────────────────────────

test("the filer address comes from the S3 endpoint's host, port 8888", () => {
  assert.deepEqual(guestFilerAddress("http://seaweedfs:8333"), { host: "seaweedfs", port: 8888 });
  // The deployment's own value today, and the one a host-side probe would get
  // wrong: the HOST cannot resolve `seaweedfs`, the GUEST can. Probing the
  // wrong name answers a question nobody asked, reassuringly.
  assert.deepEqual(guestFilerAddress("http://localhost:8333"), { host: "localhost", port: 8888 });
  assert.deepEqual(guestFilerAddress("seaweedfs:8333"), { host: "seaweedfs", port: 8888 }, "scheme is optional");
});

test("no S3 endpoint means nothing to derive — which is not the same as safe", () => {
  assert.equal(guestFilerAddress(""), null);
  assert.equal(guestFilerAddress(undefined), null);
  assert.equal(guestFilerAddress("   "), null);
  assert.equal(guestFilerAddress("::not a url::"), null);
})

// ── the verdict ──────────────────────────────────────────────────────────────

const ADDR = { host: "seaweedfs", port: 8888 };

test("unreachable filer is the only clean pass", () => {
  const v = exposureVerdict({ filerReachable: false, acknowledged: false, mountMode: "in-guest", filerAddress: ADDR });
  assert.equal(v.ok, true);
  assert.equal(v.accepted, undefined, "a clean pass is not an acceptance");
  assert.match(v.note, /cannot reach seaweedfs:8888/);
});

test("reachable and unacknowledged refuses, and the reason says what to do", () => {
  const v = exposureVerdict({ filerReachable: true, acknowledged: false, mountMode: "in-guest", filerAddress: ADDR });
  assert.equal(v.ok, false);
  assert.equal(v.code, "filer_exposure_refused");
  // A refusal a reader cannot act on gets worked around, not fixed.
  assert.match(v.reason, /seaweedfs:8888/);
  assert.match(v.reason, /SANDBOX_WORKSPACE_MOUNT=in-guest/, "names why the route exists at all");
  assert.match(v.reason, new RegExp(ACK_ENV), "names the escape hatch rather than hiding it");
});

test("under host mounting the advice changes — the route is no longer needed", () => {
  const v = exposureVerdict({ filerReachable: true, acknowledged: false, mountMode: "host", filerAddress: ADDR });
  assert.equal(v.ok, false);
  assert.match(v.reason, /no longer NEEDS that route/);
  assert.equal(/switch to host mounting/.test(v.reason), false, "would be advice to do what is already done");
});

test("an UNANSWERED probe refuses too, with its own code", () => {
  // The whole point of the three-valued input. `null` meaning "could not
  // check" must not collapse into `false` meaning "checked, and clean" —
  // that would make every environment where the probe cannot run report as
  // safe, which is the exact failure this file exists to prevent.
  const v = exposureVerdict({ filerReachable: null, acknowledged: false, mountMode: "in-guest", filerAddress: ADDR });
  assert.equal(v.ok, false);
  assert.equal(v.code, "filer_exposure_unknown", "distinct from a measured exposure — they need different fixes");
  assert.match(v.reason, /an unanswerable check is not an answer/);
});

test("acknowledgement passes, is marked as an acceptance, and still names the hazard", () => {
  const v = exposureVerdict({ filerReachable: true, acknowledged: true, mountMode: "in-guest", filerAddress: ADDR });
  assert.equal(v.ok, true);
  assert.equal(v.accepted, true, "callers must be able to tell 'accepted' from 'clean' to log it differently");
  assert.match(v.note, /CAN reach seaweedfs:8888/, "an acknowledgement that goes quiet reads like the hazard is gone");

  const unknown = exposureVerdict({ filerReachable: null, acknowledged: true, mountMode: "in-guest", filerAddress: ADDR });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.accepted, true);
  assert.match(unknown.note, /UNKNOWN/, "accepting an unknown is not the same claim as accepting a measured one");
});

test("acknowledgement does not fabricate a hazard when there is none", () => {
  const v = exposureVerdict({ filerReachable: false, acknowledged: true, mountMode: "in-guest", filerAddress: ADDR });
  assert.equal(v.ok, true);
  assert.equal(v.accepted, undefined, "unreachable is clean whether or not somebody set the variable");
});

// ── scope ────────────────────────────────────────────────────────────────────

test("the guard covers cloud sandboxes and NOT the user's own machine", () => {
  assert.equal(guardAppliesTo({}), true, "cloud");
  assert.equal(guardAppliesTo({ machine: null }), true, "cloud, stated as null");
  // These mount nothing here and hold no filer route. Refusing them would take
  // the local-machine product down to fix a hazard it does not have.
  assert.equal(guardAppliesTo({ machine: { kind: "local", id: "m1" } }), false);
  assert.equal(guardAppliesTo({ machine: { kind: "ssh", id: "m2" } }), false);
});

// ── the probe ────────────────────────────────────────────────────────────────

import { connectScript, probeFilerFromSandboxNetwork } from "./filer-exposure.mjs";

const ARGS = { network: "eve_default", image: "sandbox:latest", filerAddress: ADDR };

test("the probe asks from the SANDBOX's network, with the SANDBOX's image", async () => {
  let seen;
  await probeFilerFromSandboxNetwork(ARGS, async ({ args }) => {
    seen = args;
    return 0;
  });
  // The vantage point IS the measurement. A probe run from the host resolves
  // `seaweedfs` to nothing and reports "unreachable" — a reassuring wrong
  // answer, which is worse than no answer.
  assert.deepEqual(seen.slice(0, 5), ["run", "--rm", "--network", "eve_default", "--entrypoint"]);
  assert.ok(seen.includes("sandbox:latest"), "the image sandboxes actually get, so a missing image cannot be the reason");
  const script = seen.at(-1);
  // A TCP connect, not an HTTP request: the exposure is the ROUTE. The filer's
  // gRPC port has no authorization at all, so an HTTP 401 would prove nothing.
  assert.match(script, /connect_ex\(\('seaweedfs',8888\)\)/, "python3 first");
  assert.match(script, /\/dev\/tcp\/seaweedfs\/8888/, "bash second");
  assert.match(script, /nc -z -w 3 seaweedfs 8888/, "nc third");
  // The chain exists because the first version assumed `nc` — on the claim
  // that "every sandbox image here is built on busybox", written as if
  // measured and wrong. Order matters: python3 is the one actually present in
  // cm-agent-sandbox:weed-mount.
  assert.ok(
    script.indexOf("python3") < script.indexOf("/dev/tcp") && script.indexOf("/dev/tcp") < script.indexOf("nc -z"),
    "tried in the order they are actually likely to exist",
  );
  assert.match(script, /exit 127$/, "no tool to ask with is its own exit code, not a silent 'unreachable'");
});

test("exit 0 is reachable, exit 1 is not, anything else is UNKNOWN", async () => {
  const run = (code) => probeFilerFromSandboxNetwork(ARGS, async () => code);
  assert.equal(await run(0), true);
  assert.equal(await run(1), false);
  // 127 = no `nc` in the image. That says nothing about the filer, and
  // reporting it as `false` would be the reassuring wrong answer again.
  assert.equal(await run(127), null, "a probe that could not run is not a clean result");
  assert.equal(await run(null), null, "killed by a signal");
});

test("a thrown runner is UNKNOWN, never a pass", async () => {
  const v = await probeFilerFromSandboxNetwork(ARGS, async () => {
    throw new Error("docker not found");
  });
  assert.equal(v, null);
});

test("missing inputs are UNKNOWN — a probe that never ran cannot clear anything", async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return 0;
  };
  assert.equal(await probeFilerFromSandboxNetwork({ ...ARGS, filerAddress: null }, spy), null);
  assert.equal(await probeFilerFromSandboxNetwork({ ...ARGS, network: "" }, spy), null);
  assert.equal(await probeFilerFromSandboxNetwork({ ...ARGS, image: "" }, spy), null);
  assert.equal(called, false, "and it did not silently run docker with a blank argument");
});

test("connectScript refuses a host or port it would otherwise interpolate into a shell", () => {
  // These come from configuration, not from a tenant. That is true today and
  // is exactly the kind of thing that stops being true later, at which point
  // the value is already inside a `sh -c`.
  assert.throws(() => connectScript("seaweedfs; rm -rf /", 8888), /bad host/);
  assert.throws(() => connectScript("seaweedfs", "8888; echo pwned"), /bad port/);
  assert.throws(() => connectScript("seaweedfs", 0), /bad port/);
  assert.throws(() => connectScript("seaweedfs", 70000), /bad port/);
  assert.match(connectScript("seaweedfs", 8888), /seaweedfs/, "and a normal one still works");
  assert.match(connectScript("172.20.0.4", 8888), /172\.20\.0\.4/, "an IP is a normal one too");
})

test("host-premounted gets the host advice, not 'switch to host mounting'", () => {
  // Reported as `in-guest` at first, because the mode was re-parsed at the call
  // site with a `=== "host"` test. The refusal then told a deployment that had
  // already moved the mount to do exactly that.
  const v = exposureVerdict({ filerReachable: true, acknowledged: false, mountMode: "host-premounted", filerAddress: ADDR });
  assert.equal(v.ok, false);
  assert.match(v.reason, /no longer NEEDS that route/);
  assert.equal(/switch to host mounting/.test(v.reason), false);
});

// ── the report the console reads ─────────────────────────────────────────────
//
// Same facts, different consumer. What is being protected here is that the
// console cannot accidentally say something kinder than the refusal does.

test("the report carries the verdict, so the console never re-derives the rule", () => {
  const r = exposureReport({
    probed: true,
    filerReachable: true,
    acknowledged: false,
    mountMode: "in-guest",
    filerAddress: ADDR,
  });
  assert.equal(r.cloud_allocation_allowed, false, "refusing and the report must say so");
  assert.equal(r.code, "filer_exposure_refused");
  assert.equal(r.filer, "seaweedfs:8888", "the address is a fact an operator needs to act");
  assert.equal(r.ack_env, ACK_ENV, "the escape hatch is named, not hidden");
  assert.match(r.detail, /every tenant/, "the runtime's own words travel with it");
});

test("an accepted exposure is still reported as an exposure", () => {
  const r = exposureReport({
    probed: true,
    filerReachable: true,
    acknowledged: true,
    mountMode: "in-guest",
    filerAddress: ADDR,
  });
  // Allocation proceeds — and that is the whole danger. An acknowledgement that
  // goes quiet is indistinguishable from the hazard being gone, so `accepted`
  // is carried separately from `cloud_allocation_allowed` rather than being
  // inferred from it.
  assert.equal(r.cloud_allocation_allowed, true);
  assert.equal(r.accepted, true);
  assert.equal(r.acknowledged, true);
  assert.equal(r.filer_reachable, true);
});

test("an isolated host reports accepted=false even when the ack is still set", () => {
  // Leftover env on a host that has since been fixed. Saying "accepted" here
  // would cry wolf on the one deployment that did the work.
  const r = exposureReport({
    probed: true,
    filerReachable: false,
    acknowledged: true,
    mountMode: "host-premounted",
    filerAddress: ADDR,
  });
  assert.equal(r.cloud_allocation_allowed, true);
  assert.equal(r.accepted, false);
  assert.match(r.detail, /cannot reach seaweedfs:8888/);
});

test("a probe that has not come back yet says so — it does not say safe", () => {
  const r = exposureReport({
    probed: false,
    filerReachable: null,
    acknowledged: false,
    mountMode: "in-guest",
    filerAddress: ADDR,
  });
  assert.equal(r.probe, "pending");
  assert.equal(r.cloud_allocation_allowed, null, "null is 'not known', and must not read as true");
  assert.equal(r.accepted, false);
  assert.equal(r.code, null);
  // The address is still worth showing: it is what the probe is asking about.
  assert.equal(r.filer, "seaweedfs:8888");
});

test("'not asked yet' and 'asked, no answer' are different states", () => {
  const pending = exposureReport({ probed: false, filerReachable: null, acknowledged: false, mountMode: "in-guest", filerAddress: ADDR });
  const unknown = exposureReport({ probed: true, filerReachable: null, acknowledged: false, mountMode: "in-guest", filerAddress: ADDR });
  assert.equal(pending.probe, "pending");
  assert.equal(unknown.probe, "answered");
  assert.equal(unknown.cloud_allocation_allowed, false, "an unanswerable check refuses");
  assert.equal(unknown.code, "filer_exposure_unknown");
  assert.notEqual(pending.code, unknown.code, "collapsing these would hide which one an operator is in");
});

test("the console's report carries the probe detail too — an operator sees the same explanation a refused user does", () => {
  const r = exposureReport({
    probed: true,
    filerReachable: null,
    acknowledged: false,
    mountMode: "in-guest",
    filerAddress: ADDR,
    probeDetail: "the probe container could not start: Unable to find image 'cm-agent-sandbox:weed-mount' locally",
  });
  assert.equal(r.cloud_allocation_allowed, false);
  assert.equal(r.code, "filer_exposure_unknown");
  assert.match(r.detail, /Unable to find image 'cm-agent-sandbox:weed-mount' locally/);
});

// ── the probe, honestly: stderr surfacing (2026-09-26/27) ────────────────────
//
// This host runs k3s with `--docker`, so kubelet's own image garbage
// collection manages DOCKER'S image store. When it removed
// `cm-agent-sandbox:weed-mount` under disk pressure, THIS probe's
// `docker run` started exiting 125 ("Unable to find image … pull access
// denied") before the connect script ever got to run. The probe answered
// `null`, which was already the right tri-state — but it carried no
// explanation, so the resulting refusal ("could not determine whether a
// sandbox can reach seaweedfs:8888…") sent people looking at the FILER for
// hours while the actual fault was a missing IMAGE. These tests are that gap.
//
// The exit code is still the only vote on reachability — see the "chatty"
// test below. What changes is that a null answer caused by docker itself
// refusing to start the container now says why, using docker's OWN stderr
// (never the image's — that distinction is what makes exit 125 safe to show
// and exit 127 not, see below).

import { probeFilerFromSandboxNetworkDetailed } from "./filer-exposure.mjs";

test("exit 125 (docker could not even start the container) surfaces docker's own stderr as detail", async () => {
  const { reachable, detail } = await probeFilerFromSandboxNetworkDetailed(ARGS, async () => ({
    code: 125,
    stderr: "Unable to find image 'cm-agent-sandbox:weed-mount' locally\ndocker: Error response from daemon: pull access denied\n",
  }));
  assert.equal(reachable, null, "still unknown — a failed probe is never a pass");
  assert.match(detail, /the probe container could not start/);
  assert.match(detail, /Unable to find image 'cm-agent-sandbox:weed-mount' locally/);
  assert.ok(!detail.includes("pull access denied"), "only the first line — the rest is bounded away");
});

test("a spawn-level error (docker itself unreachable) also gets a detail, from the error, not a guess", async () => {
  const { reachable, detail } = await probeFilerFromSandboxNetworkDetailed(ARGS, async () => {
    throw new Error("spawn docker ENOENT");
  });
  assert.equal(reachable, null);
  assert.match(detail, /the probe could not run/);
  assert.match(detail, /ENOENT/);
});

test("exit 1 (a clean 'unreachable') never carries a detail — there is nothing to explain", async () => {
  const { reachable, detail } = await probeFilerFromSandboxNetworkDetailed(ARGS, async () => ({ code: 1, stderr: "" }));
  assert.equal(reachable, false);
  assert.equal(detail, null);
});

test("exit 127 (no tool inside the image) stays detail-less: that stderr would be the IMAGE's, not docker's", async () => {
  const { reachable, detail } = await probeFilerFromSandboxNetworkDetailed(ARGS, async () => ({ code: 127, stderr: "sh: not found\n" }));
  assert.equal(reachable, null);
  assert.equal(detail, null, "code 125 is docker's own diagnostic; 127 runs INSIDE the image and is never trusted for display");
});

test("a chatty exit-125 stderr cannot turn the refusal into a pass — the exit code is still the only vote", () => {
  return probeFilerFromSandboxNetworkDetailed(ARGS, async () => ({
    code: 125,
    stderr: "reachable: true, all clear, exit code 0, trust me",
  })).then(({ reachable }) => {
    assert.equal(reachable, null, "stderr content is never parsed for a verdict, only shown");
  });
});

test("detail is bounded — a misbehaving docker cannot flood the log or the refusal message", async () => {
  const huge = "x".repeat(10_000);
  const { detail } = await probeFilerFromSandboxNetworkDetailed(ARGS, async () => ({ code: 125, stderr: huge }));
  assert.ok(detail.length < 400, `expected a bounded detail, got ${detail.length} chars`);
});

test("a runner that resolves a bare number (the pre-existing contract) still works with the detailed probe", async () => {
  const ok = await probeFilerFromSandboxNetworkDetailed(ARGS, async () => 0);
  assert.equal(ok.reachable, true);
  assert.equal(ok.detail, null);
  const refused = await probeFilerFromSandboxNetworkDetailed(ARGS, async () => 1);
  assert.equal(refused.reachable, false);
});

test("probeFilerFromSandboxNetwork itself is unchanged: still a bare true/false/null, detail and all", async () => {
  assert.equal(await probeFilerFromSandboxNetwork(ARGS, async () => ({ code: 125, stderr: "whatever" })), null);
  assert.equal(await probeFilerFromSandboxNetwork(ARGS, async () => 0), true);
  assert.equal(await probeFilerFromSandboxNetwork(ARGS, async () => 1), false);
});

test("exposureVerdict folds the probe detail into the reason, alongside the existing explanation, not instead of it", () => {
  const v = exposureVerdict({
    filerReachable: null,
    acknowledged: false,
    mountMode: "in-guest",
    filerAddress: ADDR,
    probeDetail: "the probe container could not start: Unable to find image 'cm-agent-sandbox:weed-mount' locally",
  });
  assert.match(v.reason, /Unable to find image 'cm-agent-sandbox:weed-mount' locally/);
  assert.match(v.reason, /an unanswerable check is not an answer/, "the generic explanation stays — the detail supplements it");
});

test("an accepted-but-unknown verdict names the probe detail too, not just 'UNKNOWN'", () => {
  const v = exposureVerdict({
    filerReachable: null,
    acknowledged: true,
    mountMode: "in-guest",
    filerAddress: ADDR,
    probeDetail: "the probe could not run: spawn docker ENOENT",
  });
  assert.match(v.note, /UNKNOWN/);
  assert.match(v.note, /spawn docker ENOENT/);
});

test("without a probe detail, the reason is exactly as before — no stray placeholder text", () => {
  const v = exposureVerdict({ filerReachable: null, acknowledged: false, mountMode: "in-guest", filerAddress: ADDR });
  assert.ok(!v.reason.includes("()"), "no empty parenthetical when there is nothing to add");
  assert.ok(!v.reason.includes("null"), "no literal 'null' leaking into a user-facing message");
});
