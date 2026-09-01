/* 时间为基底：任意对象（地点/连线/布景/地形涂改/派系/涂域层）的存在时段判定。
   无 since/until = 全期存在（旧数据零迁移）。战略图 yr=年份，战术图 yr=日戳 T——同一套逻辑。 */
import { calOf, fromT, yearSpanT } from "./calendar.ts";
import type { Meta, Owner, PaintLayer, Phase, Timed, World, WorldNode } from "./types.ts";

/** 对象在某时刻是否存在：[since, until) 区间，缺省 ±∞ */
export function activeAt(o: Timed, yr: number): boolean {
  const s = (o.since == null ? -Infinity : o.since), u = (o.until == null ? Infinity : o.until);
  return yr >= s && yr < u;
}

/** 归属沿革：节点在某年属谁。无 owners 则用固定 faction */
export function ownerAt(n: Pick<WorldNode, "owners" | "faction">, yr: number): string | null {
  if (n.owners && n.owners.length) {
    for (const o of n.owners as Owner[]) {
      const s = (o.since == null ? -Infinity : o.since), u = (o.until == null ? Infinity : o.until);
      if (yr >= s && yr < u) return o.faction || null;
    }
    return null;
  }
  return n.faction || null;
}

/* —— 事件三态（当刻/未发生/已过去）的**唯一判据**（2026-08-02）——
   粒度恒为**粗档单位**：战略图＝同年、战术图＝同日，与时间轴当前是粗档还是细档无关。
   ⚠ 这不是新语义，是把时间坞 `sameSlot` 早就写对的那一行抽出来收口：细粒度时间轴上
   「精确相等」必然落空——战略图开月档后整年事件的红圈与无时段作战线全灭；反向更硬，
   带月事件在年档下恒判「未发生」淡显，而切回粗档会 Math.floor 时刻，时间轴**再也回不到**
   那个小数年＝该事件永久是灰的。战术图「时」档同构地坏着（这不是月粒度引入的，是「时」
   档引入时就有的），故判据不分图种——floor 在战略图上就是年、在战术图上就是日，同
   `activeAt` 那套「同一套逻辑」之规，于是全链一个签名都不必改。
   ⚠ 两者**必须成对使用**：只改「当刻」不改「未发生」，年内靠后的事件会同时满足两边
   ＝红圈亮着又淡显着的矛盾态（时间坞的 `fut = !cur && …` 保护正是为此）。
   ⚠ 整年/整日数据上 `Math.floor(a)===Math.floor(b)` 与 `a===b` 逐位等价，故旧档零迁移。 */

/** 事件当刻：战略图＝同年（月粒度下年内任意月都算当年）、战术图＝同日。无 year＝恒否 */
export function evCurrentAt(evYear: number | undefined, yr: number): boolean {
  return evYear != null && Math.floor(evYear) === Math.floor(yr);
}

/** 事件尚未发生：严格晚于当前所在的年/日；同年/同日一律不算未发生（与 evCurrentAt 互斥） */
export function evFutureAt(evYear: number | undefined, yr: number): boolean {
  return evYear != null && Math.floor(evYear) > Math.floor(yr);
}

/** 作战线显隐：带时段=[since,until) 判定（分相位箭头，独立于事件时刻）；
    无时段=事件当刻（同年/同日，见上）。渲染与拾取共用同一规则 */
export function opVisibleAt(ev: { year?: number }, op: Timed, yr: number): boolean {
  return (op.since != null || op.until != null) ? activeAt(op, yr) : evCurrentAt(ev.year, yr);
}

/** 势力涂域：某年生效的涂绘层（可分时段/多层） */
export function paintLayersAt(f: { paint?: PaintLayer[] }, yr: number): PaintLayer[] {
  return (f.paint || []).filter(L => {
    const s = (L.since == null ? -Infinity : L.since), u = (L.until == null ? Infinity : L.until);
    return yr >= s && yr < u;
  });
}

/* —— 相位（战术图分帧命名时刻,2026-07 特化）—— */

/** 相位表：过滤坏项（非对象/t 非数）+ 按时刻升序。旧档/手编档 phases 可为任意垃圾——防御在此,
    消费端（时间坞标记/览面列表/分帧出图/PgUp·PgDn）一律经此读取。 */
export function phasesOf(meta: Meta | undefined): Phase[] {
  const raw = meta && Array.isArray(meta.phases) ? meta.phases : [];
  return raw.filter((p): p is Phase => !!p && typeof p === "object" && isFinite(+(p as Phase).t))
    .slice().sort((a, b) => a.t - b.t);
}

/** 当前所在相位下标：最后一个 t ≤ T 的（段语义 [t, 下一相位)——同 owners）；早于首相位=-1 */
export function phaseIndexAt(ph: Phase[], T: number): number {
  let idx = -1;
  for (let i = 0; i < ph.length; i++) { if (ph[i].t <= T + 1e-9) idx = i; else break; }
  return idx;
}

