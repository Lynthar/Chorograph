/* 画布宿主：画布尺寸、相机取景、地形网格/高程场重建。
   全部经 ctx 共享态工作；rebuild 同步把寻路上下文送进 Worker（官道格按当年连线重算）。 */
import { buildGridCells, roadCellSet, type Grid } from "../core/grid.ts";
import { buildElevField, coarseField, fieldMix, fieldPlusDelta, waterSurface, type ElevField } from "../core/elev.ts";
import { erodeGate, erodeInput, erodeKey, ultraInput, type ErodeInput, erodeMode } from "../core/erode.ts";
import { fieldCacheGet, fieldCachePut } from "../data/fieldcache.ts";
import { worldSig, yearSig, gridVerSig, erodePhaseSig, ruleFieldSig } from "../ui/state.ts";
import { terrMetaKey } from "../ui/history.ts";
import { $ } from "./dom.ts";
import { singleFlight } from "./singleflight.ts";
import type { ShellCtx } from "./ctx.ts";
import { clampView, viewCosK, type Camera } from "../core/projection.ts";
import { frameView } from "../core/frame.ts";
import type { BBox, HeightOverride, TerrainOverride, World } from "../core/types.ts";

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
  /** 写相机的唯一入口：clampView（坏值与球面折回）→ 图页取景（core/frame.frameView）；缺 degPerPx＝不改缩放 */
  setView(v: { lon0: number; lat0: number; degPerPx?: number }): void;
  /** 重建地形网格与高程场并上传渲染器（无世界=程序化兜底参数） */
  rebuild(): void;
  /** 年份/换图/地形版本变化时才重建（builtFor 去重键） */
  rebuildIfNeeded(): void;
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
       深链写进 ctx.view 的坐标会被拉到占位图幅上，等 setWorld 按真图幅取景 */
    if (worldSig.peek()) setView(ctx.view);
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
  let pendInp: ErodeInput | null = null, pendCoarse: Float32Array | null = null;   // 侵蚀单（fireErode 结算时才组装）与它的粗格基准（仅底图档＝不含高程涂改）
  let pendCoarseNow: Float32Array | null = null;   // 最新的含涂改粗格场：落地 / 渐变 / 精修入屏时把涂改增量叠回定形后的场（底图与涂改档下与 pendCoarse 同一对象）
  /** 定形后的场叠上「当前粗格 − 定形基准」（仅底图档＝高程笔的涂改）：底图与涂改档两份粗格同一对象，原样返回＝旧行为逐位 */
  const withDelta = (f: ElevField, baseC: Float32Array): ElevField =>
    pendCoarseNow && pendCoarseNow !== baseC && ctx.grid ? fieldPlusDelta(f, baseC, pendCoarseNow, ctx.grid, ctx.grid.cells) : f;
  let pendUInp: ErodeInput | null = null;   // 同一单的精修档形态（数组共享引用，仅换预算三键；战术图才有）
  /* 工作档＝规则场（ctx.ruleField）兼等待窗合成的基座，跨同几何的重建存活；精修档只进画面，且只对
     当前构建有效——任何重建即弃（落笔不在千万格的精修场上逐 move 复制重传，静置后自会重算）。 */
  let work: ElevField | null = null, workBase: Float32Array | null = null, workKey = "";   // 已落地工作档 + 增量基准 + 几何键
  let ultra: ElevField | null = null;   // 在屏精修场（本次构建）
  let gridKey = "", gridOv: TerrainOverride[] | null = null;   // 当前 ctx.grid 建自哪份（meta 键+年份+图 id, 涂改数组引用），见 rebuild 注
  let lastBuiltKey = "", coarseAt = 0;   // 上次重建的几何键（换几何＝免防抖立即发单）+ 本几何粗格首帧时刻（缓存「早到」判据）
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
  function startFade(to: ElevField, baseC: Float32Array): void {
    clearTimeout(fadeTimer);
    const from = ctx.elevField;
    if (!from) {   // 无在屏场（不该发生）＝直接换
      ctx.elevField = withDelta(to, baseC);
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
      ctx.elevField = fieldMix(from, withDelta(to, baseC), t * t * (3 - 2 * t));   // 末帧 t=1 ＝目标场引用；仅底图档下目标场每帧按最新涂改重叠（渐变中落的笔不丢）
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
  const erodeFlight = singleFlight(() => {
    const grid = ctx.grid!;
    if (!pendInp) {
      pendInp = erodeInput(ctx.meta, pendHovs, grid, pendYear);
      /* 2026-09-02 起战略图同享精修档，但**预算减半**：大陆级图（105 万粗格）在全额预算下取 3×＝
         950 万细格、单次要跑一两分钟；减半后恰取 2×＝420 万，几秒可得，内存也只要一半。 */
      pendUInp = pendInp ? ultraInput(pendInp, ctx.meta.mapKind === "tactical" ? ULTRA_CAP : ULTRA_CAP / 2) : null;
    }
    if (!pendInp) { dropPhase(); settleRule(); return Promise.resolve(); }   // 门与组装理论上同判（erodeGate 锁）；防御留一手
    const token = buildN, baseC = pendCoarse!, key = geomKey(grid), inp = pendInp, uinp = pendUInp;
    const ck = erodeKey(inp);
    return Promise.all([uinp ? fieldCacheGet(erodeKey(uinp)) : null, fieldCacheGet(ck)]).then(([uhit, hit]) => {
      if (buildN !== token || !ctx.grid) return;   // 其间已重建＝这单作废（新单已在防抖/dirty 里）
      if (uhit) landUltra(uhit, false);   // 画面先上最锐形态；规则场仍等工作档
      if (hit) { landWork(hit, baseC, key, false); return; }
      if (!ultra) setPhase("work");   // 精修在屏时工作档的补算是幕后事，胶囊不报
      return ctx.routeClient.erode(inp).then(f => {
        if (f) void fieldCachePut(ck, f);   // 过期结果也入缓存——内容寻址＝对它的输入恒真，撤销/重做正好吃到
        if (f && buildN === token && ctx.grid) landWork(f, baseC, key, true);   // 其间无任何重建才换场（有＝结果过期作废，新重建已另发单）
        else if (buildN === token) { dropPhase(); settleRule(); }   // 算不出＝这一轮就此落定在粗格（读数也读它）；过期（含被撤）＝新单接管相位与落定，胶囊不闪
      }, e => {   // 拒绝也要落定（闸自会放闸并补发）——否则胶囊悬在「侵蚀计算中」、读数无人落定
        dropPhase();
        if (buildN === token) settleRule();
        console.warn("侵蚀计算失败（保持粗格）：", e);
      });
    });
  }, () => fireErode());
  function fireErode(): void {
    if (!ctx.grid || !pendGate) { dropPhase(); return; }   // 门关＝「relief=0 且无涂改」旧粗格路径逐位不变
    erodeFlight.fire();
  }
  /** 工作档落地：规则场换真。画面：精修在屏＝不动（同一内容的更锐形态，不许被顶回去），只把规则场
      送进渲染器；否则上工作档——几何刚换的缓存命中硬换，其余渐变。「早到」窗 1s：!work 已把它限定在
      开图/改图幅，窗只防「IDB 罕见卡死数秒后才命中」时硬换用户已看熟的粗帧；真机磁盘上取 3MB 条目
      偶尔要几百 ms，300ms 的窗曾让这类命中退化成渐变＝仍有一次可见换场（初版踩过）。
      computed＝真算过（缓存命中静默、不闪「已定形」）。 */
  function landWork(f: ElevField, baseC: Float32Array, key: string, computed: boolean): void {
    const early = !computed && !work && performance.now() - coarseAt < 1000;
    work = f; workBase = baseC; workKey = key;
    ctx.ruleField = withDelta(f, baseC);
    settleRule();
    if (ultra) upload();
    else if (early) { clearTimeout(fadeTimer); ctx.elevField = ctx.ruleField; upload(); if (ctx.repaint) ctx.repaint(); }
    else startFade(f, baseC);
    if (computed && !ultra) setPhase("done");
    if (!ultra) scheduleUltra();   // 精修已在屏（缓存命中）＝无需再排
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
      setPhase("ultra");
      return ctx.routeClient.erodeUltra(uinp).then(f => {
        if (f) void fieldCachePut(ck, f);   // 半分钟的功不许白费：过期的精修对它的输入仍恒真（撤销即命中）
        if (f && buildN === token && ctx.grid) landUltra(f, true);
        else dropPhase();   // 过期/车道不可用＝撤胶囊；下个静置窗自会重排
      }, e => {   // 拒绝也要落定（闸自会放闸并重排）——否则胶囊悬在「精修中」
        dropPhase();
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
    ctx.elevField = withDelta(f, pendCoarse!);   // 这一单的基准＝组装它的那次重建的 pendCoarse
    upload();
    if (ctx.repaint) ctx.repaint();
    if (computed) setPhase("done"); else dropPhase();
  }

  /** 重建的收尾（两条路径共用）：去重键、hud 探针、寻路上下文 */
  function settleBuild(t0: number, w: World | null): void {
    const ms = performance.now() - t0;
    ctx.builtFor = ctx.mapId + "@" + yearSig.value + "@" + gridVerSig.value;
    $("hud").dataset.grid = `${ctx.grid!.cols}×${ctx.grid!.rows} 网格 ${ms.toFixed(0)} ms`;
    // 寻路上下文随网格重建同步进 Worker（官道格按当年连线重算）
    if (w) ctx.routeClient.setContext({ meta: ctx.meta, grid: ctx.grid!, roads: roadCellSet(w.nodes, w.edges, yearSig.value, ctx.grid!), world: w, yearNow: yearSig.value });
  }
  function rebuild(): void {
    const w = worldSig.value;
    const t0 = performance.now();
    /* 无世界（程序化预览）时的 genSeed/genStyle 直接用 ctx.meta——它有出厂默认
       （createShellCtx: auto/1234/continent），深链 #seed=/#style= 也已落在同一处。 */
    /* 类型网格按实例复用：只动 heightOverrides 的重建（高程笔每个 move）传同一个 Grid，基底与水面、起伏场、
       类型纹理、水面标高全按 Grid 实例记忆＝一并免算；键外任一项变了就换新实例，记忆整批作废。
       地貌笔改涂改必换数组（paintTerrainPath 只 filter/concat），撤销换世界＝换引用，故引用比较够用。 */
    const gk = `${ctx.mapId}|${yearSig.value}|${terrMetaKey(ctx.meta)}`, ov = w ? w.terrainOverrides : null;
    const reuse = !!ctx.grid && gk === gridKey && ov === gridOv;
    if (!reuse) {
      ctx.grid = buildGridCells(ctx.meta, ov || [], yearSig.value);
      gridKey = gk; gridOv = ov;
    }
    const hovs = w ? w.heightOverrides : undefined, mode = erodeMode(ctx.meta);
    const coarseNow = buildElevField(ctx.meta, hovs, ctx.grid!, yearSig.value);   // 含涂改的粗格场：显示与规则的增量来源
    /* 仅底图 / 关闭档且 Grid 没换＝侵蚀输入一字没变：不撤单、不发单、不换场，只把涂改增量叠回已定形的场（精修在屏也留着）——
       高程笔「笔落即最终」的落点就在这里。关闭档从无工作档，走不到这一支。 */
    if (mode !== "all" && reuse && work && workBase) {
      pendCoarseNow = coarseNow;
      ctx.ruleField = withDelta(work, workBase);
      ctx.elevField = ultra ? withDelta(ultra, workBase) : ctx.ruleField;
      settleRule();
      upload();
      settleBuild(t0, w);
      return;
    }
    buildN++;   // 侵蚀令牌：任何一次重建都使在飞的侵蚀单过期（见 requestErode 注）
    clearTimeout(ultraTimer);   // 改动来了＝撤掉排着的静置精修（工作档落定后自会重排）
    ultra = null;               // 精修只对本次构建有效：落笔即弃，画面回到工作档合成（见状态头注）
    ctx.routeClient.cancelUltra();   // 在飞的精修单也撤：几十秒的单跑完只会被令牌作废，白占一核
    ctx.routeClient.cancelErode();   // 在飞的工作档单同撤：算完只会被令牌作废，还挡着新单排队（收笔后多等 1～4 s）
    const erodeHovs = mode === "all" ? hovs : undefined;   // 仅底图档：侵蚀不看高程涂改
    const coarse = mode === "all" ? coarseNow : buildElevField(ctx.meta, undefined, ctx.grid!, yearSig.value);   // 侵蚀基座与增量基准
    pendHovs = erodeHovs;
    pendYear = yearSig.value;
    pendGate = erodeGate(ctx.meta, erodeHovs, ctx.grid!, pendYear);   // 门同拍判定（轻）；数组组装延迟到 fireErode 结算（见并发闸头注）
    pendInp = null; pendUInp = null;
    pendCoarse = coarse; pendCoarseNow = coarseNow;
    /* 等待窗显示（见并发闸头注）：同几何工作档在手＝粗格增量羽化叠上去；否则粗格场
       （开图先出粗帧、门关的旧契约路径、换图/改图幅弃场）。规则场与画面此刻同一份。 */
    const key = geomKey(ctx.grid!);
    if (!pendGate || workKey !== key) { work = null; workBase = null; workKey = ""; }
    ctx.ruleField = work && workBase ? fieldPlusDelta(work, workBase, coarseNow, ctx.grid!, ctx.grid!.cells) : coarseField(ctx.grid!, coarseNow);
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
    if (ctx.mapId + "@" + yearSig.value + "@" + gridVerSig.value !== ctx.builtFor) rebuild();
  }
  function cam(): Camera {
    const [w, h] = cssSize();
    return { lon0: ctx.view.lon0, lat0: ctx.view.lat0, degPerPx: ctx.view.degPerPx, w, h, flat: ctx.meta.worldModel === "flat" };
  }
  function setView(v: { lon0: number; lat0: number; degPerPx?: number }): void {
    const [w, h] = cssSize();
    const degPerPx = v.degPerPx ?? ctx.view.degPerPx;
    const c = frameView({ ...clampView(v, ctx.meta), degPerPx }, ctx.meta, w, h);
    ctx.view.lon0 = c.lon0; ctx.view.lat0 = c.lat0; ctx.view.degPerPx = degPerPx;
  }
  return { resize, cssSize, pxSize, viewBB, cosk, cam, setView, rebuild, rebuildIfNeeded };
}
