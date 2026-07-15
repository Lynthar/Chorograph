/* 分析模式画布层：量距折线 / 行军路线（视觉自 v0.14 drawRoute 原样迁移）。
   在 drawOverlay 之后调用（画布已清、同一 ctx、CSS 像素坐标系）；
   projectSeq 保证跨 ±180° 走短边。 */
import { projectSeq, type Camera } from "../core/projection.ts";
import { distKm } from "../core/geo.ts";
import { fmtKm } from "../core/util.ts";
import type { ComputedRoute, RoutePoint } from "../core/route.ts";
import type { Meta } from "../core/types.ts";

export function drawAnalysis(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined,
  mode: "measure" | "route", pts: RoutePoint[], route: ComputedRoute | null, dpr: number): void {
  if (!pts.length) return;
  ctx.save();
  ctx.scale(dpr, dpr);
  const sp = projectSeq(cam, pts);
  if (mode === "measure") {
    // 多点折线量距（借鉴 Azgaar 的 ruler）
    if (pts.length >= 2) {
      ctx.beginPath();
      sp.forEach((q, i) => { i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
      ctx.lineWidth = 2; ctx.strokeStyle = "#b0202a"; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
      for (let i = 1; i < pts.length; i++) {
        const km = distKm(meta, pts[i - 1].lon, pts[i - 1].lat, pts[i].lon, pts[i].lat);
        const mx = (sp[i - 1][0] + sp[i][0]) / 2, my = (sp[i - 1][1] + sp[i][1]) / 2;
        ctx.font = "11.5px KaiTi,楷体,serif"; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.88)";
        ctx.strokeText(fmtKm(km), mx + 4, my - 4); ctx.fillStyle = "#8a2b20"; ctx.fillText(fmtKm(km), mx + 4, my - 4);
      }
    }
    sp.forEach((q, i) => {
      ctx.beginPath(); ctx.arc(q[0], q[1], 6.5, 0, 7); ctx.fillStyle = "#8a2b20"; ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), q[0], q[1]); ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
    });
    ctx.restore();
    return;
  }
  // 行军：起/终记号 + 路径（陆/水=描边双线，飞行=紫虚线直飞）
  sp.forEach((q, i) => {
    ctx.beginPath(); ctx.arc(q[0], q[1], 7, 0, 7); ctx.fillStyle = i === 0 ? "#2a7d3a" : "#b0202a"; ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(i === 0 ? "起" : "终", q[0], q[1]); ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
  });
  if (pts.length === 2 && route) {
    if (route.arm === "air") {
      ctx.beginPath(); ctx.moveTo(sp[0][0], sp[0][1]); ctx.lineTo(sp[1][0], sp[1][1]);
      ctx.lineWidth = 3; ctx.strokeStyle = "#7b52c7"; ctx.setLineDash([9, 5]); ctx.stroke(); ctx.setLineDash([]);
    } else if (route.path) {
      const pp = projectSeq(cam, route.path.map(([lon, lat]) => ({ lon, lat })));
      ctx.beginPath();
      pp.forEach((q, i) => { i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
      ctx.lineWidth = 4; ctx.strokeStyle = "#c0392b"; ctx.lineJoin = "round"; ctx.stroke();
      ctx.lineWidth = 1.5; ctx.strokeStyle = "#ffd9c9"; ctx.stroke();
    }
  }
  ctx.restore();
}
