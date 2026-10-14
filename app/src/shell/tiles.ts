/* 分块精修的编排：拿到全图工作档输入 → Worker 算一份粗级切割量（中尺度图不跑粗级、没有这一步） → 各块的键 → 内存/缓存命中直接上，其余按「视口里的先、离视心近的先」排队算。
   视口里的块齐了才一起上屏（不出现半清半糊的拼贴），视口外的随到随上；编辑后旧块照旧显示、叠上粗格增量（同工作档的等待窗合成），
   视口里换了键的块也等视口齐了才一起换（不出现新旧拼贴）。块只进画面：规则场、读数与等高线不读这里。 */
import { applyDelta, deltaOf, type CoarseDelta } from "../core/elev.ts";
import { tileCells, tileCore, tileField, tileInput, tileKey, tilesInView, tileWeight, type TileLayer, type TilePlan } from "../core/tiles.ts";
import type { CoarseCarve, ErodeInput } from "../core/erode.ts";
import type { Grid } from "../core/grid.ts";
import type { BBox } from "../core/types.ts";
import type { RouteClient } from "../worker/routeClient.ts";

export interface TileDeps {
  client: Pick<RouteClient, "erodeCarve" | "erodeTile" | "tileLanes">;
  cacheGet(key: string): Promise<Float32Array | null>;
  cachePut(key: string, data: Float32Array): void;
  /** 块层换了（null＝下屏）：host 交给渲染器、记进 ctx 并重画 */
  onLayer(layer: TileLayer | null): void;
  /** busy＝当前缩放用得上块、视口里还有块不是当前输入的那一份（没到、或换了键还没算完）；computed＝这一轮真算过（不是缓存命中）——host 据此亮「侵蚀精修中 / 已完成」 */
  onBusy(busy: boolean, computed: boolean): void;
  /** down＝车道失败、复位一次后又失败，本会话不再算块，而当前缩放用得上块、视口里有块不是当前那一份——host 据此报「精修不可用」 */
  onDown(down: boolean): void;
}
export interface TileManager {
  /** 换图、换几何、本图不再分块：全部清空、块层下屏 */
  reset(): void;
  /** 新一份全图工作档输入（同几何）：plan＝core/tiles.tilePlan 的结果，base＝这份输入出自的粗格场（增量合成的基准），key＝erodeKey(inp)（切割量按它在内存里留几份） */
  setInput(inp: ErodeInput, plan: TilePlan, base: Float32Array, key: string): void;
  /** 当前含涂改的粗格场与网格（每次重建都送）：在屏块按它补增量 */
  setCoarse(now: Float32Array, grid: Grid): void;
  /** 视口与缩放（每帧送，没变就不动） */
  setView(view: BBox, degPerPx: number): void;
}

interface Shown { key: string; raw: Float32Array; base: Float32Array }

/** 内存里留几份粗级切割量：撤销、重做回到算过的输入时免等 Worker */
const CARVE_KEEP = 4;
/** 车道失败后等多久复位一次（毫秒） */
export const TILE_RETRY_MS = 5000;

