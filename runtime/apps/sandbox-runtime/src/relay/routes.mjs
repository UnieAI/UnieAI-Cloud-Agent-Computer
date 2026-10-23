import { parseHarnessCall, HARNESS_READ_ACTIONS } from "../../../../packages/ava-local-protocol/src/native-harness.mjs";
/**
 * relay/routes.mjs — the daemon-facing side of the Rabi Local relay.
 *
 * The daemon never talks to sandbox-runtime directly: it dials the app
 * (`/api/machines/relay/*`), which verifies its device token and proxies here
 * with the internal token plus `x-machine-id` / `x-machine-user-id`. So by the
 * time a request lands in this file, "which machine" is a fact the app has
 * already vouched for, and the only questions left are protocol ones.
 *
 *   GET  /v1/relay/connect                 SSE down: ready → ping… → invoke… → revoke
 *   POST /v1/relay/hello                   { machine, ops }             (409 before connect)
 *   POST /v1/relay/result                  { id, ok, output, partial? }  (404 unknown id)
 *   GET  /v1/relay/machines/:machineId/status
 *   POST /v1/relay/machines/:machineId/revoke   { reason? }
 *
 * Frames on the SSE stream are `event: <type>` + `data: <json frame>`, the
 * frame being exactly what @unieai/ava-local-protocol's parseFrame accepts.
 */

import { SandboxError } from "../shared/error.mjs";
import { log } from "../shared/log.mjs";
import { writeSseHeaders, writeSseEvent, closeSse } from "../shared/sse.mjs";
import { releaseMachineSandboxes } from "../pool/manager.mjs";
import { forgetMachineCredentials } from "../cube/index.mjs";
import { PROTOCOL_VERSION } from "../../../../packages/ava-local-protocol/src/protocol.mjs";
import {
  registerMachineConnection,
  setMachineInfo,
  getMachineConnection,
  resolveInvocation,
  closeConnection,
  revokeMachine,
  touchMachine,
  invoke,
} from "./registry.mjs";
import { GIT_READS, gitReadCommand } from "./git-read.mjs";
import { redactedWriteRefusal } from "../../../../packages/ava-local-protocol/src/redaction.mjs";
import { parsePluginManagementCall, READ_ONLY_PLUGIN_ACTIONS } from "../../../../packages/ava-local-protocol/src/plugin-management.mjs";

import { parseBrowserSetup } from "../../../../packages/ava-local-protocol/src/browser-setup.mjs";

const PING_INTERVAL_MS = 15_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024; // a writeFile result carries no content, a readFile result does

function header(req, name) {
  const v = req.headers?.[name];
  return String(Array.isArray(v) ? v[0] : v || "").trim();
}

function requireMachineId(req) {
  const id = header(req, "x-machine-id");
  if (!id) throw new SandboxError("bad_request", "x-machine-id header is required", 400);
  return id;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new SandboxError("payload_too_large", "relay body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new SandboxError("bad_request", "relay body must be JSON", 400));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, body, requestId) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-request-id": requestId || "",
  });
  res.end(payload);
}

export async function handleRelayConnect(req, res, ctx = {}) {
  const machineId = requireMachineId(req);
  const userId = header(req, "x-machine-user-id") || null;

  writeSseHeaders(res, { "x-request-id": ctx.requestId || "" });
  const send = (frame) => writeSseEvent(res, { event: frame?.type || "message", data: { v: PROTOCOL_VERSION, ...frame } });

  const conn = registerMachineConnection({ machineId, userId, send });
  send({ type: "ready", connId: conn.id });

  const ping = setInterval(() => send({ type: "ping", ts: Date.now() }), PING_INTERVAL_MS);
  ping.unref?.();

  let torn = false;
  const teardown = (reason) => {
    if (torn) return;
    torn = true;
    clearInterval(ping);
    closeConnection(conn, reason);
    closeSse(res);
  };
  req.on("close", () => teardown("client closed"));
  req.on("error", () => teardown("client error"));
  res.on("close", () => teardown("stream closed"));
  // A revoke closes the connection from the registry side; end the response too.
  const origSend = conn.send;
  conn.send = (frame) => {
    origSend(frame);
    if (frame?.type === "revoke") setImmediate(() => teardown("revoked"));
  };
}

/** 一次 hello 最多對帳幾個終端機（一台電腦同時最多 4 個，這個上限只是防亂送）。 */
const HELLO_TERMINALS_MAX = 64;

