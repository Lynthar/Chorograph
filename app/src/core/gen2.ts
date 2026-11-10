/* 程序化生成第二版（meta.terrain==="auto" 且 genVer===2）：宏观格上 骨架 → 抬升 → 稳态河流地形 → 高原与盆地 → 水汽 → 湖，
   再逐格派生地类、生态与连续基底。v1（core/terrain）一字不动，按 genVer 分流。
   ⚠ 跨引擎逐位确定：只用 + − × ÷ √、floor、整数哈希与字面常数；Math.sin/cos/exp/pow/log/hypot 不许进——流向树会把 1 ULP 放大成整片流域翻转。 */
import { CLIMATE_ORDER, FP_CORE, FP_KW, LANDFORM_ORDER, MZ_MAX, RIV_WIDTH, snowLatM } from "./constants.ts";
import { DEFAULT_BBOX, type BBox, type Climate, type Landform, type Meta } from "./types.ts";
import type { FieldGeom } from "./elev.ts";
import { buildMesh, cellRand, meshLocate, type Gen2Mesh } from "./gen2mesh.ts";
import { BAND_MARGIN_KM, Heap, bandOf, pushRim, steady, treeArea, upliftSolve, type SteadyGraph, type SteadyInput, type SteadyResult, type UpliftRegion } from "./steady.ts";

export type Gen2Style = "mono" | "multi" | "isles";
export const isGen2 = (m: Meta | undefined): boolean => !!m && m.terrain === "auto" && m.genVer === 2;

/** 各档「陆地占比」[最少, 中值, 最多]：中值是该档的典型构图（构图测试只锁中值）；两端不保构图——多块调高会连成一片，单块调低时岛弧与热点岛占的比重变大 */
export const LAND_RANGE: Record<Gen2Style, [number, number, number]> = { mono: [0.10, 0.335, 0.70], multi: [0.10, 0.335, 0.40], isles: [0.05, 0.19, 0.35] };
/** 「陆地占比」滑杆位置 t（0..1）折成陆地占比：左右两半各自线性，滑杆中点恰是中值 */
export function landFrac(style: Gen2Style, t: number): number {
  const [lo, mid, hi] = LAND_RANGE[style];
  return t <= 0.5 ? lo + (mid - lo) * 2 * t : mid + (hi - mid) * (2 * t - 1);
}
/** 宏观格封顶格数：生成在开图链上同步跑，稳态求解随格数超线性增长（128² 约 30–50 ms、256² 约 0.2–0.3 s） */
export const MACRO_CAP = 16384;
/** 随机种子的值域：v2 没有 v1 那样的相位周期，取用户好认的六位数以内 */
export const GEN2_SEED_MAX = 999999;

export interface Gen2Params { bb: BBox; sphere: boolean; kmd: number; seed: number; style: Gen2Style; land: number; mtn: number; isl: number; unitM: number }
export function gen2Params(m: Meta): Gen2Params {
  const sphere = m.worldModel !== "flat";
  const kmd = sphere ? 2 * Math.PI * (+(m.planetRadiusKm ?? 0) || 10000) / 360 : (+(m.kmPerDeg ?? 0) || 2 * Math.PI * (+(m.planetRadiusKm ?? 0) || 10000) / 360);
  const style: Gen2Style = m.genStyle === "multi" || m.genStyle === "isles" ? m.genStyle : "mono";
  const cl = (v: unknown, d: number) => { const x = +(v as number); return isFinite(x) ? Math.max(0, Math.min(1, x)) : d; };
  return { bb: m.bbox || DEFAULT_BBOX, sphere, kmd, seed: ((m.genSeed as number) | 0) || 1, style, land: cl(m.genLand, 0.5), mtn: cl(m.genMtn, 0.5), isl: cl(m.genIsl, 0.5), unitM: +(m.elevUnitM as number) || 2000 };
}

/* —— 确定性数学 —— */
const PI = Math.PI, TAU = 2 * Math.PI, D2R = Math.PI / 180;
/** sin（弧度），Taylor 到 x¹⁵、先折到 [−π/2, π/2]：替代 Math.sin（各引擎可差 1 ULP） */
function sinR(x: number): number {
  x -= TAU * Math.floor((x + PI) / TAU);
  if (x > PI / 2) x = PI - x; else if (x < -PI / 2) x = -PI - x;
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800 - x2 / 1307674368000)))))));
}
const sinD = (d: number): number => sinR(d * D2R);
export const cosD = (d: number): number => sinR((d + 90) * D2R);
const clamp01 = (x: number): number => x < 0 ? 0 : x > 1 ? 1 : x;
const sstep = (x: number): number => { const t = clamp01(x); return t * t * (3 - 2 * t); };

/** mulberry32：种子 → [0,1) 序列 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 三维梯度噪声：立方体 12 棱梯度（整数表）、坐标先过一个有理正交阵——平面图切片也不落在格面上（格面切片＝轴向梯度＝晕渲直缝）。
   ⚠ 本噪声的输出被 v2 的确定性测试钉着：改梯度集、哈希或旋转＝每张 v2 图的地形与寻路全变。 */
const G12 = [1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 1, 1, 0, -1, 1, 0, 0, -1, 1, 0, -1, -1];
function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 1440662683) + Math.imul(seed, 974634541)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) & 15) * 3;
}
function noise3(x0: number, y0: number, z0: number, seed: number): number {
  const x = (2 * x0 - y0 + 2 * z0) / 3, y = (2 * x0 + 2 * y0 - z0) / 3, z = (2 * y0 + 2 * z0 - x0) / 3;
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const d = (cx: number, cy: number, cz: number, dx: number, dy: number, dz: number): number => {
    const g = hash3(cx, cy, cz, seed);
    return G12[g] * dx + G12[g + 1] * dy + G12[g + 2] * dz;
  };
  const x00 = d(ix, iy, iz, fx, fy, fz), x10 = d(ix, iy + 1, iz, fx, fy - 1, fz);
  const x01 = d(ix, iy, iz + 1, fx, fy, fz - 1), x11 = d(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1);
  const a = x00 + (d(ix + 1, iy, iz, fx - 1, fy, fz) - x00) * u, b = x10 + (d(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz) - x10) * u;
  const c = x01 + (d(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1) - x01) * u, e = x11 + (d(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1) - x11) * u;
  const p = a + (b - a) * v, q = c + (e - c) * v;
  return (p + (q - p) * w) * 1.31;
}
/** 分形噪声 ≈[-1,1]：点（km）÷ 首波长，逐倍频半幅 */
function fbm3(px: number, py: number, pz: number, lamKm: number, oct: number, seed: number): number {
  let s = 0, a = 1, n = 0, f = 1 / lamKm;
  for (let k = 0; k < oct; k++) { s += a * noise3(px * f, py * f, pz * f + 0.37, seed + k * 131); n += a; a *= 0.5; f *= 2; }
  return s / n;
}
/** 海岸噪声逐倍频幅度比：0.6 ≈ Hurst 0.75，岸线分维约 1.25；0.5（fbm3）的岸线分维趋于 1＝光滑弧 */
const COAST_G = 0.66, COAST_OCT = 9;
/** 海岸带（km，按图幅缩放）：陆侧爬升距离 · 海侧下降距离 · 噪声强的带宽；CO_AMP 是噪声幅度 */
const CO_LIN = 450, CO_LOUT = 300, CO_ZONE = 700, CO_AMP = 6, CO_WARP = 0.35, CO_HW = 300, CO_LAM = 1600, CO_HWK = 0.2;
/** 近岸岛带（km，按图幅缩放）：离岸中心距 · 半宽 · 噪声波长；CO_ISL 是「近岸岛多少」拉满时的幅度、ISL_T 起岛门槛 */
const ISL_D = 160, ISL_W = 170, ISL_LAM = 220, CO_ISL = 20, ISL_T = 0.06, ISL_AMP = 0.5;
const COAST_NORM = (() => { let s = 0, a = 1; for (let k = 0; k < COAST_OCT; k++) { s += a; a *= COAST_G; } return s; })();
/** 海岸噪声的第 k0..k1−1 个倍频（波长 λ0/2^k、幅度 COAST_G^k，按全部倍频的幅度和归一）：宏观格取粗的、网格分辨率接着取细的，合起来是同一个场。
    mid＝到所在陆地或海面中轴的距离（km）：波长比它长得多的倍频收小——粗的能把窄海峡填平、把细半岛切断，细的只让岸线变碎 */
function coastOct(px: number, py: number, pz: number, lam0: number, k0: number, k1: number, seed: number, mid: number): number {
  let s = 0, a = 1, f = 1 / lam0;
  for (let k = 0; k < k1; k++) { if (k >= k0) s += a * (0.12 + 0.88 * sstep(mid * f / CO_HWK)) * noise3(px * f, py * f, pz * f + 0.37, seed + k * 131); a *= COAST_G; f *= 2; }
  return s / COAST_NORM;
}

