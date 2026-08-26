/* 画布宿主：画布尺寸、相机取景、地形网格/高程场重建。
   全部经 ctx 共享态工作；rebuild 同步把寻路上下文送进 Worker（官道格按当年连线重算）。 */
import { buildGridCells, roadCellSet, type Grid } from "../core/grid.ts";
import { buildElevField, coarseField, fieldMix, fieldPlusDelta, type ElevField } from "../core/elev.ts";
import { erodeGate, erodeInput, erodeKey, ultraInput, type ErodeInput } from "../core/erode.ts";
import { fieldCacheGet, fieldCachePut } from "../data/fieldcache.ts";
import { worldSig, yearSig, gridVerSig, erodePhaseSig } from "../ui/state.ts";
import { $ } from "./dom.ts";
import type { ShellCtx } from "./ctx.ts";
import type { Camera } from "../core/projection.ts";
import type { BBox, HeightOverride } from "../core/types.ts";

export interface Host {
  /** 画布物理像素跟随 CSS 尺寸与 DPR（缩放/换屏后重读 devicePixelRatio） */
  resize(): void;
  /** 画布 CSS 尺寸 [宽, 高] */
  cssSize(): [number, number];
  /** 当前视口的经纬度包围盒 */
  viewBB(): BBox;
  /** 纬度余弦（球面世界经度视觉压缩系数；平面恒 1＝与 projection.viewCosK 同判） */
  cosk(): number;
  /** 当前帧相机（投影/拾取共用参数包） */
  cam(): Camera;
  /** 重建地形网格与高程场并上传渲染器（无世界=程序化兜底参数） */
  rebuild(): void;
  /** 年份/换图/地形版本变化时才重建（builtFor 去重键） */
  rebuildIfNeeded(): void;
}

