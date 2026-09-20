/* 标高点绘制：按（规则场, 半窗格数, 可见细格矩形）缓存 core/spots 的结果，走标签避让场**最后**占位（让地名与部队）。
   数字＝制图面高程取整（与光标读数同一个数）；水面前缀「水面」。
   只评估可见矩形（按窗量化，平移一窗内不重算）且窗大时在粗块上滑：整场逐格滑窗曾让每个新缩放档同步扫 100 万格＝
   滚轮一格 250 ms 长任务；现在每档的工作量随视口与窗定，与图幅大小无关。 */
import { peakSpots, waterSpots, type SpotHeight } from "../core/spots.ts";
import { elevUnitM, waterSurface, type ElevField } from "../core/elev.ts";
import { project, unproject, type Camera } from "../core/projection.ts";
import type { Grid } from "../core/grid.ts";
import type { Meta } from "../core/types.ts";
import type { LabelField } from "./labels.ts";

/** 高点搜索半窗（屏幕 px）与最小突出度（米）：窗按像素＝缩放自动调密度；5 m 把侵蚀噪声的起伏挡在外面。
    只标海拔 ≥ SPOT_MIN_M 的山顶（2026-09-14 用户点单）；水面不受这道门管。 */
export const SPOT_WIN_PX = 72, SPOT_PROM_M = 5, SPOT_MIN_M = 500;
/** 粗块评估的窗下限（粗块格）：窗 ≥ 2 倍它才合块，窗界量化不超过半窗的 1/8 */
const SPOT_COARSE_WIN = 8;
/** 三角点记号（顶角朝上）的半宽 px */
const TRI_PX = 3.5;
/** 每个规则场保留的（窗, 矩形）结果数：连续缩放 + 平移的一段路够用，超过就挤掉最老的 */
const PEAK_CACHE_MAX = 32;

const peakCache = new WeakMap<ElevField, Map<string, SpotHeight[]>>();
const waterCache = new WeakMap<Grid, SpotHeight[]>();

export function drawSpotHeights(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined, f: ElevField, grid: Grid, lf: LabelField): void {
  const U = elevUnitM(meta), wsurf = waterSurface(meta, grid);
  const win = Math.max(2, Math.round(SPOT_WIN_PX * cam.degPerPx / f.step));   // 半窗格数＝像素窗 × 度/px ÷ 度/格
  const k = Math.max(1, Math.floor(win / SPOT_COARSE_WIN));
  /* 可见细格矩形，按窗量化并各向外扩一窗（平移不足一窗不重算；unproject 不含 lonShift，拷贝相机要减回去） */
  const sh = cam.lonShift || 0, [lonA, latA] = unproject(cam, 0, cam.h), [lonB, latB] = unproject(cam, cam.w, 0);
  const cellOf = (v: number, o: number): number => (v - o) / f.step;
  const c0 = Math.max(0, (Math.floor(cellOf(lonA - sh, f.bb.lonMin) / win) - 1) * win), c1 = Math.min(f.cols, (Math.ceil(cellOf(lonB - sh, f.bb.lonMin) / win) + 1) * win);
  const r0 = Math.max(0, (Math.floor(cellOf(latA, f.bb.latMin) / win) - 1) * win), r1 = Math.min(f.rows, (Math.ceil(cellOf(latB, f.bb.latMin) / win) + 1) * win);
  const key = `${win}:${c0}:${r0}:${c1}:${r1}`;
  let byKey = peakCache.get(f);
  if (!byKey) peakCache.set(f, byKey = new Map());
  let peaks = byKey.get(key);
  if (!peaks) {
    byKey.set(key, peaks = peakSpots(f, grid, wsurf, win, SPOT_PROM_M / U, { c0, r0, c1, r1 }, k));
    if (byKey.size > PEAK_CACHE_MAX) byKey.delete(byKey.keys().next().value!);
  }
  let water = waterCache.get(grid);
  if (!water) waterCache.set(grid, water = waterSpots(grid, wsurf));
  ctx.save();
  ctx.font = "10px sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  ctx.lineJoin = "round"; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(246,239,220,.85)"; ctx.fillStyle = "rgba(70,52,28,.95)";
  for (const s of [...peaks, ...water]) {
    const eM = Math.round(s.e * U);
    if (s.kind === "peak" && eM < SPOT_MIN_M) continue;
    const [x, y] = project(cam, s.lon, s.lat);
    if (x < -60 || y < -12 || x > cam.w + 60 || y > cam.h + 12) continue;
    const txt = (s.kind === "water" ? "水面 " : "") + eM;
    const w = ctx.measureText(txt).width, tx = s.kind === "peak" ? x + TRI_PX + 3 : x - w / 2;
    if (!lf.tryPlace({ x: s.kind === "peak" ? x - TRI_PX - 1 : tx - 1, y: y - 6, w: (s.kind === "peak" ? TRI_PX + 4 : 0) + w + 2, h: 12 })) continue;
    if (s.kind === "peak") {   // 三角点：顶角朝上，纸色描边衬底
      ctx.beginPath(); ctx.moveTo(x, y - TRI_PX * 1.15); ctx.lineTo(x + TRI_PX, y + TRI_PX * 0.85); ctx.lineTo(x - TRI_PX, y + TRI_PX * 0.85); ctx.closePath();
      ctx.lineWidth = 2; ctx.stroke(); ctx.fill(); ctx.lineWidth = 3;
    }
    ctx.strokeText(txt, tx, y); ctx.fillText(txt, tx, y);
  }
  ctx.restore();
}
