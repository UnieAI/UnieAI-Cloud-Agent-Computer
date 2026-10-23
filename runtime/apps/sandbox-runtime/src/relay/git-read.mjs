/**
 * git-read.mjs — 「這個資料夾現在跟 HEAD 差什麼」，一扇只走得通這件事的窄門。
 *
 * ## 為什麼需要它
 *
 * 「檢閱」在使用者自己的電腦上，看的是**變更工具留下的卡片**。可是 agent 在
 * 本機常常整輪用 bash 做事（`sed -i`、`mv`、`git rm`、`>` 重導向、`npm install`）
 * —— 那些改動一張卡片都不會留下，於是檢閱看起來像「什麼都沒改」，而那一輪其實
 * 改了一整個專案（roy 2026-09-06：「檢閱是都沒用嗎」）。
 *
 * 使用者的專案幾乎一定是 git repo，而「跟 HEAD 差什麼」正是他要看的那件事，
 * 也是唯一**不需要我們事先記下原始內容**就能回答的來源。
 *
 * ## 為什麼不是直接開 exec
 *
 * `/v1/relay/machines/:id/invoke` 這扇 ad-hoc 門只開三個唯讀檔案操作
 * （readFile / statFile / listFiles）。把 `exec` 加進去等於讓 app 這一層可以在
 * 使用者的筆電上跑任意指令字串 —— 只要有任何一條路徑把使用者輸入接進去，
 * 那就是他電腦上的 RCE。這個專案在 2026-07 已經吃過一次「app 容器裡跑到
 * 外部指令」的虧。
 *
 * 所以這扇門收的**不是指令，是意圖**：`{ cmd: "status" | "numstat" | "diff" |
 * "toplevel", path? }`。指令字串在這裡組出來，呼叫端連一個字元都插不進去，
 * 只有路徑會進去、而且是引號包起來的一個參數。
 *
 * ## 還有三道牆在後面
 *
 * · 這裡的白名單全部是唯讀 git 子指令，沒有一條會改東西。
 * · daemon 自己還會分級一次（`shell-policy.mjs`）：`git status` / `git diff`
 *   是唯讀動詞，自動放行；真要有人想把 `git push --force` 塞進來，那份規則
 *   會擋，而且不是靠這裡。
 * · cwd 與 path 一樣要經過 daemon 的 `containPath`，出了授權資料夾就是
 *   `outside_root`。
 *
 * ## 為什麼不用 `git -C <資料夾>`
 *
 * 分級器看 `git` 後面的**第一個字**決定是不是唯讀，看到 `-C` 就不認得了 ——
 * 於是每一次檢閱都會在使用者畫面上跳一張核准卡（2026-09-06 量到）。改用
 * exec 自己的 `cwd`，指令就以 `git status` 開頭，分級器認得。
 */

/** 允許的意圖 → 指令樣板。`%p` 是唯一的插入點，而且一定會被引號包起來。 */
const READS = {
  /** 這個資料夾是不是 git repo，以及它的根在哪。 */
  toplevel: () => "git rev-parse --show-toplevel",
  /**
   * 改了哪些檔案。`-uall` 是刻意的：agent 用 bash 新建的檔案是 untracked，
   * 少了它，「新增」那一類會整批消失 —— 而那正是最需要被看到的一類。
   * `-z` 用 NUL 分隔，檔名有空白或中文時才不會被拆錯。
   */
  status: () => "git status --porcelain=v1 -uall -z",
  /** 每個檔案加了幾行刪了幾行。untracked 不在裡面（git 本來就不算它）。 */
  numstat: () => "git diff --numstat -z HEAD --",
  /**
   * 一個檔案的 unified diff，**帶整份上下文**。
   *
   * `-U100000` 不是為了保險，是為了那個版面：檢閱要像「打開那個檔案、上面標著
   * 哪幾行變了」，而不是「幾段沒頭沒尾的 hunk」（roy 2026-09-06）。整份上下文
   * 之後，同一份 unified diff 就同時是「整個檔案」與「改了哪裡」，
   * 面板那邊一行都不用重建檔案內容。
   */
  diff: (path) => `git diff HEAD -U100000 -- ${quote(path)}`,
};

/** 單引號包起來，內部的單引號用 `'\\''` 收掉。shell 的老規矩。 */
export function quote(value) {
  return `'${String(value ?? "").replace(/'/g, "'\\''")}'`;
}

export const GIT_READS = Object.freeze(Object.keys(READS));

/**
 * 意圖 → 真的要跑的那一行。
 *
 * @param {string} cmd `GIT_READS` 裡的一個。
 * @param {string} [path] 只有 `diff` 用得到。
 * @returns {string|null} 指令，或 null（不認得的意圖）。
 */
export function gitReadCommand(cmd, path) {
  const make = READS[String(cmd ?? "")];
  if (!make) return null;
  // 路徑只允許單純的一個參數：換行、NUL 這種東西進不了引號裡還能作怪，
  // 但它們會讓輸出無法解析，早點擋掉比較誠實。
  if (make.length > 0) {
    const p = String(path ?? "");
    if (!p || p.includes("\0") || p.includes("\n")) return null;
    return make(p);
  }
  return make();
}
