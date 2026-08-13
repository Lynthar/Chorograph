/* 笔刷尺度（2026-08-12 用户点单）：滑杆自此不是「格数」而是**物理尺度 32 档**——
   战术 100m→20km、战略 20km→500km，两端点之间线性。按图种给档表，同 HEIGHT_STEPS_* 之规。
   ⚠ 笔刷只能整格地涂（涂宽恒 2R+1 格），故档位是**名义**尺度，实际涂到多宽由网格密度定：
   名义不足一格即退化成单格。读数一律报 brushActualKm 的**实际**涂宽 + 格数——滑杆推不动时
   看得见是为什么（战略图地形格恒 1°≈111km，前十余档必然同落一格，是数据粒度使然不是缺陷；
   战术图 112m/格 时 32 档给得出 ~31 个不同尺寸）。名义值除了定档位之外不喂任何消费点。 */
import { kmPerDeg } from "./elev.ts";
import { gridStepDeg } from "./grid.ts";
import { paintStep } from "./territory.ts";
import type { Meta } from "./types.ts";

export const BRUSH_NOTCHES = 32;
export const BRUSH_KM_TAC: readonly [number, number] = [0.1, 20];      // 战术：100m → 20km
export const BRUSH_KM_STRAT: readonly [number, number] = [20, 500];    // 战略：20km → 500km

/** 第 notch 档的名义直径（公里）；notch 钳 [1,32]，非数当 1 */
export function brushNominalKm(meta: Meta | undefined, notch: number): number {
  const [lo, hi] = (meta || {}).mapKind === "tactical" ? BRUSH_KM_TAC : BRUSH_KM_STRAT;
  const n = Math.min(BRUSH_NOTCHES, Math.max(1, Math.round(notch) || 1));
  return lo + (hi - lo) * (n - 1) / (BRUSH_NOTCHES - 1);
}

/** 笔刷所在网格的格边度数：涂域笔走 paintStep（涂域自有更细网格），地形笔走地形网格步长 */
export function brushStepDeg(meta: Meta | undefined, sub: string): number {
  return sub === "paint" ? paintStep(meta) : gridStepDeg(meta);
}

/* 圆盘半径上限：涂改逐 dab 是 O((2R+1)²)，而 `meta.kmPerDeg` 是存档里的自由数值——一个
   「1 米/度」的玩具尺度世界会把 20km 档算成千万格半径，一笔就把主线程钉死（同「键名也是
   用户数据」之规，值同样是用户数据）。256 从不咬合法图：gridN 上钳 400＝满幅 R=200，
   战略 360° 满幅 R=180。⚠ 判据写成 `R > 0 ? … : 0` 而非 max/min——NaN 过 Math.max 会原样漏出去。 */
const MAX_R = 256;

/** 名义直径 → 圆盘半径格数 R（涂宽 2R+1 格，与 paintTerrainAt/brushCells 的 size=R+1 对齐；0＝单格） */
export function brushRadiusCells(meta: Meta | undefined, sub: string, notch: number): number {
  const cellKm = brushStepDeg(meta, sub) * kmPerDeg(meta);
  const R = Math.round((brushNominalKm(meta, notch) / cellKm - 1) / 2);
  return R > 0 ? Math.min(MAX_R, R) : 0;
}

/** 实际涂宽（公里）＝(2R+1) 格——读数报这个，名义值在不足一格时是假的 */
export function brushActualKm(meta: Meta | undefined, sub: string, R: number): number {
  return (2 * R + 1) * brushStepDeg(meta, sub) * kmPerDeg(meta);
}

/** 笔刷读数格式：相邻档相差数百米，core/util 的 fmtKm 在 ≥1km 处取整会把连着几档印成同一个数 */
export function fmtBrushKm(km: number): string {
  if (km < 1) return Math.round(km * 1000) + " m";
  if (km < 10) return (Math.round(km * 10) / 10).toFixed(1) + " km";
  return Math.round(km) + " km";
}
