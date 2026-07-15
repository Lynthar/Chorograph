/* 手绘布景 + 自动生态点缀（自 v0.14 drawPrim/scatterEco 迁移；纯视觉，不入寻路网格）。
   印章基元 drawPrim（8 种手绘符号）decor 与 eco 共用；坐标经相机 project 投影，
   尺度随缩放 (1/degPerPx)/14——高清不糊、深放大退场。调用方（drawOverlay）已按 dpr 缩放并按世界拷贝重投影。 */
import { DECOR_BASE, DECOR_BASE_IMG, terrainProps } from "../core/constants.ts";
import { hash2 } from "../core/noise.ts";
import { activeAt } from "../core/time.ts";
import { cellCenter } from "../core/route.ts";
import { project, unproject, viewCosK, visibleWorldCopies, type Camera } from "../core/projection.ts";
import type { Grid } from "../core/grid.ts";
import type { Asset, Decor, Meta, World } from "../core/types.ts";

type C = CanvasRenderingContext2D;

/* —— 印章基元（x/y=屏幕 CSS 像素，s=像素尺寸）—— */
function drawPeak(g: C, x: number, y: number, h: number, snow: boolean): void {
  const w = h * 0.82;
  g.beginPath(); g.moveTo(x - w, y + h * 0.5); g.lineTo(x, y - h); g.lineTo(x + w, y + h * 0.5); g.closePath();
  g.fillStyle = snow ? "rgba(104,86,68,.82)" : "rgba(126,116,84,.66)"; g.fill();
  g.strokeStyle = "rgba(64,50,38,.4)"; g.lineWidth = 0.6; g.stroke();
  g.beginPath(); g.moveTo(x, y - h); g.lineTo(x - w, y + h * 0.5); g.lineTo(x, y + h * 0.5); g.closePath();
  g.fillStyle = "rgba(255,250,240,.16)"; g.fill();
  if (snow) {
    g.beginPath(); g.moveTo(x - w * 0.36, y - h * 0.1); g.lineTo(x, y - h); g.lineTo(x + w * 0.36, y - h * 0.1);
    g.lineTo(x + w * 0.12, y - h * 0.34); g.lineTo(x - w * 0.12, y - h * 0.3); g.closePath();
    g.fillStyle = "rgba(249,249,253,.95)"; g.fill();
  }
}
function drawTree(g: C, x: number, y: number, h: number): void {
  g.beginPath(); g.moveTo(x, y - h); g.lineTo(x - h * 0.58, y + h * 0.5); g.lineTo(x + h * 0.58, y + h * 0.5); g.closePath();
  g.fillStyle = "rgba(50,90,52,.85)"; g.fill();
  g.fillStyle = "rgba(80,58,36,.9)"; g.fillRect(x - h * 0.09, y + h * 0.5, Math.max(0.8, h * 0.18), h * 0.3);
}
function drawPine(g: C, x: number, y: number, h: number): void {
  g.fillStyle = "rgba(38,78,52,.88)";
  g.beginPath(); g.moveTo(x, y - h); g.lineTo(x - h * 0.5, y - h * 0.15); g.lineTo(x + h * 0.5, y - h * 0.15); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(x, y - h * 0.55); g.lineTo(x - h * 0.68, y + h * 0.5); g.lineTo(x + h * 0.68, y + h * 0.5); g.closePath(); g.fill();
}
function drawShrub(g: C, x: number, y: number, r: number): void {
  g.fillStyle = "rgba(74,110,64,.8)";
  for (const [ox, oy] of [[0, -r * 0.2], [-r * 0.65, r * 0.25], [r * 0.65, r * 0.25]]) { g.beginPath(); g.arc(x + ox, y + oy, r * 0.55, 0, 7); g.fill(); }
}
function drawReed(g: C, x: number, y: number, h: number): void {
  g.strokeStyle = "rgba(70,110,80,.85)"; g.lineWidth = Math.max(0.7, h * 0.14);
  for (const i of [-1, 0, 1]) { g.beginPath(); g.moveTo(x + i * h * 0.35, y + h * 0.4); g.quadraticCurveTo(x + i * h * 0.35 + i * h * 0.12, y - h * 0.15, x + i * h * 0.55, y - h * 0.55); g.stroke(); }
}
function drawDune(g: C, x: number, y: number, w: number): void {
  g.strokeStyle = "rgba(150,120,70,.75)"; g.lineWidth = Math.max(0.8, w * 0.16);
  g.beginPath(); g.moveTo(x - w, y); g.quadraticCurveTo(x - w * 0.3, y - w * 0.55, x, y);
  g.moveTo(x, y + w * 0.25); g.quadraticCurveTo(x + w * 0.4, y - w * 0.3, x + w * 0.9, y + w * 0.2); g.stroke();
}
function drawRock(g: C, x: number, y: number, r: number): void {
  g.fillStyle = "rgba(120,112,100,.85)"; g.strokeStyle = "rgba(60,54,46,.6)"; g.lineWidth = 0.8;
  g.beginPath(); g.moveTo(x - r, y + r * 0.6); g.lineTo(x - r * 0.55, y - r * 0.5); g.lineTo(x + r * 0.15, y - r * 0.75);
  g.lineTo(x + r, y + r * 0.1); g.lineTo(x + r * 0.6, y + r * 0.6); g.closePath(); g.fill(); g.stroke();
}
/** 按种类画一枚印章（手绘布景 + 自动生态共用） */
export function drawPrim(g: C, kind: string, x: number, y: number, s: number): void {
  switch (kind) {
    case "peak": drawPeak(g, x, y, s, true); break;
    case "mount": case "hillock": drawPeak(g, x, y, s, false); break;
    case "tree": drawTree(g, x, y, s); break;
    case "pine": drawPine(g, x, y, s); break;
    case "shrub": drawShrub(g, x, y, s); break;
    case "reed": drawReed(g, x, y, s); break;
    case "dune": drawDune(g, x, y, s); break;
    case "rock": drawRock(g, x, y, s); break;
  }
}

