/**
 * click-resolve.mjs — 把「頁面上的一個點」變成「那個點底下是什麼」，以及這份答案怎麼被驗證、怎麼變成指紋。
 *
 * 設計：docs/ava/2026-10-02-click-at-design.md §0.3、§1。
 *
 * ## 信任模型（先講清楚，因為它決定這個檔案的每一個選擇）
 *
 * 解析腳本透過 chrome-devtools-mcp 的 `evaluate_script` 跑在**頁面的主世界**。頁面自己的 JS
 * 可以改寫 `document.elementsFromPoint`，回傳假資料。所以：
 *
 *  - 腳本的回傳值是**頁面自述**，不是事實。`parseResolution` 把它當不可信輸入驗證（schema、長度、
 *    型別、原型汙染），只留白名單欄位。
 *  - **像素是誠實的**：截圖是瀏覽器自己拍的。`checkViewportAgainstShot` 用截圖的實際尺寸
 *    交叉檢查頁面自述的視窗大小；對不上 → `tampered` → 一律人工。
 *  - 結構資訊只能升級嚴重度（見 click-policy.mjs），不能降級。
 *  - 這是減速而不是防線：A（串流）之後 daemon 持有 CDP，改走 `DOM.getNodeForLocation`
 *    與 isolated world，頁面就騙不了了。`parseResolution` 的輸出形狀就是為了讓兩種來源可以互換。
 *
 * 零依賴、純函式（`clickFingerprint` 用 WebCrypto，Bun／Node／瀏覽器都有）。
 */

/**
 * `ava-local browser setup` 寫進授權的 `--screenshotMaxWidth`（見 browser-setup.ts；測試釘住兩邊同一個數字）。
 * **只用在給模型看的說明文字**（「截圖最多這麼寬」）；座標換算用的是截圖的實際尺寸，不靠它。
 */
export const SHOT_MAX_WIDTH = 800;

const MAX_COORD = 100_000;

/**
 * 解析腳本的原文。`__X__`／`__Y__` 由 `buildResolveScript` 換成驗證過的有限數字。整個腳本唯讀。
 *
 * 注意（在真的 Chrome 上量到的，2026-10-02）：`button.formAction` 在沒有 formaction 屬性時回的是**文件網址**
 * （HTML 規格），不是表單的 action。所以腳本只有在明確寫了 formaction 屬性時才用它，否則用 `form.action`。
 * （這段說明放在樣板外面：樣板是 String.raw，裡面不能出現反引號。）
 */
const SCRIPT_HEAD = String.raw`  const out = { v: 1, integrity: { nativeOk: true }, overlays: 0 };
  try {
    const FPT = Function.prototype.toString;
    const isNative = (f) => { try { return typeof f === "function" && FPT.call(f).indexOf("[native code]") !== -1; } catch (e) { return false; } };
    out.integrity.nativeOk = isNative(FPT) && isNative(document.elementsFromPoint) && isNative(document.elementFromPoint) &&
      isNative(Element.prototype.getBoundingClientRect) && isNative(document.querySelectorAll);
    const vv = window.visualViewport;
    out.viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1, scale: vv ? vv.scale : 1, offX: vv ? vv.offsetLeft : 0, offY: vv ? vv.offsetTop : 0 };
    out.page = { origin: location.origin, path: location.pathname };
    out.docToken = Math.round(performance.timeOrigin);
    out.point = { x: 0, y: 0 };
    out.target = { kind: KIND };
    out.overlays = document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]').length;

`;

const SCRIPT_HELPERS = String.raw`    const clip = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, 200);
    const urlParts = (u) => { try { const p = new URL(String(u), location.href); return { protocol: p.protocol, host: p.host, path: p.pathname }; } catch (e) { return null; } };
    const deepTop = (doc, x, y) => {
      let el = doc.elementsFromPoint(x, y)[0] || null;
      let shadow = false;
      for (let s = 0; el && s < 8 && el.shadowRoot; s++) {
        const inner = el.shadowRoot.elementsFromPoint(x, y)[0];
        if (!inner || inner === el) break;
        el = inner; shadow = true;
      }
      return { el, shadow };
    };

`;

