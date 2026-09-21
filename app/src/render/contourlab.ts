/* 等高线注记（计曲线上的高程数字，2026-09-15 P2）：
   纯几何——规则场制图面按屏幕子网格取样 → marching squares 链成折线 → 每隔若干像素在曲率最小处定位；
   绘制——恒正立、纸色描边压线、走标签避让场**最后**占位（让地名、部队与标高点）。
   数字＝制图面高程取整＝与光标读数同一个数；线本身也画在同一面上（§9.15），故图内自洽。
   ⚠ 角态表与 render/maskraster 共用一份（MS_CASES）：maskContour 出的是散段（描 Path2D 够用），
   注记要按弧长走线、按曲率挑位，故此处把散段链成折线。 */
import { elevSmooth, elevUnitM, waterSurface, type ElevField } from "../core/elev.ts";
import { project, unproject, type Camera } from "../core/projection.ts";
import type { Grid } from "../core/grid.ts";
import type { BBox, Meta } from "../core/types.ts";
import type { LabelField } from "./labels.ts";
import { MS_CASES } from "./maskraster.ts";

/** 采样子网格步长（CSS px）· 同一条线上两枚注记的目标间距 · 短于此不标 · 量直度的跨度（≈数字宽）· 缓存区域每边外扩比例 */
export const LAB_SAMPLE_PX = 7, LAB_SPACING_PX = 340, LAB_MIN_LEN_PX = 110, LAB_SPAN_PX = 30, LAB_MARGIN = 0.15;
/** 可见区域内注记等高线的条数上限（超了按整数倍抽稀）· 落点离真等值线的容差（CSS px，超了弃标） */
export const LAB_MAX_LEVELS = 12, LAB_SNAP_PX = 1.5;

/** 采样面：w×h 个高程样点（抽象单位），行 0 在上；NaN＝水或图幅外，该格不出线（判据同渲染器的等高线门） */
export interface LabSurf { w: number; h: number; v: Float32Array }

/** 注记的等高距（抽象单位）：默认标计曲线（5×首曲线）；可见区域内不足两条时改标首曲线，过密时按整数倍抽稀。
    ⚠ 三种结果都是首曲线等距的整数倍——注记必须落在**画出来的**线上，否则数字旁边没有线。 */
export function labStepFor(spanV: number, base: number): number {
  if (!(base > 0)) return 0;
  const idx = base * 5;
  if (!(spanV > 0)) return idx;
  if (spanV / idx < 2) return base;   // 计曲线不足两条＝数不出来，改标首曲线
  const k = Math.ceil(spanV / idx / LAB_MAX_LEVELS);
  return k > 1 ? idx * k : idx;
}

/** level 等值线的折线集（采样格坐标，每条＝扁平 [x0,y0,x1,y1,…]；闭合环首尾同点）。
    边编号：横边 (x,y)＝(y·w+x)·2、纵边 (x,y)＝(y·w+x)·2+1——同一条边在两格间是同一个整数键，交点由边与 level 唯一决定。 */
export function tracePolylines(s: LabSurf, level: number): number[][] {
  const { w, h, v } = s;
  const link = new Map<number, number[]>();
  const add = (a: number, b: number): void => {
    const la = link.get(a); if (la) la.push(b); else link.set(a, [b]);
    const lb = link.get(b); if (lb) lb.push(a); else link.set(b, [a]);
  };
  for (let y = 0; y + 1 < h; y++) for (let x = 0; x + 1 < w; x++) {
    const a = v[y * w + x], b = v[y * w + x + 1], c = v[(y + 1) * w + x + 1], d = v[(y + 1) * w + x];
    if (!(a === a && b === b && c === c && d === d)) continue;   // 任一角 NaN＝此格不出线
    const segs = MS_CASES[(a >= level ? 8 : 0) | (b >= level ? 4 : 0) | (c >= level ? 2 : 0) | (d >= level ? 1 : 0)];
    if (!segs.length) continue;
    const E = [(y * w + x) * 2, (y * w + x + 1) * 2 + 1, ((y + 1) * w + x) * 2, (y * w + x) * 2 + 1];   // 上 右 下 左
    for (const [p, q] of segs) add(E[p], E[q]);
  }
  /* 交点按边解码：角值跨 level 才会有这条边，故除数非零 */
  const ptOf = (e: number, out: number[]): void => {
    const i = e >> 1, x = i % w, y = (i - x) / w;
    if (e & 1) { const p = v[y * w + x], q = v[(y + 1) * w + x]; out.push(x, y + (level - p) / (q - p)); }
    else { const p = v[y * w + x], q = v[y * w + x + 1]; out.push(x + (level - p) / (q - p), y); }
  };
  const seen = new Set<number>();
  const walk = (start: number): number[] => {
    const pts: number[] = [];
    let cur = start, prev = -1;
    for (;;) {
      seen.add(cur); ptOf(cur, pts);
      const nb = link.get(cur)!;
      let nxt = -1;
      for (const k of nb) if (k !== prev && !seen.has(k)) { nxt = k; break; }
      if (nxt < 0) { if (pts.length > 4 && nb.includes(start)) ptOf(start, pts); break; }   // 回到起点＝闭合环
      prev = cur; cur = nxt;
    }
    return pts;
  };
  const out: number[][] = [];
  for (const [k, nb] of link) if (nb.length === 1 && !seen.has(k)) out.push(walk(k));   // 先从开口端走，链才完整
  for (const k of link.keys()) if (!seen.has(k)) out.push(walk(k));                     // 余下的是闭合环
  return out.filter(p => p.length >= 4);
}