export function createTileManager(d: TileDeps, memCapBytes: number): TileManager {
  let token = 0, plan: TilePlan | null = null, inp: ErodeInput | null = null, base: Float32Array | null = null, inpKey = "";
  let carve: CoarseCarve | null | undefined, keys: Map<number, string> | null = null;   // carve：undefined＝还没到，null＝中尺度图不要
  const carves = new Map<string, CoarseCarve>();   // erodeKey → 切割量（Map 的插入序当 LRU）
  let dead = false;   // 车道失败：停发单，等复位
  let retry: "none" | "pending" | "used" = "none";   // 复位只给一次；用过之后再失败＝本会话停摆
  const mem = new Map<string, Float32Array>();   // 键 → 块心（Map 的插入序当 LRU）
  let memBytes = 0;
  const shown = new Map<number, Shown>(), published = new Set<number>(), held = new Set<number>();
  const fresh = new Map<number, Shown>();   // 视口里在屏块的新一份：视口齐了才换上
  const queue = new Set<number>(), inflight = new Map<number, string>();
  let now: Float32Array | null = null, grid: Grid | null = null;
  let view: BBox | null = null, dpp = 0, vis = new Set<number>();
  let disp = new Map<number, Float32Array>(), dispFor = new Map<number, [Float32Array, Float32Array, Float32Array]>();   // 在屏块 → (raw, base, now) 算出的显示数组
  let busy = false, computed = false, up = false, down = false;   // up＝块层在屏（下屏只在上过屏时报）
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
    const deltas = new Map<Float32Array, CoarseDelta | null>(), next = new Map<number, Float32Array>(), nextFor = new Map<number, [Float32Array, Float32Array, Float32Array]>();
    let changed = disp.size !== published.size;
    for (const i of published) {
      const s = shown.get(i)!, prev = dispFor.get(i);
      let a = disp.get(i)!;
      if (!prev || prev[0] !== s.raw || prev[1] !== s.base || prev[2] !== now) {
        a = s.raw;
        if (now && grid && s.base !== now) {
          if (!deltas.has(s.base)) deltas.set(s.base, deltaOf(s.base, now, grid));
          const dl = deltas.get(s.base);
          if (dl) a = applyDelta(tileField(plan.geom, i, s.raw), dl, now, grid, grid.cells, grid.meso ? grid.meso.basin : null).data;
        }
        if (a !== disp.get(i)) changed = true;
      }
      next.set(i, a); nextFor.set(i, [s.raw, s.base, now!]);
    }
    disp = next; dispFor = nextFor;
    if (changed) emit({ geom: plan.geom, tiles: disp });
  }
  /* 视口里的块都是当前那一份了，才把攒着的（初次到的、换了键的）一起放上屏；视口外的直接放。返回有没有放 */
  function release(): boolean {
    let any = false;
    const complete = [...vis].every(current);
    for (const [i, s] of fresh) if (complete || !vis.has(i)) { shown.set(i, s); fresh.delete(i); any = true; }
    for (const i of held) if (complete || !vis.has(i)) { held.delete(i); published.add(i); any = true; }
    return any;
  }
  function updateBusy(): void {
    const stale = weight() > 0 && [...vis].some(i => !current(i)), halted = dead && retry === "used";
    const b = stale && !halted;
    if (b !== busy) { if (!b) d.onBusy(false, computed); else d.onBusy(true, false); busy = b; if (!b) computed = false; }
    const dn = stale && halted;
    if (dn !== down) { down = dn; d.onDown(dn); }
  }
  function land(i: number, key: string, raw: Float32Array): void {
    if (!keys || keys.get(i) !== key) return;   // 计划已换：块只进内存与缓存
    const s = { key, raw, base: base! };
    if (published.has(i) && vis.has(i)) fresh.set(i, s);
    else { shown.set(i, s); if (!published.has(i)) held.add(i); }
    release(); publish(); updateBusy();
  }
  /* 失败：停发单；头一回等 TILE_RETRY_MS 复位（车道崩了 routeClient 会懒建新的），再失败就停在现有画面 */
  function fail(e?: unknown): void {
    if (dead) return;
    console.warn("分块精修失败（保持现有画面场）：", e ?? "车道没有结果");
    dead = true;
    if (retry === "none") { retry = "pending"; setTimeout(revive, TILE_RETRY_MS); }
    updateBusy();
  }
  function revive(): void {
    dead = false; retry = "used";
    if (plan && inp && carve === undefined) requestCarve(); else pump();
    updateBusy();
  }
  const center = (): [number, number] => (view ? [(view.lonMin + view.lonMax) / 2, (view.latMin + view.latMax) / 2] : [0, 0]);
  function next(): number | undefined {
    const p = plan!, g = p.geom, [cx, cy] = center();
    let best: number | undefined, bs = Infinity;
    for (const i of queue) {
      const { c0, r0, c1, r1 } = tileCells(g, i);
      const dx = g.lonMin + (c0 + c1) / 2 * g.pstep - cx, dy = g.latMin + (r0 + r1) / 2 * g.pstep - cy;
      const s = (vis.has(i) ? 0 : 1e9) + dx * dx + dy * dy;
      if (s < bs) { bs = s; best = i; }
    }
    return best;
  }
  function pump(): void {
    while (!dead && plan && inp && carve !== undefined && keys && queue.size && inflight.size < Math.max(1, d.client.tileLanes)) {
      const i = next()!, key = keys.get(i)!, t = token, p = plan, src = inp, cv = carve;
      queue.delete(i); inflight.set(i, key);
      const lost = (e?: unknown): void => { if (t === token && keys?.get(i) === key) queue.add(i); fail(e); };   // 这一块回队，复位后接着算
      void d.cacheGet(key).then(async hit => {
        if (hit) { remember(key, hit); land(i, key, hit); return; }
        const f = await d.client.erodeTile(tileInput(src, p, cv, i));
        if (!f) { lost(); return; }
        const core = tileCore(f, p, i);
        remember(key, core); d.cachePut(key, core);
        if (t === token) computed = true;
        land(i, key, core);
      }).catch(lost)
        .finally(() => { if (inflight.get(i) === key) inflight.delete(i); updateBusy(); pump(); });
    }
  }
  /* 切割量到了：先算齐全部块键（land 里判「视口齐了」要看全），再逐块认领——键没变的只换基准，内存命中的直接上，其余排队 */
  function onCarve(cv: CoarseCarve | null): void {
    const p = plan!, src = inp!;
    carve = cv; keys = new Map();
    for (const i of p.tiles) keys.set(i, tileKey(tileInput(src, p, cv, i)));
    for (const [i, key] of keys) {
      const f = fresh.get(i);
      if (f && f.key !== key) fresh.delete(i);
      else if (f) { f.base = base!; continue; }
      const s = shown.get(i);
      if (s?.key === key) { s.base = base!; continue; }   // 输入没变的块：内容就是这一份，基准跟着换
      const m = mem.get(key);
      if (m) { remember(key, m); land(i, key, m); } else queue.add(i);
    }
    release(); publish(); updateBusy(); pump();
  }
  function requestCarve(): void {
    const t = token, src = inp!, key = inpKey;
    if (src.mesoEnv) { onCarve(null); return; }
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
      token++; plan = null; inp = null; base = null; carve = undefined; keys = null;
      shown.clear(); published.clear(); held.clear(); fresh.clear(); queue.clear(); inflight.clear();
      disp = new Map(); dispFor = new Map(); vis = new Set();
      emit(null); updateBusy();
    },
    setInput(nextInp, nextPlan, nextBase, key) {
      token++;
      if (plan && (plan.geom.sx !== nextPlan.geom.sx || plan.geom.cols !== nextPlan.geom.cols || plan.geom.rows !== nextPlan.geom.rows)) {
        shown.clear(); published.clear(); held.clear(); fresh.clear(); disp = new Map(); dispFor = new Map(); emit(null);
      }
      plan = nextPlan; inp = nextInp; base = nextBase; inpKey = key; carve = undefined; keys = null; queue.clear();
      const inPlan = new Set(nextPlan.tiles);
      for (const i of [...shown.keys()]) if (!inPlan.has(i)) { shown.delete(i); published.delete(i); held.delete(i); fresh.delete(i); }
      if (view) vis = visibleOf(nextPlan, view);
      const cv = carves.get(key);
      if (cv) { carves.delete(key); carves.set(key, cv); onCarve(cv); return; }
      publish(); updateBusy();
      if (!dead) requestCarve();   // 等复位的那几秒不发：复位时见没有切割量会补要
    },
    setCoarse(n, g) { now = n; grid = g; publish(); },
    setView(v, degPerPx) {
      if (view && v.lonMin === view.lonMin && v.lonMax === view.lonMax && v.latMin === view.latMin && v.latMax === view.latMax && degPerPx === dpp) return;
      view = v; dpp = degPerPx;
      if (plan) vis = visibleOf(plan, v);
      if (release()) publish();
      updateBusy();
    }
  };
}
