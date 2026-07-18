/* 图库 IO：IndexedDB/文件夹两来源的开图·入库·删除·快照回写、自动保存、
   启动流程（迁移→文件夹重连→深链/开始界面分流）、战术图生成与父子导航、
   图库动作桥（HomePanel/SettingsOverlay 组件经 libActionsSig 调用；库 IO 全在外壳）。 */
import { batch } from "@preact/signals-core";
import { createAutosave, type Autosave } from "../data/autosave.ts";
import { openLibrary } from "../data/library.ts";
import { migrateFromLocalStorage, migrateFolderHandle } from "../data/migrate.ts";
import { fsSupported, folderList, folderReadWorld, folderWriteWorld, folderCreate, folderRemove, fcachePatch, fcacheRemove }
  from "../data/folder.ts";
import { countsOf, normalizeWorld } from "../core/world.ts";
import { yearRangeOf } from "../core/time.ts";
import { validateWorld, formatIssues } from "../core/validate.ts";
import { createTacticalWorld } from "../core/tactical.ts";
import { contourStepFor } from "../core/elev.ts";
import { pickBootEntry, planOpen, wantsDeepStart, type OpenSnap } from "./openplan.ts";
import { calOf, fmtWhen } from "../core/calendar.ts";
import { worldSig, yearSig, selSig, hoverSig, layersSig, setWorldState, libViewSig, libActionsSig,
  playingSig, togglePlay, stopPlay, closeSettings, mutateWorld, pushHistoryOnce, clearOpSel, cancelOpDraw,
  routePtsSig, routeResSig, linkFromSig, unitLegsSig,
  gridVerSig, editVerSig, showToast, loadStageSig, type LibActions }
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
  const autosave = createAutosave(async () => {
    const w = worldSig.peek();
    if (!ctx.lib || !ctx.mapId || !w) return;
    const snapV = { view: { lon0: ctx.view.lon0, lat0: ctx.view.lat0, degPerPx: ctx.view.degPerPx }, year: yearSig.peek() };
    if (ctx.source === "folder" && ctx.folderDir) {
      // 写失败（返回 false）不再静默：抛给 autosave 的失败路径→底栏红字+保持●未保存（审计「假已保存」修复）
      if (!(await folderWriteWorld(ctx.folderDir, ctx.mapId, w))) throw new Error("写入文件夹失败（权限失效或磁盘）");
      fcachePatch(ctx.fcache, ctx.folderDir.name, ctx.mapId, { name: (w.meta || ({} as Meta)).名称 || ctx.mapId, counts: countsOf(w), mtime: Date.now(), ...snapV });
      ctx.lib.kvSet("foldercache", ctx.fcache).catch(() => {});
      ctx.savedAt = new Date(); ctx.saveErr = null;
    } else {
      await ctx.lib.save(ctx.mapId, w, snapV);
      ctx.savedAt = new Date(); ctx.saveErr = null;
    }
  }, 600, e => {
    /* 首次失败给 toast 逃生门（导出 JSON）；持续失败只保持顶栏 savest 朱点，不刷屏 */
    const first = !ctx.saveErr;
    ctx.saveErr = e as { message?: unknown };
    if (first) showToast("自动保存失败——改动仍在内存，建议立即导出 JSON 备份", {
      err: true, action: { label: "导出 JSON", run: () => libActions.exportCurrent() }
    });
  });

  async function fetchSample(file: string): Promise<SampleWorld | null> {
    try { const r = await fetch("../" + file, { cache: "no-store" }); if (r.ok) return await r.json() as SampleWorld; } catch (e) { /* file:// 等 */ }
    return null;
  }
  /* #sample=<file>：从仓库根取指定世界 json，按名称去重（已存在则开，否则建后开）——战术夹具/演示用 */
  async function bootSample(file: string): Promise<boolean> {
    const s = await fetchSample(file);
    if (!s) return false;
    const nm = ((s.meta || ({} as Meta)).名称) || "";
    const es = await listMaps();
    const ex = nm && es.find(e => e.name === nm);
    if (ex) return openMapById(ex.id);
    if (ctx.source === "folder" && ctx.folderDir) {
      const fn = await folderCreate(ctx.folderDir, s, (f, p) => { fcachePatch(ctx.fcache, ctx.folderDir!.name, f, p); });
      ctx.lib!.kvSet("foldercache", ctx.fcache).catch(() => {});
      return fn ? openFolderMap(fn) : false;
    }
    const e = await ctx.lib!.create(s);
    return openBrowserMap(e.id);
  }
  function setWorld(w: unknown, id: string | null, snap: OpenSnap | null | undefined): void {
    const p = planOpen(w, snap, dl);   // 年份/视角决策全在纯函数（openplan.test.ts 锁语义），此处只落地
    ctx.meta = p.world.meta || {};
    ctx.mapId = id;
    // 清 builtFor＝强制按新档重建：同 id 重开时键（mapId@year@gridVer）可能相同而内容已变（如上次保存失败）。
    // 批内编排 effect 冲刷时即按【最终】世界+年份重建一次——旧「先设年份、effect 拿旧世界白建全平原」的时序病根已由 batch 杜绝。
    ctx.builtFor = null;
    batch(() => {
      selSig.value = null; hoverSig.value = null;
      if (p.year != null) yearSig.value = p.year;
      setWorldState(p.world);   // worldSig 赋值 + 年份按世界范围钳制
    });
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
      const w = await ctx.lib!.getWorld(id);
      if (!w) { alert("这张地图的数据无法读取（可能已损坏）。"); return false; }
      stageStep(1, (w.meta || ({} as Meta)).名称 || (ent && ent.name) || "未命名");
      await paintFrame();
      snapView();
      setWorld(w, id, await ctx.lib!.getEntry(id));
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
      const w = await folderReadWorld(ctx.folderDir!, fn);
      if (!w) { alert("无法读取该地图文件（可能已被移动、改名或损坏）。"); return false; }
      stageStep(1, (w.meta || ({} as Meta)).名称 || fn);
      await paintFrame();
      snapView();
      setWorld(w, fn, (ctx.fcache[ctx.folderDir!.name] || {})[fn]);
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
    if (v.warnings.length) console.warn(`导入「${srcName}」有 ${v.warnings.length} 条提示：\n` + formatIssues(v.warnings));
    if (ctx.source === "folder") {
      const fn = await folderCreate(ctx.folderDir!, w, (f, p) => { fcachePatch(ctx.fcache, ctx.folderDir!.name, f, p); });
      ctx.lib!.kvSet("foldercache", ctx.fcache).catch(() => {});
      if (fn) await openFolderMap(fn); else alert("写入文件夹失败（权限或磁盘问题）。");
    } else {
      const e = await ctx.lib!.create(w);
      await openBrowserMap(e.id);
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
      const e = await ctx.lib.create(world);
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
    createWorld(w) { importWorld(w, (w.meta || ({} as Meta)).名称 || "新地图"); },
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
    /* 设置弹层「📷 出图 PNG」：地形+叠加层合成一张全分辨率 PNG 下载 */
    exportPng() {
      if (!worldSig.peek()) return;
      closeSettings();
      if (layersSig.peek().terrain && ctx.R) {
        const cs = contourStepFor(ctx.view.degPerPx, ctx.meta);
        ctx.R.render(host.viewBB(), { contour: layersSig.peek().contour, cMinor: cs.minor, cFade: cs.fade, wrap: ctx.meta.worldModel !== "flat" });
      }
      const off = document.createElement("canvas");
      off.width = canvas.width; off.height = canvas.height;
      const g2 = off.getContext("2d")!;
      g2.drawImage(canvas, 0, 0);
      g2.drawImage(ov, 0, 0);
      off.toBlob(b => {
        if (!b) return;
        const url = URL.createObjectURL(b);
        const a = document.createElement("a");
        a.href = url; a.download = `${ctx.meta.名称 || "舆图"}_${fmtWhen(calOf(ctx.meta.calendar), ctx.meta.mapKind === "tactical", yearSig.peek())}.png`; a.click();
        URL.revokeObjectURL(url);
      }, "image/png");
    },
    /* 设置弹层「↺ 重置为内置示例」：重置为内置程序化示例大陆 */
    async resetToSample() {
      if (!confirm("把当前地图的内容重置为内置示例数据？\n可用 Ctrl+Z 撤销；其他地图不受影响。")) return;
      const s: SampleWorld = { meta: { 名称: "示例大陆", worldModel: "sphere", planetRadiusKm: 10000, kmPerDeg: 111,
        terrain: "sample", bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 } } };
      closeSettings();
      libActions.replaceCurrent(s, "内置示例数据");
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
      const w: SampleWorld = { meta: { 名称: "示例大陆", worldModel: "sphere", planetRadiusKm: 10000, kmPerDeg: 111,
        terrain: "sample", bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 } } };
      await importWorld(w, "内置示例");
    },
    async linkFolder() {
      if (!fsSupported()) return;
      let handle: FolderHandle | null = null;
      try { handle = await showDirectoryPicker({ mode: "readwrite", id: "yutu-lib" }); } catch (e) { return; }  // 取消=静默
      let perm: string = "prompt"; try { perm = await handle.requestPermission({ mode: "readwrite" }); } catch (e) {}
      if (perm !== "granted") { alert("未获得该文件夹的读写权限。"); return; }
      snapView();
      ctx.folderDir = handle; ctx.source = "folder"; ctx.mapId = null;
      ctx.lib!.kvSet("libDir", handle).catch(() => {});
      ctx.lib!.kvSet("librarySource", "folder").catch(() => {});
      refreshLib();
    },
    backToBrowser() {
      snapView();
      ctx.source = "browser"; ctx.folderDir = null; ctx.mapId = null;
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
        ctx.R.render(host.viewBB(), { contour: layersSig.peek().contour, cMinor: cs.minor, cFade: cs.fade, wrap: ctx.meta.worldModel !== "flat" });
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
    try {
      ctx.lib = await openLibrary();
      const mig = await migrateFromLocalStorage(ctx.lib, localStorage);
      if (mig.imported || mig.updated) ctx.bootNote = `已从旧版存档迁移 ${mig.imported} 张、更新 ${mig.updated} 张`;
      await migrateFolderHandle(ctx.lib);
      ctx.fcache = (await ctx.lib.kvGet<FolderCacheState>("foldercache")) || {};
    } catch (e) { console.warn("图库不可用，退回直读示例：", e); ctx.lib = null; }
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
