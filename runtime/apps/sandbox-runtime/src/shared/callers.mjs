/**
 * shared/callers.mjs — one key per caller, one namespace per key (CAC P1).
 *
 * Before this, every caller presented the same SANDBOX_INTERNAL_TOKEN, so the
 * runtime could not tell copilot-v2 from Studio: two products that both have a
 * user called `u1` would share that user's sandbox, workspace and quota.
 *
 * A namespaced caller is configured in `CAC_CALLERS` (JSON) or `CAC_CALLERS_FILE`:
 *
 *   [{ "id": "studio", "namespace": "studio", "key_sha256": "<hex sha256 of the key>" }]
 *
 * Only the hash is configured, so the file can sit beside other config without
 * holding a usable secret.
 *
 * ## How the namespace is applied: at the door, on identity
 *
 * Every identity a namespaced caller presents (path `:userId` / `:sessionId`,
 * `x-sandbox-user-id`, `x-workspace-owner`, and the identity fields of a JSON
 * body) is rewritten to `<namespace>--<id>` BEFORE any route runs. Everything
 * downstream (pool slots, S3 prefixes `users/<id>/…`, quotas, ownership checks)
 * then sees distinct ids and needs no change. Responses are rewritten back, so
 * a caller never sees its own prefix.
 *
 * The legacy shared token keeps the empty namespace: copilot-v2's existing ids
 * and S3 prefixes are untouched. Because those ids are raw, a legacy caller is
 * refused any id that starts with a configured `<namespace>--`: otherwise it
 * could name `studio--u1` and walk into Studio's tenant.
 *
 * A sandbox belongs to the caller whose namespace its userId carries.
 * Namespaced callers must therefore allocate with a `user_id`: an anonymous
 * sandbox could not be traced back to a caller.
 */
import crypto from "node:crypto";
import fs from "node:fs";

import { SandboxError } from "./error.mjs";

export const NS_SEP = "--";
const NAMESPACE_RE = /^[a-z][a-z0-9]{1,31}$/;
const CALLER_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Routes a namespaced caller may use. Everything else (metrics, pool policy,
 * global quota limits, the all-tenant event stream, SSH probes, the Rabi Local
 * relay) is operator-only, so it stays behind the legacy token.
 */
const NAMESPACED_ROUTES = [
  /^\/healthz\/?$/,
  /^\/v1\/sandboxes\/?$/,
  /^\/v1\/sandboxes\/(?!stream(?:\/|$))[^/]+(?:\/.*)?$/,
  /^\/v1\/sessions\/[^/]+\/sandbox\/?$/,
  /^\/v1\/users\/[^/]+\/(?:sandbox|workspace)(?:\/.*)?$/,
];

/** JSON body fields that carry identity and get namespaced. */
const BODY_ID_FIELDS = ["user_id", "session_id", "end_user_id"];
/** JSON body fields a namespaced caller may not set: host paths and machine routing are operator decisions. */
const BODY_PRIVILEGED_FIELDS = ["workspace_mount_path", "machine"];
/** Response fields that carry identity and get the prefix stripped. */
const RESPONSE_ID_FIELDS = new Set(["user_id", "session_id", "end_user_id", "userId", "sessionId", "endUserId", "workspace_owner", "workspaceOwner", "owner"]);

let cached = null;

