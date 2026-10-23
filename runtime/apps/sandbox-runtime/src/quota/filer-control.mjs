/**
 * quota/filer-control.mjs —— 透過 `weed shell` 讀寫 filer 的路徑規則（`fs.configure`）。
 *
 * 為什麼是 `docker exec … weed shell`：sandbox-runtime 跑在主機上，filer 在 SeaweedFS 容器裡（主機解析不到
 * `seaweedfs`，S3 端點是 localhost 的轉接），而 weed shell 是官方、格式正確的設定入口（維運手動做的也是這個）。
 * 讀：`fs.configure`（不帶參數）印出整份設定 JSON。寫：`fs.configure -locationPrefix=P -readOnly=true -apply` 與 `-delete -apply`。
 *
 * 前綴一律先過 `isManagedPrefix` 白名單才組進指令 —— 指令字串由我們組，所以不合的前綴整批拒絕、一個指令都不送。
 */
import { execFile } from "node:child_process";

import { isManagedPrefix } from "./enforcer.mjs";

function defaultExec({ container, master }) {
  return (lines) => new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      ["exec", "-i", container, "weed", "shell", `-master=${master}`],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(`docker exec weed shell failed: ${err.message} ${String(stderr).slice(0, 300)}`)) : resolve(String(stdout))),
    );
    child.stdin.end(`${lines.join("\n")}\n`);
  });
}

export function createWeedShellControl({
  container = process.env.WORKSPACE_QUOTA_WEED_CONTAINER || "uac2-seaweedfs",
  master = process.env.WORKSPACE_QUOTA_WEED_MASTER || "seaweedfs-master:9333",
  exec = defaultExec({ container, master }),
} = {}) {
  return {
    /** 現在 readOnly 的前綴（含不是我們管的；計畫會忽略它們）。讀不到就丟。 */
    async current() {
      const out = String(await exec(["fs.configure"]));
      const from = out.indexOf("{");
      const to = out.lastIndexOf("}");
      if (from < 0 || to < from) throw new Error(`fs.configure printed no JSON: ${out.slice(0, 200)}`);
      let conf;
      try { conf = JSON.parse(out.slice(from, to + 1)); } catch (e) { throw new Error(`fs.configure JSON unreadable: ${e.message}`); }
      if (!Array.isArray(conf.locations)) throw new Error("fs.configure JSON has no locations");
      return new Set(conf.locations.filter((l) => l && l.readOnly === true && typeof l.locationPrefix === "string").map((l) => l.locationPrefix));
    },
    /** `/buckets` 底下的 bucket 名稱（`all` 模式列舉隔離租戶用）。 */
    async listBuckets() {
      const out = String(await exec(["fs.ls /buckets"]));
      return out.split("\n").map((l) => l.trim()).filter((l) => /^[a-z0-9][a-z0-9.-]{1,62}$/.test(l));
    },
    /** 加唯讀／拿掉唯讀。 */
    async apply({ add = [], remove = [] }) {
      for (const p of [...add, ...remove]) {
        if (!isManagedPrefix(p)) throw new Error(`not a managed prefix: ${JSON.stringify(p)}`);
      }
      const lines = [
        ...add.map((p) => `fs.configure -locationPrefix=${p} -readOnly=true -apply`),
        ...remove.map((p) => `fs.configure -locationPrefix=${p} -delete -apply`),
      ];
      if (!lines.length) return;
      const out = String(await exec(lines));
      if (/^\s*error\b/im.test(out)) throw new Error(`fs.configure failed: ${out.slice(0, 300)}`);
    },
  };
}
