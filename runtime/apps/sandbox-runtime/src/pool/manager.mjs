/**
 * pool/manager.mjs — Minimal sandbox lifecycle manager (Phase 1).
 *
 * Phase 1 scope: allocate-on-demand only. No warm pool, no per-user quota,
 * no hibernate. Phase 2 will layer those on top of this same module.
 *
 * State is in-process. Phase 3 will mirror selected state into Redis
 * (key `sandbox:owner:{id}`) so multi-replica routing can find owners.
 */

import { EventEmitter } from "node:events";

import { config } from "../config.mjs";
import { SandboxError } from "../shared/error.mjs";
import { log } from "../shared/log.mjs";
import { emitLifecycleEvent } from "./lifecycle-telemetry.mjs";
import { effectiveTotalMax, getPoolPolicy } from "./policy.mjs";
import { hostAdmission, measureHost } from "./host-admission.mjs";

/** Common lifecycle-event detail payload from a pool entry. */
function lifecycleDetails(entry, extra = {}) {
  return {
    userId: entry.userId,
    sessionId: entry.sessionId,
    workspaceMode: entry.workspaceMode,
    workspaceOwner: entry.workspaceOwner,
    ...extra,
  };
}
import { getBackend, backendForMachine, bindSandboxBackend, releaseSandboxBackend } from "../cube/index.mjs";
import { resolveWorkspaceMountMode } from "../cube/host-mount.mjs";
import {
  ACK_ENV,
  exposureReport,
  exposureVerdict,
  guardAppliesTo,
  guestFilerAddress,
  probeFilerFromSandboxNetworkDetailed,
} from "../cube/filer-exposure.mjs";
import { closeSandboxTerminals } from "../terminal/registry.mjs";
import { localAgentSessions } from "../agent/registry.mjs";
import { restoreFromManifest } from "../env-capture/restore.mjs";
import { _bindActiveLookup } from "./machine-kind.mjs";
// 「這台機器現在還連著嗎」。這是機器綁定那一列**唯一**的失效訊號 —— 它沒有
// 閒置、沒有 TTL、不佔主機資源，能說它已經沒用的只有「連線不在了」。
// registry.mjs 只依賴 node:crypto 與 shared/log，所以這個 import 不成環。
import { isMachineOnline } from "../relay/registry.mjs";
import { forgetSandboxBase } from "../workspace/groupGit.mjs";

const active = new Map();    // sandboxId -> entry
const bySession = new Map(); // sessionId -> sandboxId
// ownerSlot -> sandboxId (only entries with workspaceMode === "user").
// Enforces the singleton policy from the B27 plan: a user opening agent mode in
// a second tab reuses their existing sandbox + workspace rather than racing on
// S3. The slot is `${userId}::${owner}` (owner = user:<id> personal | group:<gid>
// shared) so the SAME user can hold a personal AND a group sandbox at once, and
// two members of one group get SEPARATE sandboxes that share the group's S3
// prefix (the manifest lock + tombstone guard keep their writes coherent).
const byUser = new Map();

/**
 * The singleton-policy key for a (user, workspace-owner) pair.
 *
 * 個人工作區有兩種拼法都要落在同一個 slot：配置時是 `user:<id>`（server.mjs 的
 * allocate 路由），而 `resolveWorkspaceOwner` 對個人工作區回的是**裸的 userId**。
 * 以前兩者是不同的 key，用後者去查永遠查不到 —— `/v1/users/:id/workspace/sync`
 * 因此對每一個個人工作區都說 no_live_sandbox（2026-09-26 UAT B1，D2 查到的）。
 */
function ownerSlotOf(userId, owner) {
  const personal = `user:${userId || ""}`;
  const normalized = !owner || owner === userId ? personal : owner;
  return `${userId || ""}::${normalized}`;
}
// userId -> Promise (in-flight allocation for that user). Layer-2 audit H
// fix: byUser.has() and byUser.set() are separated by an await chain
// (backend.createSandbox, restoreFromManifest), so two parallel allocs for
// the same user can both see byUser as empty, both proceed, and both write
// to the same S3 prefix. This lock serialises allocations per userId —
// callers chain on the existing promise so the second caller observes the
// first's sandbox via byUser before deciding to allocate fresh.
const _allocLocks = new Map();

let reaperTimer = null;

// Pool lifecycle events for live admin UIs and other listeners.
//   · "created"  → emitted after a sandbox is allocated (including reconnects
//                  to the same session — those carry { reconnect: true })
//   · "released" → emitted after a sandbox is removed from active state
// The event payload is the public-shape entry (matches listActive() items)
// plus the reason for released events.
const events = new EventEmitter();
events.setMaxListeners(50);
export function onPoolEvent(handler) {
  events.on("event", handler);
  return () => { events.off("event", handler); };
}
function publicEntry(entry) {
  return {
    sandboxId: entry.sandboxId,
    workspaceId: entry.workspaceId,
    userId: entry.userId,
    sessionId: entry.sessionId,
    status: entry.status,
    workspaceMode: entry.workspaceMode || "ephemeral",
    leasedAt: entry.leasedAt,
    lastActivityAt: entry.lastActivityAt,
    ttlAt: entry.ttlAt
  };
}
function emitPoolEvent(kind, entry, extra = {}) {
  try {
    events.emit("event", { kind, ts: Date.now(), entry: publicEntry(entry), ...extra });
  } catch (err) {
    log("warn", "pool.event_emit_failed", { kind, message: err?.message || String(err) });
  }
}

function nowMs() { return Date.now(); }

/** 沒被呼叫端指定時的閒置窗（秒）：管理後台推來的政策，否則環境變數。 */
function policyIdleSec() {
  return Math.max(15, Math.round(getPoolPolicy().idleMinutes * 60));
}
function entryIdleSec(entry) {
  return entry.idleFromCaller && Number(entry.idleTimeoutSec) > 0 ? Number(entry.idleTimeoutSec) : policyIdleSec();
}

// 主機資源的讀取器（host-admission.mjs）。測試換成假的，不碰真的 /proc。
let _hostReaders = {};
export function _setHostReadersForTests(readers) { _hostReaders = readers || {}; }

// 背景程序偵測：閒置窗到期、沒有 exec 在跑時，量兩次容器的 CPU（隔 BACKGROUND_PROBE_MS），
// 中間用掉的 CPU 秒數過門檻就當作還在工作 —— 重新起算閒置窗，不回收。
const BACKGROUND_PROBE_MS = Number(process.env.SANDBOX_BACKGROUND_PROBE_MS) > 0 ? Number(process.env.SANDBOX_BACKGROUND_PROBE_MS) : 60_000;
const BACKGROUND_CPU_SEC_PER_MIN = Number(process.env.SANDBOX_BACKGROUND_CPU_SEC_PER_MIN) > 0 ? Number(process.env.SANDBOX_BACKGROUND_CPU_SEC_PER_MIN) : 3;
function sampleCpu(sandboxId) {
  try {
    const backend = getBackend(sandboxId);
    if (typeof backend?.cpuUsageUsec !== "function") return Promise.resolve(null);
    return Promise.resolve(backend.cpuUsageUsec(sandboxId)).catch(() => null);
  } catch { return Promise.resolve(null); }
}
/**
 * 閒置窗到期時呼叫。回 true＝這一輪先別回收（量測進行中，或量到還在用 CPU）。
 * 狀態放在 entry._cpuProbe；任何活動（touchActivity）都會把它清掉。
 */
