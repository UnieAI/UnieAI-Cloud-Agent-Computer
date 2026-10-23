/**
 * storage-engine/location.mjs — an object's ADDRESS: bucket and key, together.
 *
 * WHY THIS TYPE EXISTS. Every store operation used to take a bare `key` and
 * hardcode `Bucket: config.bucket`. That is fine while every tenant is a prefix
 * in one bucket, and silently destructive the moment one is not: with
 * `SANDBOX_ISOLATED_TENANTS` set, a tenant's prefix COLLAPSES from
 * `users/<id>/workspace` to `workspace` (the per-tenant BUCKET is meant to
 * carry the identity the prefix drops). Two isolated tenants then write the
 * identical key into the identical bucket, and the second overwrites the first
 * — measured, across a tenant boundary, with no error anywhere.
 *
 * The fix is not "add a bucket parameter". A parameter can be omitted, and the
 * default it falls back to is precisely the destructive answer. So the two
 * halves are welded into ONE value that only a resolver can mint, and the
 * store REQUIRES it: there is no way to name an object without also having
 * said which bucket it is in.
 *
 * SHAPES REJECTED, and why:
 *
 *   · `putObject({ key, bucket })` with `bucket` defaulting to config —
 *     forgetting it stays legal and lands you back on the shared bucket. It
 *     makes the bug harder to write, not impossible, and reviewers cannot see
 *     an omission.
 *
 *   · `putObject({ key, bucket })` with `bucket` REQUIRED but a plain string —
 *     better, but the bucket and the key are then two independent values, so
 *     `{ bucket: tenantA.bucket, key: tenantB.key }` typechecks and runs. The
 *     cross-tenant mistake this whole change exists to prevent is still one
 *     transposed variable away.
 *
 *   · A bucket-bound client: `storeFor(owner).putObject({ key })` — same gap.
 *     `storeFor(a).putObject({ key: keyFor(b) })` is well-typed. It also
 *     doubles the API surface and gives every caller a handle it can stash and
 *     reuse for the wrong tenant later.
 *
 *   · Resolving the bucket INSIDE the store from an `owner` argument — the
 *     store would then have to know about tenants, owner-kind parsing and the
 *     isolation allowlist, which is sandbox-runtime's domain, and the
 *     storage-engine package is also used for objects that have no owner at
 *     all (plugin bundles). It would have to invent a "no owner" default,
 *     which is the first rejected shape wearing a different hat.
 *
 * What is left: a branded, frozen `(bucket, key)` pair, minted by one of the
 * constructors below, each of which names WHO the object belongs to at the
 * point of construction. A caller that has no tenant must say so out loud by
 * calling `systemLocation`, which greps for and reviews as a claim.
 *
 * `bucket: null` means "this deployment's configured default bucket" — which
 * backend-dependently is `S3_BUCKET` or the local-fs bucket. It is NOT an
 * omission: it is the correct answer for a system object and for a tenant that
 * has not been migrated off the shared bucket, and the store resolves it at
 * call time rather than freezing config into the value.
 */

/**
 * Symbol.for, not a fresh Symbol: sandbox-runtime resolves this package
 * through a relative path from two different app roots, and if the module ever
 * loads twice a private symbol would make each copy reject the other's
 * locations at runtime, in production, for reasons invisible in the code.
 */
const LOCATION_BRAND = Symbol.for("unieai.storage-engine.ObjectLocation");

/** The kinds of thing a location can address; carried for error messages and
 *  so a store operation can report WHOSE object it refused. */
const SCOPES = new Set(["tenant", "system"]);

/**
 * @typedef {Object} ObjectLocation
 * @property {string|null} bucket the bucket, or null for "this deployment's default"
 * @property {string} key the object key (read as a PREFIX by list/deletePrefix)
 * @property {"tenant"|"system"} scope who the object belongs to
 * @property {string} describedBy the owner or the reason, for logs and errors
 */

/**
 * S3 bucket naming, the subset that matters: 3–63 chars, lowercase
 * letters/digits/hyphens, starting and ending alphanumeric. Checked here so a
 * malformed bucket is refused where it is CONSTRUCTED, with the owner still in
 * scope, rather than surfacing later as an opaque SDK error on a request whose
 * origin has been lost.
 */
