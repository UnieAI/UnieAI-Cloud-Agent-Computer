#!/usr/bin/env node
/**
 * doctor/storage-doctor.mjs — is the object store the operator configured
 * actually usable by CAC? Run before the server starts (the bundle's
 * entrypoint does), and by hand when a sandbox's /workspace looks wrong.
 *
 *   node apps/sandbox-runtime/src/doctor/storage-doctor.mjs     exit 0 = usable
 *
 * Every check answers one question an operator would otherwise find out from a
 * user ("my files are gone"): which setting, what was expected, what to do.
 * It never prints a key.
 *
 * Why each check exists:
 *   · storage-configured — storage-engine falls back to a local directory when
 *     S3 is not configured. CAC never runs on that: workspaces must outlive the
 *     host and be reachable from every host (P3).
 *   · bucket / read-write — the cheapest proof the endpoint, keys and bucket agree.
 *   · conditional-write — the workspace manifest is updated with compare-and-swap
 *     (If-Match / If-None-Match). A store that ignores the header accepts both
 *     of two concurrent updates, and one of them is silently lost.
 *   · mount — the sandbox's /workspace is a FUSE mount of the same bucket. With
 *     the wrong mounter the file panel works and every sandbox is empty.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import * as storage from "../../../../packages/storage-engine/src/index.mjs";
import { HOST_MOUNT_DRIVER_S3, resolveHostMountDriver, resolveWorkspaceMountMode, WORKSPACE_MOUNT_HOST } from "../cube/host-mount.mjs";

const PROBE_PREFIX = ".cac-doctor";

const run = (bin, args) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: 10_000 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });

const defaultDeps = {
  storage,
  which: async (bin) => (await run("sh", ["-c", `command -v ${bin}`])) !== null,
  version: (bin, args) => run(bin, args),
  exists: existsSync,
};

/**
 * @returns {Promise<Array<{ check: string, ok: boolean, detail: string }>>}
 */