function backgroundBusy(entry, now) {
  // 後端量不了 CPU（stub、ssh、測試的假後端）就照原本的規則：閒置窗到了就回收，不多等一個窗。
  let supported = false;
  try { supported = typeof getBackend(entry.sandboxId)?.cpuUsageUsec === "function"; } catch { supported = false; }
  if (!supported) return false;
  const probe = entry._cpuProbe;
  if (!probe) {
    entry._cpuProbe = { state: "first" };
    sampleCpu(entry.sandboxId).then((usec) => {
      if (entry._cpuProbe?.state !== "first") return;
      entry._cpuProbe = usec === null ? { state: "unsupported" } : { state: "sampled", usec, at: nowMs() };
    });
    entry.idleAt = now + BACKGROUND_PROBE_MS;
    return true;
  }
  if (probe.state === "first" || probe.state === "second") return true;
  if (probe.state === "sampled") {
    if (now - probe.at < BACKGROUND_PROBE_MS) return true;
    entry._cpuProbe = { ...probe, state: "second" };
    sampleCpu(entry.sandboxId).then((usec) => {
      if (entry._cpuProbe?.state !== "second") return;
      const minutes = Math.max(1 / 60, (nowMs() - probe.at) / 60_000);
      const cpuSecPerMin = usec === null ? 0 : (usec - probe.usec) / 1e6 / minutes;
      if (cpuSecPerMin >= BACKGROUND_CPU_SEC_PER_MIN) {
        log("info", "pool.idle_deferred_background", { sandboxId: entry.sandboxId, cpuSecPerMin: Math.round(cpuSecPerMin * 10) / 10 });
        touchActivity(entry.sandboxId, "background");
      } else {
        entry._cpuProbe = { state: "quiet" };
      }
    });
    return true;
  }
  return false; // "quiet" 或 "unsupported"：照閒置回收
}

function makeEntry({
  sandboxId, workspaceId, userId, endUserId, sessionId, image,
  resourceQuota, networkPolicy, ttlSec, idleTimeoutSec, metadata, workspaceDir,
  workspaceMode, workspaceMountPath, workspaceOwner
}) {
  const now = nowMs();
  const effectiveIdleSec = Math.max(15, Number(idleTimeoutSec) > 0 ? Number(idleTimeoutSec) : policyIdleSec());
  const lifeTtlSec = Math.max(1, Number(ttlSec) || config.pool.ttlSec);
  return {
    sandboxId,
    workspaceId,
    workspaceDir: workspaceDir || null,
    userId: userId || null,
    // Optional second-level identifier — when the platform user is a B2B
    // developer servicing multiple end customers, end_user_id keeps each
    // customer's sandbox quota / state separate (OpenAI's `body.user`).
    endUserId: endUserId || null,
    sessionId: sessionId || null,
    image: image || null,
    resourceQuota: resourceQuota || null,
    networkPolicy: networkPolicy || "egress_deny",
    idleTimeoutSec: effectiveIdleSec,
    // 呼叫端自己指定了閒置窗（app 的 allocateSandbox 送 600）就照它；沒指定（引擎）就跟著
    // 管理後台推來的政策走 —— 改了設定，已經開著的沙盒下一次活動起也照新值算。
    idleFromCaller: Number(idleTimeoutSec) > 0,
    // Free-form tags forwarded to the Cube vendor for per-tenant resource
    // labels / billing aggregation. Stub backend ignores. Keys we propagate
    // by convention: tenant_id, custom_model_id, end_user_id, session_id.
    metadata: metadata && typeof metadata === "object" ? { ...metadata } : null,
    // "ephemeral" (default) — per-session, gone on release.
    // "user" — singleton bound to an S3-backed workspace.
    workspaceMode: workspaceMode === "user" ? "user" : "ephemeral",
    // The S3 prefix owner this sandbox hydrates from / syncs to: `user:<id>`
    // (personal) or `group:<gid>` (enterprise shared project). Null/ephemeral
    // sandboxes have none. Used by hydrate/sync to key the S3 prefix.
    workspaceOwner: workspaceMode === "user"
      ? (workspaceOwner || `user:${userId || ""}`)
      : null,
    // Phase 4.2: caller-supplied host path that was (or would be) bind-
    // mounted into /workspace. Stashed for diagnostics + introspection.
    // Backend bind-mount happens (or no-ops in stub) inside createSandbox.
    workspaceMountPath: typeof workspaceMountPath === "string" && workspaceMountPath
      ? workspaceMountPath
      : null,
    status: "ready",
    leasedAt: now,
    lastActivityAt: now,
    ttlAt: now + lifeTtlSec * 1000,
    idleAt: now + effectiveIdleSec * 1000,
    // Phase 2 env restore promise. Populated below at allocation time
    // for fresh sandboxes; resolves once the manifest replay finishes
    // (or skips, or fails — never rejects). dispatchExec awaits this
    // before running the first user-visible command so the env is
    // ready by the time the agent reaches for it. Reused sandboxes
    // leave this null — their env is already populated from the prior
    // lease.
    restorePromise: null
  };
}

/**
 * The filer verdict for this process, computed once.
 *
 * Once, because the probe costs a container and the answer is a property of
 * the host's network rather than of the request. Cached as the PROMISE so
 * concurrent first allocations share one probe instead of racing several.
 *
 * Not cached across restarts on purpose: the network is exactly the kind of
 * thing that changes underneath a long-lived process, and a restart is the
 * cheapest moment to find out.
 */
/**
 * How long a verdict may serve before the host's network is asked again.
 *
 * The memo below is right about the cost — a probe starts a container — and
 * right that the answer belongs to the host rather than to a request. It was
 * wrong about only one thing: that the answer cannot change while the process
 * lives. It can, in two ways that need two different mechanisms.
 *
 * A CONFIG change (the sandbox network repointed, the mount mode reverted, the
 * endpoint moved) is caught by keying the memo on those inputs — free, exact,
 * and immediate. A NETWORK change under a stable config (somebody recreates
 * the docker network, or attaches the filer to it) moves no env var and can
 * only be caught by probing again.
 *
 * Fifteen minutes, and the re-probe runs OFF the allocation path: the cached
 * verdict keeps serving while it runs, so no user's sandbox ever waits behind
 * a container start. That ordering is the whole design. A re-probe placed on
 * the allocation path would have made the guard's cost proportional to
 * traffic, which is how a safety check gets turned off by whoever is on call.
 */
/**
 * How long a filer PROBE may serve before the host's network is asked again.
 *
 * Fifteen minutes, and the re-probe runs OFF the allocation path: the cached
 * answer keeps serving while it runs, so no user's sandbox waits behind a
 * container start. That ordering is the whole design — a re-probe on the
 * allocation path makes the guard's cost proportional to traffic, which is how
 * a safety check gets turned off by whoever is on call.
 */
export const FILER_VERDICT_TTL_MS = 15 * 60 * 1000;

/**
 * THE PROBE AND THE VERDICT ARE DIFFERENT QUESTIONS, and separating them is
 * what makes this cache correct rather than merely cheap.
 *
 * The PROBE — can a container on the sandbox network open a socket to the
 * filer — costs a `docker run` and depends only on the network, the image and
 * the filer's address. Cache it.
 *
 * The VERDICT — should this allocation proceed — is `exposureVerdict()` over
 * that reachability plus the mount mode plus whether an operator has ACCEPTED
 * the hazard. Those two are env reads and a few comparisons. Recompute them
 * every time; there is nothing to save.
 *
 * They used to be cached together, and the coupling had a consequence nobody
 * chose: an operator who WITHDREW the acknowledgement got no protection back
 * until the process restarted, and nothing told them so. The guard kept
 * passing, which is indistinguishable from the hazard being gone. Splitting
 * them costs nothing and removes that: withdrawing the acknowledgement takes
 * effect on the next allocation, without a single extra container.
 */
export function filerProbeCacheKey(env = process.env) {
  return JSON.stringify([
    env.SANDBOX_DOCKER_NETWORK ?? "",
    env.SANDBOX_DOCKER_IMAGE ?? "",
    env.WEED_S3_ENDPOINT ?? env.S3_ENDPOINT ?? "",
  ]);
}

/** Kept as the old name too: the memo this guards is the probe's. */
export const filerVerdictCacheKey = filerProbeCacheKey;

