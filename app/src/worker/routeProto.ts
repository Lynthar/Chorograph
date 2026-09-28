/* 寻路 Worker 协议（纯函数）：ctx=一次性上下文（换图/重建网格/换年时重发），
   route/legs=按 id 应答；erode=侵蚀重铸（自带全部输入、不依赖 ctx——纯函数直测，
   且程序化预览无 world 时照样可算）；vfield=视线判定用的规则场（规则场落定时推送一次，
   viewshed 单只带观察者，sight 单带观察者 × 飞行目标）。协议层不碰 Worker API——node:test 直接测；
   入口(routeWorker.ts)与客户端(routeClient.ts)只做消息搬运。 */
import { computeRoute, type ComputedRoute, type RoutePoint } from "../core/route.ts";
import { unitLegs, type Leg } from "../core/units.ts";
import { erodeField, type ErodeInput } from "../core/erode.ts";
import { sightTo, viewshed, type Observer, type SightHit, type ViewField, type VisMask } from "../core/viewshed.ts";
import type { ElevField } from "../core/elev.ts";
import type { Grid } from "../core/grid.ts";
import type { Arm, Meta, Unit, World } from "../core/types.ts";

export interface RouteCtx { meta?: Meta; grid?: Grid; roads?: Set<string>; world?: World; yearNow?: number; vfield?: ViewField }

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
  | { t: "ctx"; meta: Meta | undefined; grid: Grid; roads: Set<string> | string[]; world: World; yearNow: number }
  | { t: "route"; id: number; A: RoutePoint; B: RoutePoint; arm: Arm }
  /* legs 可随单带 roads（2026-08 审查批）：官道格随 nodes/edges/年份变，而 ctx 只在网格重建时
     重发——纯对象域编辑（加删路、挪地点）后按 st.roads 算就是旧路网；带上即以本单为准。 */
  | { t: "legs"; id: number; unit: Unit; roads?: Set<string> | string[] }
  | ({ t: "erode"; id: number } & ErodeInput)
  | { t: "vfield"; field: ViewField }
  | { t: "viewshed"; id: number; obs: VisReq[] }
  | { t: "sight"; id: number; reqs: SightReq[] };

export type RouteReply =
  | { t: "route"; id: number; res: ComputedRoute | null }
  | { t: "legs"; id: number; legs: Leg[] | null }
  | { t: "erode"; id: number; f: ElevField }
  | { t: "viewshed"; id: number; res: VisRes[] | null }
  | { t: "sight"; id: number; res: SightRes[] | null };

export function handleRouteMsg(st: RouteCtx, msg: RouteRequest): RouteReply | null {
  if (msg.t === "ctx") {
    st.meta = msg.meta; st.grid = msg.grid; st.world = msg.world; st.yearNow = msg.yearNow;
    st.roads = msg.roads instanceof Set ? msg.roads : new Set(msg.roads);
    return null;
  }
  if (msg.t === "vfield") { st.vfield = msg.field; return null; }
  if (msg.t === "erode") return { t: "erode", id: msg.id, f: erodeField(msg) };
  if (msg.t === "viewshed") {
    const f = st.vfield;
    return { t: "viewshed", id: msg.id, res: f ? msg.obs.map(o => ({ owner: o.owner, id: o.id, ring: o.ring, idx: o.idx, mask: viewshed(f, o) })) : null };
  }
  if (msg.t === "sight") {
    const f = st.vfield;
    return { t: "sight", id: msg.id, res: f ? msg.reqs.map(({ obs: o, tgt, lon, lat, altM }) =>
      ({ owner: o.owner, id: o.id, ring: o.ring, idx: o.idx, tgt, hit: sightTo(f, o, lon, lat, altM) })) : null };
  }
  if (!st.grid || !st.world) {
    return msg.t === "route" ? { t: "route", id: msg.id, res: null } : { t: "legs", id: msg.id, legs: null };
  }
  if (msg.t === "route") {
    return { t: "route", id: msg.id, res: computeRoute(st.meta, st.grid, st.roads, st.world, st.yearNow ?? 0, msg.A, msg.B, msg.arm) };
  }
  const roads = msg.roads != null ? (msg.roads instanceof Set ? msg.roads : new Set(msg.roads)) : st.roads;
  return { t: "legs", id: msg.id, legs: unitLegs(st.meta, st.grid, roads, msg.unit) };
}
