/* 河当水体：真宽过门槛的河段由地形渲染器当水画（与湖海同一套水色、近岸带、波纹与岸线，河口与湖海并成一片），
   叠加层只画其余的线。叠加层、GL、CPU 三方共用本文件的这一份：柔化（与曲流）后的折线与逐点宽、判水面的门槛、河段分桶、到河面的有向距离。
   距离按纬度当量的度量：经差乘该段的 lonCos，河的宽窄是地上的真宽，不随取景纬度变。 */
import { activeAt } from "../core/time.ts";
import { certaintyStyle } from "../core/constants.ts";
import { kmPerDeg, lonCos } from "../core/geo.ts";
import { chaikinOpen } from "../core/geometry.ts";
import { mapFrame } from "../core/frame.ts";
import { chaikin1, meanderOf, meanderSeed, type Meander } from "./meander.ts";
import type { BBox, Edge, Meta, World } from "../core/types.ts";

/** 真宽到这么多 CSS 像素起，河段画成水面（地形渲染器画），以下由叠加层画线 */
export const RIVER_WATER_PX = 3;
/** 一桶里至多看这么多段（GLSL 循环上限，CPU 同限）：超了的段取样看不到——分桶后仍超就打警告 */
export const RIV_LOOP = 256;
/** 分桶时按每桶至多这么多段细分桶边（桶数封顶 MAX_BINS，曲流密的地方会超过它，由 RIV_LOOP 兜住） */
const RIV_BIN = 64;
/** GL 河段纹理与索引纹理的宽（texel）：两张都按行主序铺 */
export const RIV_TEX_W = 2048;

/** 判水面的门槛（纬度当量的度）：段两端真宽较窄的那头 ≥ 它才画成水面。叠加层与两个渲染器都比这一个数 */
export const riverThr = (degPerPx: number): number => RIVER_WATER_PX * degPerPx;
const degPerM = (meta: Meta | undefined): number => 1 / 1000 / kmPerDeg(meta);

/** 自由折线河的几何（与缩放无关）。pts / w / g：逐点位置、画宽（米）与判水面的真宽（纬度当量的度，封顶在 widthM——它不计河口展宽，
    展宽那一截推不过门槛）；有曲流时是满幅曲线的，m 另带底线与曲流（叠加层按缩放在两者之间渐入，水面段恒是满幅） */
export interface RiverGeom {
  pts: [number, number][]; w: number[]; g: number[];
  m: { base: [number, number][]; bw: number[]; bg: number[]; M: Meander } | null;
}
const geomMemo = new WeakMap<Edge, { pts: unknown; ws: unknown; mz: unknown; wm: unknown; mk: string; G: RiverGeom }>();
/** 底线：球面图先把经度接成连续的（跨 ±180° 不横穿），Chaikin 两遍柔化，逐点宽 ws 同式插值（没有就整条 widthM）。
    带合法 mz（与 pts 等长）的河再在底线上合成曲流（render/meander），按边对象与它读的每个字段记忆；
    meander＝false 只要底线（叠加层在整条河都弯不起来的缩放下用，不为它合成曲流） */
export function riverGeom(meta: Meta | undefined, e: Edge, meander = true): RiverGeom {
  const raw = e.pts!, mz = meander && Array.isArray(e.mz) && e.mz.length === raw.length ? e.mz : null, mk = mz ? `${(meta || {}).worldModel}|${kmPerDeg(meta)}` : "";
  const hit = mz ? geomMemo.get(e) : undefined;
  if (hit && hit.pts === raw && hit.ws === e.ws && hit.mz === mz && hit.wm === e.widthM && hit.mk === mk) return hit.G;
  const src: [number, number][] = [raw[0]];
  for (let k = 1; k < raw.length; k++) {
    const x = raw[k][0], d = (meta || {}).worldModel === "flat" ? 0 : x - src[k - 1][0];
    src.push(d > 180 || d < -180 ? [x - 360 * Math.round(d / 360), raw[k][1]] : raw[k]);
  }
  const pts = chaikinOpen(src, 2), wm = +(e.widthM as number) || 0, dpm = degPerM(meta);
  const ws = Array.isArray(e.ws) && e.ws.length === raw.length ? chaikin1(e.ws) : null;
  const gOf = (v: number): number => v > 0 ? Math.min(v, wm > 0 ? wm : v) * dpm : 0;
  const w: number[] = [], g: number[] = [];
  for (let k = 0; k < pts.length; k++) { const v = ws ? ws[k] : wm; w.push(v); g.push(gOf(v)); }
  const M = mz ? meanderOf(meta, pts, w, mz, meanderSeed(raw[0])) : null;
  const G: RiverGeom = M ? { pts: M.pts, w: M.w, g: M.w.map(gOf), m: { base: pts, bw: w, bg: g, M } } : { pts, w, g, m: null };
  if (mz) geomMemo.set(e, { pts: raw, ws: e.ws, mz, wm: e.widthM, mk, G });
  return G;
}

