/* 拾取（自 overlay.ts 原样拆出，行为不变）：线性扫描——数百要素足够；空间索引 后段定案。
   x/y 为 CSS 像素。⚠ 可见规则与绘制同源：地点走 nodes.nodeVisibleAt、作战线与 drawOps 同规；
   标注的**文本体判中**同源于 nodes.noteBox/noteHit（drawNoteText 画的就是那个框）。 */
import { activeAt, opVisibleAt } from "../core/time.ts";
import { project, projectSeq, visibleWorldCopies, type Camera } from "../core/projection.ts";
import { chaikinOpen } from "../core/geometry.ts";
import { EDGE_STYLE } from "../core/constants.ts";
import { tget } from "../core/util.ts";
import { nodeVisibleAt, noteHit, noteMeasure, type NodeGateOpts, type NoteMeasure } from "./nodes.ts";
import { riverWpx } from "./edges.ts";
import type { Edge, Meta, World, WorldNode } from "../core/types.ts";

/** 点到线段距离（拾取共用） */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 连线拾取：道路/商路距线段 < 6px；河流走廊随渲染河宽（半宽+4px，下限 6——宽河点在河面即可选中，
    与 riverWpx 绘制同源，同 pickOp 容差随线宽之例）。多条命中取距中轴最近者。
    按拷贝重投影；河流曲流按端点弦近似。返回下标供选中模型引用 */
export function pickEdge(
  cam: Camera, meta: Meta | undefined, world: World, yearNow: number,
  x: number, y: number, layers?: Record<string, boolean>
): { edge: Edge; idx: number } | null {
  // 首个命中优先（同 render/overlay 与 core/grid.roadCellSet）：重复 id 的档上拾取与绘制须指同一对象
  const byId = new Map<string, WorldNode>();
  for (const n of world.nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  let best: { edge: Edge; idx: number } | null = null, bd = Infinity;
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    world.edges.forEach((e, idx) => {
      /* 未知线型（手编档/他人分享档的自由字符串）drawEdges 一律不画，这里必须同门——否则
         图上什么都没有却悬停得中、点得中，破「拾取绘制同源」；那条隐形命中曾把未转义的
         type 原文送进 #tip 的 innerHTML。要改这条数据得走搜索框选中→检查器，不从画布走。 */
      if (!tget(EDGE_STYLE, e.type)) return;
      if (layers && layers[e.type] === false) return;   // 图层关了不拾取
      if (!activeAt(e, yearNow)) return;
      const tol = e.type === "river" ? Math.max(6, riverWpx(meta, cam, e) / 2 + 4) : 6;
      if ((e.type === "river" || e.type === "wall") && Array.isArray(e.pts) && e.pts.length >= 2) {   // 自由折线（河/工事）：逐段到自身折线拾取（同 pickOp）；河按渲染柔化后折线、工事原样——与绘制同源
        const pp = projectSeq(c2, e.type === "river" ? chaikinOpen(e.pts, 2) : e.pts);
        for (let k = 1; k < pp.length; k++) {
          const d = segDist(x, y, pp[k - 1][0], pp[k - 1][1], pp[k][0], pp[k][1]);
          if (d < tol && d < bd) { bd = d; best = { edge: e, idx }; }
        }
        return;
      }
      if (!e.from || !e.to) return;
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) return;
      const sp = projectSeq(c2, [{ lon: a.lon, lat: a.lat }, { lon: b.lon, lat: b.lat }]);
      const d = segDist(x, y, sp[0][0], sp[0][1], sp[1][0], sp[1][1]);
      if (d < tol && d < bd) { bd = d; best = { edge: e, idx }; }
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

/** 地点拾取：只拾画面上真的画着的（与 drawNodes 同一可见门，opts 传当前图层与编辑态）；
    pin 屏幕角标注按锚点隐形、一律不可点选（经搜索/撤销管理，见 drawPinnedNotes）。
    两趟：先按锚点半径（旧行为逐位保留），全空再判标注的文本体——标注无记号、文本即本体，
    只判锚点等于「一行大字只有正中 12px 可点」。measure 缺省取 nodes.noteMeasure()（离屏度量），
    node:test 无 document 时为 null＝退回纯锚点判定，测试可注入假度量。 */
export function pickNode(
  cam: Camera, meta: Meta | undefined, world: World, yearNow: number,
  x: number, y: number, opts: NodeGateOpts & { rad?: number; measure?: NoteMeasure | null } = {}
): WorldNode | null {
  const rad = opts.rad ?? 12;
  let best: WorldNode | null = null, bd = rad * rad;
  const notes: [WorldNode, number, number][] = [];   // 锚点全空时再判文本体（按拷贝各记一份投影位）
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    for (const n of world.nodes) {
      if (n.type === "label" && n.pin) continue;
      if (!nodeVisibleAt(n, cam, meta, yearNow, opts)) continue;
      const [px, py] = project(c2, n.lon, n.lat);
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bd) { bd = d; best = n; }
      if (n.type === "label") notes.push([n, px, py]);
    }
  }
  if (best) return best;   // 记号画在标注之上：压着记号的大标注不该抢走记号的点击
  if (!notes.length) return null;   // 无标注的世界不必建离屏度量画布，也不必走第二趟
  const m = opts.measure === undefined ? noteMeasure() : opts.measure;
  if (!m) return null;
  let note: WorldNode | null = null, nd = Infinity;
  for (const [n, px, py] of notes) {
    if (!noteHit(m, n, px, py, x, y)) continue;   // 判据在 nodes.noteHit＝画的那一处旁边（逐行判中）
    const d = (px - x) ** 2 + (py - y) ** 2;      // 并列（两块文本重叠）取锚点近者，同 pickDecor
    if (d < nd) { nd = d; note = n; }
  }
  return note;
}

/** 框选：返回投影后落在屏幕矩形内的地点 id（可见门同 pickNode——隐形对象不被框进批量删；
    按世界拷贝重投影，去重）。⚠ 一律**按锚点**判定（含标注——它的锚点在文本正中，圈住整块文字
    自然圈住锚点），与 decorsInBox/unitsInBox 同规；点选那边的文本体判定是「点不中」的补救，
    框选不需要，混进来反而让半盖住一块标注的框把它捞进批量删。 */
export function nodesInBox(
  cam: Camera, meta: Meta | undefined, world: World, yearNow: number,
  x0: number, y0: number, x1: number, y1: number, opts: NodeGateOpts = {}
): string[] {
  const xs = Math.min(x0, x1), xe = Math.max(x0, x1), ys = Math.min(y0, y1), ye = Math.max(y0, y1);
  const ids = new Set<string>();
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    for (const n of world.nodes) {
      if (n.type === "label" && n.pin) continue;
      if (!nodeVisibleAt(n, cam, meta, yearNow, opts)) continue;
      const [px, py] = project(c2, n.lon, n.lat);
      if (px >= xs && px <= xe && py >= ys && py <= ye) ids.add(n.id);
    }
  }
  return [...ids];
}