/** Older than the TTL, or never probed at all. */
export function filerVerdictIsStale(entry, now = Date.now()) {
  if (!entry || typeof entry.probedAt !== "number") return true;
  return now - entry.probedAt > FILER_VERDICT_TTL_MS;
}

let _filerProbe = null;
let _filerRefreshing = false;
export function _resetFilerVerdictForTest() {
  _filerProbe = null;
  _filerRefreshing = false;
}
/** `{key, probedAt}` or null — so a test can assert the probe did NOT re-run. */
export function _filerProbeStateForTest() {
  return _filerProbe ? { key: _filerProbe.key, probedAt: _filerProbe.probedAt } : null;
}

async function runFilerProbe() {
  const filerAddress = guestFilerAddress(process.env.WEED_S3_ENDPOINT ?? process.env.S3_ENDPOINT);
  // Detailed, not the bare probe: 2026-09-26/27's incident was exactly a
  // `null` here with no explanation, which read as a filer problem when the
  // image itself was missing (kubelet's GC — see image-pin.mjs). `probeDetail`
  // is null on every branch except that one; nothing else about this call
  // changes shape.
  const { reachable: filerReachable, detail: probeDetail } = await probeFilerFromSandboxNetworkDetailed({
    network: process.env.SANDBOX_DOCKER_NETWORK,
    image: process.env.SANDBOX_DOCKER_IMAGE,
    filerAddress,
  });
  return { filerReachable, filerAddress, probeDetail };
}

/**
 * 開一次探測，並且把結果**同步讀得到**地記在那筆 entry 上。
 *
 * 為什麼要 `settled`：唯讀的狀態查詢（後台那一支）不可以 await 這個 promise。
 * 冷啟動時它是一次 `docker run`，最久 15 秒 —— 一個每 10 秒輪詢一次的後台面板
 * 會排隊排到爆。它要的是「現在已知的是什麼」，不知道就老實說不知道。
 */
/**
 * 探測「沒跑成」（逾時、docker 錯誤）跟「沒有網路可探」不一樣：後者是這個部署的
 * 固定事實，記住它是對的；前者是一時的，帶著 probeDetail。
 */
function probeCouldNotRun(result) {
  return result?.filerReachable === null && !!result?.probeDetail;
}

function startFilerProbe(key) {
  const entry = { key, probedAt: Date.now(), settled: null, promise: null };
  entry.promise = runFilerProbe().then((result) => {
    // 寫在 entry 上而不是模組變數：設定在探測途中改過的話，_filerProbe 已經換成
    // 新的那一筆了，這一筆結果就跟著它自己作廢，不會回頭蓋掉新的答案。
    entry.settled = result;
    // 探測沒跑成（逾時、映像不在）不是答案，**不要記住它**。這一次的配置照樣拒絕，
    // 但下一次配置會重新探測。2026-10-20 主機忙的時候一次 `docker run` 超過 15 秒，
    // 那個「不知道」被當成答案記了 15 分鐘 —— 期間每一個雲端沙盒都被拒絕。
    if (probeCouldNotRun(result) && _filerProbe === entry) _filerProbe = null;
    return result;
  });
  return entry;
}

function cachedFilerProbe() {
  const key = filerProbeCacheKey();
  if (_filerProbe && _filerProbe.key !== key) _filerProbe = null;
  if (!_filerProbe) {
    _filerProbe = startFilerProbe(key);
    return _filerProbe.promise;
  }
  if (filerVerdictIsStale(_filerProbe) && !_filerRefreshing) {
    _filerRefreshing = true;
    void runFilerProbe()
      .then((result) => {
        // Only replace the entry we refreshed: a config change during the probe
        // already installed a newer one, and clobbering it would reinstate the
        // old deployment's answer.
        // 重新探測沒跑成的話，舊的答案（確定的那一個）繼續用，下一次配置再試 ——
        // 不要拿「不知道」蓋掉一個確定的答案，否則一次逾時就變成 15 分鐘的全面拒絕。
        if (probeCouldNotRun(result)) {
          log("warn", "pool.filer_exposure_refresh_inconclusive", { detail: result.probeDetail ?? null });
          return;
        }
        if (_filerProbe && _filerProbe.key === key) {
          _filerProbe = { key, probedAt: Date.now(), settled: result, promise: Promise.resolve(result) };
        }
      })
      .catch((e) => {
        // A failed refresh must neither extend the old answer forever nor take
        // sandboxes down. Say so; the stale entry serves until the next try.
        log("warn", "pool.filer_exposure_refresh_failed", { error: String(e?.message ?? e) });
      })
      .finally(() => {
        _filerRefreshing = false;
      });
  }
  return _filerProbe.promise;
}

async function filerExposureVerdict() {
  const { filerReachable, filerAddress, probeDetail } = await cachedFilerProbe();
  // Derived through the same resolver the mount path uses, not re-parsed here.
  // Re-parsing missed `host-premounted` and reported it as `in-guest`, which
  // made the refusal advise "switch to host mounting" to a deployment that
  // already had — the exact "advice to do what is already done" this module's
  // own tests assert against for the other branch.
  const mountMode = resolveWorkspaceMountMode(process.env);
  const acknowledged = /^(1|true|yes)$/i.test(String(process.env[ACK_ENV] ?? "").trim());
  const verdict = exposureVerdict({ filerReachable, acknowledged, mountMode, filerAddress, probeDetail });
  log(verdict.ok ? (verdict.accepted ? "warn" : "info") : "error", "pool.filer_exposure", {
    reachable: filerReachable,
    mountMode,
    acknowledged,
    ok: verdict.ok,
    detail: verdict.note ?? verdict.reason,
    probeDetail: probeDetail ?? null,
  });
  return verdict;
}

/**
 * 同一組事實，給「讀」的那一邊 —— 後台的唯讀狀態，不是一個開關。
 *
 * 這支跟上面那支 `filerExposureVerdict()` 的差別只有一個，但那個差別是重點：
 * **它不等**。配置那條路可以等一次探測（一個使用者等幾秒，換來一個正確的拒絕）；
 * 一個每 10 秒輪詢的後台面板不行。所以這裡讀的是「已經回來的那一次探測」，
 * 還沒回來就回 `probe: "pending"`，並且順手把探測踢下去 —— 沒有人配置沙盒的
 * 機器上，後台自己就是唯一會讓這個問題被問出來的人。
 *
 * 刻意**不**提供任何寫入面。接受暴露是部署層的決定（`SANDBOX_ALLOW_ANONYMOUS_FILER`），
 * 不是後台的按鈕：那是一道跨租戶隔離的守門，做成按鈕等於任何拿到管理權限的人
 * 都能靜靜關掉它，而那個設定會住在沙盒連得到的同一個資料庫裡。
 * 見 docs/ops/filer-exposure-visibility.md。
 */
export function filerExposureReport() {
  // 先踢再讀：這一步也負責把設定改過之後那筆過期的 entry 丟掉，
  // 所以讀到的 settled 一定屬於現在這組設定。
  void cachedFilerProbe().catch(() => {});
  const settled = _filerProbe?.settled ?? null;
  return exposureReport({
    probed: settled !== null,
    filerReachable: settled?.filerReachable ?? null,
    filerAddress: settled?.filerAddress ?? guestFilerAddress(process.env.WEED_S3_ENDPOINT ?? process.env.S3_ENDPOINT),
    // Same fact the refused user sees (filerExposureVerdict's `reason`), now
    // also on the console — 2026-09-26/27's incident hid a missing-image
    // fault behind a filer-shaped message for hours on both sides at once.
    probeDetail: settled?.probeDetail ?? null,
    acknowledged: /^(1|true|yes)$/i.test(String(process.env[ACK_ENV] ?? "").trim()),
    mountMode: resolveWorkspaceMountMode(process.env),
    // 只有真的有答案才報時間。探測進行中報「開始時間」會讀成「這是那時候量到的」，
    // 而那時候什麼都還沒量到。
    probedAt: settled !== null ? (_filerProbe?.probedAt ?? null) : null,
  });
}

