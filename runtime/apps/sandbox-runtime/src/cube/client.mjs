/**
 * cube/client.mjs — Real CubeAPI / E2B-compatible backend.
 *
 * Composes:
 *   · cube/control.mjs — control-plane REST (create / destroy / pause / resume / list / snapshot)
 *   · cube/envd.mjs    — per-sandbox envd daemon client (process / filesystem / files)
 *
 * Surface mirrors cube/docker.mjs (the CONTRACT.md backend shape) so
 * pool/manager.mjs and exec/runner.mjs are backend-agnostic. SANDBOX_MODE=cube
 * selects this client (cube/index.mjs).
 *
 * Environment variables consumed:
 *   CUBE_API_URL              control-plane base URL (e.g. https://api.e2b.dev or self-hosted)
 *   CUBE_API_KEY              X-API-Key for control plane
 *   CUBE_TEMPLATE_ID_BASH     template id for bash/python images (single template suffices —
 *   CUBE_TEMPLATE_ID_PYTHON   we pass `kind` per exec to choose interpreter inside)
 *   CUBE_ENVD_PORT            override envd port (default 49983)
 *   CUBE_ENVD_URL_TEMPLATE    override envd URL pattern (self-hosted)
 *
 * The per-sandbox envd connection is cached on first use to avoid re-fetching
 * accessToken/domain on every operation.
 */

import { config } from "../config.mjs";
import { SandboxError } from "../shared/error.mjs";
import { log } from "../shared/log.mjs";
import { createControlClient } from "./control.mjs";
import { createEnvdClient } from "./envd.mjs";
import {
  applyS3CredentialPolicy,
  isS3CredentialOmitMode,
  stripS3Credentials,
} from "./s3-credentials.mjs";

function pickTemplate(kindHint) {
  const py = config.cubeTemplatePython;
  const bash = config.cubeTemplateBash;
  if (kindHint === "python" && py) return py;
  return bash || py || "";
}

/**
 * Workaround #4 (Cube bind-mount API extension not yet available):
 *
 * The cm-agent-sandbox image (#61) ships a startup hook that mounts the
 * per-user SeaweedFS prefix at /workspace via FUSE *from inside the guest*,
 * driven by environment variables baked into the sandbox at create time.
 *
 * This helper derives those env vars from the host-side mount path that a
 * host-side mount manager would otherwise bind-mount. The image entrypoint then
 * runs:  `weed mount -filer=$WEED_FILER_URL -filer.path=/buckets/$WORKSPACE_BUCKET/$WORKSPACE_PATH /workspace`
 * (or the S3 equivalent) using the rest of the WEED_/S3_ envs.
 *
 * Path shape (matches agent-fs default): /mnt/<bucket>/<rest...>
 *   e.g. /mnt/agent-fs/u-alice/p-myproject
 *        → WORKSPACE_BUCKET="agent-fs", WORKSPACE_PATH="u-alice/p-myproject"
 *
 * If the path doesn't match the expected shape we return {} — the image
 * entrypoint will then fail loud with a clear error instead of silently
 * mounting the wrong subtree.
 *
 * SeaweedFS endpoint / credentials come from the sandbox-runtime process
 * env so operators rotate them without redeploying the image; absent
 * values pass through as "" (image decides whether to fail or use anon).
 *
 * Whether the S3 CREDENTIAL is part of that block is governed by
 * SANDBOX_S3_CREDENTIALS — the same switch, the same values and the same
 * default as the docker backend, enforced by the same code
 * (./s3-credentials.mjs). Omitting it does not affect the mount: this backend
 * mounts /workspace exactly the way docker does — the cm-agent-sandbox image's
 * entrypoint runs `weed mount -filer=$WEED_FILER_URL ...` inside the guest and
 * that authenticates to the filer over gRPC, never to the S3 gateway. The
 * control plane never bind-mounts anything on this path (see Workaround #4
 * above), so there is no CubeMaster-side mount that could need the credential.
 *
 * The keys/mode are parameters (defaulted from process.env) so tests can pin
 * the policy without touching the ambient environment.
 */
