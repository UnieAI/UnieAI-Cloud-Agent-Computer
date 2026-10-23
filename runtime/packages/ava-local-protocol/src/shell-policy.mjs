/**
 * shell-policy.mjs — the three questions the daemon asks about a command,
 * shared with the app so both sides give the same answer.
 *
 *   1. isReadOnlyCommand — may it run without asking?  (allow-list, every
 *      segment must pass; ported verbatim from lib/agent-code/permission-gate.ts)
 *   2. bashDestructiveRisk — what should the approval card warn about?
 *      (ported verbatim from lib/agent-code/coding-tools-core.ts)
 *   3. isHardDenied — is it refused even with approval? (a guardrail against
 *      catastrophic one-liners slipping through an over-eager click)
 *
 * The app re-exports 1 and 2 from their historical modules, so there is one
 * implementation, not two that drift (see the "同一條規則兩份實作" lesson).
 */

export const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "stat", "file", "pwd",
  "echo", "printf", "date", "which", "whereis", "type", "du", "df", "tree",
  "sort", "uniq", "cut", "tr", "column", "basename", "dirname", "realpath",
  "grep", "egrep", "fgrep", "rg", "ag", "find", "fd", "diff", "cmp", "md5sum",
  "sha1sum", "sha256sum", "jq", "yq", "xxd", "od", "strings", "env", "id",
  "uname", "hostname", "ps", "top", "free", "uptime", "node", "python3",
  "whoami", "groups", "locale", "tty", "readlink", "sleep",
  // `sed` without -i prints to stdout and changes nothing. It used to be a
  // special case ahead of this set; it lives here now so that membership is the
  // single question and ARGUMENT_GUARDS.sed is the only exception to it.
  "sed",
  // 只有 `--version` 會過（見 ARGUMENT_GUARDS 裡同名的守門）。列在這裡只是
  // 讓守門有機會被問到 —— 沒有守門的話這一整排都是危險的。
  // 同樣只有 `--version` 會過（見 ARGUMENT_GUARDS 的同名守門）。
  "curl", "wget", "apt-get", "apt", "apk", "yum", "dnf", "brew",
  "npm", "npx", "pnpm", "yarn", "corepack", "bun", "deno",
  "pip", "pip3", "go", "cargo", "rustc", "java", "docker",
]);

/**
 * Anything that sends output somewhere — a write by another name.
 *
 * Any `>` at all. The previous form excused a redirect preceded by a digit,
 * which made `ls 1> out.txt` and `ls 2>&1 > out.txt` read as read-only.
 *
 * Applied to the command AFTER {@link stripHarmlessRedirects} — see there for
 * why, and for the two forms that are stripped.
 */
export const WRITES_VIA_SHELL = />|(\||;|&&)\s*(tee|dd|sponge)\b/;

/**
 * Redirections that write nothing, removed before the write test.
 *
 * **Why this exists.** "Any `>` is a write" is right about files and wrong
 * about two forms that create nothing and change nothing:
 *
 *   · `2>&1`, `1>&2`, `>&2` — duplicating a file descriptor onto another.
 *   · `2>/dev/null`, `&>/dev/null`, `>>/dev/null` — the bit bucket.
 *
 * Treating those as writes is what turned the approval card into a flood. Every
 * command a model runs to LOOK at something carries one: measured on the real
 * classifier 2026-09-06, `which git` auto-allowed while `which git 2>&1` asked,
 * and the same for `ls -la`, `node --version`, `uname -a`, `git status`. The
 * daemon's own audit for one session showed ~70 refusals of exactly this shape,
 * and a user facing seventy cards stops reading them — which is worse for
 * safety than the thing this rule was protecting.
 *
 * **The invariant is unchanged: anything that can reach a real path is still a
 * write.** Only these two forms are removed, and a leftover `>` after the strip
 * still ends the question. `>/dev/stdout`-style targets are deliberately NOT
 * excused — /dev/null is the one target that provably discards.
 */
