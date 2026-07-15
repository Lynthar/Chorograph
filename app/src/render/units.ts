/* 兵棋部队渲染（v0.14 战术图部队层）：单位框+兵种符号、行军尾迹（已走实线/计划虚线/
   日刻度点/超速红⚠）、火力射程圈、拾取。纯视觉走截图目检（同 decor/ops）。
   日戳 T 即 yearNow（战术图时间轴存的是 T）。各绘制函数按【单相机】工作——由 overlay 的
   世界拷贝循环逐拷贝调用（同 drawEco/drawDecor）；pickUnit 独立，自带拷贝循环（同 pickNode）。 */
import { project, projectSeq, visibleWorldCopies, type Camera } from "../core/projection.ts";
import { kmPerDegLat, toRad } from "../core/geo.ts";
import { unitFireKm, unitKind, unitPos, unitStatusAt, type Leg } from "../core/units.ts";
import { UNIT_STATUS } from "../core/constants.ts";
import { activeAt, ownerAt } from "../core/time.ts";
import { hexA } from "../core/util.ts";
import type { Meta, Unit, World } from "../core/types.ts";

/** 单位框色=所属派系色（缺省暗红） */
function boxColor(world: World, u: Unit): string {
  const f = u.faction ? world.factions.find(x => x.id === u.faction) : null;
  return (f && f.color) || "#a03030";
}

/** 状态徽章（框右上角）：交战=交叉双剑 / 对峙=对峙双杠 / 溃退=折线溃箭——手绘线条（不走 emoji 字形，跨平台一致） */
function drawStatusBadge(ctx: CanvasRenderingContext2D, bx: number, by: number, st: string, color: string): void {
  ctx.save();
  ctx.beginPath(); ctx.arc(bx, by, 6.5, 0, 7);
  ctx.fillStyle = "rgba(251,247,234,.94)"; ctx.fill();
  ctx.lineWidth = 1.3; ctx.strokeStyle = color; ctx.stroke();
  ctx.lineWidth = 1.6; ctx.lineCap = "round";
  ctx.beginPath();
  if (st === "battle") {          // 交叉双剑
    ctx.moveTo(bx - 3.2, by - 3.2); ctx.lineTo(bx + 3.2, by + 3.2);
    ctx.moveTo(bx + 3.2, by - 3.2); ctx.lineTo(bx - 3.2, by + 3.2);
  } else if (st === "standoff") { // 对峙双杠
    ctx.moveTo(bx - 1.9, by - 3.4); ctx.lineTo(bx - 1.9, by + 3.4);
    ctx.moveTo(bx + 1.9, by - 3.4); ctx.lineTo(bx + 1.9, by + 3.4);
  } else if (st === "rout") {     // 折线溃箭（向下）
    ctx.moveTo(bx - 2.6, by - 3.4); ctx.lineTo(bx + 1.4, by - 0.8);
    ctx.lineTo(bx - 1.4, by + 0.6); ctx.lineTo(bx + 2.6, by + 3.4);
    ctx.moveTo(bx + 2.6, by + 3.4); ctx.lineTo(bx + 0.4, by + 3.0);
    ctx.moveTo(bx + 2.6, by + 3.4); ctx.lineTo(bx + 2.2, by + 1.2);
  }
  ctx.stroke();
  ctx.restore();
}

/** 兵棋标准框：矩形单位框 + 兵种符号（可整体换肤为古典写意旗帜）。
    st=状态：交战=红色外框光晕+徽章、对峙=琥珀徽章、溃退=虚线框+徽章（缺省行军无饰） */