export async function handleRelayHello(req, res, ctx = {}) {
  const machineId = requireMachineId(req);
  const body = await readJson(req);
  const machine = body?.machine && typeof body.machine === "object" ? body.machine : null;
  const ops = Array.isArray(body?.ops) ? body.ops : null;
  if (!machine || !ops) throw new SandboxError("bad_request", "hello needs { machine, ops }", 400);
  const conn = getMachineConnection(machineId);
  if (!conn) {
    return json(res, 409, { error: { code: "machine_not_connected", message: "open /v1/relay/connect before hello" } }, ctx.requestId);
  }
  setMachineInfo(conn, machine, ops);
  const reply = { ok: true, connId: conn.id };
  // 終端機對帳。daemon 報「我手上還有這些終端機」（id ＝ terminalOpen 那個 invoke 的 id），伺服器答
  // 「哪些我不認得」＝不在這條連線 pending 表裡的。連線一斷所有 pending 都已結算，所以 sandbox-runtime
  // 重啟、daemon 重連之後，舊的終端機網頁不可能再接回；daemon 據此收掉那些孤兒。
  // 沒帶、或不是陣列 → 完全不回這個欄位（舊 daemon 不受影響；新 daemon 看不到欄位就什麼都不關）。
  if (Array.isArray(body?.terminals)) {
    const ids = [...new Set(body.terminals.filter((t) => typeof t === "string" && t.length > 0 && t.length <= 128))].slice(0, HELLO_TERMINALS_MAX);
    reply.unknownTerminals = ids.filter((id) => !conn.pending.has(id));
  }
  return json(res, 200, reply, ctx.requestId);
}

export async function handleRelayResult(req, res, ctx = {}) {
  const machineId = requireMachineId(req);
  const body = await readJson(req);
  if (typeof body?.id !== "string" || !body.id || typeof body?.ok !== "boolean") {
    throw new SandboxError("bad_request", "result needs { id, ok, output }", 400);
  }
  touchMachine(machineId);
  const found = resolveInvocation({ machineId, id: body.id, ok: body.ok, output: body.output, partial: !!body.partial });
  if (!found) {
    return json(res, 404, { error: { code: "unknown_invocation", message: `no pending invocation ${body.id} for this machine` } }, ctx.requestId);
  }
  return json(res, 200, { ok: true }, ctx.requestId);
}

export async function handleRelayStatus(req, res, ctx = {}) {
  const conn = getMachineConnection(ctx.params?.machineId);
  return json(res, 200, {
    // An open SSE transport is not selectable until hello supplies capabilities.
    online: !!conn && conn.info !== null,
    connectedAt: conn?.connectedAt ?? null,
    lastSeenAt: conn?.lastSeenAt ?? null,
    info: conn?.info ?? null,
    ops: conn?.ops ?? [],
    pending: conn?.pending.size ?? 0,
  }, ctx.requestId);
}

/** Reads need nothing. This door was originally for these three only. */
const READ_OPS = ["readFile", "readFileBytes", "statFile", "listFiles"];

/**
 * Writes that this door will carry — but ONLY with an approval token attached.
 *
 * The file panel and the upload button work on whichever machine the composer
 * is pointed at (lib/machines/workspace-bridge.ts), and there is no sandbox
 * behind them, so they arrive here. Refusing every write would mean a user
 * cannot put a file on their own computer through a UI they drove themselves.
 *
 * Requiring the token is what keeps the boundary honest: this process does not
 * decide the write is allowed and cannot make it so. The token is minted by the
 * app with the machine's own key, bound to the machine, the tool and a hash of
 * the payload, and it is VERIFIED ON THE DEVICE. A forged or absent token is
 * refused there. So the rule here is a cheap early "no", not the enforcement —
 * the enforcement never left the user's machine.
 */
const APPROVED_WRITE_OPS = ["writeFile", "ensureDir", "deleteFile"];

/**
 * 大檔上傳的分段（ava-local 0.2.19，file-pages.ts）。**不要票，而且要不到**：
 * 核准綁的是整個檔案的雜湊，一段一段的時候還沒有那個雜湊。這不是開了一扇
 * 寫入的門 —— 分段只進 daemon 自己的暫存資料夾（不在授權資料夾裡，有大小、
 * 數量、閒置時限），要落地還是得靠 `writeFile { stagedId }`，而那一個照上面
 * 的規矩要票，票在使用者的機器上驗。
 */
const STAGING_OPS = ["writeFileChunk"];