/** 一条河最宽处的水面宽（米）：逐点宽的最大值，没有就 widthM */
export function riverWidest(e: Edge): number {
  let v = 0;
  if (Array.isArray(e.ws)) for (const x of e.ws) if (x > v) v = x;
  return v > 0 ? v : +(e.widthM as number) || 0;
}

/** 能当水体画的河：自由折线、确证（可靠性虚线表达不了水面；叠加层 strokeEdge 同门）。时段与图层由调用方判 */
const riverWaterEligible = (e: Edge): boolean =>
  e.type === "river" && Array.isArray(e.pts) && e.pts.length >= 2 && certaintyStyle(e.certainty, "edge").dash === null;

/** 一图一档的河段与分桶（内容不变时 id 不变）。seg 每段 8 个数：两端（相对分桶原点的经纬度）、两端半宽、判水面的真宽、lonCos（度量见文件头）；
    idx＝各桶（起点, 段数）之后接桶内段号，起点是 idx 里的绝对下标，桶内按真宽降序（取样遇到不够宽的就停） */
export interface RiverSet {
  id: number; n: number; seg: Float64Array; gmax: number;
  ox: number; oy: number; bs: number; nx: number; ny: number; idx: Int32Array;
  gs: Float64Array;   // 全部段的真宽降序：数门槛以上有几段
}
/** 渲染选项里的河：一图的河段 + 本帧的判水面门槛（riverThr） */
export interface TerrainRivers { set: RiverSet; thr: number }

const MAX_BINS = 1 << 20;
/** 河段集的档：门槛所在的 2 的整数次幂（纬度当量的度）。一档只收真宽不低于档底的段——放大一档才多收一档的河，
    曲流的密点不进用不着它的缩放 */