function drawUnitSymbol(ctx: CanvasRenderingContext2D, x: number, y: number, world: World, u: Unit, selMe: boolean, st?: string | null): void {
  const W = 26, H = 17, col = boxColor(world, u);
  const sd = st ? UNIT_STATUS[st] : null;
  ctx.save();
  if (selMe) { ctx.shadowColor = "#d4b24a"; ctx.shadowBlur = 10; }
  ctx.fillStyle = "rgba(24,26,30,.78)";
  ctx.strokeStyle = col; ctx.lineWidth = 2;
  if (st === "rout") ctx.setLineDash([4, 3]);   // 溃退=虚线框（建制涣散）
  ctx.fillRect(x - W / 2, y - H / 2, W, H); ctx.strokeRect(x - W / 2, y - H / 2, W, H);
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;
  if (st === "battle" && sd) {                  // 交战=红色外框光晕（远景一眼可辨）
    ctx.strokeStyle = hexA(sd.color, .85); ctx.lineWidth = 1.3;
    ctx.strokeRect(x - W / 2 - 2.5, y - H / 2 - 2.5, W + 5, H + 5);
  }
  const k = unitKind(u);
  ctx.fillStyle = "#f2ede2"; ctx.font = "bold 11px system-ui,sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(k ? k.glyph : String(u.kind || "?").slice(0, 1), x, y + 0.5);
  if (sd) drawStatusBadge(ctx, x + W / 2 - 1, y - H / 2 - 1, st!, sd.color);
  ctx.restore();
}

/** 折线（投影后按拷贝重投影）：透明度/线宽/虚线可配 */
function strokeSeq(ctx: CanvasRenderingContext2D, cam: Camera, pts: { lon: number; lat: number }[],
  color: string, w: number, alpha: number, dash?: number[]): void {
  const pp = projectSeq(cam, pts); if (pp.length < 2) return;
  ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = w;
  ctx.setLineDash(dash || []); ctx.lineJoin = "round";
  ctx.beginPath(); pp.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke();
  ctx.restore();
}

/** 行军尾迹：已走过=实线+日刻度点；未来计划=虚线淡显；超行程的腿标红+⚠（legs 为外部预算缓存，不在帧内算路） */
function drawTrail(ctx: CanvasRenderingContext2D, cam: Camera, world: World, u: Unit, T: number,
  p: { lon: number; lat: number }, legs: Leg[] | undefined): void {
  const tr = u.track || []; if (tr.length < 2) return;
  const col = boxColor(world, u);
  const past = tr.filter(q => q.t <= T).map(q => ({ lon: q.lon, lat: q.lat }));
  past.push({ lon: p.lon, lat: p.lat });
  if (past.length > 1) strokeSeq(ctx, cam, past, col, 2, .75);
  const fut = [{ lon: p.lon, lat: p.lat }, ...tr.filter(q => q.t > T).map(q => ({ lon: q.lon, lat: q.lat }))];
  if (fut.length > 1) strokeSeq(ctx, cam, fut, col, 1.6, .38, [5, 4]);
  tr.forEach(q => {
    if (q.t > T) return;
    const [x, y] = project(cam, q.lon, q.lat);
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fillStyle = hexA(col, .85); ctx.fill(); ctx.restore();
  });
  if (legs) legs.forEach(L => {
    if (L.ok) return;
    const a = project(cam, L.a.lon, L.a.lat), b = project(cam, L.b.lon, L.b.lat);
    ctx.save(); ctx.strokeStyle = "#c0392b"; ctx.lineWidth = 3; ctx.setLineDash([3, 3]); ctx.globalAlpha = .9;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.font = "bold 12px system-ui,sans-serif"; ctx.fillStyle = "#c0392b"; ctx.textAlign = "center";
    ctx.fillText("⚠", (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 4);
    ctx.restore();
  });
}

export interface UnitDrawOpts {
  trails?: boolean;                 // 行军尾迹层
  labels?: boolean;                 // 地名标签层（部队名·兵力）
  selId?: string | null;           // 选中部队 id（泥金光晕框）
  legs?: Map<string, Leg[]>;        // 可达性预算（外壳缓存；缺省=不标超速）
}

/** 画所有在场部队（单相机；overlay 拷贝循环内调用）。部队压在地点之上——战场主角 */
export function drawUnits(ctx: CanvasRenderingContext2D, cam: Camera, world: World, T: number, opts: UnitDrawOpts = {}): void {
  const units = world.units || [];
  if (!units.length) return;
  for (const u of units) {
    const p = unitPos(u, T); if (!p) continue;
    const [x, y] = project(cam, p.lon, p.lat);
    if (opts.trails) drawTrail(ctx, cam, world, u, T, p, opts.legs && opts.legs.get(u.id));
    drawUnitSymbol(ctx, x, y, world, u, opts.selId === u.id, unitStatusAt(u, T));
    if (opts.labels) {
      const lbl = (u.名称 || "部队") + (u.strength ? ` ${u.strength}` : "");
      ctx.save(); ctx.font = "10.5px KaiTi,楷体,serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.strokeText(lbl, x, y + 16);
      ctx.fillStyle = "#2c241b"; ctx.fillText(lbl, x, y + 16); ctx.restore();
    }
  }
}


/** 某圈在屏幕上的中心与半轴（km→像素，纬向/经向各自换算——与旧 drawRanges 逐式一致） */
function ringPx(cam: Camera, meta: Meta | undefined, lon: number, lat: number, km: number): [number, number, number, number] {
  const flat = (meta || {}).worldModel === "flat";
  const dLat = 1 / kmPerDegLat(meta);            // 1km 对应的纬度跨度
  const cosn = flat ? 1 : Math.max(0.05, Math.cos(toRad(lat)));
  const [cx, cy] = project(cam, lon, lat);
  const rx = Math.abs(project(cam, lon + km * dLat / cosn, lat)[0] - cx);
  const ry = Math.abs(cy - project(cam, lon, lat + km * dLat)[1]);
  return [cx, cy, rx, ry];
}

/** 圈半径拖动手柄（编辑态·选中对象）：火力圈=右侧小方块、视野圈=左侧 */
function drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number, col: string): void {
  ctx.save();
  ctx.fillStyle = "#fbf7ea"; ctx.strokeStyle = col; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.rect(x - 3.5, y - 3.5, 7, 7); ctx.fill(); ctx.stroke();
  ctx.restore();
}