/* —— 图上点（km）：球面＝单位球 × 半径的三维点，平面＝经纬 × 每度公里 —— */
interface Pt { x: number; y: number; z: number }
export function pointOf(p: Pick<Gen2Params, "sphere" | "kmd">, lon: number, lat: number): Pt {
  if (!p.sphere) return { x: lon * p.kmd, y: lat * p.kmd, z: 0 };
  const R = p.kmd * 180 / PI, cp = cosD(lat);
  return { x: R * cp * cosD(lon), y: R * cp * sinD(lon), z: R * sinD(lat) };
}
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a: Pt): Pt => { const l = Math.sqrt(dot(a, a)) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
const cross = (a: Pt, b: Pt): Pt => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

/* —— 抬升带（古老造山带）：图上折线 + 半宽 + 强度 —— */
interface Band { pts: Pt[]; w: number; s: number }
function segDist2(P: Pt, A: Pt, B: Pt): number {
  const ab = { x: B.x - A.x, y: B.y - A.y, z: B.z - A.z }, ap = { x: P.x - A.x, y: P.y - A.y, z: P.z - A.z };
  const L = dot(ab, ab), t = L > 0 ? clamp01(dot(ap, ab) / L) : 0;
  const dx = ap.x - t * ab.x, dy = ap.y - t * ab.y, dz = ap.z - t * ab.z;
  return dx * dx + dy * dy + dz * dz;
}
function bandVal(B: Band, P: Pt): number {
  let m = Infinity;
  for (let k = 1; k < B.pts.length; k++) { const d = segDist2(P, B.pts[k - 1], B.pts[k]); if (d < m) m = d; }
  const q = m / (B.w * B.w);
  return q >= 1 ? 0 : B.s * (1 - q) * (1 - q);
}
/** 圆顶核：|x|<1 内 (1−x²)²，外 0 */
const bump = (x: number): number => { const q = x * x; return q >= 1 ? 0 : (1 - q) * (1 - q); };

/* —— 板块骨架：扭曲加权 Voronoi 分板块 → 陆壳 / 洋壳与运动 → 按相邻板块的相对运动定边界类型 → 板块内距离场给海岸与抬升 —— */
interface Plate { S: Pt; N: Pt; r: number; edge: number; area: number; L: number; cont: boolean; t: Pt; spin: number; age: number }
/** 边界类型：汇聚 / 离散 / 转换 */
type Bound = "conv" | "div" | "trans";
interface Pair { type: Bound; s: number; u: number }
interface Scene { c: Float64Array; U: Float64Array; fold: Float64Array; rift: Uint8Array; sdk: Float64Array; act: Float64Array; hw: Float64Array; mid: Float64Array; pen: Float64Array; plateaus: { C: Pt; ax: Pt; r: number; h: number }[]; basins: { C: Pt; r: number; d: number }[]; warpKm: number; wind: [number, number] }
/** 宏观格几何：节点 i 落在格 (i % cols, ⌊i / cols⌋) 里、确切位置是三角网的 (mesh.X[i], mesh.Y[i])，P 是它的图上点；
    dx / dy 是名义格距（节点面积与逐列扫掠用），len 是三角网邻接边的实际长度（km，与 mesh.nb 同序） */
interface MacroGeom { cols: number; rows: number; dlon: number; dlat: number; dx: Float64Array; dy: number; P: Pt[]; mesh: Gen2Mesh; len: Float64Array }
/* 构图（板块间距、海岸后退、热点链长、图边留海带）按图幅面积相对缺省图幅缩放 ks 倍，物理尺度（山带宽、岛弧距、火山间距、求解）按公里：
   三档风格与「陆地占比」说的是整张图的构图，按公里定构图时小图幅山落图外、半球图幅碎成上千岛 */
const DEFAULT_AREA_KM2 = 6601 * 5585;
const PLATE_N: Record<Gen2Style, [number, number]> = { mono: [3, 5], multi: [5, 9], isles: [6, 10] };
/** 陆盖洋汇聚里走弧后扩张（岛弧 + 边缘海）的比例，其余是贴岸山脉 */
const BACKARC_P = 0.5;

/** 带遮罩的距离场（只在同一板块内、沿三角网邻接传播，边长按实际距离，多源 Dijkstra）：d 入为源的初值（非源 Infinity）、出为 min(初值 + 距离)；pay 随最近源一起传 */
function distField(d: Float64Array, pay: Float64Array, lab: Int32Array, G: MacroGeom): void {
  const { nbOff, nb } = G.mesh, len = G.len, n = d.length, heap = new Heap(n + nb.length), done = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (d[i] < Infinity) heap.push(d[i], i);
  while (heap.n) {
    const i = heap.pop();
    if (done[i]) continue;
    done[i] = 1;
    for (let e = nbOff[i]; e < nbOff[i + 1]; e++) {
      const j = nb[e]; if (done[j] || lab[j] !== lab[i]) continue;
      const v = d[i] + len[e]; if (v < d[j]) { d[j] = v; pay[j] = pay[i]; heap.push(v, j); }
    }
  }
}

function buildScene(p: Gen2Params, ks: number, G: MacroGeom): Scene {
  /* 随机数按用途分流：每组决定各用一条子序列（逐板块的再分），滑杆改了某组抽几次不会让别组错位——共用一条序列时挪一格滑杆整张图重洗 */
  const styleK = p.style === "mono" ? 1 : p.style === "multi" ? 2 : 3, sd = p.seed * 31;
  const rs = (tag: number, k = 0): (() => number) => rng(Math.imul(p.seed, 7919) + styleK + Math.imul(tag + 1, 0x632BE5AB) + Math.imul(k + 1, 0x85EBCA77));
  const R = rs(0);
  const { bb } = p, lonS = bb.lonMax - bb.lonMin, latS = bb.latMax - bb.latMin, { cols, rows, dx, dy, P } = G, n = cols * rows;
  const at = (u: number, v: number): Pt => pointOf(p, bb.lonMin + u * lonS, bb.latMin + v * latS);
  const [Wk, Hk] = extentKm(p);
  const cell = Math.sqrt(Wk * Hk / n), mtnK = 0.65 + 0.7 * p.mtn;
  const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const tang = (v: Pt, N: Pt): Pt => { const k = dot(v, N); return { x: v.x - N.x * k, y: v.y - N.y * k, z: v.z - N.z * k }; };
  const nrmAt = (Q: Pt): Pt => p.sphere ? norm(Q) : { x: 0, y: 0, z: 1 };
  const onSurf = (Q: Pt): Pt => { if (!p.sphere) return { x: Q.x, y: Q.y, z: 0 }; const Rk = p.kmd * 180 / PI, u = norm(Q); return { x: u.x * Rk, y: u.y * Rk, z: u.z * Rk }; };

  /* 1. 板块种子（相互留距）与扭曲加权 Voronoi */
  const [n0, n1] = PLATE_N[p.style], N = n0 + Math.floor(R() * (n1 - n0 + 1)), sp = Math.sqrt(Wk * Hk / N);
  const plates: Plate[] = [];
  for (let tries = 0, gap = 0.6 * sp; plates.length < N && tries < 900; tries++) {
    if (tries && tries % 120 === 0) gap *= 0.9;
    const u = 0.04 + 0.92 * R(), v = 0.04 + 0.92 * R(), S = at(u, v);
    if (plates.every(q => { const d = sub(S, q.S); return dot(d, d) > gap * gap; }))
      plates.push({ S, N: nrmAt(S), r: 0.75 + 0.55 * R(), edge: Math.min(u, 1 - u, v, 1 - v), area: 0, L: 1, cont: false, t: { x: 0, y: 0, z: 0 }, spin: 0, age: R() });
  }
  const lab = new Int32Array(n), wa = 0.38 * sp, wl = 0.8 * sp, h2 = 0.12 * sp, l2 = 0.3 * sp;   // 两档扭曲：只有一档时三联点之间的边界仍是直的
  for (let i = 0; i < n; i++) {
    const Pi = P[i];
    const Q = { x: Pi.x + wa * fbm3(Pi.x, Pi.y, Pi.z, wl, 4, sd + 41) + h2 * fbm3(Pi.x, Pi.y, Pi.z, l2, 3, sd + 44),
      y: Pi.y + wa * fbm3(Pi.x, Pi.y, Pi.z, wl, 4, sd + 42) + h2 * fbm3(Pi.x, Pi.y, Pi.z, l2, 3, sd + 45),
      z: Pi.z + (p.sphere ? wa * fbm3(Pi.x, Pi.y, Pi.z, wl, 4, sd + 43) + h2 * fbm3(Pi.x, Pi.y, Pi.z, l2, 3, sd + 46) : 0) };
    let best = 0, bd = Infinity;
    for (let k = 0; k < plates.length; k++) { const d = sub(Q, plates[k].S), v = dot(d, d) / (plates[k].r * plates[k].r); if (v < bd) { bd = v; best = k; } }
    lab[i] = best;
  }
  for (let i = 0; i < n; i++) plates[lab[i]].area += dx[(i / cols) | 0] * dy;
  for (const q of plates) q.L = Math.sqrt(q.area) || 1;
  const total = Wk * Hk;

  /* 2. 相邻关系（4 邻格对） */
  const NP = plates.length, shared = new Float64Array(NP * NP), edges: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    for (const j of [c + 1 < cols ? i + 1 : -1, r + 1 < rows ? i + cols : -1]) {
      if (j < 0 || lab[j] === lab[i]) continue;
      edges.push(i, j); shared[lab[i] * NP + lab[j]]++; shared[lab[j] * NP + lab[i]]++;
    }
  }
  const adj = (a: number, b: number): boolean => shared[a * NP + b] > 0;

  /* 3. 陆壳板块与运动：单块＝居中一块加相邻几块缝合（相向运动）；多块＝一对裂开的 + 一块独立的 + 补足面积；群岛＝两三块小板块成碎陆 */
  const F = landFrac(p.style, p.land);
  /* 陆壳板块按本档陆地占比的上限选、不随滑杆增减：陆地占比只缩放陆核与海平面，同一批大陆整体放大缩小（随滑杆补板块＝补的那一格整张图换样） */
  const target = Math.min(0.85, LAND_RANGE[p.style][2] / (p.style === "isles" ? 0.9 : 0.62)) * total;
  const area = (): number => plates.reduce((a, q) => a + (q.cont ? q.area : 0), 0);
  const inner = (k: number): boolean => plates[k].edge > 0.1;
  const pick = <T>(Rr: () => number, xs: T[]): T => xs[Math.floor(Rr() * xs.length)], R2 = rs(2);
  /* 补陆壳按建板块时排定的次序取（不随机挑）：陆地占比调大时已选的板块不变，只是接着往下补 */
  const RP = rs(1), prio = plates.map(() => RP()), first = (ks: number[]): number => ks.reduce((a, b) => prio[b] < prio[a] ? b : a);
  const forced = new Uint8Array(NP);
  const aim = (k: number, toward: Pt, speed: number): void => { const q = plates[k], d = tang(sub(toward, q.S), q.N), l = Math.sqrt(dot(d, d)) || 1; q.t = { x: d.x / l * speed, y: d.y / l * speed, z: d.z / l * speed }; forced[k] = 1; };
  if (p.style === "mono") {
    let c0 = 0, bc = Infinity;
    for (let k = 0; k < NP; k++) { const e = 0.5 - plates[k].edge; if (e < bc) { bc = e; c0 = k; } }
    plates[c0].cont = true;
    for (let guard = 0; guard < NP && (area() < target || plates.filter(q => q.cont).length < 2); guard++) {
      const cand = plates.map((_, k) => k).filter(k => !plates[k].cont && plates.some((q, j) => q.cont && adj(j, k)) && plates[k].edge > 0.05);
      if (!cand.length || plates.filter(q => q.cont).length >= 4) break;
      plates[first(cand)].cont = true;
    }
    const cs = plates.filter(q => q.cont), C = cs.reduce((a, q) => ({ x: a.x + q.S.x / cs.length, y: a.y + q.S.y / cs.length, z: a.z + q.S.z / cs.length }), { x: 0, y: 0, z: 0 });
    plates.forEach((q, k) => { if (q.cont && cs.length > 1) aim(k, C, 0.6 + 0.6 * rs(3, k)()); });
  } else if (p.style === "multi") {
    const prs: [number, number][] = [];
    for (let a = 0; a < NP; a++) for (let b = a + 1; b < NP; b++) if (adj(a, b) && inner(a) && inner(b)) prs.push([a, b]);
    if (!prs.length) for (let a = 0; a < NP; a++) for (let b = a + 1; b < NP; b++) if (adj(a, b)) prs.push([a, b]);
    if (prs.length) {
      const [a, b] = pick(R2, prs), mid = { x: (plates[a].S.x + plates[b].S.x) / 2, y: (plates[a].S.y + plates[b].S.y) / 2, z: (plates[a].S.z + plates[b].S.z) / 2 };
      plates[a].cont = plates[b].cont = true;
      const away = (k: number): Pt => { const d = sub(plates[k].S, mid); return { x: plates[k].S.x + d.x, y: plates[k].S.y + d.y, z: plates[k].S.z + d.z }; };
      aim(a, away(a), 0.7 + 0.5 * R2()); aim(b, away(b), 0.7 + 0.5 * R2());   // 背向而行＝裂开，两岸同源
      const lone = plates.map((_, k) => k).filter(k => !plates[k].cont && !adj(k, a) && !adj(k, b) && inner(k));
      if (lone.length) plates[pick(R2, lone)].cont = true;   // 独立的一块：四周不挨别的陆壳
    }
    for (let guard = 0; guard < NP && area() < target; guard++) {   // 补面积：先挑不挨现有陆壳的（多块大陆要分得开），再挑挨着的
      const cand = plates.map((_, k) => k).filter(k => !plates[k].cont);
      if (!cand.length) break;
      const apart = cand.filter(k => inner(k) && !plates.some((q, j) => q.cont && adj(j, k))), pref = cand.filter(inner);
      plates[first(apart.length ? apart : pref.length ? pref : cand)].cont = true;
    }
  } else {
    const order = plates.map((_, k) => k).filter(k => plates[k].edge > 0.06).sort((a, b) => plates[a].area - plates[b].area || a - b);
    const want = 2 + Math.floor(R2() * 2);
    for (const k of order) { if (plates.filter(q => q.cont).length >= want) break; if (!plates.some((q, j) => q.cont && adj(j, k))) plates[k].cont = true; }
  }
  plates.forEach((q, k) => {
    const Rk = rs(4, k), rAim = Rk(), rPick = Rk(), rSpd = Rk(), gx = Rk() - 0.5, gy = Rk() - 0.5, gz = Rk() - 0.5, rDrift = Rk();   // 两个分支要用的数一次抽齐，走哪支都不改后面的抽取
    if (!forced[k]) {
      const oc = plates.map((_, j) => j).filter(j => !plates[j].cont && adj(j, k));
      if (q.cont && oc.length && rAim < 0.55 + 0.3 * p.mtn) aim(k, plates[oc[Math.floor(rPick * oc.length)]].S, 0.6 + 0.6 * rSpd);   // 冲向一块洋壳：那一侧成俯冲带
      else { const g = tang({ x: gx, y: gy, z: p.sphere ? gz : 0 }, q.N), l = Math.sqrt(dot(g, g)) || 1, s = q.cont ? 0.5 + 0.7 * rDrift : 0.25 + 0.45 * rDrift; q.t = { x: g.x / l * s, y: g.y / l * s, z: g.z / l * s }; }
    }
    q.spin = (Rk() - 0.5) * 0.6;
  });
  const vel = (k: number, X: Pt): Pt => {
    const q = plates[k], cr = cross(q.N, sub(X, q.S)), w = q.spin / q.L;
    const v = { x: q.t.x + cr.x * w, y: q.t.y + cr.y * w, z: q.t.z + cr.z * w };
    return p.sphere ? tang(v, norm(X)) : v;
  };

  /* 4. 边界类型（按相邻板块对的平均闭合速度）：汇聚 > 0.35，离散 < −0.35，其余转换 */
  const sum = new Float64Array(NP * NP);
  for (let e = 0; e < edges.length; e += 2) {
    const i = edges[e], j = edges[e + 1], a = lab[i], b = lab[j], nv = norm(sub(P[j], P[i])), va = vel(a, P[i]), vb = vel(b, P[i]);
    const cl = (va.x - vb.x) * nv.x + (va.y - vb.y) * nv.y + (va.z - vb.z) * nv.z;
    sum[a * NP + b] += cl; sum[b * NP + a] += cl;
  }
  const pair: (Pair | null)[] = new Array(NP * NP).fill(null), Ru = rs(5);
  for (let a = 0; a < NP; a++) for (let b = a + 1; b < NP; b++) {
    if (!adj(a, b)) continue;
    const m = sum[a * NP + b] / shared[a * NP + b], pr: Pair = { type: m > 0.35 ? "conv" : m < -0.35 ? "div" : "trans", s: clamp01(Math.abs(m) / 1.6), u: Ru() };
    if (p.style === "mono" && pr.type === "div" && plates[a].cont && plates[b].cont) pr.type = "conv";   // 单块大陆：陆壳之间只缝合不裂开
    pair[a * NP + b] = pair[b * NP + a] = pr;
  }

  /* 一块大陆＝碰撞缝合连在一起的陆壳板块组（共用一个陆核，见第 6 步）。多块大陆按碰撞强弱依次并组、组面积不过陆壳一半，超了那一对改作转换——否则常常并成一块独大 */
  const grp = plates.map((_, k) => k), root = (k: number): number => { while (grp[k] !== k) k = grp[k] = grp[grp[k]]; return k; };
  const gArea = plates.map(q => q.cont ? q.area : 0), contA = gArea.reduce((a, b) => a + b, 0), cc: [number, number][] = [];
  for (let a = 0; a < NP; a++) for (let b = a + 1; b < NP; b++) { const pr = pair[a * NP + b]; if (pr && pr.type === "conv" && plates[a].cont && plates[b].cont) cc.push([a, b]); }
  cc.sort((x, y) => pair[y[0] * NP + y[1]]!.s - pair[x[0] * NP + x[1]]!.s || x[0] - y[0] || x[1] - y[1]);
  for (const [a, b] of cc) {
    const ra = root(a), rb = root(b);
    if (ra === rb) continue;
    if (p.style === "multi" && gArea[ra] + gArea[rb] > 0.5 * contA) { pair[a * NP + b]!.type = "trans"; continue; }
    grp[rb] = ra; gArea[ra] += gArea[rb];
  }

  /* 5. 板块内距离场：海岸（起点按边界后退）、海岸山脉、碰撞带、岛弧、裂谷肩、转换带 */
  const F6 = () => new Float64Array(n).fill(Infinity), Z6 = () => new Float64Array(n);
  const dCoast = F6(), kCoast = Z6(), dAnd = F6(), sAnd = Z6(), dCol = F6(), sCol = Z6(), dArc = F6(), sArc = Z6(), dRift = F6(), oRift = Z6(), dTr = F6(), dBA = F6(), sBA = Z6();
  const src = (d: Float64Array, s: Float64Array | null, i: number, v: number, pay: number): void => { if (v < d[i]) { d[i] = v; if (s) s[i] = pay; } };
  for (let e = 0; e < edges.length; e += 2) for (const [i, j] of [[edges[e], edges[e + 1]], [edges[e + 1], edges[e]]]) {
    const a = lab[i], b = lab[j], A = plates[a], B = plates[b], pr = pair[a * NP + b]!;
    if (A.cont) {
      if (pr.type === "conv" && !B.cont && p.style !== "isles" && pr.u < BACKARC_P) {   // 弧后扩张：岛弧贴着海沟、背后拉开一片边缘海，大陆海岸退到海的另一边（日本海式）
        const off = (380 + 900 * pr.u) * ks * (0.6 + 0.8 * clamp01(0.5 + 0.8 * fbm3(P[i].x, P[i].y, P[i].z, 900, 2, sd + 97)));
        src(dCoast, kCoast, i, -off, 3); src(dBA, sBA, i, 0, pr.s);
      }
      else if (pr.type === "conv" && !B.cont) { src(dCoast, kCoast, i, -60, 2); src(dAnd, sAnd, i, 0, pr.s); }
      else if (pr.type === "conv") src(dCol, sCol, i, 0, pr.s);
      else if (pr.type === "div" && B.cont) {   // 裂开：宽度沿边界随噪声变（等宽就是一道平行四边形的海峡）
        const off = (80 + 520 * pr.u) * ks * (0.55 + 0.9 * clamp01(0.5 + 0.8 * fbm3(P[i].x, P[i].y, P[i].z, 700, 2, sd + 91)));
        src(dCoast, kCoast, i, -off, 1); src(dRift, oRift, i, 0, off);
      }
      else if (pr.type === "div") src(dCoast, kCoast, i, -(250 + 250 * pr.u) * ks, 0);
      else if (!B.cont) { src(dCoast, kCoast, i, -(120 + 130 * pr.u) * ks, 0); src(dTr, null, i, 0, 0); }
      else src(dTr, null, i, 0, 0);
    } else if (!B.cont && pr.type === "conv" && A.age < B.age) src(dArc, sArc, i, 0, pr.s);   // 洋洋汇聚：老的俯冲，年轻的一侧成岛弧
  }
  for (const [d, s] of [[dCoast, kCoast], [dAnd, sAnd], [dCol, sCol], [dArc, sArc], [dRift, oRift], [dTr, Z6()], [dBA, sBA]] as [Float64Array, Float64Array][]) distField(d, s, lab, G);

  /* 6. 陆地度 c 与抬升 U */
  const c = new Float64Array(n), U = new Float64Array(n), fold = new Float64Array(n), rift = new Uint8Array(n), isl = p.style === "isles";
  /* 活动度 0..1：俯冲带、岛弧、火山岛与构造性海岸——海岸陡、陆架窄、噪声小（被动边缘为 0） */
  const act = new Float64Array(n);
  for (let i = 0; i < n; i++) act[i] = Math.max(dAnd[i] < Infinity ? 1 - sstep((dAnd[i] - 150) / 450) : 0, dBA[i] < Infinity ? 0.7 * (1 - sstep((dBA[i] - 250) / 300)) : 0);
  const act0 = act.slice();   // 只含板块边界：热点链与构造性海岸随后会往 act 里加，挑构造性海岸的方向只能读这一份
  const W = (km: number): number => Math.max(km, 2 * cell);
  const Dand = 160, Wand = W(120), Wcol = W(260), Darc = 150, Warc = W(70), Wtr = W(90), Wsh = W(80);
  /* 陆核总面积≈目标陆地面积（群岛取其四成五，其余归岛弧与热点）：陆壳远多于目标时分位阈值会切进陆核内部，在陆核之间的低处漏出内海 */
  const cMax = isl ? 0.3 : 1;
  const gam = Math.max(0.25, Math.min(0.95, Math.sqrt((isl ? 0.45 : 1) * F * total / Math.max(1, contA)) * 1.05));
  /* 每组共用一个陆核（形心、面积按整组算）：缝合带因此必在大陆内部，裂开、转换与隔洋的各成一块 */
  const core = plates.map((q, k) => { const Rc = rs(6, k), ar = 1 + 0.9 * Rc(), g = norm(tang({ x: Rc() - 0.5, y: Rc() - 0.5, z: p.sphere ? Rc() - 0.5 : 0 }, q.N)); return { C: q.S, rho: 0, a: ar, e1: g, O: q.S, u: g }; });
  const gx = new Float64Array(NP), gy = new Float64Array(NP), gz = new Float64Array(NP), gm = new Float64Array(NP), ga = new Float64Array(NP);
  for (let i = 0; i < n; i++) { const k = root(lab[i]); gx[k] += P[i].x; gy[k] += P[i].y; gz[k] += P[i].z; gm[k]++; ga[k] += dx[(i / cols) | 0] * dy; }
  const gr = new Float64Array(NP), gc = new Float64Array(NP);
  const nG = new Set(plates.map((q, k) => q.cont ? root(k) : -1).filter(k => k >= 0)).size, aBar = contA / Math.max(1, nG);   // 陆核面积：多块大陆向各组平均拉一半（体量相近又不全一般大），群岛取平均（碰上一块特大板块会长出独大的岛）
  for (let i = 0; i < n; i++) { const k = root(lab[i]); gr[k] += G.mesh.Y[i]; gc[k] += G.mesh.X[i]; }
  for (let k = 0; k < NP; k++) {   // 陆核中心取组的形心，伸出图幅就往里挪、放不下就缩小（伸出去的陆核被留海带切成平行图廓的直海岸）
    const g = root(k);
    if (!gm[g]) continue;
    if (g !== k) { core[k].a = core[g].a; core[k].e1 = core[g].e1; }
    let rho = gam * Math.sqrt((p.style === "isles" ? aBar : p.style === "multi" ? 0.5 * ga[g] + 0.5 * aBar : ga[g]) / PI), shrink = 1;
    const r0 = gr[g] / gm[g], c0 = gc[g] / gm[g], dxr = dx[Math.min(rows - 1, Math.max(0, Math.round(r0)))], Wd = cols * dxr, Hd = rows * dy, need = rho * Math.sqrt(core[k].a) * 0.85 + 200 * ks;
    let xk = (c0 + 0.5) * dxr, yk = (r0 + 0.5) * dy;
    core[k].O = pointOf(p, bb.lonMin + xk / dxr * G.dlon, bb.latMin + yk / dy * G.dlat); core[k].u = core[g].u;   // 挪进图幅之前：陆核中心随陆核半径（陆地占比）挪
    if (2 * need > Wd) { xk = Wd / 2; shrink = Math.min(shrink, Wd / 2 / need); } else xk = Math.max(need, Math.min(Wd - need, xk));
    if (2 * need > Hd) { yk = Hd / 2; shrink = Math.min(shrink, Hd / 2 / need); } else yk = Math.max(need, Math.min(Hd - need, yk));
    core[k].rho = rho * shrink;
    core[k].C = pointOf(p, bb.lonMin + xk / dxr * G.dlon, bb.latMin + yk / dy * G.dlat);
    core[k].e1 = norm(tang(core[k].e1, nrmAt(core[k].C)));
  }
  for (let i = 0; i < n; i++) {
    const A = plates[lab[i]], Pi = P[i];
    if (A.cont) {
      const K = core[lab[i]], wr = 0.5 * K.rho, wv = 0.9 * K.rho, w2 = 0.15 * K.rho, v2 = 0.3 * K.rho;
      const Q = { x: Pi.x + wr * fbm3(Pi.x, Pi.y, Pi.z, wv, 4, sd + 71) + w2 * fbm3(Pi.x, Pi.y, Pi.z, v2, 3, sd + 74),
        y: Pi.y + wr * fbm3(Pi.x, Pi.y, Pi.z, wv, 4, sd + 72) + w2 * fbm3(Pi.x, Pi.y, Pi.z, v2, 3, sd + 75),
        z: Pi.z + (p.sphere ? wr * fbm3(Pi.x, Pi.y, Pi.z, wv, 4, sd + 73) + w2 * fbm3(Pi.x, Pi.y, Pi.z, v2, 3, sd + 76) : 0) };
      const dq = sub(Q, K.C), sc = 300 * ks, e2 = cross(nrmAt(K.C), K.e1), u = dot(dq, K.e1) / Math.sqrt(K.a), v = dot(dq, e2) * Math.sqrt(K.a);   // 椭圆陆核（长短轴比 1～1.9，面积不变）
      const blob = (K.rho - Math.sqrt(u * u + v * v)) / sc;
      let land = blob;   // 俯冲带与缝合带附近强制成陆，但至多伸出陆核边缘约 300 km（否则沿整条边界拖出一道细长山脊）
      if (dAnd[i] < Infinity) land = Math.max(land, Math.min((300 - dAnd[i]) / 300, blob + 1));
      if (dCol[i] < Infinity) land = Math.max(land, Math.min((1.6 * Wcol - dCol[i]) / 300, blob + 1.2));
      if (dRift[i] < Infinity) land = Math.max(land, Math.min((oRift[i] + 400 * ks - dRift[i]) / sc, blob + 1.5));   // 裂开的两岸贴着裂谷：海岸线同源才拼得回去
      const f = dCoast[i];
      c[i] = cMax * Math.max(-1, Math.min(1, land, f >= 0 ? f / sc : f / (200 * ks))) + (isl ? 0.6 * fbm3(Pi.x, Pi.y, Pi.z, 200 * ks, 3, sd + 81) - 0.9 * bump(fbm3(Pi.x, Pi.y, Pi.z, 450 * ks, 2, sd + 83) / 0.22) : 0);   // 末项：群岛的碎陆块沿噪声零值线（连续的曲线网）切出海峡、碎成一串岛——只加噪声只会挖洞；尺度属构图，随图幅
      rift[i] = kCoast[i] === 1 && dCoast[i] < 600 * ks ? 1 : kCoast[i] === 2 && dCoast[i] < 400 ? 2 : 0;
    } else c[i] = -1;
    if (isl) c[i] += 0.5 * fbm3(Pi.x, Pi.y, Pi.z, 500 * ks, 5, sd + 5);   // 群岛：洋面上散布的岛也进骨架（骨架陆地凑不够目标时分位阈值会沉进大洋）
    let u = 0, uf = 0;   // uf＝折皱带那份抬升：碰撞带全算、贴岸山脉算一半（核是岩浆弧、前陆才是褶皱冲断带），岛弧、裂谷肩、转换带、热点不算
    if (dAnd[i] < Infinity) { const v = (0.7 + 0.6 * sAnd[i]) * bump((dAnd[i] - Dand) / Wand); u += v; uf += 0.5 * v; }
    if (dCol[i] < Infinity) { const v = (0.6 + 0.5 * sCol[i]) * bump(dCol[i] / Wcol); u += v; uf += v; }
    if (dRift[i] < Infinity) u += 0.25 * bump((dRift[i] - oRift[i] - 90) / Wsh);
    if (dTr[i] < Infinity && A.cont) u += 0.22 * bump(dTr[i] / Wtr);
    if (dArc[i] < Infinity) {
      const seg = clamp01(0.45 + 1.4 * fbm3(Pi.x, Pi.y, Pi.z, 220, 2, sd + 51)), b = bump((dArc[i] - Darc) / Warc) * seg;
      c[i] += (isl ? 1.5 : 1.3) * b; u += (0.6 + 0.5 * sArc[i]) * b; act[i] = Math.max(act[i], bump((dArc[i] - Darc) / (2 * Warc)));
    }
    if (dBA[i] < Infinity) {   // 陆缘岛弧：比洋洋岛弧宽、断口少，成一串大岛
      const seg = clamp01(0.75 + 1.3 * fbm3(Pi.x, Pi.y, Pi.z, 380, 2, sd + 53)), b = bump((dBA[i] - 170) / W(115)) * seg;
      c[i] += 1.9 * b; u += (0.75 + 0.5 * sBA[i]) * b;
    }
    U[i] = u * mtnK; fold[i] = uf * mtnK;
  }

  /* 7. 热点链：顺板块在热点处的运动方向排开，越老越低（同板块的链方向相同）；落在陆上的照样抬升 */
  const R7 = rs(7), chains = isl ? 3 + Math.floor(R7() * 4) : p.style === "multi" ? 1 + Math.floor(R7() * 3) : Math.floor(R7() * 3);
  for (let k = 0; k < chains; k++) {
    let h0 = -1;
    const Rs = rs(8, k), R = rs(9, k);   // 起点只在洋壳板块的深海上搜：陆壳板块上的海随陆地占比变，搜到别处整条链就换地方
    for (let t = 0; t < 40 && h0 < 0; t++) { const i = Math.floor(Rs() * n), r = (i / cols) | 0, q = i - r * cols; if (!plates[lab[i]].cont && c[i] < -0.5 && r > 2 && q > 2 && r < rows - 3 && q < cols - 3) h0 = i; }
    if (h0 < 0) continue;
    const H = P[h0], v = vel(lab[h0], H), vl = Math.sqrt(dot(v, v)) || 1, L = (700 + 1300 * R()) * ks, gap = 80 + 40 * R(), r0 = 55 + 30 * R();
    const pts: { X: Pt; h: number; r: number }[] = [];
    const side = cross(nrmAt(H), { x: v.x / vl, y: v.y / vl, z: v.z / vl });   // 间距与横向都抖一抖：等距共线就成了一道虚线
    for (let s = 0; s <= L; s += gap * (0.6 + 0.8 * R())) {
      const h = 1 - s / L, o = (R() - 0.5) * 0.8 * r0;
      pts.push({ X: onSurf({ x: H.x + v.x / vl * s + side.x * o, y: H.y + v.y / vl * s + side.y * o, z: H.z + v.z / vl * s + side.z * o }), h: h * (0.6 + 0.4 * R()), r: r0 * (0.6 + 0.7 * h) * (0.7 + 0.6 * R()) });
    }
    for (let i = 0; i < n; i++) {
      const Pi = P[i];
      for (const q of pts) {
        const d = sub(Pi, q.X), b = q.h * bump(Math.sqrt(dot(d, d)) / q.r);
        if (b > 0) { c[i] += (isl ? 1.4 : 1.2) * b; U[i] += 0.9 * b * mtnK; act[i] = Math.max(act[i], Math.min(1, 3 * b)); }
      }
    }
  }

  /* 8. 古老造山带（陆壳内部、低而宽）· 碰撞带背后的高原 · 内陆盆地 */
  const deep = (k: number, km: number): number[] => { const xs: number[] = []; for (let i = 0; i < n; i++) if (lab[i] === k && dCoast[i] > km * ks) xs.push(i); return xs; };
  plates.forEach((q, k) => {
    const R = rs(10, k);
    if (!q.cont || R() > 0.45 + 0.4 * p.mtn) return;
    const xs = deep(k, 350);
    if (xs.length < 6) return;
    const A0 = P[pick(R, xs)];
    let B0 = A0, bs = Infinity;
    for (let t = 0; t < 12; t++) { const X = P[pick(R, xs)], d = sub(X, A0), e = Math.abs(Math.sqrt(dot(d, d)) - 1000 * ks); if (e < bs) { bs = e; B0 = X; } }
    const M = onSurf({ x: (A0.x + B0.x) / 2 + (R() - 0.5) * 300 * ks, y: (A0.y + B0.y) / 2 + (R() - 0.5) * 300 * ks, z: (A0.z + B0.z) / 2 + (p.sphere ? (R() - 0.5) * 300 * ks : 0) });
    const B: Band = { pts: [A0, M, B0], w: 200 + 120 * R(), s: 0.55 * mtnK };
    for (let i = 0; i < n; i++) if (lab[i] === k) { const v = bandVal(B, P[i]); U[i] += v; fold[i] += v; }
  });
  for (let i = 0; i < n; i++) fold[i] = U[i] > 0 ? (fold[i] < U[i] ? fold[i] / U[i] : 1) : 0;   // 折皱带占比 0..1，随后的热点链只加 U 不加它
  const plateaus: Scene["plateaus"] = [], basins: Scene["basins"] = [];
  const Rt = rs(11);
  if (!isl && Rt() < 0.3 + 0.5 * p.mtn) {
    const ring: number[] = [];
    for (let i = 0; i < n; i++) if (dCol[i] > 1.2 * Wcol && dCol[i] < 1.7 * Wcol && dCoast[i] > 300 * ks) ring.push(i);
    if (ring.length) {
      const i = pick(Rt, ring), C = P[i], k = lab[i];
      let bi = -1, bd = Infinity;
      for (let j = 0; j < n; j++) if (lab[j] === k && dCol[j] === 0) { const d = sub(P[j], C), v = dot(d, d); if (v < bd) { bd = v; bi = j; } }
      const ax = bi >= 0 ? norm(cross(nrmAt(C), sub(C, P[bi]))) : { x: 1, y: 0, z: 0 };
      plateaus.push({ C, ax, r: 280 + 220 * Rt(), h: (1300 + 1000 * Rt()) * mtnK });
    }
  }
  const inland: number[] = [];
  for (let i = 0; i < n; i++) if (plates[lab[i]].cont && dCoast[i] > 350 * ks) inland.push(i);
  const Rbas = rs(12);
  for (let k = (isl || !inland.length ? 0 : 1) + Math.floor(Rbas() * 3); k > 0 && inland.length; k--)
    basins.push({ C: P[pick(Rbas, inland)], r: 180 + 220 * Rbas(), d: 300 + 450 * Rbas() });
  /* 图边留海带在第 9 步之前算好：构造性海岸判海岸要把它算进去；扣进陆地度仍在第 10 步，提前扣会让构造性海岸伸进留海带 */
  const edgeKm = 500 * ks, pen = new Float64Array(n);
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
    const i = r * cols + q, X = P[i], u = G.mesh.X[i] + 0.5, v = G.mesh.Y[i] + 0.5, de = Math.min(Math.min(u, cols - u) * dx[r], Math.min(v, rows - v) * dy);
    const dn = Math.max(0, de + 0.4 * edgeKm * fbm3(X.x, X.y, X.z, 700, 2, sd + 29));
    pen[i] = dn < edgeKm ? 2.6 * (1 - dn / edgeKm) * (1 - dn / edgeKm) : 0;
  }
  /* 9. 构造性海岸，起点取骨架的被动海岸：夭折裂谷伸进陆内成长海湾（两侧裂谷肩）· 山脊伸出海岸成半岛 · 被动边缘外裂离的微陆块 */
  const quant = (): number => { const srt = Float64Array.from(c).sort(); return srt[Math.min(n - 1, Math.max(0, Math.floor((1 - F) * n)))]; };
  if (!isl) {
    const th1 = quant();
    const rot = (d: Pt, N: Pt, deg: number): Pt => { const s = sinD(deg), k = cosD(deg), x = cross(N, d); return { x: d.x * k + x.x * s, y: d.y * k + x.y * s, z: d.z * k + x.z * s }; };
    const along = (X: Pt, d: Pt, km: number): Pt => onSurf({ x: X.x + d.x * km, y: X.y + d.y * km, z: X.z + d.z * km });
    /* 折线场：到折线的距离 d 与沿线进度 t（0..1），宽度沿线由 w0 渐变到 w1 */
    const lineAt = (X: Pt, pts: Pt[]): { d: number; t: number } => {
      let bd = Infinity, bt = 0, acc = 0, tot = 0;
      for (let k = 1; k < pts.length; k++) { const s = sub(pts[k], pts[k - 1]); tot += Math.sqrt(dot(s, s)); }
      for (let k = 1; k < pts.length; k++) {
        const A0 = pts[k - 1], ab = sub(pts[k], A0), ap = sub(X, A0), L2 = dot(ab, ab), L = Math.sqrt(L2), u = L2 > 0 ? clamp01(dot(ap, ab) / L2) : 0;
        const e = { x: ap.x - u * ab.x, y: ap.y - u * ab.y, z: ap.z - u * ab.z }, dd = dot(e, e);
        if (dd < bd) { bd = dd; bt = (acc + u * L) / (tot || 1); }
        acc += L;
      }
      return { d: Math.sqrt(bd), t: bt };
    };
    const Rf = rs(13), nGulf = 1 + Math.floor(Rf() * 2), nPen = 2 + Math.floor(Rf() * 2), nBay = 1 + Math.floor(Rf() * 2), nMicro = (p.style === "multi" ? 1 : 0) + Math.floor(Rf() * 2);
    const feats: { kind: 0 | 1 | 2 | 3; i0: number }[] = [];
    /* 起点挂在不随陆地占比变的几何上：按陆壳面积挑一组大陆、取随机方位角，从组形心沿该方向走到这一组第一块陆地的最外缘。
       方向只按板块边界给的量挑、挑定不变，陆地占比只让起点沿射线进退；从当前岸线格里挑＝列表一变，海湾整条跳到别段海岸 */
    const groups = [...new Set(plates.map((q, k) => q.cont ? root(k) : -1))].filter(g => g >= 0).sort((a, b) => a - b);
    const gSum = groups.reduce((a, g) => a + gArea[g], 0);
    const passive = (i: number): boolean => { const r = (i / cols) | 0, q = i - r * cols; return r > 0 && q > 0 && r < rows - 1 && q < cols - 1 && plates[lab[i]].cont && act0[i] <= 0.05 && dCoast[i] >= 150 * ks; };
    /** 射线走廊：形心 C 沿切向 e 前方、离射线半格以内的格，按离 C 的远近排 */
    const corridor = (C: Pt, N: Pt, e: Pt): number[] => {
      const cor: [number, number][] = [], w2 = 0.36 * cell * cell;
      for (let i = 0; i < n; i++) {
        const v = tang(sub(P[i], C), N), s = dot(v, e);
        if (s <= 0) continue;
        const w = { x: v.x - e.x * s, y: v.y - e.y * s, z: v.z - e.z * s };
        if (dot(w, w) < w2) cor.push([s, i]);
      }
      return cor.sort((x, y) => x[0] - y[0] || x[1] - y[1]).map(x => x[1]);
    };
    /* 陆地连通块（4 邻，留海带算在内）：起点只认射线碰到的第一块，岛屿与隔海的陆地不算 */
    const blk = new Int32Array(n).fill(-1), qq = new Int32Array(n);
    for (let s0 = 0, nb = 0; s0 < n; s0++) {
      if (blk[s0] >= 0 || c[s0] - pen[s0] < th1) continue;
      let h = 0, t = 0;
      blk[s0] = nb; qq[t++] = s0;
      while (h < t) {
        const i = qq[h++], r = (i / cols) | 0, q = i - r * cols;
        for (let k = 0; k < 4; k++) {
          const nr = r + D4R[k], nq = q + D4C[k]; if (nr < 0 || nq < 0 || nr >= rows || nq >= cols) continue;
          const j = nr * cols + nq; if (blk[j] < 0 && c[j] - pen[j] >= th1) { blk[j] = nb; qq[t++] = j; }
        }
      }
      nb++;
    }
    let fa = 0;
    for (const [kind, cnt] of [[0, nGulf], [1, nPen], [2, nMicro], [3, nBay]] as [0 | 1 | 2 | 3, number][]) for (let k = 0; k < cnt && gSum > 0; k++) {
      const Ra = rs(15, fa++);
      let g = groups[groups.length - 1];
      for (let u = Ra() * gSum, j = 0; j < groups.length; j++) { u -= gArea[groups[j]]; if (u < 0) { g = groups[j]; break; } }
      const K = core[g], N = nrmAt(K.O), ax = norm(tang(K.u, N)), th0 = Ra() * 360;
      let cor: number[] | null = null, best = 2;
      for (let t = 0; t < 9; t++) {   // ±80° 内挑被动海岸连续最长的方向：越长，陆地占比挪到越高处海岸仍落在被动段上
        const cr = corridor(K.O, N, rot(ax, N, th0 + 20 * ((t + 1) >> 1) * (t & 1 ? 1 : -1)));
        let run = 0, top = 0;
        for (const i of cr) { if (passive(i)) top = Math.max(top, ++run); else if (run) break; }
        if (top > best) { best = top; cor = cr; }
      }
      if (!cor) continue;
      let b0 = -1, i0 = -1;
      for (const i of cor) { if (blk[i] < 0 || root(lab[i]) !== g) continue; if (b0 < 0) b0 = blk[i]; if (blk[i] === b0) i0 = i; }
      if (i0 >= 0 && passive(i0)) feats.push({ kind, i0 });   // 这个方向的海岸已推到活动边缘：缺席，不另挑
    }
    let fi = 0;
    for (const F0 of feats) {
      const R = rs(14, fi++);
      const X0 = P[F0.i0], N0 = nrmAt(X0), K = core[lab[F0.i0]], din0 = tang(sub(K.C, X0), N0), dl = Math.sqrt(dot(din0, din0)) || 1;
      const din = { x: din0.x / dl, y: din0.y / dl, z: din0.z / dl }, out = { x: -din.x, y: -din.y, z: -din.z };
      if (F0.kind === 0) {   // 裂谷海湾：口宽、梢窄，略弯
        const L = (500 + 700 * R()) * ks, w0 = (75 + 70 * R()) * ks, d1 = rot(din, N0, (R() - 0.5) * 50), d2 = rot(d1, N0, (R() - 0.5) * 40);
        const M1 = along(X0, d1, 0.5 * L), pts = [along(X0, out, 150 * ks), M1, along(M1, d2, 0.5 * L)];
        for (let i = 0; i < n; i++) {
          const { d, t } = lineAt(P[i], pts), w = w0 * (1 - 0.55 * t), b = bump(d / w);
          if (b > 0) { c[i] -= 2.6 * b; act[i] = Math.max(act[i], 0.5 * b); }
          U[i] += 0.32 * mtnK * bump((d - 1.5 * w) / w) * (1 - 0.5 * t);
        }
      } else if (F0.kind === 3) {   // 海湾：海岸上挖进去的一块椭圆（墨西哥湾、比斯开湾式）
        const Rb = (230 + 380 * R()) * ks, C0 = along(X0, din, (0.15 + 0.35 * R()) * Rb), e1 = rot(din, N0, R() * 180), ar = 1 + 0.8 * R(), e2 = cross(N0, e1);
        for (let i = 0; i < n; i++) {
          const d = sub(P[i], C0), u = dot(d, e1) / (Rb * Math.sqrt(ar)), v = dot(d, e2) * Math.sqrt(ar) / Rb, b = bump(Math.sqrt(u * u + v * v));
          if (b > 0) c[i] -= 2.2 * b;
        }
      } else if (F0.kind === 1) {   // 山脊半岛：根在陆内，向外伸、渐窄，脊上抬升
        const L = (500 + 900 * R()) * ks, w0 = (130 + 170 * R()) * ks, d1 = rot(out, N0, (R() - 0.5) * 80), d2 = rot(d1, N0, (R() - 0.5) * 30);
        const M1 = along(X0, d1, 0.5 * L), pts = [along(X0, din, 250 * ks), M1, along(M1, d2, 0.5 * L)];
        for (let i = 0; i < n; i++) {
          const { d, t } = lineAt(P[i], pts), w = w0 * (1 - 0.6 * t), b = bump(d / w);
          if (b > 0) { c[i] = Math.max(c[i], th1 + 1.2 * b); act[i] = Math.max(act[i], 0.25 * b); }
          U[i] += 0.6 * mtnK * bump(d / (0.55 * w)) * (1 - 0.4 * t);
        }
      } else {   // 微陆块：离岸、顺岸线拉长的碎陆
        const D = (260 + 320 * R()) * ks, a = (170 + 230 * R()) * ks, bw = (60 + 55 * R()) * ks, C0 = along(X0, out, D), e1 = rot(out, N0, 90 + (R() - 0.5) * 40);
        const pts = [along(C0, e1, -a), along(C0, e1, a)];
        for (let i = 0; i < n; i++) {
          const { d, t } = lineAt(P[i], pts), w = bw * (0.45 + 2.2 * t * (1 - t)), b = bump(d / w);
          if (b > 0) { c[i] = Math.max(c[i], th1 + 1.1 * b); act[i] = Math.max(act[i], 0.3 * b); }
          U[i] += 0.3 * mtnK * bump(d / (0.6 * w));
        }
      }
    }
  }

  /* 10. 图边留海带（内沿随噪声进退，不画出平行图廓的直线），先扣进骨架：否则分位阈值为了凑够陆地会沉进大洋 */
  for (let i = 0; i < n; i++) c[i] -= pen[i];
  /* 11. 骨架海岸的有向距离（km，陆正海负）与半宽（海岸到所在陆地或海面中轴的距离）：骨架只定大形，海岸细节在宏观格按距离叠分形噪声；
     噪声幅度与陡缓按半宽收——窄的海湾、海峡、半岛不被噪声抹掉，多块大陆之间不连成陆桥 */
  const th0 = Math.max(-0.95, quant()), dIn = new Float64Array(n), dOut = new Float64Array(n), pIn = new Float64Array(n), pOut = new Float64Array(n), sdk = new Float64Array(n), hw = new Float64Array(n), mid = new Float64Array(n), lab0 = new Int32Array(n);
  for (let i = 0; i < n; i++) { const L = c[i] >= th0; dIn[i] = L ? Infinity : 0; dOut[i] = L ? 0 : Infinity; pIn[i] = pOut[i] = i; }
  distField(dIn, pIn, lab0, G); distField(dOut, pOut, lab0, G);
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {   // 中轴：相邻两格的最近对岸点相隔 3 格以上且远过到岸距离的 1.4 倍（岸线小凸起伸出的假分支不算）
    const i = r * cols + q, L = c[i] >= th0, pay = L ? pIn : pOut, di = L ? dIn[i] : dOut[i], far = Math.max(3 * cell, 1.4 * di), far2 = far * far;
    mid[i] = Infinity;
    for (let k = 0; k < 4; k++) {
      const nr = r + D4R[k], nq = q + D4C[k]; if (nr < 0 || nq < 0 || nr >= rows || nq >= cols) continue;
      const j = nr * cols + nq; if ((c[j] >= th0) !== L) continue;
      const e = sub(P[pay[i]], P[pay[j]]); if (dot(e, e) > far2) { mid[i] = 0; break; }
    }
  }
  distField(mid, new Float64Array(n), Int32Array.from(c, v => v >= th0 ? 1 : 0), G);
  for (let i = 0; i < n; i++) { const L = c[i] >= th0, d = L ? dIn[i] : dOut[i]; sdk[i] = L ? d - 0.5 * cell : 0.5 * cell - d; hw[i] = d + mid[i]; }
  /* 活动度只在本板块内算，跨板块边界会一步跳变：抹三遍 3×3，陆架宽与海岸陡缓才不沿板块边界画出直线 */
  for (let it = 0, tmp = new Float64Array(n); it < 3; it++) {
    for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
      let sum = 0, w = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const nr = r + a, nq = q + b; if (nr < 0 || nq < 0 || nr >= rows || nq >= cols) continue; sum += act[nr * cols + nq]; w++; }
      tmp[r * cols + q] = sum / w;
    }
    act.set(tmp);
  }
  const Rw = rs(15), wg = norm({ x: Rw() - 0.5, y: Rw() - 0.5, z: 0 });
  return { c, U, fold, rift, sdk, act, hw, mid, pen, plateaus, basins, warpKm: (isl ? 160 : 260) * ks, wind: [wg.x, wg.y] };
}

