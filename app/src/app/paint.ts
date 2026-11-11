/* 派系涂域画笔——纯函数内核（2026-08-13 尺度定形批改位图）：
   · 涂域格＝地形格（×1,paintStep=gridStepDeg）,满幅可达 ~2M 格——旧 Set("i,j") 字符串键
     在这个量级上逐格串接/解析拖不动,笔刷期间的工作表示改 **Uint8 位图直址**；
   · 存档**读旧写新**：开笔把层（cells 坐标对/runs 行程,双认）解进位图,逐笔把位图压成
     runs 行程编码落回层（换层对象＝overlay 环缓存自动失效,旧规不变）；
   · 笔刷=半径 R=size-1 的圆盘（di²+dj²≤R²+0.5）,橡皮=反向——几何与旧实现逐位一致。 */
import { PD } from "../core/constants.ts";
import { eachPaintCenter } from "../core/territory.ts";
import { DEFAULT_BBOX } from "../core/types.ts";
import type { BBox, Meta, PaintLayer, PaintRuns } from "../core/types.ts";

export interface PaintDims { bb: BBox; cols: number; rows: number }

export function paintDims(meta: Meta | undefined, pd = PD): PaintDims {
  const bb = (meta || {}).bbox || DEFAULT_BBOX;
  // 取整与 core/territory.paintDims（及 buildGridCells）同式：round 会比地形网格少贴边一行/列
  return { bb, cols: Math.max(1, Math.ceil((bb.lonMax - bb.lonMin) / pd - 1e-9)), rows: Math.max(1, Math.ceil((bb.latMax - bb.latMin) / pd - 1e-9)) };
}

/** 笔刷期间的工作位图（网格内直址;网格外的旧越界坐标不入图＝重涂该层即整理掉,可辩护） */
export interface PaintMask extends PaintDims { pd: number; data: Uint8Array }

/** 层数据（cells/runs 双认）→ 工作位图 */
export function maskFromLayer(meta: Meta | undefined, L: PaintLayer | undefined, pd = PD): PaintMask {
  const { bb, cols, rows } = paintDims(meta, pd);
  const data = new Uint8Array(cols * rows);
  eachPaintCenter(L, bb, (lon, lat) => {
    const i = Math.round((lon - bb.lonMin) / pd - 0.5), j = Math.round((lat - bb.latMin) / pd - 0.5);
    if (i >= 0 && j >= 0 && i < cols && j < rows) data[j * cols + i] = 1;
  });
  return { bb, pd, cols, rows, data };
}

/** 圆盘笔刷一笔：在位图上加/擦格；返回是否有变化。lon 须已折回数据域。 */
export function brushMask(m: PaintMask, lon: number, lat: number, size: number, erase: boolean): boolean {
  const ci = Math.floor((lon - m.bb.lonMin) / m.pd), cj = Math.floor((lat - m.bb.latMin) / m.pd);
  const R = size - 1, v = erase ? 0 : 1;
  let ch = false;
  for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
    if (di * di + dj * dj > R * R + 0.5) continue;
    const i = ci + di, j = cj + dj;
    if (i < 0 || j < 0 || i >= m.cols || j >= m.rows) continue;
    const k = j * m.cols + i;
    if (m.data[k] !== v) { m.data[k] = v; ch = true; }
  }
  return ch;
}

/** 位图 → 行程编码（逐笔落回存档的形态;满幅扫描是字节直址,~2M 格数 ms 级） */
export function runsFromMask(m: PaintMask): PaintRuns {
  const d: number[] = [];
  for (let j = 0; j < m.rows; j++) {
    const base = j * m.cols;
    let run = -1;
    for (let i = 0; i < m.cols; i++) {
      const on = m.data[base + i];
      if (on && run < 0) run = i;
      else if (!on && run >= 0) { d.push(j, run, i - run); run = -1; }
    }
    if (run >= 0) d.push(j, run, m.cols - run);
  }
  return { pd: m.pd, d };
}

/** 取/建第 idx 层（返回实际层下标）：无层=建首层（开涂自动建层）；
    已有层而 idx 越界（删层/换派系后信号残留）=钳到既有层，**不**凭空建空层——
    否则笔迹会落进一个面板上看不见的新层（2026-07-12 P1）。 */
export function ensurePaintLayer(f: { paint?: PaintLayer[] }, idx: number): number {
  f.paint = f.paint || [];
  if (!f.paint.length) { f.paint.push({ cells: [] }); return 0; }
  return Math.min(Math.max(0, idx | 0), f.paint.length - 1);
}
