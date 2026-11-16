/* CPU 兜底地形渲染器（Canvas2D）：仅在建不出 WebGL2 上下文的环境使用。
   像素管线与 GL 版同构（= 旧版 renderRegion 语义：高程双线性 + 细节噪声 + 晕渲 + 色阶 +
   生态色调 + 海岸线，2026-08 起加 域扭曲/微八度/材质纹理/谷影/岩化/水面观感——
   结构与系数同 GL（数值系数单一真源 render/material.FX），噪声哈希不同（此处 sin-hash fp64、
   GL 是 PCG2D fp32）＝观感同构而非逐位一致，与宏观 fbm 的既有纪律相同。
   等高线与 GL 版同构地画在**规则场（工作档）的无噪声制图面**（首/计曲线，contourStepFor 的 1-2-5 阶梯单系取档；像素量按 opts.dpr 锚 CSS 像素）。
   性能策略沿袭旧版：**世界锚定瓦片 + 30% 余量**——平移只重贴图，视口越出余量或缩放变档才重渲；
   数据同形的改动（笔刷）只补画变了的那片，补画与整幅重画逐字节相同。
   推演底图（opts.flat）例外：逐屏幕像素直接栅格化、不走瓦片（贴图重采样会让格边像素取到邻格）。 */
import { fbm } from "../core/noise.ts";
import { terrainProps, compositeIndex, WATER_EPS } from "../core/constants.ts";
import { elevBilinear, elevSmooth, waterMask, type ElevField, type RuleField } from "../core/elev.ts";
import { zoneColMix, zoneTreeMix, zoneWeightsAt, ZONE_N, type ZoneWeights } from "./zones.ts";
import { airK, albM, beachK, blendSharp, cavOf, climRampColor, contourK, fbmRough, haloK, latShift, lodF, macroK, marshK, materialFor, meadowK, micro, octaveGate, decoGate, marshGate, patchN, poolGate, poolMask, rampColor, rockK, rockT,
  sandK, shadeOf, shoreElev, shoreK, slopeRidge, slopeRough, slopeSoft, snowAt, snowLine, snowSlope, texAt, texPatchK, tintK, treeFade, warp2Of, warpOf, waterT, waveM,
  albAv, poolN, sstep01 as sstep, waveWv, CONTOUR, PAPER, PAPER_RGB, FINE_STEP_K, FULL_WRAP_DEG, MICRO_F0, NRM_K, NRM_PX, FX, SHADE_LIGHT, WATER, type ClimLook } from "./material.ts";
import { riverDirty, riverSD } from "./rivers.ts";
import { bandAt, bandField } from "./beach.ts";
import type { Grid } from "../core/grid.ts";
import type { BBox } from "../core/types.ts";
import { tileCells, tileElevAt, tileWeight, type TileLayer } from "../core/tiles.ts";
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
    以岸线墨（WATER.ink / inkA）逐像素混进 d——不走画布描边：浏览器按路径繁简换光栅算法，补画窗与整块瓦片的抗锯齿会差一两级。
    w 按屏幕像素封顶（同 GL 约 1.4 px 的 coast 带）：只按 pxpd 放大时战术图放大后每段描成上百 px 宽＝沿岸成片矩形染色。
    @param rsd 逐像素到当水画的河面的有向距离（负＝河里）：河里也算水，岸线只描河与湖海并集的边；缺省＝没有河 */
export function coastInk(d: Uint8ClampedArray, elev: Float32Array, wsv: Float32Array, W: number, H: number, w: number, rsd?: Float32Array | null): void {
  const land = rsd ? (i: number): boolean => elev[i] >= wsv[i] - WATER_EPS && !(rsd[i] < 0) : (i: number): boolean => elev[i] >= wsv[i] - WATER_EPS;
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
    const k = WATER.inkA * n / 16, q = (py * W + px) * 4, I = WATER.ink;
    d[q] += (I[0] - d[q]) * k; d[q + 1] += (I[1] - d[q + 1]) * k; d[q + 2] += (I[2] - d[q + 2]) * k;
  }
}
/** 岸值（同 GL shoreAt）：四角类型格水陆标志的双线性，陆占比 − 0.5（>0 画成陆）。fx/fy 以格心为整数点；出格取边格，wrapC＝整圈图的列首尾相接。
    格心上恒为 ±0.5＝每个类型格的中心不换边：单格的岛、湖、海峡都留得住，河口点（在水格格心）不上岸 */
