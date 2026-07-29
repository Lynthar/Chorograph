/* 兵棋部队渲染（v0.14 战术图部队层）：单位框+兵种符号、行军尾迹（已走实线/计划虚线/
   日刻度点/超速红⚠）、火力射程圈、拾取。纯视觉走截图目检（同 decor/ops）。
   日戳 T 即 yearNow（战术图时间轴存的是 T）。各绘制函数按【单相机】工作——由 overlay 的
   世界拷贝循环逐拷贝调用（同 drawEco/drawDecor）；pickUnit 独立，自带拷贝循环（同 pickNode）。 */
import { project, projectSeq, visibleWorldCopies, type Camera } from "../core/projection.ts";
import { kmPerDegLat, toRad } from "../core/geo.ts";
import { footCornersLL, unitFacingAt, unitFireKm, unitFootKm, unitKind, unitPos, unitStatusAt, type Leg, type UnitPos } from "../core/units.ts";
import { pointInPoly } from "../core/geometry.ts";
import { UNIT_STATUS } from "../core/constants.ts";
import { activeAt, ownerAt } from "../core/time.ts";
import { hexA } from "../core/util.ts";
import type { LabelField } from "./labels.ts";
import type { Meta, Unit, World } from "../core/types.ts";

/** 单位框色=所属派系色（缺省暗红） */
function boxColor(world: World, u: Unit): string {
  const f = u.faction ? world.factions.find(x => x.id === u.faction) : null;
  return (f && f.color) || "#a03030";
}

/** 状态徽章（框右上角）：交战=交叉双剑 / 对峙=对峙双杠 / 溃退=折线溃箭——手绘线条（不走 emoji 字形，跨平台一致）。
    导出供图例块复用（render/legend）——徽章字形单一真源。 */