export interface RangesOpts {
  fire?: boolean;                  // 火力射程圈（ranges 层；缺省开——兼容旧调用）
  vision?: boolean;                // 视野圈（vision 层）
  handleUnit?: string | null;      // 编辑态选中部队 id → 其圈上画拖动手柄
  handleNode?: string | null;      // 编辑态选中地点 id → 其火力圈画手柄
}

/** 火力/视野圈＝派系色半透明**实心圆**（视野浅而透、火力深；描边细线区分：火力实线/视野点线）。
    部队按当日位置——火力=单值 range（旧多圈回退首条）、视野=vision，两者同机制；据点=nodes[].ranges 多圈照旧。
    编辑态选中对象的圈带拖动手柄（火力=圈右、视野=圈左），配合外壳 pickRangeHandle 拖动调半径。 */
export function drawRanges(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined, world: World, T: number, opts: RangesOpts = {}): void {
  const fire = opts.fire !== false, vision = !!opts.vision;
  const fillRing = (lon: number, lat: number, km: number, col: string, kind: "fire" | "vision", label: string, handle: boolean): void => {
    const [cx, cy, rx, ry] = ringPx(cam, meta, lon, lat, km);
    if (rx < 3 && ry < 3) return;
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, 7);
    ctx.fillStyle = hexA(col, kind === "fire" ? .18 : .07); ctx.fill();   // 实心半透明：火力深、视野浅
    if (kind === "fire") { ctx.lineWidth = 1.4; ctx.strokeStyle = hexA(col, .6); }
    else { ctx.lineWidth = 1.1; ctx.strokeStyle = hexA(col, .4); ctx.setLineDash([2, 3.5]); }
    ctx.stroke(); ctx.setLineDash([]);
    ctx.font = "10px system-ui,sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = hexA(col, kind === "fire" ? .85 : .7);
    if (kind === "fire") ctx.fillText(label, cx, cy - ry - 3);            // 火力标签在圈上、视野在圈下（相邻不打架）
    else ctx.fillText(label, cx, cy + ry + 11);
    if (handle) drawHandle(ctx, kind === "fire" ? cx + rx : cx - rx, cy, col);
    ctx.restore();
  };
  (world.units || []).forEach(u => {
    const fk = unitFireKm(u), vk = +(u.vision as number) || 0;
    if (!((fire && fk > 0) || (vision && vk > 0))) return;
    const p = unitPos(u, T); if (!p) return;
    const col = boxColor(world, u), withHandle = u.id === opts.handleUnit;
    if (fire && fk > 0) fillRing(p.lon, p.lat, fk, col, "fire", `火力 ${fk}km`, withHandle);
    if (vision && vk > 0) fillRing(p.lon, p.lat, vk, col, "vision", `视野 ${vk}km`, withHandle);
  });
  if (fire) world.nodes.forEach(n => {
    if (!(n.ranges || []).length || !activeAt(n, T)) return;
    const fid = ownerAt(n, T);
    const f = fid ? world.factions.find(x => x.id === fid) : null;
    const col = (f && f.color) || "#8a6a2a", withHandle = n.id === opts.handleNode;
    n.ranges!.forEach(r => {
      const km = +r.km || 0; if (!(km > 0)) return;
      fillRing(n.lon, n.lat, km, col, "fire", `${r.名称 || "射程"} ${km}km`, withHandle);
    });
  });
}

