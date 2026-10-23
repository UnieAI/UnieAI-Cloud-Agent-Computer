/**
 * cube/s3-credentials.mjs — whether a sandbox receives the object-store
 * credential. ONE rule, ONE implementation, both backends.
 *
 * Extracted from docker.mjs when the CubeMaster backend (client.mjs) needed the
 * same switch. This repo has been bitten more than once by a single rule living
 * in two places and only one copy getting fixed; the credential policy is
 * exactly the kind of rule where the second copy drifting is a security hole,
 * so it lives here and both `buildContainerEnv` (docker) and
 * `deriveWorkspaceEnv` / `createSandbox` (cube) call in.
 *
 * What is NOT shared: how each backend composes the rest of the env block. The
 * docker path derives bucket/subpath from workspaceMode+owner and lets the
 * workspace coordinates win over callerEnv; the cube path derives them from the
 * mount path and lets caller envVars win. Those differ on purpose and merging
 * them would be a bigger, riskier change than the one this module exists for.
 */

// Every env var that carries the shared object-store credential into a sandbox,
// including the aliases entrypoint.sh derives from it. Listed explicitly
// because "omit" has to strip what a CALLER might smuggle in, not just what we
// would otherwise add.
export const S3_CREDENTIAL_ENV_VARS = [
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];

// THE PROBLEM (measured 2026-09-05). The seaweedfs identity config in
// uac2-seaweedfs (/etc/seaweedfs/s3.json) has exactly ONE identity, with
// actions ["Admin","Read","Write","List","Tagging"] — no bucket, no prefix
// restriction. `Identity.CanDo` in weed/s3api/auth_credentials.go short-circuits
// on a bare "Admin", so that key can read, write or delete anything in the
// store. It was injected into EVERY sandbox as S3_ACCESS_KEY / S3_SECRET_KEY,
// where a model running bash can simply read its own environment. Confirmed
// exploitable end-to-end: a process in a real cm-agent-sandbox container, given
// only those two vars, signed a SigV4 ListBuckets against the gateway and got
// every bucket back, while an unauthenticated request from the same container
// got 403. WORKSPACE_PATH scoped where the agent should look; the credential
// did not scope what it could reach.
//
// The exploit was measured on the docker backend, but the exposure is the
// backend-independent part: BOTH backends boot the same cm-agent-sandbox image
// (#61) and both hand it the same env block — docker via `docker run -e`, cube
// via the CubeMaster create-sandbox request body (`envVars`). On the cube path
// the credential additionally crosses the control-plane API on its way in.
//
// WHY "omit" IS THE FIX AND NOT A PROXY OR PER-TENANT KEYS. Reading the image
// rather than its README: nothing in the sandbox consumes these vars.
// entrypoint.sh's sole use is re-exporting them as AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY "for any tooling that needs them" — and the image ships
// no such tooling (aws, s3cmd, mc, rclone, boto3 and any aws-sdk are all
// absent). `weed mount` authenticates to the FILER over gRPC, not to S3;
// /workspace was mounted successfully against the live filer with no S3
// credential in the environment at all, and entrypoint.sh already documents
// blank as a supported "anonymous" case. So the credential is pure liability:
// it grants everything and is used for nothing. Removing it is strictly smaller
// than either minting per-tenant prefix-scoped identities (which seaweedfs 4.41
// does support via /etc/iam/identities/<name>.json + hot reload, but which adds
// a key lifecycle, a revocation path, and the sibling-prefix footgun where
// "Read:bucket/t1*" also grants "bucket/t1-secret") or proxying file traffic
// through sandbox-runtime.
//
// DEFAULTS TO "inject" — i.e. to TODAY'S BEHAVIOUR — deliberately, on both
// backends. This is a live data path and the owner is not deploying the change
// in this pass. Flip with SANDBOX_S3_CREDENTIALS=omit.
export const S3_CREDENTIAL_MODE_OMIT = "omit";

/**
 * True only for an exact (whitespace- and case-insensitive) "omit".
 *
 * Anything else — unset, empty, "inject", a typo — keeps today's behaviour. A
 * misspelled env must not silently strip credentials from every sandbox in the
 * fleet; the reversible direction is the one we default to.
 */
export function isS3CredentialOmitMode(mode) {
  return String(mode ?? "").trim().toLowerCase() === S3_CREDENTIAL_MODE_OMIT;
}

/**
 * Remove every credential alias from a copy of `env`. Strip, not skip: the
 * caller-supplied part of an env block is merged in by both backends, so
 * without this a caller (or a compromised upstream) could reintroduce the very
 * credential the operator withheld.
 */
export function stripS3Credentials(env) {
  const out = { ...(env || {}) };
  for (const key of S3_CREDENTIAL_ENV_VARS) delete out[key];
  return out;
}

/**
 * Apply the credential policy to an env block: inject the platform credential,
 * or strip every alias. Returns a new object; never mutates the input.
 *
 * Exported (with the mode/keys as explicit params, defaulted from process.env)
 * so tests can assert the policy without spawning Docker or reaching CubeMaster.
 */
export function applyS3CredentialPolicy(env, {
  mode = process.env.SANDBOX_S3_CREDENTIALS ?? "inject",
  accessKey = process.env.WEED_S3_ACCESS_KEY ?? "",
  secretKey = process.env.WEED_S3_SECRET_KEY ?? "",
} = {}) {
  if (!isS3CredentialOmitMode(mode)) {
    return { ...(env || {}), S3_ACCESS_KEY: accessKey, S3_SECRET_KEY: secretKey };
  }
  return stripS3Credentials(env);
}
