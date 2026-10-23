/**
 * workspace/tenant-store.mjs — where one tenant's bytes live: (bucket, prefix).
 *
 * WHY A BUCKET AND NOT A PREFIX. Every tenant is a prefix inside one bucket
 * today (`users/<id>/workspace`, `groups/…`, `orgs/…`), and one S3 credential
 * with `Admin` over the whole store reaches all of them. Scoping a credential
 * to a tenant is the fix, and MEASURED against SeaweedFS 4.41 the only unit it
 * scopes to is the BUCKET:
 *
 *   identity actions `Read:bucket/users/a`  → denies EVERYTHING, its own
 *                                             prefix included; the path is
 *                                             read as a bucket name
 *   identity actions `Read:bucket`          → that identity reads, writes and
 *                                             lists every OTHER tenant's
 *                                             objects in the same bucket
 *   identity actions `Read:ws-a` / `Read:ws-b`
 *                                           → isolated; each is AccessDenied
 *                                             on the other's bucket
 *
 * Bucket POLICIES are a near miss worth recording, because they look like they
 * solve it. SeaweedFS accepts one, and it really does enforce a prefix
 * `Resource` — but only with `Principal: "*"`. A named principal (`t1`,
 * `arn:aws:iam::t1:user/t1`) matches nothing and denies that identity
 * everything. A principal-blind policy cannot say "t1 may read users/t1 and t2
 * may read users/t2", so one bucket cannot express per-tenant rules.
 *
 * SO THE DATA HAS TO MOVE, and it is a copy rather than a rename — also
 * measured, and the reason is not obvious:
 *
 *   weed shell mv /buckets/shared/users/tX /buckets/ws-tX
 *     → error: can not move across collection shared =>
 *
 * A SeaweedFS bucket is also a storage COLLECTION, so promoting a tenant's
 * directory to its own bucket crosses collections and the filer refuses. The
 * migration is a real copy-then-delete.
 *
 * WHAT THIS MODULE IS FOR. The move is staged per tenant, and this is the one
 * place that answers "which bucket and prefix is this tenant on right now".
 * Pure, so both answers are testable without a store, and so the legacy answer
 * can be proven byte-identical to what shipped before — a resolver that
 * silently changed the personal path would strand every existing workspace.
 */

import { objectLocation } from "../../../../packages/storage-engine/src/location.mjs";

import { SandboxError } from "../shared/error.mjs";

/** Prefix on the per-tenant bucket name. Keeps tenant buckets sortable and
 *  distinguishable from anything else that shares the store. */
export const TENANT_BUCKET_PREFIX = "ws";

/**
 * S3 bucket naming, the subset that matters here: 3–63 chars, lowercase
 * letters/digits/hyphens, must start and end alphanumeric. Checked rather than
 * assumed — an id that produced an INVALID name would fail at the store with a
 * message about bucket syntax, long after the point where the tenant could
 * have been told their id is unusable.
 */
const BUCKET_NAME_OK = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** The owner kinds the app can present. `user` is personal; the others shared. */
const KINDS = new Set(["user", "group", "org"]);

/**
 * Parse `x-workspace-owner` into `{kind, id}`.
 *
 * The colon form is produced only by the trusted app, and a bare value is a
 * legacy personal userId. Kept identical to `userPrefix`'s reading of it, in
 * one function, so the two cannot drift into disagreeing about who a request
 * belongs to.
 */
export function parseOwner(owner) {
  const s = String(owner ?? "");
  const colon = s.indexOf(":");
  if (colon !== -1) {
    const kind = s.slice(0, colon);
    const id = s.slice(colon + 1);
    if (KINDS.has(kind) && id) return { kind, id };
  }
  return { kind: "user", id: s };
}

/**
 * The bucket a tenant gets once it is isolated.
 *
 * Lowercased, because S3 bucket names are: an id differing only in case would
 * otherwise silently share a bucket with another tenant. That is the one
 * transformation here, and it is why `id` is also checked for characters a
 * bucket name cannot carry — an id containing `_` or `/` must be REFUSED
 * rather than mangled into something that might collide.
 */
export function tenantBucketName({ kind, id }) {
  const raw = `${TENANT_BUCKET_PREFIX}-${kind}-${String(id ?? "")}`.toLowerCase();
  if (!BUCKET_NAME_OK.test(raw)) {
    throw new SandboxError(
      "bad_request",
      `cannot derive a bucket name for owner ${kind}:${id} — "${raw}" is not a valid S3 bucket name ` +
        `(3-63 chars, lowercase letters, digits and hyphens, starting and ending alphanumeric)`,
      400,
    );
  }
  return raw;
}