/** 图幅的名义宽高（km，球面按中纬折经向）：构图缩放与河的起画水量都按它对缺省图幅的面积比 */
function extentKm(p: Gen2Params): [number, number] {
  const { bb } = p, cosMid = p.sphere ? Math.max(0.05, cosD((bb.latMin + bb.latMax) / 2)) : 1;
  return [(bb.lonMax - bb.lonMin) * p.kmd * cosMid, (bb.latMax - bb.latMin) * p.kmd];
}

/* —— 宏观格 —— */
export interface Macro {
  cols: number; rows: number; lon0: number; lat0: number; dlon: number; dlat: number;
  dx: Float64Array; dy: number;             // 逐行经向格距与纬向格距（km，名义值）
  mesh: Gen2Mesh;                           // 节点位置与三角网：节点 i 在格坐标 (mesh.X[i], mesh.Y[i])，经度 lon0 + (X + 0.5)·dlon；河网、填洼、湖与距离场只走它的邻接
  rcv: Int32Array; acc: Float64Array;       // 最终地表上的流向树（流入的邻节点，海格与内流终点指自己）与汇流面积（km²）
  q: Float64Array;                          // 水量（m³/s）：沿流向累积的「年径流 × 面积」
  salt: Uint8Array; lakeEnd: number[];      // 盐滩节点（干的内流盆底）· 湖是否内流（1＝咸湖，湖面低于溢出口）
  s: Float64Array;                          // 陆地度 − 海平面阈值（>0 陆）
  land: Uint8Array;                         // 陆地节点：s ≥ 0，外加被陆地围住、细格画成陆的浅海（汇流与河只认它）
  h: Float64Array;                          // 地面高程（米；海 0；含高原与盆地；外流洼地已填平，内流盆地保留）
  lake: Int32Array; lakeS: number[];        // 湖编号（−1 非湖）与湖面（米；外流湖＝溢出口，内流湖低于它）
  relief: Float64Array; moist: Float64Array; wet: Float64Array;   // 局部起伏（米）· 水汽 0..1+ · 汇流÷坡度
  shelf: Float64Array;                      // 陆架宽（km）
  camp: Float64Array; cwarp: Float64Array;  // 海岸噪声幅度与取样扭曲（xyz 交错；网格分辨率接着叠细倍频时照用）
  mid: Float64Array;                        // 到所在陆地或海面中轴的距离（km，封顶 1e6）
  coastLam: number; coastK: number;         // 海岸噪声首波长（km）与宏观格取到的倍频数
  kmPerS: number;                           // 海侧陆地度每单位折多少公里（陆架按它把宽度换成陆地度）
  iters: number;
  U: Float64Array; K: Float64Array;         // 稳态求解用的抬升（含陆地低抬升底）与可蚀性（含逐节点抖动）：中尺度稳态插到细格照用
  fold: Float64Array;                       // 抬升里折皱带那份的占比 0..1（碰撞带、古老造山带、半份贴岸山脉）：岩性带只长在这上面
  hRel: Float64Array;                       // 稳态解（乘 KAPPA_M 之前，海 0）
  plat: Float64Array; bowl: Float64Array;   // 高原叠加与沉降盆地的扣减量（米）
}
export function buildMacro(p: Gen2Params): Macro {
  const { bb } = p, lonS = bb.lonMax - bb.lonMin, latS = bb.latMax - bb.latMin;
  const [Wk, Hk] = extentKm(p), cell = Math.sqrt(Wk * Hk / MACRO_CAP);
  const cols = Math.max(8, Math.round(Wk / cell)), rows = Math.max(8, Math.round(Hk / cell)), n = cols * rows;
  const dlon = lonS / cols, dlat = latS / rows, dy = dlat * p.kmd;
  const dx = new Float64Array(rows);
  for (let r = 0; r < rows; r++) dx[r] = dlon * p.kmd * (p.sphere ? Math.max(0.05, cosD(bb.latMin + (r + 0.5) * dlat)) : 1);
  const ks = Math.sqrt(Wk * Hk / DEFAULT_AREA_KM2), sd = p.seed * 31, isl = p.style === "isles";
  const mesh = buildMesh(cols, rows, sd + 201), Pts: Pt[] = new Array(n), len = new Float64Array(mesh.nb.length);
  for (let i = 0; i < n; i++) Pts[i] = pointOf(p, bb.lonMin + (mesh.X[i] + 0.5) * dlon, bb.latMin + (mesh.Y[i] + 0.5) * dlat);
  for (let i = 0; i < n; i++) for (let e = mesh.nbOff[i]; e < mesh.nbOff[i + 1]; e++) {
    const a = Pts[i], b = Pts[mesh.nb[e]], x = a.x - b.x, y = a.y - b.y, z = a.z - b.z; len[e] = Math.sqrt(x * x + y * y + z * z);
  }
  const G: MacroGeom = { cols, rows, dlon, dlat, dx, dy, P: Pts, mesh, len };
  const sc = buildScene(p, ks, G);
  /* 逐格：原点 P、扭曲点 Q（高原与盆地在扭曲空间里取） */
  const shelfW = new Float64Array(n), c = new Float64Array(n), U = new Float64Array(n), K = new Float64Array(n), plat = new Float64Array(n), bowl = new Float64Array(n), camp = new Float64Array(n), cwarp = new Float64Array(3 * n);
  const coastLam = (isl ? 500 : CO_LAM) * ks;
  let coastK = 0;
  while (coastK < COAST_OCT && coastLam / (1 << coastK) >= 3.5 * cell) coastK++;   // 宏观格只取解得开的倍频（每波长 ≥3.5 格），更细的留给网格分辨率
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
    const i = r * cols + q, P = Pts[i], W = sc.warpKm, wl = W * 3;
    const Q = { x: P.x + W * fbm3(P.x, P.y, P.z, wl, 3, sd + 1), y: P.y + W * fbm3(P.x, P.y, P.z, wl, 3, sd + 2), z: P.z + (p.sphere ? W * fbm3(P.x, P.y, P.z, wl, 3, sd + 3) : 0) };
    shelfW[i] = SHELF_KM * (0.25 + 2.5 * clamp01(0.5 + 0.9 * fbm3(P.x, P.y, P.z, 1200, 2, sd + 25))) * (1 - 0.75 * sc.act[i]) * (isl ? 0.6 : 1);   // 被动边缘宽、俯冲带窄；群岛窄
    /* 海岸带剖面：离骨架海岸越近越平缓、噪声越强（海平面切过低缓地形才碎成半岛、海湾与近岸岛）；俯冲带一侧陡而少噪，裂开的两岸噪声收小才拼得回去 */
    const t = sc.sdk[i], ac = sc.act[i], hw = sc.hw[i];   // 半宽窄的地方（海峡、窄湾、细半岛）早一点到满幅、噪声收小
    const Lin = Math.max(cell, Math.min((isl ? 160 : CO_LIN * (1 - 0.6 * ac)) * ks, 0.6 * hw)), Lout = Math.max(cell, Math.min((isl ? 160 : CO_LOUT * (1 - 0.6 * ac)) * ks, 0.6 * hw));
    const prof = isl ? sc.c[i] : t >= 0 ? Math.min(1, t / Lin) : Math.max(-1, t / Lout);   // 群岛的骨架本身就是碎的（噪声切出的海峡），再按距离重画剖面会把窄海峡抹平
    camp[i] = (isl ? ISL_AMP : CO_AMP) * ((isl ? 0.3 : 0.12) + (isl ? 0.7 : 0.88) * bump(t / (CO_ZONE * ks))) * (1 - 0.6 * ac) * (sc.rift[i] ? 0.6 : 1);
    const wd = CO_WARP * coastLam, wx = wd * fbm3(P.x, P.y, P.z, coastLam, 3, sd + 141), wy = wd * fbm3(P.x, P.y, P.z, coastLam, 3, sd + 142), wz = p.sphere ? wd * fbm3(P.x, P.y, P.z, coastLam, 3, sd + 143) : 0;
    cwarp[3 * i] = wx; cwarp[3 * i + 1] = wy; cwarp[3 * i + 2] = wz;   // 噪声取样点先扭一扭：半岛与海湾才拉得长、拐得弯，不是一团团圆斑
    c[i] = prof + camp[i] * coastOct(P.x + wx, P.y + wy, P.z + wz, coastLam, isl ? 2 : 0, coastK, sd + 5, sc.mid[i]) - (isl ? 0 : sc.pen[i]);
    if (!isl && t < 0) c[i] += CO_ISL * p.isl * bump((t + ISL_D * ks) / (ISL_W * ks)) * (1 - ac) * sstep(sc.mid[i] / (CO_HW * ks)) * Math.max(0, fbm3(P.x + wx, P.y + wy, P.z + wz, ISL_LAM * ks, 3, sd + 67) - ISL_T);   // 陆架上的岛群：近岸浅海下的起伏冒头
    U[i] = sc.U[i] * (0.75 + 0.5 * (0.5 + 0.5 * fbm3(P.x, P.y, P.z, 400, 2, sd + 7)));
    K[i] = (0.7 + 0.3 * fbm3(P.x, P.y, P.z, 900, 2, sd + 9)) * (0.8 + 0.4 * cellRand(i, sd + 13));   // 逐节点抖动：同一抬升的平缓处流向树不排成平行梳子
    for (const T of sc.plateaus) {   // 顺主脊方向长 1.8 倍；边缘随噪声进退、顶面随噪声起伏
      const d = { x: Q.x - T.C.x, y: Q.y - T.C.y, z: Q.z - T.C.z }, al = dot(d, T.ax), cr2 = dot(d, d) - al * al;
      const q = Math.sqrt(al * al / 3.24 + cr2) / T.r + 0.35 * fbm3(P.x, P.y, P.z, 250, 3, sd + 19);
      plat[i] = Math.max(plat[i], T.h * sstep((1 - q) / 0.3) * (0.8 + 0.25 * fbm3(P.x, P.y, P.z, 180, 2, sd + 21)));
    }
    for (const S of sc.basins) {
      const d = { x: Q.x - S.C.x, y: Q.y - S.C.y, z: Q.z - S.C.z }, t = dot(d, d) / (S.r * S.r);
      if (t < 1) bowl[i] = Math.max(bowl[i], S.d * (1 - t) * (1 - t));
    }
  }
  /* 海平面阈值：按陆地占比取分位（排序是值的，平手顺序不影响取值） */
  const frac = landFrac(p.style, p.land);
  const sorted = Float64Array.from(c).sort();
  const th = sorted[Math.min(n - 1, Math.max(0, Math.floor((1 - frac) * n)))];
  const s = new Float64Array(n), land = new Uint8Array(n);
  for (let i = 0; i < n; i++) { s[i] = c[i] - th; land[i] = s[i] >= 0 ? 1 : 0; }
  /* 没有一格深过细格海岸噪声带的海当陆：细格只认与深海连通的水为海（带宽同 buildFine，倍频取到最细一档的上界），
     被陆地围住的浅海在图上是陆地，宏观仍当海的话，汇流把它当出海口，河流进一片看不见的海 */
  let fs = 0;
  for (let k = 0, a = 1; k < COAST_OCT; k++, a *= COAST_G) if (k >= coastK) fs += a;
  fs /= COAST_NORM;
  const seaC = new Int32Array(n).fill(-1), stk: number[] = [], mem: number[] = [];
  for (let i0 = 0; i0 < n; i0++) {
    if (land[i0] || seaC[i0] >= 0) continue;
    let deep = false; mem.length = 0; seaC[i0] = i0; stk.push(i0);
    while (stk.length) {
      const i = stk.pop()!; mem.push(i);
      if (s[i] <= -2 * camp[i] * fs) deep = true;
      for (let e = mesh.nbOff[i]; e < mesh.nbOff[i + 1]; e++) { const j = mesh.nb[e]; if (!land[j] && seaC[j] < 0) { seaC[j] = i0; stk.push(j); } }
    }
    if (!deep) for (const i of mem) land[i] = 1;
  }
  for (let i = 0; i < n; i++) if (land[i]) U[i] += 0.1 * (0.6 + 0.4 * K[i]);   // 低抬升底：平原与丘陵从这里来
  /* 稳态求解 */
  const area = new Float64Array(n), out = new Uint8Array(n), h0 = new Float64Array(n);
  for (let i = 0; i < n; i++) { area[i] = dx[(i / cols) | 0] * dy; if (land[i]) h0[i] = 1e-3 * cellRand(i, sd + 17); else out[i] = 1; }   // 初值抖动：首轮流向树不按格序排成平行线
  const { h: hRel, iters } = steady({ nbOff: mesh.nbOff, nb: mesh.nb, len, area }, { U, K, acrit: ACRIT_KM2, out, hOut: new Float64Array(n), head: 0 }, h0, { maxIt: 400, tol: STEADY_TOL, canon: false });
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) { const v = land[i] ? KAPPA_M * hRel[i] + plat[i] : 0; h[i] = peakCapM(v, peakKneeM(p.sphere, bb.latMin + (mesh.Y[i] + 0.5) * dlat), 0); }   // 高过膝点渐近压缩：碰撞带叠高原在滑杆拉满时会冲上十公里；膝点随纬度
  for (let i = 0; i < n; i++) if (land[i]) h[i] -= Math.min(bowl[i], BOWL_MAX * h[i]);   // 盆底不跌破海面：海面以下的干地会被渲染端当成水，或钳成 0 m 的平台
  const moist = moisture(p, sc, G, land, h);
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {   // 低频噪声：干湿界不沿等值线成光滑弧
    const i = r * cols + q, P = Pts[i];
    moist[i] *= 1 + 0.45 * fbm3(P.x, P.y, P.z, 450, 3, sd + 23);
  }
  /* 洼地按水量平衡分三种：入流够蒸发 → 溢出（够深成湖、湖面＝溢出口，否则填平）；不够 → 内流：水多的成咸湖（湖面低于溢出口），
     水少的盆底成盐滩；内流盆地不填平，河止于湖或盐滩。入流取填平地表上流到洼地出口的水量 */
  const f = Float64Array.from(h); fillInPlace(mesh, land, f);
  const { R, arid, P: Pr, E: Ev } = runoffOf(p, G, land, moist, h), cellA = new Float64Array(n);
  for (let i = 0; i < n; i++) cellA[i] = dx[(i / cols) | 0] * dy;
  const noSink = new Uint8Array(n), r0 = route(G, land, f, noSink, R, arid, cellA, null), meanA = Wk * Hk / n;
  const lake = new Int32Array(n).fill(-1), lakeS: number[] = [], lakeEnd: number[] = [], st: number[] = [];
  const seen = new Uint8Array(n), keep = new Uint8Array(n), sink = new Uint8Array(n), salt = new Uint8Array(n), cid = new Int32Array(n).fill(-1);
  for (let i0 = 0; i0 < n; i0++) {
    if (!land[i0] || seen[i0] || f[i0] - h[i0] <= 0.5) continue;
    const comp: number[] = []; let depth = 0, Ac = 0, Pm = 0, Em = 0, Qin = 0;
    seen[i0] = 1; st.push(i0);
    while (st.length) {
      const i = st.pop()!;
      comp.push(i); depth = Math.max(depth, f[i] - h[i]); Ac += cellA[i]; Pm += Pr[i] * cellA[i]; Em += Ev[i] * cellA[i];
      if (r0.Q[i] > Qin) Qin = r0.Q[i];
      for (let e = mesh.nbOff[i]; e < mesh.nbOff[i + 1]; e++) {   // 与填洼同一张邻接：一个洼地不被拆成几块
        const j = mesh.nb[e];
        if (!seen[j] && land[j] && f[j] - h[j] > 0.5) { seen[j] = 1; st.push(j); }
      }
    }
    const Enet = (Em - Pm) / Ac, Aeq = Enet > 0 ? Qin * 31536 / Enet : Infinity;   // 平衡湖面积（km²）：入流 ＝ 湖面净蒸发
    if (Aeq >= Ac || f[comp[0]] < ENDO_RIM_M) {   // 溢出口贴着海平面的洼地会被海灌进来（海湾、泻湖），不算内流
      if (depth >= LAKE_MIN_M) { const id = lakeS.length; lakeS.push(f[comp[0]]); lakeEnd.push(0); for (const i of comp) lake[i] = id; }
      continue;
    }
    /* 自盆底淹起：每次淹进水位最低的邻格（水位＝max(本格, 已淹到的水位)），淹出的次序与水位逐格记下；
       按高程排序挑最低的格会跨进互不相连的小盆，湖碎成几块 */
    let bot = comp[0];
    for (const i of comp) { cid[i] = i0; if (h[i] < h[bot] || (h[i] === h[bot] && i < bot)) bot = i; }
    const order: number[] = [], lev: number[] = [], fh = new Heap(comp.length);
    fh.push(h[bot], bot); cid[bot] = -2 - i0;
    while (fh.n) {
      const lv = fh.k[0], i = fh.pop(); order.push(i); lev.push(lv);
      for (let e = mesh.nbOff[i]; e < mesh.nbOff[i + 1]; e++) { const j = mesh.nb[e]; if (cid[j] === i0) { cid[j] = -2 - i0; fh.push(h[j] > lv ? h[j] : lv, j); } }
    }
    const wetEnd = Aeq >= LAKE_END_MIN * meanA, want = wetEnd ? Aeq : Math.max(cellA[bot], SALT_FRAC * Ac);
    let acc = 0, k = 0;
    while (k < order.length && acc < want) acc += cellA[order[k++]];
    let k2 = k;   // 干旱区咸湖外圈一圈盐滩：湖面涨落留下的盐壳（大盐湖旁的邦纳维尔、咸海干出的盐漠）
    if (wetEnd && Pm / Ac < SALT_RING_P) for (let a2 = 0; k2 < order.length && a2 < SALT_RING * Aeq; ) a2 += cellA[order[k2++]];
    const L = k < order.length ? 0.5 * (lev[k - 1] + lev[k]) : lev[k - 1], id = lakeS.length;   // 湖面取到下一格水位的半途：取在最后一格上，插值后湖底细格常高过湖面、画不出水
    if (wetEnd) { lakeS.push(L); lakeEnd.push(1); }
    for (const i of comp) keep[i] = 1;
    for (let t = 0; t < k2; t++) {
      const i = order[t];
      if (t < k) { sink[i] = 1; if (wetEnd) lake[i] = id; else { salt[i] = 1; h[i] = L; } }
      else salt[i] = 1;
    }
  }
  for (let i = 0; i < n; i++) if (land[i] && lake[i] < 0 && !keep[i]) h[i] = f[i];   // 溢出的浅洼一律填平；内流盆地保留
  fillToSinks(mesh, land, sink, lake, lakeS, h);   // 内流盆地里没淹到的小盆填到流得进湖或盐滩的高度，否则河要爬坡出去
  /* 派生（取湖面填平后的地表）：最终流向与水量、局部起伏、水量÷坡度（地形湿度指数的单调代理，不取对数） */
  const sf = Float64Array.from(h);
  for (let i = 0; i < n; i++) if (lake[i] >= 0) sf[i] = lakeS[lake[i]];
  for (let i = 0; i < n; i++) if (lake[i] >= 0 && lakeEnd[lake[i]]) sink[i] = 1;
  const fr = route(G, land, sf, sink, R, arid, cellA, lake), rcv = fr.rcv, A = fr.A, rl = fr.rl;   // 流向在地表定型之后重算：稳态树定于叠高原、扣盆地、成湖之前
  const relief = new Float64Array(n), wet = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    let mx = sf[i], mn = sf[i];
    for (let e = mesh.nbOff[i]; e < mesh.nbOff[i + 1]; e++) { const j = mesh.nb[e], v = land[j] ? sf[j] : 0; if (v > mx) mx = v; if (v < mn) mn = v; }
    relief[i] = mx - mn;
    const j = rcv[i];
    const sl = j === i ? 0.05 : Math.max(0.05, (sf[i] - (land[j] ? sf[j] : 0)) / rl[i]);   // 米/km
    wet[i] = fr.Q[i] / sl;   // 水量 ÷ 坡度：干处不沿大河长沼泽
  }
  return { cols, rows, lon0: bb.lonMin, lat0: bb.latMin, dlon, dlat, dx, dy, mesh, rcv, acc: A, q: fr.Q, salt, lakeEnd, s, land, h, lake, lakeS, relief, moist, wet, shelf: shelfW, camp, cwarp, mid: Float64Array.from(sc.mid, v => Math.min(v, 1e6)), coastLam, coastK, kmPerS: (isl ? 160 : CO_LOUT) * ks, iters, U, K, fold: sc.fold, hRel, plat, bowl };
}
/** 峰顶软上限：膝点以上按 x/(1+x/软度) 压缩，渐近膝点 + 软度（3 km）。球面图的膝点随纬度＝雪线曲线 + PEAK_ABOVE_SNOW_M（赤道恰 PEAK_KNEE_M）：
    最高峰随雪线往极地下降、高程面积在雪线之下堆积；平面图没有气候纬度，膝点恒 PEAK_KNEE_M */
