/* 通用小工具（自旧实现原样迁移） */

/** 深拷贝（JSON 语义：丢函数/undefined——与旧实现一致，勿换 structuredClone 以免行为漂移） */
export function clone<T>(o: T): T { return JSON.parse(JSON.stringify(o)) as T; }

/** HTML 转义：所有进入 innerHTML 的用户数据一律过它 */
export function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}

/** 里程显示：≥1000km 千km 两位小数 / ≥1km 取整 / 以下转米 */
export function fmtKm(km: number): string {
  if (km >= 1000) return (km / 1000).toFixed(2) + " 千km";
  if (km >= 1) return Math.round(km) + " km";
  return Math.round(km * 1000) + " m";
}

/** #rgb/#rrggbb → rgba(r,g,b,a)；非法色值原样返回（不产出 rgba(NaN)） */
export function hexA(hex: string | undefined, a: number): string {
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex || "")) return hex || "#888";
  const h = (hex as string).replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map(x => x + x).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** 文件名净化：去非法字符/前导点/尾随点空格、限 60 字符，空白回退「未命名」（文件夹图库落盘用）。
    Windows 保留设备名（CON/NUL/COM1…）前缀下划线——否则 getFileHandle 在 Win 失败且报「权限」误导。 */
export function safeName(base: unknown): string {
  const n = String(base || "未命名").replace(/[\\/:*?"<>|\n\r\t]/g, "_").replace(/^\.+/, "").replace(/[. ]+$/, "").trim().slice(0, 60) || "未命名";
  return /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i.test(n) ? "_" + n : n;
}

/** 「键：值」多行文本 ↔ 对象（属性模板表单用；中英冒号均可） */
export function parseKV(text: string | undefined): Record<string, string> {
  const o: Record<string, string> = {};
  (text || "").split(/\n/).forEach(line => {
    const m = line.match(/^\s*([^:：]+)[:：](.*)$/);
    if (m) { const k = m[1].trim(), v = m[2].trim(); if (k) o[k] = v; }
  });
  return o;
}
