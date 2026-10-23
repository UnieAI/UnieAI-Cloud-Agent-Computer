/**
 * pool/manager.test.mjs — Targeted tests for per-user concurrency quota.
 *
 * Mocks the backend so allocation is a no-op; we only exercise the
 * pre-backend gating (session reuse / per-user limit / pool exhaustion).
 */

// The filer guard (cube/filer-exposure.mjs) refuses CLOUD sandboxes on a host
// where a sandbox can reach an unauthenticated filer — or where the probe
// cannot answer, which is every test runner. These suites are about the pool,
// not about the filer, so they declare the acceptance the same way a
// deployment would.
//
// Set here rather than deleted from the guard on purpose: the guard's own
// refusals are asserted in cube/filer-exposure.test.mjs and in the three
// allocation tests at the end of machine-lifecycle.test.mjs. A blanket
// "tests are exempt" would have removed the only thing that fails when the
// guard stops working.
process.env.SANDBOX_ALLOW_ANONYMOUS_FILER = "1";

process.env.SANDBOX_USER_MAX_ACTIVE = "2";
process.env.SANDBOX_POOL_TOTAL_MAX = "100";

import test from "node:test";
import assert from "node:assert/strict";

// Inject a pure in-memory backend so each createSandbox returns synthetic IDs
// without a docker daemon / FUSE. cube/index.mjs::setBackend is the documented
// test seam (replaces the removed stub host-exec backend). `real` is the live
// object the manager calls; the per-test tweaks below patch it in place.
const cube = await import("../cube/index.mjs");
let _ctr = 0;
const real = {
  createSandbox: async ({ userId, sessionId }) => ({
    sandboxId: `sbx_${++_ctr}`,
    workspaceId: `ws_${_ctr}`,
    workspaceDir: `/tmp/fake_${_ctr}`,
    userId, sessionId
  }),
  destroySandbox: async () => undefined
};
cube.resetBackend();
cube.setBackend(real);

const { allocateSandbox, releaseSandbox } = await import("./manager.mjs");

test("allows up to userMaxActive sandboxes for same user", async () => {
  const a = await allocateSandbox({ userId: "u1", sessionId: "s1" });
  const b = await allocateSandbox({ userId: "u1", sessionId: "s2" });
  assert.ok(a.entry.sandboxId);
  assert.ok(b.entry.sandboxId);
  await releaseSandbox(a.entry.sandboxId);
  await releaseSandbox(b.entry.sandboxId);
});

test("rejects third concurrent sandbox with 429 user_quota_exceeded", async () => {
  const a = await allocateSandbox({ userId: "u2", sessionId: "u2-s1" });
  const b = await allocateSandbox({ userId: "u2", sessionId: "u2-s2" });
  await assert.rejects(
    async () => allocateSandbox({ userId: "u2", sessionId: "u2-s3" }),
    (err) => {
      assert.equal(err.code, "user_quota_exceeded");
      assert.equal(err.status, 429);
      assert.equal(err.details.retry_after, 10);
      assert.equal(err.details.limit, 2);
      assert.equal(err.details.active, 2);
      return true;
    }
  );
  await releaseSandbox(a.entry.sandboxId);
  await releaseSandbox(b.entry.sandboxId);
});

test("releasing a sandbox frees a quota slot", async () => {
  const a = await allocateSandbox({ userId: "u3", sessionId: "u3-s1" });
  const b = await allocateSandbox({ userId: "u3", sessionId: "u3-s2" });
  await releaseSandbox(a.entry.sandboxId);
  // Now under quota again — a fresh allocate should succeed.
  const c = await allocateSandbox({ userId: "u3", sessionId: "u3-s3" });
  assert.ok(c.entry.sandboxId);
  await releaseSandbox(b.entry.sandboxId);
  await releaseSandbox(c.entry.sandboxId);
});

