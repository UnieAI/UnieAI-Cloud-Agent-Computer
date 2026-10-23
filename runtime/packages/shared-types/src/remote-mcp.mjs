import { createError, textPreview } from "./index.mjs";
import { sanitizeFunctionName } from "./api-operations.mjs";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const JSON_RPC_VERSION = "2.0";
const REQUEST_TIMEOUT_MS = 15000;
const OAUTH_DISCOVERY_TIMEOUT_MS = 8000;
const OAUTH_TOKEN_TIMEOUT_MS = 10000;

function normalizeHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, headerValue]) => [String(key || "").trim(), String(headerValue || "").trim()])
      .filter(([key, headerValue]) => key && headerValue)
  );
}

function normalizeTimeoutSec(value) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.max(1, Math.min(Math.floor(parsed), 600));
}

// Upstream-compatible normalizeOAuth — keeps full metadata fields, expiresAt as ISO string
function normalizeOAuth(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const accessToken = String(value.accessToken || value.access_token || "").trim();
  const refreshToken = String(value.refreshToken || value.refresh_token || "").trim();
  const tokenType = String(value.tokenType || value.token_type || "Bearer").trim() || "Bearer";
  // Normalise expiresAt to Unix-ms number — may arrive as number or ISO string
  const expiresAtRaw = value.expiresAt;
  const expiresAt = typeof expiresAtRaw === "number" && expiresAtRaw > 0
    ? expiresAtRaw
    : typeof expiresAtRaw === "string" && expiresAtRaw
      ? (isNaN(Number(expiresAtRaw)) ? new Date(expiresAtRaw).getTime() || 0 : Number(expiresAtRaw))
      : 0;
  const scope = String(value.scope || "").trim();
  const clientId = String(value.clientId || value.client_id || "").trim();
  const clientSecret = String(value.clientSecret || value.client_secret || "").trim();
  const authorizationEndpoint = String(value.authorizationEndpoint || value.authorization_endpoint || "").trim();
  const tokenEndpoint = String(value.tokenEndpoint || value.token_endpoint || "").trim();
  const registrationEndpoint = String(value.registrationEndpoint || value.registration_endpoint || "").trim();
  const protectedResourceUrl = String(value.protectedResourceUrl || "").trim();
  const resource = String(value.resource || value.audience || "").trim();
  const authorizationServer = String(value.authorizationServer || "").trim();
  const authorizationServerMetadataUrl = String(value.authorizationServerMetadataUrl || "").trim();

  if (
    !accessToken &&
    !refreshToken &&
    !clientId &&
    !authorizationEndpoint &&
    !tokenEndpoint &&
    !authorizationServer
  ) {
    return null;
  }

  return {
    accessToken,
    refreshToken,
    tokenType,
    expiresAt,
    scope,
    clientId,
    clientSecret,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    protectedResourceUrl,
    resource,
    authorizationServer,
    authorizationServerMetadataUrl
  };
}

// --- Per-tool include/exclude filter (hermes parity) ---
// Normalize a `{ include?: string[], exclude?: string[] }` filter. Dedupes,
// drops empties, returns null when nothing usable. Applied at tool-list time
// in fetchRemoteMcpOperationsFromConfig (the only place with the live
// tools/list result). `include` wins over `exclude` when both are present.
function normalizeToolFilter(value) {
  const src = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!src) return null;
  const toList = (v) =>
    Array.isArray(v)
      ? Array.from(new Set(v.map((x) => String(x || "").trim()).filter(Boolean)))
      : [];
  const include = toList(src.include);
  const exclude = toList(src.exclude);
  if (include.length === 0 && exclude.length === 0) return null;
  return { include, exclude };
}

// Filter a raw tools/list array by a normalized tool filter. `include` (when
// non-empty) is an allow-list and wins; otherwise `exclude` is a deny-list.
function applyToolFilter(tools, toolFilter) {
  const list = Array.isArray(tools) ? tools : [];
  if (!toolFilter) return list;
  const nameOf = (t) => String(t?.name || "").trim();
  if (Array.isArray(toolFilter.include) && toolFilter.include.length > 0) {
    const allow = new Set(toolFilter.include);
    return list.filter((t) => allow.has(nameOf(t)));
  }
  if (Array.isArray(toolFilter.exclude) && toolFilter.exclude.length > 0) {
    const deny = new Set(toolFilter.exclude);
    return list.filter((t) => !deny.has(nameOf(t)));
  }
  return list;
}