export function shoreAt(water: Uint8Array, cols: number, rows: number, fx: number, fy: number, wrapC: boolean): number {
  const i0 = Math.floor(fx);
  let c0 = Math.max(0, Math.min(cols - 1, i0)), c1 = Math.min(cols - 1, c0 + 1), tx = Math.max(0, Math.min(1, fx - c0));
  if (wrapC) { c0 = ((i0 % cols) + cols) % cols; c1 = (c0 + 1) % cols; tx = fx - i0; }
  const r0 = Math.max(0, Math.min(rows - 1, Math.floor(fy))), r1 = Math.min(rows - 1, r0 + 1), ty = Math.max(0, Math.min(1, fy - r0));
  return (water[r0 * cols + c0] ? 0 : (1 - tx) * (1 - ty)) + (water[r0 * cols + c1] ? 0 : tx * (1 - ty)) + (water[r1 * cols + c0] ? 0 : (1 - tx) * ty) + (water[r1 * cols + c1] ? 0 : tx * ty) - 0.5;
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



function elevRamp(e: number, ws: number, clim?: ClimLook, dl = 0): [number, number, number] {
  if (e < ws - WATER_EPS) { const t = waterT(e, ws), D = WATER.deep, S = WATER.shallow; return [D[0] + t * (S[0] - D[0]), D[1] + t * (S[1] - D[1]), D[2] + t * (S[2] - D[2])]; }
  if (clim && clim.n > 0) return climRampColor(clim, e, dl);   // 气候色阶（dl＝球面图纬度改正；同 GL）
  return rampColor(e);   // 陆地分层设色（GL 同源）
}

export function createTerrainCPU(canvas: HTMLCanvasElement): TerrainRenderer {
  const ctx = canvas.getContext("2d")!;
  let grid: Grid | null = null;
  let field: ElevField | null = null;   // 画面场含几何（粗格或侵蚀细分，精修档在此）
  let rule: RuleField | null = null;    // 规则场（粗格或工作档）：等高线与推演底图的高程取它＝与光标读数同源
  type Tile = { cv: HTMLCanvasElement; bb: BBox; pxpd: number; key: string; rp: number; o: TerrainRenderOpts };   // rp/o＝实际渲染分辨率与选项（补画照用）
  let tiles: Tile[] = [];   // 每份露出网格的世界拷贝一张（常态一张，跨环绕缝时两张）
  let dirty: BBox[] = [];   // 自上次 render 以来数据变了的经纬矩形（已外扩到取样半径），render 时补进留用的瓦片
  let lastZW: ZoneWeights | null = null;   // 上一帧的分区权重：同几何换代＝只补画权重变了的那片
  /* 逐格材质/色调（uploadGrid 预算；7 浮点=canopy,dune,ridge,marsh,rough,albVar,rock + tint 3 通道与有无） */
  let cellMat: Float32Array | null = null;
  let cellTint: Float32Array | null = null;
  let cellTintHas: Uint8Array | null = null;
  let cellIdx: Uint8Array | null = null;    // 逐格复合索引（色界锐化按它合并同类）
  let cellWS: Float32Array | null = null;   // 每格水面高程（core/elev.waterSurface；海 0／内陆湖岸线高）
  let cellWater: Uint8Array | null = null;  // 每格水域掩码（core/elev.waterMask，按 Grid 记忆的共享只读数组）
  let cellBand: Float32Array | null = null;  // 滩带场（render/beach.bandField）：画过滩带才有，此后随上传换代
  const BD = new Float64Array(2);

  /* 画面场取样（同 GL cellAt）：块层按缩放权重 tw 混入（tw 由 render 按本帧缩放定，进瓦片键）；块所在处 tHere 给装饰噪声退场用 */
  let tLayer: TileLayer | null = null, tw = 0;
  const elevBil = (lon: number, lat: number): number => {
    const e = elevBilinear(field!.data, field!, lon, lat);
    if (tw > 0) { const t = tileElevAt(tLayer!, lon, lat); if (t === t) return e + (t - e) * tw; }
    return e;
  };
  const tHere = (lon: number, lat: number): number => { if (tw <= 0) return 0; const t = tileElevAt(tLayer!, lon, lat); return t === t ? tw : 0; };
  const dispSmooth = (lon: number, lat: number): number => {   // core/elev.elevSmooth 同式，取样走 elevBil（带块）
    const h = field!.step * 0.5;
    return 0.25 * (elevBil(lon - h, lat - h) + elevBil(lon + h, lat - h) + elevBil(lon - h, lat + h) + elevBil(lon + h, lat + h));
  };
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
  const MW = new Float64Array(4), MI = new Int32Array(4), MK = new Int32Array(4);   // 四角权重、复合索引与格号（复用，免 GC）
  const WP = new Float64Array(2), W2 = new Float64Array(4);   // 域扭曲 · 长波扭曲与边缘碎化（material.warpOf / warp2Of 的输出，复用）
  function matAt(rx: number, ry: number): void {
    const g = grid!, step = g.step, cols = g.cols, rows = g.rows;
    warpOf(rx, ry, step, WP); warp2Of(rx, ry, step, W2);   // 同 GL：域扭曲 + 长波扭曲与边缘碎化（逐项依次加）
    const rwx = rx + WP[0] + W2[0] + W2[2], rwy = ry + WP[1] + W2[1] + W2[3];
    const fx = rwx / step - 0.5, fy = rwy / step - 0.5;
    const c0 = Math.max(0, Math.min(cols - 1, Math.floor(fx))), r0 = Math.max(0, Math.min(rows - 1, Math.floor(fy)));
    const c1 = Math.min(cols - 1, c0 + 1), r1 = Math.min(rows - 1, r0 + 1);
    const tx = Math.max(0, Math.min(1, fx - c0)), ty = Math.max(0, Math.min(1, fy - r0));
    for (let i = 0; i < 4; i++) {
      MK[i] = (i >= 2 ? r1 : r0) * cols + ((i === 1 || i === 3) ? c1 : c0); MI[i] = cellIdx![MK[i]];
      MW[i] = (i === 1 || i === 3 ? tx : 1 - tx) * (i >= 2 ? ty : 1 - ty);
    }
    blendSharp(MW, MI);   // 同类合并后锐化（同 GL）：色界走双线性过半的线，过渡约半格
    MT.tr = 0; MT.tg = 0; MT.tb = 0; MT.tintW = 0; MT.c = 0; MT.d = 0; MT.r = 0; MT.m = 0; MT.rough = 0; MT.albVar = 0; MT.rock = 0;
    for (let i = 0; i < 4; i++) {
      const wi = MW[i], k = MK[i], k7 = k * 7;
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
    if (!(opts.contour && ed[i] >= ws - WATER_EPS
      && lon > grid!.bb.lonMin + grid!.step && lon < grid!.bb.lonMax - grid!.step
      && lat > grid!.bb.latMin + grid!.step && lat < grid!.bb.latMax - grid!.step)) return col;
    const cs = opts.cStep || CONTOUR.stepDef, dpr = opts.dpr ?? 1, eh = ed[i];   // 线落在等距的整数倍上（同 GL：不再偏移 0.02）
    const gx = ed[y * W + Math.min(W - 1, x + 1)] - ed[i], gy = ed[Math.min(H - 1, y + 1) * W + x] - ed[i];   // 屏幕梯度（y 朝下）
    const ad = (Math.abs(gx) + Math.abs(gy)) * dpr + 1e-7;   // 线宽与挤线门按 CSS 像素锚定（同 GL uDPR）
    /* 间曲线的浮现门看 ±10 px 差分的粗坡（同 GL），不看逐像素梯度：侵蚀微起伏让局部梯度远大于宏观坡，按它算线距会低估几十倍；
       虚线相位锚网格原点的像素坐标，切向取世界 y 朝上的帧（gy 取反），与 GL 的 dFdy 同向 */
    const kx = CONTOUR.gcPx / pxpd * dpr, ky = CONTOUR.gcPx / pxpdY * dpr;
    const gcx = (elevSmooth(src.data, src, lon + kx, lat) - elevSmooth(src.data, src, lon - kx, lat)) / (2 * CONTOUR.gcPx);   // 每 CSS px 的坡（同 GL：不再除 dpr）
    const gcy = (elevSmooth(src.data, src, lon, lat + ky) - elevSmooth(src.data, src, lon, lat - ky)) / (2 * CONTOUR.gcPx);
    const gsl = Math.abs(gcx) + Math.abs(gcy) + 1e-7, tl = Math.hypot(gy, gx) || 1;
    const sdp = ((gy / tl) * (lon - grid!.bb.lonMin) * pxpd + (gx / tl) * (lat - grid!.bb.latMin) * pxpdY) / dpr;
    const k = contourK(eh, cs, ad, gsl, sdp, 0), kh = contourK(eh, cs, ad, gsl, sdp, FX.haloPx);
    // 亮晕只画核外环（kh−k），按底色亮度渐隐（同 GL；判据见 material.FX.halo*）
    const hg = haloK((FX.luma[0] * col[0] + FX.luma[1] * col[1] + FX.luma[2] * col[2]) / 255, k, kh);
    if (hg > 0) col = [col[0] + (FX.haloC[0] * 255 - col[0]) * hg, col[1] + (FX.haloC[1] * 255 - col[1]) * hg, col[2] + (FX.haloC[2] * 255 - col[2]) * hg];
    const I = CONTOUR.color;
    return [col[0] + (I[0] - col[0]) * k, col[1] + (I[1] - col[1]) * k, col[2] + (I[2] - col[2]) * k];
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
    const out: RGB = opts.paper ? [PAPER_RGB[0], PAPER_RGB[1], PAPER_RGB[2]] : [WATER.deep[0], WATER.deep[1], WATER.deep[2]];
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
    const eroded = field!.eroded ? 1 : 0;   // 场经侵蚀（同 GL uEroded）：装饰按坡门控、宏观 fbm4 降到 1/4
    const fine = field!.step < grid!.step * FINE_STEP_K || eroded ? 1 : 0;   // 装饰噪声门只在细分/侵蚀场生效（粗格=旧图逐位契约）
    const wrapC = !!opts.wrap && grid!.bb.lonMax - grid!.bb.lonMin > FULL_WRAP_DEG;   // 岸值的列环绕（同 GL）
    const elev = new Float32Array(W * H), esh = new Float32Array(W * H), ed = new Float32Array(W * H), cav = new Float32Array(W * H);
    const wsv = new Float32Array(W * H);   // 逐像素水面（同 GL：与晕渲高程同取扭曲后坐标）
    const bkv = opts.beach !== false ? new Float32Array(W * H) : null;   // 逐像素滩带份额：趟一按扭曲后坐标取场（同 GL bandAt），趟二混色
    const mgx = new Float32Array(W * H), mgy = new Float32Array(W * H);   // 宏观场坡（±1 格、无噪声；同 GL mn）
    /* 球面图气候带的纬度改正（同 GL dLat：雪线、林线、色阶同一个），只随纬度＝逐行一个值；
       林线淡出按未扭曲点的双线性画面场高程判（同 GL cd.x），趟一算好趟二复用 */
    const clim = opts.clim, snow = opts.snow, beach = opts.beach !== false, slopeK = opts.slopeK ?? 0, rowShift = new Float64Array(H);
    if (snow && snow.lat) for (let y = 0; y < H; y++) rowShift[y] = latShift(L2P(0, y)[1], snow.refM, snow.unitM);
    const tfade = clim || opts.zones ? new Float32Array(W * H) : null;
    const Z = opts.zones, zw = new Float32Array(ZONE_N), zt = new Float32Array(4), zc = new Float32Array(4);   // 气候分区（同 GL：各档结果按权重混）
    const tmead = Z ? new Float32Array(W * H * 3) : null;
    const RV = opts.rivers && opts.rivers.set.gmax >= opts.rivers.thr ? opts.rivers : null, rsd = RV ? new Float32Array(W * H) : null;   // 到当水画的河面（瓦片像素；同 GL rsd）
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, p = L2P(x, y);
      const rx = p[0] - lonMin, ry = p[1] - latMin;
      matAt(rx, ry);
      warpOf(rx, ry, step, WP);   // 与 matAt 同一扭曲（函数确定，各算一次）
      const wx = WP[0], wy = WP[1];
      const lonW = p[0] + wx, latW = p[1] + wy;
      const e0 = elevBil(lonW, latW);
      mgx[i] = elevBil(lonW - step, latW) - elevBil(lonW + step, latW);
      mgy[i] = elevBil(lonW, latW + step) - elevBil(lonW, latW - step);
      /* 坡度补材质（同 GL：山的质感跟着坡走，与类型取大——手雕高山落在平原类型也有岩理） */
      const smac = Math.hypot(mgx[i], mgy[i]) / (2 * step);
      const roughEff = slopeRough(smac, MT.rough), twrEff = slopeRidge(smac, MT.r), rough = fbmRough(e0, eroded);
      /* 装饰噪声门（同 GL：material.decoGate 单一真源）：平坦低地不再画假起伏；侵蚀场上只按坡门控（类型兜底不再算数） */
      wsv[i] = wsAt(lonW, latW);
      const eu = elevBil(p[0], p[1]);   // 未扭曲点的画面高程：装饰门的陆地因子、林线与谷影都按它（同 GL cd.x）
      const decoK = decoGate(smac, eroded ? 0 : MT.rough, sstep(wsv[i] - WATER_EPS, wsv[i] + WATER_EPS, eu), fine) * (1 - tHere(lonW, latW));   // 块里的起伏是真算的（同 GL）
      let e = e0;
      if (decoK > 0) {   // 门关（平地或块权重满）＝噪声两项恒零，免算（同 GL）
        e += (fbm(lonW * FX.fbmF, latW * FX.fbmF) - 0.5) * rough * 2 * decoK;
        if (microOn) e += micro(rx + wx, ry + wy, pxpd) * roughEff * FX.microAmp * decoK;
      }
      const shs = shoreAt(cellWater!, grid!.cols, grid!.rows, (rx + wx) / step - 0.5, (ry + wy) / step - 0.5, wrapC);
      e = shoreElev(e, wsv[i], shs);   // 画面的水陆由岸值定（同 GL shoreFix）；岸线墨与趟二的法线都读它
      elev[i] = e;
      if (bkv) { bandAt(cellBand!, grid!.cols, grid!.rows, (rx + wx) / step - 0.5, (ry + wy) / step - 0.5, BD); bkv[i] = beachK(BD[0], e - BD[1]); }
      /* 纹理疏密（同 GL；见 FX.texPatchF 头注）：世界锚定两八度低频调制，同一片林/沼/山有疏有密 */
      const texW = texW0 * texPatchK(patchN(rx, ry, step));
      if (Z) { zoneTreeMix(Z.looks, zoneWeightsAt(Z.wt, p[0], p[1], zw), eu, rowShift[y], zt); tfade![i] = zt[0]; tmead![i * 3] = zt[1]; tmead![i * 3 + 1] = zt[2]; tmead![i * 3 + 2] = zt[3]; }
      else if (tfade) tfade[i] = treeFade(clim!.treeE, rowShift[y], clim!.band, eu);
      const twc = tfade ? MT.c * (1 - tfade[i]) : MT.c;   // 林线以上林冠纹理淡出（同 GL）
      esh[i] = microOn ? e + texAt(rx, ry, twc, MT.d, twrEff, MT.m * marshGate(smac, slopeK), pxpd) * texW : e;
      const es = tw > 0 ? dispSmooth(p[0], p[1]) : elevSmooth(field!.data, field!, p[0], p[1]);
      ed[i] = rule === field && tw === 0 ? es : elevSmooth(rule!.data, rule!, p[0], p[1]);   // 线只跟规则场：画面场为精修档或带块时都不跟画面
      cav[i] = cavOf(es - eu, field!.step, gain);
      if (rsd) { const s = riverSD(RV!.set, p[0], p[1], RV!.thr); rsd[i] = s < 1e8 ? s * pxpd : 1e9; }   // 河取未扭曲位置（同 GL）
    }
    const light = SHADE_LIGHT, SH = new Float64Array(4), PM = new Float64Array(2);   // 暖冷晕渲（明暗倍率与三通道色偏）· 水洼的湿泥与积水份额：逐像素复用
    const nrm = NRM_K * (pxpd / NRM_PX) * gain;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, e = elev[i], ws = wsv[i], p = L2P(x, y);
      const rx = p[0] - lonMin, ry = p[1] - latMin;
      const eL = esh[y * W + Math.max(0, x - 1)], eR = esh[y * W + Math.min(W - 1, x + 1)];
      const eU = esh[Math.max(0, y - 1) * W + x], eD = esh[Math.min(H - 1, y + 1) * W + x];
      const nx = (eL - eR) * nrm, ny = (eU - eD) * nrm;
      /* 宏观场法线 + 陡坡软压 + 暖冷晕渲（同 GL：FX.macroNrm＝nrm 对基础坡度响应之半）。
         ⚠ 「把细节从软压里摘出来单独叠」试过并撤回，理由见 GL 版同处头注 */
      const mnk = macroK(step, gain);
      let n2x = nx + mgx[i] * mnk, n2y = ny + mgy[i] * mnk;
      const sl = Math.hypot(n2x, n2y), slc = slopeSoft(sl);
      if (sl > 1e-6) { n2x *= slc / sl; n2y *= slc / sl; }
      const nl = Math.hypot(n2x, n2y, 1);
      const dn = (n2x / nl) * light[0] + (n2y / nl) * light[1] + (1 / nl) * light[2];
      shadeOf(dn, SH);
      const sh = SH[0], shR = SH[1], shG = SH[2], shB = SH[3];
      const ec = rsd && rsd[i] < 0 && e >= ws - WATER_EPS ? ws - WATER.riverE : e;   // 陆上的河面＝紧贴判据线下的浅水（同 GL）
      let col = elevRamp(ec, ws, clim, rowShift[y]), zsn = 0;
      if (ec >= ws - WATER_EPS) {
        if (Z) { zoneColMix(Z.looks, zoneWeightsAt(Z.wt, p[0], p[1], zw), e, rowShift[y], zc); col = [zc[0], zc[1], zc[2]]; zsn = zc[3]; }
        if (bkv) {   // 滩带：水边的浅色带（同 GL；先于类型色调）
          const a = bkv[i];
          if (a > 0) col = [col[0] * (1 - a) + FX.beachC[0] * 255 * a, col[1] * (1 - a) + FX.beachC[1] * 255 * a, col[2] * (1 - a) + FX.beachC[2] * 255 * a];
        }
        matAt(rx, ry);   // 趟二重取材质（色调/反照率/岩化）——省四条逐像素缓存数组的内存
        if (MT.tintW > 0) {
          const a = tintK(MT.tintW);
          let tr = MT.tr, tg = MT.tg, tb = MT.tb;
          const fk = tfade ? meadowK(tfade[i], MT.c) : 0;
          if (fk > 0) {   // 林线以上的森林换草甸色（同 GL）
            const mr = tmead ? tmead[i * 3] : clim!.meadow[0], mg = tmead ? tmead[i * 3 + 1] : clim!.meadow[1], mb = tmead ? tmead[i * 3 + 2] : clim!.meadow[2];
            tr += (mr - tr) * fk; tg += (mg - tg) * fk; tb += (mb - tb) * fk;
          }
          col = [col[0] * (1 - a) + tr * a, col[1] * (1 - a) + tg * a, col[2] * (1 - a) + tb * a];
        }
        // 生态辨识度（同 GL）：荒漠暖沙定调；沼泽湿绿+近景水洼/湿泥（键=材质权重）
        {   // 不设门（同 GL）：权重为零时 a＝0、颜色原样
          const a = sandK(MT.d);
          col = [col[0] * (1 - a) + FX.sandC[0] * 255 * a, col[1] * (1 - a) + FX.sandC[1] * 255 * a, col[2] * (1 - a) + FX.sandC[2] * 255 * a];
        }
        const mw0 = MT.m > FX.wMin ? MT.m * marshGate(Math.hypot(mgx[i], mgy[i]) / (2 * step), slopeK) : 0;   // 沼泽按坡淡出（同 GL）
        if (mw0 > FX.wMin) {
          const a = marshK(mw0);
          col = [col[0] * (1 - a) + FX.marshC[0] * 255 * a, col[1] * (1 - a) + FX.marshC[1] * 255 * a, col[2] * (1 - a) + FX.marshC[2] * 255 * a];
          const pg = poolGate(pxpd * step, mw0, opts.paper ? 1 : 0);
          if (pg > FX.wMin) {
            poolMask(poolN(rx, ry, step), PM);
            const mw = PM[0] * pg * FX.mudMix;
            col = [col[0] * (1 - mw) + FX.mudC[0] * 255 * mw, col[1] * (1 - mw) + FX.mudC[1] * 255 * mw, col[2] * (1 - mw) + FX.mudC[2] * 255 * mw];
            const pa = PM[1] * pg * FX.poolMix;
            col = [col[0] * (1 - pa) + FX.poolC[0] * 255 * pa, col[1] * (1 - pa) + FX.poolC[1] * 255 * pa, col[2] * (1 - pa) + FX.poolC[2] * 255 * pa];
          }
        }
        if (microOn && MT.albVar > 0) {   // 反照率抖动（同 GL：屏幕锚定低频 × 门控）
          const [f1, f2, fr] = lodF(pxpd, FX.albPx), g = octaveGate(pxpd, f1);
          if (g > 0) {
            const m = albM(albAv(rx, ry, f1, f2, fr), MT.albVar, g);
            col = [col[0] * m, col[1] * m, col[2] * m];
          }
        }
        const slp = Math.hypot(nx, ny);   // 坡度岩化（同 GL）
        const rk = rockK(slp, MT.rock);
        if (rk > 0) {
          const t = rockT(e), a = rk * FX.rockMix, R0 = FX.rockC, RS = FX.rockSpan;
          const rc = [(R0[0] + RS[0] * t) * 255, (R0[1] + RS[1] * t) * 255, (R0[2] + RS[2] * t) * 255];
          col = [col[0] * (1 - a) + rc[0] * a, col[1] * (1 - a) + rc[1] * a, col[2] * (1 - a) + rc[2] * a];
        }
        const S = opts.snow;   // 雪按米落（同 GL：material.snowSpec 同式，随纬度只在球面图且设了气候档；陡坡挂不住雪打六折）
        const snE = S ? snowLine(S.base, rowShift[y]) : 1e9;
        const sn = (Z ? zsn : snowAt(snE, e)) * snowSlope(slp);
        if (sn > 0) col = [col[0] + (FX.snowC[0] * 255 - col[0]) * sn, col[1] + (FX.snowC[1] * 255 - col[1]) * sn, col[2] + (FX.snowC[2] * 255 - col[2]) * sn];
        const ak = airK(e);   // 空气透视（同 GL）
        if (ak > 0) col = [col[0] + (FX.airC[0] * 255 - col[0]) * ak, col[1] + (FX.airC[1] * 255 - col[1]) * ak, col[2] + (FX.airC[2] * 255 - col[2]) * ak];
        const s2 = sh * (1 - cav[i]);
        col = [col[0] * s2 * shR, col[1] * s2 * shG, col[2] * s2 * shB];
        col = contourMix(opts, W, H, col, ed, i, x, y, ws, p[0], p[1], pxpd, pxpd, rule!);
      } else {
        const sc = [WATER.shore[0] * 255, WATER.shore[1] * 255, WATER.shore[2] * 255], sa = shoreK(ec, ws, pxpd * step);   // 近岸浅水带（同 GL）
        col = [col[0] * (1 - sa) + sc[0] * sa, col[1] * (1 - sa) + sc[1] * sa, col[2] * (1 - sa) + sc[2] * sa];
        if (microOn) {   // 静态波纹（同 GL：值噪声 ridged + 横向拉伸 + 门控）
          const [f1, f2, fr] = lodF(pxpd, FX.wavePx), g = octaveGate(pxpd, f1);
          if (g > 0) {
            const m = waveM(waveWv(rx, ry, f1, f2, fr), g);
            col = [col[0] * m, col[1] * m, col[2] * m];
          }
        }
      }
      const q = i * 4; d[q] = col[0]; d[q + 1] = col[1]; d[q + 2] = col[2]; d[q + 3] = 255;
    }
    coastInk(d, elev, wsv, W, H, Math.max(1, Math.min(WATER.inkWPx * (opts.dpr ?? 1), pxpd / WATER.inkWK)), rsd);
    return img;
  }

  /** 把上传前后两份数据的差异折成经纬矩形（外扩到每个像素取样所及：扭曲 + 宏观坡 ±1 格 + 双线性与帐篷平滑）；
      网格或场换了形状＝"all"（整块重画） */
  function changedSince(p: { g: Grid; f: ElevField; r: ElevField; ws: Float32Array; water: Uint8Array; band: Float32Array | null; mat: Float32Array; tint: Float32Array; has: Uint8Array }): BBox[] | "all" {
    const g = grid!, f = field!, r = rule!;
    if (g !== p.g && !sameGeom(g, p.g)) return "all";
    const m = g.step * 3 + Math.max(f.step, r.step) * 2, out: BBox[] = [];
    const add = (box: number[] | null, geo: { bb: BBox; step: number }): void => {
      if (box) out.push({ lonMin: geo.bb.lonMin + box[0] * geo.step - m, lonMax: geo.bb.lonMin + (box[2] + 1) * geo.step + m,
        latMin: geo.bb.latMin + box[1] * geo.step - m, latMax: geo.bb.latMin + (box[3] + 1) * geo.step + m });
    };
    for (const [a, b] of p.r === p.f && r === f ? [[p.f, f]] : [[p.f, f], [p.r, r]]) {
      if (a === b) continue;
      if (!sameGeom(a, b) || a.eroded !== b.eroded) return "all";
      add(changedBox(a.data, b.data, b.cols, b.rows), b);
    }
    if (p.ws !== cellWS) add(changedBox(p.ws, cellWS!, g.cols, g.rows), g);
    if (p.water !== cellWater) add(changedBox(p.water, cellWater!, g.cols, g.rows), g);
    if (p.band && p.band !== cellBand) add(changedBox(p.band, cellBand!, g.cols, g.rows, 2), g);
    if (p.mat !== cellMat) {
      add(changedBox(p.mat, cellMat!, g.cols, g.rows, 7), g); add(changedBox(p.tint, cellTint!, g.cols, g.rows, 3), g);
      add(changedBox(p.has, cellTintHas!, g.cols, g.rows), g);
    }
    return out;
  }
  /** 把 rects 补进瓦片；要补的面积过半返回 false（整块重画更省） */
  function patchTile(t: Tile, rects: BBox[]): boolean {
    const W = t.cv.width, H = t.cv.height, pd = t.rp, dpr = t.o.dpr ?? 1;
    const pm = Math.ceil(CONTOUR.gcPx * dpr) + Math.ceil(1.5 * dpr) + 3;   // 变化能波及的像素：间曲线门 ±10 CSS px 取样 + 岸线线宽 + 邻像素差分
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
    uploadGrid(g: Grid, wsurf: Float32Array, f: ElevField, r: RuleField) {
      const prev = tiles.length && grid ? { g: grid, f: field!, r: rule!, ws: cellWS!, water: cellWater!, band: cellBand, mat: cellMat!, tint: cellTint!, has: cellTintHas! } : null;
      const sameGrid = g === grid;
      grid = g; field = f; rule = r; cellWS = wsurf; cellWater = waterMask(g);
      if (cellBand) cellBand = bandField(g, wsurf);
      if (!sameGrid) {   // 同一 Grid 实例＝只动了高程，逐格材质/色调不变
        const n = g.rows * g.cols;   // 逐格材质/色调预算（renderTile 每像素四角查表）
        cellMat = new Float32Array(n * 7); cellTint = new Float32Array(n * 3); cellTintHas = new Uint8Array(n); cellIdx = new Uint8Array(n);
        for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
          const k = r * g.cols + c, cell = g.cells[r][c], m = materialFor(cell), t = terrainProps(cell).tint;
          cellMat.set([m.canopy, m.dune, m.ridge, m.marsh, m.rough, m.albVar, m.rock], k * 7); cellIdx[k] = compositeIndex(cell);
          if (t) { cellTint.set(t, k * 3); cellTintHas[k] = 1; }
        }
      }
      const d = prev ? changedSince(prev) : "all";
      if (d === "all") { tiles = []; dirty = []; }
      else if (d.length) dirty = dirty.length + d.length > 16 ? [unionBB(dirty.concat(d))] : dirty.concat(d);   // 攒多了并成一块，免得逐块重算外缘
    },
    uploadTiles(layer: TileLayer | null) {
      /* 块换了的那片要补画：只在上一帧用着块时（tw>0）——用不着块的瓦片里块不影响任何像素 */
      if (tw > 0 && grid && field && tiles.length) {
        const prev = tLayer, m = grid.step * 3 + field.step * 2, ids = new Set([...(prev ? prev.tiles.keys() : []), ...(layer ? layer.tiles.keys() : [])]);
        const g = (layer || prev)!.geom;
        for (const i of ids) {
          if (prev?.tiles.get(i) === layer?.tiles.get(i)) continue;
          const { c0, r0, c1, r1 } = tileCells(g, i);
          dirty.push({ lonMin: g.lonMin + c0 * g.pstep - m, lonMax: g.lonMin + c1 * g.pstep + m, latMin: g.latMin + r0 * g.pstep - m, latMax: g.latMin + r1 * g.pstep + m });
        }
        if (dirty.length > 16) dirty = [unionBB(dirty)];
      }
      tLayer = layer;
    },
    render(viewBB: BBox, opts: TerrainRenderOpts = {}) {
      if (!grid) return;
      if (opts.flat) { renderFlat(viewBB, opts); return; }
      const [W, H] = opts.px ?? [canvas.width, canvas.height];   // 可见区（画布可更大，只画左上这一块）
      if (opts.beach !== false && !cellBand) cellBand = bandField(grid, cellWS!);   // 头一回画滩带才建场
      tw = tLayer ? +tileWeight(tLayer.geom.step * H / (viewBB.latMax - viewBB.latMin) / (opts.dpr ?? 1)).toFixed(3) : 0;   // 同 GL；取三位进瓦片键
      const pxpd = W / (viewBB.lonMax - viewBB.lonMin);
      // 球面环绕：视口按每份拷贝平移 c 折回网格所在域做瓦片判定/重建，贴图时再按拷贝偏移回来
      const copies = wrapCopies(viewBB, grid.bb, !!opts.wrap);
      /* 键须罩住瓦片读到的每个选项（增益随缩放变）：数据不变时瓦片留用，漏一项＝改那项设置后画面不动 */
      const S = opts.snow, Z = opts.zones;
      const key = `g${(opts.gain ?? 1).toFixed(2)}d${opts.dpr ?? 1}` + (opts.contour ? `c${opts.cStep || CONTOUR.stepDef}` : "") + (opts.paper ? "p" : "") + (opts.beach !== false ? "b" : "") + `m${opts.slopeK ?? 0}`
        + (S ? `s${S.base},${S.lat ? 1 : 0},${S.refM},${S.unitM}` : "") + (opts.clim ? `k${opts.clim.key}` : "")
        + (Z ? `z${Z.looks.key}@${Z.wt.cols}x${Z.wt.rows},${Z.wt.pd},${Z.wt.bb.lonMin},${Z.wt.bb.latMin}` : "") + (tw > 0 ? `t${tw}` : "");   // 权重换代不进键：同几何走下面的补画
      if (Z && lastZW && Z.wt !== lastZW && Z.wt.cols === lastZW.cols && Z.wt.rows === lastZW.rows && Z.wt.pd === lastZW.pd) {
        const b = changedBox(lastZW.w, Z.wt.w, Z.wt.cols, Z.wt.rows, ZONE_N), wb = Z.wt.bb, pd = Z.wt.pd;
        if (b) dirty.push({ lonMin: wb.lonMin + (b[0] - 1) * pd, lonMax: wb.lonMin + (b[2] + 2) * pd, latMin: wb.latMin + (b[1] - 1) * pd, latMax: wb.latMin + (b[3] + 2) * pd });
      }
      lastZW = Z ? Z.wt : null;
      const next: Tile[] = [];
      for (const c of copies) {
        const vb: BBox = c ? { lonMin: viewBB.lonMin + c, lonMax: viewBB.lonMax + c, latMin: viewBB.latMin, latMax: viewBB.latMax } : viewBB;
        let t = next.concat(tiles).find(x => planTile(x, key, vb, pxpd, grid!.bb) === "keep");   // 视口宽过一份世界时几份拷贝要的是同一片
        if (t && Z && t.o.zones !== Z) t.o = { ...t.o, zones: Z };   // 补画照新权重画（其余选项与键同）
        let rd: BBox[] = [];   // 画成水面的河段变了（改河、换门槛）：只补画那几段；瓦片记着自己画时的那份
        if (t && !next.includes(t) && t.o.rivers !== opts.rivers) { rd = riverDirty(t.o.rivers, opts.rivers); t.o = { ...t.o, rivers: opts.rivers }; }
        const fix = rd.length ? dirty.concat(rd) : dirty;
        if (t && fix.length && !next.includes(t) && !patchTile(t, fix)) { const stale = t; tiles = tiles.filter(x => x !== stale); t = undefined; }
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
      ctx.fillStyle = opts.paper ? PAPER : `rgb(${WATER.deep.join(",")})`;
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
    dispose() { tiles = []; dirty = []; lastZW = null; grid = null; field = null; tLayer = null; cellMat = null; cellTint = null; cellTintHas = null; cellWS = null; }
  };
}
