// Hand-written types for the plain-ESM package (no build step; sandbox-runtime
// imports the .mjs files directly, the Next app and the bun daemon get these).
export function supportsNativeAgent(ops: readonly string[] | null | undefined, version: string | null | undefined): boolean;

export type ApprovalOp = "exec" | "writeFile" | "deleteFile" | "ensureDir" | "terminalOpen" | "mcpCall" | "agentSession";
export type RelayOp =
  | "exec" | "readFile" | "readFileBytes" | "writeFile" | "statFile" | "listFiles" | "deleteFile" | "ensureDir" | "cancel"
  | "terminalOpen" | "terminalInput" | "terminalResize" | "terminalSignal" | "terminalClose" | "terminalReplay"
  | "mcpList" | "mcpCall"
  | "nativeHarness"
  | "pluginManage"
  | "browserSetup"
  | "agentSession" | "agentSessionInput" | "agentSessionClose"
  | "deviceList" | "deviceEnroll" | "machineSelect" | "sessionAuthorize";
export type FrameType = "ready" | "ping" | "hello" | "invoke" | "result" | "revoke";

export interface ApprovalSubject {
  runtimeSha256?: string;
  patchFile?: string;
  tool: ApprovalOp;
  command?: string;
  path?: string;
  contentSha256?: string;
  cwd?: string | null;
  env?: Record<string, string>;
  /** mcpCall —— 哪一台本機 MCP server。 */
  server?: string;
  /** mcpCall —— 它上面的哪一個工具。不叫 `tool` 是因為那個欄位已經是 op 名字。 */
  mcpTool?: string;
  /** mcpCall —— 參數的摘要（`canonicalJson` → sha256），不是參數原文。 */
  argumentsSha256?: string;
}
export interface ApprovalClaims {
  v: 1; alg: "hmac"; invokeId: string; machineId: string; userId: string | null; sessionId: string | null;
  tool: string; payloadHash: string; iat: number; exp: number; nonce: string;
}
export interface NonceRegistry { has(nonce: string, at?: number): boolean; add(nonce: string, exp?: number, at?: number): void; readonly size: number }
export type VerifyResult = { ok: true; claims: ApprovalClaims } | { ok: false; reason: string };
export type ContainResult = { ok: true; resolved: string } | { ok: false; reason: "bad_path" | "home_relative" | "root_missing" | "outside_root" };
export interface CommandVerdict { verdict: "denied" | "read_only" | "needs_approval"; risk: string | null }
export type ParsedFrame = { ok: true; frame: Record<string, unknown> & { v: number; type: FrameType } } | { ok: false; reason: "malformed" | "unsupported_version" | "unknown_type" | "bad_shape" };

export const APPROVAL_OPS: readonly ApprovalOp[];
/** 登入授權（passkey 一次、最長 1 週）能簽哪些動作 —— daemon、伺服器、瀏覽器共用。 */
export const SESSION_GRANT_TOOLS: readonly ApprovalOp[];
export const LEGACY_SESSION_GRANT_TOOLS: readonly ApprovalOp[];
export const FULL_SESSION_GRANT_DAEMON: string;
export function sessionGrantTools(daemonVersion: string | null | undefined): readonly ApprovalOp[];
export const APPROVAL_TTL_MS: number;
export const PROTOCOL_VERSION: number;
export const FRAME_TYPES: readonly FrameType[];
export const OPS: readonly RelayOp[];
export const READ_ONLY_COMMANDS: Set<string>;
export const READ_ONLY_GIT: Set<string>;
export const WRITES_VIA_SHELL: RegExp;
export const HARD_DENYLIST: RegExp[];

export function canonicalJson(value: unknown): string;
export function sha256Hex(input: string | Uint8Array): string;
export function payloadHash(subject: unknown): string;
export function approvalSubject(tool: string, args?: Record<string, unknown>): ApprovalSubject;
export function mintApprovalToken(
  key: string | Uint8Array,
  claims: { invokeId: string; machineId: string; userId?: string | null; sessionId?: string | null; tool: string; payloadHash: string },
  opts?: { now?: number; ttlMs?: number },
): string;
export function verifyApprovalToken(
  key: string | Uint8Array,
  token: string,
  expect: { machineId: string; invokeId?: string; tool: string; subject?: unknown; payloadHash?: string },
  opts?: { now?: number; nonces?: NonceRegistry | null },
): VerifyResult;
export function createNonceRegistry(opts?: { ttlMs?: number; now?: () => number }): NonceRegistry;
export function containPath(root: string, requested: string, opts?: { realpath?: (p: string) => string; windows?: boolean }): ContainResult;
export function workspacePath(root: string | null | undefined, requested: string | null | undefined): string | null;
export function isReadOnlyCommand(raw: string): boolean;
export function bashDestructiveRisk(cmd: string): string | null;
export function isHardDenied(cmd: string): boolean;
/**
 * 分級。**第二個參數原本沒有被宣告出來**,而實作是
 * `classifyCommand(cmd, { root = "" } = {})` —— 於是每一個傳 `{ root }` 的
 * 呼叫端在型別上都是錯的,而沒有人看得到:根 tsconfig 的 exclude 含
 * `"runtime"`,所以這個目錄從來沒有被 typecheck 過。
 *
 * `root` 是承重的:路徑相對於哪裡決定了「這條指令會不會動到授權資料夾外面」。
 */
