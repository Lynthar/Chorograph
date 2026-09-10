/* 地形渲染器统一入口：
   优先 WebGL2——PoC 实测连 SwiftShader 纯软渲都比旧 CPU 瓦片快 6×，故**凡能建出
   WebGL2 上下文（含软渲）一律走 GPU**；仅上下文创建/着色器编译失败才退 CPU 瓦片。 */
import type { Grid } from "../core/grid.ts";
import { contourStepFor, type ElevField } from "../core/elev.ts";
import type { BBox, Meta } from "../core/types.ts";
import { paperOf, shadeGain, snowSpec, type SnowSpec } from "./material.ts";
import { createTerrainGL } from "./terrainGL.ts";
import { createTerrainCPU } from "./terrainCPU.ts";

/** 底图样式：shaded＝观感底图（域扭曲＋晕渲＋材质，地类边界揉成有机走向）；
    flat＝推演底图（逐格类型平色，像素颜色＝光标读数与寻路读到的那一格；等高线与纸色照画） */
export type TerrainStyle = "shaded" | "flat";

/** flat=推演底图（见 TerrainStyle）；cMinor=细曲线等距（抽象单位，contourStepFor 产出）；cFade=下一细分档淡入 0..1（×2 阶梯嵌套过渡）；
    paper=图幅外铺宣纸色（战术图恒铺，战略图看 meta.outside；内陆图四周不该是汪洋，图页感；色=出图垫纸色 #d9d2c0 同源）；
    snow=雪线参数（material.snowSpec：气候档基准 + 球面图随纬度；缺省=不落雪）；
    gain=晕渲法线增益（material.shadeGain 按 meta 与 degPerPx 算；缺省 1＝旧式 64 倍夸张，调用点必须传） */
export interface TerrainRenderOpts { flat?: boolean; contour?: boolean; wrap?: boolean; cMinor?: number; cFade?: number; paper?: boolean; snow?: SnowSpec; gain?: number }

/** 渲染选项唯一装配点（帧循环 / 高清出图 / 缩略图三处共用）：等高距随缩放、纸色与雪线按 meta、
    增益＝shadeGain × 本机「地形立体感」、flat 按底图样式。等高线仍是独立图层，推演底图不替它做主。 */
export function terrainOpts(meta: Meta, degPerPx: number, layers: Record<string, boolean>, relief: number, style: TerrainStyle): TerrainRenderOpts {
  const cs = contourStepFor(degPerPx, meta);
  return { flat: style === "flat", contour: layers.contour, cMinor: cs.minor, cFade: cs.fade, wrap: meta.worldModel !== "flat",
    paper: paperOf(meta), snow: snowSpec(meta), gain: shadeGain(meta, degPerPx) * relief };
}

export interface TerrainRenderer {
  canvas: HTMLCanvasElement;
  kind: "webgl2" | "cpu";
  /** field=高程场含几何（粗格=coarseField 包装；细分=erode 产出，可带 shadow 遮蔽通道；
      缺省=按 ELEV[类型] 示意常数合成粗格，旧行为） */
  /** 传网格与高程场。wsurf=每格水面高程（core/elev.waterSurface，海 0／内陆湖在岸线高度）：
      水陆判据与深浅色都以它为基准，必传——漏了内陆湖会静默沉回海平面。 */
  uploadGrid(grid: Grid, wsurf: Float32Array, field?: ElevField): void;
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
