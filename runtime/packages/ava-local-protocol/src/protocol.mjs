/**
 * protocol.mjs — the frames that travel between sandbox-runtime's relay and
 * the Rabi Local daemon. One JSON object per newline-terminated line (the same
 * framing DeepSeek Harness uses for its SDK, so a later bridge is a mapping,
 * not a rewrite).
 *
 * Down (relay → daemon, over the SSE stream the daemon opened):
 *   ready  { connId }
 *   ping   { ts }
 *   invoke { id, op, args, approval?, deadlineMs? }
 *   revoke { reason }
 * Up (daemon → relay, as POST bodies):
 *   hello  { machine: { platform, arch, daemonVersion, grantedRoot }, ops }
 *   result { id, ok, output }          (output.error = { code, message } when !ok)
 */

/**
 * 本機 MCP server 的兩個 op（`mcpList` / `mcpCall`）。
 *
 * 使用者自己電腦上跑的 MCP server（SlideWork、一個接他 IDE 的 server、…）
 * 雲端**連不到**：那台機器沒有對外的埠，而那是刻意的。所以 MCP 不再是「在
 * 資料庫裡登記一個網址、由引擎去連」，而是走 daemon 本來就有的那條外撥長連線：
 * 雲端把「呼叫哪一個 server 的哪一個工具」當成一個 frame 推下來，daemon 在
 * **本機**跟那個 server 講話（stdio），把結果 POST 回去。
 *
 *   mcpList { server? }
 *     → { servers: [{ id, description, tools: [ MCP tool 原樣 ], error? }] }
 *     使用者**明確授權過**的那幾台，以及它們現在真的有的工具。沒授權的不會
 *     出現在這裡 —— 這份清單就是授權清單，不是「daemon 在這台電腦上找到什麼」。
 *
 *   mcpCall { server, tool, arguments }
 *     → { content, structuredContent?, isError }  （MCP tools/call 的結果原樣）
 *     **預設每一次都要核准票**（`approvalSubject("mcpCall", …)`）。例外只有
 *     一種：使用者自己在授權檔裡把某個工具標成唯讀（`readOnlyTools`）。
 *     為什麼不靠 server 自己回報的 `annotations.readOnlyHint`：那句話是被呼叫
 *     的那個程式自己說的，而它正是我們在防的東西。
 *
 * **雲端永遠只能說 server 的 id，說不出指令。** 要跑什麼程式、在哪個資料夾、
 * 帶哪些環境變數，全部只從使用者電腦上的授權檔讀 —— frame 裡放 `command` 是
 * 讀都不會讀的。少了這一條，一個「本機 MCP」的 op 就等於一個沒有分級、沒有
 * 遮蔽、繞過 `classifyCommand` 的 `exec`。
 */
export const PROTOCOL_VERSION = 1;

export const FRAME_TYPES = Object.freeze(["ready", "ping", "hello", "invoke", "result", "revoke"]);

