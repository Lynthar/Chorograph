/* 标高点（core）：规则场上的局部高点 + 内陆水体的水面，给等高线补上晕渲画不出的绝对高差。
   纯函数；高程一律取制图面（elevSmooth）＝与光标读数同一个数。缓存与屏幕换算在 render/spots。 */
import { elevSmooth, type ElevField } from "./elev.ts";
import { terrainProps } from "./constants.ts";
import type { Grid } from "./grid.ts";

export interface SpotHeight { lon: number; lat: number; e: number; kind: "peak" | "water" }

/** 一维滑窗极值（van Herk：块内前缀 + 后缀，O(n)）。两端按 pad 补齐＝窗在边缘截断，不越界读到别的行。
    b/g/h 是调用方复用的缓冲，长度 ≥ n + 2r。 */
function slide1D(a: Float32Array, n: number, r: number, pick: (x: number, y: number) => number, pad: number,
  out: Float32Array, b: Float32Array, g: Float32Array, h: Float32Array): void {
  const w = 2 * r + 1, m = n + 2 * r;
  b.fill(pad, 0, m); b.set(a.subarray(0, n), r);
  for (let i = 0; i < m; i++) g[i] = i % w === 0 ? b[i] : pick(g[i - 1], b[i]);
  for (let i = m - 1; i >= 0; i--) h[i] = (i % w === w - 1 || i === m - 1) ? b[i] : pick(h[i + 1], b[i]);
  for (let i = 0; i < n; i++) out[i] = pick(h[i], g[i + 2 * r]);
}
/** 二维方窗极值（先行后列，可分离） */
function extrema2D(data: Float32Array, cols: number, rows: number, r: number, max: boolean): Float32Array {
  const pick = max ? Math.max : Math.min, pad = max ? -Infinity : Infinity;
  const n = Math.max(cols, rows) + 2 * r, b = new Float32Array(n), g = new Float32Array(n), h = new Float32Array(n);
  const tmp = new Float32Array(cols * rows), out = new Float32Array(cols * rows);
  const line = new Float32Array(Math.max(cols, rows)), res = new Float32Array(Math.max(cols, rows));
  for (let y = 0; y < rows; y++) { line.set(data.subarray(y * cols, (y + 1) * cols)); slide1D(line, cols, r, pick, pad, res, b, g, h); tmp.set(res.subarray(0, cols), y * cols); }
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) line[y] = tmp[y * cols + x];
    slide1D(line, rows, r, pick, pad, res, b, g, h);
    for (let y = 0; y < rows; y++) out[y * cols + x] = res[y];
  }
  return out;
}

/** 细格矩形（半开 [c0,c1)×[r0,r1)）：只在这一片里找高点，窗口的上下文仍从矩形外取 */
export interface CellRect { c0: number; r0: number; c1: number; r1: number }

/** 局部高点：以 win 格为半窗，窗内最高、且比窗内**陆格**最低高出 ≥ minProm（抽象单位）的陆格——突出度只对陆地量，
    否则湖岸边整片平地都会因为湖床更低而算成「高点」。候选按高度降序做非极大抑制（相距 < win 格只留最高）。
    窗按屏幕像素定＝放大自然出更多、缩小自动稀疏。
    rect＝只评估这片细格（缺省整场）；k＝粗块边长（格，缺省 1）：块锚在全场原点、块值取块内最高（陆格另记最低与最高格），
    窗口在粗块上滑＝工作量降 k²、窗界量化到 k 格；rect 向外扩一窗再评估，矩形内每个候选的窗都完整＝结果不随矩形变。
    rect 缺省且 k=1 时与逐格评估逐位相同。 */