export const PEAK_KNEE_M = 5500, PEAK_SOFT_M = 3000, PEAK_ABOVE_SNOW_M = 700;
/** 某纬度的膝点（米）：宏观、中尺度收尾、嵌套收尾三处封顶同读；另算一份＝块与全图的山顶对不上 */
export function peakKneeM(sphere: boolean, lat: number): number { return sphere ? snowLatM(lat < 0 ? -lat : lat) + PEAK_ABOVE_SNOW_M : PEAK_KNEE_M; }
/** 软上限：膝点以上压缩；kw＝画抬升的软边权重（1 让开、0 照压、其间混合） */
export function peakCapM(v: number, knee: number, kw: number): number {
  if (v <= knee || kw >= 1) return v;
  const k = knee + (v - knee) / (1 + (v - knee) / PEAK_SOFT_M);
  return kw > 0 ? k + kw * (v - k) : k;
}
const STEADY_TOL = 2e-4, KAPPA_M = 1050, LAKE_MIN_M = 25, ACRIT_KM2 = 1500;
/** 降水折算（P＝它 × 水汽，mm/年）· 内流湖至少多大（平均宏观格面积的倍数，再小就是盐滩）· 干盆底成盐滩的面积占洼地 */
const PREC_MM = 2000, LAKE_END_MIN = 0.6, SALT_FRAC = 0.25;
/** 咸湖外圈盐滩：盆地年降水低于它（mm）才有，面积是湖面的几倍 */
const SALT_RING_P = 600, SALT_RING = 0.5;
/** 内流盆地的溢出口至少高出海面多少（米） */
const ENDO_RIM_M = 100;
/** 沉降盆地至多扣掉原地高程的这一成数 */
export const BOWL_MAX = 0.85;
/** 沿程损失（每公里、每单位干燥度）：极干（0.8）流过 500 km 约剩一半，同尼罗河穿过撒哈拉的量级 */
const LOSS_K = 0.0017;
/** 潜在蒸散（mm/年）随纬度（球面）：赤道湿热、副热带最高、高纬冷 */
const EVAP_LAT: [number, number][] = [[0, 1700], [15, 1800], [25, 1700], [35, 1300], [45, 950], [55, 700], [65, 450], [80, 250], [90, 200]];
function evapAt(p: Gen2Params, lat: number, hm: number): number {
  let E = 1100;
  if (p.sphere) {
    const al = lat < 0 ? -lat : lat;
    for (let k = 1; k < EVAP_LAT.length; k++) if (al <= EVAP_LAT[k][0]) { const [a0, v0] = EVAP_LAT[k - 1], [a1, v1] = EVAP_LAT[k]; E = v0 + (v1 - v0) * (al - a0) / (a1 - a0); break; }
  }
  return E * Math.max(0.3, 1 - hm / 6000);   // 高处冷、蒸散少
}
const evapPot = (p: Gen2Params, G: MacroGeom, i: number, hm: number): number => evapAt(p, p.bb.latMin + (G.mesh.Y[i] + 0.5) * G.dlat, hm);
/** 年径流（mm）＝降水 P 减实际蒸散，实际蒸散取 Pike 式 P·E/√(P²+E²)（湿处趋于潜在蒸散 E、干处趋于 P）：宏观与中尺度共用这一式 */
const runoffMm = (P: number, E: number): number => P - P * E / Math.sqrt(P * P + E * E + 1e-9);
/** 干燥度＝1 − P÷E（湿处 0）：沿程损失按它 */
const aridOf = (P: number, E: number): number => P < E ? 1 - P / E : 0;
function runoffOf(p: Gen2Params, G: MacroGeom, land: Uint8Array, moist: Float64Array, h: Float64Array) {
  const n = land.length, R = new Float64Array(n), arid = new Float64Array(n), P = new Float64Array(n), E = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    const pi = PREC_MM * Math.max(0, moist[i]), ei = evapPot(p, G, i, h[i]);
    P[i] = pi; E[i] = ei; R[i] = runoffMm(pi, ei); arid[i] = aridOf(pi, ei);
  }
  return { R, arid, P, E };
}
/** 就地填洼，出口是海（高程 0）与内流终点（sink，湖格取湖面）：内流盆地里另起的小盆填到溢进主盆的高度，湖格不动 */
function fillToSinks(mesh: Gen2Mesh, land: Uint8Array, sink: Uint8Array, lake: Int32Array, lakeS: number[], h: Float64Array): void {
  const n = land.length, heap = new Heap(n), seen = new Uint8Array(n), key = new Float64Array(n);
  const top = (i: number): number => !land[i] ? 0 : lake[i] >= 0 ? lakeS[lake[i]] : h[i];
  for (let i = 0; i < n; i++) if (!land[i] || sink[i]) { seen[i] = 1; key[i] = top(i); heap.push(key[i], i); }
  while (heap.n) {
    const i = heap.pop();
    for (let e = mesh.nbOff[i]; e < mesh.nbOff[i + 1]; e++) {
      const j = mesh.nb[e]; if (seen[j]) continue;
      seen[j] = 1; key[j] = top(j) > key[i] ? top(j) : key[i];
      if (lake[j] < 0 && h[j] < key[j]) h[j] = key[j];
      heap.push(key[j], j);
    }
  }
}
/** 地表上的流向与汇流：优先洪泛自海与内流终点（sink）出发，键取 max(本格, 上游键) 顺手越过残余洼地；返回流向、集水面积（km²）、水量（m³/s）、到下游的边长 */
function route(G: MacroGeom, land: Uint8Array, sf: Float64Array, sink: Uint8Array, R: Float64Array, arid: Float64Array, cellA: Float64Array, lake: Int32Array | null) {
  const { nbOff, nb } = G.mesh, n = land.length, rcv = new Int32Array(n), rl = new Float64Array(n), order = new Int32Array(n), seen = new Uint8Array(n), key = new Float64Array(n), heap = new Heap(n);
  let no = 0;
  for (let i = 0; i < n; i++) if (!land[i] || sink[i]) { seen[i] = 1; rcv[i] = i; key[i] = land[i] ? sf[i] : 0; heap.push(key[i], i); }
  while (heap.n) {
    const i = heap.pop(); order[no++] = i;
    for (let e = nbOff[i]; e < nbOff[i + 1]; e++) {
      const j = nb[e]; if (seen[j]) continue;
      seen[j] = 1; rcv[j] = i; rl[j] = G.len[e]; key[j] = sf[j] > key[i] ? sf[j] : key[i]; heap.push(key[j], j);
      if (lake && lake[j] >= 0 && !sink[j]) {   // 第一次碰到外流湖就整湖认领：湖面平，同高的岸格不止一处，逐格认领会给一个湖开出几个出口
        const id = lake[j], qs = [j];
        for (let t = 0; t < qs.length; t++) {
          const c = qs[t];
          for (let e2 = nbOff[c]; e2 < nbOff[c + 1]; e2++) {
            const m = nb[e2]; if (seen[m] || lake[m] !== id) continue;
            seen[m] = 1; rcv[m] = c; rl[m] = G.len[e2]; key[m] = key[j]; heap.push(key[m], m); qs.push(m);
          }
        }
      }
    }
  }
  const A = Float64Array.from(cellA), Q = new Float64Array(n);
  for (let i = 0; i < n; i++) Q[i] = land[i] ? R[i] * cellA[i] / 31536 : 0;   // mm·km²/年 → m³/s
  for (let o = no - 1; o >= 0; o--) {   // 沿程损失：干处每段按干燥度与长度蒸发、下渗掉一部分（塔里木河、奥卡万戈河在荒漠里断流）
    const i = order[o], j = rcv[i]; if (j === i) continue;
    const keep = 1 - LOSS_K * arid[i] * rl[i];
    A[j] += A[i]; Q[j] += keep > 0 ? Q[i] * keep : 0;
  }
  return { rcv, A, Q, rl };
}
const D4R = [0, 0, 1, -1], D4C = [1, -1, 0, 0];
const D8R = [-1, -1, -1, 0, 0, 1, 1, 1], D8C = [-1, 0, 1, -1, 1, -1, 0, 1];

/** 优先洪泛填洼（就地，沿三角网邻接，与稳态求解同一张图）：每个洼地填到溢出口高程（海格是源，高程 0） */
function fillInPlace(mesh: Gen2Mesh, land: Uint8Array, f: Float64Array): void {
  const n = land.length, heap = new Heap(n), seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!land[i]) { seen[i] = 1; heap.push(0, i); }
  while (heap.n) {
    const i = heap.pop(), fi = land[i] ? f[i] : 0;
    for (let e = mesh.nbOff[i]; e < mesh.nbOff[i + 1]; e++) {
      const j = mesh.nb[e]; if (seen[j]) continue;
      seen[j] = 1;
      if (f[j] < fi) f[j] = fi;
      heap.push(f[j], j);
    }
  }
}

/** 水汽：顺盛行风扫掠，海上回满、陆上按路程与爬升降水（迎风坡多雨、背风雨影）。球面东西两向各扫一遍取较大者，平面取种子定的单一风向。
    扫掠顺序与步长按行列与名义格距，噪声取样点与纬度按节点的实际位置 */
function moisture(p: Gen2Params, sc: Scene, G: MacroGeom, land: Uint8Array, h: Float64Array): Float64Array {
  const { cols, rows, dx, dy } = G, n = cols * rows, H = new Float64Array(n), M = new Float64Array(n);
  const RAIN_KM = 2200, OROG_M = 2400, ET_MAX = 0.6, ET_WET = 0.5;   // 湿处回补 60%＝有效衰减距离 ×2.5，两距离按 0.4 折回与回补前同量级
  /* 球面按纬度定副热带下沉与东西两侧海洋的水汽源强度；平面图不下沉、源强恒 1 */
  const sub = new Float64Array(n), srcE = new Float64Array(n).fill(1), srcW = new Float64Array(n).fill(1);
  let src = srcE;   // 本遍扫掠的海上回满目标
  const stepTo = (Mo: Float64Array, Ho: Float64Array, i: number, hin: number, hup: number, L: number): void => {
    if (!land[i]) { Ho[i] = hin + (src[i] - hin) * Math.min(1, L / 250); Mo[i] = Ho[i]; return; }
    const s = sub[i], rise = Math.max(0, h[i] - hup), fr = Math.min(0.6, L / (RAIN_KM * (1 - SUB_DRY * s)) + rise / OROG_M);
    Mo[i] = hin * (1 + 1.5 * Math.min(1, rise / 800));
    Ho[i] = hin * (1 - fr * (1 - ET_MAX * (1 - SUB_ET * s) * Math.min(1, Mo[i] / ET_WET)));   // 陆面蒸散回补：越湿回补越多，干处不回补
  };
  const step = (i: number, hin: number, hup: number, L: number): void => stepTo(M, H, i, hin, hup, L);
  if (p.sphere) {
    /* 信风带由东侧海洋供水汽、西风带由西侧，中纬度东岸另有副高西侧与季风的弱源：两遍扫掠取较大者，荒漠只落在两侧都送不到的地方。
       只有一侧供水汽时，背风雨影会一路干到对岸 */
    /* 逐列推进、来风取上一列相邻三行的加权平均，权重中心随低频噪声南北摆（风向弯）：逐行各扫各的或风向处处平行，雨影都会从山脉平推到底、画成上下边平直的长方形荒漠 */
    const an = new Float64Array(n), ME = new Float64Array(n), MW = new Float64Array(n), HE = new Float64Array(n), HW = new Float64Array(n), W3 = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {   // 带界随噪声进退 ±8°：按纬度一刀切的界会画成水平直线
      const lat = p.bb.latMin + (G.mesh.Y[i] + 0.5) * G.dlat, al = lat < 0 ? -lat : lat, P = G.P[i];
      const a = Math.abs(al + 8 * fbm3(P.x, P.y, P.z, 1500, 2, p.seed * 31 + 27));
      an[i] = a; sub[i] = subsidence(a); srcE[i] = eastSource(a); srcW[i] = westSource(a);
    }
    for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
      const i = r * cols + q, P = G.P[i];
      const v = Math.max(-1, Math.min(1, 1.6 * fbm3(P.x, P.y, P.z, 1200, 2, p.seed * 31 + 33)));
      const a = 0.5 * Math.max(0, -v) + 0.125, b = 0.5 * (1 - (v < 0 ? -v : v)) + 0.25, c = 0.5 * Math.max(0, v) + 0.125, t = a + b + c;
      W3[i * 3] = a / t; W3[i * 3 + 1] = b / t; W3[i * 3 + 2] = c / t;
    }
    for (const [Mo, Ho, fromE] of [[ME, HE, true], [MW, HW, false]] as [Float64Array, Float64Array, boolean][]) {
      src = fromE ? srcE : srcW;
      for (let k = 0; k < cols; k++) {
        const q = fromE ? cols - 1 - k : k, qp = fromE ? q + 1 : q - 1;
        for (let r = 0; r < rows; r++) {
          let hin = src[r * cols + q], hup = 0;
          if (k > 0) {
            const ra = r > 0 ? r - 1 : r, rb = r < rows - 1 ? r + 1 : r, a = ra * cols + qp, b = r * cols + qp, c = rb * cols + qp, w = (r * cols + q) * 3;
            hin = W3[w] * Ho[a] + W3[w + 1] * Ho[b] + W3[w + 2] * Ho[c];
            hup = W3[w] * (land[a] ? h[a] : 0) + W3[w + 1] * (land[b] ? h[b] : 0) + W3[w + 2] * (land[c] ? h[c] : 0);
          }
          stepTo(Mo, Ho, r * cols + q, hin, hup, dx[r]);
        }
      }
    }
    for (let i = 0; i < n; i++) M[i] = Math.max(ME[i], MW[i]) * latFactor(an[i]) * (1 - SUB_RAIN * sub[i]);
  } else {
    const [wx, wy] = sc.wind, idx = new Int32Array(n), key = new Float64Array(n);
    for (let i = 0; i < n; i++) { const r = (i / cols) | 0; idx[i] = i; key[i] = (i - r * cols) * dx[r] * wx + r * dy * wy; }
    idx.sort((a, b) => key[a] - key[b] || a - b);
    for (const i of idx) {
      const r = (i / cols) | 0, q = i - r * cols;
      let ws = 0, hs = 0, us = 0;
      for (let k = 0; k < 8; k++) {
        const nr = r + D8R[k], nq = q + D8C[k];
        if (nr < 0 || nq < 0 || nr >= rows || nq >= cols) continue;
        const d = -(D8C[k] * wx + D8R[k] * wy); if (d <= 0.3) continue;   // 只取上风方向的邻格（已扫过）
        const j = nr * cols + nq, w = d * d;
        ws += w; hs += w * H[j]; us += w * (land[j] ? h[j] : 0);
      }
      step(i, ws > 0 ? hs / ws : 1, ws > 0 ? us / ws : 0, dx[r]);
    }
  }
  /* 一格方框平滑：逐行扫的条纹磨掉 */
  const out = new Float64Array(n);
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
    let s = 0, w = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const nr = r + a, nq = q + b; if (nr < 0 || nq < 0 || nr >= rows || nq >= cols) continue;
      s += M[nr * cols + nq]; w++;
    }
    out[r * cols + q] = s / w;
  }
  return out;
}
/** 副热带下沉（球面）：陆上水汽的有效衰减距离缩短 60%、蒸散回补减半、降水再打八折 */
const SUB_DRY = 0.6, SUB_ET = 0.5, SUB_RAIN = 0.2;
/** 副热带下沉的权重（|纬度|°）：12° 起、19–27° 满、35° 止 */
function subsidence(a: number): number {
  return a <= 12 || a >= 35 ? 0 : a < 19 ? sstep((a - 12) / 7) : a <= 27 ? 1 : 1 - sstep((a - 27) / 8);
}
/** 东侧海洋的水汽源强度（|纬度|°）：信风带满、中纬度 0.6（副高西侧与季风）、高纬 0.3 */
function eastSource(a: number): number {
  return a <= 25 ? 1 : a < 35 ? 1 - 0.4 * sstep((a - 25) / 10) : a <= 45 ? 0.6 : a < 58 ? 0.6 - 0.3 * sstep((a - 45) / 13) : 0.3;
}
/** 西侧海洋的水汽源强度（|纬度|°）：赤道辐合带 0.8、副热带无、西风带满、极地减半 */
function westSource(a: number): number {
  return a <= 8 ? 0.8 : a < 18 ? 0.8 * (1 - sstep((a - 8) / 10)) : a <= 22 ? 0 : a < 35 ? sstep((a - 22) / 13) : a <= 58 ? 1 : 1 - 0.5 * sstep((a - 58) / 10);
}
/** 纬度对降水的折算（球面）：赤道辐合带多雨、副热带略少（下沉另在 subsidence）、中纬度常态、高纬冷干。分段线性 */
function latFactor(al: number): number {
  const T: [number, number][] = [[0, 1.25], [10, 1.15], [20, 0.75], [28, 0.68], [38, 0.95], [55, 1.0], [70, 0.7], [90, 0.5]];
  for (let k = 1; k < T.length; k++) if (al <= T[k][0]) { const [a0, v0] = T[k - 1], [a1, v1] = T[k]; return v0 + (v1 - v0) * (al - a0) / (a1 - a0); }
  return 0.5;
}

/* —— 细格与分区栅格从宏观三角网取值 —— */
/** 细格高程的磨平半径（宏观格边长的倍数） */
const MESH_SMOOTH = 0.25;
/** 方框模糊三趟（≈高斯，σ≈r），边缘钳制延伸、就地改写；r < 1 不动 */
export function boxBlur3(f: Float64Array, cols: number, rows: number, r: number): void {
  if (r < 1) return;
  const tmp = new Float64Array(f.length), acc = new Float64Array(cols), w = 2 * r + 1, cl = (v: number, hi: number): number => v < 0 ? 0 : v > hi ? hi : v;
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < rows; y++) {
      const o = y * cols; let a = 0;
      for (let k = -r; k <= r; k++) a += f[o + cl(k, cols - 1)];
      for (let x = 0; x < cols; x++) { tmp[o + x] = a / w; a += f[o + cl(x + r + 1, cols - 1)] - f[o + cl(x - r, cols - 1)]; }
    }
    /* 竖向按行推进、每列一个累加器（访存连续）：每列的加减仍自上而下逐格做，换了次序就不再逐位同 */
    acc.fill(0);
    for (let k = -r; k <= r; k++) { const o = cl(k, rows - 1) * cols; for (let x = 0; x < cols; x++) acc[x] += tmp[o + x]; }
    for (let y = 0; y < rows; y++) {
      const o = y * cols, oa = cl(y + r + 1, rows - 1) * cols, ob = cl(y - r, rows - 1) * cols;
      for (let x = 0; x < cols; x++) { f[o + x] = acc[x] / w; acc[x] += tmp[oa + x] - tmp[ob + x]; }
    }
  }
}
/** 逐行扫一张栅格：fy(j) / fx(i) 给栅格点的宏观格坐标，visit(i, j, I, W) 拿到三个真节点与重心权。每行从上一行开头的三角形起步 */
function scanMesh(M: Macro, rows: number, cols: number, fy: (j: number) => number, fx: (i: number) => number, visit: (i: number, j: number, I: Int32Array, W: Float64Array) => void): void {
  const I = new Int32Array(3), W = new Float64Array(3);
  let rowHint = 0;
  for (let j = 0; j < rows; j++) {
    const y = fy(j);
    let hint = rowHint;
    for (let i = 0; i < cols; i++) {
      const t = meshLocate(M.mesh, fx(i), y, hint, I, W);
      if (t >= 0) { hint = t; if (i === 0) rowHint = t; }
      visit(i, j, I, W);
    }
  }
}
const at3 = (F: ArrayLike<number>, I: Int32Array, W: Float64Array): number => F[I[0]] * W[0] + F[I[1]] * W[1] + F[I[2]] * W[2];

/* —— 逐格派生（网格分辨率）—— */
/** sea＝生成器定为海的细格（与深海连通的水；湖不算）：渲染端判水面时据此认海，被陆地围住的海盆也钉在 0 */
export interface Gen2Fine { cells: string[][]; base: Float32Array; lf: Uint8Array; sea: Uint8Array; macro: Macro;
  /** 细格所属的宏观湖号（−1 非湖）与溢出口格（岸线最低的陆格记它溢出的湖号，其余 −1） */
  lakeOf: Int32Array; outlet: Int32Array;
  /** 陆格地类判定里与高程无关的判据位（CF_*）：中尺度按自己的高程与起伏重判时照用 */
  cf: Uint8Array }
const LF_IDX: Record<Landform, number> = Object.fromEntries(LANDFORM_ORDER.map((l, i) => [l, i])) as Record<Landform, number>;
const ECOS = ["none", "forest", "grassland", "marsh", "desert", "salt"] as const;
/** 复合类号 → 复合串：类号＝地貌序号 × 生态档数 + 生态序号（与 constants.compositeIndex 同序） */
const COMP: string[] = LANDFORM_ORDER.flatMap(lf => ECOS.map(e => e === "none" ? lf : lf + "/" + e));
const WATER_CLS = LF_IDX.water * ECOS.length, SALT_CLS = LF_IDX.plain * ECOS.length + 5;
/** 地类判定里与高程无关的逐格判据（位，buildFine 定）：宏观与中尺度两次判定共用，高程与起伏各取各的 */
const CF_COAST = 1, CF_SALT = 2, CF_MARSH = 4, CF_DESERT = 8, CF_GRASS = 16, CF_FOREST = 32;
/** 林线（米）：森林只长在它以下 */
const treeOf = (p: Gen2Params, lat: number): number => { const al = lat < 0 ? -lat : lat; return p.sphere ? Math.max(0, 4000 - 70 * Math.max(0, al - 20)) : 2400; };
/** 陆格的复合类号：e＝地面高程、rl＝周围一个宏观格内的起伏（米）、f＝判据位 */
function classOf(e: number, rl: number, f: number, tree: number): number {
  let lf = e >= 3000 ? LF_IDX.alpine : e >= 1500 || (rl >= 1800 && e >= 900) ? LF_IDX.mountain : e >= 600 || rl >= 1000 ? LF_IDX.hill
    : (f & CF_COAST) && e < 120 ? LF_IDX.coast : LF_IDX.plain;
  let eco = 0;
  if (f & CF_SALT) { lf = LF_IDX.plain; eco = 5; }   // 盐滩：干的内流盆底，平的
  else if ((lf === LF_IDX.plain || lf === LF_IDX.coast) && e < 250 && (f & CF_MARSH)) eco = 3;
  else if (f & CF_DESERT) eco = 4;
  else if (f & CF_GRASS) eco = 2;
  else if ((f & CF_FOREST) && e < tree) eco = 1;
  return lf * ECOS.length + eco;
}
/** 陆架坡折（米）· 陆架均宽（km，按地段 0.4～2 倍）· 陆坡（tan 0.8°；3° 在战略格上只剩一格宽的崖） */
const SHELF_BREAK_M = 140, SHELF_KM = 110, SLOPE_TAN = 0.014;
/** 近岸最浅（抽象单位）：水格基底须不高于水面 + 它，否则渲染端把它画成陆地；与 core/elev 的 SHORE_E 同值 */
const SHORE_U = -0.03;

let macroMemo: { key: string; m: Macro } | null = null;
let fineMemo: { key: string; f: Gen2Fine } | null = null;
export function gen2Macro(meta: Meta): Macro {
  const p = gen2Params(meta), key = JSON.stringify(p);
  if (macroMemo && macroMemo.key === key) return macroMemo.m;
  const m = buildMacro(p);
  macroMemo = { key, m };
  return m;
}
/** 网格分辨率的地类（复合串）、连续基底（抽象单位）与地貌序号；按（几何, 参数）单槽记忆，cells 共享只读 */
export function gen2Fine(meta: Meta, g: FieldGeom): Gen2Fine {
  const p = gen2Params(meta), key = JSON.stringify([p, g.bb, g.step, g.cols, g.rows]);
  if (fineMemo && fineMemo.key === key) return fineMemo.f;
  const f = buildFine(p, gen2Macro(meta), g);
  fineMemo = { key, f };
  return f;
}

/* —— 河流折线（建图时写进 edges、带 gen 标记；两个滑杆不进地形键）—— */
/** 「河流多少」→ 缺省图幅上起画的水量（m³/s），分段线性；图幅大小不同时按面积等比缩放，整张图上画出的河条数大致不变 */
const RIV_Q: readonly [number, number][] = [[0, 1500], [0.25, 600], [0.5, 250], [0.75, 120], [1, 60]];
/** 「水量」→ 径流倍率：各河水量整体乘它，河更宽、也有更多支流够上门槛（内流区的水量平衡不乘它） */
const RIV_WATER: readonly [number, number][] = [[0, 0.4], [0.5, 1], [1, 2.5]];
/** 回差：过门槛的河往下游画到、河头往上游沿干流延到水量跌破门槛的这一比例——门槛附近不冒断续短河，两条支流在海边才汇过门槛也不只画一截河口 */
const RIV_KEEP = 0.35;
/** 按细格水面截河：每段宏观折线取样的点数（宏观格距约 50 km，取样约 2 km 一点，细于细格） */
const RIV_CLIP_N = 24;
/** 河口、湖边落在细格陆上时，往外找水面的半径（宏观格距的倍数） */
const RIV_REACH = 3;
const tab = (T: readonly [number, number][], t: number): number => {
  for (let k = 1; k < T.length; k++) if (t <= T[k][0]) { const [a0, v0] = T[k - 1], [a1, v1] = T[k]; return v0 + (v1 - v0) * (t - a0) / (a1 - a0); }
  return T[T.length - 1][1];
};
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
/** pts 自源头向下游（[经, 纬]，四位小数）；widthM 是这一段的水面宽（米，有 ws 时取其最大值）；ws 逐点水面宽（米）、mz 逐点曲流强度（0..MZ_MAX）：
    两者与 pts 等长，中尺度河才有 */
export interface GenRiver { pts: [number, number][]; widthM: number; ws?: number[]; mz?: number[] }
/** 生成器画的河：最终地表的流向树上水量过「河流多少」门槛的河道，同一条河按水量每翻一倍切一段（下游的段更宽），
    支流画到汇合点、入海入湖截到细格水边。g 必须是这张图的地形网格几何（与 gen2Fine 同一份），否则入海口对不上岸线 */
