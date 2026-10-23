// Ambient type declarations for agentPermission.mjs. Keep field shapes in
// sync with the runtime helpers in agentPermission.mjs.

export const PERMISSION_REQUEST_TYPE: "permission_request";
export const PERMISSION_RESOLVED_TYPE: "permission_resolved";
export const PERMISSION_TIMEOUT_TYPE: "permission_timeout";

export const RISK_TIER: {
  readonly LOW: "low";
  readonly MEDIUM: "medium";
  readonly HIGH: "high";
};

export const TOOL_CATEGORY: {
  readonly SANDBOX: "sandbox";
  readonly WEB: "web";
  readonly MCP: "mcp";
  readonly SKILL: "skill";
  readonly KB: "kb";
  readonly TASK: "task";
  readonly SUBAGENT: "subagent";
  readonly OTHER: "other";
};

export const PERMISSION_ANSWER: {
  readonly ALLOW: "allow";
  readonly DENY: "deny";
  readonly TIMEOUT: "timeout";
  readonly CANCELLED: "cancelled";
};

export const DECIDED_BY: {
  readonly USER: "user";
  readonly SYSTEM_TIMEOUT: "system_timeout";
  readonly SYSTEM_CANCEL: "system_cancel";
  readonly POLICY_AUTO_ALLOW: "policy_auto_allow";
  readonly POLICY_AUTO_DENY: "policy_auto_deny";
  readonly PATTERN_MATCH: "pattern_match";
};

export const ALLOW_PATTERN_SCOPE: {
  readonly SESSION: "session";
  readonly USER_CUSTOM_MODEL: "user_custom_model";
  readonly USER_GLOBAL: "user_global";
};

export const PERMISSION_DEFAULT_TIMEOUT_MS: number;
export const PERMISSION_STATE_TTL_SECONDS: number;
export const PERMISSION_INPUT_PREVIEW_MAX_BYTES: number;

export function permissionPubsubChannel(sessionId: string): string;
export function permissionStateKey(sessionId: string, requestId: string): string;
export function permissionAllowlistKey(sessionId: string): string;

export interface PermissionRequestFramePayload {
  type: "permission_request";
  request_id: string;
  tool_use_id: string;
  tool_name: string;
  tool_category: string;
  risk_tier: string;
  input_preview: string;
  input_full_available: boolean;
  parent_message_id: number | null;
  expires_at: number;
  always_allow_supported: boolean;
}

export interface PermissionResolvedFramePayload {
  type: "permission_resolved";
  request_id: string;
  answer: string;
  decided_by: string;
  decided_at: number;
}

export interface PermissionTimeoutFramePayload {
  type: "permission_timeout";
  request_id: string;
  decided_at: number;
}

export function createPermissionRequestFrame(args: {
  requestId: string;
  toolUseId: string;
  toolName: string;
  toolCategory?: string;
  riskTier?: string;
  inputPreview?: string;
  inputFullAvailable?: boolean;
  parentMessageId?: number | null;
  expiresAt?: number;
  alwaysAllowSupported?: boolean;
}): PermissionRequestFramePayload;

export function createPermissionResolvedFrame(args: {
  requestId: string;
  answer?: string;
  decidedBy?: string;
}): PermissionResolvedFramePayload;

export function createPermissionTimeoutFrame(args: {
  requestId: string;
}): PermissionTimeoutFramePayload;

export interface AllowPattern {
  tool_name: string;
  preset: string;
  scope: "session" | "user_custom_model" | "user_global";
}

export function makeAllowPattern(args: {
  toolName: string;
  preset?: string;
  scope?: "session" | "user_custom_model" | "user_global";
}): AllowPattern;

export interface ValidPermissionAnswer {
  answer: "allow" | "deny" | "timeout" | "cancelled";
  patterns: AllowPattern[];
}

export function validatePermissionAnswer(body: unknown):
  | { valid: true; value: ValidPermissionAnswer }
  | { valid: false; error: string };

export const ALLOW_PATTERN_PRESETS: Readonly<Record<string, Readonly<Record<string, {
  label: string;
  description: string;
}>>>>;

export function truncateForPreview(args: unknown, maxBytes?: number): string;

// ── Plugin materialisation streaming (M2) ─────────────────────────────
export const PLUGIN_MATERIALIZE_STEP_TYPE: "plugin_materialize_step";

export const PLUGIN_MATERIALIZE_PHASE: {
  readonly PLAN: "plan";
  readonly FETCH_BUNDLE: "fetch_bundle";
  readonly VERIFY_SIGNATURE: "verify_signature";
  readonly LOAD_MANIFEST: "load_manifest";
  readonly WRITE_SANDBOX: "write_sandbox";
  readonly SPAWN_MCP: "spawn_mcp";
  readonly MCP_HANDSHAKE: "mcp_handshake";
  readonly READY: "ready";
  readonly DEGRADED: "degraded";
  readonly SESSION_READY: "session_ready";
};

export const PLUGIN_MATERIALIZE_STATUS: {
  readonly STARTED: "started";
  readonly COMPLETED: "completed";
  readonly FAILED: "failed";
};

export interface PluginMaterializeStepFrame {
  type: "plugin_materialize_step";
  plugin_id: string | null;
  plugin_slug: string | null;
  plugin_count: number | null;
  phase: string;
  status: "started" | "completed" | "failed";
  elapsed_ms: number | null;
  total_elapsed_ms: number | null;
  detail: Record<string, any> | null;
  ts: number;
}

export function createPluginMaterializeStepFrame(args: {
  pluginId?: string | null;
  pluginSlug?: string | null;
  pluginCount?: number | null;
  phase: string;
  status?: "started" | "completed" | "failed";
  elapsedMs?: number | null;
  totalElapsedMs?: number | null;
  detail?: Record<string, any> | null;
}): PluginMaterializeStepFrame;
