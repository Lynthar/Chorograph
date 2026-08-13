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

/** 笔刷光圈：rDeg=盘半径（度）＝(R+0.5)×格边度数，由调用方经 core/brush 折算（2026-08-12 起
    档位是物理尺度不是格数，故环、涂改盘、播撒盘、读数四处一律从同一个 R 派生，免各自换算漂移） */
export function drawBrushRing(ctx: CanvasRenderingContext2D, cam: Camera, x: number, y: number,
  rDeg: number, erase: boolean, dpr: number): void {
  /* 作用区=度空间正圆（brushCells 按格计圆），投影纵横比差 1/cos——环画椭圆如实标示：
     横=r·cos、纵=r（旧正圆取横向半径，高纬纵向低估 cos 倍，lat38° 约差 21%）。 */
  const cosK = cam.flat ? 1 : Math.cos(cam.lat0 * Math.PI / 180);
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(3, rDeg / cam.degPerPx * cosK), Math.max(3, rDeg / cam.degPerPx), 0, 0, 7);
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