/**
 * 自動更新：問版本、問進度、叫它更新。
 *
 * 不要核准票，因為票擋不住這件事裡真正危險的部分，而簽章擋得住：daemon 只
 * 安裝 UnieAI release 私鑰簽過的檔案（ava-local/src/release-verify.ts），而
 * 那把私鑰不在任何一台跑 app 的機器上。所以這扇門能做的最壞的事，是叫一台
 * 電腦去裝一個我們自己發布過的版本。
 */
const UPDATE_OPS = ["updateCheck", "updateApply", "updateStatus"];

/**
 * 本機 MCP 的兩個 op —— 這扇門**不替它們判斷要不要票**。
 *
 * 為什麼不比照 APPROVED_WRITE_OPS 一律要票：一個第三方 MCP server 上哪些工具
 * 會改東西，只有**使用者自己**知道（他在自己電腦上的授權檔裡把幾個列成唯讀，
 * 見 runtime/apps/ava-local/src/mcp-grants.ts）。這個行程看不到那份授權檔，
 * 在這裡硬性要票等於把他已經說過是唯讀的那幾個也擋掉，畫面上會變成一顆
 * 永遠按不完的允許鍵。
 *
 * 這扇門本來就只是一個便宜的「早一點說不」，**真正的把關從來沒有離開過使用者
 * 的機器**（上面 APPROVED_WRITE_OPS 那段已經說過同一句）。mcpCall 在 daemon
 * 那一端：沒有票、又不在使用者親手列的唯讀清單裡，它自己就不跑。mcpList 唯讀。
 */
const MCP_OPS = ["mcpList", "mcpCall"];

/**
 * 裝置簽的核准，它的兩個管理 op。
 *
 * **不要票，而且不可能要**：`deviceEnroll` 本身就是「加一把可以簽票的金鑰」，
 * 拿 HMAC 票去守它等於說「app 說可以就可以」—— 那正是這條路要消滅的東西。
 * 真正的把關在使用者的機器上：`verifyEnrollment` 要嘛看到一把**已經被信任的**
 * 金鑰簽過這次請求，要嘛這台機器一把都還沒有。這個行程做什麼都改變不了那件事，
 * 連 enrollment 那一串都改不了 —— 改一個位元，簽章就對不上。
 *
 * `deviceList` 唯讀，而且裡面沒有秘密（公鑰與 credentialId）。
 */
// machineSelect issues a challenge or verifies its device signature locally;
// it cannot execute tools or grant an execution bypass.
const DEVICE_OPS = ["deviceList", "deviceEnroll", "machineSelect", "sessionAuthorize"];

/**
 * 地端外掛清單：這台機器、這個模式的本機代理會掛哪些 DSH 外掛。唯讀 ——
 * daemon 只讓它自己的 DSH 印出組好的樹（`--dump-config`），不起代理、不碰
 * 授權資料夾 —— 所以跟 READ_OPS 一樣不需要票。
 */
const AGENT_READ_OPS = ["pluginInventory"];

/**
 * POST /v1/relay/machines/:machineId/invoke — one ad-hoc operation without a
 * sandbox. Used by the pairing wizard's folder browser and by the file panel /
 * upload path once a machine is the active workspace.
 */
