/**
 * cube/index.mjs — Backend selector.
 *
 * Picks the right backend based on SANDBOX_MODE. The interface shape is
 * documented in cube/CONTRACT.md and mirrored by cube/docker.mjs (local docker
 * daemon, the default) and cube/client.mjs (production CubeMaster cluster).
 *
 * The old `stub` host-exec backend was removed with the stub subsystem (see
 * docs/plan-remove-stub-subsystem.md): the platform runs exclusively on the
 * weed-mount FUSE workspace where `/workspace` IS the S3 store. Unit tests that
 * need a no-op backend inject one via setBackend() instead.
 */

import { config } from "../config.mjs";
import { createCubeClient } from "./client.mjs";
import { createDockerClient } from "./docker.mjs";
import {
  WORKSPACE_MOUNT_HOST,
  WORKSPACE_MOUNT_HOST_PREMOUNTED,
  createHostMountManager,
  createPreMountedHostMountManager,
  resolveWorkspaceMountMode,
} from "./host-mount.mjs";
import { createSshClient } from "./ssh.mjs";
import { createRelayClient } from "./relay.mjs";

let _backend = null;
let _sshBackend = null;
let _relayBackend = null;
let _hostMount = null;

/**
 * The host-side workspace mount manager, or null when this deployment leaves
 * the mount inside the guest (the default). Exposed so the boot path can run
 * its reconcile before the first allocate.
 */
export function getHostMountManager() {
  const mode = resolveWorkspaceMountMode(process.env);
  // Two managers, one seam. `host` mounts per sandbox from this unprivileged
  // process; `host-premounted` binds subpaths of a tree a ROOT unit mounted, so
  // it mounts nothing and needs no privilege — see WORKSPACE_MOUNT_HOST_PREMOUNTED
  // for why that difference is a security property and not a preference.
  if (mode === WORKSPACE_MOUNT_HOST_PREMOUNTED) {
    if (!_hostMount) _hostMount = createPreMountedHostMountManager();
    return _hostMount;
  }
  if (mode !== WORKSPACE_MOUNT_HOST) return null;
  if (!_hostMount) _hostMount = createHostMountManager();
  return _hostMount;
}

/**
 * sandboxId -> backend。**這是「兩線並行」的整個機制。**
 *
 * 後端不是全域一種：一個帶著機器來的 allocate 走 SSH（指令跑在使用者自己的
 * 電腦上），沒帶機器的照舊走 docker 沙箱。所以不需要、也不應該把
 * `SANDBOX_MODE` 全域切成 ssh —— 那會讓每一個還沒綁機器的使用者在下一次
 * 分派時直接失敗，而那是目前的絕大多數人。
 *
 * 一個 sandbox 的後端在分派時決定、在銷毀時解除；中間所有的
 * exec / 檔案 / 快照都必須問同一個。
 */
const _bySandbox = new Map();

/** 分派時登記這個 sandbox 屬於哪個後端。 */
export function bindSandboxBackend(sandboxId, backend) {
  if (sandboxId && backend) _bySandbox.set(sandboxId, backend);
}

/** 銷毀時解除。不解除的話這張表會跟著行程一直長大。 */
export function releaseSandboxBackend(sandboxId) {
  _bySandbox.delete(sandboxId);
}

/** SSH 後端（單例）。目標機器由每次 createSandbox 的 `machine` 參數決定，
 *  所以一個 client 服務得了所有已綁定的機器。 */
export function getSshBackend() {
  if (!_sshBackend) _sshBackend = createSshClient();
  return _sshBackend;
}

/** Rabi Local 後端（單例）。目標機器由 createSandbox 的 `machine` 決定；連線登記在 relay/registry.mjs。 */
export function getRelayBackend() {
  if (!_relayBackend) _relayBackend = createRelayClient();
  return _relayBackend;
}

/**
 * 一台機器被撤銷了：把後端層還握著的憑證快取忘掉。
 *
 * 刻意**不**用 `getSshBackend()` —— 那會為了清一個根本不存在的快取而把 SSH
 * client 建出來（連帶產生金鑰目錄）。從來沒簽過，就沒有東西要忘。
 *
 * @returns {{principals: string[], sandboxes: string[]}}
 */
export function forgetMachineCredentials(machineId, { principal = null } = {}) {
  if (!_sshBackend || typeof _sshBackend.forgetMachine !== "function") {
    return { principals: [], sandboxes: [] };
  }
  return _sshBackend.forgetMachine(machineId, { principal });
}

/** 依機器種類挑後端：`local` → relay（daemon 主動連進來）、其餘有 machine 的 → ssh、沒 machine → 部署預設。 */
export function backendForMachine(machine) {
  if (!machine) return getBackend();
  if (machine.kind === "local") return getRelayBackend();
  return getSshBackend();
}

/**
 * 取得後端。**帶了 sandboxId 就一定要帶** —— 不帶會拿到部署的預設後端，
 * 而對一個 SSH sandbox 來說那個後端根本不認得它的 id，會回 sandbox_not_found。
 */
export function getBackend(sandboxId) {
  if (sandboxId) {
    const bound = _bySandbox.get(sandboxId);
    if (bound) return bound;
  }
  if (_backend) return _backend;
  switch (config.mode) {
    case "cube":
      _backend = createCubeClient({
        cubeApiUrl: config.cubeApiUrl,
        cubeApiKey: config.cubeApiKey
      });
      break;
    case "ssh":
      // 指令跑在使用者自己的機器上（企業機房 on-prem）。見 plans/ssh-machine-backend.md。
      // 目標機器由 resolveTarget 從機器名冊解析；沒有名冊時退回 SSH_TARGET_* 環境變數。
      _backend = createSshClient({ resolveTarget: config.resolveSshTarget });
      break;
    case "docker":
    default: {
      const workspaceMountMode = resolveWorkspaceMountMode(process.env);
      _backend = createDockerClient({
        workspaceMountMode,
        // `getHostMountManager` already answers null for in-guest, so asking it
        // unconditionally is both shorter and impossible to get out of step
        // with the mode list — which is how `host-premounted` would otherwise
        // have reached createDockerClient with a null manager and been told it
        // was misconfigured.
        hostMount: getHostMountManager(),
      });
      break;
    }
  }
  return _backend;
}

export function resetBackend() {
  _backend = null;
  _hostMount = null;
  _sshBackend = null;
  _relayBackend = null;
  _bySandbox.clear();
}

/** Inject a backend directly (test seam). Bypasses SANDBOX_MODE selection so a
 *  pure in-memory fake can stand in without a docker daemon / FUSE. */
export function setBackend(backend) {
  _backend = backend;
}