const BUCKET_NAME_OK = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * Mint a location. Not exported as the general-purpose constructor by
 * accident: `scope` is required, so every call site states whether this is a
 * tenant's object or a deployment-wide one.
 *
 * @param {{ bucket?: string|null, key: string, scope: "tenant"|"system", describedBy?: string }} spec
 * @returns {ObjectLocation}
 */
export function objectLocation({ bucket = null, key, scope, describedBy = "" }) {
  if (!SCOPES.has(scope)) {
    throw new TypeError(
      `objectLocation: scope must be one of ${[...SCOPES].join("|")}, got ${JSON.stringify(scope)}`,
    );
  }
  const k = String(key ?? "");
  if (!k) throw new TypeError("objectLocation: key is required and must be a non-empty string");
  if (k.startsWith("/")) {
    throw new TypeError(`objectLocation: key must not start with "/" (got ${JSON.stringify(k)})`);
  }
  let b = null;
  if (bucket !== null && bucket !== undefined) {
    b = String(bucket).trim();
    if (!BUCKET_NAME_OK.test(b)) {
      throw new TypeError(
        `objectLocation: ${JSON.stringify(b)} is not a valid S3 bucket name ` +
          `(3-63 chars, lowercase letters, digits and hyphens, starting and ending alphanumeric)`,
      );
    }
  }
  return Object.freeze({
    [LOCATION_BRAND]: true,
    bucket: b,
    key: k,
    scope,
    describedBy: String(describedBy || (scope === "system" ? "system" : "tenant")),
  });
}

/**
 * An object that belongs to NO tenant — plugin bundles, deployment-wide
 * indexes, health probes. Lives in the configured default bucket.
 *
 * This is the ONLY sanctioned way to reach the shared bucket without naming an
 * owner, and it is deliberately a spelled-out call rather than a default, so
 * "this object crosses no tenant boundary" is an assertion someone made and a
 * reviewer can search for, instead of the silence left by an omitted argument.
 *
 * @param {string} key
 * @param {string} [why] short note on why this object has no tenant
 * @returns {ObjectLocation}
 */
export function systemLocation(key, why = "") {
  return objectLocation({ bucket: null, key, scope: "system", describedBy: why || "system" });
}

/** True for a value minted by the constructors above. */
export function isObjectLocation(value) {
  return Boolean(value) && typeof value === "object" && value[LOCATION_BRAND] === true;
}

/** Human-readable, for logs and errors: `bucket/key` (or `<default>/key`). */
export function formatLocation(loc) {
  if (!isObjectLocation(loc)) return String(loc);
  return `${loc.bucket ?? "<default-bucket>"}/${loc.key}`;
}

/**
 * Gate for every store operation. Rejects anything that is not a minted
 * location — including, with a pointed message, the old `{ key: "..." }` shape,
 * because that is the exact call that used to compile, run, and overwrite
 * another tenant's file.
 *
 * @param {unknown} at
 * @param {string} op
 * @returns {ObjectLocation}
 */
export function requireLocation(at, op) {
  if (isObjectLocation(at)) return /** @type {ObjectLocation} */ (at);
  const sawBareKey =
    Boolean(at) && typeof at === "object" && typeof (/** @type {any} */ (at).key) === "string";
  throw new TypeError(
    `${op}: \`at\` must be an ObjectLocation carrying BOTH a bucket and a key` +
      (sawBareKey
        ? ` — you passed a bare key (${JSON.stringify(/** @type {any} */ (at).key)}). A key alone ` +
          `does not say which bucket it is in, and defaulting to the shared bucket is how two ` +
          `isolated tenants overwrite each other. Build it with tenantWorkspaceLocation(owner, relPath) ` +
          `/ tenantObjectLocation(owner, key), or systemLocation(key) if this object has no tenant.`
        : `, minted by tenantWorkspaceLocation / tenantObjectLocation / systemLocation. Got ${
            at === undefined ? "undefined" : JSON.stringify(at)
          }.`),
  );
}
