/* 图库 IO：IndexedDB/文件夹两来源的开图·入库·删除·快照回写、自动保存、
   启动流程（迁移→文件夹重连→深链/开始界面分流）、战术图生成与父子导航、
   图库动作桥（HomePanel/SettingsOverlay 组件经 libActionsSig 调用；库 IO 全在外壳）。 */
import { batch } from "@preact/signals-core";
import { createAutosave, type Autosave } from "../data/autosave.ts";
import { createTabSync, tabMapKey } from "../data/tabsync.ts";
import { openLibrary } from "../data/library.ts";
import { migrateFromLocalStorage, migrateFolderHandle } from "../data/migrate.ts";
import { fsSupported, folderList, folderReadWorldAt, folderWriteWorld, folderCreate, folderRemove, folderMtime, fcachePatch, fcacheRemove }
  from "../data/folder.ts";
import { isStaleError, staleError, type StaleInfo } from "../data/guard.ts";
import { countsOf, normalizeWorld } from "../core/world.ts";
import { phasesOf, yearRangeOf } from "../core/time.ts";
import { validateWorld, formatIssues } from "../core/validate.ts";
import { createTacticalWorld } from "../core/tactical.ts";
import { contourStepFor } from "../core/elev.ts";
import { snowEOf } from "../render/material.ts";
import { safeName, errText } from "../core/util.ts";
import { drawLegend } from "../render/legend.ts";
import { pinnedStackH } from "../render/overlay.ts";
import { pickBootEntry, planOpen, wantsDeepStart, type OpenSnap } from "./openplan.ts";
import { landWorld } from "./orchestrate.ts";
import { calOf, fmtT, fmtWhen } from "../core/calendar.ts";
import { worldSig, yearSig, selSig, hoverSig, layersSig, setWorldState, libViewSig, libActionsSig,
  playingSig, togglePlay, stopPlay, closeSettings, mutateWorld, pushHistoryOnce, clearOpSel, cancelOpDraw,
  routePtsSig, routeResSig, linkFromSig, unitLegsSig, uiPrefsSig,
  gridVerSig, editVerSig, showToast, loadStageSig, saveConflictSig, type LibActions }
  from "../ui/state.ts";
import type { ShellCtx, FolderHandle } from "./ctx.ts";
import type { DeepLink } from "./deeplink.ts";
import type { Host } from "./host.ts";
import type { Meta, World, WorldNode } from "../core/types.ts";
import type { MapEntry } from "../data/library.ts";
import type { FolderMapEntry } from "../data/folder.ts";

declare global {
  /** File System Access API 目录选择器（Edge/Chrome；调用前先 fsSupported() 探测） */
  function showDirectoryPicker(opts?: { mode?: "read" | "readwrite"; id?: string }): Promise<FolderHandle>;
}

/** 仓库根样例世界的未校验 JSON（入库/normalizeWorld 前的原料） */
type SampleWorld = { meta?: Meta } & Record<string, unknown>;

/** 内置示例大陆原料（「从内置示例新建」与「↺ 重置为内置示例」共用）。
    ⚠ 空数组必须带齐（与 blankWorld 同形）——validateWorld 要求档形完整,此前两处各写一份
    meta-only 字面量,被 2026-07-10 加的导入校验整体拦死（「缺少 nodes 数组」）,按钮点了只弹错。 */
const sampleWorld = (): SampleWorld => ({
  meta: { 名称: "示例大陆", worldModel: "sphere", planetRadiusKm: 10000, kmPerDeg: 111,
    terrain: "sample", bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 } },
  factions: [], nodes: [], edges: [], decor: [], terrainOverrides: []
});

export interface LibraryIO {
  autosave: Autosave;
  /** 启动：开库→迁移→文件夹重连→（#sample 夹具｜dev 播种）→深链直达或开始界面 */
  boot(): Promise<void>;
  /** 挂图库动作桥 + 关页/切后台落盘钩子 */
  bindLib(): void;
  /** 顶栏 ⌂：停播放、落盘当前图（含缩略图/视角/纪年），回图库 */
  goHome(): Promise<void>;
  hideHome(): void;
  refreshLib(): Promise<void>;
  openParentMap(): Promise<boolean>;
  openTacmap(ev: WorldNode): Promise<boolean>;
  genTactical(ev: WorldNode, dia?: number | null): Promise<boolean>;
}

