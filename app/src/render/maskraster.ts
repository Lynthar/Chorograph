/* 视线掩膜的屏幕栅格（纯函数，node 可测）：按缩放把掩膜变成覆盖率位图，再取 0.5 等值线作可达区域的边。
   格比像素大＝逐格原样；格比像素小＝按面积平均缩小到接近屏幕分辨率——最近邻缩小每像素只留一个源格，
   稀疏掩膜的可达格会成片消失。位图行 0 在上（掩膜行 0 在南，此处翻行）。 */
import type { VisMask } from "../core/viewshed.ts";

/** 覆盖率位图：w×h，行 0 在上，值 0..1＝该像素所罩源格里可达的面积占比 */
export interface Coverage { w: number; h: number; cov: Float32Array }

/** s＝每格的屏幕像素数：≥1 逐格；<1 缩到 ceil(cols·s)×ceil(rows·s)，每像素＝所罩源格的面积加权平均 */
export function maskCoverage(m: VisMask, s: number): Coverage {
  if (s >= 1) {
    const cov = new Float32Array(m.cols * m.rows);
    for (let r = 0; r < m.rows; r++) {
      const src = (m.rows - 1 - r) * m.cols, dst = r * m.cols;
      for (let c = 0; c < m.cols; c++) cov[dst + c] = m.vis[src + c];
    }
    return { w: m.cols, h: m.rows, cov };
  }
  const w = Math.ceil(m.cols * s), h = Math.ceil(m.rows * s);
  const wx = boxWeights(m.cols, w), wy = boxWeights(m.rows, h);
  const rowSum = new Float32Array(m.rows * w);   // 先按行缩到 w 列（仍是掩膜行序），再按列缩并翻行
  for (let r = 0; r < m.rows; r++) {
    const src = r * m.cols, dst = r * w;
    for (const [x, c, k] of wx) rowSum[dst + x] += m.vis[src + c] * k;
  }
  const cov = new Float32Array(w * h);
  for (const [y, r, k] of wy) {
    const src = r * w, dst = (h - 1 - y) * w;
    for (let x = 0; x < w; x++) cov[dst + x] += rowSum[src + x] * k;
  }
  return { w, h, cov };
}

/** 输出像素 x 所罩的源格与权：源区间 [x·n/out, (x+1)·n/out)，权＝重叠长度/区间长，每个输出像素的权和为 1 */
function boxWeights(n: number, out: number): [number, number, number][] {
  const span = n / out, res: [number, number, number][] = [];
  for (let x = 0; x < out; x++) {
    const a = x * span, b = Math.min(n, a + span);
    for (let c = Math.floor(a); c < b; c++) {
      const k = (Math.min(b, c + 1) - Math.max(a, c)) / span;
      if (k > 0) res.push([x, c, k]);
    }
  }
  return res;
}

/* marching squares 的 16 种角态 → 穿过的边（0 上 1 右 2 下 3 左）；角位 a 左上 8 · b 右上 4 · c 右下 2 · d 左下 1。
   鞍点 5/10 各取一种连法，画线不区分。 */
const CASES: [number, number][][] = [
  [], [[3, 2]], [[2, 1]], [[3, 1]], [[0, 1]], [[0, 1], [3, 2]], [[0, 2]], [[0, 3]],
  [[0, 3]], [[0, 2]], [[0, 3], [1, 2]], [[0, 1]], [[3, 1]], [[2, 1]], [[3, 2]], []
];

/** 覆盖率 thr 等值线的线段集：每四个数一段 (x0,y0,x1,y1)，位图像素坐标、像素中心在 +0.5，位图外视为 0 */
export function maskContour(cv: Coverage, thr = 0.5): Float32Array {
  const { w, h, cov } = cv;
  const v = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : cov[y * w + x];
  const out: number[] = [];
  const pt = new Float64Array(8);   // 四条边上的交点 x,y：上 右 下 左
  for (let y = -1; y < h; y++) for (let x = -1; x < w; x++) {
    const a = v(x, y), b = v(x + 1, y), c = v(x + 1, y + 1), d = v(x, y + 1);
    const idx = (a >= thr ? 8 : 0) | (b >= thr ? 4 : 0) | (c >= thr ? 2 : 0) | (d >= thr ? 1 : 0);
    const segs = CASES[idx];
    if (!segs.length) continue;
    const X = x + 0.5, Y = y + 0.5, t = (p: number, q: number): number => (thr - p) / (q - p);
    pt[0] = X + t(a, b); pt[1] = Y;
    pt[2] = X + 1; pt[3] = Y + t(b, c);
    pt[4] = X + t(d, c); pt[5] = Y + 1;
    pt[6] = X; pt[7] = Y + t(a, d);
    for (const [p, q] of segs) out.push(pt[p * 2], pt[p * 2 + 1], pt[q * 2], pt[q * 2 + 1]);
  }
  return Float32Array.from(out);
}
