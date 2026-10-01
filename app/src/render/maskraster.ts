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
   鞍点 5/10 各取一种连法，画线不区分。**全仓唯一一份**，链折线也只在下方 tracePolylines：掩膜轮廓与等高线注记共用。 */
export const MS_CASES: [number, number][][] = [
  [], [[3, 2]], [[2, 1]], [[3, 1]], [[0, 1]], [[0, 1], [3, 2]], [[0, 2]], [[0, 3]],
  [[0, 3]], [[0, 2]], [[0, 3], [1, 2]], [[0, 1]], [[3, 1]], [[2, 1]], [[3, 2]], []
];

/** 等值线采样面：w×h 个样点，行 0 在上；NaN 角＝该格不出线（等高线注记用它挖掉水与图幅外） */
export interface IsoSurf { w: number; h: number; v: Float32Array }

/** level 等值线的折线集（采样格坐标，每条＝扁平 [x0,y0,x1,y1,…]；闭合环首尾同点）。
    边编号：横边 (x,y)＝(y·w+x)·2、纵边 (x,y)＝(y·w+x)·2+1——同一条边在两格间是同一个整数键，交点由边与 level 唯一决定。 */
export function tracePolylines(s: IsoSurf, level: number): number[][] {
  const { w, h, v } = s;
  const link = new Map<number, number[]>();
  const add = (a: number, b: number): void => {
    const la = link.get(a); if (la) la.push(b); else link.set(a, [b]);
    const lb = link.get(b); if (lb) lb.push(a); else link.set(b, [a]);
  };
  for (let y = 0; y + 1 < h; y++) for (let x = 0; x + 1 < w; x++) {
    const a = v[y * w + x], b = v[y * w + x + 1], c = v[(y + 1) * w + x + 1], d = v[(y + 1) * w + x];
    if (!(a === a && b === b && c === c && d === d)) continue;   // 任一角 NaN＝此格不出线
    const segs = MS_CASES[(a >= level ? 8 : 0) | (b >= level ? 4 : 0) | (c >= level ? 2 : 0) | (d >= level ? 1 : 0)];
    if (!segs.length) continue;
    const E = [(y * w + x) * 2, (y * w + x + 1) * 2 + 1, ((y + 1) * w + x) * 2, (y * w + x) * 2 + 1];   // 上 右 下 左
    for (const [p, q] of segs) add(E[p], E[q]);
  }
  /* 交点按边解码：角值跨 level 才会有这条边，故除数非零 */
  const ptOf = (e: number, out: number[]): void => {
    const i = e >> 1, x = i % w, y = (i - x) / w;
    if (e & 1) { const p = v[y * w + x], q = v[(y + 1) * w + x]; out.push(x, y + (level - p) / (q - p)); }
    else { const p = v[y * w + x], q = v[y * w + x + 1]; out.push(x + (level - p) / (q - p), y); }
  };
  const seen = new Set<number>();
  const walk = (start: number): number[] => {
    const pts: number[] = [];
    let cur = start, prev = -1;
    for (;;) {
      seen.add(cur); ptOf(cur, pts);
      const nb = link.get(cur)!;
      let nxt = -1;
      for (const k of nb) if (k !== prev && !seen.has(k)) { nxt = k; break; }
      if (nxt < 0) { if (pts.length > 4 && nb.includes(start)) ptOf(start, pts); break; }   // 回到起点＝闭合环
      prev = cur; cur = nxt;
    }
    return pts;
  };
  const out: number[][] = [];
  for (const [k, nb] of link) if (nb.length === 1 && !seen.has(k)) out.push(walk(k));   // 先从开口端走，链才完整
  for (const k of link.keys()) if (!seen.has(k)) out.push(walk(k));                     // 余下的是闭合环
  return out.filter(p => p.length >= 4);
}

/** 覆盖率 thr 等值线（可达区域的边）：闭合环，每环扁平 [x0,y0,x1,y1,…] 首尾同点，位图像素坐标、像素中心在 +0.5，位图外视为 0。
    ⚠ 描边要用链好的环：散段每段各带线帽，上万段逐帧重新栅格化会把平移拖到几十毫秒一帧。 */
export function maskOutline(cv: Coverage, thr = 0.5): number[][] {
  const W = cv.w + 2, H = cv.h + 2, v = new Float32Array(W * H);   // 四周补一圈 0＝环都闭合
  for (let y = 0; y < cv.h; y++) v.set(cv.cov.subarray(y * cv.w, (y + 1) * cv.w), (y + 1) * W + 1);
  const rings = tracePolylines({ w: W, h: H, v }, thr);
  for (const p of rings) for (let i = 0; i < p.length; i++) p[i] -= 0.5;   // 采样点 k ↔ 像素 k−1 的中心
  return rings;
}