export function createLibraryIO(ctx: ShellCtx, dl: DeepLink, host: Host): LibraryIO {
  const { canvas, ov } = ctx;
  /* 多标签提醒：同一张图被两个标签开着时互相告知（协议在 data/tabsync.ts）。
     只提醒不拦截——图库写入仍是整份覆盖，两边各自保存依旧会互相吃掉改动。 */
  const bc = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("yutu-tabs");
  const tabs = createTabSync(
    "t" + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36),
    m => { if (bc) bc.postMessage(m); },
    t => showToast(t, { err: true })
  );
  if (bc) bc.onmessage = e => tabs.receive(e.data);
  const autosave = createAutosave(async () => {
    const w = worldSig.peek();
    if (!ctx.lib || !ctx.mapId || !w) return;
    /* 未决冲突：不再撞库（每 600ms 白跑一次往返没意义）。⚠ 只能抛不能 return——
       return＝pending 归零＝顶栏谎报「已自动保存」，而改动其实还困在内存里。 */
    const pend = saveConflictSig.peek();
    if (pend) throw staleError({ base: pend.base, cur: pend.cur });
    const snapV = { view: { lon0: ctx.view.lon0, lat0: ctx.view.lat0, degPerPx: ctx.view.degPerPx }, year: yearSig.peek() };
    if (ctx.source === "folder" && ctx.folderDir) {
      // 写失败不再静默：抛给 autosave 的失败路径→底栏红字+保持●未保存（审计「假已保存」修复）
      const r = await folderWriteWorld(ctx.folderDir, ctx.mapId, w, ctx.baseVer);
      if (!r.ok) throw new Error("写入文件夹失败（权限失效或磁盘）");
      ctx.baseVer = r.mtime;   // 不更新基准＝下次守卫拿旧 mtime 比新文件，会自己拦自己
      fcachePatch(ctx.fcache, ctx.folderDir.name, ctx.mapId, { name: (w.meta || ({} as Meta)).名称 || ctx.mapId, counts: countsOf(w), mtime: r.mtime ?? Date.now(), ...snapV });
      ctx.lib.kvSet("foldercache", ctx.fcache).catch(() => {});
      ctx.savedAt = new Date(); ctx.saveErr = null;
    } else {
      ctx.baseVer = await ctx.lib.save(ctx.mapId, w, snapV, undefined, ctx.baseVer);
      ctx.savedAt = new Date(); ctx.saveErr = null;
    }
    tabs.saved();   // 落盘成功才广播（失败路径在上面就抛了）
  }, 600, e => {
    if (isStaleError(e)) { noteConflict(e.stale); return; }   // 守卫拦下≠存储故障，走冲突弹层
    /* 首次失败给 toast 逃生门（导出 JSON）；持续失败只保持顶栏 savest 朱点，不刷屏 */
    const first = !ctx.saveErr;
    ctx.saveErr = e as { message?: unknown };
    if (first) showToast("自动保存失败——改动仍在内存，建议立即导出 JSON 备份", {
      err: true, action: { label: "导出 JSON", run: () => libActions.exportCurrent() }
    });
  });

  /* 守卫拦下写入：弹冲突弹层让用户决断。底栏同时保持●未保存＋红字——改动确实还在内存里，
     不许显示成已保存。弹层置位期间自动保存不再尝试写入（见上面的短路）。 */
  function noteConflict(info: StaleInfo): void {
    ctx.saveErr = { message: "与另一处的改动冲突——保存已暂停" };
    if (saveConflictSig.peek()) return;   // 已在待决：不重复弹（同 tabsync「每张图只提醒一次」之规）
    const w = worldSig.peek();
    saveConflictSig.value = {
      name: (w && (w.meta || ({} as Meta)).名称) || "未命名",
      base: info.base, cur: info.cur,
      onOverwrite() {
        /* 「仍然覆盖」＝接受库里现在的版本号作为本标签的新基准，守卫自然放行。
           不给 save 开 force 旗标：少一个特例，也少一条能被误用的路径。 */
        ctx.baseVer = info.cur;
        saveConflictSig.value = null; ctx.saveErr = null;
        autosave.flush();
      },
      onCopy() { saveAsCopy(); },
      onExport() { libActions.exportCurrent(); }
    };
  }

  /* 「另存为副本」：把内存里这一份写成新图并切过去——两边改动都不丢，是这个局面里唯一零损失的出口。
     正因为是唯一的零损失出口，它的失败路径要比别处更实：**建副本之前一律不动内存**（改名只改到
     交给 create 的浅拷贝上），于是任何一步失败时内存一字未动——不留幽灵撤销步，也不会让随后的
     「仍然覆盖」把一个改过名的世界写回原图（冲突未决时 pointer 的 keydown 整段让位，Ctrl+Z
     根本撤不掉那次改名，遮罩也盖住了顶栏撤销钮）。
     副本建成之后才改内存名，好让 openMapById 开头那次 flush 落在副本上时内容与库里逐字一致。 */
  let copying = false;   // 重入闸：弹层按钮无 disabled 态，在一个「卡住了」的不可关闭弹层上双击很常见
  async function saveAsCopy(): Promise<void> {
    const w0 = worldSig.peek();
    if (!w0 || !ctx.lib || copying) return;
    copying = true;
    const 副本名 = ((w0.meta || ({} as Meta)).名称 || "未命名") + "（副本）";
    const named = { ...w0, meta: { ...(w0.meta || ({} as Meta)), 名称: 副本名 } } as World;
    let id: string | null = null, ver: number | null = null;
    try {   // ── 第一段：建副本。到这一段结束为止，失败＝内存与两张图都原封不动 ──
      if (ctx.source === "folder" && ctx.folderDir) {
        const fn = await folderCreate(ctx.folderDir, named, (f, p) => { fcachePatch(ctx.fcache, ctx.folderDir!.name, f, p); });
        ctx.lib.kvSet("foldercache", ctx.fcache).catch(() => {});
        if (!fn) { showToast("另存副本失败（权限或磁盘问题）", { err: true }); return; }
        id = fn; ver = await folderMtime(ctx.folderDir, fn);
      } else {
        const en = await ctx.lib.create(named);
        id = en.id; ver = en.updatedAt;
      }
    } catch (e) {
      // 配额超限 / structured-clone 失败 / 事务中止各是一回事，归成一句无信息的「失败」等于没说
      showToast("另存副本失败：" + errText(e), { err: true });
      return;
    } finally { copying = false; }
    /* ── 第二段：切图。副本**已经建成**，用户的数据从这里起就是安全的——这一段再出错也不许
       报「另存副本失败」（那是假话），而且弹层已关、三选一的界面回不去了。 ── */
    mutateWorld(w => { w.meta.名称 = 副本名; });   // 内存跟上副本名（可撤销；此时冲突已可清）
    ctx.mapId = id; ctx.baseVer = ver;
    saveConflictSig.value = null; ctx.saveErr = null;
    const ok = await openMapById(id).catch(() => false);
    showToast(ok ? "已另存为副本　对方的改动原样留在原图"
                 : "副本已建好，但打开失败——请从图库里打开它", { err: !ok });
  }

  async function fetchSample(file: string): Promise<SampleWorld | null> {
    try { const r = await fetch("../" + file, { cache: "no-store" }); if (r.ok) return await r.json() as SampleWorld; } catch (e) { /* file:// 等 */ }
    return null;
  }
  /* #sample=<file>：从仓库根取指定世界 json，按名称去重（已存在则开，否则建后开）——战术夹具/演示用 */
  async function bootSample(file: string): Promise<boolean> {
    const s = await fetchSample(file);
    if (!s) return false;
    /* 与 importWorld 同一道闸——同一个入库动作原先有两套口径：这条路径直奔 create，
       validate 的量级闸（数组长度 / bbox 跨度）与原型键闸全被绕过。
       ⚠ 只拦 fatal：warning 在 importWorld 里出 toast 是**写给写手看的**，而这里是夹具/演示
       入口，`#sample=` 载的多是旧档，逐条迁移提示每次开图弹一遍纯属噪音——故只进控制台。 */
    const v = validateWorld(s);
    if (!v.ok) { alert(`「${file}」无法载入：\n` + formatIssues(v.fatal)); return false; }
    if (v.warnings.length) console.warn(`载入「${file}」有 ${v.warnings.length} 条提示：\n` + formatIssues(v.warnings));
    const nm = ((s.meta || ({} as Meta)).名称) || "";
    const es = await listMaps();
    const ex = nm && es.find(e => e.name === nm);
    if (ex) return openMapById(ex.id);
    if (ctx.source === "folder" && ctx.folderDir) {
      const fn = await folderCreate(ctx.folderDir, s, (f, p) => { fcachePatch(ctx.fcache, ctx.folderDir!.name, f, p); });
      ctx.lib!.kvSet("foldercache", ctx.fcache).catch(() => {});
      return fn ? openFolderMap(fn) : false;
    }
    /* ⚠ 同 importWorld / genTactical 之规，这是同族的第四个入口。原先这条 await 裸奔：配额满时
       它把 boot() 一起掀翻，由 main.ts 的兜底 try 接住——界面停在「启动中…」、红条只有一句
       DOMException 原文、连图库都进不去（2026-08-07 CDP 实测）。返回 false 即优雅降级：
       boot 自会往下走到 listMaps → showHome()，用户至少落回图库。 */
    let e: Awaited<ReturnType<NonNullable<typeof ctx.lib>["create"]>>;
    try { e = await ctx.lib!.create(s); }
    catch (err) {
      alert(`「${file}」入库失败：${errText(err)}\n（浏览器存储可能已满——可先删掉几张地图，或改用「📁 链接文件夹」）`);
      return false;
    }
    return openBrowserMap(e.id);
  }
  function setWorld(w: unknown, id: string | null, snap: OpenSnap | null | undefined): void {
    const p = planOpen(w, snap, dl);   // 年份/视角决策全在纯函数（openplan.test.ts 锁语义），此处只落地
    landWorld(ctx, p.world, id, p.year);   // 批落地（orchestrate.ts；重建计数护栏与此共用同一函数）
    /* 换图＝旧基准作废。真值由各开图路径在本函数**之后**写入；漏写就退化成 null＝守卫放行，
       失败方向落在「不拦」这一侧（误拦会把用户锁在存不进去的死局里，比漏拦更伤）。 */
    ctx.baseVer = null;
    /* 冲突同属「上一张图的事」：待决的 onOverwrite 闭包里记的是**旧图**的版本号，留到新图上
       就会把它写进新图的基准。今天没有在冲突未决时切图的路径，但这条与清基准是同一个道理。 */
    saveConflictSig.value = null;
    tabs.setMap(tabMapKey(ctx.source, ctx.mapId));   // 向别的标签打招呼（同图即互相提醒）
    if (p.view) {
      ctx.view.lon0 = p.view.lon0; ctx.view.lat0 = p.view.lat0;
      if (p.view.degPerPx != null) ctx.view.degPerPx = p.view.degPerPx;
    }
    dl.urlView = dl.urlYear = false;      // URL 直达只压制首次打开
    host.rebuildIfNeeded(); refreshLib();   // 兜底（正常已在批末建过、键相符＝零开销）
  }
  /* 切图/离开前把视角与纪年快照回写（浏览器库→条目；文件夹库→foldercache） */
  function snapView(): void {
    if (!ctx.lib || !ctx.mapId) return;
    const snap = { view: { lon0: ctx.view.lon0, lat0: ctx.view.lat0, degPerPx: ctx.view.degPerPx }, year: yearSig.value };
    if (ctx.source === "folder" && ctx.folderDir) {
      fcachePatch(ctx.fcache, ctx.folderDir.name, ctx.mapId, snap);
      ctx.lib.kvSet("foldercache", ctx.fcache).catch(() => {});
    } else if (ctx.source === "browser") {
      ctx.lib.patchEntry(ctx.mapId, snap, false).catch(() => {});
    }
  }
  /* —— 开图加载舞台：步进 0 读取存档→1 地形烘焙→2 时段过滤→3 泥金落款。
     paintFrame=让浏览器真画一帧（双 rAF），保证舞台先上屏再进同步重活（setWorld 里的网格重建）；
     后台标签 rAF 不跑（深链在后台标签启动时），setTimeout 兜底防开图悬死。总时长不足则补到
     ~450ms（一闪而过比没有更糟，防闪烁语义）；失败/成功一律 finally 收场（组件自带淡出）。 */
  const paintFrame = (): Promise<void> => new Promise(r => {
    let done = false;
    const fin = (): void => { if (!done) { done = true; r(); } };
    requestAnimationFrame(() => requestAnimationFrame(() => fin()));
    setTimeout(fin, 120);
  });
  const stageStep = (step: number, name?: string): void => {
    const cur = loadStageSig.peek();
    // 渲染器只标短类别（WebGL/CPU）——rendererName() 的完整 GPU 名是 hud 诊断用，进步骤行太生
    const renderer = ctx.R ? (ctx.R.rendererName().startsWith("CPU") ? "CPU" : "WebGL") : undefined;
    loadStageSig.value = { name: name || (cur ? cur.name : "…"), step, renderer };
  };
  async function stageFinish(t0: number): Promise<void> {
    stageStep(2);
    await paintFrame();                        // 帧循环按新世界/纪年画一帧（时段过滤生效）
    stageStep(3);
    const dt = performance.now() - t0;
    if (dt < 450) await new Promise(r => setTimeout(r, 450 - dt));
  }
  async function openBrowserMap(id: string): Promise<boolean> {
    const t0 = performance.now();
    const ent = libViewSig.peek().entries.find(e => e.id === id);
    stageStep(0, (ent && ent.name) || "读取中");
    try {
      await autosave.flush();
      /* ⚠ 世界与版本必须一趟读出（getWorldAt 同事务）：先读内容、再单独读版本，中间隔着
         paintFrame 的一帧——另一处若恰在这段窗口里落盘，基准就比快照新，此后每次保存都过守卫，
         把基于旧快照的内容整份写回去。偏差方向恒定落在「漏拦」这侧，正是守卫要拦的那类。 */
      const got = await ctx.lib!.getWorldAt(id);
      const w = got.world;
      if (!w) { alert("这张地图的数据无法读取（可能已损坏）。"); return false; }
      stageStep(1, (w.meta || ({} as Meta)).名称 || (ent && ent.name) || "未命名");
      await paintFrame();
      snapView();
      setWorld(w, id, got.entry);
      ctx.baseVer = got.entry ? got.entry.updatedAt : null;   // 与内容同源（须在 setWorld 之后，它会清空基准）
      ctx.lib!.kvSet("lastMap", id).catch(() => {});
      hideHome();
      await stageFinish(t0);
      return true;
    } finally { loadStageSig.value = null; }
  }
  async function openFolderMap(fn: string): Promise<boolean> {
    const t0 = performance.now();
    stageStep(0, fn);
    try {
      await autosave.flush();
      const got = await folderReadWorldAt(ctx.folderDir!, fn);   // 同一个 File 出内容与 mtime（同上之由）
      const w = got.world;
      if (!w) { alert("无法读取该地图文件（可能已被移动、改名或损坏）。"); return false; }
      stageStep(1, (w.meta || ({} as Meta)).名称 || fn);
      await paintFrame();
      snapView();
      setWorld(w, fn, (ctx.fcache[ctx.folderDir!.name] || {})[fn]);
      ctx.baseVer = got.mtime;   // 与内容同源（须在 setWorld 之后，它会清空基准）
      hideHome();
      await stageFinish(t0);
      return true;
    } finally { loadStageSig.value = null; }
  }
  /* 开始界面显隐（v0.14 showHome/hideHome）：开=刷新列表，关=回当前图 */
  function showHome(): void { ctx.libOpen = true; refreshLib(); }
  function hideHome(): void { if (ctx.libOpen) { ctx.libOpen = false; refreshLib(); } }
  const openMapById = (id: string): Promise<boolean> => (ctx.source === "folder" ? openFolderMap(id) : openBrowserMap(id));
  async function listMaps(): Promise<(MapEntry | FolderMapEntry)[]> {
    if (ctx.source === "folder" && ctx.folderDir)
      return folderList(ctx.folderDir, ctx.fcache[ctx.folderDir.name] || {}, (fn, p) => {
        fcachePatch(ctx.fcache, ctx.folderDir!.name, fn, p);
        ctx.lib!.kvSet("foldercache", ctx.fcache).catch(() => {});
      });
    return ctx.lib ? ctx.lib.list() : [];
  }
  /* 图库视图刷新：把外壳库状态灌进 libViewSig，Preact 图库组件据此渲染
     （取代旧 renderLib 的 innerHTML 拼装；库列表条目/来源/当前图高亮全走信号）。 */
  async function refreshLib(): Promise<void> {
    const entries = ctx.lib ? await listMaps() : [];
    libViewSig.value = { available: !!ctx.lib, open: ctx.libOpen, source: ctx.source, folderName: ctx.folderDir ? ctx.folderDir.name : null,
      fsSupported: fsSupported(), mapId: ctx.mapId, entries };
  }
  async function importWorld(w: unknown, srcName: string): Promise<void> {
    const v = validateWorld(w);
    if (!v.ok) { alert(`「${srcName}」无法导入：\n` + formatIssues(v.fatal)); return; }
    /* 校验的 warning 此前只进 console——「兵力将移入说明」这类话是**专门写给写手看的**，
       落在用户看不见的通道里等于没写。详情仍留控制台（多行不适合 toast），此处报个数与去处。 */
    if (v.warnings.length) {
      console.warn(`导入「${srcName}」有 ${v.warnings.length} 条提示：\n` + formatIssues(v.warnings));
      showToast(`「${srcName}」有 ${v.warnings.length} 条数据提示　详情见浏览器控制台`);
    }
    if (ctx.source === "folder") {
      const fn = await folderCreate(ctx.folderDir!, w, (f, p) => { fcachePatch(ctx.fcache, ctx.folderDir!.name, f, p); });
      ctx.lib!.kvSet("foldercache", ctx.fcache).catch(() => {});
      if (fn) await openFolderMap(fn); else alert("写入文件夹失败（权限或磁盘问题）。");
    } else {
      /* ⚠ 入库失败必须说话：此前直接 await create()，配额满时这条 promise 无人接——点「创建此地图」
         「从内置示例新建」界面纹丝不动、零反馈，终结为一条 unhandledrejection；而文件夹分支同一
         动作是有 alert 的。同一个动作在两个来源下响与不响不该不对称。 */
      let id: string;
      try { id = (await ctx.lib!.create(w)).id; }
      catch (e) { alert(`「${srcName}」入库失败：${errText(e)}\n（浏览器存储可能已满——可先删掉几张地图，或改用「📁 链接文件夹」）`); return; }
      await openBrowserMap(id);
    }
  }

  /* ================= 战术图：生成 / 打开 / 父子导航================= */
  /* 从战役事件点烘焙一张战术图，入库、在父图事件写双向链接、打开它。dia=战场直径 km */
  async function genTactical(ev: WorldNode, dia?: number | null): Promise<boolean> {
    if (!ctx.lib) { alert("图库不可用，无法生成战术图。"); return false; }
    const world = createTacticalWorld(worldSig.peek()!, ev, dia || 200,
      { parentMapId: ctx.mapId, yearNow: yearSig.peek(), today: new Date().toISOString().slice(0, 10) });
    let newId: string | null = null, link: NonNullable<WorldNode["tacmap"]> | null = null;
    if (ctx.source === "folder" && ctx.folderDir) {
      const fn = await folderCreate(ctx.folderDir, world, (f, p) => { fcachePatch(ctx.fcache, ctx.folderDir!.name, f, p); });
      ctx.lib.kvSet("foldercache", ctx.fcache).catch(() => {});
      if (!fn) { alert("写入文件夹失败（权限或磁盘问题）。"); return false; }
      newId = fn; link = { file: fn, name: world.meta.名称 };
    } else {
      /* ⚠ 入库失败必须说话（同 importWorld 之规）：此前这条 await 裸奔，配额满时 promise 无人接——
         点「⚔ 生成战术图」界面纹丝不动、零反馈。而同一函数的文件夹分支上面就有 alert，
         同一个动作在两个来源下响与不响不该不对称。全局 unhandledrejection 网虽兜得住，
         但它只报得出原始 DOMException 措辞，给不出「删几张图或改用文件夹」这种可操作的出路。 */
      let e: Awaited<ReturnType<typeof ctx.lib.create>>;
      try { e = await ctx.lib.create(world); }
      catch (err) {
        alert(`战术图入库失败：${errText(err)}\n（浏览器存储可能已满——可先删掉几张地图，或改用「📁 链接文件夹」）`);
        return false;
      }
      newId = e.id; link = { id: e.id, name: world.meta.名称 };
    }
    // 双向链接写在父图的事件点（随父图自动保存；openMapById 会先 flush 落盘再切图）
    mutateWorld(w => { const nd = w.nodes.find(n => n.id === ev.id); if (nd) nd.tacmap = link!; });
    return openMapById(newId!);
  }
  /* 打开事件点链接的战术图：file/id 优先，丢失按名称找；都找不到=提议重新生成 */
  async function openTacmap(ev: WorldNode): Promise<boolean> {
    const t: NonNullable<WorldNode["tacmap"]> = ev.tacmap || {};
    const es = await listMaps();
    let id: string | null = null;
    if (ctx.source === "folder") { if (t.file && es.some(x => x.id === t.file)) id = t.file; }
    else if (t.id && es.some(x => x.id === t.id)) id = t.id;
    if (!id && t.name) { const hit = es.find(x => x.name === t.name); if (hit) id = hit.id; }
    if (id) return openMapById(id);
    if (confirm("找不到已链接的战术图（可能已删除，或图库来源已切换）。\n以默认参数重新生成一张？")) return genTactical(ev, 200);
    return false;
  }
  /* 战术图→上级战略图（meta.parent：id/文件名→名称 双重回退） */
  async function openParentMap(): Promise<boolean> {
    const p = (ctx.meta || ({} as Meta)).parent || {};
    const es = await listMaps();
    let id = (p.map && es.some(x => x.id === p.map)) ? p.map : null;
    if (!id && p.mapName) { const hit = es.find(x => x.name === p.mapName); if (hit) id = hit.id; }
    if (id) return openMapById(id);
    alert("找不到上级战略图（可能已删除、改名或图库来源已切换）。可从图库手动打开。");
    return false;
  }
  /* 合成当前时刻一帧（地形+叠加层;战术图按偏好附图例）——「出图 PNG」与「分帧出图」共用。
     地形层开＝先渲后同任务内读回;关＝垫恒定纸色底（产物不随主题变,既定裁决）。 */
  function composeFrame(): Promise<Blob | null> {
    const R = layersSig.peek().terrain ? ctx.R : null;
    if (R) {
      const cs = contourStepFor(ctx.view.degPerPx, ctx.meta);
      R.render(host.viewBB(), { contour: layersSig.peek().contour, cMinor: cs.minor, cFade: cs.fade, wrap: ctx.meta.worldModel !== "flat", paper: ctx.meta.mapKind === "tactical", snowE: snowEOf(ctx.meta) });
    }
    const off = document.createElement("canvas");
    off.width = canvas.width; off.height = canvas.height;
    const g2 = off.getContext("2d")!;
    if (R) g2.drawImage(canvas, 0, 0);
    else { g2.fillStyle = "#d9d2c0"; g2.fillRect(0, 0, off.width, off.height); }
    g2.drawImage(ov, 0, 0);
    /* 图例块（战术·本机偏好可关）：内容自动取图内当刻实际出现的;按 DPR 折回 CSS 像素画右下角。
       让开 se 屏幕角标注（图例不上画布，不让位就会压住画布上摆好的图注）——标注层关掉则无须让。 */
    if (ctx.meta.mapKind === "tactical" && uiPrefsSig.peek().legend !== false) {
      const w = worldSig.peek(), T = yearSig.peek(), s = selSig.peek();
      if (w) {
        const reserve = layersSig.peek().notes !== false
          ? pinnedStackH(w, T, "se", s && s.kind === "node" ? s.id : null) : 0;
        g2.save(); g2.scale(ctx.DPR, ctx.DPR);
        drawLegend(g2, w, T, off.width / ctx.DPR, off.height / ctx.DPR, reserve, layersSig.peek(), ctx.meta);
        g2.restore();
      }
    }
    return new Promise(res => off.toBlob(b => res(b), "image/png"));
  }
  function downloadBlob(name: string, b: Blob): void {
    const url = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }
  /* 图库动作桥（HomePanel 组件经 libActionsSig 调用；库 IO 全在外壳）。 */
  const libActions: LibActions = {
    toggle() { ctx.libOpen = !ctx.libOpen; refreshLib(); },
    open(id) { openMapById(id); },              // openMapById→setWorld→refreshLib；成功即 hideHome
    async remove(id) {
      const ent = libViewSig.peek().entries.find(e => e.id === id);
      const nm = (ent && ent.name) || id;
      if (!confirm(ctx.source === "folder"
        ? `从文件夹删除「${nm}」？\n将删除文件 ${id}（能否找回取决于系统回收站设置）。`
        : `删除地图「${nm}」？\n此操作不可恢复（如需备份，请先打开它并「导出 JSON」）。`)) return;
      if (ctx.source === "folder") { await folderRemove(ctx.folderDir!, id); fcacheRemove(ctx.fcache, ctx.folderDir!.name, id); ctx.lib!.kvSet("foldercache", ctx.fcache).catch(() => {}); }
      else await ctx.lib!.remove(id);
      if (ctx.mapId === id) ctx.mapId = null;
      refreshLib();
    },
    /* 设置弹层「✔ 创建此地图」：blankWorld 由组件按表单生成，这里只负责入库并打开 */
    createWorld(w) { importWorld(w, (w.meta || ({} as Meta)).名称 || "新地图").catch(e => alert("创建失败：" + errText(e))); },
    /* 设置弹层「📂 导入 JSON」：替换当前图内容（可撤销；对齐旧 importMode="current"） */
    replaceCurrent(json, srcName) {
      const w = worldSig.peek();
      if (!w) { alert("当前没有打开的地图。"); return; }
      const v = validateWorld(json);
      if (!v.ok) { alert(`「${srcName}」无法导入：\n` + formatIssues(v.fatal)); return; }
      if (v.warnings.length) console.warn(`导入「${srcName}」有 ${v.warnings.length} 条提示：\n` + formatIssues(v.warnings));
      pushHistoryOnce();
      const nw = normalizeWorld(json);
      Object.keys(w).forEach(k => { delete w[k]; });
      Object.assign(w, nw);
      /* 非 setWorldState 路径（保撤销栈），清理项须对齐 applyRestored：停播/清选中悬停/清分析态，
         年份钳到新档范围——否则跨时基替换（战术日戳档↔战略年档）后时段过滤全空、开出白图（2026-07-12 P2） */
      batch(() => {
        stopPlay();
        selSig.value = null; hoverSig.value = null; clearOpSel(); cancelOpDraw();
        routePtsSig.value = []; routeResSig.value = null; linkFromSig.value = null;
        unitLegsSig.value = new Map();
        worldSig.value = { ...w };     // meta 引用同步靠编排 effect（批末按最终态跑一遍）
        yearSig.value = yearRangeOf(worldSig.peek()!, yearSig.peek()).year;
        gridVerSig.value++;
        editVerSig.value++;
      });
      showToast(`已导入「${srcName}」替换当前图`, { undo: true });
    },
    /* 设置弹层「📷 出图 PNG」：地形+叠加层合成一张全分辨率 PNG 下载（合成细节见 composeFrame）。 */
    async exportPng() {
      if (!worldSig.peek()) return;
      closeSettings();
      const b = await composeFrame();
      if (b) downloadBlob(`${ctx.meta.名称 || "舆图"}_${fmtWhen(calOf(ctx.meta.calendar), ctx.meta.mapKind === "tactical", yearSig.peek())}.png`, b);
    },
    /* 「🎞 分帧出图」（2026-07 特化·相位批）：逐相位拨时间轴→信号同步冲刷（编排 effect 重建网格/腿账）→
       ctx.repaint 同步重画→同任务合成下载一张;末了拨回原时刻。产物=每相位一个 PNG
       （用户拍板;浏览器对连续多文件下载会请求一次授权）。 */
    async exportFrames() {
      const w = worldSig.peek();
      if (!w || ctx.meta.mapKind !== "tactical") return;
      const ph = phasesOf(w.meta);
      if (!ph.length) { showToast("还没有相位——先在「览 → 相位」记几个时刻", { err: true }); return; }
      closeSettings();
      stopPlay();
      const T0 = yearSig.peek();
      const nm = ctx.meta.名称 || "舆图";
      const cal = calOf(ctx.meta.calendar);
      for (let i = 0; i < ph.length; i++) {
        yearSig.value = ph[i].t;
        if (ctx.repaint) ctx.repaint();
        const b = await composeFrame();
        if (b) downloadBlob(`${nm}_帧${i + 1}_${safeName(ph[i].名称 || `相位${i + 1}`)}_${safeName(fmtT(cal, ph[i].t))}.png`, b);
      }
      yearSig.value = T0;
      if (ctx.repaint) ctx.repaint();
      showToast(`已导出 ${ph.length} 帧`);
    },
    /* 设置弹层「↺ 重置为内置示例」：重置为内置程序化示例大陆 */
    async resetToSample() {
      if (!confirm("把当前地图的内容重置为内置示例数据？\n可用 Ctrl+Z 撤销；其他地图不受影响。")) return;
      closeSettings();
      libActions.replaceCurrent(sampleWorld(), "内置示例数据");
    },
    async importFiles(files) {
      for (const f of files) {
        try { await importWorld(JSON.parse(await f.text()), f.name); }
        catch (e) { alert(`「${f.name}」不是有效 JSON：${(e as Error).message}`); }
      }
    },
    exportCurrent() {
      const w = worldSig.value;
      if (!w) return;
      const out = JSON.parse(JSON.stringify(w)) as World;
      out.meta.更新 = new Date().toISOString().slice(0, 10);
      const blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = (ctx.meta.名称 || "world") + ".json"; a.click();
      URL.revokeObjectURL(url);
    },
    async newFromSample() {
      await importWorld(sampleWorld(), "内置示例");
    },
    async linkFolder() {
      if (!fsSupported()) return;
      let handle: FolderHandle | null = null;
      try { handle = await showDirectoryPicker({ mode: "readwrite", id: "yutu-lib" }); } catch (e) { return; }  // 取消=静默
      let perm: string = "prompt"; try { perm = await handle.requestPermission({ mode: "readwrite" }); } catch (e) {}
      if (perm !== "granted") { alert("未获得该文件夹的读写权限。"); return; }
      snapView();
      ctx.folderDir = handle; ctx.source = "folder"; ctx.mapId = null; ctx.baseVer = null;   // 同 backToBrowser：换库＝旧基准作废
      ctx.lib!.kvSet("libDir", handle).catch(() => {});
      ctx.lib!.kvSet("librarySource", "folder").catch(() => {});
      refreshLib();
    },
    backToBrowser() {
      snapView();
      ctx.source = "browser"; ctx.folderDir = null; ctx.mapId = null; ctx.baseVer = null;
      ctx.lib!.kvSet("librarySource", "browser").catch(() => {});
      refreshLib();
    }
  };
  function bindLib(): void {
    libActionsSig.value = libActions;
    addEventListener("pagehide", () => { autosave.flush(); snapView(); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { autosave.flush(); snapView(); } });
  }
  /* 画布快照缩略图（v0.14 captureThumb：280×175 jpeg；地形先补渲一帧保证 WebGL 缓冲有效，再叠加 overlay） */
  function captureThumb(): string | null {
    try {
      if (!canvas.width || !canvas.height) return null;
      if (layersSig.peek().terrain && ctx.R) {
        const cs = contourStepFor(ctx.view.degPerPx, ctx.meta);
        ctx.R.render(host.viewBB(), { contour: layersSig.peek().contour, cMinor: cs.minor, cFade: cs.fade, wrap: ctx.meta.worldModel !== "flat", paper: ctx.meta.mapKind === "tactical", snowE: snowEOf(ctx.meta) });
      }
      const tw = 280, th = 175, off = document.createElement("canvas");
      off.width = tw; off.height = th;
      const g2 = off.getContext("2d")!;
      const s = Math.max(tw / canvas.width, th / canvas.height);
      const dx = (tw - canvas.width * s) / 2, dy = (th - canvas.height * s) / 2;
      g2.drawImage(canvas, dx, dy, canvas.width * s, canvas.height * s);
      g2.drawImage(ov, dx, dy, ov.width * s, ov.height * s);
      return off.toDataURL("image/jpeg", 0.62);
    } catch (e) { return null; }
  }
  /* 顶栏 ⌂（v0.14 goHome）：停播放、落盘当前图（含缩略图/视角/纪年），回图库 */
  async function goHome(): Promise<void> {
    if (playingSig.peek()) togglePlay();
    await autosave.flush();
    if (ctx.lib && ctx.mapId) {
      snapView();
      const thumb = captureThumb();
      if (thumb) {
        if (ctx.source === "folder" && ctx.folderDir) { fcachePatch(ctx.fcache, ctx.folderDir.name, ctx.mapId, { thumb }); ctx.lib.kvSet("foldercache", ctx.fcache).catch(() => {}); }
        else ctx.lib.patchEntry(ctx.mapId, { thumb }, false).catch(() => {});
      }
    }
    showHome();
  }
  /* 上次是文件夹图库 → 尝试静默重连（授权还在才用，否则先回浏览器库） */
  async function tryFolderBoot(): Promise<boolean> {
    if (!fsSupported() || (await ctx.lib!.kvGet<string>("librarySource")) !== "folder") return false;
    const h = await ctx.lib!.kvGet<FolderHandle>("libDir");
    if (!h) return false;
    let perm: string = "prompt"; try { perm = await h.queryPermission({ mode: "readwrite" }); } catch (e) {}
    if (perm !== "granted") { ctx.bootNote = "上次的文件夹图库需重新授权（图库面板→链接文件夹），本次先用浏览器库"; return false; }
    ctx.folderDir = h; ctx.source = "folder";
    return true;
  }
  async function boot(): Promise<void> {
    /* ⚠ 三件事分开接：只有「库打不开」才算图库不可用。原先一个 try 罩住全部——一张大体量旧档
       迁移时撞上配额，create 抛 QuotaExceeded，整个图库就被判死（已有地图全不可见不可开），
       而迁移是幂等的，下次启动照样再炸一遍。迁移/缓存失败只该少一样东西，不该连库一起赔进去。 */
    try {
      ctx.lib = await openLibrary();
    } catch (e) { console.warn("图库打不开，退回直读示例：", e); ctx.lib = null; }
    if (ctx.lib) {
      try {
        const mig = await migrateFromLocalStorage(ctx.lib, localStorage);
        if (mig.imported || mig.updated) ctx.bootNote = `已从旧版存档迁移 ${mig.imported} 张、更新 ${mig.updated} 张`;
        await migrateFolderHandle(ctx.lib);
      } catch (e) {
        console.warn("旧档迁移未完成（图库照常可用）：", e);
        ctx.bootNote = "旧版存档迁移未完成——图库照常可用，详情见浏览器控制台";
      }
      try { ctx.fcache = (await ctx.lib.kvGet<FolderCacheState>("foldercache")) || {}; }
      catch (e) { console.warn("文件夹缓存读取失败（按空缓存继续）：", e); ctx.fcache = {}; }
    }
    if (!ctx.lib) {
      const s = dl.wantSample ? await fetchSample(dl.wantSample) : null;
      if (s) setWorld(s, null, null); else host.rebuild();
      return;
    }
    await tryFolderBoot();
    if (dl.wantSample && await bootSample(dl.wantSample)) return;   // 指定夹具优先
    let entries = await listMaps();
    /* v0.14 启动语义：URL 深链直达地图，否则进开始界面（判定与选图规则在 openplan，测试锁定） */
    if (wantsDeepStart(dl)) {
      const last = ctx.source === "browser" ? await ctx.lib.kvGet<string>("lastMap") : null;
      const ent = pickBootEntry(entries, dl.wantMap, last);
      if (ent) { await openMapById(ent.id); return; }
    }
    host.rebuild();                  // 无图/非深链：程序化底图垫在开始界面后
    showHome();
  }

  return { autosave, boot, bindLib, goHome, hideHome, refreshLib, openParentMap, openTacmap, genTactical };
}

/** ctx.fcache 的存储形（kvGet 泛型用；与 data/folder.FolderCache 同构） */
type FolderCacheState = ShellCtx["fcache"];
