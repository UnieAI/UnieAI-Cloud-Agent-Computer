/**
 * agentPermission.mjs — Shared protocol surface for per-call agent permission.
 *
 * Lives in shared-types so the runtime (apps/llm-runtime), Next.js API proxy
 * (apps/studio-web/app/api), and the chat UI (apps/studio-web/app/_components)
 * all reference the same constants + helpers. Published as part of M0 so M1
 * tracks (runtime broker, frontend modal, hook runner) can parallelise
 * against a single source of truth.
 *
 * See plan: /Users/royshih/.claude/plans/plan-polished-fog.md
 *           § "Permission protocol shape"
 */

// Note: this module is bundled into the client (permission-modal.tsx etc.),
// so it MUST NOT import node-only modules. Server-only helpers that need
// node:crypto (hashToolArgs, newPermissionRequestId) live in
// ./agentPermissionServer.mjs.

// ── agent_metadata.type values used by this protocol ──────────────────
export const PERMISSION_REQUEST_TYPE = "permission_request";
export const PERMISSION_RESOLVED_TYPE = "permission_resolved";
export const PERMISSION_TIMEOUT_TYPE = "permission_timeout";

// ── permission protocol modes ─────────────────────────────────────────
// inline       — current behaviour: stream stays open, request rides as
//                agent_metadata + optional inline text, client POSTs the
//                answer to /v1/sessions/:id/permission/:request_id.
// tool_calls   — stream ends with finish_reason="tool_calls" carrying a
//                synthetic `agent_request_permission` function call. The
//                caller (OpenAI SDK / langchain / any tool-aware client)
//                answers in the next chat-completions turn via a standard
//                role:"tool" message. No side channel required.
export const PERMISSION_PROTOCOLS = Object.freeze({
  INLINE: "inline",
  TOOL_CALLS: "tool_calls"
});

/**
 * The function name used for the synthetic permission tool_call in
 * tool_calls mode. The runtime never registers this as a real tool;
 * it's only emitted as a finish_reason="tool_calls" envelope. Callers
 * implement a stub handler that returns {"answer":"allow"|"deny"}.
 */
export const AGENT_REQUEST_PERMISSION_TOOL_NAME = "agent_request_permission";

// ── plugin materialisation progress (M2 streaming UX) ─────────────────
// One frame per phase transition so the chat UI can render a real-time
// "loading plugin X (mcp_handshake, 1.2s)" status without polling.
export const PLUGIN_MATERIALIZE_STEP_TYPE = "plugin_materialize_step";

export const PLUGIN_MATERIALIZE_PHASE = Object.freeze({
  PLAN: "plan",                       // emitted once per session before any plugin work
  FETCH_BUNDLE: "fetch_bundle",       // S3 list + per-file GET
  VERIFY_SIGNATURE: "verify_signature",
  LOAD_MANIFEST: "load_manifest",     // parse + compat + structural validation
  WRITE_SANDBOX: "write_sandbox",     // cube.writeFile per bundle file
  SPAWN_MCP: "spawn_mcp",             // sandbox spawnLongLivedProcess per server
  MCP_HANDSHAKE: "mcp_handshake",     // initialize + tools/list per server
  READY: "ready",                     // plugin fully wired
  DEGRADED: "degraded",               // plugin failed; session continues without it
  SESSION_READY: "session_ready"      // all plugins processed; chat loop can start
});

export const PLUGIN_MATERIALIZE_STATUS = Object.freeze({
  STARTED: "started",
  COMPLETED: "completed",
  FAILED: "failed"
});

/**
 * Build a plugin_materialize_step frame. UI can pattern-match on `phase` to
 * render a friendly label and on `status` to flip checkmark / spinner / ✗.
 * `elapsed_ms` is per-phase; `total_elapsed_ms` is from session-materialize
 * start so a tally bar can advance monotonically across phases.
 *
 * `detail` carries phase-specific fields:
 *   spawn_mcp / mcp_handshake → { server_name, tool_count? }
 *   fetch_bundle             → { file_count, size_bytes }
 *   degraded                 → { reason }
 */
export function createPluginMaterializeStepFrame({
  pluginId = null,
  pluginSlug = null,
  pluginCount = null,
  phase,
  status,
  elapsedMs = null,
  totalElapsedMs = null,
  detail = null
} = {}) {
  if (!phase) throw new Error("createPluginMaterializeStepFrame: phase required");
  return {
    type: PLUGIN_MATERIALIZE_STEP_TYPE,
    plugin_id: pluginId,
    plugin_slug: pluginSlug,
    plugin_count: pluginCount,
    phase,
    status: status || PLUGIN_MATERIALIZE_STATUS.COMPLETED,
    elapsed_ms: typeof elapsedMs === "number" ? Math.round(elapsedMs) : null,
    total_elapsed_ms: typeof totalElapsedMs === "number" ? Math.round(totalElapsedMs) : null,
    detail: detail && typeof detail === "object" ? detail : null,
    ts: Date.now()
  };
}

