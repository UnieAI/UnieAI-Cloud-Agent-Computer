import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadBucketCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  objectLocation,
  systemLocation,
  isObjectLocation,
  formatLocation,
  requireLocation
} from "./location.mjs";

// Re-exported so a caller needs exactly one import to both build a location
// and use it, and so `storage-engine` is unambiguously the owner of the type
// its operations demand.
export { objectLocation, systemLocation, isObjectLocation, formatLocation };

// ---------------------------------------------------------------------------
// Local-fs fallback. Used in dev / on-prem / test when S3 isn't configured.
// Layout: <STORAGE_LOCAL_FS_ROOT>/<bucket>/<key>
// Bucket defaults to "unieai-objects"; root defaults to ~/.unieai-studio/objects.
// ---------------------------------------------------------------------------

const LOCAL_FS_ROOT =
  String(process.env.STORAGE_LOCAL_FS_ROOT || "").trim()
  || path.join(os.homedir(), ".unieai-studio", "objects");
const LOCAL_FS_BUCKET =
  String(process.env.STORAGE_LOCAL_FS_BUCKET || "unieai-objects").trim();
const LOCAL_FS_FORCED = /^(1|true|yes|on)$/i.test(String(process.env.STORAGE_LOCAL_FS || "").trim());

/**
 * A write refused because its precondition (`ifMatch` / `ifNoneMatch`) did not
 * hold — someone else changed the object first.
 *
 * Typed so a caller can tell "you lost a race, re-read and retry" apart from
 * "the store is broken". Swallowing that difference is how a compare-and-swap
 * quietly degrades into a last-writer-wins overwrite.
 */
export class PreconditionFailedError extends Error {
  constructor(key, detail) {
    super(`precondition failed for ${key}${detail ? `: ${detail}` : ""}`);
    this.name = "PreconditionFailedError";
    this.key = key;
  }
}

/** True for a precondition failure from EITHER backend. */
export function isPreconditionFailed(err) {
  if (err instanceof PreconditionFailedError) return true;
  const name = err?.name || err?.Code || err?.code;
  return name === "PreconditionFailed" || err?.$metadata?.httpStatusCode === 412;
}

/** ETag over content, so it actually identifies a version. */
function localEtag(buf) {
  return `"${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 32)}"`;
}

/**
 * Serialises local-fs conditional writes per key.
 *
 * The check and the write are two syscalls; without this a concurrent writer
 * can land between them and the precondition means nothing. S3 does this
 * server-side, so this only exists for the fallback backend — which is
 * single-process by definition (dev / on-prem without S3).
 */
const _localKeyLocks = new Map();
async function withLocalKeyLock(key, fn) {
  const prev = _localKeyLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  const queued = prev.then(() => next, () => next);
  _localKeyLocks.set(key, queued);
  try { await prev; } catch { /* predecessor's failure is not ours */ }
  try {
    return await fn();
  } finally {
    release();
    if (_localKeyLocks.get(key) === queued) _localKeyLocks.delete(key);
  }
}

/**
 * `<root>/<bucket>/<key>` — the bucket is a real directory here, not a
 * constant. It used to be hardcoded to LOCAL_FS_BUCKET, which made the
 * fallback backend structurally incapable of separating two buckets and so
 * incapable of reproducing the cross-tenant overwrite in a test.
 */
function localPathFor(bucket, key) {
  // Keep the same key shape S3 uses; folders are flat on disk.
  const safeKey = String(key || "").replace(/^\/+/, "");
  return path.join(LOCAL_FS_ROOT, localBucket(bucket), safeKey);
}

/** A location's bucket, or this deployment's default one. */
function localBucket(bucket) {
  return bucket || LOCAL_FS_BUCKET;
}

/** A Node Readable / async-iterable body (not a Buffer, string or plain object). */
function isStreamBody(body) {
  return !!body && !Buffer.isBuffer(body) && typeof body !== "string" && typeof body[Symbol.asyncIterator] === "function";
}