export function gen2Rivers(meta: Meta, g: FieldGeom): GenRiver[] {
  const { qmin, wf } = riverParams(meta);
  return extractRivers(gen2Macro(meta), gen2Fine(meta, g), g, qmin, wf);
}
/** 抽河参数：起画水量 qmin（m³/s，已按图幅面积比缩放）与径流倍率 wf；水量 × wf ≥ qmin 起画 */
export interface RiverParams { qmin: number; wf: number }
/** 两个滑杆换成的抽河参数 */
export function riverParams(meta: Meta): RiverParams {
  const [Wk, Hk] = extentKm(gen2Params(meta));
  const cl = (v: unknown) => { const x = +(v as number); return isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5; };
  return { qmin: tab(RIV_Q, cl(meta.genRiv)) * Wk * Hk / DEFAULT_AREA_KM2, wf: tab(RIV_WATER, cl(meta.genWater)) };
}
function extractRivers(M: Macro, F: Gen2Fine, g: FieldGeom, qmin: number, wf: number): GenRiver[] {
  const n = M.rcv.length, { rcv, q, lake } = M, land = (i: number) => M.land[i] === 1;
  const X = (i: number) => M.lon0 + (M.mesh.X[i] + 0.5) * M.dlon, Y = (i: number) => M.lat0 + (M.mesh.Y[i] + 0.5) * M.dlat;
  /* 上游先算（汇流面积沿流向严格增大）：net＝画进河网，up＝有画进河网的来水；湖里不画，但穿湖的河在出湖口照「已起画」接着画 */
  const order: number[] = [];
  for (let i = 0; i < n; i++) if (land(i)) order.push(i);
  order.sort((a, b) => M.acc[a] - M.acc[b] || a - b);
  const net = new Uint8Array(n), up = new Uint8Array(n), keep = RIV_KEEP * qmin;
  for (const i of order) {
    const j = rcv[i];
    if (lake[i] >= 0) { if (up[i] && j !== i) up[j] = 1; continue; }
    if (q[i] * wf >= qmin || up[i] && q[i] * wf >= keep) { net[i] = 1; if (j !== i) up[j] = 1; }
  }
  /* 河头往上游：下游先算，河头（没有河网来水）接上水量最大的来水，够回差就画进河网、成为新的河头；最大的来水出自湖则河从湖起，不延 */
  const big = new Int32Array(n).fill(-1);
  for (let u = 0; u < n; u++) { const i = rcv[u]; if (i !== u && land(u) && (big[i] < 0 || q[u] > q[big[i]] || q[u] === q[big[i]] && u < big[i])) big[i] = u; }
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k], u = big[i];
    if (net[i] && !up[i] && u >= 0 && lake[u] < 0 && !net[u] && q[u] * wf >= keep) { net[u] = 1; up[i] = 1; }
  }
  /* 干流来水＝水量最大的河网来水或出湖水（同量取小编号）；其余来水画到这个节点为止 */
  const main = new Int32Array(n).fill(-1);
  for (let u = 0; u < n; u++) {
    const i = rcv[u];
    if (i === u || !net[i] || !(net[u] || lake[u] >= 0)) continue;
    const m = main[i];
    if (m < 0 || q[u] > q[m] || q[u] === q[m] && u < m) main[i] = u;
  }
  const WATER = LF_IDX.water;
  const fineWater = (x: number, y: number): boolean => {
    const c = Math.floor((x - g.bb.lonMin) / g.step), r = Math.floor((y - g.bb.latMin) / g.step);
    return c < 0 || r < 0 || c >= g.cols || r >= g.rows || F.lf[r * g.cols + c] === WATER;
  };
  /** (x, y) 到最近的细格水面：沿直线取样到第一个落水点；方圆 reach 格内没有水＝null。
      最近水格的圆盘里全是陆，所以这条直线不穿水 */
  const reach = Math.ceil(RIV_REACH * M.dlat / g.step);
  const toWater = (x: number, y: number): [number, number] | null => {
    const fc = (x - g.bb.lonMin) / g.step, fr = (y - g.bb.latMin) / g.step, c0 = Math.floor(fc), r0 = Math.floor(fr);
    let best = -1, bd = Infinity;
    for (let r = Math.max(0, r0 - reach); r <= Math.min(g.rows - 1, r0 + reach); r++) for (let c = Math.max(0, c0 - reach); c <= Math.min(g.cols - 1, c0 + reach); c++) {
      const i = r * g.cols + c, dc = c + 0.5 - fc, dr = r + 0.5 - fr, d = dc * dc + dr * dr;
      if (F.lf[i] === WATER && d < bd) { bd = d; best = i; }
    }
    if (best < 0) return null;
    const bx = g.bb.lonMin + (best % g.cols + 0.5) * g.step, by = g.bb.latMin + (Math.floor(best / g.cols) + 0.5) * g.step;
    for (let t = 1; t < RIV_CLIP_N; t++) { const px = x + (bx - x) * t / RIV_CLIP_N, py = y + (by - y) * t / RIV_CLIP_N; if (fineWater(px, py)) return [px, py]; }
    return [bx, by];
  };
  const out: GenRiver[] = [];
  /** 一段折线 L（经、纬、水量三三交错；水量 −1＝只占几何：湖边、汇合点、入水点）按水量每翻一倍切段输出；
      切点前后各至少留两段折线，末尾才汇进大支流的不再切出一小截 */
  const emit = (L: number[]) => {
    const m = L.length / 3, seg = (a: number, b: number, qa: number, qb: number) => {
      const pts: [number, number][] = [];
      for (let k = a; k <= b; k++) { const x = r4(L[3 * k]), y = r4(L[3 * k + 1]), l = pts[pts.length - 1]; if (!l || l[0] !== x || l[1] !== y) pts.push([x, y]); }
      if (pts.length >= 2) out.push({ pts, widthM: Math.max(1, Math.round(RIV_WIDTH * Math.sqrt(wf * Math.sqrt(qa * qb)))) });
    };
    let a = 0, q0 = -1;
    for (let k = 0; k < m && q0 < 0; k++) q0 = L[3 * k + 2];
    let qb = q0;
    for (let k = 1; k < m; k++) {
      const qk = L[3 * k + 2];
      if (qk >= 2 * q0 && k - a >= 2 && m - 1 - k >= 2) { seg(a, k, q0, qb); a = k; q0 = qk; }
      if (qk >= 0) qb = qk;
    }
    seg(a, m - 1, q0, qb);
  };
  for (let s = 0; s < n; s++) {
    if (!net[s] || main[s] >= 0 && lake[main[s]] < 0) continue;   // 源头：没有河网来水，或干流出自湖
    const P: number[] = [];   // 宏观折线：经、纬、水量；出湖的河从湖里的节点起、入海入湖画到水里的节点，下面再按细格水面截
    if (main[s] >= 0) P.push(X(main[s]), Y(main[s]), -1);
    P.push(X(s), Y(s), q[s]);
    let cur = s, ends = false, mouth = false, len = 1;
    for (;;) {
      const j = rcv[cur];
      if (j === cur) { ends = true; break; }                                   // 内流终点（盐滩）
      if (!land(j) || lake[j] >= 0) { P.push(X(j), Y(j), -1); ends = mouth = true; break; }
      if (!net[j]) break;                                                      // 沿程损失，干涸
      if (main[j] !== cur) { P.push(X(j), Y(j), -1); ends = true; break; }     // 汇进干流
      P.push(X(j), Y(j), q[j]); len++; cur = j;
    }
    if (len < 3 && !ends) continue;   // 半路干掉的短碎河不画
    /* 细格水面上不画：沿线取样，碰水就断、出水再接着画（宏观节点会落进细格的海湾、湖里，入海口也在这里截到岸边）。
       出水之后的一截至少带两个节点才画，否则是贴着岸线的碎头 */
    let L: number[] = [], wet = fineWater(P[0], P[1]), first = true;
    if (!wet) {
      const w = main[s] >= 0 ? toWater(P[0], P[1]) : null;   // 湖里的节点落在细格陆上：从最近的湖边起
      if (w) L.push(w[0], w[1], -1);
      L.push(P[0], P[1], P[2]);
    }
    const flush = () => {
      let nq = 0;
      for (let k = 2; k < L.length; k += 3) if (L[k] >= 0) nq++;
      if (L.length >= 6 && nq >= (first ? 1 : 2)) emit(L);
      L = []; first = false;
    };
    for (let k = 3; k < P.length; k += 3) {
      const ax = P[k - 3], ay = P[k - 2], bx = P[k], by = P[k + 1];
      for (let t = 1; t <= RIV_CLIP_N; t++) {
        const x = t === RIV_CLIP_N ? bx : ax + (bx - ax) * t / RIV_CLIP_N, y = t === RIV_CLIP_N ? by : ay + (by - ay) * t / RIV_CLIP_N;
        const w = fineWater(x, y), qq = t === RIV_CLIP_N ? P[k + 2] : -1;
        if (w) { if (!wet) { L.push(x, y, -1); flush(); wet = true; } }
        else if (wet) { wet = false; L = [x, y, qq]; }
        else if (t === RIV_CLIP_N) L.push(x, y, qq);
      }
    }
    if (L.length && mouth && !wet) { const w = toWater(L[L.length - 3], L[L.length - 2]); if (w) L.push(w[0], w[1], -1); }   // 宏观的海、湖节点落在细格陆上：接到最近的水边
    if (L.length) flush();
  }
  return out;
}

/* —— 派生气候分区（core/climzone 作未涂处的缺省，不落盘）—— */
/** 干旱档的水汽门槛：荒漠生态 <0.14、草原 <0.26，干旱区罩住荒漠与偏干的草原 */
const ARID_MOIST = 0.2;
/** 纬度带上界（|纬度|°）：热带 · 亚热带 · 温带 · 寒带，其上极地 */
const BAND_LAT: readonly [number, Climate][] = [[23, "tropical"], [35, "subtropical"], [50, "temperate"], [64, "boreal"]];
const zoneIdx = (c: Climate): number => CLIMATE_ORDER.indexOf(c) + 1;
const SEA = 255;   // 派生途中的海格占位（随后取最近陆格的档）
let zoneMemo: { key: string; d: Gen2Zones } | null = null;
/** z＝各格派生档（0＝不派生）；land＝陆格（编辑示意只画陆上的派生，海格的档只为档界模糊而设） */
export interface Gen2Zones { z: Uint8Array; land: Uint8Array }

/** 分区栅格上的派生档（0＝不派生）：球面图且未设气候档＝纬度带 + 干旱，其余只派生干旱。按（参数, 几何, 是否按纬度）单槽记忆 */
export function gen2Zones(meta: Meta, g: { bb: BBox; pd: number; cols: number; rows: number }): Gen2Zones {
  const p = gen2Params(meta), bands = p.sphere && !CLIMATE_ORDER.includes(meta.climate as Climate);
  const key = JSON.stringify([p, g.bb, g.pd, g.cols, g.rows, bands]);
  if (zoneMemo && zoneMemo.key === key) return zoneMemo.d;
  const M = gen2Macro(meta), z = new Uint8Array(g.cols * g.rows), land = new Uint8Array(g.cols * g.rows), sd = p.seed * 31, arid = zoneIdx("arid"), polar = zoneIdx("polar");
  const latOf = (j: number) => g.bb.latMin + (j + 0.5) * g.pd, lonOf = (i: number) => g.bb.lonMin + (i + 0.5) * g.pd;
  scanMesh(M, g.rows, g.cols, j => (latOf(j) - M.lat0) / M.dlat - 0.5, i => (lonOf(i) - M.lon0) / M.dlon - 0.5, (i, j, I, W) => {
    const lat = latOf(j), lon = lonOf(i), s = at3(M.s, I, W), mo = at3(M.moist, I, W), al = lat < 0 ? -lat : lat;
    if (s < 0) { z[j * g.cols + i] = SEA; return; }
    land[j * g.cols + i] = 1;
    let k = mo < ARID_MOIST && (!p.sphere || al < 55) ? arid : 0;   // 高纬不成干旱区（与荒漠生态的 55° 门同口径）
    if (bands && !k) {
      const P = pointOf(p, lon, lat), ae = al + 4 * fbm3(P.x, P.y, P.z, 1500, 2, sd + 31);   // 带界随噪声南北进退 ±4°
      k = polar;
      for (const [t, cl] of BAND_LAT) if (ae < t) { k = zoneIdx(cl); break; }
    }
    z[j * g.cols + i] = k;
  });
  /* 海格取最近陆格的档（4 邻多源扩张，按格序入队）：海上另起一档会在档界模糊时把沿岸陆地稀释成别的气候 */
  const n = g.cols * g.rows, queue = new Int32Array(n);
  let qh = 0, qt = 0;
  for (let i = 0; i < n; i++) if (z[i] !== SEA) queue[qt++] = i;
  while (qh < qt) {
    const i = queue[qh++], r = (i / g.cols) | 0, c = i - r * g.cols;
    for (let k = 0; k < 4; k++) {
      const nr = r + D4R[k], nc = c + D4C[k]; if (nr < 0 || nc < 0 || nr >= g.rows || nc >= g.cols) continue;
      const q = nr * g.cols + nc; if (z[q] === SEA) { z[q] = z[i]; queue[qt++] = q; }
    }
  }
  if (!qt) z.fill(0);   // 全图无陆
  zoneMemo = { key, d: { z, land } };
  return zoneMemo.d;
}

function buildFine(p: Gen2Params, M: Macro, g: FieldGeom): Gen2Fine {
  const { bb, step, cols, rows } = g, n = cols * rows, sd = p.seed * 31, SHORE_M = SHORE_U * p.unitM, isl = p.style === "isles";
  const R = p.kmd * 180 / PI;
  const cp = new Float64Array(rows), sp = new Float64Array(rows), cl = new Float64Array(cols), sl = new Float64Array(cols);
  for (let r = 0; r < rows; r++) { const lat = bb.latMin + (r + 0.5) * step; cp[r] = p.sphere ? cosD(lat) : 1; sp[r] = p.sphere ? sinD(lat) : lat; }
  for (let c = 0; c < cols; c++) { const lon = bb.lonMin + (c + 0.5) * step; cl[c] = p.sphere ? cosD(lon) : lon; sl[c] = p.sphere ? sinD(lon) : 0; }
  const ptX = (r: number, c: number) => p.sphere ? R * cp[r] * cl[c] : cl[c] * p.kmd;
  const ptY = (r: number, c: number) => p.sphere ? R * cp[r] * sl[c] : sp[r] * p.kmd;
  const ptZ = (r: number) => p.sphere ? R * sp[r] : 0;
  /* 第一趟：在宏观三角网上取宏观场，近岸格加海岸噪声 */
  const S = new Float64Array(n), SW = new Float64Array(n), E = new Float64Array(n), RL = new Float64Array(n), MO = new Float64Array(n), WT = new Float64Array(n), SA = new Float64Array(n);
  const LK = new Int32Array(n).fill(-1), LF = new Float64Array(n);
  const Ms = M.s, Mh = M.h, Mr = M.relief, Mm = M.moist, Mw = M.wet, Ml = M.lake, Mf = M.shelf, Ma = M.camp;
  /* 海岸噪声接着宏观格往细里取，到每波长 ≥2.5 格为止；只在幅度够得着海岸的格上算（band＝细倍频幅度和） */
  let kf = M.coastK, fineSum = 0;
  for (let a = 1, k = 0; k < COAST_OCT; k++, a *= COAST_G) if (k >= M.coastK && M.coastLam / (1 << k) >= 2.5 * step * p.kmd) { kf = k + 1; fineSum += a; }
  fineSum /= COAST_NORM;
  const deep = new Uint8Array(n);
  const Md = M.mid, Mc = M.cwarp;
  scanMesh(M, rows, cols, r => (bb.latMin + (r + 0.5) * step - M.lat0) / M.dlat - 0.5, c => (bb.lonMin + (c + 0.5) * step - M.lon0) / M.dlon - 0.5, (c, r, I, W) => {
    const i = r * cols + c, a = I[0], b = I[1], d = I[2], wa = W[0], wb = W[1], wd = W[2];
    let s = at3(Ms, I, W);
    const band = 2 * at3(Ma, I, W) * fineSum;   // 两倍带宽、向带边渐收：带边一刀切会在陆架深浅上留缝
    if (s > -band && s < band) {
      const md = at3(Md, I, W), u = s / band;
      const ox = Mc[3 * a] * wa + Mc[3 * b] * wb + Mc[3 * d] * wd, oy = Mc[3 * a + 1] * wa + Mc[3 * b + 1] * wb + Mc[3 * d + 1] * wd, oz = Mc[3 * a + 2] * wa + Mc[3 * b + 2] * wb + Mc[3 * d + 2] * wd;
      s += 0.5 * band / fineSum * (1 - u * u) * coastOct(ptX(r, c) + ox, ptY(r, c) + oy, ptZ(r) + oz, M.coastLam, M.coastK, kf, sd + 5, md);
    }
    else if (s <= -band) deep[i] = 1;
    S[i] = s; E[i] = at3(Mh, I, W); RL[i] = at3(Mr, I, W); MO[i] = at3(Mm, I, W); WT[i] = at3(Mw, I, W); SW[i] = at3(Mf, I, W); SA[i] = at3(M.salt, I, W);
    if ((Ml[a] & Ml[b] & Ml[d]) === -1) return;   // 三个顶点都不是湖（−1 的位与仍是 −1）
    let lw = 0, best = -1;
    for (let k = 0; k < 3; k++) if (Ml[I[k]] >= 0) { lw += W[k]; if (W[k] > best) { best = W[k]; LK[i] = Ml[I[k]]; } }
    LF[i] = lw;
  });
  /* 三角网上的线性插值在三角形边上折出棱，平缓处露成面片：按约四分之一宏观格的半径磨一遍，大形不动 */
  boxBlur3(E, cols, rows, Math.round(MESH_SMOOTH * M.dy / (step * p.kmd)));
  /* 海：候选＝陆地度 < 0，且须与无噪声的深海 4 邻连通（噪声在近岸带里造不出内陆水塘）；湖同法，种子＝湖心 */
  const water = new Uint8Array(n), lakeOf = new Int32Array(n).fill(-1), queue = new Int32Array(n);
  let qh = 0, qt = 0;
  for (let i = 0; i < n; i++) if (deep[i]) { water[i] = 1; queue[qt++] = i; }
  while (qh < qt) {
    const i = queue[qh++], r = (i / cols) | 0, c = i - r * cols;
    for (let k = 0; k < 4; k++) {
      const nr = r + D4R[k], nc = c + D4C[k]; if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      const j = nr * cols + nc; if (!water[j] && S[j] < 0) { water[j] = 1; queue[qt++] = j; }
    }
  }
  qh = qt = 0;
  for (let i = 0; i < n; i++) if (!water[i] && LK[i] >= 0 && LF[i] >= 0.75 && E[i] < M.lakeS[LK[i]]) { lakeOf[i] = LK[i]; queue[qt++] = i; }
  while (qh < qt) {
    const i = queue[qh++], r = (i / cols) | 0, c = i - r * cols, id = lakeOf[i];
    for (let k = 0; k < 4; k++) {
      const nr = r + D4R[k], nc = c + D4C[k]; if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      const j = nr * cols + nc;
      if (!water[j] && lakeOf[j] < 0 && LK[j] === id && LF[j] >= 0.25 && E[j] < M.lakeS[id]) { lakeOf[j] = id; queue[qt++] = j; }
    }
  }
  /* 湖与海之间至少隔一格陆地（含斜邻）：海岸噪声切穿湖岸、湖和海连成一片，渲染端就把整片当海、水面钉在 0 */
  for (let i = 0; i < n; i++) {
    if (lakeOf[i] < 0) continue;
    const r = (i / cols) | 0, c = i - r * cols;
    for (let k = 0; k < 8 && lakeOf[i] >= 0; k++) { const nr = r + D8R[k], nc = c + D8C[k]; if (nr >= 0 && nc >= 0 && nr < rows && nc < cols && water[nr * cols + nc]) lakeOf[i] = -1; }
  }
  /* 两个湖之间也至少隔一格陆地：连成一片时渲染端按岸线最低处取一个水面，湖面高的那个湖底露出来画成陆。退湖面高的一方 */
  const lk0 = Int32Array.from(lakeOf);
  for (let i = 0; i < n; i++) {
    const id = lk0[i]; if (id < 0) continue;
    const r = (i / cols) | 0, c = i - r * cols;
    for (let k = 0; k < 8; k++) {
      const nr = r + D8R[k], nc = c + D8C[k]; if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      const o = lk0[nr * cols + nc];
      if (o >= 0 && o !== id && (M.lakeS[o] < M.lakeS[id] || M.lakeS[o] === M.lakeS[id] && o < id)) { lakeOf[i] = -1; break; }
    }
  }
  /* 溢出口：每个细格湖体取岸线上最低的陆格、高程恰为湖面——core/elev 的水面取岸线最低陆格，其余岸格夹到湖面以上，
     不定这一格时粗网格上整圈岸都高于溢出口，水面就被抬高 */
  const outlet = new Int32Array(n).fill(-1), comp = new Int32Array(n).fill(-1);
  for (let s0 = 0; s0 < n; s0++) {
    if (lakeOf[s0] < 0 || comp[s0] >= 0) continue;
    let qa = 0, qb = 0, best = -1; comp[s0] = s0; queue[qb++] = s0;
    while (qa < qb) {
      const i = queue[qa++], r = (i / cols) | 0, c = i - r * cols;
      for (let k = 0; k < 4; k++) {
        const nr = r + D4R[k], nc = c + D4C[k]; if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const j = nr * cols + nc;
        if (lakeOf[j] >= 0) { if (comp[j] < 0) { comp[j] = s0; queue[qb++] = j; } }
        else if (!water[j] && (best < 0 || E[j] < E[best] || (E[j] === E[best] && j < best))) best = j;
      }
    }
    if (best >= 0) outlet[best] = lakeOf[s0];
  }
  /* 距离：水格到最近陆格（陆架）、陆格到最近海格（沿海带），km */
  const kmx = new Float64Array(rows);
  for (let r = 0; r < rows; r++) kmx[r] = step * p.kmd * (p.sphere ? Math.max(0.05, cp[r]) : 1);
  const kmy = step * p.kmd;
  const dLand = new Float64Array(n), dSea = new Float64Array(n);
  for (let i = 0; i < n; i++) { const w = water[i] || lakeOf[i] >= 0; dLand[i] = w ? Infinity : 0; dSea[i] = water[i] ? 0 : Infinity; }
  chamfer(dLand, cols, rows, kmx, kmy); chamfer(dSea, cols, rows, kmx, kmy);
  /* 第二趟：基底（米）与地类 */
  const base = new Float32Array(n), lfIdx = new Uint8Array(n), cf = new Uint8Array(n), cells: string[][] = [];
  /* 陆架＝淹在海面下的低缓陆地：按陆地度取深浅（陆架宽折成陆地度），宽窄跟着海岸带的缓急走，近岸岛连在同一片浅水上；
     离岸超过两倍陆架宽一律往深里走，大洋中间不冒出孤零零的浅滩 */
  const shelf = (s: number, w: number, dl: number): number => {
    const z = Math.max(-s * M.kmPerS / w, dl / (isl ? w : 2 * w));
    return z <= 1 ? SHORE_M - (SHELF_BREAK_M + SHORE_M) * z : -SHELF_BREAK_M - (z - 1) * w * 1000 * SLOPE_TAN;
  };
  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    const lat = bb.latMin + (r + 0.5) * step, al = lat < 0 ? -lat : lat, tree = treeOf(p, lat);
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      let e: number, k: number;
      if (water[i]) { e = shelf(S[i], SW[i], dLand[i]); k = WATER_CLS; }
      else if (lakeOf[i] >= 0) { e = Math.min(E[i], M.lakeS[lakeOf[i]] + SHORE_M); k = WATER_CLS; }
      else {
        e = Math.max(1, E[i]);
        for (let d = 0; d < 4; d++) {   // 湖岸不低于湖面：水面取岸线最低陆格（core/elev），湖面才＝溢出口
          const nr = r + D4R[d], nc = c + D4C[d]; if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const id = lakeOf[nr * cols + nc]; if (id >= 0 && e < M.lakeS[id]) e = M.lakeS[id];
        }
        if (outlet[i] >= 0) e = M.lakeS[outlet[i]];
        const mo = MO[i];
        cf[i] = (dSea[i] <= 15 ? CF_COAST : 0) | (SA[i] >= 0.5 ? CF_SALT : 0) | (mo > 0.42 && WT[i] > WET_MARSH ? CF_MARSH : 0)
          | (mo < 0.14 && (!p.sphere || al < 55) ? CF_DESERT : 0) | (mo < 0.26 ? CF_GRASS : 0) | (mo > 0.48 ? CF_FOREST : 0);
        k = classOf(e, RL[i], cf[i], tree);
      }
      base[i] = e / p.unitM; lfIdx[i] = (k / ECOS.length) | 0;
      row.push(COMP[k]);
    }
    cells.push(row);
  }
  return { cells, base, lf: lfIdx, sea: water, macro: M, lakeOf, outlet, cf };
}
const WET_MARSH = 5000;   // 水量（m³/s）÷ 坡度（米/km）

/** 8 邻倒角距离（两趟），逐行经向格距 */
function chamfer(d: Float64Array, cols: number, rows: number, kx: Float64Array, ky: number): void {
  for (let r = 0; r < rows; r++) {
    const cx = kx[r], cd = Math.sqrt(cx * cx + ky * ky);
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c; let v = d[i];
      if (c > 0 && d[i - 1] + cx < v) v = d[i - 1] + cx;
      if (r > 0) { if (d[i - cols] + ky < v) v = d[i - cols] + ky; if (c > 0 && d[i - cols - 1] + cd < v) v = d[i - cols - 1] + cd; if (c < cols - 1 && d[i - cols + 1] + cd < v) v = d[i - cols + 1] + cd; }
      d[i] = v;
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    const cx = kx[r], cd = Math.sqrt(cx * cx + ky * ky);
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c; let v = d[i];
      if (c < cols - 1 && d[i + 1] + cx < v) v = d[i + 1] + cx;
      if (r < rows - 1) { if (d[i + cols] + ky < v) v = d[i + cols] + ky; if (c < cols - 1 && d[i + cols + 1] + cd < v) v = d[i + cols + 1] + cd; if (c > 0 && d[i + cols - 1] + cd < v) v = d[i + cols - 1] + cd; }
      d[i] = v;
    }
  }
}

/* —— 中尺度稳态（网格分辨率）：宏观场插到细格、在细格三角网上再解一层河流功率律，补出主脊、支谷与山麓的层次 ——
   湖仍由宏观定（画的盆地除外）；这里给连续基底、起伏包络与按最终地表重抽的河，并按自己的基底重判陆格地类。 */
