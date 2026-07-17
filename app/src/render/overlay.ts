/* 叠加层：连线 + 地点记号 + 地名标签，Canvas2D 直绘；按纪年过滤、随缩放分级显隐、
   随派系归属着色、跨 ±180° 按世界拷贝重绘。数百要素直绘足够；万级批量与空间索引在 后段定案。 */
import { EDGE_STYLE, NODE_STYLE, RANK_ZOOM } from "../core/constants.ts";
import { activeAt, opVisibleAt, ownerAt, paintLayersAt } from "../core/time.ts";
import { project, projectSeq, unproject, visibleWorldCopies, type Camera } from "../core/projection.ts";
import { distKm, kmPerDegLat, toRad, wrapLon } from "../core/geo.ts";
import { calOf, fmtT, fmtYear } from "../core/calendar.ts";
import { territoryLoops, paintStep } from "../core/territory.ts";
import { chaikinOpen, convexHull, meander, type Pt } from "../core/geometry.ts";
import { fmtKm, hexA } from "../core/util.ts";
import { drawDecor, drawEco } from "./decor.ts";
import { drawRanges, drawUnits } from "./units.ts";
import type { Grid } from "../core/grid.ts";
import type { Leg } from "../core/units.ts";
import type { Edge, Faction, Meta, Op, World, WorldNode } from "../core/types.ts";

/* —— 河流描边（经典曲流河 + 自由画河共用）：三层描边（选中红晕/白衬底/河蓝） ——
   riverWpx：widthM 米→像素（放大自然变宽、缩小退回样式底宽 2.6px；无 widthM 时三层宽度与旧值 9/5/2.6 逐位一致）。 */
function riverWpx(meta: Meta | undefined, cam: Camera, e: Edge): number {
  const wm = +(e.widthM as number) || 0;
  return wm > 0 ? Math.max(2.6, (wm / 1000) / kmPerDegLat(meta) / cam.degPerPx) : 2.6;
}
function strokeRiver(ctx: CanvasRenderingContext2D, pts: [number, number][], wpx: number, selected: boolean): void {
  const stroke = (w: number, col: string) => {
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    ctx.lineWidth = w; ctx.strokeStyle = col; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
  };
  if (selected) stroke(wpx + 6.4, "rgba(192,57,43,.35)");
  stroke(wpx + 2.4, "rgba(255,255,255,.5)"); stroke(wpx, "#3f7fc4");
}
/** 投影后折线整体在画布外＝跳过（自由画河的视口裁剪；经典边沿用端点裁剪） */
function offscreenPts(pp: [number, number][], cam: Camera): boolean {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const p of pp) { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; }
  return maxx < 0 || minx > cam.w || maxy < 0 || miny > cam.h;
}

/* 政治层：涂域边界环（marching squares，缓存按层对象+平滑档）→ 实线填充；
   无涂域时按当年归属节点凸包推导（≥3 点）；显式 territory 多边形 = 虚线影响范围 */
