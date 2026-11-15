/* 分块精修的编排：拿到全图工作档输入 → Worker 算一份粗级切割量（中尺度图不跑粗级、没有这一步） → 各块的键 → 内存/缓存命中直接认领，其余按「视口里的先、离视心近的先」排队算。
   新一份输入的块全部攒着不上屏，到齐了报 onReady，host 调 commit 才与工作档在同一帧换上；编辑后旧块照旧显示、叠上粗格增量（同工作档的等待窗合成）。
   块只进画面：规则场、读数与等高线不读这里。 */
import { applyDelta, deltaOf, type CoarseDelta, type Surface } from "../core/elev.ts";
import { tileCells, tileCore, tileField, tileInput, tileKeyOf, tilesInView, tileWeight, type TileLayer, type TilePlan } from "../core/tiles.ts";
import type { CoarseCarve, ErodeInput } from "../core/erode.ts";
import type { NestSrc } from "../core/nested.ts";
import type { Grid } from "../core/grid.ts";
import type { BBox } from "../core/types.ts";
import type { RouteClient } from "../worker/routeClient.ts";

export interface TileDeps {
  client: Pick<RouteClient, "erodeCarve" | "erodeTile" | "tileLanes">;
  cacheGet(key: string): Promise<Float32Array | null>;
  cachePut(key: string, data: Float32Array): void;
  /** 块层换了（null＝下屏）：host 交给渲染器、记进 ctx 并重画 */
  onLayer(layer: TileLayer | null): void;
  /** 当前输入下已是这一份的块数与块总数（每认领或算完一块报一次） */
  onProgress(done: number, total: number): void;
  /** 当前输入的块到齐了（ok）或车道停摆、不会再有了（!ok）：每份输入至多报一次；computed＝这一份里有真算出来的（不全是内存或缓存命中） */
  onReady(ok: boolean, computed: boolean): void;
  /** down＝车道失败、复位一次后又失败，本会话不再算块，而当前缩放用得上块、视口里有块不是当前那一份——host 据此报「精修不可用」 */
  onDown(down: boolean): void;
}
export interface TileManager {
  /** 换图、换几何、本图不再分块：全部清空、块层下屏 */
  reset(): void;
  /** 新一份全图工作档输入（同几何）：plan＝core/tiles.tilePlan 的结果，base＝这份输入出自的粗格场（增量合成的基准），key＝erodeKey(inp)（切割量按它在内存里留几份）；
      nest＝这份输入出自的中尺度场给嵌套解的那份（带中尺度的图才有，有它块就走嵌套解；工作档也是嵌套解时 nest.work 带着它，块的目标面取它）。
      换了键的块攒着不上屏，到齐报 onReady（全在内存里时在本调用内同步报） */
  setInput(inp: ErodeInput, plan: TilePlan, base: Float32Array, key: string, nest?: NestSrc | null): void;
  /** 把攒着的块（已是当前输入那一份的）一起放上屏：host 在换工作档的同一帧调 */
  commit(): void;
  /** 当前含涂改的粗格场与网格（每次重建都送）：在屏块按它补增量；drop＝地貌被涂改换掉的粗格（core/elev.deltaOf 的 drop，没有传 null）；sf＝now 所出的那份 Surface */
  setCoarse(now: Float32Array, grid: Grid, drop: Float32Array | null, sf: Surface | null): void;
  /** 视口与缩放（每帧送，没变就不动）：只定先算哪几块与停摆时报不报，不放块上屏 */
  setView(view: BBox, degPerPx: number): void;
}

interface Shown { key: string; raw: Float32Array; base: Float32Array }

/** 内存里留几份粗级切割量：撤销、重做回到算过的输入时免等 Worker */
const CARVE_KEEP = 4;
/** 车道失败后等多久复位一次（毫秒） */
export const TILE_RETRY_MS = 5000;
/** 同时在查缓存的块数：读缓存不占计算车道，重开一张算过的图时一百多块别排成一队 */
const PROBE = 8;