export function peakSpots(f: ElevField, grid: Grid, wsurf: Float32Array, win: number, minProm: number, rect?: CellRect, k = 1): SpotHeight[] {
  const { cols, rows, data } = f, gk = f.step / grid.step;
  const wsAt = (c: number, r: number): number =>
    wsurf[Math.min(grid.rows - 1, Math.floor((r + 0.5) * gk)) * grid.cols + Math.min(grid.cols - 1, Math.floor((c + 0.5) * gk))];
  const c0 = Math.max(0, Math.floor(rect ? rect.c0 : 0)), c1 = Math.min(cols, Math.ceil(rect ? rect.c1 : cols));
  const r0 = Math.max(0, Math.floor(rect ? rect.r0 : 0)), r1 = Math.min(rows, Math.ceil(rect ? rect.r1 : rows));
  if (!(c1 > c0 && r1 > r0)) return [];
  const wk = Math.max(1, Math.round(win / k));   // 粗块上的半窗
  // 评估域（粗块坐标）＝矩形所占块向外扩一窗；块锚在全场原点
  const C0 = Math.max(0, Math.floor(c0 / k) - wk), C1 = Math.min(Math.ceil(cols / k), Math.ceil(c1 / k) + wk);
  const R0 = Math.max(0, Math.floor(r0 / k) - wk), R1 = Math.min(Math.ceil(rows / k), Math.ceil(r1 / k) + wk);
  const W = C1 - C0, H = R1 - R0;
  const mxAll = new Float32Array(W * H).fill(-Infinity);   // 块内最高（含水格：水格不成候选，但能压住比它低的邻块）
  const mxLand = new Float32Array(W * H).fill(-Infinity), mnLand = new Float32Array(W * H).fill(Infinity);
  const arg = new Int32Array(W * H).fill(-1);               // 块内最高陆格的细格序号（行主序首个＝同高取 r 小 c 小）
  for (let r = R0 * k, rEnd = Math.min(rows, R1 * k); r < rEnd; r++) {
    const B0 = (Math.floor(r / k) - R0) * W - C0;
    for (let c = C0 * k, cEnd = Math.min(cols, C1 * k); c < cEnd; c++) {
      const i = r * cols + c, e = data[i], B = B0 + Math.floor(c / k);
      if (e > mxAll[B]) mxAll[B] = e;
      if (e < wsAt(c, r) - 0.02) continue;
      if (e > mxLand[B]) { mxLand[B] = e; arg[B] = i; }
      if (e < mnLand[B]) mnLand[B] = e;
    }
  }
  const mx = extrema2D(mxAll, W, H, wk, true), mn = extrema2D(mnLand, W, H, wk, false);
  const cand: { c: number; r: number; e: number }[] = [];
  for (let R = Math.floor(r0 / k) - R0; R < Math.ceil(r1 / k) - R0; R++) for (let C = Math.floor(c0 / k) - C0; C < Math.ceil(c1 / k) - C0; C++) {
    const B = R * W + C, e = mxLand[B];
    if (arg[B] < 0 || e !== mx[B] || e - mn[B] < minProm) continue;
    const c = arg[B] % cols, r = (arg[B] - c) / cols;
    if (c < c0 || c >= c1 || r < r0 || r >= r1) continue;   // 块跨矩形边：候选格本身也要在矩形内
    cand.push({ c, r, e });
  }
  cand.sort((a, b) => b.e - a.e || a.r - b.r || a.c - b.c);
  const kept: { c: number; r: number }[] = [], out: SpotHeight[] = [];
  for (const q of cand) {
    if (kept.some(p => Math.max(Math.abs(p.c - q.c), Math.abs(p.r - q.r)) < win)) continue;
    kept.push(q);
    const lon = f.bb.lonMin + (q.c + 0.5) * f.step, lat = f.bb.latMin + (q.r + 0.5) * f.step;
    out.push({ lon, lat, e: elevSmooth(data, f, lon, lat), kind: "peak" });
  }
  return out;
}

/** 内陆水体的水面：地貌 water 的粗格四邻连通块，一块一枚；水面 0＝海（碰图幅边）不标、不足 minCells 格的水洼不标。
    位置取离岸最远的格（岸格＝有陆邻或贴图幅边，多源 BFS），同远取行主序先到者；高程＝该块水面。 */
export function waterSpots(grid: Grid, wsurf: Float32Array, minCells = 4): SpotHeight[] {
  const { cols, rows, cells } = grid, n = cols * rows;
  const water = new Uint8Array(n);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) water[r * cols + c] = terrainProps(cells[r][c]).lf === "water" ? 1 : 0;
  const comp = new Int32Array(n).fill(-1), dist = new Int32Array(n).fill(-1), q = new Int32Array(n);
  const near = (i: number, fn: (j: number) => void): boolean => {   // 四邻回调；返回是否贴图幅边
    const c = i % cols, r = (i - c) / cols;
    if (c > 0) fn(i - 1); if (c < cols - 1) fn(i + 1); if (r > 0) fn(i - cols); if (r < rows - 1) fn(i + cols);
    return c === 0 || r === 0 || c === cols - 1 || r === rows - 1;
  };
  let nComp = 0;
  for (let s = 0; s < n; s++) {
    if (!water[s] || comp[s] >= 0) continue;
    let head = 0, tail = 0; q[tail++] = s; comp[s] = nComp;
    while (head < tail) near(q[head++], j => { if (water[j] && comp[j] < 0) { comp[j] = nComp; q[tail++] = j; } });
    nComp++;
  }
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (!water[i]) continue;
    let shore = false;
    if (near(i, j => { if (!water[j]) shore = true; })) shore = true;
    if (shore) { dist[i] = 0; q[tail++] = i; }
  }
  while (head < tail) { const i = q[head++]; near(i, j => { if (water[j] && dist[j] < 0) { dist[j] = dist[i] + 1; q[tail++] = j; } }); }
  const best = new Int32Array(nComp).fill(-1), count = new Int32Array(nComp);
  for (let i = 0; i < n; i++) {
    if (!water[i]) continue;
    const k = comp[i]; count[k]++;
    if (best[k] < 0 || dist[i] > dist[best[k]]) best[k] = i;
  }
  const out: SpotHeight[] = [];
  for (let k = 0; k < nComp; k++) {
    const i = best[k], ws = wsurf[i];
    if (!(ws > 0) || count[k] < minCells) continue;
    const c = i % cols, r = (i - c) / cols;
    out.push({ lon: grid.bb.lonMin + (c + 0.5) * grid.step, lat: grid.bb.latMin + (r + 0.5) * grid.step, e: ws, kind: "water" });
  }
  return out;
}
