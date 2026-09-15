/* 地形渲染器统一入口：
   优先 WebGL2——PoC 实测连 SwiftShader 纯软渲都比旧 CPU 瓦片快 6×，故**凡能建出
   WebGL2 上下文（含软渲）一律走 GPU**；仅上下文创建/着色器编译失败才退 CPU 瓦片。 */
import type { Grid } from "../core/grid.ts";
import { contourStats, contourStepFor, waterSurface, type ContourStats, type ElevField } from "../core/elev.ts";
import type { BBox, Meta } from "../core/types.ts";
import { paperOf, shadeGain, snowSpec, type SnowSpec } from "./material.ts";
import { createTerrainGL } from "./terrainGL.ts";
import { createTerrainCPU } from "./terrainCPU.ts";

/** 底图样式：shaded＝观感底图（域扭曲＋晕渲＋材质，地类边界揉成有机走向；画面场可为精修档）；
    flat＝推演底图（逐格类型平色，像素颜色＝光标读数与寻路读到的那一格；高程取规则场；纸色照画）。
    两种底图的等高线都画在规则场（工作档）上＝与光标读数同一个数。 */
export type TerrainStyle = "shaded" | "flat";

/** flat=推演底图（见 TerrainStyle）；cA/cB=两套线系的等距（抽象单位，contourStepFor 产出：1-2-5 阶梯上相邻两档，A 细 B 粗）；cFade=B 系权重 0..1（交叉淡入淡出）；
    paper=图幅外铺宣纸色（战术图恒铺，战略图看 meta.outside；内陆图四周不该是汪洋，图页感；色=出图垫纸色 #d9d2c0 同源）；
    snow=雪线参数（material.snowSpec：气候档基准 + 球面图随纬度；缺省=不落雪）；
    gain=晕渲法线增益（material.shadeGain 按 meta 与 degPerPx 算；缺省 1＝旧式 64 倍夸张，调用点必须传）；
    dpr=设备像素比：等高线的线宽、挤线门、间曲线浮现门与虚线节距按 CSS 像素锚定（缺省 1＝物理像素；出图放大随 composeFrame 的临时 DPR 同变） */
export interface TerrainRenderOpts { flat?: boolean; contour?: boolean; wrap?: boolean; cA?: number; cB?: number; cFade?: number; paper?: boolean; snow?: SnowSpec; gain?: number; dpr?: number }

/** 渲染选项唯一装配点（帧循环 / 高清出图 / 缩略图三处共用）：等高距随缩放与场统计（contourStatsOf）、纸色与雪线按 meta、
    增益＝shadeGain × 本机「地形立体感」、flat 按底图样式、dpr＝画布当前设备像素比。等高线仍是独立图层，推演底图不替它做主。 */
export function terrainOpts(meta: Meta, degPerPx: number, layers: Record<string, boolean>, relief: number, style: TerrainStyle, dpr: number, stats: ContourStats | null): TerrainRenderOpts {
  const cs = contourStepFor(degPerPx, meta, stats);
  return { flat: style === "flat", contour: layers.contour, cA: cs.a, cB: cs.b, cFade: cs.fade, wrap: meta.worldModel !== "flat",
    paper: paperOf(meta), snow: snowSpec(meta), gain: shadeGain(meta, degPerPx) * relief, dpr };
}
/** 等高距统计的取场：落定的规则场优先（演算中沿用上一份），没有就用当前规则场（粗格 / 等待窗合成）；没有网格＝null。
    三个渲染调用点都经此取，等距才不会「落笔即变、落地又变」。 */
export function contourStatsOf(meta: Meta, grid: Grid | null, landed: ElevField | null, current: ElevField | null): ContourStats | null {
  const f = landed || current;
  return grid && f ? contourStats(f, grid, waterSurface(meta, grid), meta) : null;
}

export interface TerrainRenderer {
  canvas: HTMLCanvasElement;
  kind: "webgl2" | "cpu";
  /** 传网格与高程场。field=画面场含几何（粗格=coarseField 包装；细分=erode 产出，可带 shadow 遮蔽通道；
      精修档也在此；缺省=按 ELEV[类型] 示意常数合成粗格，旧行为）。
      rule=规则场（工作档）：两种底图的等高线与推演底图的高程都取它＝与光标读数同源；缺省＝field。
      wsurf=每格水面高程（core/elev.waterSurface，海 0／内陆湖在岸线高度）：
      水陆判据与深浅色都以它为基准，必传——漏了内陆湖会静默沉回海平面。 */
  uploadGrid(grid: Grid, wsurf: Float32Array, field?: ElevField, rule?: ElevField): void;
  render(viewBB: BBox, opts?: TerrainRenderOpts): void;
  /** 单帧可渲染的最大画布边长 px（高清出图按此钳倍数；超限 GL 会静默给黑帧或裁切） */
  maxDim(): number;
  rendererName(): string;
  dispose(): void;
}

export function createTerrainRenderer(
  canvas: HTMLCanvasElement, opts?: { force?: "cpu" | "webgl2" }
): TerrainRenderer {
  if (opts?.force !== "cpu") {
    try {
      const gl = createTerrainGL(canvas);
      if (gl) return gl;
    } catch (e) {
      console.warn("WebGL2 初始化失败，退回 CPU 瓦片：", e);
    }
  }
  return createTerrainCPU(canvas);
}
