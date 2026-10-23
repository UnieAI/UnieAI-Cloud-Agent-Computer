/**
 * host-admission.mjs — 「依主機資源自動調整」：新雲端沙盒要主機還有餘裕才放行。
 *
 * 量三樣，都便宜（讀兩個 /proc 檔、一次 statfs），每次開新沙盒時量一次：
 *   - 記憶體：/proc/meminfo 的 MemAvailable。容器裡讀到的是主機的值（沒有 lxcfs），
 *     而這正是我們要的 —— 這台 30GB 的機器跟 Studio 正式站共用，該看的是整台。
 *   - CPU：/proc/loadavg 的一分鐘負載 ÷ 核心數。
 *   - 磁碟：資料所在檔案系統的剩餘比例（2026-10 磁碟曾到 99%）。
 *
 * 量不到的那一樣**放行**（回 measured:false）：擋下等於全平台停擺，而這是深度防禦
 * 不是唯一防線（每個沙盒自己還有 2GB 記憶體、2 核、行程數的硬上限）。
 * 讀取器都可以注入，測試不碰真的主機。
 */
import fs from "node:fs";
import os from "node:os";

const MB = 1024 * 1024;

export function readMemAvailableMb(read = (p) => fs.readFileSync(p, "utf8")) {
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(read("/proc/meminfo"));
    return m ? Math.floor(Number(m[1]) / 1024) : null;
  } catch { return null; }
}

export function readLoadPerCore(read = (p) => fs.readFileSync(p, "utf8"), cores = os.cpus().length) {
  try {
    const one = Number(read("/proc/loadavg").trim().split(/\s+/)[0]);
    return Number.isFinite(one) && cores > 0 ? one / cores : null;
  } catch { return null; }
}

export function readDiskFreePct(path = process.env.SANDBOX_DISK_PATH || "/", statfs = fs.statfsSync) {
  try {
    const s = statfs(path);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return total > 0 ? (free / total) * 100 : null;
  } catch { return null; }
}

export function measureHost(readers = {}) {
  return {
    memAvailableMb: (readers.mem ?? readMemAvailableMb)(),
    loadPerCore: (readers.load ?? readLoadPerCore)(),
    diskFreePct: (readers.disk ?? readDiskFreePct)(),
  };
}

/**
 * @param {{minFreeMemMb:number,maxLoadPerCore:number,minDiskFreePct:number}} limits
 * @param {{memAvailableMb:number|null,loadPerCore:number|null,diskFreePct:number|null}} host
 * @returns {{allow:boolean, reasons:string[], host:object}}
 */
export function hostAdmission(limits, host) {
  const reasons = [];
  if (host.memAvailableMb !== null && host.memAvailableMb < limits.minFreeMemMb) reasons.push("memory");
  if (host.loadPerCore !== null && host.loadPerCore > limits.maxLoadPerCore) reasons.push("cpu");
  if (host.diskFreePct !== null && host.diskFreePct < limits.minDiskFreePct) reasons.push("disk");
  return { allow: reasons.length === 0, reasons, host };
}

export { MB };
