/**
 * cube/envd.mjs — Per-sandbox envd daemon client.
 *
 * envd runs inside every sandbox and exposes:
 *   · process exec (Connect-RPC server-streaming)  process.Process/Start, /Connect, /SendSignal, /CloseStdin
 *   · filesystem ops (Connect-RPC unary)            filesystem.Filesystem/{Stat,ListDir,MakeDir,Move,Remove}
 *   · raw file upload/download                      GET/POST /files?path=…
 *
 * Auth: X-Access-Token header carrying envdAccessToken from the
 * control-plane createSandbox response.
 *
 * URL construction:
 *   When the control-plane response gives us `domain` + `sandboxID` + `clientID`,
 *   envd is reachable via the traffic-proxy subdomain:
 *
 *     https://{port}-{sandboxID}-{clientID}.{domain}/
 *
 *   The envd port is 49983 in E2B's default template. For self-hosted
 *   CubeSandbox clusters that route directly we accept an env override
 *   (CUBE_ENVD_URL_TEMPLATE) — see resolveEnvdUrl below.
 */

import { EventEmitter } from "node:events";

import { SandboxError, ConnectError } from "../shared/error.mjs";
import { connectUnary, connectServerStream } from "./connect.mjs";

const DEFAULT_ENVD_PORT = Number(process.env.CUBE_ENVD_PORT || 49983);
const DEFAULT_ENVD_USER = process.env.CUBE_ENVD_USER || "user";

/**
 * Resolve the envd base URL for a sandbox. Caller supplies the sandbox row
 * returned by control.createSandboxRaw(); we honour environment overrides for
 * self-hosted deployments.
 */
export function resolveEnvdUrl(sandbox, { port = DEFAULT_ENVD_PORT } = {}) {
  const override = String(process.env.CUBE_ENVD_URL_TEMPLATE || "").trim();
  if (override) {
    return override
      .replace("{sandboxID}", sandbox.sandboxID)
      .replace("{clientID}", sandbox.clientID || "")
      .replace("{port}", String(port))
      .replace("{domain}", sandbox.domain || "");
  }
  if (!sandbox.domain) {
    throw new SandboxError("invalid_sandbox", "Sandbox has no domain (CUBE_ENVD_URL_TEMPLATE required for self-hosted)", 500);
  }
  return `https://${port}-${sandbox.sandboxID}-${sandbox.clientID}.${sandbox.domain}`;
}

function authHeaders(accessToken) {
  return accessToken ? { "x-access-token": accessToken } : {};
}

function base64ToBuffer(b64) {
  if (!b64) return Buffer.alloc(0);
  return Buffer.from(b64, "base64");
}

