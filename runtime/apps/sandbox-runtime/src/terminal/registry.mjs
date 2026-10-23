/**
 * terminal/registry.mjs —— 沙盒裡活著的互動式終端機。
 *
 * 這一層只負責**傳輸**：開、收位元組、寫位元組、改大小、關。scrollback 與
 * 「哪一個工作區有幾個終端機」那些政策在引擎那邊（見 ava-engine 的
 * `terminal-operator.mjs`），理由跟 UAD 把 `terminal-operator` 疊在
 * `ctx.subprocess.spawnTerminal` 上是同一個：後端只知道怎麼生一個 PTY，
 * 不知道誰在看它。
 *
 * 但這裡還是留了一個**很小**的重播環，那不是重複造 scrollback ——
 * 是為了補上一個真的會發生的縫：`POST /terminals` 回來之後、
 * `GET /stream` 連上之前，中間有一個來回。shell 的 MOTD 與第一個提示字元
 * 幾乎一定落在那個縫裡，於是使用者看到的是一個空的黑框（shell 明明已經
 * 在等他打字了）。環只要蓋得住這一個來回就夠，所以它是 KB 級不是 MB 級。
 */

import { randomUUID } from "node:crypto";

import { SandboxError } from "../shared/error.mjs";
import { log } from "../shared/log.mjs";
import { officialAuthIntent } from "../../../../packages/ava-local-protocol/src/official-auth.mjs";

/** 開場那一個來回的重播上限。夠一份 MOTD ＋ 一個提示字元，不是 scrollback。 */
const PRIME_MAX_BYTES = 64 * 1024;

/**
 * 已經結束的那一列留多久才回收。
 *
 * **為什麼需要它。** `exit` 只把 `live` 翻成 false —— 紀錄、後端的 handle、
 * 那個重播環都還在這張表上，而且沒有任何東西會把它們拿掉。一個工作一整天的
 * 對話「開 → 自己 exit → 再開」可以無限重複，這張表只會單向長大。同一個
 * runtime 裡的對照組（`exec/processManager.mjs` 的 `gcExitedProcesses`，掛在
 * server.mjs 的定期 tick 上）早就在做這件事，終端機這條漏了。
 *
 * **為什麼不是立刻。** 面板關掉再打開、換 wifi、闔上筆電再打開都要能回到同一個
 * 終端機讀「它是怎麼結束的」。寬限期買的就是這一段。
 *
 * **為什麼是這個數字、而且用這個環境變數名。** 引擎那一側的同一件事
 * （`ava-engine/src/terminal-operator.mjs` 的 `REAP_GRACE_MS`）用的是同一個名字、
 * 同一個預設。**兩層必須一致**：引擎那一列還在、這一層先收掉的話，使用者重連
 * 會看到一個列得出來卻 attach 不上去的終端機 —— 一個「有時候可以重連、有時候
 * 不行」的 bug，而兩邊各自都是綠的。有一個結構性測試釘住這件事
 * （terminal/grace-matches-engine.test.mjs）。
 *
 * 上游 UAD 的 `@unieai/uad-terminal-operator` **沒有**這個回收 —— 它的
 * `settle()` 只翻旗標，紀錄留在 `this.terminals` 裡直到整個服務 dispose。
 * 那對單機單人的桌面程式撐得住；對一個行程服務所有租戶的後端撐不住。
 */
const REAP_GRACE_MS = Number(process.env.AVA_TERMINAL_REAP_GRACE_MS || 5 * 60_000);

