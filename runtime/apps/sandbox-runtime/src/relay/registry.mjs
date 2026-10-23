/**
 * relay/registry.mjs — live Rabi Local connections and invoke/result correlation.
 *
 * Descended from llm-runtime's desktop-relay registry (salvaged in M0, see git
 * history for the userId-keyed original). Re-keyed by machineId because one
 * user may pair several machines and the sandbox, not the user, decides which
 * one a call goes to.
 *
 * Owns three things:
 *   · machineId -> live connection   (the downstream `send` channel + hello info)
 *   · invocation correlation         (invokeId -> pending promise, with
 *                                     streamed partial results for exec)
 *   · nothing about auth             (the app verifies the daemon's token and
 *                                     forwards machineId/userId as headers;
 *                                     sandbox-runtime trusts its internal token)
 *
 * TRANSPORT-AGNOSTIC: a connection is `{ send(frame) }`. routes.mjs wires it to
 * an SSE writer; a WebSocket upgrade could register the same shape.
 *
 * PROCESS-LOCAL by design: sandbox-runtime is a single service instance per
 * deployment, and every cube call for a machine lands here, so no Redis tier.
 */

import crypto from "node:crypto";

import { log } from "../shared/log.mjs";

const DEFAULT_INVOKE_TIMEOUT_MS = 120_000;

/**
 * 指令跑完之後，還要等多久才承認「輸出到齊了」。
 *
 * WHAT THE USER SAW (2026-09-06)。在自己的電腦上，**指令的輸出會隨機整段不見**：
 * `cat package.json` 回 exit 0 而輸出是空的、`stat <目錄>` 空的、
 * `ls -la <目錄> | head` 空的，而同一個目錄的第一個 `ls` 好好的。模型於是開始
 * 猜環境（「是不是沙箱路徑跟真實路徑不一致」），然後照著猜測繼續做事。
 * 在 roy-linux-box 上直接打這一層重現：連五次 `echo`，兩次 stdout 整個不見。
 *
 * WHY。daemon 把輸出與結果**分兩發獨立的 HTTP** 送回來
 * （`ava-local/src/transport.ts`）：
 *
 *   host.dispatch(frame, (p) => { void post("result", { partial: true, … }) })  ← 射後不理
 *   await post("result", { ok, output })                                        ← 立刻送、而且等它
 *
 * 兩發之間沒有任何順序保證，指令越快、結束那一發越容易超車。而下面的
 * `resolveInvocation` 一收到最終結果就把那筆 pending 刪掉 —— 晚到的輸出找不到
 * 歸屬，`if (!entry) return false`，安靜地掉了。
 *
 * WHAT THIS DOES。收到最終結果時，**帶著輸出串流的呼叫**（有 `onEvent` 的那些）
 * 不立刻結算，先留一個很短的窗給還在路上的輸出。窗內來的照原順序送出去
 * （不插隊、不重複），窗過了才結算。
 *
 * 這是**擋在伺服器這一端**的修法：真正的修在 daemon（把 partial 串成一條鏈，
 * 最終結果等鏈跑完再送），但那要每一個使用者重裝一次小程序。
 *
 * 代價是每一條有串流的指令多等這麼久。所以它要短 —— 只夠蓋住「同一時刻送出、
 * 但被連線排序打亂」的那幾毫秒，不是拿來等一個慢吞吞的行程。
 */
const OUTPUT_GRACE_MS = Number(process.env.AVA_RELAY_OUTPUT_GRACE_MS || 120);

/** 窗內又來了輸出就重新計時 —— 但總共不會超過這個上限。 */
const OUTPUT_GRACE_MAX_MS = Number(process.env.AVA_RELAY_OUTPUT_GRACE_MAX_MS || 1_000);

/** machineId -> connection */
const connections = new Map();

/** Model-facing structured error (same shape the old desktop relay used). */
export function structuredError(code, message, { retryable = false } = {}) {
  return {
    error: {
      code: String(code || "machine_error"),
      message: String(message || "The machine could not run this."),
      retryable,
    },
  };
}

/**
 * Register a live connection for a machine. Last connect wins: a laptop that
 * slept and reconnected must not be blocked by its own stale socket.
 */
