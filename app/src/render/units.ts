/* 兵棋部队渲染（v0.14 战术图部队层）：单位框+兵种符号、行军尾迹（已走实线/计划虚线/
   日刻度点/超速红⚠）、火力射程圈、拾取。纯视觉走截图目检（同 decor/ops）。
   日戳 T 即 yearNow（战术图时间轴存的是 T）。各绘制函数按【单相机】工作——由 overlay 的
   世界拷贝循环逐拷贝调用（同 drawEco/drawDecor）；pickUnit 独立，自带拷贝循环（同 pickNode）。 */
import { project, projectSeq, visibleWorldCopies, type Camera } from "../core/projection.ts";
import { kmPerDeg, lonCos } from "../core/geo.ts";
import { fmtStrength, footCornersLL, isModern, arcDegOf, nodeVisionKm, rangeDirect, unitFacingAt, unitFireDirect, unitFireKm, unitFootKm, unitKind, unitPos, radarKmOf, unitStatusAt, unitStrengthAt, type Leg, type UnitPos } from "../core/units.ts";
import { maskContour, maskCoverage } from "./maskraster.ts";
import { pointInPoly } from "../core/geometry.ts";
import { UNIT_STATUS } from "../core/constants.ts";
import { activeAt, ownerAt } from "../core/time.ts";
import { hexA, hexRGB, tget } from "../core/util.ts";
import type { LabelField } from "./labels.ts";
import { detectedBy, type VisMask, type VisMasks } from "../core/viewshed.ts";
import type { SightRes } from "../worker/routeProto.ts";
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
  const sd = tget(UNIT_STATUS, st) || null;
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

/** 阵位条（柱B）：按真实正面×纵深画的旋转矩形——派系色三成填充+实描边，**前缘加粗一道**即见朝向（现代图的
    防区是防御地段不是战列，不画前缘）；兵种字正立在阵中（不随条转,斜排汉字不可读）,状态语言与标准框同规。 */
function drawUnitBar(ctx: CanvasRenderingContext2D, pts: [number, number][], world: World, u: Unit, selMe: boolean, st: string | null | undefined, frontEdge: boolean): void {
  const col = boxColor(world, u);
  const sd = tget(UNIT_STATUS, st) || null;
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
  if (frontEdge) {   // 前缘
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]);
    ctx.lineWidth = 3.6; ctx.strokeStyle = col; ctx.stroke();
  }
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
  handleUnit?: string | null;      // 编辑态选中部队 id → 其阵位条画朝向拖动手柄（调用方已并编辑态门）
  trails?: boolean;                 // 行军尾迹层
  labels?: boolean;                 // 地名标签层（部队名·兵力）
  selId?: string | null;           // 选中部队 id（泥金光晕框）
  multiIds?: string[] | null;      // 框选的部队 id（同款光晕，全部高亮）
  legs?: Map<string, Leg[]>;        // 可达性预算（外壳缓存；缺省=不标超速）
  labelField?: LabelField;          // 帧内标签避让场（与地名/标注共用）；缺省=旧行为无条件画
  detect?: Map<string, SightRes[]>; // 飞行部队被他派看见（外壳算好）：看见的画探测圈
}