/**
 * 開好之後多久內一定要有人 attach，否則當孤兒關掉（預設 120 秒；`<= 0` ＝ 不回收）。
 *
 * **為什麼需要它。** 2026-09-30：沙盒冷啟動 ~17 秒期間面板送了 3 個 `terminal.open`，
 * 2 個開成功卻從來沒有人 `GET /stream` —— 它們是活的，所以不走上面的「結束後回收」，
 * 卻一直佔著容器裡的一個 shell。引擎那一層（`terminal-operator.mjs`）有同名同預設的
 * `AVA_TERMINAL_ATTACH_DEADLINE_MS`，兩層各管各的那一列：引擎自己回收時會 DELETE 到
 * 這裡；這一層是**最後一道**，涵蓋「引擎根本沒接上來」（引擎重啟、串流接不上）。
 *
 * **只看「從沒 attach 過」。** attach 過一次（`attachedEver`）就永遠不碰：斷線重連的
 * 終端機是使用者的東西。
 *
 * **每次 open 才讀環境變數**，不在載入時讀一次：這張表是模組單例，載入時固定的話
 * 測試與維運都改不動它。測試另外可以直接給 `openTerminal({ attachDeadlineMs })`。
 */
function defaultAttachDeadlineMs() {
  return Number(process.env.AVA_TERMINAL_ATTACH_DEADLINE_MS || 120_000);
}

/** terminalId -> record */
const terminals = new Map();
// Stable application slots survive lost HTTP receipts and web-server restarts.
// The runtime owns both the PTY and its slot; never adopt an unrelated shell.
const openingSlots = new Map();
/** terminalId -> 回收計時器。closeTerminal／_resetTerminals 要記得拆掉。 */
const reapers = new Map();

function cancelAttachDeadline(record) {
  if (record.attachTimer) { clearTimeout(record.attachTimer); record.attachTimer = null; }
}

/**
 * 排「一直沒人 attach 就關掉」的期限。開火時再驗一次：還是同一列、還活著、
 * 而且從沒 attach 過。關閉走 `closeTerminal`，跟使用者主動關是同一條路。
 */
function armAttachDeadline(record, deadlineMs) {
  if (!(deadlineMs > 0)) return;
  record.attachTimer = setTimeout(() => {
    record.attachTimer = null;
    if (terminals.get(record.terminalId) !== record || !record.live || record.attachedEver) return;
    log("warn", "terminal.unattached_reaped", {
      sandboxId: record.sandboxId, terminalId: record.terminalId, deadlineMs,
    });
    void closeTerminal(record.sandboxId, record.terminalId);
  }, deadlineMs);
  // 卡在事件迴圈上會讓行程收不掉 —— 跟這個專案裡其他每一個計時器同一條規矩。
  record.attachTimer.unref?.();
}

function cancelReap(terminalId) {
  const t = reapers.get(terminalId);
  if (t) { clearTimeout(t); reapers.delete(terminalId); }
}

/** 結束的那一列排進回收。寬限期到了才真的丟掉，而且只丟還是死的那些。 */
function scheduleReap(record) {
  cancelReap(record.terminalId);
  const fire = () => {
    reapers.delete(record.terminalId);
    const r = terminals.get(record.terminalId);
    // 還活著＝這個 id 被重用了（實務上不會，但這比「相信它不會」便宜）。
    if (!r || r.live) return;
    terminals.delete(record.terminalId);
    r.prime = [];
    r.primeBytes = 0;
    r.subscribers.clear();
    log("info", "terminal.reaped", { sandboxId: r.sandboxId, terminalId: r.terminalId, graceMs: REAP_GRACE_MS });
  };
  if (!(REAP_GRACE_MS > 0)) { fire(); return; }
  const timer = setTimeout(fire, REAP_GRACE_MS);
  // 卡在事件迴圈上會讓行程收不掉 —— 跟這個專案裡其他每一個計時器同一條規矩。
  timer.unref?.();
  reapers.set(record.terminalId, timer);
}

/**
 * 一個終端機的全部狀態。
 * @typedef {object} TerminalRecord
 * @property {string} terminalId
 * @property {string} sandboxId
 * @property {object} handle 後端給的 PTY handle。
 * @property {Set<Function>} subscribers 目前掛在 SSE 上的推送函式。
 * @property {Buffer[]} prime 開場重播環。
 * @property {number} primeBytes
 * @property {boolean} live
 * @property {number|null} exitCode
 * @property {number} cols
 * @property {number} rows
 * @property {boolean} attachedEver 有沒有人接上過（單向：一旦 true 就不再被孤兒回收碰）。
 * @property {NodeJS.Timeout|null} attachTimer 「沒人 attach 就回收」的期限計時器。
 */