const LOOP_CACHE = new WeakMap<object, { smooth: number; loops: Pt[][] }>();
/** 派系名标签（对齐旧 drawFactionLabel）：楷体描白，落在疆域/凸包质心 */
function drawFactionLabel(ctx: CanvasRenderingContext2D, f: Faction, cx: number, cy: number) {
  ctx.font = "bold 15px KaiTi,楷体,serif"; ctx.textAlign = "center";
  ctx.lineWidth = 4; ctx.strokeStyle = "rgba(255,255,255,.78)"; ctx.strokeText(f.名称 || "", cx, cy);
  ctx.fillStyle = hexA(f.color || "#888", 0.95); ctx.fillText(f.名称 || "", cx, cy);
  ctx.textAlign = "start";
}
function drawFactions(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined, world: World, yearNow: number, smooth = 2) {
  for (const f of world.factions) {
    if (!activeAt(f, yearNow)) continue;
    const col = f.color || "#888";
    const pls = paintLayersAt(f, yearNow);
    if (f.paint && f.paint.length) {
      if (pls.length) {
        /* 涂绘疆域：全部层的环并进一条路径 evenodd 填充（内环成洞），标签落在最大环质心（对齐旧 drawPolitics） */
        let lab: [number, number] | null = null, labMax = -1;
        ctx.beginPath();
        for (const L of pls) {
          let c = LOOP_CACHE.get(L);
          if (!c || c.smooth !== smooth) { c = { smooth, loops: territoryLoops(L.cells, (meta || {}).bbox, smooth, paintStep(meta)) }; LOOP_CACHE.set(L, c); }
          for (const lp of c.loops) {
            const pts = lp.map(p => project(cam, p[0], p[1]));
            pts.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]));
            ctx.closePath();
            if (pts.length > labMax) {
              labMax = pts.length;
              let sx = 0, sy = 0; pts.forEach(q => { sx += q[0]; sy += q[1]; });
              lab = [sx / pts.length, sy / pts.length];
            }
          }
        }
        ctx.fillStyle = hexA(col, 0.18); ctx.fill("evenodd");
        ctx.lineWidth = 2.4; ctx.strokeStyle = hexA(col, 0.85); ctx.stroke();
        if (lab) drawFactionLabel(ctx, f, lab[0], lab[1]);
      }
      continue;   // 有涂域的势力：当年无生效层=当年无疆域
    }
    /* 无涂域：据点凸包近似。显式 territory（地点 id 列表）=影响范围（虚线淡显）；
       否则按当年归属取据点（对齐旧 factionNodesAt——曾误按坐标多边形绘制，此处修正） */
    const byId = (id: string) => world.nodes.find(n => n.id === id);
    const ns = (f.territory
      ? (f.territory as string[]).map(byId).filter((n): n is WorldNode => !!n)
      : world.nodes.filter(n => n.type !== "event" && ownerAt(n, yearNow) === f.id)
    ).filter(n => activeAt(n, yearNow));
    const pts = ns.map(n => project(cam, n.lon, n.lat));
    if (!pts.length) continue;
    const influence = !!f.territory;
    let cx = 0, cy = 0;
    if (pts.length >= 3) {
      const hull = convexHull(pts as Pt[]);
      ctx.beginPath(); hull.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
      ctx.fillStyle = hexA(col, influence ? 0.10 : 0.18); ctx.fill();
      ctx.lineWidth = influence ? 2 : 2.6; ctx.strokeStyle = hexA(col, influence ? 0.55 : 0.8);
      if (influence) ctx.setLineDash([6, 4]);
      ctx.stroke(); ctx.setLineDash([]);
      hull.forEach(p => { cx += p[0]; cy += p[1]; }); cx /= hull.length; cy /= hull.length;
    } else {
      /* 1–2 个据点：画圆斑示意（对齐旧退化分支），标签抬高 30px */
      for (const p of pts) {
        ctx.beginPath(); ctx.arc(p[0], p[1], 26, 0, 7);
        ctx.fillStyle = hexA(col, 0.16); ctx.fill();
        ctx.lineWidth = 1.6; ctx.strokeStyle = hexA(col, 0.5); ctx.stroke();
      }
      cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      cy = pts.reduce((s, p) => s + p[1], 0) / pts.length - 30;
    }
    drawFactionLabel(ctx, f, cx, cy);
  }
}

/* 作战线（战役事件点的 ops[]）：事件当年显示——攻势=末端实心箭头，防线=行进方向左侧齿线
   （reverse 翻面）；线色=所属派系（缺省红）。折线经 projectSeq 投影（跨 ±180° 不横穿全屏）。 */
/** 画一条作战线（叠加层与画线预览共用；ctx 已按 dpr 缩放、CSS 像素坐标系）。
    selected=true 在主描边下垫一圈泥金光晕表示选中。 */
export function drawOp(ctx: CanvasRenderingContext2D, cam: Camera, op: Op, world: World, selected = false): void {
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
  }
}
function drawOps(ctx: CanvasRenderingContext2D, cam: Camera, world: World, yearNow: number,
  selId?: string | null, opSel?: { evId: string; i: number } | null) {
  for (const ev of world.nodes) {
    if (ev.type !== "event" || !ev.ops) continue;
    const selEv = ev.id === selId;
    ev.ops.forEach((op, i) => {
      const on = opVisibleAt(ev, op, yearNow);   // 带时段=分相位；无时段=事件当年（旧语义）
      if (!on && !selEv) return;                 // 选中事件=回看其全部作战线（任意时刻）
      ctx.save();
      ctx.globalAlpha = on ? 0.95 : 0.8;         // 非当时（选中回看）淡一档，对齐旧 drawOps
      drawOp(ctx, cam, op, world, !!opSel && opSel.evId === ev.id && opSel.i === i);
      ctx.restore();
    });
  }
}