// --- TLS options for self-hosted / enterprise BYO endpoints (hermes parity) ---
// Normalize into `{ rejectUnauthorized, cert?, key? }`. Accepts either the
// already-normalized `server.tls` shape (round-trips through operation.server
// on the execute path) or the wire fields `ssl_verify` / `client_cert` /
// `client_key`. Returns null when it matches the secure default (verify on,
// no mTLS) so nothing extra is threaded for ordinary public servers.
function normalizeTls(server) {
  const verifyRaw =
    server?.tls?.rejectUnauthorized ?? server?.ssl_verify ?? server?.sslVerify;
  const rejectUnauthorized = verifyRaw === false ? false : true;
  const cert = String(server?.tls?.cert ?? server?.client_cert ?? server?.clientCert ?? "").trim();
  const key = String(server?.tls?.key ?? server?.client_key ?? server?.clientKey ?? "").trim();
  if (rejectUnauthorized && !cert && !key) return null;
  return {
    rejectUnauthorized,
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {})
  };
}

// TRANSPORT-SUPPORT NOTE (custom TLS)
// -----------------------------------
// The remote MCP JSON-RPC calls below use the global `fetch` (undici). Per-
// connection TLS overrides — `rejectUnauthorized` (ssl_verify) and the mTLS
// client cert/key — are ONLY honoured by undici when the request carries a
// `dispatcher` (an undici `Agent` with `connect: {...}`). Node does not expose
// a public API to build one without the `undici` package, so we import it
// lazily and DEGRADE GRACEFULLY (default TLS + a one-time warning) when it is
// not resolvable in the host runtime — which is the case today (undici is not
// a dependency here). The normalized `tls` value is always threaded through so
// the moment `undici` becomes importable (or Node exposes a dispatcher) the
// options are consumed with no further plumbing. Dispatchers are cached by a
// stable key so we neither re-import nor leak per-request sockets.
// SECURITY: `ssl_verify:false` only weakens verification for that single
// user-configured server connection; it defaults to strict.
let _undiciAgentCtor; // undefined = not yet probed, function = Agent, null = unavailable
let _tlsUnsupportedWarned = false;
const _tlsDispatcherCache = new Map();

async function getUndiciAgentCtor() {
  if (_undiciAgentCtor !== undefined) return _undiciAgentCtor;
  try {
    const mod = await import("undici");
    _undiciAgentCtor = typeof mod?.Agent === "function" ? mod.Agent : null;
  } catch {
    _undiciAgentCtor = null;
  }
  return _undiciAgentCtor;
}

async function buildTlsDispatcher(tls) {
  if (!tls) return null;
  const cacheKey = JSON.stringify(tls);
  if (_tlsDispatcherCache.has(cacheKey)) return _tlsDispatcherCache.get(cacheKey);

  const Agent = await getUndiciAgentCtor();
  let dispatcher = null;
  if (!Agent) {
    if (!_tlsUnsupportedWarned) {
      _tlsUnsupportedWarned = true;
      try {
        console.warn(
          "[remote-mcp] custom TLS (ssl_verify / mTLS client cert) was requested for a BYO MCP server, but the `undici` dispatcher is not available in this runtime — falling back to default TLS. Install/expose `undici` to enable per-server TLS options."
        );
      } catch { /* noop */ }
    }
  } else {
    try {
      dispatcher = new Agent({
        connect: {
          rejectUnauthorized: tls.rejectUnauthorized !== false,
          ...(tls.cert ? { cert: tls.cert } : {}),
          ...(tls.key ? { key: tls.key } : {})
        }
      });
    } catch {
      // Incompatible undici instance or bad cert material — never let TLS
      // wiring break the actual request; fall back to default fetch.
      dispatcher = null;
    }
  }
  _tlsDispatcherCache.set(cacheKey, dispatcher);
  return dispatcher;
}

