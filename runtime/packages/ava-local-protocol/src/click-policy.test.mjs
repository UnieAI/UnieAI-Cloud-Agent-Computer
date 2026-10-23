import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_LIMITS,
  PASSKEY_CATEGORIES,
  canAutoApprove,
  classifyClick,
  claimMatch,
  createClickBudget,
  isActivationKey,
  isSensitiveOrigin,
  requiresFreshPasskey,
  stricter,
} from "./click-policy.mjs";

/**
 * click_at 的確定性分類（docs/ava/2026-10-02-click-at-design.md §2）。
 *
 * 規矩：
 *  - **只有規則明確判為非重大（routine）才可能自動核准**；判不出、資訊不足一律是 major（D6）。
 *  - 文字信號（aria-label／可見文字）**只能升級，不能降級**：頁面可以把付款鈕標成「取消」。
 *  - 這是給「正常網站」的安全網，不是對抗惡意頁面的邊界（純 JS 的按鈕看不出它要做什麼）。
 */

/** 一個明確是「同網域一般連結」的解析結果。每個測試只改它要改的那一欄。 */
function res(over = {}, hitOver = {}) {
  return {
    v: 1,
    integrity: { nativeOk: true },
    viewport: { w: 1280, h: 720, dpr: 1, scale: 1, offX: 0, offY: 0 },
    page: { origin: "https://news.example.org", path: "/articles/42" },
    point: { x: 100, y: 200 },
    overlays: 0,
    docToken: 1_700_000_000_000,
    hit: {
      tag: "a",
      role: "link",
      name: "Read more",
      text: "Read more",
      href: { protocol: "https:", host: "news.example.org", path: "/articles/43" },
      formAction: null,
      formMethod: null,
      inputType: null,
      autocomplete: null,
      download: false,
      disabled: false,
      bbox: { x: 90, y: 190, w: 80, h: 20 },
      covered: false,
      inDialog: false,
      frame: "main",
      shadow: false,
      interactive: true,
      submits: false,
      hasTextarea: false,
      formFieldTypes: [],
      formHasPersonal: false,
      ...hitOver,
    },
    ...over,
  };
}

const tier = (r, opts) => classifyClick(r, opts).tier;
const cat = (r, opts) => classifyClick(r, opts).category;

test("基準：同網域一般連結 → routine", () => {
  assert.equal(tier(res()), "routine");
  assert.equal(cat(res()), null);
});

// ── 付款／結帳／轉帳 ───────────────────────────────────────────────────────
test("付款：結構信號（path／form action／autocomplete／支付商網域）各自就是 major(payment)", () => {
  assert.equal(cat(res({ page: { origin: "https://shop.example.com", path: "/checkout" } }, { tag: "button", role: "button", href: null, interactive: true })), "payment");
  assert.equal(cat(res({}, { tag: "button", role: "button", href: null, submits: true, formAction: { host: "shop.example.com", path: "/api/pay" }, formMethod: "post" })), "payment");
  assert.equal(cat(res({}, { tag: "input", role: "textbox", href: null, inputType: "text", autocomplete: "cc-number" })), "payment");
  assert.equal(cat(res({}, { href: { protocol: "https:", host: "checkout.stripe.com", path: "/c/pay/cs_123" } })), "payment");
  assert.equal(cat(res({ page: { origin: "https://www.paypal.com", path: "/signin" } })), "payment"); // 在支付商網域上的任何點擊
});

test("偽造 aria-label：付款鈕被標成「取消」仍是 major —— 結構信號不看文字", () => {
  const r = res({ page: { origin: "https://shop.example.com", path: "/checkout/pay" } }, { tag: "button", role: "button", href: null, name: "取消", text: "取消" });
  assert.equal(tier(r), "major");
  assert.equal(cat(r), "payment");
});

// ── 文字只能升級 ───────────────────────────────────────────────────────────
test("文字單獨命中（沒有任何結構信號）→ 升級成 major", () => {
  assert.equal(cat(res({}, { name: "Delete account", text: "Delete account" })), "delete");
  assert.equal(cat(res({}, { name: "Buy now", text: "Buy now" })), "payment");
  assert.equal(cat(res({}, { name: "寄出", text: "寄出" })), "message");
});

test("文字不降級也不誤升：結構 routine ＋ 無害文字 → routine", () => {
  assert.equal(tier(res({}, { name: "Cancel", text: "Cancel" })), "routine");
  assert.equal(tier(res({}, { name: "Payment history is not available", text: "" })) === "major", true); // 含 payment 字樣：只升不降
});

