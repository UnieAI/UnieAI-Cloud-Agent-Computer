/**
 * cube/ssh-ca.mjs — 用 SSH 憑證授權（CA）取代「保管每個人的私鑰」。
 *
 * 為什麼是 CA 而不是一人一把長命金鑰：
 *
 *   · 機房這台永遠不持有可以長期使用的東西。它持有的是「簽發能力」，簽出來的憑證
 *     15 分鐘就過期 —— 備份外洩、磁碟被撿走，撿到的都是已經失效的紙。
 *   · 撤銷是「停止簽發」，立即生效，而且不需要跑到使用者的電腦上刪 authorized_keys。
 *     員工離職、筆電遺失、專案結束，都是資料庫裡改一個欄位的事。
 *   · 員工電腦只需要信任一把 CA 公鑰（TrustedUserCAKeys），之後新增幾台機器、
 *     幾個使用者都不用再碰它。這是引導流程能做到「貼一行指令就好」的原因。
 *
 * 私鑰本身從不離開這個行程所在的服務：app（BFF）只說「要連哪台、用哪個 principal」，
 * 簽發在這裡發生。app 被攻破也拿不到 CA。
 */

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

import { log } from "../shared/log.mjs";
import { SandboxError } from "../shared/error.mjs";

/** 憑證有效期。短到外洩沒有價值，長到一輪對話不會在中間過期。 */
const DEFAULT_TTL_SEC = 900;
/** 提早多久重簽。避免「檢查時還有效、ssh 握手時剛好過期」這種只在高負載才出現的 bug。 */
const RENEW_MARGIN_SEC = 120;

function run(cmd, args, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs).unref();
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(0, 300)}`));
    });
  });
}

/**
 * 建一個憑證簽發器。
 *
 * @param caKeyPath  CA 私鑰。沒給就回一個 isConfigured() === false 的簽發器，
 *                   讓部署可以先用一般金鑰跑起來（開發、單機驗證），之後再換 CA。
 * @param keyDir     放暫時金鑰與憑證的目錄。0700，行程結束時清掉。
 */
export function createCertMinter({
  caKeyPath = process.env.SSH_CA_KEY_PATH || null,
  keyDir = process.env.SSH_KEY_DIR || "/tmp/.uac2-ssh-keys",
  ttlSec = Number(process.env.SSH_CERT_TTL_SEC) || DEFAULT_TTL_SEC,
} = {}) {
  /** principal -> { identityFile, certFile, expiresAt } */
  const cache = new Map();
  let clientKeyReady = null;

  const clientKey = path.join(keyDir, "id_ed25519");

  function isConfigured() {
    return !!caKeyPath && existsSync(caKeyPath);
  }

  /**
   * 這個行程用的「使用者金鑰」只產生一次，之後一直用同一把 —— 短命的是憑證，
   * 不是金鑰。每次連線都重產金鑰會把 ed25519 keygen 放進熱路徑，換不到任何安全性：
   * 沒有憑證的裸金鑰在任何一台機器上都不被接受。
   */
  async function ensureClientKey() {
    if (clientKeyReady) return clientKeyReady;
    clientKeyReady = (async () => {
      mkdirSync(keyDir, { recursive: true, mode: 0o700 });
      if (!existsSync(clientKey)) {
        await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", clientKey, "-C", "uac2-sandbox-runtime", "-q"]);
      }
      return clientKey;
    })();
    return clientKeyReady;
  }

  /**
   * 拿一張這個 principal 可用的憑證，過期就重簽。
   *
   * `-n <principal>` 是關鍵的一半：憑證只在那台機器把這個 principal 對應到某個帳號時
   * 才有效（authorized_principals，或預設的「principal 必須等於登入帳號」）。
   * 一張簽給 alice 的憑證登不進 bob 的機器 —— 範圍是簽在紙上的，不是靠我們記得別亂用。
   */
  async function ensureCert(principal, { identity = null } = {}) {
    if (!isConfigured()) {
      throw new SandboxError("bad_request", "SSH CA is not configured (set SSH_CA_KEY_PATH)", 500);
    }
    if (!principal || !/^[A-Za-z0-9._-]+$/.test(principal)) {
      throw new SandboxError("bad_request", `invalid ssh principal: ${principal}`, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const hit = cache.get(principal);
    if (hit && hit.expiresAt - RENEW_MARGIN_SEC > now) return hit;

    const key = await ensureClientKey();
    // 每個 principal 一份憑證檔：ssh-keygen 固定寫成 <pub 去掉 .pub>-cert.pub，
    // 所以先把公鑰複製成 per-principal 的名字，簽完就得到對應的憑證檔。
    const pubForPrincipal = path.join(keyDir, `p-${principal}.pub`);
    await run("sh", ["-c", `cp ${JSON.stringify(`${key}.pub`)} ${JSON.stringify(pubForPrincipal)}`]);
    await run("ssh-keygen", [
      "-s", caKeyPath,
      "-I", identity || `uac2:${principal}`,
      "-n", principal,
      // -5m 的回溯是給時鐘偏移用的：兩台機器差幾十秒是常態，而一張「還沒生效」的憑證
      // 被拒絕時，sshd 的訊息不會告訴你原因是時間。
      "-V", `-5m:+${Math.max(60, ttlSec)}s`,
      "-z", String(now),
      pubForPrincipal,
    ]);
    const entry = {
      identityFile: key,
      certFile: path.join(keyDir, `p-${principal}-cert.pub`),
      expiresAt: now + ttlSec,
    };
    cache.set(principal, entry);
    log("info", "ssh.cert_minted", { principal, ttlSec, expiresAt: entry.expiresAt });
    return entry;
  }

  /** 撤銷這個行程的快取（DB 那側停止授權後呼叫，讓下一次連線重新走簽發）。 */
  function forget(principal) {
    cache.delete(principal);
  }

  function destroy() {
    try { rmSync(keyDir, { recursive: true, force: true }); } catch { /* 清不掉不是錯誤 */ }
    cache.clear();
    clientKeyReady = null;
  }

  return { isConfigured, ensureCert, forget, destroy, _internal: { cache, clientKey } };
}