// ── Risk tier (drives modal urgency + whether "always allow" is offered) ──
export const RISK_TIER = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high"
});

// ── Tool category (broad bucket used for icon + filter in UI) ─────────
export const TOOL_CATEGORY = Object.freeze({
  SANDBOX: "sandbox",       // bash, python, file_write, file_edit, file_read, glob, grep
  WEB: "web",               // web_fetch, web_search
  MCP: "mcp",               // any mcp__* tool
  SKILL: "skill",           // any skill__* tool
  KB: "kb",                 // kb_search
  TASK: "task",             // task_*, todo_write
  SUBAGENT: "subagent",     // agent_create
  OTHER: "other"
});

// ── Permission answer values ──────────────────────────────────────────
export const PERMISSION_ANSWER = Object.freeze({
  ALLOW: "allow",
  DENY: "deny",
  TIMEOUT: "timeout",
  CANCELLED: "cancelled"
});

// ── Permission decision provenance ────────────────────────────────────
export const DECIDED_BY = Object.freeze({
  USER: "user",
  SYSTEM_TIMEOUT: "system_timeout",
  SYSTEM_CANCEL: "system_cancel",
  POLICY_AUTO_ALLOW: "policy_auto_allow",
  POLICY_AUTO_DENY: "policy_auto_deny",
  PATTERN_MATCH: "pattern_match"
});

// ── "Always allow" pattern scope ──────────────────────────────────────
export const ALLOW_PATTERN_SCOPE = Object.freeze({
  SESSION: "session",
  USER_CUSTOM_MODEL: "user_custom_model",
  USER_GLOBAL: "user_global"
});

// ── Defaults ──────────────────────────────────────────────────────────
export const PERMISSION_DEFAULT_TIMEOUT_MS = 60_000;        // emit → wait 60s → timeout
export const PERMISSION_STATE_TTL_SECONDS = 300;            // Redis sidecar STRING TTL
export const PERMISSION_INPUT_PREVIEW_MAX_BYTES = 2048;     // truncateJson cap

// ── Redis namespace helpers ───────────────────────────────────────────
// Channel where decision messages are PUBLISHED. One per session.
export function permissionPubsubChannel(sessionId) {
  if (!sessionId) throw new Error("sessionId required");
  return `agent:perm:${sessionId}`;
}

// Sidecar STRING with the pending/decided state. TTL = PERMISSION_STATE_TTL_SECONDS.
// Required because a fast HTTP POST may race the runtime's SUBSCRIBE call —
// after the runtime subscribes, it does GET on this key to catch any answer
// that was published before the subscription was ready.
export function permissionStateKey(sessionId, requestId) {
  if (!sessionId || !requestId) throw new Error("sessionId and requestId required");
  return `agent:perm:state:${sessionId}:${requestId}`;
}

// SET of curated "always allow" patterns for the session. Each member is a
// JSON string serialised allow pattern descriptor (see makeAllowPattern).
export function permissionAllowlistKey(sessionId) {
  if (!sessionId) throw new Error("sessionId required");
  return `agent:perm:allow:${sessionId}`;
}

// ── Frame constructors ────────────────────────────────────────────────

/**
 * Build a `permission_request` agent_metadata payload that emitter passes
 * through to the SSE consumer. The frame envelope (id, object, choices, etc.)
 * is added by apps/llm-runtime/src/agent/sse/format.mjs — this helper only
 * builds the `agent_metadata` body.
 */
export function createPermissionRequestFrame({
  requestId,
  toolUseId,
  toolName,
  toolCategory,
  riskTier,
  inputPreview,
  inputFullAvailable = false,
  parentMessageId = null,
  expiresAt,
  alwaysAllowSupported = true
} = {}) {
  if (!requestId) throw new Error("requestId required");
  if (!toolUseId) throw new Error("toolUseId required");
  if (!toolName) throw new Error("toolName required");
  return {
    type: PERMISSION_REQUEST_TYPE,
    request_id: String(requestId),
    tool_use_id: String(toolUseId),
    tool_name: String(toolName),
    tool_category: toolCategory || TOOL_CATEGORY.OTHER,
    risk_tier: riskTier || RISK_TIER.MEDIUM,
    input_preview: typeof inputPreview === "string" ? inputPreview : "",
    input_full_available: Boolean(inputFullAvailable),
    parent_message_id: parentMessageId,
    expires_at:
      typeof expiresAt === "number"
        ? expiresAt
        : Date.now() + PERMISSION_DEFAULT_TIMEOUT_MS,
    always_allow_supported: Boolean(alwaysAllowSupported)
  };
}

/**
 * Build a `permission_resolved` frame — emitted after a decision is reached
 * so the frontend can dismiss the modal even if the user has multiple tabs
 * open or the modal was rendered by SSE replay.
 */
