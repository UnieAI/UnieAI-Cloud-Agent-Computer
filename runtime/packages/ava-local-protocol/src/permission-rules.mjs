/**
 * permission-rules.mjs —— 使用者自己訂的逐工具規則，**一份實作**。
 *
 * 設定頁（components/settings/permission-rules-section.tsx）寫下的那一張表
 * （`permission_rules`，`source = 'userSettings'`）在這裡被解讀。放在這個套件
 * 裡的理由跟 `shell-policy.mjs` 一模一樣：**同一條規則有兩個執行點**，而同一條
 * 規則兩份實作是這棵樹反覆踩的那個坑。
 *
 *   · app 這一半 —— `lib/agent-code/permission-gate.ts` 的 `gateToolCall`
 *     （app 的工具，含子 agent：它們走同一個已發布的 app-tools MCP toolset）
 *     與 `lib/agent-code/session-interactions.ts` 的 `decideApproval`
 *     （要不要出核准卡）。
 *   · 引擎這一半 —— `runtime/apps/ava-engine/src/permission-mode.mjs` 的
 *     `needsApprovalFor`。DSH 自己的 `bash` 跑在引擎行程裡，**一次都不會經過
 *     app 的 toolset 守門**，所以少了這一半，使用者寫「bash:rm * → 拒絕」
 *     在略過核准模式底下完全沒有作用 —— 一個會說謊的開關。
 *
 * ── 優先順序（owner 2026-10-08 決定，四段，順序本身就是規則）────────────────
 *
 *   1. **硬性拒絕清單**永遠最先、永遠贏。使用者的 `allow` **不准**打敗它
 *      （那張清單是「沒有人會故意要的損失」）。所以這個檔案裡沒有任何東西
 *      碰得到它 —— 呼叫端一律先問 `isHardDenied` / `classify`，再問這裡。
 *   2. **使用者的 `deny`** —— 任何模式都不准繞過，`bypass`（略過核准）也不行。
 *      `bypass` 的語意是「不要再問我」，不是「忽略我自己訂的規則」。
 *   3. **使用者的 `ask`** —— 把一個本來會自動放行的呼叫降級成問一次；
 *      **不會**把一個本來就會問的升級成放行（降級一律安全，升級才需要審）。
 *   4. 以上都沒有命中 → 模式的預設行為，一個字都不改。
 *
 *   `allow` 的位置：它是第 3 段的反面 —— 「這把工具不用問我」，只能讓一個
 *   **本來會問** 的呼叫變成不問，而且只在呼叫端本來就允許不問的情況下
 *   （不是使用者自己的電腦、不是「永遠要問」的那幾類）。它永遠越不過第 1 段。
 *
 * ── pattern 的語意（最容易默默錯掉的地方，所以寫下來並且用表格測試釘住）────
 *
 *   `<工具>`              → 這把工具的每一次呼叫，不看參數。
 *   `<工具>:<glob>`       → 這把工具，而且 glob 命中「目標字串」。
 *
 *   · 工具名**不分大小寫**（cc-haha 寫 `Bash`，我們的設定頁寫 `bash`），
 *     並且先剝掉 `mcp__<server>__` 前綴 —— 模型看到的 app 工具叫
 *     `mcp__ava_app__tables_query`，而使用者寫的是 `tables_query`。
 *   · glob 只有 `*`（任意長度、可以是零個字元）。其餘字元一律**字面**比對，
 *     正規式的元字元會被轉義 —— 使用者寫的是 glob，不是正規式，而
 *     「看起來像萬用字元、其實是正規式」正是 `mcp_*` 那個坑。
 *   · glob **兩端都錨定**。所以 `bash:rm *` 命中 `rm -rf build`，
 *     **不命中** `rmdir -p x`（沒有那個空白）、也不命中 `sudo rm -rf x`
 *     （開頭不是 `rm `）。想包住後者要自己寫 `bash:*rm *`。
 *   · 比對前目標字串會 **trim + 把連續空白收成一個空白**，所以
 *     `rm   -rf  x` 跟 `rm -rf x` 是同一件事（不然多打一個空白就繞過了）。
 *   · glob 本身也做同一個正規化，`bash:rm  *` 與 `bash:rm *` 等價。
 *
 * ── 哪個規則贏（specificity）────────────────────────────────────────────────
 *
 *   帶參數 glob 的一律贏過只寫工具名的（設定頁上寫著「More specific patterns
 *   win over generic ones」，這就是那句話）。兩個都帶 glob 時，**字面字元多的**
 *   贏。完全同分時按嚴格度 deny > ask > allow —— 同分不可以是一枚硬幣。
 */

/** 這個欄位允許的三個值。 */
export const RULE_BEHAVIORS = ["allow", "deny", "ask"];

/** deny > ask > allow。同分時用它決定，數字大的贏。 */
const SEVERITY = { deny: 2, ask: 1, allow: 0 };

/** 連續空白收成一個，前後去掉。比對兩邊都要過這一關。 */
export function normalizeRuleText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 工具名正規化：剝掉 `mcp__<server>__` 前綴、trim、轉小寫。
 *
 * 前綴那一段跟 `permission-gate.ts` 的 `isEditTool` 同一個理由與同一個寫法：
 * app 的工具在 DSH 那邊帶前綴，而使用者在設定頁寫的是沒有前綴的名字。
 */
