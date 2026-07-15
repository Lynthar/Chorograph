/* 地形网格（游戏真源）：程序化初稿逐格分类 + 手绘涂改叠加 + 官道格标记。
   语义与旧实现逐位一致（黄金基准锁定）：战术图按跨度自适应加密（跨度/140），
   涂改可带时段（地形纪元）与块尺寸（战术图继承的战略图涂改=1°粗块盖章）。 */
import { seedTerrain } from "./terrain.ts";
import { canonComposite } from "./constants.ts";
import { activeAt } from "./time.ts";
import { DEFAULT_BBOX, type BBox, type Edge, type Meta, type TerrainOverride, type WorldNode } from "./types.ts";

/* cells 存**复合串**（"地貌" 或 "地貌/生态"；旧 8 类 id 是其兼容子集）。seedTerrain 产 canonical 复合、
   涂改经 canonComposite 归一；消费点一律走 core/constants 的 terrainProps/flatten（不再直接查旧表）。 */
export interface Grid { bb: BBox; step: number; cols: number; rows: number; cells: string[][] }

export function buildGridCells(meta: Meta | undefined, overrides: TerrainOverride[] | undefined, yearNow: number): Grid {
  const m = meta || {};
  const bb = m.bbox || DEFAULT_BBOX;
  // 战术图：网格按跨度自适应加密（目标≈140格宽）；战略图维持 1°/格
  const step = m.mapKind === "tactical" ? Math.max(0.001, (bb.lonMax - bb.lonMin) / 140) : 1.0;
  // cols/rows 封顶 2048（合法战略 ≤360、战术 ≈140 均远不及——逐位不变）：防超大/损坏 bbox 的 O(cols×rows) 分配 OOM
  const cols = Math.min(2048, Math.max(1, Math.ceil((bb.lonMax - bb.lonMin) / step))), rows = Math.min(2048, Math.max(1, Math.ceil((bb.latMax - bb.latMin) / step)));
  const cells: string[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) row.push(seedTerrain(m, bb.lonMin + (c + 0.5) * step, bb.latMin + (r + 0.5) * step));
    cells.push(row);
  }
  (overrides || []).forEach(o => {
    if (!activeAt(o, yearNow)) return;          // 地形涂改可带时段（山川随时间变化）
    const ot = canonComposite(o.t);             // 归一为 canonical 复合串（旧 id→复合，与 seed 一致；新组合原样）
    const bs = +(o.step as number) || step;     // 涂改块尺寸：继承的战略图涂改=1°粗块，本图涂的=本图步长
    if (bs <= step * 1.001) {                   // 常规：单格
      const c = Math.floor((o.lon - bb.lonMin) / step), r = Math.floor((o.lat - bb.latMin) / step);
      if (cells[r] && cells[r][c]) cells[r][c] = ot;
    } else {                                    // 粗块盖章：铺满所覆盖的细格（o.lon/lat=块中心）
      const c0 = Math.max(0, Math.floor((o.lon - bs / 2 - bb.lonMin) / step)), c1 = Math.min(cols - 1, Math.floor((o.lon + bs / 2 - bb.lonMin - 1e-9) / step));
      const r0 = Math.max(0, Math.floor((o.lat - bs / 2 - bb.latMin) / step)), r1 = Math.min(rows - 1, Math.floor((o.lat + bs / 2 - bb.latMin - 1e-9) / step));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r][c] = ot;
    }
  });
  return { bb, step, cols, rows, cells };
}

/** 官道降低沿途寻路代价：当年生效的道路连线按 40 段插值标记所经格（"r,c"） */
export function roadCellSet(nodes: WorldNode[], edges: Edge[], yearNow: number, grid: Grid): Set<string> {
  const byId = (id: string) => nodes.find(n => n.id === id);
  const s = new Set<string>();
  edges.filter(e => e.type === "road" && activeAt(e, yearNow)).forEach(e => {
    if (!e.from || !e.to) return;   // 道路必有两端；自由画河（pts、无 from/to）不入官道格
    const a = byId(e.from), b = byId(e.to); if (!a || !b) return;
    const N = 40;
    for (let i = 0; i <= N; i++) {
      const lon = a.lon + (b.lon - a.lon) * i / N, lat = a.lat + (b.lat - a.lat) * i / N;
      const c = Math.floor((lon - grid.bb.lonMin) / grid.step), r = Math.floor((lat - grid.bb.latMin) / grid.step);
      s.add(r + "," + c);
    }
  });
  return s;
}