/** 相邻相位时刻：dir=-1 上一（严格早于 T）/ +1 下一（严格晚于 T）；无=null。
    1e-9 容差防「正站在相位上」被浮点当作可再跳。 */
export function adjacentPhaseT(ph: Phase[], T: number, dir: -1 | 1): number | null {
  if (dir < 0) { for (let i = ph.length - 1; i >= 0; i--) { if (ph[i].t < T - 1e-9) return ph[i].t; } return null; }
  for (const p of ph) { if (p.t > T + 1e-9) return p.t; }
  return null;
}

/** 战略图 until 的「至今」哨兵：≥ 此值＝不设终点（UI 三处 `until >= 9999` 的同一约定）。
    ⚠ 不计入上界——否则任何一条「至今」时段都会把时间轴撑到近万年。 */
const FOREVER = 9999;

/* 时段极值收集（2026-08-31 审查）：战略时间轴的范围原先只看 事件年 / 派系·地点·连线的 since 四样，
   于是「只用 owners 记归属沿革」「只用 paint 记疆域变迁」「只写 until」「战略图摆了部队」这四类图
   一律落回默认 3000–3100 —— 真史料在 100–200 年，而时间轴钳在 2980–3107，用户根本走不过去
   （TimeDock 每次交互都过 quantTime(r.min, r.max)）。这里把全世界每一处有限时刻并成一个包络。
   ⚠ 只管战略图：战术图的范围由烘焙时写死的 meta.tacSpan 给，且它的时刻是日戳——两种量纲混进
   同一个包络会被一条从战略图带过来的「年」直接撑爆。 */
export function strategicExtent(world: World): { lo: number; hi: number } | null {
  let lo = Infinity, hi = -Infinity, seen = false;
  const put = (v: unknown): void => {
    if (typeof v !== "number" || !isFinite(v)) return;   // 0/负年也算（0＝公元前 1 年合法）
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    seen = true;
  };
  const span = (o: Timed | null | undefined): void => {
    if (!o) return;
    put(o.since);
    if (!(typeof o.until === "number" && o.until >= FOREVER)) put(o.until);
  };
  for (const n of world.nodes || []) {
    span(n);
    if (n.type === "event") put(n.year);
    for (const ow of n.owners || []) span(ow);
    for (const op of n.ops || []) span(op);
  }
  for (const e of world.edges || []) span(e);
  for (const f of world.factions || []) {
    span(f);
    for (const L of f.paint || []) span(L);
  }
  for (const u of world.units || []) {
    span(u);
    for (const q of u.track || []) put(q.t);
  }
  // 涂改/布景可带时段（「山川随时间变化」），量级大但只是一趟线性扫；战略图的涂改数远低于战术图
  for (const d of world.decor || []) span(d);
  for (const t of world.terrainOverrides || []) span(t);
  for (const h of world.heightOverrides || []) span(h);
  return seen ? { lo, hi } : null;
}

export interface YearRange { min: number; max: number; year: number }

/** 时间轴范围推导（对应旧 updateYearRange，纯化）：
    战略图=事件年份∪各类 since 的包络（下限压到十年整-20、上限+7），出界回到上限；
    战术图=tacSpan/battleYear 推整年日戳，再被事件年与部队航点撑开，出界回到下限。 */
export function yearRangeOf(world: World, yearNow: number): YearRange {
  const m = world.meta || {};
  if (m.mapKind === "tactical") {
    const c = calOf(m.calendar);
    const y = isFinite(m.battleYear as number) ? (m.battleYear as number) : fromT(c, yearNow || 0).y;
    const span = yearSpanT(c, y);   // 整年日戳范围（custom 与旧 y*dpy 算式逐位一致；earth=JDN）
    let lo = Array.isArray(m.tacSpan) && isFinite(m.tacSpan[0]) ? m.tacSpan[0] : span[0];
    let hi = Array.isArray(m.tacSpan) && isFinite(m.tacSpan[1]) ? m.tacSpan[1] : span[1];
    const ts = [...(world.nodes || []).filter(n => n.type === "event" && isFinite(n.year as number)).map(n => n.year as number),
                ...(world.units || []).flatMap(u => (u.track || []).map(q => q.t))].filter(t => isFinite(t));
    for (const t of ts) { if (t < lo) lo = t; if (t > hi) hi = t; }   // 循环取极值（避免 spread 大数组栈溢出）
    return { min: lo, max: hi, year: (!isFinite(yearNow) || yearNow < lo || yearNow > hi) ? lo : yearNow };
  }
  const ex = strategicExtent(world);
  let lo = 3000, hi = 3100;
  if (ex) { lo = ex.lo; hi = ex.hi; }
  const min = Math.floor((lo - 20) / 10) * 10, max = hi + 7;
  return { min, max, year: (!isFinite(yearNow) || yearNow < min || yearNow > max) ? hi : yearNow };
}
