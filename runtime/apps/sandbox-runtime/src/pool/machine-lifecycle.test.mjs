/**
 * pool/machine-lifecycle.test.mjs — who the reaper is allowed to kill.
 *
 * The reaper exists to reclaim HOST capacity: a cloud sandbox is a docker
 * container on our box, so a walked-away user must not hold one forever.
 * A machine-bound sandbox is not that. It is a routing record pointing at
 * hardware the user owns and pays for; reaping it frees nothing on the host
 * and costs the user their session — they come back to a chat that has
 * silently forgotten which computer it was working on.
 *
 * So the rule is about WHERE the compute lives, not about which backend
 * object we happen to hold:
 *
 *   machine-bound (Rabi Local / SSH) → never reaped by idle or TTL
 *   cloud (docker/cube)             → reaped on idle, and on the TTL hard cap
 *
 * These tests drive `_runReaperPass` directly (as the existing manager tests
 * do) because the 1s interval timer is not something a test should wait on.
 */
// The filer guard (cube/filer-exposure.mjs) refuses CLOUD sandboxes on a host
// where a sandbox can reach an unauthenticated filer — which this one can.
// These suites are about the pool, not the filer, so they declare the
// acceptance the way a deployment would. The guard's own refusals are asserted
// in cube/filer-exposure.test.mjs and in the allocation tests at the end of
// this file, which clear it locally and restore it.
process.env.SANDBOX_ALLOW_ANONYMOUS_FILER = "1";
process.env.SANDBOX_USER_MAX_ACTIVE = "0";
process.env.SANDBOX_POOL_TOTAL_MAX = "100";

import test from "node:test";
import assert from "node:assert/strict";

const cube = await import("../cube/index.mjs");
let _ctr = 0;
const cloud = {
  createSandbox: async ({ userId, sessionId }) => ({
    sandboxId: `cloud_${++_ctr}`,
    workspaceId: `ws_${_ctr}`,
    workspaceDir: `/tmp/fake_${_ctr}`,
    userId,
    sessionId,
  }),
  destroySandbox: async () => undefined,
};
cube.resetBackend();
cube.setBackend(cloud);

const { registerMachineConnection, _resetForTest } = await import("../relay/registry.mjs");
const { allocateSandbox, _runReaperPass, getActive, listActive, releaseSandbox, releaseMachineSandboxes } = await import("./manager.mjs");

const LOCAL = { id: "m-life", kind: "local", root: "/w" };

test("an Rabi Local sandbox is never idle-reaped, however long it sits quiet", async () => {
  _resetForTest();
  registerMachineConnection({ machineId: LOCAL.id, userId: "u-life1", send() {} });
  const a = await allocateSandbox({ userId: "u-life1", sessionId: "life-s1", workspaceMode: "user", machine: LOCAL });
  const entry = getActive(a.entry.sandboxId);
  assert.equal(entry.machineKind, "local");

  // A whole day of silence. A cloud sandbox would be long gone.
  entry.idleAt = Date.now() - 86_400_000;
  const released = _runReaperPass();

  assert.ok(!released.some((r) => r.sandboxId === a.entry.sandboxId), "idle reaper skipped the machine-bound sandbox");
  assert.ok(listActive().some((e) => e.sandboxId === a.entry.sandboxId), "still active");
  await releaseSandbox(a.entry.sandboxId);
});

test("an Rabi Local sandbox is never TTL-reaped either", async () => {
  _resetForTest();
  registerMachineConnection({ machineId: LOCAL.id, userId: "u-life2", send() {} });
  const a = await allocateSandbox({ userId: "u-life2", sessionId: "life-s2", workspaceMode: "user", machine: LOCAL });
  const entry = getActive(a.entry.sandboxId);

  entry.ttlAt = Date.now() - 1;
  const released = _runReaperPass();

  assert.ok(!released.some((r) => r.sandboxId === a.entry.sandboxId), "TTL cap does not apply to the user's own machine");
  await releaseSandbox(a.entry.sandboxId);
});

