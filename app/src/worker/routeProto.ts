/* 寻路 Worker 协议（纯函数）：ctx=一次性上下文（网格重建与每次编辑后重发；grid 缺席＝沿用上一份），
   route/legs=按 id 应答；erode=侵蚀重铸（自带全部输入、不依赖 ctx——纯函数直测；带 nest 的单（块单、v2 图的工作档单）走 core/nested 的嵌套解，
   且程序化预览无 world 时照样可算）；carve=只算粗级切割量（分块精修各块共用）；vfield=视线判定用的规则场（规则场落定时推送一次，
   viewshed 单只带观察者，sight 单带观察者 × 飞行目标，peaks 单算这份场的标高点峰表）；meso＝v2 图的中尺度稳态（带缓存的解就只派生），uplift＝在它上面解画抬升。
   协议层不碰 Worker API——node:test 直接测；入口(routeWorker.ts)与客户端(routeClient.ts)只做消息搬运。 */
import { computeRoute, type ComputedRoute, type RoutePoint } from "../core/route.ts";
import { unitLegs, type Leg } from "../core/units.ts";
import { erodeCarve, erodeField, type CoarseCarve, type ErodeInput } from "../core/erode.ts";
import { sightTo, viewshed, type Observer, type SightHit, type ViewField, type VisMask } from "../core/viewshed.ts";
import { peakTable, type PeakTable } from "../core/spots.ts";
import { gen2Meso, gen2Uplift, mesoKey, mesoState, riverParams, type BasinWaters, type Gen2Sg, type GenRiver, type MesoState, type UpliftCells } from "../core/gen2.ts";
import { nestBaseOf, nestedField, nestSolOf, type NestBase, type NestSol } from "../core/nested.ts";
import type { ElevField, FieldGeom } from "../core/elev.ts";
import type { Grid } from "../core/grid.ts";
import type { Arm, Meta, Unit, World } from "../core/types.ts";

export interface RouteCtx { meta?: Meta; grid?: Grid; roads?: Set<string>; world?: World; yearNow?: number; vfield?: ViewField;
  /** 中尺度车道留着的这张图的 Sg（按 mesoKey）与求解状态（中尺度单带回；只收到画抬升单时现建） */
  meso?: { key: string; sg: Gen2Sg; st?: MesoState } }

/** 一名观察者的一个圈：owner＋id 定观察者，ring＋idx 定哪个圈（idx＝火力圈下标，其余恒 0） */
export type VisRing = "vision" | "fire" | "radar";
export interface VisTag { owner: "unit" | "node"; id: string; ring: VisRing; idx: number }
export interface VisReq extends Observer, VisTag {}
export interface VisRes extends VisTag { mask: VisMask | null }
/** 一名观察者的一个圈看一个飞行目标（tgt＝部队 id，altM＝当刻海拔） */
export interface SightReq { obs: VisReq; tgt: string; lon: number; lat: number; altM: number }
/** hit null＝观察者或目标在场外（不判） */
export interface SightRes extends VisTag { tgt: string; hit: SightHit | null }

export type RouteRequest =
  | { t: "ctx"; meta: Meta | undefined; grid?: Grid; roads: Set<string> | string[]; world: World; yearNow: number }
  | { t: "route"; id: number; A: RoutePoint; B: RoutePoint; arm: Arm }
  | { t: "legs"; id: number; unit: Unit }
  | ({ t: "erode"; id: number } & ErodeInput)
  | ({ t: "carve"; id: number } & ErodeInput)
  | { t: "vfield"; field: ViewField }
  | { t: "viewshed"; id: number; obs: VisReq[] }
  | { t: "sight"; id: number; reqs: SightReq[] }
  | { t: "peaks"; id: number }
  | { t: "meso"; id: number; meta: Meta; geom: FieldGeom; sg: Gen2Sg | null }
  | { t: "uplift"; id: number; meta: Meta; geom: FieldGeom; sg: Gen2Sg | null; cells: UpliftCells };

/** 中尺度单的回执：sg 只在现算时带回（存缓存用），给了缓存的解就是 null；rivers 按单里 meta 的两个河流滑杆抽；
    nest＝块层嵌套解的静态场与这份解（缓存命中也带：host 手里那份 sg 已随单交给车道） */