const HARMLESS_REDIRECTS = [
  // fd duplication: `2>&1`, `1>&2`, `>&2`
  // 後界是 shell 的分隔符，不只是空白：`which git 2>&1; git --version` 裡的
  // 第一個 `2>&1` 後面接的是 `;`，只認空白的話它不會被剝掉，留下的 `>` 就又
  // 被判成寫檔 —— 每一段各自放行、串起來卻要核准（2026-09-06 量到）。
  /(?:^|\s)\d?>&\d(?=[\s;&|)]|$)/g,
  // the bit bucket, with or without a leading fd / `&`, `>` or `>>`, space optional
  /(?:^|\s)(?:\d|&)?>>?\s*\/dev\/null(?=[\s;&|)]|$)/g,
];

/** Remove the redirections above so the write test judges what is left. */
function stripHarmlessRedirects(cmd) {
  let out = String(cmd ?? "");
  for (const re of HARMLESS_REDIRECTS) out = out.replace(re, " ");
  return out;
}

/**
 * Shell syntax this classifier does not attempt to understand. Seeing any of it
 * ends the question: the command needs approval.
 *
 * This is the fix for the whole family of bypasses found on 2026-09-01. The old
 * splitter knew `;`, `&&`, `||` and `|`, so `ls\nrm -rf build` and
 * `ls & rm -rf build` were judged by the word `ls`, and `echo $(rm -rf build)`
 * was judged by `echo` — the payload was never anything's first word.
 *
 * Parsing these properly would mean writing a shell. Refusing them costs a
 * click; getting them wrong costs the user's files.
 */
const UNPARSEABLE = [
  ["\n", "換行"],
  ["\r", "換行"],
  ["$(", "指令替換"],
  ["`", "指令替換"],
  ["<(", "行程替換"],
  [">(", "行程替換"],
  ["${", "參數展開"],
];

/**
 * A lone `&` (background / separator), but not `&&`.
 *
 * **`>&` and `&>` are not separators.** `2>&1` and `&>/dev/null` are
 * redirections, and reading their `&` as "run in the background" is the second
 * half of the approval flood: it made `which git 2>&1` unparseable while
 * `which git` was fine. So those two are removed before the test — and only
 * those two, because the thing this guard exists for is real: `ls & rm -rf
 * build` must never be judged by the word `ls`.
 */
const REDIRECT_AMPERSAND = /\d?>&\d|&>>?/g;
const LONE_AMPERSAND = /(^|[^&])&([^&]|$)/;

function hasUnparseableSyntax(cmd) {
  for (const [token] of UNPARSEABLE) if (cmd.includes(token)) return true;
  return LONE_AMPERSAND.test(String(cmd).replace(REDIRECT_AMPERSAND, " "));
}

/**
 * Commands that run ANOTHER command. Their own name says nothing about what
 * happens, so `env rm -rf build` was read as `env`, which is on the allow-list.
 * There is no safe way to allow these: the payload is the argument.
 */
const RUNS_SOMETHING_ELSE = new Set([
  "env", "nohup", "time", "nice", "ionice", "sudo", "doas", "su", "xargs",
  "command", "exec", "eval", "source", ".", "watch", "timeout", "setsid",
  "stdbuf", "chroot", "unshare", "flatpak-spawn", "script", "expect",
]);

/**
 * Allow-listed commands that write when you read past the first word. Each
 * entry answers "is THIS invocation still read-only?" for one command.
 */