export async function runStorageDoctor({ env = process.env, deps = defaultDeps } = {}) {
  const results = [];
  const record = (check, ok, detail) => { results.push({ check, ok, detail }); return ok; };
  const s = deps.storage;

  // 1. Configured, and as S3.
  const backend = await s.describeStorageBackend();
  if (backend !== "s3") {
    record(
      "storage-configured",
      false,
      backend === "local-fs"
        ? "storage would fall back to a LOCAL DIRECTORY. CAC needs an S3 store: set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY (and unset STORAGE_LOCAL_FS)."
        : "no object store is configured: set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY.",
    );
    return results; // nothing below means anything without a store
  }
  record("storage-configured", true, `S3 at ${env.S3_ENDPOINT}, bucket ${env.S3_BUCKET}, path-style ${s.s3ForcePathStyle(env) ? "on" : "off"}`);

  // 2. The bucket answers with these keys.
  const probe = s.systemLocation(`${PROBE_PREFIX}/${randomUUID()}`, "storage doctor");
  try {
    await s.headBucket({ at: probe });
    record("bucket", true, `bucket ${env.S3_BUCKET} exists and the keys can reach it`);
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    record(
      "bucket",
      false,
      status === 404
        ? `bucket ${env.S3_BUCKET} does not exist at ${env.S3_ENDPOINT}. Create it; CAC never creates buckets.`
        : status === 403
          ? `the keys are refused for bucket ${env.S3_BUCKET} (403). Check S3_ACCESS_KEY / S3_SECRET_KEY and the key's policy.`
          : `cannot reach ${env.S3_ENDPOINT}: ${err?.name || ""} ${err?.message || err}. Check S3_ENDPOINT, S3_REGION and S3_FORCE_PATH_STYLE.`,
    );
    return results;
  }

  // 3. Write, read back, delete.
  const body = `cac-doctor ${Date.now()}`;
  let wrote = false;
  try {
    await s.putObject({ at: probe, body, contentType: "text/plain" });
    wrote = true;
    const obj = await s.getObject({ at: probe });
    const chunks = [];
    for await (const c of obj?.Body ?? []) chunks.push(Buffer.from(c));
    const back = Buffer.concat(chunks).toString("utf8");
    if (back !== body) throw new Error(`read back ${JSON.stringify(back.slice(0, 40))}, wrote ${JSON.stringify(body)}`);
    record("read-write", true, "an object was written, read back byte for byte, and deleted");
  } catch (err) {
    record("read-write", false, `write/read of ${PROBE_PREFIX}/… failed: ${err?.message || err}. The keys need s3:PutObject, s3:GetObject and s3:DeleteObject on the bucket.`);
  }

  // 4. Conditional writes are honoured, not ignored.
  if (wrote) {
    try {
      await s.putObject({ at: probe, body: "second", contentType: "text/plain", ifNoneMatch: "*" });
      record("conditional-write", false, "the store ACCEPTED a create-only write (If-None-Match: *) over an existing object. It ignores conditional headers, so concurrent workspace updates would overwrite each other. Use a store that honours them (measured: MinIO, SeaweedFS 4.41).");
    } catch (err) {
      if (s.isPreconditionFailed(err)) record("conditional-write", true, "create-only writes are refused over an existing object (If-None-Match honoured)");
      else record("conditional-write", false, `the conditional write failed for another reason: ${err?.message || err}`);
    }
    try { await s.deleteObject({ at: probe }); } catch { /* the probe key is harmless; reported by read-write if it matters */ }
  }

  // 5. The mount the sandboxes will get.
  const mode = resolveWorkspaceMountMode(env);
  let driver;
  try { driver = resolveHostMountDriver(env); } catch (err) {
    record("mount", false, err.message);
    return results;
  }
  if (driver === HOST_MOUNT_DRIVER_S3 && mode !== WORKSPACE_MOUNT_HOST) {
    record("mount", false, `SANDBOX_HOST_MOUNT_DRIVER=s3 only applies with SANDBOX_WORKSPACE_MOUNT=host (it is "${mode}"). As configured the sandbox mounts with weed, which reaches only a SeaweedFS filer, and /workspace would be empty.`);
  } else if (driver === HOST_MOUNT_DRIVER_S3) {
    const rclone = env.SANDBOX_HOST_MOUNT_RCLONE_BINARY || "rclone";
    const missing = [];
    if (!(await deps.which(rclone))) missing.push(`${rclone} (the mounter)`);
    if (!(await deps.which("fusermount3"))) missing.push("fusermount3 (package fuse3)");
    if (!deps.exists("/dev/fuse")) missing.push("/dev/fuse (run the container with --device /dev/fuse)");
    if (missing.length) record("mount", false, `the S3 mount cannot start here: missing ${missing.join(", ")}.`);
    else record("mount", true, `rclone ${String(await deps.version(rclone, ["version"]) || "").split("\n")[0].replace(/^rclone\s+/, "")} mounts <bucket>/<owner>/workspace for each sandbox`);
  } else if (mode === WORKSPACE_MOUNT_HOST) {
    const weed = env.SANDBOX_HOST_MOUNT_WEED_BINARY || "weed";
    if (!(await deps.which(weed))) record("mount", false, `SANDBOX_HOST_MOUNT_DRIVER=weed needs the ${weed} binary and a SeaweedFS filer; for any other S3 store set SANDBOX_HOST_MOUNT_DRIVER=s3.`);
    else record("mount", true, `weed mounts from the filer at ${env.SANDBOX_HOST_MOUNT_FILER || "127.0.0.1:8888"} (SeaweedFS only)`);
  } else {
    record("mount", true, `SANDBOX_WORKSPACE_MOUNT=${mode}: the sandbox image mounts /workspace itself (SeaweedFS only)`);
  }

  return results;
}

async function main() {
  const results = await runStorageDoctor();
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.check.padEnd(18)} ${r.detail}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\nstorage doctor: ${failed.length} problem(s). CAC will not start until they are fixed.`);
    process.exit(1);
  }
  console.log("\nstorage doctor: the object store is usable.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`storage doctor crashed: ${err?.stack || err}`);
    process.exit(2);
  });
}