/* 经纬网（graticule，faithful port 自旧 drawGraticule）：屏幕空间一次绘制（不入世界拷贝循环），
   自适应步长（10/5/1°随缩放），经线标注折回本初域经度。ctx 已按 dpr 缩放、CSS 像素坐标系。 */
function drawGraticule(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined): void {
  const tl = unproject(cam, 0, 0), br = unproject(cam, cam.w, cam.h);
  const step = cam.degPerPx > 0.12 ? 10 : (cam.degPerPx > 0.045 ? 5 : 1);
  const flat = (meta || {}).worldModel === "flat";
  ctx.save();
  ctx.strokeStyle = "rgba(40,60,80,.16)"; ctx.fillStyle = "rgba(40,60,80,.6)";
  ctx.lineWidth = 1; ctx.font = "10px sans-serif";
  for (let lon = Math.ceil(tl[0] / step) * step; lon <= br[0]; lon += step) {
    const x = project(cam, lon, cam.lat0)[0];
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cam.h); ctx.stroke();
    ctx.fillText(Math.round(wrapLon(lon, flat)) + "°", x + 2, cam.h - 6);   // 环绕后标注归一经度
  }
  for (let lat = Math.ceil(br[1] / step) * step; lat <= tl[1]; lat += step) {
    const y = project(cam, cam.lon0, lat)[1];
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cam.w, y); ctx.stroke();
    ctx.fillText(Math.round(lat) + "°", 3, y - 3);
  }
  ctx.restore();
}

export interface OverlayOpts {
  layers?: Record<string, boolean>;   // 图层开关（缺省=开；键同 LAYERS.id）
  selId?: string | null;              // 选中地点 id（金圈高亮；战役任意年显示作战线）
  opSel?: { evId: string; i: number } | null;   // 选中的作战线（泥金光晕）
  grid?: Grid;                        // 生态点缀散布 + 布景印章尺度源（应恒传；缺则 eco 不画、印章尺度回退 1°）
  eco?: boolean;                      // 生态点缀开关（缺省开）——独立于 grid：地形涂改只关此项，印章尺度仍用 grid.step
  multiIds?: string[] | null;         // 框选的地点 id（金圈高亮全部）
  unitSelId?: string | null;          // 选中部队 id（泥金光晕框；战术图）
  multiUnitIds?: string[] | null;     // 框选的部队 id（同款光晕；战术图）
  unitLegs?: Map<string, Leg[]>;      // 部队可达性预算（外壳缓存；供尾迹标超速）
  smooth?: number;                    // 涂域边界平滑档（Chaikin 轮数 0–3；缺省 2，笔刷框调）
  edgeSelIdx?: number | null;         // 选中连线下标（红晕高亮，对齐旧 isSelEdge）
  editing?: boolean;                  // 编辑模式：全部地点可见（对齐旧 nodeVisible）
}

