/* 指针/键盘/滚轮交互：
   浏览左拖/中键/Space+左拖=平移；编辑·选择空白拖=框选（Shift=强制框选）；
   按住地点/布景/部队=拖移；连线可点点或拖拽成线；其余工具空白按下只作点击。
   模块内闭持全部拖拽/笔迹瞬态；frame 经 PointerView 只读画线笔迹/框选/光标位。 */
import { unproject, clampView, zoomAtView, panByView } from "../core/projection.ts";
import { EDGE_STYLE, EVENT_TYPES, NODE_STYLE, canonComposite } from "../core/constants.ts";
import { paintStep } from "../core/territory.ts";
import { ownerAt } from "../core/time.ts";
import { calOf, fmtWhen } from "../core/calendar.ts";
import { elevUnitM, elevSmooth } from "../core/elev.ts";
import { distKm } from "../core/geo.ts";
import { fmtKm } from "../core/util.ts";
import { edgeLenKm, polylineKm, rdp } from "../core/geometry.ts";
import { pickEdge, pickNode, pickOp, nodesInBox } from "../render/overlay.ts";
import { pickUnit, pickRangeHandle, unitsInBox, type RingHit } from "../render/units.ts";
import { unitPos } from "../core/units.ts";
import { pickDecor, decorIdsInRadius } from "../render/decor.ts";
import { worldSig, yearSig, selSig, hoverSig, layersSig, selNode, selEdge, selUnit,
  modeSig, editSubSig, linkTypeSig, linkFromSig, isTacSig, setRailTool, pickEditSub, showToast,
  inspEditSig, settingsSig, closeSettings, helpOpenSig, togglePlay, stopPlay,
  opDrawSig, opSelSig, selectOp, clearOpSel, cancelOpDraw, routePtsSig,
  paintFactionSig, paintLayerSig, paintTerrainSig, terrainHeightSig, decorKindSig, decorSizeSig,
  brushSizeSig, brushEraseSig, eraNewSig,
  mutateWorld, mutateWorldLive, pushHistoryOnce, beginStroke, endStroke, undoWorld, redoWorld,
  deleteNodeAt, deleteUnitAt, deleteEdgeIdx,
  type EditSub, type Sel }
  from "../ui/state.ts";
import { addNode, addEdge, addRiver, addLabel, addOp, addDecor, addAsset, applyEra, removeNode, removeOp,
  removeDecor, removeUnit, setUnitWaypoint, setUnitRing, setNodeRangeKm, moveNode, dataLon, paintTerrainAt, paintHeightAt }
  from "../ui/editops.ts";
import { poolGet } from "../ui/stamps.ts";
import { paintDims, cellsToSet, setToCells, brushCells, ensurePaintLayer, type PaintDims } from "../ui/paint.ts";
import { $ } from "./dom.ts";
import type { ShellCtx } from "./ctx.ts";
import type { Host } from "./host.ts";
import type { LibraryIO } from "./library.ts";
import type { WorldNode } from "../core/types.ts";

/* —— 拖拽/笔迹瞬态（每帧读写，不进 signals）—— */
interface PanDrag { x: number; y: number; lon0: number; lat0: number; click: boolean }
interface OpStroke { pts: [number, number][]; lastX: number; lastY: number; river?: boolean }   // river=自由画河笔迹（收笔入 river 边），否则作战线
interface BoxSel { x0: number; y0: number; x1: number; y1: number; moved: boolean }
interface PaintStroke { set: Set<string>; dims: PaintDims; fid: string; idx: number }
interface DecorStroke { erase: boolean; lastX: number; lastY: number }
interface MultiDrag { sx: number; sy: number; t: number; pushed: boolean;
  orig: { id: string; lon0: number; lat0: number }[];        // 框选中的地点原位（moveNode 按位移整组平移）
  uorig: { id: string; lon0: number; lat0: number }[] }      // 框选中的部队在起手时刻的原位（拖动改写该时刻航点）
type RangeDrag = RingHit & { pushed: boolean };

/** frame 每帧只读的交互视图（画线预览/框选矩形/笔刷环定位共用） */
export interface PointerView {
  /** 最近一次指针在画布上的位置（CSS px；未动过=null） */
  readonly mxy: [number, number] | null;
  /** 作战线画线笔迹（画线态按住拖动中） */
  readonly opStroke: OpStroke | null;
  /** 框选矩形（拖动中） */
  readonly boxSel: BoxSel | null;
  /** 布景橡皮半径 px（v0.14 decorEraseAt：随「大小」滑杆） */
  decorEraseRadius(): number;
}

export interface PointerDeps {
  /** 「0」快捷键：回世界初始视角（boot 的顶栏「复位」同源） */
  resetView(): void;
}

