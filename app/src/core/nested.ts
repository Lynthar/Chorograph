/* 块层嵌套解：带中尺度的 v2 战略图，分块精修不跑细级侵蚀，而在块的窗口细格上照外层（中尺度或画抬升）的稳态解再解一层河流功率律——
   外层的干流钉成骨架、U / K 取外层，收尾回到父基底的大形。全图工作档与别的图的块照旧走 core/erode。
   ⚠ 跨引擎逐位确定（同 core/gen2）：只用四则、开方、floor 与整数哈希；窗口里的一切按全图细格号与全图坐标取，相邻两窗的公共格才同值。 */
import { SHORE_E, WATER_EPS } from "./constants.ts";
import { BOWL_MAX, MESO_ACRIT_KM2, MESO_HEAD, MESO_KAPPA_M, MESO_PLAIN_U0, MESO_PLAIN_U1, MESO_U_MIN, PEAK_KNEE_M, PEAK_SOFT_M, cosD, pointOf, type MesoState } from "./gen2.ts";
import { cellRand } from "./gen2mesh.ts";
import { steady, type SteadyGraph, type SteadyResult } from "./steady.ts";
import type { ElevField } from "./elev.ts";
import type { ErodeInput } from "./erode.ts";

/** 算法代号：嵌套解的流程或常数变了加一（只进带 nest 的单的键） */
export const NEST_VER = 1;
/** 每窗向外多解的父格：骨架之外的谷与坡要在这之内定形，不够则相邻两窗在块心交界上对不上 */
export const NEST_MARGIN = 8;
/** 骨架源点在窗口外再取几个父格：三角网的边（流向的一步）最多跨三格，窗外三格的节点流进窗里的那段要画上 */
export const NEST_REACH = 3;
/** 单的裁剪在窗口外再多几个父格：骨架源点的受水者再远三格；初值的三趟磨平也要窗口外三格才与全图同值 */
export const NEST_PAD = 2 * NEST_REACH;
/** 骨架：外层稳态树上汇流面积至少几个父格的边钉成细格出口（按父格数，格边变了骨架密度跟着变才与外层同尺度） */
export const NEST_SKEL_CELLS = 4;
/** 骨架编码的受水者格偏移上限：sk＝1 + (dy + R)·(2R + 1) + (dx + R)，超出的边不当骨架 */
const SK_R = 7, SK_W = 2 * SK_R + 1;
/** 细格节点的抖动全幅（格）：四邻 + 较短对角线的抖动四边形网，规则网格上的八邻流向会排成直谷 */
const NEST_JIT = 0.8;
/** K 的逐细格抖动全幅（同中尺度 0.8–1.2）：平缓处流向树不排成平行梳子 */
const NEST_KJIT = 0.4;
/** 求解轮数：首轮洪泛定树，此后固定这么多轮即停（确定性停止，不等收敛） */
const NEST_ITERS = 20;
/** 坡面扩散：汇流面积小于它（km²）的节点，遍数与系数 */
const HILL_KM2 = 20, HILL_PASSES = 4, HILL_K = 0.5;
/** 低通校正的箱式遍数；半径取一个父格（整数个细格）：块的大形与目标面一致 */
const LOW_PASSES = 3;
/** 「地势起伏」的参照档（「自然」）：坡面细节按 amp ÷ 它缩放，这一档就是解出来的样子 */
const NEST_AMP_REF = 0.7;
/** 种子偏移：K 抖动、初值扰动、节点抖动各用一路 */
const SEED_K = 4242, SEED_H0 = 17, SEED_JIT = 99;

