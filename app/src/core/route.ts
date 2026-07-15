/* A* 加权寻路与行军报告（自 v0.14 index.html 原样迁移，黄金基准平价锁定）。
   旧实现读 state.grid/state.world——这里全部显式传参：grid=buildGridCells 产物，
   roads=roadCellSet 产物（官道格 ×0.5 提速）。开集用 Map 线性扫最小 f，
   平手保留先入者——遍历顺序即语义的一部分，勿"优化"成堆结构（会改变平手路径）。 */
import { terrainProps, flattenTerrain } from "./constants.ts";
import { distKm } from "./geo.ts";
import { activeAt } from "./time.ts";
import type { Grid } from "./grid.ts";
import type { Arm, Meta, World, WorldNode } from "./types.ts";

export type LL = [number, number];
export interface RouteResult { path: LL[]; dist: number }

/** 单格通行代价：水军只走 水域/沿海/沼泽（1.0）；陆军按地形，官道格减半；越界=∞。
    经 terrainProps 兼容复合地形（旧 8 类逐位精确）。 */
export function cellCost(grid: Grid, roads: Set<string> | undefined, r: number, c: number, arm: Arm): number {
  const t = grid.cells[r] && grid.cells[r][c];
  if (!t) return Infinity;
  const p = terrainProps(t);
  if (arm === "water") return p.water ? 1.0 : Infinity;
  let base = p.land;
  if (roads && roads.has(r + "," + c)) base *= 0.5;   // 官道提速
  return base;
}

export function cellCenter(grid: Grid, r: number, c: number): LL {
  return [grid.bb.lonMin + (c + 0.5) * grid.step, grid.bb.latMin + (r + 0.5) * grid.step];
}

export function lonlatToCell(grid: Grid, lon: number, lat: number): [number, number] {
  return [Math.max(0, Math.min(grid.rows - 1, Math.floor((lat - grid.bb.latMin) / grid.step))),
          Math.max(0, Math.min(grid.cols - 1, Math.floor((lon - grid.bb.lonMin) / grid.step)))];
}

