import http from "node:http";
import { effectiveTotalMax, getPoolPolicy, setPoolPolicy } from "./pool/policy.mjs";
import { measureHost } from "./pool/host-admission.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sandboxArtifactId } from "./artifact-id.mjs";
// Capture the artifact once at boot, not on each health read. It covers every source file the
// service runs (artifact-id.mjs); the deploy compares it to decide whether this process is stale.
const NATIVE_ARTIFACT_ID = sandboxArtifactId();
import { loadEnv } from "../../../packages/shared-types/src/env.mjs";

loadEnv();

import { config, liveWorkspaceMode } from "./config.mjs";
import { log } from "./shared/log.mjs";
import { verifyInternalToken, resolveCallerUserId, resolveCallerIsPlatformAdmin } from "./shared/auth.mjs";
import { assertLegacyIdentity, callerOwnsEntry, isNamespacedRoute, namespaceBody, namespaceRequest, stripResponse } from "./shared/callers.mjs";
import { SandboxError, toErrorPayload } from "./shared/error.mjs";
import { getOrCreateRequestId } from "./shared/trace.mjs";

import {
  allocateSandbox,
  filerExposureReport,
  getActive,
  findSessionSandbox,
  findUserSandbox,
  releaseSandbox,
  startReaper,
  stopReaper,
  listActive,
  onPoolEvent
} from "./pool/manager.mjs";
import { dispatchExec } from "./exec/runner.mjs";
import { attachListener, cancelExec, gcFinishedExecs } from "./exec/streams.mjs";
import { snapshotCreate, snapshotRestore, snapshotRestoreFile, snapshotList, snapshotDiff, snapshotFileDiff } from "./snapshot/index.mjs";
import { createSshClient } from "./cube/ssh.mjs";
import { relayRoutes } from "./relay/routes.mjs";
import { notifyWorkspaceChange } from "./shared/workspace-notify.mjs";
import {
  registerLongLivedProcess,
  attachProcess,
  writeProcessStdin,
  killProcess,
  listProcesses,
  gcExitedProcesses
} from "./exec/processManager.mjs";
import { getBackend } from "./cube/index.mjs";
import { localAgentSessions } from "./agent/registry.mjs";
import {
  openTerminal as openSandboxTerminal,
  attachTerminal,
  writeTerminal,
  resizeTerminal,
  signalTerminal,
  closeTerminal,
  listTerminals,
} from "./terminal/registry.mjs";
import { handleUpload } from "./files/upload.mjs";
import { handleUserWorkspaceUpload } from "./files/user-workspace-upload.mjs";
import { quotaService, limits as quotaLimits, startQuotaEnforcer } from "./quota/index.mjs";
import { handleDownload, handleList } from "./files/download.mjs";
import { processBatchWrite } from "./files/batch.mjs";
import { captureBaseline, clearBaseline, persistArtifacts } from "./artifacts/persist.mjs";
import { loadManifest, listWorkspaceManifest, statWorkspacePath, updateManifest, SKIP_WRITE, readFile, deleteFile, isSystemDeleteProtected } from "./workspace/userStore.mjs";
import { toWorkspaceRelativePath } from "./workspace/guard.mjs";
import { notifyMemoryChange, probeMemorySync } from "./workspace/memorySync.mjs";
import { notifySkillChange, skillNameOf, probeSkillSync } from "./workspace/skillSync.mjs";

// A well-formed SHARED owner: `group:<gid>` (專案) or `org:<orgId>` (企業).
const SHARED_OWNER_RE = /^(?:group|org):[A-Za-z0-9_-]+$/;

/**
 * Is ownership enforced for this request? Always for a namespaced caller
 * (shared/callers.mjs): its key is the only thing vouching for its users, so
 * there is no "warn-only" phase to roll through. The shared token follows
 * SANDBOX_ENFORCE_OWNERSHIP as before.
 */
function enforcing(req) {
  return Boolean(req?.cacCaller) || Boolean(config.enforceOwnership);
}

/**
 * Resolve the S3 workspace OWNER for a sandbox-less user-workspace route.
 * The path `:userId` always identifies the real user (ownership enforcement +
 * memory attribution stay per-user); a trusted `x-workspace-owner` header
 * (`group:<gid>` | `org:<orgId>`) OVERRIDES only the S3 prefix so the file panel
 * / upload land in a shared space. Anything else → the user's own prefix, so
 * the personal path is unchanged. Returns { owner, isShared } (isShared ⇒ memory
 * reverse-sync is suppressed — memory is a per-user feature).
 */
function resolveWorkspaceOwner(req, userId) {
  const raw = req.headers["x-workspace-owner"];
  const hdr = Array.isArray(raw) ? raw[0] : raw;
  if (typeof hdr === "string" && SHARED_OWNER_RE.test(hdr)) {
    return { owner: hdr, isShared: true };
  }
  return { owner: userId, isShared: false };
}

function publicItem(entry, now = Date.now()) {
  return {
    sandbox_id: entry.sandboxId,
    workspace_id: entry.workspaceId,
    user_id: entry.userId || null,
    session_id: entry.sessionId || null,
    status: entry.status,
    // 這個沙盒**跑在誰的機器上**：null = 我們的雲端容器，"local"/"ssh" = 使用者
    // 自己的電腦。看的人一定要分得出來，因為兩者的意義完全不同：只有雲端的那些
    // 吃我們的容量、算進租戶配額（pool/manager.mjs 的 `if (entry.machineKind)
    // continue`）。混在一起看會讓管理員以為配額爆了，而其實爆的是別人的筆電。
    machine_kind: entry.machineKind || null,
    machine_id: entry.machineId || null,
    // 閒置回收的期限。null 有兩種意思，讀的人要分清楚：本機沙盒是**永遠**沒有
    // （配置時就設成 null，不會被回收）；雲端沙盒在第一次 touchActivity 之前也還
    // 沒有。所以不要拿 idle_at 去反推種類 —— 那是 machine_kind 的工作。
    idle_at: typeof entry.idleAt === "number" ? new Date(entry.idleAt).toISOString() : null,
    leased_at: typeof entry.leasedAt === "number" ? new Date(entry.leasedAt).toISOString() : null,
    last_activity_at: typeof entry.lastActivityAt === "number" ? new Date(entry.lastActivityAt).toISOString() : null,
    ttl_at: typeof entry.ttlAt === "number" ? new Date(entry.ttlAt).toISOString() : null,
    remaining_ms: typeof entry.ttlAt === "number" ? Math.max(0, entry.ttlAt - now) : null,
    lifetime_ms: typeof entry.ttlAt === "number" && typeof entry.leasedAt === "number"
      ? Math.max(0, entry.ttlAt - entry.leasedAt)
      : null
  };
}

function writeJson(res, status, body, requestId) {
  if (res.writableEnded) return;
  // A namespaced caller never sees its own `<namespace>--` prefix.
  if (res.cacCaller) body = stripResponse(body, res.cacCaller);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId || ""
  });
  res.end(JSON.stringify(body));
}

function writeError(res, err, requestId) {
  const payload = toErrorPayload(err, requestId);
  const status = payload.error.status || 500;
  const retryAfter = Number(payload.error?.details?.retry_after);
  if (res.writableEnded) return;
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId || ""
  };
  if (Number.isFinite(retryAfter) && retryAfter > 0 && (status === 429 || status === 503)) {
    headers["retry-after"] = String(Math.ceil(retryAfter));
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

const MAX_JSON_BYTES = 1_048_576;
async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_JSON_BYTES) {
        reject(new SandboxError("payload_too_large", `JSON body exceeds ${MAX_JSON_BYTES} bytes`, 413));
        try { req.destroy(); } catch { /* noop */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return reject(new SandboxError("bad_request", `Invalid JSON body: ${err.message}`, 400));
      }
      // Identity in a body is rewritten the same way as identity in the URL
      // (shared/callers.mjs); a refusal here is a 403, not a parse error.
      try {
        if (req.cacCaller) parsed = namespaceBody(parsed, req.cacCaller);
        else assertLegacyIdentity({ req, body: parsed });
      } catch (err) {
        return reject(err);
      }
      resolve(parsed);
    });
    req.on("error", reject);
  });
}


/** 把一個 exec handle 收成 { stdout, stderr, code }。ssh check 專用。 */
function collectHandle(handle) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    handle.on("stdout", (c) => { stdout += String(c); });
    handle.on("stderr", (c) => { stderr += String(c); });
    handle.on("exit", (evt) => resolve({ stdout, stderr, code: evt?.code ?? -1 }));
    handle.drainBufferedEvents?.();
  });
}