function pushPrime(record, chunk) {
  // 已經有人在看了就不必再存 —— 那一段是「還沒有人接上」的補償，
  // 接上之後再留著只會把記憶體浪費在永遠不會重播的位元組上。
  if (record.subscribers.size > 0 && !record.authReplay) return;
  const retained = record.authReplay && chunk.length > PRIME_MAX_BYTES ? chunk.subarray(-PRIME_MAX_BYTES) : chunk;
  record.prime.push(retained);
  record.primeBytes += retained.length;
  while (record.primeBytes > PRIME_MAX_BYTES && record.prime.length > 1) {
    const dropped = record.prime.shift();
    record.primeBytes -= dropped.length;
  }
}

/**
 * 開一個終端機。後端不支援就讓它的錯誤原樣往上 ——
 * 「這個落點做不到」跟「壞了」是兩件事，呼叫端要分得出來。
 *
 * @param {object} args
 * @param {string} args.sandboxId
 * @param {object} args.backend 這個 sandbox 綁到的後端（cube/index.mjs 的 getBackend）。
 * @param {object} args.spec `{ cwd, cols, rows, env, approval }`
 * @param {number} [args.attachDeadlineMs] 沒人 attach 就回收的期限；預設讀 env。見 defaultAttachDeadlineMs。
 * @returns {Promise<{terminalId: string, cols: number, rows: number}>}
 */
export async function openTerminal(args) {
  const slot = args.spec?.slot;
  if (slot === undefined) return createTerminal(args);
  if (typeof slot !== "string" || !/^[a-zA-Z0-9._:-]{1,160}$/.test(slot)) {
    throw new SandboxError("invalid_terminal_slot", "Invalid terminal slot", 400);
  }
  const existing = [...terminals.values()].find(r => r.sandboxId === args.sandboxId && r.slot === slot && r.live);
  if (existing) return { terminalId: existing.terminalId, cols: existing.cols, rows: existing.rows };
  const key = `${args.sandboxId}:${slot}`;
  if (openingSlots.has(key)) return openingSlots.get(key);
  const pending = createTerminal(args);
  openingSlots.set(key, pending);
  try { return await pending; } finally { if (openingSlots.get(key) === pending) openingSlots.delete(key); }
}

async function createTerminal({ sandboxId, backend, spec = {}, attachDeadlineMs = defaultAttachDeadlineMs() }) {
  if (typeof backend?.openTerminal !== "function") {
    throw new SandboxError(
      "terminal_unsupported",
      "這個執行環境還不支援互動式終端機。",
      501,
      { backend: backend?.kind || null },
    );
  }
  const authReplay = !!officialAuthIntent(spec.env);
  const cols = Math.max(1, Math.trunc(Number(spec.cols) || 80));
  const rows = Math.max(1, Math.trunc(Number(spec.rows) || 24));
  const handle = await backend.openTerminal(sandboxId, { ...spec, cols, rows });

  const terminalId = `term-${randomUUID().slice(0, 12)}`;
  /** @type {TerminalRecord} */
  const record = {
    terminalId, sandboxId, handle, slot: spec.slot ?? null,
    subscribers: new Set(),
    prime: [], primeBytes: 0,
    // A login may be resumed from another browser. Replay only its bounded,
    // private CLI output; ordinary terminals retain their existing semantics.
    authReplay,
    live: true, exitCode: null,
    cols, rows,
    attachedEver: false, attachTimer: null,
  };
  terminals.set(terminalId, record);
  armAttachDeadline(record, attachDeadlineMs);

  handle.on("data", (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    pushPrime(record, buf);
    // **base64。** PTY 給的是位元組，不是文字：一個多位元組字元會被切在
    // 兩次 read 中間，跳脫序列更是常態。在這裡當成 UTF-8 解會產生替代字元，
    // 而那個損壞是不可逆的 —— 交給看得到整條串流的那一端（xterm.js）去接。
    const payload = buf.toString("base64");
    for (const push of record.subscribers) push("data", { data: payload });
  });

  handle.on("exit", (info) => {
    record.live = false;
    record.exitCode = typeof info?.code === "number" ? info.code : null;
    // 結束的不是孤兒：它在等寬限期回收，不需要再被期限計時器關一次。
    cancelAttachDeadline(record);
    for (const push of record.subscribers) {
      push("exit", { exit_code: record.exitCode, closed_by_client: info?.closedByClient === true });
    }
    log("info", "terminal.exit", { sandboxId, terminalId, exitCode: record.exitCode });
    // 翻旗標之後還要**排進回收**。少了這一行，這張表只會單向長大（見 REAP_GRACE_MS）。
    scheduleReap(record);
  });

  log("info", "terminal.open", { sandboxId, terminalId, cols, rows, backend: handle.terminalKind || null });
  return { terminalId, cols, rows };
}

