/** Shared admission contract. No arbitrary executable, credentials or URL from the browser. */
export const HARNESS_READ_ACTIONS = Object.freeze(["status", "read", "models"]);
export function parseHarnessCall(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("native_harness_bad_request");
  const fields = { status: [], read: ["sessionId", "provider", "cwd"], models: ["sessionId", "provider", "cwd"],
    configure: ["sessionId", "provider", "cwd", "model"],
    send: ["sessionId", "provider", "cwd", "requestId", "text", "rabi"],
    stop: ["sessionId", "provider", "cwd"], approve: ["sessionId", "provider", "cwd", "approvalId", "decision"],
    reconcile: ["sessionId", "provider", "cwd"] };
  const keys = Object.hasOwn(fields, value.action) && fields[value.action];
  if (!keys || Object.keys(value).some(k => k !== "action" && !keys.includes(k))) throw new Error("native_harness_bad_request");
  if (value.action === "status") return { action: "status" };
  if (!/^[a-f0-9-]{36}$/i.test(value.sessionId) || !["claude", "codex"].includes(value.provider) ||
      typeof value.cwd !== "string" || !value.cwd || value.cwd.length > 4096 || /[\x00-\x1f]/.test(value.cwd)) throw new Error("native_harness_bad_binding");
  if (value.action === "send" && (!/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId) || typeof value.text !== "string" ||
      !value.text.trim() || value.text.length > 64000 || typeof value.rabi !== "boolean")) throw new Error("native_harness_bad_prompt");
  if (value.action === "approve" && (typeof value.approvalId !== "string" || value.approvalId.length > 200 || !["accept", "decline"].includes(value.decision))) throw new Error("native_harness_bad_approval");
  if (value.action === "configure" && value.model !== null &&
      (typeof value.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/()[\]-]{0,199}$/.test(value.model))) throw new Error("native_harness_bad_model");
  return { ...value };
}
export function harnessApprovalArgs(call) { return { server: "ava-native-harness", tool: call.action, arguments: call }; }