// ── 訊息／刪除／個資表單 ───────────────────────────────────────────────────
test("寄信／送訊息／發文：compose／send 路徑、POST 表單含 textarea", () => {
  assert.equal(cat(res({ page: { origin: "https://mail.example.com", path: "/compose" } }, { tag: "button", role: "button", href: null })), "message");
  assert.equal(cat(res({}, { tag: "button", role: "button", href: null, submits: true, hasTextarea: true, formMethod: "post", formAction: { host: "forum.example.com", path: "/thread/9/reply" } })), "message");
});

test("刪除：delete／remove 路徑、href 含 delete", () => {
  assert.equal(cat(res({}, { href: { protocol: "https:", host: "news.example.org", path: "/account/delete" } })), "delete");
  assert.equal(cat(res({}, { tag: "button", role: "button", href: null, formAction: { host: "x.example.com", path: "/items/3/remove" }, formMethod: "post", submits: true })), "delete");
});

test("含個資的表單送出 → major(personal_form)", () => {
  const r = res({}, { tag: "button", role: "button", href: null, submits: true, formMethod: "post", formAction: { host: "x.example.com", path: "/profile" }, formFieldTypes: ["text", "email", "tel"], formHasPersonal: true });
  assert.equal(cat(r), "personal_form");
});

// ── 帳密／OTP／卡號欄位 ─────────────────────────────────────────────────────
test("credential：password／one-time-code／cc-*／current-password／new-password", () => {
  for (const [inputType, autocomplete] of [["password", null], ["text", "one-time-code"], ["text", "cc-csc"], ["text", "cc-exp"], ["text", "current-password"], ["text", "new-password"]]) {
    const r = res({}, { tag: "input", role: "textbox", href: null, inputType, autocomplete });
    assert.equal(cat(r), inputType === "text" && autocomplete?.startsWith("cc-") ? "payment" : "credential", `${inputType}/${autocomplete}`);
    assert.equal(tier(r), "major");
  }
});

// ── 權限／OAuth／帳號／同意／下載 ───────────────────────────────────────────
test("權限／分享／OAuth、建立帳號", () => {
  assert.equal(cat(res({ page: { origin: "https://accounts.example.com", path: "/oauth/authorize" } }, { tag: "button", role: "button", href: null })), "permission");
  assert.equal(cat(res({}, { href: { protocol: "https:", host: "app.example.com", path: "/signup" } })), "account_creation");
  assert.equal(cat(res({}, { name: "Sign up", text: "Sign up" })), "account_creation");
});

test("接受條款／cookie：在 dialog 內的 Accept 才升級；一般頁面的 Accept 連結不因這一條升級", () => {
  assert.equal(cat(res({}, { tag: "button", role: "button", href: null, inDialog: true, name: "Accept all", text: "Accept all" })), "consent");
  assert.equal(tier(res({}, { name: "Accept our cookie policy", text: "Accept our cookie policy" })), "routine"); // 連結、不在 dialog
});

test("下載：download 屬性、危險副檔名、blob/data href", () => {
  assert.equal(cat(res({}, { download: true })), "download");
  assert.equal(cat(res({}, { href: { protocol: "https:", host: "news.example.org", path: "/files/setup.exe" } })), "download");
  assert.equal(cat(res({}, { href: { protocol: "blob:", host: "", path: "" } })), "download");
  assert.equal(cat(res({}, { href: { protocol: "data:", host: "", path: "" } })), "download");
});

// ── 判不出／資訊不足 ＝ 重大（D6）──────────────────────────────────────────
test("不透明：跨源 iframe／canvas／解析不到元素／tampered → major，與模式無關", () => {
  assert.equal(cat(res({}, { frame: "opaque" })), "opaque");
  assert.equal(cat(res({}, { tag: "canvas", href: null, interactive: false })), "opaque");
  assert.equal(cat(res({ hit: null })), "unresolved");
  assert.equal(cat(res({ integrity: { nativeOk: false } })), "tampered");
  for (const r of [res({}, { frame: "opaque" }), res({ hit: null }), res({ integrity: { nativeOk: false } })]) {
    assert.equal(tier(r), "major");
    assert.equal(canAutoApprove(classifyClick(r), r, createClickBudget()).ok, false);
  }
});

