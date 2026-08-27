/* 启动编排：渲染器创建 → Preact 组件挂载 → 图库启动流程 → 深链延迟量落地 →
   信号 effects（网格重建/自动保存/寻路上下文/HUD 同步）→ 顶栏/底栏 chrome 接线 →
   指针交互接线 → 侧栏分隔条 → rAF 帧循环。次序即 v0.14 语义，勿轻易重排。 */
import { effect } from "@preact/signals-core";
import { roadCellSet } from "../core/grid.ts";
import { clampView } from "../core/projection.ts";
import { createTerrainRenderer } from "../render/renderer.ts";
import { mountUI } from "../ui/mount.tsx";
import { initCalTemplates } from "../ui/CalendarOverlay.tsx";
import { worldSig, yearSig, selSig, layersSig, applyPreset, layersOpenSig,
  modeSig, armSig, routePtsSig, routeResSig, routeBusySig, setMode,
  editSubSig, editVerSig, isTacSig, linkTypeSig, tacReqSig,
  paintFactionSig, flyReqSig, helpOpenSig, openSettings, selectOp,
  analysisSubSig, uiPrefsSig, subDaySig, readOnlySig, libActionsSig,
  selNode, selEdge, selUnit, selFaction,
  type EditSub }
  from "../ui/state.ts";
import { wireInteractions } from "./pointer.ts";
import { wireOrchestration } from "./orchestrate.ts";
import { startFrameLoop } from "./frame.ts";
import { $ } from "./dom.ts";
import type { ShellCtx } from "./ctx.ts";
import type { DeepLink } from "./deeplink.ts";
import type { Host } from "./host.ts";
import type { LibraryIO } from "./library.ts";
import type { Meta } from "../core/types.ts";
import type { RoutePoint } from "../core/route.ts";

