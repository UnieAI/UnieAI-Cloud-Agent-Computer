/**
 * click-policy.mjs — 「這一下點擊算不算重大」的確定性規則，雲端 app 與使用者電腦上的 daemon 共用。
 *
 * 設計：docs/ava/2026-10-02-click-at-design.md。為什麼放在這個套件：
 *   同一條規則兩份實作，改一份漏一份（記憶：「同一條規則兩份實作」）。app 在出核准卡**之前**算一次，
 *   daemon 在**執行之前**再算一次，兩邊必須逐字相同。零依賴、純函式，所以瀏覽器 bundle 也能用。
 *
 * ## 三條不能破的規矩
 *
 * 1. **只有規則「明確判為非重大」才是 routine；判不出、資訊不足一律是 major**（owner／rabi D6）。
 *    routine 是一份**白名單**（見 `explicitlyBenign`），不是「沒有命中任何壞信號」。
 * 2. **文字信號（aria-label、可見文字）只能升級，不能降級。** 頁面可以把付款鈕標成「取消」；
 *    結構信號（網域、URL 路徑、form 屬性、input type）命中時，文字說什麼都不重要。
 * 3. **這是給「正常網站」的安全網，不是對抗惡意頁面的邊界。** 純 JS 處理的按鈕看不出它要做什麼，
 *    所以它們是 unknown（要人看）；而一個存心欺騙的頁面能讓任何屬性說謊 —— 那一類要靠像素裁切圖
 *    （瀏覽器自己畫的）、敏感網域清單與人。
 *
 * ## 三種結果
 *
 * - `routine`：可以自動核准（還要過 `canAutoApprove`：非敏感網域、預算內）。
 * - `major` ＋ `PASSKEY_CATEGORIES` 內的類別：**這一次的 passkey**，登入授權簽不了。
 * - `major` ＋ 其餘類別（unknown／unresolved／opaque／submit）：要人按核准卡（不自動），
 *   但不強制 passkey —— 它們是「看不懂」而不是「看懂了而且很危險」。
 *   要收緊成全部 passkey，改 `PASSKEY_CATEGORIES` 一處即可（測試兩邊都釘）。
 */

/** @typedef {{ tier: "routine" | "major", category: string | null, signals: string[] }} ClickVerdict */

/** 這些類別的點擊要這一次的 passkey（device ticket）；登入授權與 HMAC 票都不收。 */
export const PASSKEY_CATEGORIES = Object.freeze([
  "payment", "message", "delete", "personal_form", "credential", "permission", "account_creation", "consent", "download",
  // 頁面對自己的解析器動過手腳：比「看不懂」可疑得多。
  "tampered",
]);

/** 非重大的自動核准上限（app 端每個 session；daemon 另有自己的硬上限當後盾）。 */
export const AUTO_LIMITS = Object.freeze({ maxAutoClicks: 40, maxPerMinute: 12, maxConsecutiveBlocked: 3 });

// ── 網域 ───────────────────────────────────────────────────────────────────

/** 支付商（後綴比對：`checkout.stripe.com` 命中 `stripe.com` 的條目只有這裡列出的那幾個子網域）。 */
const PAYMENT_HOSTS = [
  "checkout.stripe.com", "buy.stripe.com", "billing.stripe.com", "pay.stripe.com",
  "paypal.com", "paypal.me", "braintreegateway.com", "adyen.com", "klarna.com", "squareup.com", "checkout.com",
  "worldpay.com", "authorize.net", "payoneer.com", "alipay.com", "pay.google.com", "pay.line.me",
  "ecpay.com.tw", "newebpay.com", "tappaysdk.com", "2c2p.com",
];

/** 信箱、雲端主控台：純 JS 按鈕多、動作代價高 → 不自動核准（routine 也要出卡）。 */
const SENSITIVE_HOSTS = [
  ...PAYMENT_HOSTS,
  "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "mail.yahoo.com", "proton.me", "mail.proton.me",
  "console.aws.amazon.com", "console.cloud.google.com", "portal.azure.com", "dash.cloudflare.com", "admin.google.com",
];

const BANK_LABEL = /(bank|ebank|netbank|ebanking|banking)/;
const PAY_LABEL = /^(pay|payment|payments|checkout|billing|wallet|securepay)$/;

/** @param {string} host @param {string} suffix */
const hostMatches = (host, suffix) => host === suffix || host.endsWith(`.${suffix}`);

/**
 * 這個網域算不算敏感（自動核准的前置條件）。後綴比對，不是子字串：`evilpaypal.com` 不是 `paypal.com`。
 * @param {string} host
 * @param {readonly string[]} [extra] 使用者在授權檔加的
 */
