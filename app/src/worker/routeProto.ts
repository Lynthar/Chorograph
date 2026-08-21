/* 寻路 Worker 协议（纯函数）：ctx=一次性上下文（换图/重建网格/换年时重发），
   route/legs=按 id 应答；erode=侵蚀重铸（自带全部输入、不依赖 ctx——纯函数直测，
   且程序化预览无 world 时照样可算）。协议层不碰 Worker API——node:test 直接测；
   入口(routeWorker.ts)与客户端(routeClient.ts)只做消息搬运。 */
import { computeRoute, type ComputedRoute, type RoutePoint } from "../core/route.ts";
import { unitLegs, type Leg } from "../core/units.ts";
import { erodeField, type ErodeInput } from "../core/erode.ts";
import type { ElevField } from "../core/elev.ts";
import type { Grid } from "../core/grid.ts";
import type { Arm, Meta, Unit, World } from "../core/types.ts";

export interface RouteCtx { meta?: Meta; grid?: Grid; roads?: Set<string>; world?: World; yearNow?: number }

export type RouteRequest =
  | { t: "ctx"; meta: Meta | undefined; grid: Grid; roads: Set<string> | string[]; world: World; yearNow: number }
  | { t: "route"; id: number; A: RoutePoint; B: RoutePoint; arm: Arm }
  /* legs 可随单带 roads（2026-08 审查批）：官道格随 nodes/edges/年份变，而 ctx 只在网格重建时
     重发——纯对象域编辑（加删路、挪地点）后按 st.roads 算就是旧路网；带上即以本单为准。 */
  | { t: "legs"; id: number; unit: Unit; roads?: Set<string> | string[] }
  | ({ t: "erode"; id: number } & ErodeInput);

export type RouteReply =
  | { t: "route"; id: number; res: ComputedRoute | null }
  | { t: "legs"; id: number; legs: Leg[] | null }
  | { t: "erode"; id: number; f: ElevField };

export function handleRouteMsg(st: RouteCtx, msg: RouteRequest): RouteReply | null {
  if (msg.t === "ctx") {
    st.meta = msg.meta; st.grid = msg.grid; st.world = msg.world; st.yearNow = msg.yearNow;
    st.roads = msg.roads instanceof Set ? msg.roads : new Set(msg.roads);
    return null;
  }
  if (msg.t === "erode") return { t: "erode", id: msg.id, f: erodeField(msg) };
  if (!st.grid || !st.world) {
    return msg.t === "route" ? { t: "route", id: msg.id, res: null } : { t: "legs", id: msg.id, legs: null };
  }
  if (msg.t === "route") {
    return { t: "route", id: msg.id, res: computeRoute(st.meta, st.grid, st.roads, st.world, st.yearNow ?? 0, msg.A, msg.B, msg.arm) };
  }
  const roads = msg.roads != null ? (msg.roads instanceof Set ? msg.roads : new Set(msg.roads)) : st.roads;
  return { t: "legs", id: msg.id, legs: unitLegs(st.meta, st.grid, roads, msg.unit) };
}
