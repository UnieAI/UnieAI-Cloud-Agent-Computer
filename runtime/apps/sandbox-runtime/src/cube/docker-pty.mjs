/**
 * docker-pty.mjs —— 雲端沙盒裡的**真** PTY。
 *
 * 這是整個終端機功能在雲端唯一做得到的做法，而「為什麼不能用別的」值得寫下來，
 * 因為三條看起來會通的路各自有一個只有實測才看得到的牆：
 *
 * 1. **`docker exec -it` 走 CLI —— 不行。** 實測（2026-09-06）：
 *
 *        $ echo 'echo hi' | docker exec -i -t <c> bash
 *        the input device is not a TTY
 *
 *    `-t` 要求 **CLI 自己的 stdin** 是終端機，因為它要把本機的 tty 切成 raw
 *    模式。我們是一個 HTTP 伺服器，stdin 是管道，永遠不會是 tty。
 *    （只有 `-t` 不帶 `-i` 是會過的 —— `tty` 回 `/dev/pts/0` —— 但那樣就沒有
 *    輸入，也就不是終端機了。）
 *
 * 2. **`docker exec -i <c> script -qec bash /dev/null` —— 半個。** `script`
 *    會在容器**裡面**配一個 PTY，所以互動是通的。但那個 PTY 的 master 握在
 *    `script` 手上，外面沒有任何管道對它下 `TIOCSWINSZ` ——
 *    **改不了視窗大小**。少了 resize，`vim`／`htop`／任何全螢幕程式都會畫在
 *    錯的格線上，而且是安靜地錯。
 *
 * 3. **Docker Engine API —— 這一條。** `exec` 帶 `Tty:true` 之後：
 *    連線被 hijack 成一條**雙向的 raw socket**（`Tty:true` 時**不會**有
 *    stdout/stderr 的多工標頭，所以不必解 8 位元組的 frame header），
 *    而且多了一支 `POST /exec/{id}/resize?h=&w=`。
 *
 *    2026-09-06 用 debian:stable-slim 實測，一次跑完三件事：
 *
 *        resize: 200
 *        stty size          → 42 137          ← resize 真的到了
 *        sleep 30 ; \x03    → ^C
 *        echo $?            → 130             ← SIGINT 真的到了前景行程群組
 *
 * ## 訊號是**位元組**，不是 API 呼叫
 *
 * 有了真的 tty，Ctrl-C 就不需要（也不應該）走旁路的 signal API：把 `0x03`
 * 寫進 PTY，tty 的 line discipline 會自己把 SIGINT 送給**前景行程群組** ——
 * 那正是鍵盤上那顆鍵做的事，也正是 xterm.js 送出來的東西（瀏覽器從來不會送
 * 「SIGINT」這個字，它送一個位元組）。所以 `/signal` 這個端點在雲端就是
 * 「幫你按那顆鍵」。
 *
 * 這樣做**比**旁路訊號正確：程式把 tty 切到 raw 模式時（vim、less、任何全螢幕
 * 程式），`0x03` 會照原樣變成一個位元組送進去 —— 那也正是真終端機的行為。
 * 代價寫在下面 `signal()` 的註解裡。
 */

import { EventEmitter } from "node:events";
import http from "node:http";

import { SandboxError } from "../shared/error.mjs";

/**
 * 我們**偏好**的 Engine API 版本。釘住而不是用最新版：resize 與 hijack 的語意
 * 從 1.24 起就沒動過，而不釘版本的話一次 docker 升級就可能改掉回應形狀，
 * 那種壞法只會在生產環境出現。
 *
 * 但釘子要有下限 —— 見 pickApiVersion。
 */
const PREFERRED_API_VERSION = "v1.43";

/** `1.44` → 10044；看不懂回 null（不是 0 —— 0 會讓垃圾靜靜通過）。 */
function versionRank(v) {
  const m = /^v?(\d+)\.(\d+)$/.exec(String(v ?? "").trim());
  return m ? Number(m[1]) * 1000 + Number(m[2]) : null;
}

