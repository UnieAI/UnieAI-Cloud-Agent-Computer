/**
 * chrome-launch-policy.mjs —— 在使用者的電腦上，直接啟動 Chrome／Chromium 要帶「不碰作業系統密碼庫」的旗標。
 *
 * 為什麼（owner 2026-10-22）：模型在使用者的 Mac 上用 bash 直接跑 `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
 * --headless --user-data-dir=/tmp/…` 做驗收。全新的 profile 會去要 macOS 鑰匙圈的「Chrome Safe Storage」，使用者就看到一連串
 * 「找不到鑰匙圈來儲存 Chrome」；Chrome 又是 ava-local 的子行程，系統的 Automation 詢問也算在 ava-local 頭上。
 * 我們自己開的 Chrome（localbrowser）早就帶這些旗標，漏的是模型自己開的那些。
 *
 * 這是**確定性的一道**：命令列裡以「指令」的身分（不是引數）呼叫 Chrome／Chromium 執行檔，卻缺 `--use-mock-keychain`、
 * `--password-store=basic` 或暫存的 `--user-data-dir`，就拒絕並回一句模型看得懂、照著改得了的話。`--version`／`--help` 不開 profile，放行。
 * `open -a "Google Chrome"`（把使用者自己的 Chrome 叫起來）也拒絕 —— 那沒有旗標可加，要用 localbrowser。
 *
 * 擋不到的：腳本內部的 subprocess（python 的 subprocess.run([...chrome…])）—— 看不到，所以給模型的說明要寫清楚（見 prompt）。
 *
 * **引擎有一份複本**（apps/ava-engine/src/chrome-launch-policy.mjs，引擎映像只 COPY ava-engine/src）；
 * apps/ava-engine/test/chrome-launch-policy-in-sync.test.mjs 逐字比對，要改請改這份再同步。
 */

export const KEYCHAIN_FREE_FLAGS = Object.freeze(["--use-mock-keychain", "--password-store=basic"]);

const CHROME_BASENAME = /^(?:google-chrome(?:-stable|-beta|-unstable)?|chromium(?:-browser)?|chrome|chromium-browser|microsoft-edge(?:-stable)?|brave-browser(?:-stable)?|brave|Google Chrome|Chromium|Microsoft Edge|Brave Browser)$/;
const MAC_APP_BINARY = /(?:Google Chrome|Chromium|Microsoft Edge|Brave Browser)(?: (?:Beta|Dev|Canary))?\.app\/Contents\/MacOS\/[^/]+$/;
const CHROME_APP_NAME = /^(?:google[ -]?chrome|chromium|microsoft edge|brave browser)(?: (?:beta|dev|canary))?(?:\.app)?$/i;
const CHROME_BUNDLE_ID = /^com\.(?:google\.Chrome|google\.Chrome\.(?:beta|dev|canary)|microsoft\.edgemac|brave\.Browser)$/i;
const WRAPPERS = new Set(["sudo", "nohup", "time", "exec", "command", "nice", "stdbuf", "setsid", "caffeinate", "xvfb-run", "env", "timeout"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** 把一條指令拆成「簡單指令」（以 ; && || | & 換行 分隔），每個簡單指令是 token 陣列。引號內的運算子不算。 */
export function splitSimpleCommands(command) {
  const out = [];
  let tokens = [], cur = "", has = false, quote = null;
  const endToken = () => { if (has) tokens.push(cur); cur = ""; has = false; };
  const endCommand = () => { endToken(); if (tokens.length) out.push(tokens); tokens = []; };
  const s = String(command ?? "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; }
    else if (c === "\\" && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c) && c !== "\n") endToken();
    else if (c === "\n" || c === ";" || c === "|" || c === "&") endCommand();
    else if (c === "(" || c === ")" || c === "{" || c === "}") endToken();
    else { cur += c; has = true; }
  }
  endCommand();
  return out;
}

/** 跳過前導的 VAR=value 與包裝指令（sudo、env、timeout 30 …），回第一個真正的指令字的位置。 */
function commandWordIndex(tokens) {
  let i = 0;
  for (;;) {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    const word = tokens[i]?.split("/").pop();
    if (!word || !WRAPPERS.has(word)) return i;
    i++;
    while (i < tokens.length && (tokens[i].startsWith("-") || (word === "timeout" && /^\d+[smhd]?$/.test(tokens[i])) || (word === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])))) i++;
  }
}

