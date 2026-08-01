/* 兵棋部队（v0.14 战术图）：位置插值、航点写入、行军可达性校验。
   自旧实现原样迁移并纯化——unitLegs 不再内建缓存（渲染帧不许触发 A*，
   缓存与失效由调用层管理，同旧版 state._legs 的角色）。 */
import { UNIT_KINDS } from "./constants.ts";
import { tget } from "./util.ts";
import { distKm, kmPerDegLat, toRad } from "./geo.ts";
import { astar } from "./route.ts";
import type { Grid } from "./grid.ts";
import type { Arm, Meta, TrackPt, Unit } from "./types.ts";

export function unitKind(u: Unit) { return tget(UNIT_KINDS, u.kind) || null; }
export function unitArm(u: Unit): Arm { return (u.arm || (unitKind(u) || {} as { arm?: Arm }).arm || "land") as Arm; }
export function unitSpeed(u: Unit): number { return +(u.speed || 0) || (unitKind(u) || {} as { v?: number }).v || 30; }

/* ── 逐航点存量（2026-07-30）：兵力/速度/士气随时间变。
   ⚠ 与 st 的「每航点各自声明、缺省＝常态」不同——这三样是**存量**，某航点没重新声明就意味着「没变」，
   绝不能悄悄弹回基线（打光的兵不会自己长回来）。故一律自当刻所在航点**向前回溯最近一次声明**。 ── */

/** 回溯 idx 及其之前最近一次声明的数值；min 用来放行「士气 0＝崩溃」这种有意义的零 */
function trackNum(u: Unit, idx: number, key: "strength" | "speed" | "morale", min: number): number | null {
  const tr = u.track || [];
  for (let i = Math.min(idx, tr.length - 1); i >= 0; i--) {
    const v = +(tr[i] as unknown as Record<string, unknown>)[key]!;
    if (isFinite(v) && v >= min) return v;
  }
  return null;
}
/** 当刻所在航点的序号；未入场/已离场＝-1（回溯不到任何航点，读数落到部队级基线） */
function idxAt(u: Unit, T: number): number { const p = unitPos(u, T); return p ? p.i : -1; }

/** 当刻兵力（人）：航点声明优先，回落部队级基线；无从可取＝null（不显示） */
export function unitStrengthAt(u: Unit, T: number): number | null {
  return trackNum(u, idxAt(u, T), "strength", 1) ?? parseStrength(u.strength);
}
/** 当刻速度（km/日）：航点声明 → 部队级 → 兵种表默认，三级回落 */
export function unitSpeedAt(u: Unit, T: number): number {
  return trackNum(u, idxAt(u, T), "speed", 1) ?? unitSpeed(u);
}
/** 当刻士气（0–100）：航点声明优先，回落部队级基线；无从可取＝null（未记录，不显示） */
export function unitMoraleAt(u: Unit, T: number): number | null {
  const w = trackNum(u, idxAt(u, T), "morale", 0);
  if (w != null) return w;
  const b = +(u.morale as number);
  return isFinite(b) && b >= 0 ? b : null;
}
/** 第 idx 个航点「若不声明则沿用的值」——只看它**之前**的航点，都没有才回落部队级基线。
    航点表单的占位符用它：所见即留空后的结果，「留空＝没变」这条语义才看得见。 */
export function unitInheritedAt(u: Unit, idx: number, key: "strength" | "speed" | "morale"): number | null {
  const w = trackNum(u, idx - 1, key, key === "morale" ? 0 : 1);
  if (w != null) return w;
  if (key === "strength") return parseStrength(u.strength);
  if (key === "speed") return unitSpeed(u);
  const b = +(u.morale as number);
  return isFinite(b) && b >= 0 ? b : null;
}

/** 兵力落库归一：只认纯数字（或纯数字串），返回「人」数；空/文本/非正数一律 null＝不设此键。
    严格到不容「8000骑」这类半数值——parseFloat 会悄悄取走 8000 丢掉「骑」，那正是要根除的静默变形。 */
