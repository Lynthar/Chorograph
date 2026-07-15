/* 平面几何小件：射线法点在多边形内 / Andrew 单调链凸包 / Chaikin 折线平滑 / 河流曲流。
   坐标一律 [x,y]（经纬度或屏幕像素均可）。 */
import { distKm } from "./geo.ts";
import type { Meta } from "./types.ts";

export type Pt = [number, number];

/* —— 河流曲流（对齐旧 hashSeed/meander/edgeLenKm）：两端点间 14 段、垂向正弦振幅的确定性弯曲——
   渲染画折线、信息卡量沿线长共用同一条曲线，seed=from+to 保证同一条河永远同形。 */
export function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973;
  return h;
}
export function meander(a: { lon: number; lat: number }, b: { lon: number; lat: number }, seed: string): Pt[] {
  const N = 14, pts: Pt[] = [];
  const dx = b.lon - a.lon, dy = b.lat - a.lat, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len, ph = hashSeed(seed);
  for (let i = 0; i <= N; i++) {
    const t = i / N, amp = Math.sin(t * Math.PI) * len * 0.14 * Math.sin(t * 6 + ph);
    pts.push([a.lon + dx * t + nx * amp, a.lat + dy * t + ny * amp]);
  }
  return pts;
}
/** 连线沿线长 km：河流按曲流折线累加（含曲流），其余按两端直线 */
export function edgeLenKm(
  meta: Meta | undefined,
  a: { lon: number; lat: number }, b: { lon: number; lat: number },
  type: string, seed: string
): number {
  if (type === "river") {
    const pts = meander(a, b, seed);
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += distKm(meta, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    return s;
  }
  return distKm(meta, a.lon, a.lat, b.lon, b.lat);
}
/** 折线沿线长 km（自由画河道等自由折线）：逐段累加大圆里程 */
export function polylineKm(meta: Meta | undefined, pts: [number, number][]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += distKm(meta, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  return s;
}

/** 射线法：点是否在多边形内 */
export function pointInPoly(x: number, y: number, pts: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = true;
  }
  return c;
}

/** Andrew 单调链凸包（<3 点原样返回副本） */
export function convexHull(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Pt[] = [];
  for (const pt of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], pt) <= 0) lo.pop(); lo.push(pt); }
  const up: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) { const pt = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], pt) <= 0) up.pop(); up.push(pt); }
  lo.pop(); up.pop();
  return lo.concat(up);
}

/** 折线简化（Ramer–Douglas–Peucker，度空间；逐字对齐旧 rdp）。
   eps=容差：离首末弦距 ≤ eps 的中间点全部丢弃，否则以最远点递归分治。
   只作用于新手绘作战线，不触旧存档几何。 */
export function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  let dmax = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    let t = ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / L2; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(pts[i][0] - (ax + dx * t), pts[i][1] - (ay + dy * t));
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [pts[0], pts[pts.length - 1]];
  return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
}

/** Chaikin 闭环平滑：每轮把每条边切成 1/4–3/4 两点 */
export function chaikin(loop: Pt[], it: number): Pt[] {
  for (; it > 0; it--) {
    const out: Pt[] = [];
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25],
               [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    loop = out;
  }
  return loop;
}

/** Chaikin 开折线平滑（端点固定、不闭合）：河道等开放折线用；<3 点原样返回（无内部转角可切） */
export function chaikinOpen(pts: Pt[], it: number): Pt[] {
  for (; it > 0 && pts.length >= 3; it--) {
    const out: Pt[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25],
               [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}
