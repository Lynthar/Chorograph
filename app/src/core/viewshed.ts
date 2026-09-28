/* 视域：在规则场上从观察点向圈内每格判「打得到 / 看得见」。R2 射线法——向窗口周界每格各投一条射线，
   每格取离它格心最近的那条射线的判定；眼位可在驻地半径内挑最高的格心（圈仍以部队为心）；沿线地面按格心双线性连续面采样（与观感底图画的同一张面；读格心
   台阶会让相邻格把 2 m 眼位挡死）。地表曲率按有效半径 R/(1−k) 折算（k＝大气折射系数），距 d 处地面
   下沉 d²/2R′。两种判据：视线（沿线记最大仰角切线）；曲射弹道（固定射角 θ 的真空抛物线——目标在 d 处
   可达 ⇔ q(d)＝(z₀+tanθ·d−z_t)/d² 非负且不大于沿线之前每格的 q，一趟运行最小值即判完）。纯函数、同输入逐位同输出。
   sightTo 是点对点的同一判据（飞行部队被谁看见）：眼位与地面取样和掩膜共用。 */
import { elevBilinear, type FieldGeom } from "./elev.ts";
import type { BBox } from "./types.ts";

/** 视线判定的场：规则场数据 + 粗格水面（水格抬到水面再判——湖上的船不在湖底）+ 物理标定 */
export interface ViewField extends FieldGeom {
  data: Float32Array;
  /** 粗格水面高程（core/elev.waterSurface）与粗格几何；bb 与规则场同 */
  wsurf: Float32Array; gstep: number; gcols: number; grows: number;
  unitM: number;                 // 米/抽象高程单位
  kmx: number; kmy: number;      // 经/纬向 km/度（经向已含中央纬度折算）
  curvKm: number;                // 曲率半径 km；0＝不计曲率
}
export interface Observer {
  lon: number; lat: number;
  eyeM: number;                  // 观察高度／发射高度（地面以上，米）
  tgtM: number;                  // 目标高度（地面以上，米）；弹道判定不用（炮弹落在地面）
  km: number;                    // 半径
  refract: number;               // 大气折射系数 k（光学 1/7、雷达 1/4）
  arcDeg?: number;               // 曲射射角（度）：有值＝弹道判定，否则视线判定
  vantageM?: number;             // 眼位可挑的驻地半径（米）：取此范围内最高的格心；0/缺＝原地
  gainM?: number;                // 挪眼位的最小抬升（米）：不足就留在原地；0/缺＝任何抬升都挪
  eyeAbsM?: number;              // 眼位海拔（米，飞行部队）：有值＝眼位取 max(地面, 它)，eyeM 与驻地不用
}
/** 视线掩膜：窗口 bb（度）内 rows×cols 格，行 0 在南；vis 1＝视线可达。nIn＝圈内格数、nVis＝其中可达；eyeOff＝眼位离部队的水平距离（米），0＝原地 */
export interface VisMask { bb: BBox; cols: number; rows: number; vis: Uint8Array; nVis: number; nIn: number; eyeOff: number }
/** 一个观察者的掩膜：视野圈、火力圈（直射按视线、曲射按弹道）、雷达各按自己的半径与眼位判，互不裁切——看得见不等于打得到。
    火力按圈下标（部队只有第 0 圈，地点可多圈） */
export interface RingMasks { vision?: VisMask; fire?: (VisMask | undefined)[]; radar?: VisMask }
/** 部队与地点各一张表（id 取自存档，两类之间可能重名） */
export interface VisMasks { unit: Map<string, RingMasks>; node: Map<string, RingMasks> }
export function noMasks(): VisMasks { return { unit: new Map(), node: new Map() }; }

