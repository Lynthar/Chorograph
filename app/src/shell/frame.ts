/* rAF 帧循环：地形渲染 + overlay/分析/编辑 HUD 逐帧重绘 + fps（30 帧滑窗）
   + 底栏「数据」与隐藏 #hud 调试文本（仅变化时写 DOM）。
   相机/网格/图库态直读 ctx；画线笔迹/框选/光标位经 PointerView 只读。 */
import { project, projectSeq, unproject, visibleWorldCopies } from "../core/projection.ts";
import { EDGE_STYLE } from "../core/constants.ts";
import { calOf, fmtWhen } from "../core/calendar.ts";
import { contourStepFor } from "../core/elev.ts";
import { hexA } from "../core/util.ts";
import { drawOverlay, drawOp } from "../render/overlay.ts";
import { drawAnalysis } from "../render/analysis.ts";
import { drawPaintCells, drawBrushRing, drawSelectBox } from "../render/editHud.ts";
import { paintStep } from "../core/territory.ts";
import { dataLon } from "../ui/editops.ts";
import { worldSig, yearSig, selSig, hoverSig, layersSig, selNode, selEdge, selUnit,
  modeSig, editSubSig, linkTypeSig, linkFromSig, opDrawSig, opSelSig,
  paintFactionSig, paintLayerSig, brushSizeSig, brushEraseSig, brushSmoothSig,
  routePtsSig, routeResSig, unitLegsSig }
  from "../ui/state.ts";
import { $ } from "./dom.ts";
import type { ShellCtx } from "./ctx.ts";
import type { Host } from "./host.ts";
import type { LibraryIO } from "./library.ts";
import type { PointerView } from "./pointer.ts";
import type { Meta } from "../core/types.ts";

