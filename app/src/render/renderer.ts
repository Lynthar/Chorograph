/* 地形渲染器统一入口：
   优先 WebGL2——PoC 实测连 SwiftShader 纯软渲都比旧 CPU 瓦片快 6×，故**凡能建出
   WebGL2 上下文（含软渲）一律走 GPU**；仅上下文创建/着色器编译失败才退 CPU 瓦片。 */
import type { Grid } from "../core/grid.ts";
import { contourStats, contourStepFor, waterSurface, type ContourStep, type ElevField, type FieldRect } from "../core/elev.ts";
import type { BBox, Meta } from "../core/types.ts";
import { paperOf, shadeGain, snowSpec, type SnowSpec } from "./material.ts";
import { createTerrainGL } from "./terrainGL.ts";
import { createTerrainCPU } from "./terrainCPU.ts";

/** 底图样式：shaded＝观感底图（域扭曲＋晕渲＋材质，地类边界揉成有机走向；画面场可为精修档）；
    flat＝推演底图（逐格类型平色，像素颜色＝光标读数与寻路读到的那一格；高程取规则场；纸色照画）。
    两种底图的等高线都画在规则场（工作档）上＝与光标读数同一个数。 */
export type TerrainStyle = "shaded" | "flat";

/** flat=推演底图（见 TerrainStyle）；cStep=等高距（抽象单位，contourStepFor 产出：1-2-5 阶梯上的一档，任一时刻只有一套线系）；
    paper=图幅外铺宣纸色（战术图恒铺，战略图看 meta.outside；内陆图四周不该是汪洋，图页感；色=出图垫纸色 #d9d2c0 同源）；
    snow=雪线参数（material.snowSpec：气候档基准 + 球面图随纬度；缺省=不落雪）；
    gain=晕渲法线增益（material.shadeGain 按 meta 与 degPerPx 算；缺省 1＝旧式 64 倍夸张，调用点必须传）；
    dpr=设备像素比：等高线的线宽、挤线门、间曲线浮现门与虚线节距按 CSS 像素锚定（缺省 1＝物理像素；出图放大随 composeFrame 的临时 DPR 同变） */
export interface TerrainRenderOpts { flat?: boolean; contour?: boolean; wrap?: boolean; cStep?: number; paper?: boolean; snow?: SnowSpec; gain?: number; dpr?: number }

/** 渲染选项唯一装配点（帧循环 / 高清出图 / 缩略图三处共用）：等高距＝调用方经 contourStepOf 取的那一档（抽象单位）、纸色与雪线按 meta、
    增益＝shadeGain × 本机「地形立体感」、flat 按底图样式、dpr＝画布当前设备像素比。等高线仍是独立图层，推演底图不替它做主。 */
export function terrainOpts(meta: Meta, degPerPx: number, layers: Record<string, boolean>, relief: number, style: TerrainStyle, dpr: number, cStep: number): TerrainRenderOpts {
  return { flat: style === "flat", contour: layers.contour, cStep, wrap: meta.worldModel !== "flat",
    paper: paperOf(meta), snow: snowSpec(meta), gain: shadeGain(meta, degPerPx) * relief, dpr };
}
/** 等距的取场与取档：三个渲染调用点与注记都经此，等距才不会「落笔即变、落地又变」，注记也才与线同一档。
    场＝落定的规则场优先（演算中沿用上一份），没有就用当前规则场；坡度按**视口窗**统计（放大进山不再按整图的 75 分位算＝线距不随放大变密），
    高程范围按全场（「整幅至少四级」是整张图的承诺，不随视窗变）；上一档按 meta 记忆＝换档带迟滞（平移中统计量小幅漂移不来回跳）。没有网格＝无场手感。 */
const lastStep = new WeakMap<Meta, number>();
export function contourStepOf(meta: Meta, degPerPx: number, grid: Grid | null, landed: ElevField | null, current: ElevField | null, view: BBox): ContourStep {
  const f = landed || current;
  let stats = null;
  if (grid && f) {
    const ws = waterSurface(meta, grid), whole = contourStats(f, grid, ws, meta), win = statsWindow(f, view, meta.worldModel !== "flat");
    stats = win ? { slope75: contourStats(f, grid, ws, meta, win).slope75, rangeM: whole.rangeM } : whole;
  }
  const cs = contourStepFor(degPerPx, meta, stats, lastStep.get(meta));
  lastStep.set(meta, cs.m);
  return cs;
}
/** 视口 → 统计窗（场格半开矩形）：视口的边向外量化到「⅛ 视口边长的 2 的幂」格＝挪过约八分之一屏才换窗、窗至多比视口大四分之一——
    不再外扩：放大进山时外扩会把山外的缓坡掺进统计，等距又掉回细档（2.8 m/px 实测 20 m vs 视口内 50 m）。
    盖住整场或落在场外＝undefined（全场统计）。球面图先把视口折回场所在的世界拷贝。 */
function statsWindow(f: ElevField, v: BBox, wrap: boolean): FieldRect | undefined {
  const k = wrap ? 360 * Math.round(((f.bb.lonMin + f.bb.lonMax) / 2 - (v.lonMin + v.lonMax) / 2) / 360) : 0;
  const cw = (v.lonMax - v.lonMin) / f.step, ch = (v.latMax - v.latMin) / f.step;
  const q = 2 ** Math.max(3, Math.round(Math.log2(Math.max(cw, ch) / 8)));
  const x0 = (v.lonMin + k - f.bb.lonMin) / f.step, x1 = (v.lonMax + k - f.bb.lonMin) / f.step;
  const y0 = (v.latMin - f.bb.latMin) / f.step, y1 = (v.latMax - f.bb.latMin) / f.step;
  const c0 = Math.max(0, Math.floor(x0 / q) * q), c1 = Math.min(f.cols, Math.ceil(x1 / q) * q);
  const r0 = Math.max(0, Math.floor(y0 / q) * q), r1 = Math.min(f.rows, Math.ceil(y1 / q) * q);
  return c1 <= c0 || r1 <= r0 || (c0 === 0 && r0 === 0 && c1 === f.cols && r1 === f.rows) ? undefined : { c0, r0, c1, r1 };
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