const routes = [
  {
    method: "GET",
    pattern: /^\/healthz\/?$/,
    requiresAuth: false,
    handler: async (req, res, ctx) => {
      writeJson(res, 200, {
        ok: true,
        service: "sandbox-runtime",
        nativeAgents: true,
        cloudImage: process.env.SANDBOX_DOCKER_IMAGE || "cm-agent-sandbox:weed-mount",
        artifactId: NATIVE_ARTIFACT_ID,
        mode: config.mode,
        active: listActive().length,
        ts: new Date().toISOString()
      }, ctx.requestId);
    }
  },
  {
    method: "GET",
    pattern: /^\/metrics\/?$/,
    requiresAuth: false,
    handler: async (req, res) => {
      const active = listActive();
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        `# HELP sandbox_active_total Active sandboxes\n` +
        `# TYPE sandbox_active_total gauge\n` +
        `sandbox_active_total ${active.length}\n`
      );
    }
  },

  // ── Rabi Local relay (daemon ⇄ cube/relay.mjs) ─────────────────────────────
  // The daemon reaches these through the app's /api/machines/relay/* proxy,
  // which verifies its device token and forwards x-machine-id. Unscoped for
  // the ownership backstop on purpose: the machine, not a sandbox, is the
  // resource, and the app already proved who owns it. See ADR-0004.
  ...relayRoutes,
  {
    // 綁定機器用的一次性檢查 —— 「這台機器現在連不連得上」和「它上面有哪些
    // 資料夾」。刻意不經過 pool：這是綁定流程還沒有 session 時就要問的問題，
    // 而把一次探測記進 pool 會佔掉那個使用者的單例名額，讓他真正的對話拿到
    // 一個綁在錯誤機器上的 sandbox。用完就拆。
    //
    // root 用 "/"：資料夾選擇器該讓人看見這個帳號看得到的東西。真正的邊界是
    // allowed_roots，那是 agent 執行時才套用的，不是瀏覽時。
    method: "POST",
    pattern: /^\/v1\/ssh\/check\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      const machine = body?.machine;
      if (!machine?.host || !machine?.user) {
        throw new SandboxError("bad_request", "machine { host, user } is required", 400);
      }
      const client = createSshClient({
        resolveTarget: () => ({
          host: machine.host,
          port: Number(machine.port) || 22,
          user: machine.user,
          principal: machine.principal || machine.user,
          root: "/",
        }),
      });
      const { sandboxId } = await client.createSandbox({ userId: body?.user_id, sessionId: "ssh-check" });
      try {
        if (body?.op === "browse") {
          // 沒指定路徑就從家目錄開始 —— ~ 在不同系統、不同帳號下不是同一個地方，
          // 所以讓遠端自己回答「家在哪」，而不是在這裡拼字串。
          const target = String(body?.path || "").trim();
          const cmd = target
            ? `cd -- ${JSON.stringify(target)} && pwd -P && ls -1p 2>/dev/null | grep '/$' || true`
            : `cd -- "$HOME" && pwd -P && ls -1p 2>/dev/null | grep '/$' || true`;
          const handle = await client.execProcess(sandboxId, { kind: "bash", command: cmd, timeoutMs: 15000 });
          const out = await collectHandle(handle);
          if (out.code !== 0) {
            return writeJson(res, 200, { ok: false, message: out.stderr.trim() || `exit ${out.code}` }, ctx.requestId);
          }
          const lines = out.stdout.split("\n");
          const cwd = (lines.shift() || "").trim();
          const dirs = lines
            .map((l) => l.replace(/\/$/, "").trim())
            .filter(Boolean)
            .map((name) => ({ name, path: `${cwd.replace(/\/+$/, "")}/${name}` }));
          return writeJson(res, 200, { ok: true, path: cwd, dirs }, ctx.requestId);
        }
        // probe：連一次並問它是什麼。跑得動 bash 是能不能用的最低門檻，
        // 所以連 uname 都用 bash 跑 —— Windows 沒有 WSL 會在這裡就露餡。
        const handle = await client.execProcess(sandboxId, {
          kind: "bash", command: "uname -a", timeoutMs: 15000,
        });
        const out = await collectHandle(handle);
        return writeJson(res, 200, {
          ok: out.code === 0,
          // ssh 自己的話原封不動往上送 —— 「Permission denied (publickey)」
          // 是使用者可以處理的，「連線失敗」不是。
          message: out.code === 0 ? out.stdout.trim() : (out.stderr.trim() || `exit ${out.code}`),
        }, ctx.requestId);
      } finally {
        await client.destroySandbox(sandboxId).catch(() => {});
      }
    }
  },

  {
    method: "GET",
    pattern: /^\/v1\/sandboxes\/?$/,
    handler: async (req, res, ctx) => {
      const now = Date.now();
      // This route has no path param so the generic ownership block can't scope
      // it — yet it lists every tenant's sandbox/user/session. Under enforcement,
      // filter to the caller's own sandboxes (empty when no identity asserted) so
      // it can't be used to enumerate the tenant roster.
      // A caller lists only its own namespace's sandboxes (the shared token: the un-namespaced ones).
      let entries = listActive().filter((e) => callerOwnsEntry(req.cacCaller, e));
      // 後台管理員是這條路的**例外**：「現在有哪些沙盒活著」本來就是跨租戶的問題，
      // 濾成自己那幾個等於什麼都看不到。是不是管理員由 app 的 requireCapability
      // 決定，這裡只驗簽章（見 resolveCallerIsPlatformAdmin）。
      const isAdmin = resolveCallerIsPlatformAdmin(req);
      if (enforcing(req) && !isAdmin) {
        const caller = resolveCallerUserId(req, ctx.auth?.claims);
        entries = caller ? entries.filter((e) => e.userId === caller) : [];
      }
      const items = entries.map((entry) => publicItem(entry, now));
      writeJson(
        res,
        200,
        {
          items,
          count: items.length,
          now_ms: now,
          scope: isAdmin ? "platform" : "caller",
          user_max_active: config.pool.userMaxActive,
          // 「這個部署現在是哪一種狀態」——唯讀，掛在這一支而不是新開一支。
          //
          // 為什麼是這裡：它已經要驗 internal token、已經是後台面板每 10 秒問
          // 的那一支（所以不用多一次來回），而且它分得出平台視角。為什麼**不是**
          // /healthz：那一支 requiresAuth: false，把「這台機器的租戶隔離是開是關」
          // 印在一支任何人打得到的端點上，等於替想找軟柿子的人做好功課。
          //
          // 只給平台管理員：這是部署層的事實，不是租戶資料。被濾成 caller 視角的
          // 呼叫者拿到 null，而那件事本身後台已經會說（scope）。
          filer_exposure: isAdmin ? filerExposureReport() : null,
        },
        ctx.requestId,
      );
    }
  },
  {
    method: "GET",
    pattern: /^\/v1\/sandboxes\/stream\/?$/,
    handler: async (req, res, ctx) => {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
        "x-request-id": ctx.requestId || "",
        "x-accel-buffering": "no"
      });
      const send = (event, payload) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      // Same cross-tenant concern as the list route: under enforcement, only
      // stream the caller's own sandbox lifecycle events (no identity → nothing).
      const caller = enforcing(req) ? resolveCallerUserId(req, ctx.auth?.claims) : null;
      const visible = (entry) => callerOwnsEntry(req.cacCaller, entry) && (!enforcing(req) || (!!caller && entry?.userId === caller));
      const now = Date.now();
      send("snapshot", {
        now_ms: now,
        items: listActive().filter(visible).map((entry) => publicItem(entry, now))
      });
      const unsub = onPoolEvent((evt) => {
        const ts = Date.now();
        if (!visible(evt?.entry)) return;
        const item = evt?.entry ? publicItem(evt.entry, ts) : null;
        if (evt.kind === "created" || evt.kind === "reconnected") {
          send("created", { now_ms: ts, item });
        } else if (evt.kind === "released") {
          send("released", {
            now_ms: ts,
            sandbox_id: evt?.entry?.sandboxId || null,
            user_id: evt?.entry?.userId || null,
            session_id: evt?.entry?.sessionId || null,
            reason: evt.reason || "released",
          });
        }
      });
      const heartbeat = setInterval(() => {
        if (res.writableEnded) return;
        res.write(`: ping\n\n`);
      }, 15000);
      heartbeat.unref?.();
      const cleanup = () => {
        try { clearInterval(heartbeat); } catch { /* noop */ }
        try { unsub(); } catch { /* noop */ }
        if (!res.writableEnded) try { res.end(); } catch { /* noop */ }
      };
      req.on("close", cleanup);
      req.on("aborted", cleanup);
      res.on("close", cleanup);
      res.on("error", cleanup);
    }
  },
  {
    method: "POST",
    pattern: /^\/v1\/sandboxes\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      const {
        user_id, session_id, image, resource_quota, ttl_seconds, network_policy,
        end_user_id, idle_timeout_sec, metadata, workspace_mode,
        workspace_mount_path, workspace_owner,
        // The machine the app resolved from the composer's chip (user_machines
        // row → { id, kind, host, port, user, principal, root }). Its presence
        // is what routes this allocation to the ssh / relay backend instead of
        // docker (pool/manager.mjs). Shape-checked here; identity was the app's job.
        machine
      } = body || {};
      // The S3 workspace owner: `user:<id>` (personal) or `group:<gid>` (an
      // enterprise shared project). Only honour a well-formed group owner from
      // the trusted BFF; anything else → personal (the user's own prefix), so
      // the personal path is unchanged. The runtime never resolves group
      // MEMBERSHIP (no DB) — the BFF re-verifies it before sending this.
      const workspaceOwner =
        typeof workspace_owner === "string" && SHARED_OWNER_RE.test(workspace_owner)
          ? workspace_owner
          : (user_id ? `user:${user_id}` : null);
      // Ownership backstop for allocate: the new sandbox is stamped with
      // `user_id`, so a caller must not be able to mint a sandbox owned by a
      // user they aren't acting for. When enforcing, require the on-behalf-of
      // identity to match the requested owner.
      // A namespaced caller's sandbox is traced back to it through the user id
      // (shared/callers.mjs callerOwnsEntry), so it cannot allocate anonymously.
      if (req.cacCaller && !user_id) {
        throw new SandboxError("bad_request", "user_id is required for this caller", 400, { reason: "user_id_required" });
      }
      if (enforcing(req)) {
        const caller = resolveCallerUserId(req, ctx.auth?.claims);
        if (!caller || (user_id && caller !== String(user_id))) {
          throw new SandboxError("forbidden", "allocate ownership check failed", 403, {
            reason: caller ? "owner_mismatch" : "caller_identity_required",
          });
        }
      }
      // workspace_mode "user" enables the B27 per-user S3-backed workspace —
      // only honored when the operator has opted into the feature flag.
      const requestedMode = workspace_mode === "user" && config.workspace?.userS3Enabled
        ? "user"
        : "ephemeral";
      // Phase 4.2: optional host path the caller (llm-runtime session-manager)
      // wants bind-mounted into the container's /workspace. Validate it's a
      // string when present so we fail fast on a bad client; absent → legacy
      // behaviour (stub tmpdir / S3 hydration). Honouring the bind-mount is
      // the backend's job (stub logs; cube wires it through to the runtime).
      let workspaceMountPath = null;
      if (workspace_mount_path != null) {
        if (typeof workspace_mount_path !== "string" || !workspace_mount_path) {
          throw new SandboxError(
            "bad_request",
            "workspace_mount_path must be a non-empty string when provided",
            400
          );
        }
        workspaceMountPath = workspace_mount_path;
      }
      const machineTarget =
        machine && typeof machine === "object" && typeof machine.id === "string" && typeof machine.kind === "string"
          ? machine
          : null;
      if (machine && !machineTarget) {
        throw new SandboxError("bad_request", "machine must be an object with string id and kind", 400);
      }
      const { entry, fromPool, reconnect } = await allocateSandbox({
        userId: user_id,
        machine: machineTarget,
        endUserId: end_user_id || null,
        sessionId: session_id,
        image,
        resourceQuota: resource_quota,
        ttlSec: ttl_seconds,
        idleTimeoutSec: idle_timeout_sec,
        networkPolicy: network_policy,
        workspaceMode: requestedMode,
        workspaceOwner,
        workspaceMountPath,
        // Forward tags for the Cube vendor (per-tenant resource labels,
        // billing aggregation) — stub backend ignores these.
        metadata: metadata && typeof metadata === "object" ? metadata : null
      });
      // The git baseline is a cloud-sandbox ritual; on an Rabi Local machine it
      // would be a `git add`/`commit` in the user's folder — a write that
      // needs approval, and nothing the user asked for.
      if (!reconnect && entry.machineKind !== "local") {
        try { await captureBaseline(entry.sandboxId); } catch (err) { log("warn", "baseline.capture_failed", { sandboxId: entry.sandboxId, message: err?.message }); }
        // (Removed: hydrateSandboxFromUser + startPeriodicSync. A user-mode
        // workspace is a weed-mount FUSE view of the S3 store — the container
        // sees every durable file the instant it mounts, with no S3→sandbox
        // hydrate to run and no periodic sandbox→S3 flush to schedule. See
        // docs/plan-remove-stub-subsystem.md.)
      }
      writeJson(res, 200, {
        sandbox_id: entry.sandboxId,
        workspace_id: entry.workspaceId,
        status: entry.status,
        workspace_mode: entry.workspaceMode,
        from_pool: fromPool,
        reconnect,
        ttl_at: new Date(entry.ttlAt).toISOString()
      }, ctx.requestId);
    }
  },
  {
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/exec\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      const result = await dispatchExec({
        sandboxId: ctx.params.id,
        kind: body?.kind,
        payload: body?.payload || {},
        timeoutMs: body?.timeout_ms
      });
      writeJson(res, 202, result, ctx.requestId);
    }
  },
  {
    method: "GET",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/exec\/(?<execId>[^/]+)\/stream\/?$/,
    handler: async (req, res, ctx) => {
      // Scope the lookup to the sandbox in the path. Without this the `id`
      // capture is decorative: the dispatcher checks it, the handler ignores
      // it, and any caller who owns ANY sandbox can read or kill an exec in
      // someone else's (confirmed live 2026-09-02). See exec/exec-scope.test.mjs.
      const attached = attachListener(ctx.params.execId, res, { sandboxId: ctx.params.id });
      if (!attached) {
        throw new SandboxError("not_found", `exec ${ctx.params.execId} not found`, 404);
      }
    }
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/exec\/(?<execId>[^/]+)\/?$/,
    handler: async (req, res, ctx) => {
      const ok = cancelExec(ctx.params.execId, { sandboxId: ctx.params.id });
      writeJson(res, ok ? 200 : 404, { cancelled: ok }, ctx.requestId);
    }
  },
  // ── Long-lived processes (stdio MCP servers, hook daemons) ──────────────
  {
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/processes\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      const sandboxId = ctx.params.id;
      const { command, args, env, cwd, approval, sandbox } = body || {};
      if (typeof command !== "string" || !command) {
        throw new SandboxError("bad_request", "command is required", 400);
      }
      const backend = getBackend(sandboxId);
      const handle = await backend.spawnLongLivedProcess(sandboxId, {
        command,
        args: Array.isArray(args) ? args : [],
        env: env && typeof env === "object" ? env : {},
        cwd,
        // 使用者自己的電腦上，會改東西的指令要一張使用者簽過的票 —— 跟 /exec
        // 同一條規矩。少了這兩個欄位，背景執行在本機落點只跑得動唯讀指令，
        // 而「把專案跑起來」那一句話最後一步永遠是 `pnpm dev` 這種要核准的。
        // 雲端後端不看它們（docker.mjs 的簽名裡沒有），所以帶著是無害的。
        approval: typeof approval === "string" && approval ? approval : null,
        sandbox: sandbox === true
      });
      const { processHandle, startedAt } = registerLongLivedProcess({
        sandboxId, handle, command, args
      });
      writeJson(res, 201, {
        sandbox_id: sandboxId,
        process_handle: processHandle,
        started_at: new Date(startedAt).toISOString()
      }, ctx.requestId);
    }
  },
  {
    method: "GET",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/processes\/?$/,
    handler: async (req, res, ctx) => {
      const list = listProcesses(ctx.params.id);
      writeJson(res, 200, { processes: list }, ctx.requestId);
    }
  },
  {
    method: "GET",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/processes\/(?<handle>[^/]+)\/attach\/?$/,
    handler: async (req, res, ctx) => {
      const entry = attachProcess(ctx.params.id, ctx.params.handle, res);
      if (!entry) {
        throw new SandboxError("process_not_found", `process ${ctx.params.handle} not found`, 404);
      }
      // SSE response is now owned by processManager; do not write more headers.
    }
  },
  {
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/processes\/(?<handle>[^/]+)\/stdin\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      const data = typeof body?.data === "string" ? body.data : "";
      writeProcessStdin(ctx.params.id, ctx.params.handle, data);
      writeJson(res, 200, { ok: true, bytes: Buffer.byteLength(data, "utf8") }, ctx.requestId);
    }
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/processes\/(?<handle>[^/]+)\/?$/,
    handler: async (req, res, ctx) => {
      const ok = killProcess(ctx.params.id, ctx.params.handle);
      writeJson(res, ok ? 200 : 404, { killed: ok }, ctx.requestId);
    }
  },

  // Every route has a named `id` group, so the common sandbox ownership
  // backstop checks the signed caller before the agent registry sees it.
  {
    method: "GET",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/agents\/(?<aid>[^/]+)\/?$/,
    handler: async (_req, res, ctx) => writeJson(res, 200, localAgentSessions.describe(ctx.params.id, ctx.params.aid), ctx.requestId),
  },
  {
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/agents\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      const result = await localAgentSessions.open(ctx.params.id, getBackend(ctx.params.id), {
        cwd: body?.cwd, model: body?.model, runtime: body?.runtime,
        approval: typeof body?.approval === "string" ? body.approval : null,
      });
      writeJson(res, 201, result, ctx.requestId);
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/agents\/(?<aid>[^/]+)\/stream\/?$/,
    handler: async (_req, res, ctx) => localAgentSessions.attach(ctx.params.id, ctx.params.aid, Number(ctx.url.searchParams.get("after") ?? 0), res),
  },
  {
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/agents\/(?<aid>[^/]+)\/input\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      await localAgentSessions.input(ctx.params.id, ctx.params.aid, body?.message);
      writeJson(res, 200, { ok: true }, ctx.requestId);
    },
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/agents\/(?<aid>[^/]+)\/?$/,
    handler: async (_req, res, ctx) => {
      await localAgentSessions.close(ctx.params.id, ctx.params.aid);
      writeJson(res, 200, { ok: true }, ctx.requestId);
    },
  },

  // ── 互動式終端機 ────────────────────────────────────────────────────
  //
  // **這不是 /processes 的一個旗標，是另一組端點。** 兩者的形狀不一樣而且無法
  // 合併：背景行程是 stdout／stderr 兩條分開的文字流、有退出碼、輸出是增量讀的；
  // 終端機是**一條**位元組流（stdout 與 stderr 在同一個 tty 上，本來就分不開）、
  // 有尺寸、輸入是即時的按鍵。把它塞進 /processes 只會讓兩邊都長出對方用不到的
  // 欄位，而「哪些欄位這次有效」會變成呼叫端要猜的事。
  //
  // 位元組一律 base64。PTY 送的是位元組不是文字，在傳輸層當成 UTF-8 解會把
  // 跨 chunk 的多位元組字元變成替代字元 —— 那個損壞不可逆。
  {
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/terminals\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      const backend = getBackend(ctx.params.id);
      const out = await openSandboxTerminal({
        sandboxId: ctx.params.id,
        backend,
        spec: {
          ...(body?.slot !== undefined ? { slot: body.slot } : {}),
          cwd: typeof body?.cwd === "string" ? body.cwd : undefined,
          cols: body?.cols, rows: body?.rows,
          env: body?.env && typeof body.env === "object" ? body.env : {},
          approval: typeof body?.approval === "string" && body.approval ? body.approval : null,
        },
      });
      writeJson(res, 201, {
        sandbox_id: ctx.params.id,
        terminal_id: out.terminalId,
        cols: out.cols, rows: out.rows,
      }, ctx.requestId);
    }
  },
  {
    method: "GET",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/terminals\/?$/,
    handler: async (req, res, ctx) => {
      writeJson(res, 200, { terminals: listTerminals(ctx.params.id) }, ctx.requestId);
    }
  },
  {
    method: "GET",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/terminals\/(?<tid>[^/]+)\/stream\/?$/,
    handler: async (req, res, ctx) => {
      attachTerminal(ctx.params.id, ctx.params.tid, res);
      // SSE 的回應從這裡開始歸串流所有 —— 不要再寫任何標頭。
    }
  },
  {
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/terminals\/(?<tid>[^/]+)\/input\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      const out = await writeTerminal(ctx.params.id, ctx.params.tid, body?.data);
      writeJson(res, 200, { ok: true, ...out }, ctx.requestId);
    }
  },
  {
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/terminals\/(?<tid>[^/]+)\/resize\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      const out = await resizeTerminal(ctx.params.id, ctx.params.tid, body?.cols, body?.rows);
      writeJson(res, 200, { ok: true, ...out }, ctx.requestId);
    }
  },
  {
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/terminals\/(?<tid>[^/]+)\/signal\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      const out = await signalTerminal(ctx.params.id, ctx.params.tid, body?.signal || "SIGINT");
      writeJson(res, 200, { ok: true, ...out }, ctx.requestId);
    }
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/terminals\/(?<tid>[^/]+)\/?$/,
    handler: async (req, res, ctx) => {
      const out = await closeTerminal(ctx.params.id, ctx.params.tid);
      writeJson(res, out.closed ? 200 : 404, out, ctx.requestId);
    }
  },

  {
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/upload\/?$/,
    handler: async (req, res, ctx) => {
      const result = await handleUpload({ sandboxId: ctx.params.id, req, url: ctx.url });
      writeJson(res, 200, result, ctx.requestId);
    }
  },
  {
    method: "GET",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/files\/list\/?$/,
    handler: async (req, res, ctx) => {
      await handleList({ sandboxId: ctx.params.id, res, url: ctx.url, requestId: ctx.requestId });
    }
  },
  {
    method: "GET",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/files\/?$/,
    handler: async (req, res, ctx) => {
      await handleDownload({ sandboxId: ctx.params.id, res, url: ctx.url, requestId: ctx.requestId });
    }
  },
  {
    // Batch file-write — N files in one round trip. Used by the agent
    // runtime's workspace-projection (skills / memory / AGENT.md). Must
    // sit before the single-file GET above can't shadow it (different
    // method + more-specific path, so order is not load-bearing here).
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/files\/batch\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      const backend = getBackend(ctx.params.id);
      const result = await processBatchWrite({ sandboxId: ctx.params.id, body, backend });
      writeJson(res, 200, result, ctx.requestId);
    }
  },
  {
    // O10 — capture a git tree snapshot of /workspace. Returns { hash }.
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/snapshot\/?$/,
    handler: async (req, res, ctx) => {
      const result = await snapshotCreate(ctx.params.id);
      writeJson(res, 200, result, ctx.requestId);
    }
  },
  {
    // O10 — restore /workspace to a prior snapshot hash. DESTRUCTIVE:
    // overwrites/removes files not in the snapshot tree (the caller's
    // revert flow confirms with the user first). Body: { hash }.
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/snapshot\/restore\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      const result = await snapshotRestore(ctx.params.id, body?.hash);
      writeJson(res, 200, result, ctx.requestId);
    }
  },
  {
    // Restore SPECIFIC file(s) from a snapshot — the "recover a deleted file"
    // path. NON-destructive to the rest of the tree + the conversation. Body:
    // { hash, paths: string[] } (paths workspace-relative).
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/snapshot\/restore-file\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      // removeMissing：檢閱面板的「還原」—— 基準裡沒有的檔（對話新增的）就刪掉。
      const result = await snapshotRestoreFile(ctx.params.id, body?.hash, body?.paths ?? body?.path, {
        removeMissing: body?.removeMissing === true,
      });
      writeJson(res, 200, result, ctx.requestId);
    }
  },
  {
    // 審閱面板的資料來源：從某個 baseline 到「工作區當下」改了哪些檔案。
    //
    // 比的是工作區當下而不是另一個 commit —— 使用者要審的是 agent 剛剛做完
    // 的東西，那些改動還沒有被任何快照收進去。
    //
    //   ?base=<40hex>            → { base, files: [{ path, status, additions, deletions, from }] }
    //   ?base=<40hex>&path=<p>   → { path, status, diff }   單檔 unified diff
    //
    // base 還不存在（session 還沒動過任何東西）→ 空清單，不是錯誤。
    method: "GET",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/diff\/?$/,
    handler: async (req, res, ctx) => {
      const base = ctx.url.searchParams.get("base") || "";
      const path = ctx.url.searchParams.get("path") || "";
      const result = path
        ? await snapshotFileDiff(ctx.params.id, base, path)
        : await snapshotDiff(ctx.params.id, base);
      writeJson(res, 200, result, ctx.requestId);
    }
  },
  {
    // List the workspace owner's snapshot history (refs/heads/snapshots),
    // newest first — cross-session, for the file-panel restore browser.
    // Query: ?limit=N. Returns { snapshots: [{ commit, tree, time, subject }] }.
    method: "GET",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/snapshots\/?$/,
    handler: async (req, res, ctx) => {
      const result = await snapshotList(ctx.params.id, ctx.url.searchParams.get("limit"), ctx.url.searchParams.get("path") || "");
      writeJson(res, 200, result, ctx.requestId);
    }
  },
  {
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/resume\/?$/,
    handler: async () => {
      throw new SandboxError("not_implemented", "resume is Phase 2", 501);
    }
  },
  {
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/workspace\/sync\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req).catch(() => ({}));
      const entry = getActive(ctx.params.id);
      if (entry.workspaceMode !== "user" || !entry.userId) {
        throw new SandboxError("not_applicable", "workspace sync only applies to user-mode sandboxes", 400);
      }
      const paths = Array.isArray(body?.paths) && body.paths.length > 0 ? body.paths : null;
      // No-op under FUSE — the weed-mount workspace IS S3, so writes are already
      // durable and there is nothing to flush. Kept as a 200 so existing manual-
      // sync callers don't 404. (Removed: syncSandboxToUser.)
      writeJson(res, 200, {
        synced: true, uploaded: 0, deleted: 0, skipped: [], paths: paths || [],
        reason: "live_workspace_noop",
      }, ctx.requestId);
    }
  },
  {
    method: "GET",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/workspace\/manifest\/?$/,
    handler: async (req, res, ctx) => {
      const entry = getActive(ctx.params.id);
      if (entry.workspaceMode !== "user" || !entry.userId) {
        throw new SandboxError("not_applicable", "workspace manifest only applies to user-mode sandboxes", 400);
      }
      const manifest = await loadManifest(entry.workspaceOwner || entry.userId);
      writeJson(res, 200, {
        sandbox_id: entry.sandboxId,
        user_id: entry.userId,
        workspace_owner: entry.workspaceOwner || null,
        workspace_mode: entry.workspaceMode,
        manifest
      }, ctx.requestId);
    }
  },
  {
    // Sandbox-independent read of the per-user workspace manifest.
    // Lets the FE render the sidebar file tree on the empty-hero
    // landing page (no session yet, no sandbox bound) so the user
    // sees their files immediately instead of an "empty" placeholder
    // that's lying — their files DO exist, just in S3, not in a live
    // sandbox.
    //
    // No sandbox allocation happens here. When the user actually
    // clicks a file or sends a chat turn, the regular ensure flow
    // kicks in and hydrates a sandbox from this same manifest.
    //
    // Authorization: the route trusts the internal bearer (this
    // service is only reachable from llm-runtime / the Next.js
    // server). The upstream Next.js proxy enforces that the userId
    // in the path matches the authenticated session's user.
    method: "GET",
    pattern: /^\/v1\/users\/(?<userId>[^/]+)\/workspace\/manifest\/?$/,
    handler: async (req, res, ctx) => {
      const userId = ctx.params.userId;
      if (!userId) throw new SandboxError("invalid_request", "userId required", 400);
      if (!config.workspace?.userS3Enabled) {
        throw new SandboxError("not_applicable", "per-user workspace not enabled (AGENT_WORKSPACE_S3=0)", 400);
      }
      const { owner } = resolveWorkspaceOwner(req, userId);
      // FUSE/weed-mount workspaces (docker/cube): /workspace IS the S3 store, so
      // bash + uploads write bytes at their logical path but never update
      // `.manifest.json`. List ACTUAL S3 objects so the panel reflects reality
      // (the file the agent just bash-created shows up) instead of the stale
      // index. stub mode keeps the manifest as its source of truth.
      const manifest = liveWorkspaceMode()
        ? await listWorkspaceManifest(owner)
        : await loadManifest(owner);
      writeJson(res, 200, {
        user_id: userId,
        workspace_owner: owner,
        workspace_mode: "user",
        manifest
      }, ctx.requestId);
    }
  },
  {
    // 單一路徑的 stat —— 跟上面那份清單一樣的答案，但不列整個工作區
    // （userStore.statWorkspacePath 的說明）。引擎的雲端 stat() 靠它；這支不存在的
    // 舊版 sandbox-runtime，引擎會退回抓清單。
    method: "GET",
    pattern: /^\/v1\/users\/(?<userId>[^/]+)\/workspace\/stat\/?$/,
    handler: async (req, res, ctx) => {
      const userId = ctx.params.userId;
      if (!userId) throw new SandboxError("invalid_request", "userId required", 400);
      if (!config.workspace?.userS3Enabled) {
        throw new SandboxError("not_applicable", "per-user workspace not enabled (AGENT_WORKSPACE_S3=0)", 400);
      }
      const { owner } = resolveWorkspaceOwner(req, userId);
      const relPath = (ctx.url.searchParams.get("path") || "").normalize("NFC");
      const hit = await statWorkspacePath(owner, relPath, { live: liveWorkspaceMode() });
      if (!hit) { writeJson(res, 404, { exists: false, path: relPath }, ctx.requestId); return; }
      writeJson(res, 200, { exists: true, path: relPath, ...hit }, ctx.requestId);
    }
  },
  {
    // Per-user workspace file download — no sandbox required. Reads the
    // manifest, resolves relPath → sha256, streams the blob back.
    // Used by the reparse path in copilot-v2 to re-OCR an existing
    // upload without keeping a separate S3 client there.
    method: "GET",
    pattern: /^\/v1\/users\/(?<userId>[^/]+)\/workspace\/file\/?$/,
    handler: async (req, res, ctx) => {
      const userId = ctx.params.userId;
      if (!userId) throw new SandboxError("invalid_request", "userId required", 400);
      if (!config.workspace?.userS3Enabled) {
        throw new SandboxError("not_applicable", "per-user workspace not enabled (AGENT_WORKSPACE_S3=0)", 400);
      }
      // NFC-normalize so an NFD-vs-NFC filename (CJK/accents) still resolves
      // against the stored manifest key — symmetric with the upload write.
      const relPath = (ctx.url.searchParams.get("path") || "").normalize("NFC");
      if (!relPath) throw new SandboxError("bad_request", "download requires ?path=<relative path>", 400);
      const { owner } = resolveWorkspaceOwner(req, userId);
      // FUSE/weed-mount (docker/cube): /workspace IS the S3 store, so a
      // bash / script / `mv` write lands bytes at its logical key but never
      // updates `.manifest.json`. The LISTING endpoint above already reads
      // ACTUAL S3 objects in this mode — the download MUST be symmetric, or a
      // bash-created file lists fine (correct size) yet 404s on open
      // ("面板有、點開沒內容"). So resolve the bytes from S3 DIRECTLY, not the
      // stale manifest. stub mode keeps the manifest as source of truth.
      let buf;
      if (liveWorkspaceMode()) {
        buf = await readFile(owner, relPath).catch(() => null);
        if (!buf) {
          // NFC fallback: the object may be stored under an NFD key (CJK /
          // accents). Scan the live S3 listing for an NFC-equal key.
          const listed = await listWorkspaceManifest(owner).catch(() => null);
          const hit = listed?.entries
            ? Object.keys(listed.entries).find((k) => k.normalize("NFC") === relPath)
            : null;
          if (hit) buf = await readFile(owner, hit).catch(() => null);
        }
        if (!buf) throw new SandboxError("not_found", `file not found: ${relPath}`, 404);
      } else {
        const manifest = await loadManifest(owner);
        // Exact match first; fall back to an NFC-insensitive scan so files stored
        // before normalization (NFD keys) still resolve.
        let entry = manifest.entries?.[relPath];
        let key = relPath;
        if (!entry && manifest.entries) {
          const hit = Object.keys(manifest.entries).find((k) => k.normalize("NFC") === relPath);
          if (hit) { entry = manifest.entries[hit]; key = hit; }
        }
        if (!entry || entry.kind === "dir" || !entry.sha256) {
          throw new SandboxError("not_found", `manifest entry ${relPath} not found`, 404);
        }
        // Plain-tree: read the bytes from the LOGICAL path (the manifest key),
        // not a content-addressed blob.
        buf = await readFile(owner, key);
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(buf.length),
        "x-request-id": ctx.requestId,
      });
      res.end(buf);
    }
  },
  {
    // 雲端工作區空間：已用／上限／剩餘（只計 workspace/）。面板標題列與上傳前的比對用。
    // `?fresh=1` 跳過快取（輪結束檢查要最新的數字）。
    method: "GET",
    pattern: /^\/v1\/users\/(?<userId>[^/]+)\/workspace\/quota\/?$/,
    handler: async (req, res, ctx) => {
      const { owner } = resolveWorkspaceOwner(req, ctx.params.userId);
      const state = await quotaService.state(owner, { fresh: ctx.url.searchParams.get("fresh") === "1" });
      writeJson(res, 200, state, ctx.requestId);
    }
  },
  {
    // app 推送雲端沙盒政策（管理後台 ▸ 平台設定）：閒置多久回收、選用的絕對壽命、全平台上限、
    // 依主機資源自動調整（pool/policy.mjs）。整包合法才收；亂值回 400，不改現狀。
    // GET 回現在生效的政策＋這一刻量到的主機資源，給後台顯示「現在是什麼狀況」。
    method: "POST",
    pattern: /^\/v1\/pool\/policy\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req).catch(() => null);
      if (!setPoolPolicy(body)) throw new SandboxError("bad_request", "invalid pool policy", 400);
      writeJson(res, 200, { policy: getPoolPolicy() }, ctx.requestId);
    }
  },
  {
    method: "GET",
    pattern: /^\/v1\/pool\/policy\/?$/,
    handler: async (req, res, ctx) => {
      const policy = getPoolPolicy();
      writeJson(res, 200, { policy, effectiveTotalMax: effectiveTotalMax(policy), host: measureHost() }, ctx.requestId);
    }
  },
  {
    // app 推送上限：全站值（管理後台）與依方案的 owner 覆寫（`owners`，見 quota/limits.mjs）。整包合法才收；亂值回 400，不改現狀。
    method: "POST",
    pattern: /^\/v1\/workspace-quota\/limits\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req).catch(() => null);
      if (!quotaLimits.set({ personalBytes: body?.personalBytes, sharedBytes: body?.sharedBytes, owners: body?.owners })) {
        throw new SandboxError("bad_request", "personalBytes/sharedBytes must be non-negative integers and owners a map of <kind>:<id> to bytes or null", 400);
      }
      writeJson(res, 200, quotaLimits.snapshot(), ctx.requestId);
    }
  },
  {
    // Per-user workspace upload — no sandbox required. Mirrors the
    // sandbox-independent posture of /workspace/manifest above so the
    // upstream file panel can land bytes before any chat session
    // exists. Auth (userId-on-path == authed-userId) is enforced by
    // the Next.js proxy.
    method: "POST",
    pattern: /^\/v1\/users\/(?<userId>[^/]+)\/workspace\/file(?:-conditional)?\/?$/,
    handler: async (req, res, ctx) => {
      const { owner } = resolveWorkspaceOwner(req, ctx.params.userId);
      const result = await handleUserWorkspaceUpload({
        userId: ctx.params.userId,
        owner,
        req,
        url: ctx.url,
      });
      writeJson(res, 200, result, ctx.requestId);
    }
  },
  {
    // Per-user workspace file delete — drops the manifest entry so
    // the file disappears from the rail tree. The content-addressed
    // blob is left in place: a later GC pass can reclaim orphaned
    // blobs, and another entry may still reference the same sha256
    // (uploading the same file under a second name is a free no-op
    // in this layout).
    //
    // No sandbox required — works pre-session like the upload route.
    // The /workspace/sync periodic flow keeps live sandbox views in
    // sync with the manifest on next hydration; for the user-facing
    // tree the manifest IS the source of truth.
    method: "DELETE",
    pattern: /^\/v1\/users\/(?<userId>[^/]+)\/workspace\/file\/?$/,
    handler: async (req, res, ctx) => {
      const userId = ctx.params.userId;
      if (!userId) throw new SandboxError("invalid_request", "userId required", 400);
      if (!config.workspace?.userS3Enabled) {
        throw new SandboxError("not_applicable", "per-user workspace not enabled (AGENT_WORKSPACE_S3=0)", 400);
      }
      // Validate + normalize (rejects traversal / absolute paths), symmetric
      // with the upload + folder routes — this is the only traversal guard for
      // engine-internal deletes too.
      const { owner, isShared } = resolveWorkspaceOwner(req, userId);
      const relPath = toWorkspaceRelativePath(
        ctx.url.searchParams.get("path") || "",
        "/workspace",
        { allowEmpty: false, label: "path" },
      );
      // Data-safety guard: refuse to delete a SYSTEM container dir (.opencode,
      // .opencode/skills|memories, the whole .unieai/ subtree). A targeted leaf
      // delete (.opencode/skills/<name>) is still allowed so skill management
      // works. Blocks "clean up the workspace" → wiping the skill/memory library.
      if (isSystemDeleteProtected(relPath)) {
        throw new SandboxError("protected_path",
          `"${relPath}" is a protected system folder and cannot be deleted. ` +
          `To remove a single skill or memory, delete its specific item instead.`, 403);
      }
      // Compare-and-swap so a parallel upload or sync can't see a stale
      // baseline and resurrect the deleted entry. The mutation removes ONE
      // path, so re-applying it on a newer baseline is exactly right.
      const existed = await updateManifest(owner, (manifest) => {
        manifest.entries = manifest.entries || {};
        const had = Object.prototype.hasOwnProperty.call(manifest.entries, relPath);
        if (had) delete manifest.entries[relPath];
        return had;
      });
      // Plain-tree: actually remove the S3 object (not just the index entry).
      // Outside the CAS: it is not idempotent-cheap to repeat on every retry,
      // and the index removal above is what hides the file either way.
      try { await deleteFile(owner, relPath); } catch { /* tolerate — index removal already hides it */ }

      // (Removed: mirror-delete into a live sandbox. The S3 object delete above
      // removes it from the weed-mount workspace directly — `/workspace` IS S3 —
      // so find/glob/ls reflect it immediately with no stub-index upkeep. See
      // docs/plan-remove-stub-subsystem.md.)

      // Reverse-sync memory deletes to copilot-v2 (no-op for non-memory paths).
      // Personal-only (memory isn't modelled for shared groups); staging
      // (DB→S3 prune) sets x-skip-memory-sync to avoid a delete loop.
      if (!isShared && req.headers["x-skip-memory-sync"] !== "1") {
        notifyMemoryChange(userId, relPath, "delete");
      }
      // Same for a deleted skill file (personal-only); the app re-reads the
      // folder and removes the DB row if SKILL.md is gone.
      if (!isShared && req.headers["x-skip-skill-sync"] !== "1") {
        const sn = skillNameOf(relPath);
        if (sn) notifySkillChange(userId, sn);
      }
      // Panel freshness hint (agent deletes via the engine's direct-S3 route
      // are otherwise invisible to the app's event channel).
      if (existed && req.headers["x-skip-skill-sync"] !== "1" && req.headers["x-skip-memory-sync"] !== "1") {
        notifyWorkspaceChange({ owner, userId, path: relPath, op: "delete" });
      }

      writeJson(res, 200, { deleted: existed, path: relPath }, ctx.requestId);
    }
  },
  {
    // Force-flush a user's LIVE sandbox FS → S3 and AWAIT it. Called at turn end
    // so the file panel reflects everything the agent wrote before it refetches
    // — the per-write sandbox→S3 sync is otherwise fire-and-forget and races the
    // turn's busy→idle flip. No-op (200) when S3 is off or there's no live
    // sandbox (direct-S3 writes already land synchronously).
    method: "POST",
    pattern: /^\/v1\/users\/(?<userId>[^/]+)\/workspace\/sync\/?$/,
    handler: async (req, res, ctx) => {
      const userId = ctx.params.userId;
      if (!userId) throw new SandboxError("invalid_request", "userId required", 400);
      if (!config.workspace?.userS3Enabled) {
        writeJson(res, 200, { synced: false, reason: "s3_disabled" }, ctx.requestId);
        return;
      }
      const { owner } = resolveWorkspaceOwner(req, userId);
      const sandbox = findUserSandbox(userId, owner);
      if (!sandbox || sandbox.workspaceMode !== "user") {
        writeJson(res, 200, { synced: false, reason: "no_live_sandbox" }, ctx.requestId);
        return;
      }
      // No-op flush under FUSE: `/workspace` is a weed-mount of the S3 store,
      // so every shell/script write is already durable in S3 — there is nothing
      // to flush sandbox→S3. Kept as a 200 (not 404) so the app's flush button
      // and the legacy manual-sync callers keep working. (Removed:
      // syncSandboxToUser — see docs/plan-remove-stub-subsystem.md.)
      writeJson(res, 200, {
        synced: true, uploaded: 0, deleted: 0, skipped: [], reason: "live_workspace_noop",
      }, ctx.requestId);
    }
  },
  {
    // Per-user workspace folder create — adds an explicit { kind: "dir" }
    // manifest entry so an empty folder shows in the rail tree (directories are
    // otherwise only implied by file paths). No sandbox required, pre-session.
    method: "POST",
    pattern: /^\/v1\/users\/(?<userId>[^/]+)\/workspace\/folder\/?$/,
    handler: async (req, res, ctx) => {
      const userId = ctx.params.userId;
      if (!userId) throw new SandboxError("invalid_request", "userId required", 400);
      if (!config.workspace?.userS3Enabled) {
        throw new SandboxError("not_applicable", "per-user workspace not enabled (AGENT_WORKSPACE_S3=0)", 400);
      }
      const { owner } = resolveWorkspaceOwner(req, userId);
      const relPath = toWorkspaceRelativePath(
        ctx.url.searchParams.get("path") || "",
        "/workspace",
        { allowEmpty: false, label: "path" },
      );
      const created = await updateManifest(owner, (manifest) => {
        manifest.entries = manifest.entries || {};
        const existing = manifest.entries[relPath];
        if (existing && existing.kind !== "dir") {
          throw new SandboxError("conflict", `a file already exists at ${relPath}`, 409);
        }
        // Already a dir — idempotent no-op. SKIP_WRITE rather than writing an
        // unchanged manifest, so a mkdir of an existing folder costs no PUT and
        // cannot lose a race it has no reason to enter.
        if (existing) return SKIP_WRITE;
        manifest.entries[relPath] = { kind: "dir", mtimeMs: Date.now() };
        return true;
      });
      // Note: in a live (FUSE/weed-mount) workspace the panel lists ACTUAL S3
      // objects, but listWorkspaceManifest now merges the index's `kind:"dir"`
      // entries (written above) back in, so this empty folder surfaces without
      // needing a placeholder object on S3.
      const didCreate = created === true;
      if (didCreate) notifyWorkspaceChange({ owner, userId, path: relPath, op: "mkdir" });
      writeJson(res, 200, { created: didCreate, path: relPath, kind: "dir" }, ctx.requestId);
    }
  },
  {
    // Per-user workspace folder delete — recursively drops the dir entry and
    // everything under `${relPath}/`. Same posture as the file delete: manifest
    // is the source of truth (blobs left for GC); live sandbox mirrored best-effort.
    method: "DELETE",
    pattern: /^\/v1\/users\/(?<userId>[^/]+)\/workspace\/folder\/?$/,
    handler: async (req, res, ctx) => {
      const userId = ctx.params.userId;
      if (!userId) throw new SandboxError("invalid_request", "userId required", 400);
      if (!config.workspace?.userS3Enabled) {
        throw new SandboxError("not_applicable", "per-user workspace not enabled (AGENT_WORKSPACE_S3=0)", 400);
      }
      const { owner, isShared } = resolveWorkspaceOwner(req, userId);
      const relPath = toWorkspaceRelativePath(
        ctx.url.searchParams.get("path") || "",
        "/workspace",
        { allowEmpty: false, label: "path" },
      );
      // Data-safety guard (folder delete): same as the file route — a folder
      // delete is the MAIN way `.opencode` / `.unieai` would be wiped wholesale,
      // so block the system container dirs here too. `.opencode/skills/<name>`
      // (one skill) stays deletable for the skill manager.
      if (isSystemDeleteProtected(relPath)) {
        throw new SandboxError("protected_path",
          `"${relPath}" is a protected system folder and cannot be deleted. ` +
          `To remove a single skill or memory, delete its specific item instead.`, 403);
      }
      const prefix = `${relPath}/`;
      const underPrefix = (k) => k === relPath || k.startsWith(prefix);
      // Source of truth for WHAT to delete is the LIVE S3 listing, not the
      // `.manifest.json` index: under the weed-mount workspace a file the agent
      // created via the shell (python/`mv`/`curl -o`) lives in S3 but may never
      // have been written to the manifest, so a manifest-only enumeration would
      // leave it orphaned after a "delete folder". Union the two so both
      // panel-tracked and bash-created entries under the prefix are removed.
      const listed = await listWorkspaceManifest(owner).catch(() => null);
      const s3Keys = listed?.entries ? Object.keys(listed.entries).filter(underPrefix) : [];
      // Recomputed from the CURRENT baseline on every CAS attempt: a retry must
      // delete what is under the prefix NOW, not the set captured before a
      // concurrent upload added one more file beneath it.
      const manifestKeys = await updateManifest(owner, (manifest) => {
        manifest.entries = manifest.entries || {};
        const keys = Object.keys(manifest.entries).filter(underPrefix);
        if (!keys.length) return SKIP_WRITE;
        for (const k of keys) delete manifest.entries[k];
        return keys;
      });
      const removed = Array.from(new Set([...s3Keys, ...(Array.isArray(manifestKeys) ? manifestKeys : [])]));

      // Plain-tree: actually remove the S3 objects (not just the index entries),
      // symmetric with the single-file delete above. `/workspace` is a weed-mount
      // of S3, so deleting the object removes it from any live sandbox's view too
      // — no stub-index upkeep or sandbox mirror needed.
      for (const k of removed) {
        try { await deleteFile(owner, k); } catch { /* tolerate — index removal already hides it */ }
      }

      // Reverse-sync any deleted memory files to copilot-v2 (personal-only;
      // honor the skip header, symmetric with the file-delete + upload paths).
      if (!isShared && req.headers["x-skip-memory-sync"] !== "1") {
        for (const k of removed) notifyMemoryChange(userId, k, "delete");
      }
      // Same for any deleted skill files in this folder-delete (personal-only).
      if (!isShared && req.headers["x-skip-skill-sync"] !== "1") {
        const names = new Set();
        for (const k of removed) { const sn = skillNameOf(k); if (sn) names.add(sn); }
        for (const sn of names) notifySkillChange(userId, sn);
      }

      writeJson(res, 200, { deleted: removed.length, path: relPath }, ctx.requestId);
    }
  },
  {
    method: "POST",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/artifacts\/persist\/?$/,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      // The generic ownership block already proved the caller owns `:id`, but
      // persist takes the target userId from the BODY — so a caller could ask to
      // persist their own sandbox's artifacts under a VICTIM's user prefix. When
      // enforcing, require the body userId to match the caller (== sandbox owner).
      if (enforcing(req)) {
        const caller = resolveCallerUserId(req, ctx.auth?.claims);
        if (body?.user_id && caller !== String(body.user_id)) {
          throw new SandboxError("forbidden", "artifacts/persist ownership check failed", 403, {
            reason: "owner_mismatch",
          });
        }
      }
      const result = await persistArtifacts({
        sandboxId: ctx.params.id,
        userId: body?.user_id,
        sessionId: body?.session_id
      });
      writeJson(res, 200, result, ctx.requestId);
    }
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/sandboxes\/(?<id>[^/]+)\/?$/,
    // 後台「釋放這個沙盒」要跨租戶，所以這一條（**只有這一條**帶 id 的路）允許
    // 管理員 scope 略過 ownership。exec / files / snapshot 那些一律不開 —— 管理員
    // 該有的是「放掉」的權力，不是「進去別人的工作區翻東西」的權力。
    adminBypass: true,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req).catch(() => ({}));
      const keepWorkspace = body?.keep_workspace === true;
      clearBaseline(ctx.params.id);
      await releaseSandbox(ctx.params.id, { keepWorkspace, destroy: true });
      writeJson(res, 200, { released: true, sandbox_id: ctx.params.id }, ctx.requestId);
    }
  },
  {
    method: "GET",
    pattern: /^\/v1\/sessions\/(?<sessionId>[^/]+)\/sandbox\/?$/,
    handler: async (req, res, ctx) => {
      const entry = findSessionSandbox(ctx.params.sessionId);
      if (!entry) throw new SandboxError("not_found", `no sandbox for session ${ctx.params.sessionId}`, 404);
      writeJson(res, 200, sandboxLookupBody(entry), ctx.requestId);
    }
  },
  {
    // 「這個工作區擁有者現在那一台」—— 不配置，只找活著的。
    //
    // 2026-09-26 UAT 軌道 B1，D2：沙盒由引擎配置、登記在引擎自己的 `s_…` 底下，
    // app 拿對話的 `ses_…` 問上面那一條永遠 404，所以審閱面板、每一輪前後的快照
    // 全都以為「沒有活的沙盒」。user 模式是一個擁有者一台，這一條讓 app 在
    // 第一輪（引擎還沒有 session）也找得到它。擁有者從 `x-workspace-owner` 來，
    // 跟 workspace/sync 同一套；ownership 由通用那一段以 path 的 userId 檢查。
    method: "GET",
    pattern: /^\/v1\/users\/(?<userId>[^/]+)\/sandbox\/?$/,
    handler: async (req, res, ctx) => {
      const { owner } = resolveWorkspaceOwner(req, ctx.params.userId);
      const entry = findUserSandbox(ctx.params.userId, owner);
      if (!entry) throw new SandboxError("not_found", `no live sandbox for ${ctx.params.userId}`, 404);
      writeJson(res, 200, sandboxLookupBody(entry), ctx.requestId);
    }
  }
];

