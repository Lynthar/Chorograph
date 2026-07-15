/* 地理/距离（双世界模型）：sphere=Haversine 大圆距离 + 经度环绕；flat=直角坐标直线距离。
   所有函数以 meta 为显式参数（旧实现读全局 state.world.meta）。 */
import type { Meta } from "./types.ts";

export const toRad = (d: number): number => d * Math.PI / 180;

/** 大圆距离（km）。R 缺省 10000（与旧实现一致） */
export function haversine(lon1: number, lat1: number, lon2: number, lat2: number, R?: number): number {
  const r = +(R ?? 0) || 10000;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 平面世界每度里程：显式 kmPerDeg，否则按 2πR/360 换算 */
export function flatKmPerDeg(meta: Meta | undefined): number {
  const m = meta || {};
  return +(m.kmPerDeg ?? 0) || (2 * Math.PI * (+(m.planetRadiusKm ?? 0) || 10000) / 360);
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