/** 折线上的注记锚点（扁平 [x,y,…]，同折线坐标系）：每 spacing 一枚，在目标弧长附近挑**曲率最小**处；
    短于 minLen 不标。span＝数字占的长度——量直度取 1.5×span（留出余量，否则「刚好绕过折角」也判满分，数字贴着弯处）。
    候选自目标弧长**向两侧**扫：笔直的线上处处满分，同分取最靠近名义间距的那个。 */
export function placeLabels(poly: number[], spacing: number, minLen: number, span: number): number[] {
  const n = poly.length / 2;
  if (n < 2 || !(spacing > 0)) return [];
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(poly[2 * i] - poly[2 * i - 2], poly[2 * i + 1] - poly[2 * i - 1]);
  const len = cum[n - 1];
  if (len < minLen) return [];
  const at = (s: number): [number, number] => {
    let lo = 0, hi = n - 1;
    while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const seg = cum[hi] - cum[lo], t = seg > 0 ? (s - cum[lo]) / seg : 0;
    return [poly[2 * lo] + (poly[2 * hi] - poly[2 * lo]) * t, poly[2 * lo + 1] + (poly[2 * hi + 1] - poly[2 * lo + 1]) * t];
  };
  const cnt = Math.max(1, Math.round(len / spacing));
  const win = Math.min(spacing * 0.35, len * 0.25), stepS = Math.max(span / 8, win / 6), hw = span * 0.75;
  const kMax = Math.floor(win / stepS);
  const out: number[] = [];
  for (let i = 0; i < cnt; i++) {
    const target = len * (i + 0.5) / cnt;
    let best = Infinity, bx = 0, by = 0;
    for (let k = 0; k <= kMax; k++) for (const sgn of (k ? [1, -1] : [1])) {
      const s = target + sgn * k * stepS;
      if (s - hw < 0 || s + hw > len) continue;
      const [ax, ay] = at(s - hw), [mx, my] = at(s), [cx, cy] = at(s + hw);
      const ux = mx - ax, uy = my - ay, vx = cx - mx, vy = cy - my;
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      const score = lu > 0 && lv > 0 ? 1 - (ux * vx + uy * vy) / (lu * lv) : 1;   // 0＝笔直
      if (score < best) { best = score; bx = mx; by = my; }
    }
    if (best < Infinity) out.push(bx, by);
  }
  return out;
}

/* 注记缓存：按（规则场, 世界拷贝偏移）存一份世界锚定的注记表——平移只重投影，故数字不随平移沿线爬动。
   视口出了 region（外扩 LAB_MARGIN）、缩放偏出 ±20%、或等高距换档，才重算。 */
interface LabCache { region: BBox; dpp: number; base: number; items: { lon: number; lat: number; m: number }[] }
const labCache = new WeakMap<ElevField, Map<number, LabCache>>();

/** 屏幕矩形的世界经纬 bbox（扣掉本拷贝的经度偏移＝世界域坐标） */
function worldBox(cam: Camera, x0: number, y0: number, x1: number, y1: number): BBox {
  const sh = cam.lonShift || 0;
  const tl = unproject(cam, x0, y0), br = unproject(cam, x1, y1);
  return { lonMin: tl[0] - sh, lonMax: br[0] - sh, latMin: br[1], latMax: tl[1] };
}