export function normalizeRemoteMcpServerConfig(server = {}, index = 0) {
  const oauth = normalizeOAuth(server.oauth);
  // OAuth tokens always take precedence — don't let a stale "none" authType block token use
  const authType = oauth?.accessToken
    ? "oauth"
    : String(server.authType || (server.bearerToken ? "bearer" : "none")).trim().toLowerCase();

  return {
    id: String(server.id || "").trim() || `cm_rmcp_server_${index + 1}`,
    name: String(server.name || "").trim() || `Remote MCP ${index + 1}`,
    url: String(server.url || server.baseUrl || "").trim().replace(/\/+$/, ""),
    bearerToken: String(server.bearerToken || server.apiKey || server.token || "").trim(),
    authType: ["oauth", "bearer", "none"].includes(authType) ? authType : "none",
    oauth,
    headers: normalizeHeaders(server.headers),
    isActive: server.isActive !== false,
    timeoutSec: normalizeTimeoutSec(server.timeoutSec),
    // Per-tool include/exclude filter (applied at list time). null = no filter.
    toolFilter: normalizeToolFilter(server.tools ?? server.toolFilter),
    // Custom TLS for BYO endpoints. null = default TLS. Threaded through
    // operation.server so the execute path re-derives it (see below).
    tls: normalizeTls(server)
  };
}

// --- OAuth discovery helpers (RFC 8414 + RFC 9470) ---

export async function discoverMcpOAuthMetadata(serverUrl) {
  const url = String(serverUrl || "").trim();
  if (!url) throw createError("invalid_request", "serverUrl is required", {}, 400);

  let origin;
  let parsedServerUrl;
  try {
    parsedServerUrl = new URL(url);
    origin = parsedServerUrl.origin;
  } catch {
    throw createError("invalid_request", "Invalid serverUrl", { url }, 400);
  }

  const makeSignal = () =>
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(OAUTH_DISCOVERY_TIMEOUT_MS)
      : undefined;

  // Step 0: RFC 9470 — probe the MCP server itself; extract resource_metadata URL
  // from WWW-Authenticate header (e.g. Notion returns this on 401)
  let authServerBase = origin;
  let protectedResourceUrl = "";
  let authorizationServerMetadataUrl = "";
  try {
    const probeResp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
      signal: makeSignal()
    });
    if (probeResp.status === 401) {
      const wwwAuth = String(probeResp.headers.get("www-authenticate") || "");
      // Parse resource_metadata="<url>" from WWW-Authenticate header
      const rmMatch = wwwAuth.match(/resource_metadata=["']?([^"',\s]+)["']?/i);
      if (rmMatch?.[1]) {
        protectedResourceUrl = rmMatch[1];
      }
    }
  } catch {
    // Probe optional — fall through
  }

  // Step 1: RFC 9470 — fetch Protected Resource Metadata
  // Try in order: (a) URL from step 0 WWW-Authenticate header, (b) path-appended form
  // {serverUrl}/.well-known/oauth-protected-resource per Notion docs, (c) origin-only form.
  const pathScopedProtectedResourceUrl = new URL(".well-known/oauth-protected-resource", `${url.replace(/\/+$/, "")}/`).toString();
  const originProtectedResourceUrl = `${origin}/.well-known/oauth-protected-resource`;
  const suffixProtectedResourceUrl = `${origin}/.well-known/oauth-protected-resource${parsedServerUrl.pathname === "/" ? "" : parsedServerUrl.pathname}`;

  const prCandidates = [];
  if (protectedResourceUrl) prCandidates.push(protectedResourceUrl);
  prCandidates.push(pathScopedProtectedResourceUrl);
  if (pathScopedProtectedResourceUrl !== originProtectedResourceUrl) {
    prCandidates.push(originProtectedResourceUrl);
  }
  if (suffixProtectedResourceUrl !== pathScopedProtectedResourceUrl && suffixProtectedResourceUrl !== originProtectedResourceUrl) {
    prCandidates.push(suffixProtectedResourceUrl);
  }

  for (const prUrl of prCandidates) {
    try {
      const prMeta = await fetch(prUrl, { signal: makeSignal() });
      if (prMeta.ok) {
        const prJson = await prMeta.json().catch(() => null);
        if (prJson) {
          protectedResourceUrl = prUrl;
          const authServers = Array.isArray(prJson.authorization_servers) ? prJson.authorization_servers : [];
          if (authServers.length > 0 && typeof authServers[0] === "string") {
            authServerBase = authServers[0].replace(/\/+$/, "");
          }
          break;
        }
      }
    } catch {
      // try next candidate
    }
  }

  // Step 2: RFC 8414 — Authorization Server Metadata
  const asMdUrl = `${authServerBase}/.well-known/oauth-authorization-server`;
  authorizationServerMetadataUrl = asMdUrl;
  const asMeta = await fetch(asMdUrl, { signal: makeSignal() });
  if (!asMeta.ok) {
    throw createError("oauth_discovery_failed", "Could not discover OAuth metadata from server", { authServerBase }, 502);
  }
  const asJson = await asMeta.json();
  return {
    authorization_endpoint: String(asJson.authorization_endpoint || "").trim(),
    token_endpoint: String(asJson.token_endpoint || "").trim(),
    registration_endpoint: String(asJson.registration_endpoint || "").trim() || null,
    scopes_supported: Array.isArray(asJson.scopes_supported) ? asJson.scopes_supported : [],
    authorizationServer: authServerBase,
    protectedResourceUrl,
    authorizationServerMetadataUrl
  };
}