export function drawOverlay(
  ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined,
  world: World, yearNow: number, dpr: number, opts: OverlayOpts = {}
): void {
  const L = opts.layers || {};
  const on = (id: string) => L[id] !== false;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.save(); ctx.scale(dpr, dpr);
  const byId = new Map(world.nodes.map(n => [n.id, n]));
  const fcolor = (id: string | null) => (id && world.factions.find(f => f.id === id)?.color) || "#6b6b6b";
  const multiSet = new Set(opts.multiIds || []);
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    if (on("eco") && opts.eco !== false && opts.grid) drawEco(ctx, c2, opts.grid);   // 生态点缀（垫底，地形之上）
    if (on("decor")) drawDecor(ctx, c2, world, yearNow, opts.grid ? opts.grid.step : 1);   // 手绘布景（印章尺度随格距 step）
    if (on("politics")) drawFactions(ctx, c2, meta, world, yearNow, opts.smooth ?? 2);
    if (on("range")) drawNodeRanges(ctx, c2, meta, world, yearNow, opts.selId);   // 地点范围虚线圈
    if (on("ranges") || on("vision")) drawRanges(ctx, c2, meta, world, yearNow, {   // 火力射程/视野圈：垫在连线/地点之下
      fire: on("ranges"), vision: on("vision"),
      handleUnit: opts.editing ? (opts.unitSelId || null) : null,     // 编辑态选中对象的圈带半径拖动手柄
      handleNode: opts.editing ? (opts.selId || null) : null
    });
    /* 连线（道路/河流/商路）；选中的一条垫红晕（对齐旧 isSelEdge） */
    for (let idx = 0; idx < world.edges.length; idx++) {
      const e = world.edges[idx];
      if (!on(e.type) || !activeAt(e, yearNow)) continue;
      const st = EDGE_STYLE[e.type]; if (!st) continue;
      const selected = opts.edgeSelIdx === idx;
      if (e.type === "river" && Array.isArray(e.pts) && e.pts.length >= 2) {   // 自由画河：沿自身折线（Chaikin 柔化），无端点
        const pp = projectSeq(c2, chaikinOpen(e.pts, 2));
        if (!offscreenPts(pp, cam)) strokeRiver(ctx, pp, riverWpx(meta, cam, e), selected);
        continue;
      }
      if (!e.from || !e.to) continue;    // 经典边必有两端（自由画河已在上分支处理）
      const a = byId.get(e.from), b = byId.get(e.to); if (!a || !b) continue;
      const [x1, y1] = project(c2, a.lon, a.lat), [x2, y2] = project(c2, b.lon, b.lat);
      if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > cam.w || Math.max(y1, y2) < 0 || Math.min(y1, y2) > cam.h) continue;
      if (e.type === "river") {          // 经典 from/to 河：确定性曲流（对齐旧 drawRivers：白衬底+河蓝，选中红晕）
        strokeRiver(ctx, meander(a, b, e.from + e.to).map(p => project(c2, p[0], p[1])), riverWpx(meta, cam, e), selected);
      } else if (e.type === "road") {    // 官道双线
        ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        if (selected) { ctx.strokeStyle = "rgba(192,57,43,.35)"; ctx.lineWidth = st.w + 5; ctx.stroke(); }
        ctx.strokeStyle = st.color; ctx.lineWidth = st.w * 0.85; ctx.stroke();
        ctx.strokeStyle = "#e9ddc2"; ctx.lineWidth = st.w * 0.3; ctx.stroke();
        ctx.globalAlpha = 1;
      } else {                           // 商路：紫点线
        ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        if (selected) { ctx.setLineDash([]); ctx.strokeStyle = "rgba(192,57,43,.35)"; ctx.lineWidth = st.w + 5; ctx.stroke(); }
        ctx.strokeStyle = st.color; ctx.lineWidth = st.w * 0.55; ctx.setLineDash([3, 4]); ctx.stroke(); ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }
    if (on("arrows")) drawOps(ctx, c2, world, yearNow, opts.selId, opts.opSel);
    if (on("nodes")) drawNodes(ctx, c2, world, yearNow, opts, multiSet, fcolor);   // 地点记号 + 楷体标签（避让）
    if (on("units")) drawUnits(ctx, c2, world, yearNow,   // 部队压在地点之上（战场主角）
      { trails: on("trails"), labels: on("labels"), selId: opts.unitSelId, multiIds: opts.multiUnitIds, legs: opts.unitLegs });
  }
  if (on("graticule")) drawGraticule(ctx, cam, meta);   // 经纬网：拷贝循环外，屏幕空间一次绘制
  if (on("notes")) drawPinnedNotes(ctx, cam, world, yearNow, opts, fcolor);   // 屏幕角标注（帧标题/图注块）
  drawScaleBar(ctx, cam, meta);                          // 图形比例尺（左下，随 PNG 导出）
  drawTitle(ctx, meta, yearNow);                         // 图名 + 纪年（左上，随 PNG 导出）
  ctx.restore();
}

/* —— 标注（type:"label"，v0.15 净新）：无记号，名称即图面文本 ——
   多行（\n）/字号 fs（≥16 加粗视作标题）/派系色（无派系=墨色，同地名标签）；白描边同地图文字语言。
   地图锚定的注册进避让格局（placed：地名让标注、标注本身不让位——作者摆哪是哪）；
   选中=红虚线框。align：center=锚点居中（地图标注）；left/right=屏幕角堆叠（pin）。 */