/**
 * Could `tenantBucketName` have produced this name? `ws-<kind>-<id>` with a known
 * kind and a non-empty id, under the same S3 naming rule.
 *
 * For HOST-side code that has no owner to resolve (2026-09-26, F-GRP): the
 * isolation check must find every tenant root under the mount
 * (cube/host-filer-exposure.mjs), and the premounted runtime must decide whether
 * a bucket root belongs to exactly one tenant before it fences it
 * (cube/host-mount.mjs, which ALSO requires a single-segment subpath — a name is
 * not proof of isolation, see `resolveTenantStore`). Kept here so the naming
 * rule has one home.
 */
export function isTenantBucketName(name) {
  const s = String(name ?? "");
  if (!BUCKET_NAME_OK.test(s)) return false;
  for (const kind of KINDS) {
    const head = `${TENANT_BUCKET_PREFIX}-${kind}-`;
    if (s.startsWith(head) && s.length > head.length) return true;
  }
  return false;
}

/**
 * The legacy location: one shared bucket, the tenant as a prefix.
 *
 * This must keep returning exactly what `userPrefix` returned before this
 * module existed. It is asserted against literal strings in the tests rather
 * than against a re-derivation, because a resolver and the thing it replaced
 * agreeing by construction proves nothing about the paths already on disk.
 */
export function legacyPrefix(owner) {
  const { kind, id } = parseOwner(owner);
  if (kind === "group" && id) return `groups/${id}/workspace`;
  if (kind === "org" && id) return `orgs/${id}/workspace`;
  return `users/${id}/workspace`;
}

/**
 * Which tenants have been moved. `"all"` or a comma-separated list of
 * `kind:id` (or a bare userId, read as `user:`).
 *
 * An allowlist rather than a boolean because the migration is per tenant and
 * takes a copy each time: a deployment is mid-migration for as long as it
 * takes, and during that window some tenants answer from their own bucket and
 * the rest from the shared one. A single switch would demand the whole copy be
 * atomic, which for 20 tenants of unknown size it is not.
 */
export function isolatedOwners(env = process.env) {
  const raw = String(env?.SANDBOX_ISOLATED_TENANTS ?? "").trim();
  if (!raw) return { all: false, set: new Set() };
  if (raw.toLowerCase() === "all") return { all: true, set: new Set() };
  const set = new Set();
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const { kind, id } = parseOwner(entry);
    set.add(`${kind}:${id}`);
  }
  return { all: false, set };
}

/**
 * Where this tenant's bytes are, right now.
 *
 * `isolated` is returned rather than inferred from the bucket by the caller:
 * "is this tenant on its own bucket" decides which CREDENTIAL to use, and a
 * caller working that out by string-comparing bucket names would get it wrong
 * the first time a deployment names its shared bucket something ws-shaped.
 */
export function resolveTenantStore(owner, { legacyBucket, env = process.env } = {}) {
  const shared = String(legacyBucket ?? env?.S3_BUCKET ?? "").trim();
  if (!shared) {
    throw new SandboxError("config_error", "no S3 bucket configured (S3_BUCKET)", 500);
  }
  const { prefix, isolated, owner: parsed } = tenantPrefix(owner, env);
  return { bucket: isolated ? tenantBucketName(parsed) : shared, prefix, isolated, owner: parsed };
}

/**
 * The PREFIX half, without the bucket — and therefore without needing any
 * bucket configured.
 *
 * Split out because folding the two together broke a caller: `userPrefix` has
 * always been a pure path function, and routing it through the full resolver
 * made it demand `S3_BUCKET`, which every workspace unit test then failed on.
 * Two questions that happen to be answered together are still two questions,
 * and only one of them needs the deployment's storage config.
 */
export function tenantPrefix(owner, env = process.env) {
  const parsed = parseOwner(owner);
  const { all, set } = isolatedOwners(env);
  const isolated = all || set.has(`${parsed.kind}:${parsed.id}`);
  return { prefix: isolated ? "workspace" : legacyPrefix(owner), isolated, owner: parsed };
}