/** @returns {TerminalRecord} */
function get(sandboxId, terminalId) {
  const record = terminals.get(String(terminalId || ""));
  if (!record || record.sandboxId !== sandboxId) {
    throw new SandboxError("terminal_not_found", `no terminal ${terminalId}`, 404);
  }
  return record;
}

/** 活著才收得下輸入；已經結束的終端機要明確地拒絕，不要安靜地吞掉按鍵。 */
function live(sandboxId, terminalId) {
  const record = get(sandboxId, terminalId);
  if (!record.live) {
    throw new SandboxError("terminal_exited", `terminal ${terminalId} has exited`, 409);
  }
  return record;
}

/** SSE：先補開場那一段，再轉成即時推送。 */
export function attachTerminal(sandboxId, terminalId, res) {
  const record = get(sandboxId, terminalId);
  // 第一次有人接上就不再是孤兒；之後斷線也不會變回去（見 defaultAttachDeadlineMs）。
  record.attachedEver = true;
  cancelAttachDeadline(record);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  // **標頭要在連上的那一刻送出。** `writeHead` 不送出標頭，要等第一次 write —— 開場重播環是空的（shell 還沒印任何
  // 東西）時，標頭要等到 20 秒的 `: beat`。flushHeaders ＋ 一行 `: ready`（註解行，不是事件）。
  // 跟 ava-engine/src/terminal-sse.mjs 是同一個缺陷、同一個修法（2026-10-02）。
  res.flushHeaders?.();
  try { res.write(": ready\n\n"); } catch { /* 對面走了 */ }
  const push = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 對面走了 */ }
  };

  if (record.prime.length) {
    push("data", { data: Buffer.concat(record.prime).toString("base64") });
    if (!record.authReplay) {
      record.prime = [];
      record.primeBytes = 0;
    }
  }
  if (!record.live) push("exit", { exit_code: record.exitCode, closed_by_client: false });

  record.subscribers.add(push);
  // 反向代理與閒置的連線會在沒有位元組時把 SSE 切掉，而一個開著沒在打字的
  // 終端機正好就是「長時間沒有位元組」。註解行不會被 EventSource 當成事件。
  const beat = setInterval(() => { try { res.write(": beat\n\n"); } catch { /* ignore */ } }, 20_000);
  beat.unref?.();
  res.on?.("close", () => { record.subscribers.delete(push); clearInterval(beat); });
  return true;
}

/** @param {string} dataBase64 使用者按的鍵，base64。 */
export async function writeTerminal(sandboxId, terminalId, dataBase64) {
  const record = live(sandboxId, terminalId);
  const buf = Buffer.from(String(dataBase64 || ""), "base64");
  if (!buf.length) return { bytes: 0 };
  const ok = await record.handle.write(buf);
  if (ok === false) throw new SandboxError("terminal_transport", "終端機收不下這次輸入", 502);
  return { bytes: buf.length };
}

