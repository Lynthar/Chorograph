/* 寻路客户端（主线程侧）：Worker 可用→异步计算；建不出 Worker（file:// 等）→
   同步回退跑同一协议函数。ctx 始终同镜像到回退态——Worker 中途挂掉也能续算。
   Worker 经 `?worker&inline` 内联进主包（Vite）——单文件产物自包含、无外部 worker 文件。 */
import RouteWorker from "./routeWorker.ts?worker&inline";
import { handleRouteMsg, type MesoReply, type UpliftReply, type RouteCtx, type RouteReply, type RouteRequest, type SightReq, type SightRes, type VisReq, type VisRes } from "./routeProto.ts";
import type { ComputedRoute, RoutePoint } from "../core/route.ts";
import type { Leg } from "../core/units.ts";
import type { Grid } from "../core/grid.ts";
import type { CoarseCarve, ErodeInput } from "../core/erode.ts";
import type { ElevField, FieldGeom } from "../core/elev.ts";
import { mesoKey, type Gen2Sg, type UpliftCells } from "../core/gen2.ts";
import type { ViewField } from "../core/viewshed.ts";
import type { PeakTable } from "../core/spots.ts";
import type { Arm, Meta, Unit, World } from "../core/types.ts";

export interface RouteContext { meta: Meta | undefined; grid: Grid; roads: Set<string>; world: World; yearNow: number }

export interface RouteClient {
  readonly usingWorker: boolean;
  setContext(ctx: RouteContext): void;
  route(A: RoutePoint, B: RoutePoint, arm: Arm): Promise<ComputedRoute | null>;
  legs(unit: Unit): Promise<Leg[] | null>;
  /** 侵蚀重铸（自带输入不依赖 setContext；Worker 挂掉时返 null——调用方保持粗格） */
  erode(input: ErodeInput): Promise<ElevField | null>;
  /** 4K 静置精修（第三车道，懒建）：几十秒的精修单不许挤占工作档侵蚀车道。
      ⚠ 建不出 Worker 一律返 null **绝不同步回退**——30s 的同步演算＝冻死主线程，宁可不精修 */
  erodeUltra(input: ErodeInput): Promise<ElevField | null>;
  /** 撤掉在飞的精修单：terminate 车道、单以 null 收场（新编辑来了，几十秒的单跑完也只会被令牌作废）；
      无单在飞不动车道。下一单懒建新车道。 */
  cancelUltra(): void;
  /** 分块精修的车道数（按 CPU 核数定，懒建；host 按它决定同时在飞几块） */
  readonly tileLanes: number;
  /** 粗级切割量（分块精修各块共用，走分块车道）。建不出 Worker 返 null，绝不同步回退——同 erodeUltra */
  erodeCarve(input: ErodeInput): Promise<CoarseCarve | null>;
  /** 一块的窗口侵蚀（挑在飞单最少的分块车道）。同上不回退；新编辑来了也不撤——结果按内容寻址，算完照样有用 */
  erodeTile(input: ErodeInput): Promise<ElevField | null>;
  /** 撤掉在飞的工作档侵蚀单：同 cancelUltra——新编辑来了，上一笔的单算完只会被令牌作废，还挡着新单排队（收笔后多等 1～4 s）；
      被撤的结果不进场缓存（撤销回那一步要重算，用户拍板接受）。崩溃判死与主动撤单分开：撤单后下一单懒建新车道，判死后退回主 worker。 */
  cancelErode(): void;
  /** v2 图的中尺度稳态（独立车道，懒建）：整幅要 6–30 s，只依赖生成参数与几何——编辑不撤它；sg＝缓存的解（给了就只派生）。
      建不出 Worker 或车道崩了返 null，绝不同步回退（同 erodeUltra）；崩了的车道下一单懒建新的，建不出的要等 cancelMeso 才再试 */
  meso(meta: Meta, geom: FieldGeom, sg: Gen2Sg | null): Promise<MesoReply | null>;
  /** 撤掉在飞的中尺度单（换了生成参数或几何，旧单算完也用不上当前图）：以 null 收场，下一单懒建新车道；无单在飞不动车道。
      也是复位口：清掉「建不出」的记号，下一单再试着建一次车道 */
  cancelMeso(): void;
  /** 中尺度车道手里留着这把 mesoKey 的 Sg（上一单就是这张图、车道没被撤）：画抬升单这时不必带 sg */
  mesoHolds(key: string): boolean;
  /** 在 Sg 上解画抬升（同一车道；车道按 mesoKey 留着求解图，每笔只跑标定链）。sg＝车道没留着时由调用方从缓存取来；
      都没有时车道现算 Sg（同一份解，只是慢）。建不出 Worker 或车道崩了返 null，绝不同步回退 */
  uplift(meta: Meta, geom: FieldGeom, cells: UpliftCells, sg: Gen2Sg | null): Promise<UpliftReply | null>;
  /** 视线判定与标高点共用的规则场：同 setContext 惰性推送（下一单之前才克隆）；与上一份同一组数组＝不重推 */
  setViewField(field: ViewField): void;
  /** 一批观察者的视线掩膜（寻路车道）；Worker 挂掉时返 null——调用方保持上一份 */
  viewshed(obs: VisReq[]): Promise<VisRes[] | null>;
  /** 观察者 × 飞行目标的点对点视线（同车道、同一份规则场）；Worker 挂掉时返 null */
  sight(reqs: SightReq[]): Promise<SightRes[] | null>;
  /** 已推规则场的标高点峰表（同车道）；Worker 挂掉时返 null */
  peaks(): Promise<PeakTable | null>;
  dispose(): void;
}

