/**
 * workspace/userStore.mjs — Per-user workspace S3 layout.
 *
 * S3 key layout for user-scoped sandbox workspaces (B27):
 *   users/<userId>/workspace/…                           — THE USER'S FILES.
 *       This prefix (and ONLY this prefix) is weed-mounted at /workspace inside
 *       the sandbox, so anything stored here is visible to `ls /workspace`.
 *   users/<userId>/.platform/manifest.json               — file tree + status
 *   users/<userId>/.platform/agent/skills|memories|…     — the agent's own library
 *   users/<userId>/.snapshots/                           — durable git snapshots
 *   users/<userId>/workspace/blobs/<sha-prefix>/<sha>    — content-addressed bytes
 *                                                          (DEAD; see below)
 *
 * PLATFORM STATE LIVES OUTSIDE THE MOUNT. The manifest index and the agent's
 * skill/memory library used to sit INSIDE the workspace as `.manifest.json` and
 * `.opencode/`. That leaked into the sandbox: the model ran `ls -la /workspace`,
 * saw two things it had never created, and reported them to the user as their
 * files — and could read or clobber the panel's index. They now live under the
 * owner's `.platform` SIBLING of `workspace/`, which is never mounted (the same
 * trick `.snapshots` already used). Callers are unchanged: they keep addressing
 * the library by its historical workspace-relative spelling (`.opencode/…`) and
 * `fileKey` maps it to the platform prefix. See `platformRelOf`.
 *
 * STILL IN THE MOUNT, KNOWINGLY:
 *   · `blobs/` — the pre-flat-tree content-addressed store. `writeBlob` has had
 *     no caller since the flat-tree refactor, so nothing NEW lands there, but an
 *     old account can still carry leftovers, and those ARE visible to
 *     `ls /workspace`. Moving or deleting them is a separate decision (they are
 *     the user's bytes and nothing reads them any more) — deliberately not part
 *     of the platform-prefix move.
 *   · `.unieai/` — env capture/restore, WRITTEN FROM INSIDE the sandbox. It has
 *     to stay reachable at /workspace/.unieai; redirecting it would break the
 *     capture.
 *
 * Blobs were content-addressed so re-uploading the same bytes was a free no-op
 * and two files sharing content cost one blob. Reads went through the manifest,
 * which mapped relPath → sha256.
 *
 * Manifest shape:
 *   {
 *     "version": 1,
 *     "userId": "<id>",
 *     "updatedAt": "ISO timestamp",
 *     "entries": {
 *       "<relPath>": { "size": <n>, "sha256": "<hex>", "mtimeMs": <n> }
 *     }
 *   }
 *
 * The manifest is small JSON; we read/write it in full each sync. Concurrency
 * is controlled by the per-user singleton sandbox policy in pool/manager.mjs,
 * so we never have two writers racing on the same prefix.
 */

import crypto from "node:crypto";
import { PreconditionFailedError, putObject, getObject, headObject, deleteObject, listObjectsByPrefix, listLevel, isPreconditionFailed, objectLocation } from "../../../../packages/storage-engine/src/index.mjs";

import { tenantRoot, tenantObjectLocation, tenantWorkspaceLocation } from "./tenant-store.mjs";
import { log } from "../shared/log.mjs";

const MANIFEST_VERSION = 1;

/*
 * WHERE A WORKSPACE OWNER'S BYTES LIVE. The owner is either:
 *   · a bare userId (legacy / personal)          → users/<id>/workspace
 *   · "user:<id>"  (explicit personal)           → users/<id>/workspace
 *   · "group:<gid>" (enterprise shared project)  → groups/<gid>/workspace
 *
 * The colon form is ONLY ever produced by the trusted app (x-workspace-owner,
 * validated server-side); a bare path-userId (a UUID, no colon) keeps the exact
 * legacy layout, so the personal path is byte-for-byte unchanged.
 *
 * There used to be a private `userPrefix(owner)` here returning that string.
 * It is gone, not renamed: every caller below now needs the BUCKET as well as
 * the prefix, and a helper that hands back only the prefix is precisely the
 * shape that let two isolated tenants address the same key. `tenant-store.mjs`
 * is the one answer to "where does this tenant's data live", and it answers in
 * locations — asserted against literal strings in tenant-store.test.mjs rather
 * than against a re-derivation, because a resolver agreeing with the function
 * it replaced by construction proves nothing about the paths already on disk.
 */

/**
 * The owner's tier: "group" (專案) | "org" (企業) | "user" (personal). Both
 * "group" and "org" are SHARED spaces; only "user" is personal (used to decide
 * whether per-user memory reverse-sync should fire).
 */
export function ownerKind(owner) {
  const s = String(owner || "");
  if (s.startsWith("group:")) return "group";
  if (s.startsWith("org:")) return "org";
  return "user";
}

// ---------------------------------------------------------------------------
// KEYS vs LOCATIONS, and the PLATFORM PREFIX. Two changes that landed on the
// same functions from opposite directions; both are load-bearing.
//
// KEYS vs LOCATIONS. The `*Key` functions stay: a bare key is still the right
// value for the `s3_key` field the app records and for log lines. What changed
// is that NO store call takes one. Every read/write below goes through the
// matching `*Location`, which carries the tenant's BUCKET alongside the key —
// because for an isolated tenant the prefix collapses to `workspace`, and two
// isolated tenants handing the store bare keys hand it the SAME key.
//
// PLATFORM PREFIX — where the platform keeps ITS OWN state. `userPrefix(owner)`
// is `<root>/workspace`, and THAT is what the sandbox weed-mounts at
// /workspace. Its parent — `<root>` — is not mounted, so a key under
// `<root>/.platform/` is durable, addressable by the app, and completely
// invisible from inside the sandbox. `.snapshots` already used this shape.
//
// The two meet here: `.platform` is a SIBLING of `workspace/`, so it cannot be
// addressed with `tenantWorkspaceLocation`. It is still the tenant's data and
// still lives in the tenant's bucket, which is exactly what
// `tenantObjectLocation` is for — and the root half comes from `tenantRoot`,
// which answers `""` for an isolated tenant (its bucket IS its root) instead of
// string-stripping a prefix that no longer contains `users/<id>`.
// ---------------------------------------------------------------------------