/**
 * 這次要用哪一版 Engine API。
 *
 * ── 為什麼需要這個函式（2026-09-08 線上）──────────────────────────────────
 * 使用者按「開終端機」看到「現在連不上終端機」，往下追是：
 *
 *   client version 1.43 is too old. Minimum supported API version is 1.44
 *
 * 這台的 Docker 是 29.1.3（API 1.52、最低 1.44），而我們釘死在 1.43。
 * **daemon 會升它的最低版本**，而一個釘死的客戶端遲早會掉到那條線以下。
 *
 * 修法不是拿掉釘子（那等於把上面那個保護還回去），是給它一個下限：
 * daemon 說的最低比我們偏好的新時，就用**daemon 的最低** —— 那是「還能用的
 * 最舊的一版」，離「不要騎在最新版上」這個原意最近。
 *
 * 問不到就退回偏好版本：猜一個新的等於偷偷拿掉釘子，而退回至少維持今天的
 * 行為，真的不相容時 daemon 會照實說（就像這次那樣）。
 */
export function pickApiVersion({ preferred = PREFERRED_API_VERSION, daemonMin = null } = {}) {
  const want = versionRank(preferred);
  const min = versionRank(daemonMin);
  if (want === null || min === null) return preferred;
  return min > want ? `v${String(daemonMin).replace(/^v/, "")}` : preferred;
}

/**
 * 這個行程這次要用的版本。第一次呼叫 Docker 之前問一次 `/version`（那支不帶
 * 版本前綴，任何 daemon 都收），之後沿用 —— daemon 不會在行程活著的時候換版。
 */
let negotiated = null;
async function apiVersion() {
  if (negotiated) return negotiated;
  let daemonMin = null;
  try {
    // `api()` 回的是 `{status, text}`，**不是**解析好的 body。
    // 我第一版寫成 `res.body.MinAPIVersion`，於是它永遠是 undefined、
    // 協商永遠不發生，而症狀跟沒改之前一模一樣（1.43 太舊）——
    // 一個「修好了但沒生效」的修法，比沒修更難發現。
    const res = await api("GET", "/version");
    if (res?.status === 200) daemonMin = JSON.parse(res.text)?.MinAPIVersion ?? null;
  } catch {
    // 問不到就用偏好版本 —— pickApiVersion 對 null 的處理就是這件事。
  }
  negotiated = pickApiVersion({ daemonMin });
  return negotiated;
}

/** `DOCKER_HOST=unix:///…` 或預設的 socket。TCP 形式的 DOCKER_HOST 不支援 —— 明講。 */
function dockerSocketPath() {
  const raw = String(process.env.DOCKER_HOST || "").trim();
  if (!raw) return "/var/run/docker.sock";
  if (raw.startsWith("unix://")) return raw.slice("unix://".length);
  throw new SandboxError(
    "terminal_unsupported",
    `終端機需要直接連 Docker 的 unix socket，但 DOCKER_HOST 是 "${raw}"。`
      + `目前只支援 unix:// 形式（TCP 的 daemon 要另外做 TLS 與位址設定）。`,
    501,
  );
}

/** 一次普通的 Engine API 呼叫（非 hijack）。 */
function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      {
        socketPath: dockerSocketPath(),
        method,
        path,
        headers: payload
          ? { "content-type": "application/json", "content-length": payload.length }
          : {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", (err) => reject(new SandboxError(
      "terminal_transport", `連不上 Docker：${err?.message || err}`, 502,
    )));
    if (payload) req.write(payload);
    req.end();
  });
}

/** PTY 尺寸一律夾住，不拒絕 —— 理由見 registry.mjs 的 clampSize。 */
function clamp(value) {
  if (!Number.isFinite(Number(value))) return 1;
  return Math.max(1, Math.trunc(Number(value)));
}