const NOTE_FS = (n: WorldNode) => Math.max(9, Math.min(28, +(n.fs as number) || 13));
function drawNoteText(
  ctx: CanvasRenderingContext2D, n: WorldNode, x: number, y: number,
  col: string, selected: boolean, placed: { x: number; y: number; w: number; h: number }[] | null,
  align: "center" | "left" | "right"
): void {
  const fs = NOTE_FS(n);
  const lines = String(n.名称 || "").split("\n");
  ctx.save();
  ctx.font = (fs >= 16 ? "bold " : "") + fs + "px KaiTi,楷体,serif";
  ctx.textBaseline = "middle";
  const lh = fs + 3;
  const w = lines.reduce((m, L) => Math.max(m, ctx.measureText(L).width), 0);
  const h = lines.length * lh;
  const x0 = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
  const y0 = align === "center" ? y - h / 2 : y;
  if (placed) placed.push({ x: x0, y: y0, w, h });
  for (let i = 0; i < lines.length; i++) {
    const lw = ctx.measureText(lines[i]).width;
    const lx = align === "center" ? x - lw / 2 : align === "right" ? x - lw : x;
    const ly = y0 + lh * i + lh / 2;
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.strokeText(lines[i], lx, ly);
    ctx.fillStyle = col; ctx.fillText(lines[i], lx, ly);
  }
  if (selected) {
    ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5; ctx.strokeStyle = "#c0392b";
    ctx.strokeRect(x0 - 4, y0 - 3, w + 8, h + 6); ctx.setLineDash([]);
  }
  ctx.restore();
}

/* 屏幕角标注（label.pin=nw/ne/sw/se：帧标题/图注块）——拷贝循环外屏幕空间一次绘制，
   同角多条按数组序堆叠（底角从下往上）；nw 让开图名、sw 让开比例尺。
   时限过滤同 nodeVisible（编辑模式亦按当刻，选中除外）；画布不可拾取，经搜索/地图锚点选中。 */
function drawPinnedNotes(
  ctx: CanvasRenderingContext2D, cam: Camera, world: World, yearNow: number,
  opts: OverlayOpts, fcolor: (id: string | null) => string
) {
  const cur: Record<string, number> = { nw: 46, ne: 16, sw: cam.h - 42, se: cam.h - 42 };
  for (const n of world.nodes) {
    if (n.type !== "label" || !n.pin || !(String(n.pin) in cur)) continue;
    const selected = n.id === opts.selId;
    if (!activeAt(n, yearNow) && !selected) continue;
    const pin = String(n.pin);
    const left = pin === "nw" || pin === "sw", bottom = pin === "sw" || pin === "se";
    const h = String(n.名称 || "").split("\n").length * (NOTE_FS(n) + 3);
    const y0 = bottom ? cur[pin] - h : cur[pin];
    const fid = ownerAt(n, yearNow);
    drawNoteText(ctx, n, left ? 14 : cam.w - 14, y0, fid ? fcolor(fid) : "#2c241b", selected, null, left ? "left" : "right");
    cur[pin] = bottom ? y0 - 8 : y0 + h + 8;
  }
}

/* —— 地点记号 + 标签（UI 1:1 还原 v0.14 shapePath/drawNodeMark/drawNodes）——
   记号形状按类型（★都城/◉主要/●○·聚落/▲要塞/═渡口/▽事件/◆资源/✦特殊），描边色=当年归属；
   楷体标签四方位避让（重要地点先占位），撞满则不画（选中除外）；
   事件点未发生=淡显、当年=红圈；编辑模式全部地点可见（旧 nodeVisible 语义）。 */
