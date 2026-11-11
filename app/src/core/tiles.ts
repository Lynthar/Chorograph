/* 分块精修：含陆地的块各带余量单独侵蚀（core/erode 的窗口单）、只留块心；粗级切割量全图一份（erodeCarve）裁给各块，块与块才接得上。
   带中尺度的 v2 图不侵蚀块，改走 core/nested 的嵌套解（单里带外层裁剪；工作档也是嵌套解时再带量化的工作档裁片当目标面）。
   块只进画面：规则场、等高线与光标读数照旧走工作档——让它们读块，读数就随本机内存与计算进度变。 */
import { erodeKey, upscaleOf, type CoarseCarve, type ErodeInput } from "./erode.ts";
import { nestCrop, NEST_MARGIN, NEST_PAD, type NestSrc } from "./nested.ts";
import type { ElevField } from "./elev.ts";
import type { BBox } from "./types.ts";

/** 每块的父格边长：块心 TILE_P × 倍率个细格，存一份约 1 MB */
export const TILE_P = 64;
/** 每块向外多算的父格：细级下切、扩散与填洼的作用范围要落在这之内，不够则块与块交界处的谷地对不上；
    集水区伸出余量的主河，块内算出的下切偏浅，余量补不上 */
export const TILE_MARGIN = 8;
/** 块倍率上限（相对类型网格）：小图的工作档已到这一档，就不分块 */
export const TILE_MAX_X = 8;
/** 裁给块的粗级切割量量化步长（抽象高程，约 3 cm）：粗级扩散把一处涂改的位级扰动传遍全图，不量化则任何一笔都让所有块换键重算 */
export const CARVE_Q = 1 / 65536;
/** 块的算法代号：块的取法（余量、块心、参照带、目标面）变了而侵蚀没变时换代，免得旧块还魂 */
export const TILE_VER = 3;
/** 一个块格占的 CSS 像素：不足一像素不用块（块里的起伏逐像素点采样＝整片颗粒），到 HI 全用；中间按缩放连续过渡＝缩放时不跳 */
export const TILE_W_LO = 1.0, TILE_W_HI = 2.0;

/** 块网格的几何：原点与父格同源；step＝块格（度）＝pstep/sx；块 i 覆盖父格 [tx·P, tx·P+P) × [ty·P, ty·P+P)，贴图幅右上边的块会窄一些 */
export interface TileGeom { lonMin: number; latMin: number; pstep: number; P: number; sx: number; step: number; nx: number; ny: number; cols: number; rows: number }
/** 一张图的分块计划：geom＋含陆地的块号（ty·nx+tx）＋块单用的绝对集水阈值（细格数） */
export interface TilePlan { geom: TileGeom; tiles: number[]; sxW: number; acrit: number }
/** 渲染器吃的块层：块号 → 块心高程（宽 tileW × 高 tileH，行自南起，同 ElevField）；数组当不可变快照，内容变了就换新数组 */
export interface TileLayer { geom: TileGeom; tiles: ReadonlyMap<number, Float32Array> }

/** 缩放到「一个块格占几 CSS 像素」时块的权重（0＝不用块） */
export function tileWeight(cssPxPerCell: number): number {
  const t = Math.max(0, Math.min(1, (cssPxPerCell - TILE_W_LO) / (TILE_W_HI - TILE_W_LO)));
  return t * t * (3 - 2 * t);
}

/** 块 i 的父格范围（半开） */
export function tileCells(g: TileGeom, i: number): { c0: number; r0: number; c1: number; r1: number } {
  const tx = i % g.nx, ty = (i / g.nx) | 0;
  return { c0: tx * g.P, r0: ty * g.P, c1: Math.min(g.cols, tx * g.P + g.P), r1: Math.min(g.rows, ty * g.P + g.P) };
}

/** ids 里与视口相交的块（视口先折回图幅所在的那份世界：球面图的经度环绕） */
export function tilesInView(g: TileGeom, ids: Iterable<number>, v: BBox): number[] {
  const out: number[] = [], cx = g.lonMin + g.cols * g.pstep / 2, k = 360 * Math.round(((v.lonMin + v.lonMax) / 2 - cx) / 360);
  for (const i of ids) {
    const { c0, r0, c1, r1 } = tileCells(g, i);
    const lo = g.lonMin + c0 * g.pstep, hi = g.lonMin + c1 * g.pstep, la = g.latMin + r0 * g.pstep, ha = g.latMin + r1 * g.pstep;
    if (ha <= v.latMin || la >= v.latMax) continue;
    for (const s of [k - 360, k, k + 360]) if (hi > v.lonMin - s && lo < v.lonMax - s) { out.push(i); break; }
  }
  return out;
}