/** 目标高度缺省：站立的人 */
export const TARGET_M = 2;
/** 光学视线的大气折射系数（GRASS r.viewshed 缺省 1/7） */
export const REFRACT_OPTICAL = 1 / 7;
/** 雷达的大气折射系数（4/3 地球半径） */
export const REFRACT_RADAR = 1 / 4;
/** 水陆判据与渲染端同式（e < ws − 0.02 为水） */
const WATER_EPS = 0.02;

/** 规则场上的地面取样：surface＝格 (c,r) 里高程 e 处的地面（米），水格抬到水面——观察者与目标同一判据，
    船在湖面上、不在湖底；bil＝细格坐标 (px,py) 的格心双线性高程——观察者与沿线采样同一张面 */
function terrainOf(f: ViewField) {
  const gk = f.step / f.gstep;   // 细格→粗格
  const surface = (c: number, r: number, e: number): number => {
    const gc = Math.min(f.gcols - 1, Math.floor((c + 0.5) * gk)), gr = Math.min(f.grows - 1, Math.floor((r + 0.5) * gk));
    const ws = f.wsurf[gr * f.gcols + gc];
    return (e < ws - WATER_EPS ? ws : e) * f.unitM;
  };
  const bil = (px: number, py: number): number => elevBilinear(f.data, f, f.bb.lonMin + px * f.step, f.bb.latMin + py * f.step);
  return { surface, bil };
}
type Terrain = ReturnType<typeof terrainOf>;

/** 观察者的几何：(ux,uy) 圈心＝部队位置、(ox,oy) 眼位（细格坐标）、z0 眼位海拔（米）、mx/my 米/格、R 半径（米）、vr 驻地半径（米） */
interface Eye { ux: number; uy: number; ox: number; oy: number; z0: number; mx: number; my: number; R: number; vr: number }
/** 观察点在场外或半径非正＝null。眼位：驻地半径内挑最高的格心（炮位设在驻地最高处），但**抬升不足 gainM 就不挪**——
    亚米级起伏是侵蚀场的细节噪声，为它挪几百米会把掠射几何整个换一遍且净亏；同高取最近；半径钳到射程内＝眼位不出窗 */
function eyeOf(f: ViewField, t: Terrain, o: Observer): Eye | null {
  const { bb, step, cols, rows, data } = f;
  const ux = (o.lon - bb.lonMin) / step, uy = (o.lat - bb.latMin) / step;
  if (!(ux >= 0 && ux < cols && uy >= 0 && uy < rows) || !(o.km > 0)) return null;
  const mx = 1000 * f.kmx * step, my = 1000 * f.kmy * step, R = o.km * 1000;
  let ox = ux, oy = uy, zg0 = t.surface(Math.floor(ux), Math.floor(uy), t.bil(ux, uy));
  if (o.eyeAbsM != null) return { ux, uy, ox, oy, z0: Math.max(zg0, o.eyeAbsM), mx, my, R, vr: 0 };
  const vr = Math.min(o.vantageM || 0, R);
  if (vr > 0) {
    let hi = zg0 + (o.gainM || 0), od2 = Infinity;
    for (let r = Math.max(0, Math.floor(uy - vr / my)); r <= Math.min(rows - 1, Math.floor(uy + vr / my)); r++)
      for (let c = Math.max(0, Math.floor(ux - vr / mx)); c <= Math.min(cols - 1, Math.floor(ux + vr / mx)); c++) {
        const ex = (c + 0.5 - ux) * mx, ey = (r + 0.5 - uy) * my, d2 = ex * ex + ey * ey;
        if (d2 > vr * vr) continue;
        const g = t.surface(c, r, data[r * cols + c]);
        /* 只有**严格高过**门槛才离开原地；离开之后同高取最近 */
        if (g > hi || (g === hi && od2 < Infinity && d2 < od2)) { hi = g; ox = c + 0.5; oy = r + 0.5; od2 = d2; }
      }
    if (od2 < Infinity) zg0 = hi;
  }
  return { ux, uy, ox, oy, z0: zg0 + o.eyeM, mx, my, R, vr };
}
/** 地表曲率：距 d 处地面下沉 d²·inv2R（有效半径 R/(1−k)）；0＝不计 */
const curvOf = (f: ViewField, o: Observer): number => f.curvKm > 0 ? (1 - o.refract) / (2 * f.curvKm * 1000) : 0;

