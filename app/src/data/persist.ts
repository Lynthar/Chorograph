/* 浏览器存储耐久：报出图库所在源的耐久档位与用量，并代用户申请「持久」。
   ⚠ 全模块永不抛——没有 navigator.storage 的环境一律报「无从得知」，
      调用方拿到的永远是 StorageState，不必自备兜底。 */

export interface StorageState {
  /** 浏览器是否提供 Storage API——false 时余下三项无意义 */
  supported: boolean;
  /** 已申请到持久存储；false＝尽力而为，磁盘吃紧时整个源可被浏览器驱逐 */
  persisted: boolean;
  usage: number | null;
  quota: number | null;
}

type Nav = Navigator & { storage?: StorageManager };
const sm = (): StorageManager | null => {
  const s = (typeof navigator === "undefined" ? null : (navigator as Nav).storage) || null;
  return s && typeof s.persisted === "function" ? s : null;
};

export async function storageState(): Promise<StorageState> {
  const s = sm();
  if (!s) return { supported: false, persisted: false, usage: null, quota: null };
  let persisted = false, usage: number | null = null, quota: number | null = null;
  try { persisted = await s.persisted(); } catch { /* 报不出就按尽力而为 */ }
  try {
    if (typeof s.estimate === "function") {
      const e = await s.estimate();
      usage = typeof e.usage === "number" ? e.usage : null;
      quota = typeof e.quota === "number" ? e.quota : null;
    }
  } catch { /* 配额读不到不影响档位显示 */ }
  return { supported: true, persisted, usage, quota };
}

/** 申请持久存储；已持久＝直接 true，不支持或被拒＝false。
    ⚠ 必须在用户手势的调用栈里调——部分浏览器为此弹权限框，脱离手势一律直接拒绝。 */
export async function requestPersist(): Promise<boolean> {
  const s = sm();
  if (!s || typeof s.persist !== "function") return false;
  try { return (await s.persisted()) || (await s.persist()); } catch { return false; }
}

/** 字节数的人读形；null / 非有限 / 负数一律返回「—」 */
export function fmtBytes(n: number | null): string {
  if (n == null || !isFinite(n) || n < 0) return "—";
  const U = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < U.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : +v.toFixed(1)} ${U[i]}`;
}