const ARGUMENT_GUARDS = {
  // -delete / -exec / -ok / -execdir / -okdir all run or remove.
  find: (seg) => !/\s-(delete|exec|execdir|ok|okdir|fls|fprint|fprintf|fputs)\b/.test(seg),
  fd: (seg) => !/\s(-x|-X|--exec|--exec-batch)\b/.test(seg),
  // `sed -i` edits in place.
  sed: (seg) => !/\s-[a-zA-Z]*i\b/.test(seg),
  // `sort -o` writes its output to a file.
  sort: (seg) => !/\s-o\b|\s--output\b/.test(seg),
  // `xxd -r` reverses a hex dump into bytes, normally into a file.
  xxd: (seg) => !/\s-r\b|\s--revert\b/.test(seg),
  od: () => true,
  // An interpreter is read-only ONLY when it is being asked its version and
  // nothing else. The old check accepted `-v` anywhere on the line, so
  // `python3 -c '<anything>' -v` passed.
  node: (seg) => isVersionQueryOnly(seg),
  python3: (seg) => isVersionQueryOnly(seg),
  python: (seg) => isVersionQueryOnly(seg),
  // 套件管理器：**只有**版本查詢。`isVersionQueryOnly` 要求整段剛好兩個字、
  // 第二個是版本旗標，所以 `npm install`、`npx <任何東西>`、`pnpm add` 一律
  // 落到需要核准 —— 那些會跑安裝腳本，本來就該問。
  //
  // 為什麼特地加它們：「你有哪個版本」是 agent 開工第一件事，稽核裡
  // `npm --version` / `npx --version` / `pnpm --version` / `corepack --version`
  // 一輪就出現四五次，每一次都是一張卡片。這是純粹的雜訊，而雜訊會讓使用者
  // 停止讀卡片 —— 那比這條規則本來要防的事更糟。
  // 「問工具自己的版本」永遠不是一個動作。這些指令本身會做事（curl 下載、
  // apt-get 安裝），所以只有 `--version` 那一種形式進得來 —— `isVersionQueryOnly`
  // 要求整段剛好兩個字。`curl <網址>`、`apt-get install` 一律還是要問。
  curl: (seg) => isVersionQueryOnly(seg),
  wget: (seg) => isVersionQueryOnly(seg),
  "apt-get": (seg) => isVersionQueryOnly(seg),
  apt: (seg) => isVersionQueryOnly(seg),
  apk: (seg) => isVersionQueryOnly(seg),
  yum: (seg) => isVersionQueryOnly(seg),
  dnf: (seg) => isVersionQueryOnly(seg),
  brew: (seg) => isVersionQueryOnly(seg),
  npm: (seg) => isVersionQueryOnly(seg),
  npx: (seg) => isVersionQueryOnly(seg),
  pnpm: (seg) => isVersionQueryOnly(seg),
  yarn: (seg) => isVersionQueryOnly(seg),
  corepack: (seg) => isVersionQueryOnly(seg),
  bun: (seg) => isVersionQueryOnly(seg),
  deno: (seg) => isVersionQueryOnly(seg),
  pip: (seg) => isVersionQueryOnly(seg),
  pip3: (seg) => isVersionQueryOnly(seg),
  // `go version` 與 `java -version` 是它們真正的拼法，共用的
  // `isVersionQueryOnly` 只認 `--version`/-v/-V。與其放寬那條共用規則
  //（那會連帶影響 node/python），不如給這兩個各自一條精確的。
  go: (seg) => /^go\s+(version|--version|-v)$/.test(seg.trim()),
  cargo: (seg) => isVersionQueryOnly(seg),
  rustc: (seg) => isVersionQueryOnly(seg),
  java: (seg) => /^java\s+(-version|--version)$/.test(seg.trim()),
  docker: (seg) => isVersionQueryOnly(seg),
};

/** `<interpreter> --version` (or -v / -V) and nothing besides. */
function isVersionQueryOnly(segment) {
  const words = segment.trim().split(/\s+/);
  return words.length === 2 && /^(-v|-V|--version)$/.test(words[1] ?? "");
}

/**
 * git subcommands that only read. Note what is NOT here any more: `branch`,
 * `tag` and `remote` are read-only only without their delete/rename flags, so
 * they are guarded below rather than listed.
 */
export const READ_ONLY_GIT = new Set([
  // `git --version` / `git version` 只印一行字，是 agent 最常做的探測之一。
  "version", "--version",
  "log", "status", "diff", "show", "blame", "describe", "rev-parse",
  "ls-files", "ls-tree", "cat-file", "shortlog", "branch", "tag", "remote",
]);

/** `git branch -D`, `git tag -d`, `git remote remove` … all mutate. */
const GIT_SUBCOMMAND_GUARDS = {
  branch: (rest) => !/\s-(d|D|m|M|c|C)\b|\s--(delete|move|copy|set-upstream|unset-upstream|edit-description)\b/.test(rest),
  tag: (rest) => !/\s-(d|f)\b|\s--(delete|force)\b/.test(rest) && !/^\s*tag\s+\S/.test(rest),
  remote: (rest) => /^\s*remote\s*(-v|--verbose|show|get-url)?\s*\S*\s*$/.test(rest),
};