export async function startApp(ctx: ShellCtx, dl: DeepLink, host: Host, libio: LibraryIO): Promise<void> {
  const { canvas } = ctx;
  const { resize, rebuild } = host;
  const { autosave, boot, bindLib, goHome, refreshLib, openParentMap, openTacmap, genTactical } = libio;
  /* 界面偏好：主题（亮·素笺默认/暗·漆）×密度，本机 localStorage（yutu2.ui）持久化、
     不入存档；先于首帧应用到 #app 的 data-theme/data-den，避免主题闪变。 */
  try {
    const ui = JSON.parse(localStorage.getItem("yutu2.ui") || "{}") || {};
    uiPrefsSig.value = { theme: ui.theme === "dark" ? "dark" : "light", den: ui.den === "tight" ? "tight" : "loose", legend: ui.legend !== false,
      exportScale: [2, 3, 4].includes(ui.exportScale) ? ui.exportScale : 1 };
  } catch (e) {}
  initCalTemplates();   // 本机历法模板（建图时的模具，见 data/calstore 头注）；读不到就是没有，不拦启动
  effect(() => {
    const p = uiPrefsSig.value;
    const app = $("app");
    app.dataset.theme = p.theme; app.dataset.den = p.den;
    // 浏览器 chrome（PWA 标题栏/移动地址栏）随主题：与 --q-top 顶栏色同源，暗主题不再衬亮纸边
    const tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute("content", p.theme === "dark" ? "#1b1815" : "#f7f4ec");
    try {
      const cur = JSON.parse(localStorage.getItem("yutu2.ui") || "{}") || {};
      localStorage.setItem("yutu2.ui", JSON.stringify({ ...cur, theme: p.theme, den: p.den, legend: p.legend, exportScale: p.exportScale }));
    } catch (e) {}
  });
  resize();
  ctx.R = createTerrainRenderer(canvas, { force: dl.force });   // 无 WebGL2 自动退 CPU 瓦片；#force=cpu 可强制验证
  mountUI();
  bindLib();
  await boot();
  if (!ctx.grid) rebuild();
  if (dl.wantRo) readOnlySig.value = true;   // #ro=1 单用＝演示/投屏只读；分享链接已在 boot 里落过只读
  if (dl.wantPreset) applyPreset(dl.wantPreset);
  if (dl.wantLib) { ctx.libOpen = true; refreshLib(); }
  if (dl.wantOvl === "help") helpOpenSig.value = true;
  else if (dl.wantOvl === "settings") openSettings("app");
  else if (dl.wantOvl === "create") openSettings("create");
  if (dl.wantDrawer === "layers") layersOpenSig.value = true;   // 截图/演示：直开抽屉「层」面
  if (dl.wantGrain === "hour" && isTacSig.peek()) subDaySig.value = true;    // #grain=hour：战术图直开「时」粒度（时轨展开）
  if (dl.wantGrain === "month" && !isTacSig.peek()) subDaySig.value = true;  // #grain=month：战略图直开「月」粒度
  if (dl.wantSel && worldSig.value) {
    const hit = worldSig.value.nodes.find(n => n.id === dl.wantSel || n.名称 === dl.wantSel);
    const fhit = hit ? null : worldSig.value.factions.find(f => f.id === dl.wantSel || f.名称 === dl.wantSel);
    const uhit = (hit || fhit) ? null : (worldSig.value.units || []).find(u => u.id === dl.wantSel || u.名称 === dl.wantSel);
    selSig.value = hit ? { kind: "node", id: hit.id } : fhit ? { kind: "faction", id: fhit.id } : uhit ? { kind: "unit", id: uhit.id } : null;
    if (fhit) paintFactionSig.value = fhit.id;
  }
  if (dl.wantOp != null && selSig.value && selSig.value.kind === "node") { setMode("edit"); selectOp(selSig.value.id, dl.wantOp); }
  if (dl.wantMulti && worldSig.value) {
    const wv = worldSig.value;
    const ids = dl.wantMulti.map(nm => { const n = wv.nodes.find(x => x.id === nm || x.名称 === nm); return n && n.id; })
      .filter((x): x is string => !!x);
    if (ids.length) selSig.value = { kind: "multi", ids };
  }

  /* 编排 effect（本体在 shell/orchestrate.ts，orchestrate.test.ts 锁「开图批末恰建一次」）：
     世界/年份/地形版本/选中/编辑改动 → 依序【同步 ctx.meta → 按需重建网格 → 部队可达性预算】。 */
  wireOrchestration(ctx, host);
  /* 编辑改动 → 自动保存 + 寻路上下文重发（官道格随连线增删重算）。
     meta 直取 w.meta（不靠 ctx.meta 由编排 effect 先同步——batch 冲刷顺序不保证谁先跑）；
     ctx.grid 若同批在重建，编排 effect 的 rebuild 会再发一次最终上下文，此处发的旧网格版本被覆盖。 */
  effect(() => {
    if (editVerSig.value === 0) return;
    autosave.touch();
    const w = worldSig.peek();
    if (w && ctx.grid) ctx.routeClient.setContext({ meta: w.meta || {}, grid: ctx.grid, roads: roadCellSet(w.nodes, w.edges, yearSig.peek(), ctx.grid), world: w, yearNow: yearSig.peek() });
  });
  effect(() => { canvas.style.visibility = layersSig.value.terrain ? "visible" : "hidden"; });
  /* 工具轨：「测」记住上次分析子工具（ToolRail/快捷键 1~4 经 setRailTool 消费） */
  effect(() => {
    const m = modeSig.value;
    if (m === "measure" || m === "route") analysisSubSig.value = m;
  });
  /* 画布光标（v0.14 类语义）：量距/行军=picking、编辑非选择=editing（CSS 十字准星），浏览=默认 */
  effect(() => {
    const m = modeSig.value, sub = editSubSig.value;
    canvas.classList.toggle("picking", m === "measure" || m === "route");
    canvas.classList.toggle("editing", m === "edit" && sub !== "select");
  });
  /* 视角跳转桥：事件时间线/搜索点选 → 相机移动（相机非信号，此处消费请求） */
  effect(() => {
    const req = flyReqSig.value;
    if (!req) return;
    flyReqSig.value = null;
    /* NaN 守卫：旧档/手编档地点可缺 lon/lat（normalizeWorld 有意保留），事件行/搜索/部队行点选
       会把 undefined 递进来——clampView 经度分支放行 NaN 会写坏相机（全图消失），丢弃该请求（2026-07-12 P2） */
    if (!isFinite(req.lon) || !isFinite(req.lat)) return;
    const c = clampView({ lon0: req.lon, lat0: req.lat }, ctx.meta);
    ctx.view.lon0 = c.lon0; ctx.view.lat0 = c.lat0;
    if (req.degPerPx != null && isFinite(req.degPerPx) && req.degPerPx > 0
      && (req.ifAbove == null || ctx.view.degPerPx > req.ifAbove)) ctx.view.degPerPx = req.degPerPx;
  });
  /* 商路线型仅战略图：战术图上是战略语汇噪音（chips 已藏）,残留选中态回落道路 */
  effect(() => { if (isTacSig.value && linkTypeSig.peek() === "trade") linkTypeSig.value = "road"; });
  /* 战术图请求桥：InfoPanel 战役卡按钮设 tacReqSig → 外壳做库链接/生成/导航（组件不碰库 IO） */
  effect(() => {
    const req = tacReqSig.value;
    if (!req) return;
    tacReqSig.value = null;
    const w = worldSig.peek();
    const ev = req.evId && w ? w.nodes.find(n => n.id === req.evId) : null;
    if (req.type === "parent") openParentMap();
    else if (req.type === "open" && ev) openTacmap(ev);
    else if (req.type === "gen" && ev) genTactical(ev, req.dia);
  });
  /* 顶栏「⬆ 战略图」：仅战术图且有 parent 时显示（v0.14 #btnParent，title 带上级图名）。
     parent 直取 worldSig（不读 ctx.meta——batch 冲刷时编排 effect 未必已同步它） */
  effect(() => {
    const par = isTacSig.value && ((worldSig.value ? worldSig.value.meta : null) || ({} as Meta)).parent;
    const bp = $("btnParent");
    bp.style.display = par ? "inline-flex" : "none";
    if (par) bp.title = `返回上级战略图「${par.mapName || ""}」（当前战术图自动保存）`;
  });
  $("btnParent").onclick = () => openParentMap();
  /* 只读态顶栏：图库入口让位给「存入我的图库」——只读页是别人的一张图，读者的图库要先接管才有意义 */
  effect(() => {
    const ro = readOnlySig.value;
    $("btnAdopt").style.display = ro ? "inline-flex" : "none";
    $("btnHome").style.display = ro ? "none" : "inline-flex";
  });
  $("btnAdopt").onclick = () => libActionsSig.peek()?.adoptShared();
  /* 顶栏「复位」（v0.14 btnReset；快捷键 0）：回世界初始视角 */
  const resetView = (): void => {
    const v = (ctx.meta || ({} as Meta)).view || { lon0: 108, lat0: 36, degPerPx0: 0.06 };
    const c = clampView({ lon0: v.lon0, lat0: v.lat0 }, ctx.meta);   // 档内 view 不可信（NaN/超界）
    ctx.view.lon0 = c.lon0; ctx.view.lat0 = c.lat0;
    // 同 openplan.posDpp：负数能通过 `|| 0.06`，于是「复位」把镜像拉伸的视角原样复位回去
    ctx.view.degPerPx = (typeof v.degPerPx0 === "number" && isFinite(v.degPerPx0) && v.degPerPx0 > 0) ? v.degPerPx0 : 0.06;
  };
  $("btnReset").onclick = resetView;
  $("btnHome").onclick = () => goHome();
  $("btnSettings").onclick = () => openSettings("app");
  $("btnHelp").onclick = () => { helpOpenSig.value = !helpOpenSig.peek(); };
  /* 顶栏面包屑：当前图名（战术图=「上级 · 当前」；新增，图名同时仍以画布字饰呈现） */
  effect(() => {
    const w = worldSig.value;
    const m: Meta = (w && w.meta) || {};
    const par = isTacSig.value && m.parent;
    $("crumbName").textContent = w ? (par ? `${par.mapName || "上级战略图"} · ${m.名称 || "未命名"}` : (m.名称 || "未命名")) : "—";
  });
  /* 选中态播报（画布可访问性的低成本半边）：读屏经 #a11ysel 的 aria-live 获知当前选中；
     清选置空＝不出声（每次空击都播「已清除」太吵）。走 textContent，用户数据不进 innerHTML。 */
  effect(() => {
    const s = selSig.value, w = worldSig.value;
    let t = "";
    if (s && w) {
      if (s.kind === "node") { const n = selNode(w, s); t = n ? `已选中地点「${n.名称 || n.id}」` : ""; }
      else if (s.kind === "edge") { const ed = selEdge(w, s); t = ed ? `已选中连线「${ed.名称 || ed.type || "连线"}」` : ""; }
      else if (s.kind === "unit") { const u = selUnit(w, s); t = u ? `已选中部队「${u.名称 || u.id}」` : ""; }
      else if (s.kind === "faction") { const f = selFaction(w, s); t = f ? `已选中派系「${f.名称 || f.id}」` : ""; }
      else if (s.kind === "decor") t = "已选中布景印章";
      else if (s.kind === "multi") t = `已选中 ${s.ids.length + (s.unitIds ? s.unitIds.length : 0) + (s.decorIds ? s.decorIds.length : 0)} 个对象`;
    }
    $("a11ysel").textContent = t;
  });

  /* 行军计算：模式/两点/军种/年份任一变化 → 经 routeClient 走 Worker（过期票丢弃） */
  let routeTicket = 0;
  effect(() => {
    const mode = modeSig.value, pts = routePtsSig.value, arm = armSig.value;
    yearSig.value;   // 换年=换网格上下文，重算
    if (mode !== "route" || pts.length !== 2) { routeResSig.value = null; routeBusySig.value = false; return; }
    routeBusySig.value = true;
    const ticket = ++routeTicket;
    ctx.routeClient.route(pts[0], pts[1], arm).then(res => {
      if (ticket !== routeTicket) return;
      routeResSig.value = res;
      routeBusySig.value = false;
    }, e => {   // 拒绝也要放闸——busy 卡 true＝面板永远「计算中…」
      if (ticket !== routeTicket) return;
      routeResSig.value = null;
      routeBusySig.value = false;
      console.warn("行军计算失败：", e);
    });
  });

  /* URL 直达分析：#analysis=route|measure&pts=lon,lat,…&arm= */
  if ((dl.wantAnalysis === "measure" || dl.wantAnalysis === "route" || dl.wantAnalysis === "edit")
    && !(dl.wantAnalysis === "edit" && readOnlySig.peek())) {
    setMode(dl.wantAnalysis);
    if (dl.wantAnalysis === "edit" && dl.wantSub) editSubSig.value = dl.wantSub as EditSub;
    if (dl.wantPts && dl.wantPts.length >= 4 && dl.wantPts.every(isFinite)) {
      const pts: RoutePoint[] = [];
      for (let i = 0; i + 1 < dl.wantPts.length; i += 2) pts.push({ lon: dl.wantPts[i], lat: dl.wantPts[i + 1] });
      routePtsSig.value = pts;
    }
  }
  /* #gentac=<事件名/id>&dia=<km>：从战役事件烘焙战术图并打开（无头，绕过 prompt） */
  if (dl.wantGenTac && worldSig.value) {
    const ev = worldSig.value.nodes.find(n => n.type === "event" && (n.名称 === dl.wantGenTac || n.id === dl.wantGenTac));
    if (ev) await genTactical(ev, dl.wantDia || 60);   // 缺省 60＝典型会战（2026-08-13 与另三处入口同改；直径钳 [20,140] 在 core/tactical 一处）
    else console.warn("#gentac 找不到战役事件：", dl.wantGenTac);
  }

  /* 指针/键盘/滚轮交互接线；frame 经 ptr 读画线笔迹/框选/光标位 */
  const ptr = wireInteractions(ctx, host, libio, { resetView });
  addEventListener("resize", resize);

  /* 画布物理尺寸跟随（B2：分隔条退役——抽屉/检查器为定宽可收，收展动画与窗口变化经
     ResizeObserver 连续触发 resize()，对齐旧分隔条拖拽期间的实时重设） */
  new ResizeObserver(() => resize()).observe($("canvasWrap"));

  /* rAF 帧循环 */
  startFrameLoop(ctx, host, libio, ptr);
}
