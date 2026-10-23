/**
 * 授權資料夾要綁得住 bash，不只綁得住檔案工具。
 *
 * 實測發現的洞：分級規則看的是**動詞**不是路徑。`cat` 在唯讀允許清單裡，
 * 所以 `cat ~/.ssh/id_rsa` 自動放行 —— 不問核准，也不看路徑在不在授權資料夾裡。
 * 同一個檔案走 readFile 會被 containPath 擋掉。使用者選那個資料夾是為了劃界，
 * 而界只劃到一半。
 *
 * 這個檢查是**啟發式**，而且刻意只做一個方向：把自動放行降級成問一次。
 * 漏看一個路徑 → 回到原本的行為；誤判一個 → 多按一次同意。
 * 兩邊都不會比現狀糟。用它來放行才是危險的，所以沒有那條路。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyCommand, escapesRoot } from "./shell-policy.mjs";

const ROOT = "/home/dev/work";

test("唯讀動詞讀界外，要問過人", () => {
  // 這幾條刻意**不含憑證形狀**：它們驗的是「路徑出了授權資料夾」那條規則。
  // 憑證那條（2026-09-11 加的）會先命中，訊息不一樣，兩條各自有自己的測試。
  for (const cmd of [
    "cat /etc/passwd",
    "cat ../機密/筆記.txt",
    "head /home/dev/機密/x",
    "grep -rn TODO /home/other/proj",
  ]) {
    const v = classifyCommand(cmd, { root: ROOT });
    assert.equal(v.verdict, "needs_approval", `${cmd} 竟然自動放行`);
    assert.match(v.risk, /授權資料夾外面/);
  }
});

/**
 * 憑證形狀不需要路徑解析得開。
 *
 * 上面那條要先把 token 變成絕對路徑，而 `$HOME/.npmrc`、`cd ~ && cat .aws/…`
 * 解不開 —— 解不開就照原本分級走，而 `cat` 在唯讀清單裡，所以自動放行。
 * 2026-09-11 的資安審查實測到的就是這個。
 */
test("看起來像憑證的東西，路徑解不開也要問", () => {
  for (const cmd of [
    "cat $HOME/.npmrc",
    "cat $HOME/.config/service/credentials",
    "cat ~/.ssh/id_rsa",
    "cd ~ && cat .aws/credentials",
    "grep -r token .env",
  ]) {
    const v = classifyCommand(cmd, { root: ROOT });
    assert.equal(v.verdict, "needs_approval", `${cmd} 竟然自動放行`);
    assert.match(v.risk, /憑證/);
  }
});

test("憑證那條只降級不升級 —— 一般的唯讀指令不能被它掃到", () => {
  for (const cmd of ["ls -la", "cat README.md", "grep -rn TODO ./src", "cat src/index.ts"]) {
    assert.equal(classifyCommand(cmd, { root: ROOT }).verdict, "read_only", `${cmd} 被誤判了`);
  }
});

test("在授權資料夾裡的唯讀指令照樣不問 —— 不然每一步都要點一次", () => {
  for (const cmd of [
    "ls -la",
    "cat README.md",
    "cat /home/dev/work/src/index.ts",
    "grep -rn TODO ./src",
    "cat ./a/../b.txt",
  ]) {
    assert.equal(classifyCommand(cmd, { root: ROOT }).verdict, "read_only", `${cmd} 被多問了`);
  }
});

test("沒給 root 就跟以前一樣 —— 不能因為漏傳參數就把所有東西擋掉", () => {
  assert.equal(classifyCommand("cat /etc/passwd").verdict, "read_only");
});

test("會寫的指令本來就要問，這個改動不影響它們", () => {
  assert.equal(classifyCommand("rm -rf build", { root: ROOT }).verdict, "needs_approval");
  assert.equal(classifyCommand("echo x > a.txt", { root: ROOT }).verdict, "needs_approval");
});

test("硬性拒絕的還是拒絕，不會被降級成「問一下」", () => {
  const v = classifyCommand("rm -rf /", { root: ROOT });
  assert.equal(v.verdict, "denied");
});

test("escapesRoot：只在看得懂的時候說出界", () => {
  assert.equal(escapesRoot("/etc/passwd", ROOT), true);
  assert.equal(escapesRoot("~", ROOT), true);
  assert.equal(escapesRoot("~/x", ROOT), true);
  assert.equal(escapesRoot("../x", ROOT), true);
  assert.equal(escapesRoot("a/../../x", ROOT), true);
  assert.equal(escapesRoot("/home/dev/work/x", ROOT), false);
  assert.equal(escapesRoot("src/a.ts", ROOT), false);
  assert.equal(escapesRoot("a/../b", ROOT), false);
  // 前綴一樣但不是同一個資料夾
  assert.equal(escapesRoot("/home/dev/work-其他/x", ROOT), true);
  // 看不懂的一律當成沒出界（最壞回到現狀）
  assert.equal(escapesRoot("$HOME/.ssh/id_rsa", ROOT), false);
  assert.equal(escapesRoot("x", ROOT), false);
})