export async function allocateSandbox(params = {}) {
  const { userId, workspaceOwner } = params;
  // Allocation lock (Layer-2 audit H), keyed by the OWNER SLOT (user+owner) so
  // it also serialises two different members allocating the same group: without
  // it each could see byUser empty and both create a sandbox racing on the
  // group's S3 prefix. Allocs for different slots (or anonymous) don't contend.
  // Session-level reuse below short-circuits before the lock's critical work.
  if (!userId) return _allocateSandboxInner(params);
  const lockKey = ownerSlotOf(userId, workspaceOwner);
  const prev = _allocLocks.get(lockKey) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => _allocateSandboxInner(params));
  _allocLocks.set(lockKey, next);
  try {
    return await next;
  } finally {
    if (_allocLocks.get(lockKey) === next) _allocLocks.delete(lockKey);
  }
}

async function _allocateSandboxInner(params = {}) {
  const {
    userId, endUserId, sessionId, image, resourceQuota,
    ttlSec, idleTimeoutSec, networkPolicy, metadata, workspaceMode,
    workspaceOwner,
    /**
     * 使用者選定的機器（app 從 user_machines 讀出來、隨 allocate 送下來）。
     *
     * **這一個欄位就是「兩線並行」的開關**：帶了機器就走 SSH 後端，指令跑在
     * 使用者自己的電腦上；沒帶就照舊走部署設定的後端（docker 沙箱）。
     * 所以不需要、也不應該把 SANDBOX_MODE 全域切成 ssh —— 那會讓每一個
     * 還沒綁機器的人在下一次分派時直接失敗。
     */
    machine,
    // Phase 4.2: optional host path to bind-mount into the container's
    // /workspace. Forwarded to backend.createSandbox; stub records the
    // path and logs it (no real bind-mount possible without container
    // isolation), real cube backend wires it through to the VM runtime.
    workspaceMountPath
  } = params;
  // The filer guard, BEFORE any backend work: refusing after a container exists
  // would leave one behind on a machine that has already decided not to serve.
  // It applies to cloud sandboxes only — a machine-bound one mounts nothing
  // here and holds no filer route (cube/filer-exposure.mjs).
  if (guardAppliesTo({ machine })) {
    const verdict = await filerExposureVerdict();
    if (!verdict.ok) throw new SandboxError(verdict.code, verdict.reason, 503);
  }
  const backend = backendForMachine(machine);
  const requestedMode = workspaceMode === "user" && userId ? "user" : "ephemeral";
  // The singleton slot for this (user, owner). Personal → user:<id>; a shared
  // project → group:<gid>. Distinct slots ⇒ distinct sandboxes.
  const ownerSlot = ownerSlotOf(userId, workspaceOwner);

  // A sandbox is bound to ONE machine for its whole life (cube/index.mjs
  // bindSandboxBackend). Reusing it for a different machine — the user
  // switched the chip, or re-paired — would send every call to a backend
  // that does not know the new target, so the reuse paths below only match
  // a sandbox on the SAME machine (null = the cloud) and drop stale mappings.
  const wantMachine = machine?.id || null;
  // …and to ONE FOLDER. `cube/relay.mjs` createSandbox records the picked
  // folder as the sandbox's `root`, and every path plus the default cwd
  // resolves against that — so a sandbox reused after the user picked a
  // different folder keeps serving the old one for the rest of the session.
  // Seen live 2026-09-04: the chip and the file panel both showed the new
  // folder (the panel reads the current value on every open, through
  // workspace-bridge) while `ls` listed the previous folder's contents. No
  // error anywhere, because nothing was wrong — the sandbox was answering
  // exactly what it had been built to answer.
  const wantRoot = typeof machine?.root === "string" ? machine.root : "";
  const sameTarget = (existing) =>
    (existing?.machineId || null) === wantMachine && (existing?.machineRoot ?? "") === wantRoot;

  if (sessionId && bySession.has(sessionId)) {
    const existing = active.get(bySession.get(sessionId));
    if (existing && !sameTarget(existing)) {
      log("info", "pool.session_target_changed", { sandboxId: existing.sandboxId, sessionId, from: `${existing.machineId}:${existing.machineRoot ?? ""}`, to: `${wantMachine}:${wantRoot}` });
      bySession.delete(sessionId);
    } else if (existing) {
      existing.lastActivityAt = nowMs();
      log("info", "pool.reuse_for_session", { sandboxId: existing.sandboxId, sessionId });
      emitPoolEvent("reconnected", existing);
      return { entry: existing, fromPool: false, reconnect: true };
    }
  }

  // Per-user singleton policy (workspace_mode === "user" only). Same user
  // opening agent mode in a second tab reuses the existing sandbox + its
  // S3-backed workspace, so the second tab sees live state from the first
  // (and we avoid two sandboxes racing to write the same S3 prefix).
  if (requestedMode === "user" && byUser.has(ownerSlot)) {
    const existing = active.get(byUser.get(ownerSlot));
    if (existing && existing.workspaceMode === "user" && sameTarget(existing)) {
      existing.lastActivityAt = nowMs();
      if (sessionId && !bySession.has(sessionId)) {
        bySession.set(sessionId, existing.sandboxId);
      }
      log("info", "pool.reuse_for_user", { sandboxId: existing.sandboxId, userId, ownerSlot, sessionId });
      emitPoolEvent("reconnected", existing);
      return { entry: existing, fromPool: false, reconnect: true };
    }
    // Stale mapping — fall through and allocate fresh.
    byUser.delete(ownerSlot);
  }

  // Per-tenant concurrency cap. The quota key is (userId, endUserId): the
  // platform user is the API-key holder (a B2B developer in SaaS deployments),
  // and endUserId — passed via OpenAI's standard `body.user` field — scopes
  // each of that developer's downstream customers separately. Without an
  // endUserId we fall back to per-userId (single-tenant / dev use).
  // Runs AFTER session-reuse so the same user reconnecting is never
  // throttled. Set SANDBOX_USER_MAX_ACTIVE=0 to disable entirely.
  // 進來的這一個如果是使用者自己的機器，整段配額直接跳過。
  //
  // 只把既有的本機項目從**計數**裡拿掉還不夠：租戶如果已經有 3 個**雲端**沙盒，
  // 他要連自己的電腦時 active_count 仍然是 3 → 一樣被擋。而他連自己的電腦
  // 根本不用我們的資源。
  if (userId && !machine && config.pool.userMaxActive > 0) {
    const quotaKey = endUserId ? `${userId}::${endUserId}` : userId;
    let active_count = 0;
    for (const entry of active.values()) {
      // **使用者自己的機器不算進配額。**
      //
      // 這個配額存在的理由是**我們這邊的容量**：每一個雲端沙盒是一個真的容器，
      // 吃我們的記憶體與 CPU。而本機／SSH 落點的「沙盒」只是一筆**登記** ——
      // relay 的 `createSandbox` 自己寫著「Nothing to start: the daemon is
      // already connected... this is a registration」。它在我們這邊不吃任何東西，
      // 資源是使用者自己的電腦，而那台電腦是他的。
      //
      // 不排除的話會發生這件事（roy 2026-09-06 實地撞到）：雲端配額滿了之後，
      // 連他**自己筆電上的 `ls`** 都跑不了 ——
      //   指令沒有被執行：配置沙盒失敗 (429): Tenant has 3 active sandboxes (max 3)
      // 一個他完全無法理解、也無法自救的錯誤：他根本沒在用雲端。
      //
      // `machineKind` 這個欄位旁邊已經用過兩次同樣的理由（本機不算閒置、
      // 本機沒有環境可以重播），這是第三次。
      if (entry.machineKind) continue;
      const entryKey = entry.endUserId ? `${entry.userId}::${entry.endUserId}` : entry.userId;
      if (entryKey === quotaKey) active_count += 1;
    }
    if (active_count >= config.pool.userMaxActive) {
      log("warn", "pool.tenant_quota_exceeded", {
        userId, endUserId, active: active_count, limit: config.pool.userMaxActive
      });
      throw new SandboxError(
        "user_quota_exceeded",
        `Tenant has ${active_count} active sandboxes (max ${config.pool.userMaxActive})`,
        429,
        { retry_after: 10, active: active_count, limit: config.pool.userMaxActive, end_user_id: endUserId || null }
      );
    }
  }

  // ── 容量：兩種資源，兩句不同的話 ─────────────────────────────────────────
  //
  // 舊版是 `active.size >= totalMax`，而 active 裡混著兩種完全不同的東西：真的
  // 跑在這台主機上的容器，以及指向使用者自己電腦的登記列。混在一起數會產生一句
  // **假話**：主機上一個容器都沒有，畫面上卻寫「沙盒容量暫時滿了」。2026-09-06
  // 那個 429（「他自己筆電上的 ls 跑不了」）是同一個形狀，只是發生在租戶配額；
  // 這裡是它在全域上限的雙胞胎，而這一個會打到全平台的人。
  //
  // 所以分開數，也分開講。順帶：兩個數字都放進錯誤細節裡，因為「滿了」到底是
  // 主機滿了還是有東西沒回收，讀那句話的人必須分得出來。
  let hostActive = 0;
  let machineActive = 0;
  for (const e of active.values()) {
    if (e.machineKind) machineActive += 1;
    else hostActive += 1;
  }
  const policy = getPoolPolicy();
  const totalMax = effectiveTotalMax(policy);
  if (!machine && hostActive >= totalMax) {
    log("warn", "pool.exhausted", { hostActive, machineActive, limit: totalMax, fromSettings: policy.cap.enabled });
    throw new SandboxError(
      "pool_exhausted",
      `Sandbox pool exhausted: ${hostActive} sandboxes are running on this host (max ${totalMax}).`,
      503,
      { retry_after: 5, host_active: hostActive, machine_bound: machineActive, limit: totalMax },
    );
  }
  // 依主機資源（平台設定的開關）：數量還沒到上限，但這台主機已經沒有餘裕了 —— 記憶體、
  // CPU 負載或磁碟任何一樣過線就不開新的。只管雲端沙盒（使用者自己的電腦不吃這台的資源）。
  if (!machine && policy.adaptive.enabled) {
    const verdict = hostAdmission(policy.adaptive, measureHost(_hostReaders));
    if (!verdict.allow) {
      log("warn", "pool.host_busy", { hostActive, reasons: verdict.reasons, host: verdict.host, limits: policy.adaptive });
      throw new SandboxError(
        "host_busy",
        `Host is busy (${verdict.reasons.join(", ")}); no new cloud sandbox until resources free up.`,
        503,
        { retry_after: 15, reasons: verdict.reasons, host: verdict.host, host_active: hostActive },
      );
    }
  }
  if (machine && machineActive >= config.pool.machineMax) {
    // 這句話刻意跟上面那句不一樣：撞到它**不是**主機沒容量，是這個行程的登記表
    // 沒有被回收。說成「容量滿了」會把維運指向完全錯誤的地方。
    log("warn", "pool.machine_registry_full", { hostActive, machineActive, limit: config.pool.machineMax });
    throw new SandboxError(
      "machine_pool_exhausted",
      `Too many machine-bound sandbox registrations (${machineActive}, max ${config.pool.machineMax}). `
        + `These consume no capacity on this host, so this is a bookkeeping limit — something is not being reclaimed.`,
      503,
      { retry_after: 5, host_active: hostActive, machine_bound: machineActive, limit: config.pool.machineMax },
    );
  }

  const created = await backend.createSandbox({
    userId, sessionId, image, resourceQuota, ttlSec, networkPolicy,
    // SSH 後端用它解析目標機器；docker / cube 後端會忽略這個欄位。
    machine,
    // Phase 4.2: when set, backend should bind-mount this host path into
    // the container's /workspace (cube backend honours it; stub records
    // the association for diagnostics only).
    workspaceMountPath: workspaceMountPath || null,
    // The agent-next engine sends workspace_owner (user:<id>) + mode "user"
    // and NO mount path — the docker backend derives the S3 weed-mount
    // location from these (see docker.mjs resolveWorkspaceLocation).
    workspaceMode,
    workspaceOwner,
    // Tenant tags forwarded to backend (Cube vendor labels them on the VM
    // for per-tenant resource accounting; stub ignores). end_user_id and
    // user_id are also reflected here so a backend driver can write them
    // as cloud labels without needing the manager-level entry shape.
    metadata: {
      ...(metadata || {}),
      user_id: userId || null,
      end_user_id: endUserId || null,
      session_id: sessionId || null
    }
  });
  const entry = makeEntry({
    sandboxId: created.sandboxId,
    workspaceId: created.workspaceId,
    workspaceDir: created.workspaceDir,
    userId,
    endUserId,
    sessionId,
    image,
    resourceQuota,
    networkPolicy,
    ttlSec,
    idleTimeoutSec,
    metadata,
    workspaceMode: requestedMode,
    workspaceOwner,
    workspaceMountPath
  });
  // 這個 sandbox 屬於哪個後端，要記下來 —— 之後的 exec、檔案、快照
  // 都必須問到同一個，否則 docker 後端會回一個它不認得的 id。
  // Which kind of machine this sandbox lives on (null = the cloud sandbox).
  // The allocate route uses it to skip cloud-only rituals (git baseline
  // snapshot) that would otherwise turn into approval prompts on a user's
  // own machine.
  entry.machineKind = machine?.kind || null;
  entry.machineId = machine?.id || null;
  // Recorded alongside the machine because reuse is keyed on BOTH: the sandbox
  // resolves every path against the folder it was created with, so the folder
  // is as much a part of its identity as the machine (see `sameTarget`).
  entry.machineRoot = typeof machine?.root === "string" ? machine.root : "";
  // A machine-bound sandbox is a routing record, not a container on this host.
  // Drop its idle deadline entirely so nothing can quietly expire the user's
  // link to their own computer (the reaper checks machineKind too — this is
  // the belt to that pair of braces, and it makes the entry state honest for
  // anything else that reads idleAt, e.g. the status route).
  if (entry.machineKind) entry.idleAt = null;
  bindSandboxBackend(created.sandboxId, backend);
  active.set(entry.sandboxId, entry);
  if (sessionId) bySession.set(sessionId, entry.sandboxId);
  if (entry.workspaceMode === "user" && userId) byUser.set(ownerSlot, entry.sandboxId);

  // Phase 2: kick off env restore in the background. The promise is
  // stashed on the entry so the first exec call awaits it. We log the
  // result here — failures are intentionally non-fatal (the user just
  // gets pre-Phase-2 behavior: tools install packages on demand).
  // Rabi Local: the environment IS the user's machine; there is no manifest to
  // replay onto it, and reading one would just be a refused path on the daemon.
  entry.restorePromise = entry.machineKind === "local"
    ? Promise.resolve({ status: "skipped", reason: "local_machine" })
    : restoreFromManifest({ backend, sandboxId: entry.sandboxId })
    .then((result) => {
      log("info", "pool.restore_finished", {
        sandboxId: entry.sandboxId,
        status: result?.status || "unknown",
        reason: result?.reason || null
      });
      return result;
    })
    .catch((err) => {
      log("warn", "pool.restore_threw", {
        sandboxId: entry.sandboxId,
        message: err?.message || String(err)
      });
      return { status: "failed", reason: "exception" };
    })
    .finally(() => {
      // Clear once settled so subsequent execs don't pay the await
      // overhead (resolved promise awaits are cheap, but null is free).
      if (entry.restorePromise) entry.restorePromise = null;
    });

  log("info", "pool.allocated", {
    sandboxId: entry.sandboxId, userId, endUserId, sessionId,
    workspaceMode: entry.workspaceMode
  });
  emitPoolEvent("created", entry);
  emitLifecycleEvent(entry.sandboxId, "start", lifecycleDetails(entry));

  // Baseline durable snapshot on cold open (user workspaces only): the app's
  // pre-turn snapshot can only fire when a sandbox is ALREADY live, so the
  // very first turn of a session had no pre-mutation baseline — an agent whose
  // first action deletes a file left nothing to restore from. Fire-and-forget
  // (git add -A + write-tree over the fresh weed-mount); dedupe inside
  // snapshotCreate skips the commit when the tree matches the tip.
  if (entry.workspaceMode === "user" && userId && entry.machineKind !== "local") {
    import("../snapshot/index.mjs")
      .then(({ snapshotCreate }) => snapshotCreate(entry.sandboxId))
      .then(() => log("info", "pool.baseline_snapshot", { sandboxId: entry.sandboxId }))
      .catch((err) => log("warn", "pool.baseline_snapshot_failed", {
        sandboxId: entry.sandboxId,
        message: err?.message || String(err)
      }));
  }
  return { entry, fromPool: false, reconnect: false };
}

