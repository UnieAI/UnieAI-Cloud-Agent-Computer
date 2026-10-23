/**
 * cube/relay.mjs — the Rabi Local execution backend.
 *
 * Third implementation of cube/CONTRACT.md next to docker.mjs (a container in
 * this deployment) and ssh.mjs (the user's machine, reached inbound over SSH).
 * Here the user's machine reached OUT to us: the Rabi Local daemon holds an SSE
 * stream open (relay/routes.mjs) and every contract call becomes one `invoke`
 * frame pushed down that stream, answered by `result` frames. See ADR-0004.
 *
 * What this file deliberately does NOT decide:
 *   · whether a command may run — the daemon classifies it (read-only / needs
 *     approval / denied) with the same @unieai/ava-local-protocol rules the app
 *     uses, and verifies the approval token the app minted. We only pass the
 *     token through, so a compromised sandbox-runtime cannot approve anything;
 *   · where a path may point — containment happens on the daemon against the
 *     granted root; a refusal comes back as `outside_root` and is surfaced as
 *     the contract's `workspace_escape`.
 *
 * Streaming: exec results arrive as partial frames (stdout / stderr chunks)
 * and one final frame carrying `exit`. The handle mirrors spawnSsh's shape so
 * exec/processManager.mjs cannot tell the two apart.
 */

import { redactedWriteRefusal } from "../../../../packages/ava-local-protocol/src/redaction.mjs";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import { log } from "../shared/log.mjs";
import { SandboxError } from "../shared/error.mjs";
import { EventEmitter as TerminalEmitter } from "node:events";
import { invoke as registryInvoke, isMachineOnline, machineSupportsOp, machineDaemonVersion, getMachineConnection } from "../relay/registry.mjs";
import { workspacePath } from "../../../../packages/ava-local-protocol/src/workspace.mjs";
import { supportsNativeAgent } from "../../../../packages/ava-local-protocol/src/native-capability.mjs";
import { shq } from "./ssh.mjs";
import { config } from "../config.mjs";

/** One page asked of the daemon; its own cap is 4 MB and redaction changes lengths. */
const READ_PAGE_BYTES = 2 * 1024 * 1024;
const WHOLE_READ_MAX_BYTES = Math.max(1, Number(config?.artifact?.maxBytes) || 100_000_000);

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

/**
 * 長駐處理程序的上限：24 小時。
 *
 * **為什麼不是無限。** 這個行程跑在使用者自己的筆電上，而下令的是一個對話裡的
 * 模型。一個被忘記的 `pnpm dev` 不該在別人的機器上跑到他重開機為止 —— 那是我們
 * 留在他電腦上的東西，不是他自己開的。所以一定要有一個「總會結束」的刻度。
 *
 * **為什麼是 24 小時。** 它要比人的一個工作天長（早上請 agent 起 dev server，
 * 下午回來還要看得到它在跑），又要比「一夜之間就忘了」短（隔天回到電腦前，
 * 昨天的東西已經收乾淨，不會一天疊一層）。這兩個條件之間只有「一天」這個刻度
 * 是自然的，而且使用者猜得到 —— 一個他猜不到的數字（3 小時、72 小時）會變成
 * 「有時候還在有時候不在」。
 *
 * 到期時 daemon 走的是 `killTree`（SIGTERM 整個行程樹，兩秒後 SIGKILL）並回一個
 * `timedOut` 的 exit，所以是**乾淨地收掉**，不是留一堆孤兒。
 */
const LONG_LIVED_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * 「起得來嗎」的等待窗：起不來要是一個錯誤，不是一個馬上死掉的工作。
 *
 * daemon 在 spawn 之前就先分級、驗票，所以 `approval_required` / `denied` /
 * `spawn_failed` 會在一個來回之內回來。在這個窗內收到失敗，就把它變成 HTTP 錯誤
 * （POST /processes 回 403/501…），呼叫端才有機會去領票再試一次；沒收到就當它
 * 起來了，把 handle 交出去。
 *
 * 窗口不會每次都等滿：只要 daemon 吐出第一段輸出（dev server 幾乎都會先印一行），
 * 就證明行程已經 spawn 了，這時立刻回，不必再等。
 */
const LONG_LIVED_START_GRACE_MS = 1_500;

/** Quote a word only when bash would otherwise split or expand it — keeps the approval card readable. */
function quoteWord(word) {
  const w = String(word);
  return /^[A-Za-z0-9_./=:@%+,-]+$/.test(w) ? w : shq(w);
}

/**
 * 呼叫端給的是 argv（`command` + `args`），daemon 收的是**一行 bash**。
 *
 * 特別要拆掉 `bash -lc "<整行>"` 這個包裝：daemon 自己就是用 `bash -lc` 跑的
 * （tool-host.ts 的 `argv`），再包一層不只是多開一個 shell —— 更糟的是**分級會
 * 看錯**。`classifyCommand` 讀的是第一個字，包起來以後那個字永遠是 `bash`，
 * 於是連 `tail -f` 這種在唯讀清單裡的指令都要使用者按一次核准，而使用者按下去
 * 核准的字面上也只是「bash」。拆開來，daemon 看到的就是使用者真的要跑的那一行，
 * 分級、核准卡、稽核紀錄三者說的是同一件事。
 */
function bashLineFrom(command, args) {
  const cmd = String(command ?? "").trim();
  const list = (Array.isArray(args) ? args : []).map(String);
  if ((cmd === "bash" || cmd === "sh") && list.length === 2 && /^-[a-z]*c$/.test(list[0])) return list[1];
  return [cmd || "true", ...list].map(quoteWord).join(" ");
}
/** PTY 尺寸一律夾住不拒絕：面板在隱藏／挂載中／拖曳中量到的是 0 或小數。 */
function clampDim(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.trunc(n));
}

