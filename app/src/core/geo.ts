/* 地理/距离（双世界模型）：sphere=Haversine 大圆距离 + 经度环绕；flat=直角坐标直线距离。
   所有函数以 meta 为显式参数（旧实现读全局 state.world.meta）。 */
import type { BBox, Meta } from "./types.ts";

export const toRad = (d: number): number => d * Math.PI / 180;

/** 大圆距离（km）。R=行星半径，**必填**——原先是 `R?` 缺省 10000（旧实现读全局 meta 半径，移植时改成了参数）：
    唯一调用方 `distKm` 一直显式传值，故从无现网 bug，但缺省分支是一颗哑雷——将来任何 core 代码
    直接 `haversine(a,b,c,d)` 不传 R，对所有非 10000km 半径的世界（地球图 6371）都得系统性错误距离，
    而**平价测试反而掩盖它**：用例全都显式传 6371，缺省分支零覆盖、改坏了也不变红。
    改必填即让缺省这件事根本不存在，此后 tsc 保证漏不了；`+(R) || 10000` 仍留作 0/NaN 的兜底。 */
export function haversine(lon1: number, lat1: number, lon2: number, lat2: number, R: number): number {
  const r = +R || 10000;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 平面世界每度里程：显式 kmPerDeg，否则按 2πR/360 换算 */
export function flatKmPerDeg(meta: Meta | undefined): number {
  const m = meta || {};
  return +(m.kmPerDeg ?? 0) || (2 * Math.PI * (+(m.planetRadiusKm ?? 0) || 10000) / 360);
}

/** 纬度每度公里数：平面走 flatKmPerDeg，球面按 2πR/360——与 distKm 同轨。
    2026-08-12 自 elev.ts 迁来：网格密度（core/grid）要按公里定格边，而「网格依赖高程」是错的依赖方向。 */
export function kmPerDeg(meta: Meta | undefined): number {
  const m = meta || {};
  return m.worldModel === "flat" ? flatKmPerDeg(m) : 2 * Math.PI * (+(m.planetRadiusKm ?? 0) || 10000) / 360;
}

/** 经向折算系数（经差 × 它 ＝ 与纬差同尺度）：平面世界恒 1，球面取 cos 纬度、极区兜底不除零。
    地板 = cos 85°，与战术图幅 ±85° 的钳（tactical.ts）同源，|纬度| ≤ 85° 处就是真 cos。
    圈的半轴 / 公里网 / 缩放地板 / 烘焙投影 / 坡度基底 / 侵蚀与视域格距全走它——各写一份就是各画各的椭圆。 */
export const COS_LAT_FLOOR = 0.087;
export function lonCos(meta: Meta | undefined, lat: number): number {
  return (meta || {}).worldModel === "flat" ? 1 : Math.max(COS_LAT_FLOOR, Math.cos(toRad(lat)));
}

/** 经/纬向 km/度：纬向同 kmPerDeg；经向按图幅中央纬度折算（lonCos）。侵蚀与视域的格距度量同源。 */
export function kmPerDegXY(meta: Meta | undefined, bb: BBox): { kmx: number; kmy: number } {
  const m = meta || {};
  const kmy = kmPerDeg(m);
  return { kmx: kmy * lonCos(m, (bb.latMin + bb.latMax) / 2), kmy };
}

/** 统一距离入口：球面=大圆；平面=直线 */
export function distKm(meta: Meta | undefined, lon1: number, lat1: number, lon2: number, lat2: number): number {
  const m = meta || {};
  if (m.worldModel === "flat") {
    const k = flatKmPerDeg(m);
    return Math.hypot((lon2 - lon1) * k, (lat2 - lat1) * k);
  }
  return haversine(lon1, lat1, lon2, lat2, +(m.planetRadiusKm ?? 0) || 10000);
}

/** 每纬度里程（地点范围圈/缩放下限用） */
export function kmPerDegLat(meta: Meta | undefined): number {
  const m = meta || {};
  return m.worldModel === "flat" ? flatKmPerDeg(m) : (2 * Math.PI * (+(m.planetRadiusKm ?? 0) || 10000) / 360);
}

/** 经度归一到 [-180,180)；平面世界不折返（有"世界之涯"） */
export function wrapLon(l: number, flat: boolean): number {
  if (flat) return l;
  return ((l + 180) % 360 + 360) % 360 - 180;
}