/**
 * Every operation the cube contract can ask a machine to perform, plus cancel
 * and the interactive terminal.
 *
 * THE TERMINAL OPS ARE NOT `exec` WITH EXTRA STEPS. `exec` is one command with
 * one answer; a terminal is a long-lived thing a PERSON types into, so it needs
 * an identity that outlives any single call (`terminalId`), a way to send bytes
 * mid-flight, a window size, and the interrupt keys.
 *
 *   terminalOpen   { cwd?, cols?, rows?, env? }
 *                  STREAMS, and the INVOKE ID IS THE TERMINAL. This invocation
 *                  stays open for the terminal's whole life; every follow-up
 *                  call names it as `args.id`, the same nail a long-lived
 *                  process uses. Its partial results carry `{ dataBase64 }` —
 *                  raw PTY bytes, never decoded on the way — and it settles
 *                  when the shell exits, with `{ exit: { code, signal } }`.
 *                  Two nested partials describe the terminal rather than its
 *                  output: `{ terminal: { event: "opened", … } }` once at the
 *                  start, and `{ terminal: { event: "alive" } }` while nothing
 *                  is happening.
 *   terminalInput  { id, dataBase64 }           keystrokes, exactly as typed
 *   terminalResize { id, cols, rows }
 *   terminalSignal { id, signal }               SIGINT / SIGQUIT / SIGTSTP /
 *                                               SIGTERM / SIGKILL
 *   terminalClose  { id }
 *   terminalReplay { id }                       the retained output, base64
 *
 * OUTPUT IS BASE64 OF THE RAW BYTES, decoded by the terminal emulator and by
 * nothing in between. A multi-byte character split across two PTY reads is the
 * normal case, not an edge one, and any layer that decodes early turns it into
 * a replacement character that no later layer can undo.
 *
 * `terminalReplay` exists so that a cloud side which LOSES the open invocation
 * (a reconnect, a restarted service) can repaint instead of showing a blank
 * rectangle in front of a shell that is still running. It is shipped now and
 * not when that reconnect is built, because every change to this daemon costs
 * every user a reinstall.
 *
 * WHY OUTPUT RIDES THE OPEN INVOCATION rather than an unsolicited event: the
 * relay correlates everything by invoke id (`registry.mjs`), and an event with
 * no pending invocation is dropped on the floor. Keeping the open call pending
 * means the terminal's output uses the SAME path — and the same ordering
 * guarantees — as an `exec`'s stdout, with no new channel to get wrong.
 */
export const OPS = Object.freeze([
  "browserSetup", "exec", "readFile", "writeFile", "statFile", "listFiles", "deleteFile", "ensureDir", "cancel",
  /**
   * 大檔上傳（ava-local/src/file-pages.ts）。
   *
   *   writeFileChunk { uploadId, offset, dataBase64 } → { uploadId, received }
   *     只寫進 daemon 自己的暫存資料夾，不碰授權資料夾，所以不要票。依序、
   *     不重疊；offset 不對就回 `offset_mismatch` 並說該從哪裡接。
   *   writeFile { path, stagedId, size? }
   *     把暫存落地。核准票跟單一 frame 的 writeFile **同一個 subject**
   *     （`{ path, contentSha256 }`），雜湊由 daemon 從暫存自己算。
   *
   * 讀的那一半不需要新名字：`readFile { path, offset?, length? }` 帶了 range
   * 就回一頁，並附上舊 daemon 從來不回的 `bytesRead`/`eof`/`size` —— 呼叫端
   * 靠那幾格分辨新舊。
   */
  "writeFileChunk",
  /**
   * 位元組安全的讀取（0.2.27）。`readFile` 是文字分頁器（utf8 → 遮蔽 → 重新編碼），
   * 對 xlsx／zip／png 會把每個無效位元組悄悄變成 U+FFFD。**這是另一個 op 而不是
   * `readFile` 的參數**：舊 daemon 不認得名字就會明確拒絕，呼叫端靠 `hello.ops`
   * 分辨新舊 —— 一個被舊 daemon 默默忽略的參數會讓下載拿到壞檔。
   *
   *   readFileBytes { path, offset?, length? } →
   *     { contentBase64, size, offset, bytesRead, eof, encoding: "binary" | "text" }
   *
   * 二進位與否由 daemon 看內容決定（前 64 KB 有 NUL，或不是合法 UTF-8），呼叫端無法指定；
   * 文字一律照舊遮蔽，`.env`／`.pem`／`.key` 等**檔名**就是祕密的檔案永遠走文字路徑。
   */
  "readFileBytes",
  "terminalOpen", "terminalInput", "terminalResize", "terminalSignal", "terminalClose", "terminalReplay",
  "mcpList", "mcpCall",
  /**
   * 本機代理（DSH 跑在使用者自己的電腦上）。
   *
   * **這三個名字漏了兩個月。** `agentSession` 在 `canonical.mjs` 有 subject、在
   * `daemon-caps.ts` 有功能列、在 `tool-host.ts:665` 有完整實作、`relay.mjs` 有
   * 呼叫端 —— 唯獨不在這份清單裡。後果是 invoke frame 一到 daemon 就被
   * `transport.ts` 當成 `bad_shape` 丟掉（log 只印一行 `dropped frame`），雲端
   * 等到 relay 的 120 秒逾時，使用者看到的錯誤是「你的電腦沒回應」—— 指向網路，
   * 而真正的原因是一個字串不在一個陣列裡。
   *
   * 沒被發現是因為這條路預設關著。這正是這棵樹反覆出過的形狀：**每一層都宣告
   * 了，中間少一格，而每一層的測試都只驗自己那一格**。所以下面
   * `protocol-ops-cover-tool-host.test.mjs` 改成驗「`tool-host` 實作的每一個 op
   * 名字都在這裡」—— 驗的是兩層之間的關係，不是任何一層自己。
   */
  "agentSession", "agentSessionInput", "agentSessionClose",
  // 這台機器、這個模式的本機代理會掛哪些 DSH 外掛（唯讀，不需要核准票）。
  "pluginInventory",
  "nativeHarness",
  // DSH management over the paired relay. Writes require exact MCP-style approval.
  "pluginManage",
  // 自動更新（update.ts）。這三個不碰授權資料夾、也不需要核准票 —— daemon
  // 只裝我們的私鑰簽過的東西，所以閘門在簽章，不在這條通道上。
  "updateCheck", "updateApply", "updateStatus",
  /**
   * 裝置簽的核准，它的兩個管理 op（device-keys.ts）。
   *
   *   deviceList   {} → { devices: [{ credentialId, label, addedAt }], deviceOnly, … }
   *     這台電腦信任哪幾把公鑰。**唯讀，而且裡面沒有秘密**：公鑰就是公鑰，
   *     credentialId 是瀏覽器要用來指名「用哪一把簽」的東西。
   *
   *   deviceEnroll { enrollment, by? } → { ok, devices, deviceOnly }
   *     加一把新的公鑰，或撤掉一把。**這一個 op 不看核准票**，因為它自己就是
   *     簽章驗證：`verifyEnrollment` 要嘛看到一把已信任的金鑰簽過這次請求，
   *     要嘛這台機器一把都還沒有（第一把＝配對時人就在電腦前）。雲端在這條路
   *     上說什麼都不算數 —— 它連自己的公鑰都加不進去，那是整個方案的支點。
   */
  "deviceList", "deviceEnroll", "machineSelect", "sessionAuthorize",
]);