test("session reuse does NOT count against quota", async () => {
  const a = await allocateSandbox({ userId: "u4", sessionId: "u4-s1" });
  const b = await allocateSandbox({ userId: "u4", sessionId: "u4-s2" });
  // Re-allocating with an existing sessionId should reuse, not allocate.
  const reused = await allocateSandbox({ userId: "u4", sessionId: "u4-s1" });
  assert.equal(reused.entry.sandboxId, a.entry.sandboxId);
  assert.equal(reused.reconnect, true);
  await releaseSandbox(a.entry.sandboxId);
  await releaseSandbox(b.entry.sandboxId);
});

test("quota does NOT apply when userId is missing", async () => {
  // Anonymous allocations bypass the per-user gate (still subject to totalMax).
  const a = await allocateSandbox({ sessionId: "anon-s1" });
  const b = await allocateSandbox({ sessionId: "anon-s2" });
  const c = await allocateSandbox({ sessionId: "anon-s3" });
  assert.ok(a.entry.sandboxId && b.entry.sandboxId && c.entry.sandboxId);
  await releaseSandbox(a.entry.sandboxId);
  await releaseSandbox(b.entry.sandboxId);
  await releaseSandbox(c.entry.sandboxId);
});

// ---------------------------------------------------------------------------
// Layer-2 audit H — per-userId allocation lock
// ---------------------------------------------------------------------------

test("H: parallel allocations for same user with different sessions don't race", async () => {
  // Without the alloc lock, two parallel allocates with sessionIds s1 and s2
  // (and workspaceMode user) would both see byUser as empty (because backend
  // createSandbox is awaited between byUser.has and byUser.set), and each
  // would create a fresh sandbox. With the lock, the second call observes
  // the first's allocation and reuses it (workspaceMode === "user").
  const [a, b] = await Promise.all([
    allocateSandbox({ userId: "u-H1", sessionId: "h1-s1", workspaceMode: "user" }),
    allocateSandbox({ userId: "u-H1", sessionId: "h1-s2", workspaceMode: "user" }),
  ]);
  // The second should reuse the first's sandbox (per-user singleton policy).
  assert.equal(b.entry.sandboxId, a.entry.sandboxId, "second alloc reused the first sandbox");
  assert.equal(b.reconnect, true);
  await releaseSandbox(a.entry.sandboxId);
});

test("H: parallel allocations for different users don't serialize", async () => {
  // Different userIds → no shared lock → allocations proceed in parallel.
  const start = Date.now();
  const [a, b, c] = await Promise.all([
    allocateSandbox({ userId: "u-H2a", sessionId: "h2-s1" }),
    allocateSandbox({ userId: "u-H2b", sessionId: "h2-s2" }),
    allocateSandbox({ userId: "u-H2c", sessionId: "h2-s3" }),
  ]);
  const elapsed = Date.now() - start;
  assert.notEqual(a.entry.sandboxId, b.entry.sandboxId);
  assert.notEqual(b.entry.sandboxId, c.entry.sandboxId);
  // Stub backend createSandbox is synchronous-ish (no real awaits), so this
  // is mostly a safety assertion: 3 parallel allocs shouldn't dramatically
  // amplify the time vs. one alloc. Just make sure they all succeeded.
  assert.ok(elapsed < 1000, `parallel allocs completed in ${elapsed}ms`);
  await releaseSandbox(a.entry.sandboxId);
  await releaseSandbox(b.entry.sandboxId);
  await releaseSandbox(c.entry.sandboxId);
});

// ---------------------------------------------------------------------------
// Layer-2 audit G — idle reaper
// ---------------------------------------------------------------------------