// RFC 7591 — Dynamic Client Registration
export async function registerMcpOAuthClient(registrationEndpoint, redirectUri) {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(OAUTH_DISCOVERY_TIMEOUT_MS)
      : undefined;
  const resp = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: "UnieAI Studio",
      token_endpoint_auth_method: "none"
    }),
    signal
  });
  if (!resp.ok) {
    throw createError("oauth_registration_failed", "Dynamic client registration failed", { status: resp.status }, 502);
  }
  const json = await resp.json();
  return { clientId: String(json.client_id || "").trim() };
}

// Refresh an OAuth access token using the stored refresh_token
// expiresAt is ISO string (upstream convention)
export async function refreshMcpOAuthToken(server) {
  const oauth = server.oauth;
  if (!oauth?.refreshToken || !oauth?.tokenEndpoint) {
    throw createError("oauth_refresh_failed", "No refresh token or token endpoint available", {}, 400);
  }
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(OAUTH_TOKEN_TIMEOUT_MS)
      : undefined;
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: oauth.refreshToken,
    client_id: oauth.clientId || ""
  });
  if (oauth.clientSecret) params.set("client_secret", oauth.clientSecret);
  const resp = await fetch(oauth.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal
  });
  if (!resp.ok) {
    throw createError("oauth_refresh_failed", `Token refresh returned ${resp.status}`, { status: resp.status }, 502);
  }
  const json = await resp.json();
  const expiresIn = Number(json.expires_in || 3600);
  return {
    ...oauth,
    accessToken: String(json.access_token || "").trim(),
    // Always persist the new refresh_token — Notion rotates it on every refresh
    refreshToken: String(json.refresh_token || oauth.refreshToken || "").trim(),
    tokenType: String(json.token_type || oauth.tokenType || "Bearer").trim() || "Bearer",
    scope: String(json.scope || oauth.scope || "").trim(),
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0
  };
}

function createJsonRpcPayload(method, params = {}) {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: 1,
    method,
    params
  };
}

function parseSsePayload(rawText = "") {
  const blocks = String(rawText || "").split(/\n\n+/);
  for (const block of blocks) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    if (dataLines.length === 0) {
      continue;
    }
    const joined = dataLines.join("\n");
    try {
      return JSON.parse(joined);
    } catch {
      continue;
    }
  }
  return null;
}

function parseJsonRpcResponse(rawText = "") {
  const text = String(rawText || "").trim();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    const parsedSse = parseSsePayload(text);
    if (parsedSse) {
      return parsedSse;
    }
    throw createError("invalid_mcp_response", "Remote MCP server returned an unparseable response", {
      preview: textPreview(text, 500)
    }, 502);
  }
}

// Check if OAuth token is expiring within the next 5 minutes.
// expiresAt may be a Unix ms number or an ISO string — both are handled.
function isOAuthTokenExpiringSoon(oauth) {
  if (!oauth?.accessToken || !oauth?.expiresAt) return false;
  const expiresAtMs = typeof oauth.expiresAt === "number"
    ? oauth.expiresAt
    : new Date(oauth.expiresAt).getTime();
  return !isNaN(expiresAtMs) && expiresAtMs < Date.now() + 300000; // 5-minute buffer
}