const FILE_TIMEOUT_MS = 30_000;

/**
 * 網路抖一下（Evan 的 DNS 閃了幾秒）時，檔案操作不該讓整輪失敗。
 *
 * 證據（2026-10-22 uac2-ava-engine）：statFile 送出後 15 秒沒回應 —— 連線其實已經半死，之後 relay.closed、1 秒內
 * relay.connected（pool.machine_back，offlineMs≈1001）。重連早就好了，但這一次呼叫已經死在舊連線上，錯誤直接丟給模型。
 *
 *   · 還沒送出去（機器剛好離線）：等它回來（最多 RECONNECT_WAIT_MS）再送 —— 什麼都還沒送，任何操作都安全。
 *   · 送出去之後傳輸層失敗（逾時／斷線）：只有**讀取類**才自動重試一次（等重連後）。寫入／刪除不重試：
 *     失敗的那一次可能已經生效，重送一遍 ＝ 做兩次，或對已經換掉的核准票說話。
 */
const RECONNECT_WAIT_MS = Number(process.env.AVA_RELAY_RECONNECT_WAIT_MS || 10_000);
const TRANSPORT_FAILURES = new Set(["machine_offline", "machine_disconnected", "machine_send_failed", "machine_timeout"]);
const SAFE_TO_REPEAT = new Set(["readFile", "statFile", "listFiles"]);

/** Daemon error code → contract error (code, http status). */
const ERROR_MAP = {
  outside_root: ["workspace_escape", 400],
  home_relative: ["workspace_escape", 400],
  bad_path: ["bad_request", 400],
  not_found: ["not_found", 404],
  approval_required: ["approval_required", 403],
  approval_rejected: ["approval_rejected", 403],
  denied: ["command_denied", 403],
  machine_offline: ["machine_offline", 503],
  machine_disconnected: ["machine_offline", 503],
  machine_timeout: ["machine_timeout", 504],
  machine_send_failed: ["machine_offline", 503],
  // ── 本機代理會話（L3）────────────────────────────────────────────────
  //
  // 這幾個不在表裡的時候，daemon 講的話會被收斂成 `machine_error` / 502 ——
  // 一個「機器壞了」而其實是「這台機器還沒準備好」或「雲端送錯了憑證種類」。
  // 那正是這個表存在的理由，而我第一版漏了它們（同一個「擴了一邊、漏了消費端」
  // 的形狀，approvalSubject 那邊也發生過一次）。
  //
  // 狀態碼刻意不同：
  //   · 還沒裝執行環境 → **409**，因為那是一個使用者做得到的前置條件，
  //     不是伺服器壞了（他去 Rabi Local 裡準備一次就好）
  //   · 憑證種類不對 → **500**，因為那是**我們**送錯了，不是他的問題。
  //     把它變成 4xx 會讓人去改他自己那邊，而錯在雲端這一側
  //   · 這個 build 沒啟用 / session 不在了 / 開太多 → 4xx，都是可行動的
  dsh_not_installed: ["local_agent_not_prepared", 409],
  agents_disabled: ["local_agent_unsupported", 501],
  agents_at_limit: ["local_agent_at_limit", 429],
  agent_exists: ["bad_request", 400],
  agent_gone: ["local_agent_gone", 404],
  model_credential_not_scoped: ["model_credential_not_scoped", 500],
};

function toSandboxError(output, fallback = "machine_error") {
  const err = output?.error || {};
  const [code, status] = ERROR_MAP[err.code] || [fallback, 502];
  // `payload_mismatch` means the daemon derived a different subject from the
  // same invoke than the app bound the token to. In normal operation that is a
  // tamper signal and the refusal is correct — but the OTHER cause is a machine
  // still running a daemon from before the subject gained a field, and there
  // the person just sees "approval token refused: payload_mismatch" and has no
  // way to guess that reinstalling fixes it. Say both.
  const message = /payload_mismatch/.test(String(err.message || ""))
    ? `${err.message} — the approval did not match what this machine was asked to do. If Rabi Local on that computer was installed before the latest update, reinstall it from Settings → 我的電腦; otherwise the request was altered in transit and refusing it was correct.`
    : err.message || `machine reported ${err.code || "an error"}`;
  return new SandboxError(code, message, status, {
    machineCode: err.code || null,
    retryable: !!err.retryable,
  });
}

function notSupported(what) {
  return new SandboxError("not_supported", `${what} is not supported on an Rabi Local machine yet`, 501);
}

/**
 * @param {{ invoke?: typeof registryInvoke, online?: typeof isMachineOnline }} [deps]
 */
