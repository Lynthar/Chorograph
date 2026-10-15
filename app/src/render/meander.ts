/* 曲流：带逐点强度 mz 的河在柔化后的底线上合成弯道（Kinoshita 正弦生成曲线 θ = θ0·sin φ + J·θ0³·cos 3φ）。
   与缩放无关、只进画面：rivers.riverGeom 把它当这条河的几何，叠加层、拾取与两个地形渲染器同读；
   叠加层按弯的屏幕波长把偏移渐入（edges.riverShape），宽到画成水面的段恒是满幅。 */
import { FP_CORE, FP_KW, MZ_MAX, RIV_WIDTH } from "../core/constants.ts";
import { kmPerDeg, lonCos } from "../core/geo.ts";
import type { Meta } from "../core/types.ts";

/** 弯的谷向波长 ＝ 它 × 河宽（米制同比；弧长波长再除以 J0(θ0)） */
export const MEANDER_K = 11;
/** 最大偏角（度）：再乘每半个弯的深浅（MEANDER_DEPTH 倍到 1 倍随机）、河段的深浅（MEANDER_REACH 倍到 1 倍、多半靠近 1，
    每 REACH_PERIODS 个弯一个随机值、其间平滑过渡）与 mz ÷ MZ_MAX */
export const MEANDER_DEG = 100;
const MEANDER_DEPTH = 0.7, MEANDER_REACH = 0.3, REACH_PERIODS = 3;
/** 每半个弯的长短：谷向波长乘 [MEANDER_LEN, MEANDER_LEN + 2·(1 − MEANDER_LEN)] 间的随机数（均值 1） */
const MEANDER_LEN = 0.6;
/** 偏斜项系数 J（每条河随机取正负）：弯顶朝上游或下游歪 */
const MEANDER_SKEW = 0.03;
/** 叠加层按弯的屏幕谷向波长（px）渐入：不到前者不弯、到后者满幅（smoothstep）。
    满幅的门必须 ≤ MEANDER_K × RIVER_WATER_PX：画成水面的段恒是满幅，线与水面才是同一条曲线 */
export const MEANDER_FADE_PX: readonly [number, number] = [6, 12];
/** 每个弧长波长的输出点数（积分步长减半） */
const N_ARC = 16;
/** 单条河的曲流点数预算：手编档的极窄长河按比例放大波长，不让一条河撑出百万个点 */
const MAX_PTS = 60000;

/** 合成结果：pts 是满幅曲线（经纬度），逐点 w 水面宽（米）、bx/by 该点在底线上的位置、u 底线弧长（km）、seg 所在底线段号；
    U 是底线逐点弧长（km）。f 倍幅度的点＝底线位置 + f·(pts − 底线位置) */
export interface Meander {
  pts: [number, number][]; w: number[]; bx: Float64Array; by: Float64Array; u: Float64Array; seg: Int32Array; U: Float64Array; wmax: number;
}

/** 开折线上的一维 Chaikin（与 chaikinOpen 同权、同遍数）：逐点宽与原始点序号随底线一起柔化 */
export function chaikin1(v: number[]): number[] {
  for (let it = 0; it < 2 && v.length >= 3; it++) {
    const o = [v[0]];
    for (let i = 0; i < v.length - 1; i++) o.push(v[i] * 0.75 + v[i + 1] * 0.25, v[i] * 0.25 + v[i + 1] * 0.75);
    o.push(v[v.length - 1]);
    v = o;
  }
  return v;
}
const sstep = (x: number): number => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };
/** 叠加层的渐入系数：弯的屏幕谷向波长 lamPx（px）→ 0..1 */
export const meanderFade = (lamPx: number): number => sstep((lamPx - MEANDER_FADE_PX[0]) / (MEANDER_FADE_PX[1] - MEANDER_FADE_PX[0]));
/** 整数对 → [0,1) */
function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b + 0x632be5ab) | 0, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** 河的种子：首点经纬（四位小数取整）的哈希 */
export const meanderSeed = (p: [number, number]): number => Math.floor(hash01(Math.round(p[0] * 1e4) | 0, Math.round(p[1] * 1e4) | 0) * 2147483647);
/** 第一类零阶贝塞尔 J0（|x| ≤ 3 的多项式，误差 < 5e-8）：正弦生成曲线谷向波长 ÷ 弧长波长 */
function j0(x: number): number {
  const y = (x / 3) * (x / 3);
  return 1 + y * (-2.2499997 + y * (1.2656208 + y * (-0.3163866 + y * (0.0444479 + y * (-0.0039444 + y * 0.00021)))));
}