/** 足印够宽才改画阵位条：正面屏宽 ≤ 此值＝维持标准框（旧档与远景逐位不变） */
export const BAR_MIN_PX = 34;
/** 朝向手柄离前缘的屏幕距（px）：够远才不压在条上、够近才还看得出属于这个阵位 */
const FACE_OUT_PX = 14;
/** 朝向手柄的屏幕位（绘制与拾取同源）：前缘中点沿「条心→前缘」方向外推。foot＝阵位条四角（前左→前右→后右→后左） */
export function facingHandlePx(foot: [number, number][]): [number, number] {
  const fx = (foot[0][0] + foot[1][0]) / 2, fy = (foot[0][1] + foot[1][1]) / 2;
  const cx = (foot[0][0] + foot[2][0]) / 2, cy = (foot[0][1] + foot[2][1]) / 2;
  const dx = fx - cx, dy = fy - cy, L = Math.hypot(dx, dy) || 1;
  return [fx + dx / L * FACE_OUT_PX, fy + dy / L * FACE_OUT_PX];
}

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
    if (foot) {
      drawUnitBar(ctx, foot, world, u, selMe, st, !isModern(meta));
      if (u.id === opts.handleUnit) drawFacingHandle(ctx, foot, boxColor(world, u));
    }
    else drawUnitSymbol(ctx, x, y, world, u, selMe, st);
    const seenBy = opts.detect ? detectedBy(opts.detect.get(u.id)) : [];
    if (seenBy.length) drawDetectHalo(ctx, x, y, foot, observerColor(world, T, seenBy.find(r => r.ring === "radar") || seenBy[0]), seenBy.some(r => r.ring === "radar"));
    if (opts.labels) {
      /* 标签仍在图面直立、仍走共用避让场；阵位条态改锚其外接盒的上下缘（条比框大得多，贴框距会压在阵中） */
      const lo = foot ? Math.max(...foot.map(q => q[1])) : y + 8.5;
      const hi = foot ? Math.min(...foot.map(q => q[1])) : y - 8.5;
      const mx = foot ? (foot[0][0] + foot[2][0]) / 2 : x;
      const str = fmtStrength(unitStrengthAt(u, T));
      const lbl = (u.名称 || "部队") + (str ? ` ${str}` : "");
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


/** 观察者（部队或地点）的派系色：探测圈用看见它的那一方的颜色 */
function observerColor(world: World, T: number, r: SightRes): string {
  if (r.owner === "unit") { const u = (world.units || []).find(q => q.id === r.id); return u ? boxColor(world, u) : "#888"; }
  const n = world.nodes.find(q => q.id === r.id), fid = n ? ownerAt(n, T) : null;
  return (fid && world.factions.find(f => f.id === fid)?.color) || "#8a6a2a";
}
/** 探测圈：部队框（或阵位条外接盒）外一圈椭圆，虚线式样同看见它的圈（雷达点划、视野点线），色＝看见它的那一方 */
function drawDetectHalo(ctx: CanvasRenderingContext2D, x: number, y: number, foot: [number, number][] | null | undefined, col: string, radar: boolean): void {
  let cx = x, cy = y, hw = 13, hh = 8.5;
  if (foot) {
    const xs = foot.map(q => q[0]), ys = foot.map(q => q[1]);
    cx = (Math.min(...xs) + Math.max(...xs)) / 2; cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    hw = (Math.max(...xs) - Math.min(...xs)) / 2; hh = (Math.max(...ys) - Math.min(...ys)) / 2;
  }
  ctx.save();
  ctx.strokeStyle = hexA(col, .9); ctx.lineWidth = 1.6; ctx.setLineDash(DASH[radar ? "radar" : "vision"]);
  ctx.beginPath(); ctx.ellipse(cx, cy, hw + 7, hh + 7, 0, 0, 7); ctx.stroke();
  ctx.restore();
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
  const dLat = 1 / kmPerDeg(meta);            // 1km 对应的纬度跨度
  const cosn = lonCos(meta, lat);
  const [cx, cy] = project(cam, lon, lat);
  const rx = Math.abs(project(cam, lon + km * dLat / cosn, lat)[0] - cx);
  const ry = Math.abs(cy - project(cam, lon, lat + km * dLat)[1]);
  return [cx, cy, rx, ry];
}

/** 朝向拖动手柄（编辑态·选中部队）：前缘外一枚小圆 + 一段短柄——**圆区别于半径手柄的方块**，
    图上一眼看得出哪个是转向、哪个是调半径 */
function drawFacingHandle(ctx: CanvasRenderingContext2D, foot: [number, number][], col: string): void {
  const [hx, hy] = facingHandlePx(foot);
  const fx = (foot[0][0] + foot[1][0]) / 2, fy = (foot[0][1] + foot[1][1]) / 2;
  ctx.save();
  ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(hx, hy); ctx.stroke();
  ctx.beginPath(); ctx.arc(hx, hy, 4, 0, 7);
  ctx.fillStyle = "#fbf7ea"; ctx.fill(); ctx.stroke();
  ctx.restore();
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
  radar?: boolean;                 // 雷达覆盖圈（radar 层 × 现代图；调用方已并门）
  handleUnit?: string | null;      // 编辑态选中部队 id → 其圈上画拖动手柄
  handleNode?: string | null;      // 编辑态选中地点 id → 其火力圈与视野圈画手柄
  masks?: VisMasks;                // 视线掩膜：有掩膜的圈只填可达的格（圈线仍画名义半径）
  focus?: ReadonlySet<string>;     // 选中的部队 id：有则它们的可达区域斜纹加粗描边、其余只留描边（多队相邻靠点选分辨）
  focusNodes?: ReadonlySet<string>; // 选中的带火力圈的地点 id：同 focus（两者任一非空即进焦点态）
}

/* 掩膜的屏幕栅格（位图 + 等值线路径），按 (掩膜, 缩放档, 派系色) 缓存：缩放档＝每格像素数取半倍频程阶梯，
   连续缩放不逐帧重建；≥1 一档＝逐格。派系色烙进位图、覆盖率进 alpha，透明度画时给。 */
interface MaskRaster { key: number; col: string; w: number; h: number; img: HTMLCanvasElement; path: Path2D }
const RASTER = new WeakMap<VisMask, MaskRaster>();
const scaleKey = (s: number): number => s >= 1 ? 1 : Math.pow(2, Math.round(Math.log2(s) * 2) / 2);
function maskRaster(mask: VisMask, col: string, s: number): MaskRaster | null {
  const key = scaleKey(s), hit = RASTER.get(mask);
  if (hit && hit.key === key && hit.col === col) return hit;
  if (typeof document === "undefined") return null;
  const cv = maskCoverage(mask, key), rgb = hexRGB(col) || [136, 136, 136];
  const img = document.createElement("canvas");
  img.width = cv.w; img.height = cv.h;
  const g = img.getContext("2d");
  if (!g) return null;
  const id = g.createImageData(cv.w, cv.h), px = id.data;
  for (let i = 0; i < cv.cov.length; i++) {
    const o = i * 4;
    px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = Math.round(255 * cv.cov[i]);
  }
  g.putImageData(id, 0, 0);
  const seg = maskContour(cv), path = new Path2D();
  for (let i = 0; i < seg.length; i += 4) { path.moveTo(seg[i], seg[i + 1]); path.lineTo(seg[i + 2], seg[i + 3]); }
  const r = { key, col, w: cv.w, h: cv.h, img, path };
  RASTER.set(mask, r);
  return r;
}

/* 斜纹（焦点态）：屏幕空间 7 px 一道、1.3 px 粗，纹向按焦点序轮换（多选时分得开）；经掩膜位图
   source-in 只落在可达处。图案按 (色, 纹向) 缓存；临时画布一张复用，按视口相交部分与 DPR 建。 */
const HATCH_DEG = [45, 135, 0, 90], HATCH_PX = 7;
const PATTERNS = new Map<string, CanvasPattern>();
let hatchTmp: HTMLCanvasElement | null = null;
function hatchPattern(col: string, deg: number): CanvasPattern | null {
  const k = col + "@" + deg, hit = PATTERNS.get(k);
  if (hit) return hit;
  const p = document.createElement("canvas");
  p.width = HATCH_PX; p.height = HATCH_PX;
  const g = p.getContext("2d");
  if (!g) return null;
  g.strokeStyle = col; g.lineWidth = 1.3; g.lineCap = "square";
  g.translate(HATCH_PX / 2, HATCH_PX / 2); g.rotate(deg * Math.PI / 180); g.translate(-HATCH_PX / 2, -HATCH_PX / 2);
  g.beginPath();
  for (const o of [-HATCH_PX, 0, HATCH_PX]) { g.moveTo(-HATCH_PX, o + HATCH_PX / 2); g.lineTo(2 * HATCH_PX, o + HATCH_PX / 2); }
  g.stroke();
  const pat = g.createPattern(p, "repeat");
  if (pat) PATTERNS.set(k, pat);
  return pat;
}
function drawHatch(ctx: CanvasRenderingContext2D, ras: MaskRaster, x0: number, y0: number, x1: number, y1: number,
  smooth: boolean, col: string, deg: number, alpha: number): void {
  const pat = hatchPattern(col, deg);
  if (!pat) return;
  const k = ctx.getTransform().a || 1;
  const X0 = Math.max(0, x0), Y0 = Math.max(0, y0), X1 = Math.min(ctx.canvas.width / k, x1), Y1 = Math.min(ctx.canvas.height / k, y1);
  if (!(X1 > X0 && Y1 > Y0)) return;
  const t = hatchTmp || (hatchTmp = document.createElement("canvas"));
  t.width = Math.ceil((X1 - X0) * k); t.height = Math.ceil((Y1 - Y0) * k);   // 赋尺寸即清空
  const g = t.getContext("2d");
  if (!g) return;
  g.setTransform(k, 0, 0, k, -X0 * k, -Y0 * k);
  g.imageSmoothingEnabled = smooth;
  g.drawImage(ras.img, x0, y0, x1 - x0, y1 - y0);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = pat;
  g.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
  ctx.save(); ctx.globalAlpha = alpha; ctx.drawImage(t, X0, Y0, X1 - X0, Y1 - Y0); ctx.restore();
}

type RingKind = "fire" | "vision" | "radar";
/* 透明度：掩膜填按覆盖率再乘 FILL；整圆兜底（演算中/失败/飞行）DISC 更淡；等值线描边 LINE。圈线虚线式样按圈种区分。 */
const FILL: Record<RingKind, number> = { fire: .30, vision: .18, radar: .15 };
const DISC: Record<RingKind, number> = { fire: .18, vision: .07, radar: .06 };
const LINE: Record<RingKind, number> = { fire: .95, vision: .75, radar: .6 };
const DASH: Record<RingKind, number[]> = { fire: [5, 4], vision: [2, 3.5], radar: [6, 3, 1.5, 3] };

/** 火力/视野/雷达圈：有掩膜的圈按可达区域画——按面积平均的填色（格比像素小时不丢格）+ 覆盖率 0.5 等值线
    描边（裁进名义圆内 2 px：圆周本身不描，它就是虚线圈）；虚线圈＝名义半径。掩膜未到/失败/飞行部队＝整圆淡填。
    焦点态（选中部队或带火力圈的地点）**只作用于火力圈**：可达区域斜纹加粗描边、标签带可达读数，其余的火力圈只留描边；视野与雷达圈恒按无焦点态画（圈大得多，铺纹会盖住地形）。
    部队按当日位置——火力=单值 range（旧多圈回退首条）、视野=vision，两者同机制；地点＝ranges 多圈各按自己的射击方式，另有视野与雷达。
    标签火力在圈上、视野在圈下、雷达在圈右（相邻不打架）；雷达圈最大故垫最底。
    编辑态选中对象的圈带拖动手柄（火力=圈右、视野=圈左），配合外壳 pickRangeHandle 拖动调半径。 */
export function drawRanges(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined, world: World, T: number, opts: RangesOpts = {}): void {
  const fire = opts.fire !== false, vision = !!opts.vision, radar = !!opts.radar;
  const focus = opts.focus, focusNodes = opts.focusNodes, anyFocus = !!(focus || focusNodes);
  /** role：null＝无焦点态；true＝焦点；false＝陪衬 */
  const fillRing = (lon: number, lat: number, km: number, col: string, kind: RingKind, label: string, handle: boolean,
    mask?: VisMask, role: boolean | null = null, hatchDeg = 0): void => {
    const [cx, cy, rx, ry] = ringPx(cam, meta, lon, lat, km);
    if (rx < 3 && ry < 3) return;
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, 7);
    let ras: MaskRaster | null = null, x0 = 0, y0 = 0, x1 = 0, y1 = 0, smooth = false;
    if (mask) {
      [x0, y0] = project(cam, mask.bb.lonMin, mask.bb.latMax); [x1, y1] = project(cam, mask.bb.lonMax, mask.bb.latMin);
      const s = Math.min((x1 - x0) / mask.cols, (y1 - y0) / mask.rows);
      smooth = s < 1;
      ras = maskRaster(mask, col, s);
    }
    if (ras) {
      if (role !== false) {
        ctx.save(); ctx.clip();
        ctx.globalAlpha = role ? FILL[kind] * .4 : FILL[kind]; ctx.imageSmoothingEnabled = smooth;
        ctx.drawImage(ras.img, x0, y0, x1 - x0, y1 - y0);
        ctx.globalAlpha = 1;
        if (role) drawHatch(ctx, ras, x0, y0, x1, y1, smooth, col, hatchDeg, .75);
        ctx.restore();
      }
      const p = new Path2D();
      p.addPath(ras.path, new DOMMatrix([(x1 - x0) / ras.w, 0, 0, (y1 - y0) / ras.h, x0, y0]));
      ctx.save();
      ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(1, rx - 2), Math.max(1, ry - 2), 0, 0, 7); ctx.clip();
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.lineWidth = role ? 1.6 : role === false ? 1 : kind === "fire" ? 1.3 : 1.1;
      ctx.strokeStyle = hexA(col, role ? 1 : role === false ? LINE[kind] * .6 : LINE[kind]);
      ctx.stroke(p);
      ctx.restore();
    } else if (role !== false) { ctx.fillStyle = hexA(col, DISC[kind]); ctx.fill(); }
    ctx.lineWidth = role ? 1.2 : 1; ctx.strokeStyle = hexA(col, role ? .6 : role === false ? .35 : .45); ctx.setLineDash(DASH[kind]);
    ctx.stroke(); ctx.setLineDash([]);
    if (role !== false) {   // 陪衬部队不标半径：焦点标签更长，同半径相邻的圈会撞在同一行上
      ctx.font = "10px system-ui,sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = hexA(col, kind === "fire" ? .85 : .7);
      if (kind === "fire") ctx.fillText(label, cx, cy - ry - 3);
      else if (kind === "vision") ctx.fillText(label, cx, cy + ry + 11);
      else { ctx.textAlign = "left"; ctx.fillText(label, cx + rx + 4, cy + 3); }
    }
    if (handle) drawHandle(ctx, kind === "fire" ? cx + rx : cx - rx, cy, col);
    ctx.restore();
  };
  const pctOf = (m: VisMask): string => m.nIn > 0 ? ` ${Math.round(100 * m.nVis / m.nIn)}%` : "";
  /** 焦点态才带读数 */
  const readout = (role: boolean | null, m: VisMask | undefined, 名: string): string => role && m ? ` · ${名}${pctOf(m)}` : "";
  const fireHow = (direct: boolean, arc: number): string => direct ? "直射 · 视线可达" : `曲射 ${arc}° · 弹道可达`;
  let nFocus = 0;
  /* 焦点只作用于**火力圈**（2026-09-10 用户拍板）：视野与雷达圈恒按无焦点态画。
     它俩的圈大得多（雷达 30 km），铺上斜纹既盖住地形又与火力圈抢眼——要分辨谁是谁，看火力圈就够。 */
  (world.units || []).forEach(u => {
    const fk = unitFireKm(u), vk = +(u.vision as number) || 0, rk = radarKmOf(u);
    if (!((fire && fk > 0) || (vision && vk > 0) || (radar && rk > 0))) return;
    const p = unitPos(u, T); if (!p) return;
    const col = boxColor(world, u), withHandle = u.id === opts.handleUnit, mk = opts.masks && opts.masks.unit.get(u.id);
    const role = anyFocus ? !!(focus && focus.has(u.id)) : null, deg = role ? HATCH_DEG[nFocus++ % HATCH_DEG.length] : 0;
    if (radar && rk > 0) fillRing(p.lon, p.lat, rk, col, "radar", `雷达 ${rk}km`, false, mk && mk.radar);
    if (fire && fk > 0) {
      const m = mk && mk.fire && mk.fire[0];
      fillRing(p.lon, p.lat, fk, col, "fire", `火力 ${fk}km${readout(role, m, fireHow(unitFireDirect(u), arcDegOf(u)))}`, withHandle, m, role, deg);
    }
    if (vision && vk > 0) fillRing(p.lon, p.lat, vk, col, "vision", `视野 ${vk}km`, withHandle, mk && mk.vision);
  });
  world.nodes.forEach(n => {
    const rs = n.ranges || [], vk = nodeVisionKm(n), rk = radarKmOf(n);
    if (!((fire && rs.length) || (vision && vk > 0) || (radar && rk > 0)) || !activeAt(n, T)) return;
    const fid = ownerAt(n, T);
    const f = fid ? world.factions.find(x => x.id === fid) : null;
    const col = (f && f.color) || "#8a6a2a", withHandle = n.id === opts.handleNode, mk = opts.masks && opts.masks.node.get(n.id);
    const role = anyFocus ? !!(focusNodes && focusNodes.has(n.id)) : null;
    if (radar && rk > 0) fillRing(n.lon, n.lat, rk, col, "radar", `雷达 ${rk}km`, false, mk && mk.radar);
    if (fire) rs.forEach((r, i) => {
      const km = +r.km || 0; if (!(km > 0)) return;
      const m = mk && mk.fire && mk.fire[i], deg = role ? HATCH_DEG[nFocus++ % HATCH_DEG.length] : 0;
      fillRing(n.lon, n.lat, km, col, "fire", `${r.名称 || "射程"} ${km}km${readout(role, m, fireHow(rangeDirect(r), arcDegOf(r)))}`, withHandle, m, role, deg);
    });
    if (vision && vk > 0) fillRing(n.lon, n.lat, vk, col, "vision", `视野 ${vk}km`, withHandle, mk && mk.vision);
  });
}