function buildMcpHeaders(server, sessionId = "") {
  const resolvedOAuth = server.oauth;
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...normalizeHeaders(server.headers)
  };
  const oauthAccessToken = String(resolvedOAuth?.accessToken || "").trim();
  const authType = String(server?.authType || "").trim().toLowerCase();
  if (authType === "oauth" && oauthAccessToken) {
    headers.authorization = `${String(resolvedOAuth?.tokenType || "Bearer").trim() || "Bearer"} ${oauthAccessToken}`;
  } else if (authType !== "none" && server.bearerToken) {
    headers.authorization = `Bearer ${server.bearerToken}`;
  }
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }
  return headers;
}

async function callRemoteMcpMethod(server = {}, method, params = {}, sessionId = "") {
  let refreshedOAuth = null;
  let effectiveServer = server;

  // Custom TLS (ssl_verify / mTLS) for BYO enterprise endpoints. Resolves to
  // null (default TLS) when no TLS options are set OR when the undici
  // dispatcher isn't available in this runtime — see the transport-support
  // note above. Built once per call; reused across the 401-refresh retry.
  const dispatcher = await buildTlsDispatcher(server.tls);

  // Proactively refresh OAuth token if expiring within 5 minutes
  if (isOAuthTokenExpiringSoon(server.oauth)) {
    try {
      const newOAuth = await refreshMcpOAuthToken(server);
      refreshedOAuth = newOAuth;
      effectiveServer = { ...server, oauth: newOAuth };
    } catch {
      // Refresh failed — proceed with current token; will retry on 401 below
    }
  }

  async function makeRequest(srv) {
    const response = await fetch(srv.url, {
      method: "POST",
      headers: buildMcpHeaders(srv, sessionId),
      body: JSON.stringify(createJsonRpcPayload(method, params)),
      ...(dispatcher ? { dispatcher } : {}),
      signal:
        typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          : undefined
    });
    const rawText = await response.text();
    return { response, rawText };
  }

  let { response, rawText } = await makeRequest(effectiveServer);

  // On 401: token may have silently expired — attempt one refresh+retry.
  // Skip if we already refreshed proactively (to avoid infinite loops).
  if (response.status === 401 && effectiveServer.oauth?.refreshToken && !refreshedOAuth) {
    try {
      const newOAuth = await refreshMcpOAuthToken(effectiveServer);
      refreshedOAuth = newOAuth;
      effectiveServer = { ...effectiveServer, oauth: newOAuth };
      ({ response, rawText } = await makeRequest(effectiveServer));
    } catch {
      // Refresh failed — fall through, let the 401 error surface below
    }
  }

  const parsed = parseJsonRpcResponse(rawText);
  const nextSessionId = String(response.headers.get("mcp-session-id") || sessionId || "").trim();

  if (!response.ok) {
    throw createError("remote_mcp_http_error", `Remote MCP server responded with status ${response.status}`, {
      status: response.status,
      body: parsed,
      headers: {
        wwwAuthenticate: String(response.headers.get("www-authenticate") || "").trim(),
        contentType: String(response.headers.get("content-type") || "").trim()
      },
      authDebug: {
        authType: String(effectiveServer?.authType || "").trim().toLowerCase(),
        hasBearerToken: Boolean(effectiveServer.bearerToken),
        hasOauthToken: Boolean(effectiveServer.oauth?.accessToken),
        oauthTokenType: String(effectiveServer?.oauth?.tokenType || "").trim()
      }
    }, 502);
  }

  if (parsed?.error) {
    throw createError(
      "remote_mcp_rpc_error",
      String(parsed.error?.message || `Remote MCP method ${method} failed`),
      {
        code: parsed.error?.code,
        data: parsed.error?.data,
        method
      },
      502
    );
  }

  return {
    result: parsed?.result || {},
    sessionId: nextSessionId,
    refreshedOAuth
  };
}

async function initializeRemoteMcpServer(server = {}) {
  return callRemoteMcpMethod(
    server,
    "initialize",
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "unieai-studio",
        version: "0.1.0"
      }
    },
    ""
  );
}

