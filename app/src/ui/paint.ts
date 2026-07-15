/* 派系涂域画笔（0.5° 细胞格）——纯函数内核，自旧实现迁移：
   · 存档格式：L.cells = 格心 [lon,lat]（两位小数）；笔刷期间转 Set("i,j") 高效增删，逐笔落回 cells；
   · 笔刷=半径 R=size-1 的圆盘（di²+dj²≤R²+0.5），橡皮=反向；
   · 边界环提取(territoryLoops)在 core，overlay 的 LOOP_CACHE 按层对象弱引用——
     每笔用新层对象替换旧层即自动失效重算。 */
import { PD } from "../core/constants.ts";
import { DEFAULT_BBOX } from "../core/types.ts";
import type { BBox, Meta, PaintLayer } from "../core/types.ts";

export interface PaintDims { bb: BBox; cols: number; rows: number }

export function paintDims(meta: Meta | undefined, pd = PD): PaintDims {
  const bb = (meta || {}).bbox || DEFAULT_BBOX;
  return { bb, cols: Math.max(1, Math.round((bb.lonMax - bb.lonMin) / pd)), rows: Math.max(1, Math.round((bb.latMax - bb.latMin) / pd)) };
}

/** cells（格心经纬）→ 格键集合 */
export function cellsToSet(bb: BBox, cells: [number, number][] | undefined, pd = PD): Set<string> {
  const s = new Set<string>();
  (cells || []).forEach(c => {
    const i = Math.round((c[0] - bb.lonMin) / pd - 0.5), j = Math.round((c[1] - bb.latMin) / pd - 0.5);
    s.add(i + "," + j);
  });
  return s;
}

/** 格键集合 → cells（格心经纬；小数位随步长：战略 0.5° 两位＝与旧 layerCommit 逐位一致，细格加密到四位） */
export function setToCells(bb: BBox, s: Set<string>, pd = PD): [number, number][] {
  const dp = pd >= 0.1 ? 2 : 4;
  return [...s].map(k => {
    const [i, j] = k.split(",").map(Number);
    return [+(bb.lonMin + (i + 0.5) * pd).toFixed(dp), +(bb.latMin + (j + 0.5) * pd).toFixed(dp)] as [number, number];
  });
}

/** 圆盘笔刷一笔：在集合上加/擦格；返回是否有变化。lon 须已折回数据域。 */
export function brushCells(s: Set<string>, dims: PaintDims, lon: number, lat: number, size: number, erase: boolean, pd = PD): boolean {
  const ci = Math.floor((lon - dims.bb.lonMin) / pd), cj = Math.floor((lat - dims.bb.latMin) / pd);
  const R = size - 1;
  let ch = false;
  for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
    if (di * di + dj * dj > R * R + 0.5) continue;
    const i = ci + di, j = cj + dj;
    if (i < 0 || j < 0 || i >= dims.cols || j >= dims.rows) continue;
    const k = i + "," + j;
    if (erase) { if (s.delete(k)) ch = true; }
    else if (!s.has(k)) { s.add(k); ch = true; }
  }
  return ch;
}

/** 取/建第 idx 层（返回实际层下标）：无层=建首层（开涂自动建层）；
    已有层而 idx 越界（删层/换派系后信号残留）=钳到既有层，**不**凭空建空层——
    否则笔迹会落进一个面板上看不见的新层（2026-07-12 P1）。 */
export function ensurePaintLayer(f: { paint?: PaintLayer[] }, idx: number): number {
  f.paint = f.paint || [];
  if (!f.paint.length) { f.paint.push({ cells: [] }); return 0; }
  return Math.min(Math.max(0, idx | 0), f.paint.length - 1);
}