test("資訊不足：沒有任何可互動祖先、被覆蓋、沒有 href 的一般按鈕、一般 submit → major（不是 routine）", () => {
  assert.equal(cat(res({}, { tag: "div", role: null, href: null, interactive: false })), "unknown");
  assert.equal(cat(res({}, { covered: true })), "unknown");
  assert.equal(cat(res({}, { tag: "button", role: "button", href: null, name: "Load more", text: "Load more" })), "unknown"); // JS 按鈕：看不出它要做什麼
  assert.equal(cat(res({}, { tag: "button", role: "button", href: null, submits: true, formMethod: "post", formAction: { host: "x.example.com", path: "/go" } })), "submit");
});

test("明確非重大的互動：搜尋表單、文字輸入（非憑證）、tab／展開／summary、checkbox", () => {
  assert.equal(tier(res({}, { tag: "input", role: "searchbox", href: null, inputType: "search" })), "routine");
  assert.equal(tier(res({}, { tag: "input", role: "textbox", href: null, inputType: "text", autocomplete: null })), "routine");
  assert.equal(tier(res({}, { tag: "button", role: "tab", href: null })), "routine");
  assert.equal(tier(res({}, { tag: "summary", role: null, href: null })), "routine");
  assert.equal(tier(res({}, { tag: "input", role: "checkbox", href: null, inputType: "checkbox" })), "routine");
  assert.equal(tier(res({}, { tag: "button", role: "button", href: null, submits: true, formMethod: "get", formAction: { host: "news.example.org", path: "/search" }, formFieldTypes: ["search"] })), "routine");
});

// ── stricter ───────────────────────────────────────────────────────────────
test("stricter：取較嚴的；介面保留給之後的分類器（MVP 沒有）", () => {
  const a = { tier: "routine", category: null, signals: [] };
  const b = { tier: "major", category: "payment", signals: ["x"] };
  assert.equal(stricter(a, b).tier, "major");
  assert.equal(stricter(b, a).category, "payment");
  assert.equal(stricter(a, a).tier, "routine");
  assert.equal(stricter(a, undefined).tier, "routine");
  assert.equal(stricter(a, null).tier, "routine");
});

// ── 敏感網域與自動核准 ─────────────────────────────────────────────────────
test("敏感網域：支付商、銀行關鍵字、信箱、雲端主控台；使用者可加", () => {
  for (const h of ["www.paypal.com", "pay.example.com", "ebank.example.com.tw", "mybank.example.com", "mail.google.com", "outlook.office.com", "console.aws.amazon.com", "portal.azure.com"]) {
    assert.equal(isSensitiveOrigin(h), true, h);
  }
  assert.equal(isSensitiveOrigin("news.example.org"), false);
  assert.equal(isSensitiveOrigin("intranet.corp.example"), false);
  assert.equal(isSensitiveOrigin("intranet.corp.example", ["corp.example"]), true);
  assert.equal(isSensitiveOrigin("evilpaypal.com"), false); // 後綴比對，不是子字串
});

test("canAutoApprove：routine ＋ 非敏感網域 ＋ 預算內 才行；敏感網域上的 routine 仍然出卡", () => {
  const budget = createClickBudget();
  const ok = res();
  assert.deepEqual(canAutoApprove(classifyClick(ok), ok, budget), { ok: true });
  const sensitive = res({ page: { origin: "https://mail.google.com", path: "/mail/u/0" } }, { href: { protocol: "https:", host: "mail.google.com", path: "/mail/u/0/inbox" } });
  assert.equal(classifyClick(sensitive).tier, "routine");
  assert.equal(canAutoApprove(classifyClick(sensitive), sensitive, budget).ok, false);
  assert.match(canAutoApprove(classifyClick(sensitive), sensitive, budget).reason, /sensitive_origin/);
  const user = res({ page: { origin: "https://intranet.corp.example", path: "/" } });
  assert.equal(canAutoApprove(classifyClick(user, { extraSensitiveHosts: ["corp.example"] }), user, budget, { extraSensitiveHosts: ["corp.example"] }).ok, false);
});

test("canAutoApprove：major（任何類別）永遠不行，與預算無關", () => {
  const budget = createClickBudget();
  for (const r of [res({}, { download: true }), res({ hit: null }), res({}, { tag: "div", role: null, href: null, interactive: false })]) {
    assert.equal(canAutoApprove(classifyClick(r), r, budget).ok, false);
  }
});