export interface MesoReply { base: Float32Array; env: Float32Array; cls: Uint8Array; basin: Uint8Array | null; water: BasinWaters | null; rivers: GenRiver[]; sg: Gen2Sg | null; iters: number; converged: boolean; nest: { base: NestBase; sol: NestSol } }
/** 画抬升单的回执：收尾后的基底、包络与地类（同 Gen2MesoField）与河；nest＝这份解给嵌套解用的那部分（静态场同中尺度单） */
export interface UpliftReply { base: Float32Array; env: Float32Array; cls: Uint8Array; basin: Uint8Array | null; water: BasinWaters | null; rivers: GenRiver[]; iters: number; converged: boolean; nest: NestSol }

export type RouteReply =
  | { t: "route"; id: number; res: ComputedRoute | null }
  | { t: "legs"; id: number; legs: Leg[] | null }
  | { t: "erode"; id: number; f: ElevField }
  | { t: "carve"; id: number; carve: CoarseCarve | null }
  | { t: "viewshed"; id: number; res: VisRes[] | null }
  | { t: "sight"; id: number; res: SightRes[] | null }
  | { t: "peaks"; id: number; res: PeakTable | null }
  | ({ t: "meso"; id: number } & MesoReply)
  | ({ t: "uplift"; id: number } & UpliftReply);

export function handleRouteMsg(st: RouteCtx, msg: RouteRequest): RouteReply | null {
  if (msg.t === "ctx") {
    st.meta = msg.meta; st.world = msg.world; st.yearNow = msg.yearNow;
    if (msg.grid) st.grid = msg.grid;
    st.roads = msg.roads instanceof Set ? msg.roads : new Set(msg.roads);
    return null;
  }
  if (msg.t === "vfield") { st.vfield = msg.field; return null; }
  if (msg.t === "erode") return { t: "erode", id: msg.id, f: msg.nest ? nestedField(msg) : erodeField(msg) };
  if (msg.t === "carve") return { t: "carve", id: msg.id, carve: erodeCarve(msg) };
  if (msg.t === "viewshed") {
    const f = st.vfield;
    return { t: "viewshed", id: msg.id, res: f ? msg.obs.map(o => ({ owner: o.owner, id: o.id, ring: o.ring, idx: o.idx, mask: viewshed(f, o) })) : null };
  }
  if (msg.t === "sight") {
    const f = st.vfield;
    return { t: "sight", id: msg.id, res: f ? msg.reqs.map(({ obs: o, tgt, lon, lat, altM }) =>
      ({ owner: o.owner, id: o.id, ring: o.ring, idx: o.idx, tgt, hit: sightTo(f, o, lon, lat, altM) })) : null };
  }
  if (msg.t === "peaks") return { t: "peaks", id: msg.id, res: st.vfield ? peakTable(st.vfield) : null };
  if (msg.t === "meso") {
    const r = gen2Meso(msg.meta, msg.geom, msg.sg ?? undefined);
    st.meso = { key: mesoKey(msg.meta, msg.geom), sg: r.sg, st: r.st };   // 回执里的 sg 会被 transfer 走：现算的回一份拷贝，车道留原件
    return { t: "meso", id: msg.id, base: r.base, env: r.env, cls: r.cls, basin: r.basin, water: r.water, rivers: r.rivers, sg: msg.sg ? null : { h: r.sg.h.slice(), rcv: r.sg.rcv.slice() }, iters: r.iters, converged: r.converged,
      nest: { base: nestBaseOf(r.st), sol: nestSolOf(r.st, r.st.base, null) } };
  }
  if (msg.t === "uplift") {
    const key = mesoKey(msg.meta, msg.geom);
    if (!st.meso || st.meso.key !== key) st.meso = { key, sg: msg.sg ?? gen2Meso(msg.meta, msg.geom).sg };   // 没带也没留：现算（同一份解，只是慢）
    const m = st.meso;
    if (!m.st) m.st = mesoState(msg.meta, msg.geom, m.sg);
    const r = gen2Uplift(m.st, msg.cells, riverParams(msg.meta));
    return { t: "uplift", id: msg.id, base: r.base, env: r.env, cls: r.cls, basin: r.basin, water: r.water, rivers: r.rivers, iters: r.iters, converged: r.converged, nest: nestSolOf(m.st, r.sol, r.up) };
  }
  if (!st.grid || !st.world) {
    return msg.t === "route" ? { t: "route", id: msg.id, res: null } : { t: "legs", id: msg.id, legs: null };
  }
  if (msg.t === "route") {
    return { t: "route", id: msg.id, res: computeRoute(st.meta, st.grid, st.roads, st.world, st.yearNow ?? 0, msg.A, msg.B, msg.arm) };
  }
  return { t: "legs", id: msg.id, legs: unitLegs(st.meta, st.grid, st.roads, msg.unit) };
}
