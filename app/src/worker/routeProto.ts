/* 寻路 Worker 协议（纯函数）：ctx=一次性上下文（换图/重建网格/换年时重发），
   route/legs=按 id 应答。协议层不碰 Worker API——node:test 直接测；
   入口(routeWorker.ts)与客户端(routeClient.ts)只做消息搬运。 */
import { computeRoute, type ComputedRoute, type RoutePoint } from "../core/route.ts";
import { unitLegs, type Leg } from "../core/units.ts";
import type { Grid } from "../core/grid.ts";
import type { Arm, Meta, Unit, World } from "../core/types.ts";

export interface RouteCtx { meta?: Meta; grid?: Grid; roads?: Set<string>; world?: World; yearNow?: number }

export type RouteRequest =
  | { t: "ctx"; meta: Meta | undefined; grid: Grid; roads: Set<string> | string[]; world: World; yearNow: number }
  | { t: "route"; id: number; A: RoutePoint; B: RoutePoint; arm: Arm }
  | { t: "legs"; id: number; unit: Unit };

export type RouteReply =
  | { t: "route"; id: number; res: ComputedRoute | null }
  | { t: "legs"; id: number; legs: Leg[] | null };

export function handleRouteMsg(st: RouteCtx, msg: RouteRequest): RouteReply | null {
  if (msg.t === "ctx") {
    st.meta = msg.meta; st.grid = msg.grid; st.world = msg.world; st.yearNow = msg.yearNow;
    st.roads = msg.roads instanceof Set ? msg.roads : new Set(msg.roads);
    return null;
  }
  if (!st.grid || !st.world) {
    return msg.t === "route" ? { t: "route", id: msg.id, res: null } : { t: "legs", id: msg.id, legs: null };
  }
  if (msg.t === "route") {
    return { t: "route", id: msg.id, res: computeRoute(st.meta, st.grid, st.roads, st.world, st.yearNow ?? 0, msg.A, msg.B, msg.arm) };
  }
  return { t: "legs", id: msg.id, legs: unitLegs(st.meta, st.grid, st.roads, msg.unit) };
}
