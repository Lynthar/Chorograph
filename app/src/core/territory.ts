/* 势力涂域：格集合 → marching squares 提取边界 → 链成闭环 → Chaikin 平滑。
   提取数学与旧实现逐位一致（黄金基准锁定,pd=0.5 用例原样）；2026-08-13 尺度定形批改三件：
   ① **涂域格＝地形格**（paintStep=gridStepDeg,PAINT_MUL 已废）——涂域笔与地形笔完全同粒
     （用户拍板「和地形笔刷一样」）。×4 从来不是几何要求,是旧存档格式的经济学,见 ②。
   ② 存档**双表示、读旧写新**：旧 `cells=[lon,lat][]` 逐格心坐标对照读;新落笔/新烘焙的层写
     `runs` 行程编码（×1 后满涂 140km 图坐标对要 ~50MB,runs ~25KB）。runs 自记编码时的格边
     pd,解码按格心还原再落进当前网格＝与坐标对同一「跨密度自动重栅格化」性质。
     normalizeWorld **有意不转格式**（它有 golden）,旧层保持原样直到被重涂。
   ③ 提取内部走**位图直址**（×1 后满幅约 2M 格,字符串 Set 的四角查找每次提取 ~8M 次哈希,
     拖笔即卡;位图 ~5-15ms）。查询窗 i∈[-1..cols]、j∈[-1..rows] 与旧 Set 语义一致。 */
import { PD } from "./constants.ts";
import { gridStepDeg } from "./grid.ts";
import { chaikin, type Pt } from "./geometry.ts";
import { DEFAULT_BBOX, type BBox, type Meta, type PaintRuns } from "./types.ts";

/** 涂域数据来源：裸坐标对（旧签名兼容/黄金用例）或层对象（cells/runs 双认） */
export type PaintSrc = [number, number][] | { cells?: [number, number][]; runs?: PaintRuns } | null | undefined;

/* 涂域格步长（2026-08-13 起＝地形格,×1）：涂域笔与地形笔同一张网、同一套 32 档、同一个 R。
   纯派生、不落盘（同 meta 恒得同步长;渲染/笔刷/存储共用此一处真源→天然一致）。 */
export function paintStep(meta: Meta | undefined): number {
  return gridStepDeg(meta);
}

/* 行列取整与 buildGridCells 同式（ceil−1e-9，2026-08 审查修正，原 round）：涂域格＝地形格后，
   round 会在「跨度÷步长」带分数时比地形网格少一行/列（如 801 列图纬向 417.19 行→涂域 417、
   地形 418）＝贴边那道地形格永远涂不上；黄金域（DEFAULT_BBOX÷0.5 恰为整数）两式同值＝逐位不变。 */
export function paintDims(bb: BBox | undefined, pd = PD): { bb: BBox; cols: number; rows: number } {
  const b = bb || DEFAULT_BBOX;
  return {
    bb: b,
    cols: Math.max(1, Math.ceil((b.lonMax - b.lonMin) / pd - 1e-9)),
    rows: Math.max(1, Math.ceil((b.latMax - b.latMin) / pd - 1e-9))
  };
}

/** 遍历一份涂域数据的每个格心（经纬）：cells 与 runs 双认（读旧写新之约）。
    runs 防御（值也是用户数据）：三元组非数跳过、长度钳到自身网格宽——1e9 的 len 不能变成
    1e9 次回调；起列同理钳住下界。 */
export function eachPaintCenter(src: PaintSrc, bb: BBox, cb: (lon: number, lat: number) => void): void {
  if (!src) return;
  const L = Array.isArray(src) ? { cells: src, runs: undefined as PaintRuns | undefined } : src;
  for (const c of L.cells || []) { if (Array.isArray(c)) cb(+c[0], +c[1]); }
  const R = L.runs;
  if (R && typeof R === "object" && +R.pd > 0 && Array.isArray(R.d)) {
    const pd = +R.pd, d = R.d;
    const iMax = Math.ceil((bb.lonMax - bb.lonMin) / pd) + 1;
    for (let k = 0; k + 2 < d.length; k += 3) {
      const j = Math.floor(+d[k]), i0 = Math.max(-2, Math.floor(+d[k + 1])), len = Math.floor(+d[k + 2]);
      if (!isFinite(j) || !isFinite(i0) || !(len > 0)) continue;
      const iEnd = Math.min(i0 + len, iMax);
      const lat = bb.latMin + (j + 0.5) * pd;
      for (let i = i0; i < iEnd; i++) cb(bb.lonMin + (i + 0.5) * pd, lat);
    }
  }
}

