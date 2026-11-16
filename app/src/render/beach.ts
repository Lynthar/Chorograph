/* 滩带的离水场：每格「还在带内多少格」与那片水的水面。两个地形渲染器同读（GL 传成纹理、CPU 直接取），
   只战术图用——格子不环绕。带宽上限：海（水面恰为 0）FX.beachW 格、内陆湖 FX.beachLakeW 格，
   再不超过水体里离陆地最远的那格到陆地的格数——小水塘只有一圈淡边。 */
import { waterMask } from "../core/elev.ts";
import type { Grid } from "../core/grid.ts";
import { FX } from "./material.ts";

interface BandGeom { m: Float32Array; src: Int32Array }

/** 两趟传播：每格取 max(off[源] − 到源格心的格数)。进来时源格 src＝自己的格号、val＝off，其余 src＝−1、val＝−Infinity。
    top＝off 的最大值：到顶的格不会再被别的源盖过，跳过；floor 以下的值不往外传——带外不用算准，省掉离水远的大片格子 */
function spread(cols: number, rows: number, off: Float32Array, src: Int32Array, val: Float32Array, top: number, floor: number): void {
  const pull = (i: number, c: number, r: number, j: number): void => {
    const s = src[j];
    if (s < 0 || s === src[i] || val[j] < floor) return;
    const dc = c - s % cols, dr = r - ((s / cols) | 0), v = off[s] - Math.sqrt(dc * dc + dr * dr);
    if (v > val[i]) { val[i] = v; src[i] = s; }
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (val[i] >= top) continue;
      if (c > 0) pull(i, c, r, i - 1);
      if (r > 0) { pull(i, c, r, i - cols); if (c > 0) pull(i, c, r, i - cols - 1); if (c < cols - 1) pull(i, c, r, i - cols + 1); }
    }
    for (let c = cols - 2; c >= 0; c--) { const i = r * cols + c; if (val[i] < top) pull(i, c, r, i + 1); }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (val[i] >= top) continue;
      if (c < cols - 1) pull(i, c, r, i + 1);
      if (r < rows - 1) { pull(i, c, r, i + cols); if (c < cols - 1) pull(i, c, r, i + cols + 1); if (c > 0) pull(i, c, r, i + cols - 1); }
    }
    for (let c = 1; c < cols; c++) { const i = r * cols + c; if (val[i] < top) pull(i, c, r, i - 1); }
  }
}

/** 带外的格一律记这个值（负、有限：双线性不出 NaN）；比它高的值都是算准的 */
const OUT = -2;
const LAND = 0, SEA = 2;   // 每格的水陆种类：0 陆、1 内陆湖、2 海

function build(kind: Uint8Array, cols: number, rows: number): BandGeom {
  const n = cols * rows, off = new Float32Array(n), src = new Int32Array(n), val = new Float32Array(n);
  /* 水格到最近陆格的格数（水体半宽的量度）：以陆格为源传一遍 */
  for (let i = 0; i < n; i++) { src[i] = kind[i] === LAND ? i : -1; val[i] = kind[i] === LAND ? 0 : -Infinity; }
  spread(cols, rows, off, src, val, 0, -(FX.beachW + 2));   // 半宽只用到带宽上限，更深的水格留 −Infinity＝足够宽
  const lab = new Int32Array(n).fill(-1), wide: number[] = [], st: number[] = [];
  let top = 0;
  for (let i0 = 0; i0 < n; i0++) {
    if (kind[i0] === LAND || lab[i0] >= 0) continue;
    const b = wide.length;
    let half = 0;
    lab[i0] = b; st.push(i0);
    while (st.length) {
      const i = st.pop()!, c = i % cols, r = (i / cols) | 0;
      half = Math.max(half, -val[i]);
      for (const j of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1])
        if (j >= 0 && kind[j] !== LAND && lab[j] < 0) { lab[j] = b; st.push(j); }
    }
    wide.push(Math.min(kind[i0] === SEA ? FX.beachW : FX.beachLakeW, half));
    top = Math.max(top, wide[b]);
  }
  for (let i = 0; i < n; i++) { const w = kind[i] !== LAND; off[i] = w ? wide[lab[i]] : 0; src[i] = w ? i : -1; val[i] = w ? off[i] : -Infinity; }
  spread(cols, rows, off, src, val, top, OUT);
  for (let i = 0; i < n; i++) if (!(val[i] > OUT)) val[i] = OUT;
  return { m: val, src };
}

/* 上一份离水几何：水陆种类逐格没变（只涂了陆地、或湖面只是升降）就沿用，不重算 */
let last: { kind: Uint8Array; cols: number; geom: BandGeom } | null = null;
const fieldMemo = new WeakMap<Float32Array, { grid: Grid; data: Float32Array }>();
/**
 * 滩带场：每格两项——[还在带内多少格（≤0＝带外）, 那片水的水面]。
 * @param grid 类型网格
 * @param wsurf 与 grid 成对的水面（core/elev.buildSurface 的 wsurf）
 * @returns 按（网格, 水面数组）记忆的只读快照：内容变了一定是新数组，调用方不得原地改
 */
export function bandField(grid: Grid, wsurf: Float32Array): Float32Array {
  const hit = fieldMemo.get(wsurf);
  if (hit && hit.grid === grid) return hit.data;
  const water = waterMask(grid), n = water.length, kind = new Uint8Array(n);
  for (let i = 0; i < n; i++) kind[i] = water[i] ? (wsurf[i] === 0 ? SEA : 1) : LAND;
  const same = last && last.cols === grid.cols && last.kind.length === n && last.kind.every((v, i) => v === kind[i]);
  const geom = same ? last!.geom : build(kind, grid.cols, grid.rows);
  last = { kind, cols: grid.cols, geom };
  const { m, src } = geom, data = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { data[i * 2] = m[i]; data[i * 2 + 1] = src[i] >= 0 ? wsurf[src[i]] : 0; }
  fieldMemo.set(wsurf, { grid, data });
  return data;
}

/** 滩带场的双线性（同 GL bandAt）：fx/fy 以格心为整数点，出格取边格；o[0]＝带内格数，o[1]＝水面 */
export function bandAt(b: Float32Array, cols: number, rows: number, fx: number, fy: number, o: Float64Array): void {
  const c0 = Math.max(0, Math.min(cols - 1, Math.floor(fx))), c1 = Math.min(cols - 1, c0 + 1), tx = Math.max(0, Math.min(1, fx - c0));
  const r0 = Math.max(0, Math.min(rows - 1, Math.floor(fy))), r1 = Math.min(rows - 1, r0 + 1), ty = Math.max(0, Math.min(1, fy - r0));
  const a = (r0 * cols + c0) * 2, bb = (r0 * cols + c1) * 2, c = (r1 * cols + c0) * 2, d = (r1 * cols + c1) * 2;
  for (let k = 0; k < 2; k++) {
    const lo = b[a + k] + (b[bb + k] - b[a + k]) * tx, hi = b[c + k] + (b[d + k] - b[c + k]) * tx;
    o[k] = lo + (hi - lo) * ty;
  }
}
