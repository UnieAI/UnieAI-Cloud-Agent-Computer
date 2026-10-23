import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResolveActiveScript,
  buildResolveElementScript,
  buildResolveScript,
  checkViewportAgainstShot,
  clickFingerprint,
  imageSize,
  jpegSize,
  parseResolution,
  pngSize,
  shotToCssPoint,
  SHOT_MAX_WIDTH,
} from "./click-resolve.mjs";

/**
 * 解析腳本（跑在頁面主世界，所以回傳值是「頁面自述」）與它回傳值的驗證／指紋／座標換算。
 * 設計：docs/ava/2026-10-02-click-at-design.md §0.3、§1。
 */

function raw(over = {}, hitOver = {}) {
  return {
    v: 1,
    integrity: { nativeOk: true },
    viewport: { w: 1280, h: 720, dpr: 1, scale: 1, offX: 0, offY: 0 },
    page: { origin: "https://shop.example.com", path: "/cart" },
    point: { x: 640, y: 360 },
    overlays: 0,
    docToken: 1_700_000_000_000,
    hit: {
      tag: "a", role: "link", name: "Cart", text: "Cart",
      href: { protocol: "https:", host: "shop.example.com", path: "/cart" },
      formAction: null, formMethod: null, inputType: null, autocomplete: null,
      download: false, disabled: false,
      bbox: { x: 600, y: 350, w: 80, h: 20 },
      covered: false, inDialog: false, frame: "main", shadow: false, interactive: true,
      submits: false, hasTextarea: false, formFieldTypes: [], formHasPersonal: false,
      ...hitOver,
    },
    ...over,
  };
}

// ── 解析腳本本身 ───────────────────────────────────────────────────────────
test("buildResolveScript：只內嵌通過驗證的有限數字；NaN／Infinity／字串／負數拒絕", () => {
  const s = buildResolveScript({ x: 12.5, y: 40 });
  assert.match(s, /^\(\)\s*=>/);
  assert.ok(s.includes("12.5") && s.includes("40"));
  for (const bad of [{ x: NaN, y: 1 }, { x: 1, y: Infinity }, { x: "1", y: 2 }, { x: -1, y: 2 }, { x: 1, y: -0.5 }, { x: 1e9, y: 1 }, {}, null]) {
    assert.throws(() => buildResolveScript(bad), /bad_point/, JSON.stringify(bad));
  }
});