export function startFrameLoop(ctx: ShellCtx, host: Host, libio: LibraryIO, ptr: PointerView): void {
  const { ov } = ctx;
  const { cam, viewBB } = host;
  const { autosave } = libio;
  const times: number[] = [];
  let fps = "—", lastFtData = "";
  (function frame() {
    try {   // 帧内异常：上报 #err、放弃本帧——续排在 finally，一帧出错不冻死画布（2026-07-12 P2）
    const t0 = performance.now();
    const layers = layersSig.value, world = worldSig.value, yearNow = yearSig.value;
    if (layers.terrain) {
      const cs = contourStepFor(ctx.view.degPerPx, ctx.meta);   // 等高距随缩放（×2 阶梯+过渡淡入）
      ctx.R!.render(viewBB(), { contour: layers.contour, cMinor: cs.minor, cFade: cs.fade, wrap: ctx.meta.worldModel !== "flat" });
    }
    if (world) {
      const octx = ov.getContext("2d")!;
      const selIdForOps = (selSig.value && selSig.value.kind === "node") ? selSig.value.id : null;
      const ecoOn = !(modeSig.value === "edit" && editSubSig.value === "terrain");   // 地形涂改时不散布生态，见原始格；grid 恒传——印章尺度要真实 step（缺省 1° 会让战术图印章巨大化）
      const multiIds = (selSig.value && selSig.value.kind === "multi") ? selSig.value.ids : null;
      const multiUnitIds = (selSig.value && selSig.value.kind === "multi") ? selSig.value.unitIds || null : null;
      const unitSelId = (selSig.value && selSig.value.kind === "unit") ? selSig.value.id : null;
      const edgeSelIdx = (selSig.value && selSig.value.kind === "edge") ? selSig.value.idx : null;
      drawOverlay(octx, cam(), ctx.meta, world, yearNow, ctx.DPR, { layers, selId: selIdForOps, opSel: opSelSig.value, grid: ctx.grid || undefined, eco: ecoOn, multiIds, multiUnitIds, unitSelId, unitLegs: unitLegsSig.value, smooth: brushSmoothSig.value, edgeSelIdx, editing: modeSig.value === "edit" });
      const m = modeSig.value;
      if (m === "measure" || m === "route") drawAnalysis(octx, cam(), ctx.meta, m, routePtsSig.value, routeResSig.value, ctx.DPR);
      if (m === "edit" && editSubSig.value === "paint") {
        const pf = paintFactionSig.value;
        const f = pf ? world.factions.find(x => x.id === pf) : null;
        const L = f && f.paint && f.paint[paintLayerSig.value];
        if (L) drawPaintCells(octx, cam(), L, f!.color || "#888", ctx.DPR, paintStep(ctx.meta));
        if (ptr.mxy) drawBrushRing(octx, cam(), ptr.mxy[0], ptr.mxy[1], brushSizeSig.value, brushEraseSig.value, ctx.DPR, paintStep(ctx.meta));
      }
      if (m === "edit" && editSubSig.value === "terrain" && ptr.mxy && ctx.grid) {   // 地形笔刷环（按 grid.step 定径）
        drawBrushRing(octx, cam(), ptr.mxy[0], ptr.mxy[1], brushSizeSig.value, brushEraseSig.value, ctx.DPR, ctx.grid.step);
      }
      const od = opDrawSig.value;
      if (m === "edit" && od && ptr.opStroke && ptr.opStroke.pts.length) {   // 画线预览：已采点 + 橡皮筋到光标
        const pts = ptr.opStroke.pts.slice();
        if (ptr.mxy) { const ll = unproject(cam(), ptr.mxy[0], ptr.mxy[1]); pts.push([dataLon(ctx.meta, ll[0]), ll[1]]); }
        if (pts.length >= 2) {
          octx.save(); octx.globalAlpha = 0.85; octx.scale(ctx.DPR, ctx.DPR);
          drawOp(octx, cam(), { kind: od.kind, pts, w: 3 }, world, false);
          octx.restore();
        }
      }
      if (m === "edit" && ptr.opStroke && ptr.opStroke.river && ptr.opStroke.pts.length) {   // 自由画河预览：河蓝线 + 橡皮筋到光标
        const pts = ptr.opStroke.pts.slice();
        if (ptr.mxy) { const ll = unproject(cam(), ptr.mxy[0], ptr.mxy[1]); pts.push([dataLon(ctx.meta, ll[0]), ll[1]]); }
        if (pts.length >= 2) {
          octx.save(); octx.globalAlpha = 0.7; octx.scale(ctx.DPR, ctx.DPR);
          const pp = projectSeq(cam(), pts);
          octx.beginPath(); pp.forEach((p, i) => i ? octx.lineTo(p[0], p[1]) : octx.moveTo(p[0], p[1]));
          octx.lineWidth = 2.6; octx.strokeStyle = "#3f7fc4"; octx.lineJoin = "round"; octx.lineCap = "round"; octx.stroke();
          octx.restore();
        }
      }
      if (m === "edit" && editSubSig.value === "decor" && brushEraseSig.value && ptr.mxy) {   // 布景橡皮半径环
        octx.save(); octx.scale(ctx.DPR, ctx.DPR);
        octx.beginPath(); octx.arc(ptr.mxy[0], ptr.mxy[1], ptr.decorEraseRadius(), 0, 7);
        octx.lineWidth = 1.4; octx.strokeStyle = "rgba(192,57,43,.9)"; octx.setLineDash([4, 3]); octx.stroke(); octx.setLineDash([]);
        octx.restore();
      }
      if (m === "edit" && editSubSig.value === "link" && linkFromSig.value && ptr.mxy) {   // 连线橡皮筋（起点→鼠标，v0.14）
        const fn = world.nodes.find(n => n.id === linkFromSig.value);
        if (fn) {
          const st = EDGE_STYLE[linkTypeSig.value] || EDGE_STYLE.road;
          let p: [number, number] | null = null, bd = Infinity;
          for (const shift of visibleWorldCopies(cam(), ctx.meta)) {   // 多拷贝取离光标最近的一份投影
            const q = project({ ...cam(), lonShift: shift }, fn.lon, fn.lat);
            const dd = Math.hypot(q[0] - ptr.mxy[0], q[1] - ptr.mxy[1]);
            if (dd < bd) { bd = dd; p = q; }
          }
          if (p) {
            octx.save(); octx.scale(ctx.DPR, ctx.DPR);
            octx.beginPath(); octx.moveTo(p[0], p[1]); octx.lineTo(ptr.mxy[0], ptr.mxy[1]);
            octx.lineWidth = 2; octx.strokeStyle = hexA(st.color, 0.85); octx.setLineDash([6, 5]); octx.stroke(); octx.setLineDash([]);
            octx.beginPath(); octx.arc(p[0], p[1], 10, 0, 7);
            octx.lineWidth = 2; octx.strokeStyle = "#caa45a"; octx.stroke();
            octx.restore();
          }
        }
      }
      if (ptr.boxSel && ptr.boxSel.moved) drawSelectBox(octx, ptr.boxSel.x0, ptr.boxSel.y0, ptr.boxSel.x1, ptr.boxSel.y1, ctx.DPR);   // 框选矩形
    }
    times.push(performance.now() - t0);
    if (times.length > 30) times.shift();
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    fps = avg < 0.01 ? "<0.01" : avg.toFixed(2);
    const src = !ctx.lib ? "无图库(只读)" : ctx.source === "folder" ? `📁 ${ctx.folderDir!.name}` : "💾 图库";
    /* 顶栏保存态 savest（底栏退役：原 ftData 短化——保存态为主文案，来源/图名进 title；
       启动提示 ☂（文件夹重授权/旧档迁移）仍随文案可见）；仅变化时写 DOM */
    const srcLabel = !ctx.lib ? "内置示例（只读）" : ctx.source === "folder" ? `文件「${ctx.mapId || "—"}」` : `地图「${(ctx.meta || ({} as Meta)).名称 || "未命名"}」`;
    const ftTxt = (ctx.saveErr
      ? `⚠ 自动保存失败（${ctx.saveErr && ctx.saveErr.message ? ctx.saveErr.message : "存储异常"}——未落盘，随下次改动重试）`
      : autosave.pending ? "未保存"
      : ctx.savedAt ? `已自动保存 ${String(ctx.savedAt.getHours()).padStart(2, "0")}:${String(ctx.savedAt.getMinutes()).padStart(2, "0")}`
      : srcLabel)
      + (ctx.bootNote ? ` · ☂ ${ctx.bootNote}` : "");
    if (ftTxt !== lastFtData) {
      lastFtData = ftTxt;
      $("ftData").textContent = ftTxt;
      $("savest").classList.toggle("dirty", !!(ctx.saveErr || autosave.pending));
      $("savest").title = `数据：${srcLabel}`;
    }
    const sel = selSig.value, hover = hoverSig.value;
    const selN = selNode(world, sel), selE = selEdge(world, sel), selU = selUnit(world, sel);
    const saveTxt = autosave.pending ? (ctx.saveErr ? "●未保存·上次失败" : "●未保存") : ctx.savedAt ? `已存 ${String(ctx.savedAt.getHours()).padStart(2, "0")}:${String(ctx.savedAt.getMinutes()).padStart(2, "0")}` : "";
    $("hud").textContent =
      `舆图 Chorograph${import.meta.env.DEV ? " · dev" : ""}\n渲染 ${fps} ms/帧 ｜ 视角 ${ctx.view.lon0.toFixed(2)},${ctx.view.lat0.toFixed(2)} ｜ ${ctx.view.degPerPx.toFixed(4)}°/px ｜ ${world ? fmtWhen(calOf(ctx.meta.calendar), ctx.meta.mapKind === "tactical", yearNow) : "SE" + yearNow}\n` +
      `${world ? `「${ctx.meta.名称 || "世界"}」 ${world.nodes.length} 地点 / ${world.edges.length} 连线 ｜ ` : ""}${src} ｜ ` +
      `${$("hud").dataset.grid || ""} ｜ ${ctx.R!.rendererName()} ｜ 寻路 ${ctx.routeClient.usingWorker ? "Worker" : "同步回退"}` +
      (saveTxt ? ` ｜ ${saveTxt}` : "") +
      (selN ? `\n★ 选中 ${selN.名称 || selN.id}（Esc 取消）` : selE ? `\n★ 选中连线 ${selE.名称 || selE.from + "→" + selE.to}（Esc 取消）` : selU ? `\n⚔ 选中部队 ${selU.名称 || selU.id}（Esc 取消）` : "") +
      (hover ? `\n▸ ${hover.名称 || hover.id}` : "") +
      (ctx.bootNote ? `\n☂ ${ctx.bootNote}` : "");
    } catch (e) {
      try { const el = $("err"); if (el) el.textContent = "⚠ 渲染帧异常：" + String((e as Error).message || e); } catch {}
    } finally {
      requestAnimationFrame(frame);
    }
  })();
}
