/* 按图种（战术图 / 战略图）挑的尺度参数：两份就地写定，是这些数的唯一真源。
   改任何一个都是行为变更——网格密度、侵蚀缓存键、放大上限与笔刷档位跟着变；tests/scale.test.ts 逐字钉着两份。 */
import type { Meta } from "./types.ts";

export type MapKind = "tactical" | "strategic";

/** meta.mapKind 恰为 "tactical" 才是战术图；缺 meta、缺键与其他任何值都是战略图 */
export function mapKindOf(meta: Meta | undefined): MapKind {
  return (meta || {}).mapKind === "tactical" ? "tactical" : "strategic";
}

export interface ScaleProfile {
  /** 显式 meta.gridN 的列数下限（格） */
  readonly gridNMin: number;
  /** 地形网格的列数上限（格；显式 gridN 与自动档同钳） */
  readonly gridNMax: number;
  /** 自动档的目标格边（公里） */
  readonly cellKm: number;
  /** 自动档的总格数上限（格） */
  readonly cellCap: number;
  /** 侵蚀工作档的细格数预算（细格） */
  readonly fineCap: number;
  /** 静置精修预算相对主机精修预算的倍率（无量纲） */
  readonly ultraCapK: number;
  /** 开不开分块精修（开了还要本机有块车道） */
  readonly tiles: boolean;
  /** 放大到底时比例尺条（SCALE_BAR_PX 像素）对应的地面距离（公里） */
  readonly scaleFloorKm: number;
  /** 放大上限是否另按数据封顶：块层最细一档的格占到 ZOOM_CELL_PX 个 CSS 像素为止 */
  readonly zoomDataCap: boolean;
  /** 笔刷低端的定值档（名义直径，公里，自第 1 档起，至少一项）；其后各档自末项线性递增到 brushTopKm */
  readonly brushLowKm: readonly number[];
  /** 笔刷末档（第 BRUSH_NOTCHES 档）的名义直径（公里） */
  readonly brushTopKm: number;
  /** 高程笔的幅度档（米/笔，升序）；首项兼显式幅度的下限 */
  readonly heightStepsM: readonly number[];
  /** 高程笔自动档的幅度（米/笔） */
  readonly heightAutoM: number;
}

export const SCALE_PROFILES: Readonly<Record<MapKind, ScaleProfile>> = {
  tactical: {
    gridNMin: 60, gridNMax: 1600,
    cellKm: 0.1,              // ＝笔刷首档：格边即最小笔刷
    cellCap: 2_600_000,       // 约主机精修预算高档的 1/4：域内战术图 4K 精修恒 ≥ 2×
    fineCap: 1_500_000,
    ultraCapK: 1, tiles: false,
    scaleFloorKm: 0.5, zoomDataCap: false,
    brushLowKm: [0.1, 0.3, 0.5, 0.7, 1, 1.5, 2],   // 纯线性时第 2 档就到 742 m，100 m 格上 3、5 格宽的笔够不着
    brushTopKm: 20,
    heightStepsM: [1, 5, 10, 25, 50], heightAutoM: 10,
  },
  strategic: {
    gridNMin: 1,              // 显式列数不设下限：小图幅要表达得出粗格（4° 的图要 1°/格只需 4 列）
    gridNMax: 1800,
    cellKm: 20 / 3,           // 笔刷首档 20 km 恰 3 格，且不粗过 32 档逐档互异的上限 7.74 km
    cellCap: 1_500_000,       // 出厂星球全球图 1500×708＝106 万格在内
    fineCap: 2_400_000,
    ultraCapK: 0.5, tiles: true,
    scaleFloorKm: 50, zoomDataCap: true,
    brushLowKm: [20],         // 线性低端本就逐档互异：相邻档差 15.48 km，半径约差一格
    brushTopKm: 500,
    heightStepsM: [10, 25, 50, 100, 250], heightAutoM: 50,
  },
};

export function scaleProfile(meta: Meta | undefined): ScaleProfile {
  return SCALE_PROFILES[mapKindOf(meta)];
}