export interface RingHit { owner: "unit" | "node"; id: string; ring: "vision" | "range" | number; lon: number; lat: number }

/** 朝向手柄拾取（编辑态·选中部队）：命中返回旋转中心＝部队当日位置。自带世界拷贝循环（同 pickUnit）；
    走 unitSpots ＝与绘制同源（点你看得见的那一枚）。命中半径与圈手柄同为 7px。 */
export function pickFacingHandle(cam: Camera, meta: Meta | undefined, world: World, T: number,
  x: number, y: number, unitId: string | null): { id: string; lon: number; lat: number } | null {
  if (!unitId) return null;
  for (const shift of visibleWorldCopies(cam, meta)) {
    const c2: Camera = { ...cam, lonShift: shift };
    for (const s of unitSpots(c2, meta, world, T)) {
      if (s.u.id !== unitId || !s.foot) continue;
      const [hx, hy] = facingHandlePx(s.foot);
      if (Math.hypot(x - hx, y - hy) <= 7) return { id: s.u.id, lon: s.p.lon, lat: s.p.lat };
    }
  }
  return null;
}

/** 拾取圈半径手柄（编辑态·仅选中对象）：火力圈手柄在圈右、视野圈在圈左；命中返回圈心数据坐标。
    部队火力=单值 "range"（含旧多圈回退）、视野="vision"；地点火力圈=下标、视野="vision"。
    x/y=CSS 像素，自带世界拷贝循环（同 pickUnit）；fire/vision 对应图层开关（关了的层不可拖）。 */
