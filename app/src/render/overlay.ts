/* 叠加层编排：按图层开关与世界拷贝循环调度各域绘制（政治 factions / 连线·作战线 edges /
   地点·标签·标注 nodes / 部队 units / 生态·布景 decor），本文件只留 编排 + 画布 chrome
   （经纬网/图廓外的纸与图廓线/比例尺/图名）；拆出的域文件与拾取（pick.ts）经此门面再导出——外部 import 面不变。
   数百要素直绘足够；万级批量与空间索引在 后段定案。 */
import { LAYERS } from "../core/constants.ts";
import { project, SCALE_BAR_PX, unproject, visibleWorldCopies, type Camera } from "../core/projection.ts";
import { frameRectsPx, type FrameRect } from "../core/frame.ts";
import { PAPER } from "./material.ts";
import { distKm, kmPerDeg, lonCos, wrapLon } from "../core/geo.ts";
import { calOf, fmtT, fmtYear } from "../core/calendar.ts";
import { fmtKm } from "../core/util.ts";
import { isModern } from "../core/units.ts";
import { drawDecor } from "./decor.ts";
import { drawRanges, drawUnits } from "./units.ts";
import { drawFactions, type LoopBudget } from "./factions.ts";
import { drawEdges, drawOps } from "./edges.ts";
import { drawNodes, drawNodeRanges, drawPinnedNotes } from "./nodes.ts";
import { createLabelField } from "./labels.ts";
import { drawSpotHeights } from "./spots.ts";
import { drawContourLabels } from "./contourlab.ts";
import type { Grid } from "../core/grid.ts";
import type { ElevField } from "../core/elev.ts";
import type { SpotTable } from "../core/spots.ts";
import type { Leg } from "../core/units.ts";
import type { VisMasks } from "../core/viewshed.ts";
import type { SightRes } from "../worker/routeProto.ts";
import type { Meta, World, WorldNode } from "../core/types.ts";

/* 门面再导出（拆层不改调用点）：绘制单线 drawOp 供画线预览（frame），拾取全家（pointer） */
export { drawOp } from "./edges.ts";
export { pickEdge, pickOp, pickNode, nodesInBox } from "./pick.ts";
export { pinnedStackH } from "./nodes.ts";   // 出图图例让开 se 屏幕角标注（library.composeFrame）
export type { NodeGateOpts } from "./nodes.ts";
export type { LoopBudget } from "./factions.ts";

/** 战术图专属层 id（tacOnly 的唯一消费点，与 LayersPane 的「战术」小签同源于 LAYERS） */
const TAC_ONLY = new Set(LAYERS.filter(l => l.tacOnly).map(l => l.id));
/** 图层是否该画：开关（缺省=开）× tacOnly 门。tacOnly 层在非战术图上一律不画——
    层面板不显示它们的行＝用户关不掉，若某张战略图的存档带了 units[]/node.ranges，
    就会画出关不掉的兵棋。与 pointer 的 unitPickable() 同义＝拾取绘制同源。 */
export function layerOn(layers: Record<string, boolean> | undefined, meta: Meta | undefined, id: string): boolean {
  if ((layers || {})[id] === false) return false;
  return (meta || {}).mapKind === "tactical" || !TAC_ONLY.has(id);
}

export interface OverlayOpts {
  layers?: Record<string, boolean>;   // 图层开关（缺省=开；键同 LAYERS.id）
  selId?: string | null;              // 选中地点 id（金圈高亮；战役任意年显示作战线）
  opSel?: { evId: string; i: number } | null;   // 选中的作战线（泥金光晕）
  grid?: Grid;                        // 布景印章尺度源（应恒传；缺则印章尺度回退 1°）
  multiIds?: string[] | null;         // 框选的地点 id（金圈高亮全部）
  unitSelId?: string | null;          // 选中部队 id（泥金光晕框；战术图）
  multiUnitIds?: string[] | null;     // 框选的部队 id（同款光晕；战术图）
  decorSelId?: string | null;         // 选中布景 id（虚线金框）
  decorMultiIds?: string[] | null;    // 框选的布景 id（同款金框）
  unitLegs?: Map<string, Leg[]>;      // 部队可达性预算（外壳缓存；供尾迹标超速）
  visMasks?: VisMasks;                // 视线掩膜（外壳编排；有掩膜的圈只填视线可达的格）
  detect?: Map<string, SightRes[]>;   // 飞行部队被他派看见（外壳编排；看见的画探测圈）
  ruleField?: ElevField | null;       // 落定的规则场（等高线注记读；数字与光标读数同源，演算中沿用上一份）
  spotTable?: SpotTable | null;       // 标高点峰表（外壳编排；null＝未算出，只标水面）
  contourStep?: number;               // 等距（抽象单位，renderer.contourStepOf 取的那一档，与地形渲染器同一档；注记按它标）
  smooth?: number;                    // 涂域边界平滑档（Chaikin 轮数 0–3；缺省 2，笔刷框调）
  edgeSelIdx?: number | null;         // 选中连线下标（红晕高亮，对齐旧 isSelEdge）
  editing?: boolean;                  // 编辑模式：全部地点可见（对齐旧 nodeVisible）
  loopBudget?: LoopBudget;            // 涂域环首算的本帧额度（缺省＝一次算全）
}