test("an SSH machine sandbox is exempt on the same grounds", async () => {
  _resetForTest();
  const a = await allocateSandbox({
    userId: "u-life3",
    sessionId: "life-s3",
    workspaceMode: "user",
    machine: { id: "m-ssh", kind: "ssh", host: "h", user: "u", root: "/w" },
  });
  const entry = getActive(a.entry.sandboxId);
  entry.idleAt = Date.now() - 86_400_000;
  entry.ttlAt = Date.now() - 1;

  const released = _runReaperPass();
  assert.ok(!released.some((r) => r.sandboxId === a.entry.sandboxId), "SSH machines run on the user's hardware too");
  await releaseSandbox(a.entry.sandboxId);
});

test("a cloud sandbox is still idle-reaped — the exemption is not global", async () => {
  _resetForTest();
  const a = await allocateSandbox({ userId: "u-life4", sessionId: "life-s4", workspaceMode: "user" });
  const entry = getActive(a.entry.sandboxId);
  assert.equal(entry.machineKind, null, "no machine → cloud");

  entry.idleAt = Date.now() - 1;
  const released = _runReaperPass();
  const ours = released.find((r) => r.sandboxId === a.entry.sandboxId);
  assert.ok(ours, "cloud sandbox reaped");
  assert.equal(ours.reason, "idle");
});

test("a cloud sandbox is reaped at the opt-in max lifetime (TTL no longer reaps)", async () => {
  _resetForTest();
  const { setPoolPolicy, resetPoolPolicyForTests } = await import("./policy.mjs");
  const a = await allocateSandbox({ userId: "u-life5", sessionId: "life-s5", workspaceMode: "user" });
  const entry = getActive(a.entry.sandboxId);
  entry.ttlAt = Date.now() - 1;
  assert.equal(_runReaperPass().find((r) => r.sandboxId === a.entry.sandboxId), undefined, "TTL alone must not reap");
  setPoolPolicy({ maxLifetime: { enabled: true, hours: 1 } });
  try {
    entry.leasedAt = Date.now() - 2 * 3_600_000;
    const ours = _runReaperPass().find((r) => r.sandboxId === a.entry.sandboxId);
    assert.ok(ours, "cloud sandbox reaped at max lifetime");
    assert.equal(ours.reason, "max_lifetime");
  } finally { resetPoolPolicyForTests(); }
});

test("the cloud idle window is 15 minutes by default", async () => {
  const { config } = await import("../config.mjs");
  assert.equal(config.pool.idleTimeoutSec, 900, "SANDBOX_DEFAULT_IDLE_TIMEOUT_SEC default");
});

test("a cloud sandbox's idle deadline is set from that window, and a machine's is not set at all", async () => {
  _resetForTest();
  const cloudAlloc = await allocateSandbox({ userId: "u-life6", sessionId: "life-s6", workspaceMode: "user" });
  const cloudEntry = getActive(cloudAlloc.entry.sandboxId);
  const window = cloudEntry.idleAt - cloudEntry.lastActivityAt;
  assert.ok(Math.abs(window - 900_000) < 2_000, `idle window ≈ 15 min, got ${window}ms`);
  await releaseSandbox(cloudAlloc.entry.sandboxId);

  registerMachineConnection({ machineId: LOCAL.id, userId: "u-life7", send() {} });
  const localAlloc = await allocateSandbox({ userId: "u-life7", sessionId: "life-s7", workspaceMode: "user", machine: LOCAL });
  const localEntry = getActive(localAlloc.entry.sandboxId);
  assert.equal(localEntry.idleAt, null, "a machine-bound sandbox carries no idle deadline");
  await releaseSandbox(localAlloc.entry.sandboxId);
});

