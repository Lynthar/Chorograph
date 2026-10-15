/* 连线与作战线（自 overlay.ts 原样拆出，行为不变）：
   河流三层描边（选中红晕/白衬底/河蓝；真宽过门槛的段由地形渲染器当水画，见 render/rivers）、官道双线、商路紫点线、工事墨石齿线（2026-07 特化柱B）；
   作战线 攻势=末端实心箭头 / 防线=行进方向左侧齿线（reverse 翻面）。 */
import { EDGE_STYLE, certaintyStyle } from "../core/constants.ts";
import { tget } from "../core/util.ts";
import { activeAt, opVisibleAt } from "../core/time.ts";
import { project, projectSeq, type Camera } from "../core/projection.ts";
import { kmPerDeg } from "../core/geo.ts";
import { meander } from "../core/geometry.ts";
import { RIVER_WATER_PX, riverGeom, riverSD, riverWidest, type RiverGeom, type TerrainRivers } from "./rivers.ts";
import { MEANDER_K, meanderFade } from "./meander.ts";
import { FP_CORE, FP_KW, RIV_WIDTH } from "../core/constants.ts";
import { waterMask } from "../core/elev.ts";
import type { Grid } from "../core/grid.ts";
import type { LabelField } from "./labels.ts";
import type { Edge, Meta, Op, World, WorldNode } from "../core/types.ts";

/* —— 河流描边（经典曲流河 + 自由画河共用）：三层描边（选中红晕/白衬底/河蓝） ——
   riverWpx：widthM 米→像素，放大自然变宽；真宽不足底宽时按水面宽分档（10 m 以下 1px、1000 m 以上 2.6px，对数插值），
   缩小的图上大河仍比支流粗；无 widthM 时三层宽度与旧值 9/5/2.6 逐位一致。导出供 pickEdge 拾取走廊同源。 */
export function riverWpx(meta: Meta | undefined, cam: Camera, e: Edge): number {
  const wm = +(e.widthM as number) || 0;
  if (!(wm > 0)) return 2.6;
  return Math.max(tierPx(wm), (wm / 1000) / kmPerDeg(meta) / cam.degPerPx);
}
const tierPx = (wm: number): number => 1 + 1.6 * Math.min(1, Math.max(0, Math.log10(wm / 10) / 2));
/** 自由折线河按画法柔化（与曲流）后的折线（rivers.riverGeom）与逐点的画宽、真宽（px）：绘制与拾取同用；g＝逐点判水面的真宽（度，与地形渲染器比同一个门槛）。
    真宽封顶在 widthM（它不计河口展宽）：只用来判线还是水面，展宽那一截推不过门槛 */
export function riverShape(meta: Meta | undefined, cam: Camera, e: Edge): { pts: [number, number][]; px: number[]; tp: number[]; g: number[] } {
  const wm = +(e.widthM as number) || 0, pm = 1 / 1000 / kmPerDeg(meta) / cam.degPerPx, wx = riverWidest(e);
  const G = riverGeom(meta, e, meanderFade(MEANDER_K * wx * pm) > 0 && nearView(cam, projectSeq(cam, e.pts!), meanderPad(wx, pm)));
  const S = G.m ? meanderView(meta, cam, G) : G, px: number[] = [], tp: number[] = [];
  for (let k = 0; k < S.pts.length; k++) {
    const w = S.w[k];
    tp.push(w > 0 ? Math.min(w, wm > 0 ? wm : w) * pm : 0); px.push(w > 0 ? Math.max(tierPx(w), w * pm) : 2.6);
  }
  return { pts: S.pts, px, tp, g: S.g };
}
/** 曲流离底线的最远处（px）：平底半宽封顶，外加一个波长的余量（点距、柔化） */
const meanderPad = (wM: number, pm: number): number => (FP_CORE * FP_KW * wM / RIV_WIDTH * 1000 + MEANDER_K * wM) * pm + 16;
/** 折线外框外扩 pad 后碰不碰得到屏幕 */
function nearView(cam: Camera, pp: [number, number][], pad: number): boolean {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pp) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 + pad >= 0 && x0 - pad <= cam.w && y1 + pad >= 0 && y0 - pad <= cam.h;
}
/** 曲流按本帧缩放渐入：逐点偏移乘 meanderFade(弯的屏幕谷向波长)；整段不弯（含离屏幕超过最大横移的底线段）的点都在底线上，换回稀疏的底线点。
    宽到画成水面的点恒是满幅（MEANDER_FADE_PX 的门），与地形渲染器读的满幅曲线是同一条 */
