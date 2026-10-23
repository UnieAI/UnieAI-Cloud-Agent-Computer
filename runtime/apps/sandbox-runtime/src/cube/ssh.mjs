/**
 * cube/ssh.mjs — 執行後端：指令跑在「使用者自己的機器」上，經由 SSH。
 *
 * 用途：企業機房 on-prem —— copilot-v2 裝在客戶機房，員工在同一內網，
 * agent 的指令與檔案讀寫發生在員工自己的電腦上，機房那台只負責 agent loop。
 * 設計與決策見 plans/ssh-machine-backend.md。
 *
 * 與 docker.mjs 的關係：介面完全相同（cube/CONTRACT.md），但這裡沒有容器 ——
 * 所以 docker.mjs 八成的程式碼（建容器、等 weed-mount、孤兒回收、記憶體/CPU 上限）
 * 在這裡不存在。真正跑指令的機制是同一個：spawn 一個子行程，把 stdout/stderr/exit
 * 轉成事件。只是執行檔從 `docker` 換成 `ssh`。
 *
 * 三個「不照做就會壞」的行為，來自 UnieAI-Agent-Desktop packages/ssh/subprocess-ssh
 * 的實機驗證（那邊已經踩過，這裡直接照抄結論）：
 *
 *   1. 遠端指令會活過連線。殺掉本地 ssh 客戶端，遠端指令還在跑。所以連線不是行程的
 *      握把，pid file 才是：遠端 shell 先寫下自己的 pid 再 exec，中止時另開一條
 *      （多工，很便宜）連線對那個 process group 送訊號。打 group 才殺得到子孫。
 *   2. 客戶端 exit 255（或被訊號）是「連線」結束，說明不了遠端行程的死活。
 *      此時刪掉 pid file 等於扔掉唯一的握把 —— 只有非 255 的離開碼才代表指令真的結束。
 *   3. BatchMode=yes 是必要的，不是保險。沒有它，OpenSSH 會直接開 /dev/tty 要密碼
 *      （pipe stdin 擋不住），結果是整條指令無聲卡死。有它才會變成可顯示、
 *      使用者可以處理的 "Permission denied (publickey)"。
 */

import { spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";

import { createCertMinter } from "./ssh-ca.mjs";
import { SandboxError } from "../shared/error.mjs";
import { log } from "../shared/log.mjs";

/** ControlMaster socket 放哪。
 *
 *  路徑長度是有後果的：OpenSSH 把 %C 展開成 40 字元摘要後，若綁定路徑超過平台的
 *  sun_path 上限（Linux 108 bytes、macOS 104），它會拒絕「整條連線」而不是只關掉
 *  多工。所以這裡刻意用短路徑，而且檢查的是展開後的長度。 */
const CONTROL_DIR = process.env.SSH_CONTROL_DIR || "/tmp/.uac2-ssh";
const CONTROL_PERSIST_SEC = parseIntEnv(process.env.SSH_CONTROL_PERSIST_SEC, 300);
const CONNECT_TIMEOUT_SEC = parseIntEnv(process.env.SSH_CONNECT_TIMEOUT_SEC, 10);

/** 遠端存放 pid file 的地方（使用者家目錄下，不碰他的專案）。 */
const REMOTE_RUN_DIR = '"$HOME"/.unieai/run';

function parseIntEnv(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * ControlPath 的目錄必須先存在 —— OpenSSH 不會建它，綁不上就整條連線失敗
 * （`unix_listener: cannot bind to path ...: No such file or directory`，
 * 客戶端 exit 255），而不是只是失去多工。
 *
 * 同時檢查展開後的長度：OpenSSH 把 %C 換成 40 字元摘要，再為暫時綁定加一個
 * 約 17 字元的隨機尾碼，全部要塞進 sockaddr_un.sun_path（Linux 108、macOS 104）。
 * 超過就「連線整條被拒」。所以太長時寧可放棄多工也不要失去機器 ——
 * 慢，好過連不上。
 */
const SUN_PATH_MAX = process.platform === "darwin" ? 104 : 108;
const CONTROL_PATH_BUDGET = 40 /* %C */ + 3 /* "/c-" */ + 20 /* 綁定用的隨機尾碼 */;
const MULTIPLEX_OK = CONTROL_DIR.length + CONTROL_PATH_BUDGET < SUN_PATH_MAX;

let controlDirReady = false;
function ensureControlDir() {
  if (controlDirReady || !MULTIPLEX_OK) return;
  try {
    mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
    controlDirReady = true;
  } catch (err) {
    log("warn", "ssh.control_dir_failed", { dir: CONTROL_DIR, error: err?.message });
  }
}

if (!MULTIPLEX_OK) {
  log("warn", "ssh.multiplexing_disabled", {
    dir: CONTROL_DIR, reason: "control path would exceed sun_path limit", limit: SUN_PATH_MAX,
  });
}


/** 跟作業系統要一個現在沒人用的本地埠。綁 0、讀號碼、放掉。 */
function freeLocalPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** POSIX 單引號跳脫：把任意字串包成可以安全丟進遠端 shell 的一個 word。 */
export function shq(s) {
  return `'${String(s ?? "").replace(/'/g, `'\\''`)}'`;
}

/**
 * 把 workspace 相對路徑接到這台機器的 root 底下，並在「字面上」擋掉 ..。
 *
 * 這只是第一道。symlink 繞得過字面檢查，所以真正的邊界在 guardPrelude() ——
 * 在遠端解析完再比一次。兩道都要，因為字面檢查便宜（省掉一次 round trip 才發現
 * 路徑根本不合法），而遠端檢查才是有效的那道。
 */
export function joinRoot(root, filePath) {
  const rel = String(filePath || "")
    .replace(/^\/workspace(\/|$)/, "/")   // 相容既有呼叫端的 /workspace 前綴
    .replace(/^\/+/, "");
  // 尾端斜線一定要去掉：dirname("/ws/") 是 "/" 而不是 "/ws" —— 留著的話，
  // 「列出工作區根目錄」這個最常見的操作會被自己的越界檢查擋下來。
  const joined = path.posix
    .normalize(`${root.replace(/\/+$/, "")}/${rel}`)
    .replace(/(.)\/+$/, "$1");
  if (joined !== root && !joined.startsWith(`${root.replace(/\/+$/, "")}/`)) {
    throw new SandboxError("workspace_escape", `path escapes workspace root: ${filePath}`, 400);
  }
  return joined;
}

/**
 * 一段遠端 shell 前綴：確認 $F 落在 $R 底下，不是就 exit 77。之後 $P 是要操作的
 * 路徑、$D 是它的父目錄。
 *
 * 難點是「還不存在的路徑」—— 每一次建檔、建目錄都是這種。所以不能直接
 * canonicalize $F（它還不在），而是從它的父目錄往上找到最近一個「存在的目錄」，把那個解析開來
 * 比對；剩下那段既然不存在，就不可能藏著 symlink 把人帶出去。
 *
 * 起點分兩種：$F 本身是目錄就檢查它自己，否則檢查它的父目錄。兩邊都要 ——
 * 一律從 $F 開始，讀一個現有檔案會變成「cd 進一個檔案」而失敗；一律從父目錄開始，
 * 列出工作區根目錄會變成在檢查根目錄的「上一層」而被判越界。symlink 兩種都擋得住，
 * 因為 -d 會跟著 symlink 走，cd -P 解出來的是它真正指向的地方。
 *
 * 用 `cd` + `pwd -P` 而不是 realpath / readlink -f —— 後兩者在 BSD/macOS 上不存在
 * 或拼法不同（fs-ssh 的結論）。$R 自己也要先解析一次，否則一個「授權目錄本身是
 * symlink」的部署會把每個合法路徑都判成越界。
 */
function guardPrelude(root, remotePath) {
  return [
    `F=${shq(remotePath)}; R0=${shq(root.replace(/\/+$/, ""))};`,
    `R=$(cd -P -- "$R0" 2>/dev/null && pwd -P) || { echo "__NOROOT__" >&2; exit 79; };`,
    // 往上走到第一個存在的祖先
    `if [ -d "$F" ]; then A="$F"; else A=$(dirname -- "$F"); fi;`,
    `while [ ! -d "$A" ] && [ "$A" != "/" ] && [ "$A" != "." ]; do A=$(dirname -- "$A"); done;`,
    `C=$(cd -P -- "$A" 2>/dev/null && pwd -P) || { echo "__NODIR__" >&2; exit 78; };`,
    `case "$C" in "$R"|"$R"/*) ;; *) echo "__ESCAPE__" >&2; exit 77;; esac;`,
    // 整條都存在時用解析後的路徑（symlink 已在上面被攔下），否則用字面路徑
    `if [ -e "$F" ]; then P="$(cd -P -- "$(dirname -- "$F")" && pwd -P)/$(basename -- "$F")"; else P="$F"; fi;`,
    `D=$(dirname -- "$P");`,
  ].join(" ");
}

/**
 * stat 有兩種方言：GNU/busybox 吃 `stat -c`，BSD/macOS 吃 `stat -f`。
 * 不能用 uname 猜 —— Linux 上可能裝著 BSD 工具，Mac 上可能透過 Homebrew 裝了 GNU 的。
 * 所以每個指令自己帶 fallback：先試 -c，失敗再試 -f。一次 round trip，不用先探測。
 */
function statExpr(varName) {
  return `stat -c '%s:%Y:%F' "${varName}" 2>/dev/null || stat -f '%z:%m:%HT' "${varName}" 2>/dev/null`;
}

/** 建立一個 SSH 執行後端。
 *
 *  @param resolveTarget 由呼叫端提供：從 createSandbox 的參數解析出這個 session
 *         該連到哪台機器。正式版讀 user_machines 表；測試時直接給一個固定值。
 */
export function createSshClient({ resolveTarget, certMinter } = {}) {
  /** sandboxId -> { target, createdAt, sessionId, userId } */
  const sandboxes = new Map();
  /** processHandle -> { sandboxId, handle, command } */
  const processes = new Map();

  const resolve = resolveTarget || defaultResolveTarget;
  const minter = certMinter || createCertMinter();

  function getSandbox(sandboxId) {
    const entry = sandboxes.get(sandboxId);
    if (!entry) throw new SandboxError("sandbox_not_found", `no such sandbox: ${sandboxId}`, 404);
    return entry;
  }

  /**
   * 取得 sandbox，並確保它的憑證還沒過期。
   *
   * 續簽掛在「每次操作之前」而不是計時器上：一條閒置兩小時的 session 不該持續消耗
   * 簽發，而它醒來時要能立刻用。憑證檔的路徑寫回 target，spawnSsh 在真正呼叫的
   * 那一刻才讀 —— 所以續簽對正在進行的連線是透明的。
   */
  async function useSandbox(sandboxId) {
    const entry = getSandbox(sandboxId);
    if (minter.isConfigured()) {
      const { identityFile, certFile } = await minter.ensureCert(
        entry.target.principal || entry.target.user,
      );
      entry.target.identityFile = identityFile;
      entry.target.certFile = certFile;
    }
    return entry;
  }

  return {
    /**
     * 「建立 sandbox」在這裡只是登記一筆連線。沒有容器要開、沒有 mount 要等 ——
     * 這是本後端相對 docker 模式最大的體感差異：docker 模式每個 session 要付秒級的
     * 冷啟動（UI 上就是那個 `sandbox: allocating`），這裡是 0。
     */
    async createSandbox({ userId, sessionId, ...rest } = {}) {
      const target = await resolve({ userId, sessionId, ...rest });
      if (!target?.host || !target?.user || !target?.root) {
        throw new SandboxError(
          "bad_request",
          "ssh backend needs a machine target { host, user, root }",
          400,
        );
      }
      const sandboxId = `ssh-${randomUUID().slice(0, 12)}`;
      // machineId 要記下來：撤銷是以**機器**為單位發生的（app 停用 user_machines
      // 的一列），而這一層本來只認得 principal。沒有這個對照，一個被撤銷的機器在
      // 這個行程裡就找不回它簽過的憑證快取，`ssh-ca.mjs` 的 forget() 也就永遠沒有
      // 呼叫端 —— 那正是它到今天為止的狀態。
      sandboxes.set(sandboxId, {
        target, sessionId, userId, createdAt: Date.now(),
        machineId: rest?.machine?.id ? String(rest.machine.id) : null,
      });
      // 先簽一張，讓第一次 exec 不用在熱路徑上等簽發。
      if (minter.isConfigured()) await useSandbox(sandboxId);
      log("info", "ssh.sandbox_created", {
        sandboxId, userId, sessionId, host: target.host, root: target.root,
      });
      return { sandboxId, workspaceId: sessionId || sandboxId, workspaceDir: target.root };
    },

    /**
     * 關掉共用連線。使用者的檔案一個都不動 —— 那是他自己的電腦，
     * keepWorkspace 在這個後端恆為真，參數只是為了介面一致。
     */
    async destroySandbox(sandboxId) {
      const entry = sandboxes.get(sandboxId);
      if (!entry) return;
      for (const [handleId, proc] of processes) {
        if (proc.sandboxId === sandboxId) {
          try { proc.handle.kill(); } catch { /* best-effort */ }
          processes.delete(handleId);
        }
      }
      try {
        await once(spawnSsh({ target: entry.target, control: "exit", execId: "ctl" }));
      } catch { /* master 可能本來就沒開，不是錯誤 */ }
      sandboxes.delete(sandboxId);
      log("info", "ssh.sandbox_destroyed", { sandboxId });
    },

    // 沒有東西可以凍結 —— 那是使用者的電腦，不是我們的容器。
    async pauseSandbox() { /* no-op */ },
    async resumeSandbox() { /* no-op */ },

    async listSandboxes() {
      return [...sandboxes.entries()].map(([sandboxId, e]) => ({
        sandboxId,
        workspaceId: e.sessionId || sandboxId,
        createdAt: e.createdAt,
        host: e.target.host,
      }));
    },

    async execProcess(sandboxId, {
      kind = "bash", command, args = [], env = {}, cwd, timeoutMs, stdin,
    } = {}) {
      const entry = await useSandbox(sandboxId);
      const { target } = entry;
      const workdir = cwd ? joinRoot(target.root, cwd) : target.root;

      let inner;
      if (kind === "bash") {
        const raw = typeof command === "string"
          ? command
          : (Array.isArray(args) && args.length ? args.join(" ") : "true");
        inner = `exec bash -lc ${shq(raw)}`;
      } else if (kind === "python") {
        inner = `exec python3 -c ${shq(typeof command === "string" ? command : "")}`;
      } else {
        const bin = String(command || "true");
        // 開頭是 - 的指令名直接拒絕。`exec -- cmd` 是 bash 擴充，dash 會答
        // `exec: --: not found`，所以不能靠 -- 擋，只能在這裡先擋掉。
        if (bin.startsWith("-")) {
          throw new SandboxError("bad_request", `refusing command name starting with '-': ${bin}`, 400);
        }
        inner = `exec ${shq(bin)} ${(Array.isArray(args) ? args : []).map(shq).join(" ")}`;
      }

      // 環境變數走「賦值前綴」而不是 `env A=b -- cmd`：POSIX 的 env 只接受
      // 出現在賦值「之前」的 --，否則會答 `'--': No such file or directory`。
      const envPrefix = Object.entries(env || {})
        .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
        .map(([k, v]) => `${k}=${shq(v)}`)
        .join(" ");

      const execId = `exec-${randomUUID().slice(0, 8)}`;
      const remote = [
        `mkdir -p ${REMOTE_RUN_DIR} 2>/dev/null;`,
        `echo $$ > ${REMOTE_RUN_DIR}/${execId}.pid 2>/dev/null;`,
        // 指定了工作目錄就必須真的在那裡跑。進不去要讓指令失敗（127），
        // 而不是默默掉回登入目錄 —— 呼叫端指名了目錄就是認真的。
        `cd -- ${shq(workdir)} || exit 127;`,
        envPrefix ? `${envPrefix} ${inner}` : inner,
      ].join(" ");

      return spawnSsh({ target, remote, stdin, timeoutMs, execId });
    },

    /** 長駐行程：同上，但沒有 timeout，而且 stdin 保持開著等 writeStdin。 */
    async spawnLongLivedProcess(sandboxId, { command, args = [], env = {}, cwd } = {}) {
      const entry = await useSandbox(sandboxId);
      const { target } = entry;
      const workdir = cwd ? joinRoot(target.root, cwd) : target.root;
      const execId = `lproc-${randomUUID().slice(0, 8)}`;

      const envPrefix = Object.entries(env || {})
        .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
        .map(([k, v]) => `${k}=${shq(v)}`)
        .join(" ");
      const inner = `exec ${shq(String(command || ""))} ${(Array.isArray(args) ? args : []).map(shq).join(" ")}`;

      const remote = [
        `mkdir -p ${REMOTE_RUN_DIR} 2>/dev/null;`,
        `echo $$ > ${REMOTE_RUN_DIR}/${execId}.pid 2>/dev/null;`,
        `cd -- ${shq(workdir)} || exit 127;`,
        envPrefix ? `${envPrefix} ${inner}` : inner,
      ].join(" ");

      const handle = spawnSsh({
        target, remote, stdin: null, keepStdinOpen: true, timeoutMs: 0, execId,
      });
      processes.set(execId, { sandboxId, handle, command: String(command || "") });
      handle.on("exit", () => processes.delete(execId));
      return { processHandle: execId, startedAt: Date.now(), handle };
    },

    async readFile(sandboxId, filePath) {
      const { target } = await useSandbox(sandboxId);
      const p = joinRoot(target.root, filePath);
      const handle = spawnSsh({
        target,
        remote: `${guardPrelude(target.root, p)} exec cat -- "$P"`,
        timeoutMs: 30_000,
        execId: `read-${randomUUID().slice(0, 8)}`,
      });
      return await collectStdout(handle);
    },

    /**
     * 寫檔：先寫到「同一個目錄」裡的暫存檔，再 rename 蓋過去。
     *
     * mv 只有在同一個檔案系統內才是原子的，所以暫存檔放到別處（/tmp）會默默退化成
     * 複製 —— 讀的人就可能讀到寫到一半的檔案。既有檔案的權限要帶過去：
     * chmod --reference 是 GNU 限定，所以用兩種方言各讀一次模式再套用。
     * 一個被改寫後失去執行位元的 script、或變成全世界可讀的金鑰，比寫入失敗更糟。
     */
    async writeFile(sandboxId, filePath, content) {
      const { target } = await useSandbox(sandboxId);
      const p = joinRoot(target.root, filePath);
      const buf = Buffer.isBuffer(content)
        ? content
        : Buffer.from(typeof content === "string" ? content : JSON.stringify(content));

      const remote = [
        guardPrelude(target.root, p),
        `mkdir -p -- "$D" || exit 1;`,
        `T="$D/.uac2.tmp.$$";`,
        `cat > "$T" || exit 1;`,
        `if [ -e "$P" ]; then`,
        `  M=$(stat -c '%a' "$P" 2>/dev/null || stat -f '%Lp' "$P" 2>/dev/null);`,
        `  [ -n "$M" ] && chmod "$M" "$T" 2>/dev/null;`,
        `fi;`,
        `mv -f -- "$T" "$P" || { rm -f -- "$T"; exit 1; }`,
      ].join(" ");

      const handle = spawnSsh({
        target, remote, stdin: buf, timeoutMs: 60_000,
        execId: `write-${randomUUID().slice(0, 8)}`,
      });
      await collectExit(handle);
    },

    async statFile(sandboxId, filePath) {
      const { target } = await useSandbox(sandboxId);
      const p = joinRoot(target.root, filePath);
      const handle = spawnSsh({
        target,
        remote: `${guardPrelude(target.root, p)} ${statExpr('$P')} || echo "::missing"`,
        timeoutMs: 10_000,
        execId: `stat-${randomUUID().slice(0, 8)}`,
      });
      const out = (await collectStdout(handle)).toString("utf8").trim();
      if (!out || out.endsWith("missing")) return null;
      const [sizeStr, mtimeStr, typeStr] = out.split(":");
      return {
        path: filePath,
        size: Number(sizeStr) || 0,
        mtimeMs: (Number(mtimeStr) || 0) * 1000,
        // GNU 的 %F 給 "regular file"/"directory"，BSD 的 %HT 給 "Regular File"/"Directory"
        isFile: /regular/i.test(typeStr || ""),
        isDirectory: /directory/i.test(typeStr || ""),
      };
    },

    /**
     * 列目錄：一次 round trip 拿齊全部項目的 type/size/mtime。
     *
     * 每個檔案各 stat 一次會變成「每個檔案一次連線往返」—— 在 30ms 延遲的線路上，
     * 一個兩百檔的目錄要開六秒。這是遠端檔案系統最容易搞砸的地方。
     */
    async listFiles(sandboxId, dirPath = "/") {
      const { target } = await useSandbox(sandboxId);
      const p = joinRoot(target.root, dirPath);
      const remote = [
        guardPrelude(target.root, p),
        `cd -- "$P" 2>/dev/null || exit 0;`,
        `for n in .* *; do`,
        `  [ "$n" = "." ] || [ "$n" = ".." ] || [ ! -e "$n" ] || {`,
        `    printf '%s\\t' "$n"; ${statExpr('$n')} || printf '::';`,
        `    printf '\\n';`,
        `  };`,
        `done`,
      ].join(" ");
      const handle = spawnSsh({
        target, remote, timeoutMs: 20_000,
        execId: `ls-${randomUUID().slice(0, 8)}`,
      });
      const out = (await collectStdout(handle)).toString("utf8").trim();
      if (!out) return [];
      const seen = new Set();
      return out.split("\n").flatMap((line) => {
        const [name, meta] = line.split("\t");
        if (!name || seen.has(name)) return [];
        seen.add(name);
        const [sizeStr, mtimeStr, typeStr] = String(meta || "").split(":");
        return [{
          name,
          path: `${String(dirPath).replace(/\/+$/, "")}/${name}`.replace(/\/+/g, "/"),
          isFile: /regular/i.test(typeStr || ""),
          isDirectory: /directory/i.test(typeStr || ""),
          size: Number(sizeStr) || 0,
          mtimeMs: (Number(mtimeStr) || 0) * 1000,
        }];
      });
    },

    async deleteFile(sandboxId, filePath) {
      const { target } = await useSandbox(sandboxId);
      const p = joinRoot(target.root, filePath);
      const handle = spawnSsh({
        target,
        remote: `${guardPrelude(target.root, p)} rm -rf -- "$P"`,
        timeoutMs: 30_000,
        execId: `rm-${randomUUID().slice(0, 8)}`,
      });
      await collectExit(handle);
    },

    async ensureDir(sandboxId, dirPath) {
      const { target } = await useSandbox(sandboxId);
      const p = joinRoot(target.root, dirPath);
      const handle = spawnSsh({
        target,
        remote: `${guardPrelude(target.root, p)} mkdir -p -- "$P"`,
        timeoutMs: 15_000,
        execId: `mkdir-${randomUUID().slice(0, 8)}`,
      });
      await collectExit(handle);
    },

    /**
     * 把使用者機器上的一個 port 拉到這邊來 —— 「agent 去看我本機跑起來的網站」。
     *
     * 這是 SSH 模式免費送的東西：dev server 跑在使用者自己的電腦上，使用者
     * 直接開 localhost 就看得到（雲端沙箱要做一整套預覽代理才辦得到）。缺的
     * 只有「讓雲端這側也看得到」，而那就是一條 -L 通道。
     *
     * 用 `ssh -O forward` 對已經在的 ControlMaster 下指令，而不是另外開一個
     * 常駐的 ssh 行程：多工的連線已經在了，通道只是它上面多一個 channel。
     *
     * 本地 port 得自己挑：`-L` 不支援動態配埠（`0:host:port` 會被回
     * "Bad local forwarding specification"，動態配埠只有 `-R` 有）。所以先讓
     * 作業系統給一個空的、關掉、再用它 —— 中間有一個很小的搶號窗口，
     * 所以撞到就換一個重試。
     *
     * 綁 127.0.0.1：這條通道是給這個服務自己用的（截圖、健康檢查、預覽代理），
     * 不是給網路上任何人連的。
     */
    async openTunnel(sandboxId, { remotePort, remoteHost = "127.0.0.1" } = {}) {
      const { target } = await useSandbox(sandboxId);
      const port = Number(remotePort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new SandboxError("bad_request", `invalid remote port: ${remotePort}`, 400);
      }
      let lastErr = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const localPort = await freeLocalPort();
        const spec = `${localPort}:${remoteHost}:${port}`;
        const handle = spawnSsh({ target, forward: ["-O", "forward", "-L", spec], execId: null });
        try {
          await collectExit(handle);
          log("info", "ssh.tunnel_opened", { sandboxId, remotePort: port, localPort });
          return { localPort, remotePort: port, remoteHost, url: `http://127.0.0.1:${localPort}` };
        } catch (err) {
          // 這個埠在「問完」到「綁上」之間被別人拿走了，換一個。
          lastErr = err;
        }
      }
      throw new SandboxError(
        "ssh_exec_failed",
        `could not open a tunnel to ${remoteHost}:${port}: ${lastErr?.message || "unknown"}`,
        500,
      );
    },

    /** 收掉一條通道。忘了收的代價是這個行程持續持有一個對別人機器的入口。 */
    async closeTunnel(sandboxId, { localPort, remotePort, remoteHost = "127.0.0.1" } = {}) {
      const { target } = await useSandbox(sandboxId);
      const spec = `${localPort}:${remoteHost}:${remotePort}`;
      const handle = spawnSsh({ target, forward: ["-O", "cancel", "-L", spec], execId: null });
      await collectExit(handle).catch(() => {});
      log("info", "ssh.tunnel_closed", { sandboxId, localPort });
    },

    async snapshotSandbox() {
      throw new SandboxError("not_supported", "snapshot is not supported in ssh mode", 501);
    },
    async restoreSnapshot() {
      throw new SandboxError("not_supported", "restore is not supported in ssh mode", 501);
    },

    /**
     * 這台機器被撤銷了：忘掉為它簽過的憑證快取。
     *
     * **為什麼這件事有安全意義。** `ssh-ca.mjs` 的憑證 15 分鐘就過期，所以直覺是
     * 「撤銷之後最多多撐一個有效期」。那個直覺是錯的：`ensureCert` 過期會**自己
     * 重簽**，而它從頭到尾不回頭問 DB —— 只要這個行程還有一筆用得到它的登記，
     * 它就會一直簽下去。所以真正的窗口長度不是 TTL，是「那筆登記還在多久」。
     * 這一支負責快取那一半；登記那一半在 pool/manager.mjs 的
     * releaseMachineSandboxes。兩半都要，缺一個窗口就還開著。
     *
     * `principal` 可以由呼叫端直接給（app 手上有 user_machines 那一列），
     * 這樣即使這個行程從來沒為它開過 sandbox 也忘得掉。
     *
     * @returns {{principals: string[], sandboxes: string[]}} 實際清掉的東西。
     */
    forgetMachine(machineId, { principal = null } = {}) {
      const mid = String(machineId || "").trim();
      const principals = new Set();
      const dropped = [];
      if (principal) principals.add(String(principal));
      if (mid) {
        for (const [sandboxId, entry] of sandboxes) {
          if (entry.machineId !== mid) continue;
          const p = entry.target?.principal || entry.target?.user;
          if (p) principals.add(String(p));
          dropped.push(sandboxId);
        }
      }
      for (const p of principals) minter.forget(p);
      if (principals.size || dropped.length) {
        log("info", "ssh.machine_forgotten", {
          machineId: mid, principals: [...principals], sandboxes: dropped.length,
        });
      }
      return { principals: [...principals], sandboxes: dropped };
    },

    _internal: { sandboxes, processes, spawnSsh, joinRoot, shq, guardPrelude, minter },
  };
}

/** 沒有機器名冊時的退路：從環境變數讀一台。讓這個後端可以脫離 DB 單獨測試。 */
function defaultResolveTarget(params = {}) {
  // app（BFF）從 user_machines 讀出來、隨 allocate 一起送過來的那台機器。
  // 它只帶「連哪裡、用哪個 principal」，永遠不帶金鑰 —— 簽發在這個服務裡發生。
  const m = params.machine;
  if (m?.host && m?.user && m?.root) {
    return {
      host: m.host, user: m.user, root: m.root,
      port: Number(m.port) || 22,
      principal: m.principal || m.user,
      identityFile: null,
    };
  }
  const host = process.env.SSH_TARGET_HOST;
  const user = process.env.SSH_TARGET_USER;
  const root = process.env.SSH_TARGET_ROOT;
  if (!host || !user || !root) return null;
  return {
    host, user, root,
    port: parseIntEnv(process.env.SSH_TARGET_PORT, 22),
    principal: process.env.SSH_TARGET_PRINCIPAL || user,
    identityFile: process.env.SSH_TARGET_IDENTITY || null,
  };
}

/**
 * 這個目標的 known_hosts 放哪裡。
 *
 * 一個目標一個檔，檔名從 host/port/user 算出來 —— 共用一個檔的話，兩台機器
 * 的金鑰混在一起，而「這一把是誰的」正是要驗的東西。
 */
function knownHostsFor(target) {
  const id = createHash("sha256")
    .update(`${target?.user ?? ""}@${target?.host ?? ""}:${target?.port ?? 22}`)
    .digest("hex")
    .slice(0, 16);
  return `${CONTROL_DIR}/kh-${id}`;
}

function knownHostsExists(target) {
  try {
    return statSync(knownHostsFor(target)).size > 0;
  } catch {
    return false;
  }
}

/** 組出一次 ssh 呼叫的參數。多工、不問密碼、不掛 TTY。 */
export function sshArgs(target, { remote = null, control = null, tty = false, forward = null } = {}) {
  ensureControlDir();
  const args = [
    // 沒有 BatchMode，一台要密碼的機器會讓 OpenSSH 直接開 /dev/tty 問，
    // 而畫面上什麼都不會顯示 —— 使用者看到的是整個程式卡死。
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${CONNECT_TIMEOUT_SEC}`,
    // **金鑰釘在這台目標自己的 known_hosts 上。**
    //
    // 原本是一律 `accept-new` 並且用共用的 known_hosts。那有兩個問題：
    // 第一次連線完全沒有驗證（TOFU 的固有風險，2026-09-11 的資安審查第 7 條
    // 點名的就是這個），而共用檔案讓「哪一把金鑰屬於哪一台機器」混在一起。
    //
    // 改成每一個目標一個檔：檔案還不存在 ＝ 真的第一次，才 `accept-new`；
    // 存在之後一律 `yes`，金鑰換了就連不上，而那正是要的行為 —— 中間人換掉
    // 金鑰時應該是一個**失敗**，不是一句沒有人會看的警告。
    //
    // 這不是完整的指紋釘選（那要由使用者在配對時確認一次，資料在 app 那一
    // 側），但它把「每一次連線都可能被換掉」縮到「只有第一次」。
    "-o", `UserKnownHostsFile=${knownHostsFor(target)}`,
    "-o", knownHostsExists(target) ? "StrictHostKeyChecking=yes" : "StrictHostKeyChecking=accept-new",
    // 多工：第一條連線做完握手，其餘的併進去。沒有它，每次讀檔和每條指令
    // 都要付一次完整金鑰交換，遠端工作區會慢得像另一個產品。
  ];
  if (MULTIPLEX_OK) {
    args.push(
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${CONTROL_DIR}/c-%C`,
      "-o", `ControlPersist=${CONTROL_PERSIST_SEC}`,
    );
  }
  if (target.port && target.port !== 22) args.push("-p", String(target.port));
  if (target.identityFile) args.push("-i", target.identityFile);
  // 憑證和金鑰是一組：沒有 CertificateFile，遠端看到的是一把它從不認識的裸公鑰。
  if (target.certFile) args.push("-o", `CertificateFile=${target.certFile}`);
  // 只用我們給的身分。否則 ssh 會先把行程使用者 ~/.ssh 底下的每一把金鑰都試一遍，
  // 在設了 MaxAuthTries 的機器上會在輪到憑證之前就被斷線。
  if (target.identityFile) args.push("-o", "IdentitiesOnly=yes");
  if (control) args.push("-O", control);
  // -O forward/cancel 對現有的 master 下指令，所以這些參數要在目標之前。
  if (forward) args.push(...forward);
  if (tty) args.push("-tt");
  args.push(`${target.user}@${target.host}`);
  if (remote) args.push(remote);
  return args;
}

/**
 * spawn `ssh <args...>`，回一個和 docker.mjs / envd 同形狀的 handle
 * （stdout/stderr/exit/error + .write/.cancel/.kill）。
 *
 * 這個函式和 docker.mjs 的 spawnDockerExec 幾乎一樣 —— 差別只在執行檔名，
 * 以及 cancel 必須額外去遠端殺 process group（見檔頭第 1、2 點）。
 */
function spawnSsh({ target, remote, stdin = null, keepStdinOpen = false, timeoutMs = 0, execId, control = null, forward = null }) {
  const handle = new EventEmitter();
  const pendingEvents = [];
  let exitEmitted = false;
  let timer = null;

  // 很短的指令可能在監聽器掛上之前就結束了。先緩衝，讓 registry 之後 replay，
  // 否則這個 exec 會永遠停在 "running"。
  const emitOrBuffer = (type, ...values) => {
    if (handle.listenerCount(type) > 0) handle.emit(type, ...values);
    else pendingEvents.push([type, values]);
  };

  const child = spawn("ssh", sshArgs(target, { remote, control, forward }), {
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (stdin != null) {
    try { child.stdin.write(stdin); } catch { /* ignore */ }
  }
  if (!keepStdinOpen) {
    try { child.stdin.end(); } catch { /* ignore */ }
  }

  child.stdout.on("data", (chunk) => emitOrBuffer("stdout", chunk));
  child.stderr.on("data", (chunk) => emitOrBuffer("stderr", chunk));

  const emitExit = (code, signal, errorMessage) => {
    if (exitEmitted) return;
    exitEmitted = true;
    if (timer) clearTimeout(timer);
    // 255 或被訊號 = 「客戶端」結束了，遠端行程的死活未知（活過連線正是它的常態）。
    // 只有真的是遠端指令的離開碼，pid file 才是垃圾、可以清掉。
    const clientDied = code === 255 || signal != null;
    if (!clientDied && execId) cleanupPidFile(target, execId);
    emitOrBuffer("exit", {
      execId,
      code: code === null ? null : Number(code),
      signal: signal || null,
      error: errorMessage || null,
      clientDied,
    });
  };

  child.on("error", (err) => {
    emitOrBuffer("error", err);
    emitExit(null, null, err?.message || String(err));
  });
  child.on("close", (code, signal) => emitExit(code, signal, null));

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      // 兩件事都要做，而且缺一不可：關掉客戶端才會釋放呼叫端的串流並結算，
      // 但真正讓工作停下來的是遠端那個訊號。
      remoteKill(target, execId, "TERM");
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => {
        if (!exitEmitted) {
          remoteKill(target, execId, "KILL");
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, 2000).unref();
    }, timeoutMs).unref();
  }

  handle.execId = execId;
  handle.pid = child.pid;
  handle.drainBufferedEvents = () => {
    for (const [type, values] of pendingEvents.splice(0)) handle.emit(type, ...values);
  };
  handle.write = (data) => {
    try { child.stdin.write(data); } catch (err) { handle.emit("error", err); }
  };
  handle.cancel = () => {
    remoteKill(target, execId, "TERM");
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    setTimeout(() => {
      if (!exitEmitted) {
        remoteKill(target, execId, "KILL");
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }, 2000).unref();
  };
  handle.kill = handle.cancel;

  return handle;
}

/**
 * 對遠端那個 pid 的「process group」送訊號。
 *
 * 打 group 而不是單一 pid，是因為在 sshd 底下那個指令 shell 自己就是 group leader ——
 * 一個訊號就能到達它和它啟動的一切。沒有 group 可打時退回單一 pid。
 * 這條連線是多工的，所以「再開一條連線去殺」很便宜。
 */
function remoteKill(target, execId, sig = "TERM") {
  if (!execId) return;
  const remote = [
    `P=$(cat ${REMOTE_RUN_DIR}/${execId}.pid 2>/dev/null);`,
    `[ -n "$P" ] && { kill -${sig} -"$P" 2>/dev/null || kill -${sig} "$P" 2>/dev/null; };`,
    // 遠端腳本永遠 exit 0：這樣非 0 的離開碼就一定來自客戶端（master 被關掉、
    // 連線被拒），而不是「pid 已經不在了」這種正常情況。
    `exit 0`,
  ].join(" ");
  try {
    const child = spawn("ssh", sshArgs(target, { remote }), { stdio: "ignore" });
    child.unref?.();
  } catch (err) {
    log("warn", "ssh.remote_kill_failed", { execId, error: err?.message });
  }
}

function cleanupPidFile(target, execId) {
  try {
    const child = spawn("ssh", sshArgs(target, {
      remote: `rm -f ${REMOTE_RUN_DIR}/${execId}.pid 2>/dev/null; exit 0`,
    }), { stdio: "ignore" });
    child.unref?.();
  } catch { /* 垃圾檔而已，清不掉不是錯誤 */ }
}

function once(handle) {
  return new Promise((resolve) => {
    handle.on("exit", resolve);
    handle.on("error", () => resolve(null));
    handle.drainBufferedEvents?.();
  });
}

function collectStdout(handle) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errs = [];
    handle.on("stdout", (c) => chunks.push(c));
    handle.on("stderr", (c) => errs.push(c));
    handle.on("exit", (evt) => {
      if (evt?.code === 0 || evt?.code == null) return resolve(Buffer.concat(chunks));
      const stderr = Buffer.concat(errs).toString("utf8");
      if (evt?.code === 77) {
        return reject(new SandboxError("workspace_escape", "path escapes workspace root", 400, evt));
      }
      if (evt?.code === 79) {
        return reject(new SandboxError("bad_request", "workspace root does not exist on that machine", 400, evt));
      }
      reject(new SandboxError("ssh_exec_failed", `ssh exited ${evt?.code}: ${stderr.slice(0, 200)}`, 500, evt));
    });
    handle.on("error", reject);
    // 快指令可能在監聽器掛上前就結束了，把緩衝的事件放出來，否則這裡永遠不會 resolve。
    handle.drainBufferedEvents?.();
  });
}

function collectExit(handle) {
  return new Promise((resolve, reject) => {
    const errs = [];
    handle.on("stderr", (c) => errs.push(c));
    handle.on("exit", (evt) => {
      if (evt?.code === 0 || evt?.code == null) return resolve(evt);
      const stderr = Buffer.concat(errs).toString("utf8");
      if (evt?.code === 77) {
        return reject(new SandboxError("workspace_escape", "path escapes workspace root", 400, evt));
      }
      if (evt?.code === 79) {
        return reject(new SandboxError("bad_request", "workspace root does not exist on that machine", 400, evt));
      }
      reject(new SandboxError("ssh_exec_failed", `ssh exited ${evt?.code}: ${stderr.slice(0, 200)}`, 500, evt));
    });
    handle.on("error", reject);
    handle.drainBufferedEvents?.();
  });
}