export function isSensitiveOrigin(host, extra = []) {
  const h = String(host || "").toLowerCase();
  if (!h) return false;
  if (SENSITIVE_HOSTS.some((s) => hostMatches(h, s))) return true;
  if (extra.some((s) => typeof s === "string" && s && hostMatches(h, s.toLowerCase()))) return true;
  return h.split(".").some((label) => BANK_LABEL.test(label) || PAY_LABEL.test(label));
}

const hostOfOrigin = (origin) => {
  try { return new URL(String(origin)).hostname.toLowerCase(); } catch { return ""; }
};

// ── 結構信號（路徑 token）─────────────────────────────────────────────────

/** 把一個 URL path 切成小寫 token（`/api/pay-now_2` → api, pay, now, 2）。 */
const tokensOf = (path) => String(path || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const PATH_TOKENS = {
  payment: ["checkout", "payment", "payments", "pay", "billing", "purchase", "buy", "transfer", "wire", "order", "orders", "subscribe", "subscription", "donate", "invoice"],
  message: ["compose", "send", "reply", "forward", "publish"],
  delete: ["delete", "remove", "destroy", "trash", "purge", "erase", "revoke", "terminate", "deactivate"],
  permission: ["oauth", "authorize", "consent", "grant", "permissions", "share", "invite", "sharing"],
  account_creation: ["signup", "register", "registration", "join", "onboarding"],
};

const DANGEROUS_EXT = /\.(exe|dmg|msi|pkg|apk|deb|rpm|zip|rar|7z|tar|gz|iso|bat|cmd|sh|ps1|jar|scr|app)$/i;
const SENSITIVE_AUTOCOMPLETE = new Set(["one-time-code", "current-password", "new-password"]);

// ── 文字信號（只升不降）────────────────────────────────────────────────────

const TEXT_SIGNALS = [
  ["payment", /\b(pay|payments?|buy|purchase|checkout|place order|order now|subscribe|donate)\b|付款|結帳|購買|下單|轉帳|支付|訂閱|捐款/i],
  ["delete", /\b(delete|remove|erase|destroy|discard|revoke|deactivate)\b|刪除|移除|清空|撤銷|停用/i],
  ["account_creation", /\b(sign ?up|register|create (an )?account|join now)\b|註冊|建立帳號|加入會員/i],
  ["permission", /\b(authorize|grant access|allow access|share)\b|授權|分享|允許存取/i],
  ["message", /\b(send|post|publish|reply|tweet)\b|寄出|送出|發布|發送|回覆|發文/i],
  ["download", /\b(download|install)\b|下載|安裝/i],
];
const CONSENT_TEXT = /\b(accept|agree|allow all|i understand|got it)\b|同意|接受|我了解/i;

// ── 分類 ───────────────────────────────────────────────────────────────────

const major = (category, signals) => ({ tier: "major", category, signals });

/** 這個元素是「動作控制項」（按鈕、送出）而不是連結 —— 它的動作發生在**目前這一頁**。 */
const isActionControl = (h) => h.tag === "button" || h.role === "button" || h.submits || (h.tag === "input" && ["submit", "button", "image"].includes(h.inputType || ""));

/** 在哪些 URL 上看路徑 token：連結看 href；動作控制項看目前頁面路徑與 form action。 */
function pathsToInspect(r, h) {
  const out = [];
  if (h.href && (h.href.protocol === "http:" || h.href.protocol === "https:")) out.push(["href", tokensOf(h.href.path)]);
  if (h.formAction) out.push(["action", tokensOf(h.formAction.path)]);
  if (isActionControl(h)) out.push(["page", tokensOf(r.page.path)]);
  return out;
}

function structuralCategory(r, h) {
  const pageHost = hostOfOrigin(r.page.origin);
  const signals = [];
  const hit = (category, why) => { signals.push(why); return major(category, signals); };

  const ac = String(h.autocomplete || "").toLowerCase();
  // 憑證／卡號欄位（先於其他：欄位本身就是答案）
  if (h.inputType === "password" || SENSITIVE_AUTOCOMPLETE.has(ac)) return hit("credential", `field:${h.inputType === "password" ? "password" : ac}`);
  if (ac.startsWith("cc-")) return hit("payment", `field:${ac}`);

  // 支付商網域：頁面本身、連結、form action
  if (PAYMENT_HOSTS.some((s) => hostMatches(pageHost, s))) return hit("payment", `host:page:${pageHost}`);
  if (h.href?.host && PAYMENT_HOSTS.some((s) => hostMatches(h.href.host.toLowerCase(), s))) return hit("payment", `host:href:${h.href.host}`);
  if (h.formAction?.host && PAYMENT_HOSTS.some((s) => hostMatches(h.formAction.host.toLowerCase(), s))) return hit("payment", `host:action:${h.formAction.host}`);

  // 路徑 token
  for (const [where, tokens] of pathsToInspect(r, h)) {
    for (const category of ["payment", "permission", "delete", "account_creation", "message"]) {
      const t = PATH_TOKENS[category].find((x) => tokens.includes(x));
      if (t) return hit(category, `path:${where}:${t}`);
    }
  }

  // 表單形狀
  if (h.submits && h.hasTextarea && h.formMethod !== "get") return hit("message", "form:textarea-post");
  if (h.submits && h.formHasPersonal && h.formMethod !== "get") return hit("personal_form", "form:personal");

  // 下載
  if (h.download) return hit("download", "attr:download");
  if (h.href) {
    if (h.href.protocol === "blob:" || h.href.protocol === "data:") return hit("download", `href:${h.href.protocol}`);
    if (DANGEROUS_EXT.test(h.href.path || "")) return hit("download", "href:ext");
  }
  return null;
}

function textCategory(h) {
  const text = `${h.name || ""} ${h.text || ""}`;
  if (!text.trim()) return null;
  if (h.inDialog && CONSENT_TEXT.test(text)) return major("consent", ["text:consent"]);
  for (const [category, re] of TEXT_SIGNALS) if (re.test(text)) return major(category, [`text:${category}`]);
  return null;
}

const TEXT_LIKE_INPUTS = new Set(["text", "search", "email", "tel", "url", "number", "date", "time", "month", "week", "datetime-local"]);
const BENIGN_ROLES = new Set(["tab", "checkbox", "radio", "searchbox", "textbox", "combobox", "listbox"]);

/** 白名單：明確、無副作用的互動。其餘一律 unknown。 */
function explicitlyBenign(h) {
  if (h.tag === "a" && h.href && (h.href.protocol === "http:" || h.href.protocol === "https:")) return "link";
  if (h.tag === "summary" || h.tag === "details") return "disclosure";
  if (h.tag === "textarea" || h.tag === "select") return "field";
  if (h.tag === "input" && (TEXT_LIKE_INPUTS.has(h.inputType || "text") || h.inputType === "checkbox" || h.inputType === "radio")) return "field";
  if (h.role && BENIGN_ROLES.has(h.role) && !h.submits) return "role";
  // 搜尋表單的送出：GET、只有搜尋／文字欄位。
  if (h.submits && h.formMethod === "get" && h.formFieldTypes.length > 0 && h.formFieldTypes.every((t) => ["search", "text", "hidden"].includes(t)) && (h.formFieldTypes.includes("search") || tokensOf(h.formAction?.path).some((t) => ["search", "find", "query", "results"].includes(t)))) return "search";
  return null;
}

/**
 * 分類一次解析結果。
 * @param {any} r `parseResolution` 驗證過的解析結果
 * @returns {ClickVerdict}
 */
export function classifyClick(r, _opts = {}) {
  if (!r?.integrity?.nativeOk) return major("tampered", ["integrity:native"]);
  const h = r.hit;
  if (!h) return major("unresolved", ["hit:null"]);
  if (h.frame === "opaque" || h.tag === "canvas") return major("opaque", [h.tag === "canvas" ? "tag:canvas" : "frame:opaque"]);

  const structural = structuralCategory(r, h);
  if (structural) return structural;
  const text = textCategory(h);
  if (text) return text;

  if (h.covered) return major("unknown", ["covered"]);
  if (h.href?.protocol === "javascript:") return major("unknown", ["href:javascript"]);
  const benign = explicitlyBenign(h);
  if (benign) return { tier: "routine", category: null, signals: [`benign:${benign}`] };
  return major(h.submits ? "submit" : "unknown", [h.submits ? "submit:generic" : "no-rule"]);
}

/**
 * 取較嚴的。MVP 沒有模型分類器（D6），介面保留給之後接分類器用：它只能升、不能降。
 * @param {ClickVerdict | null | undefined} a
 * @param {ClickVerdict | null | undefined} b
 * @returns {ClickVerdict}
 */
export function stricter(a, b) {
  if (!a) return b ?? { tier: "routine", category: null, signals: [] };
  if (!b) return a;
  if (a.tier !== b.tier) return a.tier === "major" ? a : b;
  const pick = PASSKEY_CATEGORIES.includes(b.category ?? "") && !PASSKEY_CATEGORIES.includes(a.category ?? "") ? b : a;
  return { tier: pick.tier, category: pick.category, signals: [...new Set([...a.signals, ...b.signals])] };
}

/** 這個結果要不要這一次的 passkey（登入授權與 HMAC 票都不夠）。 */
export function requiresFreshPasskey(verdict) {
  return verdict?.tier === "major" && PASSKEY_CATEGORIES.includes(verdict.category ?? "");
}

/**
 * 能不能自動核准（bypass 的 autoSign 路）。三個條件缺一不可：routine、非敏感網域、預算內。
 * @param {ClickVerdict} verdict
 * @param {any} resolution
 * @param {{ check(): { ok: boolean, reason?: string } }} budget
 * @param {{ extraSensitiveHosts?: readonly string[] }} [opts]
 */
export function canAutoApprove(verdict, resolution, budget, opts = {}) {
  if (verdict?.tier !== "routine") return { ok: false, reason: `major:${verdict?.category ?? "unknown"}` };
  if (isSensitiveOrigin(hostOfOrigin(resolution?.page?.origin), opts.extraSensitiveHosts ?? [])) return { ok: false, reason: "sensitive_origin" };
  return budget.check();
}

// ── 預算 ───────────────────────────────────────────────────────────────────

/**
 * 一個 session 的自動核准預算。**連續被擋 N 次後不會自己恢復**（Claude in Chrome 的做法：
 * 一直被擋就退回逐步核准）—— 恢復要換一個 session。
 * @param {{ now?: () => number, limits?: typeof AUTO_LIMITS }} [opts]
 */
export function createClickBudget(opts = {}) {
  const now = opts.now ?? Date.now;
  const limits = opts.limits ?? AUTO_LIMITS;
  /** @type {number[]} */
  let recent = [];
  let total = 0;
  let consecutiveBlocked = 0;
  let tripped = false;
  return {
    check() {
      if (tripped) return { ok: false, reason: "blocked_streak" };
      if (total >= limits.maxAutoClicks) return { ok: false, reason: "total_limit" };
      const t = now();
      recent = recent.filter((x) => t - x < 60_000);
      if (recent.length >= limits.maxPerMinute) return { ok: false, reason: "rate_limit" };
      return { ok: true };
    },
    recordAuto() { total += 1; recent.push(now()); },
    /** 人按了允許：打斷「連續被擋」，但不會讓已經跳脫的預算恢復。 */
    recordHumanApproved() { if (!tripped) consecutiveBlocked = 0; },
    /** 被擋（人拒絕、daemon 拒絕、target_changed…）。 */
    recordBlocked() { consecutiveBlocked += 1; if (consecutiveBlocked >= limits.maxConsecutiveBlocked) tripped = true; },
    snapshot() { return { total, consecutiveBlocked, tripped }; },
  };
}

// ── AI 宣稱 vs 系統解析 ────────────────────────────────────────────────────

const STOP = new Set(["the", "a", "an", "to", "of", "on", "in", "and", "or", "for", "with", "button", "link", "click", "icon", "page", "this", "that", "it", "is"]);
const CJK_STOP = new Set(["的", "了", "是", "在", "按", "點", "鈕", "個"]);

/** @param {string} s */
function tokenize(s) {
  const out = new Set();
  const text = String(s || "").toLowerCase();
  for (const w of text.match(/[a-z0-9]{2,}/g) ?? []) if (!STOP.has(w)) out.add(w);
  for (const c of text.match(/[㐀-鿿豈-﫿]/g) ?? []) if (!CJK_STOP.has(c)) out.add(c);
  return out;
}

/**
 * AI 說它要點的東西，跟系統解析到的對得上嗎（只給 UI 紅標用，**不是授權依據**）。
 * @returns {"match" | "mismatch" | "unverifiable"}
 */
export function claimMatch(claim, hit) {
  const claimTokens = tokenize(claim);
  if (claimTokens.size === 0 || !hit) return "unverifiable";
  const surface = [hit.name, hit.text, hit.href?.host, ...tokensOf(hit.href?.path), hit.role === "link" || hit.role === "button" ? "" : hit.role].join(" ");
  if (!String(hit.name || "").trim() && !String(hit.text || "").trim() && !hit.href?.host) return "unverifiable";
  const surfaceTokens = tokenize(surface);
  for (const t of claimTokens) if (surfaceTokens.has(t)) return "match";
  return "mismatch";
}

// ── press_key 的啟動鍵 ─────────────────────────────────────────────────────

const ACTIVATION_KEYS = new Set(["enter", "numpadenter", "space", " "]);

/**
 * 這個按鍵會不會「啟動」焦點元素（Enter／Space，含修飾鍵組合如 `Control+Enter`）。
 * 啟動鍵等於對焦點元素點一下（送出表單、按下按鈕、勾選…），所以 `press_key` 的這幾個鍵要走跟 `click`
 * 同一套守門；其他的鍵（Tab、方向鍵、字母…）不啟動東西，維持原本的路。
 * @param {unknown} key
 */
export function isActivationKey(key) {
  if (typeof key !== "string" || !key) return false;
  const last = key === " " ? " " : key.split("+").pop();
  return ACTIVATION_KEYS.has(String(last).toLowerCase());
}