export function wireInteractions(ctx: ShellCtx, host: Host, libio: LibraryIO, deps: PointerDeps): PointerView {
  const { canvas } = ctx;
  const { cam, cssSize, cosk, rebuild } = host;
  const { hideHome } = libio;

  /* 缩放下限（最大 度/像素）＝全图恰好整屏 × 1.1 余量：v0.14 硬编码 0.5 与图无关，
     战术图 bbox 0.24° 时形同无限制（可缩到全图不足半屏）。无 bbox 退回 0.5；
     不低于该图默认开图缩放 degPerPx0，免开图即被钳进。传入 zoomAtView(…, maxDpp)。 */
  const maxDppFit = (): number => {
    const meta = ctx.meta, bb = meta?.bbox, [w, h] = cssSize();
    if (!bb || !(w > 0 && h > 0)) return 0.5;
    const cosLat = meta?.worldModel === "flat" ? 1 : Math.max(0.05, Math.cos((bb.latMin + bb.latMax) / 2 * Math.PI / 180));
    const fit = Math.max((bb.lonMax - bb.lonMin) * cosLat / w, (bb.latMax - bb.latMin) / h) * 1.1;
    return Math.max(fit, meta?.view?.degPerPx0 || 0);
  };

  /* 悬停速览提示（v0.14 #tip）：地点/连线 hover 出小卡；拖动/绘制时隐藏 */
  const tip = $("tip");
  const escHtml = (s: unknown): string => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const updateTip = (x: number, y: number, nd: WorldNode | null): void => {
    const world = worldSig.value;
    if (!world) { tip.style.display = "none"; return; }
    const layers = layersSig.peek(), yearNow = yearSig.peek();
    const ed = !nd ? pickEdge(cam(), ctx.meta, world, yearNow, x, y, layers) : null;
    let html = "";
    if (nd) {
      const isEv = nd.type === "event";
      const et = EVENT_TYPES[nd.evtype!] || EVENT_TYPES.battle;
      const s = NODE_STYLE[nd.type] || NODE_STYLE.city;
      const fid = ownerAt(nd, yearNow);
      const f = fid ? world.factions.find(q => q.id === fid) : null;
      const pop = (!isEv && nd.字段 && nd.字段.人口) ? ` · 人口 ${escHtml(nd.字段.人口)}` : "";
      html = `<b>${escHtml(nd.名称 || nd.id)}</b> ${isEv ? `${et.sym}${et.名}` : s.名}${isEv && nd.year != null ? ` · ${escHtml(fmtWhen(calOf(ctx.meta.calendar), ctx.meta.mapKind === "tactical", nd.year, true))}` : ""}` +
        `${f ? ` · ${escHtml(f.名称 || f.id)}` : (isEv ? "" : " · 中立")}${pop}${isEv && nd.result ? `<br>${escHtml(nd.result)}` : ""}`;
    } else if (ed) {
      const st = EDGE_STYLE[ed.edge.type] || { 名: ed.edge.type };
      const a = world.nodes.find(q => q.id === ed.edge.from), b = world.nodes.find(q => q.id === ed.edge.to);
      const elen = Array.isArray(ed.edge.pts) && ed.edge.pts.length >= 2 ? polylineKm(ctx.meta, ed.edge.pts)
        : (a && b ? edgeLenKm(ctx.meta, a, b, ed.edge.type, (ed.edge.from || "") + (ed.edge.to || "")) : 0);
      html = `<b>${escHtml(ed.edge.名称 || st.名)}</b> · ${st.名} ≈${fmtKm(elen)}`;
    }
    if (html) {
      tip.innerHTML = html;
      tip.style.left = Math.min(x + 14, canvas.clientWidth - 200) + "px";
      tip.style.top = (y + 10) + "px";
      tip.style.display = "block";
    } else tip.style.display = "none";
    if (modeSig.peek() === "browse") canvas.style.cursor = html ? "pointer" : "";
  };
  canvas.addEventListener("mouseleave", () => { tip.style.display = "none"; });

  let drag: PanDrag | null = null, nodeDrag: { id: string; pushed: boolean } | null = null,
    paintStroke: PaintStroke | null = null, opStroke: OpStroke | null = null,
    terrainStroke: boolean | null = null, decorStroke: DecorStroke | null = null,
    boxSel: BoxSel | null = null, multiDrag: MultiDrag | null = null,
    unitDrag: { id: string; pushed: boolean } | null = null, rangeDrag: RangeDrag | null = null,
    mxy: [number, number] | null = null;
  let spaceHeld = false, linkDrag: { fromId: string; x: number; y: number; moved: boolean } | null = null,
    decorDrag: { id: string; pushed: boolean } | null = null,
    clickTrack: { x: number; y: number; moved: boolean } | null = null, nudgeT = 0;
  /* 拾取门（点选/悬停/框选与绘制同一套可见性）：图层显隐 + 编辑态全见/浏览态 rank 缩放门——
     关掉的层不再"隐形可选"；部队/布景拾取同规则在各调用点看 units/decor 层。 */
  const pickGate = () => ({ layers: layersSig.peek(), editing: modeSig.peek() === "edit" });
  const decorPickable = () => layersSig.peek().decor !== false;
  const paintDab = (x: number, y: number): void => {
    if (!paintStroke) return;
    const ll = unproject(cam(), x, y);
    const lon = dataLon(ctx.meta, ll[0]);
    const pd = paintStep(ctx.meta);
    if (!brushCells(paintStroke.set, paintStroke.dims, lon, ll[1], brushSizeSig.value, brushEraseSig.value, pd)) return;
    const { fid, idx, dims, set } = paintStroke;
    mutateWorldLive(w => {
      const f = w.factions.find(x2 => x2.id === fid);
      const L = f && f.paint && f.paint[idx];
      if (L) f!.paint![idx] = { ...L, cells: setToCells(dims.bb, set, pd) };   // L 真⇒f/f.paint 真；换层对象=overlay 环缓存自动失效
    });
  };
  const terrainDab = (x: number, y: number): void => {
    const grid = ctx.grid;
    if (!grid) return;
    const ll = unproject(cam(), x, y);
    let changed = false;
    // 返回 changed 给 mutateWorldLive：空笔（涂同地形/无变化）不广播、不 editVer++（不留空撤销、不空触发自动保存）
    mutateWorldLive(w => {
      changed = terrainHeightSig.peek()
        ? paintHeightAt(w, grid, dataLon(ctx.meta, ll[0]), ll[1], brushEraseSig.peek() ? -0.02 : 0.02, brushSizeSig.value, eraNewSig.peek())
        : paintTerrainAt(w, grid, yearSig.peek(), dataLon(ctx.meta, ll[0]), ll[1], paintTerrainSig.value, brushSizeSig.value, brushEraseSig.value, eraNewSig.peek());
      return changed;
    });
    if (changed) rebuild();   // overrides 变了→重建网格与高程场（undo 靠 terrKey 重建）
  };
  const decorPlace = (x: number, y: number): void => {
    const ll = unproject(cam(), x, y);
    const kind = decorKindSig.value;
    mutateWorldLive(w => {
      if (kind.startsWith("img:")) { const a = poolGet(kind.slice(4)); if (a) addAsset(w, a); }   // 首次落章内嵌资产（幂等）
      applyEra(addDecor(w, ll[0], ll[1], kind, decorSizeSig.value), eraNewSig.peek());
    });
  };
  const decorEraseRadius = (): number => 6 + 5 * brushSizeSig.value;   // v0.14 decorEraseAt：半径随「大小」滑杆
  const decorEraseSweep = (x: number, y: number): void => {
    const w0 = worldSig.peek();
    if (!w0 || !decorPickable()) return;   // 布景层隐藏＝不许盲擦看不见的章
    const ids = decorIdsInRadius(cam(), ctx.meta, w0, yearSig.peek(), x, y, decorEraseRadius());
    if (ids.length) mutateWorldLive(w => { for (const id of ids) removeDecor(w, id); });
  };
  /* Alt+点=取样（吸管，对齐 v0.14 sampleAt）：地形取该格 / 布景取印章种类+大小 / 涂域取该格所属派系与层 */
  const sampleAt = (x: number, y: number): void => {
    const world = worldSig.peek();
    const sub = editSubSig.peek();
    const ll = unproject(cam(), x, y);
    const lon = dataLon(ctx.meta, ll[0]);
    if (sub === "terrain" && ctx.grid) {
      const c = Math.floor((lon - ctx.grid.bb.lonMin) / ctx.grid.step), r = Math.floor((ll[1] - ctx.grid.bb.latMin) / ctx.grid.step);
      const t = ctx.grid.cells[r] && ctx.grid.cells[r][c];
      if (t) { paintTerrainSig.value = canonComposite(t); brushEraseSig.value = false; }   // 取样取复合（两轴笔；Alt+点取样该格地貌/生态）
      return;
    }
    if (sub === "decor" && world) {
      const d = decorPickable() ? pickDecor(cam(), ctx.meta, world, yearSig.peek(), x, y) : null;
      if (d) { decorKindSig.value = d.kind; decorSizeSig.value = d.size || 1; brushEraseSig.value = false; }
      return;
    }
    if (sub === "paint" && world) {
      const pd = paintStep(ctx.meta);
      const { bb } = paintDims(ctx.meta, pd);
      const key = Math.floor((lon - bb.lonMin) / pd) + "," + Math.floor((ll[1] - bb.latMin) / pd);
      for (const f of world.factions) {
        const Ls = f.paint || [];
        for (let i = 0; i < Ls.length; i++) {
          if (cellsToSet(bb, Ls[i].cells, pd).has(key)) {
            paintFactionSig.value = f.id; paintLayerSig.value = i; brushEraseSig.value = false;
            return;
          }
        }
      }
    }
  };
  /* 连线落库（点击-点击与拖拽两路径共用）：重复连线先查后报——addEdge 返 null 的静默 no-op
     曾连"已保存"都不说一声（2026-07-16 P3）；先查也避免 mutateWorld 空改动留一步幽灵撤销。 */
  const tryLink = (from: string, to: string): void => {
    const w0 = worldSig.peek();
    const tp = linkTypeSig.peek();
    if (w0 && w0.edges.some(ed => ed.type === tp && ((ed.from === from && ed.to === to) || (ed.from === to && ed.to === from)))) {
      showToast(`两地已有一条${(EDGE_STYLE[tp] || { 名: tp }).名}，未重复新建`);
      return;
    }
    mutateWorld(w => { const ed = addEdge(w, from, to, tp); if (ed) applyEra(ed, eraNewSig.peek()); });
  };
  /* 方向键微调选中地点（对齐 v0.14 nudgeSel）：每按≈2 屏幕像素；1.2s 内连续按键合并为一步撤销 */
  const nudgeSel = (k: string): void => {
    const sel = selSig.peek();
    if (!worldSig.peek()) return;
    const nodeIds = sel && sel.kind === "node" ? [sel.id] : sel && sel.kind === "multi" ? sel.ids : [];
    const unitIds = sel && sel.kind === "multi" ? (sel.unitIds || []) : [];   // 框选含部队：与整组拖移一致，同步微调
    if (!nodeIds.length && !unitIds.length) return;
    const now = performance.now();
    if (now - nudgeT > 1200) pushHistoryOnce();
    nudgeT = now;
    const d = ctx.view.degPerPx * 2;
    const T = yearSig.peek();
    const dLon = (k === "ArrowLeft" ? -d : k === "ArrowRight" ? d : 0) / cosk();
    const dLat = k === "ArrowUp" ? d : k === "ArrowDown" ? -d : 0;
    mutateWorldLive(w => {
      for (const id of nodeIds) {
        const nd = w.nodes.find(x => x.id === id);
        if (nd) moveNode(w, id, nd.lon + dLon, nd.lat + dLat);
      }
      for (const id of unitIds) {          // 部队＝改写当前时刻航点（同单部队拖动 / 整组拖移语义）
        const u = (w.units || []).find(x => x.id === id);
        const p = u ? unitPos(u, T) : null;
        if (p) setUnitWaypoint(w, id, T, p.lon + dLon, p.lat + dLat);
      }
    });
  };
  /* 整组拖移起手（按住框选中的地点/部队任一成员）：地点记原位走 moveNode 平移；
     部队记「起手时刻」原位，拖动=整组改写该时刻航点（与单部队拖动同语义） */
  const startMultiDrag = (sv: Extract<Sel, { kind: "multi" }>, e: PointerEvent): void => {
    stopPlay();   // 播放中拖拽冻结时刻：起手 T=写入 T=收笔 toast 报的 T（否则 toast 报松手时刻、与写入不符）
    const world = worldSig.value!;
    const ll0 = unproject(cam(), e.offsetX, e.offsetY);
    const T = yearSig.peek();
    multiDrag = { sx: ll0[0], sy: ll0[1], t: T, pushed: false,
      orig: sv.ids.map(id => { const nd = world.nodes.find(n => n.id === id); return nd ? { id, lon0: nd.lon, lat0: nd.lat } : null; })
        .filter((o): o is { id: string; lon0: number; lat0: number } => !!o),
      uorig: (sv.unitIds || []).map(id => {
        const un = (world.units || []).find(x => x.id === id), p = un && unitPos(un, T);
        return p ? { id, lon0: p.lon, lat0: p.lat } : null;
      }).filter((o): o is { id: string; lon0: number; lat0: number } => !!o) };
    canvas.style.cursor = "move";
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.addEventListener("pointerdown", e => {
    tip.style.display = "none";   // 拖动/绘制期间不出速览
    const world = worldSig.value;
    // 中键=拖动地图（任何模式，v0.14）
    if (e.button === 1) {
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, lon0: ctx.view.lon0, lat0: ctx.view.lat0, click: false };
      canvas.style.cursor = "grabbing";
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;   // 右键动作走 contextmenu
    // Space+左键拖=平移（绘图软件惯例，任何模式，v0.14）
    if (spaceHeld) {
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, lon0: ctx.view.lon0, lat0: ctx.view.lat0, click: false };
      canvas.style.cursor = "grabbing";
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    // 作战线绘制态（模态，覆盖任何编辑子工具）：按住拖一笔成线
    if (world && modeSig.value === "edit" && opDrawSig.value) {
      const ll = unproject(cam(), e.offsetX, e.offsetY);
      opStroke = { pts: [[+dataLon(ctx.meta, ll[0]).toFixed(3), +ll[1].toFixed(3)]], lastX: e.offsetX, lastY: e.offsetY };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    // 河流自由画线：连线子工具选「河流」时按住拖一笔成河（镜像作战线画线，无需锚地点）
    if (world && modeSig.value === "edit" && editSubSig.value === "link" && linkTypeSig.value === "river") {
      const ll = unproject(cam(), e.offsetX, e.offsetY);
      opStroke = { pts: [[+dataLon(ctx.meta, ll[0]).toFixed(3), +ll[1].toFixed(3)]], lastX: e.offsetX, lastY: e.offsetY, river: true };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    // Alt+点=取样（吸管：地形/布景/涂域派系）
    if (world && modeSig.value === "edit" && e.altKey && ["paint", "terrain", "decor"].includes(editSubSig.value)) {
      e.preventDefault();
      sampleAt(e.offsetX, e.offsetY);
      return;
    }
    if (world && modeSig.value === "edit" && editSubSig.value === "paint") {
      const fid = paintFactionSig.value;
      if (!fid || !world.factions.some(f => f.id === fid)) return;
      beginStroke();                              // 一笔=一步撤销（收笔回收空笔）
      let idx = paintLayerSig.value;
      // 建首层才广播；钳制/原样返回=无实际改动（返回 false 保住收笔的空笔回收）
      mutateWorldLive(w => {
        const f = w.factions.find(x => x.id === fid);
        if (!f) return false;
        const n0 = (f.paint || []).length;
        idx = ensurePaintLayer(f, idx);
        return f.paint!.length !== n0;
      });
      paintLayerSig.value = idx;
      const pd = paintStep(ctx.meta);
      const dims = paintDims(ctx.meta, pd);
      const f2 = worldSig.peek()!.factions.find(x => x.id === fid);
      paintStroke = { set: cellsToSet(dims.bb, (f2!.paint![idx].cells) || [], pd), dims, fid, idx };
      canvas.setPointerCapture(e.pointerId);
      paintDab(e.offsetX, e.offsetY);
      return;
    }
    if (world && modeSig.value === "edit" && editSubSig.value === "terrain") {
      beginStroke();                              // 一笔=一步撤销（undo 按 terrKey 重建网格；收笔回收空笔）
      terrainStroke = true;
      canvas.setPointerCapture(e.pointerId);
      terrainDab(e.offsetX, e.offsetY);
      return;
    }
    if (world && modeSig.value === "edit" && editSubSig.value === "decor") {
      beginStroke();                              // 一笔=一步撤销（收笔回收空笔，如橡皮扫空白）
      const erase = brushEraseSig.value;
      decorStroke = { erase, lastX: e.offsetX, lastY: e.offsetY };
      if (erase) decorEraseSweep(e.offsetX, e.offsetY); else decorPlace(e.offsetX, e.offsetY);
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    // 视野/火力圈半径手柄（编辑·选择/部队工具，仅选中对象的圈显示手柄）：按住拖=调半径，一次拖动=一步撤销
    if (world && modeSig.value === "edit" && ["select", "unit"].includes(editSubSig.value)) {
      const sv = selSig.value;
      const hu = sv && sv.kind === "unit" ? sv.id : null, hn = sv && sv.kind === "node" ? sv.id : null;
      if (hu || hn) {
        const Lyr = layersSig.value;
        const rh = pickRangeHandle(cam(), ctx.meta, world, yearSig.value, e.offsetX, e.offsetY, hu, hn,
          { fire: Lyr.ranges !== false, vision: Lyr.vision !== false });
        if (rh) {
          stopPlay();   // 播放中拖半径：冻结时刻，圈心不随播放漂移
          rangeDrag = { ...rh, pushed: false };
          canvas.style.cursor = "ew-resize"; canvas.setPointerCapture(e.pointerId);
          return;
        }
      }
    }
    // 部队工具（战术图）：按住部队拖动=记录/改写当日位置；Shift+拖=框选；按住框选成员=整体拖移
    if (world && modeSig.value === "edit" && editSubSig.value === "unit" && isTacSig.value) {
      if (e.shiftKey) {
        boxSel = { x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY, moved: false };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      const un = layersSig.peek().units !== false   // 部队层隐藏＝不可点选（同框选门）
        ? pickUnit(cam(), ctx.meta, world, yearSig.value, e.offsetX, e.offsetY) : null;
      if (un) {
        const s = selSig.value;
        if (s && s.kind === "multi" && s.unitIds && s.unitIds.includes(un.id)) { startMultiDrag(s, e); return; }
        stopPlay();   // 播放中拖部队：冻结时刻，航点只落起手当日（否则逐 move 散作一串、toast 报错日）
        unitDrag = { id: un.id, pushed: false }; selSig.value = { kind: "unit", id: un.id };
        canvas.style.cursor = "move"; canvas.setPointerCapture(e.pointerId); return;
      }
    }
    if (world && modeSig.value === "edit" && editSubSig.value === "select") {
      // Shift+拖=强制框选（压过元素拾取，v0.14）
      if (e.shiftKey) {
        boxSel = { x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY, moved: false };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (isTacSig.value && layersSig.peek().units !== false) {   // 部队优先于地点（框小、常压在地点上层）；层隐藏不可选
        const un = pickUnit(cam(), ctx.meta, world, yearSig.value, e.offsetX, e.offsetY);
        if (un) {
          const s = selSig.value;
          if (s && s.kind === "multi" && s.unitIds && s.unitIds.includes(un.id)) { startMultiDrag(s, e); return; }   // 按住框选中的部队=整体拖移
          stopPlay();   // 同军工具：播放中拖部队冻结时刻
          unitDrag = { id: un.id, pushed: false }; selSig.value = { kind: "unit", id: un.id };
          canvas.style.cursor = "move"; canvas.setPointerCapture(e.pointerId); return;
        }
      }
      const hit = pickNode(cam(), ctx.meta, world, yearSig.value, e.offsetX, e.offsetY, pickGate());
      if (hit) {
        const s = selSig.value;
        if (s && s.kind === "multi" && s.ids.includes(hit.id)) {   // 按住框选中的地点=整体拖移（地点+部队）
          startMultiDrag(s, e);
        } else {
          nodeDrag = { id: hit.id, pushed: false };
          selSig.value = { kind: "node", id: hit.id };
          canvas.style.cursor = "move";
          canvas.setPointerCapture(e.pointerId);
        }
        return;
      }
      const dd = decorPickable() ? pickDecor(cam(), ctx.meta, world, yearSig.value, e.offsetX, e.offsetY) : null;   // 按住布景=拖移（v0.14）；层隐藏不可选
      if (dd) {
        decorDrag = { id: dd.id, pushed: false };
        canvas.style.cursor = "move"; canvas.setPointerCapture(e.pointerId); return;
      }
      // 空白处拖动=框选（v0.14 编辑·选择默认；平移走 空格/中键/WASD）
      boxSel = { x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY, moved: false };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (world && modeSig.value === "edit" && editSubSig.value === "link") {
      const hit = pickNode(cam(), ctx.meta, world, yearSig.value, e.offsetX, e.offsetY, pickGate());
      if (hit) {
        const from = linkFromSig.peek();
        if (from && from !== hit.id) {            // 第二点：成线（点击-点击路径）
          tryLink(from, hit.id);
          return;
        }
        linkFromSig.value = hit.id;               // 起点：可拖到另一地点成线（拖拽路径）
        linkDrag = { fromId: hit.id, x: e.clientX, y: e.clientY, moved: false };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
    }
    if (modeSig.value === "browse") {
      if (world && e.shiftKey) {                  // Shift+拖=框选（浏览）
        boxSel = { x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY, moved: false };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      drag = { x: e.clientX, y: e.clientY, lon0: ctx.view.lon0, lat0: ctx.view.lat0, click: true };   // 左键拖=平移（网页地图惯例）
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    // 量距/行军/编辑其余工具：空白按下只作点击追踪（不平移，v0.14）
    clickTrack = { x: e.clientX, y: e.clientY, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", e => {
    mxy = [e.offsetX, e.offsetY];
    {   // 底栏经纬度（v0.14 fmtLon/coordDec：深放大 4 位小数）+ 光标高程（场双线性×标定——与渲染面/等高线同源）
      const ll = unproject(cam(), e.offsetX, e.offsetY);
      const dec = ctx.view.degPerPx < 0.002 ? 4 : 2;
      let hTxt = "";
      if (ctx.grid && ctx.elevField) {
        const g = ctx.grid, lonD = dataLon(ctx.meta, ll[0]);
        if (lonD >= g.bb.lonMin && lonD <= g.bb.lonMax && ll[1] >= g.bb.latMin && ll[1] <= g.bb.latMax)
          hTxt = ` ｜ 高程≈${Math.round(elevSmooth(ctx.elevField, g, lonD, ll[1]) * elevUnitM(ctx.meta))}m`;
      }
      $("ftCoord").textContent = `经纬度 ${dataLon(ctx.meta, ll[0]).toFixed(dec)}°, ${ll[1].toFixed(dec)}°${hTxt}`;
    }
    /* 拖态悬挂自愈：拖拽中弹 confirm()/alert() 会吞掉 pointerup——按键已全松而拖态仍在时，
       按 pointercancel 语义中止（只清态不成交），免得松手后的悬停继续改写世界（2026-07-16 P3）。 */
    if (e.buttons === 0 && (drag || nodeDrag || unitDrag || decorDrag || multiDrag || rangeDrag
      || boxSel || linkDrag || clickTrack || paintStroke || terrainStroke || decorStroke || opStroke)) abortDrags();
    if (opStroke) {
      if (Math.hypot(e.offsetX - opStroke.lastX, e.offsetY - opStroke.lastY) >= 7) {
        const ll = unproject(cam(), e.offsetX, e.offsetY);
        opStroke.pts.push([+dataLon(ctx.meta, ll[0]).toFixed(3), +ll[1].toFixed(3)]);
        opStroke.lastX = e.offsetX; opStroke.lastY = e.offsetY;
      }
      return;
    }
    if (paintStroke) { paintDab(e.offsetX, e.offsetY); return; }
    if (terrainStroke) { terrainDab(e.offsetX, e.offsetY); return; }
    if (decorStroke) {
      if (decorStroke.erase) decorEraseSweep(e.offsetX, e.offsetY);
      else {
        const sp = Math.max(16, 24 * decorSizeSig.value);   // 拖动按间距落章
        if (Math.hypot(e.offsetX - decorStroke.lastX, e.offsetY - decorStroke.lastY) >= sp) {
          decorPlace(e.offsetX, e.offsetY); decorStroke.lastX = e.offsetX; decorStroke.lastY = e.offsetY;
        }
      }
      return;
    }
    if (boxSel) {
      boxSel.x1 = e.offsetX; boxSel.y1 = e.offsetY;
      if (Math.abs(boxSel.x1 - boxSel.x0) + Math.abs(boxSel.y1 - boxSel.y0) > 4) boxSel.moved = true;
      return;
    }
    if (multiDrag) {
      if (!multiDrag.pushed) { pushHistoryOnce(); multiDrag.pushed = true; }
      const ll = unproject(cam(), e.offsetX, e.offsetY);
      const dLon = ll[0] - multiDrag.sx, dLat = ll[1] - multiDrag.sy;
      const md = multiDrag;
      mutateWorldLive(w => {
        for (const o of md.orig) moveNode(w, o.id, o.lon0 + dLon, o.lat0 + dLat);
        for (const o of md.uorig) setUnitWaypoint(w, o.id, md.t, o.lon0 + dLon, o.lat0 + dLat);   // 整组改写起手时刻航点
      });
      return;
    }
    if (rangeDrag) {
      if (!rangeDrag.pushed) { pushHistoryOnce(); rangeDrag.pushed = true; }   // 一次拖动=一步撤销
      const ll = unproject(cam(), e.offsetX, e.offsetY);
      const km = distKm(ctx.meta, rangeDrag.lon, rangeDrag.lat, dataLon(ctx.meta, ll[0]), ll[1]);   // 半径=圈心到光标的地理距离（球面周期化，跨拷贝安全）
      const rd = rangeDrag;
      mutateWorldLive(w => typeof rd.ring === "string"
        ? setUnitRing(w, rd.id, rd.ring, km)      // 部队视野/火力（同机制：拖近零清除）
        : setNodeRangeKm(w, rd.id, rd.ring, km)); // 据点防御圈（钳底不删）
      return;
    }
    if (unitDrag) {
      if (!unitDrag.pushed) { pushHistoryOnce(); unitDrag.pushed = true; }   // 一次拖动=一步撤销
      const ll = unproject(cam(), e.offsetX, e.offsetY);
      const ud = unitDrag;
      mutateWorldLive(w => setUnitWaypoint(w, ud.id, yearSig.peek(), ll[0], ll[1]));   // 落/改当日航点
      return;
    }
    if (nodeDrag) {
      if (!nodeDrag.pushed) { pushHistoryOnce(); nodeDrag.pushed = true; }   // 一次拖动=一步撤销
      const ll = unproject(cam(), e.offsetX, e.offsetY);
      const nd = nodeDrag;
      mutateWorldLive(w => moveNode(w, nd.id, ll[0], ll[1]));
      return;
    }
    if (decorDrag) {   // 拖移布景（v0.14 movingDecor）
      if (!decorDrag.pushed) { pushHistoryOnce(); decorDrag.pushed = true; }
      const ll = unproject(cam(), e.offsetX, e.offsetY);
      const dd = decorDrag;
      mutateWorldLive(w => {
        const d = (w.decor || []).find(x => x.id === dd.id);
        if (d) { d.lon = +dataLon(ctx.meta, ll[0]).toFixed(3); d.lat = +ll[1].toFixed(3); }
      });
      return;
    }
    if (linkDrag) {   // 连线拖拽：橡皮筋在 rAF 里画（linkFromSig+mxy），这里只记位移
      if (Math.abs(e.clientX - linkDrag.x) + Math.abs(e.clientY - linkDrag.y) > 4) linkDrag.moved = true;
      return;
    }
    if (clickTrack) {   // 非平移工具的点击追踪：位移过阈值=不是点击
      if (Math.abs(e.clientX - clickTrack.x) + Math.abs(e.clientY - clickTrack.y) > 3) clickTrack.moved = true;
      return;
    }
    if (!drag) {
      // 悬停圈手柄→可拖光标（仅编辑态选中对象的圈；离开即还原）
      if (worldSig.value && modeSig.value === "edit" && ["select", "unit"].includes(editSubSig.value)) {
        const sv = selSig.value;
        const hu = sv && sv.kind === "unit" ? sv.id : null, hn = sv && sv.kind === "node" ? sv.id : null;
        const Lyr = layersSig.value;
        const over = (hu || hn) && pickRangeHandle(cam(), ctx.meta, worldSig.value, yearSig.value, e.offsetX, e.offsetY, hu, hn,
          { fire: Lyr.ranges !== false, vision: Lyr.vision !== false });
        if (over && canvas.style.cursor !== "ew-resize") canvas.style.cursor = "ew-resize";
        else if (!over && canvas.style.cursor === "ew-resize") canvas.style.cursor = "";
      }
      const h = worldSig.value ? pickNode(cam(), ctx.meta, worldSig.value, yearSig.value, e.offsetX, e.offsetY, pickGate()) : null;
      hoverSig.value = h;
      if (!spaceHeld) updateTip(e.offsetX, e.offsetY, h);
      return;
    }
    const c = clampView({ lon0: drag.lon0 - (e.clientX - drag.x) * ctx.view.degPerPx / cosk(),
                          lat0: drag.lat0 + (e.clientY - drag.y) * ctx.view.degPerPx }, ctx.meta);
    ctx.view.lon0 = c.lon0; ctx.view.lat0 = c.lat0;
  });
  canvas.addEventListener("pointerup", e => {
    const world = worldSig.value;
    if (opStroke) {   // 收笔：RDP 简化后入库并自动选中（<2 点=只点了一下，不成线/河）
      const raw = opStroke.pts, wasRiver = opStroke.river; opStroke = null;
      const simp = raw.length >= 2 && world
        ? rdp(raw, ctx.view.degPerPx * 2.5).map(p => [+p[0].toFixed(3), +p[1].toFixed(3)] as [number, number]) : [];
      if (simp.length >= 2 && wasRiver) {          // 自由画河：入库为一条 river 边（pts 折线、无端点），自动选中
        let idx = -1;
        mutateWorld(w => { const ed = addRiver(w, simp); applyEra(ed, eraNewSig.peek()); idx = w.edges.length - 1; });
        if (idx >= 0) selSig.value = { kind: "edge", idx };
      } else if (simp.length >= 2 && opDrawSig.value) {   // 作战线：原语义
        const dd = opDrawSig.value; let idx: number | null = null;
        mutateWorld(w => { idx = addOp(w, dd.evId, dd.kind, simp); });
        cancelOpDraw();
        if (idx != null) selectOp(dd.evId, idx);
      }
      return;
    }
    if (paintStroke) { paintStroke = null; endStroke(); return; }
    if (terrainStroke) { terrainStroke = null; endStroke(); return; }
    if (decorStroke) { decorStroke = null; endStroke(); return; }
    if (multiDrag) {
      const md = multiDrag; multiDrag = null; canvas.style.cursor = "";
      if (md.pushed && md.uorig.length)   // 含部队的整组拖移收笔：报所记时刻（时间坞忘对时的防呆）
        showToast(`已记录 ${fmtWhen(calOf(ctx.meta.calendar), ctx.meta.mapKind === "tactical", yearSig.peek())} 位置`, { undo: true });
      return;
    }
    if (rangeDrag) { rangeDrag = null; canvas.style.cursor = ""; return; }   // 圈半径拖动收笔（半径已随移动写入）
    if (unitDrag) {   // 拖动部队收笔：航点已随移动写入——toast 报所记时刻（时间坞忘对时的防呆）
      const ud = unitDrag; unitDrag = null; canvas.style.cursor = "";
      if (ud.pushed) showToast(`已记录 ${fmtWhen(calOf(ctx.meta.calendar), ctx.meta.mapKind === "tactical", yearSig.peek())} 位置`, { undo: true });
      return;
    }
    if (decorDrag) { decorDrag = null; canvas.style.cursor = ""; return; }
    if (linkDrag) {   // 连线拖拽收笔：拖到另一地点=成线；拖到空处=取消起点；原地未动=保持起点（可再点第二点）
      const ld = linkDrag; linkDrag = null;
      const hit = world ? pickNode(cam(), ctx.meta, world, yearSig.value, e.offsetX, e.offsetY, pickGate()) : null;
      if (hit && hit.id !== ld.fromId) {
        tryLink(ld.fromId, hit.id);
        linkFromSig.value = null;
      } else if (ld.moved) linkFromSig.value = null;
      return;
    }
    if (boxSel) {
      const b = boxSel; boxSel = null;
      if (!b.moved) {   // 只点未拖=点击（编辑·选择的空白拖框选与点选共用起点）
        if (world) clickAt(e);
        return;
      }
      const ids = world ? nodesInBox(cam(), ctx.meta, world, yearSig.value, b.x0, b.y0, b.x1, b.y1, pickGate()) : [];
      const unitIds = world && isTacSig.peek() && layersSig.peek().units !== false   // 部队层隐藏时不隔空捕获
        ? unitsInBox(cam(), ctx.meta, world, yearSig.value, b.x0, b.y0, b.x1, b.y1) : [];
      selSig.value = (ids.length || unitIds.length)
        ? { kind: "multi", ids, ...(unitIds.length ? { unitIds } : {}) } : null;
      return;
    }
    if (nodeDrag) { nodeDrag = null; canvas.style.cursor = ""; return; }
    if (clickTrack) {   // 非平移工具：未位移=点击动作
      const ct = clickTrack; clickTrack = null;
      if (!ct.moved && world) clickAt(e);
      return;
    }
    if (drag) {
      const d = drag; drag = null;
      canvas.style.cursor = spaceHeld ? "grab" : "";
      if (d.click && !spaceHeld && world && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) clickAt(e);   // 浏览左键未拖动=点击选择
      return;
    }
  });
  /* 中止一切进行中拖态——只清态、不提交（成线/框选落选中这类「成交」动作只在 pointerup 发生）；
     笔刷类先 endStroke 回收空笔，已落下的笔迹保留（起笔时已入撤销栈一步）。
     pointercancel（触控滚动/笔离屏/系统手势）与拖态悬挂自愈共用。缺这条时拖态残留、下次按下双重起笔（2026-07-12 P2）。 */
  const abortDrags = (): void => {
    if (opStroke) opStroke = null;                    // 保持画线武装态可重画（同 <2 点收笔语义）
    if (paintStroke) { paintStroke = null; endStroke(); }
    if (terrainStroke) { terrainStroke = null; endStroke(); }
    if (decorStroke) { decorStroke = null; endStroke(); }
    boxSel = null; multiDrag = null; rangeDrag = null; unitDrag = null;
    nodeDrag = null; decorDrag = null; linkDrag = null; clickTrack = null;
    drag = null;
    canvas.style.cursor = spaceHeld ? "grab" : "";
  };
  canvas.addEventListener("pointercancel", abortDrags);
  /* 点击动作（对齐旧 handleClick）：按模式/子工具分发 */
  function clickAt(e: PointerEvent): void {
    const world = worldSig.value;
    if (world) {
      const mode = modeSig.value;
      const hit = pickNode(cam(), ctx.meta, world, yearSig.value, e.offsetX, e.offsetY, pickGate());
      const ll = unproject(cam(), e.offsetX, e.offsetY);
      if (mode === "browse" || (mode === "edit" && editSubSig.value === "select")) {
        // 拾取优先级：地点 > 作战线 > 连线（部队随战术图批次）
        if (hit) { clearOpSel(); selSig.value = { kind: "node", id: hit.id }; }
        else {
          const selId = (selSig.value && selSig.value.kind === "node") ? selSig.value.id : null;
          const op = pickOp(cam(), ctx.meta, world, yearSig.value, e.offsetX, e.offsetY, layersSig.value, selId);
          if (op) selectOp(op.evId, op.i);
          else {
            clearOpSel();
            const ed = pickEdge(cam(), ctx.meta, world, yearSig.value, e.offsetX, e.offsetY, layersSig.value);
            selSig.value = ed ? { kind: "edge", idx: ed.idx } : null;
          }
        }
      } else if (mode === "measure" || mode === "route") {
        const pt = hit ? { lon: hit.lon, lat: hit.lat, node: hit } : { lon: +ll[0].toFixed(3), lat: +ll[1].toFixed(3) };
        const pts = routePtsSig.value;
        if (mode === "route" && pts.length >= 2) routePtsSig.value = [pt];   // 第三次点击=重新开始
        else routePtsSig.value = [...pts, pt];
      } else if (mode === "edit" && editSubSig.value === "add") {
        if (hit) selSig.value = { kind: "node", id: hit.id };
        else {
          let nid: string | null = null;
          mutateWorld(w => { nid = applyEra(addNode(w, "新地点", ll[0], ll[1]), eraNewSig.peek()).id; });
          if (nid) selSig.value = { kind: "node", id: nid };   // 落默认名并选中→检查器改名（去 prompt）
        }
      } else if (mode === "edit" && editSubSig.value === "label") {
        if (hit) selSig.value = { kind: "node", id: hit.id };
        else {
          let nid: string | null = null;
          mutateWorld(w => { nid = applyEra(addLabel(w, "新标注", ll[0], ll[1]), eraNewSig.peek()).id; });
          if (nid) selSig.value = { kind: "node", id: nid };   // 落默认文本并选中→检查器改多行/字号（去 prompt）
        }
      } else if (mode === "edit" && editSubSig.value === "link") {
        if (!hit) linkFromSig.value = null;
        else if (!linkFromSig.value || linkFromSig.value === hit.id) linkFromSig.value = hit.id;
        else {
          tryLink(linkFromSig.value, hit.id);
          linkFromSig.value = null;
        }
      } else if (mode === "edit" && editSubSig.value === "unit" && isTacSig.value) {
        selSig.value = null;   // 军工具点击＝选择（空击清选）；新增走军面板「＋ 新增部队」→按住列表项拖入地图
      } else if (mode === "edit" && editSubSig.value === "delete") {
        if (hit) deleteNodeAt(hit.id);   // 删工具即时删 + 可撤销 toast（去 confirm）
        else {
          const ed = pickEdge(cam(), ctx.meta, world, yearSig.value, e.offsetX, e.offsetY, layersSig.value);
          if (ed) deleteEdgeIdx(ed.idx);
        }
      }
    }
  }
  /* 右键单击动作（对齐 v0.14 rightAction；始终屏蔽浏览器菜单）：
     退画线态 / 量距撤上一点 / 布景删单个 / 取消连线起点 */
  canvas.addEventListener("contextmenu", e => {
    e.preventDefault();
    const mode = modeSig.value;
    if (opStroke && opStroke.river) { opStroke = null; return; }         // 右键取消在画河道
    if (opDrawSig.value) { opStroke = null; cancelOpDraw(); return; }   // 右键取消画线
    if (mode === "measure") { routePtsSig.value = routePtsSig.value.slice(0, -1); return; }   // 右键撤上一点
    if (mode === "edit" && editSubSig.value === "decor") {   // 右键=删单个布景（层隐藏不许盲删）
      const world = worldSig.value;
      const d = world && decorPickable() ? pickDecor(cam(), ctx.meta, world, yearSig.value, e.offsetX, e.offsetY) : null;
      if (d) mutateWorld(w => { removeDecor(w, d.id); });
      return;
    }
    if (mode === "edit" && editSubSig.value === "link") linkFromSig.value = null;   // 取消连线起点
  });
  addEventListener("keydown", e => {
    /* ⌘K / Ctrl+K：聚焦顶栏搜索框。
       须在输入框守卫之前（正在打字也能召唤）；弹层/图库打开时让位（焦点别落进被盖住的顶栏）。 */
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "k" || e.key === "K")
      && !settingsSig.peek() && !helpOpenSig.peek() && !ctx.libOpen) {
      e.preventDefault();
      const sb = document.getElementById("searchBox") as HTMLInputElement | null;
      if (sb) { sb.focus(); sb.select(); }
      return;
    }
    if (/INPUT|TEXTAREA|SELECT/.test((e.target && (e.target as HTMLElement).tagName) || "")) return;
    /* 弹层优先（v0.14 层级：设置 50 > 帮助 50 > 图库 45）：Esc 逐层退出 */
    if (settingsSig.peek()) { if (e.key === "Escape") closeSettings(); return; }
    if (helpOpenSig.peek()) { if (e.key === "Escape" || e.key === "?") helpOpenSig.value = false; return; }
    if (ctx.libOpen) {   // 开始界面可见：屏蔽地图快捷键；Esc=回当前图（v0.14 homeVisible 分支）
      if (e.key === "Escape" && ctx.mapId) hideHome();
      return;
    }
    if (e.key === "?") { helpOpenSig.value = true; return; }
    if (e.key === "Escape") {
      if (opStroke && opStroke.river) { opStroke = null; return; }        // 先退在画河道
      if (opDrawSig.value) { opStroke = null; cancelOpDraw(); return; }   // 再退画线态
      if (opSelSig.value) { clearOpSel(); return; }                       // 再退作战线选中
      if (inspEditSig.peek()) { inspEditSig.value = false; return; }      // 再退「随时编辑」表单回卡片（两段式：不一步清掉选中）
      selSig.value = null; linkFromSig.value = null; return;
    }
    /* 模式与子工具快捷键：1/2/3/4=览/测/绘/军；
       P=播放；0=复位视角；编辑内 Shift+1..7=子工具（新序重映射） */
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "p" || e.key === "P")) { togglePlay(); return; }
    if (e.key === " ") {   // Space=平移修饰键（按住+左键拖，任何模式）
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "BUTTON" || t.getAttribute("role") === "button")) return;   // 聚焦按钮时 Space＝激活（键盘可达性），不抢作平移
      e.preventDefault();
      if (!spaceHeld) { spaceHeld = true; if (!drag) canvas.style.cursor = "grab"; }
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (e.key === "1") { setRailTool("browse"); return; }
      if (e.key === "2") { setRailTool("measure"); return; }
      if (e.key === "3") { setRailTool("draw"); return; }
      if (e.key === "4") { if (isTacSig.peek()) setRailTool("units"); return; }
      if (e.key === "0") { deps.resetView(); return; }
    }
    /* ＋/－=以画布中心缩放；方向键=编辑模式选中地点微调（否则平移）；WASD=平移（v0.14） */
    const zoomCenter = (f: number): void => {
      const [w, h] = cssSize();
      const r = zoomAtView(ctx.view, ctx.meta, w, h, w / 2, h / 2, f, maxDppFit());
      ctx.view.lon0 = r.lon0; ctx.view.lat0 = r.lat0; ctx.view.degPerPx = r.degPerPx;
    };
    if (e.key === "+" || e.key === "=") { zoomCenter(0.8); return; }
    if (e.key === "-") { zoomCenter(1.25); return; }
    const panKey = ({ w: [0, -1], W: [0, -1], s: [0, 1], S: [0, 1], a: [-1, 0], A: [-1, 0], d: [1, 0], D: [1, 0],
      ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] } as Record<string, [number, number]>)[e.key];
    if (panKey) {
      e.preventDefault();
      const sel = selSig.peek();
      if (/^Arrow/.test(e.key) && modeSig.peek() === "edit" && sel && (sel.kind === "node" || sel.kind === "multi")) {
        nudgeSel(e.key);   // 编辑模式选中地点(含框选集)：方向键=微调位置（WASD 仍是平移）
        return;
      }
      const r = panByView(ctx.view, ctx.meta, panKey[0], panKey[1]);
      ctx.view.lon0 = r.lon0; ctx.view.lat0 = r.lat0;
      return;
    }
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && modeSig.value === "edit" && /^Digit[1-7]$/.test(e.code)) {
      /* 绘子工具新序＝地形/地点/连线/涂域/布景/标注；Shift+7=部队（仅战术图）。
         与 stgrid 一致：再按当前子工具＝退回选择态（无「选择」子工具，null 态即选择）。 */
      const subs: EditSub[] = (["terrain", "add", "link", "paint", "decor", "label"] as EditSub[])
        .concat(isTacSig.peek() ? (["unit"] as EditSub[]) : []);
      const s = subs[+e.code.slice(5) - 1];
      if (s) pickEditSub(s);   // 再按当前＝退回选择；连带清理（含 cancelOpDraw）见 state.pickEditSub
      return;
    }
    if (modeSig.value === "edit" && (editSubSig.value === "paint" || editSubSig.value === "terrain")) {
      if (e.key === "[") { brushSizeSig.value = Math.max(1, brushSizeSig.peek() - 1); return; }
      if (e.key === "]") { brushSizeSig.value = Math.min(12, brushSizeSig.peek() + 1); return; }
      if (e.key === "e" || e.key === "E") { brushEraseSig.value = !brushEraseSig.peek(); return; }
    }
    if (modeSig.value === "edit" && editSubSig.value === "decor") {
      if (e.key === "[") { if (brushEraseSig.peek()) brushSizeSig.value = Math.max(1, brushSizeSig.peek() - 1); else decorSizeSig.value = Math.max(0.5, Math.round((decorSizeSig.peek() - 0.1) * 10) / 10); return; }
      if (e.key === "]") { if (brushEraseSig.peek()) brushSizeSig.value = Math.min(12, brushSizeSig.peek() + 1); else decorSizeSig.value = Math.min(2.5, Math.round((decorSizeSig.peek() + 0.1) * 10) / 10); return; }
      if (e.key === "e" || e.key === "E") { brushEraseSig.value = !brushEraseSig.peek(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) redoWorld(); else undoWorld(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redoWorld(); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && worldSig.value) {
      const os = opSelSig.value;
      if (os) { mutateWorld(w => { removeOp(w, os.evId, os.i); }); clearOpSel(); return; }   // 选中作战线=删线
      const sel = selSig.value;
      if (sel && sel.kind === "multi") {   // 框选=批量删除（地点+部队）
        const uids = sel.unitIds || [];
        const what = [sel.ids.length ? `${sel.ids.length} 个地点及其连线与关联引用` : "",
          uids.length ? `${uids.length} 支部队及其全部动向` : ""].filter(Boolean).join("与");
        if (confirm(`删除框选的 ${what}？`)) {
          const ids = sel.ids.slice(), us = uids.slice();
          mutateWorld(w => { for (const id of ids) removeNode(w, id); for (const id of us) removeUnit(w, id); });
          selSig.value = null;
        }
        return;
      }
      if (sel && sel.kind === "unit") { deleteUnitAt(sel.id); return; }   // 选中部队=删（即时 + 可撤销 toast）
      const n = selNode(worldSig.value, sel);
      if (n) deleteNodeAt(n.id);
      else if (selEdge(worldSig.value, sel)) deleteEdgeIdx((sel as Extract<Sel, { kind: "edge" }>).idx);
    }
  });
  /* 军面板「＋ 新增部队」→ 按住列表项拖入地图放置（HTML5 DnD）：落点=当前时刻首航点。
     dragover 只对本类型放行——不碰文件拖入等其它拖放路径。 */
  canvas.addEventListener("dragover", e => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("text/unit-id")) e.preventDefault();
  });
  canvas.addEventListener("drop", e => {
    const id = e.dataTransfer ? e.dataTransfer.getData("text/unit-id") : "";
    if (!id) return;
    e.preventDefault();
    const w0 = worldSig.peek();
    if (!w0 || !isTacSig.peek() || !(w0.units || []).some(u => u.id === id)) return;
    const ll = unproject(cam(), e.offsetX, e.offsetY);
    mutateWorld(w => { setUnitWaypoint(w, id, yearSig.peek(), ll[0], ll[1]); });
    selSig.value = { kind: "unit", id };
    showToast(`已入场 ${fmtWhen(calOf(ctx.meta.calendar), true, yearSig.peek())}`, { undo: true });
  });
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    /* Alt+滚轮=笔刷/印章大小（对齐 v0.14 nudgeBrush：布景画笔态调印章，其余调笔刷半径） */
    if (e.altKey && modeSig.peek() === "edit") {
      const sub = editSubSig.peek(), dir = e.deltaY < 0 ? 1 : -1;
      if (sub === "decor" && !brushEraseSig.peek()) {
        decorSizeSig.value = Math.max(0.5, Math.min(2.5, Math.round((decorSizeSig.peek() + dir * 0.1) * 10) / 10));
        return;
      }
      if (sub === "paint" || sub === "terrain" || sub === "decor") {
        brushSizeSig.value = Math.max(1, Math.min(12, brushSizeSig.peek() + dir));
        return;
      }
    }
    const [w, h] = cssSize();
    const r = zoomAtView(ctx.view, ctx.meta, w, h, e.offsetX, e.offsetY, e.deltaY < 0 ? 0.85 : 1.18, maxDppFit());   // v0.14 缩放步进
    ctx.view.lon0 = r.lon0; ctx.view.lat0 = r.lat0; ctx.view.degPerPx = r.degPerPx;
  }, { passive: false });
  /* 双击=放大（Shift+双击=缩小；仅浏览——工具模式下双击是两次点击，v0.14） */
  canvas.addEventListener("dblclick", e => {
    if (modeSig.peek() !== "browse") return;
    const [w, h] = cssSize();
    const r = zoomAtView(ctx.view, ctx.meta, w, h, e.offsetX, e.offsetY, e.shiftKey ? 1.5 : 0.62, maxDppFit());
    ctx.view.lon0 = r.lon0; ctx.view.lat0 = r.lat0; ctx.view.degPerPx = r.degPerPx;
  });
  addEventListener("keyup", e => { if (e.key === " ") { spaceHeld = false; if (!drag) canvas.style.cursor = ""; } });
  addEventListener("blur", () => { spaceHeld = false; if (!drag) canvas.style.cursor = ""; });

  return {
    get mxy() { return mxy; },
    get opStroke() { return opStroke; },
    get boxSel() { return boxSel; },
    decorEraseRadius
  };
}