/** GL 块层起步的层数（一块一层） */
export const TILE_SLOTS = 64;
/** GL 块层的显存上限（字节）：层数随视口里的块扩到这里为止，等于倍率封顶那档起步层数的用量 */
export const TILE_VRAM = TILE_SLOTS * (TILE_P * TILE_MAX_X) ** 2 * 4;

/** 视口里有 want 块时 GL 块层要几层（一层 K×K 的 R32F）：have 够就不动，不够按倍增扩，封顶 TILE_VRAM 与本机的 maxLayers。
    封顶也装不下＝0：这一帧整幅不用块——只装下一部分＝视口里有块的与没块的按块拼贴 */
export function tileSlotsFor(have: number, want: number, K: number, maxLayers: number): number {
  if (want <= have) return have;
  const cap = Math.min(maxLayers, Math.floor(TILE_VRAM / (K * K * 4)));
  if (want > cap) return 0;
  let n = Math.max(1, have);
  while (n < want) n *= 2;
  return Math.min(n, cap);
}

/** GL 块层的驻留：slots[s]＝第 s 层放的块号（-1＝空）、used[s]＝它上次在视口里的帧号，两者就地改写。
    want 里不在层里的块占空层，没有空层就占最久没用、且不在 want 里的层；返回要上传的 [块号, 层号]
    @throws RangeError want 多于层数（先经 tileSlotsFor 扩层）：多出的块分不到层 */
export function tileResidency(slots: number[], used: number[], want: readonly number[], tick: number): [number, number][] {
  if (want.length > slots.length) throw new RangeError(`视口里 ${want.length} 块，层只有 ${slots.length}`);
  const wantSet = new Set(want), up: [number, number][] = [];
  for (const i of want) {
    let s = slots.indexOf(i);
    if (s < 0) {
      s = slots.indexOf(-1);
      if (s < 0) for (let k = 0; k < slots.length; k++) if (!wantSet.has(slots[k]) && (s < 0 || used[k] < used[s])) s = k;
      slots[s] = i; up.push([i, s]);
    }
    used[s] = tick;
  }
  return up;
}

/** 分块计划。工作档输入 inp（全图）；budget＝全部块心细格数的上限（按本机内存给）；minSx＝不比它细就不值得分块（画面场已有的倍率）。
    倍率取预算允许的最大整数、封顶 TILE_MAX_X；不比 minSx 细、或一块陆地都没有＝null。 */
export function tilePlan(inp: ErodeInput, budget: number, minSx: number): TilePlan | null {
  const { cols, rows, bb, step, water } = inp, P = TILE_P;
  const nx = Math.ceil(cols / P), ny = Math.ceil(rows / P), tiles: number[] = [];
  let landCells = 0;
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const c0 = tx * P, c1 = Math.min(cols, c0 + P), r0 = ty * P, r1 = Math.min(rows, r0 + P);
    let land = false;
    for (let r = r0; r < r1 && !land; r++) for (let c = c0; c < c1; c++) if (!water[r * cols + c]) { land = true; break; }
    if (land) { tiles.push(ty * nx + tx); landCells += (c1 - c0) * (r1 - r0); }
  }
  const sxW = upscaleOf(cols, rows, inp.cap, inp.axisMax);
  const sx = Math.min(TILE_MAX_X, Math.floor(Math.sqrt(budget / Math.max(1, landCells))));
  if (!tiles.length || sx <= minSx) return null;
  const effW = Math.min(inp.acrit, cols * rows * sxW * sxW / 64);   // 工作档实际生效的阈值（同 erodeField 的封顶）
  return { geom: { lonMin: bb.lonMin, latMin: bb.latMin, pstep: step, P, sx, step: step / sx, nx, ny, cols, rows }, tiles, sxW, acrit: effW * (sx / sxW) * (sx / sxW) };
}