function meanderView(meta: Meta | undefined, cam: Camera, G: RiverGeom): { pts: [number, number][]; w: number[]; g: number[] } {
  const { base, bw, bg, M } = G.m!, kmpp = cam.degPerPx * kmPerDeg(meta), fOf = (w: number): number => meanderFade(MEANDER_K * w / 1000 / kmpp);
  const bp = projectSeq(cam, base), pad = meanderPad(M.wmax, 1 / 1000 / kmpp), on = new Uint8Array(base.length);
  for (let j = 0; j < base.length - 1; j++) on[j] = nearView(cam, [bp[j], bp[j + 1]], pad) ? 1 : 0;
  const n = M.pts.length, fAt = (i: number): number => on[M.seg[i]] ? fOf(M.w[i]) : 0;
  const pts: [number, number][] = [], w: number[] = [], g: number[] = [];
  for (let i = 0; i < n;) {
    const f = fAt(i);
    if (f > 0) {
      pts.push(f >= 1 ? M.pts[i] : [M.bx[i] + f * (M.pts[i][0] - M.bx[i]), M.by[i] + f * (M.pts[i][1] - M.by[i])]); w.push(M.w[i]); g.push(G.g[i]);
      i++; continue;
    }
    let b = i;
    while (b + 1 < n && !(fAt(b + 1) > 0)) b++;
    pts.push([M.bx[i], M.by[i]]); w.push(M.w[i]); g.push(G.g[i]);
    for (let j = M.seg[i] + 1; j <= M.seg[b]; j++) if (M.U[j] > M.u[i] && M.U[j] < M.u[b]) { pts.push(base[j]); w.push(bw[j]); g.push(bg[j]); }
    if (b > i) { pts.push([M.bx[b], M.by[b]]); w.push(M.w[b]); g.push(G.g[b]); }
    i = b + 1;
  }
  return { pts, w, g };
}
/** 折线 [a, b] 画成变宽带并进当前路径：每段一个梯形，内部顶点补圆（圆接头），capA / capB 时那一头也补圆。
    子路径一律顺时针，非零环绕下是并集：半透明的一次填满不叠深 */
