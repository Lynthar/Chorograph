/* CPU 兜底地形渲染器（Canvas2D）：仅在建不出 WebGL2 上下文的环境使用。
   像素管线与 GL 版同构（= 旧版 renderRegion 语义：高程双线性 + 细节噪声 + 晕渲 + 色阶 +
   生态色调 + 海岸线）；细节噪声用 core/noise 的 sin-hash（fp64，与旧版逐位一致）。
   等高线与 GL 版同构地画在**无噪声数据面**（细/计曲线 + contourStepFor 缩放自适应等距）。
   性能策略沿袭旧版：**世界锚定瓦片 + 30% 余量**——平移只重贴图，视口越出余量或缩放变档才重渲。 */
import { fbm } from "../core/noise.ts";
import { terrainProps } from "../core/constants.ts";
import { elevBilinear, elevSmooth } from "../core/elev.ts";
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
    const elev = new Float32Array(W * H), ed = new Float32Array(W * H);   // elev=+细节噪声（晕渲/色阶/海岸）；ed=制图面（帐篷平滑，等高线用）
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = L2P(x, y), e0 = elevBil(p[0], p[1]);
      const rough = e0 > 0.4 ? 0.24 : (e0 > 0.2 ? 0.08 : 0.025);
      ed[y * W + x] = opts.contour ? elevSmooth(field!, grid!, p[0], p[1]) : e0;
      elev[y * W + x] = e0 + (fbm(p[0] * 1.1, p[1] * 1.1) - 0.5) * rough * 2;
    }
    const light = [-0.6, -0.6, 0.9], ll = Math.hypot(...light); light[0] /= ll; light[1] /= ll; light[2] /= ll;
    const nrm = 4.5 * (pxpd / 14);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, e = elev[i], p = L2P(x, y);
      const eL = elev[y * W + Math.max(0, x - 1)], eR = elev[y * W + Math.min(W - 1, x + 1)];
      const eU = elev[Math.max(0, y - 1) * W + x], eD = elev[Math.min(H - 1, y + 1) * W + x];
      const nx = (eL - eR) * nrm, ny = (eU - eD) * nrm, nl = Math.hypot(nx, ny, 1);
      let sh = (nx / nl) * light[0] + (ny / nl) * light[1] + (1 / nl) * light[2]; sh = 0.6 + 0.75 * Math.max(0, sh);
      let col = elevRamp(e);
      if (e >= -0.02) {
        const tint = terrainProps(nearestT(p[0], p[1])).tint;
        if (tint) col = [col[0] * 0.55 + tint[0] * 0.45, col[1] * 0.55 + tint[1] * 0.45, col[2] * 0.55 + tint[2] * 0.45];
        col = [col[0] * sh, col[1] * sh, col[2] * sh];
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
    uploadGrid(g: Grid, elev?: Float32Array) { grid = g; field = elev || fieldOfTypes(g); tile = null; },
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
      // 底色=深水（视口越出网格范围的部分），再按世界拷贝贴瓦片。
      // 纵向用独立 pxpdY：viewBB 经度含 cos(lat0) 校正、纬度不含，贴图须各向异性拉伸
      //（对齐旧 drawTile 经 project 求角点的行为；瓦片内部仍为方度像素，交给 drawImage 缩放）。
      const pxpdY = canvas.height / (viewBB.latMax - viewBB.latMin);
      ctx.fillStyle = "rgb(40,90,132)";
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
    dispose() { tile = null; grid = null; field = null; }
  };
}