/** 粗级切割量裁到窗口并按 CARVE_Q 量化：双线性支撑域外留一格；在图幅边上照全图同样钳边 */
function cropCarve(cv: CoarseCarve, lonMin: number, latMin: number, lonMax: number, latMax: number): CoarseCarve {
  const g = cv.geo;
  const c0 = Math.max(0, Math.floor((lonMin - g.bb.lonMin) / g.step - 0.5) - 1), c1 = Math.min(g.cols - 1, Math.ceil((lonMax - g.bb.lonMin) / g.step - 0.5) + 1);
  const r0 = Math.max(0, Math.floor((latMin - g.bb.latMin) / g.step - 0.5) - 1), r1 = Math.min(g.rows - 1, Math.ceil((latMax - g.bb.latMin) / g.step - 0.5) + 1);
  const w = c1 - c0 + 1, h = r1 - r0 + 1, data = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) data[r * w + c] = Math.round(cv.data[(r0 + r) * g.cols + c0 + c] / CARVE_Q) * CARVE_Q;
  const lo = g.bb.lonMin + c0 * g.step, la = g.bb.latMin + r0 * g.step;
  return { data, geo: { bb: { lonMin: lo, latMin: la, lonMax: lo + w * g.step, latMax: la + h * g.step }, step: g.step, cols: w, rows: h } };
}

/** 块 i 的侵蚀单：父格窗口＝块心外扩 TILE_MARGIN（钳到图幅），倍率 plan.sx，四个窗口约定见 core/erode.ErodeWindow。
    carve＝erodeCarve(inp) 的全图切割量；中尺度图（inp.mesoEnv）不跑粗级，传 null。
    nest＝这份输入出自的外层解（带中尺度的图）：给了就是嵌套解的单——解的窗口外扩 NEST_MARGIN，单的裁剪再外扩 NEST_PAD、带外层裁剪（nest.work 给了再带工作档裁片），
    不带 win、mesoEnv 与工作档单自己的全图裁剪 */
export function tileInput(inp: ErodeInput, plan: TilePlan, carve: CoarseCarve | null, i: number, nest?: NestSrc | null, keyOnly = false): ErodeInput {
  const g = plan.geom, { c0, r0, c1, r1 } = tileCells(g, i), M = nest ? NEST_MARGIN : TILE_MARGIN, X = nest ? NEST_MARGIN + NEST_PAD : M;
  const a0 = Math.max(0, c0 - X), a1 = Math.min(g.cols, c1 + X), b0 = Math.max(0, r0 - X), b1 = Math.min(g.rows, r1 + X);
  const w = a1 - a0, h = b1 - b0;
  const sub = <T extends Float32Array | Uint8Array>(a: T): T => {
    const o = new (a.constructor as new (n: number) => T)(w * h);
    for (let r = 0; r < h; r++) o.set(a.subarray((b0 + r) * g.cols + a0, (b0 + r) * g.cols + a1), r * w);
    return o;
  };
  const lonMin = g.lonMin + a0 * g.pstep, latMin = g.latMin + b0 * g.pstep, lonMax = g.lonMin + a1 * g.pstep, latMax = g.latMin + b1 * g.pstep;
  if (nest) {
    const { mesoEnv: _m, lfDelta: _l, win: _w, ...rest } = inp;
    const wa0 = Math.max(0, c0 - M), wa1 = Math.min(g.cols, c1 + M), wb0 = Math.max(0, r0 - M), wb1 = Math.min(g.rows, r1 + M);
    return { ...rest, bb: { lonMin, latMin, lonMax, latMax }, cols: w, rows: h, elev0: sub(inp.elev0), water: sub(inp.water), wsurf: sub(inp.wsurf), hovGrid: sub(inp.hovGrid),
      cap: w * h * g.sx * g.sx, axisMax: g.sx, acrit: plan.acrit, bandS: g.sx / plan.sxW, ...(inp.basin ? { basin: sub(inp.basin) } : {}),
      nest: nestCrop(nest, wa0, wa1, wb0, wb1, a0, a1, b0, b1, g.sx, g.lonMin, g.latMin, g.pstep, !keyOnly) };
  }
  const sc = inp.sphere ? [(inp.bb.lonMin + inp.bb.lonMax) / 2, (inp.bb.latMin + inp.bb.latMax) / 2] as const : null;
  return { ...inp, bb: { lonMin, latMin, lonMax, latMax }, cols: w, rows: h,
    elev0: sub(inp.elev0), water: sub(inp.water), wsurf: sub(inp.wsurf), hovGrid: sub(inp.hovGrid),
    cap: w * h * g.sx * g.sx, axisMax: g.sx, acrit: plan.acrit, bandS: g.sx / plan.sxW, ...(inp.mesoEnv ? { mesoEnv: sub(inp.mesoEnv) } : {}), ...(inp.basin ? { basin: sub(inp.basin) } : {}),
    ...(inp.lfDelta ? { lfDelta: sub(inp.lfDelta) } : {}),
    win: { carve: carve ? cropCarve(carve, lonMin, latMin, lonMax, latMax) : null, refS: 1, sc, coast: true } };
}

