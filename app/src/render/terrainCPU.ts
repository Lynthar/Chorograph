/* CPU 兜底地形渲染器（Canvas2D）：仅在建不出 WebGL2 上下文的环境使用。
   像素管线与 GL 版同构（= 旧版 renderRegion 语义：高程双线性 + 细节噪声 + 晕渲 + 色阶 +
   生态色调 + 海岸线，2026-08 起加 域扭曲/微八度/材质纹理/谷影/岩化/水面观感——
   结构与系数同 GL（数值系数单一真源 render/material.FX），噪声哈希不同（此处 sin-hash fp64、
   GL 是 PCG2D fp32）＝观感同构而非逐位一致，与宏观 fbm 的既有纪律相同。
   等高线与 GL 版同构地画在**规则场（工作档）的无噪声制图面**（首/计曲线，contourStepFor 的 1-2-5 阶梯单系取档；像素量按 opts.dpr 锚 CSS 像素）。
   性能策略沿袭旧版：**世界锚定瓦片 + 30% 余量**——平移只重贴图，视口越出余量或缩放变档才重渲；
   数据同形的改动（笔刷）只补画变了的那片，补画与整幅重画逐字节相同。
   推演底图（opts.flat）例外：逐屏幕像素直接栅格化、不走瓦片（贴图重采样会让格边像素取到邻格）。 */
import { fbm, vnoise, hash2 } from "../core/noise.ts";
import { terrainProps } from "../core/constants.ts";
import { elevBilinear, elevSmooth, coarseField, SUP_DASH_PX, SUP_HI_PX, SUP_LO_PX, type ElevField } from "../core/elev.ts";
import { climRampColor, materialFor, octaveGate, decoGate, rampColor, snowLatM, FOREST_CANOPY, MICRO_F0, MICRO_OCTAVES, NRM0, FX, type ClimLook } from "./material.ts";
import type { Grid } from "../core/grid.ts";
import type { BBox } from "../core/types.ts";
import type { TerrainRenderer, TerrainRenderOpts } from "./renderer.ts";

const MAX_TILE_PX = 2_400_000;   // 瓦片总像素预算（与旧版一致）

/** 瓦片是否仍可复用：完整覆盖视口，且分辨率在 [0.66, 1.5]× 档内（导出以便单测）。
    tile.pxpd 是**请求分辨率**（planTile 记录），与本次请求同口径可比。 */
export function tileCovers(
  tile: { bb: BBox; pxpd: number }, viewBB: BBox, pxpd: number, gridBB: BBox
): boolean {
  const need = (v: number, lo: number, hi: number) => v >= lo - 1e-9 && v <= hi + 1e-9;
  const lonMin = Math.max(viewBB.lonMin, gridBB.lonMin), lonMax = Math.min(viewBB.lonMax, gridBB.lonMax);
  const latMin = Math.max(viewBB.latMin, gridBB.latMin), latMax = Math.min(viewBB.latMax, gridBB.latMax);
  if (lonMax <= lonMin || latMax <= latMin) return true;   // 视口不含网格：无需瓦片
  return need(pxpd, tile.pxpd * 0.66, tile.pxpd * 1.5)
    && tile.bb.lonMin <= lonMin + 1e-9 && tile.bb.lonMax >= lonMax - 1e-9
    && tile.bb.latMin <= latMin + 1e-9 && tile.bb.latMax >= latMax - 1e-9;
}

/** 瓦片方案（导出以便单测）："keep"=复用现瓦片；"none"=视口在网格外无需瓦片；否则给出重建参数。
    renderPxpd 按总像素预算封顶；pxpd 记录**请求分辨率**供 tileCovers 同口径比对——
    若记录封顶值，高分屏请求一旦 >1.5×封顶将永判不覆盖、每帧全量重渲瓦片（数百 ms/帧）。 */
export function planTile(
  tile: { bb: BBox; pxpd: number; key: string } | null, key: string,
  vb: BBox, pxpd: number, gridBB: BBox
): "keep" | "none" | { bb: BBox; renderPxpd: number; pxpd: number } {
  if (tile && tile.key === key && tileCovers(tile, vb, pxpd, gridBB)) return "keep";
  const mLon = (vb.lonMax - vb.lonMin) * 0.3, mLat = (vb.latMax - vb.latMin) * 0.3;   // 30% 余量：平移只重贴图
  const bb: BBox = {
    lonMin: Math.max(gridBB.lonMin, vb.lonMin - mLon), lonMax: Math.min(gridBB.lonMax, vb.lonMax + mLon),
    latMin: Math.max(gridBB.latMin, vb.latMin - mLat), latMax: Math.min(gridBB.latMax, vb.latMax + mLat)
  };
  if (bb.lonMax <= bb.lonMin || bb.latMax <= bb.latMin) return "none";
  const cap = Math.sqrt(MAX_TILE_PX / ((bb.lonMax - bb.lonMin) * (bb.latMax - bb.latMin)));
  return { bb, renderPxpd: Math.min(pxpd, cap), pxpd };
}

/** 视口落在哪几份世界拷贝上（导出以便单测）：各份的经度偏移 c（视口 +c＝折回网格所在域），只留与网格相交的。
    球面环绕时视口可同时跨两三份拷贝、各露出网格的不同部分——只按最近的一份规划瓦片，另一侧就无瓦片可贴、露出底色。 */
export function wrapCopies(viewBB: BBox, gridBB: BBox, wrap: boolean): number[] {
  if (!wrap) return [0];
  const k = 360 * Math.round(((gridBB.lonMin + gridBB.lonMax) / 2 - (viewBB.lonMin + viewBB.lonMax) / 2) / 360);
  return [k - 360, k, k + 360].filter(c => viewBB.lonMin + c < gridBB.lonMax && viewBB.lonMax + c > gridBB.lonMin);
}

/** 岸线：水陆相邻两像素之间的格边描 w 宽的线段（竖段在像素左边、横段在上边，端点落在邻像素中心），按 4×4 超采样算覆盖、
    以 55% 深蓝逐像素混进 d——不走画布描边：浏览器按路径繁简换光栅算法，补画窗与整块瓦片的抗锯齿会差一两级。
    w 按屏幕像素封顶（同 GL 约 1.4 px 的 coast 带）：只按 pxpd 放大时战术图放大后每段描成上百 px 宽＝沿岸成片矩形染色 */