/**
 * 查詢一台活著的沙盒時回的形狀。`machine_kind` 讓呼叫端分得出雲端容器（null）
 * 與使用者自己的電腦（"local"／"ssh"）—— 後者上面的 `git add -A` 是一次要他
 * 核准的寫入，雲端的快照／審閱不該碰它。
 */
function sandboxLookupBody(entry) {
  return {
    sandbox_id: entry.sandboxId,
    workspace_id: entry.workspaceId,
    status: entry.status,
    machine_kind: entry.machineKind || null,
  };
}

// Infer a route's tenant-ownership scope from its matched URL params. Returns
// the scope kind, or null for routes that target no specific user's resource
// (allocate, global list/stream, health/metrics).
function ownershipForRoute(params) {
  if (params?.userId) return "pathUser";
  if (params?.id) return "sandbox";
  if (params?.sessionId) return "session";
  return null;
}

function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(pathname);
    if (m) return { route, params: m.groups || {} };
  }
  return null;
}

async function handleRequest(req, res) {
  const requestId = getOrCreateRequestId(req);
  res.setHeader("x-request-id", requestId);
  let url;
  try {
    url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  } catch {
    return writeError(res, new SandboxError("bad_request", "Invalid request URL", 400), requestId);
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,x-sandbox-internal-token,x-request-id",
      "access-control-max-age": "600"
    });
    res.end();
    return;
  }

  const match = matchRoute(req.method || "GET", url.pathname);
  if (!match) {
    return writeError(res, new SandboxError("not_found", `${req.method} ${url.pathname} not found`, 404), requestId);
  }

  const { route, params } = match;
  let auth = { ok: true };
  if (route.requiresAuth !== false) {
    auth = verifyInternalToken(req);
    if (!auth.ok) {
      log("warn", "sandbox.auth_rejected", { requestId, reason: auth.reason, path: url.pathname });
      return writeError(res, new SandboxError("unauthorized", "Invalid or missing internal token", 401, { reason: auth.reason }), requestId);
    }

    // Caller namespaces (shared/callers.mjs). A namespaced caller is held to
    // its route allowlist and has every identity it presents rewritten into
    // its namespace before anything below reads it; the shared token may not
    // name an id inside someone else's namespace.
    try {
      if (auth.caller) {
        if (!isNamespacedRoute(url.pathname)) {
          throw new SandboxError("forbidden", `${req.method} ${url.pathname} is operator-only`, 403, { reason: "caller_route_forbidden" });
        }
        namespaceRequest(req, params, auth.caller);
        req.cacCaller = auth.caller;
        res.cacCaller = auth.caller;
      } else {
        assertLegacyIdentity({ req, params });
      }
      // A sandbox id from another caller reads as unknown (404), not forbidden:
      // a 403 would confirm that the id exists.
      if (params.id && url.pathname.startsWith("/v1/sandboxes/")) {
        let entry = null;
        try { entry = getActive(params.id); } catch { /* unknown: the handler answers 404 */ }
        if (entry && !callerOwnsEntry(req.cacCaller, entry)) {
          throw new SandboxError("not_found", `sandbox ${params.id} not found`, 404);
        }
      }
    } catch (err) {
      log("warn", "sandbox.caller_rejected", { requestId, path: url.pathname, caller: auth.caller?.id || "shared", reason: err?.details?.reason || err?.code });
      return writeError(res, err, requestId);
    }

    // Cross-tenant ownership backstop. The internal token only proves the
    // caller is the engine; it does NOT prove WHICH user they act for. Derive
    // the targeted resource's scope from the route's URL params and require the
    // caller's asserted identity (signed JWT claim or x-sandbox-user-id header)
    // to own it. Scope is inferred from the named regex groups so we don't have
    // to annotate every route:
    //   · params.userId    → /v1/users/:userId/*      (owner = path userId)
    //   · params.id        → /v1/sandboxes/:id/*       (owner = sandbox's userId)
    //   · params.sessionId → /v1/sessions/:id/sandbox  (owner = session sandbox's userId)
    // Unscoped routes (allocate, global list, stream, health) skip this.
    // route.adminBypass 是逐條白名單（目前只有 DELETE /v1/sandboxes/:id）：後台
    // 要能釋放**別人的**沙盒，但不該因此能 exec 或讀別人的檔案。所以不是「管理員
    // 一路綠燈」，而是「這一條路允許管理員」。
    const ownerCheck = route.adminBypass && resolveCallerIsPlatformAdmin(req) ? null : ownershipForRoute(params);
    if (ownerCheck) {
      const caller = resolveCallerUserId(req, auth.claims);
      let owner = null;
      let resourceExists = true;
      try {
        if (ownerCheck === "pathUser") owner = params.userId || null;
        // A userId-less (ephemeral) sandbox has owner=null → denied under
        // enforcement (can't prove ownership). The live agent-next path always
        // allocates workspace_mode:"user" with a real user_id, so this only
        // bites bare ephemeral allocations — intentional for untrusted cloud.
        else if (ownerCheck === "sandbox") owner = getActive(params.id)?.userId || null;
        else if (ownerCheck === "session") {
          const entry = findSessionSandbox(params.sessionId);
          if (!entry) resourceExists = false;
          else owner = entry.userId || null;
        }
      } catch (err) {
        // Unknown sandbox/session → let the handler return its own 404 instead
        // of a misleading 403 (getActive throws 404 for unknown ids).
        if (Number(err?.status) === 404) resourceExists = false;
        else throw err;
      }

      if (resourceExists) {
        const mismatch = !caller || owner !== caller;
        if (enforcing(req)) {
          if (mismatch) {
            log("warn", "sandbox.ownership_denied", {
              requestId, path: url.pathname, scope: ownerCheck,
              caller: caller || null, owner: owner || null,
            });
            return writeError(
              res,
              new SandboxError("forbidden", "sandbox ownership check failed", 403, {
                reason: caller ? "owner_mismatch" : "caller_identity_required",
              }),
              requestId,
            );
          }
        } else if (caller && owner && owner !== caller) {
          // Warn-only telemetry so operators can confirm callers thread
          // identity correctly BEFORE flipping SANDBOX_ENFORCE_OWNERSHIP=1.
          log("warn", "sandbox.ownership_mismatch", {
            requestId, path: url.pathname, scope: ownerCheck, caller, owner,
          });
        }
      }
    }
  }

  const ctx = { requestId, params, url, auth };
  try {
    await route.handler(req, res, ctx);
  } catch (err) {
    // A 404 (e.g. codex probing for optional AGENTS.md/CLAUDE.md instruction
    // files) is an expected client-level outcome, not a server fault — log it
    // at debug so the real handler faults stay visible at error level.
    const status = Number(err?.status) || 500;
    const level = err?.code === "not_found" || (status >= 400 && status < 500) ? "debug" : "error";
    log(level, "sandbox.handler_error", {
      requestId,
      path: url.pathname,
      code: err?.code || "internal_error",
      message: err?.message || String(err)
    });
    if (!res.headersSent) writeError(res, err, requestId);
    else if (!res.writableEnded) res.end();
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    log("error", "sandbox.unhandled", { message: err?.message || String(err) });
    if (!res.writableEnded) {
      try { res.end(); } catch { /* noop */ }
    }
  });
});