export function classifyCommand(cmd: string, opts?: { root?: string }): CommandVerdict;

/* ── 使用者自己訂的逐工具規則（permission-rules.mjs）────────────────────────
 * 宣告在這裡的理由跟 `classifyCommand` 的註解一樣，而且方向相反：那一條是
 * 「宣告漏了一個承重的參數」，這一條是「別讓它一開始就漏」。app 那一側的型別
 * 門面在 lib/agent-code/permission-rules.ts（它直接 import 那個 .mjs）。 */
export type PermissionRuleBehavior = "allow" | "deny" | "ask";
export interface PermissionRule { pattern: string; behavior: PermissionRuleBehavior }
export interface PermissionRuleHit { behavior: PermissionRuleBehavior; pattern: string }
export const RULE_BEHAVIORS: readonly PermissionRuleBehavior[];
export function normalizeRuleText(value: unknown): string;
export function normalizeRuleTool(name: unknown): string;
export function parsePermissionRule(pattern: unknown): { tool: string; arg: string | null } | null;
export function ruleMatches(pattern: unknown, tool: unknown, target: unknown): boolean;
export function ruleSpecificity(pattern: unknown): number;
export function evaluatePermissionRules(
  rules: readonly PermissionRule[] | null | undefined,
  tool: string,
  target: string,
): PermissionRuleHit | null;
export function ruleTargetOf(tool: string, input: unknown): string;
export function usablePermissionRules(rows: unknown): PermissionRule[];
/** 一張裝置簽的核准（WebAuthn assertion），在線路上的樣子。見 device-ticket.mjs。 */
export interface DeviceAssertion {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}
export interface DeviceClaims {
  v: 1; alg: "webauthn"; invokeId: string; machineId: string; tool: string; payloadHash: string;
  scope: unknown | null; iat: number; exp: number;
}
export const DEVICE_APPROVAL_TTL_MS: number;
export const DEVICE_TICKET_PREFIX: string;
export function encodeDeviceClaims(claims: {
  invokeId: string; machineId: string; tool: string; payloadHash: string; scope?: unknown; iat?: number; exp?: number;
}): string;
export function challengeFor(claimsB64: string): string;
/** 一張斷言的簽章事實（assertion-policy.mjs）。稽核與 posture 用；不是門，除非 strict。 */
export interface AssertionEvidence {
  uv: boolean;
  /** `null` ＝ 沒有 appOrigin 可比。 */
  rpIdMatches: boolean | null;
  originMatches: boolean | null;
  crossOrigin: boolean;
  origin: string | null;
}
export interface AssertionPolicy {
  appOrigin?: string;
  /** 使用者在自己電腦上開的：UV 必須、origin／rpId 精確一致。 */
  strict?: boolean;
  /** 登入授權既有的底線：不開 strict 也比 origin／rpId。 */
  enforceOrigin?: boolean;
}
export function checkAssertion(
  authData: Buffer, clientData: unknown, policy?: AssertionPolicy,
): { ok: true; evidence: AssertionEvidence } | { ok: false; reason: string; message: string; evidence: AssertionEvidence | null };
export function judgeEvidence(
  evidence: AssertionEvidence, policy?: AssertionPolicy,
): { ok: true } | { ok: false; reason: string; message: string };
export function inspectAssertion(authData: Buffer, clientData: unknown, appOrigin?: string): AssertionEvidence;
export function formatEvidence(e: AssertionEvidence | null | undefined): string;
export function verifyDeviceApproval(
  claimsB64: string,
  assertion: DeviceAssertion,
  expect: { machineId: string; tool: string; payloadHash: string },
  deps: { keys: Map<string, string>; now?: number; nonces?: { seen?(id: string): boolean; remember?(id: string, exp: number): void } } & AssertionPolicy,
): { ok: true; claims: DeviceClaims; evidence: AssertionEvidence } | { ok: false; reason: string; message?: string; evidence?: AssertionEvidence | null };
export function encodeEnrollment(req: {
  op: "add" | "remove"; machineId: string; credentialId: string; publicKey?: string | null; label?: string | null;
  iat?: number; exp?: number;
}): string;
export function enrollmentChallenge(enrollB64: string): string;
export function verifyEnrollment(
  enrollB64: string,
  by: DeviceAssertion | null,
  deps: { machineId: string; keys: Map<string, string>; localConfirm?: boolean; now?: number } & AssertionPolicy,
): { ok: true; req: { op: "add" | "remove"; machineId: string; credentialId: string; publicKey: string | null; label: string | null; iat: number; exp: number }; evidence?: AssertionEvidence }
  | { ok: false; reason: string; message?: string; evidence?: AssertionEvidence | null };
export function isDeviceTicket(token: unknown): boolean;
export function packDeviceTicket(claimsB64: string, assertion: DeviceAssertion): string;
export function parseDeviceTicket(token: unknown): { claimsB64: string; assertion: DeviceAssertion } | null;

export function encodeFrame(frame: Record<string, unknown> & { type: FrameType }): string;
export function parseFrame(line: string): ParsedFrame;

export const REDACTION_KINDS: readonly string[];
export function redactionMarkersIn(text: string): string[];
export function redactedWriteRefusal(content: string | Uint8Array): { code: "redacted_content"; message: string } | null;

export { chromeLaunchRefusal, KEYCHAIN_FREE_FLAGS } from "./chrome-launch-policy.mjs";
