/* 投影：经纬度 ↔ 屏幕像素（等距圆柱变体；平面世界 cos=1，球面按视中心纬度校正 + 经度环绕）。
   旧实现读全局 state.view/canvas/DPR——这里全部参数化为 Camera（尺寸取 CSS 像素）。 */
import { kmPerDegLat, toRad, wrapLon } from "./geo.ts";
import type { BBox, Meta } from "./types.ts";

export interface Camera {
  lon0: number; lat0: number;   // 视中心
  degPerPx: number;             // 缩放（度/像素）
  w: number; h: number;         // 视口 CSS 像素
  flat: boolean;                // 平面世界（cos=1，无环绕）
  lonShift?: number;            // 球面环绕：当前绘制拷贝的经度偏移(0/±360)
}

export function viewCosK(cam: Pick<Camera, "flat" | "lat0">): number {
  return cam.flat ? 1 : Math.cos(toRad(cam.lat0));
}

export function project(cam: Camera, lon: number, lat: number): [number, number] {
  const k = 1 / cam.degPerPx;
  const cx = cam.w / 2, cy = cam.h / 2;
  const cosk = viewCosK(cam);
  return [cx + (lon + (cam.lonShift || 0) - cam.lon0) * k * cosk, cy - (lat - cam.lat0) * k];
}

export function unproject(cam: Camera, x: number, y: number): [number, number] {
  const k = 1 / cam.degPerPx;
  const cx = cam.w / 2, cy = cam.h / 2;
  const cosk = viewCosK(cam);
  return [cam.lon0 + (x - cx) / (k * cosk), cam.lat0 - (y - cy) / k];
}

/* 环绕连续折线投影：逐点取与前一点的最短经差，跨±180°的线不再横穿全屏 */
export function projectSeq(cam: Camera, arr: ({ lon: number; lat: number } | [number, number])[]): [number, number][] {
  const k = 1 / cam.degPerPx, cosk = viewCosK(cam), flat = cam.flat;
  const out: [number, number][] = [];
  let px: number | null = null, prevLon = 0;
  arr.forEach(p => {
    const lon = (p as { lon?: number }).lon != null ? (p as { lon: number }).lon : (p as [number, number])[0];
    const lat = (p as { lat?: number }).lat != null ? (p as { lat: number }).lat : (p as [number, number])[1];
    if (px === null) { px = project(cam, lon, lat)[0]; }
    else {
      let d = lon - prevLon; if (!flat) d = ((d + 180) % 360 + 360) % 360 - 180;
      px += d * k * cosk;
    }
    prevLon = lon;
    out.push([px, project(cam, lon, lat)[1]]);
  });
  return out;
}

/* 视角约束：球面=纬度限±85°+经度环绕；平面=限制在世界范围附近（有边界）。
   纯函数版：返回新的 lon0/lat0 与本次环绕产生的经度平移量 wrapShift
  （旧实现在拖拽中用它同步拖拽原点，避免跳变——由调用方处理）。 */
export function clampView(
  view: { lon0: number; lat0: number }, meta: Meta | undefined
): { lon0: number; lat0: number; wrapShift: number } {
  const m = meta || {};
  let { lon0, lat0 } = view;
  if (m.worldModel === "flat") {
    const bb: BBox = m.bbox || { lonMin: -180, lonMax: 180, latMin: -85, latMax: 85 };
    const sx = (bb.lonMax - bb.lonMin) * 0.75, sy = (bb.latMax - bb.latMin) * 0.75;
    lon0 = Math.max(bb.lonMin - sx, Math.min(bb.lonMax + sx, lon0));
    lat0 = Math.max(bb.latMin - sy, Math.min(bb.latMax + sy, lat0));
    return { lon0, lat0, wrapShift: 0 };
  }
  lat0 = Math.max(-85, Math.min(85, lat0));
  let s = 0;
  while (lon0 >= 180) { lon0 -= 360; s -= 360; }
  while (lon0 < -180) { lon0 += 360; s += 360; }
  return { lon0, lat0, wrapShift: s };
}

/* 球面环绕：算出世界的哪些 ±360° 拷贝落在视口内（跨±180°经线时同时画两份） */
export function visibleWorldCopies(cam: Camera, meta: Meta | undefined): number[] {
  const m = meta || {};
  if (m.worldModel === "flat" || !m.bbox) return [0];
  const tl = unproject(cam, 0, 0), br = unproject(cam, cam.w, 0);
  const out: number[] = [];
  for (let k = -2; k <= 2; k++) {
    const s = k * 360;
    if (m.bbox.lonMin + s <= br[0] + 3 && m.bbox.lonMax + s >= tl[0] - 3) out.push(s);
  }
  return out.length ? out : [0];
}

/* 缩放下限随世界尺度自适应：放大到底≈5 m/像素；星球半径改了自动跟着变 */
export function minDegPerPx(meta: Meta | undefined): number {
  const k = kmPerDegLat(meta);
  return (isFinite(k) && k > 0) ? Math.max(1e-6, 0.005 / k) : 0.004;
}

/** 数据坐标经度归一（球面 [-180,180)；平面原样）——渲染/拾取共用 */
export function wrapLonData(l: number, meta: Meta | undefined): number {
  return wrapLon(l, (meta || {}).worldModel === "flat");
}

export interface ViewState { lon0: number; lat0: number; degPerPx: number }

/* 缩放到光标（滚轮/双击）：保持光标下经纬度不动；缩放限 [minDegPerPx, maxDpp]。
   maxDpp＝缩放下限（最大 度/像素），缺省 0.5（平价锁定不破）；外壳按 bbox/画布算「全图恰好整屏」值传入。 */
export function zoomAtView(
  view: ViewState, meta: Meta | undefined, w: number, h: number, x: number, y: number, f: number, maxDpp = 0.5
): ViewState & { wrapShift: number } {
  const flat = (meta || {}).worldModel === "flat";
  const cam: Camera = { lon0: view.lon0, lat0: view.lat0, degPerPx: view.degPerPx, w, h, flat };
  const before = unproject(cam, x, y);
  const dpp = Math.max(minDegPerPx(meta), Math.min(maxDpp, view.degPerPx * f));
  const after = unproject({ ...cam, degPerPx: dpp }, x, y);
  const cl = clampView({ lon0: view.lon0 + before[0] - after[0], lat0: view.lat0 + before[1] - after[1] }, meta);
  return { lon0: cl.lon0, lat0: cl.lat0, degPerPx: dpp, wrapShift: cl.wrapShift };
}

/* 键盘/惯性平移：dx/dy 为步数（每步 90px），经度按视中心纬度做 cos 校正 */
export function panByView(
  view: ViewState, meta: Meta | undefined, dx: number, dy: number
): ViewState & { wrapShift: number } {
  const step = 90 * view.degPerPx;
  const cosk = (meta || {}).worldModel === "flat" ? 1 : Math.cos(toRad(view.lat0));
  const cl = clampView({ lon0: view.lon0 + dx * step / cosk, lat0: view.lat0 - dy * step }, meta);
  return { lon0: cl.lon0, lat0: cl.lat0, degPerPx: view.degPerPx, wrapShift: cl.wrapShift };
}
