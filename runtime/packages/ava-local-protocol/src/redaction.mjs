/**
 * 遮蔽記號 —— daemon 讀檔時把祕密換成 `[redacted:<kind>]`（ava-local/src/redact.ts）。
 *
 * WHY 這一份放在 protocol（2026-09-26 UAT 軌道 C，P0）：檔案面板開一個含祕密的檔案，
 * 畫面上是遮蔽後的內容；使用者改了別的地方按存檔，**遮蔽記號就被寫回磁碟、真的祕密被蓋掉**。
 * 讀的那一端（daemon）會遮蔽，寫的那一端（relay、daemon）卻不認得自己的記號。
 *
 * 所以「哪些字串是遮蔽記號」只有這一份：daemon 產生它、relay 與 daemon 在寫入時拒收它。
 * 種類清單跟 daemon 的 `RedactionKind` 由測試釘著相等。
 */
export const REDACTION_KINDS = Object.freeze([
  "private-key",
  "jwt",
  "openai-key",
  "github-token",
  "aws-key",
  "google-key",
  "slack-token",
  "bearer",
  "url-credentials",
  "assignment",
  "card-number",
]);

const MARKER = new RegExp(`\\[redacted:(${REDACTION_KINDS.join("|")})\\]`, "g");

/** 這段文字裡有哪些遮蔽記號（依出現順序，可重複）。 */
export function redactionMarkersIn(text) {
  return [...String(text ?? "").matchAll(MARKER)].map((m) => m[1]);
}

/**
 * 要寫的內容裡如果有遮蔽記號，回一個拒絕（code + 給人看的訊息）；沒有就回 null。
 * 寫入端一律拒收：把記號寫回去等於用「這裡有祕密」這幾個字蓋掉那個祕密。
 */
export function redactedWriteRefusal(content) {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content ?? "");
  const kinds = redactionMarkersIn(text);
  if (!kinds.length) return null;
  const uniq = [...new Set(kinds)];
  return {
    code: "redacted_content",
    message:
      `沒有存檔：內容裡有 ${kinds.length} 處遮蔽記號（${uniq.map((k) => `[redacted:${k}]`).join("、")}）。` +
      "網頁上看到的是遮蔽後的內容，存回去會把電腦上真正的祕密蓋掉。請在你的電腦上直接編輯這個檔案。",
  };
}