export function registerMachineConnection({ machineId, userId, send }) {
  const mid = String(machineId || "").trim();
  if (!mid) throw new Error("registerMachineConnection: machineId required");
  if (typeof send !== "function") throw new Error("registerMachineConnection: send must be a function");

  const prev = connections.get(mid);
  if (prev && !prev.closed) {
    log("info", "relay.evict_previous", { machineId: mid.slice(0, 8), connId: prev.id.slice(0, 8) });
    closeConnection(prev, "superseded by a newer connection");
  }

  const conn = {
    id: crypto.randomUUID(),
    machineId: mid,
    userId: String(userId || "").trim() || null,
    send,
    info: null,
    ops: [],
    pending: new Map(), // invokeId -> { resolve, timer, timeoutMs, onEvent }
    closed: false,
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  connections.set(mid, conn);
  log("info", "relay.connected", { machineId: mid.slice(0, 8), connId: conn.id.slice(0, 8) });
  return conn;
}

/** The daemon's `hello`: what it is and which operations it serves. */
export function setMachineInfo(conn, info, ops) {
  if (!conn || conn.closed) return;
  conn.info = info && typeof info === "object" ? { ...info } : null;
  conn.ops = Array.isArray(ops) ? ops.map(String) : [];
  conn.lastSeenAt = Date.now();
  log("info", "relay.hello", {
    machineId: conn.machineId.slice(0, 8),
    platform: conn.info?.platform,
    daemonVersion: conn.info?.daemonVersion,
    // **截斷要說出來。** 這一行原本是 `conn.ops.slice(0, 12)` 而沒有任何標記,
    // 於是每一筆日誌都剛好 12 個 op、darwin 那批剛好結尾在 `terminalClose`
    // (`terminalReplay` 的前一個) —— 我因此差點報出「所有 Mac 都不支援終端機
    // 重播」這個不存在的缺陷。被截掉的那一段長得跟「這台機器沒有那個能力」
    // 一模一樣,而這兩件事的處理方式完全相反。
    opCount: conn.ops.length,
    ops: conn.ops.length > 12 ? [...conn.ops.slice(0, 12), `…+${conn.ops.length - 12} more`] : conn.ops,
  });
}

export function touchMachine(machineId) {
  const conn = connections.get(String(machineId || "").trim());
  if (conn && !conn.closed) conn.lastSeenAt = Date.now();
}

export function getMachineConnection(machineId) {
  const conn = connections.get(String(machineId || "").trim());
  return conn && !conn.closed ? conn : null;
}

export function isMachineOnline(machineId) {
  return getMachineConnection(machineId) !== null;
}

/**
 * 這台電腦上的 daemon 有沒有這個 op。
 *
 * **為什麼要在動手之前先問。** daemon 在 `hello` 裡就報了它服務哪些 op
 * （tool-host.ts 的 `ops: Object.keys(ops)`），所以「這個版本做不做得到」
 * 是一個**開口前**就知道的事實，不必先開一個終端機再從錯誤裡推。
 *
 * 這個差別對終端機特別重要：一個開起來但打不出字的黑框，使用者會一直打、
 * 一直等，然後以為是自己的電腦壞了。先問一句就能換成一句人看得懂的話
 *（「這台電腦上的 Rabi Local 版本還不支援終端機，請更新」）。
 *
 * 沒連線時回 false —— 呼叫端本來就要先處理離線，這裡不需要第三種答案。
 */
export function machineSupportsOp(machineId, op) {
  const conn = getMachineConnection(machineId);
  if (!conn) return false;
  return Array.isArray(conn.ops) && conn.ops.includes(String(op || ""));
}

/** 這台電腦報上來的 daemon 版本（沒有就 null）—— 錯誤訊息要說得出「舊到什麼程度」。 */
export function machineDaemonVersion(machineId) {
  return getMachineConnection(machineId)?.info?.daemonVersion ?? null;
}

export function listMachineConnections() {
  return [...connections.values()]
    .filter((c) => !c.closed)
    .map((c) => ({
      machineId: c.machineId,
      userId: c.userId,
      connId: c.id,
      connectedAt: c.connectedAt,
      lastSeenAt: c.lastSeenAt,
      info: c.info,
      pending: c.pending.size,
    }));
}

function armTimer(conn, invokeId, entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    conn.pending.delete(invokeId);
    entry.resolve({
      ok: false,
      output: structuredError(
        "machine_timeout",
        `The machine did not answer "${entry.op}" within ${entry.timeoutMs}ms.`,
        { retryable: true },
      ),
    });
  }, entry.timeoutMs);
}