export async function listRemoteMcpTools(server = {}) {
  const normalizedServer = normalizeRemoteMcpServerConfig(server);
  if (!normalizedServer.url) {
    throw createError("invalid_request", "Remote MCP server url is required", {}, 400);
  }

  const initialized = await initializeRemoteMcpServer(normalizedServer);
  // Carry refreshedOAuth from the first call if applicable
  const effectiveServer = initialized.refreshedOAuth
    ? { ...normalizedServer, oauth: initialized.refreshedOAuth }
    : normalizedServer;
  const listed = await callRemoteMcpMethod(effectiveServer, "tools/list", {}, initialized.sessionId);
  return {
    serverInfo: initialized.result?.serverInfo || null,
    capabilities: initialized.result?.capabilities || {},
    tools: Array.isArray(listed.result?.tools) ? listed.result.tools : [],
    refreshedOAuth: initialized.refreshedOAuth || listed.refreshedOAuth || null
  };
}

/**
 * List MCP resources from a remote server. Mirrors the cc-haha
 * `fetchResourcesForClient` surface, but stateless (no LRU cache — each
 * call goes through initialize → resources/list).
 *
 * Returns `{ resources, capabilities, refreshedOAuth }`. `resources` is
 * the raw MCP `resources/list` array (each entry has `uri`, `name`,
 * optional `mimeType`, `description`). The caller (tool wrapper) is
 * responsible for the `server` field annotation.
 *
 * Throws on server.url missing. Throws via callRemoteMcpMethod on
 * upstream non-200 / RPC error.
 */
export async function listRemoteMcpResources(server = {}) {
  const normalizedServer = normalizeRemoteMcpServerConfig(server);
  if (!normalizedServer.url) {
    throw createError("invalid_request", "Remote MCP server url is required", {}, 400);
  }
  const initialized = await initializeRemoteMcpServer(normalizedServer);
  const effectiveServer = initialized.refreshedOAuth
    ? { ...normalizedServer, oauth: initialized.refreshedOAuth }
    : normalizedServer;
  const capabilities = initialized.result?.capabilities || {};
  // Some servers expose tools but NOT resources — surface this so the
  // tool wrapper can give a useful "this server has no resources" message
  // instead of trying the request and getting a method-not-found error.
  if (!capabilities.resources) {
    return {
      resources: [],
      capabilities,
      serverSupportsResources: false,
      refreshedOAuth: initialized.refreshedOAuth || null
    };
  }
  const listed = await callRemoteMcpMethod(effectiveServer, "resources/list", {}, initialized.sessionId);
  return {
    resources: Array.isArray(listed.result?.resources) ? listed.result.resources : [],
    capabilities,
    serverSupportsResources: true,
    refreshedOAuth: initialized.refreshedOAuth || listed.refreshedOAuth || null
  };
}

/**
 * Read a single MCP resource by URI. Mirrors cc-haha's ReadMcpResourceTool
 * inner call. Returns `{ contents, refreshedOAuth }` where `contents` is
 * the raw MCP `resources/read` array (each entry has `uri`, `mimeType`,
 * optional `text` or `blob`). Binary blob persistence is the caller's
 * concern — SaaS callers route blobs through sandbox-runtime upload,
 * cc-haha CLI persisted to local mcpOutputStorage.
 *
 * Throws if server doesn't declare `capabilities.resources`.
 */
export async function readRemoteMcpResource(server = {}, uri) {
  const normalizedServer = normalizeRemoteMcpServerConfig(server);
  if (!normalizedServer.url) {
    throw createError("invalid_request", "Remote MCP server url is required", {}, 400);
  }
  if (typeof uri !== "string" || !uri.trim()) {
    throw createError("invalid_request", "Resource uri is required", {}, 400);
  }
  const initialized = await initializeRemoteMcpServer(normalizedServer);
  const effectiveServer = initialized.refreshedOAuth
    ? { ...normalizedServer, oauth: initialized.refreshedOAuth }
    : normalizedServer;
  if (!initialized.result?.capabilities?.resources) {
    throw createError(
      "remote_mcp_capability_missing",
      `Remote MCP server does not declare \`resources\` capability`,
      { server: normalizedServer.name || normalizedServer.id, uri },
      400
    );
  }
  const read = await callRemoteMcpMethod(
    effectiveServer,
    "resources/read",
    { uri },
    initialized.sessionId
  );
  return {
    contents: Array.isArray(read.result?.contents) ? read.result.contents : [],
    refreshedOAuth: initialized.refreshedOAuth || read.refreshedOAuth || null
  };
}

