/* A* 加权寻路与行军报告（自 v0.14 index.html 原样迁移，黄金基准平价锁定）。
   旧实现读 state.grid/state.world——这里全部显式传参：grid=buildGridCells 产物，
   roads=roadCellSet 产物（官道格 ×0.5 提速）。
   ⚠ 开集 2026-08-13 起是**保平手语义的二叉堆**：旧「Map 线性扫最小 f、平手保留先入者」的
   弹出序被 (f, 首入序) 字典序逐位复刻（证明见 astar 内注），黄金基准与随机夹具对照双锁——
   改堆序/tie-break 即改平手路径。 */
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
  /* 开集＝二叉堆＋懒删除（2026-08-13 规模引擎批）：旧实现每次弹出线性扫全 open 取最小 f
     （平手取 Map 插入序里最早者,严格小于）——4.6 万格图无感,196 万格图上长途一单分钟级。
     堆序取 **(f, 首入序) 字典序**,与旧弹出序**逐位相同**,证明：Map 迭代序=插入序,且已在集内
     的键 set() 更新值**不换位置**、弹出后再入才排队尾——故「扫描取首个严格更小者」恰=先比 f
     再比首入序;此处 seq 依同规发放（在集=保旧 seq,不在集=发新号）,字典序堆弹出即同一元。
     堆里的旧条目（同键被更新过 f）弹出时对不上 open 现值＝过期跳过,不计入 guard（guard 计的
     是与旧实现一致的**真实弹出数**）。 */
  const open = new Map<number, { r: number; c: number; f: number; seq: number }>(), came = new Map<number, number>(), gScore = new Map<number, number>();
  /* 启发式：裸大圆距离在官道 0.5× 之下会高估剩余代价（不可采纳）→ 可能绕过官道给出次优路径。
     **细网格（step<1）×0.5 恢复可采纳；1° 粗网格保持旧式**——粗网格那一支的 hK=1 明知不可采纳,
     留着纯为黄金基准（平手保留先入者=遍历顺序即语义，动了启发式即动平手路径）。
     ⚠ 判据是**格细不细**不是图种（2026-08-12 正名）：战略图开了网格密度也走 0.5 支＝拿到最优路,
     这是**有意**的（缺 gridN 的战略图 step 恒 1.0＝黄金基准原样）。 */
  const hK = grid.step < 1 ? 0.5 : 1;
  const h = (r: number, c: number) => {
    const [lo, la] = cellCenter(grid, r, c), [glo, gla] = cellCenter(grid, gr, gc);
    return distKm(meta, lo, la, glo, gla) * hK;
  };
  /* 并行数组小顶堆（f 主序、seq 次序）；hpush/hpop 是教科书二叉堆,无平衡魔法 */
  const hf: number[] = [], hs: number[] = [], hk: number[] = [];
  const less = (a: number, b: number) => hf[a] < hf[b] || (hf[a] === hf[b] && hs[a] < hs[b]);
  const hswap = (a: number, b: number) => {
    let t = hf[a]; hf[a] = hf[b]; hf[b] = t;
    t = hs[a]; hs[a] = hs[b]; hs[b] = t;
    t = hk[a]; hk[a] = hk[b]; hk[b] = t;
  };
  const hpush = (f: number, seq: number, k: number) => {
    let i = hf.length;
    hf.push(f); hs.push(seq); hk.push(k);
    while (i > 0) { const p = (i - 1) >> 1; if (less(i, p)) { hswap(i, p); i = p; } else break; }
  };
  const hpop = (): [number, number, number] => {
    const out: [number, number, number] = [hf[0], hs[0], hk[0]];
    const last = hf.length - 1;
    hswap(0, last); hf.pop(); hs.pop(); hk.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m2 = i;
      if (l < hf.length && less(l, m2)) m2 = l;
      if (r < hf.length && less(r, m2)) m2 = r;
      if (m2 === i) break;
      hswap(i, m2); i = m2;
    }
    return out;
  };
  let seqN = 0;
  gScore.set(key(sr, sc), 0); open.set(key(sr, sc), { r: sr, c: sc, f: h(sr, sc), seq: 0 });
  hpush(h(sr, sc), 0, key(sr, sc));
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
  /* guard：定数 20 万 → max(20 万, 2×格数)——20 万只覆盖 196 万格图的一成,山地长途会假报
     「不可达」（功能断裂不只是慢）;黄金域(1° 网格,6.5 万格)上限仍恰 20 万＝行为原样。
     2× 因 0.5× 启发式可采纳但不一致,格可被再松弛重弹,1× 不够。 */
  const guardMax = Math.max(200000, 2 * grid.cols * grid.rows);
  let guard = 0;
  while (hf.length) {
    const [ef, eseq, ek] = hpop();
    const cur = open.get(ek);
    if (!cur || cur.f !== ef || cur.seq !== eseq) continue;   // 过期堆条目（该键已更新/已弹出）＝跳过,不计 guard
    open.delete(ek);
    if (++guard > guardMax) break;
    if (cur.r === gr && cur.c === gc) {
      const path: LL[] = [];
      let k: number | undefined = ek;
      while (k !== undefined) { const r = Math.floor(k / grid.cols), c = k % grid.cols; path.push(cellCenter(grid, r, c)); k = came.get(k); }
      path.reverse();
      let dist = 0;
      for (let i = 1; i < path.length; i++) dist += distKm(meta, path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
      return { path, dist };
    }
    for (const [dr, dc] of dirs) {
      const nr = cur.r + dr, nc = cur.c + dc;
      if (nr < 0 || nc < 0 || nr >= grid.rows || nc >= grid.cols) continue;
      const cost = cellCost(grid, roads, nr, nc, arm);
      if (!isFinite(cost)) continue;
      const [lo1, la1] = cellCenter(grid, cur.r, cur.c), [lo2, la2] = cellCenter(grid, nr, nc);
      const step = distKm(meta, lo1, la1, lo2, la2) * ((cellCost(grid, roads, cur.r, cur.c, arm) + cost) / 2);
      const nk = key(nr, nc), tentative = gScore.get(key(cur.r, cur.c))! + step;
      if (!gScore.has(nk) || tentative < gScore.get(nk)!) {
        came.set(nk, key(cur.r, cur.c)); gScore.set(nk, tentative);
        const nf = tentative + h(nr, nc);
        const ex = open.get(nk);
        const seq = ex ? ex.seq : ++seqN;   // 在集＝保位（首入序不变,同 Map set 不换位置）;不在集（新/曾弹出）＝排队尾
        open.set(nk, { r: nr, c: nc, f: nf, seq });
        hpush(nf, seq, nk);
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
  /* 途经半径随格距：旧值 0.55 是 1° 战略格的「半格多一点」——战术细网格（井陉全宽 0.24°）
     照抄 0.55° 会把全图地点都判成途经；0.55×step 在战略 step=1 逐位等于旧值（平价锁定）。 */
  const near = 0.55 * grid.step;
  nodes.forEach(n => {
    if (endIds && endIds.has(n.id)) return;
    if (!activeAt(n, yearNow)) return;   // 途经报告只列当年存在的地点
    for (let i = 0; i < p.length; i++) {
      if (Math.abs(n.lon - p[i][0]) <= near && Math.abs(n.lat - p[i][1]) <= near) { via.push({ n, idx: i }); break; }
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
