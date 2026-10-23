// IMPORTANT: import for side effect — guarantees dotenv has populated
// process.env BEFORE the envStr/envInt reads below run at module-init.
// Without this, ES module hoisting locks in empty values regardless of
// when server.mjs calls loadEnv() in its function body.
import "../../../packages/shared-types/src/env.mjs";

import { log } from "./shared/log.mjs";

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function envStr(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : String(raw);
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw));
}


// 只接受字母、數字、底線、減號、點。
//
// 為什麼要有這條白名單：這個值最後會變成 `docker run` argv 裡的一段。我們用
// spawn 的陣列形式、沒有 shell，所以 `; rm -rf /` 不會被展開成第二個指令 ——
// 但那只擋得住 shell 注入，擋不住「把一段看起來像旗標的字串餵給 docker CLI」。
// 一個帶空白或引號的值仍然可以讓 argv 的切分跟人眼讀到的不一樣。runtime 名稱
// （runsc、kata-runtime、crun…）本來就落在這個字元集裡，所以收緊它不會擋掉任何
// 真實的設定，卻把整類問題移出可能性。
//
// 第一個字元另外要求不是減號：字元集本身允許 "--privileged" 這種整串都合法、
// 但長得像旗標的值。它被當成 --runtime 的值時 docker 只會抱怨找不到這個 runtime，
// 不會真的多開一個旗標 —— 但一個「看起來是旗標」的設定值沒有任何正當用途，
// 早一步擋掉比之後去論證它為什麼無害便宜。
const DOCKER_RUNTIME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * 把 SANDBOX_DOCKER_RUNTIME 收斂成「可以安全接進 argv 的字串」或空字串。
 *
 * 空字串的意思是**完全不要碰 docker 指令** —— 不是「退回 runc」。這兩件事在
 * argv 上長得一樣，但在意義上不同：我們不下 --runtime，daemon 就用它自己的
 * 預設，那是這個設定出現之前的行為，一個位元組都沒變。
 *
 * 不合法的值一樣回空字串，並且留一行 log。這裡刻意不丟例外：一個打錯字的
 * runtime 名稱不該讓整個 sandbox-runtime 起不來；但它也絕對不能靜靜地生效。
 */
export function sanitizeDockerRuntime(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (!DOCKER_RUNTIME_PATTERN.test(value)) {
    log("warn", "sandbox.docker_runtime_rejected", {
      requested: value,
      note: "SANDBOX_DOCKER_RUNTIME 只接受 [A-Za-z0-9._-] 且開頭不能是減號；這個值被當成沒設定，容器會用 daemon 的預設 runtime",
    });
    return "";
  }
  return value;
}

/** Shared by artifact persistence and the buffered upload path (see below). */
const artifactMaxBytes = envInt("SANDBOX_ARTIFACT_MAX_BYTES", 100_000_000);