test("G: _runReaperPass releases sandboxes whose idleAt has passed", async () => {
  const { _runReaperPass, getActive, listActive } = await import("./manager.mjs");
  const a = await allocateSandbox({ userId: "u-G1", sessionId: "g1-s1" });
  // Force idleAt into the past — simulates a sandbox that's been quiet
  // longer than its idleTimeout. getActive returns the live entry so
  // mutating it mutates pool state.
  const entry = getActive(a.entry.sandboxId);
  entry.idleAt = Date.now() - 1;
  // Run one reaper pass and verify it picked up our sandbox by idle reason.
  const released = _runReaperPass();
  const ours = released.find((r) => r.sandboxId === a.entry.sandboxId);
  assert.ok(ours, "reaper released the idle sandbox");
  assert.equal(ours.reason, "idle");

  // Active map should no longer have it (releaseSandbox is async but it
  // synchronously deletes from `active` before destroy). Allow a tick.
  await new Promise((r) => setImmediate(r));
  assert.ok(!listActive().some((e) => e.sandboxId === a.entry.sandboxId), "sandbox removed from active");
});

test("G: a passed ttlAt no longer reaps — only idle does (roy 2026-10-21)", async () => {
  // 14:20 那天 TTL 把一個每分鐘都在工作的沙盒砍了（pool.reap_ttl aliveMs=3600923）。
  const { _runReaperPass, getActive } = await import("./manager.mjs");
  const a = await allocateSandbox({ userId: "u-G2", sessionId: "g2-s1" });
  const entry = getActive(a.entry.sandboxId);
  entry.ttlAt = Date.now() - 1;
  const released = _runReaperPass();
  assert.equal(released.find((r) => r.sandboxId === a.entry.sandboxId), undefined, "TTL 又在回收了");
  assert.ok(getActive(a.entry.sandboxId), "沙盒應該還在");
  await releaseSandbox(a.entry.sandboxId);
});

test("G: _runReaperPass leaves active-and-fresh sandboxes alone", async () => {
  const { _runReaperPass, listActive } = await import("./manager.mjs");
  const a = await allocateSandbox({ userId: "u-G3", sessionId: "g3-s1" });
  const released = _runReaperPass();
  assert.ok(!released.find((r) => r.sandboxId === a.entry.sandboxId), "fresh sandbox not reaped");
  assert.ok(listActive().some((e) => e.sandboxId === a.entry.sandboxId), "still active");
  await releaseSandbox(a.entry.sandboxId);
});

// ---------------------------------------------------------------------------
// Phase 4.2 — workspaceMountPath plumb-through
// ---------------------------------------------------------------------------

test("4.2: allocateSandbox forwards workspaceMountPath to backend.createSandbox", async () => {
  const { getActive } = await import("./manager.mjs");
  // Capture the args the manager hands to backend.createSandbox so we can
  // assert workspaceMountPath survives the call shape transition (caller
  // workspaceMountPath → backend.createSandbox arg).
  const originalCreate = real.createSandbox;
  let captured = null;
  real.createSandbox = async (args) => {
    captured = args;
    return originalCreate(args);
  };
  try {
    const mountPath = "/tmp/agent-fs/u-42/sessions/sess-mount-1";
    const r = await allocateSandbox({
      userId: "u-42",
      sessionId: "sess-mount-1",
      workspaceMountPath: mountPath,
      workspaceMode: "user",
    });
    assert.ok(captured, "backend.createSandbox was called");
    assert.equal(captured.workspaceMountPath, mountPath,
      "backend received workspaceMountPath");
    // Manager also stashes the path on the entry for introspection.
    const entry = getActive(r.entry.sandboxId);
    assert.equal(entry.workspaceMountPath, mountPath);
    await releaseSandbox(r.entry.sandboxId);
  } finally {
    real.createSandbox = originalCreate;
  }
});

test("4.2: back-compat — missing workspaceMountPath still allocates", async () => {
  // Legacy callers (and the stub fake) don't pass the new field at all.
  // The plumb-through must not crash or change behaviour for them; the
  // entry just lacks the field.
  const { getActive } = await import("./manager.mjs");
  const r = await allocateSandbox({ userId: "u-42b", sessionId: "sess-mount-back-compat" });
  const entry = getActive(r.entry.sandboxId);
  assert.equal(entry.workspaceMountPath, null,
    "entry.workspaceMountPath is null when caller didn't pass one");
  await releaseSandbox(r.entry.sandboxId);
});