/** 观察点在场外或半径非正＝null */
export function viewshed(f: ViewField, o: Observer): VisMask | null {
  const { bb, step, cols, rows } = f;
  const ter = terrainOf(f), surface = ter.surface, bil = ter.bil, e = eyeOf(f, ter, o);
  if (!e) return null;
  const { ux, uy, ox, oy, z0, mx, my, R, vr } = e;
  const rc = R / mx, rr = R / my;
  const c0 = Math.max(0, Math.floor(ux - rc)), c1 = Math.min(cols - 1, Math.floor(ux + rc));
  const r0 = Math.max(0, Math.floor(uy - rr)), r1 = Math.min(rows - 1, Math.floor(uy + rr));
  const W = c1 - c0 + 1, H = r1 - r0 + 1;
  const vis = new Uint8Array(W * H), near = new Float32Array(W * H).fill(Infinity);
  const uc = Math.floor(ux), ur = Math.floor(uy), oc = Math.floor(ox), or = Math.floor(oy);
  const inv2R = curvOf(f, o);
  const R2 = R * R, R2out = (R + vr + Math.hypot(mx, my)) ** 2;   // 射线自眼位多走驻地偏移加一格对角线：格心在圈内而穿越段中点在圈外的贴边格也要判到
  const arc = o.arcDeg != null && o.arcDeg > 0;
  const tanA = arc ? Math.tan(Math.min(85, Math.max(5, o.arcDeg!)) * Math.PI / 180) : 0;
  vis[(ur - r0) * W + (uc - c0)] = 1; near[(ur - r0) * W + (uc - c0)] = 0;   // 自己脚下
  vis[(or - r0) * W + (oc - c0)] = 1; near[(or - r0) * W + (oc - c0)] = 0;   // 眼位所在格
  const cast = (tc: number, tr: number): void => {
    const dx = tc + 0.5 - ox, dy = tr + 0.5 - oy;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) return;
    /* Amanatides-Woo 走格：t∈[0,1] 自观察点到目标格心，每步进入一个新格，取该格穿越段中点采样 */
    let c = oc, r = or, t = 0;
    const sc = dx > 0 ? 1 : -1, sr = dy > 0 ? 1 : -1;
    let tx = dx !== 0 ? ((dx > 0 ? c + 1 : c) - ox) / dx : Infinity;
    let ty = dy !== 0 ? ((dy > 0 ? r + 1 : r) - oy) / dy : Infinity;
    const ddx = dx !== 0 ? Math.abs(1 / dx) : Infinity, ddy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let maxTan = -Infinity, qMin = Infinity;
    for (;;) {
      if (tx < ty) { c += sc; t = tx; tx += ddx; } else { r += sr; t = ty; ty += ddy; }
      if (t >= 1 || c < c0 || c > c1 || r < r0 || r > r1) break;
      const tm = (t + Math.min(tx, ty)) / 2;
      const px = ox + dx * tm, py = oy + dy * tm;
      const ex = (px - ox) * mx, ey = (py - oy) * my, d2 = ex * ex + ey * ey;
      if (d2 > R2out) break;
      const d = Math.sqrt(d2);
      const zg = surface(c, r, bil(px, py)) - d2 * inv2R;
      let seen: 0 | 1;
      if (arc) {
        /* 本格既是目标也是后方格的障碍：同一个 q 先判可达（对之前各格的最小值），再并入运行最小值 */
        const q = (z0 + tanA * d - zg) / d2;
        seen = q >= 0 && q <= qMin ? 1 : 0;
        if (q < qMin) qMin = q;
      } else {
        seen = (zg + o.tgtM - z0) / d >= maxTan ? 1 : 0;
        const tg = (zg - z0) / d;
        if (tg > maxTan) maxTan = tg;
      }
      const ccx = (c + 0.5 - ux) * mx, ccy = (r + 0.5 - uy) * my;
      if (ccx * ccx + ccy * ccy > R2) continue;   // 格心在圈外（圈以部队为心）：只当障碍，不落判定
      const i = (r - r0) * W + (c - c0);
      const off = Math.abs((c + 0.5 - ox) * dy - (r + 0.5 - oy) * dx) / len;   // 格心到射线的垂距（格）
      if (off < near[i]) { near[i] = off; vis[i] = seen; }
    }
  };
  for (let c = c0; c <= c1; c++) { cast(c, r0); if (r1 !== r0) cast(c, r1); }
  for (let r = r0 + 1; r < r1; r++) { cast(c0, r); if (c1 !== c0) cast(c1, r); }
  let nVis = 0, nIn = 0;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const ex = (c + 0.5 - ux) * mx, ey = (r + 0.5 - uy) * my;
    if (ex * ex + ey * ey > R2) continue;
    nIn++;
    if (vis[(r - r0) * W + (c - c0)]) nVis++;
  }
  return {
    bb: { lonMin: bb.lonMin + c0 * step, lonMax: bb.lonMin + (c1 + 1) * step, latMin: bb.latMin + r0 * step, latMax: bb.latMin + (r1 + 1) * step },
    cols: W, rows: H, vis, nVis, nIn, eyeOff: Math.hypot((ox - ux) * mx, (oy - uy) * my)
  };
}