function shapePath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, shape?: string) {
  ctx.beginPath();
  switch (shape) {
    case "star": for (let i = 0; i < 10; i++) {
      const R = i % 2 ? r * 0.45 : r, a = -Math.PI / 2 + i * Math.PI / 5;
      const px = x + R * Math.cos(a), py = y + R * Math.sin(a);
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    } ctx.closePath(); break;
    case "diamond": ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.8, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r * 0.8, y); ctx.closePath(); break;
    case "tri": ctx.moveTo(x, y - r); ctx.lineTo(x - r * 0.95, y + r * 0.8); ctx.lineTo(x + r * 0.95, y + r * 0.8); ctx.closePath(); break;
    case "triDown": ctx.moveTo(x, y + r); ctx.lineTo(x - r * 0.95, y - r * 0.8); ctx.lineTo(x + r * 0.95, y - r * 0.8); ctx.closePath(); break;
    case "penta": for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + i * 2 * Math.PI / 5;
      const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    } ctx.closePath(); break;
    case "spark": ctx.moveTo(x, y - r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.quadraticCurveTo(x, y, x, y + r);
      ctx.quadraticCurveTo(x, y, x - r, y); ctx.quadraticCurveTo(x, y, x, y - r); ctx.closePath(); break;
    case "rect": ctx.rect(x - r, y - r * 0.45, r * 2, r * 0.9); break;
    default: ctx.arc(x, y, r, 0, 7);
  }
}
function drawNodeMark(ctx: CanvasRenderingContext2D, n: WorldNode, x: number, y: number, col: string) {
  const s = NODE_STYLE[n.type] || NODE_STYLE.city;
  shapePath(ctx, x, y, s.r, s.shape); ctx.fillStyle = "#fff"; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.stroke();
  if (s.shape === "dot" || !s.shape) {
    ctx.beginPath(); ctx.arc(x, y, Math.max(1.5, s.r - 3), 0, 7); ctx.fillStyle = col; ctx.fill();
  } else if (s.shape === "ring") {
    ctx.beginPath(); ctx.arc(x, y, Math.max(1.2, s.r - 3.2), 0, 7); ctx.fillStyle = col; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, s.r + 2.2, 0, 7); ctx.lineWidth = 1; ctx.strokeStyle = col; ctx.stroke();
  } else {
    ctx.save(); ctx.globalAlpha = 0.3; shapePath(ctx, x, y, s.r, s.shape); ctx.fillStyle = col; ctx.fill(); ctx.restore();
    ctx.beginPath(); ctx.arc(x, y, 1.7, 0, 7); ctx.fillStyle = col; ctx.fill();
  }
}
function drawNodes(
  ctx: CanvasRenderingContext2D, cam: Camera, world: World, yearNow: number,
  opts: OverlayOpts, multiSet: Set<string>, fcolor: (id: string | null) => string
) {
  const on = (id: string) => (opts.layers || {})[id] !== false;
  const nodeVisible = (n: WorldNode) => {
    if (!activeAt(n, yearNow)) return false;
    if (n.type === "event" && !on("events")) return false;
    if (n.type === "label" && !on("notes")) return false;
    if (opts.editing) return true;                       // 编辑也按当年世界编辑，但全部地点可见
    const s = NODE_STYLE[n.type] || NODE_STYLE.city;
    return cam.degPerPx <= RANK_ZOOM[s.rank == null ? 2 : s.rank];
  };
  // 重要地点先画：标签避让时高等级优先占位
  const order = world.nodes.slice().sort((a, b) => {
    const ra = (NODE_STYLE[a.type] || NODE_STYLE.city).rank || 0, rb = (NODE_STYLE[b.type] || NODE_STYLE.city).rank || 0;
    return ra - rb;
  });
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const collide = (r: { x: number; y: number; w: number; h: number }) =>
    placed.some(q => !(r.x + r.w + 2 < q.x || q.x + q.w + 2 < r.x || r.y + r.h + 1 < q.y || q.y + q.h + 1 < r.y));
  for (const n of order) {
    const selected = n.id === opts.selId || multiSet.has(n.id);
    if (!nodeVisible(n) && !selected) continue;
    if (n.type === "label") {                            // 标注：无记号，文本即本体（rank 0 先画=先占避让格局）
      if (n.pin) continue;                               // 屏幕角标注在拷贝循环外画（drawPinnedNotes）
      const [lx, ly] = project(cam, n.lon, n.lat);
      const lf = ownerAt(n, yearNow);
      drawNoteText(ctx, n, lx, ly, lf ? fcolor(lf) : "#2c241b", selected, placed, "center");
      continue;
    }
    const [x, y] = project(cam, n.lon, n.lat);
    const s = NODE_STYLE[n.type] || NODE_STYLE.city;
    const isEv = n.type === "event";
    if (isEv && n.year != null && n.year > yearNow) ctx.globalAlpha = 0.35;   // 未发生的事件淡显
    const fid = ownerAt(n, yearNow);
    const col = fid ? fcolor(fid) : (isEv ? "#b0202a" : "#555");
    drawNodeMark(ctx, n, x, y, col);
    if (isEv && n.year === yearNow) { ctx.beginPath(); ctx.arc(x, y, s.r + 4, 0, 7); ctx.lineWidth = 2; ctx.strokeStyle = "#b0202a"; ctx.stroke(); }
    if (selected) { ctx.beginPath(); ctx.arc(x, y, s.r + 5, 0, 7); ctx.lineWidth = 2.5; ctx.strokeStyle = "#c0392b"; ctx.stroke(); }
    if (on("labels")) {
      ctx.font = (n.type === "capital" ? "bold 14px" : "13px") + " KaiTi,楷体,serif"; ctx.textBaseline = "middle";
      const lbl = (n.type === "port" ? "⚓" : "") + (n.名称 || "");
      const w = ctx.measureText(lbl).width, h = 15;
      // 候选位：右、左、下、上；全撞则（选中除外）不画标签
      const cands = [
        { x: x + s.r + 4, y },
        { x: x - s.r - 4 - w, y },
        { x: x - w / 2, y: y + s.r + 10 },
        { x: x - w / 2, y: y - s.r - 10 }
      ];
      let pos: { x: number; y: number } | null = null;
      for (const c of cands) {
        const r = { x: c.x, y: c.y - h / 2, w, h };
        if (!collide(r)) { pos = c; placed.push(r); break; }
      }
      if (!pos && selected) pos = cands[0];
      if (pos && lbl) {
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.strokeText(lbl, pos.x, pos.y);
        ctx.fillStyle = "#2c241b"; ctx.fillText(lbl, pos.x, pos.y);
      }
      ctx.textBaseline = "alphabetic";
    }
    ctx.globalAlpha = 1;
  }
}