export function coastInk(d: Uint8ClampedArray, elev: Float32Array, wsv: Float32Array, W: number, H: number, w: number): void {
  const land = (i: number): boolean => elev[i] >= wsv[i] - 0.02;
  const sv = new Uint8Array(W * H), sh = new Uint8Array(W * H), near = new Uint8Array(W * H);
  const hw = w / 2, R = Math.ceil(hw) + 1;
  for (let y = 1; y < H; y++) for (let x = 1; x < W; x++) {
    const i = y * W + x, a = land(i);
    if (a !== land(i - 1)) sv[i] = 1;
    if (a !== land(i - W)) sh[i] = 1;
    if (sv[i] || sh[i]) for (let yy = Math.max(0, y - R); yy <= Math.min(H - 1, y + R); yy++) near.fill(1, yy * W + Math.max(0, x - R), yy * W + Math.min(W - 1, x + R) + 1);
  }
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    if (!near[py * W + px]) continue;
    let n = 0;
    for (let b = 0; b < 4; b++) {
      const sy = py + (b + 0.5) / 4, ry = Math.floor(sy + 0.5);
      for (let a = 0; a < 4; a++) {
        const sx = px + (a + 0.5) / 4, rx = Math.floor(sx + 0.5);
        let hit = false;
        if (ry >= 1 && ry < H) for (let x = Math.max(1, Math.ceil(sx - hw)); !hit && x <= Math.min(W - 1, Math.floor(sx + hw)); x++) hit = sv[ry * W + x] === 1;
        if (rx >= 1 && rx < W) for (let y = Math.max(1, Math.ceil(sy - hw)); !hit && y <= Math.min(H - 1, Math.floor(sy + hw)); y++) hit = sh[y * W + rx] === 1;
        if (hit) n++;
      }
    }
    if (!n) continue;
    const k = 0.55 * n / 16, q = (py * W + px) * 4;
    d[q] += (38 - d[q]) * k; d[q + 1] += (66 - d[q + 1]) * k; d[q + 2] += (86 - d[q + 2]) * k;
  }
}
/** 两份同形数组的变化包围盒（行主序、每格 stride 个数）：[c0, r0, c1, r1] 闭区间，无变化 null（导出以便单测） */
export function changedBox(a: ArrayLike<number>, b: ArrayLike<number>, cols: number, rows: number, stride = 1): number[] | null {
  let c0 = cols, r0 = rows, c1 = -1, r1 = -1;
  const rs = cols * stride;
  for (let r = 0; r < rows; r++) {
    const o = r * rs;
    let lo = 0;
    while (lo < rs && a[o + lo] === b[o + lo]) lo++;
    if (lo === rs) continue;
    let hi = rs - 1;
    while (a[o + hi] === b[o + hi]) hi--;
    c0 = Math.min(c0, Math.floor(lo / stride)); c1 = Math.max(c1, Math.floor(hi / stride));
    if (r < r0) r0 = r;
    r1 = r;
  }
  return c1 < 0 ? null : [c0, r0, c1, r1];
}
/** 两个格网（Grid / ElevField）同形：行列数、格距与范围逐位相同 */
export function sameGeom(a: { cols: number; rows: number; step: number; bb: BBox }, b: { cols: number; rows: number; step: number; bb: BBox }): boolean {
  return a.cols === b.cols && a.rows === b.rows && a.step === b.step && a.bb.lonMin === b.bb.lonMin && a.bb.lonMax === b.bb.lonMax
    && a.bb.latMin === b.bb.latMin && a.bb.latMax === b.bb.latMax;
}
export function unionBB(bs: BBox[]): BBox {
  return { lonMin: Math.min(...bs.map(b => b.lonMin)), lonMax: Math.max(...bs.map(b => b.lonMax)),
    latMin: Math.min(...bs.map(b => b.latMin)), latMax: Math.max(...bs.map(b => b.latMax)) };
}

