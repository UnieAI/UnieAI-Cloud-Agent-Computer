/**
 * device-ticket.mjs —— 一張裝置簽的核准，在線路上長什麼樣。
 *
 * ## 為什麼不開一個新的 frame 欄位
 *
 * 一張核准從 app 走到 daemon 要經過三層（app → sandbox-runtime 的 relay 門 →
 * registry 的 invoke frame → daemon），而中間那兩層對 `approval` 這個欄位做的
 * 事只有一件：**原樣往下傳**。它們讀不懂票，也因此改不了票 —— 那正是我們要的
 * 性質。
 *
 * 開一個 `deviceApproval` 新欄位的話，那兩層都要跟著改，而且從此有兩條路要維護
 * （「有的票走這個欄位、有的走那個」）。所以裝置簽的票就是**一個字串**，跟
 * HMAC 那張同一格。中間層完全不必知道世界上有第二種票。
 *
 * ## 認得出來，而且不會認錯
 *
 * HMAC 票是 `base64url(JSON).base64url(sig)`，JSON 一定以 `{"v":1` 開頭，所以
 * base64url 一定以 `ey` 開頭 —— 前綴 `ava1d.` 不可能跟它撞。版本號寫在前綴裡
 * （`1`）是為了以後換簽章格式時，舊 daemon 看到的是「我不認得這種票」而不是
 * 「這張票壞了」。
 */

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** 裝置簽的票的前綴。見檔頭：故意跟 HMAC 票的 base64url 開頭撞不到。 */
export const DEVICE_TICKET_PREFIX = "ava1d.";

export function isDeviceTicket(token) {
  return typeof token === "string" && token.startsWith(DEVICE_TICKET_PREFIX);
}

/**
 * 把 claims 與 WebAuthn assertion 包成一個字串。
 *
 * **app 用的就是這一支，而它不簽任何東西** —— 兩個參數都是別人給的：claims 是
 * app 自己算的（沒有秘密），assertion 是使用者的裝置簽的（app 產不出來）。
 *
 * @param {string} claimsB64  encodeDeviceClaims 的輸出
 * @param {{ credentialId: string, authenticatorData: string, clientDataJSON: string, signature: string }} assertion
 */
export function packDeviceTicket(claimsB64, assertion) {
  for (const f of ["credentialId", "authenticatorData", "clientDataJSON", "signature"]) {
    if (!assertion?.[f] || typeof assertion[f] !== "string") {
      throw new Error(`packDeviceTicket: assertion.${f} is required`);
    }
  }
  const body = {
    credentialId: assertion.credentialId,
    authenticatorData: assertion.authenticatorData,
    clientDataJSON: assertion.clientDataJSON,
    signature: assertion.signature,
  };
  return `${DEVICE_TICKET_PREFIX}${String(claimsB64)}.${b64url(JSON.stringify(body))}`;
}

/**
 * 拆開一張裝置票。**壞掉一律回 null，不丟例外** —— 這條路上的輸入全部來自
 * 網路，而一個未捕捉的例外會變成「那台機器沒回應」，那句話跟真正的原因
 * （票的格式不對）差很遠。
 *
 * @returns {{ claimsB64: string, assertion: object } | null}
 */
export function parseDeviceTicket(token) {
  if (!isDeviceTicket(token)) return null;
  const rest = token.slice(DEVICE_TICKET_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  const claimsB64 = rest.slice(0, dot);
  let assertion;
  try {
    assertion = JSON.parse(Buffer.from(rest.slice(dot + 1), "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) return null;
  for (const f of ["credentialId", "authenticatorData", "clientDataJSON", "signature"]) {
    if (typeof assertion[f] !== "string" || !assertion[f]) return null;
  }
  return { claimsB64, assertion };
}