/* 地点范围（radiusKm 虚线圈，对齐旧 drawNodeRanges）：按真实地理尺度画椭圆、随当年归属换色；
   视距太远（<3px）不画、放大自现；选中的地点即便当年不在场/降级隐藏也画（加深显示）。 */
function drawNodeRanges(
  ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined,
  world: World, yearNow: number, selId?: string | null
) {
  const kpd = kmPerDegLat(meta);
  const flat = (meta || {}).worldModel === "flat";
  for (const n of world.nodes) {
    if (!(typeof n.radiusKm === "number" && n.radiusKm > 0)) continue;
    const selected = n.id === selId;
    const st = NODE_STYLE[n.type] || NODE_STYLE.city;
    const visible = activeAt(n, yearNow) && cam.degPerPx <= (RANK_ZOOM[st.rank] ?? Infinity);
    if (!visible && !selected) continue;
    const dLat = n.radiusKm / kpd;
    const cosn = flat ? 1 : Math.max(0.05, Math.cos(toRad(n.lat)));
    const [cx, cy] = project(cam, n.lon, n.lat);
    const rx = Math.abs(project(cam, n.lon + dLat / cosn, n.lat)[0] - cx);
    const ry = Math.abs(cy - project(cam, n.lon, n.lat + dLat)[1]);
    if (rx < 3 && ry < 3) continue;
    const f = ownerAt(n, yearNow) ? world.factions.find(x => x.id === ownerAt(n, yearNow)) : null;
    const col = (f && f.color) || "#667788";
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, 7);
    ctx.fillStyle = hexA(col, selected ? 0.14 : 0.08); ctx.fill();
    ctx.lineWidth = selected ? 2 : 1.4; ctx.strokeStyle = hexA(col, selected ? 0.75 : 0.45);
    ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
  }
}