test("解析腳本是唯讀的：不含 eval／new Function／fetch／XHR／sendBeacon／WebSocket／寫入 DOM／導航", () => {
  const s = buildResolveScript({ x: 1, y: 1 });
  for (const forbidden of [
    /\beval\s*\(/, /new\s+Function/, /\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /importScripts/,
    /\.innerHTML\s*=/, /\.outerHTML\s*=/, /document\.write/, /\.appendChild\s*\(/, /\.insertBefore\s*\(/, /\.setAttribute\s*\(/, /\.remove\s*\(/,
    /location\s*=[^=]/, /location\.(assign|replace|href\s*=)/, /\.click\s*\(/, /\.focus\s*\(/, /dispatchEvent/, /localStorage|sessionStorage|document\.cookie/,
  ]) {
    assert.doesNotMatch(s, forbidden, String(forbidden));
  }
});

test("解析腳本會檢查自己用到的原生函式（被改寫 → nativeOk:false）", () => {
  const s = buildResolveScript({ x: 1, y: 1 });
  assert.match(s, /\[native code\]/);
  assert.match(s, /elementsFromPoint/);
  assert.match(s, /getBoundingClientRect/);
});

test("解析腳本能在假 DOM 上跑：回傳可序列化、能被 parseResolution 接受；假的原生函式被抓到（nativeOk:false）", () => {
  const s = buildResolveScript({ x: 5, y: 5 });
  const calls = [];
  const rect = { left: 0, top: 0, width: 50, height: 20 };
  const el = {
    tagName: "A", shadowRoot: null, parentElement: null, form: null,
    matches: () => true, closest: () => null, contains: () => true, getRootNode: () => ({}),
    getAttribute: (n) => ({ href: "/x" })[n] ?? null, hasAttribute: () => false,
    href: "https://shop.example.com/x?token=SECRET", innerText: "Hello", textContent: "Hello",
    getBoundingClientRect: () => rect,
  };
  const fakeDocument = {
    elementsFromPoint: () => { calls.push("efp"); return [el]; },
    elementFromPoint: () => el,
    querySelectorAll: () => [],
  };
  const fakeWindow = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0 } };
  const run = new Function("document", "window", "Element", "location", "performance", `return (${s})()`);
  const out = run(fakeDocument, fakeWindow, { prototype: { getBoundingClientRect: () => rect } },
    { origin: "https://shop.example.com", pathname: "/cart", href: "https://shop.example.com/cart" }, { timeOrigin: 1_700_000_000_000 });
  const parsed = parseResolution(JSON.parse(JSON.stringify(out)));
  assert.equal(parsed.ok, true, JSON.stringify(out));
  assert.equal(parsed.value.hit.tag, "a");
  assert.equal(parsed.value.hit.href.path, "/x"); // query 沒有跟出來
  assert.equal(parsed.value.integrity.nativeOk, false); // 假的 elementsFromPoint 不是 [native code]
  assert.ok(calls.length >= 1);
});

// ── 回傳值驗證 ─────────────────────────────────────────────────────────────
test("parseResolution：好的通過，並丟棄未知欄位、截斷文字", () => {
  const long = "x".repeat(5000);
  const r = parseResolution({ ...raw({}, { text: long, name: long }), extra: "drop me" });
  assert.equal(r.ok, true);
  assert.equal(r.value.extra, undefined);
  assert.ok(r.value.hit.text.length <= 200 && r.value.hit.name.length <= 200);
});

test("parseResolution：缺欄位／型別錯／負或超大 bbox／未知 frame／過大物件 → 拒絕", () => {
  const bad = [
    null, "x", [], {}, raw({ v: 2 }), raw({ viewport: { w: "1280" } }), raw({ viewport: { w: 0, h: 720, dpr: 1, scale: 1, offX: 0, offY: 0 } }),
    raw({ page: { origin: 5, path: "/" } }), raw({}, { frame: "weird" }), raw({}, { bbox: { x: 0, y: 0, w: -1, h: 5 } }),
    raw({}, { bbox: { x: 0, y: 0, w: 1e9, h: 5 } }), raw({}, { tag: 5 }), raw({}, { formFieldTypes: new Array(500).fill("text") }),
    raw({ integrity: { nativeOk: "yes" } }), raw({ overlays: -1 }),
  ];
  for (const b of bad) assert.equal(parseResolution(b).ok, false, JSON.stringify(b)?.slice(0, 80));
  assert.equal(parseResolution(JSON.parse(`{"v":1,"__proto__":{"polluted":1}}`)).ok, false);
  assert.equal({}.polluted, undefined);
});

test("parseResolution：hit 可以是 null（解析不到元素）；url 只留 protocol／host／path，不留 query／hash", () => {
  const r = parseResolution(raw({ hit: null }));
  assert.equal(r.ok, true);
  assert.equal(r.value.hit, null);
  const withQuery = raw({}, { href: { protocol: "https:", host: "a.example.com", path: "/p?token=SECRET#frag" } });
  const p = parseResolution(withQuery);
  assert.equal(p.ok, true);
  assert.equal(p.value.hit.href.path, "/p");
  assert.equal(p.value.page.path.includes("?"), false);
});

// ── 指紋 ───────────────────────────────────────────────────────────────────
test("clickFingerprint：同元素同位置 → 同指紋；身分相關欄位一動就不同；名稱變了不改指紋", async () => {
  const base = parseResolution(raw()).value;
  const fp = await clickFingerprint(base);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(await clickFingerprint(parseResolution(raw()).value), fp);

  const changes = {
    href: raw({}, { href: { protocol: "https:", host: "evil.example.net", path: "/cart" } }),
    formAction: raw({}, { formAction: { host: "shop.example.com", path: "/pay" } }),
    bbox: raw({}, { bbox: { x: 700, y: 350, w: 80, h: 20 } }),
    overlay: raw({ overlays: 1 }),
    navigation: raw({ docToken: 1_700_000_005_000 }),
    path: raw({ page: { origin: "https://shop.example.com", path: "/checkout" } }),
    origin: raw({ page: { origin: "https://other.example.com", path: "/cart" } }),
    tag: raw({}, { tag: "button" }),
    covered: raw({}, { covered: true }),
    frame: raw({}, { frame: "same-origin" }),
    inputType: raw({}, { inputType: "password" }),
  };
  for (const [k, v] of Object.entries(changes)) {
    assert.notEqual(await clickFingerprint(parseResolution(v).value), fp, k);
  }
  assert.equal(await clickFingerprint(parseResolution(raw({}, { name: "Basket (3)", text: "Basket (3)" })).value), fp, "名稱／文字變動（例如購物車數量）不改指紋");
  assert.equal(await clickFingerprint(parseResolution(raw({}, { bbox: { x: 601, y: 351, w: 80, h: 20 } })).value), fp, "1px 位移（子像素捲動）容忍");
});

// ── 座標換算 ───────────────────────────────────────────────────────────────
test("shotToCssPoint：分母是截圖的實際尺寸，換算回 CSS px；DPR 2、窄視窗、沒有縮小的截圖", () => {
  // 1280×720、dpr1、截圖縮成 800×450：比例 1.6
  assert.deepEqual(shotToCssPoint({ x: 400, y: 225 }, { w: 1280, h: 720, dpr: 1 }, { w: 800, h: 450 }), { x: 640, y: 360 });
  // dpr2：原始 2560 寬，截圖仍是 800×450
  assert.deepEqual(shotToCssPoint({ x: 400, y: 225 }, { w: 1280, h: 720, dpr: 2 }, { w: 800, h: 450 }), { x: 640, y: 360 });
  // 窄視窗 300×600、dpr2：截圖 600×1200 → 比例 0.5
  assert.deepEqual(shotToCssPoint({ x: 300, y: 600 }, { w: 300, h: 600, dpr: 2 }, { w: 600, h: 1200 }), { x: 150, y: 300 });
  // 授權沒設 --screenshotMaxWidth：截圖就是視窗的實際大小 → 座標一對一
  assert.deepEqual(shotToCssPoint({ x: 400, y: 225 }, { w: 1280, h: 720, dpr: 1 }, { w: 1280, h: 720 }), { x: 400, y: 225 });
});

test("shotToCssPoint：超出截圖範圍拒絕、不夾緊；非有限數字拒絕；沒有截圖尺寸拒絕", () => {
  const vp = { w: 1280, h: 720, dpr: 1 };
  const shot = { w: 800, h: 450 };
  for (const p of [{ x: 800, y: 10 }, { x: 10, y: 450 }, { x: -1, y: 5 }, { x: NaN, y: 5 }, { x: 5, y: Infinity }, { x: "5", y: 5 }]) {
    assert.throws(() => shotToCssPoint(p, vp, shot), /out_of_shot|bad_point/, JSON.stringify(p));
  }
  assert.throws(() => shotToCssPoint({ x: 1, y: 1 }, vp, null), /bad_shot/);
  assert.throws(() => shotToCssPoint({ x: 1, y: 1 }, vp, { w: 0, h: 450 }), /bad_shot/);
});

test("checkViewportAgainstShot：截圖不會比視窗的裝置像素更寬、長寬比要對；沒設縮小也算對", () => {
  assert.equal(checkViewportAgainstShot({ w: 1280, h: 720, dpr: 1 }, { w: 800, h: 450 }), true);
  assert.equal(checkViewportAgainstShot({ w: 1280, h: 720, dpr: 2 }, { w: 800, h: 450 }), true);
  assert.equal(checkViewportAgainstShot({ w: 300, h: 600, dpr: 2 }, { w: 600, h: 1200 }), true);
  assert.equal(checkViewportAgainstShot({ w: 1280, h: 720, dpr: 1 }, { w: 1280, h: 720 }), true, "授權沒設 maxWidth");
  assert.equal(checkViewportAgainstShot({ w: 1280, h: 720, dpr: 1 }, { w: 800, h: 300 }), false, "比例不對");
  assert.equal(checkViewportAgainstShot({ w: 640, h: 360, dpr: 1 }, { w: 800, h: 450 }), false, "頁面謊報成比較小：截圖比它的裝置像素還寬");
  assert.equal(checkViewportAgainstShot({ w: 1280, h: 720, dpr: 1 }, null), false);
});

test("jpegSize：從 SOF 標記讀出寬高；不是 JPEG／被截斷 → null", () => {
  // SOI, APP0(len 16), SOF0(len 17) h=450 w=800
  const bytes = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0),
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xc2, 0x03, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  assert.deepEqual(jpegSize(bytes), { w: 800, h: 450 });
  assert.equal(jpegSize(new Uint8Array([1, 2, 3])), null);
  assert.equal(jpegSize(bytes.slice(0, 12)), null);
  assert.equal(jpegSize(null), null);
});

test("pngSize／imageSize：PNG 的 IHDR；兩種格式都讀得出；壞的回 null", () => {
  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x05, 0x00, 0, 0, 0x02, 0xd0]);
  assert.deepEqual(pngSize(png), { w: 1280, h: 720 });
  assert.deepEqual(imageSize(png), { w: 1280, h: 720 });
  assert.equal(pngSize(new Uint8Array(30)), null);
  assert.equal(pngSize(null), null);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xc2, 0x03, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  assert.deepEqual(imageSize(jpeg), { w: 800, h: 450 });
  assert.equal(imageSize(new Uint8Array([1, 2, 3, 4])), null);
});

test("解析腳本：按鈕沒有 formaction 屬性時用表單的 action（button.formAction 回的是文件網址，不能信）", () => {
  const s = buildResolveScript({ x: 5, y: 5 });
  const rect = { left: 0, top: 0, width: 50, height: 20 };
  const form = { action: "https://shop.example.com/checkout/pay", method: "post", elements: [], querySelector: () => null };
  const mk = (hasOwn) => ({
    tagName: "BUTTON", shadowRoot: null, parentElement: null, form, type: "submit",
    matches: () => true, closest: () => null, contains: () => true, getRootNode: () => ({}),
    getAttribute: () => null, hasAttribute: (n) => hasOwn && n === "formaction",
    // 真的瀏覽器：沒有屬性時回文件網址；有屬性時回屬性解析後的網址
    formAction: hasOwn ? "https://shop.example.com/other/endpoint" : "https://shop.example.com/cart", formMethod: "",
    innerText: "Go", textContent: "Go", getBoundingClientRect: () => rect,
  });
  const run = (el) => {
    const doc = { elementsFromPoint: () => [el], elementFromPoint: () => el, querySelectorAll: () => [] };
    const win = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0 } };
    const fn = new Function("document", "window", "Element", "location", "performance", `return (${s})()`);
    const out = fn(doc, win, { prototype: { getBoundingClientRect: () => rect } }, { origin: "https://shop.example.com", pathname: "/cart", href: "https://shop.example.com/cart" }, { timeOrigin: 1_700_000_000_000 });
    const parsed = parseResolution(JSON.parse(JSON.stringify(out)));
    assert.equal(parsed.ok, true, JSON.stringify(out));
    return parsed.value.hit;
  };
  assert.deepEqual(run(mk(false)).formAction, { host: "shop.example.com", path: "/checkout/pay" }, "沒有 formaction：用 form.action，不是文件網址 /cart");
  assert.deepEqual(run(mk(true)).formAction, { host: "shop.example.com", path: "/other/endpoint" }, "明確寫了 formaction：用它");
});