function addRibbon(ctx: CanvasRenderingContext2D, P: [number, number][], R: number[], a: number, b: number, capA: boolean, capB: boolean): void {
  for (let k = a; k < b; k++) {
    const [x0, y0] = P[k], [x1, y1] = P[k + 1], dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
    if (!(L > 0)) continue;
    const nx = -dy / L, ny = dx / L, q = [[x0 + nx * R[k], y0 + ny * R[k]], [x1 + nx * R[k + 1], y1 + ny * R[k + 1]], [x1 - nx * R[k + 1], y1 - ny * R[k + 1]], [x0 - nx * R[k], y0 - ny * R[k]]];
    let area = 0;
    for (let i = 0; i < 4; i++) area += q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1];
    const o = area > 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
    ctx.moveTo(q[o[0]][0], q[o[0]][1]); for (let i = 1; i < 4; i++) ctx.lineTo(q[o[i]][0], q[o[i]][1]); ctx.closePath();
  }
  for (let k = a; k <= b; k++) {
    if ((k === a && !capA) || (k === b && !capB)) continue;
    const [x, y] = P[k]; ctx.moveTo(x + R[k], y); ctx.arc(x, y, R[k], 0, 2 * Math.PI);
  }
}
/** 选中的水面段 [a, b]：沿两岸各描一道红晕（水面在地形渲染器里，叠加层盖上去就把水染红了） */
function bankHalo(ctx: CanvasRenderingContext2D, P: [number, number][], px: number[], a: number, b: number): void {
  ctx.beginPath();
  for (const side of [1, -1]) for (let k = a; k <= b; k++) {
    const p0 = P[Math.max(a, k - 1)], p1 = P[Math.min(b, k + 1)], dx = p1[0] - p0[0], dy = p1[1] - p0[1], L = Math.hypot(dx, dy) || 1;
    const r = (px[k] / 2 + 1.6) * side, x = P[k][0] - dy / L * r, y = P[k][1] + dx / L * r;
    if (k === a) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.lineWidth = 3.2; ctx.strokeStyle = "rgba(192,57,43,.35)"; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
}
/** 渐隐段切成的小段长（px）：透明度逐小段一档 */
const FADE_STEP = 6;
/** 带逐点宽、宽到画成水面、或首尾落在水里的河。wet[k]＝第 k 段由地形渲染器当水画（null＝一段都不是）：这里跳过，选中时沿两岸描红晕；
    其余段按逐点宽画线（选中红晕、白衬底、河蓝），挨着水面段的那一头不补圆头——线头压在水面上会露出一截白衬底。
    fh / ft 是首 / 尾渐隐的弧长（px，0＝不渐隐），这段里的线淡到 0 */
function drawRiverVar(ctx: CanvasRenderingContext2D, P0: [number, number][], px0: number[], wet: boolean[] | null, fh: number, ft: number, selected: boolean): void {
  /* 弧长、渐隐段细分、逐段透明度；par＝细分后的小段属于原折线的哪一段 */
  const S0 = [0];
  for (let k = 1; k < P0.length; k++) S0.push(S0[k - 1] + Math.hypot(P0[k][0] - P0[k - 1][0], P0[k][1] - P0[k - 1][1]));
  const L = S0[S0.length - 1], alpha = (s: number): number => Math.min(1, fh > 0 ? s / fh : 1, ft > 0 ? (L - s) / ft : 1);
  const P: [number, number][] = [P0[0]], px = [px0[0]], A: number[] = [], par: number[] = [];
  for (let k = 0; k < P0.length - 1; k++) {
    const s0 = S0[k], s1 = S0[k + 1], fade = (fh > 0 && s0 < fh) || (ft > 0 && s1 > L - ft), m = fade ? Math.max(1, Math.ceil((s1 - s0) / FADE_STEP)) : 1;
    for (let t = 1; t <= m; t++) {
      const u = t / m, uh = (t - 0.5) / m;
      P.push(t === m ? P0[k + 1] : [P0[k][0] + (P0[k + 1][0] - P0[k][0]) * u, P0[k][1] + (P0[k + 1][1] - P0[k][1]) * u]);
      px.push(px0[k] + (px0[k + 1] - px0[k]) * u);
      A.push(fade ? Math.max(0, alpha(s0 + (s1 - s0) * uh)) : 1); par.push(k);
    }
  }
  const n = P.length, wetAt = (j: number): boolean => !!wet && wet[par[j]];
  for (let a = 0; a < n - 1;) {
    let b = a + 1;
    const wt = wetAt(a), whole = A[a] >= 1;
    while (b < n - 1 && wetAt(b) === wt && (A[b] >= 1) === whole) b++;
    if (wt) { if (selected) bankHalo(ctx, P, px, a, b); }
    else if (whole) {
      const capA = a === 0 || !wetAt(a - 1), capB = b === n - 1 || !wetAt(b);
      const fill = (grow: (v: number) => number, col: string): void => { ctx.beginPath(); addRibbon(ctx, P, px.map(v => grow(v) / 2), a, b, capA, capB); ctx.fillStyle = col; ctx.fill("nonzero"); };
      if (selected) fill(v => v + 6.4, "rgba(192,57,43,.35)");
      fill(v => v + Math.min(2.4, v), "rgba(255,255,255,.5)");
      fill(v => v, "#3f7fc4");
    } else for (let k = a; k < b; k++) {   // 线状的渐隐段：逐小段按透明度画
      const piece = (grow: (v: number) => number, col: string, al: number): void => { ctx.beginPath(); addRibbon(ctx, P, px.map(v => grow(v) / 2), k, k + 1, false, false); ctx.globalAlpha = al; ctx.fillStyle = col; ctx.fill("nonzero"); };
      const g0 = ctx.globalAlpha;
      if (selected) piece(v => v + 6.4, "rgba(192,57,43,.35)", g0 * A[k]);
      piece(v => v + Math.min(2.4, v), "rgba(255,255,255,.5)", g0 * A[k]);
      piece(v => v, "#3f7fc4", g0 * A[k]);
      ctx.globalAlpha = g0;
    }
    a = b;
  }
}
function strokeRiver(ctx: CanvasRenderingContext2D, pts: [number, number][], wpx: number, selected: boolean, dash?: number[] | null): void {
  const stroke = (w: number, col: string) => {
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    ctx.lineWidth = w; ctx.strokeStyle = col; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
  };
  if (selected) stroke(wpx + 6.4, "rgba(192,57,43,.35)");
  stroke(wpx + Math.min(2.4, wpx), "rgba(255,255,255,.5)");   // 细河的白衬底跟着收：一像素的线配满宽衬底只剩一道白边
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
  byId: Map<string, WorldNode>, e: Edge, st: { color: string; w: number }, selected: boolean, dash: number[] | null, wet: ((lon: number, lat: number) => boolean) | null, rv: TerrainRivers | undefined): void {
  if (e.type === "river" && Array.isArray(e.pts) && e.pts.length >= 2) {   // 自由画河：沿自身折线（Chaikin 柔化），无端点
    const sh = riverShape(meta, cam, e), pp = projectSeq(cam, sh.pts);
    if (offscreenPts(pp, cam)) return;
    /* 首尾落在水里的那一头（水格，或地形渲染器画成水面的别的河），原始折线的末段整段渐隐（画面岸线另有域扭曲与分块，不硬截） */
    const m = e.pts.length, q = projectSeq(cam, [e.pts[0], e.pts[1], e.pts[m - 2], e.pts[m - 1]]);
    const fh = wet && wet(e.pts[0][0], e.pts[0][1]) ? Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) : 0;
    const ft = wet && wet(e.pts[m - 1][0], e.pts[m - 1][1]) ? Math.hypot(q[3][0] - q[2][0], q[3][1] - q[2][1]) : 0;
    /* 地形渲染器当水画的段（确证的自由折线河，rivers.riverSet 同门）：与它比同一个门槛，两端较窄的那头过门槛才算 */
    const wseg = rv && !dash ? sh.g.slice(1).map((g, k) => Math.min(sh.g[k], g) >= rv.thr) : null;
    /* 没有逐点宽、窄于水面门槛、两头都不在水里的照旧三层描边（旧样式逐位不变）；有可靠性虚线的也照旧——水面与渐隐都表达不了虚线 */
    if (dash || (!Array.isArray(e.ws) && !fh && !ft && !sh.tp.some(v => v >= RIVER_WATER_PX))) strokeRiver(ctx, pp, riverWpx(meta, cam, e), selected, dash);
    else drawRiverVar(ctx, pp, sh.px, wseg && wseg.some(Boolean) ? wseg : null, fh, ft, selected);
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
    可靠性（柱B）：逐边 save/restore 施 alpha 与虚线——确证＝dash null + alpha 1 ＝旧渲染逐位。
    rv＝地形渲染器本帧当水画的河（renderer.terrainOpts 给的那一份；缺省＝没画，宽河也画成线） */
export function drawEdges(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined,
  world: World, yearNow: number, byId: Map<string, WorldNode>,
  layers: Record<string, boolean>, edgeSelIdx: number | null | undefined, grid: Grid | undefined, rv?: TerrainRivers): void {
  const on = (id: string) => layers[id] !== false;
  const wet = grid || rv ? (lon: number, lat: number): boolean => {   // 河的首尾落在水里（湖、海、画的盆里成的湖、画成水面的干流）：那一头渐隐
    const c = grid ? Math.floor((lon - grid.bb.lonMin) / grid.step) : -1, r = grid ? Math.floor((lat - grid.bb.latMin) / grid.step) : -1;
    if (grid && c >= 0 && r >= 0 && c < grid.cols && r < grid.rows && waterMask(grid)[r * grid.cols + c] === 1) return true;
    return !!rv && riverSD(rv.set, lon, lat, rv.thr) < 0;
  } : null;
  for (let idx = 0; idx < world.edges.length; idx++) {
    const e = world.edges[idx];
    if (!on(e.type) || !activeAt(e, yearNow)) continue;
    const st = tget(EDGE_STYLE, e.type); if (!st) continue;   // 未知线型不画——pickEdge 同门（拾取绘制同源）
    const cs = certaintyStyle(e.certainty, "edge");
    ctx.save();
    ctx.globalAlpha *= cs.alpha;
    strokeEdge(ctx, cam, meta, byId, e, st, edgeSelIdx === idx, cs.dash, wet, rv);
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
