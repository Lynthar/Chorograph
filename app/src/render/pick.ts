/* 拾取（自 overlay.ts 原样拆出，行为不变）：线性扫描——数百要素足够；空间索引 后段定案。
   x/y 为 CSS 像素。⚠ 可见规则与绘制同源：地点走 nodes.nodeVisibleAt、作战线与 drawOps 同规。 */
import { activeAt, opVisibleAt } from "../core/time.ts";
import { project, projectSeq, visibleWorldCopies, type Camera } from "../core/projection.ts";
import { chaikinOpen } from "../core/geometry.ts";
import { nodeVisibleAt, type NodeGateOpts } from "./nodes.ts";
import type { Edge, Meta, World, WorldNode } from "../core/types.ts";

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

/** 地点拾取：只拾画面上真的画着的（与 drawNodes 同一可见门，opts 传当前图层与编辑态）；
    pin 屏幕角标注按锚点隐形、一律不可点选（经搜索/撤销管理，见 drawPinnedNotes）。 */
export function pickNode(
  cam: Camera, meta: Meta | undefined, world: World, yearNow: number,
  x: number, y: number, opts: NodeGateOpts & { rad?: number } = {}
): WorldNode | null {
  const rad = opts.rad ?? 12;
  let best: WorldNode | null = null, bd = rad * rad;
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    for (const n of world.nodes) {
      if (n.type === "label" && n.pin) continue;
      if (!nodeVisibleAt(n, cam, yearNow, opts)) continue;
      const [px, py] = project(c2, n.lon, n.lat);
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
  }
  return best;
}

/** 框选：返回投影后落在屏幕矩形内的地点 id（可见门同 pickNode——隐形对象不被框进批量删；
    按世界拷贝重投影，去重） */
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
      if (!nodeVisibleAt(n, cam, yearNow, opts)) continue;
      const [px, py] = project(c2, n.lon, n.lat);
      if (px >= xs && px <= xe && py >= ys && py <= ye) ids.add(n.id);
    }
  }
  return [...ids];
}
