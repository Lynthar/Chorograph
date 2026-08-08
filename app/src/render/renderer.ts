/* 地形渲染器统一入口：
   优先 WebGL2——PoC 实测连 SwiftShader 纯软渲都比旧 CPU 瓦片快 6×，故**凡能建出
   WebGL2 上下文（含软渲）一律走 GPU**；仅上下文创建/着色器编译失败才退 CPU 瓦片。 */
import type { Grid } from "../core/grid.ts";
import type { ElevField } from "../core/elev.ts";
import type { BBox } from "../core/types.ts";
import { createTerrainGL } from "./terrainGL.ts";
import { createTerrainCPU } from "./terrainCPU.ts";

/** cMinor=细曲线等距（抽象单位，contourStepFor 产出）；cFade=下一细分档淡入 0..1（×2 阶梯嵌套过渡）；
    paper=图幅外铺宣纸色（战术图裁决：内陆战场四周不该是汪洋，图页感；色=出图垫纸色 #d9d2c0 同源）；
    snowE=雪线抽象高程（material.snowEOf 按米折算；缺省=不落雪） */
export interface TerrainRenderOpts { diag?: boolean; contour?: boolean; wrap?: boolean; cMinor?: number; cFade?: number; paper?: boolean; snowE?: number }

export interface TerrainRenderer {
  canvas: HTMLCanvasElement;
  kind: "webgl2" | "cpu";
  /** field=高程场含几何（粗格=coarseField 包装；细分=erode 产出，可带 shadow 遮蔽通道；
      缺省=按 ELEV[类型] 示意常数合成粗格，旧行为） */
  uploadGrid(grid: Grid, field?: ElevField): void;
  render(viewBB: BBox, opts?: TerrainRenderOpts): void;
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