// ── B6：以元素（uid）與焦點元素為目標 ──────────────────────────────────────

/** 假的 DOM：一個元素與它所在的文件。script 用函式參數收到全域。 */
function runScript(script, el, opts = {}) {
  const rect = opts.rect ?? { left: 100, top: 200, width: 80, height: 20 };
  const doc = {
    activeElement: opts.active ?? null,
    elementsFromPoint: () => (opts.under ? [opts.under] : [el].filter(Boolean)),
    elementFromPoint: () => opts.under ?? el,
    querySelectorAll: () => [],
  };
  const win = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0 } };
  const fn = new Function("document", "window", "Element", "location", "performance", `return (${script})`)(
    doc, win, { prototype: { getBoundingClientRect: () => rect } },
    { origin: "https://shop.example.com", pathname: "/cart", href: "https://shop.example.com/cart" }, { timeOrigin: 1_700_000_000_000 },
  );
  return JSON.parse(JSON.stringify(opts.pass === false ? fn() : fn(el)));
}

const fakeEl = (over = {}) => ({
  nodeType: 1, tagName: "BUTTON", shadowRoot: null, parentElement: null, form: null, type: "button",
  ownerDocument: null, matches: () => true, closest: () => null, contains: () => true,
  getRootNode: () => ({}), getAttribute: () => null, hasAttribute: () => false,
  innerText: "Pay", textContent: "Pay", href: undefined,
  getBoundingClientRect: () => ({ left: 100, top: 200, width: 80, height: 20 }), ...over,
});

