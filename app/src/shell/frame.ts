/* rAF 帧循环：地形渲染 + overlay/分析/编辑 HUD 逐帧重绘 + fps（30 帧滑窗）
   + 底栏「数据」与隐藏 #hud 调试文本（仅变化时写 DOM）。
   相机/网格/图库态直读 ctx；画线笔迹/框选/光标位经 PointerView 只读。 */
import { project, projectSeq, unproject, visibleWorldCopies } from "../core/projection.ts";
import { EDGE_STYLE } from "../core/constants.ts";
import { calOf, fmtWhen } from "../core/calendar.ts";
import { contourStepFor } from "../core/elev.ts";
import { hexA, errText } from "../core/util.ts";
import { drawOverlay, drawOp } from "../render/overlay.ts";
import { snowEOf } from "../render/material.ts";
import { drawAnalysis } from "../render/analysis.ts";
import { drawPaintCells, drawBrushRing, drawSelectBox } from "../render/editHud.ts";
import { paintStep } from "../core/territory.ts";
import { brushRadiusCells } from "../core/brush.ts";
import { dataLon } from "../ui/editops.ts";
import { worldSig, yearSig, selSig, hoverSig, layersSig, selNode, selEdge, selUnit,
  modeSig, editSubSig, linkTypeSig, linkFromSig, opDrawSig, opSelSig,
  paintFactionSig, paintLayerSig, brushSizeSig, brushEraseSig, brushSmoothSig,
  routePtsSig, routeResSig, unitLegsSig, editVerSig, gridVerSig, saveConflictSig, erodePhaseSig }
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
  /* 画一帧（地形+叠加层+工具预览）：rAF 循环逐帧调用；host.resize 设完画布尺寸后同步补画共用——
     设 canvas 宽高即清屏，若等下一帧 rAF 补画，空白帧会先被合成上屏（检查器滑开/收起的 0.22s 过渡
     经 ResizeObserver 逐帧触发 resize，空白帧与画面帧交替＝整屏闪烁）。 */
  const paint = (): void => {
    const layers = layersSig.value, world = worldSig.value, yearNow = yearSig.value;
    if (layers.terrain) {
      const cs = contourStepFor(ctx.view.degPerPx, ctx.meta);   // 等高距随缩放（×2 阶梯+过渡淡入）
      ctx.R!.render(viewBB(), { contour: layers.contour, cMinor: cs.minor, cFade: cs.fade, wrap: ctx.meta.worldModel !== "flat", paper: ctx.meta.mapKind === "tactical", snowE: snowEOf(ctx.meta) });
    }
    if (world) {
      const octx = ov.getContext("2d")!;
      const selIdForOps = (selSig.value && selSig.value.kind === "node") ? selSig.value.id : null;
      const multiIds = (selSig.value && selSig.value.kind === "multi") ? selSig.value.ids : null;
      const multiUnitIds = (selSig.value && selSig.value.kind === "multi") ? selSig.value.unitIds || null : null;
      const unitSelId = (selSig.value && selSig.value.kind === "unit") ? selSig.value.id : null;
      const edgeSelIdx = (selSig.value && selSig.value.kind === "edge") ? selSig.value.idx : null;
      const decorSelId = (selSig.value && selSig.value.kind === "decor") ? selSig.value.id : null;
      const decorMultiIds = (selSig.value && selSig.value.kind === "multi") ? selSig.value.decorIds || null : null;
      drawOverlay(octx, cam(), ctx.meta, world, yearNow, ctx.DPR, { layers, selId: selIdForOps, opSel: opSelSig.value, grid: ctx.grid || undefined, multiIds, multiUnitIds, unitSelId, unitLegs: unitLegsSig.value, smooth: brushSmoothSig.value, edgeSelIdx, editing: modeSig.value === "edit", decorSelId, decorMultiIds });
      const m = modeSig.value;
      if (m === "measure" || m === "route") drawAnalysis(octx, cam(), ctx.meta, m, routePtsSig.value, routeResSig.value, ctx.DPR);
      if (m === "edit" && editSubSig.value === "paint") {
        const pf = paintFactionSig.value;
        const f = pf ? world.factions.find(x => x.id === pf) : null;
        const L = f && f.paint && f.paint[paintLayerSig.value];
        if (L) drawPaintCells(octx, cam(), L, f!.color || "#888", ctx.DPR, paintStep(ctx.meta), ctx.meta.bbox);
        if (ptr.mxy) drawBrushRing(octx, cam(), ptr.mxy[0], ptr.mxy[1],
          (brushRadiusCells(ctx.meta, "paint", brushSizeSig.value) + 0.5) * paintStep(ctx.meta), brushEraseSig.value, ctx.DPR);
      }
      if (m === "edit" && editSubSig.value === "terrain" && ptr.mxy && ctx.grid) {   // 地形笔刷环（按 grid.step 定径）
        drawBrushRing(octx, cam(), ptr.mxy[0], ptr.mxy[1],
          (brushRadiusCells(ctx.meta, "terrain", brushSizeSig.value) + 0.5) * ctx.grid.step, brushEraseSig.value, ctx.DPR);
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
      if (m === "edit" && ptr.opStroke && ptr.opStroke.free && ptr.opStroke.pts.length) {   // 自由画河/工事预览：型色线 + 橡皮筋到光标
        const pts = ptr.opStroke.pts.slice();
        if (ptr.mxy) { const ll = unproject(cam(), ptr.mxy[0], ptr.mxy[1]); pts.push([dataLon(ctx.meta, ll[0]), ll[1]]); }
        if (pts.length >= 2) {
          const est = EDGE_STYLE[ptr.opStroke.free];
          octx.save(); octx.globalAlpha = 0.7; octx.scale(ctx.DPR, ctx.DPR);
          const pp = projectSeq(cam(), pts);
          octx.beginPath(); pp.forEach((p, i) => i ? octx.lineTo(p[0], p[1]) : octx.moveTo(p[0], p[1]));
          octx.lineWidth = est.w; octx.strokeStyle = est.color; octx.lineJoin = "round"; octx.lineCap = "round"; octx.stroke();
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
  };
  ctx.repaint = paint;

  /* 空闲降频（2026-07-26）：帧循环照旧每帧醒来，但先比一份便宜的状态指纹——没变就整帧跳过。
     变化后 IDLE_MS 内保持满帧（覆盖 CSS 过渡、飞行动画、播放这类连续变化的尾巴）；
     再往后落到 IDLE_PAINT_MS 一帧的**保底频率**——兜住指纹没盯住的变化
     （布景图片资产 onload、字体度量就位等都不经 signal），代价只是最多晚一拍上屏。
     ⚠ 这正是不做全量脏标记的理由：ctx.view 是普通对象、ptr 瞬态与资产加载都不是 signal，
     漏一个就成「画面静止不更新」的静默 bug；保底频率把漏判从"永不"降级成"晚 250ms"。
     ⚠ 新增任何进 paint()／hud 文本的读取源，记得同步进 stamp()。 */
  const IDLE_MS = 1000, IDLE_PAINT_MS = 250;
  let sig: unknown[] = [], lastChange = 0, lastPaint = 0;
  const stamp = (): unknown[] => {
    const v = ctx.view, os = ptr.opStroke, bs = ptr.boxSel, m = ptr.mxy;
    return [
      // 数据与图层（worldSig 换引用广播；原地改由 editVer 兜、网格重建由 gridVer 兜）
      worldSig.value, editVerSig.value, gridVerSig.value, yearSig.value, layersSig.value,
      // 选中/悬停/工具态
      selSig.value, hoverSig.value, modeSig.value, editSubSig.value, opSelSig.value,
      opDrawSig.value, linkTypeSig.value, linkFromSig.value,
      paintFactionSig.value, paintLayerSig.value,
      brushSizeSig.value, brushEraseSig.value, brushSmoothSig.value,
      routePtsSig.value, routeResSig.value, unitLegsSig.value,
      // 外壳可变态（非 signal，只能逐帧比）；elevField=侵蚀细化异步换入（引用比较有效）
      ctx.grid, ctx.elevField, ctx.R, ctx.DPR, ctx.canvas.width, ctx.canvas.height,
      v.lon0, v.lat0, v.degPerPx,
      // 指针瞬态（画线笔迹/框选/光标位）
      m ? m[0] : -1, m ? m[1] : -1,
      os ? os.pts.length : -1, os ? os.free : false,
      bs ? bs.x1 : -1, bs ? bs.y1 : -1, bs ? bs.moved : false,
      // 顶栏保存态文案的来源（同样不是 signal，漏了就会「已保存」迟迟不上屏）
      autosave.pending, ctx.savedAt, ctx.saveErr, ctx.bootNote, ctx.mapId, ctx.source, ctx.lib,
      saveConflictSig.value, erodePhaseSig.value
    ];
  };
  const changed = (a: unknown[], b: unknown[]): boolean => a.length !== b.length || a.some((x, i) => x !== b[i]);

  let frameErr = false;   // 上一帧是否由本循环写了红条（只有自己写的才由自己撤，见 catch 旁注）
  (function frame() {
    try {   // 帧内异常：上报 #err、放弃本帧——续排在 finally，一帧出错不冻死画布（2026-07-12 P2）
    const t0 = performance.now();
    const now = stamp();
    if (changed(now, sig)) { sig = now; lastChange = t0; }
    if (t0 - lastChange > IDLE_MS && t0 - lastPaint < IDLE_PAINT_MS) return;   // 空闲且未到保底节拍：整帧跳过
    lastPaint = t0;
    paint();
    const world = worldSig.value, yearNow = yearSig.value;
    times.push(performance.now() - t0);
    if (times.length > 30) times.shift();
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    fps = avg < 0.01 ? "<0.01" : avg.toFixed(2);
    const src = !ctx.lib ? "无图库(只读)" : ctx.source === "folder" ? `📁 ${ctx.folderDir!.name}` : "💾 浏览器图库";
    /* 顶栏保存态 savest（底栏退役：原 ftData 短化——保存态为主文案，来源/图名进 title；
       启动提示 ☂（文件夹重授权/旧档迁移）仍随文案可见）；仅变化时写 DOM。
       可见文案不再写图名（面包屑相邻已有、画布图幅标题第三遍——2026-07-16 审阅③双写），只报来源；图名细节留 title */
    const srcLabel = !ctx.lib ? "内置示例（只读）" : ctx.source === "folder" ? `文件「${ctx.mapId || "—"}」` : `地图「${(ctx.meta || ({} as Meta)).名称 || "未命名"}」`;
    const srcShort = !ctx.lib ? "内置示例（只读）" : ctx.source === "folder" ? "📁 文件夹图库" : "💾 浏览器图库";
    /* 地势定形相位胶囊（可读性三件套之一）：命名的、可见的过程不被读成 bug——
       落定后的换场自此有预告。告警态（冲突/保存失败）在场时让位，警报优先。 */
    const ep = erodePhaseSig.value;
    const epTxt = saveConflictSig.value || ctx.saveErr ? ""
      : ep === "work" ? "⛰ 地势定形中… · " : ep === "ultra" ? "⛰ 地势精修中… · " : ep === "done" ? "✓ 地势已定形 · " : "";
    /* ⚠ 冲突自成一档，不能并进「自动保存失败」那句——那句尾巴写着「随下次改动重试」，
       而冲突态恰恰**不会**重试（守卫短路着，等用户在弹层里决断），并进去就是在说假话。 */
    const ftTxt = epTxt + (saveConflictSig.value
      ? "⚠ 保存已暂停——这张图在别处被改过，请在弹层中选择处置"
      : ctx.saveErr
      /* ⚠ 走 errText 而非直读 .message：真配额下 QuotaExceededError 的 message 是空串，
         直读会退成「存储异常」这句无信息的兜底（2026-08-07 CDP 实测撞出） */
      ? `⚠ 自动保存失败（${errText(ctx.saveErr)}——未落盘，随下次改动重试）`
      : autosave.pending ? "未保存"
      : ctx.savedAt ? `已自动保存 ${String(ctx.savedAt.getHours()).padStart(2, "0")}:${String(ctx.savedAt.getMinutes()).padStart(2, "0")}`
      : srcShort)
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
      /* 这一帧画成了：把上一帧留下的红条撤掉。⚠ 只撤**自己**写的那条——`#err` 也承载
         启动失败与全局未处理异常，那些不该被一帧成功抹掉（错误条原先只写不清，一次瞬时的
         帧内异常会把红条永久留在界面上，无任何路径清空）。 */
      if (frameErr) { frameErr = false; try { const el = $("err"); if (el) el.textContent = ""; } catch {} }
    } catch (e) {
      frameErr = true;
      try { const el = $("err"); if (el) el.textContent = "⚠ 渲染帧异常：" + String((e as Error).message || e); } catch {}
    } finally {
      requestAnimationFrame(frame);
    }
  })();
}