// ── 新鮮 passkey ───────────────────────────────────────────────────────────
test("requiresFreshPasskey：明確的重大類別與 tampered 要這一次的 passkey；判不出的（unknown／unresolved／opaque／submit）要人按卡，但不強制 passkey", () => {
  for (const c of PASSKEY_CATEGORIES) assert.equal(requiresFreshPasskey({ tier: "major", category: c, signals: [] }), true, c);
  for (const c of ["unknown", "unresolved", "opaque", "submit"]) assert.equal(requiresFreshPasskey({ tier: "major", category: c, signals: [] }), false, c);
  assert.equal(requiresFreshPasskey({ tier: "routine", category: null, signals: [] }), false);
  for (const c of ["payment", "message", "delete", "personal_form", "credential", "permission", "account_creation", "consent", "download", "tampered"]) assert.ok(PASSKEY_CATEGORIES.includes(c), c);
});

// ── 預算 ───────────────────────────────────────────────────────────────────
test("預算：第 41 次自動、一分鐘內第 13 次、連續 3 次被擋 → 之後不能自動，而且不會自己恢復", () => {
  let t = 0;
  const b = createClickBudget({ now: () => t });
  assert.equal(AUTO_LIMITS.maxAutoClicks, 40);
  assert.equal(AUTO_LIMITS.maxPerMinute, 12);
  assert.equal(AUTO_LIMITS.maxConsecutiveBlocked, 3);
  for (let i = 0; i < 12; i++) { assert.equal(b.check().ok, true, `#${i}`); b.recordAuto(); }
  assert.equal(b.check().ok, false); // 一分鐘內第 13 次
  assert.match(b.check().reason, /rate/);
  t += 61_000;
  assert.equal(b.check().ok, true); // 速率視窗會滑走
  // 總量：再補到 40
  for (let i = 12; i < 40; i++) { b.recordAuto(); t += 6_000; }
  assert.equal(b.check().ok, false);
  assert.match(b.check().reason, /total/);

  const c = createClickBudget({ now: () => t });
  c.recordBlocked(); c.recordBlocked();
  assert.equal(c.check().ok, true);
  c.recordBlocked();
  assert.equal(c.check().ok, false);
  assert.match(c.check().reason, /blocked/);
  t += 3_600_000;
  assert.equal(c.check().ok, false, "不會自己恢復");
});

test("預算：中間有一次人工核准通過會讓『連續』被擋歸零；自動通過不會", () => {
  const b = createClickBudget();
  b.recordBlocked(); b.recordBlocked();
  b.recordHumanApproved();
  b.recordBlocked(); b.recordBlocked();
  assert.equal(b.check().ok, true);
  const c = createClickBudget();
  c.recordBlocked(); c.recordBlocked(); c.recordAuto(); c.recordBlocked();
  assert.equal(c.check().ok, false); // 自動通過不算「中斷連續」
});

// ── AI 宣稱 vs 系統解析 ────────────────────────────────────────────────────
test("claimMatch：有共同字詞 → match；完全沒有 → mismatch；解析結果沒有名稱／文字 → unverifiable", () => {
  assert.equal(claimMatch("Read more about the article", res().hit), "match");
  assert.equal(claimMatch("Pay now", res({}, { name: "Read more", text: "Read more" }).hit), "mismatch");
  assert.equal(claimMatch("下一頁", res({}, { name: "下一頁", text: "下一頁" }).hit), "match");
  assert.equal(claimMatch("送出訂單", res({}, { name: "取消", text: "取消" }).hit), "mismatch");
  assert.equal(claimMatch("the search icon", res({}, { name: "", text: "", tag: "button", role: "button", href: null }).hit), "unverifiable");
  assert.equal(claimMatch("", res().hit), "unverifiable");
});

// ── B6：press_key 的啟動鍵 ─────────────────────────────────────────────────

test("isActivationKey：Enter／Space（含修飾鍵組合）會啟動焦點元素；其他鍵不會", () => {
  for (const k of ["Enter", "NumpadEnter", "Space", " ", "Control+Enter", "Shift+Space", "Meta+Enter", "Alt+Shift+Enter"]) assert.equal(isActivationKey(k), true, k);
  for (const k of ["Tab", "Escape", "ArrowDown", "a", "Control+a", "Backspace", "", "Enter2", "Control+", "PageDown"]) assert.equal(isActivationKey(k), false, k);
  for (const k of [null, undefined, 5, {}]) assert.equal(isActivationKey(k), false);
});
