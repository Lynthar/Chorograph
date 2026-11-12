/* 画布宿主：画布尺寸、相机取景、地形网格/高程场重建。
   全部经 ctx 共享态工作；rebuild 同步把寻路上下文送进 Worker（官道格按当年连线重算）。 */
import { buildGridCells, gridGeom, overrideDiff, roadCellSet, type Grid } from "../core/grid.ts";
import { isGen2, mesoKey, riverParams, type Gen2MesoField, type GenRiver, type UpliftCells } from "../core/gen2.ts";
import { genRiverEdgesOf } from "../core/world.ts";
import { buildElevField, coarseField, fieldMix, fieldPlusDelta, dropWeights, upliftCells, waterSurface, type ElevField, type RuleField } from "../core/elev.ts";
import { erodeBasis, erodeGate, erodeInput, erodeKey, hovSig, ultraInput, upscaleOf, workNest, type ErodeInput, erodeMode } from "../core/erode.ts";
import { tilePlan } from "../core/tiles.ts";
import type { NestBase, NestSrc } from "../core/nested.ts";
import { fieldCacheGet, fieldCachePut } from "../data/fieldcache.ts";
import { tileCacheGet, tileCachePut } from "../data/tilecache.ts";
import { mesoCacheGet, mesoCachePut } from "../data/mesocache.ts";
import { createTileManager } from "./tiles.ts";
import { worldSig, yearSig, gridVerSig, erodePhaseSig, ruleFieldSig, tilesDownSig, mesoDownSig, cellsVerSig, inStroke, mutateWorldLive, readOnlySig, selSig } from "../app/state.ts";
import { syncGenRivers } from "../app/editops.ts";
import { terrMetaKey } from "../app/history.ts";
import { $ } from "./dom.ts";
import { singleFlight } from "./singleflight.ts";
import type { ShellCtx } from "./ctx.ts";
import { clampView, minDppFor, viewCosK, type Camera } from "../core/projection.ts";
import { scaleProfile } from "../core/scale.ts";
import { lonCos } from "../core/geo.ts";
import { frameView } from "../core/frame.ts";
import type { BBox, HeightOverride, Meta, TerrainOverride, World } from "../core/types.ts";

export interface Host {
  /** 可见区或 DPR 变了就重画；后备存储只增不减（换屏/缩放后重读 devicePixelRatio 才整个重分配） */
  resize(): void;
  /** 可见区（canvasWrap）CSS 尺寸 [宽, 高]——取景与投影都按它，画布本身可以更大 */
  cssSize(): [number, number];
  /** 可见区物理像素 [宽, 高]＝cssSize × DPR：渲染器只画画布左上这一块 */
  pxSize(): [number, number];
  /** 当前视口的经纬度包围盒 */
  viewBB(): BBox;
  /** 纬度余弦（球面世界经度视觉压缩系数；平面恒 1＝与 projection.viewCosK 同判） */
  cosk(): number;
  /** 当前帧相机（投影/拾取共用参数包） */
  cam(): Camera;
  /** 写相机的唯一入口：clampView（坏值与球面折回）→ 图页取景（core/frame.frameView）。
      带 degPerPx＝设缩放，放大那头钳到 dppRange().min；缺＝只挪位置、不改缩放（可见区变了重新取景就走这一支） */
  setView(v: { lon0: number; lat0: number; degPerPx?: number }): void;
  /** 缩放两头（度/像素）：min＝放大到底（core/projection.minDppFor），max＝缩小到底（全图整屏留一成余量，且不低于本图的开图缩放） */
  dppRange(): { min: number; max: number };
  /** 重建地形网格与高程场并上传渲染器（无世界=程序化兜底参数） */
  rebuild(): void;
  /** 年份/换图/地形版本变化时才重建（builtFor 去重键） */
  rebuildIfNeeded(): void;
  /** 把当前视口与缩放交给分块精修（帧循环每帧调，没变就不动）：决定先算哪几块、视口里的块齐了没有 */
  syncTiles(): void;
}

