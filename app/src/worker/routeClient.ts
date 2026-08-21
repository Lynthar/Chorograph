/* 寻路客户端（主线程侧）：Worker 可用→异步计算；建不出 Worker（file:// 等）→
   同步回退跑同一协议函数。ctx 始终同镜像到回退态——Worker 中途挂掉也能续算。
   Worker 经 `?worker&inline` 内联进主包（Vite）——单文件产物自包含、无外部 worker 文件。 */
import RouteWorker from "./routeWorker.ts?worker&inline";
import { handleRouteMsg, type RouteCtx, type RouteReply, type RouteRequest } from "./routeProto.ts";
import type { ComputedRoute, RoutePoint } from "../core/route.ts";
import type { Leg } from "../core/units.ts";
import type { Grid } from "../core/grid.ts";
import type { ErodeInput } from "../core/erode.ts";
import type { ElevField } from "../core/elev.ts";
import type { Arm, Meta, Unit, World } from "../core/types.ts";

export interface RouteContext { meta: Meta | undefined; grid: Grid; roads: Set<string>; world: World; yearNow: number }

export interface RouteClient {
  readonly usingWorker: boolean;
  setContext(ctx: RouteContext): void;
  route(A: RoutePoint, B: RoutePoint, arm: Arm): Promise<ComputedRoute | null>;
  /** roads=本单专用官道格（对象域编辑后 ctx 里那份可能陈旧，见 routeProto legs 注）；缺省用 ctx 的 */
  legs(unit: Unit, roads?: Set<string>): Promise<Leg[] | null>;
  /** 侵蚀重铸（自带输入不依赖 setContext；Worker 挂掉时返 null——调用方保持粗格） */
  erode(input: ErodeInput): Promise<ElevField | null>;
  /** 4K 静置精修（第三车道，懒建）：几十秒的精修单不许挤占工作档侵蚀车道。
      ⚠ 建不出 Worker 一律返 null **绝不同步回退**——30s 的同步演算＝冻死主线程，宁可不精修 */
  erodeUltra(input: ErodeInput): Promise<ElevField | null>;
  dispose(): void;
}

export function createRouteClient(): RouteClient {
  let w: Worker | null = null;
  let ew: Worker | null = null;   // 侵蚀专用 Worker（2026-08-09 提速批）：0.7~1s 的侵蚀单与寻路/腿账
                                  // 不再挤同一队列——收笔后 hover 路由不用等侵蚀，侵蚀也不用等腿账。
                                  // 同一份内联 bundle 二次实例化＝零体积成本；erode 自带全部输入，
                                  // 不吃 setContext，故 ew 无 ctx 镜像之需。
  let uw: Worker | null = null;   // 4K 静置精修车道（2026-08-11，懒建）：精修单跑几十秒，
  let uwTried = false;            // 与 ew 分开＝精修期间新笔的工作档侵蚀不排队
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
  try {
    ew = new RouteWorker();
    ew.onmessage = e => {
      const r = e.data as RouteReply;
      const f = pendingE.get(r.id);
      if (f) { pendingE.delete(r.id); f(r); }
    };
    ew.onerror = killErodeWorker;        // 侵蚀 worker 死＝该单以 null 收场（调用方保持粗格），后续退回主 worker/同步
    ew.onmessageerror = killErodeWorker;
  } catch { ew = null; }

  /* 上下文惰性推送（2026-08-13 规模引擎批）：rebuild 每笔都 setContext,而 postMessage 要
     结构化克隆整个 grid.cells——196 万格字符串数组一次克隆上百 ms,连笔＝每 move 白扔一次。
     故 setContext 只同步镜像到回退态（存引用,零克隆）并**记下待送件**,真正 postMessage 推迟到
     下一个 route/legs 请求之前（flushCtx）——查询永远先于自己看到最新上下文（同信道保序），
     没有查询的连笔一次都不用克隆。 */
  let ctxMsg: RouteRequest | null = null;
  const flushCtx = () => { if (ctxMsg && w) { w.postMessage(ctxMsg); ctxMsg = null; } };
  function ask(msg: RouteRequest & { id: number }): Promise<RouteReply> {
    if (w) { flushCtx(); return new Promise(res => { pending.set(msg.id, res); w!.postMessage(msg); }); }
    return Promise.resolve(handleRouteMsg(fallback, msg)!);
  }

  return {
    get usingWorker() { return !!w; },
    setContext(ctx) {
      const msg: RouteRequest = { t: "ctx", meta: ctx.meta, grid: ctx.grid, roads: ctx.roads, world: ctx.world, yearNow: ctx.yearNow };
      handleRouteMsg(fallback, msg);          // 镜像到回退态（引用赋值,便宜;Worker 侧见 flushCtx）
      if (w) ctxMsg = msg;
    },
    async route(A, B, arm) {
      const r = await ask({ t: "route", id: ++seq, A, B, arm });
      return r.t === "route" ? r.res : null;
    },
    async legs(unit, roads) {
      const r = await ask(roads ? { t: "legs", id: ++seq, unit, roads } : { t: "legs", id: ++seq, unit });
      return r.t === "legs" ? r.legs : null;
    },
    async erode(input) {
      /* 优先走侵蚀专用 worker；它死了退回主 worker/同步回退。任一 worker 死时对应 kill 以
         route 型收场→此处判型返 null（调用方保持粗格） */
      if (ew) {
        const id = ++seq;
        const r = await new Promise<RouteReply>(res => { pendingE.set(id, res); ew!.postMessage({ t: "erode", id, ...input }); });
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
    dispose() { killWorker(); killErodeWorker(); killUltraWorker(); }
  };
}