// ── revoke is the only thing that can clean these up ─────────────────────────
//
// The exemption above is deliberate and stays. Its consequence is that a
// machine-bound entry has NO deadline at all: `idleAt` is null at allocation
// and stays null on every touch. So when the app revokes the machine, nothing
// else will ever remove the entry — `revokeMachine` closed the relay
// connection and left the routing record behind, pointing at hardware that can
// no longer answer. Every pair/revoke cycle leaked one, which is why the e2e
// left five behind and they had to be released by hand.

test("revoking a machine releases the sandboxes bound to it — nothing else ever will", async () => {
  _resetForTest();
  registerMachineConnection({ machineId: LOCAL.id, userId: "u-rev", send() {} });
  const mine = await allocateSandbox({ userId: "u-rev", sessionId: "rev-s1", workspaceMode: "user", machine: LOCAL });
  const alsoMine = await allocateSandbox({ userId: "u-rev", sessionId: "rev-s2", workspaceMode: "user", machine: { ...LOCAL, root: "/other" } });

  // Two that must SURVIVE: a different machine, and the cloud. A release that
  // took these too would log a user out of a computer they never revoked.
  registerMachineConnection({ machineId: "m-bystander", userId: "u-rev", send() {} });
  const bystander = await allocateSandbox({ userId: "u-rev", sessionId: "rev-s3", workspaceMode: "user", machine: { id: "m-bystander", kind: "local", root: "/w" } });
  const cloudBox = await allocateSandbox({ userId: "u-rev", sessionId: "rev-s4", workspaceMode: "user" });

  assert.equal(getActive(mine.entry.sandboxId).idleAt, null, "the premise: no deadline, so no reaper pass can ever collect it");

  // `{ released }`, not a bare array: the two lines each wrote this function and
  // the merged one keeps ava-roy's shape, because relay/routes.mjs reports the
  // release count next to the forgotten cert principals.
  const { released } = await releaseMachineSandboxes(LOCAL.id, "revoked by user");
  assert.deepEqual(
    released.sort(),
    [mine.entry.sandboxId, alsoMine.entry.sandboxId].sort(),
    "both of the revoked machine's sandboxes, and only those",
  );
  for (const id of released) {
    assert.throws(() => getActive(id), /not found/, `${id} is gone from the pool`);
  }
  assert.ok(listActive().some((e) => e.sandboxId === bystander.entry.sandboxId), "another machine's sandbox survives");
  assert.ok(listActive().some((e) => e.sandboxId === cloudBox.entry.sandboxId), "the cloud sandbox survives");

  await releaseSandbox(bystander.entry.sandboxId);
  await releaseSandbox(cloudBox.entry.sandboxId);
});

test("releasing an unknown machine's sandboxes is a no-op, not an error", async () => {
  _resetForTest();
  assert.deepEqual((await releaseMachineSandboxes("m-never-paired", "revoked")).released, []);
  // Guards the revoke route: it runs this unconditionally, including for a
  // machine that was revoked twice or never allocated anything.
  assert.deepEqual((await releaseMachineSandboxes("", "revoked")).released, [], "an empty id must not match entries whose machineId is null");
});

// The function existing is not the fix; the revoke ROUTE calling it is. This
// drives the real handler, in this file rather than relay/routes.test.mjs,
// because the pool fixture (a fake cube backend) lives here and that file
// deliberately loads no pool.
test("the revoke route releases the machine's sandboxes, not just the connection", async () => {
  _resetForTest();
  const { Readable } = await import("node:stream");
  const { handleRelayRevoke } = await import("../relay/routes.mjs");

  registerMachineConnection({ machineId: LOCAL.id, userId: "u-route", send() {} });
  const a = await allocateSandbox({ userId: "u-route", sessionId: "route-s1", workspaceMode: "user", machine: LOCAL });

  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ reason: "revoked by user" }))]), { headers: {}, method: "POST" });
  let status = 0
  let payload = ""
  const res = {
    writeHead(code) { status = code },
    setHeader() {},
    end(body) { payload = String(body ?? "") },
  };
  await handleRelayRevoke(req, res, { params: { machineId: LOCAL.id }, requestId: "t" });

  assert.equal(status, 200);
  assert.equal(JSON.parse(payload).revoked, true, "the connection was closed");
  assert.throws(() => getActive(a.entry.sandboxId), /not found/, "and the routing record is gone with it");
});