/** 找目標（三種）：座標底下的元素／uid 對應的元素／現在有焦點的元素。每一種都留下 top、frame、shadow、doc、offX、offY。 */
const FIND_POINT = String.raw`    let doc = document, px = X, py = Y, frame = "main", shadow = false, top = null, offX = 0, offY = 0;
    out.point = { x: X, y: Y };
    for (let depth = 0; depth < 8; depth++) {
      const d = deepTop(doc, px, py);
      shadow = shadow || d.shadow;
      if (!d.el) { top = null; break; }
      if (d.el.tagName === "IFRAME" || d.el.tagName === "FRAME") {
        let inner = null;
        try { inner = d.el.contentDocument; } catch (e) { inner = null; }
        if (!inner) { frame = "opaque"; top = d.el; break; }
        const fr = d.el.getBoundingClientRect();
        px = px - fr.left - d.el.clientLeft; py = py - fr.top - d.el.clientTop;
        doc = inner; frame = "same-origin"; continue;
      }
      top = d.el; break;
    }
    if (!top) { out.hit = null; return out; }

`;

const FIND_ELEMENT = String.raw`    if (!el || el.nodeType !== 1) { out.hit = null; return out; }
    let top = el, frame = "main", shadow = false, doc = document, offX = 0, offY = 0;
    const od = el.ownerDocument;
    if (od && od !== document) {
      frame = "same-origin"; doc = od;
      const fe = od.defaultView && od.defaultView.frameElement;
      if (fe) { const fr = fe.getBoundingClientRect(); offX = fr.left + fe.clientLeft; offY = fr.top + fe.clientTop; }
    }
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      let inner = null;
      try { inner = el.contentDocument; } catch (e) { inner = null; }
      if (!inner) frame = "opaque";
    }
    { const rn = el.getRootNode && el.getRootNode(); shadow = !!(rn && rn.host); }
`;

const FIND_ACTIVE = String.raw`    let a = document.activeElement;
    for (let s = 0; a && s < 8; s++) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (a.tagName === "IFRAME" || a.tagName === "FRAME") {
        let inner = null;
        try { inner = a.contentDocument; } catch (e) { inner = null; }
        if (inner && inner.activeElement) { a = inner.activeElement; continue; }
      }
      break;
    }
    if (!a || a.tagName === "BODY" || a.tagName === "HTML") { out.hit = null; return out; }
    const el = a;
    if (!el || el.nodeType !== 1) { out.hit = null; return out; }
    let top = el, frame = "main", shadow = false, doc = document, offX = 0, offY = 0;
    const od = el.ownerDocument;
    if (od && od !== document) {
      frame = "same-origin"; doc = od;
      const fe = od.defaultView && od.defaultView.frameElement;
      if (fe) { const fr = fe.getBoundingClientRect(); offX = fr.left + fe.clientLeft; offY = fr.top + fe.clientTop; }
    }
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      let inner = null;
      try { inner = el.contentDocument; } catch (e) { inner = null; }
      if (!inner) frame = "opaque";
    }
    { const rn = el.getRootNode && el.getRootNode(); shadow = !!(rn && rn.host); }
`;