export const config = {
  port: envInt("SANDBOX_PORT", envInt("PORT", 4020)),
  internalToken: envStr("SANDBOX_INTERNAL_TOKEN", ""),
  // Cross-tenant ownership enforcement at the runtime itself (defense in
  // depth — does NOT replace the upstream proxy's authz, it backstops it).
  // The shared internalToken only proves "the caller is the engine"; it does
  // NOT prove WHICH user the caller is acting for. With this on, every
  // user-scoped route (/v1/sandboxes/:id/*, /v1/users/:userId/*) requires a
  // resolvable caller identity (signed JWT claim or the on-behalf-of
  // `x-sandbox-user-id` header) that matches the targeted resource's owner —
  // so a caller acting for user A can never reach user B's sandbox/workspace,
  // even with a valid internal token and a leaked sandboxId.
  //
  // Default OFF so existing single-tenant / dev deployments keep working and
  // we can observe `sandbox.ownership_mismatch` warnings before flipping it.
  // MUST be set to 1 for any untrusted multi-tenant cloud deployment.
  // Safe-by-default: ownership enforcement ON unless a (single-user/dev) deploy
  // explicitly opts out with SANDBOX_ENFORCE_OWNERSHIP=0. Every app→sandbox
  // scoped call threads x-sandbox-user-id (see lib/agent/cm-runtime-client.ts +
  // lib/agent-next/extensibility-staging.ts), so enforcement no longer 403s the
  // legitimate BFF path.
  enforceOwnership: envBool("SANDBOX_ENFORCE_OWNERSHIP", true),
  // SANDBOX_MODE controls which backend `cube/index.mjs::getBackend()`
  // returns. Recognized values:
  //   - "docker" (default) — local docker daemon + cm-agent-sandbox image,
  //                          weed-mount FUSE workspace (self-host / staging)
  //   - "cube"             — production CubeMaster cluster (E2B-compatible)
  // Unknown values fall back to "docker" inside the selector. (The old "stub"
  // host-exec backend was removed with the stub subsystem — see
  // docs/plan-remove-stub-subsystem.md. Tests inject a fake via setBackend().)
  mode: envStr("SANDBOX_MODE", "docker"),

  // 用哪一個 docker runtime 跑沙盒容器。空字串（預設）＝ 不加 --runtime，
  // 完全維持既有行為；設成 "runsc" 之類的值 ＝ 建立容器時帶上 --runtime=<值>。
  //
  // 沒有 fallback 是刻意的：runtime 沒裝好的時候 docker run 會直接失敗，沙盒
  // 開不起來，這是對的結果。若改成「失敗就用預設 runtime 再跑一次」，使用者會
  // 拿到一個以為有 gVisor 隔離、實際上沒有的容器 —— 那比明擺著開不起來更糟。
  dockerRuntime: sanitizeDockerRuntime(envStr("SANDBOX_DOCKER_RUNTIME", "")),

  cubeApiUrl: envStr("CUBE_API_URL", ""),
  cubeApiKey: envStr("CUBE_API_KEY", ""),
  cubeTemplateBash: envStr("CUBE_TEMPLATE_ID_BASH", ""),
  cubeTemplatePython: envStr("CUBE_TEMPLATE_ID_PYTHON", ""),

  pool: {
    warmMin: envInt("SANDBOX_POOL_WARM_MIN", 10),
    warmMax: envInt("SANDBOX_POOL_WARM_MAX", 50),
    // 這台主機上同時跑幾個沙盒的上限。**只數真的落在這台主機上的那些** ——
    // 一列機器綁定的沙盒（Rabi Local / SSH）是一筆登記，容器在使用者自己的電腦上，
    // 這裡一個位元組都不吃。把它算進來的後果是：綁了機器的人越多，還沒綁的人越早
    // 撞到「沙盒容量暫時滿了」，而那句話是假的 —— 主機根本是空的。
    // （同一個理由在 manager.mjs 的租戶配額那一段已經寫過，這是同一條線。）
    totalMax: envInt("SANDBOX_POOL_TOTAL_MAX", 200),
    // 「依主機資源自動調整」開著（且手動上限關著）時的安全天花板：主機量測失靈也不會無限開。
    adaptiveCeiling: envInt("SANDBOX_POOL_ADAPTIVE_CEILING", 40),
    // 機器綁定登記列的上限。跟 totalMax 是**兩種資源**：這一個保護的是本行程的
    // 記帳表，不是主機容量，所以撞到它的時候該說的是另一句話。設得高是刻意的 ——
    // 正常情況下每一列都對應一台線上的電腦，撞到就代表有東西沒被回收。
    machineMax: envInt("SANDBOX_POOL_MACHINE_MAX", 2000),
    // 機器離線多久之後，那一列登記才算失效。
    //
    // 為什麼需要它：機器綁定的那一列不佔主機資源，所以 TTL 與閒置回收器都刻意
    // 跳過它（見 pool/manager.mjs::_runReaperPass）。但「不佔資源」不等於「永遠
    // 有效」—— 使用者關掉 Rabi Local、闔上筆電、解除配對之後，那一列指向的是一條
    // 已經不存在的連線。正確的失效條件不是計時器，是**沒有活著的機器連線了**。
    //
    // 為什麼不是立刻：daemon 的重連退避最多 30 秒（ava-local/src/transport.ts），
    // 換 wifi、睡眠喚醒、更新重啟都會短暫斷線。五分鐘 ≈ 十次重連機會，夠蓋住
    // 那些；而一台關機過夜的筆電不會整晚佔著一列。回收的代價接近零 ——
    // 重新分派一列 relay 沙盒是 0 成本（cube/relay.mjs 的 createSandbox 只是登記），
    // 而「使用者選了哪一台、哪個資料夾」存在 DB 與 cookie，不在這一列裡。
    machineOfflineGraceSec: envInt("SANDBOX_MACHINE_OFFLINE_GRACE_SEC", 300),
    // How long a CLOUD sandbox may sit quiet before the reaper reclaims it.
    // It applies to docker/cube sandboxes only — a sandbox bound to a user's own
    // machine (Rabi Local / SSH) is never reaped on THOSE grounds, because reaping
    // it frees nothing on this host (see pool/manager.mjs::_runReaperPass;
    // machineOfflineGraceSec above is the condition that does apply to them).
    //
    // 15 minutes is a product decision, not a capacity one: a user who steps
    // away mid-task and comes back within a coffee break should find their
    // container still warm, with its installed packages and /tmp intact.
    // The cost is real — a container held 15 min instead of 2 min is ~7×
    // the idle residency per walked-away session — so an operator under
    // memory pressure should turn this DOWN via the env var, not up.
    idleTimeoutSec: envInt("SANDBOX_DEFAULT_IDLE_TIMEOUT_SEC", 900),
    // 一個**安靜**的沙盒最多活多久。它不是「這個沙盒最多能工作多久」——
    // 正在執行的指令不會被它砍斷（見 pool/manager.mjs::_runReaperPass 的 TTL 分支）。
    //
    // 為什麼要寫下這一句：這個旋鈕原本是這一整段裡唯一沒有註解的，而它的行為
    // 也正好是唯一沒有被想過的 —— reaper 的 TTL 分支沒有 `hasRunningExec` 守衛，
    // 於是一個跑了 60 分鐘、還在工作的任務會被無聲砍掉，而閒置那條路同樣的情形
    // 早就擋住了（H1）。那不是容量決定，是一個漏掉的守衛。
    ttlSec: envInt("SANDBOX_DEFAULT_TTL_SEC", 3600),
    // 絕對天花板：連「正在執行」也不能再延長的那條線。
    //
    // 需要它的理由很具體：TTL 一旦對執行中的指令讓步，`sleep infinity`（或任何
    // 不會結束的程序）就能永久釘住一個位子，而這台主機的 `totalMax` 只有個位數，
    // 後果是別人看到「沙盒容量暫時滿了」而主機其實是空的 —— 跟上面
    // machineOfflineGraceSec 註解記的是同一種事故。
    //
    // 12 小時是「任何真實任務都跑得完，而跑不完的那個一定是壞掉了」這條線。
    // 被它回收時 reason 是 `max_lifetime`，**不是** `ttl` —— 兩者要能在日誌裡分開，
    // 否則「我的長任務被砍了」和「有個程序失控了」看起來一模一樣。
    maxLifetimeSec: envInt("SANDBOX_MAX_LIFETIME_SEC", 12 * 60 * 60),
    // 2026-10-21 起絕對壽命是**選用**的（開關，預設關）：時間只看閒置。平台設定可以打開它
    // （pool/policy.mjs，app 推過來）；這個環境變數是沒推過時的預設。上面那段 TTL 也不再回收。
    maxLifetimeEnabled: envStr("SANDBOX_MAX_LIFETIME", "") === "on",
    userMaxActive: envInt("SANDBOX_USER_MAX_ACTIVE", 3),
    allocTimeoutMs: envInt("SANDBOX_ALLOC_TIMEOUT_MS", 5000)
  },

  exec: {
    ringBytes: envInt("SANDBOX_EXEC_RING_BYTES", 2_097_152),
    maxMs: envInt("SANDBOX_EXEC_MAX_MS", 600_000),
    heartbeatMs: envInt("SANDBOX_EXEC_HEARTBEAT_MS", 10_000)
  },

  artifact: {
    maxBytes: artifactMaxBytes,
    urlTtlSec: envInt("SANDBOX_ARTIFACT_URL_TTL_SEC", 604_800)
  },

  nativeSnapshot: envBool("SANDBOX_NATIVE_SNAPSHOT", false),

  workspaceRoot: envStr("SANDBOX_WORKSPACE_ROOT", "/workspace"),

  // Per-user S3-backed workspace (B27). Off by default — when on, sandbox
  // allocations with `workspace_mode: "user"` lazy-hydrate from
  // `users/<userId>/workspace/` and sync back on write + periodically.
  // Reverse-sync of agent memory writes (.opencode/memories/*) back to
  // copilot-v2's agent_memories DB. `url` = copilot-v2's
  // /api/agent-next/memory/callback; unset → memory reverse-sync disabled.
  // `token` defaults to the shared internal token the app verifies.
  memorySync: {
    url: envStr("AGENT_MEMORY_SYNC_URL", ""),
    token: envStr("AGENT_MEMORY_SYNC_TOKEN", "") || envStr("SANDBOX_INTERNAL_TOKEN", ""),
  },
  // Reverse-sync of agent SKILL writes (.opencode/skills/<name>/*) back to
  // copilot-v2's user_agent_skills DB. `url` = copilot-v2's
  // /api/agent-next/skill/callback; unset → skill reverse-sync disabled.
  skillSync: {
    url: envStr("AGENT_SKILL_SYNC_URL", ""),
    token: envStr("AGENT_SKILL_SYNC_TOKEN", "") || envStr("SANDBOX_INTERNAL_TOKEN", ""),
  },
  workspace: {
    userS3Enabled: envBool("AGENT_WORKSPACE_S3", false),
    // Per-file cap of the user workspace upload endpoint (the app's upload
    // entry is 200 MB). Separate from artifact.maxBytes, which also gates what
    // a sandbox run may persist — raising one must not silently raise the other.
    userUploadMaxBytes: envInt("SANDBOX_USER_UPLOAD_MAX_BYTES", 400 * 1024 * 1024),
    // ...but only when the body STREAMS. An upload that has to be held in memory
    // (no declared size, as the agent's own file writes send it; memory, skill
    // and conditional-save paths) keeps the old cap: this process is shared by
    // every tenant (security review 2026-09-27).
    bufferedUploadMaxBytes: envInt("SANDBOX_USER_BUFFERED_UPLOAD_MAX_BYTES", artifactMaxBytes),
    // Warm-load files at or below this size during hydrate so small dotfiles
    // / configs are immediately readable by `cat`. Larger files stay as
    // zero-byte stubs until first read.
    warmupMaxBytes: envInt("SANDBOX_USER_WS_WARMUP_MAX_BYTES", 65_536),
    // Periodic sync interval — catches agent shell writes that bypass the
    // copilot-v2 file API (echo > foo, mv, custom scripts).
    periodicSyncMs: envInt("SANDBOX_USER_WS_PERIODIC_SYNC_MS", 60_000),
    // Final-sync budget on releaseSandbox. Beyond this we release anyway
    // to avoid stuck sandboxes — periodic ticks usually flushed most
    // work. Bumped 10s → 30s after Layer-2 audit I: 10s was too tight
    // when an agent's last turn wrote ≥ 50-100 MB and the periodic sync
    // hadn't ticked yet. Hitting this budget is now logged at error
    // level since sandbox FS is destroyed before pending S3 writes can
    // complete.
    releaseSyncMaxMs: envInt("SANDBOX_USER_WS_RELEASE_SYNC_MAX_MS", 30_000),
    // C1 fix: hard deadline for the DETACHED final flush. When the soft
    // releaseSyncMaxMs budget elapses we detach the flush and remove the
    // entry from the active pool — but the only reaper scans `active`, so a
    // hung flush (stuck docker exec / S3 PUT) would never reach
    // destroySandbox and the container would leak until process restart.
    // After this deadline the container is force-reclaimed regardless of
    // flush state. Already-persisted bytes are safe (sync writes blobs
    // before flipping the manifest). Must be ≥ releaseSyncMaxMs.
    releaseDrainMaxMs: envInt("SANDBOX_USER_WS_RELEASE_DRAIN_MAX_MS", 120_000),
    // Pre-exec lazy materialization (Layer-2 audit J). Before each bash /
    // python exec, the runner calls materializePendingStubs to pull any
    // S3-backed stubs into the sandbox FS so `cat foo.pdf` / `python
    // parse.py foo.pdf` see real bytes rather than zero-byte placeholders.
    //   · preExecMaterializeMaxBytes — cap per-call total bytes pulled.
    //     Default 200 MB strikes a balance between "first bash on a
    //     fresh sandbox covers most workspaces" and "huge workspaces
    //     don't stall every exec forever".
    //   · preExecMaterializeTimeMs   — cap per-call walltime. Beyond
    //     this, remaining stubs stay as zero-byte; the next exec retries.
    //   · preExecMaterializeEnabled  — kill switch. Set to 0 to disable
    //     entirely (return to lazy-via-file_read-only behaviour).
    preExecMaterializeEnabled: envBool("SANDBOX_USER_WS_PRE_EXEC_MATERIALIZE", true),
    preExecMaterializeMaxBytes: envInt("SANDBOX_USER_WS_PRE_EXEC_MAX_BYTES", 200 * 1024 * 1024),
    preExecMaterializeTimeMs: envInt("SANDBOX_USER_WS_PRE_EXEC_MAX_MS", 20_000),
    preExecMaterializeParallel: envInt("SANDBOX_USER_WS_PRE_EXEC_PARALLEL", 4)
  }
};

/**
 * True when /workspace is a LIVE S3 mount (SeaweedFS weed-FUSE) — `docker` and
 * `cube` backends. In these modes the sandbox FS IS the S3 store, so the
 * stub-era hydrate/sync machinery (built for `stub` host-exec, where the FS and
 * S3 are separate) must NOT write placeholders into /workspace — doing so
 * OVERWRITES the live bytes (a >warmupMax file becomes a 0-byte stub → the
 * user's uploaded image opens empty). See workspace/hydrate.mjs.
 */
export function liveWorkspaceMode() {
  return config.mode === "docker" || config.mode === "cube";
}
