/* 连线与作战线（自 overlay.ts 原样拆出，行为不变）：
   河流三层描边（选中红晕/白衬底/河蓝）、官道双线、商路紫点线、工事墨石齿线（2026-07 特化柱B）；
   作战线 攻势=末端实心箭头 / 防线=行进方向左侧齿线（reverse 翻面）。 */
import { EDGE_STYLE, certaintyStyle } from "../core/constants.ts";
import { tget } from "../core/util.ts";
import { activeAt, opVisibleAt } from "../core/time.ts";
import { project, projectSeq, type Camera } from "../core/projection.ts";
import { kmPerDegLat } from "../core/geo.ts";
import { chaikinOpen, meander } from "../core/geometry.ts";
import type { LabelField } from "./labels.ts";
import type { Edge, Meta, Op, World, WorldNode } from "../core/types.ts";

/* —— 河流描边（经典曲流河 + 自由画河共用）：三层描边（选中红晕/白衬底/河蓝） ——
   riverWpx：widthM 米→像素（放大自然变宽、缩小退回样式底宽 2.6px；无 widthM 时三层宽度与旧值 9/5/2.6 逐位一致）；
   导出供 pickEdge 拾取走廊同源（宽河点在河面即可选中）。 */
export function riverWpx(meta: Meta | undefined, cam: Camera, e: Edge): number {
  const wm = +(e.widthM as number) || 0;
  return wm > 0 ? Math.max(2.6, (wm / 1000) / kmPerDegLat(meta) / cam.degPerPx) : 2.6;
}
function strokeRiver(ctx: CanvasRenderingContext2D, pts: [number, number][], wpx: number, selected: boolean, dash?: number[] | null): void {
  const stroke = (w: number, col: string) => {
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    ctx.lineWidth = w; ctx.strokeStyle = col; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
  };
  if (selected) stroke(wpx + 6.4, "rgba(192,57,43,.35)");
  stroke(wpx + 2.4, "rgba(255,255,255,.5)");
  if (dash) ctx.setLineDash(dash);    // 可靠性：只断主线，衬底照画（柱B）
  stroke(wpx, "#3f7fc4");
  ctx.setLineDash([]);
}
/* —— 工事线（2026-07 特化柱B）：墨石主线+白衬底+单侧齿（雉堞刻）——壁垒/长城/堑壕/岸线同一线型。
   齿距 9px·齿长 4.5px；缺省齿在画线方向左侧，reverse 翻右（岸线惯例＝齿朝水）。
   渲染先行**寻路不吃**（route/grid 无 wall 分支，平价不动）；要吃只走战术分支另议。 —— */
export interface WallTooth { x: number; y: number; tx: number; ty: number }
/** 齿位（纯几何，node:test 锁）：与作战线防线齿同一走步——起步 0.6×gap、跨段累计弧长、短段跳过 */
export function wallTeeth(pts: [number, number][], gap: number, len: number, rev?: boolean): WallTooth[] {
  const out: WallTooth[] = [];
  let acc = 0, next = gap * 0.6;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], ay = pts[i - 1][1], bx = pts[i][0], by = pts[i][1];
    const seg = Math.hypot(bx - ax, by - ay); if (seg < 0.5) { acc += seg; continue; }
    const ux = (bx - ax) / seg, uy = (by - ay) / seg, s = rev ? -1 : 1, nx = s * uy, ny = -s * ux;
    while (next <= acc + seg) {
      const px = ax + ux * (next - acc), py = ay + uy * (next - acc);
      out.push({ x: px, y: py, tx: px + nx * len, ty: py + ny * len });
      next += gap;
    }
    acc += seg;
  }
  return out;
}
function strokeWall(ctx: CanvasRenderingContext2D, pts: [number, number][], selected: boolean, rev: boolean, dash?: number[] | null): void {
  const st = EDGE_STYLE.wall;
  const trace = () => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke(); };
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  if (selected) { ctx.strokeStyle = "rgba(192,57,43,.35)"; ctx.lineWidth = st.w + 5; trace(); }
  ctx.strokeStyle = "rgba(255,255,255,.5)"; ctx.lineWidth = st.w + 2.2; trace();
  if (dash) ctx.setLineDash(dash);    // 可靠性：只断主线，衬底与齿照画（柱B）
  ctx.strokeStyle = st.color; ctx.lineWidth = st.w; trace();
  ctx.setLineDash([]);
  ctx.lineWidth = 1.6;
  for (const t of wallTeeth(pts, 9, 4.5, rev)) { ctx.beginPath(); ctx.moveTo(t.x, t.y); ctx.lineTo(t.tx, t.ty); ctx.stroke(); }
}

