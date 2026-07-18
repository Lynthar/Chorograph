/* 势力涂域（0.5° 细胞格）：格集合 → marching squares 提取边界 → 链成闭环 → Chaikin 平滑。
   与旧实现逐位一致（黄金基准锁定）；缓存策略交给调用方（旧版用 WeakMap，这里保持纯函数）。 */
import { PD } from "./constants.ts";
import { chaikin, type Pt } from "./geometry.ts";
import { DEFAULT_BBOX, type BBox, type Meta } from "./types.ts";

/* 涂域格步长：战术图按 bbox 派生更细步长（≈span/16→就近取整齐梯级），战略图/无 bbox 恒 PD=0.5°。
   纯派生、不落盘（同 meta 恒得同步长；渲染/笔刷/存储共用此一处真源→天然一致）；
   战略图（mapKind≠"tactical"）一律 PD——故战术图涂域细化不影响战略图（平价与落盘皆逐位不变）。 */
export function paintStep(meta: Meta | undefined): number {
  const m = meta || {}, bb = m.bbox;
  if (m.mapKind !== "tactical" || !bb) return PD;
  const raw = Math.max(bb.lonMax - bb.lonMin, bb.latMax - bb.latMin) / 16;
  return [PD, 0.25, 0.2, 0.1, 0.05, 0.025, 0.02, 0.01, 0.005].find(v => v <= raw) ?? 0.005;
}

export function paintDims(bb: BBox | undefined, pd = PD): { bb: BBox; cols: number; rows: number } {
  const b = bb || DEFAULT_BBOX;
  return {
    bb: b,
    cols: Math.max(1, Math.round((b.lonMax - b.lonMin) / pd)),
    rows: Math.max(1, Math.round((b.latMax - b.latMin) / pd))
  };
}

/** 涂域格坐标 → "i,j" 集合（与旧版 layerSet 同构） */
export function paintCellSet(cells: [number, number][] | undefined, bb: BBox | undefined, pd = PD): Set<string> {
  const { bb: b } = paintDims(bb, pd);
  const s = new Set<string>();
  (cells || []).forEach(c => {
    const i = Math.round((c[0] - b.lonMin) / pd - 0.5), j = Math.round((c[1] - b.latMin) / pd - 0.5);
    s.add(i + "," + j);
  });
  return s;
}

/* 涂域跨图重采样（战术烘焙用）：cells 是按「源图 bbox/pd」存的格心，直接拷进 pd 更细的战术图
   会被 paintCellSet 解码成一格一点的碎点。此处把源格视为色块重栅格化到目标网格：
   目标格心落在任一源格块内即着色（源粗→目标细＝整块铺满；源细→目标粗＝格心采样），出目标 bbox 剔除。
   小数位随步长（≥0.1° 两位、更细四位），与 ui/paint.setToCells 同规。 */
export function resamplePaintCells(
  cells: [number, number][] | undefined,
  srcBB: BBox | undefined, srcPd: number,
  dstBB: BBox, dstPd: number
): [number, number][] {
  const sb = srcBB || DEFAULT_BBOX;
  const s = paintCellSet(cells, srcBB, srcPd);
  if (!s.size) return [];
  const { cols, rows } = paintDims(dstBB, dstPd);
  const dp = dstPd >= 0.1 ? 2 : 4;
  const out: [number, number][] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const cx = dstBB.lonMin + (i + 0.5) * dstPd, cy = dstBB.latMin + (j + 0.5) * dstPd;
    if (s.has(Math.floor((cx - sb.lonMin) / srcPd) + "," + Math.floor((cy - sb.latMin) / srcPd))) {
      out.push([+cx.toFixed(dp), +cy.toFixed(dp)]);
    }
  }
  return out;
}

const LUT: Record<number, [string, string][]> = {
  1: [["L", "B"]], 2: [["B", "R"]], 3: [["L", "R"]], 4: [["T", "R"]], 5: [["T", "L"], ["B", "R"]],
  6: [["T", "B"]], 7: [["T", "L"]], 8: [["T", "L"]], 9: [["T", "B"]], 10: [["T", "R"], ["B", "L"]],
  11: [["T", "R"]], 12: [["L", "R"]], 13: [["B", "R"]], 14: [["L", "B"]]
};

/** 涂域层 → 平滑闭环（经纬度坐标）；smooth=Chaikin 轮数（旧版取 state.brush.smooth，默认 2） */
export function territoryLoops(cells: [number, number][] | undefined, bbox: BBox | undefined, smooth: number, pd = PD): Pt[][] {
  const { bb, cols, rows } = paintDims(bbox, pd);
  const s = paintCellSet(cells, bbox, pd);
  const val = (i: number, j: number) => s.has(i + "," + j) ? 1 : 0;
  const segs: [Pt, Pt][] = [];
  for (let j = -1; j < rows; j++) for (let i = -1; i < cols; i++) {
    const A = val(i, j + 1), B = val(i + 1, j + 1), C = val(i + 1, j), D = val(i, j);
    const idx = (A ? 8 : 0) | (B ? 4 : 0) | (C ? 2 : 0) | (D ? 1 : 0);
    if (idx === 0 || idx === 15) continue;
    const P: Record<string, Pt> = { T: [i + 0.5, j + 1], R: [i + 1, j + 0.5], B: [i + 0.5, j], L: [i, j + 0.5] };
    (LUT[idx] || []).forEach(sg => segs.push([P[sg[0]], P[sg[1]]]));
  }
  const key = (p: Pt) => (p[0] * 2) + "|" + (p[1] * 2);
  const bykey = new Map<string, [Pt, Pt][]>();
  segs.forEach(sg => ([0, 1] as const).forEach(e => {
    const k = key(sg[e]); if (!bykey.has(k)) bykey.set(k, []); bykey.get(k)!.push(sg);
  }));
  const used = new Set<[Pt, Pt]>(), loops: Pt[][] = [];
  segs.forEach(sg0 => {
    if (used.has(sg0)) return;
    const loop: Pt[] = [sg0[0], sg0[1]]; used.add(sg0);
    let cur = sg0[1];
    for (let g = 0; g < segs.length * 2; g++) {
      const nxt = (bykey.get(key(cur)) || []).find(sg => !used.has(sg));
      if (!nxt) break;
      used.add(nxt);
      cur = (key(nxt[0]) === key(cur)) ? nxt[1] : nxt[0];
      if (key(cur) === key(loop[0])) break;   // 闭合
      loop.push(cur);
    }
    if (loop.length >= 3) loops.push(loop);
  });
  return loops.map(lp => chaikin(lp.map(p => [bb.lonMin + (p[0] + 0.5) * pd, bb.latMin + (p[1] + 0.5) * pd] as Pt), smooth));
}
