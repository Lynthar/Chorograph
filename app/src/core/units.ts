/* 兵棋部队（v0.14 战术图）：位置插值、航点写入、行军可达性校验。
   自旧实现原样迁移并纯化——unitLegs 不再内建缓存（渲染帧不许触发 A*，
   缓存与失效由调用层管理，同旧版 state._legs 的角色）。 */
import { UNIT_KINDS } from "./constants.ts";
import { distKm } from "./geo.ts";
import { astar } from "./route.ts";
import type { Grid } from "./grid.ts";
import type { Arm, Meta, TrackPt, Unit } from "./types.ts";

export function unitKind(u: Unit) { return UNIT_KINDS[u.kind] || null; }
export function unitArm(u: Unit): Arm { return (u.arm || (unitKind(u) || {} as { arm?: Arm }).arm || "land") as Arm; }
export function unitSpeed(u: Unit): number { return +(u.speed || 0) || (unitKind(u) || {} as { v?: number }).v || 30; }
/** 部队火力半径（km）：单值 range 优先；旧多圈 ranges（v0.14 遗留）只读回退取首条（表单保存时归一） */
export function unitFireKm(u: Unit): number {
  const rk = +(u.range as number) || 0;
  if (rk > 0) return rk;
  const legacy = +((u.ranges || [])[0] || {}).km || 0;
  return legacy > 0 ? legacy : 0;
}

export interface UnitPos { lon: number; lat: number; i: number }

/** 部队在日戳 T 的位置：首航点前=未入场(null)；航点间=线性插值；末航点后=停驻；until 后=离场 */
export function unitPos(u: Unit, T: number): UnitPos | null {
  const tr = u.track || [];
  if (!tr.length) return null;
  if (u.until != null && T >= u.until) return null;
  if (u.since != null && T < u.since) return null;
  if (T < tr[0].t) return null;
  for (let i = tr.length - 1; i >= 0; i--) {
    if (T >= tr[i].t) {
      if (i === tr.length - 1 || tr[i + 1].t === tr[i].t) return { lon: tr[i].lon, lat: tr[i].lat, i };
      const a = tr[i], b = tr[i + 1], k = (T - a.t) / (b.t - a.t);
      return { lon: a.lon + (b.lon - a.lon) * k, lat: a.lat + (b.lat - a.lat) * k, i };
    }
  }
  return null;
}

/** 写/改某日航点：同日=改写（保留原状态 st），异日=插入并按日排序（原地修改；调用层负责失效 legs 缓存） */
export function setUnitPoint(u: Unit, T: number, lon: number, lat: number): void {
  u.track = u.track || [];
  const p: TrackPt = { t: +T, lon: +(+lon).toFixed(4), lat: +(+lat).toFixed(4) };
  const i = u.track.findIndex(q => q.t === +T);
  if (i >= 0) { if (u.track[i].st) p.st = u.track[i].st; u.track[i] = p; }
  else { u.track.push(p); u.track.sort((a, b) => a.t - b.t); }
}

/** 部队在日戳 T 的状态（UNIT_STATUS 键）：取所处航段起点航点的 st；未入场/无状态=null */
export function unitStatusAt(u: Unit, T: number): string | null {
  const p = unitPos(u, T);
  if (!p) return null;
  const q = (u.track || [])[p.i];
  return (q && q.st) || null;
}

export interface Leg {
  i: number; a: TrackPt; b: TrackPt;
  km: number; days: number; need: number; ok: boolean; route: boolean;
}

/** 行军可达性：逐腿校验 A*里程(按兵种) vs 速度×间隔天数；飞行=直线。工具当账房，胜负由你。 */
export function unitLegs(meta: Meta | undefined, grid: Grid, roads: Set<string> | undefined, u: Unit): Leg[] {
  const tr = u.track || [];
  const arm = unitArm(u), v = unitSpeed(u), legs: Leg[] = [];
  for (let i = 1; i < tr.length; i++) {
    const a = tr[i - 1], b = tr[i], days = b.t - a.t;
    let km = distKm(meta, a.lon, a.lat, b.lon, b.lat), route = false;
    if (arm !== "air") {
      const r = astar(meta, grid, roads, [a.lon, a.lat], [b.lon, b.lat], arm);
      if (r && isFinite(r.dist)) { km = r.dist; route = true; }
    }
    const need = km / v;
    legs.push({ i, a, b, km, days, need, ok: days > 0 && need <= days + 1e-9, route });
  }
  return legs;
}