/** Parse and validate the caller registry. Throws on a malformed entry: a typo must not boot as "no callers". */
export function parseCallers(raw) {
  if (raw == null || String(raw).trim() === "") return [];
  let list;
  try {
    list = JSON.parse(String(raw));
  } catch (err) {
    throw new Error(`CAC_CALLERS is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(list)) throw new Error("CAC_CALLERS must be a JSON array");
  const ids = new Set();
  const namespaces = new Set();
  const hashes = new Set();
  return list.map((c, i) => {
    const id = String(c?.id ?? "");
    const namespace = String(c?.namespace ?? "");
    const keySha256 = String(c?.key_sha256 ?? "").toLowerCase();
    if (!CALLER_ID_RE.test(id)) throw new Error(`CAC_CALLERS[${i}].id "${id}" must match ${CALLER_ID_RE}`);
    if (!NAMESPACE_RE.test(namespace)) throw new Error(`CAC_CALLERS[${i}].namespace "${namespace}" must match ${NAMESPACE_RE}`);
    if (!SHA256_HEX_RE.test(keySha256)) throw new Error(`CAC_CALLERS[${i}].key_sha256 must be 64 hex characters (sha256 of the key)`);
    if (ids.has(id)) throw new Error(`CAC_CALLERS: duplicate id "${id}"`);
    if (namespaces.has(namespace)) throw new Error(`CAC_CALLERS: duplicate namespace "${namespace}"`);
    if (hashes.has(keySha256)) throw new Error(`CAC_CALLERS: two callers share one key`);
    ids.add(id); namespaces.add(namespace); hashes.add(keySha256);
    return Object.freeze({ id, namespace, keySha256 });
  });
}

/** The configured callers (cached; `env` is for tests). */
export function loadCallers(env = process.env) {
  if (env === process.env && cached) return cached;
  let raw = env.CAC_CALLERS;
  if ((raw == null || raw === "") && env.CAC_CALLERS_FILE) raw = fs.readFileSync(env.CAC_CALLERS_FILE, "utf8");
  const callers = parseCallers(raw);
  if (env === process.env) cached = callers;
  return callers;
}

export function _resetCallersForTests() { cached = null; }

export function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

/** The namespaced caller this bearer belongs to, or null. Compares hashes in constant time. */
export function callerForToken(token, callers = loadCallers()) {
  if (!token || !callers.length) return null;
  const supplied = Buffer.from(sha256Hex(token), "hex");
  let found = null;
  for (const c of callers) {
    if (crypto.timingSafeEqual(supplied, Buffer.from(c.keySha256, "hex"))) found = c;
  }
  return found;
}

/** `studio` + `u1` → `studio--u1`. */
export function nsId(caller, id) {
  if (id == null || id === "") return id;
  return `${caller.namespace}${NS_SEP}${String(id)}`;
}

/** The inverse of nsId for this caller; anything not carrying its prefix comes back unchanged. */
export function stripNsId(caller, id) {
  if (typeof id !== "string") return id;
  const p = `${caller.namespace}${NS_SEP}`;
  if (id.startsWith(p)) return id.slice(p.length);
  const colon = id.indexOf(":");
  if (colon !== -1 && id.slice(colon + 1).startsWith(p)) return `${id.slice(0, colon + 1)}${id.slice(colon + 1 + p.length)}`;
  return id;
}

/** `group:g1` → `group:studio--g1`; a bare (personal) owner is a user id. */
export function nsOwner(caller, owner) {
  if (typeof owner !== "string" || !owner) return owner;
  const colon = owner.indexOf(":");
  if (colon === -1) return nsId(caller, owner);
  return `${owner.slice(0, colon + 1)}${nsId(caller, owner.slice(colon + 1))}`;
}

/** Which configured namespace an id lives in ("" = the legacy, un-namespaced tenant space). */
export function namespaceOfId(id, callers = loadCallers()) {
  if (typeof id !== "string" || !id) return "";
  const colon = id.indexOf(":");
  const bare = colon === -1 ? id : id.slice(colon + 1);
  for (const c of callers) if (bare.startsWith(`${c.namespace}${NS_SEP}`)) return c.namespace;
  return "";
}

export function isNamespacedRoute(pathname) {
  return NAMESPACED_ROUTES.some((re) => re.test(pathname));
}

function forbidden(reason, message) {
  return new SandboxError("forbidden", message, 403, { reason });
}

function header1(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Rewrite one request's identity for a namespaced caller, in place.
 * Also drops headers only the trusted app may send (signed identity, admin):
 * an app-signed identity carries a raw user id, so honouring it here would let
 * a namespaced caller step outside its namespace.
 */
export function namespaceRequest(req, params, caller) {
  for (const k of ["userId", "sessionId"]) if (params[k]) params[k] = nsId(caller, params[k]);
  const uid = header1(req, "x-sandbox-user-id");
  if (typeof uid === "string" && uid.trim()) req.headers["x-sandbox-user-id"] = nsId(caller, uid.trim());
  const owner = header1(req, "x-workspace-owner");
  if (typeof owner === "string" && owner) req.headers["x-workspace-owner"] = nsOwner(caller, owner);
  delete req.headers["x-sandbox-user-jwt"];
  delete req.headers["x-sandbox-admin"];
}

/** Rewrite a parsed JSON body for a namespaced caller; refuses privileged fields. */
export function namespaceBody(body, caller) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  for (const f of BODY_PRIVILEGED_FIELDS) {
    if (body[f] != null) throw forbidden("caller_field_forbidden", `${f} is operator-only and cannot be set by caller ${caller.id}`);
  }
  const out = { ...body };
  for (const f of BODY_ID_FIELDS) if (typeof out[f] === "string" && out[f]) out[f] = nsId(caller, out[f]);
  if (typeof out.workspace_owner === "string" && out.workspace_owner) out.workspace_owner = nsOwner(caller, out.workspace_owner);
  return out;
}

/**
 * Legacy (shared-token) requests may not name an id inside a configured
 * namespace. Checks path params, identity headers and, when given, a body.
 */
export function assertLegacyIdentity({ req, params, body }, callers = loadCallers()) {
  if (!callers.length) return;
  const values = [params?.userId, params?.sessionId, header1(req, "x-sandbox-user-id"), header1(req, "x-workspace-owner")];
  if (body && typeof body === "object") values.push(...BODY_ID_FIELDS.map((f) => body[f]), body.workspace_owner);
  for (const v of values) {
    if (namespaceOfId(typeof v === "string" ? v : "", callers)) {
      throw forbidden("namespaced_id_from_legacy_caller", `id "${v}" belongs to a caller namespace and cannot be used with the shared token`);
    }
  }
}

/** May this caller see this sandbox entry? Legacy sees only un-namespaced ones. */
export function callerOwnsEntry(caller, entry, callers = loadCallers()) {
  const ns = namespaceOfId(entry?.userId || entry?.sessionId || "", callers);
  return ns === (caller ? caller.namespace : "");
}

/** Strip the caller's prefix from identity fields anywhere in a response body. */
export function stripResponse(body, caller) {
  if (Array.isArray(body)) return body.map((v) => stripResponse(v, caller));
  if (!body || typeof body !== "object") return body;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    out[k] = RESPONSE_ID_FIELDS.has(k) && typeof v === "string" ? stripNsId(caller, v) : stripResponse(v, caller);
  }
  return out;
}