export function normalizeRuleTool(name) {
  return String(name ?? "").trim().replace(/^mcp__[a-z0-9_]+__/i, "").toLowerCase();
}

/**
 * `"bash:rm *"` → `{ tool: "bash", arg: "rm *" }`；`"bash"` → `{ tool: "bash", arg: null }`。
 *
 * 認不出來（空字串、只有冒號、工具名是空的）→ `null`。一條解析不出來的規則
 * **不是**「命中一切」，它什麼都不命中 —— 壞掉的規則不可以變成一道牆。
 */
export function parsePermissionRule(pattern) {
  const raw = String(pattern ?? "").trim();
  if (!raw) return null;
  const colon = raw.indexOf(":");
  const tool = normalizeRuleTool(colon === -1 ? raw : raw.slice(0, colon));
  if (!tool) return null;
  if (colon === -1) return { tool, arg: null };
  const arg = normalizeRuleText(raw.slice(colon + 1));
  // `"bash:"` —— 冒號後面什麼都沒有。當成「只寫工具名」，不是「命中空字串」：
  // 使用者的意思顯然是整把工具，而把它讀成「只命中沒有參數的呼叫」會讓那條
  // 規則看起來沒有生效。
  return { tool, arg: arg || null };
}

/** glob → 錨定的正規式。只有 `*` 有意義，其餘字元轉義。 */
function globToRegExp(glob) {
  const escaped = normalizeRuleText(glob).replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? "\u0000" : `\\${c}`));
  return new RegExp(`^${escaped.split("\u0000").join(".*")}$`);
}

/**
 * 這條規則命中這一次呼叫嗎。
 *
 * `target` 是「目標字串」—— bash 是那條指令，檔案類是路徑（見 `ruleTargetOf`）。
 */
export function ruleMatches(pattern, tool, target) {
  const parsed = parsePermissionRule(pattern);
  if (!parsed) return false;
  if (parsed.tool !== normalizeRuleTool(tool)) return false;
  if (parsed.arg === null) return true;
  return globToRegExp(parsed.arg).test(normalizeRuleText(target));
}

/**
 * 這條 pattern 有多「具體」。大的贏。
 *
 * 帶 glob 的一律贏過只有工具名的（+1000），之後比字面字元數（`*` 不算）。
 */
export function ruleSpecificity(pattern) {
  const parsed = parsePermissionRule(pattern);
  if (!parsed) return -1;
  if (parsed.arg === null) return 0;
  return 1000 + parsed.arg.split("*").join("").length;
}

/**
 * 這一次呼叫，使用者的規則說什麼。
 *
 * 回 `null` = 沒有任何規則命中（→ 照模式的預設走，第 4 段）。
 * 回 `{ behavior, pattern }` = 命中的那一條，連 pattern 一起回去，因為
 * **使用者要能從拒絕訊息裡認出是自己哪一條規則擋的** —— 一個沒有來源的
 * 「已拒絕」會被當成系統壞了。
 */
export function evaluatePermissionRules(rules, tool, target) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  let best = null;
  let bestScore = -1;
  let bestSeverity = -1;
  for (const rule of rules) {
    const pattern = String(rule?.pattern ?? "");
    const behavior = String(rule?.behavior ?? "");
    if (!RULE_BEHAVIORS.includes(behavior)) continue;
    if (!ruleMatches(pattern, tool, target)) continue;
    const score = ruleSpecificity(pattern);
    const severity = SEVERITY[behavior];
    if (score > bestScore || (score === bestScore && severity > bestSeverity)) {
      best = { behavior, pattern };
      bestScore = score;
      bestSeverity = severity;
    }
  }
  return best;
}

/**
 * 一次工具呼叫的「目標字串」—— 規則的 glob 比對的就是它。
 *
 * `bash` 是那條指令；其餘的取第一個看起來像「這次動的是哪個東西」的字串欄位。
 * 取不到就是空字串，而空字串只會被 `<工具>` 或 `<工具>:*` 命中 —— 不是
 * 「命中一切」。欄位名的順序是刻意的：`cmd` 最先（它才是 bash 的全部），
 * 路徑類在前、網址類在後。
 */
const TARGET_KEYS = ["cmd", "command", "filePath", "file_path", "path", "url", "pattern", "target", "query"];

export function ruleTargetOf(tool, input) {
  if (!input || typeof input !== "object") return "";
  for (const key of TARGET_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return normalizeRuleText(v);
  }
  return "";
}

/**
 * 只留下能用的那幾條（來源、行為、pattern 都認得出來）。
 *
 * 呼叫端從資料庫讀出來的列可能帶著別的 `source`（`agentCodeApproval` 是核准卡
 * 存的指令簽章，**不是**這一套的規則），所以過濾在這裡做一次，而不是讓每個
 * 呼叫端各自記得。
 */
export function usablePermissionRules(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const behavior = String(row?.behavior ?? "");
    if (!RULE_BEHAVIORS.includes(behavior)) continue;
    if (!parsePermissionRule(row?.pattern)) continue;
    out.push({ pattern: String(row.pattern).trim(), behavior });
  }
  return out;
}