/**
 * 在一個已經在跑的容器裡開一個互動式終端機。
 *
 * @param {object} opts
 * @param {string} opts.containerId 容器 id。
 * @param {string} [opts.cwd] 起始目錄；不存在時 docker 會直接讓 exec 失敗，所以由呼叫端保證。
 * @param {number} [opts.cols] 初始欄數。
 * @param {number} [opts.rows] 初始列數。
 * @param {Record<string,string>} [opts.env] 額外環境變數。
 * @param {string[]} [opts.argv] 要跑的程式；預設就是一個 bash。
 * @returns {Promise<EventEmitter>} handle：`data` / `exit` 事件 ＋ write／resize／signal／close。
 */
export async function openDockerTerminal({
  containerId, cwd, cols = 80, rows = 24, env = {}, argv = null,
} = {}) {
  if (!containerId) throw new SandboxError("bad_request", "openDockerTerminal 需要 containerId", 400);

  // **不加 `-l`，也不加 `--noprofile --norc`。**
  //
  // 這兩個極端各自屬於另一個人：`--noprofile --norc` 是**模型**要的（每台機器
  // 上遇到同一個 shell，見 UAD 的 terminal-bash）；`-l` 會變成 login shell，
  // 讀 `.bash_profile` 而**跳過** `.bashrc` —— 而使用者的 alias、prompt、
  // 補完幾乎都寫在 `.bashrc` 裡。人要的是他自己的 shell，所以什麼旗標都不帶：
  // 在 PTY 上 bash 光憑「有終端機」就會判定自己是互動式並讀 `.bashrc`。
  // Linux 的終端機模擬器全都是這樣開的。
  const cmd = Array.isArray(argv) && argv.length ? argv.map(String) : ["/bin/bash"];

  // TERM／COLORTERM：shell 與它跑起來的每一個全螢幕程式都靠這兩個決定可以吐
  // 哪些跳脫序列。少了 TERM，`vim` 會說 terminal is not fully functional。
  // HOME/USER 跟 execProcess 同一個理由（容器裡的 uid 1000 是 user）。
  const envPairs = Object.entries({
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    ...(env || {}),
    HOME: "/home/user",
    USER: "user",
  }).map(([k, v]) => `${k}=${v}`);

  const created = await api("POST", `/${await apiVersion()}/containers/${encodeURIComponent(containerId)}/exec`, {
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Cmd: cmd,
    Env: envPairs,
    ...(cwd ? { WorkingDir: String(cwd) } : {}),
  });
  if (created.status !== 201) {
    throw new SandboxError(
      "terminal_start_failed",
      `Docker 開不了終端機 (${created.status}): ${created.text.slice(0, 200)}`,
      502,
    );
  }
  let execId;
  try { execId = JSON.parse(created.text).Id; } catch { execId = null; }
  if (!execId) throw new SandboxError("terminal_start_failed", "Docker 沒有回 exec id", 502);

  const handle = new EventEmitter();
  handle.terminalKind = "docker";
  handle.execId = execId;

  let socket = null;
  let exited = false;
  let closedByUs = false;

  const settle = async () => {
    if (exited) return;
    exited = true;
    // 退出碼要另外問 —— hijack 的串流結束時不帶它。問不到就送 null，
    // 因為「猜一個 0」會讓面板顯示「正常結束」，而它可能是被砍掉的。
    let code = null;
    try {
      const insp = await api("GET", `/${await apiVersion()}/exec/${execId}/json`);
      if (insp.status === 200) {
        const parsed = JSON.parse(insp.text);
        if (typeof parsed?.ExitCode === "number") code = parsed.ExitCode;
      }
    } catch { /* 問不到就 null */ }
    handle.emit("exit", { code, closedByClient: closedByUs });
  };

  // 先算好版本再進 Promise —— 那個 executor 是同步的，裡面不能 await。
  const startVersion = await apiVersion();
  await new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: true }), "utf8");
    const req = http.request({
      socketPath: dockerSocketPath(),
      method: "POST",
      path: `/${startVersion}/exec/${execId}/start`,
      headers: {
        "content-type": "application/json",
        "content-length": payload.length,
        Connection: "Upgrade",
        Upgrade: "tcp",
      },
    });
    // `Tty:true` ⇒ 這條 socket 是 raw 的雙向位元組流，**沒有** docker 那個
    // 8 位元組的 stream 多工標頭（那只在 Tty:false 時才有）。所以收到什麼就
    // 是什麼，不要在這裡解 frame。
    req.on("upgrade", (_res, sock) => {
      socket = sock;
      sock.on("data", (chunk) => handle.emit("data", chunk));
      sock.on("close", () => { void settle(); });
      sock.on("error", (err) => {
        handle.emit("error", err);
        void settle();
      });
      resolve();
    });
    req.on("error", (err) => reject(new SandboxError(
      "terminal_transport", `接不上終端機：${err?.message || err}`, 502,
    )));
    // 沒有 upgrade 就代表 docker 用一般回應拒絕了我們 —— 那是錯誤，不是終端機。
    req.on("response", (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => reject(new SandboxError(
        "terminal_start_failed",
        `Docker 沒有把連線升級成終端機 (${res.statusCode}): ${text.slice(0, 200)}`,
        502,
      )));
    });
    req.end(payload);
  });

  handle.write = (data) => {
    if (exited || !socket) return false;
    try {
      socket.write(Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8"));
      return true;
    } catch (err) {
      handle.emit("error", err);
      return false;
    }
  };

  handle.resize = async (nextCols, nextRows) => {
    if (exited) return false;
    const h = clamp(nextRows);
    const w = clamp(nextCols);
    const res = await api("POST", `/${await apiVersion()}/exec/${execId}/resize?h=${h}&w=${w}`);
    // 200 是正常；行程剛好在這一刻結束會回 500 —— 那不是使用者做錯什麼，
    // 而 resize 失敗一律不該把一次普通的重繪變成一個錯誤（見 registry 的註解）。
    return res.status === 200;
  };

  /**
   * 訊號 → tty 的控制位元組。
   *
   * **這是刻意的，不是偷懶。** 真的終端機沒有「送訊號」這個動作：Ctrl-C 是一個
   * 位元組，tty 的 line discipline 收到之後才把 SIGINT 發給**前景行程群組**。
   * 走這條路我們自動拿到「該收到的人收到」這件事，不必自己去容器裡找哪個
   * pgid 在前景（那需要讀 /proc，而且會有 race）。
   *
   * **代價**（要講清楚）：程式把 tty 切成 raw 模式時（vim、less、fzf…），
   * 這個位元組會照原樣送進去而不產生訊號 —— 那跟真終端機一模一樣，所以對
   * **人**是對的。但也因此 SIGINT 不保證砍得掉東西；砍不掉時的出路是關掉
   * 這個終端機（`close()`，走 SIGKILL 那條）。
   *
   * SIGTERM／SIGKILL 沒有對應的按鍵，tty 送不出去 —— 回 false 讓呼叫端明講，
   * 不要假裝送出去了。
   */
  handle.signal = (name) => {
    const byte = { SIGINT: 0x03, SIGQUIT: 0x1c, SIGTSTP: 0x1a, EOF: 0x04 }[String(name || "").toUpperCase()];
    if (byte === undefined) return false;
    return handle.write(Buffer.from([byte]));
  };

  handle.close = async () => {
    closedByUs = true;
    if (socket) {
      // shell 收到 EOF 就會自己收乾淨（跟關掉終端機視窗一樣）；接著砍 socket，
      // docker 會對 exec 的行程樹送 SIGKILL。
      try { socket.write(Buffer.from([0x04])); } catch { /* ignore */ }
      try { socket.end(); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
    }
    await settle();
  };

  return handle;
}