test("4.2: empty/whitespace workspaceMountPath normalises to null", async () => {
  // Guard against the "" or " " degenerate case escaping through the
  // pipeline and being recorded as a real bind-mount instruction.
  const { getActive } = await import("./manager.mjs");
  const r = await allocateSandbox({
    userId: "u-42c",
    sessionId: "sess-mount-empty",
    workspaceMountPath: "",
  });
  const entry = getActive(r.entry.sandboxId);
  assert.equal(entry.workspaceMountPath, null);
  await releaseSandbox(r.entry.sandboxId);
});

// ---------------------------------------------------------------------------
// H1 — long, output-less execs must not be idle-reaped mid-run
// ---------------------------------------------------------------------------

test("H1: _runReaperPass skips a sandbox with a running exec", async () => {
  const { EventEmitter } = await import("node:events");
  const { _runReaperPass, getActive, touchActivity } = await import("./manager.mjs");
  const { registerExec, cancelExec } = await import("../exec/streams.mjs");

  const a = await allocateSandbox({ userId: "u-H1exec", sessionId: "h1exec-s1" });
  const sandboxId = a.entry.sandboxId;

  // Register a fake exec that emits NO stdout/stderr — simulates `sleep 300`.
  // Its handle is an EventEmitter with the minimal shape registerExec needs.
  const handle = new EventEmitter();
  handle.execId = "exec-h1-fake";
  handle.cancel = () => {};
  registerExec({ sandboxId, handle, kind: "bash", command: "sleep 300", timeoutMs: 600000 });

  // Force the sandbox idle. Without the H1 guard the reaper would reap it even
  // though the exec is still running and has never produced output.
  const entry = getActive(sandboxId);
  entry.idleAt = Date.now() - 1;

  const released = _runReaperPass();
  assert.ok(
    !released.find((r) => r.sandboxId === sandboxId),
    "sandbox with a running exec must NOT be idle-reaped"
  );
  // The guard also refreshes the idle window so the sandbox doesn't sit at a
  // past idleAt forever.
  assert.ok(getActive(sandboxId).idleAt > Date.now(), "idle window refreshed");

  // Once the exec exits, a normal idle reap may proceed. cancelExec is scoped
  // to a sandbox now (exec/exec-scope.test.mjs — an execId alone was letting
  // one tenant kill another's command), so the owning id has to be named.
  cancelExec("exec-h1-fake", { sandboxId });
  const entry2 = getActive(sandboxId);
  entry2.idleAt = Date.now() - 1;
  const released2 = _runReaperPass();
  assert.ok(
    released2.find((r) => r.sandboxId === sandboxId),
    "after exec exits the idle sandbox reaps normally"
  );
  await new Promise((r) => setImmediate(r));
});

// ---------------------------------------------------------------------------
// H3 — user-mode release must never destroy the durable workspace
// ---------------------------------------------------------------------------

test("H3: releasing a user-mode sandbox never destroys its workspace (keepWorkspace forced true)", async () => {
  const { getActive } = await import("./manager.mjs");
  const originalDestroy = real.destroySandbox;
  let destroyArgs = null;
  real.destroySandbox = async (id, opts) => { destroyArgs = { id, opts }; };
  try {
    const a = await allocateSandbox({
      userId: "u-H3", sessionId: "h3-s1", workspaceMode: "user"
    });
    const sandboxId = a.entry.sandboxId;
    assert.equal(getActive(sandboxId).workspaceMode, "user");

    // Even though the caller asks to drop the workspace, user-mode forces
    // keepWorkspace:true so the durable S3 blobs/manifest survive teardown.
    await releaseSandbox(sandboxId, { keepWorkspace: false, destroy: true });
    assert.ok(destroyArgs, "backend.destroySandbox was called");
    assert.equal(destroyArgs.opts?.keepWorkspace, true,
      "user-mode release must preserve the workspace");
  } finally {
    real.destroySandbox = originalDestroy;
  }
});