export function createHost(ctx: ShellCtx): Host {
  const { canvas, ov } = ctx;
  function resize(): void {
    const dpr = Math.max(1, devicePixelRatio || 1);   // 重读：缩放/换屏后 devicePixelRatio 变，帧内各处每帧读 ctx 自动跟新
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (dpr === ctx.DPR && canvas.width === w && canvas.height === h) return;   // 尺寸没变不碰画布（设宽高即清屏）
    ctx.DPR = dpr;
    canvas.width = w; canvas.height = h;
    ov.width = w; ov.height = h;
    /* 设完尺寸立即同步补画：ResizeObserver 回调跑在当帧 rAF 之后，清空的画布会先被合成上屏、
       下一帧才补画——检查器滑开/收起（0.22s 过渡逐帧触发 resize）期间空白帧与画面帧交替＝整屏闪烁。 */
    if (ctx.repaint) ctx.repaint();
  }
  function cssSize(): [number, number] { return [canvas.clientWidth, canvas.clientHeight]; }
  function viewBB(): BBox {
    const [w, h] = cssSize();
    return { lonMin: ctx.view.lon0 - w / 2 * ctx.view.degPerPx / cosk(), lonMax: ctx.view.lon0 + w / 2 * ctx.view.degPerPx / cosk(),
             latMin: ctx.view.lat0 - h / 2 * ctx.view.degPerPx, latMax: ctx.view.lat0 + h / 2 * ctx.view.degPerPx };
  }
  /* ⚠ 平面世界必须取 1（2026-08 审查修正）：viewBB 是地形栅格的渲染视口（frame/composeFrame
     直喂 R.render），而对象层走 projection.viewCosK（平面=1）——此处曾无条件 cos(lat0)，
     平面战术图（恒真实纬度，尺度定形批起）上地形与地点/部队横向错位 1/cosφ（38° 处 +27%），
     拖拽平移与方向键微调（pointer 两处经此函数）同病。球面分支逐位不变。 */
  const cosk = (): number => ctx.meta.worldModel === "flat" ? 1 : Math.cos(ctx.view.lat0 * Math.PI / 180);

  /* 侵蚀细化的并发闸：150ms 防抖（同拍的 legs/route 先进同一 Worker 队列、连续拨年/连笔只算
     最后一帧）+ 同一时刻至多一单在 Worker 里；飞行中再来重建只记「还有活」，回来后按最新网格
     补一单。⚠ 过期判据是**每次重建自增的 buildN**，不能用 builtFor 串——实时地形笔刷走
     pointer 的直调 rebuild() 而不 bump gridVerSig，连笔之间 builtFor 一字不变，开图/上一笔时
     发出的侵蚀单（算的是旧世界）落地时会顶掉刚画的内容＝「一松开就回到最初」（河洛实证）。
     ⚠ 等待窗显示不换回粗格场（河洛实证第二回「笔刷一按全图变、松开又变回」）：细分场在屏时
     的重建走 fieldPlusDelta＝旧细分场+粗格增量补丁，远处纹丝不动、笔下即时起落；细分场与它的
     增量基准（fineBase＝该场所出世界的粗格场）+ 几何键三件同担、随侵蚀落地一起换，门关或几何
     变（换图/改图幅）即弃场回粗格。**门的判定在 rebuild 同拍（pendGate＝erodeGate,轻）**、
     数组组装延迟到 fireErode 结算时（2026-08-13 规模引擎批：erodeInput 每次组装分配 ~13B/格,
     196 万格图上每笔 move 白扔 26MB＝GC 风暴;门与显示分支同源之约由 erodeGate 与 erodeInput
     的同一判据担保,worker.test 锁）。结果按输入内容寻址缓存（fireErode 头注：命中免重算），
     几何刚换的重建免防抖立即发单。 */
  let eroding = false, erodeDirty = false, erodeTimer: ReturnType<typeof setTimeout> | undefined, buildN = 0;
  let pendGate = false, pendHovs: HeightOverride[] | undefined, pendYear = 0;   // 门判定与延迟组装的原料（rebuild 同拍记账）
  let pendInp: ErodeInput | null = null, pendCoarse: Float32Array | null = null;   // 侵蚀单（fireErode 结算时才组装）与粗格场
  let pendUInp: ErodeInput | null = null;   // 同一单的精修档形态（数组共享引用，仅换预算三键；战术图才有）
  let fine: ElevField | null = null, fineBase: Float32Array | null = null, fineKey = "";   // 已落地细分场 + 增量基准 + 几何键
  let lastBuiltKey = "", coarseAt = 0;   // 上次重建的几何键（换几何＝免防抖立即发单）+ 本几何粗格首帧时刻（缓存「早到」判据）
  /* —— 4K 静置精修（2026-08-11）：交互档手感零变化——工作档落定且 ULTRA_IDLE_MS 无新改动后，
     后台第三车道按精修预算重算一遍，好了**硬换**入屏（只增细节的换场读作「对上焦/加载完成」，
     与缓存早到硬换同一先例；且 fieldMix 在 990 万格上一帧 ~40ms×6＝渐变本身就是卡顿）。
     内容寻址缓存吃到精修档：fireErode 开头先问精修键——画完的图重开即满解析、工作档整个免算。
     低内存机（deviceMemory<8）降到 2.8K 档；测不出（Firefox 等）按够用算。 */
  const dm = typeof navigator !== "undefined" ? (navigator as { deviceMemory?: number }).deviceMemory : undefined;
  const ULTRA_CAP = (dm ?? 8) >= 8 ? 10_500_000 : 5_250_000;
  const ULTRA_IDLE_MS = 6000;   // 静置这么久才发精修单——单要跑半分钟，窗太短＝零星编辑不断点燃注定作废的后台计算
  let ultraTimer: ReturnType<typeof setTimeout> | undefined, ultraBusy = false, ultraDirty = false;
  /* 相位胶囊（ui/state.erodePhaseSig，本模块独写）：只在真演算时亮，缓存命中静默；done 2s 自动归位 */
  let doneTimer: ReturnType<typeof setTimeout> | undefined;
  const setPhase = (p: "idle" | "work" | "ultra" | "done"): void => {
    erodePhaseSig.value = p;
    if (p === "done") {
      clearTimeout(doneTimer);
      doneTimer = setTimeout(() => { if (erodePhaseSig.peek() === "done") erodePhaseSig.value = "idle"; }, 2000);
    }
  };
  const dropPhase = (): void => { if (erodePhaseSig.peek() === "work" || erodePhaseSig.peek() === "ultra") erodePhaseSig.value = "idle"; };
  const geomKey = (g: Grid): string =>
    `${ctx.mapId}@${g.bb.lonMin},${g.bb.latMin},${g.bb.lonMax},${g.bb.latMax}@${g.step}@${g.cols}x${g.rows}`;
  function requestErode(): void {
    clearTimeout(erodeTimer);
    /* 60ms（2026-08-09 提速批，原 150）：防抖唯一职责是归并连发（笔刷 move/拨年/播放帧间隔
       8~33ms，60 足以吞并），收笔到重算启动的纯等待随之 -90ms；中途误发的单会被 buildN 令牌
       作废＝语义不变，只是侵蚀 worker 白算（它已独占一线，不再堵路由/腿账） */
    erodeTimer = setTimeout(fireErode, 60);
  }
  /* 落地渐变（fieldMix 注有病历：硬切读感像「出错了自己纠正」）：约 0.4s 六帧缓动换场。
     远处两场逐位相同＝渐变只在真变了的区域发生；帧间任何重建（buildN 变）即中止——
     rebuild 已按 fine(=终场)+增量接管显示，动画不许再覆盖它。fine/fineBase 在落地一拍
     **立即**记账（渐变纯属显示），中途重建合成的就是终场。 */
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  const FADE_MS = 240, FADE_STEPS = 6;   // 380→240（2026-08-10 精度批）：侵蚀单本身变长了，收尾渐变缩短把「等」的总观感拉回来（用户拍板）
  function startFade(to: ElevField): void {
    clearTimeout(fadeTimer);
    const from = ctx.elevField;
    if (!from) {   // 无在屏场（不该发生）＝直接换
      ctx.elevField = to;
      ctx.R!.uploadGrid(ctx.grid!, to);
      if (ctx.repaint) ctx.repaint();
      return;
    }
    const token = buildN;
    let k = 0;
    const tick = (): void => {
      if (buildN !== token || !ctx.grid) return;
      k++;
      const t = k / FADE_STEPS;
      ctx.elevField = fieldMix(from, to, t * t * (3 - 2 * t));   // 末帧 t=1 ＝ to 本身（真场引用）
      ctx.R!.uploadGrid(ctx.grid, ctx.elevField);
      if (ctx.repaint) ctx.repaint();
      if (k < FADE_STEPS) fadeTimer = setTimeout(tick, FADE_MS / FADE_STEPS);
    };
    tick();
  }
  /* 先问缓存（data/fieldcache 按 erodeKey 内容寻址；侵蚀确定性纯函数＝命中即逐位同重算结果）：
     开图/撤销/拨回看过的年份免 1~2s 重算——「先粗后细」的可见换场正是用户读作「还在施工/
     出错了」的那一下。**精修键先问**：本地形若曾静置精修过，直接以 4K 场入屏、工作档整个免算
     （画完的图重开即满解析）。工作档命中：几何刚换（开图/改图幅）时的命中落在粗帧上屏后数十
     毫秒内，直接硬换真形（粗帧至多闪一两帧＝「加载完成」的读感）；中途命中（拨年/撤销，粗帧
     已看了一阵）仍走渐变——fieldMix 的「硬切读感像出错了自己纠正」病历只适用于**看久了的画面**
     被结算的场合。 */
  function fireErode(): void {
    if (!ctx.grid || !pendGate) { dropPhase(); return; }   // 门关＝「relief=0 且无涂改」旧粗格路径逐位不变
    if (eroding) { erodeDirty = true; return; }
    /* 延迟组装（每 buildN 至多一次）：原料是 rebuild 同拍记下的 grid/hovs/year 快照——任何
       世界/年份变化都会先走 rebuild 刷新它们,故结算时组装与「rebuild 同拍组装」逐位同单 */
    if (!pendInp) {
      pendInp = erodeInput(ctx.meta, pendHovs, ctx.grid, pendYear);
      pendUInp = pendInp && ctx.meta.mapKind === "tactical" ? ultraInput(pendInp, ULTRA_CAP) : null;   // 精修档只给战术图（战略观感已验收，不碰）
    }
    if (!pendInp) { dropPhase(); return; }   // 门与组装理论上同判（erodeGate 锁）；防御留一手
    eroding = true;
    const token = buildN, baseC = pendCoarse!, key = geomKey(ctx.grid), inp = pendInp, uinp = pendUInp;
    const done = (): void => { if (erodeDirty) { erodeDirty = false; fireErode(); } };
    const uProbe = uinp ? fieldCacheGet(erodeKey(uinp)) : Promise.resolve(null);
    uProbe.then(uhit => {
      if (buildN !== token || !ctx.grid) { eroding = false; done(); return; }
      if (uhit) {   // 精修命中＝落定真形的最锐形态；硬换（精修换场恒硬换，见静置精修头注）
        eroding = false;
        landUltra(uhit, baseC, key, false);
        done();
        return;
      }
      const ck = erodeKey(inp);
      fieldCacheGet(ck).then(hit => {
        if (buildN !== token || !ctx.grid) { eroding = false; done(); return; }   // 其间已重建＝这单作废（新单已在防抖/dirty 里）
        if (hit) {
          eroding = false;
          /* 「早到」窗 1s：!fine 已把此分支限定在「刚换几何（开图/改图幅）」，窗只防「IDB 罕见
             卡死数秒后才命中」时硬换用户已看熟的粗帧；真机磁盘上取 3MB 条目偶尔要几百 ms，
             300ms 的窗曾让这类命中退化成渐变＝仍有一次可见换场（初版踩过） */
          const early = !fine && performance.now() - coarseAt < 1000;
          fine = hit; fineBase = baseC; fineKey = key;
          if (early) {
            clearTimeout(fadeTimer);
            ctx.elevField = hit;
            ctx.R!.uploadGrid(ctx.grid, hit);
            if (ctx.repaint) ctx.repaint();
          } else startFade(hit);
          scheduleUltra();
          done();
          return;
        }
        setPhase("work");
        ctx.routeClient.erode(inp).then(f => {
          eroding = false;
          if (f) void fieldCachePut(ck, f);   // 过期结果也入缓存——内容寻址＝对它的输入恒真，撤销/重做正好吃到
          if (f && buildN === token && ctx.grid) {   // 其间无任何重建才换场（有＝结果过期作废，新重建已另发单）
            fine = f; fineBase = baseC; fineKey = key;
            startFade(f);
            setPhase("done");
            scheduleUltra();
          } else dropPhase();
          done();
        }, e => {   // 拒绝也要放闸（同腿账之规）——卡死 eroding＝本会话侵蚀永哑、胶囊悬在「定形中」
          eroding = false; dropPhase();
          console.warn("侵蚀计算失败（保持粗格）：", e);
          done();
        });
      });
    });
  }
  /* —— 静置精修：工作档落定后 ULTRA_IDLE_MS 无新改动才发单；单飞行 + dirty 补发 + buildN 令牌
     作废过期结果（同工作档并发闸之规）。fireUltra 消费**发单当刻**的 pendUInp/pendCoarse——
     期间若有重建，令牌自会把落地拦下。 —— */
  const scheduleUltra = (): void => {
    if (!pendUInp) return;
    clearTimeout(ultraTimer);
    ultraTimer = setTimeout(fireUltra, ULTRA_IDLE_MS);
  };
  function fireUltra(): void {
    if (!ctx.grid || !pendUInp) return;
    if (ultraBusy) { ultraDirty = true; return; }
    ultraBusy = true;
    const token = buildN, baseC = pendCoarse!, key = geomKey(ctx.grid), uinp = pendUInp;
    const ck = erodeKey(uinp);
    const done = (): void => { if (ultraDirty) { ultraDirty = false; scheduleUltra(); } };
    fieldCacheGet(ck).then(hit => {
      if (buildN !== token || !ctx.grid) { ultraBusy = false; done(); return; }
      if (hit) { ultraBusy = false; landUltra(hit, baseC, key, false); done(); return; }
      setPhase("ultra");
      ctx.routeClient.erodeUltra(uinp).then(f => {
        ultraBusy = false;
        if (f) void fieldCachePut(ck, f);   // 半分钟的功不许白费：过期的精修对它的输入仍恒真（撤销即命中）
        if (f && buildN === token && ctx.grid) landUltra(f, baseC, key, true);
        else dropPhase();   // 过期/车道不可用＝撤胶囊；下个静置窗自会重排
        done();
      }, e => {   // 拒绝也要放闸——卡死 ultraBusy＝精修永哑、胶囊悬在「精修中」
        ultraBusy = false; dropPhase();
        console.warn("静置精修失败（保持工作档）：", e);
        done();
      });
    });
  }
  /** 精修场入屏：恒硬换（见静置精修头注）；computed=真算过（缓存命中静默、不闪「已定形」） */
  function landUltra(f: ElevField, baseC: Float32Array, key: string, computed: boolean): void {
    fine = f; fineBase = baseC; fineKey = key;
    clearTimeout(fadeTimer);
    ctx.elevField = f;
    ctx.R!.uploadGrid(ctx.grid!, f);
    if (ctx.repaint) ctx.repaint();
    if (computed) setPhase("done"); else dropPhase();
  }

  function rebuild(): void {
    const w = worldSig.value;
    /* 无世界（程序化预览）时的 genSeed/genStyle 直接用 ctx.meta——它有出厂默认
       （createShellCtx: auto/1234/continent），深链 #seed=/#style= 也已落在同一处。 */
    buildN++;   // 侵蚀令牌：任何一次重建都使在飞的侵蚀单过期（见 requestErode 注）
    clearTimeout(ultraTimer);   // 改动来了＝撤掉排着的静置精修（工作档落定后自会重排）
    const t0 = performance.now();
    ctx.grid = buildGridCells(ctx.meta, w ? w.terrainOverrides : [], yearSig.value);
    const coarse = buildElevField(ctx.meta, w ? w.heightOverrides : undefined, ctx.grid, yearSig.value);
    pendHovs = w ? w.heightOverrides : undefined;
    pendYear = yearSig.value;
    pendGate = erodeGate(ctx.meta, pendHovs, ctx.grid, pendYear);   // 门同拍判定（轻）；数组组装延迟到 fireErode 结算（见并发闸头注）
    pendInp = null; pendUInp = null;
    pendCoarse = coarse;
    /* 等待窗显示（见并发闸头注）：同几何细分场在屏＝粗格增量羽化叠上去；否则粗格场
       （开图先出粗帧、门关的旧契约路径、换图/改图幅弃场） */
    const key = geomKey(ctx.grid);
    if (!pendGate || fineKey !== key) { fine = null; fineBase = null; fineKey = ""; }
    ctx.elevField = fine && fineBase ? fieldPlusDelta(fine, fineBase, coarse, ctx.grid, ctx.grid.cells) : coarseField(ctx.grid, coarse);
    const ms = performance.now() - t0;
    ctx.R!.uploadGrid(ctx.grid, ctx.elevField);   // rebuild 只在渲染器就绪后发生（boot 先建 R）；缺 R=启动即错
    ctx.builtFor = ctx.mapId + "@" + yearSig.value + "@" + gridVerSig.value;
    $("hud").dataset.grid = `${ctx.grid.cols}×${ctx.grid.rows} 网格 ${ms.toFixed(0)} ms`;
    // 寻路上下文随网格重建同步进 Worker（官道格按当年连线重算）
    if (w) ctx.routeClient.setContext({ meta: ctx.meta, grid: ctx.grid, roads: roadCellSet(w.nodes, w.edges, yearSig.value, ctx.grid), world: w, yearNow: yearSig.value });
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
    if (ctx.mapId + "@" + yearSig.value + "@" + gridVerSig.value !== ctx.builtFor) rebuild();
  }
  function cam(): Camera {
    const [w, h] = cssSize();
    return { lon0: ctx.view.lon0, lat0: ctx.view.lat0, degPerPx: ctx.view.degPerPx, w, h, flat: ctx.meta.worldModel === "flat" };
  }
  return { resize, cssSize, viewBB, cosk, cam, rebuild, rebuildIfNeeded };
}