export async function handleRelayInvoke(req, res, ctx = {}) {
  const body = await readJson(req);
  const op = String(body?.op || "");
  const approval = typeof body?.approval === "string" && body.approval ? body.approval : null;
  if (op === "nativeHarness") {
    let call;
    try { call = parseHarnessCall(body?.args?.call); }
    catch { throw new SandboxError("bad_request", "Invalid native harness request", 400); }
    if (!HARNESS_READ_ACTIONS.includes(call.action) && !approval) throw new SandboxError("bad_request", "Native harness action needs approval", 400);
    const result = await invoke({ machineId: ctx.params?.machineId, op, args: { call, rabiToken: body?.args?.rabiToken },
      approval: approval ?? undefined, timeoutMs: 60000 });
    return json(res, 200, { ok: result.ok, output: result.output }, ctx.requestId);
  }
  if (op === "browserSetup") {
    let call;
    try { call = parseBrowserSetup(body?.args?.call); }
    catch (error) { throw new SandboxError("bad_request", String(error.message), 400); }
    if (call.action === "setup" && !approval) {
      throw new SandboxError("bad_request", "Browser preparation needs an approval token", 400);
    }
    const limit = call.action === "setup" ? 540_000 : 15_000;
    const result = await invoke({ machineId: ctx.params?.machineId, op, args: { call }, approval: approval ?? undefined,
      timeoutMs: Math.max(1, Math.min(Number(body?.timeoutMs) || limit, limit)) });
    return json(res, 200, { ok: result.ok, output: result.output }, ctx.requestId);
  }
  if (op === "pluginManage") {
    let call;
    try { call = parsePluginManagementCall(body?.args?.call); }
    catch (error) { throw new SandboxError("bad_request", String(error.message), 400); }
    if (!READ_ONLY_PLUGIN_ACTIONS.includes(call.action) && !approval) {
      throw new SandboxError("bad_request", "Plugin changes need an approval token", 400);
    }
    const result = await invoke({ machineId: ctx.params?.machineId, op, args: { call }, approval: approval ?? undefined,
      timeoutMs: Math.min(Number(body?.timeoutMs) || 60_000, call.action === "install" ? 900_000 : 60_000) });
    return json(res, 200, { ok: result.ok, output: result.output }, ctx.requestId);
  }

  // 「檢閱」要問那個資料夾跟 HEAD 差什麼 —— 那需要跑 git，而這扇門刻意不開
  // `exec`（開了等於 app 這一層可以在使用者的筆電上跑任意指令）。所以它收的是
  // **意圖**，指令由 `gitReadCommand` 在伺服器端組出來，呼叫端插不進任何字元。
  // 白名單全是唯讀 git 子指令；daemon 那邊還會自己分級一次，cwd 與 path 也還要
  // 過它的 containPath。細節與理由見 relay/git-read.mjs 的檔頭。
  if (op === "gitRead") {
    const args = body?.args && typeof body.args === "object" ? body.args : {};
    const command = gitReadCommand(args.cmd, args.path);
    if (!command) {
      throw new SandboxError("bad_request", `gitRead only does: ${GIT_READS.join(", ")}`, 400);
    }
    const out = { stdout: "", stderr: "" };
    const r = await invoke({
      machineId: ctx.params?.machineId,
      op: "exec",
      args: {
        kind: "bash",
        command,
        // 指令要以 `git status` 開頭（不是 `git -C …`），否則 daemon 的分級器
        // 認不出它是唯讀的，每一次檢閱都會在使用者畫面上跳一張核准卡。
        cwd: typeof args.cwd === "string" && args.cwd ? args.cwd : undefined,
        env: {},
        stdin: null,
        sandbox: false,
      },
      timeoutMs: Math.min(Number(body?.timeoutMs) || 15_000, 60_000),
      // 輸出是分段送回來的（stdout/stderr 各自是 partial frame）。
      onEvent: (ev) => {
        if (ev?.stream === "stdout") out.stdout += String(ev.data ?? "");
        else if (ev?.stream === "stderr") out.stderr += String(ev.data ?? "");
      },
    });
    const exit = r.output?.exit || {};
    return json(res, 200, {
      ok: r.ok && (exit.code === 0 || exit.code === undefined),
      output: { stdout: out.stdout, stderr: out.stderr, exitCode: exit.code ?? null, ...(r.ok ? {} : { error: r.output?.error }) },
    }, ctx.requestId);
  }

  if (!READ_OPS.includes(op) && !UPDATE_OPS.includes(op) && !MCP_OPS.includes(op) && !DEVICE_OPS.includes(op) && !AGENT_READ_OPS.includes(op) && !STAGING_OPS.includes(op)) {
    if (!APPROVED_WRITE_OPS.includes(op)) {
      throw new SandboxError("bad_request", `ad-hoc invoke does not allow "${op}"`, 400);
    }
    if (!approval) {
      throw new SandboxError("bad_request", `"${op}" through this door needs an approval token`, 400);
    }
  }

  // 遮蔽記號不准寫回去（protocol/redaction.mjs）：檔案面板存的是遮蔽後的內容，
  // 照寫就會把電腦上真正的祕密換成 `[redacted:…]`（2026-09-26 UAT，P0）。
  // 分段的記號可能跨兩段 —— 那一種由 daemon 在 commit 時對整個暫存檔再掃一次。
  if (op === "writeFile" || op === "writeFileChunk") {
    const field = op === "writeFile" ? body?.args?.contentBase64 : body?.args?.dataBase64;
    const refusal = redactedWriteRefusal(Buffer.from(String(field ?? ""), "base64"));
    if (refusal) throw new SandboxError(refusal.code, refusal.message, 409);
  }

  const r = await invoke({
    machineId: ctx.params?.machineId,
    op,
    args: body?.args && typeof body.args === "object" ? body.args : {},
    approval: approval ?? undefined,
    timeoutMs: Math.min(Number(body?.timeoutMs) || 15_000, 60_000),
  });
  return json(res, 200, { ok: r.ok, output: r.output }, ctx.requestId);
}

