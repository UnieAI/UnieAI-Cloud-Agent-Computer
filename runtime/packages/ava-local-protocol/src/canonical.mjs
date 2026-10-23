/**
 * canonical.mjs — one byte-stable serialisation for anything two parties must
 * agree on without talking to each other.
 *
 * The daemon and the app never exchange the approval *subject* itself; each
 * side derives it from what it has (the app from the tool call it is about to
 * forward, the daemon from the invoke it received) and compares digests. That
 * only works if both serialise identically, so this module is deliberately
 * boring: sorted keys at every depth, no undefined, no whitespace.
 */

import { createHash } from "node:crypto";

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortDeep(value[key]);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON: sorted keys, undefined dropped, no whitespace. */
export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value));
}

/** Lowercase hex sha256 of a string or bytes. */
export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** The digest an approval token is bound to. */
export function payloadHash(subject) {
  return sha256Hex(canonicalJson(subject));
}

/** Operations that need a human's approval before the daemon runs them. */
export const APPROVAL_OPS = Object.freeze(["exec", "writeFile", "deleteFile", "ensureDir", "terminalOpen", "mcpCall", "agentSession"]);

/**
 * Version of the subject shape. Part of the digest on purpose: a daemon and an
 * app that disagree about what a subject contains must fail loudly rather than
 * agree by coincidence.
 *
 * v1 → v2: `exec` bound the command string alone.
 */
export const APPROVAL_SUBJECT_VERSION = 2;

/**
 * What exactly is being approved, reduced to the fields the daemon will act on.
 *
 * THE RULE: every field the daemon reads off the invoke frame and lets change
 * the outcome must be in here. Nothing else can be, or the two sides cannot
 * derive the same digest independently.
 *
 * `exec` binds the command AND its surroundings. It used to bind the command
 * alone, justified in this comment by "the working directory is always the
 * granted root on the daemon" — an invariant the daemon had already stopped
 * honouring, since it resolves `args.cwd` whenever one is sent. Nothing failed,
 * because no test asserted the invariant either. What that left open was not a
 * replay (the nonce still holds) but the FIRST use of a genuine token with
 * different surroundings, by the component this design exists to distrust:
 *
 *   · `env`     — never sent on any legitimate path, so binding it costs
 *                 nothing; an injected PATH makes an approved `npm test` run
 *                 someone else's `npm` under the user's own account.
 *   · `cwd`     — the card named a command, not a place.
 *   · `kind`    — the same text through `python3 -c` is a different program.
 *   · `sandbox` — the card promises this one IN WORDS. A promise shown to a
 *                 person and not carried by the token is not a promise.
 *
 * `writeFile` binds the path and a digest of the content — never the content,
 * which can be megabytes and would otherwise travel twice. Anything else is a
 * read and must not be approved at all, so asking for its subject is a
 * programming error, not a policy question.
 */