/* 等高线助手（与 GL 版同构）：sstep=smoothstep；cw=线强（w0..w1 带宽像素，数值 +1e-6 防零梯度平台整面刷线）；oddK=倍数奇偶 */
const sstep = (a: number, b: number, x: number): number => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/* —— 与 GL 版同构的观感函数（sin-hash 域；逐行对齐 terrainGL 的 GLSL 同名函数）—— */
/* 梯度噪声（±0.7）：棱脊/沙丘的 ridged 变换用——值噪声 ridged 后是迷宫纹（同 GL gnoise2） */
function gnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const g = (ix: number, iy: number, dx: number, dy: number): number => {
    const a = hash2(ix, iy) * 6.2831853; return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const a = g(xi, yi, xf, yf), b = g(xi + 1, yi, xf - 1, yf);
  const c = g(xi, yi + 1, xf, yf - 1), d = g(xi + 1, yi + 1, xf - 1, yf - 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const rgd = (n: number): number => 1 - Math.min(1, Math.abs(n) * 1.9);   // 梯度噪声 → 脊形（同 GL rg）
/** 屏幕波长 tpx 锚定的两档世界频率 + crossfade（同 GL lodF） */
function lodF(pxpd: number, tpx: number): [number, number, number] {
  const fi = Math.max(MICRO_F0, pxpd / tpx);
  const n = Math.floor(Math.log2(fi / MICRO_F0));
  return [MICRO_F0 * 2 ** n, MICRO_F0 * 2 ** (n + 1), Math.log2(fi / MICRO_F0) - n];
}
/** 微八度（同 GL micro）：世界锚定 ×2 阶梯 + 逐档门控 + 逐档旋转 37° */
function micro(rx: number, ry: number, pxpd: number): number {
  let s = 0, a = 0.5, f = MICRO_F0, px = rx, py = ry;
  for (let k = 0; k < MICRO_OCTAVES; k++) {
    const g = octaveGate(pxpd, f); if (g <= 0) break;
    s += a * g * (vnoise(px * f + k * 19.7, py * f + k * 7.9) - 0.5);
    const nx = 0.7986 * px + 0.6018 * py, ny = -0.6018 * px + 0.7986 * py;   // 同 GL ROT（列主序展开）
    px = nx; py = ny; f *= 2; a *= FX.microPers;
  }
  return s;
}
/** 材质纹理（同 GL texAt）：canopy/dune/ridge/marsh 各一对 lod 档 crossfade，只进光照法线 */
function texAt(rx: number, ry: number, twc: number, twd: number, twr: number, twm: number, pxpd: number): number {
  let h = 0;
  if (twc > 0.003) {
    const [f1, f2, fr] = lodF(pxpd, FX.canopyPx), g = octaveGate(pxpd, f1);
    if (g > 0) {
      const a = vnoise(rx * f1 + 7.7, ry * f1 + 3.1) - 0.5, b = vnoise(rx * f2 + 3.3, ry * f2 + 8.9) - 0.5;   // 软鼓包（同 GL）
      h += twc * FX.canopyAmp * g * (a + (b - a) * fr);
    }
  }
  if (twd > 0.003) {
    const [f1, f2, fr] = lodF(pxpd, FX.dunePx), g = octaveGate(pxpd, f1);
    if (g > 0) {
      const a = rgd(gnoise(rx * 0.3 * f1 + 11.1, ry * f1 + 0.7)), b = rgd(gnoise(rx * 0.3 * f2 + 0.9, ry * f2 + 17.3));
      h += twd * FX.duneAmp * g * (a + (b - a) * fr);
    }
  }
  if (twr > 0.003) {
    const [f1, f2, fr] = lodF(pxpd, FX.ridgePx), g = octaveGate(pxpd, f1);
    if (g > 0) {   // 棱脊两级：主脉（×0.36 波长）调制支脉＝山系层级感
      const m1 = rgd(gnoise(rx * f1 * 0.36 + 77.7, ry * f1 * 0.36 + 13.9));
      const a = rgd(gnoise(rx * f1 + 23.1, ry * f1 + 9.3)), b = rgd(gnoise(rx * f2 + 5.3, ry * f2 + 31.7));
      const r = a + (b - a) * fr;
      h += twr * FX.ridgeAmp * g * (0.55 * m1 * m1 + 0.45 * m1 * r);
    }
  }
  if (twm > 0.003) {
    const [f1, f2, fr] = lodF(pxpd, FX.marshPx), g = octaveGate(pxpd, f1);
    if (g > 0) {
      const a = vnoise(rx * f1 + 41.3, ry * f1 + 2.9), b = vnoise(rx * f2 + 3.7, ry * f2 + 55.1);
      h += twm * FX.marshAmp * g * (a + (b - a) * fr - 0.5);
    }
  }
  return h;
}
const cw = (eh: number, itv: number, ad: number, w0: number, w1: number): number => {
  const u = eh / itv, d = (Math.abs(u - Math.round(u)) * itv + 1e-6) / ad;
  return 1 - sstep(w0, w1, d);
};
const oddK = (eh: number, itv: number): number => Math.round(eh / itv) % 2 === 0 ? 0 : 1;

function elevRamp(e: number, ws: number, clim?: ClimLook, dl = 0): [number, number, number] {
  if (e < ws - 0.02) { const t = Math.max(0, Math.min(1, (e - ws + 0.35) / 0.33)); return [40 + t * 60, 90 + t * 70, 132 + t * 66]; }
  if (clim && clim.n > 0) return climRampColor(clim, e, dl);   // 气候色阶（dl＝球面图纬度改正，滩带不移；同 GL）
  return rampColor(e);   // 陆地分层设色＝material.ELEV_RAMP 一张表（GL 同源）
}

export function createTerrainCPU(canvas: HTMLCanvasElement): TerrainRenderer {
  const ctx = canvas.getContext("2d")!;
  let grid: Grid | null = null;
  let field: ElevField | null = null;   // 画面场含几何（粗格或侵蚀细分，精修档在此；缺省=按 ELEV[类型] 合成粗格,旧行为）
  let rule: ElevField | null = null;    // 规则场（工作档）：推演底图的等高线取它＝与光标读数同源；缺省＝画面场
  type Tile = { cv: HTMLCanvasElement; bb: BBox; pxpd: number; key: string; rp: number; o: TerrainRenderOpts };   // rp/o＝实际渲染分辨率与选项（补画照用）
  let tiles: Tile[] = [];   // 每份露出网格的世界拷贝一张（常态一张，跨环绕缝时两张）
  let dirty: BBox[] = [];   // 自上次 render 以来数据变了的经纬矩形（已外扩到取样半径），render 时补进留用的瓦片
  /* 逐格材质/色调（uploadGrid 预算；7 浮点=canopy,dune,ridge,marsh,rough,albVar,rock + tint 3 通道与有无） */
  let cellMat: Float32Array | null = null;
  let cellTint: Float32Array | null = null;
  let cellTintHas: Uint8Array | null = null;
  let cellWS: Float32Array | null = null;   // 每格水面高程（core/elev.waterSurface；海 0／内陆湖岸线高）

  /* 高程场恒备：未传入时按 ELEV[类型] 合成（旧行为）；双线性统一走 core/elev.elevBilinear（与光标读数同源） */
  const fieldOfTypes = (g: Grid): Float32Array => {
    const f = new Float32Array(g.rows * g.cols);
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) f[r * g.cols + c] = terrainProps(g.cells[r][c]).elev;
    return f;
  };
  const elevBil = (lon: number, lat: number): number => elevBilinear(field!.data, field!, lon, lat);
  function nearestT(lon: number, lat: number) {
    const g = grid!;
    const r = Math.max(0, Math.min(g.rows - 1, Math.floor((lat - g.bb.latMin) / g.step)));
    const c = Math.max(0, Math.min(g.cols - 1, Math.floor((lon - g.bb.lonMin) / g.step)));
    return g.cells[r][c];
  }
  /* 水面高程（粗格最近取，同 GL wsAt）。瓦片恒裁在网格内（planTile），扭曲后的采样点越出一点按边格取——
     按出界返 0 会把贴边的湖判成海（同 GL 出界判据看未扭曲位置之理） */
  function wsAt(lon: number, lat: number): number {
    const g = grid!;
    const r = Math.max(0, Math.min(g.rows - 1, Math.floor((lat - g.bb.latMin) / g.step)));
    const c = Math.max(0, Math.min(g.cols - 1, Math.floor((lon - g.bb.lonMin) / g.step)));
    return cellWS![r * g.cols + c];
  }

  /* 域扭曲后的四角双线性材质/色调（同 GL matAt；逐像素两趟调用故写进复用对象 MT，免 GC）。
     rx/ry=图幅局部坐标（lon-lonMin, lat-latMin） */
  const MT = { tr: 0, tg: 0, tb: 0, tintW: 0, c: 0, d: 0, r: 0, m: 0, rough: 0, albVar: 0, rock: 0 };
  function matAt(rx: number, ry: number): void {
    const g = grid!, step = g.step, cols = g.cols, rows = g.rows;
    const wf = FX.warpF / step;   // 同 GL warpOf：双频、幅度 <半格
    const w1x = vnoise(rx * wf + 13.7, ry * wf + 91.2) - 0.5, w1y = vnoise(rx * wf + 57.1, ry * wf + 33.9) - 0.5;
    const w2x = vnoise(rx * wf * 3.1 + 7.3, ry * wf * 3.1 + 44.9) - 0.5, w2y = vnoise(rx * wf * 3.1 + 99.1, ry * wf * 3.1 + 5.7) - 0.5;
    const w2f = FX.warp2F / step;   // 长波扭曲（同 GL warp2Of）：只喂色调/材质查找，有意超半格
    const w3f = FX.warp3F / step;   // 边缘碎化：高频小幅（同 GL），见 FX.warp3F 头注
    const rwx = rx + (w1x + w2x * 0.35) * step * FX.warpAmp + (vnoise(rx * w2f + 3.9, ry * w2f + 71.3) - 0.5) * step * FX.warp2Amp
      + (vnoise(rx * w3f + 17.1, ry * w3f + 53.7) - 0.5) * step * FX.warp3Amp;
    const rwy = ry + (w1y + w2y * 0.35) * step * FX.warpAmp + (vnoise(rx * w2f + 41.7, ry * w2f + 9.1) - 0.5) * step * FX.warp2Amp
      + (vnoise(rx * w3f + 88.3, ry * w3f + 25.9) - 0.5) * step * FX.warp3Amp;
    const fx = rwx / step - 0.5, fy = rwy / step - 0.5;
    const c0 = Math.max(0, Math.min(cols - 1, Math.floor(fx))), r0 = Math.max(0, Math.min(rows - 1, Math.floor(fy)));
    const c1 = Math.min(cols - 1, c0 + 1), r1 = Math.min(rows - 1, r0 + 1);
    const tx = sstep(0.22, 0.78, Math.max(0, Math.min(1, fx - c0)));   // 过渡压窄到约半格（同 GL）
    const ty = sstep(0.22, 0.78, Math.max(0, Math.min(1, fy - r0)));
    MT.tr = 0; MT.tg = 0; MT.tb = 0; MT.tintW = 0; MT.c = 0; MT.d = 0; MT.r = 0; MT.m = 0; MT.rough = 0; MT.albVar = 0; MT.rock = 0;
    for (let i = 0; i < 4; i++) {
      const cc = (i === 1 || i === 3) ? c1 : c0, rr = i >= 2 ? r1 : r0;
      const wi = (i === 1 || i === 3 ? tx : 1 - tx) * (i >= 2 ? ty : 1 - ty);
      const k = rr * cols + cc, k7 = k * 7;
      if (cellTintHas![k]) { MT.tr += cellTint![k * 3] * wi; MT.tg += cellTint![k * 3 + 1] * wi; MT.tb += cellTint![k * 3 + 2] * wi; MT.tintW += wi; }
      MT.c += cellMat![k7] * wi; MT.d += cellMat![k7 + 1] * wi; MT.r += cellMat![k7 + 2] * wi; MT.m += cellMat![k7 + 3] * wi;
      MT.rough += cellMat![k7 + 4] * wi; MT.albVar += cellMat![k7 + 5] * wi; MT.rock += cellMat![k7 + 6] * wi;
    }
    if (MT.tintW > 0) { MT.tr /= MT.tintW; MT.tg /= MT.tintW; MT.tb /= MT.tintW; }
  }

  type RGB = [number, number, number];
  /* 等高线画在规则场制图面 ed（帐篷平滑，与读数一致；画面场为精修档时线不跟画面）；公式与 GL 版同构；图幅内缩一格裁掉贴边假线。
     两种底图共用：观感底图在瓦片趟二末尾叠、推演底图逐屏幕像素叠在平色上（W/H＝ed 的行宽与行数） */
  function contourMix(opts: TerrainRenderOpts, W: number, H: number, col: RGB, ed: Float32Array, i: number, x: number, y: number, ws: number, lon: number, lat: number, pxpd: number, pxpdY: number, src: ElevField): RGB {
    if (!(opts.contour && ed[i] >= ws - 0.02
      && lon > grid!.bb.lonMin + grid!.step && lon < grid!.bb.lonMax - grid!.step
      && lat > grid!.bb.latMin + grid!.step && lat < grid!.bb.latMax - grid!.step)) return col;
    const cs = opts.cStep || 0.12, dpr = opts.dpr ?? 1, eh = ed[i];   // 线落在等距的整数倍上（同 GL：不再偏移 0.02）
    const gx = ed[y * W + Math.min(W - 1, x + 1)] - ed[i], gy = ed[Math.min(H - 1, y + 1) * W + x] - ed[i];   // 屏幕梯度（y 朝下）
    const ad = (Math.abs(gx) + Math.abs(gy)) * dpr + 1e-7;   // 线宽与挤线门按 CSS 像素锚定（同 GL uDPR）
    /* 间曲线的浮现门看 ±10 px 差分的粗坡（同 GL），不看逐像素梯度：侵蚀微起伏让局部梯度远大于宏观坡，按它算线距会低估几十倍；
       虚线相位锚网格原点的像素坐标，切向取世界 y 朝上的帧（gy 取反），与 GL 的 dFdy 同向 */
    const kx = 10 / pxpd * dpr, ky = 10 / pxpdY * dpr;
    const gcx = (elevSmooth(src.data, src, lon + kx, lat) - elevSmooth(src.data, src, lon - kx, lat)) / 20;   // 每 CSS px 的坡（同 GL：不再除 dpr）
    const gcy = (elevSmooth(src.data, src, lon, lat + ky) - elevSmooth(src.data, src, lon, lat - ky)) / 20;
    const gsl = Math.abs(gcx) + Math.abs(gcy) + 1e-7, tl = Math.hypot(gy, gx) || 1;
    const sdp = ((gy / tl) * (lon - grid!.bb.lonMin) * pxpd + (gx / tl) * (lat - grid!.bb.latMin) * pxpdY) / dpr;
    const k = contourK(eh, cs, ad, gsl, sdp, 0), kh = contourK(eh, cs, ad, gsl, sdp, FX.haloPx);
    // 亮晕只画核外环（kh−k），按底色亮度渐隐（同 GL；判据见 material.FX.halo*）
    const hg = (1 - sstep(FX.haloLo, FX.haloHi, (0.299 * col[0] + 0.587 * col[1] + 0.114 * col[2]) / 255)) * Math.max(0, kh - k);
    if (hg > 0) col = [col[0] + (FX.haloC[0] * 255 - col[0]) * hg, col[1] + (FX.haloC[1] * 255 - col[1]) * hg, col[2] + (FX.haloC[2] * 255 - col[2]) * hg];
    return [col[0] + (90 - col[0]) * k, col[1] + (70 - col[1]) * k, col[2] + (40 - col[2]) * k];
  }
  /* 此像素的着墨（同 GL contourK）：首曲线（挤线抑制）、计曲线（每第 5 条，带宽 0.9–1.65 只比首曲线略宽、靠墨 0.70 区分）、
     间曲线 / 助曲线（粗坡门 + 虚线）。gsl=粗坡（高程/CSS 像素）、sdp=沿等值线切向的像素坐标、bo=带宽外扩像素（亮晕） */
  function contourK(eh: number, itv: number, ad: number, gsl: number, sdp: number, bo: number): number {
    const mn = cw(eh, itv, ad, 0.8 + bo, 1.5 + bo) * sstep(2.5, 6, itv / ad);
    const ix = cw(eh, itv * 5, ad, 0.9 + bo, 1.65 + bo) * sstep(2.5, 6, itv * 5 / ad);
    const sp1 = itv / gsl, g1 = sstep(SUP_LO_PX, SUP_HI_PX, sp1), g2 = g1 * sstep(SUP_LO_PX, SUP_HI_PX, sp1 * 0.5);
    let m2 = 0, m4 = 0;
    if (g1 > 0) {
      const sd = sdp / SUP_DASH_PX, fr = sd - Math.floor(sd), fr2 = 2 * sd - Math.floor(2 * sd);
      const d1 = Math.abs(fr - 0.5) >= 0.125 ? 1 : 0, d2 = Math.abs(fr2 - 0.5) >= 0.25 ? 1 : 0;
      m2 = cw(eh, itv * 0.5, ad, 0.8 + bo, 1.5 + bo) * oddK(eh, itv * 0.5) * g1 * d1;
      m4 = cw(eh, itv * 0.25, ad, 0.8 + bo, 1.5 + bo) * oddK(eh, itv * 0.25) * g2 * d2;
    }
    return Math.max(mn * 0.50, ix * 0.70, m2 * 0.50, m4 * 0.42);
  }
  const rgbCache = new Map<string, RGB>();   // 复合串 → 平色（distinct cell 极少）
  const rgbOf = (cell: string): RGB => {
    let c = rgbCache.get(cell);
    if (!c) { const h = terrainProps(cell).color; c = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; rgbCache.set(cell, c); }
    return c;
  };
  /* 推演底图（同 GL uMode=1）：直接按屏幕像素栅格化，不走瓦片——瓦片贴回屏幕要经 drawImage 重采样，
     格边像素会取到邻格的颜色；逐像素与 GL 同式取样（x/pxpd、y/pxpdY、经度折回）才逐格一致。
     所在格类型平色 + 等高线；不扭曲、不晕渲、不描岸线（水陆界就是格边）；图幅外＝深海或纸色。 */
  function renderFlat(viewBB: BBox, opts: TerrainRenderOpts): void {
    const g = grid!, gb = g.bb, [W, H] = opts.px ?? [canvas.width, canvas.height];
    const pxpd = W / (viewBB.lonMax - viewBB.lonMin), pxpdY = H / (viewBB.latMax - viewBB.latMin), cx = (gb.lonMin + gb.lonMax) / 2;
    const lons = new Float64Array(W), cols = new Int32Array(W);   // 每列经度（折回后）与格列；-1＝图幅外
    for (let x = 0; x < W; x++) {
      let lon = viewBB.lonMin + x / pxpd;
      if (opts.wrap) lon -= 360 * Math.floor((lon - cx + 180) / 360);
      lons[x] = lon; cols[x] = lon >= gb.lonMin && lon <= gb.lonMax ? Math.min(g.cols - 1, Math.floor((lon - gb.lonMin) / g.step)) : -1;
    }
    const img = ctx.createImageData(W, H), d = img.data;
    const ed = opts.contour ? new Float32Array(W * H) : null;
    const out: RGB = opts.paper ? [217, 210, 192] : [40, 90, 132];
    for (let y = 0; y < H; y++) {
      const lat = viewBB.latMax - y / pxpdY, inRow = lat >= gb.latMin && lat <= gb.latMax;
      const row = inRow ? g.cells[Math.min(g.rows - 1, Math.floor((lat - gb.latMin) / g.step))] : null;
      for (let x = 0; x < W; x++) {
        const i = y * W + x, q = i * 4, c = row && cols[x] >= 0 ? rgbOf(row[cols[x]]) : out;
        d[q] = c[0]; d[q + 1] = c[1]; d[q + 2] = c[2]; d[q + 3] = 255;
        if (ed && row && cols[x] >= 0) ed[i] = elevSmooth(rule!.data, rule!, lons[x], lat);   // 规则场：线＝读数
      }
    }
    if (ed) for (let y = 0; y < H; y++) {
      const lat = viewBB.latMax - y / pxpdY;
      if (!(lat >= gb.latMin && lat <= gb.latMax)) continue;
      for (let x = 0; x < W; x++) {
        if (cols[x] < 0) continue;
        const i = y * W + x, q = i * 4;
        const c = contourMix(opts, W, H, [d[q], d[q + 1], d[q + 2]], ed, i, x, y, wsAt(lons[x], lat), lons[x], lat, pxpd, pxpdY, rule!);
        d[q] = c[0]; d[q + 1] = c[1]; d[q + 2] = c[2];
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  function renderTile(bb: BBox, pxpd: number, opts: TerrainRenderOpts): HTMLCanvasElement {
    const W = Math.max(2, Math.round((bb.lonMax - bb.lonMin) * pxpd)), H = Math.max(2, Math.round((bb.latMax - bb.latMin) * pxpd));
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    cv.getContext("2d")!.putImageData(paintTile(bb, pxpd, opts, 0, 0, W, H), 0, 0);
    return cv;
  }
  /** 瓦片 bb 里像素窗 [x0, x0+W)×[y0, y0+H) 的画面：纯逐像素计算、坐标恒从整块瓦片的原点量起＝窗内每个像素与整幅渲染逐字节同，
      只有窗边几像素（邻像素差分、岸线看不到窗外的格边）不同——补画须多算一圈外缘再裁掉 */
  function paintTile(bb: BBox, pxpd: number, opts: TerrainRenderOpts, x0: number, y0: number, W: number, H: number): ImageData {
    const img = new ImageData(W, H), d = img.data;
    const L2P = (x: number, y: number): [number, number] => [bb.lonMin + (x0 + x) / pxpd, bb.latMax - (y0 + y) / pxpd];
    /* 趟一：elev=双线性+宏观 fbm+微八度（晕渲/色阶/海岸）；esh=elev+材质纹理（只进法线）；
       ed=规则场制图面（帐篷平滑，等高线取它＝与读数同源）；cav=画面场帐篷差谷影。
       高程采样过同一域扭曲（同 GL：晕渲是画可形变，等高线是尺不动——ed 用未扭曲坐标）。 */
    const lonMin = grid!.bb.lonMin, latMin = grid!.bb.latMin, step = grid!.step;
    const gain = opts.gain ?? 1;   // 晕渲增益（material.shadeGain；趟一的谷影与趟二的法线共用）
    const microOn = octaveGate(pxpd, MICRO_F0) > 0;   // 整幅视角＝全部新增细节为零，趟一退化为旧管线成本
    const texW0 = FX.texW / pxpd;   // 纹理疏密逐像素乘，故基值在外
    const eroded = field!.shadow ? 1 : 0;   // 场经侵蚀（同 GL uEroded）：装饰按坡门控、宏观 fbm4 降到 1/4
    const fine = field!.step < grid!.step * 0.999 || eroded ? 1 : 0;   // 装饰噪声门只在细分/侵蚀场生效（粗格=旧图逐位契约）
    const elev = new Float32Array(W * H), esh = new Float32Array(W * H), ed = new Float32Array(W * H), cav = new Float32Array(W * H);
    const wsv = new Float32Array(W * H);   // 逐像素水面（同 GL：与晕渲高程同取扭曲后坐标）
    const mgx = new Float32Array(W * H), mgy = new Float32Array(W * H);   // 宏观场坡（±1 格、无噪声；同 GL mn）
    const occ = new Float32Array(W * H);   // 烘焙遮蔽（侵蚀场 shadow 通道；粗格恒 0）
    /* 球面图气候带的纬度改正（同 GL dLat：雪线、林线、色阶同一个），只随纬度＝逐行一个值；
       林线淡出按未扭曲点的双线性画面场高程判（同 GL cd.x），趟一算好趟二复用 */
    const clim = opts.clim, snow = opts.snow, rowShift = new Float64Array(H);
    if (snow && snow.lat) for (let y = 0; y < H; y++) rowShift[y] = (snowLatM(Math.abs(L2P(0, y)[1])) - snow.refM) / snow.unitM;
    const tfade = clim ? new Float32Array(W * H) : null;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, p = L2P(x, y);
      const rx = p[0] - lonMin, ry = p[1] - latMin;
      matAt(rx, ry);
      const wf = FX.warpF / step;   // 与 matAt 同一 warp（各自计算，函数确定性保证一致）
      const w1x = vnoise(rx * wf + 13.7, ry * wf + 91.2) - 0.5, w1y = vnoise(rx * wf + 57.1, ry * wf + 33.9) - 0.5;
      const w2x = vnoise(rx * wf * 3.1 + 7.3, ry * wf * 3.1 + 44.9) - 0.5, w2y = vnoise(rx * wf * 3.1 + 99.1, ry * wf * 3.1 + 5.7) - 0.5;
      const wx = (w1x + w2x * 0.35) * step * FX.warpAmp, wy = (w1y + w2y * 0.35) * step * FX.warpAmp;
      const lonW = p[0] + wx, latW = p[1] + wy;
      const e0 = elevBil(lonW, latW);
      mgx[i] = elevBil(lonW - step, latW) - elevBil(lonW + step, latW);
      mgy[i] = elevBil(lonW, latW + step) - elevBil(lonW, latW - step);
      /* 坡度补材质（同 GL：山的质感跟着坡走，与类型取大——手雕高山落在平原类型也有岩理） */
      const smac = Math.hypot(mgx[i], mgy[i]) / (2 * step);
      const roughEff = Math.max(MT.rough, Math.min(FX.slopeRoughMax, smac * FX.slopeRough));
      const twrEff = Math.max(MT.r, Math.min(1, smac * FX.slopeRidge));
      const rough = (e0 > 0.4 ? 0.24 : (e0 > 0.2 ? 0.08 : 0.025)) * (eroded ? 0.25 : 1);
      /* 装饰噪声门（同 GL：material.decoGate 单一真源）：平坦低地不再画假起伏；侵蚀场上只按坡门控（类型兜底不再算数） */
      wsv[i] = wsAt(lonW, latW);
      const decoK = decoGate(smac, eroded ? 0 : MT.rough, sstep(wsv[i] - 0.02, wsv[i] + 0.02, e0), fine);
      let e = e0 + (fbm(lonW * 1.1, latW * 1.1) - 0.5) * rough * 2 * decoK;
      if (microOn) e += micro(rx + wx, ry + wy, pxpd) * roughEff * FX.microAmp * decoK;
      elev[i] = e;
      /* 纹理疏密（同 GL；见 FX.texPatchF 头注）：世界锚定两八度低频调制，同一片林/沼/山有疏有密 */
      const pf = FX.texPatchF / step;
      const pn = 0.65 * vnoise(rx * pf + 19.3, ry * pf + 5.7) + 0.35 * vnoise(rx * pf * 2.7 + 63.1, ry * pf * 2.7 + 28.9);
      const texW = texW0 * (FX.texPatchLo + (FX.texPatchHi - FX.texPatchLo) * sstep(0.32, 0.68, pn));
      if (tfade) { const t = clim!.treeE + rowShift[y]; tfade[i] = sstep(t, t + clim!.band, elevBil(p[0], p[1])); }
      const twc = tfade ? MT.c * (1 - tfade[i]) : MT.c;   // 林线以上林冠纹理淡出（同 GL）
      esh[i] = microOn ? e + texAt(rx, ry, twc, MT.d, twrEff, MT.m, pxpd) * texW : e;
      const es = elevSmooth(field!.data, field!, p[0], p[1]);
      ed[i] = rule === field ? es : elevSmooth(rule!.data, rule!, p[0], p[1]);   // 画面场为精修档时线不跟画面
      cav[i] = Math.max(-0.10, Math.min(0.16, (es - elevBil(p[0], p[1])) / field!.step * gain * 2 * NRM0 * (1 + FX.macroW) * FX.cavAmp));   // 同 GL：按真实坡度并随夸张走
      occ[i] = field!.shadow ? elevBilinear(field!.shadow, field!, lonW, latW) : 0;   // 烘焙遮蔽（同 GL occAt(llw)）
    }
    const light = [-0.6, -0.6, 0.9], ll = Math.hypot(...light); light[0] /= ll; light[1] /= ll; light[2] /= ll;
    const nrm = 4.5 * (pxpd / 14) * gain;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, e = elev[i], ws = wsv[i], p = L2P(x, y);
      const rx = p[0] - lonMin, ry = p[1] - latMin;
      const eL = esh[y * W + Math.max(0, x - 1)], eR = esh[y * W + Math.min(W - 1, x + 1)];
      const eU = esh[Math.max(0, y - 1) * W + x], eD = esh[Math.min(H - 1, y + 1) * W + x];
      const nx = (eL - eR) * nrm, ny = (eU - eD) * nrm;
      /* 宏观场法线 + 陡坡软压 + 暖冷晕渲（同 GL：0.3214=nrm 对基础坡度响应系数之半）。
         ⚠ 「把细节从软压里摘出来单独叠」试过并撤回，理由见 GL 版同处头注 */
      const mnk = 0.3214 / step * FX.macroW * gain;
      let n2x = nx + mgx[i] * mnk, n2y = ny + mgy[i] * mnk;
      const sl = Math.hypot(n2x, n2y), sxc = Math.max(0, sl - FX.slopeKnee);
      const slc = Math.min(sl, FX.slopeKnee) + sxc * FX.slopeSoft / (FX.slopeSoft + sxc);   // 膝内恒等（同 GL）
      if (sl > 1e-6) { n2x *= slc / sl; n2y *= slc / sl; }
      const nl = Math.hypot(n2x, n2y, 1);
      const dn = (n2x / nl) * light[0] + (n2y / nl) * light[1] + (1 / nl) * light[2];
      const lt = sstep(FX.shadeKnee, 1, dn) * (1 - occ[i] * FX.shadowK);   // 投影阴影连同暖冷响应一起压暗（同 GL）
      const sh = FX.shadeLo + (FX.shadeHi - FX.shadeLo) * lt;
      const shR = FX.cool[0] + (FX.warm[0] - FX.cool[0]) * lt, shG = FX.cool[1] + (FX.warm[1] - FX.cool[1]) * lt, shB = FX.cool[2] + (FX.warm[2] - FX.cool[2]) * lt;
      let col = elevRamp(e, ws, clim, rowShift[y]);
      if (e >= ws - 0.02) {
        matAt(rx, ry);   // 趟二重取材质（色调/反照率/岩化）——省四条逐像素缓存数组的内存
        if (MT.tintW > 0) {
          const a = 0.45 * MT.tintW;
          let tr = MT.tr, tg = MT.tg, tb = MT.tb;
          const fk = tfade ? tfade[i] * Math.max(0, Math.min(1, MT.c / FOREST_CANOPY)) : 0;
          if (fk > 0) { tr += (clim!.meadow[0] - tr) * fk; tg += (clim!.meadow[1] - tg) * fk; tb += (clim!.meadow[2] - tb) * fk; }   // 林线以上的森林换草甸色（同 GL）
          col = [col[0] * (1 - a) + tr * a, col[1] * (1 - a) + tg * a, col[2] * (1 - a) + tb * a];
        }
        // 生态辨识度（同 GL）：荒漠暖沙定调；沼泽湿绿+近景水洼/湿泥（键=材质权重）
        if (MT.d > 0.003) {
          const a = MT.d * FX.sandMix;
          col = [col[0] * (1 - a) + FX.sandC[0] * 255 * a, col[1] * (1 - a) + FX.sandC[1] * 255 * a, col[2] * (1 - a) + FX.sandC[2] * 255 * a];
        }
        if (MT.m > 0.003) {
          const a = MT.m * FX.marshMix;
          col = [col[0] * (1 - a) + FX.marshC[0] * 255 * a, col[1] * (1 - a) + FX.marshC[1] * 255 * a, col[2] * (1 - a) + FX.marshC[2] * 255 * a];
          const pg = sstep(FX.poolLo, FX.poolHi, pxpd * step) * MT.m * (opts.paper ? 1 : 0);   // px/格；只在战术图（同 GL）
          if (pg > 0.003) {
            const pf = FX.poolF / (grid ? grid.step : 1);
            const pn = 0.65 * vnoise(rx * pf + 7.3, ry * pf + 3.9) + 0.35 * vnoise(rx * pf * 2.7 + 51.3, ry * pf * 2.7 + 17.9);   // 两八度（同 GL）
            const pw = sstep(0.58, 0.68, pn);
            const mw = sstep(0.40, 0.58, pn) * (1 - pw) * pg * FX.mudMix;
            col = [col[0] * (1 - mw) + FX.mudC[0] * 255 * mw, col[1] * (1 - mw) + FX.mudC[1] * 255 * mw, col[2] * (1 - mw) + FX.mudC[2] * 255 * mw];
            const pa = pw * pg * FX.poolMix;
            col = [col[0] * (1 - pa) + FX.poolC[0] * 255 * pa, col[1] * (1 - pa) + FX.poolC[1] * 255 * pa, col[2] * (1 - pa) + FX.poolC[2] * 255 * pa];
          }
        }
        if (microOn && MT.albVar > 0) {   // 反照率抖动（同 GL：屏幕锚定低频 × 门控）
          const [f1, f2, fr] = lodF(pxpd, FX.albPx), g = octaveGate(pxpd, f1);
          if (g > 0) {
            const av = vnoise(rx * f1 + 19.9, ry * f1 + 7.1) * (1 - fr) + vnoise(rx * f2 + 2.3, ry * f2 + 27.9) * fr - 0.5;
            const m = 1 + av * MT.albVar * FX.albAmp * g;
            col = [col[0] * m, col[1] * m, col[2] * m];
          }
        }
        const slp = Math.hypot(nx, ny);   // 坡度岩化（同 GL）
        const rk = sstep(FX.rockSlopeLo, FX.rockSlopeHi, slp) * MT.rock;
        if (rk > 0) {
          const t = Math.max(0, Math.min(1, e * 1.1)), a = rk * FX.rockMix;
          const rc = [(0.36 + 0.26 * t) * 255, (0.33 + 0.27 * t) * 255, (0.30 + 0.27 * t) * 255];
          col = [col[0] * (1 - a) + rc[0] * a, col[1] * (1 - a) + rc[1] * a, col[2] * (1 - a) + rc[2] * a];
        }
        const S = opts.snow;   // 雪按米落（同 GL：material.snowSpec 同式，随纬度只在球面图且设了气候档；陡坡挂不住雪打六折）
        const snE = S ? Math.max(0, S.base + rowShift[y]) : 1e9;
        const sn = sstep(snE, snE + FX.snowBand, e) * (1 - 0.6 * sstep(FX.snowSlopeLo, FX.snowSlopeHi, slp));
        if (sn > 0) col = [col[0] + (237.15 - col[0]) * sn, col[1] + (239.7 - col[1]) * sn, col[2] + (246.075 - col[2]) * sn];
        const ak = sstep(FX.airLo, FX.airHi, e) * FX.airMix;   // 空气透视（同 GL）
        if (ak > 0) col = [col[0] + (FX.airC[0] * 255 - col[0]) * ak, col[1] + (FX.airC[1] * 255 - col[1]) * ak, col[2] + (FX.airC[2] * 255 - col[2]) * ak];
        const s2 = sh * (1 - cav[i]);
        col = [col[0] * s2 * shR, col[1] * s2 * shG, col[2] * s2 * shB];
        col = contourMix(opts, W, H, col, ed, i, x, y, ws, p[0], p[1], pxpd, pxpd, rule!);
      } else {
        const shore = sstep(ws - 0.10, ws - 0.02, e) * sstep(FX.shoreLo, FX.shoreHi, pxpd * step);   // 近岸浅水带随 px/格 渐显（同 GL）
        const sc = [0.55 * 255, 0.72 * 255, 0.75 * 255], sa = shore * FX.shoreMix;
        col = [col[0] * (1 - sa) + sc[0] * sa, col[1] * (1 - sa) + sc[1] * sa, col[2] * (1 - sa) + sc[2] * sa];
        if (microOn) {   // 静态波纹（同 GL：值噪声 ridged + 横向拉伸 + 门控）
          const [f1, f2, fr] = lodF(pxpd, FX.wavePx), g = octaveGate(pxpd, f1);
          if (g > 0) {
            const ra = 1 - Math.abs(2 * vnoise(rx * 0.35 * f1 + 3.1, ry * f1 + 9.7) - 1);
            const rb = 1 - Math.abs(2 * vnoise(rx * 0.35 * f2 + 21.3, ry * f2 + 1.1) - 1);
            const m = 1 + (ra + (rb - ra) * fr - 0.5) * FX.waveAmp * g;
            col = [col[0] * m, col[1] * m, col[2] * m];
          }
        }
      }
      const q = i * 4; d[q] = col[0]; d[q + 1] = col[1]; d[q + 2] = col[2]; d[q + 3] = 255;
    }
    coastInk(d, elev, wsv, W, H, Math.max(1, Math.min(1.5 * (opts.dpr ?? 1), pxpd / 14)));
    return img;
  }

  /** 把上传前后两份数据的差异折成经纬矩形（外扩到每个像素取样所及：扭曲 + 宏观坡 ±1 格 + 双线性与帐篷平滑）；
      网格或场换了形状＝"all"（整块重画） */
  function changedSince(p: { g: Grid; f: ElevField; r: ElevField; ws: Float32Array; mat: Float32Array; tint: Float32Array; has: Uint8Array }): BBox[] | "all" {
    const g = grid!, f = field!, r = rule!;
    if (g !== p.g && !sameGeom(g, p.g)) return "all";
    const m = g.step * 3 + Math.max(f.step, r.step) * 2, out: BBox[] = [];
    const add = (box: number[] | null, geo: { bb: BBox; step: number }): void => {
      if (box) out.push({ lonMin: geo.bb.lonMin + box[0] * geo.step - m, lonMax: geo.bb.lonMin + (box[2] + 1) * geo.step + m,
        latMin: geo.bb.latMin + box[1] * geo.step - m, latMax: geo.bb.latMin + (box[3] + 1) * geo.step + m });
    };
    for (const [a, b] of p.r === p.f && r === f ? [[p.f, f]] : [[p.f, f], [p.r, r]]) {
      if (a === b) continue;
      if (!sameGeom(a, b) || !a.shadow !== !b.shadow) return "all";
      add(changedBox(a.data, b.data, b.cols, b.rows), b);
      if (a.shadow && a.shadow !== b.shadow) add(changedBox(a.shadow, b.shadow!, b.cols, b.rows), b);
    }
    if (p.ws !== cellWS) add(changedBox(p.ws, cellWS!, g.cols, g.rows), g);
    if (p.mat !== cellMat) {
      add(changedBox(p.mat, cellMat!, g.cols, g.rows, 7), g); add(changedBox(p.tint, cellTint!, g.cols, g.rows, 3), g);
      add(changedBox(p.has, cellTintHas!, g.cols, g.rows), g);
    }
    return out;
  }
  /** 把 rects 补进瓦片；要补的面积过半返回 false（整块重画更省） */
  function patchTile(t: Tile, rects: BBox[]): boolean {
    const W = t.cv.width, H = t.cv.height, pd = t.rp, dpr = t.o.dpr ?? 1;
    const pm = Math.ceil(10 * dpr) + Math.ceil(1.5 * dpr) + 3;   // 变化能波及的像素：间曲线门 ±10 CSS px 取样 + 岸线线宽 + 邻像素差分
    const rm = Math.ceil(1.5 * dpr) + 3;                          // 只算不贴的外缘：让窗边像素也看得见窗外的邻像素与岸线格边
    const wins: number[][] = [];
    let area = 0;
    for (const d of rects) {
      const x0 = Math.max(0, Math.floor((d.lonMin - t.bb.lonMin) * pd) - pm), x1 = Math.min(W, Math.ceil((d.lonMax - t.bb.lonMin) * pd) + pm);
      const y0 = Math.max(0, Math.floor((t.bb.latMax - d.latMax) * pd) - pm), y1 = Math.min(H, Math.ceil((t.bb.latMax - d.latMin) * pd) + pm);
      if (x1 > x0 && y1 > y0) { wins.push([x0, y0, x1, y1]); area += (x1 - x0) * (y1 - y0); }
    }
    if (area > 0.5 * W * H) return false;
    const tctx = t.cv.getContext("2d")!;
    for (const [x0, y0, x1, y1] of wins) {
      const X0 = Math.max(0, x0 - rm), Y0 = Math.max(0, y0 - rm), X1 = Math.min(W, x1 + rm), Y1 = Math.min(H, y1 + rm);
      tctx.putImageData(paintTile(t.bb, pd, t.o, X0, Y0, X1 - X0, Y1 - Y0), X0, Y0, x0 - X0, y0 - Y0, x1 - x0, y1 - y0);   // 只贴内窗、逐字节，不经合成
    }
    return true;
  }

  return {
    canvas, kind: "cpu",
    uploadGrid(g: Grid, wsurf: Float32Array, f?: ElevField, r?: ElevField) {
      const prev = tiles.length && grid ? { g: grid, f: field!, r: rule!, ws: cellWS!, mat: cellMat!, tint: cellTint!, has: cellTintHas! } : null;
      const sameGrid = g === grid;
      grid = g; field = f || coarseField(g, fieldOfTypes(g)); rule = r || field; cellWS = wsurf;
      if (!sameGrid) {   // 同一 Grid 实例＝只动了高程，逐格材质/色调不变
        const n = g.rows * g.cols;   // 逐格材质/色调预算（renderTile 每像素四角查表）
        cellMat = new Float32Array(n * 7); cellTint = new Float32Array(n * 3); cellTintHas = new Uint8Array(n);
        for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
          const k = r * g.cols + c, cell = g.cells[r][c], m = materialFor(cell), t = terrainProps(cell).tint;
          cellMat.set([m.canopy, m.dune, m.ridge, m.marsh, m.rough, m.albVar, m.rock], k * 7);
          if (t) { cellTint.set(t, k * 3); cellTintHas[k] = 1; }
        }
      }
      const d = prev ? changedSince(prev) : "all";
      if (d === "all") { tiles = []; dirty = []; }
      else if (d.length) dirty = dirty.length + d.length > 16 ? [unionBB(dirty.concat(d))] : dirty.concat(d);   // 攒多了并成一块，免得逐块重算外缘
    },
    render(viewBB: BBox, opts: TerrainRenderOpts = {}) {
      if (!grid) return;
      if (opts.flat) { renderFlat(viewBB, opts); return; }
      const [W, H] = opts.px ?? [canvas.width, canvas.height];   // 可见区（画布可更大，只画左上这一块）
      const pxpd = W / (viewBB.lonMax - viewBB.lonMin);
      // 球面环绕：视口按每份拷贝平移 c 折回网格所在域做瓦片判定/重建，贴图时再按拷贝偏移回来
      const copies = wrapCopies(viewBB, grid.bb, !!opts.wrap);
      /* 键须罩住瓦片读到的每个选项（增益随缩放变）：数据不变时瓦片留用，漏一项＝改那项设置后画面不动 */
      const S = opts.snow;
      const key = `g${(opts.gain ?? 1).toFixed(2)}d${opts.dpr ?? 1}` + (opts.contour ? `c${opts.cStep || 0.12}` : "") + (opts.paper ? "p" : "")
        + (S ? `s${S.base},${S.lat ? 1 : 0},${S.refM},${S.unitM}` : "") + (opts.clim ? `k${opts.clim.key}` : "");
      const next: Tile[] = [];
      for (const c of copies) {
        const vb: BBox = c ? { lonMin: viewBB.lonMin + c, lonMax: viewBB.lonMax + c, latMin: viewBB.latMin, latMax: viewBB.latMax } : viewBB;
        let t = next.concat(tiles).find(x => planTile(x, key, vb, pxpd, grid!.bb) === "keep");   // 视口宽过一份世界时几份拷贝要的是同一片
        if (t && dirty.length && !next.includes(t) && !patchTile(t, dirty)) { const stale = t; tiles = tiles.filter(x => x !== stale); t = undefined; }
        if (!t) {
          const plan = planTile(null, key, vb, pxpd, grid.bb);
          if (typeof plan !== "object") continue;
          /* 瓦片被像素预算封顶（renderPxpd < pxpd）时贴回屏幕要放大 pxpd/renderPxpd 倍：等高线的像素量按 CSS 像素锚定，
             喂给瓦片的 dpr 须同比缩小，否则线在屏幕上按放大倍数变粗（960 px 方图 DPR4 实测 6.8 px） */
          const s = plan.renderPxpd / plan.pxpd;
          const o = s < 1 ? { ...opts, dpr: (opts.dpr ?? 1) * s } : opts;
          t = { cv: renderTile(plan.bb, plan.renderPxpd, o), bb: plan.bb, pxpd: plan.pxpd, key, rp: plan.renderPxpd, o };
        }
        if (!next.includes(t)) next.push(t);
      }
      tiles = next; dirty = [];
      // 底色=深水（视口越出网格范围的部分；战术图按 paper 裁决铺宣纸色），再按世界拷贝贴瓦片。
      // 纵向用独立 pxpdY：viewBB 经度含 cos(lat0) 校正、纬度不含，贴图须各向异性拉伸
      //（对齐旧 drawTile 经 project 求角点的行为；瓦片内部仍为方度像素，交给 drawImage 缩放）。
      const pxpdY = H / (viewBB.latMax - viewBB.latMin);
      ctx.fillStyle = opts.paper ? "#d9d2c0" : "rgb(40,90,132)";
      ctx.fillRect(0, 0, W, H);
      for (const t of tiles) {
        const py0 = (viewBB.latMax - t.bb.latMax) * pxpdY, py1 = (viewBB.latMax - t.bb.latMin) * pxpdY;
        for (const c of copies) {
          const x0 = (t.bb.lonMin - c - viewBB.lonMin) * pxpd, x1 = (t.bb.lonMax - c - viewBB.lonMin) * pxpd;
          if (x1 <= 0 || x0 >= W) continue;
          ctx.drawImage(t.cv, x0, py0, x1 - x0, py1 - py0);
        }
      }
    },
    maxDim() { return 16384; },   // Canvas2D 各主流实现的稳妥边长
    rendererName() { return "CPU 瓦片（Canvas2D 兜底）"; },
    dispose() { tiles = []; dirty = []; grid = null; field = null; cellMat = null; cellTint = null; cellTintHas = null; cellWS = null; }
  };
}