export function createHost(ctx: ShellCtx): Host {
  const { canvas, ov } = ctx;
  const wrap = $("canvasWrap");
  let seenW = 0, seenH = 0;   // 上次 resize 见到的可见区 CSS 尺寸
  /* 画布后备存储只增不减，CSS 盒随存储（style 宽高＝存储÷DPR），可见区（canvasWrap，overflow:hidden）裁掉多出的部分：
     改画布宽高＝同步重分配 GPU 缓冲，核显上每次 15～45 ms，检查器滑开/滑拢的 0.22 s 过渡逐帧触发十来次就是一串卡顿；
     可见区缩小只换视口与取景（渲染器按 pxSize 只画左上一块），不碰缓冲。DPR 变了才整个重分配。 */
  function resize(): void {
    const dpr = Math.max(1, devicePixelRatio || 1);   // 重读：缩放/换屏后 devicePixelRatio 变，帧内各处每帧读 ctx 自动跟新
    const [cw, ch] = cssSize();
    if (dpr === ctx.DPR && cw === seenW && ch === seenH) return;
    seenW = cw; seenH = ch;
    const w = Math.round(cw * dpr), h = Math.round(ch * dpr);
    if (dpr !== ctx.DPR || w > canvas.width || h > canvas.height) {
      const W = dpr !== ctx.DPR ? w : Math.max(w, canvas.width), H = dpr !== ctx.DPR ? h : Math.max(h, canvas.height);
      ctx.DPR = dpr;
      canvas.width = W; canvas.height = H;
      ov.width = W; ov.height = H;
      canvas.style.width = ov.style.width = `${W / dpr}px`;
      canvas.style.height = ov.style.height = `${H / dpr}px`;
    }
    /* 可见区变了取景就变（检查器滑开后图廓不许因视口变窄而越界）。开图前不钳：ctx.meta 还是占位图幅，
       深链写进 ctx.view 的坐标会被拉到占位图幅上，等 setWorld 按真图幅取景。
       只递位置不递缩放：放大上限里的小图护栏随可见区变，递了＝检查器一滑开画面自己退一档 */
    if (worldSig.peek()) setView({ lon0: ctx.view.lon0, lat0: ctx.view.lat0 });
    /* 立即同步补画：ResizeObserver 回调跑在当帧 rAF 之后——重分配后的空画布若等下一帧才画，空白帧会先被合成上屏；
       没重分配时取景也已随可见区变，同帧画上免得地图慢一拍才归中。 */
    if (ctx.repaint) ctx.repaint();
  }
  function cssSize(): [number, number] { return [wrap.clientWidth, wrap.clientHeight]; }
  function pxSize(): [number, number] { const [w, h] = cssSize(); return [Math.round(w * ctx.DPR), Math.round(h * ctx.DPR)]; }
  function viewBB(): BBox {
    const [w, h] = cssSize();
    return { lonMin: ctx.view.lon0 - w / 2 * ctx.view.degPerPx / cosk(), lonMax: ctx.view.lon0 + w / 2 * ctx.view.degPerPx / cosk(),
             latMin: ctx.view.lat0 - h / 2 * ctx.view.degPerPx, latMax: ctx.view.lat0 + h / 2 * ctx.view.degPerPx };
  }
  /* ⚠ 平面世界必须取 1（2026-08 审查修正）：viewBB 是地形栅格的渲染视口（frame/composeFrame
     直喂 R.render），而对象层走 projection.viewCosK（平面=1）——此处曾无条件 cos(lat0)，
     平面战术图（恒真实纬度，尺度定形批起）上地形与地点/部队横向错位 1/cosφ（38° 处 +27%），
     拖拽平移与方向键微调（pointer 两处经此函数）同病。球面分支逐位不变。 */
  const cosk = (): number => viewCosK({ flat: ctx.meta.worldModel === "flat", lat0: ctx.view.lat0 });

  /* 侵蚀细化的并发闸：150ms 防抖（同拍的 legs/route 先进同一 Worker 队列、连续拨年/连笔只算
     最后一帧）+ 同一时刻至多一单在 Worker 里；飞行中再来重建只记「还有活」，回来后按最新网格
     补一单。⚠ 过期判据是**每次重建自增的 buildN**，不能用 builtFor 串——实时地形笔刷走
     pointer 的直调 rebuild() 而不 bump gridVerSig，连笔之间 builtFor 一字不变，开图/上一笔时
     发出的侵蚀单（算的是旧世界）落地时会顶掉刚画的内容＝「一松开就回到最初」（河洛实证）。
     ⚠ 等待窗显示不换回粗格场（河洛实证第二回「笔刷一按全图变、松开又变回」）：细分场在屏时
     的重建走 fieldPlusDelta＝旧工作档+粗格增量补丁，远处纹丝不动、笔下即时起落；工作档与它的
     增量基准（workBase＝该场所出世界的粗格场）+ 几何键三件同担、随侵蚀落地一起换，门关或几何
     变（换图/改图幅）即弃场回粗格。**门的判定在 rebuild 同拍（pendGate＝erodeGate,轻）**、
     数组组装延迟到 fireErode 结算时（2026-08-13 规模引擎批：erodeInput 每次组装分配 ~13B/格,
     196 万格图上每笔 move 白扔 26MB＝GC 风暴;门与显示分支同源之约由 erodeGate 与 erodeInput
     的同一判据担保,worker.test 锁）。结果按输入内容寻址缓存（fireErode 头注：命中免重算），
     几何刚换的重建免防抖立即发单。 */
  let erodeTimer: ReturnType<typeof setTimeout> | undefined, buildN = 0;
  let pendGate = false, pendHovs: HeightOverride[] | undefined, pendYear = 0;   // 门判定与延迟组装的原料（rebuild 同拍记账）
  let pendInp: ErodeInput | null = null, pendCoarse: Float32Array | null = null;   // 侵蚀单（fireErode 结算时才组装）与它的粗格基准（手动档＝侵蚀看到的那份涂改的粗格场）
  let pendGrid: Grid | null = null;   // 侵蚀单取哪个 Grid：手动档下是侵蚀看到的那份地貌涂改与抬升建的（侵蚀不看之后的笔），其余即 ctx.grid
  let pendEh = "";   // 侵蚀单的高程涂改指纹（core/erode.hovSig；手动档才算）
  let pendLive = false;   // 这一轮（pendGrid）的单排上了或在飞；等中尺度没发出去、或算不出即置否——手动档的早退支只替还在路上的单等
  let pendCoarseNow: Float32Array | null = null;   // 最新的含涂改粗格场：落地 / 渐变 / 精修入屏时把涂改增量叠回定形后的场（自动档下与 pendCoarse 同一对象）
  /** 定形后的场叠上「当前粗格 − 定形基准」（手动档＝上次侵蚀之后的涂改）：自动档两份粗格同一对象，原样返回＝旧行为逐位 */
  const basinOf = (g: Grid): Uint8Array | null => g.meso ? g.meso.basin : null;   // 画的盆地：增量合成不钳陆地地板
  /** from＝f 与 baseC 出自的那个侵蚀 Grid：手动档下它的地貌与屏上的不同处，f 的侵蚀细节作废（dropOf） */
  const withDelta = <F extends ElevField>(f: F, baseC: Float32Array, from: Grid | null): F =>
    pendCoarseNow && pendCoarseNow !== baseC && ctx.grid ? fieldPlusDelta(f, baseC, pendCoarseNow, ctx.grid, ctx.grid.cells, basinOf(ctx.grid), dropOf(from)) : f;
  let pendUInp: ErodeInput | null = null;   // 同一单的精修档形态（数组共享引用，仅换预算三键）；走嵌套解的单没有
  /* 工作档＝规则场（ctx.ruleField）兼等待窗合成的基座，跨同几何的重建存活；精修档只进画面，且只对
     当前构建有效——任何重建即弃（落笔不在千万格的精修场上逐 move 复制重传，静置后自会重算）。 */
  let work: RuleField | null = null, workBase: Float32Array | null = null, workKey = "";   // 已落地工作档 + 增量基准 + 几何键
  let workEg: Grid | null = null, workEh = "";   // 工作档是哪个侵蚀 Grid、哪份高程涂改的解：与本轮的对不上＝画面上是旧解叠增量的合成，不许落定
  let ultra: ElevField | null = null;   // 在屏精修场（本次构建）
  /* 类型网格按（meta 键+年份+图 id, 地貌涂改数组引用, 中尺度场）留着：在屏的、侵蚀用的（手动档下可以是另一份）、只带 Sg 的。键换了整批作废 */
  let gridKey = "", grids: { ov: TerrainOverride[] | null; g: Grid }[] = [];
  let sentCells: string[][] | null = null;   // 上次随寻路上下文发出的类型格（换了就递增 cellsVerSig）
  let lastEg: Grid | null = null, lastEh = "";   // 上次重建的侵蚀 Grid 与高程涂改指纹
  let ehRef: HeightOverride[] | undefined, ehSig = "";   // 指纹按数组引用记：手动档下侵蚀看到的那份不会被原地改（editops.pinBase）
  /* 手动档下地貌被涂改换掉的格（侵蚀 Grid 对屏上 Grid，core/elev.dropWeights）：增量合成在这些格上丢掉旧的侵蚀细节——不丢，把山涂成平原后山脊的纹理还留在平地上。
     只算涂改换的：两个 Grid 的中尺度场不同时（画了抬升）先按涂改差圈范围，抬升重判出来的地类变化照旧叠增量。自动档的等待窗不用它（旧行为逐位） */
  const gridOvs = new WeakMap<Grid, TerrainOverride[] | null>();
  let dropMemo: { a: Grid; b: Grid; m: Float32Array | null } | null = null;
  function dropOf(from: Grid | null): Float32Array | null {
    const g = ctx.grid;
    if (!from || !g || from === g || erodeMode(ctx.meta) !== "base") return null;
    if (dropMemo && dropMemo.a === from && dropMemo.b === g) return dropMemo.m;
    const oa = gridOvs.get(from), ob = gridOvs.get(g);
    const m = oa === ob ? null : dropWeights(ctx.meta, from, g, from.meso === g.meso ? null : overrideDiff(oa || undefined, ob || undefined, g, yearSig.value));
    dropMemo = { a: from, b: g, m };
    return m;
  }
  let lastBuiltKey = "", coarseAt = 0;   // 上次重建的几何键（换几何＝免防抖立即发单）+ 本几何粗格首帧时刻（缓存「早到」判据）
  let builtYear = NaN;   // 上次重建的年份（离散换场查最近落地只在年份没变时）
  /* —— 4K 静置精修（2026-08-11）：交互档手感零变化——工作档落定且 ULTRA_IDLE_MS 无新改动后，
     后台第三车道按精修预算重算一遍，好了**硬换**入屏（只增细节的换场读作「对上焦/加载完成」，
     与缓存早到硬换同一先例；且 fieldMix 在 990 万格上一帧 ~40ms×6＝渐变本身就是卡顿）。
     内容寻址缓存吃到精修档：fireErode 并问精修键——画完的图重开即满解析上屏。
     低内存机（deviceMemory<8）降到 2.8K 档；测不出（Firefox / Safari 没有这个 API）也按低档——精修少一档没人看得出，
     满预算的场在低内存机上会把标签页顶爆（2026-09-22 用户拍板）。
     ⚠ 精修**只进画面**：预算随本机内存分档，规则场与读数恒为工作档（ctx.ruleField），精修命中时
     工作档照旧要算——否则重开曾精修过的图，规则与读数退回粗格。 */
  const dm = typeof navigator !== "undefined" ? (navigator as { deviceMemory?: number }).deviceMemory : undefined;
  const ULTRA_CAP = (dm ?? 0) >= 8 ? 10_500_000 : 5_250_000;
  const ULTRA_IDLE_MS = 6000;   // 静置这么久才发精修单——单要跑半分钟，窗太短＝零星编辑不断点燃注定作废的后台计算
  let ultraTimer: ReturnType<typeof setTimeout> | undefined;
  /* 相位胶囊（app/state.erodePhaseSig，本模块独写）：只在真演算时亮，缓存命中静默；done 2s 自动归位 */
  let doneTimer: ReturnType<typeof setTimeout> | undefined;
  const setPhase = (p: "idle" | "work" | "ultra" | "done"): void => {
    erodePhaseSig.value = p;
    if (p === "done") {
      clearTimeout(doneTimer);
      doneTimer = setTimeout(() => { if (erodePhaseSig.peek() === "done") erodePhaseSig.value = "idle"; }, 2000);
    }
  };
  const dropPhase = (): void => { if (erodePhaseSig.peek() === "work" || erodePhaseSig.peek() === "ultra") erodePhaseSig.value = "idle"; };
  /* —— 分块精修（战略图，core/tiles）：工作档落地后按块算 TILE 倍的画面细节，只进画面。预算按本机内存分档（同 ULTRA_CAP），
     定的是块倍率，不碰规则场。胶囊只在「当前缩放用得上块、视口里还有块没到」时亮——整幅视图下块看不见，后台算着也不报。 —— */
  const TILE_BUDGET = (dm ?? 0) >= 8 ? 48_000_000 : 20_000_000;
  let ultraRunning = false, tilesBusy = false;
  let doneOwed = false;   // 工作档或精修真算过、而视口里的块还没换完：「已完成」留到块齐了再报
  const tiles = createTileManager({
    client: ctx.routeClient, cacheGet: tileCacheGet, cachePut: (k, a) => { void tileCachePut(k, a); },
    onLayer: L => { ctx.tileLayer = L; ctx.R?.uploadTiles(L); if (ctx.repaint) ctx.repaint(); },
    onBusy: (b, computed) => {
      tilesBusy = b;
      if (b) { if (erodePhaseSig.peek() !== "work") setPhase("ultra"); }
      else {
        if (erodePhaseSig.peek() === "ultra" && !ultraRunning) { if (computed || doneOwed) setPhase("done"); else dropPhase(); }
        doneOwed = false;
      }
    },
    onDown: dn => { tilesDownSig.value = dn; }
  }, TILE_BUDGET * 4 * 1.3);
  const tilesOn = (): boolean => scaleProfile(ctx.meta).tiles && ctx.routeClient.tileLanes > 0;
  /* —— 中尺度（v2 图，core/gen2.gen2Meso）：稳态解只依赖生成参数与几何，独立车道上算、解存进 IDB。到了之前不发侵蚀单（先侵蚀宏观底再换形＝多一次可见换场），
     到了就换一个带它的新 Grid 重建。没有结果先复位车道再要一次，仍没有＝这张图照旧用宏观底、报不可用（mesoDownSig）；开图或换了键才再试。 —— */
  /** 中尺度场抽出的河与抽它用的滑杆键（riverParams）：滑杆换了要重抽，场不变 */
  interface RivSet { rk: string; rivers: GenRiver[] }
  const rkOf = (m: Meta): string => JSON.stringify(riverParams(m));
  let meso: { key: string; f: Gen2MesoField; riv: RivSet; nb: NestBase } | null = null;   // 当前图的那份（单槽）；nb＝块层嵌套解的静态场
  /** 中尺度场（中尺度单或画抬升的解）→ 它给块层嵌套解的那份：不挂在 Grid 上——Grid 换实例就整份克隆给寻路车道 */
  const nestOf = new WeakMap<Gen2MesoField, NestSrc>();
  let mesoWant = "", mesoBad = "";   // 在飞单的键 · 复位后仍没有结果的键（不再要、侵蚀不再等）
  let mesoReset = "", mesoSeen = ""; // 已复位过一次车道的键 · 上次重建的键（开图或换了键，这两条失败记录作废）
  let mesoHold = false;              // 这一轮的侵蚀单要等中尺度（rebuild 同拍定）
  let upWait = false;                // 胶囊亮着只因为早退支在等抬升的解（没有侵蚀单替它收场）
  function requestMeso(key: string): void {
    if (mesoWant === key) return;
    mesoWant = key;
    const meta = ctx.meta, geom = gridGeom(meta);
    const done = (m: { f: Gen2MesoField; riv: RivSet; nb: NestBase } | null, e?: unknown): void => {
      if (mesoWant !== key) return;   // 换了键：这一单撤了或用不上
      mesoWant = "";
      if (!m && mesoReset !== key) {   // 头一回没有结果：复位车道（崩了的懒建新的、建不出的再试一次）再要，侵蚀照旧等
        console.warn("中尺度稳态没有结果（复位车道再试一次）：", e ?? "车道不可用");
        mesoReset = key;
        ctx.routeClient.cancelMeso();
        requestMeso(key);
        return;
      }
      if (m) meso = { key, ...m }; else { mesoBad = key; console.warn("中尺度稳态没有结果（这张图照旧用宏观底）：", e ?? "车道不可用"); }
      if (ctx.grid) rebuild();
    };
    void mesoCacheGet(key).then(sg => ctx.routeClient.meso(meta, geom, sg)).then(r => {
      if (r?.sg) void mesoCachePut(key, r.sg);   // 现算的解都入缓存：过期的对它的键仍恒真
      if (!r) { done(null); return; }
      const f: Gen2MesoField = { base: r.base, env: r.env, cls: r.cls, basin: r.basin, water: r.water };
      nestOf.set(f, r.nest);
      done({ f, riv: { rk: rkOf(meta), rivers: r.rivers }, nb: r.nest.base });
    }, e => done(null, e));
  }
  /* —— 画抬升（v2 战略图，core/gen2.gen2Uplift）：在 Sg 上解，同一车道、单飞行闸（飞行中只记最新那份，落地后补发）；
     解按（mesoKey, 逐格目标）内容留最近几份——撤销、重做直接换上。解回来之前屏上沿用上一份、侵蚀不发单（落笔不画草稿）。 —— */
  const UP_KEEP = 4;
  interface UpSol { key: string; cells: UpliftCells; f: Gen2MesoField; riv: RivSet }
  let upDone: UpSol[] = [];
  let upKeep: UpSol | null = null;   // 侵蚀看到的那份抬升的解：手动档下它可以不是屏上那份，不许随 upDone 轮换掉（掉了＝侵蚀每隔几笔重等一次解）
  let upWant: { key: string; cells: UpliftCells } | null = null;   // 眼下要解的那份（rebuild 同拍记；侵蚀等的那份排在屏上那份之前）
  let upBad: { key: string; cells: UpliftCells }[] = [];           // 解不出的（至多屏上的与侵蚀看到的两份）：同一份不再等、不再发
  let upFly = "";                                                  // 在飞那单的 mesoKey（换图时撤车道）
  const sameCells = (a: UpliftCells, b: UpliftCells): boolean => {
    if (a === b) return true;
    if (a.idx.length !== b.idx.length) return false;
    for (let i = 0; i < a.idx.length; i++) if (a.idx[i] !== b.idx[i] || a.peakM[i] !== b.peakM[i]) return false;
    const fa = a.fidx, fb = b.fidx;
    if (!fa || !fb) return !fa === !fb;
    if (fa.length !== fb.length) return false;
    for (let i = 0; i < fa.length; i++) if (fa[i] !== fb[i] || a.floorM![i] !== b.floorM![i]) return false;
    return true;
  };
  const upAll = (): UpSol[] => upKeep ? [upKeep, ...upDone] : upDone;
  const upEntry = (key: string, cells: UpliftCells): UpSol | undefined => upAll().find(e => e.key === key && sameCells(e.cells, cells));
  const upFind = (key: string, cells: UpliftCells): Gen2MesoField | undefined => upEntry(key, cells)?.f;
  const upFlight = singleFlight(() => {
    const want = upWant;
    if (!want || upFind(want.key, want.cells)) return Promise.resolve();
    const meta = ctx.meta, geom = gridGeom(meta);
    upFly = want.key;
    const fail = (e?: unknown): void => {
      if (upFly !== want.key) return;   // 换图撤了车道：不是这张图的事
      upFly = ""; upBad = [want, ...upBad].slice(0, 2);
      console.warn("画抬升没有解出（这一笔不显示）：", e ?? "车道不可用");
      if (ctx.grid) rebuild();
    };
    return (ctx.routeClient.mesoHolds(want.key) ? Promise.resolve(null) : mesoCacheGet(want.key))
      .then(sg => ctx.routeClient.uplift(meta, geom, want.cells, sg))
      .then(r => {
        if (!r) { fail(); return; }
        upFly = "";
        const f: Gen2MesoField = { base: r.base, env: r.env, cls: r.cls, basin: r.basin, water: r.water };
        if (meso && meso.key === want.key) nestOf.set(f, { base: meso.nb, sol: r.nest });
        upDone = [{ key: want.key, cells: want.cells, f, riv: { rk: rkOf(meta), rivers: r.rivers } }, ...upDone].slice(0, UP_KEEP);
        if (ctx.grid) rebuild();   // 还要的就是它＝换上；已不是最新＝重建记下新的那份、闸放开后补发
      }, fail);
  }, () => upFlight.fire());
  /* —— 生成的河跟着屏上的中尺度场走：场换了、两个河流滑杆或删改记录变了就换带 gen 标记的河（editops.syncGenRivers，逐条相同零写入）。
     不推撤销（河是场的函数：撤销换回旧场，河跟着换回）、只读态不写；笔画中途不写（会让空笔回收误判），收笔后再来。
     屏上没有中尺度场（还在算或车道不可用）时留着存档里的河：拿宏观河顶替＝存档随车道好坏来回改写。 —— */
  const NO_CELLS: UpliftCells = { idx: new Int32Array(0), peakM: new Float64Array(0) };
  let rivLast: unknown[] = [], rivQueued = false;
  const rivEntry = (mf: Gen2MesoField): { cells?: UpliftCells; riv: RivSet } | undefined => meso && meso.f === mf ? meso : upAll().find(e => e.f === mf);
  function syncRiversSoon(): void {
    if (rivQueued) return;
    rivQueued = true;
    queueMicrotask(() => { rivQueued = false; syncRivers(); });   // 不在重建或编排 effect 里写 worldSig
  }
  function syncRivers(): void {
    const w = worldSig.peek(), g = ctx.grid;
    if (!w || !g || readOnlySig.peek() || !isGen2(ctx.meta)) return;
    if (inStroke()) { setTimeout(syncRiversSoon, 250); return; }
    const rk = rkOf(ctx.meta), mf = g.meso, e = mf ? rivEntry(mf) : undefined;
    if (!mf || !e) return;
    if (e.riv.rk !== rk) { rivFlight.fire(); return; }
    const now = [mf, rk, w.genRiverOff, w.edges];
    if (now.every((v, i) => v === rivLast[i])) return;
    const add = genRiverEdgesOf(ctx.meta, e.riv.rivers, w.genRiverOff);
    const sel = selSig.peek(), selE = sel && sel.kind === "edge" ? w.edges[sel.idx] : null;
    mutateWorldLive(x => syncGenRivers(x, add));
    const w2 = worldSig.peek()!;
    rivLast = [mf, rk, w2.genRiverOff, w2.edges];
    if (selE && sel && sel.kind === "edge") {   // 连线按下标选中：按对象身份找回新下标，换掉的生成河就清选中
      const k = w2.edges.indexOf(selE);
      if (k !== sel.idx) selSig.value = k >= 0 ? { kind: "edge", idx: k } : null;
    }
  }
  /** 滑杆换了：在屏的场用同一份格子再要一单（零个区＝gen2Meso 逐位同；车道留着求解状态时只跑收尾），只换它带的河 */
  const rivFlight = singleFlight(() => {
    const mf = ctx.grid && ctx.grid.meso, e = mf ? rivEntry(mf) : undefined, meta = ctx.meta, rk = rkOf(meta);
    if (!mf || !e || e.riv.rk === rk) return Promise.resolve();
    const geom = gridGeom(meta), key = mesoKey(meta, geom);
    return (ctx.routeClient.mesoHolds(key) ? Promise.resolve(null) : mesoCacheGet(key))
      .then(sg => ctx.routeClient.uplift(meta, geom, e.cells || NO_CELLS, sg))
      .then(r => { if (r) { e.riv = { rk, rivers: r.rivers }; syncRiversSoon(); } },
        err => console.warn("按新滑杆重抽河没有结果（沿用原来的河）：", err));
  }, () => rivFlight.fire());
  /** 规则场落定（ruleFieldSig 独写点）：门关的粗格、落地的工作档、算不出时当下那份；rebuild 起演算即置 null */
  const settleRule = (): void => { ruleFieldSig.value = ctx.ruleField; };
  const geomKey = (g: Grid): string =>
    `${ctx.mapId}@${g.bb.lonMin},${g.bb.latMin},${g.bb.lonMax},${g.bb.latMax}@${g.step}@${g.cols}x${g.rows}`;
  function requestErode(): void {
    clearTimeout(erodeTimer);
    /* 60ms（2026-08-09 提速批，原 150）：防抖唯一职责是归并连发（笔刷 move/拨年/播放帧间隔
       8~33ms，60 足以吞并），收笔到重算启动的纯等待随之 -90ms；中途误发的单会被 buildN 令牌
       作废＝语义不变，只是侵蚀 worker 白算（它已独占一线，不再堵路由/腿账） */
    erodeTimer = setTimeout(fireErode, 60);
  }
  /* 上传口收一处：画面场与规则场一起送（推演底图画规则场），水面高程随网格同拍取（core/elev.waterSurface
     按 Grid 记忆＝重复取零成本）。漏传水面内陆湖会静默沉回海平面，故不留第二条上传路径。 */
  const upload = (): void => ctx.R!.uploadGrid(ctx.grid!, waterSurface(ctx.meta, ctx.grid!), ctx.elevField!, ctx.ruleField!);
  /* 落地渐变（fieldMix 注有病历：硬切读感像「出错了自己纠正」）：约 0.4s 六帧缓动换场。
     远处两场逐位相同＝渐变只在真变了的区域发生；帧间任何重建（buildN 变）即中止——
     rebuild 已按 work(=终场)+增量接管显示，动画不许再覆盖它。work/workBase 在落地一拍
     **立即**记账（渐变纯属显示），中途重建合成的就是终场。 */
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  const FADE_MS = 240, FADE_STEPS = 6;   // 380→240（2026-08-10 精度批）：侵蚀单本身变长了，收尾渐变缩短把「等」的总观感拉回来（用户拍板）
  function startFade(to: ElevField, baseC: Float32Array, from0: Grid | null): void {
    clearTimeout(fadeTimer);
    const from = ctx.elevField;
    if (!from) {   // 无在屏场（不该发生）＝直接换
      ctx.elevField = withDelta(to, baseC, from0);
      upload();
      if (ctx.repaint) ctx.repaint();
      return;
    }
    const token = buildN;
    let k = 0;
    const tick = (): void => {
      if (buildN !== token || !ctx.grid) return;
      k++;
      const t = k / FADE_STEPS;
      ctx.elevField = fieldMix(from, withDelta(to, baseC, from0), t * t * (3 - 2 * t));   // 末帧 t=1 ＝目标场引用；手动档下目标场每帧按最新涂改重叠（渐变中落的笔不丢）
      upload();
      if (ctx.repaint) ctx.repaint();
      if (k < FADE_STEPS) fadeTimer = setTimeout(tick, FADE_MS / FADE_STEPS);
    };
    tick();
  }
  /* 先问缓存（data/fieldcache 按 erodeKey 内容寻址；侵蚀确定性纯函数＝命中即逐位同重算结果）：
     开图/撤销/拨回看过的年份免 1~2s 重算——「先粗后细」的可见换场正是用户读作「还在施工/
     出错了」的那一下。**精修键与工作档键并问**：精修命中＝画面直接上 4K 场；工作档仍照常取
     （命中或重算），它是规则场——精修只进画面（见静置精修头注）。工作档命中：几何刚换（开图/
     改图幅）时的命中落在粗帧上屏后数十毫秒内，直接硬换真形（粗帧至多闪一两帧＝「加载完成」的
     读感）；中途命中（拨年/撤销，粗帧已看了一阵）仍走渐变——fieldMix 的「硬切读感像出错了自己
     纠正」病历只适用于**看久了的画面**被结算的场合。 */
  /* 工作档单走单飞行闸（飞行中再来只记 dirty，落地后再过一遍 fireErode 的门）。延迟组装放在闸**内**、每 buildN 至多一次：
     原料是 rebuild 同拍记下的 grid/hovs/year 快照（任何世界/年份变化都先走 rebuild 刷新它们，结算时组装与同拍组装逐位同单）；
     放到闸外＝飞行期每笔 move 白组装一份 ~26MB 的单。 */
  /** 按 rebuild 同拍记下的原料组装这一轮的侵蚀单（每 buildN 至多一次） */
  function assemble(): void {
    if (pendInp) return;
    /* 带中尺度的 v2 图（细分 ≥ 2 倍）工作档走嵌套解（core/erode.workNest）：读数与等高线跟块层同一套谷网；不精修（ultraInput 对它返 null） */
    const inp = erodeInput(ctx.meta, pendHovs, pendGrid!, pendYear), ns = pendGrid!.meso ? nestOf.get(pendGrid!.meso) : undefined;
    pendInp = inp && ns ? workNest(inp, ns) : inp;
    /* 2026-09-02 起战略图同享精修档，但**预算减半**：大陆级图（105 万粗格）在全额预算下取 3×＝
       950 万细格、单次要跑一两分钟；减半后恰取 2×＝420 万，几秒可得，内存也只要一半。 */
    pendUInp = pendInp ? ultraInput(pendInp, ULTRA_CAP * scaleProfile(ctx.meta).ultraCapK) : null;
  }
  /** 工作档车道交出来的场才是规则场：标记只在这一处打（缓存命中与现算两个到货点），精修与块的车道不打 */
  const asWork = (f: ElevField): RuleField => ({ ...f, src: "work" });
  const erodeFlight = singleFlight(() => {
    const grid = ctx.grid!;
    assemble();
    if (!pendInp) { dropPhase(); settleRule(); pendLive = false; return Promise.resolve(); }   // 门与组装理论上同判（erodeGate 锁）；防御留一手
    const token = buildN, baseC = pendCoarse!, key = geomKey(grid), inp = pendInp, uinp = pendUInp;
    const ck = erodeKey(inp);
    return Promise.all([uinp ? fieldCacheGet(erodeKey(uinp)) : null, fieldCacheGet(ck)]).then(([uhit, hit]) => {
      if (buildN !== token || !ctx.grid) return;   // 其间已重建＝这单作废（新单已在防抖/dirty 里）
      if (uhit) landUltra(uhit, false);   // 画面先上最锐形态；规则场仍等工作档
      if (hit) { landWork(asWork(hit), baseC, key, false, inp, uinp, ck); return; }
      if (!ultra) setPhase("work");   // 精修在屏时工作档的补算是幕后事，胶囊不报
      return ctx.routeClient.erode(inp).then(f => {
        if (f) void fieldCachePut(ck, f);   // 过期结果也入缓存——内容寻址＝对它的输入恒真，撤销/重做正好吃到
        if (f && buildN === token && ctx.grid) landWork(asWork(f), baseC, key, true, inp, uinp, ck);   // 其间无任何重建才换场（有＝结果过期作废，新重建已另发单）
        else if (buildN === token) { dropPhase(); settleRule(); pendLive = false; }   // 算不出＝落定在当下那份（读数也读它），下次重建重发单；过期（含被撤）＝新单接管相位与落定，胶囊不闪
      }, e => {   // 拒绝也要落定（闸自会放闸并补发）——否则胶囊悬在「侵蚀计算中」、读数无人落定
        dropPhase();
        if (buildN === token) { settleRule(); pendLive = false; }
        console.warn("侵蚀计算失败（保持粗格）：", e);
      });
    });
  }, () => fireErode());
  function fireErode(): void {
    if (!ctx.grid || !pendGate) { dropPhase(); return; }   // 门关＝「relief=0 且无涂改」旧粗格路径逐位不变
    if (mesoHold) { pendLive = false; setPhase("work"); return; }   // 中尺度到了会重建、再发单
    erodeFlight.fire();
  }
  /** 工作档落地：规则场换真。画面：精修在屏＝不动（同一内容的更锐形态，不许被顶回去），只把规则场
      送进渲染器；否则上工作档——几何刚换的缓存命中硬换，其余渐变。「早到」窗 1s：!work 已把它限定在
      开图/改图幅，窗只防「IDB 罕见卡死数秒后才命中」时硬换用户已看熟的粗帧；真机磁盘上取 3MB 条目
      偶尔要几百 ms，300ms 的窗曾让这类命中退化成渐变＝仍有一次可见换场（初版踩过）。
      computed＝真算过（缓存命中静默、不闪「已定形」）。 */
  function landWork(f: RuleField, baseC: Float32Array, key: string, computed: boolean, inp: ErodeInput, uinp: ErodeInput | null, ck: string): void {
    const early = !computed && !work && performance.now() - coarseAt < 1000;
    work = f; workBase = baseC; workKey = key; workEg = pendGrid; workEh = pendEh;
    keep({ key, base: baseC, f, ck });
    ctx.ruleField = withDelta(f, baseC, workEg);
    settleRule();
    if (ultra) upload();
    else if (early) { clearTimeout(fadeTimer); ctx.elevField = ctx.ruleField; upload(); if (ctx.repaint) ctx.repaint(); }
    else startFade(f, baseC, workEg);
    if (!ultra) scheduleUltra();   // 精修已在屏（缓存命中）＝无需再排
    /* 分块：画面场已有的倍率（精修档或工作档）不比块细才分块；计划为空＝本图不分块 */
    if (tilesOn()) {
      const plan = tilePlan(inp, TILE_BUDGET, uinp ? upscaleOf(uinp.cols, uinp.rows, uinp.cap, uinp.axisMax) : upscaleOf(inp.cols, inp.rows, inp.cap, inp.axisMax));
      const ns = pendGrid && pendGrid.meso ? nestOf.get(pendGrid.meso) ?? null : null;   // 工作档是嵌套解时块的目标面取它（同一份输入落地的场）
      if (plan) tiles.setInput(inp, plan, baseC, ck, ns && inp.nest ? { ...ns, work: { data: f.data, sx: inp.nest.sx } } : ns); else tiles.reset();
    }
    /* 胶囊在块编排之后定：视口里的块没换完，「已完成」欠着、块齐了再报；缓存命中静默，前一单被撤时亮着的「计算中」也收掉 */
    if (ultra) return;
    if (tilesBusy) { if (computed) doneOwed = true; setPhase("ultra"); }
    else if (computed) setPhase("done");
    else dropPhase();
  }
  /* 撤销 / 重做这类同年的离散换场常回到刚落地过的地形：最近几份工作档留在内存，内容键对上就同步换上，
     不走等待窗合成——合成＝定形场减去未侵蚀的满高增量，撤一笔大幅雕刻会合成出一圈坑和土垒 */
  const RECENT = 4;
  let recent: { key: string; base: Float32Array; f: RuleField; ck: string }[] = [];
  function keep(e: { key: string; base: Float32Array; f: RuleField; ck: string }): void {
    recent = [e, ...recent.filter(x => x.key === e.key && x.ck !== e.ck)].slice(0, RECENT);   // 只留当前几何的
  }
  const sameArr = (a: Float32Array, b: Float32Array): boolean => {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  /** 粗格基准相同的才组装侵蚀单比内容键（组装与求键要几十毫秒，只在候选上付） */
  function recall(key: string, coarse: Float32Array): { f: RuleField; ck: string } | null {
    const cand = recent.filter(e => e.key === key && sameArr(e.base, coarse));
    if (!cand.length) return null;
    assemble();
    const ck = pendInp ? erodeKey(pendInp) : "";
    return cand.find(e => e.ck === ck) ?? null;
  }
  /* —— 静置精修：工作档落定后 ULTRA_IDLE_MS 无新改动才发单；单飞行闸 + buildN 令牌作废过期结果。
     dirty 补发走 scheduleUltra **重新等静置窗**而不是立即发——立即发会在用户刚落笔后烧一单半分钟的精修。
     fireUltra 消费**发单当刻**的 pendUInp——期间若有重建，令牌自会把落地拦下。 —— */
  const scheduleUltra = (): void => {
    if (!pendUInp) return;
    clearTimeout(ultraTimer);
    ultraTimer = setTimeout(fireUltra, ULTRA_IDLE_MS);
  };
  const ultraFlight = singleFlight(() => {
    const token = buildN, uinp = pendUInp!;
    const ck = erodeKey(uinp);
    return fieldCacheGet(ck).then(hit => {
      if (buildN !== token || !ctx.grid) return;
      if (hit) { landUltra(hit, false); return; }
      setPhase("ultra"); ultraRunning = true;
      return ctx.routeClient.erodeUltra(uinp).then(f => {
        ultraRunning = false;
        if (f) void fieldCachePut(ck, f);   // 半分钟的功不许白费：过期的精修对它的输入仍恒真（撤销即命中）
        if (f && buildN === token && ctx.grid) landUltra(f, true);
        else if (!tilesBusy) dropPhase();   // 过期/车道不可用＝撤胶囊；下个静置窗自会重排
      }, e => {   // 拒绝也要落定（闸自会放闸并重排）——否则胶囊悬在「精修中」
        ultraRunning = false;
        if (!tilesBusy) dropPhase();
        console.warn("静置精修失败（保持工作档）：", e);
      });
    });
  }, scheduleUltra);
  function fireUltra(): void {
    if (!ctx.grid || !pendUInp) return;
    ultraFlight.fire();
  }
  /** 精修场入屏：恒硬换（见静置精修头注）；只进画面，work/ruleField 不动。computed=真算过（缓存命中静默、不闪「已定形」） */
  function landUltra(f: ElevField, computed: boolean): void {
    ultra = f;
    clearTimeout(fadeTimer);
    ctx.elevField = withDelta(f, pendCoarse!, pendGrid);   // 这一单的基准＝组装它的那次重建的 pendCoarse
    upload();
    if (ctx.repaint) ctx.repaint();
    if (tilesBusy) { if (computed) doneOwed = true; return; }   // 视口里还有块在算：胶囊留给分块收尾
    if (computed) setPhase("done"); else dropPhase();
  }

  /** 重建的收尾（两条路径共用）：去重键、hud 探针、寻路上下文 */
  function settleBuild(t0: number, w: World | null): void {
    const ms = performance.now() - t0;
    ctx.builtFor = ctx.mapId + "@" + yearSig.value + "@" + gridVerSig.value;
    $("hud").dataset.grid = `${ctx.grid!.cols}×${ctx.grid!.rows} 网格 ${ms.toFixed(0)} ms`;
    // 寻路上下文随网格重建同步进 Worker（官道格按当年连线重算）
    if (w) ctx.routeClient.setContext({ meta: ctx.meta, grid: ctx.grid!, roads: roadCellSet(w.nodes, w.edges, yearSig.value, ctx.grid!), world: w, yearNow: yearSig.value });
    if (w && ctx.grid!.cells !== sentCells) { sentCells = ctx.grid!.cells; cellsVerSig.value++; }
  }
  /** recallOk＝离散换场（经 rebuildIfNeeded）：年份没变时先查最近落地过的工作档；笔刷每个 move 不查 */
  function rebuild(recallOk = false): void {
    const w = worldSig.value;
    const t0 = performance.now();
    const sameYear = yearSig.value === builtYear;
    builtYear = yearSig.value;
    /* 无世界（程序化预览）时的 genSeed/genStyle 直接用 ctx.meta——它有出厂默认
       （createShellCtx: auto/1234/continent），深链 #seed=/#style= 也已落在同一处。 */
    /* 类型网格按实例复用：只动 heightOverrides 的重建（高程笔每个 move）传同一个 Grid，基底与水面、起伏场、
       类型纹理、水面标高全按 Grid 实例记忆＝一并免算；键外任一项变了就换新实例，记忆整批作废。
       地貌笔改涂改必换数组（paintTerrainPath 只 filter/concat），撤销换世界＝换引用，故引用比较够用。 */
    const gk = `${ctx.mapId}|${yearSig.value}|${terrMetaKey(ctx.meta)}`, ov = w ? w.terrainOverrides : null, geom = gridGeom(ctx.meta);
    const mk = isGen2(ctx.meta) ? mesoKey(ctx.meta, geom) : "", sgF = meso && meso.key === mk ? meso.f : undefined;
    if (gk !== gridKey) { grids = []; gridKey = gk; }
    /** 这份地貌涂改配这份中尺度场的类型网格：留着的直接取（同一实例＝按实例记忆的派生量全免算），没有才建 */
    const gridOf = (o: TerrainOverride[] | null, f: Gen2MesoField | undefined): Grid => {
      let e = grids.find(x => x.ov === o && x.g.meso === f);
      if (!e) { grids.push(e = { ov: o, g: buildGridCells(ctx.meta, o || [], yearSig.value, f) }); gridOvs.set(e.g, o); }
      return e.g;
    };
    /* 侵蚀看到的三轴涂改（core/erode.erodeBasis）：手动档＝上次侵蚀时的那份，其余档就是现状（下面带 E 的量与屏上的同一份） */
    const bas = w ? erodeBasis(w) : null;
    const isBad = (c: UpliftCells | null): boolean => !!c && upBad.some(b => b.key === mk && sameCells(b.cells, c));
    /* 画抬升：当年生效的逐格目标。解到了就换上它；没到就沿用屏上那份（同一张图上一笔的解或 Sg），侵蚀等它 */
    const cells = sgF && w ? upliftCells(ctx.meta, w.upliftOverrides, geom, yearSig.value) : null;
    const cellsB = !bas || bas.uplift === w!.upliftOverrides ? cells : sgF ? upliftCells(ctx.meta, bas.uplift, geom, yearSig.value) : null;
    const cellsE = cells && cellsB && sameCells(cells, cellsB) ? cells : cellsB;   // 内容相同＝同一份（撤销回来的新数组）
    const bad = isBad(cells), badE = cellsE === cells ? bad : isBad(cellsE);
    const upF = cells && !bad ? upFind(mk, cells) : undefined;
    const upE = cellsE === cells ? upF : cellsE && !badE ? upFind(mk, cellsE) : undefined;
    const prev = ctx.grid, same = grids.some(x => x.g === prev && x.ov === ov);
    const mf = !cells || bad ? sgF : upF ?? (same && prev!.meso ? prev!.meso : sgF);
    /* 中尺度场换了＝底稿地类也换了（按它的基底重判），格随之换一个实例。侵蚀的 Grid：屏上同一份抬升就跟屏上走（含等解时的沿用），
       另一份还没解到先拿 Sg 占位——侵蚀单被 mesoHold 扣着，解到了重建时换上 */
    ctx.grid = gridOf(ov, mf);
    const eg = gridOf(bas ? bas.terrain : ov, cellsE === cells ? mf : upE ?? sgF);
    grids = grids.filter(x => x.g === ctx.grid || x.g === eg || (!!sgF && x.ov === ov && x.g.meso === sgF));   // 只带 Sg 的那份留着：擦掉抬升、撤销时直接换回
    upKeep = cellsE && upE ? upEntry(mk, cellsE) ?? null : null;
    if ((mesoWant && mesoWant !== mk) || (upFly && upFly !== mk)) { ctx.routeClient.cancelMeso(); mesoWant = ""; upFly = ""; }
    if (ctx.builtFor === null || mk !== mesoSeen) { mesoBad = ""; mesoReset = ""; mesoSeen = mk; }   // 开图（landWorld 清空了 builtFor）或换了键：允许再试
    upWant = cellsE && cellsE !== cells && !badE && !upE ? { key: mk, cells: cellsE } : cells && !bad && !upF ? { key: mk, cells } : null;
    mesoHold = !!mk && mk !== mesoBad && (!sgF || !!upWant);
    mesoDownSig.value = !!mk && mk === mesoBad;
    if (!sgF) { if (mesoHold) requestMeso(mk); }
    else if (upWant) upFlight.fire();
    syncRiversSoon();
    const hovs = w ? w.heightOverrides : undefined, mode = erodeMode(ctx.meta);
    const eh = bas ? bas.height : undefined;   // 侵蚀看到的高程涂改（自动档就是 hovs）
    if (mode !== "base") { ehRef = undefined; ehSig = ""; }
    else if (eh !== ehRef) { ehRef = eh; ehSig = hovSig(eh); }
    const eReuse = eg === lastEg && ehSig === lastEh, workHere = workEg === eg && workEh === ehSig;
    lastEg = eg; lastEh = ehSig;
    const coarseNow = buildElevField(ctx.meta, hovs, ctx.grid!, yearSig.value);   // 含涂改的粗格场：显示与规则的增量来源
    /* 手动 / 关闭档且侵蚀的 Grid 与高程涂改都没换＝侵蚀输入一字没变：不撤单、不发单、不换场，只把之后的涂改增量叠回已定形的场（精修在屏也留着）——
       「笔落即最终」的落点就在这里。关闭档从无工作档，走不到这一支。
       工作档不是这份输入的解时，只在本轮的单还在路上才走这里：画面照常跟笔，落定等那一单落地（先落定合成场＝落地又变一次）。 */
    if (mode !== "all" && eReuse && work && workBase && (workHere || pendLive)) {
      pendCoarseNow = coarseNow;
      tiles.setCoarse(coarseNow, ctx.grid!, dropOf(workEg));
      ctx.ruleField = withDelta(work, workBase, workEg);
      ctx.elevField = ultra ? withDelta(ultra, workBase, workEg) : ctx.ruleField;
      if (workHere) settleRule();
      /* 点了「应用」、解还没回来：侵蚀输入暂时没变所以走到这里，胶囊照样亮；解到了若仍走这一支（侵蚀不看这份抬升），由这里收掉 */
      if (upWant) { upWait = true; setPhase("work"); } else if (upWait) { upWait = false; if (!pendLive) dropPhase(); }
      upload();
      settleBuild(t0, w);
      return;
    }
    upWait = false;   // 全路径：相位归侵蚀单管
    buildN++;   // 侵蚀令牌：任何一次重建都使在飞的侵蚀单过期（见 requestErode 注）
    clearTimeout(ultraTimer);   // 改动来了＝撤掉排着的静置精修（工作档落定后自会重排）
    ultra = null;               // 精修只对本次构建有效：落笔即弃，画面回到工作档合成（见状态头注）
    ctx.routeClient.cancelUltra();   // 在飞的精修单也撤：几十秒的单跑完只会被令牌作废，白占一核
    ctx.routeClient.cancelErode();   // 在飞的工作档单同撤：算完只会被令牌作废，还挡着新单排队（收笔后多等 1～4 s）
    const coarse = eg === ctx.grid && eh === hovs ? coarseNow : buildElevField(ctx.meta, eh, eg, yearSig.value);   // 侵蚀基座与增量基准（自动档＝含涂改的那份本身）
    pendHovs = eh;
    pendYear = yearSig.value;
    pendGrid = eg; pendEh = ehSig;
    pendGate = erodeGate(ctx.meta, eh, eg, pendYear);   // 门同拍判定（轻）；数组组装延迟到 fireErode 结算（见并发闸头注）
    pendInp = null; pendUInp = null; pendLive = pendGate;
    pendCoarse = coarse; pendCoarseNow = coarseNow;
    doneOwed = false;
    const key = geomKey(ctx.grid!);
    if (!pendGate || key !== lastBuiltKey || !tilesOn()) tiles.reset();   // 换几何、门关或换成战术图＝旧块作废；同几何的编辑留着旧块叠增量
    tiles.setCoarse(coarseNow, ctx.grid!, dropOf(workEg));
    /* 等待窗显示（见并发闸头注）：同几何工作档在手＝粗格增量羽化叠上去；否则粗格场
       （开图先出粗帧、门关的旧契约路径、换图/改图幅弃场）。规则场与画面此刻同一份。 */
    if (!pendGate || workKey !== key) { work = null; workBase = null; workKey = ""; workEg = null; workEh = ""; }
    /* 年份变了不查：播放与拨年每步都换 Grid、地形又多半不随年变，每步组装求键＝每帧白付几十毫秒 */
    const back = recallOk && sameYear && pendGate && !mesoHold && key === lastBuiltKey ? recall(key, coarse) : null;
    if (back) {   // 内容对上＝这就是该落定的场，不发单
      clearTimeout(erodeTimer);
      settleBuild(t0, w);
      if (back.f !== work) { landWork(back.f, coarse, key, false, pendInp!, pendUInp, back.ck); return; }   // 换回别的一步：渐变换场、块按它重排
      workEg = eg; workEh = ehSig;   // 内容键对上＝它也是这份输入的解
      ctx.ruleField = ctx.elevField = withDelta(work!, workBase!, eg);   // 就是在屏那份：只落定，块的输入也没变
      settleRule(); upload(); dropPhase(); scheduleUltra();
      return;
    }
    ctx.ruleField = work && workBase ? fieldPlusDelta(work, workBase, coarseNow, ctx.grid!, ctx.grid!.cells, basinOf(ctx.grid!), dropOf(workEg)) : coarseField(ctx.grid!, coarseNow);
    ctx.elevField = ctx.ruleField;
    ruleFieldSig.value = pendGate ? null : ctx.ruleField;   // 门开＝落地前是过渡合成，规则消费者沿用上一份；门关＝粗格即终态
    upload();   // rebuild 只在渲染器就绪后发生（boot 先建 R）；缺 R=启动即错
    settleBuild(t0, w);
    /* 有单的图异步细化：谷网算好即整场换真（无细分场在屏时先出的是粗格帧）。
       几何刚换（开图/改图幅）＝这一单不欠防抖债，立即发——缓存命中时数十毫秒内即上真形；
       150ms 防抖只为连笔/连续拨年归并（同几何的后续重建照旧走它）。 */
    if (key !== lastBuiltKey) {
      lastBuiltKey = key; coarseAt = performance.now();
      clearTimeout(erodeTimer);
      fireErode();
    } else requestErode();
  }
  function rebuildIfNeeded(): void {
    if (!ctx.R) return;
    if (ctx.mapId + "@" + yearSig.value + "@" + gridVerSig.value !== ctx.builtFor) rebuild(true);
    else syncRiversSoon();   // 世界变了、地形没变（删河、撤销删河、挪河流滑杆）：河照样核一遍
  }
  function cam(): Camera {
    const [w, h] = cssSize();
    return { lon0: ctx.view.lon0, lat0: ctx.view.lat0, degPerPx: ctx.view.degPerPx, w, h, flat: ctx.meta.worldModel === "flat" };
  }
  /* 缩小到底＝全图恰好整屏 × 1.1（没有图幅或可见区时退回 0.5）；放大到底喂的是这个纯 fit，不含存档里的 degPerPx0 */
  function dppRange(): { min: number; max: number } {
    const bb = ctx.meta.bbox, [w, h] = cssSize();
    const fit = bb && w > 0 && h > 0
      ? Math.max((bb.lonMax - bb.lonMin) * lonCos(ctx.meta, (bb.latMin + bb.latMax) / 2) / w, (bb.latMax - bb.latMin) / h) * 1.1 : 0.5;
    return { min: minDppFor(ctx.meta, fit), max: Math.max(fit, ctx.meta.view?.degPerPx0 || 0) };
  }
  function setView(v: { lon0: number; lat0: number; degPerPx?: number }): void {
    const [w, h] = cssSize();
    const degPerPx = v.degPerPx == null ? ctx.view.degPerPx : Math.max(v.degPerPx, dppRange().min);
    const c = frameView({ ...clampView(v, ctx.meta), degPerPx }, ctx.meta, w, h);
    ctx.view.lon0 = c.lon0; ctx.view.lat0 = c.lat0; ctx.view.degPerPx = degPerPx;
  }
  function syncTiles(): void { tiles.setView(viewBB(), ctx.view.degPerPx); }
  return { resize, cssSize, pxSize, viewBB, cosk, cam, setView, dppRange, rebuild: () => rebuild(), rebuildIfNeeded, syncTiles };
}