// onTokenRefreshed(serverId, newOAuth) — optional callback for persisting rotated tokens.
// Notion and similar servers rotate the refresh_token on every use; without persisting the
// new token immediately, the next call will have an invalidated refresh_token.
export async function fetchRemoteMcpOperationsFromConfig(servers = [], { onTokenRefreshed } = {}) {
  const operationLists = await Promise.all(
    (Array.isArray(servers) ? servers : []).map(async (server, index) => {
      const normalizedServer = normalizeRemoteMcpServerConfig(server, index);
      if (!normalizedServer.url || normalizedServer.isActive === false) {
        return [];
      }

      try {
        const listed = await listRemoteMcpTools(normalizedServer);

        // Persist rotated token immediately so subsequent calls in this request and
        // future requests both start with a valid refresh_token.
        const effectiveOAuth = listed.refreshedOAuth || normalizedServer.oauth;
        if (listed.refreshedOAuth && typeof onTokenRefreshed === "function") {
          onTokenRefreshed(normalizedServer.id, listed.refreshedOAuth).catch(() => {});
        }

        // Apply the admin-configured per-tool include/exclude filter before we
        // advertise this server's tools to the agent (hermes parity).
        const visibleTools = applyToolFilter(listed.tools, normalizedServer.toolFilter);

        return (Array.isArray(visibleTools) ? visibleTools : []).map((tool, toolIndex) => ({
          kind: "remote_mcp_tool",
          functionName: sanitizeFunctionName(`rmcp_${normalizedServer.id}_${tool.name}`, `rmcp_${normalizedServer.id}_${toolIndex + 1}`),
          displayName: String(tool?.name || "").trim() || `tool_${toolIndex + 1}`,
          description: String(tool?.description || "").trim() || String(tool?.title || "").trim() || `Remote MCP tool ${toolIndex + 1}`,
          parameters:
            tool?.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
              ? tool.inputSchema
              : {
                  type: "object",
                  properties: {},
                  additionalProperties: true
                },
          server: {
            id: normalizedServer.id,
            name: normalizedServer.name,
            url: normalizedServer.url,
            bearerToken: normalizedServer.bearerToken,
            authType: normalizedServer.authType,
            oauth: effectiveOAuth,  // use fresh token so executeRemoteMcpOperation doesn't hit a rotated-away refresh_token
            headers: normalizedServer.headers,
            timeoutSec: normalizedServer.timeoutSec,
            tls: normalizedServer.tls  // round-trip custom TLS to the execute path
          },
          remoteToolName: String(tool?.name || "").trim(),
          annotations: tool?.annotations || {}
        }));
      } catch {
        return [];
      }
    })
  );

  const seen = new Set();
  return operationLists.flat().filter((operation) => {
    const key = String(operation?.functionName || "").trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function executeRemoteMcpOperation(operation = {}, args = {}, { onTokenRefreshed } = {}) {
  const server = normalizeRemoteMcpServerConfig(operation?.server || {});
  const remoteToolName = String(operation?.remoteToolName || operation?.displayName || "").trim();
  if (!server.url || !remoteToolName) {
    throw createError("invalid_request", "Remote MCP operation is missing server or tool metadata", {}, 400);
  }

  const initialized = await initializeRemoteMcpServer(server);
  // Use the refreshed token from initialize (Notion rotates tokens) so tools/call doesn't fail
  const effectiveServer = initialized.refreshedOAuth
    ? { ...server, oauth: initialized.refreshedOAuth }
    : server;
  const executed = await callRemoteMcpMethod(
    effectiveServer,
    "tools/call",
    {
      name: remoteToolName,
      arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {}
    },
    initialized.sessionId
  );

  // Persist whichever refresh occurred (initialize or tools/call step)
  const latestRefreshed = executed.refreshedOAuth || initialized.refreshedOAuth || null;
  if (latestRefreshed && typeof onTokenRefreshed === "function") {
    onTokenRefreshed(server.id, latestRefreshed).catch(() => {});
  }

  const content = Array.isArray(executed.result?.content) ? executed.result.content : [];
  const preview = content
    .map((item) => {
      if (typeof item?.text === "string") {
        return item.text;
      }
      return JSON.stringify(item);
    })
    .filter(Boolean)
    .join("\n");

  return {
    result: executed.result,
    preview: textPreview(preview || JSON.stringify(executed.result || {}), 6000)
  };
}