// ── 使用者自己的機器不吃雲端配額（2026-09-06）──────────────────────────────
//
// roy 選了自己的 Linux 機器，連 `ls` 都跑不了：
//   指令沒有被執行：配置沙盒失敗 (429):
//     {"code":"user_quota_exceeded","message":"Tenant has 3 active sandboxes (max 3)"}
//
// 他根本沒在用雲端。這個配額存在的理由是**我們這邊的容量**（每個雲端沙盒是一個
// 真的容器），而本機／SSH 落點的「沙盒」只是一筆登記 —— relay 的 createSandbox
// 自己寫著「Nothing to start: the daemon is already connected... this is a
// registration」。資源是他自己的電腦。
//
// 而且模型當時還叫他「到 UnieAI 平台的 Sandbox 頁面關掉一些」——那個頁面不存在。
// 一個他無法理解、也無法自救的錯誤。

test("本機落點不吃雲端配額 —— 額度滿了也連得上自己的電腦", async () => {
  await allocateSandbox({ userId: "u-mach", sessionId: "m-s1" });
  await allocateSandbox({ userId: "u-mach", sessionId: "m-s2" });
  // 雲端已經滿了（limit=2）
  await assert.rejects(
    async () => allocateSandbox({ userId: "u-mach", sessionId: "m-s3" }),
    (err) => err.code === "user_quota_exceeded",
  );
  // **本機的請求要走得過配額那一關。**
  //
  // 這個測試環境沒有活著的 daemon，所以它仍然會失敗 —— 但要失敗在**後端**
  // （「機器沒有連上」），不是失敗在配額。錯誤碼不是 `user_quota_exceeded`
  // 就是它通過了那一關的證明；能不能真的連上是 relay 那層的事，那邊有自己的測試。
  await assert.rejects(
    async () =>
      allocateSandbox({
        userId: "u-mach",
        sessionId: "m-s4",
        machine: { id: "mach-1", kind: "local", root: "/home/dev/work" },
      }),
    (err) => {
      assert.notEqual(err.code, "user_quota_exceeded", "選自己的電腦被雲端配額擋下來了");
      return true;
    },
  );
});

test("雲端的配額仍然擋得住 —— 這條放寬不可以把牆拆掉", async () => {
  // 上面兩條放寬的代價上限：純雲端的租戶行為完全不變。
  await allocateSandbox({ userId: "u-cloud", sessionId: "c-s1" });
  await allocateSandbox({ userId: "u-cloud", sessionId: "c-s2" });
  await assert.rejects(
    async () => allocateSandbox({ userId: "u-cloud", sessionId: "c-s3" }),
    (err) => err.code === "user_quota_exceeded" && err.status === 429,
  );
});

// ---------------------------------------------------------------------------
// SBX-02 — TTL 不可以砍斷正在做的事
//
// 閒置那條路早就有這個守衛（上面的 H1）：一個安靜但在跑的指令不會被回收。
// TTL 分支原本**沒有**，所以同一件事在兩條路上有兩種答案，而 TTL 給的是錯的
// 那一個 —— 跑到第 60 分鐘的任務會被無聲砍掉。
//
// 讓步不能是無限的：`sleep infinity` 若能永久延長，就會釘住一個位子，而
// `totalMax` 在正式主機上只有個位數。所以有一條絕對天花板，而且它回收時的
// reason 必須和 `ttl` 分得開 —— 「我的長任務被砍了」和「有個程序失控了」
// 在日誌裡是兩回事。
// ---------------------------------------------------------------------------

async function withFakeExec(sandboxId, command = "sleep 300") {
  const { EventEmitter } = await import("node:events");
  const { registerExec, cancelExec } = await import("../exec/streams.mjs");
  const handle = new EventEmitter();
  handle.execId = `exec-ttl-${sandboxId}`;
  handle.cancel = () => {};
  registerExec({ sandboxId, handle, kind: "bash", command, timeoutMs: 600000 });
  return () => { try { cancelExec(handle.execId); } catch { /* 已經收掉了 */ } };
}