/** 描述找到的那個元素（三種共用）。 */
const SCRIPT_DESCRIBE = String.raw`    const INTERACTIVE = 'a[href],button,input,select,textarea,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="option"],[role="combobox"],[role="textbox"],[role="searchbox"],[onclick],[contenteditable="true"]';
    const up = (n) => { if (!n) return null; if (n.parentElement) return n.parentElement; const root = n.getRootNode && n.getRootNode(); return root && root.host ? root.host : null; };
    let walk = top, found = null;
    for (let i = 0; walk && i < 40; i++) { if (walk.matches && walk.matches(INTERACTIVE)) { found = walk; break; } walk = up(walk); }
    let target = found || top;
    if (found && found.tagName === "LABEL" && found.control) target = found.control;

    const tag = String(target.tagName || "").toLowerCase();
    const attr = (n) => (target.getAttribute ? target.getAttribute(n) : null);
    const type = tag === "input" ? String(target.type || attr("type") || "text").toLowerCase() : null;
    const implicit = tag === "a" ? "link" : tag === "button" ? "button" : tag === "select" ? "combobox" : tag === "textarea" ? "textbox" :
      tag === "input" ? (type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : type === "search" ? "searchbox" : (type === "submit" || type === "button" || type === "image") ? "button" : "textbox") : null;
    const role = attr("role") || implicit;
    const form = target.form || (target.closest ? target.closest("form") : null);
    const r = target.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    out.target = { kind: KIND };
    if (KIND !== "point") {
      const gx = cx + offX, gy = cy + offY;
      out.offscreen = gx < 0 || gy < 0 || gx >= window.innerWidth || gy >= window.innerHeight;
      out.point = { x: Math.max(0, Math.round(gx)), y: Math.max(0, Math.round(gy)) };
    }
    let covered = false;
    if (doc === document && cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
      const c = deepTop(document, cx, cy).el;
      covered = !!c && !(c === target || target.contains(c) || c.contains(target));
    }
    const els = form && form.elements ? Array.prototype.slice.call(form.elements, 0, 30) : [];
    const personal = /(^|\s)(name|given-name|family-name|email|tel|address-line1|street-address|postal-code|bday)/;
    const ownAction = (tag === "button" || tag === "input") && target.hasAttribute && target.hasAttribute("formaction") && typeof target.formAction === "string" && target.formAction ? target.formAction : null;
    const actionRaw = ownAction || (form && typeof form.action === "string" ? form.action : null);
    const hrefRaw = typeof target.href === "string" && target.href ? target.href : null;
    const textRaw = tag === "input" && (type === "submit" || type === "button") ? target.value : (target.innerText || target.textContent);
    out.hit = {
      tag: tag.slice(0, 40),
      role: role ? String(role).slice(0, 40) : null,
      name: clip(attr("aria-label") || attr("title") || attr("alt") || textRaw),
      text: clip(textRaw),
      href: hrefRaw ? urlParts(hrefRaw) : null,
      formAction: actionRaw ? (function () { const p = urlParts(actionRaw); return p ? { host: p.host, path: p.path } : null; })() : null,
      formMethod: form ? String(target.formMethod || form.method || "get").toLowerCase().slice(0, 10) : null,
      inputType: type ? type.slice(0, 30) : null,
      autocomplete: (attr("autocomplete") || target.autocomplete || null) ? String(attr("autocomplete") || target.autocomplete).toLowerCase().slice(0, 100) : null,
      download: !!(target.hasAttribute && target.hasAttribute("download")),
      disabled: !!target.disabled || attr("aria-disabled") === "true",
      bbox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      covered: covered,
      inDialog: !!(target.closest && target.closest('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]')),
      frame: frame,
      shadow: shadow,
      interactive: !!found,
      submits: !!form && ((tag === "button" && String(target.type || "submit").toLowerCase() === "submit") || (tag === "input" && (type === "submit" || type === "image"))),
      hasTextarea: !!form && form.querySelector("textarea") !== null,
      formFieldTypes: els.map((e) => String(e.type || e.tagName || "").toLowerCase().slice(0, 30)),
      formHasPersonal: els.some((e) => { const t = String(e.type || "").toLowerCase(); return t === "email" || t === "tel" || personal.test(String(e.autocomplete || "").toLowerCase()); }),
    };
    return out;
  } catch (e) {
    return { error: String(e && e.message ? e.message : e).slice(0, 80) };
  }
}`;