export function getActive(sandboxId) {
  const entry = active.get(sandboxId);
  if (!entry) throw new SandboxError("sandbox_not_found", `sandbox ${sandboxId} not found`, 404);
  return entry;
}

export function findSessionSandbox(sessionId) {
  const id = bySession.get(sessionId);
  if (!id) return null;
  return active.get(id) || null;
}

// Per-user singleton lookup — used by the user-workspace-upload path to
// push a freshly-uploaded file's stub into the running sandbox so glob /
// find / ls see it immediately. Without this, the first upload after a
// sandbox is allocated stays invisible until the next allocation cycle,
// which is the "Find tool can't find my upload" UX bug.
export function findUserSandbox(userId, owner) {
  if (!userId) return null;
  // `owner` scopes to a specific workspace (personal vs a shared group); when
  // omitted, default to the user's PERSONAL sandbox so legacy callers are
  // unchanged. Group-aware callers pass the resolved owner.
  const id = byUser.get(ownerSlotOf(userId, owner));
  if (!id) return null;
  return active.get(id) || null;
}

export function touchActivity(sandboxId, kind = null) {
  const entry = active.get(sandboxId);
  if (!entry) return;
  entry.lastActivityAt = nowMs();
  // Accumulate the distinct exec KINDS that kept this sandbox alive so the
  // "active" lifecycle event can report which tools were used (bash /
  // file_read / file_write / file_op). Bounded (a handful of kinds).
  if (kind) {
    if (!entry._tools) entry._tools = new Set();
    entry._tools.add(kind);
  }
  // Use the entry's own idle window (it may have been set per-allocation via
  // idle_timeout_sec), falling back to the global default. The prior code
  // hard-coded config.pool.idleTimeoutSec here, which silently ignored a
  // caller's longer idle window on every touch and could reap a sandbox the
  // caller expected to stay warm.
  // A machine-bound sandbox has no idle deadline to refresh (set to null at
  // allocation). Recomputing one here would silently re-arm the reaper on the
  // user's own machine the first time they ran anything on it.
  if (entry.machineKind) {
    entry.idleAt = null;
  } else {
    entry.idleAt = entry.lastActivityAt + entryIdleSec(entry) * 1000;
    entry._cpuProbe = null;
  }
  // Throttled "active" ping (touchActivity fires per exec chunk) — at most once
  // a minute per sandbox.
  if (!entry._lastActiveEmit || entry.lastActivityAt - entry._lastActiveEmit > 60_000) {
    entry._lastActiveEmit = entry.lastActivityAt;
    emitLifecycleEvent(
      sandboxId,
      "active",
      lifecycleDetails(entry, {
        durationMs: entry.lastActivityAt - entry.leasedAt,
        tools: entry._tools ? [...entry._tools] : null,
      }),
    );
  }
}