/**
 * Fail-closed boot guard on the execution backend. The default SANDBOX_MODE is
 * "docker" (weed-mount FUSE isolation). This guard refuses to start if an
 * operator has somehow selected a NON-isolated mode under multi-tenant
 * enforcement — a backstop kept after the zero-isolation "stub" backend was
 * removed (docs/plan-remove-stub-subsystem.md), so an unknown/misconfigured
 * SANDBOX_MODE can never silently downgrade isolation in an untrusted cloud.
 *
 *   · SANDBOX_REQUIRE_MODE=cube[,docker]  — explicit operator allowlist; boot
 *     fails unless the running mode is one of the listed backends.
 *   · SANDBOX_ENFORCE_OWNERSHIP=1 + non-isolated mode — incoherent; refuse.
 *   · any non-isolated mode               — loud warning.
 */
function assertSandboxModeSafe() {
  const mode = config.mode;
  const ISOLATED = new Set(["docker", "cube"]);

  const requireRaw = String(process.env.SANDBOX_REQUIRE_MODE || "").trim();
  if (requireRaw) {
    const allow = requireRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (allow.length && !allow.includes(mode)) {
      log("error", "sandbox.mode_assertion_failed", { mode, required: allow });
      throw new Error(
        `Refusing to start: SANDBOX_MODE="${mode}" is not in the required set ` +
        `[${allow.join(", ")}] (SANDBOX_REQUIRE_MODE).`,
      );
    }
  }

  if (config.enforceOwnership && !ISOLATED.has(mode)) {
    log("error", "sandbox.insecure_mode", { mode, enforceOwnership: true });
    throw new Error(
      `Refusing to start: SANDBOX_ENFORCE_OWNERSHIP=1 (untrusted multi-tenant) ` +
      `requires a real isolation backend, but SANDBOX_MODE="${mode}" provides none ` +
      `(host-process exec). Set SANDBOX_MODE=cube (recommended) or docker.`,
    );
  }

  if (!ISOLATED.has(mode)) {
    log("warn", "sandbox.stub_mode_insecure", {
      mode,
      message:
        "SANDBOX_MODE provides NO isolation (host-process exec) — dev / single trusted " +
        "user only. NEVER run untrusted multi-tenant on this. Use SANDBOX_MODE=cube in cloud.",
    });
  }
}