export function encodeFrame(frame) {
  return `${JSON.stringify({ v: PROTOCOL_VERSION, ...frame })}\n`;
}

const isStr = (v) => typeof v === "string" && v.length > 0;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

const SHAPES = {
  ready: (f) => isStr(f.connId) || f.connId === undefined,
  ping: () => true,
  revoke: () => true,
  invoke: (f) => isStr(f.id) && OPS.includes(f.op) && isObj(f.args),
  result: (f) => isStr(f.id) && typeof f.ok === "boolean",
  hello: (f) =>
    isObj(f.machine) &&
    isStr(f.machine.platform) &&
    isStr(f.machine.arch) &&
    isStr(f.machine.daemonVersion) &&
    isStr(f.machine.grantedRoot) &&
    Array.isArray(f.ops),
};

/**
 * @param {string} line
 * @returns {{ ok: true, frame: object } | { ok: false, reason: "malformed"|"unsupported_version"|"unknown_type"|"bad_shape" }}
 */
export function parseFrame(line) {
  let frame;
  try {
    frame = JSON.parse(String(line).trim());
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isObj(frame) || typeof frame.v !== "number") return { ok: false, reason: "malformed" };
  if (frame.v > PROTOCOL_VERSION) return { ok: false, reason: "unsupported_version" };
  if (!FRAME_TYPES.includes(frame.type)) return { ok: false, reason: "unknown_type" };
  if (!SHAPES[frame.type](frame)) return { ok: false, reason: "bad_shape" };
  return { ok: true, frame };
}
