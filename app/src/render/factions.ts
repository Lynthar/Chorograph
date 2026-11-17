/* 政治层（自 overlay.ts 原样拆出，行为不变）：涂域边界环（marching squares，
   缓存按层对象+平滑档）→ 实线填充；无涂域时按当年归属节点凸包推导（≥3 点）；
   显式 territory 多边形＝虚线影响范围。 */
import { activeAt, ownerAt, paintLayersAt } from "../core/time.ts";
import { project, viewCosK, type Camera } from "../core/projection.ts";
import { territoryLoops, paintStep } from "../core/territory.ts";
import { convexHull, type Pt } from "../core/geometry.ts";
import { hexA } from "../core/util.ts";
import type { Faction, Meta, World, WorldNode } from "../core/types.ts";

/* 每层的边界环按平铺数组记（[经, 纬, 经, 纬…]）连同各环的外框 [经小, 纬小, 经大, 纬大]：整国涂域的图上环有几十万个点，
   逐帧逐点 project() 再攒成数组是叠加层里最重的一项。投影在画的地方就地算，式子与 core/projection.project 逐字相同 */
interface LoopSet { smooth: number; flat: Float64Array[]; box: Float64Array[] }
const LOOP_CACHE = new WeakMap<object, LoopSet>();
function loopSet(loops: Pt[][], smooth: number): LoopSet {
  const flat: Float64Array[] = [], box: Float64Array[] = [];
  for (const lp of loops) {
    const a = new Float64Array(lp.length * 2);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < lp.length; i++) {
      const x = lp[i][0], y = lp[i][1];
      a[i * 2] = x; a[i * 2 + 1] = y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    flat.push(a); box.push(Float64Array.of(x0, y0, x1, y1));
  }
  return { smooth, flat, box };
}
/** 整环离屏多远就不进路径（px）：描边半宽 1.2 再留一点抗锯齿的余量 */
const LOOP_PAD = 3;
/** 涂域环首算的逐帧额度：每层首算要扫整张地图格网，层多的外来档一帧算完会冻住页面。
    spent 累计本帧首算耗时、done 计本帧算了几层，达 ms 后余下未缓存的层留到下一帧（skipped 计数，调用方据此续画）；
    至少算完一层才判额度＝每帧必前进（地形先吃掉整帧时间也不会饿死）。ms＝Infinity 即一次算全（出图要完整）。 */
export interface LoopBudget { ms: number; spent: number; done: number; skipped: number }
/** 派系名标签（对齐旧 drawFactionLabel）：楷体描白，落在疆域/凸包质心 */
function drawFactionLabel(ctx: CanvasRenderingContext2D, f: Faction, cx: number, cy: number) {
  ctx.font = "bold 15px KaiTi,楷体,serif"; ctx.textAlign = "center";
  ctx.lineWidth = 4; ctx.strokeStyle = "rgba(255,255,255,.78)"; ctx.strokeText(f.名称 || "", cx, cy);
  ctx.fillStyle = hexA(f.color || "#888", 0.95); ctx.fillText(f.名称 || "", cx, cy);
  ctx.textAlign = "start";
}
export function drawFactions(ctx: CanvasRenderingContext2D, cam: Camera, meta: Meta | undefined, world: World, yearNow: number, smooth = 2, budget?: LoopBudget) {
  for (const f of world.factions) {
    if (!activeAt(f, yearNow)) continue;
    const col = f.color || "#888";
    const pls = paintLayersAt(f, yearNow);
    if (f.paint && f.paint.length) {
      if (pls.length) {
        /* 涂绘疆域：全部层的环并进一条路径 evenodd 填充（内环成洞），标签落在最大环质心（对齐旧 drawPolitics） */
        let big: Float64Array | null = null, labMax = -1;
        const k = 1 / cam.degPerPx, cosk = viewCosK(cam), cx = cam.w / 2, cy = cam.h / 2, sh = cam.lonShift || 0;
        ctx.beginPath();
        for (const L of pls) {
          let c = LOOP_CACHE.get(L);
          if (!c || c.smooth !== smooth) {
            if (budget && budget.done && budget.spent >= budget.ms) { budget.skipped++; if (!c) continue; }   // 额度用完：旧平滑档的先画着，没有的下一帧补
            else {
              const t0 = budget ? performance.now() : 0;
              c = loopSet(territoryLoops(L, (meta || {}).bbox, smooth, paintStep(meta)), smooth); LOOP_CACHE.set(L, c);   // 层整体传入＝cells/runs 双认（读旧写新）
              if (budget) { budget.spent += performance.now() - t0; budget.done++; }
            }
          }
          for (let li = 0; li < c.flat.length; li++) {
            const a = c.flat[li], b = c.box[li];
            if (a.length / 2 > labMax) { labMax = a.length / 2; big = a; }   // 标签认最大的环，在不在屏上都算
            /* 整环在屏外：不进路径。闭合的环框不住屏幕就填不到屏上，描边也够不着 */
            if (cx + (b[2] + sh - cam.lon0) * k * cosk < -LOOP_PAD || cx + (b[0] + sh - cam.lon0) * k * cosk > cam.w + LOOP_PAD
              || cy - (b[1] - cam.lat0) * k < -LOOP_PAD || cy - (b[3] - cam.lat0) * k > cam.h + LOOP_PAD) continue;
            ctx.moveTo(cx + (a[0] + sh - cam.lon0) * k * cosk, cy - (a[1] - cam.lat0) * k);
            for (let i = 2; i < a.length; i += 2) ctx.lineTo(cx + (a[i] + sh - cam.lon0) * k * cosk, cy - (a[i + 1] - cam.lat0) * k);
            ctx.closePath();
          }
        }
        ctx.fillStyle = hexA(col, 0.18); ctx.fill("evenodd");
        ctx.lineWidth = 2.4; ctx.strokeStyle = hexA(col, 0.85); ctx.stroke();
        if (big) {   // 标签落在最大环的质心（投影后各点的平均）
          let sx = 0, sy = 0;
          for (let i = 0; i < big.length; i += 2) { sx += cx + (big[i] + sh - cam.lon0) * k * cosk; sy += cy - (big[i + 1] - cam.lat0) * k; }
          drawFactionLabel(ctx, f, sx / labMax, sy / labMax);
        }
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
