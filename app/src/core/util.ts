/* 通用小工具（自旧实现原样迁移） */

/** 深拷贝（JSON 语义：丢函数/undefined——与旧实现一致，勿换 structuredClone 以免行为漂移） */
export function clone<T>(o: T): T { return JSON.parse(JSON.stringify(o)) as T; }

/** 查表取值——**键名也是用户数据**。存档/URL 里的 `edge.type`、`decor.kind`、`terrainOverrides.t`、
    `#preset=` 等等都是自由字符串，而 `TABLE[k]` 沿原型链取得到 `toString`/`constructor`/`__proto__`
    这些继承成员：于是 `k in TABLE` 说「认识这个键」（校验绿灯放行）、`TABLE[k] || 缺省` 又兜不住
    （函数是真值），拿去 `.split()`/解构/算术即崩或悄悄变 NaN。本函数只认表**自有**的键。
    凡键来自存档/URL/表单的查表一律走它；键来自本表 Object.keys/ORDER 数组的内部遍历不必。
    ⚠ 别改用 `Object.create(null)` 建表绕开——parity 的 deepStrictEqual 连原型一起比，会破平价基线。 */
export function tget<T>(table: Record<string, T>, key: unknown): T | undefined {
  return typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined;
}

/** 异常文本：配额超限 / structured-clone 失败 / 事务中止各是一回事，归成一句无信息的
    「失败」等于什么都没说——凡把异常报给用户的地方都过它，别在别处另写一份。
    ⚠ 末尾那条 `|| e` 不是冗余：Chromium 真配额下 IDB 事务 abort 给出的
    `QuotaExceededError` **message 是空串**（2026-08-07 实测），直读 `.message`
    的地方会掉进自己的兜底文案（底栏那句「存储异常」即由此而来）。 */
export function errText(e: unknown): string {
  return String((e as { message?: unknown } | null)?.message || e || "未知错误");
}

/** HTML 转义：所有进入 innerHTML 的用户数据一律过它 */
export function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}

/** 里程显示：≥1km 取整 / 以下转米。旧「≥1000km 印两位小数 千km」的半译 2026-08-26 收掉
    （sanctioned 偏离,golden misc 组两样本期望在 parity.test 重写） */
export function fmtKm(km: number): string {
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