function firstWord(segment) {
  return segment.trim().split(/\s+/)[0] ?? "";
}

/**
 * Would this command leave the machine exactly as it found it?
 *
 * Fail closed. Anything this function does not fully understand — unknown
 * syntax, a command that runs another command, an argument it has no rule for —
 * is NOT read-only. A wrong "no" here costs one approval click. A wrong "yes"
 * runs on the user's disk without them ever seeing it.
 */
export function isReadOnlyCommand(raw) {
  const cmd = String(raw ?? "").trim();
  if (!cmd) return false;
  // `2>&1` and `2>/dev/null` write nothing — judge what is left after them.
  // The unparseable-syntax check keeps looking at the ORIGINAL string: the
  // strip must never be able to hide a construct that ends the question.
  if (WRITES_VIA_SHELL.test(stripHarmlessRedirects(cmd))) return false;
  if (hasUnparseableSyntax(cmd)) return false;

  // 分段也看剝過的字串：重導向對參數守門一樣是雜訊。`node` 的守門是
  // `isVersionQueryOnly(seg)`，帶著 `2>&1` 的 `node --version 2>&1` 就過不了 ——
  // 同一個問題的第三種長相。剝掉的只有 `N>&M` 與 `>/dev/null`，塞不進任何酬載。
  const segments = stripHarmlessRedirects(cmd).split(/;|&&|\|\||\|/).filter((s) => s.trim());
  if (!segments.length) return false;

  return segments.every((segment) => {
    const word = firstWord(segment);
    if (!word) return false;
    // A wrapper's own name tells us nothing about what it will run.
    if (RUNS_SOMETHING_ELSE.has(word)) return false;
    if (word === "git") {
      const rest = segment.trim().slice(3);
      const sub = firstWord(rest);
      if (!READ_ONLY_GIT.has(sub)) return false;
      const guard = GIT_SUBCOMMAND_GUARDS[sub];
      return guard ? guard(rest) : true;
    }
    if (!READ_ONLY_COMMANDS.has(word)) return false;
    const guard = ARGUMENT_GUARDS[word];
    return guard ? guard(segment) : true;
  });
}