/**
 * The owner's ROOT prefix: the parent of `workspace/` (`users/<id>`, …), and
 * `""` for an isolated tenant, whose bucket is its own root.
 *
 * Read out of `tenantRoot` rather than by stripping `/workspace` off
 * `userPrefix`: under SANDBOX_ISOLATED_TENANTS `userPrefix` is the bare string
 * `workspace`, and stripping a leading-slash suffix off it yields `workspace`
 * unchanged — which would have put every platform object back INSIDE the mount,
 * silently, on exactly the tenants that paid for a bucket to get away from it.
 */
export function ownerRoot(owner) {
  return tenantRoot(owner).root;
}

/** Everything platform-owned hangs off here — a sibling of `workspace/`. */
const PLATFORM_DIR = ".platform";

export function platformPrefix(owner) {
  const root = ownerRoot(owner);
  return root ? `${root}/${PLATFORM_DIR}` : PLATFORM_DIR;
}

/**
 * A platform-owned object, bucket included. `platRel` is relative to
 * `platformPrefix` (`manifest.json`, `agent/skills/x/SKILL.md`).
 */
export function platformLocation(owner, platRel = "") {
  const rel = String(platRel ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (rel === "." || rel === ".." || rel.split("/").some((seg) => seg === "..")) {
    throw new Error(`userStore: invalid platform path "${platRel}"`);
  }
  const prefix = platformPrefix(owner);
  return tenantObjectLocation(owner, rel ? `${prefix}/${rel}` : `${prefix}/`);
}

// Workspace-relative paths that are PLATFORM state, not user content: the file
// API, the panel's virtual `skill/` + `memory/` folders, the reverse-sync
// callbacks, version-git's TRACKED_PREFIXES.
//
// **儲存層早就不叫 `.opencode` 了** —— 位元組落在 `<root>/.platform/agent/…`，
// 那一步在這裡翻譯。剩下的只是「呼叫端講話用哪一個拼法」。
//
// 2026-09-11 把那個拼法從 `.opencode` 換成 `.unieai/agent`。
//
// **為什麼不再叫 `.opencode`**：那個引擎 8/30 就從部署裡拿掉了，留著它的名字
// 只會讓每一個新來的人以為它還在。
//
// **為什麼是 `.unieai/` 底下**：使用者自己電腦上的 Rabi Local 住在
// `~/.unieai/ava-local`，雲端工作區裡的環境擷取住在 `.unieai/env.json`、
// 工作流產物住在 `.unieai/wf-runs/`。同一個品牌命名空間，雲端與地端一致。
//
// **為什麼多一段 `agent/` 而不是直接用 `.unieai/`**：前綴會把**整個子樹**
// 映射到平台儲存，而 `.unieai/env.json` 是沙盒直接寫進 `/workspace` 的一般
// 檔案（`env-capture/manifest.mjs` 的 `MANIFEST_PATH`，走 backend.writeFile
// 的容器絕對路徑，不經過這裡）。整個 `.unieai/` 當前綴的話，檔案 API 會去
// 平台前綴找一個其實躺在使用者工作區裡的檔案 —— 不會報錯，只會找不到。
// 多一段 `agent/` 就分開了，而且它剛好對上儲存那邊本來就有的同一段。
//
// **舊拼法照收，而且會一直收下去。** 不是禮貌，是因為它存在於我們改不到的
// 地方：使用者自己打過的路徑、產品內 git 的歷史提交、存下來的技能紀錄。
// 只認新拼法的那一天，那些東西會安靜地變成「一般使用者檔案」—— 不是報錯，
// 是**跑到另一個 S3 前綴去**，於是技能庫看起來空了。
const AGENT_DIR = ".unieai/agent";
const LEGACY_AGENT_DIR = ".opencode";
const AGENT_DIRS = [AGENT_DIR, LEGACY_AGENT_DIR];
const PLATFORM_AGENT_DIR = "agent";

export { AGENT_DIR, LEGACY_AGENT_DIR, AGENT_DIRS };

/**
 * Map a workspace-relative path to its path UNDER the platform prefix, or null
 * when it is ordinary user content. `.opencode/skills/x/SKILL.md` →
 * `agent/skills/x/SKILL.md`.
 */
export function platformRelOf(relPath) {
  const rel = String(relPath || "").replace(/^\/+/, "").replace(/\/+$/, "");
  // 兩個拼法都認。順序無關 —— 它們指向同一個地方。
  for (const dir of AGENT_DIRS) {
    if (rel === dir) return PLATFORM_AGENT_DIR;
    if (rel.startsWith(`${dir}/`)) return `${PLATFORM_AGENT_DIR}/${rel.slice(dir.length + 1)}`;
  }
  return null;
}

/** Inverse of platformRelOf: `agent/skills/x` → `.unieai/agent/skills/x`（回新拼法）。 */
function relOfPlatform(platRel) {
  const rel = String(platRel || "").replace(/^\/+/, "");
  if (rel === PLATFORM_AGENT_DIR) return AGENT_DIR;
  if (rel.startsWith(`${PLATFORM_AGENT_DIR}/`)) {
    return `${AGENT_DIR}/${rel.slice(PLATFORM_AGENT_DIR.length + 1)}`;
  }
  return null;
}

export function manifestKey(owner) {
  return manifestLocation(owner).key;
}

/** The manifest index for this owner, bucket included. */
export function manifestLocation(owner) {
  return platformLocation(owner, "manifest.json");
}

/**
 * Where the manifest lived BEFORE the move — inside the mounted workspace.
 * Still READ (never written) so a workspace that has not been through
 * `scripts/migrate-platform-prefix.mjs` keeps working. Delete-able only by the
 * migration's `--delete-legacy` pass.
 */
export function legacyManifestKey(owner) {
  return legacyManifestLocation(owner).key;
}

/** The pre-move manifest, bucket included. */
export function legacyManifestLocation(owner) {
  return tenantWorkspaceLocation(owner, ".manifest.json");
}

export function blobKey(owner, sha256) {
  return blobLocation(owner, sha256).key;
}

/** One content-addressed blob for this owner, bucket included. */
export function blobLocation(owner, sha256) {
  const prefix = String(sha256).slice(0, 2);
  return tenantWorkspaceLocation(owner, `blobs/${prefix}/${sha256}`);
}

// ---------------------------------------------------------------------------
// PLAIN-TREE layout (flat-tree refactor). Files are stored at their LOGICAL
// path under the owner prefix — `users/<id>/workspace/<relPath>` — so the same
// bytes are (a) weed-mountable directly into a sandbox at /workspace (no
// hydrate/sync), and (b) addressable via the S3 API on the logical path. The
// `.manifest.json` index (size/sha256/mtime) is retained for fast listing +
// change-detection; only the BYTES move from content-addressed blobs to the
// logical path. See memory: workspace-flat-tree-refactor-plan.
// ---------------------------------------------------------------------------

/** Normalize + validate a workspace-relative path. Rejects path traversal —
 *  the owner prefix is the tenant isolation boundary, so a `..` must never
 *  escape it. */
function safeRel(relPath) {
  const rel = String(relPath || "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!rel || rel === "." || rel === ".." || rel.split("/").some((s) => s === "..")) {
    throw new Error(`userStore: invalid workspace path "${relPath}"`);
  }
  return rel;
}

/**
 * S3 key for a logical workspace file. Derived from the location, so the key
 * and the bucket cannot disagree about where the file is.
 */
export function fileKey(owner, relPath) {
  return fileLocation(owner, relPath).key;
}

/**
 * One logical workspace file, as a (bucket, key) pair. The owner is named ONCE
 * and both halves are derived from it, so a call cannot address tenant A's
 * bucket at tenant B's key.
 *
 * User content lands under the mounted `workspace/` prefix. Platform state
 * (`.opencode/…`) is redirected to the unmounted `.platform/` sibling, so it
 * never appears in the sandbox's `/workspace` — while every caller keeps using
 * the same relPath it always did. Both halves stay inside the SAME tenant
 * bucket; the redirect moves the key, never the tenant.
 */
export function fileLocation(owner, relPath) {
  const rel = safeRel(relPath);
  const plat = platformRelOf(rel);
  if (plat) return platformLocation(owner, plat);
  return tenantWorkspaceLocation(owner, rel);
}

/**
 * The PRE-MOVE key for a relPath: always inside the mounted workspace. Equal to
 * `fileKey` for ordinary user content; differs only for platform paths, where
 * it is the un-migrated location. Read-only fallback + migration source.
 */
export function legacyFileKey(owner, relPath) {
  return legacyFileLocation(owner, relPath).key;
}

/** The pre-move location for a relPath: always inside the mounted workspace. */
export function legacyFileLocation(owner, relPath) {
  return tenantWorkspaceLocation(owner, safeRel(relPath));
}

// System files that must never be deleted or overwritten through the public
// per-file API. Deleting `.manifest.json` orphans the whole tree index; the
// content-addressed `blobs/` bytes are referenced by it. The system's OWN
// writers (writeManifest → putObject(manifestKey), writeBlob → putObject(
// blobKey)) bypass writeFile/deleteFile, so this guard never blocks legitimate
// internal maintenance — only external callers (agent file tools, the app file
// API, a user) trying to remove/clobber a structural file.
const PROTECTED_RELPATHS = new Set([".manifest.json"]);

/** True when relPath is a structural file no external caller may delete/overwrite. */
export function isProtectedRelPath(relPath) {
  const rel = String(relPath || "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (PROTECTED_RELPATHS.has(rel)) return true;
  if (rel === "blobs" || rel.startsWith("blobs/")) return true;
  return false;
}

// System folders that hold the agent's own machinery, NOT user content:
//   .opencode/  — skills (.opencode/skills/<name>/) + memories (.opencode/memories/)
//   .unieai/    — captured env / restore logs (regenerated, never user-authored)
// A "clean up the workspace" instruction must NOT let the agent (or a stray panel
// action) wipe these as a UNIT and take the user's whole skill/memory library +
// env with it. We protect the CONTAINER DIRS — the bare `.opencode`,
// `.opencode/skills`, `.opencode/memories`, and the entire `.unieai/` subtree —
// from deletion, while STILL allowing a targeted delete of one named leaf
// (`.opencode/skills/<name>`, `.opencode/memories/<file>`) so the skill manager
// UI (and a deliberate single-skill removal) keeps working. Writes are never
// blocked here — only destructive deletes. (See the workspace data-safety thread.)
//
// These are still spelled `.opencode/…` on purpose: that spelling is the file
// API's PATH CONTRACT, which did not change when the bytes moved out of the
// mount (fileKey redirects them to `<root>/.platform/agent/…`). The guard has
// in fact become mostly redundant for `.opencode` — a path the sandbox cannot
// see is a path its `rm -rf` cannot reach — but it still covers the app's own
// file API and the agent's remove tool, which address it by relPath. `.unieai/`
// is genuinely inside the mount and this is its only protection.
const SYSTEM_DIR_ROOTS = new Set([".opencode", ".opencode/skills", ".opencode/memories", ".unieai"]);

/** True when relPath is a SYSTEM container dir that must not be deleted wholesale. */
export function isSystemDeleteProtected(relPath) {
  const rel = String(relPath || "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!rel) return false;
  if (SYSTEM_DIR_ROOTS.has(rel)) return true;            // the container dir itself
  if (rel === ".unieai" || rel.startsWith(".unieai/")) return true; // whole system subtree
  return false;
}

/** Thrown when a protected path is targeted; carries a code routes map to 403. */
export class ProtectedPathError extends Error {
  constructor(relPath, op) {
    super(`userStore: "${relPath}" is a protected workspace file and cannot be ${op}`);
    this.name = "ProtectedPathError";
    this.code = "protected_path";
    this.relPath = relPath;
  }
}

/**
 * Listeners told about every workspace object this process writes or deletes,
 * AFTER the store accepted it and BEFORE the call returns.
 *
 * Why it is awaited (CAC P2): an S3-driver host mount (rclone) caches directory
 * listings, so a file the agent writes with its write tool — which lands here,
 * through S3 — is invisible to the `cat` it runs next until the cache expires.
 * Measured: still missing after 30 s with rclone's defaults. The listener drops
 * the cached directory, and the HTTP reply waits for that, so "write, then run"
 * sees the file. A listener failure never fails the write: the object is
 * stored; the worst case is the cache's own expiry.
 */
const objectChangeListeners = new Set();

export function onWorkspaceObjectChange(listener) {
  objectChangeListeners.add(listener);
  return () => objectChangeListeners.delete(listener);
}

async function announceObjectChange(at, op) {
  if (objectChangeListeners.size === 0) return;
  await Promise.allSettled(Array.from(objectChangeListeners, (fn) => fn({ bucket: at.bucket, key: at.key, op })));
}

/**
 * `body` may be a Buffer/string or, for a large upload, a stream — then
 * `contentLength` is required (S3 cannot sign a PutObject of unknown length)
 * and a conditional write is refused (it compares bytes it would have to buffer).
 */
export async function writeFile(owner, relPath, body, contentType, { expectedSha256, contentLength } = {}) {
  if (isProtectedRelPath(relPath)) throw new ProtectedPathError(relPath, "overwritten");
  // Writes ALWAYS go to the new key. A platform path that still has a legacy
  // twin is then shadowed by this one on read, which is the intended precedence
  // (the migration copies legacy → new; a later edit must win over the copy).
  let ifMatch;
  if (expectedSha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("invalid expected content hash");
    let object;
    try { object = await getObject({ at: fileLocation(owner, relPath) }); }
    catch (error) {
      if (isNotFound(error)) throw new PreconditionFailedError(relPath, "file missing or legacy-only; reload before saving");
      throw error;
    }
    const bytes = await streamToBuffer(object?.Body || object?.body || object);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
      throw new PreconditionFailedError(relPath, "file changed since editor loaded it");
    }
    ifMatch = object?.ETag;
    if (!ifMatch) throw new Error("storage does not provide a version for conditional writes");
  }
  await putObject({
    at: fileLocation(owner, relPath),
    ...(ifMatch ? { ifMatch } : {}),
    body,
    ...(contentLength !== undefined ? { contentLength } : {}),
    contentType: contentType || "application/octet-stream",
  });
  await announceObjectChange(fileLocation(owner, relPath), "write");
}

export async function readFile(owner, relPath) {
  const at = fileLocation(owner, relPath);
  try {
    const obj = await getObject({ at });
    return streamToBuffer(obj?.Body || obj?.body || obj);
  } catch (err) {
    // Dual-read window: a platform file written before the move still lives at
    // its old in-workspace key. Fall back rather than 404 — otherwise every
    // skill a user already had would vanish the moment this ships.
    const legacy = legacyFileLocation(owner, relPath);
    if (legacy.key === at.key || !isNotFound(err)) throw err;
    const obj = await getObject({ at: legacy });
    return streamToBuffer(obj?.Body || obj?.body || obj);
  }
}

export async function deleteFile(owner, relPath) {
  if (isProtectedRelPath(relPath)) throw new ProtectedPathError(relPath, "deleted");
  const at = fileLocation(owner, relPath);
  await deleteObject({ at });
  // A delete must also clear the legacy twin, or the dual-read above would
  // resurrect the file the user just removed.
  const legacy = legacyFileLocation(owner, relPath);
  if (legacy.key !== at.key) await deleteObject({ at: legacy }).catch(() => {});
  await announceObjectChange(at, "delete");
}

async function streamToBuffer(stream) {
  if (Buffer.isBuffer(stream)) return stream;
  if (stream && typeof stream.transformToByteArray === "function") {
    return Buffer.from(await stream.transformToByteArray());
  }
  if (stream && typeof stream[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (stream && typeof stream.pipe === "function") {
    return await new Promise((resolve, reject) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  }
  throw new Error("userStore: unsupported S3 body type");
}

/**
 * "The object is not there" — as opposed to a real outage. Match on three
 * independent signals, because different S3-compatible servers say it
 * differently:
 *   · AWS S3 / MinIO  → name="NoSuchKey", httpStatusCode=404
 *   · SeaweedFS       → message contains "The specified key does not exist"
 *   · generic         → message contains "not found" / "404"
 * Anything else (5xx, network blip) is an ERROR and must propagate: treating an
 * outage as "empty" is what lets a caller write back a truncated manifest and
 * wipe the user's workspace.
 */
export function isNotFound(err) {
  const msg = String(err?.message || err);
  const status = err?.$metadata?.httpStatusCode;
  const errName = err?.name || err?.Code;
  return (
    errName === "NoSuchKey" ||
    status === 404 ||
    /not found|NoSuchKey|404|does not exist/i.test(msg)
  );
}

export async function loadManifest(userId) {
  if (!userId) return emptyManifest(userId);
  try {
    let obj;
    let fromLegacy = false;
    try {
      obj = await getObject({ at: manifestLocation(userId) });
    } catch (err) {
      // Dual-read window: not yet migrated → the index still sits inside the
      // workspace. Read it, but do NOT carry its ETag: the next write creates
      // the object at the NEW key, so it must be create-only (ifNoneMatch:*),
      // and an ifMatch against a key that does not exist would fail forever.
      if (!isNotFound(err)) throw err;
      obj = await getObject({ at: legacyManifestLocation(userId) });
      fromLegacy = true;
    }
    const buf = await streamToBuffer(obj?.Body || obj?.body || obj);
    const parsed = JSON.parse(buf.toString("utf8"));
    if (!parsed || typeof parsed !== "object") return emptyManifest(userId);
    if (Number(parsed.version || 0) !== MANIFEST_VERSION) {
      log("warn", "userStore.manifest_unknown_version", { userId, version: parsed.version });
      return emptyManifest(userId);
    }
    return {
      version: MANIFEST_VERSION,
      userId,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {},
      // The store's version token for THIS read. `updateManifest` hands it back
      // on the write so the write lands only if nothing changed in between.
      // It never reaches the stored JSON: writeManifest builds its payload from
      // named fields, not by spreading the manifest.
      ...(!fromLegacy && obj?.ETag ? { __etag: String(obj.ETag) } : {})
    };
  } catch (err) {
    const msg = String(err?.message || err);
    // First-time user: no manifest at EITHER key yet. Treat as empty workspace.
    // (The original regex only caught the AWS shape; on SeaweedFS the "key
    // missing" path threw to the caller and the sandbox 500'd → UI Files panel
    // never recovered, blocking workspace persistence in dev L2.)
    if (isNotFound(err)) {
      return emptyManifest(userId);
    }
    // Any other failure (S3 5xx, network blip, JSON corruption from a
    // half-written file) is propagated to the caller. Previously we
    // silently returned emptyManifest here — that masked transient
    // outages and, worse, an upload/sync caller would then writeManifest
    // with their (small) set of entries and wipe everything else from S3.
    // Surface the error so the caller can fail the request instead of
    // destroying the user's workspace.
    log("error", "userStore.manifest_load_failed", { userId, message: msg });
    throw err;
  }
}

export function emptyManifest(userId) {
  return {
    version: MANIFEST_VERSION,
    userId: userId || null,
    updatedAt: new Date().toISOString(),
    entries: {}
  };
}

// Heavy / noise directories never shown in the panel — mirrors files/walk.mjs
// SKIP_DIRS so the S3-truth listing matches what the old sandbox→S3 walk
// recorded (and so a big node_modules can't crowd real files out of the
// listObjectsByPrefix cap, hiding e.g. a CJK-named folder that sorts last).
const LISTING_SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", ".cache", ".npm", ".yarn"]);

/**
 * 「這個 rel 不進清單」—— 檔案與資料夾共用同一個判準。
 *
 * 2026-09-16：把資料夾改成由 delimiter 列舉直接提供之後，我只在資料夾那一邊
 * 濾了 `LISTING_SKIP_DIRS`，忘了 `blobs/` 與索引檔自己 —— 於是 `blobs` 以
 * 資料夾的身分出現在面板上。既有的「blobs excluded」測試當場抓到。
 *
 * 那是同一個形狀第 N 次：**加寬了一邊，漏掉一個消費端**。所以規則搬到一個地方，
 * 兩個迴圈都讀它，走樹要不要下去也讀它。三個呼叫點，一份規則。
 */
function excludedRel(rel) {
  if (!rel) return true;
  if (rel === ".manifest.json") return true;                      // 索引自己
  if (rel === "blobs" || rel.startsWith("blobs/")) return true;   // 內容定址的位元組
  return rel.split("/").some((seg) => LISTING_SKIP_DIRS.has(seg));
}

/**
 * 「這是一個重目錄本身」—— 內容不列，但資料夾要出現，並標成 `unlisted`。
 *
 * 2026-09-26 UAT 軌道 B1，D13：AI 在 `uat0926-longjob/node_modules` 產生了 300 個檔，
 * 檔案樹裡整個資料夾都不見了，沒有任何提示。不下去是對的（見 walkSkippingHeavyDirs：
 * 那是「排在 node_modules 後面的檔案消失」的修法）；安靜消失不對。
 *
 * 只有**最後一段**是重目錄、前面每一段都沒被排除的才算 —— 重目錄裡面的重目錄
 * 外層已經不下去，不會被看到。`.git` 例外：版本庫的內部，大多數檔案瀏覽器預設就藏它。
 */
function unlistedHeavyDir(rel) {
  if (!rel) return false;
  const segs = rel.split("/");
  const last = segs[segs.length - 1];
  if (!LISTING_SKIP_DIRS.has(last) || last === ".git") return false;
  return !excludedRel(segs.slice(0, -1).join("/") || "x");
}

/**
 * 一個路徑在工作區清單裡會長什麼樣子 —— **不列整個工作區**。
 *
 * 引擎的雲端 `stat()` 以前每問一個路徑就抓一次整份清單（2026-10-21 roy 的工作區
 * 8,751 筆、1 MB，一次 2–6 秒），而 DSH 每一輪開口之前要依序問好幾個（往上找
 * `.git`、每一層的 AGENTS.md／CLAUDE.md）—— 每一輪送出之後那 7 秒就是這個。
 *
 * 答案必須跟 `listWorkspaceManifest` 一致，否則同一個檔案 stat 說有、list 說沒有：
 *   · 檔案：那一把鍵的 HEAD（不用前綴列舉 —— 前綴的第一筆可能是 `a.txt.bak`）。
 *     平台路徑（`.opencode/…`）走 `fileLocation` 的轉址，搬家前的舊位置也認。
 *   · 資料夾：底下至少有一個物件（含 SeaweedFS 的 `rel/` 目錄標記）。
 *   · 清單排除的（`.git`、node_modules 裡面、blobs、索引檔）就是不存在；重目錄
 *     本身（node_modules）跟清單一樣以資料夾出現。
 *   · 清單把只有 NFD 鍵的檔案呈現在 NFC 名字下，這裡也是。
 *   · 清單的 `mtimeMs` 在這個模式是 0、size 是物件大小 —— 一字不差照抄，
 *     引擎拿它們算版本（防舊寫入的守門），兩條路算出來的版本必須相同。
 * 例外（已知、刻意）：面板「新增資料夾」建的**空**資料夾只記在 `.manifest.json`，
 * 沒有任何 S3 物件；這裡不讀索引（那正是要省掉的那一次大讀取），所以它回不存在。
 *
 * 非 live 模式（stub）清單就是索引本身，照索引回答。
 *
 * @returns {Promise<null | { type: "file", size: number, mtimeMs: number } | { type: "directory", mtimeMs: number, unlisted?: true }>}
 */
export async function statWorkspacePath(owner, relPath, { live = true } = {}) {
  const rel = String(relPath ?? "").normalize("NFC").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!rel) return { type: "directory", mtimeMs: 0 };
  if (!live) {
    const entries = (await loadManifest(owner))?.entries ?? {};
    const e = entries[rel];
    if (e) return e.kind === "dir" ? { type: "directory", mtimeMs: e.mtimeMs || 0 } : { type: "file", size: Number(e.size) || 0, mtimeMs: e.mtimeMs || 0 };
    return Object.keys(entries).some((k) => k.startsWith(`${rel}/`)) ? { type: "directory", mtimeMs: 0 } : null;
  }
  const heavy = unlistedHeavyDir(rel);
  if (excludedRel(rel) && !heavy) return null;
  const candidates = [...new Set([rel, rel.normalize("NFD")])];
  if (!heavy) {
    for (const cand of candidates) {
      const file = await headFileAnyLocation(owner, cand);
      if (file) return { type: "file", size: file.sizeBytes, mtimeMs: 0 };
    }
  }
  for (const cand of candidates) {
    if (await hasObjectsUnder(owner, cand)) return heavy ? { type: "directory", mtimeMs: 0, unlisted: true } : { type: "directory", mtimeMs: 0 };
  }
  return null;
}

async function headFileAnyLocation(owner, rel) {
  const at = fileLocation(owner, rel);
  const hit = await headObject({ at });
  if (hit) return hit;
  const legacy = legacyFileLocation(owner, rel);
  return legacy.key === at.key ? null : headObject({ at: legacy });
}

async function hasObjectsUnder(owner, rel) {
  const locs = [fileLocation(owner, rel), legacyFileLocation(owner, rel)];
  for (const at of locs) {
    const dir = objectLocation({ bucket: at.bucket, key: `${at.key}/`, scope: at.scope, describedBy: at.describedBy });
    if ((await listObjectsByPrefix({ at: dir, maxItems: 1 })).length > 0) return true;
    if (locs[1].key === locs[0].key) break;
  }
  return false;
}

/**
 * Build a manifest by listing ACTUAL S3 objects under the owner prefix — the
 * source of truth for a FUSE/weed-mounted workspace, where bash + uploads write
 * bytes straight to S3 at their logical path and the legacy `.manifest.json`
 * index is never updated. Returns the same `{version,userId,updatedAt,entries}`
 * shape as loadManifest so the panel's tree builder is unchanged; the app layer
 * still applies its own hides/virtual-folder surfacing on top.
 */
export async function listWorkspaceManifest(owner) {
  // Both listings are scoped by the same location type as every write: the
  // prefix and the bucket come out of one `owner`, so a tenant cannot list into
  // another's bucket even when their collapsed prefixes are identical strings.
  const wsAt = tenantWorkspaceLocation(owner);
  const platAt = platformLocation(owner);
  const prefix = wsAt.key;
  const platPrefix = platAt.key;
  // Two listings, one entry set. The workspace prefix holds the user's files
  // (plus any not-yet-migrated `.opencode/` leftovers); the platform prefix
  // holds the agent library, which the panel still shows through its virtual
  // `skill/` + `memory/` folders — so it has to appear here under its
  // `.opencode/…` relPath even though the bytes live outside the mount.
  // **走樹，不要扁平列舉。** 見 `walkSkippingHeavyDirs` 的說明：扁平列舉會把
  // 上限花在 node_modules 裡面，然後字典序排在它後面的每一個檔案安靜消失。
  const [ws, plat] = await Promise.all([
    walkSkippingHeavyDirs(wsAt),
    walkSkippingHeavyDirs(platAt).catch(() => ({ objs: [], dirs: [], truncated: false, scanned: 0 })),
  ]);
  const objs = [];
  for (const o of ws.objs) {
    const key = String(o?.key || "");
    if (key.startsWith(prefix)) objs.push({ ...o, rel: key.slice(prefix.length) });
  }
  for (const o of plat.objs) {
    const key = String(o?.key || "");
    if (!key.startsWith(platPrefix)) continue;
    const platRel = key.slice(platPrefix.length);
    // `manifest.json` is the index itself; only the agent library is surfaced.
    const rel = relOfPlatform(platRel.replace(/\/+$/, ""));
    if (!rel) continue;
    objs.push({ ...o, rel: platRel.endsWith("/") ? `${rel}/` : rel });
  }
  const truncated = ws.truncated || plat.truncated;
  const entries = {};
  const dirRels = [];
  for (const o of objs) {
    const rel = o.rel;
    if (!rel) continue;
    if (excludedRel(rel.replace(/\/+$/, ""))) continue;
    if (rel.endsWith("/")) {
      // Directory marker (SeaweedFS lists filer DIRECTORY entries as
      // trailing-slash keys — including dirs created by bash `mkdir` over the
      // weed mount). These used to be dropped, which made an EMPTY folder
      // created inside the sandbox invisible to the panel (the manifest's
      // kind:"dir" entries only cover the panel's own "New Folder" route).
      // Surface them as dir entries; files below fill in the rest.
      dirRels.push(rel.replace(/\/+$/, ""));
      continue;
    }
    entries[rel] = { size: Number(o?.sizeBytes || 0), mtimeMs: 0 };
  }
  // 走樹時看到的子前綴 = 資料夾，**包含沒有任何檔案的空資料夾**。扁平列舉只能
  // 靠 SeaweedFS 的 trailing-slash 標記推出它們；delimiter 列舉直接就有。
  for (const rel of ws.dirs.filter((d) => d.startsWith(prefix)).map((d) => d.slice(prefix.length).replace(/\/+$/, ""))) {
    if (!excludedRel(rel) && !(rel in entries)) {
      entries[rel] = { kind: "dir", mtimeMs: 0 };
    } else if (unlistedHeavyDir(rel) && !(rel in entries)) {
      // 重目錄：出現，但內容不列（見 unlistedHeavyDir）。面板據此說明它為什麼是空的。
      entries[rel] = { kind: "dir", unlisted: true, mtimeMs: 0 };
    }
  }
  for (const rel of dirRels) {
    if (rel && !(rel in entries)) entries[rel] = { kind: "dir", mtimeMs: 0 };
  }

  // NFC/NFD self-heal. App writers NFC-normalize keys (guard.mjs / the upload
  // routes) but the FUSE mount stores whatever raw bytes the shell wrote — so
  // a CJK/accented filename written via bash lands under an NFD key, and once
  // the app later writes the same visible name the two keys show as DUPLICATE
  // rows (the bbb.csv-class panel bug for non-ASCII names). Two cases:
  //   · NFD only  → pure rename: present it under the NFC key now and migrate
  //     the object in the background (copy → delete, fire-and-forget).
  //   · both keys → the NFC copy is the app-authored/authoritative one; hide
  //     the NFD row ONLY when sizes match (likely same bytes). Diverged sizes
  //     stay visible as two rows — truthfully — rather than guessing which to
  //     drop.
  const heals = [];
  for (const rel of Object.keys(entries)) {
    const nfc = rel.normalize("NFC");
    if (nfc === rel) continue;
    const nfd = entries[rel];
    const canonical = entries[nfc];
    if (!canonical) {
      entries[nfc] = nfd;
      delete entries[rel];
      heals.push({ from: rel, to: nfc });
    } else if (!nfd.kind && !canonical.kind && nfd.size === canonical.size) {
      delete entries[rel];
      heals.push({ from: rel, to: null }); // same-size twin → just delete NFD
    }
  }
  if (heals.length > 0) {
    void (async () => {
      for (const h of heals.slice(0, 20)) {
        try {
          if (h.to) {
            const body = await readFile(owner, h.from);
            if (body != null) await writeFile(owner, h.to, body, "application/octet-stream");
          }
          await deleteFile(owner, h.from);
          log("info", "workspace.nfc_healed", { owner, from: h.from, to: h.to });
        } catch (err) {
          log("warn", "workspace.nfc_heal_failed", { owner, from: h.from, error: err?.message });
        }
      }
    })();
  }

  // Merge explicit directory entries from the index. We list real S3 objects
  // above because the index's FILE entries are stale in a live/weed-mount
  // workspace (bash + uploads write bytes straight to S3 without touching
  // `.manifest.json`). But its `kind:"dir"` entries are the ONLY record of an
  // EMPTY folder created via the panel's "New Folder" button — an empty dir has
  // no S3 object to imply it, so without this merge it never shows ("新增資料夾
  // 不顯示"). Dir entries are only ever written by the folder-create route, so
  // they aren't subject to the file-staleness problem. A folder later removed
  // via bash can leave a ghost entry; the panel's delete drops it.
  try {
    const idx = await loadManifest(owner);
    for (const [rel, v] of Object.entries(idx.entries || {})) {
      if (v && v.kind === "dir" && !(rel in entries)) {
        entries[rel] = { kind: "dir", mtimeMs: v.mtimeMs || 0 };
      }
    }
  } catch {
    /* index missing/unreadable — the S3 listing stands on its own */
  }

  if (truncated) {
    // **不要安靜截斷。** 上一版就是安靜的，代價是使用者上傳的文件在面板與
    // agent 眼裡都不存在，而畫面上沒有任何一個字說少了東西。
    log("warn", "workspace.listing_truncated", {
      owner, kept: Object.keys(entries).length, scanned: ws.scanned + plat.scanned,
    });
  }
  return {
    version: MANIFEST_VERSION,
    userId: owner || null,
    updatedAt: new Date().toISOString(),
    entries,
    ...(truncated ? { truncated: true, scanned: ws.scanned + plat.scanned } : {})
  };
}

/**
 * 走一棵工作區的樹，**在花掉預算之前**就決定不要下去重目錄。
 *
 * ## 這一支取代了什麼，以及為什麼
 *
 * 舊版是 `listObjectsByPrefix({ maxItems: 5000 })` —— 扁平地把子樹裡每一個鍵
 * 拉回來，然後在迴圈裡用 `LISTING_SKIP_DIRS` 過濾。兩個步驟的順序就是缺陷：
 * **上限在列的時候生效，跳過在列完之後才生效。**
 *
 * 實測（2026-09-16，線上這個工作區）：`ava-e2e/` 底下至少兩萬個
 * node_modules 的鍵，5000 個鍵的預算全部花在那裡面。可否證的預測與結果：
 *
 *     寫 aaa-order-probe.md（排在 ava-e2e/ 之前）→ 清單看得到
 *     寫 zzz-order-probe.md（排在 ava-e2e/ 之後）→ 清單看不到
 *
 * 同一個 bucket、同一秒、同一個寫入呼叫，唯一的差別是字典序位置。使用者上傳
 * 的文件因此在面板與 agent 的 read/list 工具眼裡都不存在，而上傳本身回 200、
 * 位元組也真的在 S3 上。模型於是請使用者「把內容貼上來」。
 *
 * 那段舊註解說它要防的正是這件事（「一個大的 node_modules 不能把真的檔案從
 * 上限裡擠出去」）—— 規則寫對了，實作的順序讓它從來沒有生效過。又一個看起來
 * 像控制的控制。
 *
 * ## 判準
 *
 * · 重目錄**不下去**，所以它只花一個前綴而不是兩萬個鍵
 * · 預算算的是「留下來的檔案」，不是「掃過的鍵」
 * · 走不完就把 `truncated` 說出來。藏起來的上限跟說出來的上限是兩件事
 */
const WORKSPACE_WALK_MAX_FILES = 20_000;
const WORKSPACE_WALK_MAX_PREFIXES = 4_000;
/** 同時在飛的逐層列舉數。不設限會對 filer 開出幾百個併發連線。 */
const WALK_CONCURRENCY = 12;

async function walkSkippingHeavyDirs(rootAt, { maxFiles = WORKSPACE_WALK_MAX_FILES, maxPrefixes = WORKSPACE_WALK_MAX_PREFIXES } = {}) {
  const rootKey = rootAt.key;
  const objs = [];
  const dirs = [];
  let scanned = 0;
  let truncated = false;
  // 一層一個 round trip，序列化跑在一棵有幾百個目錄的樹上要 5 秒（線上實測
  // 2026-09-16，一個含 Next.js 建置產物的工作區）。**同一層的目錄彼此獨立**，
  // 所以按層並行，並限制同時在飛的數量 —— 不設限會對 filer 開出幾百個併發。
  let frontier = [""];
  let visited = 0;
  while (frontier.length) {
    if (visited >= maxPrefixes || objs.length >= maxFiles) { truncated = true; break }
    const room = Math.min(frontier.length, maxPrefixes - visited);
    if (room < frontier.length) truncated = true;
    const batch = frontier.slice(0, room);
    frontier = frontier.slice(room);
    visited += batch.length;
    const next = [];
    for (let i = 0; i < batch.length && objs.length < maxFiles; i += WALK_CONCURRENCY) {
      // 根 location 原封不動傳下去，深度用 subPrefix 表示 —— 展開 location 換 key
      // 會繞過 objectLocation 的驗證（見 listLevel 的說明）。
      const levels = await Promise.all(batch.slice(i, i + WALK_CONCURRENCY).map((sub) =>
        listLevel({ at: rootAt, subPrefix: sub, delimiter: "/", maxItems: maxFiles })));
      for (const level of levels) {
        if (level.truncated) truncated = true;
        scanned += level.files.length + level.prefixes.length;
        for (const f of level.files) {
          if (objs.length >= maxFiles) { truncated = true; break }
          objs.push(f);
        }
        for (const pfx of level.prefixes) {
          dirs.push(pfx);
          // **跳過在下去之前** —— 這是整支函式的重點。判準跟清單那邊共用一份，
          // 否則「不列」與「不下去」會分岔，blobs/ 這種目錄照樣把預算花掉。
          if (excludedRel(pfx.slice(rootKey.length).replace(/\/+$/, ""))) continue;
          // 佇列裡存的是「相對於根」的子前綴，跟 subPrefix 同一個語彙。
          next.push(pfx.slice(rootKey.length));
        }
      }
    }
    frontier = frontier.concat(next);
  }
  return { objs, dirs, truncated, scanned };
}

/**
 * 測試接縫。`truncated` 有兩個方向要量：超過預算要說、**沒超過不能誤說**。
 * 後者只能直接量這支函式 —— 從 `listWorkspaceManifest` 外面看不出差別，而一個
 * 永遠說「我截斷了」的旗標跟沒有旗標是同一件事。
 */
export async function walkForTests(owner, opts) {
  return walkSkippingHeavyDirs(tenantWorkspaceLocation(owner), opts);
}

export async function writeManifest(userId, manifest, { ifMatch, ifNoneMatch } = {}) {
  const payload = {
    version: MANIFEST_VERSION,
    userId,
    updatedAt: new Date().toISOString(),
    entries: manifest?.entries && typeof manifest.entries === "object" ? manifest.entries : {}
  };

  // We trust the caller's entries set as-is. An earlier draft of the
  // audit added a "refuse non-empty → empty overwrite" guard here as
  // defence-in-depth against the bug where loadManifest silently
  // returned an empty manifest on a transient S3 error and the next
  // writeManifest wiped real state. That bug was fixed at the source
  // (B1: loadManifest now throws on non-NotFound errors instead of
  // returning empty), so the empty-overwrite path can only be reached
  // by an honest delete-last-entry — which the guard incorrectly
  // refused, breaking DELETE /v1/users/<id>/workspace/file for the
  // user's final file. B1 + withUserManifestLock (D) already cover
  // the original threat model; adding the empty-detection guard back
  // would require differentiating "deleted the last entry on purpose"
  // from "loaded an empty manifest by mistake", which isn't expressible
  // without extra signalling from the caller. Not worth the surface.

  const res = await putObject({
    at: manifestLocation(userId),
    body: Buffer.from(JSON.stringify(payload), "utf8"),
    contentType: "application/json; charset=utf-8",
    ...(ifMatch ? { ifMatch } : {}),
    ...(ifNoneMatch ? { ifNoneMatch } : {})
  });
  // Carry the new version token back so a caller doing several writes in a row
  // does not have to re-read to get it.
  return res?.etag ? { ...payload, __etag: String(res.etag) } : payload;
}

export async function readBlob(userId, sha256) {
  const obj = await getObject({ at: blobLocation(userId, sha256) });
  return streamToBuffer(obj?.Body || obj?.body || obj);
}

export async function blobExists(userId, sha256) {
  try {
    const list = await listObjectsByPrefix({ at: blobLocation(userId, sha256), maxItems: 1 });
    return list.length > 0 && list[0].key === blobKey(userId, sha256);
  } catch {
    return false;
  }
}

export async function writeBlob(userId, sha256, body, contentType) {
  await putObject({
    at: blobLocation(userId, sha256),
    body,
    contentType: contentType || "application/octet-stream"
  });
}

// ---------------------------------------------------------------------------
// Per-userId manifest mutex.
//
// All callers that do read-modify-write on a user's manifest (upload, sync,
// delete) must run inside withUserManifestLock(userId, fn). Without this,
// two parallel loads see the same baseline and the second writeManifest
// silently drops entries the first one added.
//
// The lock is IN-MEMORY, so on its own it is a policy, not a mechanism: its
// correctness rested on "the per-user-singleton sandbox-runtime policy means
// one process owns one user's manifest at a time". That is a deployment
// arrangement, not something the code enforces — and the manifest lost-update
// bug is what it looks like when the arrangement does not hold. `updateManifest`
// below closes it with a compare-and-swap, which is a mechanism: the write
// carries the version it read, and the store refuses it if anything changed.
// The lock stays as the fast path that keeps same-process writers from
// generating conflicts in the first place.
// ---------------------------------------------------------------------------

const _userLocks = new Map();

export async function withUserManifestLock(userId, fn) {
  if (!userId) return fn();
  const prev = _userLocks.get(userId) || Promise.resolve();
  // Chain: wait for prev to settle (success OR failure — we just need
  // sequencing; a failed predecessor must not block subsequent calls).
  const next = prev.catch(() => {}).then(() => fn());
  _userLocks.set(userId, next);
  try {
    return await next;
  } finally {
    // If we're still the tail of the chain, clear the entry so the Map
    // doesn't grow unbounded for users that never upload again.
    if (_userLocks.get(userId) === next) _userLocks.delete(userId);
  }
}

/** How many times a losing writer re-reads and re-applies before giving up. */
const MANIFEST_CAS_RETRIES = 6;

/**
 * The read-modify-write primitive for a user's manifest.
 *
 * `mutate(manifest)` receives the freshly-loaded manifest and mutates
 * `manifest.entries` in place (or returns a replacement). It may run MORE THAN
 * ONCE: if another writer commits first, the CAS is refused, the manifest is
 * re-read, and the mutation is re-applied on top of the new baseline. Write it
 * so that is safe — express the change as "add/remove THESE paths", never as
 * "the entry set is now exactly this", or a retry will undo the other writer.
 *
 * Return value: whatever `mutate` returned, or the written manifest when it
 * returned undefined. `mutate` may return the symbol `SKIP_WRITE` to abort
 * without writing (nothing to do — a common case for the sync paths).
 */
export const SKIP_WRITE = Symbol("manifest.skip-write");

export async function updateManifest(owner, mutate) {
  if (!owner) throw new Error("updateManifest: owner is required");
  return withUserManifestLock(owner, async () => {
    let lastErr = null;
    for (let attempt = 0; attempt < MANIFEST_CAS_RETRIES; attempt += 1) {
      const manifest = await loadManifest(owner);
      const etag = manifest.__etag;
      const out = await mutate(manifest, { attempt });
      if (out === SKIP_WRITE) return out;
      const next = out && typeof out === "object" && out.entries ? out : manifest;
      try {
        await writeManifest(owner, next, {
          // No etag means the manifest does not exist yet — then the write must
          // be create-only, so two first-writers cannot both "create" it and
          // one silently lose everything the other put in.
          ...(etag ? { ifMatch: etag } : { ifNoneMatch: "*" })
        });
        return out === undefined ? next : out;
      } catch (err) {
        if (!isPreconditionFailed(err)) throw err;
        lastErr = err;
        log("warn", "userStore.manifest_cas_retry", { owner, attempt: attempt + 1 });
        // Someone else committed between our read and our write. Re-read and
        // re-apply rather than overwriting their work.
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }
    log("error", "userStore.manifest_cas_exhausted", { owner, retries: MANIFEST_CAS_RETRIES });
    throw lastErr || new Error(`manifest update failed after ${MANIFEST_CAS_RETRIES} attempts`);
  });
}