export function createEnvdClient({ sandbox, fetchImpl = fetch } = {}) {
  if (!sandbox?.sandboxID) throw new SandboxError("invalid_sandbox", "createEnvdClient: sandbox.sandboxID required", 400);
  const envdUrl = resolveEnvdUrl(sandbox);
  const accessToken = sandbox.envdAccessToken || null;
  const auth = authHeaders(accessToken);

  // ── Filesystem ──────────────────────────────────────────────

  async function listDir(path = "/", { depth = 1, signal } = {}) {
    const result = await connectUnary({
      baseUrl: envdUrl,
      service: "filesystem.Filesystem",
      method: "ListDir",
      body: { path, depth },
      auth,
      fetchImpl,
      signal
    });
    return (result?.entries || []).map((e) => ({
      name: e.name,
      path: e.path,
      isFile: e.type === "FILE_TYPE_FILE" || e.type === 1,
      isDirectory: e.type === "FILE_TYPE_DIRECTORY" || e.type === 2,
      size: Number(e.size || 0),
      mtimeMs: e.modifiedTime ? new Date(e.modifiedTime).getTime() : 0,
      mode: e.mode,
      permissions: e.permissions,
      owner: e.owner,
      group: e.group,
      symlinkTarget: e.symlinkTarget || null
    }));
  }

  async function stat(path, { signal } = {}) {
    const result = await connectUnary({
      baseUrl: envdUrl,
      service: "filesystem.Filesystem",
      method: "Stat",
      body: { path },
      auth,
      fetchImpl,
      signal
    });
    const e = result?.entry;
    if (!e) return null;
    return {
      name: e.name,
      path: e.path,
      isFile: e.type === "FILE_TYPE_FILE" || e.type === 1,
      isDirectory: e.type === "FILE_TYPE_DIRECTORY" || e.type === 2,
      size: Number(e.size || 0),
      mtimeMs: e.modifiedTime ? new Date(e.modifiedTime).getTime() : 0
    };
  }

  async function makeDir(path, { signal } = {}) {
    await connectUnary({
      baseUrl: envdUrl,
      service: "filesystem.Filesystem",
      method: "MakeDir",
      body: { path },
      auth, fetchImpl, signal
    });
  }

  async function move(source, destination, { signal } = {}) {
    await connectUnary({
      baseUrl: envdUrl,
      service: "filesystem.Filesystem",
      method: "Move",
      body: { source, destination },
      auth, fetchImpl, signal
    });
  }

  async function remove(path, { signal } = {}) {
    await connectUnary({
      baseUrl: envdUrl,
      service: "filesystem.Filesystem",
      method: "Remove",
      body: { path },
      auth, fetchImpl, signal
    });
  }

  // ── File content (REST /files) ──────────────────────────────

  async function readFile(path, { username = DEFAULT_ENVD_USER, signal } = {}) {
    const url = `${envdUrl}/files?path=${encodeURIComponent(path)}&username=${encodeURIComponent(username)}`;
    const res = await fetchImpl(url, { headers: auth, signal });
    if (res.status === 404) throw new SandboxError("file_not_found", `file not found: ${path}`, 404);
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* ignore */ }
      throw new SandboxError(body?.code || "envd_error", body?.message || `readFile HTTP ${res.status}`, res.status);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async function writeFile(path, content, { username = DEFAULT_ENVD_USER, signal } = {}) {
    const url = `${envdUrl}/files?path=${encodeURIComponent(path)}&username=${encodeURIComponent(username)}`;
    const body = Buffer.isBuffer(content) ? content
      : typeof content === "string" ? Buffer.from(content)
      : Buffer.from(JSON.stringify(content));
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { ...auth, "content-type": "application/octet-stream" },
      body,
      signal
    });
    if (!res.ok) {
      let payload = null;
      try { payload = await res.json(); } catch { /* ignore */ }
      throw new SandboxError(payload?.code || "envd_error", payload?.message || `writeFile HTTP ${res.status}`, res.status);
    }
  }

  // ── Process exec (Connect-RPC server-streaming) ─────────────

  /**
   * Start a process inside the sandbox. Returns an EventEmitter handle
   * matching the backend exec contract (cube/CONTRACT.md):
   *   .execId          — synthesised id (also the pid once StartEvent arrives)
   *   .on("stdout" | "stderr" | "exit" | "error", cb)
   *   .write(stdin)    — send stdin via SendInput
   *   .cancel() / .kill() — sends SIGTERM (with SIGKILL fallback after 2s)
   */
  async function execProcess({ kind = "bash", command, args = [], env = {}, cwd, timeoutMs, stdin, tag, signal } = {}) {
    let cmd;
    let cmdArgs;
    if (kind === "bash") {
      cmd = "/bin/bash";
      cmdArgs = ["-lc", typeof command === "string" ? command : (Array.isArray(args) && args.length ? args.join(" ") : "true")];
    } else if (kind === "python") {
      cmd = "/usr/bin/env";
      cmdArgs = ["python3", "-c", typeof command === "string" ? command : ""];
    } else {
      cmd = String(command || "true");
      cmdArgs = Array.isArray(args) ? args.map(String) : [];
    }

    const startBody = {
      process: {
        cmd,
        args: cmdArgs,
        envs: { ...env },
        ...(cwd ? { cwd } : {})
      },
      ...(tag ? { tag } : {}),
      stdin: typeof stdin === "string"
    };

    const handle = new EventEmitter();
    let pid = null;
    let exited = false;
    const ctrl = new AbortController();
    if (signal) signal.addEventListener("abort", () => ctrl.abort(), { once: true });

    let timer = null;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        sendSignal(pid, "SIGNAL_SIGTERM").catch(() => {});
        setTimeout(() => {
          if (!exited) sendSignal(pid, "SIGNAL_SIGKILL").catch(() => {});
        }, 2000).unref();
      }, timeoutMs).unref();
    }

    const stream = connectServerStream({
      baseUrl: envdUrl,
      service: "process.Process",
      method: "Start",
      body: startBody,
      auth,
      fetchImpl,
      signal: ctrl.signal
    });

    // Pump events asynchronously so the caller has the handle returned
    // synchronously, the same as the stub.
    (async () => {
      try {
        for await (const evt of stream) {
          if (evt?.__trailer) break;
          const wrapper = evt?.event || {};
          if (wrapper.start) {
            pid = wrapper.start.pid || null;
            handle.execId = `pid-${pid || Date.now().toString(36)}`;
          } else if (wrapper.data) {
            if (wrapper.data.stdout) handle.emit("stdout", base64ToBuffer(wrapper.data.stdout));
            if (wrapper.data.stderr) handle.emit("stderr", base64ToBuffer(wrapper.data.stderr));
            if (wrapper.data.pty) handle.emit("stdout", base64ToBuffer(wrapper.data.pty));
          } else if (wrapper.end) {
            exited = true;
            if (timer) clearTimeout(timer);
            const exitCode = wrapper.end.exitCode === undefined ? wrapper.end.exit_code : wrapper.end.exitCode;
            handle.emit("exit", {
              execId: handle.execId || `pid-${pid || "?"}`,
              code: typeof exitCode === "number" ? exitCode : null,
              signal: null,
              error: wrapper.end.error || null,
              status: wrapper.end.status || null
            });
          }
          // keepalive ignored
        }
        if (!exited) {
          handle.emit("exit", { execId: handle.execId, code: null, signal: null, error: "stream_closed_without_end" });
        }
      } catch (err) {
        handle.emit("error", err);
        if (!exited) handle.emit("exit", { execId: handle.execId, code: null, signal: null, error: err?.message || String(err) });
      }
    })();

    // Public surface
    handle.execId = handle.execId || `pending-${Date.now().toString(36)}`;
    handle.write = (data) => {
      if (pid == null) return; // not started yet
      const payload = Buffer.isBuffer(data) ? data.toString("base64") : Buffer.from(String(data)).toString("base64");
      sendInput(pid, payload).catch(() => {});
    };
    handle.cancel = () => sendSignal(pid, "SIGNAL_SIGTERM").catch(() => {});
    handle.kill = () => sendSignal(pid, "SIGNAL_SIGKILL").catch(() => {});

    return handle;
  }

  async function sendInput(pid, stdinBase64) {
    if (!pid) return;
    await connectUnary({
      baseUrl: envdUrl,
      service: "process.Process",
      method: "SendInput",
      body: { process: { pid }, input: { stdin: stdinBase64 } },
      auth, fetchImpl
    });
  }

  async function sendSignal(pid, signal) {
    if (!pid) return;
    await connectUnary({
      baseUrl: envdUrl,
      service: "process.Process",
      method: "SendSignal",
      body: { process: { pid }, signal },
      auth, fetchImpl
    });
  }

  async function listProcesses({ signal } = {}) {
    const result = await connectUnary({
      baseUrl: envdUrl,
      service: "process.Process",
      method: "List",
      body: {},
      auth, fetchImpl, signal
    });
    return result?.processes || [];
  }

  return {
    envdUrl,
    listDir,
    stat,
    makeDir,
    move,
    remove,
    readFile,
    writeFile,
    execProcess,
    sendInput,
    sendSignal,
    listProcesses
  };
}
