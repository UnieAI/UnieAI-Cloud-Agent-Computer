/**
 * disk-guard.mjs — 雲端沙盒的磁碟上限。
 *
 * CPU（`--cpus`）、記憶體（`--memory` + swap 釘死）、行程數（`--pids-limit`）
 * 都有硬上限。磁碟**沒有**，而且不是疏漏：`--storage-opt size=` 只有在 driver
 * 真的強制它的時候才有意義（見 cube/docker.mjs::storageQuotaSupported），
 * 這台主機是 `overlayfs` + ext4 且沒掛 `prjquota`，所以那一面旗標會被探測後
 * 跳過。於是在此之前，一個租戶的 `dd if=/dev/zero of=big` 能把共用主機填滿 ——
 * 而這台上面還跑著別的產品。
 *
 * 兩層，刻意重疊，因為它們擋的是不同的東西：
 *
 *   1. `fsize` rlimit（`docker run --ulimit fsize=`）—— **單一檔案**的上限。
 *      核心強制、立刻生效、不需要任何輪詢。它擋掉「一個 `dd` 就填滿」這一類，
 *      也就是唯一能在幾分鐘內把主機弄掉的路徑。
 *      它擋不掉「一百萬個小檔」—— 那是第 2 層的事。
 *
 *   2. 入場管制（`diskAdmission`）—— 主機剩餘空間低於保留量就不再開新沙盒。
 *      一次 `statfs`，成本接近零，跟既有的記憶體 `reservePct` 同一個形狀。
 *      它擋不掉「已經開著的沙盒繼續寫」—— 那是第 1 層的事。
 *
 * 為什麼不做「量每個沙盒的可寫層然後超標就殺」：那需要對 overlay 的 upperdir
 * 做 `du`，在一台 IO 已經被別的產品用著的共用主機上，巡檢本身就是資源佔用。
 * 上面兩層的成本是 0（rlimit 是核心的、statfs 是一次系統呼叫），涵蓋的是真正
 * 會發生的兩種形狀。
 *
 * **只對雲端沙盒成立。** 綁在使用者自己電腦上的那一列（Rabi Local / SSH）用的
 * 是他們的磁碟；在這裡設限不會省下這台主機的任何一個位元組，只會讓他們無法
 * 工作。呼叫端負責不要把那一類送進來（見 manager.mjs 的 machineKind 判斷）。
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

function intEnv(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function floatEnv(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number.parseFloat(String(raw));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * env → 磁碟上限設定。
 *
 * **0 是「明確關閉」，不是「掉回預設」** —— 這個區別是承重的：一個 operator
 * 把保留量設成 0 是在說「這台我自己顧」，靜靜地換回 20GB 等於無視他的決定。
 * 空字串與垃圾值才掉回預設。
 */
export function resolveDiskLimits(env = process.env) {
  return {
    // 單檔上限。20GB 對寫程式的沙盒來說是慷慨的（最大的合理產物是容器映像
    // 或模型權重），同時把 `dd` / 日誌炸彈擋在主機之外。
    fsizeGb: intEnv(env.SANDBOX_FSIZE_LIMIT_GB, 20),
    // 主機絕對保留量：低於這個數字就不開新沙盒。
    reserveMb: intEnv(env.SANDBOX_DISK_RESERVE_MB, 20 * 1024),
    // 主機百分比保留量。大磁碟上絕對值不夠用 —— 1TB 剩 20GB 已經太晚了。
    reservePct: floatEnv(env.SANDBOX_DISK_RESERVE_PCT, 0.1),
  };
}

/**
 * 單檔 rlimit 的 bytes 值，給 `docker run --ulimit fsize=<bytes>`。
 * @returns bytes；0 代表不設限（呼叫端就不要送那面旗標）。
 */
export function fsizeLimitBytes(gb) {
  const n = Number(gb);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n) * GB;
}

/**
 * 要不要放一個新的雲端沙盒進來。
 *
 * 兩個門檻取**較嚴**的：絕對值保護小磁碟（百分比在小磁碟上算出來太小），
 * 百分比保護大磁碟（絕對值在大磁碟上來得太晚）。
 *
 * 量不到主機空間時**放行**，但回 `measured: false`。擋下等於全平台停擺，
 * 而這道門是深度防禦不是唯一防線（第 1 層的 rlimit 不依賴量測）；呼叫端拿到
 * `measured: false` 才知道這一次沒有這層保護，可以記一筆而不是以為過了。
 */
export function diskAdmission({ freeMb, totalMb, reserveMb = 0, reservePct = 0 }) {
  const free = Number(freeMb);
  const total = Number(totalMb);
  const measured = Number.isFinite(free) && Number.isFinite(total) && total > 0;
  if (!measured) {
    return { allow: true, measured: false, freeMb: null, requiredMb: null, reason: "" };
  }
  const byPct = Math.floor(total * (Number(reservePct) || 0));
  const requiredMb = Math.max(Number(reserveMb) || 0, byPct);
  if (requiredMb <= 0 || free >= requiredMb) {
    return { allow: true, measured: true, freeMb: free, requiredMb, reason: "" };
  }
  return {
    allow: false,
    measured: true,
    freeMb: free,
    requiredMb,
    reason:
      `host disk below reserve: ${free}MB free, ${requiredMb}MB required. `
      + `No new cloud sandbox until space is reclaimed — your own computer (Rabi Local) is unaffected.`,
  };
}

/** 讀主機剩餘空間。注入 statfs 讓測試不用碰真的檔案系統。 */
export function measureHostDisk(path, statfsSync) {
  try {
    const s = statfsSync(path);
    // statfs 回的是 block 數；bavail 是**非特權使用者**可用的，這才是我們的視角。
    const blockSize = Number(s.bsize) || 0;
    if (!blockSize) return { freeMb: null, totalMb: null };
    return {
      freeMb: Math.floor((Number(s.bavail) * blockSize) / MB),
      totalMb: Math.floor((Number(s.blocks) * blockSize) / MB),
    };
  } catch {
    return { freeMb: null, totalMb: null };
  }
}
