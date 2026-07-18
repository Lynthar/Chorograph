/* 地点记号 + 地名标签 + 标注（自 overlay.ts 原样拆出，行为不变）：
   记号形状按类型（★都城/◉主要/●○·聚落/▲要塞/═渡口/▽事件/◆资源/✦特殊），描边色=当年归属；
   楷体标签四方位避让（重要地点先占位），撞满则不画（选中除外）；
   事件点未发生=淡显、当年=红圈；编辑模式全部地点可见（旧 nodeVisible 语义）。
   ⚠ nodeVisibleAt 是绘制与拾取（render/pick.ts）同源的可见门——改门先想两边。 */
import { NODE_STYLE, RANK_ZOOM } from "../core/constants.ts";
import { activeAt, ownerAt } from "../core/time.ts";
import { project, type Camera } from "../core/projection.ts";
import { kmPerDegLat, toRad } from "../core/geo.ts";
import { hexA } from "../core/util.ts";
import type { LabelField } from "./labels.ts";
import type { Meta, World, WorldNode } from "../core/types.ts";
import type { OverlayOpts } from "./overlay.ts";

/* —— 标注（type:"label"，v0.15 净新）：无记号，名称即图面文本 ——
   多行（\n）/字号 fs（≥16 加粗视作标题）/派系色（无派系=墨色，同地名标签）；白描边同地图文字语言。
   地图锚定的注册进避让格局（placed：地名让标注、标注本身不让位——作者摆哪是哪）；
   选中=红虚线框。align：center=锚点居中（地图标注）；left/right=屏幕角堆叠（pin）。 */
const NOTE_FS = (n: WorldNode) => Math.max(9, Math.min(28, +(n.fs as number) || 13));
export function drawNoteText(
  ctx: CanvasRenderingContext2D, n: WorldNode, x: number, y: number,
  col: string, selected: boolean, field: LabelField | null,
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
  if (field) field.claim({ x: x0, y: y0, w, h });   // 标注不让位（作者摆哪是哪），只登记让后来者绕开
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
export function drawPinnedNotes(
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
/** 地点可见门（绘制与拾取同源，防"隐形可选"）：时限 → nodes 总门与 events/notes 类型子门 →
    编辑全见 → rank 缩放门。pin 屏幕角标注不在此处理：绘制走 drawPinnedNotes、拾取一律排除。 */
export interface NodeGateOpts { layers?: Record<string, boolean>; editing?: boolean }
export function nodeVisibleAt(n: WorldNode, cam: Camera, yearNow: number, opts: NodeGateOpts): boolean {
  const L = opts.layers || {};
  if (!activeAt(n, yearNow)) return false;
  if (L.nodes === false) return false;
  if (n.type === "event" && L.events === false) return false;
  if (n.type === "label" && L.notes === false) return false;
  if (opts.editing) return true;                       // 编辑也按当年世界编辑，但全部地点可见
  const s = NODE_STYLE[n.type] || NODE_STYLE.city;
  return cam.degPerPx <= RANK_ZOOM[s.rank == null ? 2 : s.rank];
}
export function drawNodes(
  ctx: CanvasRenderingContext2D, cam: Camera, world: World, yearNow: number,
  opts: OverlayOpts, multiSet: Set<string>, fcolor: (id: string | null) => string,
  field: LabelField
) {
  const on = (id: string) => (opts.layers || {})[id] !== false;
  const nodeVisible = (n: WorldNode) => nodeVisibleAt(n, cam, yearNow, opts);
  /* 占位次序＝让位次序：标注最先（不让位）→ 当日事件（战场焦点，2026-07 提级）→ 地名按 rank；
     部队标签在 drawUnits（同场、更后）——部队让地名（用户拍板：地点语义上固定不动，标签该稳）。 */
  const keyOf = (n: WorldNode): number => n.type === "label" ? -2
    : (n.type === "event" && n.year === yearNow ? -1 : ((NODE_STYLE[n.type] || NODE_STYLE.city).rank || 0));
  const order = world.nodes.slice().sort((a, b) => keyOf(a) - keyOf(b));
  for (const n of order) {
    const selected = n.id === opts.selId || multiSet.has(n.id);
    if (!nodeVisible(n) && !selected) continue;
    if (n.type === "label") {                            // 标注：无记号，文本即本体（最先画=先占避让格局）
      if (n.pin) continue;                               // 屏幕角标注在拷贝循环外画（drawPinnedNotes）
      const [lx, ly] = project(cam, n.lon, n.lat);
      const lf = ownerAt(n, yearNow);
      drawNoteText(ctx, n, lx, ly, lf ? fcolor(lf) : "#2c241b", selected, field, "center");
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
        if (field.tryPlace({ x: c.x, y: c.y - h / 2, w, h })) { pos = c; break; }
      }
      if (!pos && selected) { pos = cands[0]; field.claim({ x: pos.x, y: pos.y - h / 2, w, h }); }   // 选中恒显＋登记（后来者绕开）
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
export function drawNodeRanges(
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