const isChromeExecutable = (word) => MAC_APP_BINARY.test(word) || CHROME_BASENAME.test(word.split("/").pop() ?? "");

/** `open -a "Google Chrome" …`／`open -b com.google.Chrome …` */
function opensChromeApp(tokens, at) {
  if (tokens[at]?.split("/").pop() !== "open") return false;
  for (let i = at + 1; i < tokens.length; i++) {
    if (tokens[i] === "-a" && CHROME_APP_NAME.test(tokens[i + 1] ?? "")) return true;
    if (tokens[i] === "-b" && CHROME_BUNDLE_ID.test(tokens[i + 1] ?? "")) return true;
    if (/^-[A-Za-z]*a$/.test(tokens[i]) && CHROME_APP_NAME.test(tokens[i + 1] ?? "")) return true;
  }
  return false;
}

const hasFlag = (args, flag) => args.some((a) => a === flag || a.startsWith(`${flag}=`));
const INFO_ONLY = new Set(["--version", "-version", "--help", "-h"]);

function judgeLaunch(args) {
  if (args.length && args.every((a) => INFO_ONLY.has(a))) return null; // 只印版本／說明，不開 profile
  const missing = [
    ...KEYCHAIN_FREE_FLAGS.filter((f) => !hasFlag(args, f)),
    ...(hasFlag(args, "--user-data-dir") ? [] : ["--user-data-dir=<暫存目錄>"]),
  ];
  return missing.length ? missing : null;
}

const REFUSE_LAUNCH = (missing) =>
  `不要在使用者的電腦上直接啟動 Chrome：新的 profile 會讀他的作業系統鑰匙圈（macOS 會跳出「找不到鑰匙圈」之類的系統視窗），而且這個 Chrome 是 ava-local 的子行程。` +
  `瀏覽器驗證請改用 localbrowser 工具。如果一定要自己開，必須同時帶 ${KEYCHAIN_FREE_FLAGS.join(" ")} 和一個暫存的 --user-data-dir=<新的暫存目錄>（不要碰使用者自己的 Chrome profile）。這次缺：${missing.join("、")}。`;
const REFUSE_OPEN =
  `不要用 open 叫起使用者自己的 Chrome。瀏覽器驗證請改用 localbrowser 工具；如果是要讓使用者看某個頁面，把網址寫在回覆裡讓他自己開。`;

/**
 * 這條指令是不是「直接啟動 Chrome 卻漏帶旗標」。
 * @returns {{ code: "chrome_launch_flags" | "chrome_open_app", message: string, missing?: string[] } | null}
 */
export function chromeLaunchRefusal(command, depth = 0) {
  for (const tokens of splitSimpleCommands(command)) {
    const at = commandWordIndex(tokens);
    const word = tokens[at];
    if (!word) continue;
    if (SHELLS.has(word.split("/").pop()) && depth < 3) {
      const c = tokens.indexOf("-c", at + 1) >= 0 ? tokens.indexOf("-c", at + 1) : tokens.findIndex((t, i) => i > at && /^-[A-Za-z]*c$/.test(t));
      if (c >= 0 && tokens[c + 1]) {
        const inner = chromeLaunchRefusal(tokens[c + 1], depth + 1);
        if (inner) return inner;
      }
      continue;
    }
    if (opensChromeApp(tokens, at)) return { code: "chrome_open_app", message: REFUSE_OPEN };
    if (!isChromeExecutable(word)) continue;
    const missing = judgeLaunch(tokens.slice(at + 1));
    if (missing) return { code: "chrome_launch_flags", message: REFUSE_LAUNCH(missing), missing };
  }
  return null;
}
