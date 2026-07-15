/* 时间为基底：任意对象（地点/连线/布景/地形涂改/派系/涂域层）的存在时段判定。
   无 since/until = 全期存在（旧数据零迁移）。战略图 yr=年份，战术图 yr=日戳 T——同一套逻辑。 */
import { calOf, fromT, yearSpanT } from "./calendar.ts";
import type { Owner, PaintLayer, Timed, World, WorldNode } from "./types.ts";

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

/** 作战线显隐：带时段=[since,until) 判定（分相位箭头，独立于事件时刻）；
    无时段=事件当年/当日精确相等（旧语义，旧档零迁移）。渲染与拾取共用同一规则 */
export function opVisibleAt(ev: { year?: number }, op: Timed, yr: number): boolean {
  return (op.since != null || op.until != null) ? activeAt(op, yr) : ev.year === yr;
}

/** 势力涂域：某年生效的涂绘层（可分时段/多层） */
export function paintLayersAt(f: { paint?: PaintLayer[] }, yr: number): PaintLayer[] {
  return (f.paint || []).filter(L => {
    const s = (L.since == null ? -Infinity : L.since), u = (L.until == null ? Infinity : L.until);
    return yr >= s && yr < u;
  });
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
  const pos = (v: unknown): v is number => typeof v === "number" && v > 0;
  const yrs = [...(world.nodes || []).filter(n => n.type === "event" && isFinite(n.year as number)).map(n => n.year as number),
               ...(world.factions || []).filter(f => pos(f.since)).map(f => f.since as number),
               ...[...(world.nodes || []), ...(world.edges || [])].filter(o => pos(o.since)).map(o => o.since as number)
              ].filter(y => isFinite(y));
  let lo = 3000, hi = 3100;
  if (yrs.length) { lo = hi = yrs[0]; for (const y of yrs) { if (y < lo) lo = y; if (y > hi) hi = y; } }   // 同上，循环取极值
  const min = Math.floor((lo - 20) / 10) * 10, max = hi + 7;
  return { min, max, year: (!isFinite(yearNow) || yearNow < min || yearNow > max) ? hi : yearNow };
}