/** A*：八向、代价=两格均值×大圆里程；返回途经格心折线与总里程，不可达=null */
export function astar(meta: Meta | undefined, grid: Grid, roads: Set<string> | undefined,
  startLL: LL, goalLL: LL, arm: Arm): RouteResult | null {
  const [sr, sc] = lonlatToCell(grid, startLL[0], startLL[1]);
  const [gr, gc] = lonlatToCell(grid, goalLL[0], goalLL[1]);
  const key = (r: number, c: number) => r * grid.cols + c;
  const open = new Map<number, { r: number; c: number; f: number }>(), came = new Map<number, number>(), gScore = new Map<number, number>();
  const h = (r: number, c: number) => {
    const [lo, la] = cellCenter(grid, r, c), [glo, gla] = cellCenter(grid, gr, gc);
    return distKm(meta, lo, la, glo, gla);
  };
  gScore.set(key(sr, sc), 0); open.set(key(sr, sc), { r: sr, c: sc, f: h(sr, sc) });
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
  let guard = 0;
  while (open.size) {
    if (++guard > 200000) break;
    let cur: { r: number; c: number; f: number } | null = null, ck: number | null = null;
    for (const [k, v] of open) { if (!cur || v.f < cur.f) { cur = v; ck = k; } }
    open.delete(ck!);
    if (cur!.r === gr && cur!.c === gc) {
      const path: LL[] = [];
      let k: number | undefined = ck!;
      while (k !== undefined) { const r = Math.floor(k / grid.cols), c = k % grid.cols; path.push(cellCenter(grid, r, c)); k = came.get(k); }
      path.reverse();
      let dist = 0;
      for (let i = 1; i < path.length; i++) dist += distKm(meta, path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
      return { path, dist };
    }
    for (const [dr, dc] of dirs) {
      const nr = cur!.r + dr, nc = cur!.c + dc;
      if (nr < 0 || nc < 0 || nr >= grid.rows || nc >= grid.cols) continue;
      const cost = cellCost(grid, roads, nr, nc, arm);
      if (!isFinite(cost)) continue;
      const [lo1, la1] = cellCenter(grid, cur!.r, cur!.c), [lo2, la2] = cellCenter(grid, nr, nc);
      const step = distKm(meta, lo1, la1, lo2, la2) * ((cellCost(grid, roads, cur!.r, cur!.c, arm) + cost) / 2);
      const nk = key(nr, nc), tentative = gScore.get(key(cur!.r, cur!.c))! + step;
      if (!gScore.has(nk) || tentative < gScore.get(nk)!) {
        came.set(nk, key(cur!.r, cur!.c)); gScore.set(nk, tentative);
        open.set(nk, { r: nr, c: nc, f: tentative + h(nr, nc) });
      }
    }
  }
  return null;
}

export interface RouteReport { terr: Record<string, number>; via: WorldNode[] }

/** 行军沿途报告：地形分段里程 + 途经地点（endIds=起讫点自身，不列入途经；只列当年存在的地点） */
export function routeReport(meta: Meta | undefined, grid: Grid, nodes: WorldNode[], yearNow: number,
  route: RouteResult | null, endIds?: Set<string>): RouteReport | null {
  const p = route && route.path;
  if (!p || p.length < 2) return null;
  const terr: Record<string, number> = {};
  for (let i = 1; i < p.length; i++) {
    const km = distKm(meta, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
    const [r, c] = lonlatToCell(grid, (p[i - 1][0] + p[i][0]) / 2, (p[i - 1][1] + p[i][1]) / 2);
    const t = grid.cells[r] && grid.cells[r][c];
    if (t) { const ft = flattenTerrain(t); terr[ft] = (terr[ft] || 0) + km; }   // 沿途报告按旧 8 类归并（P6 可改 terrainProps.名 显示）
  }
  const via: { n: WorldNode; idx: number }[] = [];
  nodes.forEach(n => {
    if (endIds && endIds.has(n.id)) return;
    if (!activeAt(n, yearNow)) return;   // 途经报告只列当年存在的地点
    for (let i = 0; i < p.length; i++) {
      if (Math.abs(n.lon - p[i][0]) <= 0.55 && Math.abs(n.lat - p[i][1]) <= 0.55) { via.push({ n, idx: i }); break; }
    }
  });
  via.sort((a, b) => a.idx - b.idx);
  return { terr, via: via.map(v => v.n) };
}

export interface RoutePoint { lon: number; lat: number; node?: WorldNode | null }

export interface MeasureResult { legs: { km: number }[]; total: number }

/** 量距：多点折线逐段里程 + 合计（球面=大圆/平面=直线，随 meta.worldModel） */
export function measureLegs(meta: Meta | undefined, pts: RoutePoint[]): MeasureResult {
  const legs: { km: number }[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const km = distKm(meta, pts[i - 1].lon, pts[i - 1].lat, pts[i].lon, pts[i].lat);
    legs.push({ km });
    total += km;
  }
  return { legs, total };
}
export interface ComputedRoute {
  path: LL[] | null; dist: number | null; straight: number; arm: Arm;
  report?: RouteReport | null; fail?: boolean;
}

/** 行军计算总入口（对应旧 computeRoute，纯化）：飞行=直线；陆/水军 A*，附沿途报告与迂回率素材 */
export function computeRoute(meta: Meta | undefined, grid: Grid, roads: Set<string> | undefined,
  world: World, yearNow: number, A: RoutePoint, B: RoutePoint, arm: Arm): ComputedRoute {
  if (arm === "air") {
    const dist = distKm(meta, A.lon, A.lat, B.lon, B.lat);
    return { dist, straight: dist, path: null, arm: "air" };
  }
  const res = astar(meta, grid, roads, [A.lon, A.lat], [B.lon, B.lat], arm);
  const straight = distKm(meta, A.lon, A.lat, B.lon, B.lat);
  if (res) {
    const endIds = new Set([A, B].filter(p => p.node).map(p => p.node!.id));
    return { ...res, straight, arm, report: routeReport(meta, grid, world.nodes, yearNow, res, endIds) };
  }
  return { path: null, dist: null, straight, arm, fail: true };
}
