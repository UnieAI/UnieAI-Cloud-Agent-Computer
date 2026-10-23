/**
 * 這扇門收的是**意圖，不是指令**。
 *
 * 「檢閱」要看那個資料夾跟 HEAD 差什麼，所以 app 這一層需要在使用者的電腦上跑
 * git。ad-hoc 那扇門刻意不開 `exec` —— 開了等於 app 可以在別人的筆電上跑任意
 * 指令字串，而只要有任何一條路徑把使用者輸入接進去，那就是他電腦上的 RCE。
 *
 * 所以指令在伺服器端組，呼叫端只能說「我要 status」。這條測試守的就是那句話：
 * 白名單之外的東西組不出指令，而路徑只會變成一個引號包好的參數。
 */
import test from "node:test"
import assert from "node:assert/strict"

import { GIT_READS, gitReadCommand, quote } from "./git-read.mjs"

test("白名單之外的意圖組不出任何指令", () => {
  for (const bad of ["", "push", "exec", "status; rm -rf /", "STATUS", null, undefined, 1, {}]) {
    assert.equal(gitReadCommand(bad), null, `${JSON.stringify(bad)} 竟然組得出指令`)
  }
  assert.deepEqual(GIT_READS, ["toplevel", "status", "numstat", "diff"])
})

test("組出來的都是唯讀 git，而且以 `git <子指令>` 開頭", () => {
  // 開頭很重要：daemon 的分級器看 `git` 後面第一個字決定是不是唯讀。
  // 寫成 `git -C <資料夾> status` 的話它認不出來，每一次檢閱都會跳核准卡。
  for (const cmd of ["toplevel", "status", "numstat"]) {
    const line = gitReadCommand(cmd)
    assert.match(line, /^git (rev-parse|status|diff) /, `${cmd} → ${line}`)
    assert.doesNotMatch(line, /^git -C/, "用了 -C，分級器會認不出這是唯讀")
  }
})

test("路徑只會是一個引號包好的參數 —— 塞得進引號，塞不出指令", () => {
  const line = gitReadCommand("diff", "src/a b'; rm -rf ~/#.ts")
  assert.equal(line, `git diff HEAD -U100000 -- 'src/a b'\\''; rm -rf ~/#.ts'`)
  // 逃出引號的那一手（`'`）被 `'\''` 收掉了，所以整段仍然是**一個**參數。
  assert.equal(quote("a'b"), `'a'\\''b'`)
})

test("換行與 NUL 直接拒收 —— 它們過得了引號，但會讓輸出無法解析", () => {
  assert.equal(gitReadCommand("diff", "a\nb"), null)
  assert.equal(gitReadCommand("diff", "a\0b"), null)
  assert.equal(gitReadCommand("diff", ""), null)
  assert.equal(gitReadCommand("diff"), null)
})

test("不吃路徑的意圖，路徑給了也不會被接進去", () => {
  assert.equal(gitReadCommand("status", "; rm -rf /"), "git status --porcelain=v1 -uall -z")
})