// ── the filer guard, at the allocation seam ──────────────────────────────────
//
// The unit tests in cube/filer-exposure.test.mjs prove the RULE. These prove it
// is CONNECTED, and — more importantly — that connecting it did not take the
// local-machine product down with it. A guard that refuses everything is not
// obviously different from a guard that works, until someone tries to use their
// own laptop.

const { _resetFilerVerdictForTest, _filerProbeStateForTest } = await import("./manager.mjs");

test("an exposed host refuses a CLOUD sandbox, with the reason attached", async () => {
  _resetForTest();
  _resetFilerVerdictForTest();
  const before = { ...process.env };
  // Everything the probe needs, pointed at a filer that will answer: the probe
  // itself is exercised for real in cube/filer-exposure.test.mjs, so here it is
  // driven through env to the "reachable" branch by an image that has no tool…
  // no — that would be UNKNOWN. Acknowledgement absent + reachable is the case
  // under test, so the probe must genuinely answer; a docker-less runner gives
  // `null`, which is the OTHER refusal. Both refuse, so assert on the code.
  process.env.WEED_S3_ENDPOINT = "http://seaweedfs:8333";
  process.env.SANDBOX_DOCKER_NETWORK = "";      // → probe cannot run → UNKNOWN
  delete process.env.SANDBOX_ALLOW_ANONYMOUS_FILER;
  try {
    await assert.rejects(
      () => allocateSandbox({ userId: "u-guard1", sessionId: "guard-s1", workspaceMode: "user" }),
      (err) => {
        assert.match(String(err.code), /^filer_exposure_/, `refused for the filer reason, not something else: ${err.code}`);
        assert.equal(err.status, 503, "a host that will not serve is unavailable, not a bad request");
        assert.match(String(err.message), /SANDBOX_ALLOW_ANONYMOUS_FILER/, "names the escape hatch");
        return true;
      },
    );
  } finally {
    Object.assign(process.env, before);
    _resetFilerVerdictForTest();
  }
});

test("the SAME host still allocates a machine-bound sandbox — the guard is scoped", async () => {
  _resetForTest();
  _resetFilerVerdictForTest();
  const before = { ...process.env };
  process.env.WEED_S3_ENDPOINT = "http://seaweedfs:8333";
  process.env.SANDBOX_DOCKER_NETWORK = "";
  delete process.env.SANDBOX_ALLOW_ANONYMOUS_FILER;
  try {
    registerMachineConnection({ machineId: LOCAL.id, userId: "u-guard2", send() {} });
    // If this throws, the guard has taken down the user's own machine to fix a
    // hazard that machine does not have: it mounts nothing here and holds no
    // filer route.
    const a = await allocateSandbox({ userId: "u-guard2", sessionId: "guard-s2", workspaceMode: "user", machine: LOCAL });
    assert.ok(getActive(a.entry.sandboxId), "allocated");
    await releaseSandbox(a.entry.sandboxId);
  } finally {
    Object.assign(process.env, before);
    _resetFilerVerdictForTest();
  }
});

test("an acknowledged deployment allocates cloud sandboxes again", async () => {
  _resetForTest();
  _resetFilerVerdictForTest();
  const before = { ...process.env };
  process.env.WEED_S3_ENDPOINT = "http://seaweedfs:8333";
  process.env.SANDBOX_DOCKER_NETWORK = "";
  process.env.SANDBOX_ALLOW_ANONYMOUS_FILER = "1";
  try {
    const a = await allocateSandbox({ userId: "u-guard3", sessionId: "guard-s3", workspaceMode: "user" });
    assert.ok(getActive(a.entry.sandboxId), "the escape hatch is real — otherwise nobody could run today");
    await releaseSandbox(a.entry.sandboxId);
  } finally {
    Object.assign(process.env, before);
    _resetFilerVerdictForTest();
  }
});

