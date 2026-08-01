/* 手绘布景（自 v0.14 drawPrim/placeDecor 迁移；纯视觉，不入寻路网格）。生态笔刷落下的印章
   与手绘印章共用同一 decor[] 与本层——完全同质，可单独拾取/选中/调整/删除。
   印章基元 drawPrim（8 种手绘符号）；坐标经相机 project 投影，尺度随缩放 (step/degPerPx)/14——
   高清不糊、深放大退场。调用方（drawOverlay）已按 dpr 缩放并按世界拷贝重投影。 */
import { DECOR_BASE, DECOR_BASE_IMG } from "../core/constants.ts";
import { tget } from "../core/util.ts";
import { activeAt } from "../core/time.ts";
import { project, visibleWorldCopies, type Camera } from "../core/projection.ts";
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
/* 各基元的体包络 [半宽, 上伸, 下伸]（×s，逐条对应上面 draw* 的坐标，含描边半宽）：印章都「站」在
   锚点上、体主要在锚点【上方】，故拾取不能用以锚点为心的正圆——大印章点得中底座却点不中顶尖。
   改 draw* 的形状须同步改此表（拾取绘制同源；表就近放在基元旁即为此）。 */
const PRIM_BOX: Record<string, [number, number, number]> = {
  peak: [0.82, 1, 0.5], mount: [0.82, 1, 0.5], hillock: [0.82, 1, 0.5],
  tree: [0.58, 1, 0.8], pine: [0.68, 1, 0.5], shrub: [1.2, 0.75, 0.8],
  reed: [0.62, 0.62, 0.47], dune: [1.08, 0.63, 0.33], rock: [1, 0.75, 0.6]
};
const PRIM_BOX_DEF: [number, number, number] = [1, 1, 0.6];   // 未知种类（旧档/未来基元）：取包络上界

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
export function drawDecor(ctx: C, cam: Camera, world: World, yearNow: number, step = 1,
  sel?: { id?: string | null; ids?: Set<string> | null }): void {
  const decor = world.decor || [];
  if (!decor.length) return;
  const scale = (step / cam.degPerPx) / 14;
  const assets = world.assets;
  const byAsset = assets && assets.length ? new Map(assets.map(a => [a.id, a])) : null;
  const isSel = (id: string) => !!sel && (sel.id === id || (sel.ids ? sel.ids.has(id) : false));
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
      if (x < -50 - dw || y < -50 - dh || x > cam.w + 50 + dw || y > cam.h + 50 + dh) continue;   // ⚠ 底缘须加 dh：印章底中锚定、体在锚点上方，锚点落到画布下方 50px 时大印章仍有半截在画面里（缺 dh 即整章突然消失，而 pickDecor 按完整体判中＝那条带里点得中一个没画出来的印章）
      ctx.drawImage(im, x - dw / 2, y - dh, dw, dh);         // 底中锚定：印章"站"在点上
      if (isSel(d.id)) selBox(ctx, x - dw / 2, y - dh, x + dw / 2, y);
      continue;
    }
    const s = (tget(DECOR_BASE, d.kind) || 5) * (d.size || 1) * scale;
    if (s > 420) continue;                                   // 深放大退场
    const [x, y] = project(cam, d.lon, d.lat);
    if (x < -50 - s || y < -50 - s || x > cam.w + 50 + s || y > cam.h + 50 + s) continue;
    drawPrim(ctx, d.kind, x, y, s);
    if (isSel(d.id)) { const [hw, up, dn] = tget(PRIM_BOX, d.kind) || PRIM_BOX_DEF; selBox(ctx, x - hw * s, y - up * s, x + hw * s, y + dn * s); }
  }
  ctx.restore();
}

/** 选中布景高亮框（虚线金环，紧贴体外扩 3px；拾取绘制同源的体几何） */
function selBox(ctx: C, x0: number, y0: number, x1: number, y1: number): void {
  ctx.save();
  ctx.strokeStyle = "rgba(198,140,44,.95)"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
  ctx.strokeRect(x0 - 3, y0 - 3, (x1 - x0) + 6, (y1 - y0) + 6);
  ctx.restore();
}

/** 框选命中的全部布景 id（锚点落框内即选中；对齐 nodesInBox 的锚点判定） */
export function decorsInBox(cam: Camera, meta: Meta | undefined, world: World, yearNow: number,
  x0: number, y0: number, x1: number, y1: number): string[] {
  const xs = Math.min(x0, x1), xe = Math.max(x0, x1), ys = Math.min(y0, y1), ye = Math.max(y0, y1);
  const ids = new Set<string>();
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    for (const d of world.decor || []) {
      if (!activeAt(d, yearNow)) continue;
      const [px, py] = project(c2, d.lon, d.lat);
      if (px >= xs && px <= xe && py >= ys && py <= ye) ids.add(d.id);
    }
  }
  return [...ids];
}

/** 拾取最近的布景（取样/拖移/右键删共用）：命中＝点落在【所画的体】外扩 13px 余量内——两类印章
    同一套语义（体在锚点上方，点体即中），几何与 drawDecor 逐条同源：矢量印取 PRIM_BOX×s 包络、
    自定义 img 印取底中锚定的 dw×dh 矩形；资产悬空/深放大退场时回退锚点 13px（没画出来的只按锚点拾取）。
    step 须与 drawDecor 同源传 grid.step（缺省 1）。
    多枚命中：先比到体的距离，体内并列（同为 0，密林/成岭常见）再比锚点距离取最近者。 */
export function pickDecor(cam: Camera, meta: Meta | undefined, world: World, yearNow: number,
  x: number, y: number, step = 1): Decor | null {
  const scale = (step / cam.degPerPx) / 14;
  const assets = world.assets;
  const byAsset = assets && assets.length ? new Map(assets.map(a => [a.id, a])) : null;
  let best: Decor | null = null, bd = Infinity, ba = Infinity;
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    for (const d of world.decor || []) {
      if (!activeAt(d, yearNow)) continue;
      const [px, py] = project(c2, d.lon, d.lat);
      const ad = Math.hypot(px - x, py - y);   // 锚点距离：体内并列时的次序键，也是无体可算时的回退
      let dd = ad;
      if (typeof d.kind === "string" && d.kind.startsWith("img:")) {
        const a = byAsset && byAsset.get(d.kind.slice(4));
        const base = DECOR_BASE_IMG * (d.size || 1) * scale;
        if (a && base >= 1 && base <= 420) {
          const ar = (a.w && a.h) ? a.w / a.h : 1;
          const dw = ar >= 1 ? base : base * ar, dh = ar >= 1 ? base / ar : base;
          dd = boxDist(x, y, px - dw / 2, py - dh, px + dw / 2, py);
        }
      } else {
        const s = (tget(DECOR_BASE, d.kind) || 5) * (d.size || 1) * scale;
        if (s <= 420) {                        // 深放大退场者不给体（与绘制同门）
          const [hw, up, dn] = tget(PRIM_BOX, d.kind) || PRIM_BOX_DEF;
          dd = boxDist(x, y, px - hw * s, py - up * s, px + hw * s, py + dn * s);
        }
      }
      if (dd < 13 && (dd < bd || (dd === bd && ad < ba))) { bd = dd; ba = ad; best = d; }
    }
  }
  return best;
}

/** 点到轴对齐矩形的距离（体内=0） */
function boxDist(x: number, y: number, x0: number, y0: number, x1: number, y1: number): number {
  return Math.hypot(Math.max(x0, Math.min(x, x1)) - x, Math.max(y0, Math.min(y, y1)) - y);
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