test("buildResolveElementScript：是一個收元素參數的函式（evaluate_script 的 args 傳 uid）；描述那個元素，座標是它的中心", () => {
  const s = buildResolveElementScript();
  assert.match(s, /^\(el\)\s*=>/);
  const out = runScript(s, fakeEl());
  const parsed = parseResolution(out);
  assert.equal(parsed.ok, true, JSON.stringify(out));
  assert.equal(parsed.value.hit.tag, "button");
  assert.deepEqual(parsed.value.point, { x: 140, y: 210 }, "bbox (100,200,80,20) 的中心");
  assert.equal(parsed.value.target?.kind, "element");
});

test("buildResolveElementScript：參數不是元素（uid 已經不在）→ hit:null", () => {
  const out = runScript(buildResolveElementScript(), null);
  const parsed = parseResolution(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.hit, null);
});

test("buildResolveElementScript：捲到視窗外的元素 → 座標夾到 0、offscreen:true（仍然是合法的解析）", () => {
  const out = runScript(buildResolveElementScript(), fakeEl({ getBoundingClientRect: () => ({ left: -500, top: -300, width: 40, height: 10 }) }), { rect: { left: -500, top: -300, width: 40, height: 10 } });
  const parsed = parseResolution(out);
  assert.equal(parsed.ok, true, JSON.stringify(out));
  assert.deepEqual(parsed.value.point, { x: 0, y: 0 });
  assert.equal(parsed.value.offscreen, true);
});

