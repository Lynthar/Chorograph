/* 地形渲染器统一入口：
   优先 WebGL2——PoC 实测连 SwiftShader 纯软渲都比旧 CPU 瓦片快 6×，故**凡能建出
   WebGL2 上下文（含软渲）一律走 GPU**；仅上下文创建/着色器编译失败才退 CPU 瓦片。 */
import type { Grid } from "../core/grid.ts";
import type { BBox } from "../core/types.ts";
import { createTerrainGL } from "./terrainGL.ts";
import { createTerrainCPU } from "./terrainCPU.ts";

export interface TerrainRenderOpts { diag?: boolean; contour?: boolean; wrap?: boolean; cInt?: number }

export interface TerrainRenderer {
  canvas: HTMLCanvasElement;
  kind: "webgl2" | "cpu";
  /** elev=每格高程场（core/elev.buildElevField；缺省=按 ELEV[类型] 示意常数，旧行为） */
  uploadGrid(grid: Grid, elev?: Float32Array): void;
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