test("the PROBE runs once, not per allocation", async () => {
  // This test used to flip the acknowledgement after the first allocation and
  // assert the second still succeeded — using "the verdict did not change" as
  // a stand-in for "no container was started". The two came apart once the
  // probe and the verdict were separated (manager.mjs), and only one of them
  // was ever the property worth having:
  //
  //   · no `docker run` in front of a user's sandbox — REAL, asserted here by
  //     the probe's own timestamp rather than by a proxy;
  //   · an operator who WITHDRAWS the acknowledgement keeps being told the
  //     host is fine until the process restarts — NOT a property anyone chose.
  //     It was a side effect of caching both answers together.
  _resetForTest();
  _resetFilerVerdictForTest();
  const before = { ...process.env };
  process.env.WEED_S3_ENDPOINT = "http://seaweedfs:8333";
  process.env.SANDBOX_DOCKER_NETWORK = "";
  process.env.SANDBOX_ALLOW_ANONYMOUS_FILER = "1";
  try {
    const a = await allocateSandbox({ userId: "u-guard4", sessionId: "guard-s4a", workspaceMode: "user" });
    const first = _filerProbeStateForTest();
    assert.ok(first, "the probe ran and was cached");

    const b = await allocateSandbox({ userId: "u-guard4b", sessionId: "guard-s4b", workspaceMode: "user" });
    assert.ok(getActive(b.entry.sandboxId), "the second allocation went through");
    assert.deepEqual(
      _filerProbeStateForTest(),
      first,
      "the probe was not re-run — re-running it per allocation would put a docker run in front of every sandbox",
    );
    await releaseSandbox(a.entry.sandboxId);
    await releaseSandbox(b.entry.sandboxId);
  } finally {
    Object.assign(process.env, before);
    _resetFilerVerdictForTest();
  }
});

test("WITHDRAWING the acknowledgement takes effect without a restart, and without a new probe", async () => {
  // The other half of the split. An acknowledgement is an operator's standing
  // decision to accept a known hazard; withdrawing it is a decision to stop
  // accepting it. If that needs a process restart to take hold, the guard
  // cannot be re-armed without downtime — and, worse, the operator who
  // withdrew it gets no signal that it did not take.
  _resetForTest();
  _resetFilerVerdictForTest();
  const before = { ...process.env };
  process.env.WEED_S3_ENDPOINT = "http://seaweedfs:8333";
  process.env.SANDBOX_DOCKER_NETWORK = "";
  process.env.SANDBOX_ALLOW_ANONYMOUS_FILER = "1";
  try {
    const a = await allocateSandbox({ userId: "u-guard5", sessionId: "guard-s5a", workspaceMode: "user" });
    await releaseSandbox(a.entry.sandboxId);
    const probed = _filerProbeStateForTest();

    delete process.env.SANDBOX_ALLOW_ANONYMOUS_FILER;
    await assert.rejects(
      () => allocateSandbox({ userId: "u-guard5b", sessionId: "guard-s5b", workspaceMode: "user" }),
      (err) => {
        assert.match(String(err.code), /^filer_exposure_/, `refused for the filer reason, not something else: ${err.code}`);
        return true;
      },
      "withdrawing the acknowledgement must re-arm the guard on the next allocation",
    );
    assert.deepEqual(_filerProbeStateForTest(), probed, "and it cost no new container: the verdict is recomputed, the probe is not");
  } finally {
    Object.assign(process.env, before);
    _resetFilerVerdictForTest();
  }
});