/** 投影后折线整体在画布外＝跳过（自由画河/工事的视口裁剪；经典边沿用端点裁剪） */
function offscreenPts(pp: [number, number][], cam: Camera): boolean {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const p of pp) { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; }
  return maxx < 0 || minx > cam.w || maxy < 0 || miny > cam.h;
}

/** 一条连线的本体绘制（drawEdges 逐边在 save/restore 内调用）。dash=可靠性虚线（null＝确证，逐位不变） */
function strokeEdge(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined,
  byId: Map<string, WorldNode>, e: Edge, st: { color: string; w: number }, selected: boolean, dash: number[] | null): void {
  if (e.type === "river" && Array.isArray(e.pts) && e.pts.length >= 2) {   // 自由画河：沿自身折线（Chaikin 柔化），无端点
    const pp = projectSeq(cam, chaikinOpen(e.pts, 2));
    if (!offscreenPts(pp, cam)) strokeRiver(ctx, pp, riverWpx(meta, cam, e), selected, dash);
    return;
  }
  if (e.type === "wall" && Array.isArray(e.pts) && e.pts.length >= 2) {    // 自由画工事：原样折线（防线有棱角，不柔化）
    const pp = projectSeq(cam, e.pts);
    if (!offscreenPts(pp, cam)) strokeWall(ctx, pp, selected, !!e.reverse, dash);
    return;
  }
  if (!e.from || !e.to) return;      // 经典边必有两端（自由画河/工事已在上分支处理）
  const a = byId.get(e.from), b = byId.get(e.to); if (!a || !b) return;
  const [x1, y1] = project(cam, a.lon, a.lat), [x2, y2] = project(cam, b.lon, b.lat);
  if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > cam.w || Math.max(y1, y2) < 0 || Math.min(y1, y2) > cam.h) return;
  if (e.type === "river") {          // 经典 from/to 河：确定性曲流（对齐旧 drawRivers：白衬底+河蓝，选中红晕）
    strokeRiver(ctx, meander(a, b, e.from + e.to).map(p => project(cam, p[0], p[1])), riverWpx(meta, cam, e), selected, dash);
  } else if (e.type === "wall") {    // 锚定工事（两端点直线；UI 只产自由画，此形态供手编数据）
    strokeWall(ctx, [[x1, y1], [x2, y2]], selected, !!e.reverse, dash);
  } else if (e.type === "road") {    // 官道双线（可靠性虚线两层同步，否则亮线从缺口透出）
    ctx.globalAlpha *= 0.9;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    if (selected) { ctx.strokeStyle = "rgba(192,57,43,.35)"; ctx.lineWidth = st.w + 5; ctx.stroke(); }
    if (dash) ctx.setLineDash(dash);
    ctx.strokeStyle = st.color; ctx.lineWidth = st.w * 0.85; ctx.stroke();
    ctx.strokeStyle = "#e9ddc2"; ctx.lineWidth = st.w * 0.3; ctx.stroke();
    ctx.setLineDash([]);
  } else {                           // 商路：紫点线（可靠性时换长虚，与本型点线可辨）
    ctx.globalAlpha *= 0.9;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    if (selected) { ctx.setLineDash([]); ctx.strokeStyle = "rgba(192,57,43,.35)"; ctx.lineWidth = st.w + 5; ctx.stroke(); }
    ctx.strokeStyle = st.color; ctx.lineWidth = st.w * 0.55; ctx.setLineDash(dash || [3, 4]); ctx.stroke(); ctx.setLineDash([]);
  }
}

/** 连线（道路/河流/商路/工事）；选中的一条垫红晕（对齐旧 isSelEdge）。单相机（overlay 拷贝循环内调用）。
    可靠性（柱B）：逐边 save/restore 施 alpha 与虚线——确证＝dash null + alpha 1 ＝旧渲染逐位。 */
export function drawEdges(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined,
  world: World, yearNow: number, byId: Map<string, WorldNode>,
  layers: Record<string, boolean>, edgeSelIdx?: number | null): void {
  const on = (id: string) => layers[id] !== false;
  for (let idx = 0; idx < world.edges.length; idx++) {
    const e = world.edges[idx];
    if (!on(e.type) || !activeAt(e, yearNow)) continue;
    const st = tget(EDGE_STYLE, e.type); if (!st) continue;   // 未知线型不画——pickEdge 同门（拾取绘制同源）
    const cs = certaintyStyle(e.certainty, "edge");
    ctx.save();
    ctx.globalAlpha *= cs.alpha;
    strokeEdge(ctx, cam, meta, byId, e, st, edgeSelIdx === idx, cs.dash);
    ctx.restore();
  }
}

/* 作战线（战役事件点的 ops[]）：事件当年显示——攻势=末端实心箭头，防线=行进方向左侧齿线
   （reverse 翻面）；线色=所属派系（缺省红）。折线经 projectSeq 投影（跨 ±180° 不横穿全屏）。 */
