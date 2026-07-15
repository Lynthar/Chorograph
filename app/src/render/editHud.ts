/* 编辑态视觉层：涂域编辑格底纹（所见即所涂）+ 笔刷光圈。
   在 drawOverlay/drawAnalysis 之后同一 ctx 上绘制（CSS 像素坐标系）。 */
import { PD } from "../core/constants.ts";
import { project, type Camera } from "../core/projection.ts";
import { hexA } from "../core/util.ts";
import type { PaintLayer } from "../core/types.ts";

/** 当前编辑层的格底纹（对齐旧 drawPolitics 编辑态分支） */
export function drawPaintCells(ctx: CanvasRenderingContext2D, cam: Camera, layer: PaintLayer, color: string, dpr: number, pd = PD): void {
  const cells = layer.cells || [];
  if (!cells.length) return;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.fillStyle = hexA(color, 0.15);
  for (const [lon, lat] of cells) {
    const a = project(cam, lon - pd / 2, lat + pd / 2), b = project(cam, lon + pd / 2, lat - pd / 2);
    ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
  }
  ctx.restore();
}

/** 笔刷光圈：半径=((size-1)+0.5)×每格像素（对齐旧 drawBrushCursor；cellDeg=格边度数，涂域=PD、地形=grid.step） */
export function drawBrushRing(ctx: CanvasRenderingContext2D, cam: Camera, x: number, y: number,
  size: number, erase: boolean, dpr: number, cellDeg = PD): void {
  const cosK = cam.flat ? 1 : Math.cos(cam.lat0 * Math.PI / 180);
  const rPx = ((size - 1) + 0.5) * (1 / cam.degPerPx) * cellDeg * cosK;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.beginPath();
  ctx.arc(x, y, Math.max(3, rPx), 0, 7);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = erase ? "rgba(192,57,43,.9)" : "rgba(220,230,240,.8)";
  ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/** 框选矩形（对齐旧 drawBoxSelect）；坐标为 CSS 像素 */
export function drawSelectBox(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, dpr: number): void {
  ctx.save();
  ctx.scale(dpr, dpr);
  const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  ctx.fillStyle = "rgba(202,164,90,.12)"; ctx.fillRect(x, y, w, h);
  ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(160,120,40,.9)";
  ctx.setLineDash([5, 4]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
  ctx.restore();
}
