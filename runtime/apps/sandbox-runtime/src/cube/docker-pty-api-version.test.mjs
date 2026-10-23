/**
 * Docker Engine API 的版本:釘住，但不能釘到 daemon 不收的那一版。
 *
 * ── 線上實際發生的事（2026-09-08）────────────────────────────────────────
 *
 * 使用者按「開終端機」，面板顯示「現在連不上終端機」。往下追是:
 *
 *   Docker 開不了終端機 (400): client version 1.43 is too old.
 *   Minimum supported API version is 1.44
 *
 * 這台機器的 Docker 是 29.1.3（API 1.52、最低 1.44），而我們釘死在 v1.43。
 *
 * ── 為什麼不是「拿掉釘子」──────────────────────────────────────────────
 *
 * 釘住的理由是對的，原註解寫著: resize 與 hijack 的語意從 1.24 起就沒動過，
 * 不釘版本的話一次 docker 升級就可能改掉回應形狀，而那種壞法只會在生產環境
 * 出現。拿掉釘子等於把那個保護還回去。
 *
 * 壞的是**它沒有下限**。daemon 會升它的最低版本（這次就是），而一個釘死的
 * 客戶端版本遲早會掉到那條線以下。所以:偏好版本照舊釘著，但如果 daemon 說
 * 它的最低是更高的那一版，就用 daemon 的最低 —— 那是「還能用的最舊的一版」，
 * 也就是離原本那個保護最近的選擇。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pickApiVersion } from "./docker-pty.mjs";

test("daemon 收得下偏好版本 → 就用偏好的（釘子還在）", () => {
  assert.equal(pickApiVersion({ preferred: "v1.43", daemonMin: "1.24", daemonMax: "1.52" }), "v1.43");
});

test("daemon 的最低比偏好新 → 用 daemon 的最低，不是它的最新", () => {
  // 2026-09-08 線上就是這一格。用 daemon 的**最低**而不是最新，是為了離
  // 原本那個「不要騎在最新版上」的保護最近。
  assert.equal(pickApiVersion({ preferred: "v1.43", daemonMin: "1.44", daemonMax: "1.52" }), "v1.44");
});

test("問不到 daemon 的版本 → 退回偏好版本，不要自己猜一個新的", () => {
  // 猜一個新版本等於把釘子拿掉；退回偏好版本至少維持今天的行為，
  // 而真的不相容時錯誤訊息會照實說（就像這次那樣）。
  assert.equal(pickApiVersion({ preferred: "v1.43", daemonMin: null, daemonMax: null }), "v1.43");
  assert.equal(pickApiVersion({ preferred: "v1.43" }), "v1.43");
});

test("版本比較是數字的，不是字串的", () => {
  // "1.9" > "1.10" 在字串比較上成立，而那會讓一個夠新的 daemon 被當成太舊。
  assert.equal(pickApiVersion({ preferred: "v1.9", daemonMin: "1.10", daemonMax: "1.52" }), "v1.10");
  assert.equal(pickApiVersion({ preferred: "v1.44", daemonMin: "1.9", daemonMax: "1.52" }), "v1.44");
});

test("看不懂的版本字串 → 退回偏好版本，不要當成 0", () => {
  // 當成 0 的話任何垃圾都會「小於偏好版本」而靜靜通過。
  assert.equal(pickApiVersion({ preferred: "v1.43", daemonMin: "abc", daemonMax: "x" }), "v1.43");
  assert.equal(pickApiVersion({ preferred: "v1.43", daemonMin: "", daemonMax: "" }), "v1.43");
});

test("api() 回的是 {status, text} —— 這條釘住我抄錯過的那個形狀", () => {
  // 第一版我寫成 `res.body.MinAPIVersion`。`api()` 回的是 `{status, text}`，
  // 所以那個值永遠是 undefined、協商永遠不發生，而症狀跟沒改之前**一模一樣**
  // （client version 1.43 is too old）。修好了但沒生效，比沒修更難發現。
  const src = readFileSync(new URL("./docker-pty.mjs", import.meta.url), "utf8");
  const at = src.indexOf("async function apiVersion");
  assert.ok(at > 0, "找不到 apiVersion —— docker-pty.mjs 的結構變了");
  // **先剝掉註解。** 這個檔案的註解裡就寫著 `res.body.MinAPIVersion` 當反例，
  // 而第一版的檢查被自己的說明文字絆倒 —— 一個對正確程式碼變紅的閘門，
  // 下一個人會直接刪掉它。
  const fn = src.slice(at, src.indexOf("\n}", at) + 2)
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(fn, /JSON\.parse\(\s*res\.text\s*\)/, "沒有解析 res.text —— api() 不回解析好的 body");
  assert.doesNotMatch(fn, /res\??\.body/, "又抄成 res.body 了");
});