/** 点对点视线的结果：inRange＝在圈的半径内，seen＝视线未被地形挡 */
export interface SightHit { inRange: boolean; seen: boolean }
/** 看见了目标的那些（在半径内且视线未被挡） */
export function detectedBy<T extends { hit: SightHit | null }>(rs: T[] | undefined): T[] {
  return (rs || []).filter(r => !!r.hit && r.hit.inRange && r.hit.seen);
}

/** 点对点视线：观察者 o（眼位同 viewshed）看 (lon,lat) 处海拔 zAbsM 的目标（低于地面按地面），视线判据同掩膜
    （目标仰角切线不低于沿线每处地面的切线）。inRange＝目标离圈心不超过半径；观察者或目标在场外＝null */
export function sightTo(f: ViewField, o: Observer, lon: number, lat: number, zAbsM: number): SightHit | null {
  const tr = terrainOf(f), e = eyeOf(f, tr, o);
  const tx = (lon - f.bb.lonMin) / f.step, ty = (lat - f.bb.latMin) / f.step;
  if (!e || !(tx >= 0 && tx < f.cols && ty >= 0 && ty < f.rows)) return null;
  const inRange = Math.hypot((tx - e.ux) * e.mx, (ty - e.uy) * e.my) <= e.R;
  const D = Math.hypot((tx - e.ox) * e.mx, (ty - e.oy) * e.my), inv2R = curvOf(f, o);
  if (!(D > 0)) return { inRange, seen: true };
  const zT = Math.max(tr.surface(Math.floor(tx), Math.floor(ty), tr.bil(tx, ty)), zAbsM) - D * D * inv2R;
  const tanT = (zT - e.z0) / D;
  /* 沿线每半格取一次地面（与掩膜同一张双线性面、同一水面与曲率），任何一处切线高过目标即被挡 */
  const n = Math.ceil(2 * Math.hypot(tx - e.ox, ty - e.oy));
  for (let k = 1; k < n; k++) {
    const s = k / n, px = e.ox + (tx - e.ox) * s, py = e.oy + (ty - e.oy) * s, d = D * s;
    if ((tr.surface(Math.floor(px), Math.floor(py), tr.bil(px, py)) - d * d * inv2R - e.z0) / d > tanT) return { inRange, seen: false };
  }
  return { inRange, seen: true };
}