/**
 * Push an operation to a machine and await its final result. NEVER rejects:
 * offline / timeout / transport failures come back as `{ ok:false, output:
 * { error } }` so the cube backend can turn them into a SandboxError with a
 * code the app already understands.
 *
 * `onEvent` receives partial results (exec stdout/stderr chunks) as they
 * arrive; each partial resets the idle timer, so a long-running command is
 * bounded by silence, not by total duration (the daemon enforces the hard
 * deadline it was given).
 */
export function invoke({ machineId, op, args, approval = null, timeoutMs = DEFAULT_INVOKE_TIMEOUT_MS, onEvent = null, invokeId: requestedId = null } = {}) {
  const conn = getMachineConnection(machineId);
  if (!conn) {
    return Promise.resolve({
      ok: false,
      output: structuredError("machine_offline", `This machine is not connected, so "${op}" cannot run.`),
    });
  }
  // The caller may name the invocation. It matters for anything the caller
  // needs to refer to LATER: the daemon registers a running child under this
  // frame's id (`running.set(frame.id, ...)`) and `cancel` looks it up by that
  // id, so a caller that cannot name the invocation cannot stop it. Minted here
  // when nobody asked, which is every call that is a single request/response.
  const invokeId = typeof requestedId === "string" && requestedId ? requestedId : crypto.randomUUID();
  const limit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_INVOKE_TIMEOUT_MS;

  return new Promise((resolve) => {
    const entry = { resolve, timer: null, timeoutMs: limit, op: String(op || ""), onEvent };
    conn.pending.set(invokeId, entry);
    armTimer(conn, invokeId, entry);
    const frame = { type: "invoke", id: invokeId, op: String(op || ""), args: args ?? {}, deadlineMs: limit };
    if (approval) frame.approval = approval;
    try {
      conn.send(frame);
    } catch (err) {
      conn.pending.delete(invokeId);
      clearTimeout(entry.timer);
      resolve({
        ok: false,
        output: structuredError("machine_send_failed", `Could not send "${op}" to the machine: ${err?.message || err}.`),
      });
    }
  });
}

/**
 * Deliver a daemon result. `partial: true` streams an event and keeps the
 * invocation open; anything else settles it. Unknown ids and ids that belong
 * to another machine are ignored (late, duplicate, or misrouted).
 */
export function resolveInvocation({ machineId, id, ok, output, partial = false }) {
  const conn = connections.get(String(machineId || "").trim());
  if (!conn) return false;
  const entry = conn.pending.get(id);
  if (!entry) {
    // **掉了一段輸出。** 這條路以前是靜靜地 return false，而那正是那個 bug 能活
    // 這麼久的原因：沒有任何一端會說出「我剛剛丟掉了使用者指令的輸出」。
    // 寬限窗已經關掉的晚到輸出走到這裡；留一行，數量看得出來就知道窗夠不夠短。
    if (partial && output?.stream) {
      log("warn", "relay.late_output_dropped", {
        machineId: conn.machineId.slice(0, 8),
        stream: String(output.stream),
        bytes: String(output.data ?? "").length,
      });
    }
    return false;
  }
  conn.lastSeenAt = Date.now();
  if (partial) {
    // 結算中又來了輸出 —— 這就是寬限窗在等的東西。照原順序送出去，然後重新計時
    // （總長有上限，見 OUTPUT_GRACE_MAX_MS）。
    if (entry.settling) {
      entry.settling.rescued += 1;
      deliverPartial(conn, entry, output);
      armGrace(conn, id, entry);
      return true;
    }
    armTimer(conn, id, entry);
    deliverPartial(conn, entry, output);
    return true;
  }
  // 已經在結算窗裡又收到一個最終結果（重送／重複）—— 認第一個就好。
  if (entry.settling) return true;
  clearTimeout(entry.timer);
  entry.timer = null;
  // **有輸出串流的呼叫先不結算。** 見 OUTPUT_GRACE_MS 的說明：daemon 的輸出與
  // 結果是兩發獨立的 HTTP，結果超車的時候輸出還在路上。沒有 `onEvent` 的呼叫
  // （檔案操作那些）沒有這個問題，立刻結算，不要無謂地多等。
  if (entry.onEvent && OUTPUT_GRACE_MS > 0) {
    entry.settling = { ok: ok !== false, output, startedAt: Date.now(), rescued: 0 };
    armGrace(conn, id, entry);
    return true;
  }
  conn.pending.delete(id);
  entry.resolve({ ok: ok !== false, output });
  return true;
}

