/**
 * 直接啟動 Chrome 要帶「不碰作業系統密碼庫」的旗標（chrome-launch-policy.mjs，owner 2026-10-22）。
 * 反例用使用者那台 Mac 上模型真的跑過的兩條指令；正例是同一條加上旗標。
 * Run: node --test runtime/packages/ava-local-protocol/src/chrome-launch-policy.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chromeLaunchRefusal, splitSimpleCommands } from "./chrome-launch-policy.mjs";

const MAC = '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"';
const FLAGS = "--use-mock-keychain --password-store=basic";

test("反例（真實）：模型在使用者 Mac 上直接開 headless Chrome、沒帶旗標 → 拒絕，並說清楚缺什麼、怎麼改", () => {
  const r = chromeLaunchRefusal(`${MAC} --headless=new --no-sandbox --disable-gpu --user-data-dir=/tmp/cpro123 --dump-dom about:blank`);
  assert.equal(r?.code, "chrome_launch_flags");
  assert.deepEqual(r.missing, ["--use-mock-keychain", "--password-store=basic"]);
  assert.match(r.message, /localbrowser/);
  assert.match(r.message, /--use-mock-keychain/);
  assert.match(r.message, /--user-data-dir/);
});

test("反例（真實）：--version 不開 profile → 放行", () => {
  assert.equal(chromeLaunchRefusal(`${MAC} --version`), null);
  assert.equal(chromeLaunchRefusal("google-chrome --version"), null);
});

test("正例：同一條加上兩個旗標和暫存 profile → 放行", () => {
  assert.equal(chromeLaunchRefusal(`${MAC} --headless=new ${FLAGS} --user-data-dir=/tmp/cpro123 about:blank`), null);
});

test("反例：只帶一個旗標、或沒有暫存 profile → 仍拒絕，並指出缺的那一個", () => {
  assert.deepEqual(chromeLaunchRefusal(`${MAC} --headless --use-mock-keychain --user-data-dir=/tmp/x`).missing, ["--password-store=basic"]);
  assert.deepEqual(chromeLaunchRefusal(`${MAC} --headless ${FLAGS}`).missing, ["--user-data-dir=<暫存目錄>"]);
});

test("各種寫法的 Chrome／Chromium 都認得（路徑、名稱、包裝指令、bash -c、管線之後）", () => {
  for (const cmd of [
    "google-chrome --headless --dump-dom https://x",
    "/usr/bin/google-chrome-stable --headless",
    "chromium --headless",
    "chromium-browser --headless",
    "/Applications/Chromium.app/Contents/MacOS/Chromium --headless",
    "FOO=1 timeout 30 google-chrome --headless",
    "sudo -n google-chrome --headless",
    "env DISPLAY=:0 nohup chromium --headless &",
    `cd /tmp && ${MAC} --headless`,
    `echo hi; ${MAC} --headless | tee out.txt`,
    `bash -c '${MAC} --headless --user-data-dir=/tmp/x'`,
    `sh -lc "chromium --headless"`,
    "xvfb-run -a google-chrome --headless",
  ]) assert.equal(chromeLaunchRefusal(cmd)?.code, "chrome_launch_flags", cmd);
});

test("open -a／-b 叫起使用者自己的 Chrome → 拒絕（沒有旗標可加，改用 localbrowser）", () => {
  for (const cmd of ['open -a "Google Chrome" https://x', "open -a 'Google Chrome.app' file.html", "open -b com.google.Chrome https://x", "open -a Chromium x.html"]) {
    assert.equal(chromeLaunchRefusal(cmd)?.code, "chrome_open_app", cmd);
  }
  assert.equal(chromeLaunchRefusal('open -a "Visual Studio Code" .'), null);
  assert.equal(chromeLaunchRefusal("open ."), null);
});

test("不誤傷：Chrome 只是引數、字串、路徑的一部分，或別的程式 → 放行", () => {
  for (const cmd of [
    'echo "google-chrome --headless"',
    "grep -r chrome src/",
    "ls /Applications/Google\\ Chrome.app",
    "cat '/Applications/Google Chrome.app/Contents/Info.plist'",
    "npm i puppeteer-core",
    "node scripts/check.mjs --browser chrome",
    "python3 qa/web_check.py",
    "chrome-devtools-mcp --headless",
    "git commit -m 'run google-chrome --headless'",
    "pkill chrome",
    "ls",
    "",
  ]) assert.equal(chromeLaunchRefusal(cmd), null, cmd);
});

test("Windows 的 chrome.exe 不在這條規則裡（Windows 沒有鑰匙圈）", () => {
  assert.equal(chromeLaunchRefusal('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless'), null);
  assert.equal(chromeLaunchRefusal("start chrome https://x"), null);
});

test("拆指令：引號裡的運算子不算分隔", () => {
  assert.deepEqual(splitSimpleCommands(`echo "a;b" && ls | wc`), [["echo", "a;b"], ["ls"], ["wc"]]);
});