export function parseStrength(v: unknown): number | null {
  const n = typeof v === "number" ? v : (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v) ? +v : NaN);
  return isFinite(n) && n > 0 ? n : null;
}

/** 兵力显示（存底恒为「人」的纯数字）：≥1 万折成「45万」「2.5万」，以下原样——
    兵棋标签/列表/浮签就在图面上，六位数读不动。折算只在显示层，数据一律是人数单值。
    ⚠ 字符串入参＝未经 normalizeWorld 的原始数据（旧档非数值兵力），原样返回不吞内容。 */
export function fmtStrength(v: unknown): string {
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return "";
    if (!/^\d+(\.\d+)?$/.test(s)) return s;
    v = +s;
  }
  const n = typeof v === "number" && isFinite(v) ? v : 0;
  if (n <= 0) return "";
  return n >= 10000 ? `${+(n / 10000).toFixed(2)}万` : String(+n.toFixed(2));
}
/** 部队火力半径（km）：单值 range 优先；旧多圈 ranges（v0.14 遗留）只读回退取首条（表单保存时归一） */
export function unitFireKm(u: Unit): number {
  /* 无远程投射能力的兵种（步/骑/后勤/侦察）火力圈一律不成立——判据只此一处，
     渲染、拾取、拖拽手柄、检查器读数、图例随之全灭，消费端不必各判一遍。 */
  if ((unitKind(u) || {} as { noFire?: boolean }).noFire) return 0;
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

/* ── 阵形足印（2026-07 特化柱B）：正面×纵深×朝向——万人步阵与二千轻骑不再同框等大。
   全部可选：无 frontKm ＝ 无足印 ＝ 标准兵棋框逐位不变（旧档零变化）。 ── */

/** 未显式给纵深时的正面:纵深比——战列的常见观感（2km 正面配 0.33km 纵深） */
export const DEPTH_RATIO = 6;

/** 阵形尺寸（km）：无正面＝null＝走标准框；纵深缺省由正面派生 */
export function unitFootKm(u: Unit): { front: number; depth: number } | null {
  const f = +(u.frontKm as number) || 0;
  if (!(f > 0)) return null;
  const d = +(u.depthKm as number) || 0;
  return { front: f, depth: d > 0 ? d : f / DEPTH_RATIO };
}

/** 经纬向的 km 换算基（同 ringPx/笔刷环之规：经向再除 cos 纬度，平面世界不除） */
function kmScale(meta: Meta | undefined, lat: number): { kpd: number; cosn: number } {
  const kpd = kmPerDegLat(meta);
  const cosn = (meta || {}).worldModel === "flat" ? 1 : Math.max(0.05, Math.cos(toRad(lat)));
  return { kpd, cosn };
}

/** 两点间方位角（度，0=正北顺时针）：经差按 cos 纬度折算＝与图面观感同向；零长返回 null */
export function bearingDeg(meta: Meta | undefined, lon1: number, lat1: number, lon2: number, lat2: number): number | null {
  const { cosn } = kmScale(meta, (lat1 + lat2) / 2);
  const e = (lon2 - lon1) * cosn, n = lat2 - lat1;
  if (Math.abs(e) < 1e-12 && Math.abs(n) < 1e-12) return null;
  return ((Math.atan2(e, n) * 180 / Math.PI) % 360 + 360) % 360;
}

/** 部队在 T 的朝向（度）：所处航段起点的显式 facing 优先（同 st「自该航点起生效」之规），
    否则取行进方向——行军纵队本就朝行进向；驻止（末航点后）沿用上一段方向；无从可取＝正北。 */
export function unitFacingAt(meta: Meta | undefined, u: Unit, T: number): number {
  const p = unitPos(u, T);
  if (!p) return 0;
  const tr = u.track || [];
  const f = +(tr[p.i] || {}).facing!;
  if (isFinite(f)) return ((f % 360) + 360) % 360;
  const nxt = tr[p.i + 1];
  const fwd = nxt ? bearingDeg(meta, tr[p.i].lon, tr[p.i].lat, nxt.lon, nxt.lat) : null;
  if (fwd != null) return fwd;
  const prv = p.i > 0 ? bearingDeg(meta, tr[p.i - 1].lon, tr[p.i - 1].lat, tr[p.i].lon, tr[p.i].lat) : null;
  return prv ?? 0;
}

/** 阵位条四角的经纬（绘制与拾取同源）：在地面 km 空间按朝向转出再折回度——
    正面＝垂直于朝向的边、纵深＝沿朝向的边，部队位置＝阵形中心。
    顺序＝前左 → 前右 → 后右 → 后左（前缘即 [0]–[1]，画粗一道即见朝向）。 */
export function footCornersLL(meta: Meta | undefined, lon: number, lat: number,
  front: number, depth: number, facing: number): [number, number][] {
  const { kpd, cosn } = kmScale(meta, lat);
  const a = toRad(facing), s = Math.sin(a), c = Math.cos(a);
  const hw = front / 2, hd = depth / 2;
  /* du＝沿正面（朝向的右手为正）、dv＝沿朝向（向前为正） */
  return ([[-hw, hd], [hw, hd], [hw, -hd], [-hw, -hd]] as [number, number][]).map(([du, dv]) => {
    const kmE = du * c + dv * s, kmN = -du * s + dv * c;
    return [lon + kmE / (kpd * cosn), lat + kmN / kpd] as [number, number];
  });
}

export interface Leg {
  i: number; a: TrackPt; b: TrackPt;
  km: number; days: number; need: number; ok: boolean; route: boolean;
}

/* 一日行军约几小时：速度 v(km/日)是「含宿营休整的整日配额」,不是 24 小时匀速——
   亚日航段(时辰级战役分帧)按 v/MARCH_H 的小时行军速率折算,否则 2 小时突击 5km
   在 30km/日 之下会被 24 小时摊薄算成超速(井陉成图实测误报)。 */
const MARCH_H = 8;

/** 行军可达性：逐腿校验 A*里程(按兵种) vs 速度×间隔天数；飞行=直线。工具当账房，胜负由你。
    耗时 need(日)分两域：km>一日配额 v ＝ km/v(跨日,旧语义逐位——黄金腿全为整日间隔);
    km≤v ＝ km/(v×24/MARCH_H)(纯行军时数,一日配额内的短途冲刺不吃宿营摊薄)。
    两域与容量模型自洽:一日内至多行军 MARCH_H 小时、至多走完配额 v。 */
export function unitLegs(meta: Meta | undefined, grid: Grid, roads: Set<string> | undefined, u: Unit): Leg[] {
  const tr = u.track || [];
  const arm = unitArm(u), base = unitSpeed(u), legs: Leg[] = [];
  for (let i = 1; i < tr.length; i++) {
    const a = tr[i - 1], b = tr[i], days = b.t - a.t;
    /* 逐腿速度：这一腿走的是**出发航点**当时生效的速度（存量回溯，同 unitSpeedAt 之规）。
       旧档航点上没有 speed，回溯必空、恒落到部队级基线＝旧腿账逐位不变。 */
    const v = trackNum(u, i - 1, "speed", 1) ?? base;
    let km = distKm(meta, a.lon, a.lat, b.lon, b.lat), route = false;
    if (arm !== "air") {
      const r = astar(meta, grid, roads, [a.lon, a.lat], [b.lon, b.lat], arm);
      if (r && isFinite(r.dist)) { km = r.dist; route = true; }
    }
    const need = km > v ? km / v : km / (v * 24 / MARCH_H);
    legs.push({ i, a, b, km, days, need, ok: days > 0 && need <= days + 1e-9, route });
  }
  return legs;
}