test("SBX-02: 指令還在跑 —— 跑多久都不回收（沒開絕對壽命時）", async () => {
  const { _runReaperPass, getActive } = await import("./manager.mjs");
  const a = await allocateSandbox({ userId: "u-ttl-busy", sessionId: "ttl-busy-s1" });
  const sandboxId = a.entry.sandboxId;
  const stop = await withFakeExec(sandboxId);
  try {
    const entry = getActive(sandboxId);
    entry.leasedAt = Date.now() - 48 * 3_600_000;   // 兩天
    entry.ttlAt = Date.now() - 1;
    entry.idleAt = Date.now() - 1;
    const released = _runReaperPass();
    assert.ok(!released.find((r) => r.sandboxId === sandboxId), "一個還在工作的沙盒被回收了");
  } finally { stop(); await releaseSandbox(sandboxId); }
});

test("SBX-02: 平台設定打開絕對壽命 —— 到了就回收，即使在跑，reason 是 max_lifetime", async () => {
  const { _runReaperPass, getActive } = await import("./manager.mjs");
  const { setPoolPolicy, resetPoolPolicyForTests } = await import("./policy.mjs");
  assert.equal(setPoolPolicy({ maxLifetime: { enabled: true, hours: 12 } }), true);
  const a = await allocateSandbox({ userId: "u-ttl-runaway", sessionId: "ttl-runaway-s1" });
  const sandboxId = a.entry.sandboxId;
  const stop = await withFakeExec(sandboxId, "sleep infinity");
  try {
    getActive(sandboxId).leasedAt = Date.now() - (12 * 3_600_000 + 60_000);
    const released = _runReaperPass();
    const ours = released.find((r) => r.sandboxId === sandboxId);
    assert.ok(ours, "開了絕對壽命，過了還是沒回收");
    assert.equal(ours.reason, "max_lifetime");
  } finally { stop(); resetPoolPolicyForTests(); }
});

test("SBX-02: 絕對壽命沒開（預設）—— 過了 12 小時也不回收一個在跑的沙盒", async () => {
  const { _runReaperPass, getActive } = await import("./manager.mjs");
  const a = await allocateSandbox({ userId: "u-ttl-quiet", sessionId: "ttl-quiet-s1" });
  const sandboxId = a.entry.sandboxId;
  const stop = await withFakeExec(sandboxId, "python render.py");
  try {
    getActive(sandboxId).leasedAt = Date.now() - 13 * 3_600_000;
    const released = _runReaperPass();
    assert.equal(released.find((r) => r.sandboxId === sandboxId), undefined);
  } finally { stop(); await releaseSandbox(sandboxId); }
});

test('official terminal survives idle reaping without an exec; closing it restores normal reclamation',async()=>{
 const {EventEmitter}=await import('node:events');
 const {openTerminal,closeTerminal}=await import('../terminal/registry.mjs');
 const {_runReaperPass,getActive}=await import('./manager.mjs');
 const {entry}=await allocateSandbox({userId:'official-idle',sessionId:'official-idle'});
 const {terminalId}=await openTerminal({sandboxId:entry.sandboxId,backend:{openTerminal:async()=>new EventEmitter()},spec:{slot:'official.idle.claude'},attachDeadlineMs:0});
 await new Promise(r=>setImmediate(r));
 getActive(entry.sandboxId).idleAt=Date.now()-1000;
 assert.ok(!_runReaperPass().some(r=>r.sandboxId===entry.sandboxId));
 assert.ok(getActive(entry.sandboxId));
 await closeTerminal(entry.sandboxId,terminalId);
 getActive(entry.sandboxId).idleAt=Date.now()-1000;
 assert.ok(_runReaperPass().some(r=>r.sandboxId===entry.sandboxId && r.reason==='idle'));
});