/**
 * The tenant's SUBTREE root in the shared bucket — the parent of `workspace`.
 *
 * `workspace/` is not all of a tenant, and assuming it was is what made the
 * first migration incomplete. Measured on the live store, one tenant had 166
 * objects under `workspace/` and 526 under `.snapshots/` — 9.2 MB of version
 * history that docker.mjs bind-mounts into every sandbox as `/snapshots`. A
 * copy scoped to the workspace prefix leaves it behind and reports a confident
 * count of the part it looked at.
 *
 * Derived by stripping the known suffix off `legacyPrefix` rather than
 * re-assembling the path, so the two cannot disagree about where a tenant
 * lives — the test asserts `legacyPrefix === legacyTenantRoot + "/workspace"`
 * for every kind.
 */
export function legacyTenantRoot(owner) {
  const prefix = legacyPrefix(owner);
  const suffix = "/workspace";
  if (!prefix.endsWith(suffix)) {
    throw new SandboxError(
      "config_error",
      `legacyPrefix(${owner}) is "${prefix}", which does not end in "${suffix}" — the two have drifted`,
      500,
    );
  }
  return prefix.slice(0, -suffix.length);
}

/**
 * Where the tenant's whole subtree lives, isolated or not.
 *
 * For an isolated tenant the answer is `""`: the bucket ITSELF is the tenant's
 * root, so `workspace` and `.snapshots` sit in it as siblings — the shared
 * layout with `users/<id>/` removed, rather than a different shape. That is
 * what lets `docker.mjs` derive the snapshot mount the same way in both.
 *
 * Takes no bucket, for the same reason `tenantPrefix` does not.
 */
export function tenantRoot(owner, env = process.env) {
  const { isolated, owner: parsed } = tenantPrefix(owner, env);
  return { root: isolated ? "" : legacyTenantRoot(owner), isolated, owner: parsed };
}

// ---------------------------------------------------------------------------
// LOCATIONS — the only sanctioned way to address a tenant's bytes.
//
// `resolveTenantStore` above returns the two halves as separate fields, which
// is what a MOUNT needs (docker.mjs wants a bucket and a subpath to hand to
// the filesystem). The STORE must not be given them separately: a bucket and a
// key as two values can be crossed, and the first version of this system
// crossed them by simply never passing the bucket at all. So everything below
// returns ONE value carrying both, derived from ONE owner argument, so there
// is no expressible way to pair tenant A's bucket with tenant B's key.
// ---------------------------------------------------------------------------

/**
 * A location under this tenant's WORKSPACE prefix.
 *
 * The caller supplies a path RELATIVE to the workspace root and never the
 * prefix, so the prefix and the bucket are both derived from the same `owner`
 * in the same call. That is what makes the cross-tenant pairing impossible
 * rather than merely discouraged.
 *
 * `relPath` empty → the workspace SUBTREE, keyed with a trailing slash, which
 * is what a listing or a prefix-delete wants. The slash is load-bearing: the
 * bare prefix `workspace` also matches `workspace-backup/...`, so dropping it
 * would silently widen every listing to a sibling subtree.
 *
 * Traversal is refused here as well as in `userStore.fileKey`, because this is
 * now a second door onto the same keys and a guard on only one door is a guard
 * on neither.
 */
export function tenantWorkspaceLocation(owner, relPath = "", env = process.env) {
  const { prefix, isolated, owner: parsed } = tenantPrefix(owner, env);
  const rel = String(relPath ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (rel === "." || rel === ".." || rel.split("/").some((seg) => seg === "..")) {
    throw new SandboxError("bad_request", `invalid workspace path "${relPath}"`, 400);
  }
  return objectLocation({
    bucket: isolated ? tenantBucketName(parsed) : null,
    key: rel ? `${prefix}/${rel}` : `${prefix}/`,
    scope: "tenant",
    describedBy: `${parsed.kind}:${parsed.id}`,
  });
}

/**
 * A location in this tenant's bucket at a caller-composed key.
 *
 * Weaker than `tenantWorkspaceLocation` — the key is not derived from the
 * owner, so it is the caller's job to keep it tenant-specific — and it exists
 * for the one real case that is tenant data OUTSIDE the workspace tree:
 * `artifacts/persist.mjs`, whose keys are
 * `cm-agent-artifacts/<uid>/<sid>/<ulid>/<name>`. Reach for the workspace
 * constructor unless the key genuinely cannot live under `workspace/`.
 */
export function tenantObjectLocation(owner, key, env = process.env) {
  const { isolated, owner: parsed } = tenantPrefix(owner, env);
  return objectLocation({
    bucket: isolated ? tenantBucketName(parsed) : null,
    key,
    scope: "tenant",
    describedBy: `${parsed.kind}:${parsed.id}`,
  });
}