/** 稳态的高程标度（米 / 抬升单位）与河道起始面积（km²） */
export const MESO_KAPPA_M = 650, MESO_ACRIT_KM2 = 100;
/** 源头修正系数（steady 的 SteadyInput.head）：格面积大过河道起始面积时补上格内没解析的河源，同一张图换格边山高才相当 */
export const MESO_HEAD = 0.75;
/** 宏观场插到细格后的磨平半径（宏观格边的倍数）：三角形边上的折痕与初值的格边折痕会被稳态解放大成直线 */
const MESO_SMOOTH = 0.5;
/** 平原渐变（宏观抬升）：低于 U0 照宏观面、高于 U1 全取中尺度解；低于宏观面的部分按权重三次方渐入，山脚不出环形浅槽 */
export const MESO_PLAIN_U0 = 0.12, MESO_PLAIN_U1 = 0.45;
/** 起伏包络：宏观抬升从 U0 到 U1 渐满，汇流面积（km²）从 A0 到 A1 渐退（按四次方根插）——坡面上有起伏纹理，河谷与平原上没有 */
const MESO_ENV_U0 = 0.15, MESO_ENV_U1 = 0.8, MESO_ENV_A0 = 500, MESO_ENV_A1 = 20000;
/** 陆格抬升地板：近岸陆格会插到宏观海节点的抬升（≤ 0），负增量让节点比下游还低、流向每轮来回翻、永不收敛；取在宏观陆地的低抬升底（0.06–0.11）之下 */
export const MESO_U_MIN = 0.05;
/** 稳态轮数上限：到流向树不变即停，撞上限也确定 */
const MESO_MAXIT = 300;
/** 收尾的格子尺度平滑核（5×5 二项式，约 1 格）：纯河流功率律在节点尺度带划痕 */
const MESO_KERN = [1, 4, 6, 4, 1];
/** 平滑按图幅渐入（√(宽×高)，km）：小于 KM0 取地板 MIN、大于 KM1 满核——大图要概括；小图多留些多峰结构，但节点尺度的折角仍要磨掉 */
const MESO_GEN_KM0 = 1000, MESO_GEN_KM1 = 3000, MESO_GEN_MIN = 0.3;
const mesoGenOf = (p: Gen2Params): number => { const [w, h] = extentKm(p); return MESO_GEN_MIN + (1 - MESO_GEN_MIN) * sstep((Math.sqrt(w * h) - MESO_GEN_KM0) / (MESO_GEN_KM1 - MESO_GEN_KM0)); };
/** 这张图的收尾平滑强度（0..1，按图幅渐入，见 MESO_GEN_*） */
export const mesoSmoothOf = (meta: Meta): number => mesoGenOf(gen2Params(meta));
/** 陆格 i 的平滑模板，写进 at / w 的前若干项（至多 25）并返回项数：(1 − a)·自身 + a·（5×5 内的陆格按核权重归一，出口不参与）；
    a 为 0 就是自身、权 1。收尾与画抬升量峰同用这一份，量到的就是收尾的值 */
function landStencil(i: number, a: number, out: Uint8Array, cols: number, rows: number, at: Int32Array, w: Float64Array): number {
  if (!(a > 0)) { at[0] = i; w[0] = 1; return 1; }
  const r = (i / cols) | 0, c = i - r * cols;
  let ws = 0, m = 0;
  for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
    const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
    const j = rr * cols + cc; if (out[j]) continue;
    const k = MESO_KERN[dr + 2] * MESO_KERN[dc + 2]; at[m] = j; w[m] = k; m++; ws += k;
  }
  for (let t = 0; t < m; t++) w[t] = (at[t] === i ? 1 - a : 0) + a * w[t] / ws;
  return m;
}

/** 中尺度算法代号：中尺度的数学或常数变了就加一，缓存键随之换代（旧解不许还魂） */
export const MESO_VER = 3;
/** 中尺度稳态的解：高程（米）与流向。缓存这两样就够——汇流面积由流向重积（treeArea），与现解逐位同 */
export interface Gen2Sg { h: Float64Array; rcv: Int32Array }
/** 中尺度的产出（网格分辨率）：base＝连续基底（抽象单位；水格照 gen2Fine.base）· env＝起伏包络 0..1（水格 0）·
    cls＝复合类号（地貌序号 × 生态档数 + 生态序号，同 constants.compositeIndex）：陆格按 base 重判，水格同 gen2Fine ·
    basin＝画的盆地（位 1＝下沉的支撑格，陆地可低于海面；位 2＝盐滩，侵蚀不填它），没画盆地为 null · water＝盆里积的水的读数表 */
export interface Gen2MesoField { base: Float32Array; env: Float32Array; cls: Uint8Array; basin: Uint8Array | null; water: BasinWaters | null }
/** 收尾的产出外加最终地表上抽的河（随两个河流滑杆变，不进地形） */
interface MesoOut extends Gen2MesoField { rivers: GenRiver[] }
export interface Gen2Meso extends MesoOut { sg: Gen2Sg; iters: number; converged: boolean; st: MesoState }
/** 中尺度的内容键：生成参数 + 网格几何 + 算法代号——同键＝同解（gen2Meso 确定性） */
export function mesoKey(meta: Meta, g: FieldGeom): string {
  return "m" + MESO_VER + ":" + JSON.stringify([gen2Params(meta), g.bb, g.step, g.cols, g.rows]);
}

/* —— 岩性带：褶皱带里硬软岩层平行造山带，K 按带分档。带的坐标取宏观抬升 U/Umax（等值线平行造山带），每 1/bandN 一条，
   叠两个倍频的三维噪声当褶皱弯曲，带号整数哈希查五档倍率表。静态场，中尺度与块层同一函数、各在自己的格心取 —— */
/** 目标带宽（km）· 最硬对最软 ＝ c² · 弯曲波长（km）· 弯曲幅度（带数；|弯| 中位约 0.24 条带） */
export const BAND_KM = 8, BAND_CONTRAST = 3.2, BAND_BEND_KM = 60, BAND_BEND = 1.16;
/** 带只属于造山带：U/Umax 低于 U0 倍率恒 1、到 U1 满幅渐入（低地与平台整片落在同一带号上，不渐入＝半张图的低地拿同一个倍率）；带数的梯度中位也只看 U0 以上 */
export const BAND_U0 = 0.1, BAND_U1 = 0.2;
/** 折皱带里也只有一部分露出成层岩性：按 BAND_VAR_KM 尺度的噪声开关，约四成折皱带满幅、其余不显 */
export const BAND_VAR_KM = 1500;
const BAND_TAB = [1 / BAND_CONTRAST, 1 / Math.sqrt(BAND_CONTRAST), 1, Math.sqrt(BAND_CONTRAST), BAND_CONTRAST];
/** 带规格：umax＝宏观抬升最大值 · bandN＝U/Umax 从 0 到 1 切几条带（0＝没有带，倍率恒 1） */
export interface BandSpec { umax: number; bandN: number }
const bandMemo = new WeakMap<Macro, BandSpec>();
/** 带数按目标带宽与 U/Umax 的梯度中位数反推：陆地节点（U > 0.1·Umax）各按邻点最小二乘求切面梯度（法向加一项压住），取 |∇| 的中位。只随宏观，换网格不变 */
export function bandSpecOf(M: Macro, p: Gen2Params): BandSpec {
  const hit = bandMemo.get(M);
  if (hit) return hit;
  const { mesh, U, land, lon0, lat0, dlon, dlat } = M, n = U.length, g: number[] = [];
  let umax = 0;
  for (let i = 0; i < n; i++) if (U[i] > umax) umax = U[i];
  if (umax > 0) {
    const P: Pt[] = new Array(n), Us = new Float64Array(n);
    for (let i = 0; i < n; i++) P[i] = pointOf(p, lon0 + (mesh.X[i] + 0.5) * dlon, lat0 + (mesh.Y[i] + 0.5) * dlat);
    for (let i = 0; i < n; i++) {   // 磨半格再求梯度：中尺度场就是按半个宏观格磨过的，节点间的抖动不算带
      let s = 0, m = 0;
      for (let e = mesh.nbOff[i]; e < mesh.nbOff[i + 1]; e++) { s += U[mesh.nb[e]]; m++; }
      Us[i] = m ? 0.5 * U[i] + 0.5 * s / m : U[i];
    }
    for (let i = 0; i < n; i++) {
      if (!land[i] || U[i] < BAND_U0 * umax) continue;
      const a = P[i], N = p.sphere ? norm(a) : { x: 0, y: 0, z: 1 };
      let axx = 0, axy = 0, axz = 0, ayy = 0, ayz = 0, azz = 0, bx = 0, by = 0, bz = 0;
      for (let e = mesh.nbOff[i]; e < mesh.nbOff[i + 1]; e++) {
        const b = P[mesh.nb[e]], x = b.x - a.x, y = b.y - a.y, z = b.z - a.z, du = (Us[mesh.nb[e]] - Us[i]) / umax;
        axx += x * x; axy += x * y; axz += x * z; ayy += y * y; ayz += y * z; azz += z * z; bx += du * x; by += du * y; bz += du * z;
      }
      const t = axx + ayy + azz;   // 法向压项按邻点距离的量级给：邻点都近乎在切面上，不压则法向分量把噪声放大
      axx += t * N.x * N.x; axy += t * N.x * N.y; axz += t * N.x * N.z; ayy += t * N.y * N.y; ayz += t * N.y * N.z; azz += t * N.z * N.z;
      const det = axx * (ayy * azz - ayz * ayz) - axy * (axy * azz - ayz * axz) + axz * (axy * ayz - ayy * axz);
      if (!(det > 0)) continue;
      const gx = (bx * (ayy * azz - ayz * ayz) - axy * (by * azz - ayz * bz) + axz * (by * ayz - ayy * bz)) / det;
      const gy = (axx * (by * azz - ayz * bz) - bx * (axy * azz - ayz * axz) + axz * (axy * bz - by * axz)) / det;
      const gz = (axx * (ayy * bz - by * ayz) - axy * (axy * bz - by * axz) + bx * (axy * ayz - ayy * axz)) / det;
      const m = Math.sqrt(gx * gx + gy * gy + gz * gz);
      if (m > 0) g.push(m);
    }
  }
  g.sort((a, b) => a - b);
  const gm = g.length ? g[g.length >> 1] : 0, spec = { umax, bandN: gm > 0 ? 1 / (BAND_KM * gm) : 0 };
  bandMemo.set(M, spec);
  return spec;
}
/** 一点的岩性带 K 倍率：uRel＝U/Umax · g＝折皱带占比（Macro.fold 插到这一点）· P＝图上点（km）；seed 同中尺度（gen2 的 seed × 31） */
export function bandMultAt(sp: BandSpec, uRel: number, g: number, P: Pt, seed: number): number {
  if (!(sp.bandN > 0) || !(uRel > BAND_U0) || !(g > 0)) return 1;
  const V = BAND_VAR_KM, v = sstep((noise3(P.x / V, P.y / V, P.z / V, seed + 1204) + 0.05) / 0.2);
  if (!(v > 0)) return 1;
  const L = BAND_BEND_KM, L3 = BAND_BEND_KM / 3;
  const bend = BAND_BEND * (noise3(P.x / L, P.y / L, P.z / L, seed + 1201) + 0.5 * noise3(P.x / L3, P.y / L3, P.z / L3, seed + 1202));
  const u = uRel > 1 ? 1 : uRel, b = Math.floor(u * sp.bandN + bend), w = sstep((uRel - BAND_U0) / (BAND_U1 - BAND_U0)) * (g > 1 ? 1 : g) * v;
  return 1 + w * (BAND_TAB[Math.floor(cellRand(b + 1048576, seed + 1203) * 5)] - 1);
}

/** 中尺度求解的准备（网格分辨率）：插值并磨平的宏观场、出口与水面、稳态输入与初值。同一 meta 与几何确定 */
export interface MesoPrep { p: Gen2Params; g: FieldGeom; M: Macro; F: Gen2Fine; fU: Float64Array; fK: Float64Array; fP: Float64Array; fB: Float64Array; fM: Float64Array; fG: Float64Array; inp: SteadyInput; h0: Float64Array; area: Float64Array; gen: number; band: BandSpec }
function mesoPrep(meta: Meta, g: FieldGeom): MesoPrep {
  const p = gen2Params(meta), M = gen2Macro(meta), F = gen2Fine(meta, g), band = bandSpecOf(M, p);
  const { bb, step, cols, rows } = g, n = cols * rows, sd = p.seed * 31;
  const fU = new Float64Array(n), fK = new Float64Array(n), fP = new Float64Array(n), fB = new Float64Array(n), fH = new Float64Array(n), fM = new Float64Array(n), fG = new Float64Array(n);
  scanMesh(M, rows, cols, r => (bb.latMin + (r + 0.5) * step - M.lat0) / M.dlat - 0.5, c => (bb.lonMin + (c + 0.5) * step - M.lon0) / M.dlon - 0.5, (c, r, I, W) => {
    const i = r * cols + c;
    fU[i] = at3(M.U, I, W); fK[i] = at3(M.K, I, W); fP[i] = at3(M.plat, I, W); fB[i] = at3(M.bowl, I, W); fH[i] = at3(M.hRel, I, W); fM[i] = at3(M.moist, I, W); fG[i] = at3(M.fold, I, W);
  });
  const rb = Math.round(MESO_SMOOTH * M.dy / (step * p.kmd));
  for (const f of [fU, fK, fP, fB, fH, fM, fG]) boxBlur3(f, cols, rows, rb);
  /* 节点面积（名义格面积）；求解时才建细格三角网（节点位置取图上点的弦长） */
  const area = new Float64Array(n), kmy = step * p.kmd;
  for (let r = 0; r < rows; r++) {
    const a = kmy * (p.sphere ? Math.max(0.05, cosD(bb.latMin + (r + 0.5) * step)) : 1) * kmy;
    for (let c = 0; c < cols; c++) area[r * cols + c] = a;
  }
  /* 出口＝生成器的水：海 0、湖＝湖面 */
  const out = new Uint8Array(n), hOut = new Float64Array(n), U = new Float64Array(n), K = new Float64Array(n), h0 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lk = F.lakeOf[i];
    if (F.sea[i] || lk >= 0) { out[i] = 1; hOut[i] = lk >= 0 ? M.lakeS[lk] : 0; }
    U[i] = MESO_KAPPA_M * (fU[i] > MESO_U_MIN ? fU[i] : MESO_U_MIN);
    const r = (i / cols) | 0, c = i - r * cols;   // 岩性带在格心取（fK 不含带：块层按自己的细格心再取一次）
    K[i] = fK[i] * (0.8 + 0.4 * cellRand(i, sd + 913)) * bandMultAt(band, fU[i] / band.umax, fG[i], pointOf(p, bb.lonMin + (c + 0.5) * step, bb.latMin + (r + 0.5) * step), sd);
    h0[i] = out[i] ? hOut[i] : MESO_KAPPA_M * fH[i] + 1e-3 * cellRand(i, sd + 17);
  }
  return { p, g, M, F, fU, fK, fP, fB, fM, fG, inp: { U, K, acrit: MESO_ACRIT_KM2, out, hOut, head: MESO_HEAD }, h0, area, gen: mesoGenOf(p), band };
}
/** 中尺度三角网：求解图，外加汇流微地形（米，见 RIV_MICRO_*）与节点位置（格坐标，格 (q, r) 的格心在 (q, r)） */
export interface MesoGraph extends SteadyGraph { micro: Float64Array; X: Float32Array; Y: Float32Array }
/** 细格三角网上的求解图：节点位置取图上点、边长取三维弦长 */
function mesoGraph(pr: MesoPrep): MesoGraph {
  const { p, g: { bb, step, cols, rows }, area } = pr, n = cols * rows, sd = p.seed * 31;
  const { nbOff, nb, X, Y } = buildMesh(cols, rows, sd + 77);
  const PX = new Float64Array(n), PY = new Float64Array(n), PZ = new Float64Array(n), len = new Float64Array(nb.length), micro = new Float64Array(n);
  for (let i = 0; i < n; i++) { const P = pointOf(p, bb.lonMin + (X[i] + 0.5) * step, bb.latMin + (Y[i] + 0.5) * step); PX[i] = P.x; PY[i] = P.y; PZ[i] = P.z; }
  for (let i = 0; i < n; i++) for (let e = nbOff[i]; e < nbOff[i + 1]; e++) {
    const j = nb[e], x = PX[i] - PX[j], y = PY[i] - PY[j], z = PZ[i] - PZ[j]; len[e] = Math.sqrt(x * x + y * y + z * z);
  }
  const [k0, k1] = RIV_MICRO_KM;
  for (let i = 0; i < n; i++) micro[i] = RIV_MICRO_M * (noise3(PX[i] / k0, PY[i] / k0, PZ[i] / k0, sd + 811) + 0.5 * noise3(PX[i] / k1, PY[i] / k1, PZ[i] / k1, sd + 812));
  return { nbOff, nb, len, area, micro, X: Float32Array.from(X.subarray(0, n)), Y: Float32Array.from(Y.subarray(0, n)) };
}
/** 画抬升对收尾的两处改动：du＝叠加的抬升（宏观单位，即求解增量 ÷ MESO_KAPPA_M）· kw＝软边权重（涂抹区内 1）：
    峰顶软上限按它让开、平原渐变按它取满——画的峰高要落在目标上 */
interface MesoUp { du: Float64Array; kw: Float64Array; bas?: BasinRegion[] }
/** 一行（或一列）上半宽 k 的滑窗最大值，就地写回（出界的部分不算）：van Herk–Gil-Werman，sgn −1 即最小值。x / g / h 是长 ≥ len + 2k 的暂存 */
function winMax(f: Float64Array, off: number, stride: number, len: number, k: number, sgn: number, x: Float64Array, g: Float64Array, h: Float64Array): void {
  const w = 2 * k + 1, m = len + 2 * k;
  for (let t = 0; t < m; t++) x[t] = t < k || t >= len + k ? -Infinity : sgn * f[off + (t - k) * stride];
  for (let t = 0; t < m; t++) g[t] = t % w === 0 || x[t] > g[t - 1] ? x[t] : g[t - 1];
  for (let t = m - 1; t >= 0; t--) h[t] = t === m - 1 || (t + 1) % w === 0 || x[t] > h[t + 1] ? x[t] : h[t + 1];
  for (let t = 0; t < len; t++) { const a = h[t], b = g[t + 2 * k]; f[off + t * stride] = sgn * (a > b ? a : b); }
}
/** 方窗（半宽 k 格）内的最大值减最小值 */
function windowRange(s: Float64Array, cols: number, rows: number, k: number): Float64Array {
  const L = Math.max(cols, rows) + 2 * k, x = new Float64Array(L), g = new Float64Array(L), h = new Float64Array(L);
  const hi = Float64Array.from(s), lo = Float64Array.from(s);
  for (const [f, sgn] of [[hi, 1], [lo, -1]] as const) {
    for (let r = 0; r < rows; r++) winMax(f, r * cols, 1, cols, k, sgn, x, g, h);
    for (let c = 0; c < cols; c++) winMax(f, c, cols, rows, k, sgn, x, g, h);
  }
  for (let i = 0; i < hi.length; i++) hi[i] -= lo[i];
  return hi;
}

/** 收尾：格子尺度平滑（landStencil），再同宏观加高原、峰顶软上限、扣盆地，抬升低处渐变回宏观面，守住湖面＝溢出口，
    画的盆里按水量成湖，最终地表上汇流、刻河、抽河，最后按基底重判陆格地类 */
function mesoFinish(st: { pr: MesoPrep; G: MesoGraph }, h: Float64Array, A: Float64Array, up: MesoUp | null, rp: RiverParams): MesoOut {
  const { pr, G } = st, { p, g: { bb, step, cols, rows }, M, F, fU, fP, fB, inp: { out, hOut } } = pr, n = cols * rows, um = p.unitM;
  const base = new Float32Array(n), env = new Float32Array(n);
  const qa0 = Math.sqrt(Math.sqrt(MESO_ENV_A0)), qa1 = Math.sqrt(Math.sqrt(MESO_ENV_A1));
  const at = new Int32Array(25), wt = new Float64Array(25), kneeR = new Float64Array(rows);
  for (let r = 0; r < rows; r++) kneeR[r] = peakKneeM(p.sphere, bb.latMin + (r + 0.5) * step);
  for (let i = 0; i < n; i++) {
    if (out[i]) { base[i] = F.base[i]; continue; }
    const m = landStencil(i, pr.gen, out, cols, rows, at, wt);
    let hs = 0; for (let t = 0; t < m; t++) hs += wt[t] * h[at[t]];
    let v = hs + fP[i];
    v = peakCapM(v, kneeR[(i / cols) | 0], up ? up.kw[i] : 0);
    v -= Math.min(fB[i], BOWL_MAX * v);
    const u = up ? fU[i] + up.du[i] : fU[i];
    let w = sstep((u - MESO_PLAIN_U0) / (MESO_PLAIN_U1 - MESO_PLAIN_U0));
    if (up && up.kw[i] > w) w = up.kw[i];
    const e = (v > 1 ? v : 1) / um, b0 = F.base[i], d = e - b0;
    base[i] = b0 + (d >= 0 ? w : w * w * w) * d;
    env[i] = sstep((u - MESO_ENV_U0) / (MESO_ENV_U1 - MESO_ENV_U0)) * (1 - clamp01((Math.sqrt(Math.sqrt(A[i])) - qa0) / (qa1 - qa0)));
  }
  const wf = up && up.bas && up.bas.length ? sinkBasins(pr, base, env, up.bas) : null;
  /* 湖岸不低于湖面、溢出口恰为湖面（同 buildFine）：渲染端的水面取岸线最低陆格 */
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c; if (out[i]) continue;
    for (let k = 0; k < 4; k++) {
      const nr = r + D4R[k], nc = c + D4C[k]; if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      const id = F.lakeOf[nr * cols + nc]; if (id >= 0 && base[i] < M.lakeS[id] / um) base[i] = M.lakeS[id] / um;
    }
    if (F.outlet[i] >= 0) base[i] = M.lakeS[F.outlet[i]] / um;
  }
  const he = new Float64Array(n);
  for (let i = 0; i < n; i++) he[i] = out[i] ? hOut[i] : base[i] * um;
  const ro = mesoRunoff(pr, he);
  const wet = wf ? basinWater(pr, G, base, env, wf, he, ro) : null;   // 画的盆里积的水：在湖岸钳制之后、刻河之前
  const rt = mesoRoute(pr, G, base, wet, ro);
  carveRivers(pr, G, base, env, rt, wf);
  const rivers = mesoRivers(pr, rt, rp, base);
  /* 地类按这份基底重判（判法同 buildFine）：起伏取半宽一个宏观格的方窗、水格取水面——与宏观起伏同一尺度，门槛才照用 */
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = out[i] ? hOut[i] : wet && wet.lake[i] >= 0 ? wet.lakeS[wet.lake[i]] : base[i] * um;
  const rl = windowRange(s, cols, rows, Math.max(1, Math.round(M.dy / (step * p.kmd)))), cls = new Uint8Array(n);
  for (let r = 0; r < rows; r++) {
    const tree = treeOf(p, bb.latMin + (r + 0.5) * step);
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      cls[i] = out[i] || (wet && wet.lake[i] >= 0) ? WATER_CLS : wet && wet.salt[i] ? SALT_CLS : classOf(s[i], rl[i], F.cf[i], tree);
    }
  }
  let basin: Uint8Array | null = null;   // 位 1＝下沉的支撑格、位 2＝盐滩（内流盆的终点，侵蚀不填它）
  if (wf) { basin = new Uint8Array(n); for (let i = 0; i < n; i++) basin[i] = (wf[i] > 0 ? 1 : 0) | (wet && wet.salt[i] ? 2 : 0); }
  return { base, env, cls, basin, water: wet ? wet.info : null, rivers };
}

/**
 * 中尺度基底：宏观 U / K / 稳态解 / 高原 / 盆地插到网格（g 必须是这张图的地形网格几何）、按半个宏观格磨平，
 * 以生成器的水（海 0、湖＝湖面）为出口解稳态，加高原、扣盆地，抬升低处渐变回宏观面，守住湖面＝溢出口，再在最终地表上刻河、抽河。
 * @param sg 缓存的稳态解（同一 meta 生成参数、同一几何上本函数算出的）：给了就不再求解，只建三角网
 * @returns 收尾的产出与河（河按 meta 的两个河流滑杆抽，地形不随它们变），外加画抬升接着用的求解状态 st
 */
export function gen2Meso(meta: Meta, g: FieldGeom, sg?: Gen2Sg): Gen2Meso {
  const pr = mesoPrep(meta, g), G = mesoGraph(pr);
  let iters = 0, converged = true;
  if (!sg) {
    const S = steady(G, pr.inp, pr.h0, { maxIt: MESO_MAXIT, tol: 0, canon: true });
    sg = { h: S.h, rcv: S.rcv }; iters = S.iters; converged = S.converged;
  }
  const st = stateOf(pr, G, sg);
  return { ...mesoFinish(st, sg.h, st.base.A, null, riverParams(meta)), sg, iters, converged, st };
}

/* —— 画抬升（高程笔在 v2 战略图上）：涂抹区按连通区各自标定，区内最高点到区内最大目标峰高，山体与谷网由中尺度稳态长出 —— */
/** 逐格目标：idx / peakM＝峰高（米，> 0），fidx / floorM＝盆底（米，可为负）；格号升序、同格一项，一格不同时出现在两边 */
export interface UpliftCells { idx: Int32Array; peakM: Float64Array; fidx?: Int32Array; floorM?: Float64Array }
/** 软边（km）：取它与 UPLIFT_SOFT_CELLS 个格边中较大者——消的是格边台阶，格比它粗时不到一格就消不掉 */
const UPLIFT_SOFT_KM = 15, UPLIFT_SOFT_CELLS = 1.5;
const softOf = (p: Gen2Params, step: number): number => Math.max(UPLIFT_SOFT_KM, UPLIFT_SOFT_CELLS * step * p.kmd);
/** 8 邻连通分区：按格号起种，各区成员升序 */
function components8(has: (i: number) => boolean, cols: number, rows: number): number[][] {
  const n = cols * rows, lab = new Int32Array(n).fill(-1), areas: number[][] = [], st: number[] = [];
  for (let i0 = 0; i0 < n; i0++) {
    if (!has(i0) || lab[i0] >= 0) continue;
    const k = areas.length, mem: number[] = [];
    lab[i0] = k; st.push(i0);
    while (st.length) {
      const i = st.pop()!, r = (i / cols) | 0, c = i - r * cols; mem.push(i);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const j = rr * cols + cc; if (has(j) && lab[j] < 0) { lab[j] = k; st.push(j); }
      }
    }
    areas.push(mem.sort((a, b) => a - b));
  }
  return areas;
}
/** 画抬升的求解状态：准备、求解图与 Sg 的完整解（流向、汇流面积、到下游的边长）——Worker 按 mesoKey 留着，每笔只跑标定链 */
export interface MesoState { pr: MesoPrep; G: MesoGraph; base: SteadyResult }
/**
 * @param sg 同一 meta 生成参数与几何上 gen2Meso 的解（现算或缓存，逐位同）：影响带重解的起点，换一份就换一族解
 */