export function createTileManager(d: TileDeps, memCapBytes: number): TileManager {
  let token = 0, plan: TilePlan | null = null, inp: ErodeInput | null = null, base: Float32Array | null = null, inpKey = "", nest: NestSrc | null = null;
  let carve: CoarseCarve | null | undefined, keys: Map<number, string> | null = null;   // carve：undefined＝还没到，null＝中尺度图不要
  const carves = new Map<string, CoarseCarve>();   // erodeKey → 切割量（Map 的插入序当 LRU）
  let dead = false;   // 车道失败：停发单，等复位
  let retry: "none" | "pending" | "used" = "none";   // 复位只给一次；用过之后再失败＝本会话停摆
  const mem = new Map<string, Float32Array>();   // 键 → 块心（Map 的插入序当 LRU）
  let memBytes = 0;
  const shown = new Map<number, Shown>(), published = new Set<number>(), held = new Set<number>();
  const fresh = new Map<number, Shown>();   // 在屏块的新一份：commit 才换上
  const probeQ = new Set<number>(), probing = new Map<number, string>();   // 等查缓存的块 · 在查的
  const queue = new Set<number>(), inflight = new Map<number, string>();   // 等算的块（缓存里没有）· 在算的
  let now: Float32Array | null = null, grid: Grid | null = null, drop: Float32Array | null = null, sf: Surface | null = null;
  let view: BBox | null = null, dpp = 0, vis = new Set<number>();
  let disp = new Map<number, Float32Array>(), dispFor = new Map<number, [Float32Array, Float32Array, Float32Array, Float32Array | null]>();   // 在屏块 → (raw, base, now, drop) 算出的显示数组
  let readied = false, computed = false, up = false, down = false;   // readied＝这份输入报过 onReady 了；up＝块层在屏（下屏只在上过屏时报）
  let frozen = false;   // 块几何换了：屏上那份旧块层原样留着（不叠增量），commit 才换成新的或下屏
  const emit = (L: TileLayer | null): void => { if (!L && !up) return; up = !!L; d.onLayer(L); };

  const remember = (key: string, a: Float32Array): void => {
    if (mem.has(key)) { mem.delete(key); mem.set(key, a); return; }
    mem.set(key, a); memBytes += a.byteLength;
    const live = new Set(keys ? keys.values() : []);
    for (const [k, v] of mem) {
      if (memBytes <= memCapBytes) break;
      if (live.has(k)) continue;
      mem.delete(k); memBytes -= v.byteLength;
    }
  };
  const visibleOf = (p: TilePlan, v: BBox): Set<number> => new Set(tilesInView(p.geom, p.tiles, v));
  const weight = (): number => (plan && dpp > 0 ? tileWeight(plan.geom.step / dpp) : 0);
  /** 块 i 手里（在屏的或等着换上的）是不是当前输入的那一份 */
  const current = (i: number): boolean => !!keys && (fresh.get(i) ?? shown.get(i))?.key === keys.get(i);

  /* 块层：在屏块按「raw + (当前粗格 − 它的基准粗格)」出显示数组；三样引用都没变就沿用上一份（渲染器按数组引用判要不要重传） */
  function publish(): void {
    if (!plan) return;
    const deltas = new Map<Float32Array, CoarseDelta | null>(), next = new Map<number, Float32Array>(), nextFor = new Map<number, [Float32Array, Float32Array, Float32Array, Float32Array | null]>();
    let changed = disp.size !== published.size;
    for (const i of published) {
      const s = shown.get(i)!, prev = dispFor.get(i);
      let a = disp.get(i)!;
      if (!prev || prev[0] !== s.raw || prev[1] !== s.base || prev[2] !== now || prev[3] !== drop) {
        a = s.raw;
        if (now && grid && s.base !== now) {
          if (!deltas.has(s.base)) deltas.set(s.base, deltaOf(s.base, now, grid, drop));
          const dl = deltas.get(s.base);
          if (dl) a = applyDelta(tileField(plan.geom, i, s.raw), dl, now, grid, grid.cells, grid.meso ? grid.meso.basin : null, sf).data;
        }
        if (a !== disp.get(i)) changed = true;
      }
      next.set(i, a); nextFor.set(i, [s.raw, s.base, now!, drop]);
    }
    disp = next; dispFor = nextFor;
    if (changed) emit({ geom: plan.geom, tiles: disp });
  }
  /* 进度与到齐：全部块都是当前那一份＝到齐；车道复位后又失败（切割量都没要到也算）＝不会再有了，等缓存查完也报（host 照现有的换上、另报不可用）。每份输入至多报一次 */
  function check(): void {
    const halted = dead && retry === "used";
    let done = 0;
    if (keys) { for (const i of keys.keys()) if (current(i)) done++; d.onProgress(done, keys.size); }
    const all = !!keys && done === keys.size;
    if (plan && !readied && (all || (halted && !probeQ.size && !probing.size))) { readied = true; d.onReady(all, computed); }
    const dn = halted && weight() > 0 && [...vis].some(i => !current(i));
    if (dn !== down) { down = dn; d.onDown(dn); }
  }
  function land(i: number, key: string, raw: Float32Array): void {
    if (!keys || keys.get(i) !== key) return;   // 计划已换：块只进内存与缓存
    const s = { key, raw, base: base! };
    if (published.has(i)) fresh.set(i, s);
    else { shown.set(i, s); held.add(i); }
  }
  /* 失败：停发单；头一回等 TILE_RETRY_MS 复位（车道崩了 routeClient 会懒建新的），再失败就停在现有画面 */
  function fail(e?: unknown): void {
    if (dead) return;
    console.warn("分块精修失败（保持现有画面场）：", e ?? "车道没有结果");
    dead = true;
    if (retry === "none") { retry = "pending"; setTimeout(revive, TILE_RETRY_MS); }
    check();
  }
  function revive(): void {
    dead = false; retry = "used";
    if (plan && inp && carve === undefined) requestCarve(); else pump();
    check();
  }
  const center = (): [number, number] => (view ? [(view.lonMin + view.lonMax) / 2, (view.latMin + view.latMax) / 2] : [0, 0]);
  function next(from: Set<number>): number | undefined {
    const p = plan!, g = p.geom, [cx, cy] = center();
    let best: number | undefined, bs = Infinity;
    for (const i of from) {
      const { c0, r0, c1, r1 } = tileCells(g, i);
      const dx = g.lonMin + (c0 + c1) / 2 * g.pstep - cx, dy = g.latMin + (r0 + r1) / 2 * g.pstep - cy;
      const s = (vis.has(i) ? 0 : 1e9) + dx * dx + dy * dy;
      if (s < bs) { bs = s; best = i; }
    }
    return best;
  }
  function pump(): void {
    /* 先查缓存（不占车道，车道停摆也照查）：命中直接认领，没有的才进等算的队 */
    while (plan && keys && probeQ.size && probing.size < PROBE) {
      const i = next(probeQ)!, key = keys.get(i)!;
      probeQ.delete(i); probing.set(i, key);
      const miss = (): void => { if (keys?.get(i) === key && !current(i)) queue.add(i); };
      void d.cacheGet(key).then(hit => { if (hit) { remember(key, hit); land(i, key, hit); } else miss(); }, miss)
        .finally(() => { if (probing.get(i) === key) probing.delete(i); check(); pump(); });
    }
    while (!dead && plan && inp && carve !== undefined && keys && queue.size && inflight.size < Math.max(1, d.client.tileLanes)) {
      const i = next(queue)!, key = keys.get(i)!, t = token, p = plan, src = inp, cv = carve, ns = nest;
      queue.delete(i); inflight.set(i, key);
      const lost = (e?: unknown): void => { if (t === token && keys?.get(i) === key) queue.add(i); fail(e); };   // 这一块回队，复位后接着算
      void d.client.erodeTile(tileInput(src, p, cv, i, ns)).then(f => {
        if (!f) { lost(); return; }
        const core = tileCore(f, p, i);
        remember(key, core); d.cachePut(key, core);
        if (t === token) computed = true;
        land(i, key, core);
      }).catch(lost)
        .finally(() => { if (inflight.get(i) === key) inflight.delete(i); check(); pump(); });
    }
  }
  /* 切割量到了：先算齐全部块键（判「到齐」要看全），再逐块认领——键没变的只换基准，内存命中的直接认领，其余先查缓存 */
  function onCarve(cv: CoarseCarve | null): void {
    const p = plan!, src = inp!;
    carve = cv; keys = new Map();
    for (const i of p.tiles) keys.set(i, tileKeyOf(src, p, cv, i, nest));
    for (const [i, key] of keys) {
      const f = fresh.get(i);
      if (f && f.key !== key) fresh.delete(i);
      else if (f) { f.base = base!; continue; }
      const s = shown.get(i);
      if (s?.key === key) { s.base = base!; continue; }   // 输入没变的块：内容就是这一份，基准跟着换
      const m = mem.get(key);
      if (m) { remember(key, m); land(i, key, m); } else probeQ.add(i);
    }
    publish(); check(); pump();
  }
  function requestCarve(): void {
    const t = token, src = inp!, key = inpKey;
    if (src.mesoEnv || src.nest) { onCarve(null); return; }   // 中尺度图（工作档细级侵蚀或嵌套解）不跑粗级
    d.client.erodeCarve(src).then(cv => {
      if (t !== token || !plan) return;
      if (!cv) { fail(); return; }
      carves.set(key, cv);
      for (const k of carves.keys()) { if (carves.size <= CARVE_KEEP) break; carves.delete(k); }
      onCarve(cv);
    }, e => { if (t === token) fail(e); });
  }

  return {
    reset() {
      token++; plan = null; inp = null; base = null; nest = null; carve = undefined; keys = null; readied = false; computed = false; frozen = false;
      shown.clear(); published.clear(); held.clear(); fresh.clear(); probeQ.clear(); probing.clear(); queue.clear(); inflight.clear();
      disp = new Map(); dispFor = new Map(); vis = new Set();
      emit(null); check();
    },
    setInput(nextInp, nextPlan, nextBase, key, nextNest) {
      token++;
      if (plan && (plan.geom.sx !== nextPlan.geom.sx || plan.geom.cols !== nextPlan.geom.cols || plan.geom.rows !== nextPlan.geom.rows)) {
        shown.clear(); published.clear(); held.clear(); fresh.clear(); disp = new Map(); dispFor = new Map(); frozen = up;   // 不当场下屏：那是一次多出来的画面变化
      }
      plan = nextPlan; inp = nextInp; base = nextBase; nest = nextNest ?? null; inpKey = key; carve = undefined; keys = null; probeQ.clear(); queue.clear();
      readied = false; computed = false;
      const inPlan = new Set(nextPlan.tiles);
      for (const i of [...shown.keys()]) if (!inPlan.has(i)) { shown.delete(i); published.delete(i); held.delete(i); fresh.delete(i); }
      if (view) vis = visibleOf(nextPlan, view);
      const cv = carves.get(key);
      if (cv) { carves.delete(key); carves.set(key, cv); onCarve(cv); return; }
      publish(); check();
      if (!dead) requestCarve();   // 等复位的那几秒不发：复位时见没有切割量会补要
    },
    commit() {
      let any = false;
      for (const [i, f] of fresh) { shown.set(i, f); any = true; }   // fresh 里只有当前键的（onCarve 清掉了换了键的）
      fresh.clear();
      /* held 里可以有上一份输入没换上的块：停摆收场时它们不是当前那份，不放 */
      for (const i of held) if (current(i)) { held.delete(i); published.add(i); any = true; }
      if (any) publish();
      if (frozen) { frozen = false; if (!published.size) emit(null); }   // 新几何一块都没有（车道停摆）：旧块层这时才下屏
    },
    setCoarse(n, g, dr, s) { now = n; grid = g; drop = dr; sf = s; publish(); },
    setView(v, degPerPx) {
      if (view && v.lonMin === view.lonMin && v.lonMax === view.lonMax && v.latMin === view.latMin && v.latMax === view.latMax && degPerPx === dpp) return;
      view = v; dpp = degPerPx;
      if (plan) vis = visibleOf(plan, v);
      check();
    }
  };
}