export function deriveWorkspaceEnv(mountPath, {
  s3CredentialMode = process.env.SANDBOX_S3_CREDENTIALS ?? "inject",
  s3Endpoint = process.env.WEED_S3_ENDPOINT ?? "",
  s3AccessKey = process.env.WEED_S3_ACCESS_KEY ?? "",
  s3SecretKey = process.env.WEED_S3_SECRET_KEY ?? "",
} = {}) {
  if (typeof mountPath !== "string" || !mountPath) return {};
  const m = mountPath.match(/^\/mnt\/([^/]+)\/(.+)$/);
  if (!m) {
    log("warn", "cube.workspace_env.unrecognised_mount_path", {
      mountPath,
      expected: "/mnt/<bucket>/<rest>",
    });
    return {};
  }
  const env = applyS3CredentialPolicy({
    WORKSPACE_BUCKET: m[1],
    WORKSPACE_PATH: m[2],
    S3_ENDPOINT: s3Endpoint,
  }, { mode: s3CredentialMode, accessKey: s3AccessKey, secretKey: s3SecretKey });
  if (process.env.WEED_FILER_URL) env.WEED_FILER_URL = process.env.WEED_FILER_URL;
  return env;
}

export function createCubeClient({ cubeApiUrl, cubeApiKey } = {}) {
  const control = createControlClient({
    baseUrl: cubeApiUrl || config.cubeApiUrl,
    apiKey: cubeApiKey || config.cubeApiKey
  });

  if (isS3CredentialOmitMode(process.env.SANDBOX_S3_CREDENTIALS)) {
    log("info", "cube.s3_credentials_omitted", {
      note: "SANDBOX_S3_CREDENTIALS=omit — sandboxes will NOT receive S3_ACCESS_KEY/S3_SECRET_KEY in the CubeMaster create request. /workspace still mounts (the image's weed mount uses the filer over gRPC). Unset the env to restore the previous behaviour.",
    });
  }

  // sandboxId -> { sandbox, envd } — cached envd client per sandbox.
  const envdBySandbox = new Map();

  function envdFor(sandboxId) {
    const entry = envdBySandbox.get(sandboxId);
    if (!entry) throw new SandboxError("sandbox_not_known", `No envd cached for sandbox ${sandboxId}`, 404);
    return entry.envd;
  }

  function sandboxFor(sandboxId) {
    const entry = envdBySandbox.get(sandboxId);
    if (!entry) throw new SandboxError("sandbox_not_known", `No record for sandbox ${sandboxId}`, 404);
    return entry.sandbox;
  }

  return {
    backend: "cube",

    async createSandbox({ userId, sessionId, image, resourceQuota, ttlSec, networkPolicy, workspaceMountPath, envVars: callerEnvVars } = {}) {
      const templateId = image && image !== "default" ? image : pickTemplate("bash");
      if (!templateId) {
        throw new SandboxError("invalid_config", "CUBE_TEMPLATE_ID_BASH (or _PYTHON) must be set", 500);
      }
      // Phase 4.2: forward the requested host bind-mount path as VM
      // metadata so the operator can correlate which user FS prefix backs
      // a given sandbox. (Retained as a breadcrumb under Workaround #4
      // below — operators searching by mount path still hit the right
      // sandbox even though host-side bind-mount never happens.)
      const mountPath = typeof workspaceMountPath === "string" && workspaceMountPath
        ? workspaceMountPath
        : null;
      const metadata = {
        ...(userId ? { user_id: String(userId) } : {}),
        ...(sessionId ? { session_id: String(sessionId) } : {}),
        ...(mountPath ? { workspace_mount_path: mountPath } : {})
      };
      const network = networkPolicy === "egress_deny" ? { allow_internet_access: false } : undefined;

      // Workaround #4: instead of asking Cube to bind-mount the host path,
      // we ship the WORKSPACE_BUCKET / WORKSPACE_PATH / S3_* / WEED_* env
      // vars to the cm-agent-sandbox image (#61) which mounts SeaweedFS
      // from inside the guest at startup. Caller-supplied envVars take
      // precedence — operators / callers can override any field (incl.
      // S3 credentials) for a specific sandbox without us silently
      // clobbering it.
      const workspaceEnv = deriveWorkspaceEnv(mountPath);
      const callerEnv = callerEnvVars && typeof callerEnvVars === "object" ? callerEnvVars : null;
      let mergedEnvVars = (workspaceEnv && Object.keys(workspaceEnv).length) || callerEnv
        ? { ...workspaceEnv, ...(callerEnv || {}) }
        : undefined;
      // "omit" outranks caller precedence — for the four credential aliases
      // ONLY. Caller envVars are merged last on this backend, and with no mount
      // path deriveWorkspaceEnv returns {} and never sees them at all, so the
      // strip has to live on the merge and not only inside the deriver:
      // otherwise a caller (or a compromised upstream) could reintroduce over
      // the control-plane API the very credential the operator withheld.
      if (mergedEnvVars && isS3CredentialOmitMode(process.env.SANDBOX_S3_CREDENTIALS)) {
        mergedEnvVars = stripS3Credentials(mergedEnvVars);
      }

      const sandbox = await control.createSandboxRaw({
        templateId,
        timeoutSec: Math.max(60, Number(ttlSec) || config.pool.ttlSec || 3600),
        autoPause: false,
        envVars: mergedEnvVars,
        metadata,
        network
      });

      const envd = createEnvdClient({ sandbox });
      envdBySandbox.set(sandbox.sandboxID, { sandbox, envd });

      log("info", "cube.createSandbox.workspace_mount_via_envd", {
        sandboxId: sandbox.sandboxID,
        templateID: sandbox.templateID,
        clientID: sandbox.clientID,
        domain: sandbox.domain || null,
        workspaceMountPath: mountPath,
        workspaceBucket: workspaceEnv.WORKSPACE_BUCKET || null,
        workspacePath: workspaceEnv.WORKSPACE_PATH || null,
        strategy: "in_guest_weed_mount",
        note: "Workaround #4: image entrypoint mounts SeaweedFS via FUSE; host bind-mount not used",
      });

      return {
        sandboxId: sandbox.sandboxID,
        workspaceId: sandbox.sandboxID, // CubeSandbox doesn't have separate volume IDs by default; reuse sandbox id
        workspaceDir: process.env.CUBE_DEFAULT_WORKDIR || "/home/user",
        meta: { userId, sessionId, image: templateId, resourceQuota, ttlSec, networkPolicy, workspaceMountPath: mountPath, raw: sandbox }
      };
    },

    async destroySandbox(sandboxId, { keepWorkspace = false } = {}) {
      try {
        await control.destroySandbox(sandboxId);
      } catch (err) {
        if (err?.status !== 404) log("warn", "cube.destroy_failed", { sandboxId, message: err?.message || String(err) });
      }
      envdBySandbox.delete(sandboxId);
    },

    async pauseSandbox(sandboxId) {
      await control.pauseSandbox(sandboxId);
    },

    async resumeSandbox(sandboxId, opts) {
      await control.resumeSandbox(sandboxId, opts);
    },

    async listSandboxes() {
      const rows = await control.listSandboxes({});
      return (Array.isArray(rows) ? rows : []).map((row) => ({
        sandboxId: row.sandboxID,
        workspaceId: row.sandboxID,
        templateId: row.templateID,
        state: row.state
      }));
    },

    async execProcess(sandboxId, opts) {
      return envdFor(sandboxId).execProcess(opts);
    },

    /**
     * Spawn a long-lived process inside the sandbox. Delegates to envd's
     * execProcess with kind="raw" and no timeout — envd already keeps stdin
     * open for later SendInput RPCs, so the returned handle's .write() works
     * across multiple HTTP requests. processManager registers the handle and
     * provides the cross-request addressable processHandle id.
     *
     * Contract: see CONTRACT.md (Long-lived process execution).
     */
    async spawnLongLivedProcess(sandboxId, { command, args = [], env = {}, cwd } = {}) {
      return envdFor(sandboxId).execProcess({
        kind: "raw",
        command,
        args,
        env,
        cwd
        // intentionally no timeoutMs — long-lived processes are killed explicitly
      });
    },

    async readFile(sandboxId, path) {
      return envdFor(sandboxId).readFile(path);
    },

    async writeFile(sandboxId, path, content) {
      await envdFor(sandboxId).writeFile(path, content);
    },

    async statFile(sandboxId, path) {
      return envdFor(sandboxId).stat(path);
    },

    async listFiles(sandboxId, path = "/") {
      return envdFor(sandboxId).listDir(path, { depth: 1 });
    },

    async deleteFile(sandboxId, path) {
      await envdFor(sandboxId).remove(path);
    },

    async snapshotSandbox(sandboxId) {
      try {
        const result = await control.snapshotSandbox(sandboxId);
        return { snapshotId: result?.snapshotID || result?.snapshotId || null, mode: "native" };
      } catch (err) {
        // Fallback documented in plan: pause + persist volume.
        if (err?.code === "snapshot_not_supported") {
          await control.pauseSandbox(sandboxId);
          return { snapshotId: null, mode: "pause-fallback" };
        }
        throw err;
      }
    },

    async restoreSnapshot(snapshotId) {
      throw new SandboxError("not_implemented", "restoreSnapshot is not exposed by CubeAPI's standard surface yet; use resume on the original sandbox id", 501);
    },

    // Inspection helpers used by tests / introspection routes.
    _internal: {
      sandboxFor,
      envdFor,
      controlBaseUrl: control.baseUrl
    }
  };
}