/**
 * 在底线 P（Chaikin 柔化后、经度已接连续）上合成曲流。
 * @param bw 底线逐点水面宽（米，与 P 等长）：波长按它，横移封在冲积平原平底（FP_CORE·FP_KW·√水量，水量按 RIV_WIDTH 由宽反推）内
 * @param mz 原始折线逐点强度（0..MZ_MAX）：首尾与「自己为 0、两邻都弯」的点（汇合处）是钉点，曲线过钉点处的底线、前后约一个波长内收平
 * @returns 没有弯（全 0、没有宽、几何坏）＝null
 */
export function meanderOf(meta: Meta | undefined, P: [number, number][], bw: number[], mz: number[], seed: number): Meander | null {
  const n = P.length, m = mz.length;
  if (n < 2 || m < 2 || bw.length !== n || !mz.some(z => z > 0)) return null;
  const kpd = kmPerDeg(meta), U = new Float64Array(n), TX = new Float64Array(n), TY = new Float64Array(n);
  let wmax = 0;
  for (let j = 0; j < n; j++) { const v = bw[j]; if (!(v > 0) || !isFinite(v)) return null; if (v > wmax) wmax = v; }
  for (let j = 0; j < n - 1; j++) {
    const dx = (P[j + 1][0] - P[j][0]) * kpd * lonCos(meta, (P[j][1] + P[j + 1][1]) / 2), dy = (P[j + 1][1] - P[j][1]) * kpd, L = Math.hypot(dx, dy);
    if (!isFinite(L)) return null;
    U[j + 1] = U[j] + L;
    if (L > 0) { TX[j] = dx / L; TY[j] = dy / L; } else if (j) { TX[j] = TX[j - 1]; TY[j] = TY[j - 1]; } else TX[j] = 1;
  }
  const L = U[n - 1];
  if (!(L > 0)) return null;
  /* 逐点左法向：相邻两段切向之和归一（端点取那一段） */
  const NX = new Float64Array(n), NY = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let tx = j < n - 1 ? TX[j] : 0, ty = j < n - 1 ? TY[j] : 0;
    if (j > 0) { tx += TX[j - 1]; ty += TY[j - 1]; }
    const l = Math.hypot(tx, ty) || 1; NX[j] = -ty / l; NY[j] = tx / l;
  }
  /* 钉点与有效强度：钉点取两邻（首尾取邻点）的强度，收平交给钉点包络；原始点序号 t 随底线柔化，定强度与钉点在底线上的位置 */
  const z = mz.map(v => Math.max(0, Math.min(MZ_MAX, +v || 0))), v = z.slice(), pinK: number[] = [];
  for (let k = 0; k < m; k++) {
    if (k === 0 || k === m - 1) { pinK.push(k); v[k] = z[k === 0 ? 1 : m - 2]; }
    else if (z[k] === 0 && z[k - 1] > 0 && z[k + 1] > 0) { pinK.push(k); v[k] = (z[k - 1] + z[k + 1]) / 2; }
  }
  const t = chaikin1(Array.from({ length: m }, (_, k) => k));
  if (t.length !== n) return null;
  const A = new Float64Array(n);
  for (let j = 0; j < n; j++) { const k0 = Math.floor(t[j]), k1 = Math.min(m - 1, k0 + 1), f = t[j] - k0; A[j] = (v[k0] + (v[k1] - v[k0]) * f) / MZ_MAX; }
  let jp = 0;
  const segAt = (u: number): number => { while (jp < n - 2 && U[jp + 1] <= u) jp++; while (jp > 0 && U[jp] > u) jp--; return jp; };   // U[j] ≤ u < U[j+1]（末段含 L）
  const lerpAt = (arr: ArrayLike<number>, u: number): number => { const j = segAt(u), d = U[j + 1] - U[j], f = d > 0 ? Math.max(0, Math.min(1, (u - U[j]) / d)) : 0; return arr[j] + (arr[j + 1] - arr[j]) * f; };
  const lamV = (u: number): number => MEANDER_K * lerpAt(bw, u) / 1000;   // km
  const pins: { u: number; lam: number }[] = [];
  for (const k of pinK) {
    let u = k === 0 ? 0 : k === m - 1 ? L : NaN;
    if (u !== u) for (let j = 0; j < n - 1; j++) if (t[j] <= k && k <= t[j + 1]) { u = U[j] + (U[j + 1] - U[j]) * (t[j + 1] > t[j] ? (k - t[j]) / (t[j + 1] - t[j]) : 0); break; }
    if (u === u) pins.push({ u, lam: lamV(u) });
  }
  pins.sort((a, b) => a.u - b.u);
  const lmax = Math.max(...pins.map(q => q.lam));
  let pp = 0;
  const env = (u: number): number => {   // 钉点包络：离钉点一个波长内 smoothstep 收到 0
    while (pp < pins.length - 1 && pins[pp].u < u - lmax) pp++;
    while (pp > 0 && pins[pp - 1].u >= u - lmax) pp--;
    let e = 1;
    for (let q = pp; q < pins.length && pins[q].u <= u + lmax; q++) { const d = Math.abs(u - pins[q].u); if (d < pins[q].lam) e *= sstep(d / pins[q].lam); }
    return e;
  };
  /* 点数预算：按最窄处估，超了整条按比例放大波长 */
  let est = 0;
  for (let j = 0; j < n - 1; j++) if (A[j] > 0 || A[j + 1] > 0) est += 2 * N_ARC * (U[j + 1] - U[j]) / (MEANDER_K * Math.min(bw[j], bw[j + 1]) / 1000) / j0(MEANDER_DEG * Math.PI / 180);
  const reach = (q: number): number => { const r = hash01(seed ^ 0x5bd1e995, q); return 1 - (1 - MEANDER_REACH) * r * r; };
  const lamS = est > MAX_PTS ? est / MAX_PTS : 1, th = MEANDER_DEG * Math.PI / 180, jsk = (hash01(seed, 1) < 0.5 ? -1 : 1) * MEANDER_SKEW;
  const dep = (h: number): number => MEANDER_DEPTH + (1 - MEANDER_DEPTH) * hash01(seed, 2 * h + 2), len = (h: number): number => MEANDER_LEN + 2 * (1 - MEANDER_LEN) * hash01(seed, 2 * h + 3);
  /* 沿弧长积分（中点法，每输出点两步）；底线两段都不弯时一步跨到下一个底线点 */
  const oU: number[] = [0], oY: number[] = [0], oF: number[] = [];
  let u = 0, y = 0, ph = 2 * Math.PI * hash01(seed, 7), st = 0;
  oF.push(ph);
  while (u < L) {
    const j = segAt(u);
    if (A[j] === 0 && A[j + 1] === 0) {
      const to = U[j + 1];
      ph += 2 * Math.PI * (to - u) / (lamV((u + to) / 2) * lamS); u = to;
      oU.push(u); oY.push(y); oF.push(ph); st = 0;
      continue;
    }
    const hl = (ph - Math.PI / 2) / Math.PI, h = Math.floor(hl), fr = sstep(hl - h);
    const rl = ph / (2 * Math.PI * REACH_PERIODS), rq = Math.floor(rl), r0 = reach(rq), rf = r0 + (reach(rq + 1) - r0) * sstep(rl - rq);
    const a = lerpAt(A, u) * env(u), t0 = th * a * rf * (dep(h) + (dep(h + 1) - dep(h)) * fr);
    const la = lamV(u) * lamS * (len(h) + (len(h + 1) - len(h)) * fr) / j0(t0), ds = la / (2 * N_ARC);
    const pm = ph + Math.PI * ds / la, tv = t0 * Math.sin(pm) + jsk * t0 * t0 * t0 * Math.cos(3 * pm);
    u += Math.cos(tv) * ds; y += Math.sin(tv) * ds; ph += 2 * Math.PI * ds / la;
    if (++st % 2 === 0 || u >= L) { oU.push(u); oY.push(y); oF.push(ph); }
    if (oU.length > 2 * MAX_PTS) return null;
  }
  const no = oU.length;
  oU[no - 1] = L;
  /* 去漂移：减去前后各半个相位周期内按相位加权的均值（弯在一个周期里正负抵消，剩下的就是漂移）；再乘钉点包络、软封在平底内 */
  const C = new Float64Array(no);
  for (let i = 1; i < no; i++) C[i] = C[i - 1] + (oY[i] + oY[i - 1]) / 2 * (oF[i] - oF[i - 1]);
  const cAt = (f: number, i: number): number => { const d = oF[i + 1] - oF[i]; return C[i] + (d > 0 ? (C[i + 1] - C[i]) * (f - oF[i]) / d : 0); };
  const Y = new Float64Array(no);
  for (let i = 0, a = 0, b = 0; i < no; i++) {
    const fa = Math.max(oF[0], oF[i] - Math.PI), fb = Math.min(oF[no - 1], oF[i] + Math.PI);
    while (a < no - 2 && oF[a + 1] <= fa) a++;
    while (b < no - 2 && oF[b + 1] < fb) b++;
    const mean = fb > fa ? (cAt(fb, b) - cAt(fa, a)) / (fb - fa) : oY[i];
    const cap = FP_CORE * FP_KW * lerpAt(bw, oU[i]) / RIV_WIDTH, yy = (oY[i] - mean) * env(oU[i]), ay = Math.abs(yy), k0 = 0.8 * cap;
    Y[i] = ay <= k0 ? yy : Math.sign(yy) * (k0 + (cap - k0) * Math.tanh((ay - k0) / (cap - k0)));
  }
  /* 映回经纬：底线上同一弧长处的位置与插值法向 */
  const pts: [number, number][] = [], w: number[] = [], bx = new Float64Array(no), by = new Float64Array(no), uu = new Float64Array(no), seg = new Int32Array(no);
  for (let i = 0; i < no; i++) {
    const ui = Math.max(0, Math.min(L, oU[i])), j = segAt(ui), d = U[j + 1] - U[j], f = d > 0 ? Math.max(0, Math.min(1, (ui - U[j]) / d)) : 0;
    const x = i === 0 ? P[0][0] : i === no - 1 ? P[n - 1][0] : P[j][0] + (P[j + 1][0] - P[j][0]) * f;
    const yv = i === 0 ? P[0][1] : i === no - 1 ? P[n - 1][1] : P[j][1] + (P[j + 1][1] - P[j][1]) * f;
    let nx = NX[j] + (NX[j + 1] - NX[j]) * f, ny = NY[j] + (NY[j + 1] - NY[j]) * f;
    const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    const o = i === 0 || i === no - 1 ? 0 : Y[i];
    bx[i] = x; by[i] = yv; uu[i] = ui; seg[i] = j;
    pts.push(o ? [x + nx * o / (kpd * lonCos(meta, yv)), yv + ny * o / kpd] : [x, yv]);
    w.push(bw[j] + (bw[j + 1] - bw[j]) * f);
  }
  return { pts, w, bx, by, u: uu, seg, U, wmax };
}
