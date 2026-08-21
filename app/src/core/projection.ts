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
  if (!isFinite(lon0)) lon0 = 0;   // 坏档守卫：NaN 穿透 max/min 钳制、±Infinity 让经度折返死循环——非有限一律归零
  if (!isFinite(lat0)) lat0 = 0;
  if (m.worldModel === "flat") {
    const bb: BBox = m.bbox || { lonMin: -180, lonMax: 180, latMin: -85, latMax: 85 };
    const sx = (bb.lonMax - bb.lonMin) * 0.75, sy = (bb.latMax - bb.latMin) * 0.75;
    lon0 = Math.max(bb.lonMin - sx, Math.min(bb.lonMax + sx, lon0));
    lat0 = Math.max(bb.latMin - sy, Math.min(bb.latMax + sy, lat0));
    return { lon0, lat0, wrapShift: 0 };
  }
  lat0 = Math.max(-85, Math.min(85, lat0));
  let s = 0;
  if (Math.abs(lon0) > 1e9) lon0 = 0;   // 亿度开外＝坏档：归零重来。旧 while±360 对其线性冻页（3.6e10≈亿次循环）甚至浮点不动点死循环（1e300-360===1e300），wrapShift 也不携带天文数
  else if (lon0 >= 180 || lon0 < -180) {
    const k = 360 * Math.floor((lon0 + 180) / 360);   // O(1) 预折返（≤1e9 全程精确）；floor 刀口残差至多一圈交下方 while——与旧逐圈递减逐位一致（黄金基准锁定）
    s -= k; lon0 -= k;
  }
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

/* —— 放大到底：按**比例尺档位**定（2026-08-20 用户点单）——
   战术图停在「500 m」档、战略图停在「50 km」档。口径与画面左下的比例尺同源：读数恒＝
   degPerPx × 每度公里（投影里两处 cos 正好抵消，故与视中心纬度无关），于是「让比例尺停在
   X 档」可精确反算成 dpp = X / (SCALE_BAR_PX × 每度公里)。
   ⚠ 固定档位对中小战略图会翻车：3°×3°（≈330km）那样的图，「50km 档」比全图整屏还粗 ⇒ 放大
   极限落在缩小极限之外，相机被钉死在一个尺度上（既缩不到整屏也放不大）。故配一道**小图护栏**：
   任何图都至少保证 MIN_ZOOM_RANGE 倍可放大（用户拍板 10 倍≈14 档滚轮）。最内层仍是物理地板
   minDegPerPx，防手编档给出极端的每度公里。 */
export const SCALE_BAR_PX = 110;                              // 比例尺条的目标宽度：drawScaleBar 与本规则的单一真源
export const SCALE_FLOOR_KM = { tactical: 0.5, strategic: 50 };
export const MIN_ZOOM_RANGE = 10;
/** 放大到底（最小 度/像素）。fitDpp＝该图「全图恰好整屏」的度/像素（外壳按 bbox 与画布算）。
    ⚠ 传纯 fit：不含 meta.view.degPerPx0 那半句——它是存档里的自由数值，手编一个大的会连带把
    放大这一头也放松。fitDpp 非正/非有限＝当没有图幅，只按档位与物理地板定。 */
export function minDppFor(meta: Meta | undefined, fitDpp: number): number {
  const phys = minDegPerPx(meta), k = kmPerDegLat(meta);
  if (!(isFinite(k) && k > 0)) return phys;
  const floorKm = (meta || {}).mapKind === "tactical" ? SCALE_FLOOR_KM.tactical : SCALE_FLOOR_KM.strategic;
  const byScale = floorKm / (SCALE_BAR_PX * k);
  const guard = (isFinite(fitDpp) && fitDpp > 0) ? fitDpp / MIN_ZOOM_RANGE : byScale;
  return Math.max(phys, Math.min(byScale, guard));
}

/** 数据坐标经度归一（球面 [-180,180)；平面原样）——渲染/拾取共用 */
export function wrapLonData(l: number, meta: Meta | undefined): number {
  return wrapLon(l, (meta || {}).worldModel === "flat");
}

export interface ViewState { lon0: number; lat0: number; degPerPx: number }

/* 缩放到光标（滚轮/双击）：保持光标下经纬度不动；缩放钳在 [minDpp, maxDpp]。
   ⚠ 两头都**必填**（同「参数可选＋内部兜底常数一律改必填」之训）：缩小到底＝全图恰好整屏、
   放大到底＝minDppFor 的比例尺档位，两条规则各有出处，此处只管钳。 */
export function zoomAtView(
  view: ViewState, meta: Meta | undefined, w: number, h: number, x: number, y: number, f: number,
  maxDpp: number, minDpp: number
): ViewState & { wrapShift: number } {
  const flat = (meta || {}).worldModel === "flat";
  const cam: Camera = { lon0: view.lon0, lat0: view.lat0, degPerPx: view.degPerPx, w, h, flat };
  const before = unproject(cam, x, y);
  const dpp = Math.max(minDpp, Math.min(maxDpp, view.degPerPx * f));
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