/** 組一種腳本：point 收座標（內嵌）、element 收一個元素參數（evaluate_script 的 args 傳 uid）、active 看焦點。 */
function assemble(kind) {
  const header = kind === "element" ? "(el) => {\n" : "() => {\n";
  const vars = (kind === "point" ? "  const X = __X__, Y = __Y__;\n" : "") + '  const KIND = "' + kind + '";\n';
  const find = kind === "point" ? FIND_POINT : kind === "element" ? FIND_ELEMENT : FIND_ACTIVE;
  return header + vars + SCRIPT_HEAD + SCRIPT_HELPERS + find + SCRIPT_DESCRIBE;
}

/**
 * 組出要交給 `evaluate_script` 的函式原文。座標只接受通過驗證的有限數字（其他一律拒絕），
 * 所以不可能把任何東西「注入」進腳本。
 * @param {{ x: number, y: number }} p 頁面視窗的 CSS px
 */
export function buildResolveScript(p) {
  const ok = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_COORD;
  if (!p || !ok(p.x) || !ok(p.y)) throw new Error("bad_point");
  return assemble("point").replace("__X__", String(p.x)).replace("__Y__", String(p.y));
}

/**
 * 以**元素**為目標的解析腳本：一個收元素參數的函式，要用 `evaluate_script` 的 `args: [uid]` 叫（MCP 把 uid 換成
 * 那個元素的 handle）。描述的是 `click(uid)` 真正會點的那個元素；座標是它的視窗中心。沒有輸入要內嵌，
 * 所以沒有任何東西可以被注入。
 */
export function buildResolveElementScript() {
  return assemble("element");
}

/** 以**目前有焦點的元素**為目標（`press_key` Enter／Space 會啟動的那一個）。沒有參數。 */
export function buildResolveActiveScript() {
  return assemble("active");
}

