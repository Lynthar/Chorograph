/* 标高点（core）：按突出度选的真山顶 + 内陆水体的水面，给等高线补上晕渲画不出的绝对高差。
   纯函数；数字一律取制图面（elevSmooth）＝与光标读数同一个数。峰表要对整场排序，走 Worker（shell/spots）。 */
import { elevSmooth, waterMask, type ElevField } from "./elev.ts";
import type { Grid } from "./grid.ts";
import type { ViewField } from "./viewshed.ts";

export interface SpotHeight { lon: number; lat: number; e: number; kind: "peak" | "water" }

/** 全场峰表：真山顶的细格序号与突出度（抽象单位；全场最高＝Infinity），按突出度降序、同值按高程降序再按序号 */
export interface PeakTable { idx: Int32Array; prom: Float32Array }
/** 峰表与算它的那份规则场：选点与数字都读 f——场已换而新表未到时，画的仍是自洽的上一份 */
export interface SpotTable { f: ElevField; t: PeakTable }

/** 高程降序的格序（LSD 基数排序，稳定＝同高按序号升序）：比较排序在百万格上要慢一个量级 */
function descOrder(e: Float32Array): Uint32Array {
  const n = e.length, u = new Uint32Array(e.buffer, e.byteOffset, n);
  let k = new Uint32Array(n), kt = new Uint32Array(n), idx = new Uint32Array(n), it = new Uint32Array(n);
  for (let i = 0; i < n; i++) { const x = u[i]; k[i] = ~((x & 0x80000000) ? ~x : (x | 0x80000000)) >>> 0; idx[i] = i; }
  const cnt = new Uint32Array(65536);
  for (let sh = 0; sh < 32; sh += 16) {
    cnt.fill(0);
    for (let i = 0; i < n; i++) cnt[(k[i] >>> sh) & 0xffff]++;
    for (let b = 0, s = 0; b < 65536; b++) { const c = cnt[b]; cnt[b] = s; s += c; }
    for (let i = 0; i < n; i++) { const d = cnt[(k[i] >>> sh) & 0xffff]++; kt[d] = k[i]; it[d] = idx[i]; }
    [k, kt] = [kt, k]; [idx, it] = [it, idx];
  }
  return idx;
}

/** 峰表：自高向低扫描、八邻并查集——两块高地在某格相接时，矮的那块之顶的突出度＝顶高 − 该格（关键鞍部）。
    水格按水面参与（岛与湖边山的突出度量到水面、不量到湖床）；只收陆格、不收图幅边格（边上的极大是被图框截断的坡）；
    同高的平台只成一座峰。 */
export function peakTable(vf: Pick<ViewField, "data" | "cols" | "rows" | "step" | "wsurf" | "gstep" | "gcols" | "grows">): PeakTable {
  const { data, cols, rows, wsurf, gcols, grows } = vf, n = cols * rows, gk = vf.step / vf.gstep;
  const e = new Float32Array(n), land = new Uint8Array(n);
  for (let r = 0; r < rows; r++) {
    const g0 = Math.min(grows - 1, Math.floor((r + 0.5) * gk)) * gcols;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c, ws = wsurf[g0 + Math.min(gcols - 1, Math.floor((c + 0.5) * gk))];
      if (data[i] >= ws - 0.02) { e[i] = data[i]; land[i] = 1; } else e[i] = ws;
    }
  }
  const order = descOrder(e);
  const par = new Int32Array(n).fill(-1), top = new Int32Array(n), prom = new Float32Array(n).fill(NaN), roots = new Int32Array(8);
  const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (let o = 0; o < n; o++) {
    const i = order[o], c = i % cols, r = (i - c) / cols;
    let nr = 0;
    for (let rr = Math.max(0, r - 1); rr <= Math.min(rows - 1, r + 1); rr++) for (let cc = Math.max(0, c - 1); cc <= Math.min(cols - 1, c + 1); cc++) {
      const j = rr * cols + cc;
      if (j === i || par[j] < 0) continue;
      const q = find(j);
      let t = 0; while (t < nr && roots[t] !== q) t++;
      if (t === nr) roots[nr++] = q;
    }
    if (!nr) { par[i] = i; top[i] = i; prom[i] = Infinity; continue; }
    let best = roots[0];   // 顶最高的那块并走其余；同高取先扫到的顶（序号小）——平手不看邻格扫描次序
    for (let t = 1; t < nr; t++) { const a = top[roots[t]], b = top[best]; if (e[a] > e[b] || (e[a] === e[b] && a < b)) best = roots[t]; }
    for (let t = 0; t < nr; t++) { const q = roots[t]; if (q !== best) { prom[top[q]] = e[top[q]] - e[i]; par[q] = best; } }
    par[i] = best;
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!(prom[i] > 0) || !land[i]) continue;
    const c = i % cols, r = (i - c) / cols;
    if (c > 0 && r > 0 && c < cols - 1 && r < rows - 1) out.push(i);
  }
  out.sort((a, b) => prom[b] - prom[a] || e[b] - e[a] || a - b);
  return { idx: Int32Array.from(out), prom: Float32Array.from(out, i => prom[i]) };
}

