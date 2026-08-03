/* CPU 兜底地形渲染器（Canvas2D）：仅在建不出 WebGL2 上下文的环境使用。
   像素管线与 GL 版同构（= 旧版 renderRegion 语义：高程双线性 + 细节噪声 + 晕渲 + 色阶 +
   生态色调 + 海岸线，2026-08 起加 域扭曲/微八度/材质纹理/谷影/岩化/水面观感——
   结构与系数同 GL（数值系数单一真源 render/material.FX），噪声哈希不同（此处 sin-hash fp64、
   GL 是 PCG2D fp32）＝观感同构而非逐位一致，与宏观 fbm 的既有纪律相同。
   等高线与 GL 版同构地画在**无噪声数据面**（细/计曲线 + contourStepFor 缩放自适应等距）。
   性能策略沿袭旧版：**世界锚定瓦片 + 30% 余量**——平移只重贴图，视口越出余量或缩放变档才重渲。 */
import { fbm, vnoise, hash2 } from "../core/noise.ts";
import { terrainProps } from "../core/constants.ts";
import { elevBilinear, elevSmooth } from "../core/elev.ts";
import { materialFor, octaveGate, MICRO_F0, MICRO_OCTAVES, FX } from "./material.ts";
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
      const a = sstep(0.35, 0.8, vnoise(rx * f1 + 7.7, ry * f1 + 3.1)), b = sstep(0.35, 0.8, vnoise(rx * f2 + 3.3, ry * f2 + 8.9));
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

function elevRamp(e: number): [number, number, number] {
  if (e < -0.02) { const t = Math.max(0, Math.min(1, (e + 0.35) / 0.33)); return [40 + t * 60, 90 + t * 70, 132 + t * 66]; }
  if (e < 0.09) return [224, 216, 172];
  if (e < 0.30) { const t = (e - 0.09) / 0.21; return [132 + t * 38, 174 - t * 2, 98 + t * 12]; }
  if (e < 0.55) { const t = (e - 0.30) / 0.25; return [170 + t * 8, 166 - t * 12, 110 - t * 4]; }
  if (e < 0.82) { const t = (e - 0.55) / 0.27; return [178 - t * 28, 152 - t * 24, 118 - t * 22]; }
  const t = Math.min(1, (e - 0.82) / 0.18); return [140 + t * 100, 132 + t * 104, 124 + t * 118];
}