/** 外层的静态场（一张图一份，随 mesoKey）：三角网节点位置（格坐标，格 (q, r) 的格心在 (q, r)）与插到网格的宏观 U / K / 高原 / 盆地 */
export interface NestBase {
  cols: number; rows: number;
  X: Float32Array; Y: Float32Array; fU: Float32Array; fK: Float32Array; fP: Float32Array; fB: Float32Array;
  /** 生成器种子（gen2 的 seed × 31）、每度公里、球面 */
  seed: number; kmd: number; sphere: boolean;
}
/** 外层的一份解：h 稳态高程（米）· sk 骨架边（0＝不是，否则受水者的格偏移编码）· up 画抬升叠的抬升（宏观单位）与软边权重（稀疏、格号升序；没画山为 null） */
export interface NestSol { h: Float32Array; sk: Uint8Array; up: { idx: Int32Array; du: Float32Array; kw: Float32Array } | null }
/** 宿主按块裁剪的来源：静态场与当前那份解 */
export interface NestSrc { base: NestBase; sol: NestSol }
/** 一窗的外层裁剪（ErodeInput.nest）。单的父格范围是窗口外扩 NEST_PAD 再钳到图幅，基底、水面、水域、盆地与涂改都按它裁；只解窗口那一块。
    du / kw＝画抬升（裁剪里全 0 为 null）；bsig＝静态场全图那份的内容摘要，键拿它代替逐块的静态场 */
export interface NestInput {
  /** 解的窗口：原点（全图父格）与宽高 */
  wx: number; wy: number; wcols: number; wrows: number;
  /** 单的裁剪原点（全图父格）、全图父格列数、细格倍率 */
  x0: number; y0: number; gcols: number; sx: number;
  /** 全图原点（度）与父格边长：细格的经纬一律按全图细格号算 */
  lon0: number; lat0: number; step: number;
  seed: number; kmd: number; sphere: boolean;
  h: Float32Array; sk: Uint8Array; X: Float32Array; Y: Float32Array; fU: Float32Array; du: Float32Array | null; kw: Float32Array | null; K: Float32Array; P: Float32Array; B: Float32Array;
  bsig: string;
}

/** 中尺度求解状态 → 静态场（拷贝，回执可整份交出） */
export function nestBaseOf(st: MesoState): NestBase {
  const { pr, G } = st, { cols, rows } = pr.g;
  return { cols, rows, X: G.X.slice(), Y: G.Y.slice(), fU: Float32Array.from(pr.fU), fK: Float32Array.from(pr.fK), fP: Float32Array.from(pr.fP), fB: Float32Array.from(pr.fB),
    seed: pr.p.seed * 31, kmd: pr.p.kmd, sphere: pr.p.sphere };
}
/**
 * 一份外层稳态解（h / rcv / A 同 steady：中尺度的 Sg 或画抬升的解）→ 嵌套用的解：骨架＝非出口、流向不指自己、汇流面积 ≥ NEST_SKEL_CELLS 个本格面积。
 * 骨架的树与高程必须出自同一份稳态解：换成收尾后最终地表的流向树（抽河的那棵），平原与过渡带上骨架会比四周高出一截成墙、成坑，两窗交界差到上百米
 */
export function nestSolOf(st: MesoState, sol: { h: Float64Array; rcv: Int32Array; A: Float64Array }, up: { du: Float64Array; kw: Float64Array } | null): NestSol {
  const { pr } = st, { cols } = pr.g, { h, rcv, A } = sol, n = rcv.length, area = pr.area, out = pr.inp.out, sk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const j = rcv[i]; if (j === i || out[i] || !(A[i] >= NEST_SKEL_CELLS * area[i])) continue;
    const dx = (j % cols) - (i % cols), dy = ((j / cols) | 0) - ((i / cols) | 0);
    if (dx >= -SK_R && dx <= SK_R && dy >= -SK_R && dy <= SK_R) sk[i] = 1 + (dy + SK_R) * SK_W + dx + SK_R;
  }
  let u: NestSol["up"] = null;
  if (up) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (up.du[i] !== 0 || up.kw[i] !== 0) idx.push(i);
    u = { idx: Int32Array.from(idx), du: Float32Array.from(idx, i => up.du[i]), kw: Float32Array.from(idx, i => up.kw[i]) };
  }
  return { h: Float32Array.from(h), sk, up: u };
}

/** 只算键用的裁剪里静态场的占位（键拿 bsig 代替它们）：这样的裁剪发不得单 */
const NO_STATIC = new Float32Array(0);
/**
 * 窗口 [a0, a1) × [b0, b1) 的外层裁剪，裁到 [x0, x1) × [y0, y1)（全图父格，须罩住窗口外扩 NEST_PAD 钳到图幅）；lon0 / lat0 / step 是全图网格的原点与父格边长。
 * @param withStatic false＝静态场不裁、只放占位：键与带静态场的那份一字不差，但这份不能拿去解（nestedField 会读到空数组）
 */