export function createPermissionResolvedFrame({ requestId, answer, decidedBy, winner } = {}) {
  if (!requestId) throw new Error("requestId required");
  const frame = {
    type: PERMISSION_RESOLVED_TYPE,
    request_id: String(requestId),
    answer: answer || PERMISSION_ANSWER.DENY,
    decided_by: decidedBy || DECIDED_BY.USER,
    decided_at: Date.now()
  };
  // `winner` is the broker-side instrumentation label for which race
  // path delivered the answer (pubsub / timeout / cancel / raced_get /
  // auto_allow / pattern_match). Optional — back-compat: pre-Phase-4
  // emitters omit it and the field stays absent. Frontend debug tools
  // can surface it; prod UI ignores.
  if (winner) frame.winner = String(winner);
  return frame;
}

/**
 * Build a `permission_timeout` frame — drop-in for when the broker's
 * setTimeout fires before any decision arrives.
 */
export function createPermissionTimeoutFrame({ requestId } = {}) {
  if (!requestId) throw new Error("requestId required");
  return {
    type: PERMISSION_TIMEOUT_TYPE,
    request_id: String(requestId),
    decided_at: Date.now()
  };
}

/**
 * Curated allow pattern descriptor. The frontend never sends free-form regex;
 * it picks from a server-defined preset list (e.g. "git_commands",
 * "npm_install_commands"). Future versions may add arg-match maps for power
 * users via admin UI.
 */
export function makeAllowPattern({
  toolName,
  preset = "all",
  scope = ALLOW_PATTERN_SCOPE.SESSION
} = {}) {
  if (!toolName) throw new Error("toolName required");
  return { tool_name: String(toolName), preset: String(preset), scope: String(scope) };
}

// ── Validators ────────────────────────────────────────────────────────

const VALID_ANSWERS = new Set(Object.values(PERMISSION_ANSWER));
const VALID_SCOPES = new Set(Object.values(ALLOW_PATTERN_SCOPE));

/**
 * Validate the POST body sent by frontend to /v1/sessions/:id/permission/:request_id.
 * Returns `{ valid: true, value }` or `{ valid: false, error }` — never throws.
 */
export function validatePermissionAnswer(body) {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "body must be an object" };
  }
  const answer = body.answer;
  if (!VALID_ANSWERS.has(answer)) {
    return { valid: false, error: `invalid answer: ${answer}` };
  }
  const patterns = Array.isArray(body.patterns) ? body.patterns : [];
  for (const p of patterns) {
    if (!p || typeof p !== "object") {
      return { valid: false, error: "pattern must be an object" };
    }
    if (typeof p.tool_name !== "string" || !p.tool_name) {
      return { valid: false, error: "pattern.tool_name required" };
    }
    if (typeof p.preset !== "string" || !p.preset) {
      return { valid: false, error: "pattern.preset required" };
    }
    if (!VALID_SCOPES.has(p.scope || ALLOW_PATTERN_SCOPE.SESSION)) {
      return { valid: false, error: `invalid pattern.scope: ${p.scope}` };
    }
  }
  return { valid: true, value: { answer, patterns } };
}

// ── Curated pattern presets ───────────────────────────────────────────
// Server-side mapping from preset name → matcher fn(args) → boolean.
// Loaded by the runtime's permissionPolicy.mjs; frontend just shows the
// labels.
export const ALLOW_PATTERN_PRESETS = Object.freeze({
  // Keys match the actual tool names registered by tools/registry.mjs
  // (snake_case). The legacy TitleCase variants stay aliased below for
  // operators who may have stored historical allow patterns in Redis under
  // those names.
  bash: {
    git_commands: {
      label: "Allow all git commands",
      description: "bash invocations whose command starts with `git `"
    },
    npm_install: {
      label: "Allow npm install",
      description: "bash invocations matching `npm install ...`"
    },
    all: {
      label: "Allow all bash",
      description: "All bash tool calls (use with caution)"
    }
  },
  web_fetch: {
    same_origin: {
      label: "Allow web_fetch within same origin",
      description: "URLs matching the origin of the URL just approved"
    },
    all: {
      label: "Allow all web_fetch",
      description: "All web fetches (use with caution)"
    }
  }
  // Extend as new tools learn presets. Tools without a preset entry can still
  // emit permission requests but won't surface "always allow" in M1.
});

// ── Utility ───────────────────────────────────────────────────────────

/**
 * Truncate a JSON arg blob for the `input_preview` field of the frame.
 * Matches StreamingToolExecutor's truncateJson(args, 2048) behavior.
 *
 * Uses TextEncoder (universal, available in Node + browser) so this module
 * stays client-bundleable. Server-only helpers (hashToolArgs,
 * newPermissionRequestId) live in ./agentPermissionServer.mjs.
 */
export function truncateForPreview(args, maxBytes = PERMISSION_INPUT_PREVIEW_MAX_BYTES) {
  let serialised;
  try {
    serialised = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    serialised = String(args ?? "");
  }
  const byteLength = new TextEncoder().encode(serialised).byteLength;
  if (byteLength <= maxBytes) return serialised;
  return serialised.slice(0, maxBytes) + "…[truncated]";
}