/** 选点参数：突出度与海拔门槛（抽象单位）、屏幕半窗（格）、地面间距椭圆的两半轴（格）；
    lineM＝图上画着的等高距（米，0＝没画线），unitM＝米/抽象单位 */
export interface PickOpts { minProm: number; minE: number; win: number; sepC: number; sepR: number; lineM: number; unitM: number }

/** 一个视口的山顶：峰表里过门槛、且显示值（取整米）不恰在等高线上的峰，按表序（突出度降序）过非极大抑制——
    与已留者切比雪夫距离 < win 格（屏幕窗）或落在 sepC×sepR 格的椭圆内（地面距离）就不标。 */
export function pickPeaks(t: PeakTable, f: ElevField, o: PickOpts): SpotHeight[] {
  const { minProm, minE, win, sepC, sepR, lineM, unitM } = o;
  const { cols, data } = f, B = Math.max(1, win, Math.ceil(sepC), Math.ceil(sepR));
  const bw = Math.ceil(cols / B), cells = new Map<number, number[]>(), out: SpotHeight[] = [];
  const near = (c: number, r: number): boolean => {
    const bx = Math.floor(c / B), by = Math.floor(r / B);
    for (let y = by - 1; y <= by + 1; y++) for (let x = bx - 1; x <= bx + 1; x++) {
      const kept = x >= 0 && x < bw && y >= 0 ? cells.get(y * bw + x) : undefined;
      if (kept) for (let j = 0; j < kept.length; j += 2) {
        const dc = Math.abs(kept[j] - c), dr = Math.abs(kept[j + 1] - r);
        if (Math.max(dc, dr) < win || (sepC > 0 && sepR > 0 && (dc / sepC) ** 2 + (dr / sepR) ** 2 < 1)) return true;
      }
    }
    return false;
  };
  for (let k = 0; k < t.idx.length && t.prom[k] >= minProm; k++) {
    const i = t.idx[k], c = i % cols, r = (i - c) / cols;
    if (near(c, r)) continue;
    const lon = f.bb.lonMin + (c + 0.5) * f.step, lat = f.bb.latMin + (r + 0.5) * f.step, e = elevSmooth(data, f, lon, lat);
    if (e < minE) continue;
    if (lineM > 0) { const q = Math.round(e * unitM) / lineM; if (Math.abs(q - Math.round(q)) < 1e-9) continue; }   // 数字与线重复：线已经说了这个数
    const key = Math.floor(r / B) * bw + Math.floor(c / B);
    (cells.get(key) || cells.set(key, []).get(key)!).push(c, r);
    out.push({ lon, lat, e, kind: "peak" });
  }
  return out;
}

/** 内陆水体的水面：地貌 water 的粗格四邻连通块一块一枚，位置取离岸最远的格（岸格＝有陆邻或贴图幅边，多源 BFS）。
    水面 0＝海（碰图幅边）不标、不足 minCells 格的水洼不标；按块大小降序，与已标的同值水面相距 < sepKm 就不再标
    （水面同值＝同一类型高程，浮点全等）。km＝经/纬向每度公里。 */
export function waterSpots(grid: Grid, wsurf: Float32Array, km: { kmx: number; kmy: number }, sepKm: number, minCells = 4): SpotHeight[] {
  const { cols, rows } = grid, n = cols * rows;
  const water = waterMask(grid);
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
  const byCount = Array.from({ length: nComp }, (_, k) => k).filter(k => wsurf[best[k]] > 0 && count[k] >= minCells)
    .sort((a, b) => count[b] - count[a] || a - b);
  const out: SpotHeight[] = [];
  for (const k of byCount) {
    const i = best[k], ws = wsurf[i], c = i % cols, r = (i - c) / cols;
    const lon = grid.bb.lonMin + (c + 0.5) * grid.step, lat = grid.bb.latMin + (r + 0.5) * grid.step;
    if (out.some(s => s.e === ws && Math.hypot((s.lon - lon) * km.kmx, (s.lat - lat) * km.kmy) < sepKm)) continue;
    out.push({ lon, lat, e: ws, kind: "water" });
  }
  return out;
}