/**
 * Stream a body to `target` through a sibling temp file, hashing as it goes, so
 * a 200 MB upload never sits in this process's memory and a stream that dies
 * midway leaves nothing behind (the temp is removed, the target never appears).
 */
async function localPutStream(target, key, bucket, body, contentType) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${crypto.randomUUID().slice(0, 12)}`;
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(tmp, "wx");
  try {
    for await (const chunk of body) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(b);
      await handle.write(b);
    }
    await handle.close();
    await fs.rename(tmp, target);
  } catch (err) {
    await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return { key, bucket: localBucket(bucket), etag: `"${hash.digest("hex").slice(0, 32)}"`, contentType };
}

async function localPutObject({ bucket, key, body, contentType, ifMatch = undefined, ifNoneMatch = undefined }) {
  const target = localPathFor(bucket, key);
  if (isStreamBody(body)) {
    // Conditional writes compare against the existing bytes and are only ever
    // small editor saves; a streamed body is an unconditional upload.
    if (ifMatch || ifNoneMatch) throw new Error("local-fs storage: conditional writes need a buffered body");
    return withLocalKeyLock(`${localBucket(bucket)}/${key}`, () => localPutStream(target, key, bucket, body, contentType));
  }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const write = async () => {
    if (ifMatch || ifNoneMatch) {
      const existing = await fs.readFile(target).catch(() => null);
      if (ifNoneMatch === "*" && existing) {
        throw new PreconditionFailedError(key, "object already exists");
      }
      if (ifMatch) {
        if (!existing) throw new PreconditionFailedError(key, "object does not exist");
        if (localEtag(existing) !== ifMatch) {
          throw new PreconditionFailedError(key, "etag mismatch");
        }
      }
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buf);
    // Content-addressed, not `local-<length>`: two different manifests of the
    // same length shared an etag, which made every CAS against this backend a
    // coin flip that usually said "unchanged".
    return { key, bucket: localBucket(bucket), etag: localEtag(buf), contentType };
  };
  // The lock key carries the bucket: two tenants can hold the same key, and
  // serialising them against each other would be wrong as well as slow.
  return withLocalKeyLock(`${localBucket(bucket)}/${key}`, write);
}

async function localGetObject({ bucket, key }) {
  const target = localPathFor(bucket, key);
  try {
    const buf = await fs.readFile(target);
    return {
      Body: buf,
      ContentLength: buf.length,
      ContentType: "application/octet-stream",
      // Callers compare-and-swap against this, so it has to be the same
      // function of the content that localPutObject checks.
      ETag: localEtag(buf)
    };
  } catch (err) {
    const e = new Error(`local-fs storage: object not found: ${key}`);
    e.cause = err;
    throw e;
  }
}

async function localDeleteObject({ bucket, key }) {
  return withLocalKeyLock(`${localBucket(bucket)}/${key}`, () => fs.rm(localPathFor(bucket, key), { force: true }));
}

async function localListObjectsByPrefix({ bucket, prefix, maxItems = 5000 }) {
  const root = path.join(LOCAL_FS_ROOT, localBucket(bucket));
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const key = path.relative(root, fullPath).split(path.sep).join("/");
        if (!prefix || key.startsWith(prefix)) {
          const stat = await fs.stat(fullPath).catch(() => null);
          if (stat) out.push({ key, sizeBytes: stat.size, etag: `local-${stat.size}` });
          if (out.length >= maxItems) return;
        }
      }
      if (out.length >= maxItems) return;
    }
  }
  await walk(root);
  return out;
}

async function localListCommonPrefixes({ bucket, prefix, delimiter = "/" }) {
  const list = await localListObjectsByPrefix({ bucket, prefix, maxItems: 1_000_000 });
  const out = new Set();
  for (const { key } of list) {
    const rest = key.slice(prefix.length);
    const cut = rest.indexOf(delimiter);
    if (cut === -1) continue;
    out.add(`${prefix}${rest.slice(0, cut + delimiter.length)}`);
  }
  return [...out].sort();
}

async function localDeletePrefix({ bucket, prefix }) {
  const list = await localListObjectsByPrefix({ bucket, prefix, maxItems: 100_000 });
  await Promise.all(list.map((obj) => localDeleteObject({ bucket, key: obj.key })));
}

async function localUseFallback() {
  if (LOCAL_FS_FORCED) return true;
  // Default: only use local-fs when no S3 config is reachable.
  if (await resolveDbConfig()) return false;
  if (getStorageConfigFromEnv()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Config — reads from DB (via injected resolver) with env var fallback
// ---------------------------------------------------------------------------

let _dbConfigResolver = null;
let _cachedDbConfig = null;
let _dbConfigFetchedAt = 0;
const DB_CONFIG_TTL_MS = 30_000;

/**
 * Inject a function that returns S3 settings from the database.
 * Call this once at startup from the app that has access to db-schema.
 * Signature: () => Promise<{ s3Endpoint, s3Bucket, s3AccessKey, s3SecretKey, s3Region }>
 */
export function setStorageConfigResolver(resolver) {
  _dbConfigResolver = resolver;
  _cachedDbConfig = null;
  _s3Client = null;
}

async function resolveDbConfig() {
  if (!_dbConfigResolver) return null;
  const now = Date.now();
  if (_cachedDbConfig && now - _dbConfigFetchedAt < DB_CONFIG_TTL_MS) {
    return _cachedDbConfig;
  }
  try {
    const settings = await _dbConfigResolver();
    if (settings?.s3Endpoint && settings?.s3Bucket && settings?.s3AccessKey && settings?.s3SecretKey) {
      _cachedDbConfig = {
        endpoint: String(settings.s3Endpoint).trim().replace(/\/+$/, ""),
        bucket: String(settings.s3Bucket).trim(),
        accessKeyId: String(settings.s3AccessKey).trim(),
        secretAccessKey: String(settings.s3SecretKey).trim(),
        region: String(settings.s3Region || "auto").trim()
      };
      _dbConfigFetchedAt = now;
      return _cachedDbConfig;
    }
  } catch { /* fall through to env vars */ }
  return null;
}

function getStorageConfigFromEnv() {
  const endpoint = String(process.env.S3_ENDPOINT || "").trim();
  const bucket = String(process.env.S3_BUCKET || "").trim();
  const accessKeyId = String(process.env.S3_ACCESS_KEY || "").trim();
  const secretAccessKey = String(process.env.S3_SECRET_KEY || "").trim();
  const region = String(process.env.S3_REGION || "auto").trim();

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey, region };
}

async function getStorageConfig() {
  const dbConfig = await resolveDbConfig();
  if (dbConfig) return dbConfig;

  const envConfig = getStorageConfigFromEnv();
  if (envConfig) return envConfig;

  throw new Error(
    "S3 storage is not configured. Set S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY environment variables or configure via Admin Panel."
  );
}

let _s3Client = null;
let _s3ClientConfigKey = "";
let _s3ClientOverride = null;

async function getS3Client() {
  if (_s3ClientOverride) return _s3ClientOverride;
  const config = await getStorageConfig();
  const key = `${config.endpoint}|${config.bucket}|${config.accessKeyId}`;
  if (_s3Client && _s3ClientConfigKey === key) return _s3Client;
  _s3Client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    },
    forcePathStyle: true,
    // SeaweedFS may advertise optional CRC32 response checksums with an
    // incorrect zero value. Keep required S3 checksum validation while
    // ignoring unsupported optional checksum headers.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED"
  });
  _s3ClientConfigKey = key;
  return _s3Client;
}

export async function isStorageConfigured() {
  try {
    await getStorageConfig();
    return true;
  } catch {
    // Local-fs fallback counts as configured for the caller's perspective.
    return await localUseFallback();
  }
}

/**
 * Diagnostic: which backend will operations use right now?
 * Returns "s3" or "local-fs" or "unavailable".
 */
export async function describeStorageBackend() {
  if (await localUseFallback()) return "local-fs";
  try { await getStorageConfig(); return "s3"; } catch { return "unavailable"; }
}

/**
 * The bucket a location names, resolved against this deployment.
 *
 * `loc.bucket === null` means "the configured default bucket" — a system
 * object, or a tenant that has not been migrated off the shared bucket. It is
 * resolved HERE, at call time, rather than baked into the location, so a
 * location built once stays correct if config is re-read.
 */
async function resolveBucket(loc) {
  if (loc.bucket) return loc.bucket;
  const config = await getStorageConfig();
  return config.bucket;
}

/**
 * Test seam: run the S3 code path against a stand-in client.
 *
 * It exists because the defect this module was fixed for lived exactly in the
 * `Bucket:` field of the commands built below, and a test that never builds a
 * command cannot see it. The local-fs backend proves tenants land on different
 * OBJECTS; this proves the S3 path puts the right BUCKET on the wire. Pass
 * `null` to restore normal behaviour.
 */
export function __setS3ClientForTests(client) {
  _s3ClientOverride = client;
  _s3Client = null;
  _s3ClientConfigKey = "";
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Write an object, optionally CONDITIONALLY.
 *
 *   ifMatch: "<etag>"  — write only if the object still has that etag
 *                        (compare-and-swap: the read-modify-write primitive).
 *   ifNoneMatch: "*"   — write only if the object does not exist (create-only,
 *                        i.e. acquire-a-lock semantics).
 *
 * A refused write throws `PreconditionFailedError` (or the SDK's
 * `PreconditionFailed`); use `isPreconditionFailed(err)` to catch both.
 * Verified against this deployment's SeaweedFS: both preconditions are
 * enforced server-side and a stale-etag PUT does not land.
 */
// The parameter shape is written out in JSDoc rather than left to be inferred
// from destructuring defaults. Inference gets it wrong in a way that only
// shows up at a TypeScript call site: `contentType = undefined` makes tsc infer
// the type AS `undefined`, so passing a real content type is an error, while
// omitting the default makes the property REQUIRED. Neither is what this
// signature means. Spelling it out also puts `at`'s requiredness in the type,
// so a bare key is refused by the compiler and not only at runtime.
/**
 * `contentLength` is required with a stream body on S3: PutObject cannot sign a
 * body of unknown length (and with requestChecksumCalculation WHEN_REQUIRED the
 * stream goes out as one plain PUT, not aws-chunked).
 *
 * One doc block only: TypeScript reads the LAST block before the function, so a
 * second comment above it silently dropped these parameter types (every caller's
 * `contentType` became `undefined` in the root typecheck).
 *
 * @param {{
 *   at: import("./location.mjs").ObjectLocation,
 *   body: any,
 *   contentType?: string,
 *   contentLength?: number,
 *   ifMatch?: string,
 *   ifNoneMatch?: string
 * }} params
 */
export async function putObject({ at, body, contentType = undefined, contentLength = undefined, ifMatch = undefined, ifNoneMatch = undefined }) {
  const loc = requireLocation(at, "putObject");
  if (await localUseFallback()) {
    return localPutObject({ bucket: loc.bucket, key: loc.key, body, contentType, ifMatch, ifNoneMatch });
  }
  const bucket = await resolveBucket(loc);
  const client = await getS3Client();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: loc.key,
    Body: body,
    ContentType: contentType || "application/octet-stream",
    ...(Number.isSafeInteger(contentLength) && contentLength >= 0 ? { ContentLength: contentLength } : {}),
    ...(ifMatch ? { IfMatch: ifMatch } : {}),
    ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {})
  });
  const result = await client.send(command);
  return { key: loc.key, bucket, etag: result.ETag || null };
}

/** @param {{ at: import("./location.mjs").ObjectLocation }} params */
export async function getObject({ at }) {
  const loc = requireLocation(at, "getObject");
  if (await localUseFallback()) return localGetObject({ bucket: loc.bucket, key: loc.key });
  const client = await getS3Client();
  const command = new GetObjectCommand({
    Bucket: await resolveBucket(loc),
    Key: loc.key
  });
  const result = await client.send(command);
  return result;
}

/**
 * Size of one object without reading it, or `null` when there is no object at
 * exactly that key. A directory-like key (`a/`) or a sibling with a longer name
 * (`a.txt.bak`) never answers for `a.txt` — unlike a prefix listing, whose
 * first hit depends on the backend's ordering.
 *
 * Only "not there" becomes `null`; any other failure (5xx, network) throws, so a
 * caller cannot read an outage as "the file does not exist".
 *
 * @param {{ at: import("./location.mjs").ObjectLocation }} params
 * @returns {Promise<{ sizeBytes: number, etag: string|null, lastModified: Date|null } | null>}
 */
export async function headObject({ at }) {
  const loc = requireLocation(at, "headObject");
  if (await localUseFallback()) {
    const st = await fs.stat(localPathFor(loc.bucket, loc.key)).catch((err) => {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
      throw err;
    });
    return st && st.isFile() ? { sizeBytes: st.size, etag: `local-${st.size}`, lastModified: st.mtime } : null;
  }
  const client = await getS3Client();
  try {
    const r = await client.send(new HeadObjectCommand({ Bucket: await resolveBucket(loc), Key: loc.key }));
    return { sizeBytes: Number(r.ContentLength || 0), etag: r.ETag || null, lastModified: r.LastModified || null };
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404 || err?.name === "NotFound" || err?.name === "NoSuchKey") return null;
    throw err;
  }
}

/** @param {{ at: import("./location.mjs").ObjectLocation }} params */
export async function deleteObject({ at }) {
  const loc = requireLocation(at, "deleteObject");
  if (await localUseFallback()) return localDeleteObject({ bucket: loc.bucket, key: loc.key });
  const client = await getS3Client();
  const command = new DeleteObjectCommand({
    Bucket: await resolveBucket(loc),
    Key: loc.key
  });
  await client.send(command);
}

/**
 * List object keys + sizes under a prefix, paginating internally.
 *
 * `at` is a location whose KEY is read as the prefix — the same value type as
 * every other operation, so a listing cannot be scoped to one tenant's prefix
 * while pointed at another tenant's bucket.
 *
 * Returns: Array<{ key: string, sizeBytes: number, etag?: string }>
 */
/** @param {{ at: import("./location.mjs").ObjectLocation, maxItems?: number }} params */
export async function listObjectsByPrefix({ at, maxItems = 5000 }) {
  const loc = requireLocation(at, "listObjectsByPrefix");
  if (await localUseFallback()) {
    return localListObjectsByPrefix({ bucket: loc.bucket, prefix: loc.key, maxItems });
  }
  const bucket = await resolveBucket(loc);
  const client = await getS3Client();
  const out = [];
  let continuationToken;
  do {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: loc.key,
      ContinuationToken: continuationToken
    });
    const result = await client.send(listCommand);
    for (const obj of result.Contents || []) {
      out.push({
        key: obj.Key,
        sizeBytes: Number(obj.Size || 0),
        etag: obj.ETag || null
      });
      if (out.length >= maxItems) return out;
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return out;
}

/**
 * List the immediate "directories" under `at`'s key, read as a prefix — S3's
 * CommonPrefixes — inside `at`'s bucket.
 *
 * Enumerating tenants by walking every object under `users/` is both slow and
 * DANGEROUS for a migration: the walk is capped, so a bucket bigger than the cap
 * would silently report "nothing left to migrate" while owners went untouched. A
 * delimiter listing returns one entry per owner regardless of how many objects
 * they hold, so the enumeration is complete by construction.
 *
 * Takes a LOCATION like every other operation here: an enumeration is only
 * complete relative to a bucket, and "the configured default" is a claim the
 * caller has to make out loud (`systemLocation`) rather than inherit from a
 * hardcoded `config.bucket`. Under SANDBOX_ISOLATED_TENANTS the default bucket
 * holds only the tenants that were never moved off it, and a walk that assumed
 * otherwise would report "nothing left to migrate" for exactly the owners it
 * cannot see.
 *
 * Returns fully-qualified prefixes WITH the trailing delimiter, e.g.
 * `["users/abc/", "users/def/"]`.
 *
 * @param {{ at: import("./location.mjs").ObjectLocation, delimiter?: string }} params
 */
export async function listCommonPrefixes({ at, delimiter = "/" }) {
  const loc = requireLocation(at, "listCommonPrefixes");
  if (await localUseFallback()) {
    return localListCommonPrefixes({ bucket: loc.bucket, prefix: loc.key, delimiter });
  }
  const bucket = await resolveBucket(loc);
  const client = await getS3Client();
  const out = new Set();
  let continuationToken;
  do {
    const result = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: loc.key,
      Delimiter: delimiter,
      ContinuationToken: continuationToken
    }));
    for (const cp of result.CommonPrefixes || []) {
      if (cp?.Prefix) out.add(cp.Prefix);
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return [...out].sort();
}

/**
 * ONE LEVEL of the tree: the files directly under `at`'s key, plus the
 * immediate child prefixes — from the same delimiter listing.
 *
 * ## 為什麼需要它，而 `listObjectsByPrefix` 不夠
 *
 * 那一支是**扁平**的：它把子樹裡每一個鍵都拉回來，然後由呼叫端過濾。於是
 * 「不要看 node_modules」這種規則變成**列完之後**才生效，而上限是**列的時候**
 * 生效的 —— 一個有兩萬個 node_modules 鍵的工作區，5000 個鍵的預算會全部花在
 * 那裡面，字典序排在它後面的每一個檔案都安靜消失。
 *
 * 實測 2026-09-16：同一個工作區、同一秒、同一個寫入呼叫，
 * `aaa-order-probe.md` 看得到、`zzz-order-probe.md` 看不到 —— 唯一的差別是
 * 檔名排在 `ava-e2e/`（那個放著 node_modules 的資料夾）前面還是後面。
 *
 * `listCommonPrefixes` 的註解早就把這條原則寫對了：「上限會讓比上限大的 bucket
 * 安靜回報『沒有東西了』…delimiter 列舉在構造上就是完整的」。這棵樹在那裡學到
 * 了，在扁平那一支沒有。這支函式把同一條原則給需要**邊走邊決定要不要下去**的
 * 呼叫端。
 *
 * `truncated` 是刻意回報的：一個把東西藏起來的上限，跟一個說出來的上限，是兩
 * 件不同的事。
 *
 * ## `subPrefix` 為什麼是一個參數，而不是讓呼叫端自己換 location 的 key
 *
 * 走樹的時候每一層都要一個更深的前綴。呼叫端最順手的寫法是 `{ ...at, key }` ——
 * 而那會**繞過 `objectLocation` 的驗證**（它是 branded + frozen 的，展開會把
 * brand 一起抄走，於是 `requireLocation` 放它過）。`location.mjs` 整份存在的
 * 理由就是「bucket 跟 key 必須由同一個 owner 推出來，不能各說各話」。
 *
 * 所以子前綴是**資料**：bucket 仍然來自那個鑄造過的根 location，而路徑是這次
 * 列舉自己回報的子前綴。沒有第二個地方在組 location。
 *
 * @param {{ at: import("./location.mjs").ObjectLocation, subPrefix?: string, delimiter?: string, maxItems?: number }} params
 * @returns {Promise<{ files: Array<{key: string, sizeBytes: number, etag: string|null}>, prefixes: string[], truncated: boolean }>}
 */
export async function listLevel({ at, subPrefix = "", delimiter = "/", maxItems = 5000 }) {
  const loc = requireLocation(at, "listLevel");
  const sub = String(subPrefix || "");
  if (sub.startsWith("/") || sub.includes("..")) {
    throw new TypeError(`listLevel: subPrefix must be a relative path without "..", got ${JSON.stringify(sub)}`);
  }
  const listPrefix = `${loc.key}${sub}`;
  if (await localUseFallback()) {
    return localListLevel({ bucket: loc.bucket, prefix: listPrefix, delimiter, maxItems });
  }
  const bucket = await resolveBucket(loc);
  const client = await getS3Client();
  const files = [];
  const prefixes = new Set();
  let continuationToken;
  do {
    const result = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: listPrefix,
      Delimiter: delimiter,
      ContinuationToken: continuationToken,
    }));
    for (const cp of result.CommonPrefixes || []) {
      if (cp?.Prefix) prefixes.add(cp.Prefix);
    }
    for (const obj of result.Contents || []) {
      files.push({ key: obj.Key, sizeBytes: Number(obj.Size || 0), etag: obj.ETag || null });
      if (files.length >= maxItems) return { files, prefixes: [...prefixes].sort(), truncated: true };
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return { files, prefixes: [...prefixes].sort(), truncated: false };
}

async function localListLevel({ bucket, prefix, delimiter = "/", maxItems = 5000 }) {
  // 本機備援沒有 delimiter，所以自己切。這裡不受上限那個缺陷影響（它是全量掃
  // 本機檔案系統），但要回一樣的形狀，否則兩條路徑會對「有哪些子資料夾」有
  // 兩種答案。
  const list = await localListObjectsByPrefix({ bucket, prefix, maxItems: 1_000_000 });
  const files = [];
  const prefixes = new Set();
  for (const obj of list) {
    const rest = obj.key.slice(prefix.length);
    const cut = rest.indexOf(delimiter);
    if (cut === -1) {
      if (files.length < maxItems) files.push(obj);
      continue;
    }
    prefixes.add(`${prefix}${rest.slice(0, cut + delimiter.length)}`);
  }
  return { files, prefixes: [...prefixes].sort(), truncated: files.length >= maxItems };
}

/** Delete everything under `at`'s key, read as a prefix, in `at`'s bucket. */
/** @param {{ at: import("./location.mjs").ObjectLocation }} params */
export async function deletePrefix({ at }) {
  const loc = requireLocation(at, "deletePrefix");
  if (await localUseFallback()) return localDeletePrefix({ bucket: loc.bucket, prefix: loc.key });
  const bucket = await resolveBucket(loc);
  const client = await getS3Client();

  let continuationToken;
  do {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: loc.key,
      ContinuationToken: continuationToken
    });
    const listResult = await client.send(listCommand);
    const objects = listResult.Contents || [];

    if (objects.length > 0) {
      const deleteCommand = new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: objects.map((obj) => ({ Key: obj.Key })),
          Quiet: true
        }
      });
      await client.send(deleteCommand);
    }

    continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * A time-limited URL for one object. Takes the same location as the write, so
 * a URL is never signed against a different bucket than the bytes went to —
 * which would produce a link that 404s for exactly the tenants that have been
 * isolated, i.e. the ones hardest to test.
 */
/** @param {{ at: import("./location.mjs").ObjectLocation, expiresIn?: number }} params */
export async function getSignedUrl({ at, expiresIn = 3600 }) {
  const loc = requireLocation(at, "getSignedUrl");
  const client = await getS3Client();
  const command = new GetObjectCommand({
    Bucket: await resolveBucket(loc),
    Key: loc.key
  });
  return awsGetSignedUrl(client, command, { expiresIn });
}

/**
 * Reachability probe for ONE bucket. Takes a location because "which bucket"
 * is now a real question: a deployment mid-migration has a shared bucket and N
 * tenant buckets, and "the store is up" is only ever true of one of them at a
 * time. Pass `systemLocation("<probe key>")` to probe the default bucket.
 */
/** @param {{ at: import("./location.mjs").ObjectLocation }} params */
export async function headBucket({ at }) {
  const loc = requireLocation(at, "headBucket");
  const client = await getS3Client();
  const command = new HeadBucketCommand({ Bucket: await resolveBucket(loc) });
  await client.send(command);
}

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

export function buildDocumentAssetKey({ knowledgeBaseId, documentId, filename }) {
  return `${knowledgeBaseId}/${documentId}/${filename}`;
}

export function buildPageImageKey({ knowledgeBaseId, documentId, pageIndex }) {
  return `${knowledgeBaseId}/${documentId}/pages/${pageIndex}.png`;
}