/** 涂域数据 → 当前 pd 网格的 "i,j" 格键集合（与旧版 layerSet 同构;首参自 2026-08-13 起双认层对象） */
export function paintCellSet(src: PaintSrc, bb: BBox | undefined, pd = PD): Set<string> {
  const b = bb || DEFAULT_BBOX;
  const s = new Set<string>();
  eachPaintCenter(src, b, (lon, lat) => {
    const i = Math.round((lon - b.lonMin) / pd - 0.5), j = Math.round((lat - b.latMin) / pd - 0.5);
    s.add(i + "," + j);
  });
  return s;
}

/* 涂域跨图重采样为行程编码（战术烘焙用）：源格视为色块重栅格化到目标网格——目标格心落在任一
   源格块内即着色（源粗→目标细＝整块铺满;源细→目标粗＝格心采样），出目标 bbox 剔除。
   mapLon＝目标空间经度→源空间经度（平面烘焙的切平面逆投影 lon_src=心+(lon−心)/cosφ;缺省恒等,
   语义保持故可缺省——旧「逐格坐标对」返回值已废,烘焙自此直接写 runs）。空涂域返 null。 */
export function resamplePaintRuns(
  src: PaintSrc,
  srcBB: BBox | undefined, srcPd: number,
  dstBB: BBox, dstPd: number,
  mapLon: (lon: number) => number = l => l
): PaintRuns | null {
  const sb = srcBB || DEFAULT_BBOX;
  const s = paintCellSet(src, srcBB, srcPd);
  if (!s.size) return null;
  const { cols, rows } = paintDims(dstBB, dstPd);
  const d: number[] = [];
  for (let j = 0; j < rows; j++) {
    const cy = dstBB.latMin + (j + 0.5) * dstPd;
    const sj = Math.floor((cy - sb.latMin) / srcPd);
    let run = -1;
    for (let i = 0; i < cols; i++) {
      const cx = mapLon(dstBB.lonMin + (i + 0.5) * dstPd);
      const hit = s.has(Math.floor((cx - sb.lonMin) / srcPd) + "," + sj);
      if (hit && run < 0) run = i;
      else if (!hit && run >= 0) { d.push(j, run, i - run); run = -1; }
    }
    if (run >= 0) d.push(j, run, cols - run);
  }
  return d.length ? { pd: dstPd, d } : null;
}

const LUT: Record<number, [string, string][]> = {
  1: [["L", "B"]], 2: [["B", "R"]], 3: [["L", "R"]], 4: [["T", "R"]], 5: [["T", "L"], ["B", "R"]],
  6: [["T", "B"]], 7: [["T", "L"]], 8: [["T", "L"]], 9: [["T", "B"]], 10: [["T", "R"], ["B", "L"]],
  11: [["T", "R"]], 12: [["L", "R"]], 13: [["B", "R"]], 14: [["L", "B"]]
};

/** 涂域层 → 平滑闭环（经纬度坐标）；smooth=Chaikin 轮数（旧版取 state.brush.smooth，默认 2）。
    首参双认（裸 cells＝黄金用例原样;层对象＝渲染端直接传 L）。 */
export function territoryLoops(src: PaintSrc, bbox: BBox | undefined, smooth: number, pd = PD): Pt[][] {
  const { bb, cols, rows } = paintDims(bbox, pd);
  /* 位图直址（规模引擎批）：查询窗 i∈[-1..cols]、j∈[-1..rows]偏移 +1 存进 (cols+2)×(rows+2)；
     窗外格（旧数据的越界坐标）本就查不到＝行为同旧字符串 Set。 */
  const W = cols + 2, mask = new Uint8Array(W * (rows + 2));
  eachPaintCenter(src, bb, (lon, lat) => {
    const i = Math.round((lon - bb.lonMin) / pd - 0.5), j = Math.round((lat - bb.latMin) / pd - 0.5);
    if (i >= -1 && i <= cols && j >= -1 && j <= rows) mask[(j + 1) * W + (i + 1)] = 1;
  });
  const val = (i: number, j: number) => mask[(j + 1) * W + (i + 1)];
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