test("buildResolveActiveScript：沒有參數；描述 document.activeElement；body 或沒有焦點 → hit:null", () => {
  const s = buildResolveActiveScript();
  assert.match(s, /^\(\)\s*=>/);
  const el = fakeEl({ tagName: "INPUT", type: "submit" });
  const withFocus = parseResolution(runScript(s, el, { active: el, pass: false }));
  assert.equal(withFocus.ok, true);
  assert.equal(withFocus.value.hit.tag, "input");
  assert.equal(withFocus.value.target?.kind, "active");
  const none = parseResolution(runScript(s, el, { active: null, pass: false }));
  assert.equal(none.ok, true);
  assert.equal(none.value.hit, null);
  const body = fakeEl({ tagName: "BODY" });
  const onBody = parseResolution(runScript(s, body, { active: body, pass: false }));
  assert.equal(onBody.value.hit, null, "焦點在 body ＝ 沒有焦點元素");
});

test("三種腳本都是唯讀的（同一份禁字表）", () => {
  for (const s of [buildResolveElementScript(), buildResolveActiveScript(), buildResolveScript({ x: 1, y: 1 })]) {
    for (const forbidden of [/\beval\s*\(/, /new\s+Function/, /\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /\.innerHTML\s*=/, /\.appendChild\s*\(/, /\.setAttribute\s*\(/, /scrollIntoView/, /\.click\s*\(/, /\.focus\s*\(/, /dispatchEvent/, /localStorage|sessionStorage|document\.cookie/]) {
      assert.doesNotMatch(s, forbidden, String(forbidden));
    }
  }
});

test("parseResolution：target 與 offscreen 是選填；未知的 target.kind 拒絕", () => {
  const base = raw();
  assert.equal(parseResolution(base).ok, true);
  assert.equal(parseResolution({ ...base, target: { kind: "element" }, offscreen: false }).ok, true);
  assert.equal(parseResolution({ ...base, target: { kind: "weird" } }).ok, false);
  assert.equal(parseResolution({ ...base, offscreen: "yes" }).ok, false);
});