function build(cam: Camera, meta: Meta | undefined, f: ElevField, grid: Grid, base: number): LabCache {
  const mx = cam.w * LAB_MARGIN, my = cam.h * LAB_MARGIN, sh = cam.lonShift || 0;
  const x0 = -mx, y0 = -my;
  const sw = Math.floor((cam.w + 2 * mx) / LAB_SAMPLE_PX) + 1, shh = Math.floor((cam.h + 2 * my) / LAB_SAMPLE_PX) + 1;
  const v = new Float32Array(sw * shh);
  const wsurf = waterSurface(meta, grid), bb = grid.bb, st = grid.step, U = elevUnitM(meta);
  let mn = Infinity, mxv = -Infinity;
  for (let j = 0; j < shh; j++) for (let i = 0; i < sw; i++) {
    const [ul, lat] = unproject(cam, x0 + i * LAB_SAMPLE_PX, y0 + j * LAB_SAMPLE_PX);
    const lon = ul - sh;
    let val = NaN;
    // 图幅内缩一格（同渲染器的裁边：制图面在边缘塌向海）+ 陆格（同 e ≥ ws − 0.02 的水陆判据）
    if (lon > bb.lonMin + st && lon < bb.lonMax - st && lat > bb.latMin + st && lat < bb.latMax - st) {
      const e = elevSmooth(f.data, f, lon, lat);
      const gc = Math.max(0, Math.min(grid.cols - 1, Math.floor((lon - bb.lonMin) / st)));
      const gr = Math.max(0, Math.min(grid.rows - 1, Math.floor((lat - bb.latMin) / st)));
      if (e >= wsurf[gr * grid.cols + gc] - 0.02) { val = e; if (e < mn) mn = e; if (e > mxv) mxv = e; }
    }
    v[j * sw + i] = val;
  }
  const region = worldBox(cam, x0, y0, cam.w + mx, cam.h + my);
  const items: LabCache["items"] = [];
  const step = mn < Infinity ? labStepFor(mxv - mn, base) : 0;
  /* 落点吸附到真等值线：采样格 7 px 上的线性插值在弯坡上能偏一两个像素，而注记要压在线上（数字＝该处读数）。
     牛顿沿梯度走四步、每步钳 3 px；**残差按像素判**（除以梯度）——按米判在陡坡上会错杀（1 px 就值几十米）、
     在平台上又放行离线几十像素的落点。留不下就弃标，不给个飘在空处的数字。 */
  const snap = (lon0: number, lat0: number, level: number): [number, number] | null => {
    const dx = cam.degPerPx / (cam.flat ? 1 : Math.cos(lat0 * Math.PI / 180)), dy = cam.degPerPx;
    let lon = lon0, lat = lat0, e = elevSmooth(f.data, f, lon, lat), g = 0;
    for (let it = 0; it < 4; it++) {
      const ex = (elevSmooth(f.data, f, lon + dx, lat) - elevSmooth(f.data, f, lon - dx, lat)) / 2;
      const ey = (elevSmooth(f.data, f, lon, lat + dy) - elevSmooth(f.data, f, lon, lat - dy)) / 2;
      g = Math.hypot(ex, ey);
      if (!(g > 0) || e === level) break;
      const t = Math.max(-3, Math.min(3, (level - e) / g)) / g;   // 步长按像素钳
      lon += t * ex * dx; lat += t * ey * dy;
      e = elevSmooth(f.data, f, lon, lat);
    }
    return g > 0 && Math.abs(e - level) / g <= LAB_SNAP_PX ? [lon, lat] : null;
  };
  if (step > 0) {
    const surf: LabSurf = { w: sw, h: shh, v };
    const sp = LAB_SPACING_PX / LAB_SAMPLE_PX, ml = LAB_MIN_LEN_PX / LAB_SAMPLE_PX, spn = LAB_SPAN_PX / LAB_SAMPLE_PX;
    for (let k = Math.ceil(mn / step - 1e-9); k * step <= mxv; k++) {
      const level = k * step, m = Math.round(level * U);
      for (const poly of tracePolylines(surf, level)) {
        const pos = placeLabels(poly, sp, ml, spn);
        for (let t = 0; t + 1 < pos.length; t += 2) {
          const [ul, lat] = unproject(cam, x0 + pos[t] * LAB_SAMPLE_PX, y0 + pos[t + 1] * LAB_SAMPLE_PX);
          const fix = snap(ul - sh, lat, level);
          if (fix) items.push({ lon: fix[0], lat: fix[1], m });
        }
      }
    }
  }
  return { region, dpp: cam.degPerPx, base, items };
}

/** 画本拷贝的等高线注记：base＝渲染器这一帧用的等距（抽象单位，renderer.contourStepOf），不在此另算；避让场撞位即弃标。 */
export function drawContourLabels(
  ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined,
  f: ElevField, grid: Grid, lf: LabelField, base: number
): void {
  if (!(base > 0)) return;
  let byShift = labCache.get(f);
  if (!byShift) labCache.set(f, byShift = new Map());
  const sh = cam.lonShift || 0;
  const vb = worldBox(cam, 0, 0, cam.w, cam.h);
  let c = byShift.get(sh);
  if (!c || c.base !== base || cam.degPerPx > c.dpp * 1.2 || cam.degPerPx < c.dpp / 1.2
    || !(c.region.lonMin <= vb.lonMin && c.region.lonMax >= vb.lonMax && c.region.latMin <= vb.latMin && c.region.latMax >= vb.latMax)) {
    byShift.set(sh, c = build(cam, meta, f, grid, base));
  }
  if (!c.items.length) return;
  ctx.save();
  ctx.font = "10px sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "center";
  ctx.lineJoin = "round"; ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(246,239,220,.92)"; ctx.fillStyle = "rgba(90,70,40,.95)";
  for (const it of c.items) {
    const [x, y] = project(cam, it.lon, it.lat);
    if (x < -40 || y < -10 || x > cam.w + 40 || y > cam.h + 10) continue;
    const txt = String(it.m), w = ctx.measureText(txt).width;
    if (!lf.tryPlace({ x: x - w / 2 - 1, y: y - 6, w: w + 2, h: 12 })) continue;
    ctx.strokeText(txt, x, y); ctx.fillText(txt, x, y);   // 纸色描边压线，再落墨色数字
  }
  ctx.restore();
}