// ── 回傳值驗證 ─────────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const num = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const str = (v, max) => typeof v === "string" && v.length <= max;
const clip = (v, max) => String(v).slice(0, max);
const stripQuery = (p) => String(p).split(/[?#]/)[0];

/** 回傳 null 代表壞掉；回傳 undefined 不會出現。 */
function parseUrlParts(v, withProtocol) {
  if (v === null) return { ok: true, value: null };
  if (!isObj(v) || own(v, "__proto__")) return { ok: false };
  if (!str(v.host, 200) || !str(v.path, 600) || (withProtocol && !str(v.protocol, 20))) return { ok: false };
  return { ok: true, value: withProtocol ? { protocol: v.protocol, host: v.host, path: stripQuery(v.path) } : { host: v.host, path: stripQuery(v.path) } };
}

function parseHit(h) {
  if (h === null) return { ok: true, value: null };
  if (!isObj(h) || own(h, "__proto__")) return { ok: false };
  if (!str(h.tag, 40) || !(h.role === null || str(h.role, 40)) || !str(h.name, 100_000) || !str(h.text, 100_000)) return { ok: false };
  for (const k of ["download", "disabled", "covered", "inDialog", "shadow", "interactive", "submits", "hasTextarea", "formHasPersonal"]) if (typeof h[k] !== "boolean") return { ok: false };
  if (!["main", "same-origin", "opaque"].includes(h.frame)) return { ok: false };
  if (!(h.formMethod === null || str(h.formMethod, 10)) || !(h.inputType === null || str(h.inputType, 30)) || !(h.autocomplete === null || str(h.autocomplete, 100))) return { ok: false };
  if (!Array.isArray(h.formFieldTypes) || h.formFieldTypes.length > 30 || !h.formFieldTypes.every((t) => str(t, 30))) return { ok: false };
  const b = h.bbox;
  if (!isObj(b) || !num(b.x, -1e6, 1e6) || !num(b.y, -1e6, 1e6) || !num(b.w, 0, 1e5) || !num(b.h, 0, 1e5)) return { ok: false };
  const href = parseUrlParts(h.href, true);
  const action = parseUrlParts(h.formAction, false);
  if (!href.ok || !action.ok) return { ok: false };
  return {
    ok: true,
    value: {
      tag: h.tag, role: h.role, name: clip(h.name, 200), text: clip(h.text, 200),
      href: href.value, formAction: action.value, formMethod: h.formMethod, inputType: h.inputType, autocomplete: h.autocomplete,
      download: h.download, disabled: h.disabled, bbox: { x: b.x, y: b.y, w: b.w, h: b.h },
      covered: h.covered, inDialog: h.inDialog, frame: h.frame, shadow: h.shadow, interactive: h.interactive,
      submits: h.submits, hasTextarea: h.hasTextarea, formFieldTypes: [...h.formFieldTypes], formHasPersonal: h.formHasPersonal,
    },
  };
}

/**
 * 驗證解析腳本的回傳值（不可信輸入）。只留白名單欄位、截斷文字、丟掉 query／hash。
 * @param {unknown} raw
 * @returns {{ ok: true, value: any } | { ok: false, reason: string }}
 */
export function parseResolution(raw) {
  if (!isObj(raw) || own(raw, "__proto__") || raw.v !== 1) return { ok: false, reason: "bad_shape" };
  const { integrity, viewport: vp, page, point, hit } = raw;
  if (!isObj(integrity) || typeof integrity.nativeOk !== "boolean") return { ok: false, reason: "bad_integrity" };
  if (!isObj(vp) || !num(vp.w, 1, 20_000) || !num(vp.h, 1, 20_000) || !num(vp.dpr, 0.1, 10) || !num(vp.scale, 0.1, 10) || !num(vp.offX, -1e5, 1e5) || !num(vp.offY, -1e5, 1e5)) return { ok: false, reason: "bad_viewport" };
  if (!isObj(page) || !str(page.origin, 300) || !str(page.path, 600)) return { ok: false, reason: "bad_page" };
  if (!isObj(point) || !num(point.x, 0, MAX_COORD) || !num(point.y, 0, MAX_COORD)) return { ok: false, reason: "bad_point" };
  if (!Number.isInteger(raw.overlays) || raw.overlays < 0 || raw.overlays > 1000) return { ok: false, reason: "bad_overlays" };
  if (raw.target !== undefined && (!isObj(raw.target) || !["point", "element", "active"].includes(raw.target.kind))) return { ok: false, reason: "bad_target" };
  if (raw.offscreen !== undefined && typeof raw.offscreen !== "boolean") return { ok: false, reason: "bad_offscreen" };
  if (!num(raw.docToken, 0, 1e15)) return { ok: false, reason: "bad_doc_token" };
  const h = parseHit(hit);
  if (!h.ok) return { ok: false, reason: "bad_hit" };
  return {
    ok: true,
    value: {
      v: 1,
      integrity: { nativeOk: integrity.nativeOk },
      viewport: { w: vp.w, h: vp.h, dpr: vp.dpr, scale: vp.scale, offX: vp.offX, offY: vp.offY },
      page: { origin: page.origin, path: stripQuery(page.path) },
      point: { x: point.x, y: point.y },
      overlays: raw.overlays,
      docToken: raw.docToken,
      target: { kind: raw.target?.kind ?? "point" },
      offscreen: raw.offscreen === true,
      hit: h.value,
    },
  };
}

// ── 指紋 ───────────────────────────────────────────────────────────────────

/**
 * 「同一個元素、同一個位置、同一個文件」的指紋。**名稱與文字不在裡面**（購物車數量會變）；
 * 位置以 4px 為格，所以 1px 的子像素捲動不會讓它變。
 * @param {any} r `parseResolution` 驗證過的結果
 */
export async function clickFingerprint(r) {
  const h = r.hit;
  const q = (n) => Math.round(n / 4);
  const material = JSON.stringify({
    o: r.page.origin, p: r.page.path, d: r.docToken, ov: r.overlays,
    h: h && {
      t: h.tag, r: h.role, i: h.inputType, a: h.autocomplete,
      u: h.href && [h.href.protocol, h.href.host, h.href.path],
      f: h.formAction && [h.formAction.host, h.formAction.path], m: h.formMethod,
      c: h.covered, fr: h.frame, dl: h.download, s: h.submits,
      b: [q(h.bbox.x), q(h.bbox.y), q(h.bbox.w), q(h.bbox.h)],
    },
  });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── 座標 ───────────────────────────────────────────────────────────────────

/**
 * 模型給的座標（它看到的那張截圖上的像素）→ 頁面的 CSS px。
 *
 * **分母是瀏覽器自己拍的那張截圖的實際尺寸**（`shot`），不是寫死的 800：截圖寬度由授權檔的
 * `--screenshotMaxWidth` 決定（舊授權、不同設定都可能不同），而 daemon 自己拍的那張與模型看到的那張
 * 用的是同一份設定。超出截圖範圍**拒絕、不夾緊**（同 `validateTakeoverCall`：夾緊會把一個錯誤悄悄變成
 * 「點到了別的東西」）。
 * @param {{ x: number, y: number }} p
 * @param {{ w: number, h: number, dpr: number }} vp 頁面自述的視窗（CSS px）
 * @param {{ w: number, h: number }} shot 截圖的實際像素尺寸
 */
export function shotToCssPoint(p, vp, shot) {
  if (!p || typeof p.x !== "number" || typeof p.y !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error("bad_point");
  if (!shot || !(shot.w > 0) || !(shot.h > 0)) throw new Error("bad_shot");
  if (p.x < 0 || p.y < 0 || p.x >= shot.w || p.y >= shot.h) throw new Error("out_of_shot");
  const round = (v) => Math.round(v * 100) / 100;
  return { x: round((p.x * vp.w) / shot.w), y: round((p.y * vp.h) / shot.h) };
}

/**
 * 頁面自述的視窗大小，跟瀏覽器自己拍的截圖尺寸對得上嗎？對不上 ＝ 頁面在說謊（或視窗剛被改過）→ tampered。
 *
 * 兩個**不靠設定**的檢查：截圖不會比視窗的裝置像素（視窗寬×dpr）更寬；截圖的長寬比等於視窗的長寬比。
 * 抓得到「謊報成比較小」與「比例不對」；**抓不到「謊報成比較大」**（截圖被 `--screenshotMaxWidth` 縮小時，
 * 比較大的視窗看起來一樣合理）—— 那是頁面完全受攻擊者控制的殘餘風險（設計文件 §1.3）：同一個頁面也能
 * 對 `elementsFromPoint` 說謊，防線是敏感網域、像素裁切圖上的十字準星（誠實的）與人。
 * @param {{ w: number, h: number, dpr: number }} vp
 * @param {{ w: number, h: number } | null} shot
 */
export function checkViewportAgainstShot(vp, shot) {
  if (!shot || !vp) return false;
  if (shot.w > vp.w * vp.dpr + 1.5) return false;
  return Math.abs(shot.h - (shot.w * vp.h) / vp.w) <= 1.5;
}

/**
 * 從 JPEG 的 SOF 標記讀出寬高（daemon 用它量 `take_screenshot` 回來的圖，不需要影像函式庫）。
 * @param {Uint8Array | null | undefined} bytes
 * @returns {{ w: number, h: number } | null}
 */
export function jpegSize(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 8 >= bytes.length) return null;
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/**
 * 從 PNG 的 IHDR 讀出寬高。
 * @param {Uint8Array | null | undefined} bytes
 * @returns {{ w: number, h: number } | null}
 */
export function pngSize(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!bytes || bytes.length < 24 || !sig.every((b, i) => bytes[i] === b)) return null;
  const u32 = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  if (u32(12) !== 0x49484452) return null; // "IHDR"
  const w = u32(16), h = u32(20);
  return w > 0 && h > 0 && w <= 65535 && h <= 65535 ? { w, h } : null;
}

/** JPEG 或 PNG 的尺寸（授權檔沒設 `--screenshotFormat jpeg` 的舊設定拍出來的是 PNG）。 */
export function imageSize(bytes) {
  return jpegSize(bytes) ?? pngSize(bytes);
}