/** 焦点部队＝选中 + 框选的部队 id；空＝无焦点态（各圈平铺） */
function unitFocus(opts: OverlayOpts): ReadonlySet<string> | undefined {
  const s = new Set<string>(opts.multiUnitIds || []);
  if (opts.unitSelId) s.add(opts.unitSelId);
  return s.size ? s : undefined;
}
/** 焦点地点＝选中 + 框选里带火力圈的那些：点一座城不该把全图火力圈压成陪衬 */
function nodeFocus(opts: OverlayOpts, byId: Map<string, WorldNode>): ReadonlySet<string> | undefined {
  const s = new Set<string>();
  for (const id of [opts.selId, ...(opts.multiIds || [])]) {
    const n = id ? byId.get(id) : undefined;
    if (n && (n.ranges || []).some(r => +r.km > 0)) s.add(n.id);
  }
  return s.size ? s : undefined;
}

export function drawOverlay(
  ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined,
  world: World, yearNow: number, dpr: number, opts: OverlayOpts = {}
): void {
  const L = opts.layers || {};
  const on = (id: string) => layerOn(L, meta, id);   // 开关 × tacOnly 门（判据见 layerOn）
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.save(); ctx.scale(dpr, dpr);
  /* try/finally：任一绘制域抛异常也须归位画布状态——否则下帧 save+scale 在残留变换上复利，
     叠加层永久失控放大；末尾 setTransform 兜底「内层 save 未配对」时单次 restore 不够的情形。 */
  try {
    /* 首个命中优先（同 core/grid.roadCellSet 的同名纪律）：`nodes.find` 取首个同 id 者，而
       `new Map(nodes.map(…))` 是后者覆盖前者——重复 id 的档上「选中的」与「画出来/点到的」会是两个对象。 */
    const byId = new Map<string, WorldNode>();
    for (const n of world.nodes) if (!byId.has(n.id)) byId.set(n.id, n);
    const fcolor = (id: string | null) => (id && world.factions.find(f => f.id === id)?.color) || "#6b6b6b";
    const multiSet = new Set(opts.multiIds || []);
    const decorSel = { id: opts.decorSelId, ids: opts.decorMultiIds ? new Set(opts.decorMultiIds) : null };
    const focus = unitFocus(opts), focusNodes = nodeFocus(opts, byId);
    for (const shift of visibleWorldCopies(cam, meta)) {
      const c2: Camera = { ...cam, lonShift: shift };
      if (on("decor")) drawDecor(ctx, c2, world, yearNow, opts.grid ? opts.grid.step : 1, decorSel);   // 手绘布景（印章尺度随格距 step；生态笔刷落的真实印章同此层）
      if (on("politics")) drawFactions(ctx, c2, meta, world, yearNow, opts.smooth ?? 2, opts.loopBudget);
      if (on("range")) drawNodeRanges(ctx, c2, meta, world, yearNow, opts.selId);   // 地点范围虚线圈
      if (on("ranges") || on("vision") || on("radar")) drawRanges(ctx, c2, meta, world, yearNow, {   // 火力射程/视野/雷达圈：垫在连线/地点之下
        fire: on("ranges"), vision: on("vision"), radar: on("radar") && isModern(meta), masks: opts.visMasks,   // 雷达层随时代（层面板同门）
        focus, focusNodes,                                               // 选中/框选的部队与带火力圈的地点＝焦点：斜纹加粗，其余只留描边
        handleUnit: opts.editing ? (opts.unitSelId || null) : null,     // 编辑态选中对象的圈带半径拖动手柄
        handleNode: opts.editing ? (opts.selId || null) : null
      });
      drawEdges(ctx, c2, meta, world, yearNow, byId, L, opts.edgeSelIdx);   // 连线（道路/河流/商路）
      const field = createLabelField();   // 标签避让场（每拷贝一场）：线注记/标注 claim → 当日事件→地名→部队 先占先得
      if (on("arrows")) drawOps(ctx, c2, world, yearNow, opts.selId, opts.opSel, field);
      if (on("nodes")) drawNodes(ctx, c2, meta, world, yearNow, opts, multiSet, fcolor, field);   // 地点记号 + 楷体标签（避让）
      if (on("units")) drawUnits(ctx, c2, meta, world, yearNow,   // 部队【记号】压在地点之上（战场主角）；标签让地名
        { trails: on("trails"), labels: on("labels"), selId: opts.unitSelId, multiIds: opts.multiUnitIds, legs: opts.unitLegs, labelField: field, detect: opts.detect,
          handleUnit: opts.editing ? (opts.unitSelId || null) : null });   // 阵形朝向手柄（同圈手柄之规：编辑态选中对象才出）
      if (on("spots") && opts.grid) drawSpotHeights(ctx, c2, meta, opts.spotTable || null, opts.grid, field, opts.contourStep || 0, on("terrain") && on("contour"));   // 标高点占位：让地名与部队
      if (on("terrain") && on("contour") && opts.ruleField && opts.grid)   // 等高线注记**最后**占位：让地名、部队与标高点（线由地形渲染器画，故并 terrain 门）
        drawContourLabels(ctx, c2, meta, opts.ruleField, opts.grid, field, opts.contourStep || 0);
    }
    /* 图页：网线先画、图廓外那段随后被纸盖住；纸与图廓线之后才是刻度字与屏幕 chrome（字在图里，不在纸上） */
    const rects = frameRectsPx(cam, meta);
    const ticks = on("graticule") ? gridTicks(cam, meta) : null;
    if (ticks) strokeTicks(ctx, cam, ticks);
    drawMargin(ctx, cam, rects);
    drawNeatline(ctx, cam, rects);
    if (ticks) labelTicks(ctx, cam, ticks, rects);
    if (on("notes")) drawPinnedNotes(ctx, cam, world, yearNow, opts, fcolor);   // 屏幕角标注（帧标题/图注块）
    drawScaleBar(ctx, cam, meta);                          // 图形比例尺（左下，随 PNG 导出）
    drawTitle(ctx, meta, yearNow);                         // 图名 + 纪年（左上，随 PNG 导出）
  } finally {
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

/** 网格的刻度：竖线的屏幕 x 与横线的屏幕 y，各带刻度字 */
interface Ticks { xs: { p: number; t: string }[]; ys: { p: number; t: string }[] }

/* 经纬网（graticule，faithful port 自旧 drawGraticule）：屏幕空间一次绘制（不入世界拷贝循环），
   自适应步长（10/5/1°随缩放），经线标注折回本初域经度。
   战术图分流为公里网（2026-07 特化 P0）：1° 最小步长在 0.24° 宽的战场图上恒 0~1 条线＝失效。 */
function gridTicks(cam: Camera, meta: Meta | undefined): Ticks {
  if ((meta || {}).mapKind === "tactical" && (meta || {}).bbox) return kmTicks(cam, meta!);
  const tl = unproject(cam, 0, 0), br = unproject(cam, cam.w, cam.h);
  const step = cam.degPerPx > 0.12 ? 10 : (cam.degPerPx > 0.045 ? 5 : 1);
  const flat = (meta || {}).worldModel === "flat";
  const out: Ticks = { xs: [], ys: [] };
  for (let lon = Math.ceil(tl[0] / step) * step; lon <= br[0]; lon += step)
    out.xs.push({ p: project(cam, lon, cam.lat0)[0], t: Math.round(wrapLon(lon, flat)) + "°" });   // 环绕后标注归一经度
  for (let lat = Math.ceil(br[1] / step) * step; lat <= tl[1]; lat += step)
    out.ys.push({ p: project(cam, cam.lon0, lat)[1], t: Math.round(lat) + "°" });
  return out;
}

/* 战术公里网（方里格）：战场测绘的参考系是公里格不是经纬度。原点锚 meta.bbox 西南角
   ＝图幅原点（不随镜头漂）；步长 1-2-5 档取格宽 ≥64px 的最细档；经向按图幅中央纬度
   折算（战场尺度曲率可忽略,折算式同火力圈 ringPx）。标注=距图幅原点的东距/北距。 */
function kmTicks(cam: Camera, meta: Meta): Ticks {
  const bb = meta.bbox!;
  const out: Ticks = { xs: [], ys: [] };
  const dLat = 1 / kmPerDeg(meta);                     // 1km 的纬度跨度
  const dLon = dLat / lonCos(meta, (bb.latMin + bb.latMax) / 2);
  const kmPerPx = cam.degPerPx / dLon;
  if (!isFinite(kmPerPx) || kmPerPx <= 0) return out;
  let stepKm = 5000;
  outer: for (let p = 0.001; p <= 1000; p *= 10) for (const m5 of [1, 2, 5]) {
    if (m5 * p / kmPerPx >= 64) { stepKm = m5 * p; break outer; }
  }
  const lonStep = stepKm * dLon, latStep = stepKm * dLat;
  const tl = unproject(cam, 0, 0), br = unproject(cam, cam.w, cam.h);
  const lab = (k: number) => k === 0 ? "0" : fmtKm(k * stepKm);
  for (let k = Math.ceil((tl[0] - bb.lonMin) / lonStep); k <= Math.floor((br[0] - bb.lonMin) / lonStep); k++)
    out.xs.push({ p: project(cam, bb.lonMin + k * lonStep, cam.lat0)[0], t: lab(k) });
  for (let k = Math.ceil((br[1] - bb.latMin) / latStep); k <= Math.floor((tl[1] - bb.latMin) / latStep); k++)
    out.ys.push({ p: project(cam, cam.lon0, bb.latMin + k * latStep)[1], t: lab(k) });
  return out;
}

const GRID_INK = "rgba(40,60,80,.16)", GRID_TEXT = "rgba(40,60,80,.6)";

/** 网线铺满视口：图廓外那段由随后的纸盖住 */
function strokeTicks(ctx: CanvasRenderingContext2D, cam: Camera, g: Ticks): void {
  ctx.save();
  ctx.strokeStyle = GRID_INK; ctx.lineWidth = 1;
  ctx.beginPath();
  for (const { p } of g.xs) { ctx.moveTo(p, 0); ctx.lineTo(p, cam.h); }
  for (const { p } of g.ys) { ctx.moveTo(0, p); ctx.lineTo(cam.w, p); }
  ctx.stroke();
  ctx.restore();
}

/** 刻度字只标图幅里的线，贴在可见图幅的下沿与左沿内侧——视口边在纸上时字跟着图廓走 */
function labelTicks(ctx: CanvasRenderingContext2D, cam: Camera, g: Ticks, rects: FrameRect[]): void {
  const vis = rects.filter(r => r.x1 > 0 && r.x0 < cam.w && r.y1 > 0 && r.y0 < cam.h);
  if (!vis.length) return;
  const yT = Math.max(0, vis[0].y0), yB = Math.min(cam.h, vis[0].y1);
  const xL = Math.max(0, Math.min(...vis.map(r => r.x0)));
  ctx.save();
  ctx.fillStyle = GRID_TEXT; ctx.font = "10px sans-serif";
  for (const { p, t } of g.xs) if (vis.some(r => p >= r.x0 - 0.5 && p <= r.x1 + 0.5)) ctx.fillText(t, p + 2, yB - 6);
  for (const { p, t } of g.ys) if (p >= yT - 0.5 && p <= yB + 0.5) ctx.fillText(t, xL + 3, p - 3);
  ctx.restore();
}

/** 画布外扩量（CSS 像素）：纸与图廓线画到视口外一点，免得抗锯齿在视口边露出底下的地形 */
const EDGE_PAD = 8;

/* 图廓外铺纸：视口减各块图幅，一次 even-odd 填充——地形画布与叠加层在图廓外的一切都被它盖住，
   两个地形渲染器不必各自裁 */
function drawMargin(ctx: CanvasRenderingContext2D, cam: Camera, rects: FrameRect[]): void {
  const P = EDGE_PAD;
  ctx.save();
  ctx.beginPath();
  ctx.rect(-P, -P, cam.w + 2 * P, cam.h + 2 * P);
  for (const r of rects) {
    const x0 = Math.max(-P, r.x0), x1 = Math.min(cam.w + P, r.x1), y0 = Math.max(-P, r.y0), y1 = Math.min(cam.h + P, r.y1);
    if (x1 > x0 && y1 > y0) ctx.rect(x0, y0, x1 - x0, y1 - y0);
  }
  ctx.fillStyle = PAPER;
  ctx.fill("evenodd");
  ctx.restore();
}

/* 图廓线（neatline）：内粗外细双线（地图集惯例），随 PNG 导出；经跨满 360° 的球面图只有上下两条 */
function drawNeatline(ctx: CanvasRenderingContext2D, cam: Camera, rects: FrameRect[]): void {
  const P = EDGE_PAD;
  const trace = (d: number): void => {
    ctx.beginPath();
    for (const r of rects) {
      if (r.x1 + d < -P || r.x0 - d > cam.w + P || r.y1 + d < -P || r.y0 - d > cam.h + P) continue;
      if (isFinite(r.x0)) ctx.rect(r.x0 - d, r.y0 - d, r.x1 - r.x0 + 2 * d, r.y1 - r.y0 + 2 * d);
      else for (const y of [r.y0 - d, r.y1 + d]) { ctx.moveTo(-P, y); ctx.lineTo(cam.w + P, y); }
    }
    ctx.stroke();
  };
  ctx.save();
  ctx.strokeStyle = "rgba(90,74,38,.62)"; ctx.lineWidth = 1.5; trace(0);
  ctx.strokeStyle = "rgba(90,74,38,.28)"; ctx.lineWidth = 1; trace(3.5);
  ctx.restore();
}

/* 图形比例尺（对齐旧 drawScaleBar：制图规范 1-2-5 档，细分到 m；宣纸底衬） */
function drawScaleBar(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined) {
  const H = cam.h;
  const a = unproject(cam, 12, H - 16), b = unproject(cam, 112, H - 16);
  const kmPerPx = distKm(meta, a[0], a[1], b[0], b[1]) / 100;
  if (!isFinite(kmPerPx) || kmPerPx <= 0) return;
  let nice = 0.001;
  const target = kmPerPx * SCALE_BAR_PX;
  for (const m of [1, 2, 5]) for (let p = 0.001; p <= 100000; p *= 10) { if (m * p <= target) nice = Math.max(nice, m * p); }
  const px = nice / kmPerPx, x0 = 12, y0 = H - 16;
  ctx.save();
  ctx.fillStyle = "rgba(246,239,220,.82)"; ctx.fillRect(x0 - 6, y0 - 16, px + 12, 26);
  ctx.strokeStyle = "rgba(90,74,38,.5)"; ctx.lineWidth = 1; ctx.strokeRect(x0 - 6, y0 - 16, px + 12, 26);
  ctx.fillStyle = "#2c241b"; ctx.fillRect(x0, y0, px / 2, 4);
  ctx.strokeStyle = "#2c241b"; ctx.strokeRect(x0, y0, px, 4);
  ctx.font = "11px sans-serif"; ctx.fillStyle = "#3a2f1d";
  ctx.fillText("0", x0 - 2, y0 - 4);
  const t = fmtKm(nice);
  ctx.fillText(t, x0 + px - ctx.measureText(t).width + 4, y0 - 4);
  ctx.restore();
}

/* 图名 + 纪年（对齐旧 drawTitle：左上角楷体描白，随 PNG 导出，方便贴进笔记） */
function drawTitle(ctx: CanvasRenderingContext2D, meta: Meta | undefined, yearNow: number) {
  const m = meta || {};
  const cursor = m.mapKind === "tactical" ? fmtT(calOf(m.calendar), yearNow) : fmtYear(calOf(m.calendar), yearNow, true);
  const t = `${m.名称 || "舆图"} · ${cursor}`;
  ctx.save();
  ctx.font = "bold 17px KaiTi,楷体,serif";
  ctx.lineWidth = 4; ctx.strokeStyle = "rgba(255,255,255,.82)"; ctx.strokeText(t, 14, 28);
  ctx.fillStyle = "#3a2f1d"; ctx.fillText(t, 14, 28);
  ctx.restore();
}