export function nestCrop(src: NestSrc, a0: number, a1: number, b0: number, b1: number, x0: number, x1: number, y0: number, y1: number, sx: number, lon0: number, lat0: number, step: number, withStatic = true): NestInput {
  const { base: B, sol: S } = src, gc = B.cols, w = x1 - x0, hh = y1 - y0, n = w * hh;
  const sub = <T extends Float32Array | Uint8Array>(a: T): T => {
    const o = new (a.constructor as new (n: number) => T)(n);
    for (let r = 0; r < hh; r++) o.set(a.subarray((y0 + r) * gc + x0, (y0 + r) * gc + x1), r * w);
    return o;
  };
  const st = (a: Float32Array): Float32Array => withStatic ? sub(a) : NO_STATIC;
  const du = S.up ? new Float32Array(n) : NO_STATIC, kw = S.up ? new Float32Array(n) : NO_STATIC;
  let anyDu = false, anyKw = false;
  if (S.up) {   // 稀疏表按格号升序：逐行二分到行首
    const { idx } = S.up;
    for (let r = 0; r < hh; r++) {
      const g0 = (y0 + r) * gc + x0, g1 = g0 + w;
      let lo = 0, hi = idx.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (idx[m] < g0) lo = m + 1; else hi = m; }
      for (let t = lo; t < idx.length && idx[t] < g1; t++) { const k = r * w + idx[t] - g0; du[k] = S.up.du[t]; kw[k] = S.up.kw[t]; if (du[k] !== 0) anyDu = true; if (kw[k] > 0) anyKw = true; }
    }
  }
  return { wx: a0, wy: b0, wcols: a1 - a0, wrows: b1 - b0, x0, y0, gcols: gc, sx, lon0, lat0, step, seed: B.seed, kmd: B.kmd, sphere: B.sphere,
    h: sub(S.h), sk: sub(S.sk), X: st(B.X), Y: st(B.Y), fU: st(B.fU), du: anyDu ? du : null, kw: anyKw ? kw : null, K: st(B.fK), P: st(B.fP), B: st(B.fB), bsig: baseSig(B) };
}
/* 静态场的内容摘要（FNV-1a 双流，按 NestBase 实例记忆）：静态场只随 mesoKey 变，逐块哈希它的裁剪是白花主线程 */
const sigMemo = new WeakMap<NestBase, string>();
function baseSig(B: NestBase): string {
  const hit = sigMemo.get(B);
  if (hit) return hit;
  let a = 0x811c9dc5 | 0, b = 0x6c62272e | 0;
  for (const f of [B.X, B.Y, B.fU, B.fK, B.fP, B.fB]) {
    const u = new Uint32Array(f.buffer, f.byteOffset, f.length);
    let la = Math.imul(a ^ u.length, 16777619), lb = Math.imul(b ^ u.length, 0x85ebca6b);
    for (let i = 0; i < u.length; i++) { const x = u[i]; la = Math.imul(la ^ (x & 0xffff), 16777619); la = Math.imul(la ^ (x >>> 16), 16777619); lb = Math.imul(lb ^ (x >>> 16), 0x85ebca6b); lb = Math.imul(lb ^ (x & 0xffff), 0x85ebca6b); }
    a = la; b = lb;
  }
  const s = `${B.cols}x${B.rows}:${B.seed}:${B.kmd}:${B.sphere ? 1 : 0}:${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
  sigMemo.set(B, s);
  return s;
}
/** 进 erodeKey 的数据：标量与常数一段、静态场摘要一段，其余数组逐个（基底、水面等随 ErodeInput 另进键） */
export function nestKeyParts(ne: NestInput): (Uint32Array | Uint8Array)[] {
  const head = new Float64Array([NEST_VER, NEST_MARGIN, NEST_REACH, NEST_PAD, NEST_SKEL_CELLS, SK_R, NEST_JIT, NEST_KJIT, NEST_ITERS, HILL_KM2, HILL_PASSES, HILL_K, LOW_PASSES, NEST_AMP_REF,
    SEED_K, SEED_H0, SEED_JIT, ne.wx, ne.wy, ne.wcols, ne.wrows, ne.x0, ne.y0, ne.gcols, ne.sx, ne.lon0, ne.lat0, ne.step, ne.seed, ne.kmd, ne.sphere ? 1 : 0, ne.du ? 1 : 0, ne.kw ? 1 : 0]);
  const v = (a: Float32Array): Uint32Array => new Uint32Array(a.buffer, a.byteOffset, a.length);
  return [new Uint32Array(head.buffer), Uint32Array.from(ne.bsig, ch => ch.charCodeAt(0)), v(ne.h), ne.sk, ...(ne.du ? [v(ne.du)] : []), ...(ne.kw ? [v(ne.kw)] : [])];
}

const sstep = (x: number): number => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };
/** 格心对齐的双线性（同 core/elev.elevBilinear）：fx / fy 以格为单位、0 是第一格的格心，出界钳边 */
function bil(f: ArrayLike<number>, cols: number, rows: number, fx: number, fy: number): number {
  const c0 = Math.max(0, Math.min(cols - 1, Math.floor(fx))), r0 = Math.max(0, Math.min(rows - 1, Math.floor(fy)));
  const c1 = Math.min(cols - 1, c0 + 1), r1 = Math.min(rows - 1, r0 + 1);
  const tx = Math.max(0, Math.min(1, fx - c0)), ty = Math.max(0, Math.min(1, fy - r0));
  const a = f[r0 * cols + c0], b = f[r0 * cols + c1], c = f[r1 * cols + c0], d = f[r1 * cols + c1];
  const top = a + (b - a) * tx, bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}
/** 收尾正变换的软上限（kw＝画抬升的软边权重，1 让开、0 照压，同 gen2 收尾） */
function capOf(v: number, kw: number): number {
  if (v <= PEAK_KNEE_M || kw >= 1) return v;
  const sc = PEAK_KNEE_M + (v - PEAK_KNEE_M) / (1 + (v - PEAK_KNEE_M) / PEAK_SOFT_M);
  return kw > 0 ? sc + kw * (v - sc) : sc;
}
/** 三趟 3 点方框（行再列，边缘钳制）：每格只读左中右三个数、次序固定——裁剪里离边四格以外的值与全图那份逐位同 */
function blur3(f: Float64Array, cols: number, rows: number): void {
  const t = new Float64Array(f.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const o = r * cols; t[o + c] = (f[o + (c > 0 ? c - 1 : c)] + f[o + c] + f[o + (c < cols - 1 ? c + 1 : c)]) / 3; }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const i = r * cols + c; f[i] = (t[(r > 0 ? r - 1 : r) * cols + c] + t[i] + t[(r < rows - 1 ? r + 1 : r) * cols + c]) / 3; }
  }
}
/** 半径 R 的方框（行再列、边缘截断）passes 遍，就地改：只取 m 为 1 的格的平均，m 为 0 的格原样 */
function boxLow(d: Float64Array, FC: number, FR: number, R: number, passes: number, m: Uint8Array): void {
  const t = new Float64Array(d.length), ps = new Float64Array(Math.max(FC, FR) + 1), pn = new Float64Array(Math.max(FC, FR) + 1);
  const run = (src: Float64Array, dst: Float64Array, len: number, stride: number, count: number, cstride: number): void => {
    for (let k = 0; k < count; k++) {
      const o = k * cstride;
      for (let j = 0; j < len; j++) { const i = o + j * stride; ps[j + 1] = ps[j] + m[i] * src[i]; pn[j + 1] = pn[j] + m[i]; }
      for (let j = 0; j < len; j++) {
        const i = o + j * stride; if (!m[i]) { dst[i] = src[i]; continue; }
        const lo = j - R < 0 ? 0 : j - R, hi = j + R > len - 1 ? len - 1 : j + R;
        dst[i] = (ps[hi + 1] - ps[lo]) / (pn[hi + 1] - pn[lo]);
      }
    }
  };
  for (let p = 0; p < passes; p++) { run(d, t, FC, 1, FR, FC); run(t, d, FR, FC, FC, 1); }
}

/** 抖动四边形网：节点 i 在格内的偏移 jx / jy（按全图细格号取）、四邻轴向边 + 每个四边形较短的那条对角线；边长取图上点的三维弦长 */
export interface NestGraph extends SteadyGraph { jx: Float64Array; jy: Float64Array }
function nestGraph(FC: number, FR: number, gc0: number, gr0: number, FCg: number, fs: number, ne: NestInput, area: Float64Array): NestGraph {
  const n = FC * FR, jx = new Float64Array(n), jy = new Float64Array(n), sj = ne.seed + SEED_JIT;
  for (let r = 0; r < FR; r++) for (let c = 0; c < FC; c++) {
    const i = r * FC + c, gi = (gr0 + r) * FCg + gc0 + c;
    jx[i] = NEST_JIT * (cellRand(2 * gi, sj) - 0.5); jy[i] = NEST_JIT * (cellRand(2 * gi + 1, sj) - 0.5);
  }
  /* 四边形 (c, r)–(c + 1, r + 1)：diag 1＝连 (c + 1, r)–(c, r + 1)，0＝连 (c, r)–(c + 1, r + 1)；长短按格内偏移比，与窗口原点无关 */
  const diag = new Uint8Array(n);
  for (let r = 0; r < FR - 1; r++) for (let c = 0; c < FC - 1; c++) {
    const a = r * FC + c, b = a + 1, d = a + FC, e = d + 1;
    const ex = 1 + jx[e] - jx[a], ey = 1 + jy[e] - jy[a], dx = -1 + jx[d] - jx[b], dy = 1 + jy[d] - jy[b];
    diag[a] = dx * dx + dy * dy < ex * ex + ey * ey ? 1 : 0;
  }
  const PX = new Float64Array(n), PY = new Float64Array(n), PZ = new Float64Array(n), geo = { sphere: ne.sphere, kmd: ne.kmd };
  for (let r = 0; r < FR; r++) for (let c = 0; c < FC; c++) {
    const i = r * FC + c, Q = pointOf(geo, ne.lon0 + (gc0 + c + 0.5 + jx[i]) * fs, ne.lat0 + (gr0 + r + 0.5 + jy[i]) * fs);
    PX[i] = Q.x; PY[i] = Q.y; PZ[i] = Q.z;
  }
  /* 邻点按号升序：左下、下、右下、左、右、左上、上、右上（邻接对称，steady 的 lowestTree 要求） */
  const nbOff = new Int32Array(n + 1), tmp = new Int32Array(8 * n);
  let m = 0;
  for (let r = 0; r < FR; r++) for (let c = 0; c < FC; c++) {
    const i = r * FC + c;
    if (r > 0) {
      if (c > 0 && !diag[i - FC - 1]) tmp[m++] = i - FC - 1;
      tmp[m++] = i - FC;
      if (c + 1 < FC && diag[i - FC]) tmp[m++] = i - FC + 1;
    }
    if (c > 0) tmp[m++] = i - 1;
    if (c + 1 < FC) tmp[m++] = i + 1;
    if (r + 1 < FR) {
      if (c > 0 && diag[i - 1]) tmp[m++] = i + FC - 1;
      tmp[m++] = i + FC;
      if (c + 1 < FC && !diag[i]) tmp[m++] = i + FC + 1;
    }
    nbOff[i + 1] = m;
  }
  const nb = tmp.slice(0, m), len = new Float64Array(m);
  for (let i = 0; i < n; i++) for (let e = nbOff[i]; e < nbOff[i + 1]; e++) {
    const j = nb[e], x = PX[i] - PX[j], y = PY[i] - PY[j], z = PZ[i] - PZ[j]; len[e] = Math.sqrt(x * x + y * y + z * z);
  }
  return { nbOff, nb, len, area, jx, jy };
}

/** 节点值挪回格心：节点在格内抖开了，值却按格存——坡上每个节点差「坡度 × 抖距」，晕渲成满坡麻点。按邻点最小二乘拟平面、沿它外推到格心；出口不动 */
export function resample(G: { nbOff: Int32Array; nb: Int32Array; jx: Float64Array; jy: Float64Array }, h: Float64Array, out: Uint8Array, FC: number): Float64Array {
  const { nbOff, nb, jx, jy } = G, o = Float64Array.from(h);
  for (let i = 0; i < h.length; i++) {
    if (out[i]) continue;
    const ci = i % FC, ri = (i - ci) / FC;
    let sxx = 0, sxy = 0, syy = 0, sxh = 0, syh = 0;
    for (let e = nbOff[i]; e < nbOff[i + 1]; e++) {
      const j = nb[e], cj = j % FC, dx = (cj - ci) + (jx[j] - jx[i]), dy = ((j - cj) / FC - ri) + (jy[j] - jy[i]), dh = h[j] - h[i];
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy; sxh += dx * dh; syh += dy * dh;
    }
    const det = sxx * syy - sxy * sxy; if (!(det > 1e-12)) continue;
    const gx = (syy * sxh - sxy * syh) / det, gy = (sxx * syh - sxy * sxh) / det;
    o[i] = h[i] - gx * jx[i] - gy * jy[i];
  }
  return o;
}

/** 解一窗要的细格量：父格号 par（单的裁剪里）、细格水 wat、出口 out 与出口高程 hOut（米）、窗口原点（全图细格）与细格边 */
export interface NestFine { FC: number; FR: number; gc0: number; gr0: number; fs: number; par: Int32Array; wat: Uint8Array; out: Uint8Array; hOut: Float64Array }

/**
 * 一窗的嵌套解：inp 是 core/tiles.tileInput 带 nest 的块单（裁剪上的基底、水与水面、盆地掩码、高程涂改，外加外层裁剪）。
 * @returns 窗口（nest.wx / wy / wcols / wrows）的细格场，抽象单位、同 erodeField 的产出
 */
export function nestedField(inp: ErodeInput): ElevField {
  const ne = inp.nest!, { F, G, sol } = nestSolve(inp), lonMin = ne.lon0 + ne.wx * ne.step, latMin = ne.lat0 + ne.wy * ne.step;
  return { data: nestFinish(inp, G, sol.h, sol.A, F), cols: F.FC, rows: F.FR, step: F.fs, eroded: true,
    bb: { lonMin, latMin, lonMax: lonMin + ne.wcols * ne.step, latMax: latMin + ne.wrows * ne.step } };
}
/**
 * 收尾之前的那一步：出口＝细格水（水陆交界一圈按基底与水面的等值线定，高程取水面）、窗口外圈（取磨平的外层解）与骨架（高程沿外层解线性插），
 * 在抖动四边形网上固定 NEST_ITERS 轮。G 带节点的格内偏移，sol 同 steady 的产出（米）
 */
export function nestSolve(inp: ErodeInput): { F: NestFine; G: NestGraph; sol: SteadyResult } {
  const ne = inp.nest!, { cols, rows, elev0, water, wsurf, unitM: um } = inp, sx = ne.sx;
  const FC = ne.wcols * sx, FR = ne.wrows * sx, n = FC * FR, fs = ne.step / sx, gc0 = ne.wx * sx, gr0 = ne.wy * sx, FCg = ne.gcols * sx;
  /* 水陆交界一圈的父格（自己或八邻有水有陆）：细格水陆按基底与水面的等值线定 */
  const shore = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const w0 = water[r * cols + c];
    for (let dr = -1; dr <= 1 && !shore[r * cols + c]; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && water[rr * cols + cc] !== w0) { shore[r * cols + c] = 1; break; }
    }
  }
  const Uc = new Float64Array(cols * rows);   // 求解抬升（同中尺度：宏观抬升有地板，再叠画抬升）
  for (let k = 0; k < Uc.length; k++) Uc[k] = MESO_KAPPA_M * ((ne.fU[k] > MESO_U_MIN ? ne.fU[k] : MESO_U_MIN) + (ne.du ? ne.du[k] : 0));
  const hB = Float64Array.from(ne.h);
  blur3(hB, cols, rows);   // 初值：外层解磨平一个父格
  const U = new Float64Array(n), K = new Float64Array(n), out = new Uint8Array(n), hOut = new Float64Array(n), h0 = new Float64Array(n), area = new Float64Array(n), wat = new Uint8Array(n), par = new Int32Array(n);
  const kmF = fs * ne.kmd, sd = ne.seed;
  for (let r = 0; r < FR; r++) {
    const gr = gr0 + r, lat = ne.lat0 + (gr + 0.5) * fs, cy = (gr + 0.5) / sx - 0.5 - ne.y0, a = kmF * (ne.sphere ? Math.max(0.05, cosD(lat)) : 1) * kmF;
    for (let c = 0; c < FC; c++) {
      const i = r * FC + c, gc = gc0 + c, gi = gr * FCg + gc, cx = (gc + 0.5) / sx - 0.5 - ne.x0, k = (((gr / sx) | 0) - ne.y0) * cols + ((gc / sx) | 0) - ne.x0;
      par[i] = k; area[i] = a;
      wat[i] = shore[k] ? (bil(elev0, cols, rows, cx, cy) < wsurf[k] - WATER_EPS ? 1 : 0) : water[k];
      U[i] = bil(Uc, cols, rows, cx, cy);
      K[i] = bil(ne.K, cols, rows, cx, cy) * (1 - NEST_KJIT / 2 + NEST_KJIT * cellRand(gi, sd + SEED_K));
      const hb = bil(hB, cols, rows, cx, cy);
      if (wat[i]) { out[i] = 1; hOut[i] = wsurf[k] * um; h0[i] = hOut[i]; }
      else if (r === 0 || c === 0 || r === FR - 1 || c === FC - 1) { out[i] = 1; hOut[i] = hb; h0[i] = hb; }
      else h0[i] = hb + 1e-3 * cellRand(gi, sd + SEED_H0);
    }
  }
  /* 骨架：窗口外扩 NEST_REACH 内的骨架边（节点到受水者）画进细格，高程沿外层解线性插；同一格取各段最低。坐标按全图细格算，与窗口原点无关 */
  const y1 = Math.min(ne.y0 + rows, ne.wy + ne.wrows + NEST_REACH), x1 = Math.min(ne.x0 + cols, ne.wx + ne.wcols + NEST_REACH);
  for (let y = Math.max(ne.y0, ne.wy - NEST_REACH); y < y1; y++) for (let x = Math.max(ne.x0, ne.wx - NEST_REACH); x < x1; x++) {
    const kc = (y - ne.y0) * cols + x - ne.x0, code = ne.sk[kc]; if (!code) continue;
    const jxp = x + (code - 1) % SK_W - SK_R, jyp = y + Math.floor((code - 1) / SK_W) - SK_R;
    if (jxp < ne.x0 || jyp < ne.y0 || jxp >= ne.x0 + cols || jyp >= ne.y0 + rows) continue;
    const jc = (jyp - ne.y0) * cols + jxp - ne.x0, ha = ne.h[kc], hz = ne.h[jc];
    const xa = (ne.X[kc] + 0.5) * sx - 0.5, ya = (ne.Y[kc] + 0.5) * sx - 0.5, xb = (ne.X[jc] + 0.5) * sx - 0.5, yb = (ne.Y[jc] + 0.5) * sx - 0.5;
    const ax = xb > xa ? xb - xa : xa - xb, ay = yb > ya ? yb - ya : ya - yb, L = 1 - Math.floor(-2 * (ax > ay ? ax : ay));
    for (let t = 0; t <= L; t++) {
      const s = t / L, c = Math.floor(xa + (xb - xa) * s + 0.5) - gc0, r = Math.floor(ya + (yb - ya) * s + 0.5) - gr0;
      if (c < 1 || r < 1 || c >= FC - 1 || r >= FR - 1) continue;
      const i = r * FC + c; if (wat[i]) continue;
      const hv = ha + (hz - ha) * s;
      if (!out[i] || hv < hOut[i]) { out[i] = 1; hOut[i] = hv; h0[i] = hv; }
    }
  }
  const G = nestGraph(FC, FR, gc0, gr0, FCg, fs, ne, area);
  const sol = steady(G, { U, K, acrit: MESO_ACRIT_KM2, out, hOut, head: MESO_HEAD }, h0, { maxIt: NEST_ITERS, tol: 0, canon: true });
  return { F: { FC, FR, gc0, gr0, fs, par, wat, out, hOut }, G, sol };
}

/**
 * 收尾的目标面（细格，抽象单位）：块的大形按它校正、平原与盆地按权重回到它。现取父基底的双线性，陆格在细格上磨平半个父格——
 * 双线性在格边折角，没有细节盖着的地方（平原、盆底）晕渲成方格。只取陆格：水格是床面，混进来就把岸边一圈拉低成坑；水格原样（床面）
 */
function nestTarget(inp: ErodeInput, F: NestFine, land: Uint8Array): Float64Array {
  const ne = inp.nest!, { cols, rows, elev0 } = inp, sx = ne.sx, { FC, FR, gc0, gr0 } = F, t = new Float64Array(FC * FR);
  for (let r = 0; r < FR; r++) {
    const cy = (gr0 + r + 0.5) / sx - 0.5 - ne.y0;
    for (let c = 0; c < FC; c++) t[r * FC + c] = bil(elev0, cols, rows, (gc0 + c + 0.5) / sx - 0.5 - ne.x0, cy);
  }
  boxLow(t, FC, FR, Math.max(1, Math.floor(sx / 2)), 2, land);
  return t;
}

/** 收尾（同中尺度收尾的细格版）：挪回格心 → 坡面扩散 → 加高原、软上限、扣盆地 → 低通校正到目标面（nestTarget）→ 平原渐变与起伏权重 → 水陆钳制 */
function nestFinish(inp: ErodeInput, G: NestGraph, hs: Float64Array, A: Float64Array, F: NestFine): Float32Array {
  const ne = inp.nest!, { cols, rows, wsurf, hovGrid, basin, unitM: um } = inp, sx = ne.sx, { FC, FR, gc0, gr0, par, wat, out } = F, n = FC * FR;
  const h = resample(G, hs, out, FC);
  const h2 = new Float64Array(n);
  for (let pass = 0; pass < HILL_PASSES; pass++) {
    h2.set(h);
    for (let r = 1; r < FR - 1; r++) for (let c = 1; c < FC - 1; c++) {
      const i = r * FC + c; if (out[i] || A[i] >= HILL_KM2) continue;
      h2[i] = h[i] + HILL_K * ((h[i - 1] + h[i + 1] + h[i - FC] + h[i + FC]) * 0.25 - h[i]);
    }
    h.set(h2);
  }
  const fine = new Float64Array(n), w = new Float64Array(n), hov = new Float64Array(n);
  let noHov = true;
  for (let k = 0; k < hovGrid.length && noHov; k++) if (hovGrid[k] !== 0) noHov = false;
  const bm = basin ? Float32Array.from(basin, v => v & 1) : null;
  for (let r = 0; r < FR; r++) {
    const cy = (gr0 + r + 0.5) / sx - 0.5 - ne.y0;
    for (let c = 0; c < FC; c++) {
      const i = r * FC + c, cx = (gc0 + c + 0.5) / sx - 0.5 - ne.x0;
      const kwv = ne.kw ? bil(ne.kw, cols, rows, cx, cy) : 0;
      let v = capOf(h[i] + bil(ne.P, cols, rows, cx, cy), kwv);
      const b = bil(ne.B, cols, rows, cx, cy);
      v -= b < BOWL_MAX * v ? b : BOWL_MAX * v;
      fine[i] = (v > 1 ? v : 1) / um;
      let wu = sstep((bil(ne.fU, cols, rows, cx, cy) + (ne.du ? bil(ne.du, cols, rows, cx, cy) : 0) - MESO_PLAIN_U0) / (MESO_PLAIN_U1 - MESO_PLAIN_U0));
      if (kwv > wu) wu = kwv;
      if (bm) wu *= 1 - bil(bm, cols, rows, cx, cy);   // 画的盆地：盆底与盆沿照目标面
      w[i] = wu;
      if (!noHov) hov[i] = bil(hovGrid, cols, rows, cx, cy);
    }
  }
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) land[i] = wat[i] ? 0 : 1;
  const T = nestTarget(inp, F, land);
  /* 低通校正：减去（细解 − 目标面）在一个父格半径上的低通（只取陆格，同 nestTarget） */
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = fine[i] - T[i];
  boxLow(d, FC, FR, sx, LOW_PASSES, land);
  const amp = inp.amp / NEST_AMP_REF, o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = par[i];
    if (wat[i]) { const cap = wsurf[k] + SHORE_E; o[i] = T[i] < cap ? T[i] : cap; continue; }
    const dd = fine[i] - d[i] - T[i], wi = w[i];
    const v = T[i] + hov[i] + amp * (dd >= 0 ? wi : wi * wi * wi) * dd, fl = wsurf[k] - WATER_EPS + 1e-4;
    o[i] = v > fl ? v : fl;
  }
  return o;
}