// True while a sandbox has at least one exec still in the "running" state.
// The idle reaper consults this so a long, silent command (e.g. `sleep 300`,
// a quiet compile) is never reaped mid-run just because it produced no
// stdout/stderr to refresh lastActivityAt. streams.mjs refreshes activity on
// every output chunk, but output-less commands need this guard too (H1).
//
// listExecs is imported lazily (dynamic import, memoised) to avoid an
// import-time cycle: streams.mjs statically imports touchActivity from this
// module. The first reaper tick resolves it; subsequent ticks reuse the cached
// reference, so the hot path stays synchronous.
let _listExecs = null;
let _listTerminals = null;
import("../terminal/registry.mjs").then(mod => { _listTerminals = mod.listTerminals; }).catch(() => {});
import("../exec/streams.mjs")
  .then((mod) => { _listExecs = mod.listExecs; })
  .catch(() => { /* streams not available (e.g. isolated unit test) — guard below */ });
function hasRunningExec(sandboxId) {
  try {
    // An official CLI is a long-lived PTY, not a /exec record. Switching tabs
    // must not let the ordinary idle timeout destroy a still-running agent.
    if (_listTerminals?.(sandboxId).some(t => t.live && t.slot?.startsWith("official."))) return true;
    if (typeof _listExecs !== "function") return false;
    for (const e of _listExecs(sandboxId)) {
      if (e.status === "running") return true;
    }
  } catch { /* be conservative: if we can't tell, treat as not running */ }
  return false;
}

// Single-flight guard for releaseSandbox. The release body awaits the final S3
// flush (up to ~30s) BEFORE it removes the entry from `active`, so without this
// guard two near-simultaneous DELETE /v1/sandboxes/:id calls (engine session
// teardown + idle reaper, retries, duplicate aborts) both pass the `active.get`
// check and each run a full release-sync + destroy → a "release storm":
// N concurrent flushes (read every file via docker exec), N `docker rm` racing
// ("removal already in progress"), and N duplicate "close" lifecycle events.
// Coalescing on sandboxId makes release idempotent under concurrency.
const _releaseInflight = new Map();

export function releaseSandbox(sandboxId, { keepWorkspace = false, destroy = true } = {}) {
  const inflight = _releaseInflight.get(sandboxId);
  if (inflight) return inflight;
  const promise = (async () => releaseSandboxImpl(sandboxId, { keepWorkspace, destroy }))().finally(() => {
    if (_releaseInflight.get(sandboxId) === promise) _releaseInflight.delete(sandboxId);
  });
  _releaseInflight.set(sandboxId, promise);
  return promise;
}