export function approvalSubject(tool, args = {}) {
  const v = APPROVAL_SUBJECT_VERSION;
  switch (tool) {
    case "exec":
      return {
        v,
        tool,
        command: String(args.command ?? ""),
        // Normalised the same way the daemon normalises them, so both sides
        // reach the same digest from the same frame. `canonicalJson` sorts env
        // keys at every depth, so key order cannot change the hash.
        kind: args.kind === "python" ? "python" : "bash",
        cwd: typeof args.cwd === "string" && args.cwd ? args.cwd : null,
        env: args.env && typeof args.env === "object" && !Array.isArray(args.env)
          ? Object.fromEntries(Object.entries(args.env).map(([k, val]) => [String(k), String(val)]))
          : {},
        sandbox: args.sandbox === true,
      };
    case "writeFile": {
      // The signer does not always hold the bytes. The engine has them and the
      // app signs, so the app is handed `contentSha256` instead of megabytes of
      // content travelling a second time. Both sides still derive the SAME
      // subject, which is the only property that matters here.
      //
      // Bytes win when both are present: `content` is the ground truth, and a
      // stray `contentSha256` on a call that does have the content must not be
      // able to decide what gets signed.
      if (args.content === undefined && typeof args.contentSha256 === "string") {
        const given = args.contentSha256.toLowerCase();
        // A malformed digest is a programming error, not a policy question. Left
        // unchecked it would sign a subject the daemon can never reproduce, and
        // the person would see "payload_mismatch" for a write they did approve.
        if (!/^[0-9a-f]{64}$/.test(given)) {
          throw new Error("approvalSubject: contentSha256 must be 64 lowercase hex characters");
        }
        return { v, tool, path: String(args.path ?? ""), contentSha256: given };
      }
      const content = args.content ?? "";
      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      return { v, tool, path: String(args.path ?? ""), contentSha256: sha256Hex(bytes) };
    }
    case "deleteFile":
    case "ensureDir":
      return { v, tool, path: String(args.path ?? "") };
    case "mcpCall":
      // 本機 MCP server 的一次工具呼叫。
      //
      // **為什麼三個欄位都要綁**：MCP server 是使用者自己電腦上的一個程式，
      // 它能做的事沒有上界（SlideWork 會改簡報、一個 git server 會 push）。
      // 所以核准卡上寫的那一句話 ——「讓 <server> 跑 <tool>，參數是這些」——
      // 三段都必須在票裡，少一段就等於卡片上的承諾沒有被票帶著走：
      //
      //   · `server`  —— 同一個工具名字在兩台 server 上是兩件完全不同的事。
      //   · `mcpTool` —— 不叫 `tool` 是因為 `tool` 這個欄位已經被 op 名字
      //                  （"mcpCall"）佔走了。**兩邊算 subject 的時候要給
      //                  同一組 args**（frame 上是 MCP 原生的 `tool`），所以
      //                  這裡兩個拼法都收 —— 不然症狀是 `payload_mismatch`，
      //                  一個看起來像「票壞了」其實是「兩邊算的不是同一件事」
      //                  的錯誤（exec 的 cwd、terminalOpen 的 cwd 都踩過）。
      //   · 參數摘要   —— 跟 writeFile 的內容一樣走摘要而不是原文：參數可以很大
      //                  （一整份簡報的 JSON），而票是要放進 HTTP header 大小
      //                  等級的地方的。`canonicalJson` 兩邊排序一致，所以
      //                  key 的順序換了不會變成不同的摘要。
      {
        const mcpTool = String(args.mcpTool ?? args.tool ?? "");
        if (args.arguments === undefined && typeof args.argumentsSha256 === "string") {
          const given = args.argumentsSha256.toLowerCase();
          if (!/^[0-9a-f]{64}$/.test(given)) {
            throw new Error("approvalSubject: argumentsSha256 must be 64 lowercase hex characters");
          }
          return { v, tool, server: String(args.server ?? ""), mcpTool, argumentsSha256: given };
        }
        return {
          v,
          tool,
          server: String(args.server ?? ""),
          mcpTool,
          argumentsSha256: sha256Hex(canonicalJson(args.arguments ?? {})),
        };
      }
    case "terminalOpen":
      // A terminal is approved ONCE, at open, and then accepts anything the
      // person types — there is no such thing as approving a keystroke. So the
      // subject is the two facts the card can honestly show: WHERE the shell
      // starts, and whether a caller tried to plant variables in it.
      //
      // `cwd` is bound even though the daemon also contains it, for the same
      // reason `exec` binds it: the card named a place, and a promise shown to
      // a person that the token does not carry is not a promise.
      return {
        v,
        tool,
        cwd: typeof args.cwd === "string" && args.cwd ? args.cwd : null,
        env: args.env && typeof args.env === "object" && !Array.isArray(args.env)
          ? Object.fromEntries(Object.entries(args.env).map(([k, val]) => [String(k), String(val)]))
          : {},
      };
    case "agentSession":
      // 本機代理會話：在**這台電腦上**起一個 DSH。
      //
      // 核准一次，在 open 的時候 —— 跟終端機同一個判斷，理由也一樣：
      // 一個本機代理能做的事不少於一個終端機（它就是要在這裡跑指令），
      // 而「核准每一則 ACP 訊息」既不可行也沒有意義。
      //
      // subject 綁的是卡片誠實說得出的那件事：**在哪個資料夾**。
      // `cwd` 要綁即使 daemon 也會圍籬，理由跟 exec 與 terminalOpen 一樣 ——
      // 卡片指名了一個地方，而一個給人看過卻沒有被票帶著走的承諾不是承諾。
      //
      // **模型憑證刻意不進 subject。** 它是每個 session 新鑄的短期 token
      // （lib/machines/model-token.ts），所以把它綁進去會讓票在換一把 token
      // 之後就對不上，而那個症狀會長得像「票壞了」。它的保護是另一道：
      // env-guard 的 `agentEnv` 只接受限範圍的形狀，共用金鑰過不去。
      return {
        v,
        tool,
        cwd: typeof args.cwd === "string" && args.cwd ? args.cwd : null,
        // A change of preset, provider endpoint, persona or patch is a new
        // launch. Scoped credential rotation alone does not invalidate consent.
        ...(args.runtime !== undefined ? { runtimeSha256: sha256Hex(canonicalJson(args.runtime)) } : {}),
        ...(args.patchFile ? { patchFile: String(args.patchFile) } : {}),
      };
    default:
      throw new Error(`approvalSubject: "${tool}" does not require approval`);
  }
}