/** 把一段輸出交給呼叫端。它自己爆掉不該連累這條連線。 */
function deliverPartial(conn, entry, output) {
  try {
    entry.onEvent?.(output ?? {});
  } catch (err) {
    log("warn", "relay.on_event_failed", { machineId: conn.machineId.slice(0, 8), message: err?.message });
  }
}

/** 結算窗：到時間就真的結算。窗內又有輸出就重新計時，但總長有上限。 */
function armGrace(conn, invokeId, entry) {
  if (entry.graceTimer) clearTimeout(entry.graceTimer);
  const elapsed = Date.now() - entry.settling.startedAt;
  const left = Math.max(0, Math.min(OUTPUT_GRACE_MS, OUTPUT_GRACE_MAX_MS - elapsed));
  entry.graceTimer = setTimeout(() => settleNow(conn, invokeId, entry), left);
}

/** 結算：把 pending 拆掉，把留著的最終結果交出去。 */
function settleNow(conn, invokeId, entry) {
  if (entry.graceTimer) clearTimeout(entry.graceTimer);
  entry.graceTimer = null;
  const settling = entry.settling;
  entry.settling = null;
  conn.pending.delete(invokeId);
  // 救回來過就講一聲。這一行是這個修法唯一的證據 —— 沒有它，下一個人只會看到
  // 「輸出有時候會不見」又從頭查一次。
  if (settling?.rescued > 0) {
    log("info", "relay.output_after_exit", {
      machineId: conn.machineId.slice(0, 8),
      op: entry.op,
      frames: settling.rescued,
      waitedMs: Date.now() - settling.startedAt,
    });
  }
  entry.resolve(settling ? { ok: settling.ok, output: settling.output } : { ok: true, output: {} });
}

/** Tear down a connection: fail every in-flight invocation, mark closed. */
export function closeConnection(conn, reason = "closed") {
  if (!conn || conn.closed) return;
  conn.closed = true;
  for (const [, entry] of conn.pending) {
    clearTimeout(entry.timer);
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    // 正在等輸出到齊的那些，**結果已經在手上了** —— 連線斷掉不該把它改寫成
    // 「機器斷線了」。那會把一條跑完的指令說成失敗，而使用者的檔案已經改了。
    if (entry.settling) {
      entry.resolve({ ok: entry.settling.ok, output: entry.settling.output });
      continue;
    }
    entry.resolve({
      ok: false,
      output: structuredError("machine_disconnected", `The machine disconnected before "${entry.op}" returned (${reason}).`, { retryable: true }),
    });
  }
  conn.pending.clear();
  if (connections.get(conn.machineId) === conn) connections.delete(conn.machineId);
  log("info", "relay.closed", { machineId: conn.machineId.slice(0, 8), connId: conn.id.slice(0, 8), reason });
}

/** Push a `revoke` frame and drop the connection (the app revoked the machine). */
export function revokeMachine(machineId, reason = "revoked") {
  const conn = getMachineConnection(machineId);
  if (!conn) return false;
  try {
    conn.send({ type: "revoke", reason });
  } catch {
    /* the close below is what matters */
  }
  closeConnection(conn, reason);
  return true;
}

/** Test/diagnostic helper: drop all connections. */
export function _resetForTest() {
  for (const conn of connections.values()) closeConnection(conn, "reset");
  connections.clear();
}
