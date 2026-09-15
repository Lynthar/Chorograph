/* 标高点绘制：按（规则场, 半窗格数）缓存 core/spots 的结果，走标签避让场**最后**占位（让地名与部队）。
   数字＝制图面高程取整（与光标读数同一个数）；水面前缀「水面」。 */
import { peakSpots, waterSpots, type SpotHeight } from "../core/spots.ts";
import { elevUnitM, waterSurface, type ElevField } from "../core/elev.ts";
import { project, type Camera } from "../core/projection.ts";
import type { Grid } from "../core/grid.ts";
import type { Meta } from "../core/types.ts";
import type { LabelField } from "./labels.ts";

/** 高点搜索半窗（屏幕 px）与最小突出度（米）：窗按像素＝缩放自动调密度；5 m 把侵蚀噪声的起伏挡在外面、留住能挡视线的埂 */
export const SPOT_WIN_PX = 72, SPOT_PROM_M = 5;

const peakCache = new WeakMap<ElevField, Map<number, SpotHeight[]>>();
const waterCache = new WeakMap<Grid, SpotHeight[]>();

export function drawSpotHeights(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined, f: ElevField, grid: Grid, lf: LabelField): void {
  const U = elevUnitM(meta), wsurf = waterSurface(meta, grid);
  const win = Math.max(2, Math.round(SPOT_WIN_PX * cam.degPerPx / f.step));   // 半窗格数＝像素窗 × 度/px ÷ 度/格
  let byWin = peakCache.get(f);
  if (!byWin) peakCache.set(f, byWin = new Map());
  let peaks = byWin.get(win);
  if (!peaks) byWin.set(win, peaks = peakSpots(f, grid, wsurf, win, SPOT_PROM_M / U));
  let water = waterCache.get(grid);
  if (!water) waterCache.set(grid, water = waterSpots(grid, wsurf));
  ctx.save();
  ctx.font = "10px sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  ctx.lineJoin = "round"; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(246,239,220,.85)"; ctx.fillStyle = "rgba(70,52,28,.95)";
  for (const s of [...peaks, ...water]) {
    const [x, y] = project(cam, s.lon, s.lat);
    if (x < -60 || y < -12 || x > cam.w + 60 || y > cam.h + 12) continue;
    const txt = (s.kind === "water" ? "水面 " : "") + Math.round(s.e * U);
    const w = ctx.measureText(txt).width, tx = s.kind === "peak" ? x + 4 : x - w / 2;
    if (!lf.tryPlace({ x: tx - 1, y: y - 6, w: w + 2, h: 12 })) continue;
    if (s.kind === "peak") { ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 7); ctx.fill(); }
    ctx.strokeText(txt, tx, y); ctx.fillText(txt, tx, y);
  }
  ctx.restore();
}