// Importing the real HTTP handlers must not reap another runtime's containers
// or modify shared filer quotas. Standalone production startup keeps all jobs.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
try {
  assertSandboxModeSafe();
} catch (err) {
  log("error", "sandbox.boot_aborted", { message: err?.message || String(err) });
  process.exit(1);
}

startReaper();

// Boot-time orphan reap (docker mode): containers from a previous
// sandbox-runtime process are unreachable (the pool map died with it) but keep
// consuming host RAM — kill them now. Fire-and-forget; the workspace itself is
// durable in S3 so nothing user-visible is lost.
if (config.mode === "docker") {
  import("./cube/docker.mjs")
    .then(({ reapOrphanContainers }) => reapOrphanContainers())
    .catch((err) => log("warn", "sandbox.orphan_reap_skipped", { error: err?.message || String(err) }));

  // Host-mount mode only: clear the mounts a previous process left behind.
  // This is NOT cosmetic. A weed process that died with its host leaves its
  // `fuse.seaweedfs` line in /proc/mounts while every syscall against the path
  // returns ENOTCONN, and a container bind-mounted onto that path sees "Socket
  // not connected" — an empty, broken /workspace with no error at allocate
  // time. reconcile() probes each mount for liveness (not just presence) and
  // unmounts the corpses so the next allocate mounts cleanly.
  import("./cube/index.mjs")
    .then(async ({ getHostMountManager }) => {
      const hostMount = getHostMountManager();
      if (!hostMount) return;
      const result = await hostMount.reconcile();
      log("info", "sandbox.host_mount_reconciled", {
        adopted: result.adopted.length,
        staleUnmounted: result.staleUnmounted.length,
        removedDirs: result.removedDirs.length,
        errors: result.errors.length,
      });
    })
    .catch((err) => log("warn", "sandbox.host_mount_reconcile_failed", { error: err?.message || String(err) }));

  // Pin the sandbox image against kubelet's own garbage collector, then keep
  // re-checking hourly. 2026-09-26/27: this host's k3s runs `--docker`, so
  // kubelet's image GC manages the SAME docker image store this process
  // creates sandboxes from — and under disk pressure it removed
  // `cm-agent-sandbox:weed-mount` outright, which every sandbox and the
  // filer-exposure probe depend on. See cube/image-pin.mjs for the full
  // incident and the fix (one throwaway, never-started container that holds
  // a reference Docker will not let a non-forced `rmi` break). Boot AND
  // hourly, same as the orphan reap above: a rebuild between deploys must be
  // caught without waiting for the next restart.
  import("./cube/image-pin.mjs")
    .then(({ ensureImagePin, startImagePinReconciler }) => {
      ensureImagePin().catch((err) => log("warn", "sandbox.image_pin_failed", { error: err?.message || String(err) }));
      startImagePinReconciler();
    })
    .catch((err) => log("warn", "sandbox.image_pin_boot_skipped", { error: err?.message || String(err) }));
}
const execGcTimer = setInterval(() => {
  gcFinishedExecs();
  gcExitedProcesses();
}, 5 * 60 * 1000);
execGcTimer.unref?.();