/* 图形比例尺（对齐旧 drawScaleBar：制图规范 1-2-5 档，细分到 m；宣纸底衬） */
function drawScaleBar(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined) {
  const H = cam.h;
  const a = unproject(cam, 12, H - 16), b = unproject(cam, 112, H - 16);
  const kmPerPx = distKm(meta, a[0], a[1], b[0], b[1]) / 100;
  if (!isFinite(kmPerPx) || kmPerPx <= 0) return;
  let nice = 0.001;
  const target = kmPerPx * 110;
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

/** 拾取（线性扫描——数百要素足够；空间索引 后段定案）。x/y 为 CSS 像素 */
/** 点到线段距离（拾取共用） */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 连线拾取：距任一线段 < 6px（按拷贝重投影；河流曲流按端点弦近似）。返回下标供选中模型引用 */
export function pickEdge(
  cam: Camera, meta: Meta | undefined, world: World, yearNow: number,
  x: number, y: number, layers?: Record<string, boolean>
): { edge: Edge; idx: number } | null {
  const byId = new Map(world.nodes.map(n => [n.id, n]));
  let best: { edge: Edge; idx: number } | null = null, bd = 6;
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    world.edges.forEach((e, idx) => {
      if (layers && layers[e.type] === false) return;   // 图层关了不拾取
      if (!activeAt(e, yearNow)) return;
      if (e.type === "river" && Array.isArray(e.pts) && e.pts.length >= 2) {   // 自由画河：逐段到自身折线拾取（同 pickOp）
        const pp = projectSeq(c2, chaikinOpen(e.pts, 2));
        for (let k = 1; k < pp.length; k++) {
          const d = segDist(x, y, pp[k - 1][0], pp[k - 1][1], pp[k][0], pp[k][1]);
          if (d < bd) { bd = d; best = { edge: e, idx }; }
        }
        return;
      }
      if (!e.from || !e.to) return;
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) return;
      const sp = projectSeq(c2, [{ lon: a.lon, lat: a.lat }, { lon: b.lon, lat: b.lat }]);
      const d = segDist(x, y, sp[0][0], sp[0][1], sp[1][0], sp[1][1]);
      if (d < bd) { bd = d; best = { edge: e, idx }; }
    });
  }
  return best;
}

/** 作战线拾取（可见规则与 drawOps 一致：事件当年或事件被选中）；命中容差随线宽。
    对齐旧 pickOpD——arrows 图层关闭则不拾取。返回 {evId,i}。 */
export function pickOp(
  cam: Camera, meta: Meta | undefined, world: World, yearNow: number,
  x: number, y: number, layers?: Record<string, boolean>, selId?: string | null
): { evId: string; i: number } | null {
  if (layers && layers.arrows === false) return null;
  let best: { evId: string; i: number } | null = null, bd = Infinity;
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    for (const ev of world.nodes) {
      if (ev.type !== "event" || !ev.ops) continue;
      ev.ops.forEach((op, i) => {
        if (!opVisibleAt(ev, op, yearNow) && ev.id !== selId) return;   // 与 drawOps 同规则（分相位）
        const pp = projectSeq(c2, op.pts);
        const tol = Math.max(7, (op.w || 3) / 2 + 5);
        for (let k = 1; k < pp.length; k++) {
          const d = segDist(x, y, pp[k - 1][0], pp[k - 1][1], pp[k][0], pp[k][1]);
          if (d < tol && d < bd) { bd = d; best = { evId: ev.id, i }; }
        }
      });
    }
  }
  return best;
}

export function pickNode(
  cam: Camera, meta: Meta | undefined, world: World, yearNow: number,
  x: number, y: number, rad = 12
): WorldNode | null {
  let best: WorldNode | null = null, bd = rad * rad;
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    for (const n of world.nodes) {
      if (!activeAt(n, yearNow)) continue;
      const [px, py] = project(c2, n.lon, n.lat);
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
  }
  return best;
}

/** 框选：返回投影后落在屏幕矩形内的地点 id（当年可见者；按世界拷贝重投影，去重） */
export function nodesInBox(
  cam: Camera, meta: Meta | undefined, world: World, yearNow: number,
  x0: number, y0: number, x1: number, y1: number
): string[] {
  const xs = Math.min(x0, x1), xe = Math.max(x0, x1), ys = Math.min(y0, y1), ye = Math.max(y0, y1);
  const ids = new Set<string>();
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    for (const n of world.nodes) {
      if (!activeAt(n, yearNow)) continue;
      const [px, py] = project(c2, n.lon, n.lat);
      if (px >= xs && px <= xe && py >= ys && py <= ye) ids.add(n.id);
    }
  }
  return [...ids];
}