/* 自定义印章位图缓存：asset id → 解码中的 Image（dataURL 无网络、1–2 帧内 complete）。
   dataURL 按 id 不可变故只增不汰；未就绪的当帧跳过绘制。 */
const IMG_CACHE = new Map<string, HTMLImageElement>();
function assetImg(a: Asset): HTMLImageElement {
  let im = IMG_CACHE.get(a.id);
  if (!im) { im = new Image(); im.src = a.src; IMG_CACHE.set(a.id, im); }
  return im;
}

/** 手绘布景层：遍历 world.decor[]（纪年过滤），投影后按 DECOR_BASE×size×缩放 落印章。
    尺度按格距 step 标定（同 drawEco）：战略 1° 格观感不变，细网格战术图印章随格缩小——
    旧固定按 1° 标定，0.006° 格上每枚印章巨大（自动生态 drawEco 已修，此为手绘层同款修正）。 */
export function drawDecor(ctx: C, cam: Camera, world: World, yearNow: number, step = 1): void {
  const decor = world.decor || [];
  if (!decor.length) return;
  const scale = (step / cam.degPerPx) / 14;
  const assets = world.assets;
  const byAsset = assets && assets.length ? new Map(assets.map(a => [a.id, a])) : null;
  ctx.save();
  for (const d of decor) {
    if (!activeAt(d, yearNow)) continue;
    if (typeof d.kind === "string" && d.kind.startsWith("img:")) {   // 自定义印章：位图，底中锚定
      const a = byAsset && byAsset.get(d.kind.slice(4)); if (!a) continue;   // 悬空引用/无资产表=跳过
      const im = assetImg(a); if (!im.complete || !im.naturalWidth) continue;   // 未解码当帧跳过
      const base = DECOR_BASE_IMG * (d.size || 1) * scale;
      if (base > 420 || base < 1) continue;                  // 深放大退场 / 亚像素远景不画
      const ar = (a.w && a.h) ? a.w / a.h : 1;
      const dw = ar >= 1 ? base : base * ar, dh = ar >= 1 ? base / ar : base;
      const [x, y] = project(cam, d.lon, d.lat);
      if (x < -50 - dw || y < -50 - dh || x > cam.w + 50 + dw || y > cam.h + 50) continue;
      ctx.drawImage(im, x - dw / 2, y - dh, dw, dh);         // 底中锚定：印章"站"在点上
      continue;
    }
    const s = (DECOR_BASE[d.kind] || 5) * (d.size || 1) * scale;
    if (s > 420) continue;                                   // 深放大退场
    const [x, y] = project(cam, d.lon, d.lat);
    if (x < -50 - s || y < -50 - s || x > cam.w + 50 + s || y > cam.h + 50 + s) continue;
    drawPrim(ctx, d.kind, x, y, s);
  }
  ctx.restore();
}