async function releaseSandboxImpl(sandboxId, { keepWorkspace = false, destroy = true } = {}) {
  const entry = active.get(sandboxId);
  if (!entry) return;

  // 這個沙盒上開著的互動式終端機要跟著收掉。少了這一條，被回收的沙盒會在終端機
  // 表上留下一列指向已經不存在的容器的 handle，而那個 PTY 行程可能還活著 ——
  // 使用者看到的是一個「還連著」但每一個按鍵都石沉大海的框。
  try { await closeSandboxTerminals(sandboxId); } catch { /* 收不掉也不能擋住回收 */ }
  await localAgentSessions.release(sandboxId);

  // ── Final S3 sync for user-mode sandboxes ────────────────────────────────
  // H3 fix: the prior design raced the final flush against a ~30s budget and,
  // on timeout, tore the sandbox FS down ANYWAY — silently dropping the tail
  // of un-synced shell writes (the only flush between the 60s periodic ticks).
  // Idle reap fires routinely for users who stepped away mid-edit, so this was
  // a real, recurring data-loss path.
  //
  // New invariant for workspace_mode === "user": user file bytes are NEVER
  // dropped because a timer fired. We therefore do NOT race the sync against a
  // hard budget that proceeds to destroy. Instead:
  //   · The sync runs to completion (it is content-addressed + single-flight,
  //     and writes blobs before the manifest, so a crash mid-flush still loses
  //     nothing already persisted — the manifest only flips once every blob is
  //     up).
  //   · A soft budget is used ONLY to decide whether we keep blocking the
  //     caller or hand the remaining flush off to a detached, out-of-band
  //     retry. Either way we KEEP the workspace: we never pass keepWorkspace
  //     through to a destroy while bytes are still pending.
  //   · We force keepWorkspace = true for user-mode so the backend reclaims
  //     only the container, never the durable S3 workspace.
  // Ephemeral sandboxes are unaffected and keep the old (cheap) behaviour.
  // User-mode workspaces are DURABLE with zero flush: `/workspace` is a
  // weed-mount FUSE view of the S3 store, so every byte is already persisted
  // the instant it's written. There is no sandbox→S3 drain to run on release —
  // just keep the durable workspace and let the container be reclaimed below.
  // (Removed: the old syncSandboxToUser release-flush with its soft budget /
  // detached-drain / hard-deadline machinery, which existed for the snapshot
  // model and was a pure no-op under FUSE. See docs/plan-remove-stub-subsystem.md.)
  const userSyncSettled = true;
  if (entry.workspaceMode === "user" && entry.userId) {
    keepWorkspace = true;
  }

  active.delete(sandboxId);
  if (entry.sessionId && bySession.get(entry.sessionId) === sandboxId) {
    bySession.delete(entry.sessionId);
  }
  if (entry.userId) {
    const slot = ownerSlotOf(entry.userId, entry.workspaceOwner);
    if (byUser.get(slot) === sandboxId) byUser.delete(slot);
  }
  // Kill long-lived processes (stdio MCP servers, hook daemons) before the
  // backend tears down the workspace. processManager is in the same Node
  // process, so this is synchronous + cheap.
  try {
    const { killAllForSandbox } = await import("../exec/processManager.mjs");
    const killed = killAllForSandbox(sandboxId);
    if (killed > 0) log("info", "pool.processes_killed", { sandboxId, count: killed });
  } catch (err) {
    log("warn", "pool.process_cleanup_failed", { sandboxId, message: err?.message || String(err) });
  }
  // When userSyncSettled is false we deferred the container teardown to the
  // detached flush handler above (so the FS the sync is still reading stays
  // alive). Skipping it here avoids destroying the container out from under
  // that in-flight read. Settled releases (ephemeral, or user-mode whose
  // flush finished in budget) destroy inline as before.
  if (destroy && userSyncSettled) {
    try {
      const backend = getBackend(sandboxId);
      await backend.destroySandbox(sandboxId, { keepWorkspace });
    } catch (err) {
      log("warn", "pool.destroy_failed", { sandboxId, message: err?.message || String(err) });
    }
  }
  // ── 這個 sandbox 在別的表裡留下的東西 ────────────────────────────────────
  //
  // 兩張都是「只寫不刪」：`cube/index.mjs` 的 `_bySandbox`（id → 後端）本來就有
  // 一支 `releaseSandboxBackend`，它甚至一直被 import 在這個檔案最上面 ——
  // 只是**零個呼叫端**。「import 還在、呼叫點在重構時掉了」是這個專案已經被咬過
  // 一次的形狀（2026-08-05 那批），而 tsc、lint、測試都不會叫。
  // 順序重要：一定在 destroySandbox 之後，因為那一行還要靠 getBackend 找到它。
  releaseSandboxBackend(sandboxId);
  forgetSandboxBase(sandboxId);
  log("info", "pool.released", { sandboxId, keepWorkspace, destroy, deferredDestroy: !userSyncSettled });
  emitPoolEvent("released", entry, { reason: keepWorkspace ? "released_keep_workspace" : "released" });
  emitLifecycleEvent(
    entry.sandboxId,
    "close",
    lifecycleDetails(entry, {
      durationMs: nowMs() - entry.leasedAt,
      reason: keepWorkspace ? "released_keep_workspace" : "released",
    }),
  );
}

export function listActive() {
  return Array.from(active.values()).map((entry) => ({
    sandboxId: entry.sandboxId,
    workspaceId: entry.workspaceId,
    userId: entry.userId,
    sessionId: entry.sessionId,
    status: entry.status,
    leasedAt: entry.leasedAt,
    lastActivityAt: entry.lastActivityAt,
    ttlAt: entry.ttlAt
  }));
}

/**
 * 這一列背後的那台機器，還連得上嗎？
 *
 * **只有 `local` 有答案。** Rabi Local 的 daemon 是**撥出來**的：它連上來、留著
 * 一條 SSE，`relay/registry.mjs` 記著它。所以「這台電腦還在不在」在這個行程裡
 * 是一個看得到的事實。SSH 相反 —— 是我們撥出去，平常沒有任何連線掛著，
 * 「離線」在那條路上不可觀測。硬要用計時器猜就會把一台好好的機器判死，
 * 所以 ssh 這裡一律回 false，它的失效走另一條線：撤銷（releaseMachineSandboxes）。
 *
 * **為什麼要寬限期而不是一斷就收。** 換 wifi、睡眠喚醒、daemon 自己更新重啟都會
 * 讓那條 SSE 斷掉幾秒到幾十秒，而 daemon 會自己退避重連（最多 30 秒一次）。
 * 一斷就收等於每次闔上筆電都換一個沙盒 id。
 *
 * 狀態記在 entry 上（`machineOfflineSince`），因為連線一關就從 registry 裡刪掉了，
 * 沒有別的地方記得「從什麼時候開始不見的」。重新連上就清掉 —— 斷斷續續的網路
 * 不會累積成一次回收。
 */
function machineLinkLost(entry, now) {
  if (entry.machineKind !== "local" || !entry.machineId) return false;
  if (isMachineOnline(entry.machineId)) {
    if (entry.machineOfflineSince) {
      log("info", "pool.machine_back", {
        sandboxId: entry.sandboxId,
        machineId: entry.machineId,
        offlineMs: now - entry.machineOfflineSince,
      });
      entry.machineOfflineSince = null;
    }
    return false;
  }
  if (!entry.machineOfflineSince) {
    entry.machineOfflineSince = now;
    log("info", "pool.machine_offline", { sandboxId: entry.sandboxId, machineId: entry.machineId });
    return false;
  }
  const graceMs = Math.max(0, Number(config.pool.machineOfflineGraceSec) || 0) * 1000;
  return now - entry.machineOfflineSince >= graceMs;
}

/**
 * 這台機器被撤銷了 —— 把它在這個行程裡還握著的東西全部放掉。
 *
 * 撤銷是**授權**的事件，不是時間的事件，所以它不等寬限期：DB 那一列一停用，
 * 這裡的登記列就不該還能用。少了這一條，一個已經被撤銷的機器上**已經分派好**的
 * sandbox 會繼續服務 —— 而且對 SSH 來說不是「多活一個憑證有效期」：
 * `ssh-ca.mjs` 的 `ensureCert` 過期會自己重簽，它從來不回頭問 DB，
 * 所以那個窗口的長度是「這一列還在多久」，而在此之前那是**永遠**。
 *
 * MERGED (ava ✕ ava-roy). Both lines wrote this function independently and the
 * merge produced two exported definitions of the same name in one module — a
 * duplicate export, which is a SyntaxError, and which nothing but `node --check`
 * would have said out loud. This is the single one, carrying both halves:
 *
 *   · ava's reason for it existing at all: a machine-bound entry is exempt from
 *     both reapers on purpose (it is a routing record for hardware the user
 *     owns, and collecting it would cost them their session while freeing
 *     nothing on this host — pool/machine-lifecycle.test.mjs). The cost of that
 *     exemption is that such an entry has NO deadline of any kind: `idleAt` is
 *     null at allocation and stays null on every touch. Revoke is the ONLY
 *     thing that can ever remove one, and until this existed nothing did.
 *   · ava-roy's `keepWorkspace: true`: 使用者的檔案在他自己的電腦上，撤銷是
 *     收回我們的存取權，不是刪他的東西。
 *   · ava-roy's `{ released }` return shape, which relay/routes.mjs reports
 *     alongside the connection close and the forgotten cert principals.
 *
 * `await`s each release rather than firing and forgetting: the count it returns
 * is then what actually happened, and the entry is gone from `active` by the
 * time the caller reads it. Sequential, not `Promise.all` — `releaseSandbox`
 * coalesces per sandboxId and a revoke is rare and small; failures are
 * per-sandbox, so one that cannot be torn down must not keep the others.
 *
 * Matches on `machineId` and never on a falsy one: a cloud entry's machineId is
 * null, and `"" === null`-style matching would collect the whole cloud pool.
 *
 * `reason` takes either a string (ava's call shape) or `{ reason }`
 * (ava-roy's), because both call shapes are on the tree and a silently-ignored
 * second argument is how a log line stops saying why anything happened.
 */