export function mesoState(meta: Meta, g: FieldGeom, sg: Gen2Sg): MesoState {
  const pr = mesoPrep(meta, g);
  return stateOf(pr, mesoGraph(pr), sg);
}
function stateOf(pr: MesoPrep, G: MesoGraph, sg: Gen2Sg): MesoState {
  const n = pr.area.length, { rcv } = sg, rl = new Float64Array(n);
  for (let j = 0; j < n; j++) {   // 到下游的边长：同 steady 的洪泛，取受水者邻接表里第一条指向它的边
    const i = rcv[j]; if (i === j) continue;
    for (let e = G.nbOff[i]; e < G.nbOff[i + 1]; e++) if (G.nb[e] === j) { rl[j] = G.len[e]; break; }
  }
  return { pr, G, base: { h: sg.h, rcv, A: treeArea(rcv, pr.area), rl, iters: 0, converged: true } };
}
/** 画抬升的分区：各区的权重支撑与目标（steady 的 UpliftRegion）· kw 软边权重 · src 权重支撑的并集 · peakAdd 量峰时的反解改正 · soft 软边（km）·
    fw 各区支撑格（同 regions[k].idx）的软边权重（不乘目标比例） */
export interface UpliftSetup { regions: UpliftRegion[]; kw: Float64Array; src: Uint8Array; peakAdd: Float64Array; soft: number; fw: Float64Array[] }
/**
 * 涂到的陆格按 8 邻连通分区，每区的目标＝区内最大峰高；区内权重＝各格目标比例，向外沿三角网按软边渐退（水格不抬）。
 * 量峰的点是区内涂到的格，量的是收尾之后的高程：涂抹格的峰顶软上限让开，按格反解出稳态解要到的高度
 */
export function upliftRegions(st: MesoState, cells: UpliftCells): UpliftSetup {
  const { pr, G } = st, { p, g: { step, cols, rows }, fP, fB, inp } = pr, n = cols * rows, { out } = inp;
  const tgt = new Float64Array(n);
  for (let k = 0; k < cells.idx.length; k++) { const i = cells.idx[k]; if (i >= 0 && i < n && !out[i] && cells.peakM[k] > tgt[i]) tgt[i] = cells.peakM[k]; }
  const areas = components8(i => tgt[i] > 0, cols, rows);   // 各区的涂抹格
  /* 软边：沿三角网到本区涂抹格的路程（多源 Dijkstra，带最近涂抹格的目标比例），只走到 soft 为止 */
  const soft = softOf(p, step);
  const d = new Float64Array(n).fill(Infinity), pay = new Float64Array(n), kw = new Float64Array(n), src = new Uint8Array(n), peakAdd = new Float64Array(n);
  const regions: UpliftRegion[] = [], fw: Float64Array[] = [];
  for (const mem of areas) {
    let T = 0;
    for (const i of mem) if (tgt[i] > T) T = tgt[i];
    const heap = new Heap(64), seen: number[] = [];
    for (const i of mem) { d[i] = 0; pay[i] = tgt[i] / T; heap.push(0, i); seen.push(i); }
    while (heap.n) {
      const i = heap.pop(), di = d[i];
      for (let e = G.nbOff[i]; e < G.nbOff[i + 1]; e++) {
        const j = G.nb[e], v = di + G.len[e];
        if (v < soft && v < d[j]) { if (d[j] === Infinity) seen.push(j); d[j] = v; pay[j] = pay[i]; heap.push(v, j); }
      }
    }
    seen.sort((a, b) => a - b);
    const idx: number[] = [], w: number[] = [], fs: number[] = [];
    for (const i of seen) {
      const f = sstep(1 - d[i] / soft);
      if (!out[i] && f > 0) { idx.push(i); w.push(f * pay[i]); fs.push(f); src[i] = 1; if (f > kw[i]) kw[i] = f; }
      d[i] = Infinity;
    }
    fw.push(Float64Array.from(fs));
    /* 量的是收尾之后的高程：平滑走同一份模板；涂抹格的峰顶软上限让开（kw＝1），只剩加高原、扣盆地——按格反解出平滑值要到的高度 */
    for (const i of mem) {
      const v1 = T + fB[i], need = fB[i] <= BOWL_MAX * v1 ? v1 : T / (1 - BOWL_MAX);
      peakAdd[i] = T - (need - fP[i]);
    }
    const off = [0], sat: number[] = [], sw: number[] = [], ta = new Int32Array(25), tw = new Float64Array(25);
    for (const i of mem) {
      const m = landStencil(i, pr.gen, out, cols, rows, ta, tw);
      for (let t = 0; t < m; t++) { sat.push(ta[t]); sw.push(tw[t]); }
      off.push(sat.length);
    }
    regions.push({ idx: Int32Array.from(idx), w: Float64Array.from(w), peak: Int32Array.from(mem), target: T,
      stencil: { off: Int32Array.from(off), at: Int32Array.from(sat), w: Float64Array.from(sw) } });
  }
  return { regions, kw, src, peakAdd, soft, fw };
}
/* —— 画盆地：涂抹区叠一个光滑下沉场、盆心起伏随泥沙填平（向光滑面插值会抹掉盆缘的谷与脊，岸线成人工湖）；不进稳态（陆上负抬升让流向来回翻）—— */
/** 一区画盆地：支撑格（升序）与碗形权重、量底的涂抹格、目标盆底（米） */
interface BasinRegion { idx: Int32Array; w: Float64Array; floor: Int32Array; target: number }
/**
 * 涂到的陆格（目标盆底）按 8 邻连通分区，目标＝区内最小盆底。权重是碗形：区内到区外的路程最远处为 1，
 * 向区界、再向外过软边平滑降到 0（平底会让淹水次序全是平手）；路程沿三角网量，水格不下沉
 */
function basinRegions(st: MesoState, cells: UpliftCells): BasinRegion[] {
  const fidx = cells.fidx, fm = cells.floorM;
  if (!fidx || !fm || !fidx.length) return [];
  const { pr, G } = st, { p, g: { step, cols, rows }, inp: { out } } = pr, n = cols * rows;
  const tgt = new Float64Array(n).fill(NaN);
  for (let k = 0; k < fidx.length; k++) { const i = fidx[k]; if (i >= 0 && i < n && !out[i] && !(tgt[i] <= fm[k])) tgt[i] = fm[k]; }
  const soft = softOf(p, step), din = new Float64Array(n).fill(Infinity), dout = new Float64Array(n).fill(Infinity), inR = new Uint8Array(n);
  const regs: BasinRegion[] = [];
  for (const mem of components8(i => tgt[i] === tgt[i], cols, rows)) {
    let T = Infinity;
    for (const i of mem) { inR[i] = 1; if (tgt[i] < T) T = tgt[i]; }
    /* 区内：到最近区外节点的路程；区外：到最近涂抹格的路程（到 soft 为止） */
    const hi = new Heap(64), ho = new Heap(64), seen: number[] = [];
    for (const i of mem) {
      dout[i] = 0; ho.push(0, i);
      for (let e = G.nbOff[i]; e < G.nbOff[i + 1]; e++) if (!inR[G.nb[e]] && G.len[e] < din[i]) din[i] = G.len[e];
      if (din[i] < Infinity) hi.push(din[i], i);
    }
    while (hi.n) {
      const i = hi.pop(), di = din[i];
      for (let e = G.nbOff[i]; e < G.nbOff[i + 1]; e++) { const j = G.nb[e], v = di + G.len[e]; if (inR[j] && v < din[j]) { din[j] = v; hi.push(v, j); } }
    }
    while (ho.n) {
      const i = ho.pop(), di = dout[i];
      for (let e = G.nbOff[i]; e < G.nbOff[i + 1]; e++) {
        const j = G.nb[e], v = di + G.len[e];
        if (!inR[j] && v < soft && v < dout[j]) { if (dout[j] === Infinity) seen.push(j); dout[j] = v; ho.push(v, j); }
      }
    }
    let D = 0;
    for (const i of mem) if (din[i] < Infinity && din[i] > D) D = din[i];
    const all = mem.concat(seen).sort((a, b) => a - b), idx: number[] = [], w: number[] = [];
    for (const i of all) {
      const f = sstep(inR[i] ? (soft + (din[i] < Infinity ? din[i] : D)) / (soft + D) : (soft - dout[i]) / (soft + D));
      if (!out[i] && f > 0) { idx.push(i); w.push(f); }
      din[i] = Infinity; dout[i] = Infinity;
    }
    for (const i of mem) inR[i] = 0;
    regs.push({ idx: Int32Array.from(idx), w: Float64Array.from(w), floor: Int32Array.from(mem), target: T });
  }
  return regs;
}
/**
 * 收尾里的下沉（米）：e′ ＝ e − w·(e − 光滑面) − w·Dn，光滑面按软边半径三趟箱式磨平；Dn 闭式取到区内涂抹格的最低点恰为目标，
 * 已在目标以下的区不沉。重叠的区下沉与填平各取最大。起伏包络乘 1 − w。
 * @returns 逐格下沉权重（各区取最大），一区都没沉＝null
 */
function sinkBasins(pr: MesoPrep, base: Float32Array, env: Float32Array, regs: BasinRegion[]): Float64Array | null {
  const { p, g: { step, cols, rows }, inp: { out, hOut } } = pr, n = cols * rows, um = p.unitM;
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) e[i] = out[i] ? hOut[i] : base[i] * um;
  const hS = Float64Array.from(e);
  boxBlur3(hS, cols, rows, Math.max(1, Math.round(softOf(p, step) / (step * p.kmd))));
  const sub = new Float64Array(n), wf = new Float64Array(n), wv = new Float64Array(n);
  let any = false;
  for (const R of regs) {
    for (let t = 0; t < R.idx.length; t++) wv[R.idx[t]] = R.w[t];
    let Dn = Infinity;
    for (const i of R.floor) { const w = wv[i]; if (w > 0) { const d = (e[i] - w * (e[i] - hS[i]) - R.target) / w; if (d < Dn) Dn = d; } }
    for (let t = 0; t < R.idx.length; t++) wv[R.idx[t]] = 0;
    if (!(Dn > 0 && Dn < Infinity)) continue;
    any = true;
    for (let t = 0; t < R.idx.length; t++) { const i = R.idx[t], w = R.w[t]; if (w * Dn > sub[i]) sub[i] = w * Dn; if (w > wf[i]) wf[i] = w; }
  }
  if (!any) return null;
  for (let i = 0; i < n; i++) if (wf[i] > 0) { base[i] = (e[i] - wf[i] * (e[i] - hS[i]) - sub[i]) / um; env[i] *= 1 - wf[i]; }
  return wf;
}

/** 画的盆地里积的水：逐格所属的洼地号（−1 不在任何一个里）与各洼地的结局——kind 0 外流湖 / 1 咸湖 / 2 盐滩 / 3 被海灌进，
    surfM 水面（盐滩取盆底最低处），areaKm2 水面或盐滩面积 */
export interface BasinWaters { at: Int16Array; list: { kind: 0 | 1 | 2 | 3; surfM: number; areaKm2: number }[] }
/** lake / lakeS 逐格湖号与各湖湖面（米）· kinds 各湖 0 外流 / 1 咸湖 · seaIn 各湖是否被海灌进 · salt 盐滩格 */
interface BasinWet { lake: Int32Array; lakeS: number[]; kinds: (0 | 1 | 2)[]; seaIn: boolean[]; salt: Uint8Array; info: BasinWaters | null }
/** 内流湖至少多大（km²）：平衡面积不到它的内流盆是盐滩 */
const BASIN_LAKE_KM2 = 300;
/**
 * 画盆地的水量平衡（同宏观那套搬到中尺度三角网）：自海与生成器的湖填洼，只认含下沉权重 > 0.5 的格的洼地；
 * 入流取填平地表上的汇流水量，平衡湖面积＝入流 ÷ 湖面净蒸发。够大或溢出口离海面不到 ENDO_RIM_M＝外流湖（湖面＝溢出口），
 * 否则自盆底淹起：够平衡面积成咸湖（干处外圈一圈盐滩），不够成盐滩。画的盆不填平。
 * 写回 base 的三条渲染约束同 buildFine：湖床 ≤ 湖面 + SHORE_U、岸格 ≥ 湖面且最低那格恰为湖面、新湖与别的水和图幅边隔一格；
 * 溢出口贴着海面又挨着海的盆是被海灌进，就与海连成一片
 */
function basinWater(pr: MesoPrep, G: SteadyGraph, base: Float32Array, env: Float32Array, wf: Float64Array, h: Float64Array, ro: Runoff): BasinWet | null {
  const { p, g: { cols, rows }, F, area, inp: { out } } = pr, n = cols * rows, um = p.unitM, { nbOff, nb, len } = G;
  /* 填洼：出口＝生成器的水（海 0、湖＝湖面），沿三角网 */
  const f = Float64Array.from(h), seen = new Uint8Array(n), heap = new Heap(64);
  for (let i = 0; i < n; i++) if (out[i]) seen[i] = 1;
  pushRim(heap, seen, f, nbOff, nb);
  while (heap.n) {
    const i = heap.pop(), fi = f[i];
    for (let e = nbOff[i]; e < nbOff[i + 1]; e++) { const j = nb[e]; if (seen[j]) continue; seen[j] = 1; if (f[j] < fi) f[j] = fi; heap.push(f[j], j); }
  }
  /* 画过的洼地：f − h > 0.5 m 连通、含下沉权重 > 0.5 的格 */
  const cid = new Int32Array(n).fill(-1), comps: number[][] = [], st: number[] = [];
  for (let i0 = 0; i0 < n; i0++) {
    if (out[i0] || cid[i0] !== -1 || !(f[i0] - h[i0] > 0.5)) continue;
    const comp: number[] = [], k = comps.length; let mine = false;
    cid[i0] = k; st.push(i0);
    while (st.length) {
      const i = st.pop()!; comp.push(i); if (wf[i] > 0.5) mine = true;
      for (let e = nbOff[i]; e < nbOff[i + 1]; e++) { const j = nb[e]; if (!out[j] && cid[j] === -1 && f[j] - h[j] > 0.5) { cid[j] = k; st.push(j); } }
    }
    comps.push(mine ? comp : []);
  }
  if (!comps.some(c => c.length)) return null;
  /* 填平地表上的汇流水量（同宏观 route，出口＝生成器的水） */
  const { P, E, R, arid } = ro;
  const rcv = new Int32Array(n), rl = new Float64Array(n), order = new Int32Array(n), key = new Float64Array(n), Q = new Float64Array(n);
  let no = 0;
  seen.fill(0);
  for (let i = 0; i < n; i++) if (out[i]) { seen[i] = 1; rcv[i] = i; key[i] = f[i]; }
  pushRim(heap, seen, key, nbOff, nb);
  while (heap.n) {
    const i = heap.pop(); order[no++] = i;
    for (let e = nbOff[i]; e < nbOff[i + 1]; e++) { const j = nb[e]; if (seen[j]) continue; seen[j] = 1; rcv[j] = i; rl[j] = len[e]; key[j] = f[j] > key[i] ? f[j] : key[i]; heap.push(key[j], j); }
  }
  for (let i = 0; i < n; i++) Q[i] = out[i] ? 0 : R[i] * area[i] / 31536;
  for (let o = no - 1; o >= 0; o--) { const i = order[o], j = rcv[i]; if (j === i) continue; const keep = 1 - LOSS_K * arid[i] * rl[i]; Q[j] += keep > 0 ? Q[i] * keep : 0; }
  /* 各洼地的结局 */
  const lake = new Int32Array(n).fill(-1), lakeS: number[] = [], salt = new Uint8Array(n), kinds: (0 | 1 | 2)[] = [], seaIn: boolean[] = [];
  const done: number[] = [];
  for (let k = 0; k < comps.length; k++) {
    const comp = comps[k]; if (!comp.length) { done.push(-1); continue; }
    let Ac = 0, Pm = 0, Em = 0, Qin = 0;
    for (const i of comp) { Ac += area[i]; Pm += P[i] * area[i]; Em += E[i] * area[i]; if (Q[i] > Qin) Qin = Q[i]; }
    const spill = f[comp[0]], Enet = (Em - Pm) / Ac, Aeq = Enet > 0 ? Qin * 31536 / Enet : Infinity;
    if (Aeq >= Ac || spill < ENDO_RIM_M) {
      const id = lakeS.length; lakeS.push(spill); kinds.push(0);
      let sea = false;
      for (const i of comp) { lake[i] = id; for (let e = nbOff[i]; e < nbOff[i + 1] && !sea; e++) if (F.sea[nb[e]]) sea = true; }
      seaIn.push(sea && spill <= 0);   // 溢出口就在海面、挨着海：被海灌进
      done.push(id); continue;
    }
    /* 内流：自盆底淹起，每次淹进水位最低的邻格（同宏观） */
    let bot = comp[0];
    for (const i of comp) if (h[i] < h[bot] || (h[i] === h[bot] && i < bot)) bot = i;
    const ord: number[] = [], lev: number[] = [], fh = new Heap(64), mark = -2 - k;
    fh.push(h[bot], bot); cid[bot] = mark;
    while (fh.n) {
      const lv = fh.k[0], i = fh.pop(); ord.push(i); lev.push(lv);
      for (let e = nbOff[i]; e < nbOff[i + 1]; e++) { const j = nb[e]; if (cid[j] === k) { cid[j] = mark; fh.push(h[j] > lv ? h[j] : lv, j); } }
    }
    const wet = Aeq >= BASIN_LAKE_KM2, want = wet ? Aeq : Math.max(area[bot], SALT_FRAC * Ac);
    let acc = 0, m = 0;
    while (m < ord.length && acc < want) acc += area[ord[m++]];
    if (wet && m === ord.length) {   // 格子太粗、一淹就满：湖面到了溢出口，是外流湖
      const id = lakeS.length; lakeS.push(spill); kinds.push(0); seaIn.push(false);
      for (const i of comp) lake[i] = id;
      done.push(id); continue;
    }
    let m2 = m;   // 干旱区咸湖外圈一圈盐滩（同宏观）
    if (wet && Pm / Ac < SALT_RING_P) for (let a2 = 0; m2 < ord.length && a2 < SALT_RING * Aeq; ) a2 += area[ord[m2++]];
    if (wet) {
      const L = m < ord.length ? 0.5 * (lev[m - 1] + lev[m]) : lev[m - 1], id = lakeS.length;
      lakeS.push(L); kinds.push(1); seaIn.push(false);
      for (let t = 0; t < m; t++) lake[ord[t]] = id;
      for (let t = m; t < m2; t++) salt[ord[t]] = 1;
      done.push(id);
    } else {
      for (let t = 0; t < m; t++) salt[ord[t]] = 1;
      done.push(-1);
    }
  }
  /* 新湖与别的水、图幅边隔一格（含斜邻；两湖挨着退湖面高的一方）；被海灌进的不隔海 */
  const lk0 = Int32Array.from(lake);
  for (let i = 0; i < n; i++) {
    const id = lk0[i]; if (id < 0) continue;
    const r = (i / cols) | 0, c = i - r * cols;
    if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) { lake[i] = -1; continue; }
    for (let d = 0; d < 8; d++) {
      const j = (r + D8R[d]) * cols + c + D8C[d], o = lk0[j];
      if ((out[j] && !(seaIn[id] && F.sea[j])) || (o >= 0 && o !== id && (lakeS[o] < lakeS[id] || (lakeS[o] === lakeS[id] && o < id)))) { lake[i] = -1; break; }
    }
  }
  /* 湖床、岸格与溢出口：每个 4 邻连通的湖体，岸格不低于湖面、最低那格恰为湖面（core/elev 的水面取岸线最低陆格） */
  const body = new Int32Array(n).fill(-1);
  for (let s0 = 0; s0 < n; s0++) {
    if (lake[s0] < 0 || body[s0] >= 0) continue;
    const id = lake[s0], L = seaIn[id] ? 0 : lakeS[id], q = [s0]; let lo = -1;
    body[s0] = s0;
    for (let t = 0; t < q.length; t++) {
      const i = q[t], r = (i / cols) | 0, c = i - r * cols;
      for (let d = 0; d < 4; d++) {
        const rr = r + D4R[d], cc = c + D4C[d]; if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const j = rr * cols + cc;
        if (lake[j] === id) { if (body[j] < 0) { body[j] = s0; q.push(j); } }
        else if (!out[j] && lake[j] < 0) { if (base[j] < L / um) base[j] = L / um; if (lo < 0 || base[j] < base[lo] || (base[j] === base[lo] && j < lo)) lo = j; }
      }
      const bed = (L + SHORE_U * um) / um;
      if (base[i] > bed) base[i] = bed;
      env[i] = 0; salt[i] = 0;
    }
    if (lo >= 0 && !seaIn[id]) base[lo] = L / um;
  }
  /* 按洼地的读数表：外流湖 / 咸湖取湖面与湖面积，盐滩取盆底最低处与盐滩面积 */
  const at = new Int16Array(n).fill(-1), list: BasinWaters["list"] = [], slot = new Int32Array(comps.length).fill(-1);
  for (let k = 0; k < comps.length; k++) {
    const comp = comps[k]; if (!comp.length) continue;
    const id = done[k]; let a = 0, mn = Infinity;
    for (const i of comp) { if (id >= 0 ? lake[i] === id : salt[i]) a += area[i]; if (h[i] < mn) mn = h[i]; }
    if (!(a > 0)) continue;
    slot[k] = list.length;
    list.push({ kind: id >= 0 ? (seaIn[id] ? 3 : kinds[id]) : 2, surfM: id >= 0 ? (seaIn[id] ? 0 : lakeS[id]) : mn, areaKm2: a });
    for (const i of comp) at[i] = slot[k];
  }
  return { lake, lakeS, kinds, seaIn, salt, info: list.length ? { at, list } : null };
}

/* —— 中尺度河网：湖与盐滩定下之后，在最终地表上沿三角网汇流、刻河、抽河（画抬升第 3 步）——
   刻地形只认物理水量，两个河流滑杆只管抽哪些、画多宽：挪滑杆不重算地形。 */
/** 汇流微地形（米）与两档波长（km）：平原上绝对平处水按淹水次序分方向，河走成几何形；只给汇流，地形不动 */
const RIV_MICRO_M = 1, RIV_MICRO_KM = [15, 6];
/** 刻地形的河：水量（m³/s）至少多少 */
const FP_Q = 100;
/** 冲积平原：比降（米/km）不超过它的河段才有；半宽 FP_KW·√水量（km），沿河按 FP_WMOD 幅度、FP_WMOD_KM 波长起伏（免得像一条渠） */
const FP_SMAX = 15, FP_WMOD = 0.35, FP_WMOD_KM = 25;
/** 谷底横坡（米/km）；离河道路程 ÷ 半宽到 FP_CORE 是平的谷底，到 FP_OUT 缓升回原地面 */
const FP_G = 1.5, FP_OUT = 2.2;
/** 河槽下切（米）＝ INC_K·水量^(11/32)，不超过离海面高度的 INC_CAP 成 */
const INC_K = 2, INC_CAP = 0.4;
/** 入海、入湖那一点的水面宽是岸边的几倍（河口展宽；渲染端照逐点宽画成喇叭口），河的 widthM 不计它 */
const RIV_MOUTH = 2;
/** 河线抽稀的容差（格）：节点约一格一个、又顺河道平滑过，离弦不到它的点画出来分不出 */
const RIV_SIMPLIFY = 0.1;
/** 河线平滑（Taubin）：每轮先朝邻点均值收 λ、再按 μ（负）推回，RIV_TAUBIN_N 轮——去掉节点尺度的锯齿而谷尺度的弯不缩 */
const RIV_TAUBIN_L = 0.5, RIV_TAUBIN_M = -0.53, RIV_TAUBIN_N = 2;
/** 曲流强度按比降（米/km）渐入：不陡于 MZ_S0 满档、陡于 MZ_S1 为 0；比降取本点上下游各两个节点的窗 */
const MZ_S0 = 0.5, MZ_S1 = 5;
/** 抽稀时曲流强度偏离两端线性插值到这么多档的点留下：汇合处的 0 与比降转折不被抽掉 */
const MZ_KEEP = 2;
/**
 * 折线抽稀（Douglas–Peucker，P 为格坐标 x、y 交错）：离弦超过 RIV_SIMPLIFY 的点留下，水面宽偏离两端线性插值一成以上的点也留下（汇合处的宽度台阶），
 * 曲流强度偏离线性插值 MZ_KEEP 档以上的也留下（汇合处的 0 要落在点上，渲染端才在那里拉直）。
 * @returns 逐点是否留下，两端恒留
 */
function simplifyLine(P: number[], W: number[], Z: Uint8Array): Uint8Array {
  const m = W.length, keep = new Uint8Array(m), st = [0, m - 1], t2 = RIV_SIMPLIFY * RIV_SIMPLIFY;
  keep[0] = 1; keep[m - 1] = 1;
  while (st.length) {
    const b = st.pop()!, a = st.pop()!;
    if (b - a < 2) continue;
    const ax = P[2 * a], ay = P[2 * a + 1], dx = P[2 * b] - ax, dy = P[2 * b + 1] - ay, L2 = dx * dx + dy * dy;
    let far = -1, fd = 0;
    for (let k = a + 1; k < b; k++) {
      const px = P[2 * k] - ax, py = P[2 * k + 1] - ay, t = L2 > 0 ? clamp01((px * dx + py * dy) / L2) : 0;
      const ex = px - t * dx, ey = py - t * dy, d2 = ex * ex + ey * ey, f = (k - a) / (b - a), wi = W[a] + (W[b] - W[a]) * f, zi = Z[a] + (Z[b] - Z[a]) * f - Z[k];
      const v = d2 > t2 ? d2 : (W[k] - wi > 0.1 * W[k] || wi - W[k] > 0.1 * W[k] || zi >= MZ_KEEP || -zi >= MZ_KEEP) ? t2 : 0;
      if (v > fd) { fd = v; far = k; }
    }
    if (far < 0) continue;
    keep[far] = 1; st.push(a, far, far, b);
  }
  return keep;
}
/** x^(11/32)＝x^(1/4)·x^(1/16)·x^(1/32)：开方链才跨引擎逐位 */
const pow11_32 = (x: number): number => { const a = Math.sqrt(Math.sqrt(x)), b = Math.sqrt(Math.sqrt(a)); return a * b * Math.sqrt(b); };