export async function resizeTerminal(sandboxId, terminalId, cols, rows) {
  const record = live(sandboxId, terminalId);
  record.cols = Math.max(1, Math.trunc(Number(cols) || record.cols));
  record.rows = Math.max(1, Math.trunc(Number(rows) || record.rows));
  const ok = typeof record.handle.resize === "function"
    ? await record.handle.resize(record.cols, record.rows)
    : false;
  return { cols: record.cols, rows: record.rows, applied: ok !== false };
}

export async function signalTerminal(sandboxId, terminalId, signal) {
  const record = live(sandboxId, terminalId);
  const ok = typeof record.handle.signal === "function"
    ? await record.handle.signal(signal)
    : false;
  if (ok === false) {
    // 送不出去要明講是哪一種「送不出去」。SIGTERM／SIGKILL 在 tty 上沒有對應
    // 的按鍵，那不是壞掉 —— 那是「這個訊號要用關掉終端機來達成」。
    throw new SandboxError(
      "terminal_signal_unsupported",
      `這個終端機送不出 ${signal}。終端機能送的是鍵盤送得出來的那些（SIGINT／SIGQUIT／SIGTSTP）；`
        + `要強制結束請關掉這個終端機。`,
      501,
    );
  }
  return { signal };
}

export async function closeTerminal(sandboxId, terminalId) {
  const record = terminals.get(String(terminalId || ""));
  if (!record || record.sandboxId !== sandboxId) return { closed: false };
  // 已經排進回收就把計時器拆掉 —— 紀錄馬上就要不見了，留著一個指向它的計時器
  // 只是把它多留在記憶體裡五分鐘。
  cancelReap(record.terminalId);
  cancelAttachDeadline(record);
  terminals.delete(record.terminalId);
  record.live = false;
  try { await record.handle.close?.(); } catch { /* 已經死了也算關掉 */ }
  for (const push of record.subscribers) push("exit", { exit_code: record.exitCode, closed_by_client: true });
  record.subscribers.clear();
  return { closed: true };
}

export function listTerminals(sandboxId) {
  return [...terminals.values()]
    .filter((r) => r.sandboxId === sandboxId)
    .map((r) => ({
      terminal_id: r.terminalId, live: r.live, exit_code: r.exitCode, cols: r.cols, rows: r.rows,
      ...(r.slot ? { slot: r.slot } : {}),
    }));
}

/**
 * 沙盒被回收時把它的終端機一起收掉。
 *
 * 少了這一條，一個被釋放的沙盒會在這張表上留下一列指向已經不存在的容器的
 * handle —— 而且那個 PTY 行程可能還活著。
 */
export async function closeSandboxTerminals(sandboxId) {
  const mine = [...terminals.values()].filter((r) => r.sandboxId === sandboxId);
  await Promise.all(mine.map((r) => closeTerminal(sandboxId, r.terminalId)));
  return mine.length;
}

/** 測試/診斷用：這張表現在有幾列（活的＋還在寬限期裡的）。 */
export function _terminalCount() {
  return terminals.size;
}

/** 測試用：這一列的回收計時器排了沒有。 */
export function _hasReaper(terminalId) {
  return reapers.has(String(terminalId || ""));
}

/** 測試用：這一列的「沒人 attach 就回收」期限計時器還排著嗎。 */
export function _hasAttachDeadline(terminalId) {
  return Boolean(terminals.get(String(terminalId || ""))?.attachTimer);
}

/** 測試用：清空整張表。計時器也要拆，否則會在下一個測試裡開火。 */
export function _resetTerminals() {
  for (const t of reapers.values()) clearTimeout(t);
  reapers.clear();
  for (const r of terminals.values()) cancelAttachDeadline(r);
  terminals.clear();
}