export const riverTier = (thr: number): number => Math.floor(Math.log2(thr));
let setN = 0, memo: { w: World; meta: Meta | undefined; year: number; sets: Map<number, RiverSet | null> } | null = null;
const lastOfTier = new Map<number, RiverSet>();
/** 当年在场、能当水体画、真宽够得上本档的河拼成的河段集（按世界对象与档记忆；内容与本档上一份逐位同就沿用上一份）。没有＝null */
export function riverSet(meta: Meta | undefined, world: World | null | undefined, yearNow: number, degPerPx: number): RiverSet | null {
  const thr = riverThr(degPerPx);
  if (!world || !(thr > 0) || !isFinite(thr)) return null;
  const tier = riverTier(thr), floor = 2 ** tier;
  if (!memo || memo.w !== world || memo.meta !== meta || memo.year !== yearNow) memo = { w: world, meta, year: yearNow, sets: new Map() };
  const got = memo.sets.get(tier);
  if (got !== undefined) return got;
  const parts: Float64Array[] = [], f = mapFrame(meta), cx = (f.lonMin + f.lonMax) / 2, dpm = degPerM(meta);
  for (const e of world.edges) {
    if (!riverWaterEligible(e) || !activeAt(e, yearNow)) continue;
    let wtop = +(e.widthM as number) || 0;
    if (!(wtop > 0) && Array.isArray(e.ws)) for (const v of e.ws) if (v > wtop) wtop = v;
    if (!(wtop * dpm >= floor)) continue;   // 整条河够不上档底：不必合成它的几何
    const { a, lo, hi } = segsOf(meta, riverGeom(meta, e), floor, dpm);
    if (!a.length) continue;
    parts.push(a);
    if (!f.sphere) continue;   // 球面图：伸出经度折回域（以图幅中心为轴 ±180°）的河另放一份平移 360° 的
    for (const sh of [lo < cx - 180 ? 360 : 0, hi >= cx + 180 ? -360 : 0]) if (sh) {
      const c = a.slice();
      for (let o = 0; o < c.length; o += 8) { c[o] += sh; c[o + 2] += sh; }
      parts.push(c);
    }
  }
  const prev = lastOfTier.get(tier);
  let set: RiverSet | null = null;
  if (parts.length) {
    const abs = new Float64Array(parts.reduce((s, a) => s + a.length, 0));
    for (let i = 0, o = 0; i < parts.length; o += parts[i].length, i++) abs.set(parts[i], o);
    set = prev && sameAbs(prev, abs) ? prev : buildSet(abs);
    lastOfTier.set(tier, set);
  }
  for (const k of lastOfTier.keys()) if (Math.abs(k - tier) > 2) lastOfTier.delete(k);   // 只留邻近几档（来回缩放时沿用）
  memo.sets.set(tier, set);
  return set;
}
/** 一条河真宽 ≥ floor 的段（每段 8 个数，见 RiverSet）与经度范围；按几何对象记忆最近一档（曲流河的几何是记忆着的，换档或重拼不重算） */
const segMemo = new WeakMap<RiverGeom, { floor: number; dpm: number; a: Float64Array; lo: number; hi: number }>();
function segsOf(meta: Meta | undefined, G: RiverGeom, floor: number, dpm: number): { a: Float64Array; lo: number; hi: number } {
  const hit = segMemo.get(G);
  if (hit && hit.floor === floor && hit.dpm === dpm) return hit;
  const out: number[] = [];
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < G.pts.length - 1; k++) {
    const g = Math.min(G.g[k], G.g[k + 1]), [x0, y0] = G.pts[k], [x1, y1] = G.pts[k + 1];
    if (!(g >= floor) || !isFinite(x0 + y0 + x1 + y1)) continue;
    out.push(x0, y0, x1, y1, G.w[k] * dpm / 2, G.w[k + 1] * dpm / 2, g, lonCos(meta, (y0 + y1) / 2));
    lo = Math.min(lo, x0, x1); hi = Math.max(hi, x0, x1);
  }
  const r = { floor, dpm, a: Float64Array.from(out), lo, hi };
  segMemo.set(G, r);
  return r;
}
const absOf = new WeakMap<RiverSet, Float64Array>();
function sameAbs(s: RiverSet, a: Float64Array): boolean {
  const b = absOf.get(s)!;
  if (b.length !== a.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
/** 分桶：桶边从段外框中位尺寸的两倍起，有桶超过 RIV_BIN 段就减半（桶数封顶 MAX_BINS）。段外框按 3 倍半宽外扩——岸线墨伸出水面之外 */
function buildSet(abs: Float64Array): RiverSet {
  const n = abs.length / 8, bx0 = new Float64Array(n), by0 = new Float64Array(n), bx1 = new Float64Array(n), by1 = new Float64Array(n);
  let ox = Infinity, oy = Infinity, X1 = -Infinity, Y1 = -Infinity, gmax = 0;
  const sz: number[] = [];
  for (let s = 0; s < n; s++) {
    const o = s * 8, hy = 3 * Math.max(abs[o + 4], abs[o + 5]), hx = hy / abs[o + 7];
    bx0[s] = Math.min(abs[o], abs[o + 2]) - hx; bx1[s] = Math.max(abs[o], abs[o + 2]) + hx;
    by0[s] = Math.min(abs[o + 1], abs[o + 3]) - hy; by1[s] = Math.max(abs[o + 1], abs[o + 3]) + hy;
    ox = Math.min(ox, bx0[s]); oy = Math.min(oy, by0[s]); X1 = Math.max(X1, bx1[s]); Y1 = Math.max(Y1, by1[s]);
    sz.push(Math.max(bx1[s] - bx0[s], by1[s] - by0[s])); gmax = Math.max(gmax, abs[o + 6]);
  }
  sz.sort((a, b) => a - b);
  const ext = Math.max(X1 - ox, Y1 - oy, 1e-9);
  let bs = Math.min(ext, Math.max(ext / 1024, 2 * sz[n >> 1])), nx = 1, ny = 1, cnt = new Int32Array(1);
  for (let tr = 0; ; tr++) {
    nx = Math.max(1, Math.ceil((X1 - ox) / bs)); ny = Math.max(1, Math.ceil((Y1 - oy) / bs));
    if (nx * ny > MAX_BINS) { bs *= Math.sqrt(nx * ny / MAX_BINS) * 1.01; continue; }
    cnt = new Int32Array(nx * ny);
    let mx = 0;
    for (let s = 0; s < n; s++) eachBin(s, (b) => { mx = Math.max(mx, ++cnt[b]); });
    if (mx <= RIV_BIN || tr >= 6 || nx * ny * 4 > MAX_BINS) {
      if (mx > RIV_LOOP) console.warn(`河段分桶：一桶 ${mx} 段，超过取样上限 ${RIV_LOOP}，这一片的宽河水面会缺段`);
      break;
    }
    bs /= 2;
  }
  /* 段进它外框里、离段中轴不到「3 倍半宽 + 半个桶对角」的桶（斜段的外框远大于它扫过的桶） */
  function eachBin(s: number, fn: (b: number) => void): void {
    const c0 = Math.max(0, Math.floor((bx0[s] - ox) / bs)), c1 = Math.min(nx - 1, Math.floor((bx1[s] - ox) / bs));
    const r0 = Math.max(0, Math.floor((by0[s] - oy) / bs)), r1 = Math.min(ny - 1, Math.floor((by1[s] - oy) / bs));
    const o = s * 8, c = abs[o + 7], ex = (abs[o + 2] - abs[o]) * c, ey = abs[o + 3] - abs[o + 1], L = Math.max(ex * ex + ey * ey, 1e-30);
    const lim = 3 * Math.max(abs[o + 4], abs[o + 5]) + bs / 2 * Math.sqrt(c * c + 1);
    for (let r = r0; r <= r1; r++) for (let k = c0; k <= c1; k++) {
      const ax = (ox + (k + 0.5) * bs - abs[o]) * c, ay = oy + (r + 0.5) * bs - abs[o + 1], h = Math.max(0, Math.min(1, (ax * ex + ay * ey) / L));
      if (Math.hypot(ax - ex * h, ay - ey * h) <= lim) fn(r * nx + k);
    }
  }
  const nb = nx * ny, idx = new Int32Array(2 * nb + cnt.reduce((a, b) => a + b, 0)), fill = new Int32Array(nb);
  for (let b = 0, p = 2 * nb; b < nb; b++) { idx[2 * b] = p; idx[2 * b + 1] = cnt[b]; p += cnt[b]; }
  for (let s = 0; s < n; s++) eachBin(s, (b) => { idx[idx[2 * b] + fill[b]++] = s; });
  for (let b = 0; b < nb; b++) {
    if (cnt[b] < 2) continue;
    const st = idx[2 * b], l = Array.from(idx.subarray(st, st + cnt[b])).sort((p, q) => abs[q * 8 + 6] - abs[p * 8 + 6] || p - q);
    idx.set(l, st);
  }
  const seg = new Float64Array(abs);
  for (let o = 0; o < seg.length; o += 8) { seg[o] -= ox; seg[o + 1] -= oy; seg[o + 2] -= ox; seg[o + 3] -= oy; }
  const gs = new Float64Array(n);
  for (let s = 0; s < n; s++) gs[s] = abs[s * 8 + 6];
  gs.sort().reverse();
  const set: RiverSet = { id: ++setN, n, seg, gmax, ox, oy, bs, nx, ny, idx, gs };
  absOf.set(set, abs);
  return set;
}

/** (lon, lat) 到真宽 ≥ thr 的河面的有向距离（纬度当量的度，负＝在水里；附近没有＝1e9）。GL riverGLSL 同式 */
export function riverSD(s: RiverSet, lon: number, lat: number, thr: number): number {
  const px = lon - s.ox, py = lat - s.oy, bx = Math.floor(px / s.bs), by = Math.floor(py / s.bs);
  if (!(bx >= 0 && by >= 0 && bx < s.nx && by < s.ny)) return 1e9;
  const q = s.seg, I = s.idx, b = 2 * (by * s.nx + bx), st = I[b], cn = Math.min(I[b + 1], RIV_LOOP);
  let sd = 1e9;
  for (let i = 0; i < cn; i++) {
    const o = I[st + i] * 8;
    if (q[o + 6] < thr) break;
    const c = q[o + 7], ax = (px - q[o]) * c, ay = py - q[o + 1], ex = (q[o + 2] - q[o]) * c, ey = q[o + 3] - q[o + 1];
    const h = Math.max(0, Math.min(1, (ax * ex + ay * ey) / Math.max(ex * ex + ey * ey, 1e-30))), dx = ax - ex * h, dy = ay - ey * h;
    const d = Math.sqrt(dx * dx + dy * dy) - (q[o + 4] + (q[o + 5] - q[o + 4]) * h);
    if (d < sd) sd = d;
  }
  return sd;
}

/** GL 的 riverSD（同式；纹理布局见 riverTexels）。p 是相对分桶原点的经纬度，uRivA.w＝门槛 */
export function riverGLSL(): string {
  const W = RIV_TEX_W;
  return `int ridx(int k){ return texelFetch(uRIdx,ivec2(k%${W},k/${W}),0).r; }
float riverSD(vec2 ll){
  vec2 p=ll-uRivA.xy; ivec2 b=ivec2(floor(p/uRivA.z));
  if(b.x<0||b.y<0||b.x>=uRivN.x||b.y>=uRivN.y) return 1e9;
  int bi=2*(b.y*uRivN.x+b.x), st=ridx(bi), cn=ridx(bi+1);
  float sd=1e9;
  for(int i=0;i<${RIV_LOOP};i++){
    if(i>=cn) break;
    int s=2*ridx(st+i);
    vec4 a=texelFetch(uRSeg,ivec2(s%${W},s/${W}),0), w=texelFetch(uRSeg,ivec2((s+1)%${W},(s+1)/${W}),0);
    if(w.z<uRivA.w) break;
    vec2 pa=vec2((p.x-a.x)*w.w,p.y-a.y), ba=vec2((a.z-a.x)*w.w,a.w-a.y);
    float h=clamp(dot(pa,ba)/max(dot(ba,ba),1e-30),0.0,1.0);
    sd=min(sd,length(pa-ba*h)-(w.x+(w.y-w.x)*h));
  }
  return sd;
}`;
}

/** GL 纹理数据：河段 RGBA32F（每段两格：两端、(半宽, 半宽, 真宽, lonCos)）与索引 R32I，都按 RIV_TEX_W 宽铺满整行 */
export function riverTexels(s: RiverSet): { seg: Float32Array; segRows: number; idx: Int32Array; idxRows: number } {
  const segRows = Math.max(1, Math.ceil(2 * s.n / RIV_TEX_W)), idxRows = Math.max(1, Math.ceil(s.idx.length / RIV_TEX_W));
  const seg = new Float32Array(segRows * RIV_TEX_W * 4);
  seg.set(s.seg);
  const idx = new Int32Array(idxRows * RIV_TEX_W);
  idx.set(s.idx);
  return { seg, segRows, idx, idxRows };
}

/** 真宽 ≥ thr 的段数（gs 降序上二分） */
function countAbove(s: RiverSet, thr: number): number {
  let lo = 0, hi = s.n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (s.gs[m] >= thr) lo = m + 1; else hi = m; }
  return lo;
}
const keysOf = new WeakMap<RiverSet, string[]>();
/** 两份渲染选项之间画成水面的段变了哪些：变了的段（旧有新无、新有旧无）的外框，每段按半宽外扩（岸线墨与取样外缘由补画窗再扩）。
    同一份河段且门槛以上段数相同（或两边都没有）＝一段没变。多于 16 块并成一块 */
export function riverDirty(a: TerrainRivers | undefined, b: TerrainRivers | undefined): BBox[] {
  const sa = a ? a.set : null, sb = b ? b.set : null, na = sa ? countAbove(sa, a!.thr) : 0, nb = sb ? countAbove(sb, b!.thr) : 0;
  if ((sa === sb && na === nb) || na + nb === 0) return [];
  const on = (s: RiverSet | null, thr: number): Map<string, number> => {
    const m = new Map<string, number>();
    if (!s) return m;
    let K = keysOf.get(s);
    if (!K) { const A = absOf.get(s)!; K = []; for (let o = 0; o < A.length; o += 8) K.push(Array.from(A.subarray(o, o + 6)).join(",")); keysOf.set(s, K); }
    for (let i = 0; i < s.n; i++) if (s.seg[i * 8 + 6] >= thr) m.set(K[i], i);
    return m;
  };
  const ma = on(sa, a ? a.thr : 0), mb = on(sb, b ? b.thr : 0), out: BBox[] = [];
  const box = (s: RiverSet, i: number): BBox => {
    const A = absOf.get(s)!, o = i * 8, hy = Math.max(A[o + 4], A[o + 5]), hx = hy / A[o + 7];
    return { lonMin: Math.min(A[o], A[o + 2]) - hx, lonMax: Math.max(A[o], A[o + 2]) + hx, latMin: Math.min(A[o + 1], A[o + 3]) - hy, latMax: Math.max(A[o + 1], A[o + 3]) + hy };
  };
  for (const [k, i] of ma) if (!mb.has(k)) out.push(box(sa!, i));
  for (const [k, i] of mb) if (!ma.has(k)) out.push(box(sb!, i));
  if (out.length <= 16) return out;
  return [{ lonMin: Math.min(...out.map(r => r.lonMin)), lonMax: Math.max(...out.map(r => r.lonMax)),
    latMin: Math.min(...out.map(r => r.latMin)), latMax: Math.max(...out.map(r => r.latMax)) }];
}