export function pickRangeHandle(cam: Camera, meta: Meta | undefined, world: World, T: number, x: number, y: number,
  unitId: string | null, nodeId: string | null, opts: { fire?: boolean; vision?: boolean } = {}): RingHit | null {
  const fire = opts.fire !== false, vision = !!opts.vision, HIT = 7;   // 缺省与 drawRanges 同源（火力缺省开、视野缺省关），免两边各记一套
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
    const n = nodeId ? world.nodes.find(q => q.id === nodeId) : null;
    if (n && activeAt(n, T)) {
      const rs = fire ? n.ranges || [] : [];
      for (let i = 0; i < rs.length; i++) {
        const km = +rs[i].km || 0; if (!(km > 0)) continue;
        const [cx, cy, rx, ry] = ringPx(c2, meta, n.lon, n.lat, km);
        if (rx < 3 && ry < 3) continue;
        if (Math.abs(x - (cx + rx)) <= HIT && Math.abs(y - cy) <= HIT) return { owner: "node", id: n.id, ring: i, lon: n.lon, lat: n.lat };
      }
      const vk = nodeVisionKm(n);
      if (vision && vk > 0) {
        const [cx, cy, rx, ry] = ringPx(c2, meta, n.lon, n.lat, vk);
        if (!(rx < 3 && ry < 3) && Math.abs(x - (cx - rx)) <= HIT && Math.abs(y - cy) <= HIT) return { owner: "node", id: n.id, ring: "vision", lon: n.lon, lat: n.lat };
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