export function drawStatusBadge(ctx: CanvasRenderingContext2D, bx: number, by: number, st: string, color: string): void {
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

/** 阵位条（柱B）：按真实正面×纵深画的旋转矩形——派系色三成填充+实描边，**前缘加粗一道**即见朝向；
    兵种字正立在阵中（不随条转,斜排汉字不可读）,状态语言与标准框同规（溃退虚框/交战红芯/徽章）。 */
function drawUnitBar(ctx: CanvasRenderingContext2D, pts: [number, number][], world: World, u: Unit, selMe: boolean, st?: string | null): void {
  const col = boxColor(world, u);
  const sd = st ? UNIT_STATUS[st] : null;
  const trace = () => { ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); ctx.closePath(); };
  ctx.save();
  ctx.lineJoin = "round";
  if (selMe) { ctx.shadowColor = "#d4b24a"; ctx.shadowBlur = 10; }
  trace(); ctx.fillStyle = hexA(col, .3); ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = col;
  if (st === "rout") ctx.setLineDash([4, 3]);          // 溃退=虚边（建制涣散，同标准框）
  trace(); ctx.stroke();
  ctx.setLineDash([]); ctx.shadowBlur = 0;
  const cx = (pts[0][0] + pts[2][0]) / 2, cy = (pts[0][1] + pts[2][1]) / 2;
  if (st === "battle" && sd) {   // 交战=**外扩一圈**红晕（同标准框之规）——不覆边框：边框色是派系身份，状态色不夺
    ctx.beginPath();
    pts.forEach((q, i) => {
      const dx = q[0] - cx, dy = q[1] - cy, L = Math.hypot(dx, dy) || 1;
      const ox = q[0] + dx / L * 3, oy = q[1] + dy / L * 3;
      i ? ctx.lineTo(ox, oy) : ctx.moveTo(ox, oy);
    });
    ctx.closePath();
    ctx.lineWidth = 1.3; ctx.strokeStyle = hexA(sd.color, .85); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]);   // 前缘
  ctx.lineWidth = 3.6; ctx.strokeStyle = col; ctx.stroke();
  /* 兵种字随纵深收缩——薄条（纵深缺省＝正面÷6）里 11px 会溢出条外 */
  const dpx = Math.hypot(pts[0][0] - pts[3][0], pts[0][1] - pts[3][1]);
  const k = unitKind(u);
  ctx.font = `bold ${Math.max(7, Math.min(11, dpx * 0.8)).toFixed(1)}px system-ui,sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.85)";                          // 白衬底=图面文字语言
  ctx.strokeText(k ? k.glyph : String(u.kind || "?").slice(0, 1), cx, cy);
  ctx.fillStyle = col; ctx.fillText(k ? k.glyph : String(u.kind || "?").slice(0, 1), cx, cy);
  ctx.restore();
  if (sd) drawStatusBadge(ctx, pts[1][0], pts[1][1], st!, sd.color);                      // 徽章挂前右角（右翼之前）
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
  multiIds?: string[] | null;      // 框选的部队 id（同款光晕，全部高亮）
  legs?: Map<string, Leg[]>;        // 可达性预算（外壳缓存；缺省=不标超速）
  labelField?: LabelField;          // 帧内标签避让场（与地名/标注共用）；缺省=旧行为无条件画
}

/** 足印够宽才改画阵位条：正面屏宽 ≤ 此值＝维持标准框（旧档与远景逐位不变） */
export const BAR_MIN_PX = 34;

export interface UnitSpot {
  u: Unit; p: UnitPos; x: number; y: number;
  /** 阵位条四角屏幕坐标（前左→前右→后右→后左）；null＝标准框态 */
  foot: [number, number][] | null;
}

/** 各在场部队的屏幕位（含同点堆叠偏移，2026-07 特化 P0）：真实位置屏幕距 <10px 的部队
    按数组序向右上阶梯错开（每级 +7,-6px——在框高内,记号不全遮又看得出「叠着」）。
    绘制与拾取共用此一源（pickUnit 拾偏移后的位置=点你看见的那个框）;
    尾迹端点与火力/视野圈仍锚真实经纬（地理事实）,框选 unitsInBox 亦按真实位置（框选按锚点之规）。
    ⚠ 阵位条（柱B）**不参与堆叠**：真实足印各占其地、天然分离，错开反而挪离阵位。 */
export function unitSpots(cam: Camera, meta: Meta | undefined, world: World, T: number): UnitSpot[] {
  const spots: UnitSpot[] = [], base: [number, number][] = [];
  for (const u of world.units || []) {
    const p = unitPos(u, T); if (!p) continue;
    const [bx, by] = project(cam, p.lon, p.lat);
    const fk = unitFootKm(u);
    if (fk) {   // 足印够宽＝阵位条：四角各自投影（前缘屏宽即判据，无须另算 km→px）
      const pts = footCornersLL(meta, p.lon, p.lat, fk.front, fk.depth, unitFacingAt(meta, u, T))
        .map(q => project(cam, q[0], q[1]) as [number, number]);
      if (Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) > BAR_MIN_PX) {
        spots.push({ u, p, x: bx, y: by, foot: pts });
        continue;
      }
    }
    let n = 0;
    for (const [qx, qy] of base) if (Math.hypot(bx - qx, by - qy) < 10) n++;
    base.push([bx, by]);
    spots.push({ u, p, x: bx + n * 7, y: by - n * 6, foot: null });
  }
  return spots;
}

/** 画所有在场部队（单相机；overlay 拷贝循环内调用）。部队压在地点之上——战场主角；
    但部队【标签】让地名（用户拍板：地点语义上固定不动，标签该稳；部队是移动体）——
    框下→框上两候选位试进共用避让场，全撞不画（选中部队恒显并登记占位）。 */
export function drawUnits(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined, world: World, T: number, opts: UnitDrawOpts = {}): void {
  if (!(world.units || []).length) return;
  for (const { u, p, x, y, foot } of unitSpots(cam, meta, world, T)) {   // 含同点堆叠偏移（与 pickUnit 同源）
    const selMe = opts.selId === u.id || !!(opts.multiIds && opts.multiIds.includes(u.id));
    if (opts.trails) drawTrail(ctx, cam, world, u, T, p, opts.legs && opts.legs.get(u.id));
    const st = unitStatusAt(u, T);
    if (foot) drawUnitBar(ctx, foot, world, u, selMe, st);
    else drawUnitSymbol(ctx, x, y, world, u, selMe, st);
    if (opts.labels) {
      /* 标签仍在图面直立、仍走共用避让场；阵位条态改锚其外接盒的上下缘（条比框大得多，贴框距会压在阵中） */
      const lo = foot ? Math.max(...foot.map(q => q[1])) : y + 8.5;
      const hi = foot ? Math.min(...foot.map(q => q[1])) : y - 8.5;
      const mx = foot ? (foot[0][0] + foot[2][0]) / 2 : x;
      const lbl = (u.名称 || "部队") + (u.strength ? ` ${u.strength}` : "");
      ctx.save(); ctx.font = "10.5px KaiTi,楷体,serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const w = ctx.measureText(lbl).width, h = 13;
      let ly: number | null = lo + 7.5;
      if (opts.labelField) {
        ly = null;
        for (const cy of [lo + 7.5, hi - 8.5]) {   // 下缘优先，占了试上缘
          if (opts.labelField.tryPlace({ x: mx - w / 2, y: cy - h / 2, w, h })) { ly = cy; break; }
        }
        if (ly == null && selMe) { ly = lo + 7.5; opts.labelField.claim({ x: mx - w / 2, y: ly - h / 2, w, h }); }
      }
      if (ly != null) {
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.strokeText(lbl, mx, ly);
        ctx.fillStyle = "#2c241b"; ctx.fillText(lbl, mx, ly);
      }
      ctx.restore();
    }
  }
}


/** 框选拾取：当前时刻位置落在屏幕矩形内的部队 id（语义对齐 overlay.nodesInBox；未入场无位置不参与） */
export function unitsInBox(cam: Camera, meta: Meta | undefined, world: World, T: number,
  x0: number, y0: number, x1: number, y1: number): string[] {
  const xs = Math.min(x0, x1), xe = Math.max(x0, x1), ys = Math.min(y0, y1), ye = Math.max(y0, y1);
  const ids = new Set<string>();
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    for (const u of world.units || []) {
      const p = unitPos(u, T); if (!p) continue;
      const [px, py] = project(c2, p.lon, p.lat);
      if (px >= xs && px <= xe && py >= ys && py <= ye) ids.add(u.id);
    }
  }
  return [...ids];
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

/** 拾取部队（矩形容差；优先级最高——战场主角）。x/y 为 CSS 像素，自带世界拷贝循环。
    位置经 unitSpots＝含堆叠偏移,与绘制同源——点你看见的那个框。
    阵位条态（柱B）＝落在四角围出的条内即命中,距离折算成同一量纲（条心 0 → 条边 12）
    与框态可比：点在条心胜过点在旁边框的边缘,点在条边则让位于压在那里的框。 */
export function pickUnit(cam: Camera, meta: Meta | undefined, world: World, T: number, x: number, y: number): Unit | null {
  let best: Unit | null = null, bd = Infinity;
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    for (const sp of unitSpots(c2, meta, world, T)) {
      let d: number;
      if (sp.foot) {
        if (!pointInPoly(x, y, sp.foot)) continue;
        const cx = (sp.foot[0][0] + sp.foot[2][0]) / 2, cy = (sp.foot[0][1] + sp.foot[2][1]) / 2;
        const half = Math.hypot(sp.foot[0][0] - cx, sp.foot[0][1] - cy) || 1;
        d = Math.min(12, Math.hypot(x - cx, y - cy) / half * 12);
      } else {
        d = Math.max(Math.abs(x - sp.x) / 1.5, Math.abs(y - sp.y));
        if (d >= 12) continue;
      }
      if (d < bd) { bd = d; best = sp.u; }
    }
  }
  return best;
}