export function bashDestructiveRisk(cmd) {
  const c = String(cmd ?? "").trim();
  if (/\brm\s+(-\S*[rR]\S*|--recursive)/.test(c) || /\brm\s+-\S*f\S*\s+[/~]/.test(c))
    return "⚠️ Permanently deletes files/directories recursively — cannot be undone.";
  if (/\bmkfs\b|\bdd\s+if=|\bshred\b|>\s*\/dev\/[sh]d/.test(c))
    return "⚠️ Can wipe or overwrite a disk device — irreversible data loss.";
  if (/\bgit\s+push\b[^|]*(--force|-f\b)/.test(c) || /\bgit\s+push\s+-f/.test(c))
    return "⚠️ Force-push rewrites remote history and can destroy commits.";
  if (/\bdrop\s+(table|database|schema)\b/i.test(c) || /\btruncate\s+table\b/i.test(c))
    return "⚠️ Drops/truncates a database object — data is permanently lost.";
  if (/:\s*\(\s*\)\s*\{.*\|\s*:/.test(c)) return "⚠️ Looks like a fork bomb — will exhaust the machine.";
  return null;
}

/**
 * Refused before approval is even asked. Not a security boundary on its own —
 * containment and approval are — just the floor under a mis-click.
 */
/**
 * 每一條都帶著**它自己的理由**，不是一句共用的罐頭。
 *
 * 2026-09-11 實測到的事：`reboot` 被擋下來時使用者讀到的是「這個指令被目前的
 * 權限模式擋下來：」後面一個字都沒有 —— 因為這份清單原本只有 regex，
 * `classifyCommand` 對 denied 回 `risk: null`，而呼叫端寫的是 `${risk ?? ""}`。
 * **最嚴重的那一類拒絕，正好是唯一不說理由的。**
 *
 * 理由跟 regex 放在同一列，是為了讓「加一條規則」與「說得出為什麼」變成同一個
 * 動作 —— 分成兩份清單就會有人只加一半（這棵樹裡「一個概念兩份清單」已經咬過
 * 很多次）。`hardDenyReason` 底下那條測試會盯著每一列都有話講、而且彼此不同。
 */
export const HARD_DENIALS = [
  { re: /\brm\s+-\S*[rR]\S*\s+\/+(?:\s|$)/, why: "這會從根目錄整棵刪掉，救不回來。" },
  { re: /\brm\s+-\S*[rR]\S*\s+(~|\$HOME)\/?(?:\s|$)/, why: "這會把整個家目錄刪掉，救不回來。" },
  { re: /\bmkfs(\.\w+)?\b/, why: "這會把一個磁碟重新格式化，上面的東西全部消失。" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//, why: "這會直接覆寫一個磁碟裝置，覆寫掉的資料拿不回來。" },
  { re: /:\s*\(\s*\)\s*\{.*\|\s*:/, why: "這是 fork bomb，會把整台機器的資源吃光。" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: "這會關掉或重開整台機器，正在跑的東西會一起中斷。" },
  { re: />\s*\/dev\/(sd|hd|nvme)[a-z0-9]/, why: "這會直接寫進磁碟裝置，等於破壞上面的檔案系統。" },
];

/** 相容用的舊名字：只有 regex 的那一份。新的程式碼請用 `HARD_DENIALS`。 */
export const HARD_DENYLIST = HARD_DENIALS.map((d) => d.re);

export function isHardDenied(cmd) {
  const c = String(cmd ?? "").trim();
  return HARD_DENIALS.some((d) => d.re.test(c));
}

/** 擋下來的理由。沒有被擋就回 null —— 呼叫端用它分辨兩種情況。 */
export function hardDenyReason(cmd) {
  const c = String(cmd ?? "").trim();
  return HARD_DENIALS.find((d) => d.re.test(c))?.why ?? null;
}

/**
 * 指令字串裡看起來像「檔案路徑」的東西。
 *
 * 這是啟發式，而且**不可能完整** —— `$HOME`、`$(...)`、glob、先 `cd` 再讀，
 * 都躲得過。它能成立是因為它只做一個方向的事：**把自動放行降級成問一次**。
 * 漏看一個路徑，結果跟現在一樣（照原本的分級）；誤判一個路徑，代價是使用者
 * 多按一次同意。兩邊都不會比現狀糟。
 *
 * 反過來（用它來放行）就完全不行 —— 所以這個函式的回傳只被用在降級。
 */
function pathLikeTokens(cmd) {
  const out = [];
  // 去掉引號但保留裡面的內容：`cat '/etc/passwd'` 的路徑一樣要看得到。
  const bare = String(cmd ?? "").replace(/['"]/g, " ");
  for (const tok of bare.split(/[\s;|&<>()]+/)) {
    if (!tok) continue;
    if (tok.startsWith("-")) continue;             // 旗標不是路徑
    if (tok.startsWith("/") || tok.startsWith("~") || tok.includes("/")) out.push(tok);
  }
  return out;
}

/**
 * 把絕對路徑裡的 `.` 與 `..` 收乾淨 —— **純字串運算，不碰檔案系統**
 * （這支要能在判定的行程裡跑，而那裡沒有那個資料夾）。
 *
 * 2026-09-10 我為了驗白名單而寫的測試順手抓到的既有漏洞：
 * `cat /workspace/../secret` 被判成 `read_only`。因為底下的判斷對絕對路徑
 * **只比前綴**，而那個字串的前綴是 `/workspace/`，`..` 卻讓它實際解析到
 * `/secret`。相對路徑那一段本來就逐段算過 `..`，絕對路徑那一段沒有。
 *
 * 不處理 symlink —— 那要碰檔案系統，而這裡只做語法上的收斂。少了它仍然比
 * 只比前綴嚴格，多出來的那個洞（symlink 指向界外）記在 OUTSTANDING。
 */
function normalizeAbsolute(t) {
  const out = [];
  for (const seg of t.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  return "/" + out.join("/");
}

/**
 * 這些路徑**不承載任何使用者資料**，所以碰到它們不算跨界。
 *
 * 2026-09-10 實測：`/loop`、`/init`、`/review` 三個指令跑起來各自都停在核准卡上，
 * 理由都是「這個指令要讀授權資料夾外面的東西：/dev/null」—— 而觸發它的是
 * `2>/dev/null`，一個把 stderr 丟掉的慣用寫法。判定在技術上正確（那是絕對路徑、
 * 不在工作區底下）而在語意上錯誤：丟進 /dev/null 的東西沒有人讀得到，
 * 從 /dev/null 讀出來的是空的。
 *
 * 這是**閘門對正確行為變紅**，而它的代價比誤報更高：每一個用了 `2>/dev/null`
 * 的指令都要人按一次，於是人開始無腦按「一律允許」，那道界就真的沒了。
 *
 * 是白名單而不是 `/dev/` 前綴規則 —— `/dev/mem`、`/dev/sda`、`/dev/kmsg`
 * 是真的敏感。`stdin`/`stdout`/`stderr`/`fd/N` 是這個行程自己的流，
 * `random`/`urandom`/`zero`/`null` 是不帶資訊的裝置。
 */
const CARRIES_NO_DATA = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
]);

/** `/dev/fd/3`、`/proc/self/fd/1` —— 都是這個行程自己的檔案描述子。 */
const OWN_FD = /^\/(?:dev\/fd|proc\/self\/fd)\/\d+$/;

/**
 * 這個路徑跑出授權資料夾外面了嗎？
 *
 * `root` 是使用者授權的資料夾（絕對路徑）。判斷刻意保守：
 * 看不懂的一律當成**沒有**出界（那樣只會回到現狀，不會放行本來擋著的東西）。
 */
/**
 * `aliases`：同一個授權資料夾的**其他名字**。雲端對話的工作目錄在系統提示裡叫
 * `/ava/<對話 id>`，在沙盒裡是指向 `/workspace` 的符號連結 —— 模型照提示寫出來
 * 的路徑用的是那個名字（AGENT-577，見 test/session-alias-is-inside-root.test.mjs）。
 * 檔案工具那條路（`toRelative` 的 `aliases`）早就兩個都收，這裡跟它同一條規則。
 */
export function escapesRoot(token, root, aliases = []) {
  if (!root) return false;
  const t = String(token ?? "");
  if (CARRIES_NO_DATA.has(t) || OWN_FD.test(t)) return false;
  // `~` 一定不在授權資料夾裡（除非授權的就是家目錄，那也該問一次）
  if (t === "~" || t.startsWith("~/")) return true;
  if (!t.startsWith("/")) {
    // 相對路徑：只有 `..` 走得出去。逐段算，走到負的就是出界。
    if (!t.includes("..")) return false;
    let depth = 0;
    for (const seg of t.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") { if (--depth < 0) return true; continue; }
      depth++;
    }
    return false;
  }
  // 先收斂再比前綴 —— 只比前綴的話 `/workspace/../secret` 會被當成界內。
  const abs = normalizeAbsolute(t);
  return ![root, ...aliases].filter(Boolean).some((r) => {
    const rootAbs = normalizeAbsolute(r);
    const base = rootAbs.endsWith("/") ? rootAbs : `${rootAbs}/`;
    return abs === rootAbs || abs.startsWith(base);
  });
}

/**
 * One verdict for the daemon's dispatcher:
 *   denied         → refuse, never ask
 *   read_only      → run without asking
 *   needs_approval → require a valid approval token (risk goes on the card)
 *
 * `root` 是使用者授權的資料夾。有給的話，**唯讀指令碰到界外路徑也要問** ——
 * 分級規則本身只看動詞（`cat` 在允許清單裡），所以 `cat ~/.ssh/id_rsa`
 * 原本會自動放行、不問任何人。使用者選那個資料夾就是為了劃界，
 * 而界只劃到檔案工具、沒劃到 bash。
 *
 * 只降級不升級：看不懂的路徑一律當成沒出界，所以最壞的情況是回到原本的行為。
 */
/**
 * 看起來像憑證的東西。**不管路徑解不解得開，碰到就要問。**
 *
 * 為什麼需要這一條，而不是靠上面那個「出了授權資料夾就問」：那個判斷要先把
 * token 解析成絕對路徑，而 `$HOME/.npmrc`、`~/.aws/credentials`、
 * `cd ~ && cat .ssh/id_rsa` 全都解不開 —— 解不開就照原本的分級走，而 `cat`
 * 在唯讀清單裡，所以**自動放行、不問任何人**。2026-09-11 的資安審查實測到的
 * 就是這個：`cat $HOME/.npmrc` 與 `cat $HOME/.config/service/credentials`
 * 都被判成 read_only。
 *
 * 所以這一條不看路徑，只看**名字**：指令字串裡出現這些形狀就降級成要核准。
 * 跟上面同一個方向 —— 只降級不升級，所以誤判的代價是多按一次同意，
 * 而漏看的代價回到原本的行為。
 *
 * 蓋不到用變數繞開名字的情況（`cat $F`），那需要真的執行才知道，
 * 不是靜態分析做得到的事。這裡只是把最常見、而且一讀就外洩的那幾個補起來。
 */
const CREDENTIAL_SHAPES = [
  /\.ssh\b/i,
  /\bid_(rsa|dsa|ecdsa|ed25519)\b/i,
  /\.aws\b/i,
  /\.npmrc\b/i,
  /\.netrc\b/i,
  /\.pypirc\b/i,
  /\.gnupg\b/i,
  /\.kube\b/i,
  /\.docker\/config\.json/i,
  /\bcredentials?\b/i,
  /\bsecrets?\b/i,
  /\.env(\.[A-Za-z0-9_.-]+)?\b/i,
  /\bkeychain\b/i,
  /\.pem\b/i,
  /\.p12\b/i,
  /\bserviceaccount[^\s]*\.json/i,
];

/** 指令裡提到的憑證形狀（給卡片顯示用，最多幾個）。 */
export function credentialShapesIn(cmd) {
  const c = String(cmd ?? "");
  const hit = [];
  for (const re of CREDENTIAL_SHAPES) {
    const m = re.exec(c);
    if (m) hit.push(m[0]);
  }
  return [...new Set(hit)];
}

export function classifyCommand(cmd, { root = "", aliases = [] } = {}) {
  // 理由跟判定一起回。`risk` 對 denied 曾經一律是 null，於是唯一一句
  // 「不問也不跑」的訊息是所有訊息裡唯一不說原因的那一句（F-28）。
  const denied = hardDenyReason(cmd);
  if (denied) return { verdict: "denied", risk: denied };
  if (isReadOnlyCommand(cmd)) {
    // 憑證形狀優先：它不需要路徑解析得開，而那正是上面那條漏掉的情況。
    const creds = credentialShapesIn(cmd);
    if (creds.length > 0) {
      return {
        verdict: "needs_approval",
        risk: `這個指令看起來要讀憑證：${creds.slice(0, 3).join("、")}`,
        credentials: creds.slice(0, 8),
      };
    }
    // 去重：`cmd 2>/dev/null | x 2>/dev/null` 會讓同一個路徑出現兩次，
    // 而卡片上寫「/dev/null、/dev/null」看起來像兩個不同的東西。
    const outside = root
      ? [...new Set(pathLikeTokens(cmd).filter((t) => escapesRoot(t, root, aliases)))]
      : [];
    if (outside.length === 0) return { verdict: "read_only", risk: null };
    return {
      verdict: "needs_approval",
      risk: `這個指令要讀授權資料夾外面的東西：${outside.slice(0, 3).join("、")}`,
      outsideRoot: outside.slice(0, 8),
    };
  }
  // 不是唯讀的指令本來就要核准，但卡片上該說出**為什麼要小心**。碰到憑證形狀
  // 時把它講出來 —— 「這個指令會改東西」跟「這個指令會讀你的金鑰」是兩種風險，
  // 而使用者是看著那句話按下同意的。
  const creds = credentialShapesIn(cmd);
  const destructive = bashDestructiveRisk(cmd);
  if (creds.length > 0) {
    const note = `這個指令看起來會碰到憑證：${creds.slice(0, 3).join("、")}`;
    return {
      verdict: "needs_approval",
      risk: destructive ? `${destructive}；${note}` : note,
      credentials: creds.slice(0, 8),
    };
  }
  return { verdict: "needs_approval", risk: destructive };
}