export function createRouteClient(): RouteClient {
  let w: Worker | null = null;
  let ew: Worker | null = null;   // 侵蚀专用 Worker（2026-08-09 提速批）：0.7~1s 的侵蚀单与寻路/腿账
                                  // 不再挤同一队列——收笔后 hover 路由不用等侵蚀，侵蚀也不用等腿账。
                                  // 同一份内联 bundle 二次实例化＝零体积成本；erode 自带全部输入，
                                  // 不吃 setContext，故 ew 无 ctx 镜像之需。
  let ewDead = false;             // 侵蚀车道崩过＝不再建（退回主 worker / 同步）；主动撤单只置 ew=null，下一单懒建
  let uw: Worker | null = null;   // 4K 静置精修车道（2026-08-11，懒建）：精修单跑几十秒，
  let uwTried = false;            // 与 ew 分开＝精修期间新笔的工作档侵蚀不排队
  /* 分块精修车道（懒建）：首次开图要算一百多块、每块半秒到一秒，两条并行把等待减半；核少的机器只开一条，免得挤占交互 */
  const hc = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 0 : 0;
  const TILE_LANES = hc >= 6 ? 2 : 1;
  const tl: { w: Worker | null; tried: boolean; pend: Map<number, (r: RouteReply) => void> }[] =
    Array.from({ length: TILE_LANES }, () => ({ w: null, tried: false, pend: new Map() }));
  const killTileLane = (L: (typeof tl)[number]): void => {
    try { L.w?.terminate(); } catch { /* 已死 */ }
    if (L.w) L.tried = false;   // 崩了的车道下一单懒建新的（复位与否由分块编排定）；建不出 Worker 的照旧不再试
    L.w = null;
    for (const [, res] of L.pend) res({ t: "route", id: -1, res: null } as RouteReply);
    L.pend.clear();
  };
  const ensureTl = (L: (typeof tl)[number]): Worker | null => {
    if (L.tried) return L.w;
    L.tried = true;
    try {
      const w = new RouteWorker();
      w.onmessage = e => { const r = e.data as RouteReply, f = L.pend.get(r.id); if (f) { L.pend.delete(r.id); f(r); } };
      w.onerror = () => killTileLane(L);
      w.onmessageerror = () => killTileLane(L);
      L.w = w;
    } catch { L.w = null; }
    return L.w;
  };
  const askTile = (msg: RouteRequest & { id: number }): Promise<RouteReply | null> => {
    const L = tl.reduce((a, b) => (b.pend.size < a.pend.size ? b : a));
    const w = ensureTl(L);
    if (!w) return Promise.resolve(null);
    return new Promise(res => { L.pend.set(msg.id, res); w.postMessage(msg); });
  };
  let seq = 0;
  const pending = new Map<number, (r: RouteReply) => void>();
  const pendingE = new Map<number, (r: RouteReply) => void>();
  const pendingU = new Map<number, (r: RouteReply) => void>();
  const fallback: RouteCtx = {};
  const killWorker = () => {
    try { w?.terminate(); } catch { /* 已死 */ }
    w = null;
    for (const [, res] of pending) res({ t: "route", id: -1, res: null } as RouteReply);
    pending.clear();
  };
  const killErodeWorker = () => {
    try { ew?.terminate(); } catch { /* 已死 */ }
    ew = null;
    for (const [, res] of pendingE) res({ t: "route", id: -1, res: null } as RouteReply);
    pendingE.clear();
  };
  const ensureEw = (): Worker | null => {
    if (ew || ewDead) return ew;
    try {
      ew = new RouteWorker();
      ew.onmessage = e => {
        const r = e.data as RouteReply;
        const f = pendingE.get(r.id);
        if (f) { pendingE.delete(r.id); f(r); }
      };
      ew.onerror = () => { ewDead = true; killErodeWorker(); };        // 侵蚀 worker 死＝该单以 null 收场（调用方保持粗格），后续退回主 worker/同步
      ew.onmessageerror = () => { ewDead = true; killErodeWorker(); };
    } catch { ew = null; ewDead = true; }
    return ew;
  };
  let mw: Worker | null = null, mwFailed = false;   // 中尺度车道（懒建）：几十秒的单不挤侵蚀与精修车道，编辑时也不撤；mwFailed＝上回没建出来，cancelMeso 之前不再试
  let mwKey = "";                                   // 车道留着哪把 mesoKey 的 Sg（单落地才记；车道没了即清）
  const pendingM = new Map<number, (r: RouteReply) => void>();
  /* 崩了与撤单同样只丢掉车道：下一单懒建新的 */
  const killMesoWorker = () => {
    try { mw?.terminate(); } catch { /* 已死 */ }
    mw = null; mwKey = "";
    for (const [, res] of pendingM) res({ t: "route", id: -1, res: null } as RouteReply);
    pendingM.clear();
  };
  const ensureMw = (): Worker | null => {
    if (mw || mwFailed) return mw;
    try {
      const nw = new RouteWorker(), kill = (): void => { if (mw === nw) killMesoWorker(); };   // 只认自己：换掉的车道迟到的错误不许杀新车道
      mw = nw;
      nw.onmessage = e => { const r = e.data as RouteReply, f = pendingM.get(r.id); if (f) { pendingM.delete(r.id); f(r); } };
      nw.onerror = kill;
      nw.onmessageerror = kill;
    } catch { mw = null; mwFailed = true; }
    return mw;
  };
  const killUltraWorker = () => {
    try { uw?.terminate(); } catch { /* 已死 */ }
    uw = null;
    for (const [, res] of pendingU) res({ t: "route", id: -1, res: null } as RouteReply);
    pendingU.clear();
  };
  /* 懒建：不开战术图/低配机（host 不发精修单）的会话根本不实例化第三个 Worker */
  const ensureUw = (): Worker | null => {
    if (uwTried) return uw;
    uwTried = true;
    try {
      uw = new RouteWorker();
      uw.onmessage = e => {
        const r = e.data as RouteReply;
        const f = pendingU.get(r.id);
        if (f) { pendingU.delete(r.id); f(r); }
      };
      uw.onerror = killUltraWorker;
      uw.onmessageerror = killUltraWorker;
    } catch { uw = null; }
    return uw;
  };
  try {
    w = new RouteWorker();
    w.onmessage = e => {
      const r = e.data as RouteReply;
      const f = pending.get(r.id);
      if (f) { pending.delete(r.id); f(r); }
    };
    w.onerror = killWorker;         // Worker 崩=判死；已发请求以 null 收场，后续走同步回退
    w.onmessageerror = killWorker;  // 回程结构化克隆失败=同样判死（否则该请求 promise 永不 resolve）
  } catch { w = null; }
  ensureEw();   // 工作档车道构造时即建（常驻）；撤单后由 erode() 懒建

  /* 上下文惰性推送（2026-08-13 规模引擎批）：rebuild 每笔都 setContext,而 postMessage 要
     结构化克隆整个 grid.cells——196 万格字符串数组一次克隆上百 ms,连笔＝每 move 白扔一次。
     故 setContext 只同步镜像到回退态（存引用,零克隆）并**记下待送件**,真正 postMessage 推迟到
     下一个 route/legs 请求之前（flushCtx）——查询永远先于自己看到最新上下文（同信道保序），
     没有查询的连笔一次都不用克隆。
     网格是不可变实例：与 Worker 手里那份同一实例就不随 ctx 再送（1400² 一次序列化主线程约 65 ms）。 */
  let ctxMsg: (RouteRequest & { t: "ctx" }) | null = null, vfMsg: RouteRequest | null = null, vfCur: ViewField | null = null;
  let sentGrid: Grid | undefined;
  const flushCtx = () => {
    if (!w) return;
    if (ctxMsg) {
      const { grid, ...rest } = ctxMsg;
      w.postMessage(grid === sentGrid ? rest : ctxMsg);
      sentGrid = grid; ctxMsg = null;
    }
    if (vfMsg) { w.postMessage(vfMsg); vfMsg = null; }
  };
  function ask(msg: RouteRequest & { id: number }): Promise<RouteReply> {
    if (w) { flushCtx(); return new Promise(res => { pending.set(msg.id, res); w!.postMessage(msg); }); }
    return Promise.resolve(handleRouteMsg(fallback, msg)!);
  }

  return {
    get usingWorker() { return !!w; },
    setContext(ctx) {
      const msg = { t: "ctx" as const, meta: ctx.meta, grid: ctx.grid, roads: ctx.roads, world: ctx.world, yearNow: ctx.yearNow };
      handleRouteMsg(fallback, msg);          // 镜像到回退态（引用赋值,便宜;Worker 侧见 flushCtx）
      if (w) ctxMsg = msg;
    },
    async route(A, B, arm) {
      const r = await ask({ t: "route", id: ++seq, A, B, arm });
      return r.t === "route" ? r.res : null;
    },
    async legs(unit) {
      const r = await ask({ t: "legs", id: ++seq, unit });
      return r.t === "legs" ? r.legs : null;
    },
    setViewField(field) {
      if (vfCur && vfCur.data === field.data && vfCur.wsurf === field.wsurf && vfCur.unitM === field.unitM
        && vfCur.kmx === field.kmx && vfCur.kmy === field.kmy && vfCur.curvKm === field.curvKm) return;   // 视域与标高点两路各推一次同一份场＝白克隆几兆
      vfCur = field;
      const msg: RouteRequest = { t: "vfield", field };
      handleRouteMsg(fallback, msg);
      if (w) vfMsg = msg;
    },
    async viewshed(obs) {
      const r = await ask({ t: "viewshed", id: ++seq, obs });
      return r.t === "viewshed" ? r.res : null;
    },
    async sight(reqs) {
      const r = await ask({ t: "sight", id: ++seq, reqs });
      return r.t === "sight" ? r.res : null;
    },
    async peaks() {
      const r = await ask({ t: "peaks", id: ++seq });
      return r.t === "peaks" ? r.res : null;
    },
    async erode(input) {
      /* 优先走侵蚀专用 worker；它死了退回主 worker/同步回退。任一 worker 死时对应 kill 以
         route 型收场→此处判型返 null（调用方保持粗格） */
      const worker = ensureEw();
      if (worker) {
        const id = ++seq;
        const r = await new Promise<RouteReply>(res => { pendingE.set(id, res); worker.postMessage({ t: "erode", id, ...input }); });
        return r.t === "erode" ? r.f : null;
      }
      const r = await ask({ t: "erode", id: ++seq, ...input });
      return r.t === "erode" ? r.f : null;
    },
    async erodeUltra(input) {
      const worker = ensureUw();
      if (!worker) return null;   // 头注之约：绝不同步回退
      const id = ++seq;
      const r = await new Promise<RouteReply>(res => { pendingU.set(id, res); worker.postMessage({ t: "erode", id, ...input }); });
      return r.t === "erode" ? r.f : null;
    },
    tileLanes: TILE_LANES,
    async erodeCarve(input) {
      const r = await askTile({ t: "carve", id: ++seq, ...input });
      return r && r.t === "carve" ? r.carve : null;
    },
    async erodeTile(input) {
      const r = await askTile({ t: "erode", id: ++seq, ...input });
      return r && r.t === "erode" ? r.f : null;
    },
    cancelUltra() {
      if (!pendingU.size) return;
      killUltraWorker();
      uwTried = false;   // 与崩溃判死不同：这是主动撤单，车道要能再建
    },
    async meso(meta, geom, sg) {
      const worker = ensureMw();
      if (!worker) return null;
      const id = ++seq;
      const r = await new Promise<RouteReply>(res => { pendingM.set(id, res); worker.postMessage({ t: "meso", id, meta, geom, sg }, sg ? [sg.h.buffer, sg.rcv.buffer] : []); });
      if (r.t !== "meso") return null;
      if (mw === worker) mwKey = mesoKey(meta, geom);
      return r;
    },
    mesoHolds: key => !!key && key === mwKey && !!mw,
    async uplift(meta, geom, cells, sg) {
      const worker = ensureMw();
      if (!worker) return null;
      const id = ++seq;
      const r = await new Promise<RouteReply>(res => { pendingM.set(id, res); worker.postMessage({ t: "uplift", id, meta, geom, sg, cells }, sg ? [sg.h.buffer, sg.rcv.buffer] : []); });
      if (r.t !== "uplift") return null;
      if (mw === worker) mwKey = mesoKey(meta, geom);
      return r;
    },
    cancelMeso() {
      if (pendingM.size) killMesoWorker();   // 无单在飞不动车道：它留着的 Sg 下一单还用得上
      mwFailed = false;
    },
    cancelErode() {
      if (!pendingE.size) return;
      killErodeWorker();   // ewDead 不置：主动撤单，下一单懒建新车道
    },
    dispose() { killWorker(); killErodeWorker(); killUltraWorker(); killMesoWorker(); for (const L of tl) killTileLane(L); }
  };
}
