/* 图幅（图廓以内）：地图只在这里有内容，图廓外是纸。
   判据只有本文件一处——遮罩、图廓线、拾取门、落点钳制、相机取景都从这里取，各写各的就是「画的和点的不是一回事」。 */
import { toRad, wrapLon } from "./geo.ts";
import { project, visibleWorldCopies, VIEW_LAT_MAX, type Camera, type ViewState } from "./projection.ts";
import { DEFAULT_BBOX, type Meta } from "./types.ts";

/** 图幅范围。sphere＝球面（经度按 360° 周期比较）；wrap＝球面且经跨满 360°，经向无边、只有上下两条图廓 */
export interface Frame {
  lonMin: number; lonMax: number; latMin: number; latMax: number;
  sphere: boolean; wrap: boolean;
}

/** 屏幕上的一块图幅（CSS 像素，y0 在上）；wrap 图的 x0/x1 为 ∓Infinity */
export interface FrameRect { x0: number; y0: number; x1: number; y1: number }

/** 贴边容差（度）：存档坐标是四位小数，钳到图廓上的点舍入后可能出去半个末位，不能因此判到图外 */
const EPS = 1e-4;

/** 图廓离视口边至多这么多（占视口宽 / 高的比例）；图幅装得下时不用它，直接居中 */
export const FRAME_SLACK = 0.25;

/** 缺 bbox 与网格同取 DEFAULT_BBOX——图廓与地形用两个缺省就是两个框 */
export function mapFrame(meta: Meta | undefined): Frame {
  const m = meta || {}, bb = m.bbox || DEFAULT_BBOX;
  const sphere = m.worldModel !== "flat";
  return { lonMin: bb.lonMin, lonMax: bb.lonMax, latMin: bb.latMin, latMax: bb.latMax,
    sphere, wrap: sphere && bb.lonMax - bb.lonMin >= 360 - EPS };
}

/** 经度相对 lonMin 的偏移，球面折进 [0, 360) */
function lonOffset(f: Frame, lon: number): number {
  const u = lon - f.lonMin;
  return f.sphere ? ((u % 360) + 360) % 360 : u;
}

export function inFrame(f: Frame, lon: number, lat: number): boolean {
  if (!(lat >= f.latMin - EPS && lat <= f.latMax + EPS)) return false;
  if (f.wrap) return true;
  const u = lonOffset(f, lon);
  return (u >= -EPS && u <= f.lonMax - f.lonMin + EPS) || (f.sphere && u >= 360 - EPS);
}

/** 钳进图幅：纬度夹到上下图廓；经度夹到最近的那条经向图廓（球面按 360° 周期取近的一侧，结果折回 [-180,180)） */
export function clampToFrame(f: Frame, lon: number, lat: number): [number, number] {
  const la = Math.max(f.latMin, Math.min(f.latMax, lat));
  if (f.wrap || inFrame(f, lon, la)) return [lon, la];
  if (!f.sphere) return [Math.max(f.lonMin, Math.min(f.lonMax, lon)), la];
  const past = lonOffset(f, lon) - (f.lonMax - f.lonMin);   // 越过东图廓多少度；绕到西图廓还差 360−偏移
  return [wrapLon(past <= 360 - lonOffset(f, lon) ? f.lonMax : f.lonMin, false), la];
}

/** 一个轴上的取景：图幅装得下就居中；装不下时图廓边至多进到视口内 slack（单位与 c 同为度） */
function fitAxis(c: number, lo: number, hi: number, half: number, slack: number): number {
  if (hi - lo <= 2 * half) return (lo + hi) / 2;
  return Math.max(lo + half - slack, Math.min(hi - half + slack, c));
}

/** 相机取景：在 clampView 之后调。w/h＝可见区 CSS 像素；球面结果经度折回 [-180,180)、纬度守 ±VIEW_LAT_MAX */
export function frameView(view: ViewState, meta: Meta | undefined, w: number, h: number): { lon0: number; lat0: number } {
  const f = mapFrame(meta), dpp = view.degPerPx;
  let lat0 = fitAxis(view.lat0, f.latMin, f.latMax, h / 2 * dpp, FRAME_SLACK * h * dpp);
  if (f.sphere) lat0 = Math.max(-VIEW_LAT_MAX, Math.min(VIEW_LAT_MAX, lat0));
  if (f.wrap) return { lon0: view.lon0, lat0 };
  const k = f.sphere ? Math.cos(toRad(lat0)) : 1;
  const half = w / 2 * dpp / k, slack = FRAME_SLACK * w * dpp / k;
  if (!f.sphere) return { lon0: fitAxis(view.lon0, f.lonMin, f.lonMax, half, slack), lat0 };
  const s = 360 * Math.round((view.lon0 - (f.lonMin + f.lonMax) / 2) / 360);   // 离视中心最近的那份图幅拷贝
  return { lon0: wrapLon(fitAxis(view.lon0 - s, f.lonMin, f.lonMax, half, slack) + s, false), lat0 };
}

/** 视口里每份图幅拷贝的屏幕矩形（拷贝与叠加层的世界拷贝循环同判：visibleWorldCopies） */
export function frameRectsPx(cam: Camera, meta: Meta | undefined): FrameRect[] {
  const f = mapFrame(meta);
  const y0 = project(cam, f.lonMin, f.latMax)[1], y1 = project(cam, f.lonMin, f.latMin)[1];
  if (f.wrap) return [{ x0: -Infinity, y0, x1: Infinity, y1 }];
  return visibleWorldCopies(cam, meta).map(s => {
    const c: Camera = { ...cam, lonShift: s };
    return { x0: project(c, f.lonMin, f.latMin)[0], y0, x1: project(c, f.lonMax, f.latMin)[0], y1 };
  });
}