/** 块缓存的键：窗口单的内容键（含窗口位置与裁过的切割量）＋块代号 */
export function tileKey(tinp: ErodeInput): string { return erodeKey(tinp) + "~t" + TILE_VER; }
/** 块 i 的键，与 tileKey(tileInput(…)) 一字不差：嵌套解的静态场按全图摘要进键，逐块裁它只为发单——一次算全部块键时省掉 */
export function tileKeyOf(inp: ErodeInput, plan: TilePlan, carve: CoarseCarve | null, i: number, nest?: NestSrc | null): string {
  return tileKey(tileInput(inp, plan, carve, i, nest, true));
}

/** 窗口单的产出 → 块心（去掉余量）。f 必须是 tileInput(…, i) 那一单的结果：余量按产出的原点算，两种窗口单通用 */
export function tileCore(f: ElevField, plan: TilePlan, i: number): Float32Array {
  const g = plan.geom, { c0, r0, c1, r1 } = tileCells(g, i), sx = g.sx;
  const ox = (c0 - Math.round((f.bb.lonMin - g.lonMin) / g.pstep)) * sx, oy = (r0 - Math.round((f.bb.latMin - g.latMin) / g.pstep)) * sx;
  const w = (c1 - c0) * sx, h = (r1 - r0) * sx, out = new Float32Array(w * h);
  for (let r = 0; r < h; r++) out.set(f.data.subarray((oy + r) * f.cols + ox, (oy + r) * f.cols + ox + w), r * w);
  return out;
}

/** 块 i 的块心当作一张场（几何＋数据）：等待窗合成（core/elev.fieldPlusDelta）按场处理它 */
export function tileField(g: TileGeom, i: number, data: Float32Array): ElevField {
  const { c0, r0, c1, r1 } = tileCells(g, i);
  return { bb: { lonMin: g.lonMin + c0 * g.pstep, latMin: g.latMin + r0 * g.pstep, lonMax: g.lonMin + c1 * g.pstep, latMax: g.latMin + r1 * g.pstep },
    step: g.step, cols: (c1 - c0) * g.sx, rows: (r1 - r0) * g.sx, data, eroded: true };
}

/** 块层上一点的双线性高程（格心对齐、图幅边钳边，同 core/elev.elevBilinear）；四个取样格有一个不在层里＝NaN（调用方退回画面场）。
    GL 着色器 tileBil 同式 */
export function tileElevAt(L: TileLayer, lon: number, lat: number): number {
  const g = L.geom, K = g.P * g.sx, FC = g.cols * g.sx, FR = g.rows * g.sx;
  const fx = (lon - g.lonMin) / g.step - 0.5, fy = (lat - g.latMin) / g.step - 0.5;
  const c0 = Math.max(0, Math.min(FC - 1, Math.floor(fx))), r0 = Math.max(0, Math.min(FR - 1, Math.floor(fy)));
  const c1 = Math.min(FC - 1, c0 + 1), r1 = Math.min(FR - 1, r0 + 1);
  const tx = Math.max(0, Math.min(1, fx - c0)), ty = Math.max(0, Math.min(1, fy - r0));
  const v = (r: number, c: number): number => {
    const a = L.tiles.get(((r / K) | 0) * g.nx + ((c / K) | 0));
    if (!a) return NaN;
    const w = Math.min(K, FC - ((c / K) | 0) * K);
    return a[(r % K) * w + (c % K)];
  };
  const s00 = v(r0, c0), s10 = v(r0, c1), s01 = v(r1, c0), s11 = v(r1, c1);
  const top = s00 + (s10 - s00) * tx, bot = s01 + (s11 - s01) * tx;
  return top + (bot - top) * ty;
}
