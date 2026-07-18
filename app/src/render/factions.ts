/* 政治层（自 overlay.ts 原样拆出，行为不变）：涂域边界环（marching squares，
   缓存按层对象+平滑档）→ 实线填充；无涂域时按当年归属节点凸包推导（≥3 点）；
   显式 territory 多边形＝虚线影响范围。 */
import { activeAt, ownerAt, paintLayersAt } from "../core/time.ts";
import { project, type Camera } from "../core/projection.ts";
import { territoryLoops, paintStep } from "../core/territory.ts";
import { convexHull, type Pt } from "../core/geometry.ts";
import { hexA } from "../core/util.ts";
import type { Faction, Meta, World, WorldNode } from "../core/types.ts";

const LOOP_CACHE = new WeakMap<object, { smooth: number; loops: Pt[][] }>();
/** 派系名标签（对齐旧 drawFactionLabel）：楷体描白，落在疆域/凸包质心 */
function drawFactionLabel(ctx: CanvasRenderingContext2D, f: Faction, cx: number, cy: number) {
  ctx.font = "bold 15px KaiTi,楷体,serif"; ctx.textAlign = "center";
  ctx.lineWidth = 4; ctx.strokeStyle = "rgba(255,255,255,.78)"; ctx.strokeText(f.名称 || "", cx, cy);
  ctx.fillStyle = hexA(f.color || "#888", 0.95); ctx.fillText(f.名称 || "", cx, cy);
  ctx.textAlign = "start";
}
export function drawFactions(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined, world: World, yearNow: number, smooth = 2) {
  for (const f of world.factions) {
    if (!activeAt(f, yearNow)) continue;
    const col = f.color || "#888";
    const pls = paintLayersAt(f, yearNow);
    if (f.paint && f.paint.length) {
      if (pls.length) {
        /* 涂绘疆域：全部层的环并进一条路径 evenodd 填充（内环成洞），标签落在最大环质心（对齐旧 drawPolitics） */
        let lab: [number, number] | null = null, labMax = -1;
        ctx.beginPath();
        for (const L of pls) {
          let c = LOOP_CACHE.get(L);
          if (!c || c.smooth !== smooth) { c = { smooth, loops: territoryLoops(L.cells, (meta || {}).bbox, smooth, paintStep(meta)) }; LOOP_CACHE.set(L, c); }
          for (const lp of c.loops) {
            const pts = lp.map(p => project(cam, p[0], p[1]));
            pts.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]));
            ctx.closePath();
            if (pts.length > labMax) {
              labMax = pts.length;
              let sx = 0, sy = 0; pts.forEach(q => { sx += q[0]; sy += q[1]; });
              lab = [sx / pts.length, sy / pts.length];
            }
          }
        }
        ctx.fillStyle = hexA(col, 0.18); ctx.fill("evenodd");
        ctx.lineWidth = 2.4; ctx.strokeStyle = hexA(col, 0.85); ctx.stroke();
        if (lab) drawFactionLabel(ctx, f, lab[0], lab[1]);
      }
      continue;   // 有涂域的势力：当年无生效层=当年无疆域
    }
    /* 无涂域：据点凸包近似。显式 territory（地点 id 列表）=影响范围（虚线淡显）；
       否则按当年归属取据点（对齐旧 factionNodesAt——曾误按坐标多边形绘制，此处修正） */
    const byId = (id: string) => world.nodes.find(n => n.id === id);
    const ns = (f.territory
      ? (f.territory as string[]).map(byId).filter((n): n is WorldNode => !!n)
      : world.nodes.filter(n => n.type !== "event" && ownerAt(n, yearNow) === f.id)
    ).filter(n => activeAt(n, yearNow));
    const pts = ns.map(n => project(cam, n.lon, n.lat));
    if (!pts.length) continue;
    const influence = !!f.territory;
    let cx = 0, cy = 0;
    if (pts.length >= 3) {
      const hull = convexHull(pts as Pt[]);
      ctx.beginPath(); hull.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
      ctx.fillStyle = hexA(col, influence ? 0.10 : 0.18); ctx.fill();
      ctx.lineWidth = influence ? 2 : 2.6; ctx.strokeStyle = hexA(col, influence ? 0.55 : 0.8);
      if (influence) ctx.setLineDash([6, 4]);
      ctx.stroke(); ctx.setLineDash([]);
      hull.forEach(p => { cx += p[0]; cy += p[1]; }); cx /= hull.length; cy /= hull.length;
    } else {
      /* 1–2 个据点：画圆斑示意（对齐旧退化分支），标签抬高 30px */
      for (const p of pts) {
        ctx.beginPath(); ctx.arc(p[0], p[1], 26, 0, 7);
        ctx.fillStyle = hexA(col, 0.16); ctx.fill();
        ctx.lineWidth = 1.6; ctx.strokeStyle = hexA(col, 0.5); ctx.stroke();
      }
      cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      cy = pts.reduce((s, p) => s + p[1], 0) / pts.length - 30;
    }
    drawFactionLabel(ctx, f, cx, cy);
  }
}
