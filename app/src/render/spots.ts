/* 标高点绘制：峰表（shell/spots 在 Worker 里算）按（半窗, 突出度门槛）选点并缓存，水面按 grid 缓存；
   走标签避让场**最后**占位（让地名与部队）。数字＝制图面高程取整（与光标读数同一个数）；水面前缀「水面」。 */
import { pickPeaks, waterSpots, type PeakTable, type SpotHeight, type SpotTable } from "../core/spots.ts";
import { contourFloorM, elevUnitM, waterSurface } from "../core/elev.ts";
import { kmPerDegXY } from "../core/geo.ts";
import { EDGE_STYLE } from "../core/constants.ts";
import { project, type Camera } from "../core/projection.ts";
import type { Grid } from "../core/grid.ts";
import type { Meta } from "../core/types.ts";
import type { LabelField } from "./labels.ts";

/** 选点半窗（屏幕 px）：窗按像素＝缩放自动调密度。只标海拔 ≥ SPOT_MIN_M 的山顶（2026-09-14 用户点单）；水面不受这道门管 */
export const SPOT_WIN_PX = 72, SPOT_MIN_M = 500;
/** 山顶地面间距下限（km）：再近的两座只标更显著的一座，放大也不拆开（用户拍板） */
export const SPOT_SEP_KM = 2;
/** 同值水面的合并距离（km）：水面相同且标点相距更近的不连通水体只标最大一块（用户拍板） */
export const SPOT_WATER_SEP_KM = 30;
/** 三角点记号（顶角朝上）的半宽 px */
const TRI_PX = 3.5;
/** 字样：山顶 10 px 褐；水面 11 px、取河流的水色（湖面高程是水的属性，不画点位）——用户拍板 */
const PEAK_FONT = "10px sans-serif", PEAK_INK = "rgba(70,52,28,.95)", WATER_FONT = "11px sans-serif", WATER_INK = EDGE_STYLE.river.color;
/** 每张峰表保留的（窗, 门槛）选点结果数：连续缩放一段路够用，超过就挤掉最老的 */
const PICK_CACHE_MAX = 32;

const pickCache = new WeakMap<PeakTable, Map<string, SpotHeight[]>>();
const waterCache = new WeakMap<Grid, SpotHeight[]>();

/** 山顶门槛＝本帧等高距（突出度不到一个等距的起伏在线上画不出闭合圈）；地形层关着（cstep=0）时取本图最细等高距。
    lines＝等高线画着：此时显示值恰为等距整数倍的山顶不标（数字与线重复）。 */
export function drawSpotHeights(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined, tab: SpotTable | null, grid: Grid, lf: LabelField, cstep: number, lines: boolean): void {
  const U = elevUnitM(meta);
  let peaks: SpotHeight[] = [];
  if (tab) {
    const f = tab.f, win = Math.max(2, Math.round(SPOT_WIN_PX * cam.degPerPx / f.step));   // 半窗格数＝像素窗 × 度/px ÷ 度/格
    const minProm = cstep > 0 ? cstep : contourFloorM(meta) / U, lineM = lines && cstep > 0 ? cstep * U : 0, key = `${win}:${minProm}:${lineM}`;
    let byKey = pickCache.get(tab.t);
    if (!byKey) pickCache.set(tab.t, byKey = new Map());
    const hit = byKey.get(key);
    if (hit) peaks = hit;
    else {
      const { kmx, kmy } = kmPerDegXY(meta, f.bb);
      byKey.set(key, peaks = pickPeaks(tab.t, f, { minProm, minE: (SPOT_MIN_M - 0.5) / U, win, sepC: SPOT_SEP_KM / (f.step * kmx), sepR: SPOT_SEP_KM / (f.step * kmy), lineM, unitM: U }));
      if (byKey.size > PICK_CACHE_MAX) byKey.delete(byKey.keys().next().value!);
    }
  }
  let water = waterCache.get(grid);
  if (!water) waterCache.set(grid, water = waterSpots(grid, waterSurface(meta, grid), kmPerDegXY(meta, grid.bb), SPOT_WATER_SEP_KM));
  ctx.save();
  ctx.textBaseline = "middle"; ctx.textAlign = "left";
  ctx.lineJoin = "round"; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(246,239,220,.85)";
  for (const s of [...peaks, ...water]) {
    const eM = Math.round(s.e * U);
    const [x, y] = project(cam, s.lon, s.lat);
    if (x < -60 || y < -12 || x > cam.w + 60 || y > cam.h + 12) continue;
    const peak = s.kind === "peak", txt = (peak ? "" : "水面 ") + eM;
    ctx.font = peak ? PEAK_FONT : WATER_FONT; ctx.fillStyle = peak ? PEAK_INK : WATER_INK;
    const w = ctx.measureText(txt).width, tx = peak ? x + TRI_PX + 3 : x - w / 2, h = peak ? 12 : 13;
    if (!lf.tryPlace({ x: peak ? x - TRI_PX - 1 : tx - 1, y: y - h / 2, w: (peak ? TRI_PX + 4 : 0) + w + 2, h })) continue;
    if (peak) {   // 三角点：顶角朝上，纸色描边衬底
      ctx.beginPath(); ctx.moveTo(x, y - TRI_PX * 1.15); ctx.lineTo(x + TRI_PX, y + TRI_PX * 0.85); ctx.lineTo(x - TRI_PX, y + TRI_PX * 0.85); ctx.closePath();
      ctx.lineWidth = 2; ctx.stroke(); ctx.fill(); ctx.lineWidth = 3;
    }
    ctx.strokeText(txt, tx, y); ctx.fillText(txt, tx, y);
  }
  ctx.restore();
}