export function createRelayClient({
  invoke = registryInvoke,
  online = isMachineOnline,
  supportsOp = machineSupportsOp,
  daemonVersion = machineDaemonVersion,
  connectionId = (machineId) => getMachineConnection(machineId)?.id ?? null,
  reconnectWaitMs = RECONNECT_WAIT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  /** sandboxId -> { machineId, root, userId, sessionId, createdAt, running: Map<execId, handle> } */
  const sandboxes = new Map();

  function getSandbox(sandboxId) {
    const entry = sandboxes.get(sandboxId);
    if (!entry) throw new SandboxError("sandbox_not_found", `no such sandbox: ${sandboxId}`, 404);
    return entry;
  }

  /**
   * A path the cube contract gave us (workspace-relative) → the path the daemon
   * should act on (under the folder the user picked).
   *
   * The same job ssh.mjs does with `joinRoot`, and the same rule — shared with
   * the app through @unieai/ava-local-protocol rather than copied, because the
   * app hashes this exact string into the approval token the daemon verifies
   * against the frame we send. Two spellings of one path is not a wrong file,
   * it is `payload_mismatch` on the user's own laptop.
   *
   * A machine with no folder picked gets its path back untouched: that is what
   * every machine did before, and joining under "/" would make the path
   * absolute and land it outside the granted root.
   */
  function daemonPath(sandboxId, requested) {
    const { root } = getSandbox(sandboxId);
    // An ABSOLUTE path that is already inside this workspace passes through
    // unchanged. `workspacePath` treats a leading slash as "relative to the
    // workspace" (it strips it and joins), which is right for a path the caller
    // expressed in workspace terms and wrong for one it expressed in the
    // MACHINE's terms — that one gets stacked on itself:
    //
    //   workspacePath("/home/dev/work", "/home/dev/work") → "/home/dev/work/home/dev/work"
    //
    // The engine sends the machine's own absolute cwd (it has to: the approval
    // token binds the string the daemon will see, and the daemon resolves
    // against the GRANTED root, not the picked folder). Stacking it turns
    // "run in my project" into `payload_mismatch` — the exact shape of the
    // 2026-09-06 bug, one layer down. Same rule as the panel's
    // `lib/machines/workspace-bridge.ts`.
    //
    // Outside the workspace it is NOT passed through: that path still goes to
    // `workspacePath`, which either contains it or refuses it below.
    const abs = String(requested ?? "").trim();
    if (abs.startsWith("/") && root) {
      const base = String(root).replace(/\/+$/, "");
      if (abs === base || abs.startsWith(`${base}/`)) return abs;
    }
    const p = workspacePath(root, requested);
    if (p === null) {
      throw new SandboxError("workspace_escape", `path escapes the workspace root: ${requested}`, 400);
    }
    return p;
  }

  /** 等這台機器（重新）連上，最多 reconnectWaitMs。回傳現在是否在線。 */
  async function waitOnline(machineId) {
    // 以睡了多久計，不看牆上時鐘：預算是確定的，測試也不必真的等。
    for (let waited = 0; !online(machineId) && waited < reconnectWaitMs; waited += 250) await sleep(250);
    return online(machineId);
  }

  async function call(sandboxId, op, args, { approval = null, timeoutMs = FILE_TIMEOUT_MS } = {}) {
    const { machineId } = getSandbox(sandboxId);
    // 還沒送：機器剛好離線就等它回來，什麼都沒送出去，所以對任何操作都安全。
    let waitedAlready = false;
    if (!online(machineId) && reconnectWaitMs > 0) {
      log("info", "relay.wait_for_reconnect", { machineId: String(machineId).slice(0, 8), op });
      await waitOnline(machineId);
      waitedAlready = true;
    }
    const connBefore = connectionId(machineId);
    let r = await invoke({ machineId, op, args, approval, timeoutMs });
    const code = r.ok ? null : r.output?.error?.code;
    if (!r.ok && TRANSPORT_FAILURES.has(code) && SAFE_TO_REPEAT.has(op) && reconnectWaitMs > 0 && !(waitedAlready && code === "machine_offline")) {
      const back = await waitOnline(machineId);
      // 逾時但還是同一條連線（半死的）→ 再送一次也一樣會逾時，別把等待時間加倍。
      if (back && (code !== "machine_timeout" || connectionId(machineId) !== connBefore)) {
        log("info", "relay.retry_after_reconnect", { machineId: String(machineId).slice(0, 8), op, after: code });
        r = await invoke({ machineId, op, args, approval, timeoutMs });
      }
    }
    if (!r.ok) throw toSandboxError(r.output);
    return r.output || {};
  }

  return {
    /**
     * Nothing to start: the daemon is already connected (or we refuse now
     * rather than let the first tool call discover it). Like ssh.mjs, this is
     * a registration, so `sandbox: allocating` is instantaneous.
     */
    async createSandbox({ userId, sessionId, machine } = {}) {
      if (!machine?.id || machine.kind !== "local") {
        throw new SandboxError("bad_request", "relay backend needs a machine { id, kind: 'local' }", 400);
      }
      if (!online(machine.id)) {
        throw new SandboxError("machine_offline", "This machine is not connected. Start Rabi Local on it and try again.", 503);
      }
      const sandboxId = `local-${randomUUID().slice(0, 12)}`;
      // `machine.root` is the folder the user PICKED in the composer
      // (`last_workspace`), not the folder they GRANTED at pairing. Only the
      // daemon knows the second one, and it resolves everything against it —
      // so a path sent workspace-relative lands in the granted folder, which
      // is usually an ancestor. On 2026-09-04 the chip read「evan」and the
      // agent described /home/ubuntu: right machine, wrong folder, no error.
      // `daemonPath` below is what makes the pick take effect.
      const root = typeof machine.root === "string" ? machine.root : "";
      sandboxes.set(sandboxId, { machineId: machine.id, root, userId, sessionId, createdAt: Date.now(), running: new Map() });
      log("info", "relay.sandbox_created", { sandboxId, userId, sessionId, machineId: String(machine.id).slice(0, 8) });
      return { sandboxId, workspaceId: sessionId || sandboxId, workspaceDir: root || "/" };
    },

    async destroySandbox(sandboxId) {
      const entry = sandboxes.get(sandboxId);
      if (!entry) return;
      for (const handle of entry.running.values()) {
        try { handle.cancel(); } catch { /* best-effort */ }
      }
      sandboxes.delete(sandboxId);
      log("info", "relay.sandbox_destroyed", { sandboxId });
    },

    async pauseSandbox() { /* the user's machine is not ours to freeze */ },
    async resumeSandbox() { /* no-op */ },

    async listSandboxes() {
      return [...sandboxes.entries()].map(([sandboxId, e]) => ({
        sandboxId, workspaceId: e.sessionId || sandboxId, createdAt: e.createdAt, machineId: e.machineId,
      }));
    },

    /**
     * One-shot command. `approval` is the token the app minted after the user
     * clicked Allow; read-only commands run without one (the daemon decides).
     */
    async execProcess(sandboxId, { kind = "bash", command, args = [], env = {}, cwd, timeoutMs, stdin, approval = null, sandbox = false } = {}) {
      const entry = getSandbox(sandboxId);
      // Raw invocations are folded into a single bash line so the approval
      // subject (the command string) covers the arguments too.
      const line = kind === "raw"
        ? [String(command || "true"), ...(Array.isArray(args) ? args : []).map(String)].map(quoteWord).join(" ")
        : typeof command === "string" ? command : (Array.isArray(args) && args.length ? args.join(" ") : "true");
      const execKind = kind === "python" ? "python" : "bash";
      const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_EXEC_TIMEOUT_MS;

      // Where the command runs. No cwd from the caller means "the workspace",
      // which is the folder the user picked — NOT the daemon's default, which
      // is the whole granted folder. Resolved before anything is spawned so a
      // path that climbs out is refused here, not on the machine.
      const workdir = daemonPath(sandboxId, cwd) || undefined;

      const handle = createHandle();
      const execId = handle.execId;
      entry.running.set(execId, handle);

      // Name the invocation, because we have to refer to it again to stop it.
      // The daemon keys the running child by the invoke frame's id
      // (`running.set(frame.id, child)` in tool-host.ts) and `cancel` looks it
      // up by `args.id`. This used to send `execId` — a purely local handle id
      // the daemon has never seen — so Stop matched nothing, answered
      // `{cancelled:false}`, and the command ran on the user's machine until it
      // timed out, while sandbox-runtime had already reported it cancelled.
      // Kept distinct from execId rather than reusing it: execId is a short
      // 32-bit label that appears in exit events and client-side maps, and an
      // id that decides which process gets killed should not be that narrow.
      const invokeId = randomUUID();

      const done = invoke({
        machineId: entry.machineId,
        invokeId,
        op: "exec",
        args: {
          kind: execKind,
          command: line,
          env: env && typeof env === "object" ? env : {},
          cwd: workdir,
          stdin: typeof stdin === "string" ? stdin : null,
          // Per-command container on the device. The daemon decides whether it
          // can honour it; the app only asks.
          sandbox: sandbox === true,
        },
        approval,
        timeoutMs: limit,
        onEvent: (ev) => {
          if (ev?.stream === "stdout" || ev?.stream === "stderr") handle._emitOrBuffer(ev.stream, Buffer.from(String(ev.data ?? ""), "utf8"));
        },
      });
      handle.cancel = () => {
        void invoke({ machineId: entry.machineId, op: "cancel", args: { id: invokeId }, timeoutMs: 5_000 }).catch(() => {});
      };
      handle.kill = handle.cancel;

      done.then((r) => {
        entry.running.delete(execId);
        if (r.ok) {
          const exit = r.output?.exit || {};
          handle._emitExit({ code: exit.code === undefined ? 0 : exit.code, signal: exit.signal || null, error: null, errorCode: null });
        } else {
          const err = r.output?.error || {};
          handle._emitExit({ code: null, signal: null, error: `${err.code || "machine_error"}: ${err.message || "failed"}`, errorCode: err.code || "machine_error" });
        }
      });
      return handle;
    },

    /**
     * 長駐處理程序 —— `pnpm dev`、`tail -f`、watch。
     *
     * **跟 execProcess 的差別只有一個：這一輪不等它結束。** 底下的機械完全一樣，
     * 因為 daemon 那端本來就已經全部備齊：`spawn(..., { detached: true })`、
     * 用 frame id 登記 `running`、stdout/stderr 走 partial frame、`cancel` op 對得上
     * `killTree`。缺的從來不是能力，是**截止時間** —— tool-host.ts 的
     * `DEFAULT_TIMEOUT_MS` 是兩分鐘，所以任何「留下來跑」的東西都會在第 120 秒
     * 被 SIGKILL，而模型只看得到 `exit code -1`，然後自己編一套解釋
     *（2026-09-04 實測：`pnpm dev:web` 每次都這樣）。
     *
     * 所以這裡送的是一個很長（但有上限）的 deadline，**daemon 一行都不用改** ——
     * 那很重要：改 daemon 等於要每一個使用者重裝一次 Rabi Local。
     */
    async spawnLongLivedProcess(sandboxId, { command, args = [], env = {}, cwd, approval = null, sandbox = false } = {}) {
      const entry = getSandbox(sandboxId);
      const line = bashLineFrom(command, args);
      const workdir = daemonPath(sandboxId, cwd) || undefined;

      const handle = createHandle();
      const execId = handle.execId;
      entry.running.set(execId, handle);

      // 跟 execProcess 同一顆釘子：daemon 用 **frame 的 id** 登記正在跑的子行程，
      // `cancel` 也用同一個 id 去找。送 execId（本地的短標籤）的話 Stop 會匹配不到
      // 任何東西，回 `{cancelled:false}`，而行程繼續在使用者的電腦上跑。
      const invokeId = randomUUID();
      let sawOutput = null;
      const firstOutput = new Promise((resolve) => { sawOutput = resolve; });

      const done = invoke({
        machineId: entry.machineId,
        invokeId,
        op: "exec",
        args: {
          kind: "bash",
          command: line,
          env: env && typeof env === "object" ? env : {},
          cwd: workdir,
          stdin: null,
          sandbox: sandbox === true,
        },
        approval,
        // 這個數字同時是 daemon 的硬截止時間，也是 relay 這端的**閒置**計時器
        //（registry 的 armTimer 每收到一段輸出就重算）。一個安靜到滿 24 小時的
        // 行程會由這端先喊 machine_timeout，daemon 隨後也會把它收掉 —— 兩邊講的
        // 是同一件事（它結束了），只是措辭不同。
        timeoutMs: LONG_LIVED_MAX_MS,
        onEvent: (ev) => {
          if (ev?.stream === "stdout" || ev?.stream === "stderr") {
            sawOutput?.();
            handle._emitOrBuffer(ev.stream, Buffer.from(String(ev.data ?? ""), "utf8"));
          }
        },
      });
      handle.cancel = () => {
        void invoke({ machineId: entry.machineId, op: "cancel", args: { id: invokeId }, timeoutMs: 5_000 }).catch(() => {});
      };
      handle.kill = handle.cancel;

      done.then((r) => {
        entry.running.delete(execId);
        if (r.ok) {
          const exit = r.output?.exit || {};
          handle._emitExit({ code: exit.code === undefined ? 0 : exit.code, signal: exit.signal || null, error: null, errorCode: null });
        } else {
          const err = r.output?.error || {};
          handle._emitExit({ code: null, signal: null, error: `${err.code || "machine_error"}: ${err.message || "failed"}`, errorCode: err.code || "machine_error" });
        }
      });

      // ── 起得來嗎 ────────────────────────────────────────────────────────
      //
      // 「起不來」要長得像起不來。daemon 拒絕（沒有核准票、在硬拒清單上、
      // spawn 失敗）是在 spawn **之前**決定的，所以一個來回就回得來；在這個窗內
      // 收到失敗就丟出對應的 SandboxError，POST /processes 於是回 403/501，
      // 呼叫端才走得到「領票再試一次」。少了這一段，同一件事會變成「工作起來了、
      // 然後立刻死掉」，模型讀到的是一段錯誤字串而不是一次拒絕。
      let graceTimer = null;
      const grace = new Promise((resolve) => {
        graceTimer = setTimeout(() => resolve(null), LONG_LIVED_START_GRACE_MS);
        graceTimer.unref?.();
      });
      const settled = await Promise.race([
        done.then((r) => ({ r })),
        // 有輸出就代表 spawn 成功了，不必再等滿整個窗。
        firstOutput.then(() => null),
        grace,
      ]);
      clearTimeout(graceTimer);
      if (settled?.r && settled.r.ok === false) throw toSandboxError(settled.r.output);

      return handle;
    },

    /**
     * 使用者自己電腦上的互動式終端機。
     *
     * ## 先問，再開
     *
     * daemon 在 `hello` 就報了它服務哪些 op，所以「這個版本支不支援終端機」是
     * 開口**之前**就知道的。這一步不是保險，是這條路唯一不會騙人的地方：
     * 沒有它，舊版 daemon 會回一個 `unknown_op`，而那個錯誤要嘛被吞掉、要嘛
     * 長得像一次普通的失敗 —— 使用者面前就是一個開起來、打字沒反應的黑框，
     * 他會一直打，然後以為是自己的電腦壞了。
     *
     * ## 一個 invoke 撐整條終端機
     *
     * `terminalOpen` 這個 invoke **不會**在開完之後結束：它一直開著，daemon 把
     * PTY 的輸出當作 partial frame 往回推，最後才用一個 result frame 說它結束了。
     * 跟 `spawnLongLivedProcess` 同一個機械。
     *
     * 所以後續的 `terminalInput` / `terminalResize` / `terminalSignal` /
     * `terminalClose` 用**同一個 invokeId** 當終端機的把手 —— 跟背景行程用
     * frame id 當把手是同一顆釘子（送一個本地短標籤的話 daemon 找不到任何東西，
     * 而使用者看到的是按鍵靜靜地消失）。
     */
    async openTerminal(sandboxId, { cwd, cols = 80, rows = 24, env = {}, approval = null } = {}) {
      const entry = getSandbox(sandboxId);
      if (!online(entry.machineId)) {
        throw new SandboxError("machine_offline", "這台電腦沒有連上線，開不了終端機。", 503);
      }
      if (!supportsOp(entry.machineId, "terminalOpen")) {
        const version = daemonVersion(entry.machineId);
        throw new SandboxError(
          "terminal_unsupported",
          // 版號放進括號是給人看的，**不是判斷依據** —— `DAEMON_VERSION` 從
          // daemon 誕生到今天都是 "0.1.0"，連加上終端機支援的那個 commit 都沒有
          // 改它。判斷是上面那行的 `supportsOp`（daemon 自報的 ops）。
          //
          // 下一步只講「更新」，不要指路。先前這句寫的是「請到『設定 →
          // 我的電腦』重新安裝」，而那個頁面**不存在** —— 一句叫人去一個不存在
          // 的地方的錯誤訊息，比只說出問題還糟。更新的入口在終端機面板的
          // 「更新 Rabi Local」與機器選單那一列上（components/agent-next/machine/
          // update-machine-dialog.tsx），兩個都在使用者已經看著的地方。
          `這台電腦上的 Rabi Local 版本還不支援終端機${version ? `（目前是 ${version}）` : ""}。`
            + `把那台電腦上的 Rabi Local 更新之後，這裡就會出現一個真的終端機。`,
          501,
          { machineId: entry.machineId, daemonVersion: version, missingOp: "terminalOpen" },
        );
      }

      const workdir = daemonPath(sandboxId, cwd) || undefined;
      const handle = new TerminalEmitter();
      // **EventEmitter 的 `error` 沒有聽眾就會丟例外，而在 `.then()` 裡丟等於一個
      // 沒有人接的 rejection —— node 22 的預設是讓整個行程死掉。**
      //
      // 2026-09-08 實測：在使用者自己的電腦上開一個終端機、daemon 因為沒有核准票
      // 而拒絕 → 下面那個 `done.then` 走 else 分支 → `handle.emit("error")` →
      // sandbox-runtime **整個行程崩潰重啟**（量到的：拒絕在 20:38:31，行程起於
      // 20:38:34）。掉的不只是按下去那個人的機器，是**當下所有連著的機器**，
      // 而每一台看到的都是「連線被意外關閉」然後退避重連。使用者那端的症狀是
      // 「一按重試，我的電腦就斷線」。
      //
      // 失敗本來就有另外兩條路送出去（`settle` ＋ 下面那個 grace 競賽會 throw），
      // 所以這裡掛一個永遠在的空聽眾：真的有人在聽時他照樣收得到，沒有人聽的
      // 時候它只是一則沒人要的訊息 —— 而不是一次全站中斷。
      handle.on("error", () => {});
      handle.terminalKind = "machine";
      const invokeId = randomUUID();
      handle.execId = invokeId;
      let exited = false;

      // ── 開場輸出不能掉在 grace 窗裡 ─────────────────────────────────────
      //
      // 下面會等 LONG_LIVED_START_GRACE_MS（1.5 秒）確認 daemon 沒有拒絕，**之後**呼叫端
      // （terminal/registry.mjs）才拿到 handle、才 `handle.on("data")`。shell 的 MOTD 與第一個提示字元
      // 幾乎一定落在那 1.5 秒裡 —— 打在一個沒有 data 聽眾的 EventEmitter 上就是直接掉了
      // （2026-10-02 實測：使用者看到空的黑框，要打字才出現提示字元）。
      // 所以第一個 data 聽眾出現之前先存（64 KB 上限，留最後的），聽眾掛上就補發給**那一個**聽眾。
      const EARLY_MAX_BYTES = 64 * 1024;
      let early = [];
      let earlyBytes = 0;
      let earlyDone = false;
      const keepEarly = (buf) => {
        early.push(buf);
        earlyBytes += buf.length;
        while (earlyBytes > EARLY_MAX_BYTES && early.length > 1) earlyBytes -= early.shift().length;
      };
      handle.on("newListener", (event, listener) => {
        if (event !== "data" || earlyDone) return;
        earlyDone = true;
        const pending = early;
        early = [];
        earlyBytes = 0;
        // 同步補發（`newListener` 在聽眾真的被加進去**之前**觸發）：補發一定排在之後任何即時輸出之前，
        // 不會有「聽眾先收到新的、補發的才到」的亂序。
        for (const b of pending) listener(b);
      });

      const settle = (info) => {
        if (exited) return;
        exited = true;
        handle.emit("exit", info);
      };

      const done = invoke({
        machineId: entry.machineId,
        invokeId,
        op: "terminalOpen",
        args: { cwd: workdir, cols: clampDim(cols), rows: clampDim(rows), env: env && typeof env === "object" ? env : {} },
        approval,
        timeoutMs: LONG_LIVED_MAX_MS,
        onEvent: (ev) => {
          // daemon 推回來的 PTY 位元組是 base64（見協定）。這裡**不解碼成文字** ——
          // 一個多位元組字元被切在兩次 read 中間是常態，在這裡解就會產生不可逆的
          // 替代字元。原樣傳給看得到整條串流的那一端。
          let chunk = null;
          if (typeof ev?.dataBase64 === "string") chunk = Buffer.from(ev.dataBase64, "base64");
          else if (ev?.stream === "stdout" || ev?.stream === "stderr") chunk = Buffer.from(String(ev.data ?? ""), "utf8");
          if (!chunk) return;
          if (earlyDone) handle.emit("data", chunk);
          else keepEarly(chunk);
        },
      });

      done.then((r) => {
        entry.running.delete(invokeId);
        if (r.ok) {
          const exit = r.output?.exit || {};
          settle({ code: typeof exit.code === "number" ? exit.code : null, closedByClient: false });
        } else {
          const err = r.output?.error || {};
          handle.emit("error", new Error(`${err.code || "machine_error"}: ${err.message || "failed"}`));
          settle({ code: null, closedByClient: false });
        }
      });
      entry.running.set(invokeId, { cancel: () => { void invoke({ machineId: entry.machineId, op: "terminalClose", args: { id: invokeId }, timeoutMs: 5_000 }).catch(() => {}); } });

      // ── 開得起來嗎 ──────────────────────────────────────────────────
      // 跟背景行程同一個窗：daemon 在配 PTY 之前就會拒絕（沒有票、路徑在授權
      // 根外面），那是一個來回就回得來的。在窗內收到失敗就丟出來，讓
      // POST /terminals 回 403/501 —— 而不是交出一個馬上就死的終端機。
      let graceTimer = null;
      const grace = new Promise((resolve) => {
        graceTimer = setTimeout(() => resolve(null), LONG_LIVED_START_GRACE_MS);
        graceTimer.unref?.();
      });
      const settled = await Promise.race([done.then((r) => ({ r })), grace]);
      clearTimeout(graceTimer);
      if (settled?.r && settled.r.ok === false) throw toSandboxError(settled.r.output);

      handle.write = async (data) => {
        if (exited) return false;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
        const r = await invoke({
          machineId: entry.machineId, op: "terminalInput",
          args: { id: invokeId, dataBase64: buf.toString("base64") }, timeoutMs: 10_000,
        });
        return r.ok !== false;
      };
      handle.resize = async (nextCols, nextRows) => {
        if (exited) return false;
        const r = await invoke({
          machineId: entry.machineId, op: "terminalResize",
          args: { id: invokeId, cols: clampDim(nextCols), rows: clampDim(nextRows) }, timeoutMs: 10_000,
        });
        return r.ok !== false;
      };
      handle.signal = async (name) => {
        if (exited) return false;
        const r = await invoke({
          machineId: entry.machineId, op: "terminalSignal",
          args: { id: invokeId, signal: String(name || "SIGINT") }, timeoutMs: 10_000,
        });
        return r.ok !== false;
      };
      handle.close = async () => {
        await invoke({
          machineId: entry.machineId, op: "terminalClose", args: { id: invokeId }, timeoutMs: 10_000,
        }).catch(() => {});
        settle({ code: null, closedByClient: true });
      };

      return handle;
    },

    /**
     * 在**使用者的電腦上**開一個 DSH 代理會話。L3b。
     *
     * ## 跟 openTerminal 是同一顆釘子
     *
     * `agentSession` 這個 invoke **不會**在開完之後結束：它一直開著，daemon 把
     * ACP 訊息當作 partial frame 往回推，最後才用一個 result frame 說它結束了。
     * 所以後續的 `agentSessionInput` / `agentSessionClose` 用**同一個 invokeId**
     * 當把手 —— 跟終端機用 invokeId、背景行程用 frame id 是同一個道理（送一個
     * 本地短標籤的話 daemon 找不到任何東西，而使用者看到的是訊息靜靜地消失）。
     *
     * ## 為什麼要有這條路
     *
     * 見 docs/sandbox/local-sandbox-design.md。簡短版：DSH 今天跑在共用的引擎
     * 容器裡（雲端與地端都一樣），所以 workflow、PTC 模式、創造模式、plugin
     * 全部必須拒絕。把 DSH 搬到使用者的機器上之後，那四個就只是 DSH 在做 DSH
     * 該做的事。
     *
     * ## 兩個從終端機那條路學到的東西，照抄不商量
     *
     * 1. **掛一個永遠在的空 `error` 聽眾。** EventEmitter 的 `error` 沒有聽眾
     *    就丟例外，而在 `.then()` 裡丟等於一個沒人接的 rejection —— node 22 的
     *    預設是讓整個行程死掉。2026-09-08 實測那個形狀讓 sandbox-runtime
     *    整個行程崩潰重啟，掉的是**當下所有連著的機器**。
     * 2. **grace 窗讓「起不來」變成 HTTP 錯誤。** daemon 在 spawn 之前就分級、
     *    驗票、檢查 DSH 裝了沒，所以 `approval_required` / `dsh_not_installed`
     *    / `model_credential_not_scoped` 都是一個來回就回得來的。在窗內收到
     *    失敗就丟出來，而不是交出一個馬上就死的 session。
     */
    async openAgentSession(sandboxId, { cwd, env = {}, model = null, runtime = null, patchFile = null, approval = null } = {}) {
      const entry = getSandbox(sandboxId);
      if (runtime && !supportsNativeAgent(supportsOp(entry.machineId, "agentSession") ? ["agentSession"] : [], daemonVersion(entry.machineId))) {
        throw new SandboxError("local_agent_upgrade_required", "本機原生代理需要 Rabi Local 0.2.11 以上，請先更新這台電腦。", 501);
      }
      if (!online(entry.machineId)) {
        throw new SandboxError("machine_offline", "這台電腦沒有連上線，開不了本機代理。", 503);
      }
      // 判斷依據是 daemon 自報的 ops，**不是版號** —— 版號從 daemon 誕生到今天
      // 都沒有跟著功能改過（見 openTerminal 那段註解）。而 daemon 只在
      // 「這個 build 啟用了本機代理**而且** DSH 真的裝好了」時才宣傳這個 op，
      // 所以缺它的兩種原因要分開講。
      if (!supportsOp(entry.machineId, "agentSession")) {
        const version = daemonVersion(entry.machineId);
        throw new SandboxError(
          "local_agent_unsupported",
          `這台電腦上的 Rabi Local 還不能在本機跑代理${version ? `（目前是 ${version}）` : ""}。`
            + `把那台電腦上的 Rabi Local 更新、並在它裡面準備一次本機執行環境（約 300 MB），這裡就會用它。`,
          501,
          { machineId: entry.machineId, daemonVersion: version, missingOp: "agentSession" },
        );
      }

      const workdir = daemonPath(sandboxId, cwd) || undefined;
      const handle = new TerminalEmitter();
      // 見上面第 1 點：不掛這個會是一次全站中斷，不是一則錯誤。
      handle.on("error", () => {});
      const invokeId = randomUUID();
      handle.sessionId = invokeId;
      let exited = false;
      const settle = (info) => {
        if (exited) return;
        exited = true;
        handle.emit("exit", info);
      };

      const done = invoke({
        machineId: entry.machineId,
        invokeId,
        op: "agentSession",
        args: {
          sessionId: invokeId,
          cwd: workdir,
          env: env && typeof env === "object" ? env : {},
          // 模型憑證原樣往下傳。**這一層不檢查它** —— daemon 那邊的
          // `agentEnv` 才是那道門（只收限範圍的短期 token），而檢查放在兩個
          // 地方就是兩份實作。這裡只確保它不會被記進 log。
          ...(model && typeof model === "object" ? { model } : {}),
          ...(runtime && typeof runtime === "object" ? { runtime } : {}),
          ...(patchFile ? { patchFile: String(patchFile) } : {}),
        },
        approval,
        timeoutMs: LONG_LIVED_MAX_MS,
        onEvent: (ev) => {
          // daemon 推回來的是 `{ agent: … }`：ACP 訊息、DSH 的診斷、或結束。
          // **原樣往上送，不在這裡解釋 ACP 的語意** —— 那是 app 的事，而在這
          // 一層多解一次就是第二個會跟它不一致的地方。
          const a = ev?.agent;
          if (!a) return;
          if (a.acp) handle.emit("acp", a.acp);
          else if (typeof a.note === "string") handle.emit("note", a.note);
          else if (a.exit) settle({ code: a.exit.code ?? null, signal: a.exit.signal ?? null, closedByClient: false });
        },
      });

      done.then((r) => {
        entry.running.delete(invokeId);
        if (r.ok) {
          const out = r.output || {};
          settle({ code: typeof out.exitCode === "number" ? out.exitCode : null, signal: out.signal ?? null, closedByClient: false });
        } else {
          const err = r.output?.error || {};
          handle.emit("error", new Error(`${err.code || "machine_error"}: ${err.message || "failed"}`));
          settle({ code: null, signal: null, closedByClient: false });
        }
      });
      entry.running.set(invokeId, {
        cancel: () => {
          void invoke({
            machineId: entry.machineId, op: "agentSessionClose",
            args: { sessionId: invokeId }, timeoutMs: 5_000,
          }).catch(() => {});
        },
      });

      // 見上面第 2 點。
      let graceTimer = null;
      const grace = new Promise((resolve) => {
        graceTimer = setTimeout(() => resolve(null), LONG_LIVED_START_GRACE_MS);
        graceTimer.unref?.();
      });
      const settled = await Promise.race([done.then((r) => ({ r })), grace]);
      clearTimeout(graceTimer);
      if (settled?.r && settled.r.ok === false) throw toSandboxError(settled.r.output);

      handle.send = async (message) => {
        if (exited) return false;
        const r = await invoke({
          machineId: entry.machineId, op: "agentSessionInput",
          args: { sessionId: invokeId, message }, timeoutMs: 30_000,
        });
        return r.ok !== false;
      };
      handle.close = async () => {
        await invoke({
          machineId: entry.machineId, op: "agentSessionClose",
          args: { sessionId: invokeId }, timeoutMs: 10_000,
        }).catch(() => {});
        settle({ code: null, signal: null, closedByClient: true });
      };

      return handle;
    },

    /**
     * 整個檔案，一頁一頁拿（daemon 0.2.19 起 readFile 收 offset/length）。
     * 舊 daemon 不認得 range、回整個檔案而且不帶 `bytesRead` —— 那一次就是全部。
     * 上限跟 artifact 一樣（config.artifact.maxBytes）：這支的呼叫端（下載、
     * artifact 保存）都是要整個檔案抱在記憶體裡的。
     */
    async readFile(sandboxId, filePath) {
      const p = daemonPath(sandboxId, filePath);
      const parts = [];
      let offset = 0;
      let total = 0;
      for (;;) {
        const out = await call(sandboxId, "readFile", { path: p, offset, length: READ_PAGE_BYTES });
        const buf = Buffer.from(String(out.contentBase64 || ""), "base64");
        parts.push(buf);
        total += buf.length;
        if (typeof out.bytesRead !== "number" || out.eof === true) break;
        if (!(out.bytesRead > 0)) throw new SandboxError("read_failed", "paged read made no progress", 502);
        if (total > WHOLE_READ_MAX_BYTES) {
          throw new SandboxError("payload_too_large", `file is larger than ${WHOLE_READ_MAX_BYTES} bytes`, 413);
        }
        offset += out.bytesRead;
      }
      return Buffer.concat(parts);
    },

    async writeFile(sandboxId, filePath, content, { approval = null } = {}) {
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(typeof content === "string" ? content : JSON.stringify(content));
      // 同一道：AI 讀到的是遮蔽後的檔案，照寫回去一樣會蓋掉真的祕密（protocol/redaction.mjs）。
      const refusal = redactedWriteRefusal(buf);
      if (refusal) throw new SandboxError(refusal.code, refusal.message, 409);
      await call(sandboxId, "writeFile", { path: daemonPath(sandboxId, filePath), contentBase64: buf.toString("base64") }, { approval, timeoutMs: 60_000 });
    },

    async statFile(sandboxId, filePath) {
      const out = await call(sandboxId, "statFile", { path: daemonPath(sandboxId, filePath) });
      return out.stat ?? null;
    },

    async listFiles(sandboxId, dirPath = "/") {
      const out = await call(sandboxId, "listFiles", { path: daemonPath(sandboxId, dirPath) });
      return Array.isArray(out.entries) ? out.entries : [];
    },

    async deleteFile(sandboxId, filePath, { approval = null } = {}) {
      await call(sandboxId, "deleteFile", { path: daemonPath(sandboxId, filePath) }, { approval });
    },

    async ensureDir(sandboxId, dirPath, { approval = null } = {}) {
      await call(sandboxId, "ensureDir", { path: daemonPath(sandboxId, dirPath) }, { approval });
    },

    async openTunnel() { throw notSupported("a port tunnel"); },
    async closeTunnel() { /* nothing was opened */ },
    async snapshotSandbox() { throw notSupported("snapshot"); },
    async restoreSnapshot() { throw notSupported("restore"); },

    _internal: { sandboxes },
  };
}

/** An EventEmitter shaped exactly like spawnSsh's handle, minus the process. */
function createHandle() {
  const handle = new EventEmitter();
  const pendingEvents = [];
  let exitEmitted = false;
  handle.execId = `exec-${randomUUID().slice(0, 8)}`;
  handle.pid = null;
  handle._emitOrBuffer = (type, ...values) => {
    if (handle.listenerCount(type) > 0) handle.emit(type, ...values);
    else pendingEvents.push([type, values]);
  };
  handle._emitExit = (info) => {
    if (exitEmitted) return;
    exitEmitted = true;
    handle._emitOrBuffer("exit", { execId: handle.execId, ...info });
  };
  handle.drainBufferedEvents = () => {
    for (const [type, values] of pendingEvents.splice(0)) handle.emit(type, ...values);
  };
  handle.write = () => {
    handle._emitOrBuffer("error", new Error("stdin is not supported on an Rabi Local machine yet"));
  };
  handle.cancel = () => {};
  handle.kill = () => {};
  return handle;
}