export function createTerrainCPU(canvas: HTMLCanvasElement): TerrainRenderer {
  const ctx = canvas.getContext("2d")!;
  let grid: Grid | null = null;
  let field: Float32Array | null = null;   // 每格高程场（buildElevField；缺省=ELEV[类型] 旧行为）
  let tile: { cv: HTMLCanvasElement; bb: BBox; pxpd: number; key: string } | null = null;
  /* 逐格材质/色调（uploadGrid 预算；7 浮点=canopy,dune,ridge,marsh,rough,albVar,rock + tint 3 通道与有无） */
  let cellMat: Float32Array | null = null;
  let cellTint: Float32Array | null = null;
  let cellTintHas: Uint8Array | null = null;

  /* 高程场恒备：未传入时按 ELEV[类型] 合成（旧行为）；双线性统一走 core/elev.elevBilinear（与光标读数同源） */
  const fieldOfTypes = (g: Grid): Float32Array => {
    const f = new Float32Array(g.rows * g.cols);
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) f[r * g.cols + c] = terrainProps(g.cells[r][c]).elev;
    return f;
  };
  const elevBil = (lon: number, lat: number): number => elevBilinear(field!, grid!, lon, lat);
  function nearestT(lon: number, lat: number) {
    const g = grid!;
    const r = Math.max(0, Math.min(g.rows - 1, Math.floor((lat - g.bb.latMin) / g.step)));
    const c = Math.max(0, Math.min(g.cols - 1, Math.floor((lon - g.bb.lonMin) / g.step)));
    return g.cells[r][c];
  }

  /* 域扭曲后的四角双线性材质/色调（同 GL matAt；逐像素两趟调用故写进复用对象 MT，免 GC）。
     rx/ry=图幅局部坐标（lon-lonMin, lat-latMin） */
  const MT = { tr: 0, tg: 0, tb: 0, tintW: 0, c: 0, d: 0, r: 0, m: 0, rough: 0, albVar: 0, rock: 0 };
  function matAt(rx: number, ry: number): void {
    const g = grid!, step = g.step, cols = g.cols, rows = g.rows;
    const wf = FX.warpF / step;   // 同 GL warpOf：双频、幅度 <半格
    const w1x = vnoise(rx * wf + 13.7, ry * wf + 91.2) - 0.5, w1y = vnoise(rx * wf + 57.1, ry * wf + 33.9) - 0.5;
    const w2x = vnoise(rx * wf * 3.1 + 7.3, ry * wf * 3.1 + 44.9) - 0.5, w2y = vnoise(rx * wf * 3.1 + 99.1, ry * wf * 3.1 + 5.7) - 0.5;
    const rwx = rx + (w1x + w2x * 0.35) * step * FX.warpAmp, rwy = ry + (w1y + w2y * 0.35) * step * FX.warpAmp;
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

  function renderTile(bb: BBox, pxpd: number, opts: TerrainRenderOpts): HTMLCanvasElement {
    const W = Math.max(2, Math.round((bb.lonMax - bb.lonMin) * pxpd)), H = Math.max(2, Math.round((bb.latMax - bb.latMin) * pxpd));
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const octx = cv.getContext("2d")!, img = octx.createImageData(W, H), d = img.data;
    const L2P = (x: number, y: number): [number, number] => [bb.lonMin + x / pxpd, bb.latMax - y / pxpd];
    if (opts.diag) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const p = L2P(x, y), c = terrainProps(nearestT(p[0], p[1])).color, q = (y * W + x) * 4;
        d[q] = parseInt(c.slice(1, 3), 16); d[q + 1] = parseInt(c.slice(3, 5), 16); d[q + 2] = parseInt(c.slice(5, 7), 16); d[q + 3] = 255;
      }
      octx.putImageData(img, 0, 0); return cv;
    }
    /* 趟一：elev=双线性+宏观 fbm+微八度（晕渲/色阶/海岸）；esh=elev+材质纹理（只进法线）；
       ed=制图面（帐篷平滑，等高线+谷影恒算）；cav=帐篷差谷影。
       高程采样过同一域扭曲（同 GL：晕渲是画可形变，等高线是尺不动——ed 用未扭曲坐标）。 */
    const lonMin = grid!.bb.lonMin, latMin = grid!.bb.latMin, step = grid!.step;
    const microOn = octaveGate(pxpd, MICRO_F0) > 0;   // 整幅视角＝全部新增细节为零，趟一退化为旧管线成本
    const texW = FX.texW / pxpd;
    const elev = new Float32Array(W * H), esh = new Float32Array(W * H), ed = new Float32Array(W * H), cav = new Float32Array(W * H);
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
      const rough = e0 > 0.4 ? 0.24 : (e0 > 0.2 ? 0.08 : 0.025);
      let e = e0 + (fbm(lonW * 1.1, latW * 1.1) - 0.5) * rough * 2;
      if (microOn) e += micro(rx + wx, ry + wy, pxpd) * MT.rough * FX.microAmp;
      elev[i] = e;
      esh[i] = microOn ? e + texAt(rx, ry, MT.c, MT.d, MT.r, MT.m, pxpd) * texW : e;
      const es = elevSmooth(field!, grid!, p[0], p[1]);
      ed[i] = es;
      cav[i] = Math.max(-0.10, Math.min(0.16, (es - elevBil(p[0], p[1])) * FX.cavAmp));
    }
    const light = [-0.6, -0.6, 0.9], ll = Math.hypot(...light); light[0] /= ll; light[1] /= ll; light[2] /= ll;
    const nrm = 4.5 * (pxpd / 14);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, e = elev[i], p = L2P(x, y);
      const rx = p[0] - lonMin, ry = p[1] - latMin;
      const eL = esh[y * W + Math.max(0, x - 1)], eR = esh[y * W + Math.min(W - 1, x + 1)];
      const eU = esh[Math.max(0, y - 1) * W + x], eD = esh[Math.min(H - 1, y + 1) * W + x];
      const nx = (eL - eR) * nrm, ny = (eU - eD) * nrm, nl = Math.hypot(nx, ny, 1);
      let sh = (nx / nl) * light[0] + (ny / nl) * light[1] + (1 / nl) * light[2]; sh = 0.6 + 0.75 * Math.max(0, sh);
      let col = elevRamp(e);
      if (e >= -0.02) {
        matAt(rx, ry);   // 趟二重取材质（色调/反照率/岩化）——省四条逐像素缓存数组的内存
        if (MT.tintW > 0) {
          const a = 0.45 * MT.tintW;
          col = [col[0] * (1 - a) + MT.tr * a, col[1] * (1 - a) + MT.tg * a, col[2] * (1 - a) + MT.tb * a];
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
        const rk = sstep(0.55, 1.6, slp) * MT.rock;
        if (rk > 0) {
          const t = Math.max(0, Math.min(1, e * 1.1)), a = rk * FX.rockMix;
          const rc = [(0.36 + 0.26 * t) * 255, (0.33 + 0.27 * t) * 255, (0.30 + 0.27 * t) * 255];
          col = [col[0] * (1 - a) + rc[0] * a, col[1] * (1 - a) + rc[1] * a, col[2] * (1 - a) + rc[2] * a];
        }
        const s2 = sh * (1 - cav[i]);
        col = [col[0] * s2, col[1] * s2, col[2] * s2];
        if (opts.contour && ed[i] >= -0.02
          && p[0] > grid!.bb.lonMin + grid!.step && p[0] < grid!.bb.lonMax - grid!.step
          && p[1] > grid!.bb.latMin + grid!.step && p[1] < grid!.bb.latMax - grid!.step) {
          // 等高线画在制图面 ed（帐篷平滑数据面，与读数一致）；公式与 GL 版同构；图幅内缩一格裁掉贴边假线
          const ci = opts.cMinor || 0.12, fd = opts.cFade || 0, eh = ed[i] + 0.02;
          const ad = Math.abs(ed[y * W + Math.min(W - 1, x + 1)] - ed[i]) + Math.abs(ed[Math.min(H - 1, y + 1) * W + x] - ed[i]) + 1e-7;
          const mn = Math.max(cw(eh, ci, ad, 0.8, 1.5), cw(eh, ci * 0.5, ad, 0.8, 1.5) * oddK(eh, ci * 0.5) * fd);
          const ix = Math.max(cw(eh, ci * 4, ad, 1.3, 2.4), cw(eh, ci * 2, ad, 1.3, 2.4) * oddK(eh, ci * 2) * fd);
          const sup = sstep(2.5, 6, ci / ad), supIx = sstep(2.5, 6, ci * 4 / ad);   // 挤线抑制：陡坎细曲线隐去、计曲线幸存
          const k = Math.max(mn * 0.50 * sup, ix * 0.70 * supIx);
          col = [col[0] + (90 - col[0]) * k, col[1] + (70 - col[1]) * k, col[2] + (40 - col[2]) * k];
        }
      } else {
        const shore = sstep(-0.10, -0.02, e);   // 近岸浅水带（同 GL）
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
    octx.putImageData(img, 0, 0);
    octx.strokeStyle = "rgba(38,66,86,.55)"; octx.lineWidth = Math.max(1, pxpd / 14); octx.beginPath();
    for (let y = 1; y < H; y++) for (let x = 1; x < W; x++) {
      const a = elev[y * W + x] >= -0.02;
      if (a !== (elev[y * W + x - 1] >= -0.02)) { octx.moveTo(x, y - 0.5); octx.lineTo(x, y + 0.5); }
      if (a !== (elev[(y - 1) * W + x] >= -0.02)) { octx.moveTo(x - 0.5, y); octx.lineTo(x + 0.5, y); }
    }
    octx.stroke();
    return cv;
  }

  return {
    canvas, kind: "cpu",
    uploadGrid(g: Grid, elev?: Float32Array) {
      grid = g; field = elev || fieldOfTypes(g); tile = null;
      const n = g.rows * g.cols;   // 逐格材质/色调预算（renderTile 每像素四角查表）
      cellMat = new Float32Array(n * 7); cellTint = new Float32Array(n * 3); cellTintHas = new Uint8Array(n);
      for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
        const k = r * g.cols + c, cell = g.cells[r][c], m = materialFor(cell), t = terrainProps(cell).tint;
        cellMat.set([m.canopy, m.dune, m.ridge, m.marsh, m.rough, m.albVar, m.rock], k * 7);
        if (t) { cellTint.set(t, k * 3); cellTintHas[k] = 1; }
      }
    },
    render(viewBB: BBox, opts: TerrainRenderOpts = {}) {
      if (!grid) return;
      const pxpd = canvas.width / (viewBB.lonMax - viewBB.lonMin);
      // 球面环绕：把视口平移 k×360° 折回网格所在域做瓦片判定/重建，贴图时再按拷贝偏移回来
      const k = opts.wrap
        ? 360 * Math.round(((grid.bb.lonMin + grid.bb.lonMax) / 2 - (viewBB.lonMin + viewBB.lonMax) / 2) / 360)
        : 0;
      const vb: BBox = k ? { lonMin: viewBB.lonMin + k, lonMax: viewBB.lonMax + k, latMin: viewBB.latMin, latMax: viewBB.latMax } : viewBB;
      const key = (opts.diag ? "d" : "") + (opts.contour ? `c${opts.cMinor || 0.12}f${Math.round((opts.cFade || 0) * 4)}` : "");   // fade 量化 1/4 桶：连续缩放不致每帧重渲瓦片
      const plan = planTile(tile, key, vb, pxpd, grid.bb);
      if (plan === "none") tile = null;
      else if (plan !== "keep") tile = { cv: renderTile(plan.bb, plan.renderPxpd, opts), bb: plan.bb, pxpd: plan.pxpd, key };
      // 底色=深水（视口越出网格范围的部分；战术图按 paper 裁决铺宣纸色），再按世界拷贝贴瓦片。
      // 纵向用独立 pxpdY：viewBB 经度含 cos(lat0) 校正、纬度不含，贴图须各向异性拉伸
      //（对齐旧 drawTile 经 project 求角点的行为；瓦片内部仍为方度像素，交给 drawImage 缩放）。
      const pxpdY = canvas.height / (viewBB.latMax - viewBB.latMin);
      ctx.fillStyle = opts.paper ? "#d9d2c0" : "rgb(40,90,132)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (tile) {
        const py0 = (viewBB.latMax - tile.bb.latMax) * pxpdY, py1 = (viewBB.latMax - tile.bb.latMin) * pxpdY;
        for (const s of (opts.wrap ? [-360, 0, 360] : [0])) {
          const x0 = (tile.bb.lonMin - k + s - viewBB.lonMin) * pxpd, x1 = (tile.bb.lonMax - k + s - viewBB.lonMin) * pxpd;
          if (x1 <= 0 || x0 >= canvas.width) continue;
          ctx.drawImage(tile.cv, x0, py0, x1 - x0, py1 - py0);
        }
      }
    },
    rendererName() { return "CPU 瓦片（Canvas2D 兜底）"; },
    dispose() { tile = null; grid = null; field = null; cellMat = null; cellTint = null; cellTintHas = null; }
  };
}