/** 画一条作战线（叠加层与画线预览共用；ctx 已按 dpr 缩放、CSS 像素坐标系）。
    selected=true 在主描边下垫一圈泥金光晕表示选中。
    field：把 troop·label 注记登进标签避让场（作者内容不让位，地名/部队绕行）；预览调用不传。 */
export function drawOp(ctx: CanvasRenderingContext2D, cam: Camera, op: Op, world: World, selected = false, field?: LabelField | null): void {
  const pts = projectSeq(cam, op.pts);
  if (pts.length < 2) return;
  const col = (op.side && world.factions.find(f => f.id === op.side)?.color) || "#b0202a";
  const w = op.w || 3;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  const trace = () => { ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke(); };
  if (op.dash) ctx.setLineDash([Math.max(7, w * 2.2), Math.max(5, w * 1.8)]);   // 虚线（佯动/隐蔽/撤退）；箭头与防线齿保持实画
  if (selected) { ctx.strokeStyle = "rgba(202,164,90,.5)"; ctx.lineWidth = w + 9; trace(); }   // 泥金光晕
  ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = w + 3; trace();                   // 白衬底（对齐旧 drawOpLine）
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = w; trace();
  if (op.dash) ctx.setLineDash([]);
  if (op.kind === "attack") {
    // 攻势线末端箭头（沿最后一段方向，对齐旧参数）
    const n1 = pts[pts.length - 2], n2 = pts[pts.length - 1];
    const dx = n2[0] - n1[0], dy = n2[1] - n1[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    const s = Math.max(8, w * 2.6);
    ctx.beginPath(); ctx.moveTo(n2[0] + ux * s * 0.6, n2[1] + uy * s * 0.6);
    ctx.lineTo(n2[0] - ux * s - (-uy) * s * 0.55, n2[1] - uy * s - ux * s * 0.55);
    ctx.lineTo(n2[0] - ux * s + (-uy) * s * 0.55, n2[1] - uy * s + ux * s * 0.55);
    ctx.closePath(); ctx.fill();
  } else {
    // 防线齿：沿线等距在"正面"画短齿（旧版翻转=倒转点序；新数据用 reverse 翻法线，同效）
    const side = op.reverse ? -1 : 1;
    const tooth = Math.max(5, w * 2), gap = 14;
    let acc = 0, next = gap * 0.6;
    ctx.lineWidth = Math.max(1.4, w * 0.6);
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1][0], ay = pts[i - 1][1], bx = pts[i][0], by = pts[i][1];
      const seg = Math.hypot(bx - ax, by - ay); if (seg < 0.5) { acc += seg; continue; }
      const ux = (bx - ax) / seg, uy = (by - ay) / seg, nx = side * uy, ny = -side * ux;   // 画线方向左侧
      while (next <= acc + seg) {
        const px = ax + ux * (next - acc), py = ay + uy * (next - acc);
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + nx * tooth, py + ny * tooth); ctx.stroke();
        next += gap;
      }
      acc += seg;
    }
  }
  const txt = [op.troop, op.label].filter(Boolean).join("·");   // troop·label 标在线弧长中点（对齐旧）
  if (txt) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    let want = total / 2, acc2 = 0, mx = pts[0][0], my = pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (acc2 + seg >= want) {
        const t = seg ? (want - acc2) / seg : 0;
        mx = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t; my = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
        break;
      }
      acc2 += seg;
    }
    ctx.font = "11px KaiTi,楷体,serif"; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.88)";
    ctx.strokeText(txt, mx + 5, my - 5); ctx.fillStyle = col; ctx.fillText(txt, mx + 5, my - 5);
    if (field) field.claim({ x: mx + 5, y: my - 5 - 11, w: ctx.measureText(txt).width, h: 13 });
  }
}
export function drawOps(ctx: CanvasRenderingContext2D, cam: Camera, world: World, yearNow: number,
  selId?: string | null, opSel?: { evId: string; i: number } | null, field?: LabelField | null) {
  for (const ev of world.nodes) {
    if (ev.type !== "event" || !ev.ops) continue;
    const selEv = ev.id === selId;
    ev.ops.forEach((op, i) => {
      const on = opVisibleAt(ev, op, yearNow);   // 带时段=分相位；无时段=事件当年（旧语义）
      if (!on && !selEv) return;                 // 选中事件=回看其全部作战线（任意时刻）
      ctx.save();
      ctx.globalAlpha = on ? 0.95 : 0.8;         // 非当时（选中回看）淡一档，对齐旧 drawOps
      drawOp(ctx, cam, op, world, !!opSel && opSel.evId === ev.id && opSel.i === i, field);
      ctx.restore();
    });
  }
}