export interface RingHit { owner: "unit" | "node"; id: string; ring: "vision" | "range" | number; lon: number; lat: number }

/** 拾取圈半径手柄（编辑态·仅选中对象）：火力圈手柄在圈右、视野圈在圈左；命中返回圈心数据坐标。
    部队火力=单值 "range"（含旧多圈回退）、视野="vision"；据点防御圈=下标。
    x/y=CSS 像素，自带世界拷贝循环（同 pickUnit）；fire/vision 对应图层开关（关了的层不可拖）。 */
export function pickRangeHandle(cam: Camera, meta: Meta | undefined, world: World, T: number, x: number, y: number,
  unitId: string | null, nodeId: string | null, opts: { fire?: boolean; vision?: boolean } = {}): RingHit | null {
  const fire = opts.fire !== false, vision = opts.vision !== false, HIT = 7;
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    if (unitId) {
      const u = (world.units || []).find(q => q.id === unitId);
      const p = u ? unitPos(u, T) : null;
      if (u && p) {
        const fk = unitFireKm(u);
        if (fire && fk > 0) {
          const [cx, cy, rx, ry] = ringPx(c2, meta, p.lon, p.lat, fk);
          if (!(rx < 3 && ry < 3) && Math.abs(x - (cx + rx)) <= HIT && Math.abs(y - cy) <= HIT) return { owner: "unit", id: u.id, ring: "range", lon: p.lon, lat: p.lat };
        }
        const vk = +(u.vision as number) || 0;
        if (vision && vk > 0) {
          const [cx, cy, rx, ry] = ringPx(c2, meta, p.lon, p.lat, vk);
          if (!(rx < 3 && ry < 3) && Math.abs(x - (cx - rx)) <= HIT && Math.abs(y - cy) <= HIT) return { owner: "unit", id: u.id, ring: "vision", lon: p.lon, lat: p.lat };
        }
      }
    }
    if (nodeId && fire) {
      const n = world.nodes.find(q => q.id === nodeId);
      if (n && (n.ranges || []).length && activeAt(n, T)) {
        const rs = n.ranges!;
        for (let i = 0; i < rs.length; i++) {
          const km = +rs[i].km || 0; if (!(km > 0)) continue;
          const [cx, cy, rx, ry] = ringPx(c2, meta, n.lon, n.lat, km);
          if (rx < 3 && ry < 3) continue;
          if (Math.abs(x - (cx + rx)) <= HIT && Math.abs(y - cy) <= HIT) return { owner: "node", id: n.id, ring: i, lon: n.lon, lat: n.lat };
        }
      }
    }
  }
  return null;
}

/** 拾取部队（矩形容差；优先级最高——战场主角）。x/y 为 CSS 像素，自带世界拷贝循环 */
export function pickUnit(cam: Camera, meta: Meta | undefined, world: World, T: number, x: number, y: number): Unit | null {
  let best: Unit | null = null, bd = Infinity;
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    for (const u of world.units || []) {
      const p = unitPos(u, T); if (!p) continue;
      const [ux, uy] = project(c2, p.lon, p.lat);
      const d = Math.max(Math.abs(x - ux) / 1.5, Math.abs(y - uy));
      if (d < 12 && d < bd) { bd = d; best = u; }
    }
  }
  return best;
}