/** 拾取最近的布景（取样/单击用）：投影后距 < rad 像素，按世界拷贝重投影。对齐旧 pickDecorD。 */
export function pickDecor(cam: Camera, meta: Meta | undefined, world: World, yearNow: number,
  x: number, y: number, rad = 13): Decor | null {
  let best: Decor | null = null, bd = rad;
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    for (const d of world.decor || []) {
      if (!activeAt(d, yearNow)) continue;
      const [px, py] = project(c2, d.lon, d.lat);
      const dd = Math.hypot(px - x, py - y);
      if (dd < bd) { bd = dd; best = d; }
    }
  }
  return best;
}

/** 橡皮笔刷扫除：返回投影后距 ≤ r 像素的全部布景 id（对齐旧 decorEraseAt 的半径判定）。 */
export function decorIdsInRadius(cam: Camera, meta: Meta | undefined, world: World, yearNow: number,
  x: number, y: number, r: number): string[] {
  const ids: string[] = [];
  for (const d of world.decor || []) {
    if (!activeAt(d, yearNow)) continue;
    for (const shift of visibleWorldCopies(cam, meta)) {
      const c2: Camera = { ...cam, lonShift: shift };
      const [px, py] = project(c2, d.lon, d.lat);
      if (Math.hypot(px - x, py - y) <= r) { ids.push(d.id); break; }
    }
  }
  return ids;
}

/** 自动生态点缀层：按 TERRAIN_ECO 在每个地形格内做确定性散布（哈希定位，任何分辨率同位）。
    尺寸与格内散布**按格距标定**：战略 1° 格（grid.step=1）与旧 scatterEco 逐位一致；
    细网格战术图印章随格缩放——旧公式固定按 1° 标定，0.006° 格上每棵树 100–200px、
    且散布 ±0.31° 漂出所在格 50 格远，把战术图糊成巨物（鄱阳湖成图时暴露）。 */
export function drawEco(ctx: C, cam: Camera, grid: Grid): void {
  const scale = (grid.step / cam.degPerPx) / 14;
  /* 视口裁剪（审计：原先全网格逐格付哈希代价、离屏格命中后才剔除——大网格深放大时白算）：
     由屏幕角反投影出本拷贝可见经纬窗口（unproject 不含 lonShift，需自行减去），只扫窗口内的格；
     余量=格内散布外溢(≤0.7格) + 最大印章半径 + 原 50px 屏幕余量。逐格绘制参数不变（无跨格状态），可见输出逐位一致。 */
  const shift = (cam.lonShift || 0);
  const [lonA, latTop] = unproject(cam, 0, 0);
  const [lonB, latBot] = unproject(cam, cam.w, cam.h);
  const szMax = Math.min(340, 10 * scale * 1.25);                       // TERRAIN_ECO 最大 s=10 × 抖动上限 1.25
  const pxDeg = cam.degPerPx / Math.max(0.05, viewCosK(cam));
  const margin = 0.7 * grid.step + (szMax + 50) * pxDeg;
  const c0 = Math.max(0, Math.floor((lonA - shift - margin - grid.bb.lonMin) / grid.step));
  const c1 = Math.min(grid.cols - 1, Math.ceil((lonB - shift + margin - grid.bb.lonMin) / grid.step));
  const r0 = Math.max(0, Math.floor((latBot - margin - grid.bb.latMin) / grid.step));
  const r1 = Math.min(grid.rows - 1, Math.ceil((latTop + margin - grid.bb.latMin) / grid.step));
  ctx.save();
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const spec = terrainProps(grid.cells[r][c]).scatter;
    if (!spec.length) continue;
    const [clon, clat] = cellCenter(grid, r, c);
    for (let i = 0; i < spec.length; i++) {
      const it = spec[i];
      if (hash2(r * 13.1 + i * 7.31, c * 7.7 + i * 3.17) > it.p) continue;
      const jx = ((hash2(r * 3.7 + i, c * 5.3 + i) - 0.5) * 0.62 + (it.dx || 0)) * grid.step;
      const jy = ((hash2(r * 5.9 + i, c * 2.9 + i) - 0.5) * 0.5 + (it.dy || 0)) * grid.step;
      const sz = it.s * scale * (0.85 + hash2(r * 1.3 + i, c * 9.1 + i) * 0.4);   // ±20% 尺寸抖动
      if (sz > 340 || sz < 1.1) continue;                      // 深放大退场；亚像素细网格远景不画
      const [x, y] = project(cam, clon + jx, clat + jy);
      if (x < -50 - sz || y < -50 - sz || x > cam.w + 50 + sz || y > cam.h + 50 + sz) continue;
      drawPrim(ctx, it.k, x, y, sz);
    }
  }
  ctx.restore();
}