/** 逐格年径流（mm）、降水、潜在蒸散与干燥度：同宏观 runoffOf，水汽取插到细格的那份；出口格全 0 */
interface Runoff { P: Float64Array; E: Float64Array; R: Float64Array; arid: Float64Array }
function mesoRunoff(pr: MesoPrep, h: Float64Array): Runoff {
  const { p, g: { bb, step, cols, rows }, fM, inp: { out } } = pr, n = cols * rows;
  const P = new Float64Array(n), E = new Float64Array(n), R = new Float64Array(n), arid = new Float64Array(n);
  for (let r = 0; r < rows; r++) {
    const lat = bb.latMin + (r + 0.5) * step;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c; if (out[i]) continue;
      const pi = PREC_MM * Math.max(0, fM[i]), ei = evapAt(p, lat, h[i]);
      P[i] = pi; E[i] = ei; R[i] = runoffMm(pi, ei); arid[i] = aridOf(pi, ei);
    }
  }
  return { P, E, R, arid };
}

/** 最终地表的汇流：rcv 流向（源点指自己）· Q 水量（m³/s）· rl 到下游的边长（km）· order 洪泛序（下游在前；邻居全是源点的源点不在里面）·
    lk 逐格湖号（生成器的湖在前、画的湖接着编）与 lkS 湖面（米；被海灌进的记 0）· sink 源点（海、内流湖、盐滩） */
interface MesoRoute { rcv: Int32Array; Q: Float64Array; rl: Float64Array; order: Int32Array; no: number; lk: Int32Array; lkS: number[]; sink: Uint8Array }
/** 填洼（就地改 base）与汇流，同宏观：自海、内流湖（湖面）与盐滩（自身高程）优先洪泛，外流湖第一次碰到就整湖认领（逐格认领会给一个湖开出几个出口）。
    第一趟所有湖都按湖面当源点、键取 max(本格, 上游键)，没成湖的洼地填到溢出口（同宏观「溢出的浅洼一律填平」；画的盆这时已是湖或盐滩，不动）——
    湖面是生成器定的，湖下游隔着更高的槛也不许把湖岸填高；第二趟外流湖整湖认领、在填平的地表上加微地形定流向（平地上的平手按节点号走成直线），出湖河过的槛由刻河破开。水量＝年径流 × 面积沿流向累积，干处按干燥度与边长沿程损失；湖格自身不产水 */
function mesoRoute(pr: MesoPrep, G: MesoGraph, base: Float32Array, wet: BasinWet | null, ro: Runoff): MesoRoute {
  const { p, M, F, area } = pr, n = base.length, um = p.unitM, { nbOff, nb, len, micro } = G;
  const nL = M.lakeS.length, lk = new Int32Array(n).fill(-1), lkS = M.lakeS.slice(), end = M.lakeEnd.map(v => v === 1);
  if (wet) wet.lakeS.forEach((L, id) => { lkS.push(wet.seaIn[id] ? 0 : L); end.push(wet.kinds[id] === 1 || wet.seaIn[id]); });
  const hr = new Float64Array(n), sink = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    lk[i] = F.lakeOf[i] >= 0 ? F.lakeOf[i] : wet && wet.lake[i] >= 0 ? nL + wet.lake[i] : -1;
    const L = lk[i];
    if (F.sea[i]) sink[i] = 1;
    else if (L >= 0) { hr[i] = lkS[L]; if (end[L]) sink[i] = 1; }
    else { hr[i] = base[i] * um; if ((F.cf[i] & CF_SALT) || (wet && wet.salt[i])) sink[i] = 1; }
  }
  const rcv = new Int32Array(n), rl = new Float64Array(n), order = new Int32Array(n), seen = new Uint8Array(n), key = new Float64Array(n), heap = new Heap(64);
  let no = 0;
  const flood = (lakeSrc: boolean): void => {
    no = 0; seen.fill(0);
    for (let i = 0; i < n; i++) { rcv[i] = i; if (sink[i] || lakeSrc && lk[i] >= 0) { seen[i] = 1; key[i] = hr[i]; } }
    pushRim(heap, seen, key, nbOff, nb);
    while (heap.n) {
      const i = heap.pop(); order[no++] = i;
      for (let e = nbOff[i]; e < nbOff[i + 1]; e++) {
        const j = nb[e]; if (seen[j]) continue;
        seen[j] = 1; rcv[j] = i; rl[j] = len[e]; key[j] = hr[j] > key[i] ? hr[j] : key[i]; heap.push(key[j], j);
        const id = lk[j];
        if (id >= 0) {
          const qs = [j];
          for (let t = 0; t < qs.length; t++) {
            const c = qs[t];
            for (let e2 = nbOff[c]; e2 < nbOff[c + 1]; e2++) {
              const m = nb[e2]; if (seen[m] || lk[m] !== id) continue;
              seen[m] = 1; rcv[m] = c; rl[m] = len[e2]; key[m] = key[j]; heap.push(key[m], m); qs.push(m);
            }
          }
        }
      }
    }
  };
  flood(true);
  for (let i = 0; i < n; i++) {
    if (!seen[i] || sink[i] || lk[i] >= 0 || F.sea[i]) continue;
    if (key[i] > hr[i]) { base[i] = key[i] / um; hr[i] = key[i]; }
    hr[i] += micro[i];
  }
  flood(false);
  const Q = new Float64Array(n);
  for (let i = 0; i < n; i++) Q[i] = lk[i] < 0 ? ro.R[i] * area[i] / 31536 : 0;   // mm·km²/年 → m³/s；海格的径流本就是 0
  for (let o = no - 1; o >= 0; o--) {
    const i = order[o], j = rcv[i]; if (j === i) continue;
    const keep = 1 - LOSS_K * ro.arid[i] * rl[i];
    Q[j] += keep > 0 ? Q[i] * keep : 0;
  }
  return { rcv, Q, rl, order, no, lk, lkS, sink };
}

/** 刻河（就地改 base 与 env）：水量 ≥ FP_Q 的陆上河道沿程不升（下游的槛刻到上游河槽的高度），比降 ≤ FP_SMAX 处再下切 D(Q)，都不低于入的那片水与下游路上的湖岸下界；
    这些河段外加冲积平原——沿三角网离河道 t＝路程 ÷ 半宽，FP_CORE 以内压到「河槽 + FP_G·路程」，到 FP_OUT 渐回原地面，谷底起伏包络随之退。
    下界：陆格 1 m（画的盆地里不设）；湖的 8 邻岸格不低于湖面——core/elev 的湖面取 4 邻岸格最低值（刻低了湖面跟着降），斜邻的基底钳在晕开的水面以上 */
function carveRivers(pr: MesoPrep, G: MesoGraph, base: Float32Array, env: Float32Array, rt: MesoRoute, basin: Float64Array | null): void {
  const { p, g: { bb, step, cols, rows }, F } = pr, n = base.length, um = p.unitM, { nbOff, nb, len } = G, { rcv, Q, rl, order, no, lk, lkS, sink } = rt;
  const land = (i: number): boolean => !F.sea[i] && lk[i] < 0 && !sink[i];
  const surf = (j: number): number => F.sea[j] ? 0 : lk[j] >= 0 ? lkS[lk[j]] : base[j] * um;
  const riv = new Uint8Array(n), fp = new Uint8Array(n), c = new Float64Array(n);
  for (let i = 0; i < n; i++) if (land(i) && rcv[i] !== i && Q[i] >= FP_Q) riv[i] = 1;
  for (let o = no - 1; o >= 0; o--) { const i = order[o], j = rcv[i]; if (riv[i] && land(j) && rcv[j] !== j) riv[j] = 1; }   // 干处沿程蒸发掉回门槛以下的下游照样算（否则上游刻了、下游没刻成坑）
  for (let i = 0; i < n; i++) {
    if (!riv[i]) continue;
    const hi = base[i] * um;
    c[i] = hi;
    if ((hi - surf(rcv[i])) / rl[i] <= FP_SMAX) { fp[i] = 1; c[i] = hi - Math.min(INC_K * pow11_32(Q[i]), INC_CAP * Math.max(0, hi)); }
  }
  for (let o = no - 1; o >= 0; o--) { const i = order[o], j = rcv[i]; if (riv[i] && riv[j] && c[j] > c[i]) c[j] = c[i]; }   // 上游先：槛刻到上游河槽
  /* 湖的 8 邻下界（米，不挨湖为 −∞）；lo 再并上陆格地板（见上） */
  const ll = new Float64Array(n).fill(-Infinity), lo = new Float64Array(n);
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
    const i = r * cols + q, id = lk[i]; if (id < 0) continue;
    for (let k = 0; k < 8; k++) {
      const rr = r + D8R[k], cc = q + D8C[k]; if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      const j = rr * cols + cc; if (lkS[id] > ll[j]) ll[j] = lkS[id];
    }
  }
  for (let i = 0; i < n; i++) { const f = basin && basin[i] > 0 ? -Infinity : 1; lo[i] = ll[i] > f ? ll[i] : f; }
  /* 河槽不低于它最终入的那片水、也不低于下游路上各格的湖岸下界：刻到它们以下，下游被钳回的那格就把上游围成坑 */
  const bl = new Float64Array(n);
  for (let o = 0; o < no; o++) { const i = order[o], j = rcv[i]; bl[i] = j === i || !land(i) ? surf(i) : bl[j] > ll[i] ? bl[j] : ll[i]; if (riv[i] && c[i] < bl[i]) c[i] = bl[i]; }
  /* 冲积平原：多源 Dijkstra，键＝路程 ÷ 源的半宽；不跨水 */
  const src = new Int32Array(n).fill(-1), dist = new Float64Array(n), tk = new Float64Array(n).fill(Infinity), hw = new Float64Array(n), heap = new Heap(64), sd = p.seed * 31;
  for (let i = 0; i < n; i++) {
    if (!fp[i]) continue;
    const P = pointOf(p, bb.lonMin + (i % cols + 0.5) * step, bb.latMin + (((i / cols) | 0) + 0.5) * step), k = FP_WMOD_KM;
    hw[i] = FP_KW * Math.sqrt(Q[i]) * Math.max(0.4, 1 + FP_WMOD * noise3(P.x / k, P.y / k, P.z / k, sd + 913));
    src[i] = i; tk[i] = 0; heap.push(0, i);
  }
  while (heap.n) {
    const t0 = heap.k[0], i = heap.pop(); if (t0 > tk[i]) continue;
    const s0 = src[i];
    for (let e = nbOff[i]; e < nbOff[i + 1]; e++) {
      const j = nb[e]; if (!land(j)) continue;
      const d = dist[i] + len[e], t = d / hw[s0];
      if (t > FP_OUT || t >= tk[j]) continue;
      tk[j] = t; dist[j] = d; src[j] = s0; heap.push(t, j);
    }
  }
  for (let i = 0; i < n; i++) {
    if (!land(i)) continue;
    const h0 = base[i] * um;
    let v = riv[i] && c[i] < h0 ? c[i] : h0;
    const s0 = src[i];
    if (s0 >= 0) {
      const t = tk[i], target = c[s0] + FP_G * dist[i];
      if (v > target) { const w = t <= FP_CORE ? 1 : 1 - sstep((t - FP_CORE) / (FP_OUT - FP_CORE)); v -= w * (v - target); env[i] *= 1 - w; }
    }
    if (v < lo[i]) v = lo[i];
    if (v < h0) base[i] = v / um;
  }
  gridDrain(pr, G, base, rt, lo, land, j => F.sea[j] === 1 || lk[j] >= 0);
}

/**
 * 渲染端按格心双线性插值、地面只沿格边相通：流向斜跨或隔格的一步隔着谷壁，画面上是一个封闭的坑，侵蚀细级还会把它填平。
 * 四邻没有更低格、也不挨水与汇的陆格，流向那步不是四邻时，在两格张成的方框里挑压低最少的四连通阶梯，路上的陆格压到它的高度；
 * 目标都按改之前的地面算、逐格取最小（与先后无关），只降不升。
 * @param G 求解图：流向那步是上坡（汇流微地形让平地上的水爬了一点）时改朝基底最低的邻点——填洼之后它恒不高于本格
 * @param lo 逐格下界（米）：压不到它以下；要压破下界的阶梯不走，没有别的阶梯就不改
 * @param wet 水格：四邻里的水恒是出口，汇（盐滩）不高过本格才是——高原上高过本格的盐滩算出口，那一格就留成坑
 */
function gridDrain(pr: MesoPrep, G: SteadyGraph, base: Float32Array, rt: MesoRoute, lo: Float64Array, land: (i: number) => boolean, wet: (i: number) => boolean): void {
  const { p, g: { cols, rows } } = pr, n = base.length, um = p.unitM, { rcv } = rt, { nbOff, nb } = G;
  const req = new Float64Array(n).fill(Infinity), cost = new Float64Array(64), from = new Int32Array(64), end = new Uint8Array(64);
  for (let i = 0; i < n; i++) {
    let j = rcv[i]; if (j === i || !land(i)) continue;
    if (land(j) && base[j] > base[i]) {
      for (let e = nbOff[i]; e < nbOff[i + 1]; e++) { const k = nb[e]; if (base[k] < base[j] || (base[k] === base[j] && k < j)) j = k; }
      if (base[j] > base[i]) continue;
    }
    const ri = (i / cols) | 0, ci = i - ri * cols, rj = (j / cols) | 0, cj = j - rj * cols;
    const U = rj > ri ? rj - ri : ri - rj, V = cj > ci ? cj - ci : ci - cj;
    if (U + V <= 1 || U > 7 || V > 7) continue;
    let open = false;
    for (let d = 0; d < 4 && !open; d++) {
      const rr = ri + D4R[d], cc = ci + D4C[d]; if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      const k = rr * cols + cc; if (land(k) ? base[k] < base[i] : wet(k) || base[k] <= base[i]) open = true;
    }
    if (open) continue;
    /* 方框 (U+1)×(V+1)：自 i 起每步只朝 j 走一行或一列，碰到水与汇或到 j 即止 */
    const su = rj > ri ? 1 : -1, sv = cj > ci ? 1 : -1, a = base[i] * um, W = V + 1, last = U * W + V;
    let bq = -1, bc = Infinity;
    for (let u = 0; u <= U; u++) for (let w = 0; w <= V; w++) {
      const q = u * W + w, k = (ri + su * u) * cols + ci + sv * w;
      if (q === 0) { cost[0] = 0; from[0] = -1; end[0] = 0; continue; }
      let c0 = Infinity, f0 = -1;
      if (u > 0 && !end[q - W] && cost[q - W] < c0) { c0 = cost[q - W]; f0 = q - W; }
      if (w > 0 && !end[q - 1] && cost[q - 1] < c0) { c0 = cost[q - 1]; f0 = q - 1; }
      end[q] = q === last || !land(k) ? 1 : 0;
      if (!end[q]) { const s = base[k] * um; if (s > a) c0 = lo[k] > a ? Infinity : c0 + (s - a); }
      cost[q] = c0; from[q] = f0;
      if (end[q] && c0 < bc) { bc = c0; bq = q; }
    }
    if (bq < 0) continue;
    for (let q = from[bq]; q > 0; q = from[q]) { const u = (q / W) | 0, k = (ri + su * u) * cols + ci + sv * (q - u * W); if (a < req[k]) req[k] = a; }
  }
  for (let k = 0; k < n; k++) if (req[k] < base[k] * um && req[k] >= lo[k]) base[k] = req[k] / um;
}

/**
 * 抽河（同宏观 extractRivers 的门槛、回差、河头上延与干流规则，搬到最终地表的流向上）：一条河从河头（或出湖口）画到入水、汇进干流、
 * 盐滩或干涸处为止，整段一条、逐点水面宽 ws 沿河连续。河线位置顺河道 Taubin 平滑（本点、下游点、干流来水点）去掉节点尺度的锯齿、留住谷尺度的弯；
 * 入水、出湖的那一头取水格格心：画面上的岸线另有域扭曲与分块，这里估不准，宁可伸进水里由渲染端最后一段渐隐。
 * @param base 最终地表（刻河之后）：逐点曲流强度 mz 按它上面的比降给；两头与有支流汇入的节点恒为 0——渲染端在那里拉直，支流末端才接得上
 */
function mesoRivers(pr: MesoPrep, rt: MesoRoute, rp: RiverParams, base: Float32Array): GenRiver[] {
  const { p, g: { bb, step, cols }, F } = pr, n = rt.rcv.length, { rcv, Q, rl, order, no, lk, sink } = rt, { qmin, wf } = rp, um = p.unitM;
  const X = (i: number): number => i % cols, Y = (i: number): number => (i / cols) | 0;   // 格心：渲染端的谷底在格心（双线性），侵蚀细级的河道也沿格心刻
  const wet = (i: number): boolean => F.sea[i] === 1 || lk[i] >= 0, land = (i: number): boolean => !wet(i) && !sink[i];
  const net = new Uint8Array(n), up = new Uint8Array(n), keep = RIV_KEEP * qmin;
  for (let o = no - 1; o >= 0; o--) {
    const i = order[o], j = rcv[i];
    if (lk[i] >= 0) { if (up[i] && j !== i) up[j] = 1; continue; }
    if (!land(i)) continue;
    if (Q[i] * wf >= qmin || up[i] && Q[i] * wf >= keep) { net[i] = 1; if (j !== i) up[j] = 1; }
  }
  /* 河头往上游：下游先算，河头接上水量最大的来水，够回差就画进河网、成为新的河头；最大的来水出自湖则河从湖起，不延 */
  const big = new Int32Array(n).fill(-1);
  for (let u = 0; u < n; u++) { const i = rcv[u]; if (i !== u && !F.sea[u] && (big[i] < 0 || Q[u] > Q[big[i]] || Q[u] === Q[big[i]] && u < big[i])) big[i] = u; }
  for (let o = 0; o < no; o++) { const i = order[o], u = big[i]; if (net[i] && !up[i] && u >= 0 && land(u) && !net[u] && Q[u] * wf >= keep) { net[u] = 1; up[i] = 1; } }
  /* 干流来水＝水量最大的河网来水或出湖水（同量取小编号）；其余来水画到这个节点为止 */
  const main = new Int32Array(n).fill(-1);
  for (let u = 0; u < n; u++) {
    const i = rcv[u];
    if (i === u || !net[i] || !(net[u] || lk[u] >= 0)) continue;
    const m = main[i];
    if (m < 0 || Q[u] > Q[m] || Q[u] === Q[m] && u < m) main[i] = u;
  }
  /* 河线位置（格坐标）：河网节点顺河道（下游点与干流来水点）Taubin 平滑，两头与汇合处之外才动 */
  const ids: number[] = [], ix = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (net[i]) { ix[i] = ids.length; ids.push(i); }
  const m0 = ids.length, sx = new Float64Array(m0), sy = new Float64Array(m0), tx = new Float64Array(m0), ty = new Float64Array(m0);
  for (let k = 0; k < m0; k++) { sx[k] = X(ids[k]); sy[k] = Y(ids[k]); }
  const pass = (lam: number): void => {
    tx.set(sx); ty.set(sy);
    for (let k = 0; k < m0; k++) {
      const i = ids[k], j = rcv[i], u = main[i];
      if (j === i || !net[j] || u < 0 || !net[u]) continue;
      tx[k] = sx[k] + lam * ((sx[ix[j]] + sx[ix[u]]) / 2 - sx[k]); ty[k] = sy[k] + lam * ((sy[ix[j]] + sy[ix[u]]) / 2 - sy[k]);
    }
    sx.set(tx); sy.set(ty);
  };
  for (let t = 0; t < RIV_TAUBIN_N; t++) { pass(RIV_TAUBIN_L); pass(RIV_TAUBIN_M); }
  const wOf = (i: number): number => Math.max(1, Math.round(RIV_WIDTH * Math.sqrt(Q[i] * wf)));
  const out: GenRiver[] = [];
  const emit = (P: number[], W: number[], Z: Uint8Array, mouth: boolean): void => {
    const keep = simplifyLine(P, W, Z), pts: [number, number][] = [], ws: number[] = [], mz: number[] = [];
    for (let k = 0; k < W.length; k++) {
      if (!keep[k]) continue;
      const x = r4(bb.lonMin + (P[2 * k] + 0.5) * step), y = r4(bb.latMin + (P[2 * k + 1] + 0.5) * step), l = pts[pts.length - 1];
      if (l && l[0] === x && l[1] === y) { if (Z[k] < mz[mz.length - 1]) mz[mz.length - 1] = Z[k]; continue; }   // 并掉的点若是 0，留下的那点也取 0
      pts.push([x, y]); ws.push(W[k]); mz.push(Z[k]);
    }
    if (pts.length >= 2) out.push({ pts, widthM: Math.max(...(mouth ? ws.slice(0, -1) : ws)), ws, mz });
  };
  /* 先走出全部的河（I＝逐点的河网节点，水格与盐滩端点为 −1），记下支流汇入的节点，再定曲流强度、抽稀 */
  const paths: { P: number[]; W: number[]; I: number[]; mouth: boolean }[] = [], jn = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    const u0 = main[s];
    if (!net[s] || u0 >= 0 && lk[u0] < 0) continue;   // 源头：没有河网来水，或干流出自湖
    const P: number[] = [], W: number[] = [], I: number[] = [];
    if (u0 >= 0) { P.push(X(u0), Y(u0)); W.push(wOf(s)); I.push(-1); }   // 出湖：从湖格格心起
    P.push(sx[ix[s]], sy[ix[s]]); W.push(wOf(s)); I.push(s);
    let cur = s, ends = false, len = 1, mouth = false, join = -1;
    for (;;) {
      const j = rcv[cur];
      if (j === cur) { ends = true; break; }
      if (wet(j)) { P.push(X(j), Y(j)); W.push(wOf(cur) * RIV_MOUTH); I.push(-1); ends = mouth = true; break; }   // 入海、入湖：画到水格格心
      if (sink[j]) { P.push(X(j), Y(j)); W.push(wOf(cur)); I.push(-1); ends = true; break; }                          // 盐滩：内流终点
      if (!net[j]) break;                                                                                             // 沿程损失，干涸
      if (main[j] !== cur) { P.push(sx[ix[j]], sy[ix[j]]); W.push(wOf(cur)); I.push(j); ends = true; join = j; break; }   // 汇进干流
      P.push(sx[ix[j]], sy[ix[j]]); W.push(wOf(j)); I.push(j); len++; cur = j;
    }
    if (len < 3 && !ends) continue;   // 半路干掉的短碎河不画
    if (join >= 0) jn[join] = 1;
    paths.push({ P, W, I, mouth });
  }
  /* 比降窗只跨河网节点（节点间距＝流向边长 rl，km）；窗里两端高差取绝对值 */
  const mzOf = (I: number[]): Uint8Array => {
    const m = I.length, Z = new Uint8Array(m), S = new Float64Array(m);
    for (let k = 1; k < m; k++) S[k] = S[k - 1] + (I[k - 1] >= 0 ? rl[I[k - 1]] : 0);
    for (let k = 1; k < m - 1; k++) {
      if (I[k] < 0 || jn[I[k]]) continue;
      let a = k, b = k;
      while (a > k - 2 && I[a - 1] >= 0) a--;
      while (b < k + 2 && I[b + 1] >= 0) b++;
      const L = S[b] - S[a];
      if (!(L > 0)) continue;
      const d = (base[I[a]] - base[I[b]]) * um, sl = (d < 0 ? -d : d) / L;
      Z[k] = Math.floor(MZ_MAX * sstep((MZ_S1 - sl) / (MZ_S1 - MZ_S0)) + 0.5);
    }
    return Z;
  };
  for (const r of paths) emit(r.P, r.W, mzOf(r.I), r.mouth);
  return out;
}

/** 抬升到了目标的一区（标定系数 > 0）：T 目标峰高（米）· mem 涂抹格（升序）· idx / f 支撑格与软边权重——工作档嵌套解按它把细格的峰校到 T */
export interface UpliftPeak { T: number; mem: Int32Array; idx: Int32Array; f: Float64Array }
/** sol＝这份解本身（零个区即 Sg）· up＝收尾叠的抬升、软边权重与抬升到目标的各区（零个区为 null）：块层与工作档的嵌套解照它们 */
export interface Gen2Uplift extends MesoOut { s: Float64Array; iters: number; converged: boolean; sol: { h: Float64Array; rcv: Int32Array; A: Float64Array; rl: Float64Array }; up: { du: Float64Array; kw: Float64Array; regs: UpliftPeak[] } | null }
/**
 * 画抬升：按 upliftRegions 分区，定树标定让各区最高点（收尾之后的高程）恰到目标，不抬就已到目标的区不抬。
 * @param rp 抽河参数（riverParams）：只定画哪些河、多宽，地形不随它变
 * @returns 收尾后的基底与包络（零个区＝与 gen2Meso 逐位同）、河与各区系数
 */
export function gen2Uplift(st: MesoState, cells: UpliftCells, rp: RiverParams): Gen2Uplift {
  const { pr, G, base: B } = st, n = B.h.length, { regions, kw, src, peakAdd, fw } = upliftRegions(st, cells), bas = basinRegions(st, cells);
  if (!regions.length) return { ...mesoFinish(st, B.h, B.A, bas.length ? { du: new Float64Array(n), kw: new Float64Array(n), bas } : null, rp), s: new Float64Array(0), iters: 0, converged: true, sol: { h: B.h, rcv: B.rcv, A: B.A, rl: B.rl }, up: null };
  const S = upliftSolve(G, pr.inp, B, bandOf(G, src, BAND_MARGIN_KM), regions, peakAdd, MESO_MAXIT);
  const du = new Float64Array(n);
  regions.forEach((r, k) => { for (let t = 0; t < r.idx.length; t++) du[r.idx[t]] += S.s[k] * r.w[t] / MESO_KAPPA_M; });
  const regs: UpliftPeak[] = [];
  regions.forEach((r, k) => { if (S.s[k] > 0) regs.push({ T: r.target, mem: r.peak, idx: r.idx, f: fw[k] }); });
  return { ...mesoFinish(st, S.h, S.A, { du, kw, bas }, rp), s: S.s, iters: S.iters, converged: S.converged, sol: { h: S.h, rcv: S.rcv, A: S.A, rl: S.rl }, up: { du, kw, regs } };
}