/**
 * POST /v1/relay/machines/:machineId/revoke — 這台機器被收回了。
 *
 * **這一支要做完整件事，不能只關連線。** 撤銷在 app 那一側是「DB 那一列停用」，
 * 而這個行程裡有三個地方還握著這台機器：
 *
 *   1. relay 的連線表（`revokeMachine` → 推一個 revoke frame 再關掉），
 *   2. sandbox 池裡指向它的登記列 —— 不清掉的話，**已經分派好**的 sandbox 會繼續
 *      服務一台已經被撤銷的機器，
 *   3. SSH 憑證簽發器的快取（`cube/ssh-ca.mjs` 的 `forget`，在此之前零個呼叫端）。
 *
 * 只做第 1 件的後果不是「多活一個憑證有效期」：`ensureCert` 過期會自己重簽，而且
 * 從不回頭問 DB，所以窗口的長度是「那筆登記還在多久」—— 而機器綁定的登記列在這次
 * 修改之前是**永遠**。三件一起做，撤銷才是即時的。
 *
 * 回傳把三件事分開報，因為呼叫端與維運必須看得出**哪一件**沒生效：一台離線的機器
 * `revoked` 本來就會是 false，那不代表撤銷失敗。
 */
export async function handleRelayRevoke(req, res, ctx = {}) {
  const body = await readJson(req).catch(() => ({}));
  const machineId = ctx.params?.machineId;
  const reason = typeof body?.reason === "string" ? body.reason : "revoked";
  const short = String(machineId || "").slice(0, 8);

  const revoked = revokeMachine(machineId, reason);

  // 池與憑證快取：一邊出錯不該擋掉另一邊，也不該擋掉回應本身 —— 撤銷是安全動作，
  // 「盡量多做成幾件」比「全有全無」正確。
  //
  // 放沙盒這件事**刻意不看 `revoked`**：一台沒有連線的機器照樣可能還佔著登記列，
  // 而那正是漏掉的那個案例。machine-bound 的登記列對兩個回收器都是豁免的
  // （它是指向使用者自己硬體的路由紀錄），所以它根本沒有期限 —— 除了這裡，
  // 沒有任何東西會把它拿掉，每一次 pair/revoke 都留下一列指向一台已經回不了話的機器。
  let released = [];
  try {
    ({ released } = await releaseMachineSandboxes(machineId, { reason: `revoked: ${reason}` }));
  } catch (err) {
    log("warn", "relay.revoke_release_failed", { machineId: short, message: err?.message || String(err) });
  }
  let forgot = { principals: [], sandboxes: [] };
  try {
    forgot = forgetMachineCredentials(machineId, {
      principal: typeof body?.principal === "string" && body.principal ? body.principal : null,
    });
  } catch (err) {
    log("warn", "relay.revoke_forget_failed", { machineId: short, message: err?.message || String(err) });
  }

  log("info", "relay.revoked", {
    machineId: short,
    reason,
    connectionClosed: revoked,
    sandboxesReleased: released.length,
    certPrincipalsForgotten: forgot.principals.length,
  });
  return json(res, 200, {
    revoked,
    sandboxes_released: released.length,
    cert_principals_forgotten: forgot.principals.length,
  }, ctx.requestId);
}

/** Route table entries for server.mjs (same shape as the rest of its `routes`). */
export const relayRoutes = [
  { method: "GET", pattern: /^\/v1\/relay\/connect\/?$/, handler: handleRelayConnect },
  { method: "POST", pattern: /^\/v1\/relay\/hello\/?$/, handler: handleRelayHello },
  { method: "POST", pattern: /^\/v1\/relay\/result\/?$/, handler: handleRelayResult },
  { method: "GET", pattern: /^\/v1\/relay\/machines\/(?<machineId>[^/]+)\/status\/?$/, handler: handleRelayStatus },
  { method: "POST", pattern: /^\/v1\/relay\/machines\/(?<machineId>[^/]+)\/revoke\/?$/, handler: handleRelayRevoke },
  { method: "POST", pattern: /^\/v1\/relay\/machines\/(?<machineId>[^/]+)\/invoke\/?$/, handler: handleRelayInvoke },
];