server.listen(config.port, "0.0.0.0", () => {
  // Print the workspace-persistence flag at startup so an operator
  // can read one line to know whether AGENT_WORKSPACE_S3 was picked
  // up (the most common "uploads vanish across sessions" cause is
  // this flag silently being false because the env var wasn't in
  // scope when the process started).
  // 空間上限的 filer 強制器：只在有個人 S3 工作區時有意義；啟動後立刻對帳一次（見 quota/enforcer.mjs 檔頭）。
  if (config.workspace?.userS3Enabled) {
    try { startQuotaEnforcer({ log }); } catch (err) { log("warn", "quota.enforcer_start_failed", { error: err?.message || String(err) }); }
  }
  log("info", "sandbox.listening", {
    port: config.port,
    mode: config.mode,
    userS3Enabled: Boolean(config.workspace?.userS3Enabled),
    enforceOwnership: Boolean(config.enforceOwnership),
  });
  // Verify memory reverse-sync auth up front — a token mismatch otherwise causes
  // silent memory loss (every callback 401s, then staging prunes). Loud on fail.
  void probeMemorySync();
  void probeSkillSync();
});

server.on("error", (err) => {
  log("error", "sandbox.server_error", { message: err?.message || String(err) });
});

function shutdown(signal) {
  log("info", "sandbox.shutdown", { signal });
  stopReaper();
  clearInterval(execGcTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

}

// matchRoute is exported for tests that must prove a route exists before
// asserting it is refused (a missing route answers 404 for every caller).
export { server, handleRequest, assertSandboxModeSafe, matchRoute };