export async function releaseMachineSandboxes(machineId, reason = "machine_revoked") {
  const why = typeof reason === "string" ? reason : String(reason?.reason ?? "machine_revoked");
  const mid = String(machineId || "").trim();
  const released = [];
  if (!mid) return { released, machineId: mid };
  const doomed = [...active.values()].filter((e) => e.machineId === mid).map((e) => e.sandboxId);
  if (!doomed.length) return { released, machineId: mid };
  log("info", "pool.machine_revoked", { machineId: mid.slice(0, 8), count: doomed.length, reason: why });
  for (const sandboxId of doomed) {
    try {
      // keepWorkspace：使用者的檔案在他自己的電腦上，撤銷是收回我們的存取權，
      // 不是刪他的東西。
      await releaseSandbox(sandboxId, { keepWorkspace: true, destroy: true });
      released.push(sandboxId);
      log("info", "pool.release_machine_revoked", { sandboxId, machineId: mid, reason: why });
    } catch (err) {
      log("warn", "pool.machine_revoke_release_failed", { sandboxId, error: String(err?.message || err) });
    }
  }
  return { released, machineId: mid };
}

/** 診斷用：這台機器現在還佔著幾列。撤銷之後應該是 0。 */
export function countMachineSandboxes(machineId) {
  const mid = String(machineId || "").trim();
  let n = 0;
  for (const entry of active.values()) if (entry.machineId === mid) n += 1;
  return n;
}

// Single pass over the active pool. Exported (with the underscore prefix
// signalling "internal but reachable") so tests can drive the reaper
// without waiting on the 1s setInterval. Returns the list of sandboxIds
// it released so callers can verify which were eligible.
export function _runReaperPass() {
  const now = nowMs();
  const released = [];
  for (const entry of active.values()) {
    // The reaper reclaims HOST capacity. A sandbox bound to a user's own
    // machine (Rabi Local `local`, or `ssh`) occupies none: the compute, the
    // disk and the electricity are theirs. Reaping it would free nothing here
    // and cost them their session — they would come back to a chat that had
    // silently forgotten which computer it was working on, and the next tool
    // call would land in the cloud sandbox instead of on their laptop.
    //
    // The user's own controls remain the way out: closing Rabi Local, or
    // removing the machine (which revokes the device token and pushes a
    // `revoke` frame). Neither is a timer.
    //
    // 但「不是計時器」不等於「沒有出口」。那一句原本寫的是使用者自己的動作 ——
    // 而在此之前**沒有任何東西在聽那個動作**：關掉 Rabi Local 只是斷一條 SSE，
    // closeConnection / revokeMachine 收的是 relay 的連線表，碰不到這裡的 active。
    // 於是那一列永遠留著，而且算進總量，最後全平台的人都拿到「容量滿了」。
    //
    // 正確的失效條件不是時間，是**沒有活著的機器連線了**（見 machineLinkLost）。
    // 到期就照一般的回收路徑走，reason 說清楚不是閒置、也不是 TTL。
    if (entry.machineKind) {
      if (!machineLinkLost(entry, now)) continue;
      log("info", "pool.reap_machine_gone", {
        sandboxId: entry.sandboxId,
        machineId: entry.machineId,
        offlineMs: now - (entry.machineOfflineSince || now),
      });
      released.push({ sandboxId: entry.sandboxId, reason: "machine_gone" });
      emitLifecycleEvent(entry.sandboxId, "idle", lifecycleDetails(entry, {
        durationMs: now - entry.lastActivityAt,
        reason: "machine_gone",
      }));
      releaseSandbox(entry.sandboxId, { keepWorkspace: true, destroy: true }).catch(() => {});
      continue;
    }
    // 時間只剩**閒置**在算（roy 2026-10-21：「沒有在動時開始倒數，時間到了再關」）。
    //
    // 這裡原本還有一條 TTL：「安靜的沙盒最多活 1 小時」，而它只在「到期那一秒沒有 exec 在跑」
    // 時讓步 —— 一個每分鐘都在工作、只是剛好在兩個指令之間的沙盒，照樣在第 60 分鐘被砍
    // （2026-10-21 14:20 roy 的影片渲染：pool.reap_ttl aliveMs=3600923，30 秒後換了一個新沙盒，
    // /tmp、背景程序、裝好的套件全沒了）。閒置那條已經涵蓋「沒人在用」，TTL 只剩誤殺。
    //
    // 絕對壽命留成**選用**的保險（平台設定的開關＋小時數，預設關）：開了就是到了就回收，
    // 不管在不在跑 —— 那正是它存在的理由（`sleep infinity` 釘住位子）。reason 是 max_lifetime。
    const policy = getPoolPolicy();
    if (policy.maxLifetime.enabled && now > entry.leasedAt + policy.maxLifetime.hours * 3_600_000) {
      log("info", "pool.reap_max_lifetime", { sandboxId: entry.sandboxId, aliveMs: now - entry.leasedAt });
      released.push({ sandboxId: entry.sandboxId, reason: "max_lifetime" });
      emitLifecycleEvent(entry.sandboxId, "idle", lifecycleDetails(entry, { durationMs: now - entry.leasedAt, reason: "max_lifetime" }));
      releaseSandbox(entry.sandboxId, { keepWorkspace: false, destroy: true }).catch(() => {});
      continue;
    }
    // Idle: per-sandbox quiet-period reaper (default 120s after last
    // exec / touchActivity). Layer-2 audit G fix — previously `idleAt`
    // was computed and refreshed by touchActivity but never read, so
    // walked-away users kept their sandbox alive for the full TTL.
    // Final S3 sync inside releaseSandbox protects data; the workspace
    // re-hydrates from S3 next time the user reconnects.
    if (entry.idleAt && now > entry.idleAt) {
      // H1: never idle-reap a sandbox with a live exec. A long, output-less
      // command (sleep, quiet compile/test run) doesn't refresh lastActivityAt
      // via the stdout/stderr path, so without this guard the reaper would
      // tear the container down mid-run and the next output write / the client
      // would see sandbox_not_found. Refresh the idle window and skip; the
      // exec's eventual exit (or a later quiet period) lets it reap normally.
      if (hasRunningExec(entry.sandboxId)) {
        touchActivity(entry.sandboxId);
        continue;
      }
      // 背景程序（`nohup … &`）不留 exec，只看 exec 會在它跑到一半時回收。量 CPU 再決定。
      if (backgroundBusy(entry, now)) continue;
      log("info", "pool.reap_idle", {
        sandboxId: entry.sandboxId,
        idleMs: now - entry.lastActivityAt,
      });
      released.push({ sandboxId: entry.sandboxId, reason: "idle" });
      emitLifecycleEvent(entry.sandboxId, "idle", lifecycleDetails(entry, { durationMs: now - entry.lastActivityAt, reason: "idle" }));
      releaseSandbox(entry.sandboxId, { keepWorkspace: false, destroy: true }).catch(() => {});
    }
  }
  return released;
}

export function startReaper() {
  if (reaperTimer) return;
  reaperTimer = setInterval(_runReaperPass, 1000);
  reaperTimer.unref?.();
}

export function stopReaper() {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}

// Lets env-capture / dir-sync ask "is this an Rabi Local sandbox?" without a circular import.
_bindActiveLookup((sandboxId) => active.get(sandboxId) || null);
