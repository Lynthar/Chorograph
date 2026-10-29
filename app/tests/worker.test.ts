/* 寻路 Worker 协议测试 + 寻路语义行为测试。
   协议是纯函数（Worker 入口/客户端只做消息搬运，浏览器截图目检）；
   语义断言防"新旧一起错"：官道减半、水军限水、可达性判定、时间轴范围。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGridCells, gridGeom, roadCellSet, type Grid } from "../src/core/grid.ts";
import { astar, cellCenter, cellCost, computeRoute, lonlatToCell, measureLegs, routeReport } from "../src/core/route.ts";
import { DEPTH_RATIO, bearingDeg, footCornersLL, setUnitPoint, unitFacingAt, unitFootKm, unitLegs, unitPos } from "../src/core/units.ts";
import { pickUnit, unitSpots } from "../src/render/units.ts";
import { project, type Camera } from "../src/core/projection.ts";
import { yearRangeOf } from "../src/core/time.ts";
import { distKm } from "../src/core/geo.ts";
import { handleRouteMsg, type RouteCtx } from "../src/worker/routeProto.ts";
import { ERODE_VER, erodeCarve, erodeField, erodeGate, erodeInput, erodeKey, erodeMode, rowFbm, ultraInput, upscaleOf, type ErodeInput } from "../src/core/erode.ts";
import { gen2Meso, gen2Uplift, mesoState, riverParams, type UpliftCells } from "../src/core/gen2.ts";
import { tileInput, tileKey, tilePlan } from "../src/core/tiles.ts";
import { fbm } from "../src/core/noise.ts";
import { baseElev, buildElevField, coarseField, elevBilinear, fieldMix, fieldPlusDelta, waterMask, waterSurface, LAND_FLOOR, SHORE_E, type ElevField } from "../src/core/elev.ts";
import { gnoise, makeRelief, mountainness, RELIEF_M } from "../src/core/relief.ts";
import type { Meta, Unit, World } from "../src/core/types.ts";

/* 全平原世界：语义可手推 */
/* 战略夹具写死 48 列＝1°/格（DEFAULT_BBOX 恰 48° 宽）：网格密度自 2026-08-12 起缺键即自动，
   而这些用例测的是寻路与腿账，不该随默认策略漂。 */
const META: Meta = { terrain: "plain", gridN: 48 };
const plainWorld = (over: Partial<World> = {}): World => ({
  meta: META, factions: [], nodes: [], edges: [], decor: [], terrainOverrides: [], units: [], ...over
});
const mkGrid = (world: World, yearNow = 3100) => {
  const grid = buildGridCells(world.meta, world.terrainOverrides, yearNow);
  return { grid, roads: roadCellSet(world.nodes, world.edges, yearNow, grid) };
};

describe("寻路（语义）", () => {
  it("水军在全平原寸步难行；陆军畅通", () => {
    const { grid, roads } = mkGrid(plainWorld());
    assert.strictEqual(astar(META, grid, roads, [100.5, 30.5], [104.5, 30.5], "water"), null);
    const land = astar(META, grid, roads, [100.5, 30.5], [104.5, 30.5], "land");
    assert.ok(land && land.dist > 0);
  });
  it("起点=终点：单点路径零里程", () => {
    const { grid, roads } = mkGrid(plainWorld());
    const r = astar(META, grid, roads, [100.5, 30.5], [100.7, 30.4], "land")!;   // 同格
    assert.strictEqual(r.path.length, 1);
    assert.strictEqual(r.dist, 0);
  });
  it("官道格代价减半", () => {
    const world = plainWorld({
      nodes: [{ id: "a", type: "city", lon: 100.5, lat: 30.5 }, { id: "b", type: "city", lon: 104.5, lat: 30.5 }],
      edges: [{ from: "a", to: "b", type: "road" }]
    });
    const { grid, roads } = mkGrid(world);
    const [r, c] = [8, 18];   // (100.5,30.5) → r=floor(30.5-22)=8, c=floor(100.5-82)=18，官道端点格
    assert.ok(roads.has(r + "," + c), "端点应是官道格");
    assert.strictEqual(cellCost(grid, roads, r, c, "land"), 0.5);
    assert.strictEqual(cellCost(grid, undefined, r, c, "land"), 1.0);
  });
  it("水道走廊：水军沿走廊可达，出走廊不可达", () => {
    const overrides = [];
    for (let lat = 25.5; lat <= 35.5; lat++) overrides.push({ lon: 100.5, lat, t: "water" as const });
    const world = plainWorld({ terrainOverrides: overrides });
    const { grid, roads } = mkGrid(world);
    const along = astar(META, grid, roads, [100.5, 25.5], [100.5, 35.5], "water");
    assert.ok(along && along.path.every(([lon]) => Math.abs(lon - 100.5) < 1e-9), "水军路径应全程贴走廊");
    assert.strictEqual(astar(META, grid, roads, [100.5, 25.5], [104.5, 30.5], "water"), null);
  });
  it("routeReport：途经地点按路线顺序，起讫与未来地点不列", () => {
    const world = plainWorld({
      nodes: [
        { id: "a", type: "city", lon: 100.5, lat: 30.5 }, { id: "b", type: "city", lon: 106.5, lat: 30.5 },
        { id: "m1", 名称: "早驿", type: "town", lon: 102.5, lat: 30.5 },
        { id: "m2", 名称: "晚驿", type: "town", lon: 105.5, lat: 30.5 },
        { id: "ghost", 名称: "未来城", type: "city", lon: 103.5, lat: 30.5, since: 3200 }
      ]
    });
    const { grid, roads } = mkGrid(world);
    const res = computeRoute(META, grid, roads, world, 3100,
      { lon: 100.5, lat: 30.5, node: world.nodes[0] }, { lon: 106.5, lat: 30.5, node: world.nodes[1] }, "land");
    assert.ok(res.report);
    assert.deepStrictEqual(res.report!.via.map(n => n.名称), ["早驿", "晚驿"]);
    assert.ok(res.report!.terr.plain > 0);
    // 球面上沿纬线折线 ≥ 大圆直线；寻路结果不可能短于直线
    assert.ok(res.dist! >= res.straight - 1e-9 && res.dist! < res.straight * 1.02, `dist=${res.dist} straight=${res.straight}`);
  });
  it("measureLegs：逐段里程与合计；平面世界勾股可手推", () => {
    const flat = { worldModel: "flat" as const, kmPerDeg: 1 };
    const r = measureLegs(flat, [{ lon: 0, lat: 0 }, { lon: 3, lat: 4 }, { lon: 3, lat: 10 }]);
    assert.strictEqual(r.legs.length, 2);
    assert.ok(Math.abs(r.legs[0].km - 5) < 1e-12);
    assert.ok(Math.abs(r.legs[1].km - 6) < 1e-12);
    assert.ok(Math.abs(r.total - 11) < 1e-12);
    assert.deepStrictEqual(measureLegs(flat, [{ lon: 0, lat: 0 }]), { legs: [], total: 0 });
  });
  it("routeReport 对空/单点路线返回 null", () => {
    const { grid } = mkGrid(plainWorld());
    assert.strictEqual(routeReport(META, grid, [], 3100, null), null);
    assert.strictEqual(routeReport(META, grid, [], 3100, { path: [[100.5, 30.5]], dist: 0 }), null);
  });
});

describe("寻路（战术尺度）", () => {
  /* 战术细网格三处尺度修正的判别测试（战略 1° 路径由 golden 平价锁定,此处专锁细网格域） */
  it("roadCellSet：战术细网格采样加密,官道格不断续", () => {
    const meta: Meta = { mapKind: "tactical", terrain: "plain", gridN: 140,   // 写死 140 列：这些用例测的是寻路与腿账，不该随密度默认值漂（2026-08-12 缺键改自动）
      bbox: { lonMin: 0, lonMax: 0.28, latMin: 0, latMax: 0.2 } };
    const world = plainWorld({ meta,
      nodes: [{ id: "a", type: "city", lon: 0.011, lat: 0.101 }, { id: "b", type: "city", lon: 0.271, lat: 0.101 }],
      edges: [{ from: "a", to: "b", type: "road" }] });
    const grid = buildGridCells(meta, [], 3100);
    assert.ok(Math.abs(grid.step - 0.002) < 1e-12, "战术步长=跨度/140");
    const roads = roadCellSet(world.nodes, world.edges, 3100, grid);
    const row = Math.floor(0.101 / grid.step);
    for (let c = Math.floor(0.011 / grid.step); c <= Math.floor(0.271 / grid.step); c++) {
      assert.ok(roads.has(row + "," + c), `沿线格 ${row},${c} 应为官道格（定数 40 段漏约 2/3）`);
    }
  });
  it("astar：战术网格启发式可采纳,官道绕行取真最优（Dijkstra 神谕比对）", () => {
    /* 手搭 30×30 细网格（step 0.01<1 触发战术分支）,官道走「凵」字绕行:
       直线全平原代价 25、绕行官道 ≈22.5——旧启发式高估剩余代价,判直线先到即返回次优 */
    const meta: Meta = { worldModel: "flat", kmPerDeg: 100 };
    const cells: string[][] = [];
    for (let r = 0; r < 30; r++) cells.push(new Array(30).fill("plain"));
    const grid = { bb: { lonMin: 0, lonMax: 0.3, latMin: 0, latMax: 0.3 }, step: 0.01, cols: 30, rows: 30, cells };
    const roads = new Set<string>();
    for (let r = 2; r <= 12; r++) { roads.add(r + ",2"); roads.add(r + ",27"); }
    for (let c = 2; c <= 27; c++) roads.add("12," + c);
    const S: [number, number] = [0.025, 0.025], G: [number, number] = [0.275, 0.025];
    // 神谕：无启发式 Dijkstra,代价公式与 astar 完全同式（两格均值×里程）
    const dij = (): number => {
      const key = (r: number, c: number) => r * 30 + c;
      const dist = new Map<number, number>([[key(2, 2), 0]]);
      const open = new Map<number, [number, number]>([[key(2, 2), [2, 2]]]);
      const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
      while (open.size) {
        let bk = -1, bd = Infinity;
        for (const [k] of open) { const d = dist.get(k)!; if (d < bd) { bd = d; bk = k; } }
        const [r, c] = open.get(bk)!; open.delete(bk);
        if (r === 2 && c === 27) return bd;
        for (const [dr, dc] of dirs) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= 30 || nc >= 30) continue;
          const [lo1, la1] = cellCenter(grid, r, c), [lo2, la2] = cellCenter(grid, nr, nc);
          const w = distKm(meta, lo1, la1, lo2, la2) * ((cellCost(grid, roads, r, c, "land") + cellCost(grid, roads, nr, nc, "land")) / 2);
          const nk = key(nr, nc), nd = bd + w;
          if (!dist.has(nk) || nd < dist.get(nk)!) { dist.set(nk, nd); open.set(nk, [nr, nc]); }
        }
      }
      return Infinity;
    };
    const best = dij();
    const r = astar(meta, grid, roads, S, G, "land")!;
    assert.ok(r, "应可达");
    /* astar.dist 是路径的真实公里数（耗时=km/速度用）,择路最优性要按「加权代价」比:
       把返回路径逐点折回格、按同一代价公式求加权代价,与神谕比对 */
    let cost = 0;
    for (let i = 1; i < r.path.length; i++) {
      const [r1, c1] = lonlatToCell(grid, r.path[i - 1][0], r.path[i - 1][1]);
      const [r2, c2] = lonlatToCell(grid, r.path[i][0], r.path[i][1]);
      cost += distKm(meta, r.path[i - 1][0], r.path[i - 1][1], r.path[i][0], r.path[i][1])
        * ((cellCost(grid, roads, r1, c1, "land") + cellCost(grid, roads, r2, c2, "land")) / 2);
    }
    assert.ok(Math.abs(cost - best) < 1e-9, `astar 应取真最优代价 ${best},实得 ${cost}（旧启发式走直线=25）`);
    const onRoad = r.path.filter(([lon, lat]) => { const [rr, cc] = lonlatToCell(grid, lon, lat); return roads.has(rr + "," + cc); }).length;
    assert.ok(onRoad > 15, `最优路应确实借道官道（路径 ${r.path.length} 点中 ${onRoad} 点在官道格）`);
  });
  it("routeReport：途经半径随格距（战术不再全图皆途经）", () => {
    const cells: string[][] = [];
    for (let r = 0; r < 30; r++) cells.push(new Array(30).fill("plain"));
    const grid = { bb: { lonMin: 0, lonMax: 0.3, latMin: 0, latMax: 0.3 }, step: 0.01, cols: 30, rows: 30, cells };
    const meta: Meta = { worldModel: "flat", kmPerDeg: 100 };
    const path: [number, number][] = [];
    for (let c = 2; c <= 27; c++) path.push([(c + 0.5) * 0.01, 0.025]);
    const nodes = [
      { id: "n1", 名称: "近驿", type: "town", lon: 0.155, lat: 0.0295 },   // 距路 0.45 格 → 途经
      { id: "n2", 名称: "远村", type: "village", lon: 0.155, lat: 0.06 }   // 距路 3.5 格 → 不途经（旧 0.55° 全图皆中）
    ];
    const rep = routeReport(meta, grid, nodes, 3100, { path, dist: 25 })!;
    assert.deepStrictEqual(rep.via.map(n => n.名称), ["近驿"]);
  });
});

describe("部队（语义）", () => {
  it("unitPos：入场前 null / 航点间插值 / 末点停驻 / until 后离场", () => {
    const u: Unit = { id: "u", kind: "inf", until: 200, track: [{ t: 100, lon: 100, lat: 30 }, { t: 110, lon: 101, lat: 31 }] };
    assert.strictEqual(unitPos(u, 99), null);
    assert.deepStrictEqual(unitPos(u, 105), { lon: 100.5, lat: 30.5, i: 0 });
    assert.deepStrictEqual(unitPos(u, 150), { lon: 101, lat: 31, i: 1 });
    assert.strictEqual(unitPos(u, 200), null);
  });
  it("setUnitPoint：同日改写、异日按日戳插入", () => {
    const u: Unit = { id: "u", kind: "inf", track: [{ t: 100, lon: 100, lat: 30 }] };
    setUnitPoint(u, 100, 105, 35);
    assert.deepStrictEqual(u.track, [{ t: 100, lon: 105, lat: 35 }]);
    setUnitPoint(u, 90, 99, 29);
    assert.deepStrictEqual(u.track.map(p => p.t), [90, 100]);
  });
  it("setUnitPoint：同日改写只动坐标——st/facing/兵力/速度/士气全保留（2026-08 审查：原先只捎 st，拖一下位置即静默抹掉存量声明）", () => {
    const u: Unit = { id: "u", kind: "inf", track: [
      { t: 100, lon: 100, lat: 30, st: "eng", facing: 45, strength: 8000, speed: 25, morale: 60 } as never] };
    setUnitPoint(u, 100, 105, 35);
    assert.deepStrictEqual(u.track, [
      { t: 100, lon: 105, lat: 35, st: "eng", facing: 45, strength: 8000, speed: 25, morale: 60 }]);
  });
  it("unitLegs：跨日=日配额旧语义；亚日按一日行军 8 小时折算（小时级不再摊薄误报）", () => {
    const world = plainWorld();
    const { grid, roads } = mkGrid(world);
    const kmPerDay = distKm(META, 100.5, 30.5, 101.5, 30.5);   // 走 1 格的里程
    const u: Unit = { id: "u", kind: "inf", speed: kmPerDay, track: [
      { t: 0, lon: 100.5, lat: 30.5 }, { t: 1, lon: 101.5, lat: 30.5 },
      { t: 1.5, lon: 102.5, lat: 30.5 }, { t: 1.7, lon: 103.5, lat: 30.5 }] };
    const legs = unitLegs(META, grid, roads, u);
    assert.strictEqual(legs[0].ok, true, "恰好等于一日配额应可达（旧语义逐位）");
    /* ⚠ 语义翻转（2026-07 战术特化 P0）：原断言「半天走一格不可达」是 24 小时摊薄的产物——
       半日窗里装得下 8 小时行军＝走完一日配额，militarily 合法；真正的不可达该由更短的窗口触发 */
    assert.strictEqual(legs[1].ok, true, "半日窗内走完一日配额（8 小时行军装得进 12 小时）");
    assert.ok(Math.abs(legs[1].need - 1 / 3) < 1e-9, "配额内耗时=纯行军时数 km/(3v)");
    assert.strictEqual(legs[2].ok, false, "0.2 日（4.8 小时）装不下 8 小时行军");
    const dup: Unit = { id: "d", kind: "inf", track: [{ t: 5, lon: 100.5, lat: 30.5 }, { t: 5, lon: 100.5, lat: 30.5 }] };
    assert.strictEqual(unitLegs(META, grid, roads, dup)[0].ok, false, "days=0 恒不可达");
  });
  it("unitLegs：亚日航段的可达按小时速率（v/8 km/时）记账", () => {
    const world = plainWorld();
    const { grid, roads } = mkGrid(world);
    const kmCell = distKm(META, 100.5, 30.5, 101.5, 30.5);
    const u: Unit = { id: "u2", kind: "inf", speed: 4 * kmCell, track: [   // 配额=4 格/日 → 1 格=2 小时行军
      { t: 0, lon: 100.5, lat: 30.5 }, { t: 0.125, lon: 101.5, lat: 30.5 }, { t: 0.1875, lon: 102.5, lat: 30.5 }] };
    const legs = unitLegs(META, grid, roads, u);
    assert.ok(Math.abs(legs[0].need - 1 / 12) < 1e-9, "1 格=四分之一配额=2 小时行军");
    assert.strictEqual(legs[0].ok, true, "3 小时窗装 2 小时行军");
    assert.strictEqual(legs[1].ok, false, "1.5 小时窗装不下 2 小时行军");
    /* 跨日超配额仍走旧公式：需日数=km/v（黄金基准 cav/navy/air 腿全在此域，平价锁定） */
    const far: Unit = { id: "far", kind: "inf", speed: kmCell, track: [
      { t: 0, lon: 100.5, lat: 30.5 }, { t: 1, lon: 102.5, lat: 30.5 }] };
    const fl = unitLegs(META, grid, roads, far);
    assert.ok(fl[0].need > 1.9 && !fl[0].ok, "两格/日于一格配额=旧公式超速");
  });
  it("unitLegs：逐腿速度取出发航点当时生效的值，未重新声明＝沿用不弹回基线", () => {
    const world = plainWorld();
    const { grid, roads } = mkGrid(world);
    const kmCell = distKm(META, 100.5, 30.5, 101.5, 30.5);
    const u: Unit = { id: "u3", kind: "linf", speed: kmCell, track: [
      { t: 0, lon: 100.5, lat: 30.5 },
      { t: 1, lon: 101.5, lat: 30.5, speed: 2 * kmCell },   // 自此腿起提速一倍（强行军）
      { t: 2, lon: 102.5, lat: 30.5 },
      { t: 3, lon: 103.5, lat: 30.5 }] };
    const legs = unitLegs(META, grid, roads, u);
    assert.ok(Math.abs(legs[0].need - 1 / 3) < 1e-9, "第一腿用部队级基线");
    assert.ok(Math.abs(legs[1].need - 1 / 6) < 1e-9, "第二腿按出发航点声明的速度记账");
    assert.ok(Math.abs(legs[2].need - 1 / 6) < 1e-9, "第三腿未重新声明＝沿用提速，不弹回基线");
    /* 旧档没有航点速度：回溯必空、恒落部队级基线＝腿账逐位不变（黄金基准据此仍成立） */
    const old: Unit = { id: "old", kind: "linf", speed: kmCell, track: u.track.map(({ t, lon, lat }) => ({ t, lon, lat })) };
    assert.deepStrictEqual(unitLegs(META, grid, roads, old).map(L => L.need), [1 / 3, 1 / 3, 1 / 3]);
  });
});

describe("部队堆叠偏移（绘制拾取同源）", () => {
  const cam: Camera = { lon0: 100, lat0: 30, degPerPx: 0.01, w: 800, h: 600, flat: false, lonShift: 0 };
  const units: Unit[] = [
    { id: "u1", kind: "inf", track: [{ t: 0, lon: 100, lat: 30 }] },
    { id: "u2", kind: "cav", track: [{ t: 0, lon: 100, lat: 30 }] },
    { id: "u3", kind: "bow", track: [{ t: 0, lon: 100.5, lat: 30 }] }
  ];
  const world = plainWorld({ units });
  it("同点第二支按数组序错开 (+7,-6)、异点不动、未入场不占位", () => {
    const sp = unitSpots(cam, META, world, 0);
    assert.strictEqual(sp.length, 3);
    const [bx, by] = project(cam, 100, 30);
    assert.deepStrictEqual([sp[0].x, sp[0].y], [bx, by], "首支在真实位置");
    assert.deepStrictEqual([sp[1].x - bx, sp[1].y - by], [7, -6], "同点第二支阶梯错开");
    const [cx2, cy2] = project(cam, 100.5, 30);
    assert.deepStrictEqual([sp[2].x, sp[2].y], [cx2, cy2], "异点不受牵连");
    const w2 = plainWorld({ units: [units[0], { id: "gone", kind: "inf", track: [] }, units[1]] });
    assert.strictEqual(unitSpots(cam, META, w2, 0).length, 2, "未入场（track 空）不入位");
  });
  it("pickUnit 拾偏移后的位置＝点你看见的那个框", () => {
    const [bx, by] = project(cam, 100, 30);
    assert.strictEqual(pickUnit(cam, META, world, 0, bx, by)!.id, "u1", "真实位＝首支");
    assert.strictEqual(pickUnit(cam, META, world, 0, bx + 7, by - 6)!.id, "u2", "偏移位＝第二支");
    assert.strictEqual(pickUnit(cam, META, world, 0, bx + 200, by), null, "远处空拾");
  });
});

describe("阵形足印与朝向（柱B）", () => {
  const kpd = 2 * Math.PI * 10000 / 360;          // META 默认星球：每纬度 km
  const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

  it("unitFootKm：无正面＝null（标准框逐位不变）；纵深缺省由正面派生", () => {
    assert.strictEqual(unitFootKm({ id: "a", kind: "inf", track: [] }), null);
    assert.strictEqual(unitFootKm({ id: "a", kind: "inf", frontKm: 0, track: [] }), null, "0 视同未设");
    assert.deepStrictEqual(unitFootKm({ id: "a", kind: "inf", frontKm: 3, track: [] }), { front: 3, depth: 3 / DEPTH_RATIO });
    assert.deepStrictEqual(unitFootKm({ id: "a", kind: "inf", frontKm: 3, depthKm: 1, track: [] }), { front: 3, depth: 1 });
  });

  it("bearingDeg：正北 0 / 正东 90 / 正南 180；经差按 cos 纬度折算；零长＝null", () => {
    near(bearingDeg(META, 100, 30, 100, 31)!, 0);
    near(bearingDeg(META, 100, 30, 101, 30)!, 90);
    near(bearingDeg(META, 100, 30, 100, 29)!, 180);
    near(bearingDeg(META, 100, 30, 99, 30)!, 270);
    assert.strictEqual(bearingDeg(META, 100, 30, 100, 30), null, "零长无方向");
    // 等经纬差的东北向：因 cos30≈0.866 压缩经距，方位角小于 45°
    const d = bearingDeg(META, 100, 30, 101, 31)!;
    assert.ok(d > 39 && d < 42, `等经纬差东北向≈${d}°（cos 折算后偏北）`);
  });

  it("unitFacingAt：显式优先 → 行进方向 → 驻止沿用上一段 → 无从可取＝正北", () => {
    const u: Unit = { id: "a", kind: "inf", track: [
      { t: 0, lon: 100, lat: 30 },                  // →正东行进
      { t: 1, lon: 101, lat: 30, facing: 200 },     // 显式朝向（自此生效）
      { t: 2, lon: 101, lat: 31 }                   // 驻止：沿用上一段（正北）
    ] };
    near(unitFacingAt(META, u, 0), 90, 1e-9);
    near(unitFacingAt(META, u, 0.5), 90, 1e-9, );
    near(unitFacingAt(META, u, 1), 200, 1e-9);
    near(unitFacingAt(META, u, 1.5), 200, 1e-9, );
    near(unitFacingAt(META, u, 9), 0, 1e-9);        // 末航点后驻止＝上一段方位（正北）
    assert.strictEqual(unitFacingAt(META, { id: "b", kind: "inf", track: [{ t: 0, lon: 100, lat: 30 }] }, 0), 0, "单点无从可取＝正北");
    assert.strictEqual(unitFacingAt(META, u, -5), 0, "未入场＝0");
    near(unitFacingAt(META, { id: "c", kind: "inf", track: [{ t: 0, lon: 100, lat: 30, facing: -90 }] }, 0), 270, 1e-9);
  });

  it("footCornersLL：朝北时前缘在北、正面沿东西；正面/纵深为真实 km", () => {
    const c = footCornersLL(META, 100, 30, 4, 1, 0);   // 正面 4km、纵深 1km、朝北
    const [fl, fr, br, bl] = c;
    assert.ok(fl[1] > bl[1], "前缘在北");
    assert.ok(fr[0] > fl[0], "前右在前左之东");
    near((fl[1] - bl[1]) * kpd, 1, 1e-6);                                  // 纵深 1km
    near((fr[0] - fl[0]) * kpd * Math.cos(30 * Math.PI / 180), 4, 1e-6);   // 正面 4km（经向折 cos）
    near((br[1] - bl[1]) * kpd, 0, 1e-9);
  });

  it("footCornersLL：朝东＝整块转 90°（前缘在东、正面沿南北），尺寸不变", () => {
    const c = footCornersLL(META, 100, 30, 4, 1, 90);
    const [fl, fr] = c;
    const cosn = Math.cos(30 * Math.PI / 180);
    // 前缘长仍是 4km（此时沿南北）
    near(Math.hypot((fr[0] - fl[0]) * kpd * cosn, (fr[1] - fl[1]) * kpd), 4, 1e-6);
    assert.ok(fl[1] > fr[1], "朝东时前左在北、前右在南");
    assert.ok(fl[0] > 100 && fr[0] > 100, "前缘整体偏东");
  });

  it("unitSpots：足印够宽才成阵位条，阵位条不吃堆叠偏移（框态照旧）", () => {
    const cam: Camera = { lon0: 100, lat0: 30, degPerPx: 0.0004, w: 800, h: 600, flat: false, lonShift: 0 };
    const bar: Unit = { id: "bar", kind: "inf", frontKm: 4, track: [{ t: 0, lon: 100, lat: 30 }] };
    const box: Unit = { id: "box", kind: "cav", track: [{ t: 0, lon: 100, lat: 30 }] };
    const sp = unitSpots(cam, META, plainWorld({ units: [bar, box] }), 0);
    assert.ok(sp[0].foot, "正面 4km 在 0.0004°/px 下远超阈值＝阵位条");
    assert.strictEqual(sp[1].foot, null, "未设正面＝标准框");
    const [bx, by] = project(cam, 100, 30);
    assert.deepStrictEqual([sp[1].x, sp[1].y], [bx, by], "阵位条不占堆叠位＝同点的框仍在真实位");
    // 缩到足印窄于阈值即回落标准框（远景逐位不变）
    const far: Camera = { ...cam, degPerPx: 0.5 };
    assert.strictEqual(unitSpots(far, META, plainWorld({ units: [bar] }), 0)[0].foot, null, "远景回落标准框");
  });

  it("pickUnit：阵位条按条内判中（条心胜过邻框边缘），条外不中", () => {
    const cam: Camera = { lon0: 100, lat0: 30, degPerPx: 0.0004, w: 800, h: 600, flat: false, lonShift: 0 };
    const bar: Unit = { id: "bar", kind: "inf", frontKm: 4, track: [{ t: 0, lon: 100, lat: 30, facing: 0 }] };
    const world2 = plainWorld({ units: [bar] });
    const [cx, cy] = project(cam, 100, 30);
    assert.strictEqual(pickUnit(cam, META, world2, 0, cx, cy)!.id, "bar", "条心命中");
    /* 2km 折像素：角点经度换算里的 cos(纬度) 与投影的 cosk 在视心处相消——屏上 km 各向同性 */
    const halfFrontPx = 2 / kpd / 0.0004;
    assert.strictEqual(pickUnit(cam, META, world2, 0, cx + halfFrontPx * 0.9, cy)!.id, "bar", "条内近前右仍命中");
    assert.strictEqual(pickUnit(cam, META, world2, 0, cx + halfFrontPx * 1.2, cy), null, "条外不中（不再是恒定 12px 框）");
  });
});

describe("时间轴范围（语义）", () => {
  it("战略：下限压到十年整-20、上限+7；出界回上限", () => {
    const w = plainWorld({ nodes: [{ id: "e", type: "event", evtype: "battle", lon: 1, lat: 2, year: 3054 }] });
    const r = yearRangeOf(w, 9999);
    assert.strictEqual(r.min, 3030);
    assert.strictEqual(r.max, 3061);
    assert.strictEqual(r.year, 3054);
  });
  it("空世界默认 3000..3100 包络", () => {
    const r = yearRangeOf(plainWorld(), 3050);
    assert.deepStrictEqual(r, { min: 2980, max: 3107, year: 3050 });
  });
  it("公元前 since 也入包络（0=前 1 年合法；原 v>0 使纯 BC 图锁死默认包络、内容拨不到）", () => {
    const w = plainWorld({ factions: [{ id: "f", since: -400 }],
      nodes: [{ id: "n", type: "city", lon: 1, lat: 2, since: 0 }] });
    const r = yearRangeOf(w, -400);
    assert.strictEqual(r.min, -420);
    assert.strictEqual(r.max, 7);
    assert.strictEqual(r.year, -400, "-400 在范围内应保持不弹回");
  });
});

describe("寻路 Worker 协议", () => {
  const world = plainWorld({
    nodes: [{ id: "a", type: "city", lon: 100.5, lat: 30.5 }, { id: "b", type: "city", lon: 104.5, lat: 30.5 }],
    edges: [{ from: "a", to: "b", type: "road" }]
  });
  const { grid, roads } = mkGrid(world);
  const ctxMsg = { t: "ctx" as const, meta: META, grid, roads, world, yearNow: 3100 };
  it("未设 ctx 的请求安全返回 null", () => {
    const st: RouteCtx = {};
    assert.deepStrictEqual(handleRouteMsg(st, { t: "route", id: 1, A: { lon: 100.5, lat: 30.5 }, B: { lon: 104.5, lat: 30.5 }, arm: "land" }),
      { t: "route", id: 1, res: null });
    assert.deepStrictEqual(handleRouteMsg(st, { t: "legs", id: 2, unit: { id: "u", kind: "inf", track: [] } }),
      { t: "legs", id: 2, legs: null });
  });
  it("ctx 后 route/legs 与直调 core 一致；roads 数组形式自动还原 Set", () => {
    const st: RouteCtx = {};
    assert.strictEqual(handleRouteMsg(st, { ...ctxMsg, roads: [...roads] }), null);
    const A = { lon: 100.5, lat: 30.5, node: world.nodes[0] }, B = { lon: 104.5, lat: 30.5, node: world.nodes[1] };
    const viaProto = handleRouteMsg(st, { t: "route", id: 7, A, B, arm: "land" });
    const direct = computeRoute(META, grid, roads, world, 3100, A, B, "land");
    assert.deepStrictEqual(viaProto, { t: "route", id: 7, res: direct });
    const u: Unit = { id: "u", kind: "cav", track: [{ t: 0, lon: 100.5, lat: 30.5 }, { t: 3, lon: 104.5, lat: 30.5 }] };
    assert.deepStrictEqual(handleRouteMsg(st, { t: "legs", id: 8, unit: u }),
      { t: "legs", id: 8, legs: unitLegs(META, grid, roads, u) });
  });
  it("不带 grid 的 ctx 沿用上一份网格，官道格与世界按本条换新", () => {
    const st: RouteCtx = {};
    handleRouteMsg(st, ctxMsg);
    const noRoad = plainWorld({ nodes: world.nodes, edges: [] });
    handleRouteMsg(st, { t: "ctx", meta: META, roads: [], world: noRoad, yearNow: 3100 });
    assert.strictEqual(st.grid, grid);
    assert.strictEqual(st.world, noRoad);
    const u: Unit = { id: "u", kind: "cav", track: [{ t: 0, lon: 100.5, lat: 30.5 }, { t: 3, lon: 104.5, lat: 30.5 }] };
    assert.deepStrictEqual(handleRouteMsg(st, { t: "legs", id: 9, unit: u }),
      { t: "legs", id: 9, legs: unitLegs(META, grid, new Set(), u) });
  });
});

describe("起伏采样（core/relief）", () => {
  it("球面图东西与南北同为真实公里（R9-#8）：54° 处梯度能量比近 1；按「经度 × 每纬度公里」取样则东西被压扁", () => {
    const kmd = 174.53, D = Math.PI / 180, h = 0.25;   // 半个中心差分步长 250 m
    const ratio = (rel: (lon: number, lat: number, m: number) => number): number => {
      let ex = 0, ny = 0;
      for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) {
        const lat = 53.4 + i * 0.02, lon = 99 + j * 0.034, dLon = h / (kmd * Math.cos(lat * D)), dLat = h / kmd;
        ex += (rel(lon + dLon, lat, 1) - rel(lon - dLon, lat, 1)) ** 2;
        ny += (rel(lon, lat + dLat, 1) - rel(lon, lat - dLat, 1)) ** 2;
      }
      return ex / ny;
    };
    const iso = ratio(makeRelief(7, 0.5, kmd, [100, 54], Infinity)), old = ratio(makeRelief(7, 0.5, kmd, null, Infinity));
    assert.ok(iso > 0.8 && iso < 1.25, `三维取样东西/南北能量比 ${iso.toFixed(2)}`);
    assert.ok(old > 2, `对照：二维按度取样在 54° 被压扁，能量比 ${old.toFixed(2)}`);
  });
  it("波长封顶（中尺度图只加两格以下的带）：封在最短带以下恒 0，封在最长带以上与不封逐位同，封在中间幅度变小、不被归一放大", () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) pts.push([100 + j * 0.031, 30 + i * 0.029]);
    const rms = (rel: (lon: number, lat: number, m: number) => number): number => Math.sqrt(pts.reduce((a, [x, y]) => a + rel(x, y, 1) ** 2, 0) / pts.length);
    const kmd = 111.19, all = makeRelief(7, 2, kmd, null, Infinity);
    assert.ok(pts.every(([x, y]) => makeRelief(7, 2, kmd, null, 1)(x, y, 1) === 0), "封在最短带以下应恒 0");
    assert.ok(pts.every(([x, y]) => makeRelief(7, 2, kmd, null, 1000)(x, y, 1) === all(x, y, 1)), "封在最长带以上应与不封逐位同");
    const mid = rms(makeRelief(7, 2, kmd, null, 20)), full = rms(all);
    assert.ok(mid > 0 && mid < 0.6 * full, `只留 20 km 以下的带，幅度 ${mid.toFixed(3)} 对不封 ${full.toFixed(3)}`);
  });
  it("梯度集避开坐标轴（R9-#14）：没有整条格边恒为 0（轴向集约 1/16 的格边是晕渲上的直缝）", () => {
    let zero = 0;
    for (let i = 0; i < 120; i++) for (let j = 0; j < 120; j++) {
      let all = true;
      for (let t = 1; t < 10 && all; t++) if (Math.abs(gnoise(i + t / 10, j, 7001)) > 1e-12) all = false;
      if (all) zero++;
    }
    assert.strictEqual(zero, 0);
  });
});

describe("侵蚀真形（core/erode）", () => {
  /* 4×4 粗格试验场：西一列水域＝侵蚀基准面，往东平原→丘陵→山地（数值取自 LANDFORM 表） */
  const mk = (hovGrid?: Float32Array): ErodeInput => {
    const cols = 4, rows = 4;
    const elevCol = [-0.35, 0.16, 0.5, 0.9];   // 山地度自基面高程来（core/relief），不再另给起伏幅列
    const elev0 = new Float32Array(rows * cols), water = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      elev0[r * cols + c] = elevCol[c]; water[r * cols + c] = c === 0 ? 1 : 0;
    }
    return { bb: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 }, step: 1, cols, rows,
      elev0, water, wsurf: new Float32Array(rows * cols), amp: 0.7, seed: 1234, kmx: 96, kmy: 111, hovGrid: hovGrid || new Float32Array(rows * cols),
      cap: 400_000, axisMax: 8, acrit: 300, bandS: 1, unitM: 2000, sphere: false };
  };
  /* 均质试验场：整幅同一基面高程——山地度自它来，故 0.9=山地档、0.16=平原档 */
  const ELEV_MTN = 0.9, ELEV_PLN = 0.16;
  const flatAt = (e: number): ErodeInput => {
    const cols = 6, rows = 6, n2 = cols * rows;
    return { bb: { lonMin: 100, lonMax: 106, latMin: 30, latMax: 36 }, step: 1, cols, rows,
      elev0: new Float32Array(n2).fill(e), water: new Uint8Array(n2), wsurf: new Float32Array(n2), amp: 0.7, seed: 1234,
      kmx: 96, kmy: 111, hovGrid: new Float32Array(n2), cap: 400_000, axisMax: 8, acrit: 300, bandS: 1, unitM: 2000, sphere: false };
  };
  const span = (f: { data: Float32Array }): number => {
    const a = Float32Array.from(f.data).sort();
    return a[Math.floor(a.length * 0.95)] - a[Math.floor(a.length * 0.05)];
  };
  it("确定性：同输入两跑逐位同输出（Worker 与主线程回退必须可互换）", () => {
    const a = erodeField(mk()), b = erodeField(mk());
    assert.deepStrictEqual(a.data, b.data);
  });
  it("细分几何：倍率按预算取、场步长=粗步长/倍率、bb 原样", () => {
    const f = erodeField(mk()), sx = upscaleOf(4, 4, 400_000, 8);
    assert.ok(sx > 1, "小网格必须真的细分");
    assert.strictEqual(f.cols, 4 * sx);
    assert.strictEqual(f.rows, 4 * sx);
    assert.strictEqual(f.step, 1 / sx);
    assert.deepStrictEqual(f.bb, mk().bb);
  });
  it("upscaleOf 预算分档（2026-08-10）：战略 40 万逐位旧值；战术 140 万下旧 140 密度顶到轴上限 8×、280 密度取 5×", () => {
    assert.strictEqual(upscaleOf(48, 32, 400_000, 8), 8, "战略小图=轴上限");
    assert.strictEqual(upscaleOf(140, 94, 400_000, 8), 5, "旧战术@旧预算＝5×（旧值锁定）");
    assert.strictEqual(upscaleOf(140, 94, 1_400_000, 8), 8, "旧战术@新预算＝轴上限 8×（1120×752，不重涂也更锐）");
    assert.strictEqual(upscaleOf(280, 188, 1_400_000, 8), 5, "280 密度@新预算＝5×（1400×940≈132 万）");
  });
  it("精修档（2026-08-11）：axisMax 16 下 240×161→16×＝3840×2576、280×188→14×；ultraInput 三键换、acrit 面积归一、数组共享引用", () => {
    assert.strictEqual(upscaleOf(240, 161, 10_500_000, 16), 16, "井陉（0.001° 地板图）→ 恰 4K 宽");
    assert.strictEqual(upscaleOf(280, 188, 10_500_000, 16), 14, "280 密度图 → 3920×2632≈1030 万");
    assert.strictEqual(upscaleOf(140, 94, 10_500_000, 16), 16, "旧 140 图轴上限 16 → 2240×1504");
    const w = mk(), u = ultraInput(w, 10_500_000)!;
    assert.ok(u, "倍率有增益＝出精修单");
    assert.strictEqual(u.cap, 10_500_000);
    assert.strictEqual(u.axisMax, 16);
    // 4×4 夹具：sxW=upscaleOf(4,4,400k,8)=8、sxU=upscaleOf(4,4,10.5M,16)=16 → acrit=300×(16/8)²=1200
    assert.strictEqual(u.acrit, 1200, "acrit 按 (sxU/sxW)² 放大＝物理集水阈值与工作档一致");
    assert.strictEqual(u.elev0, w.elev0, "数组共享引用（Worker postMessage 自会克隆）");
    assert.strictEqual(w.cap, 400_000, "原输入不被改写（纯函数）");
    /* 零增益跳过（2026-08 审查）：低内存预算在大战场上提不动倍率＝同几何白算一遍还入一条重复缓存 */
    assert.strictEqual(ultraInput({ ...w, cols: 1400, rows: 1400, cap: 1_400_000 }, 5_250_000), null,
      "sxU==sxW（大战场×低内存档均 1×）＝不发精修单");
  });
  it("细带按物理波长归一（2026-08-19，用户实报「地势定形完过一会又回到细密纹理」）：bandS 的三条约束", () => {
    /* 病：涂改细噪 λ≈5、雕体支脉 λ≈14、表面细节 λ≈3 都锚在**细格**上，精修档格更小＝物理波长
       一起缩而幅度不变 ⇒ 微坡度陡两三倍（井陉实测每公里坡度中位数 精修/工作 2.23→归一后 1.26，
       p95 仅 1.11＝宏观地貌本来就没变，变的全是细纹）。遮蔽光线步距同理（480m→170m）。 */
    const w = mk(), u = ultraInput(w, 10_500_000)!;
    const sxW = upscaleOf(w.cols, w.rows, w.cap, w.axisMax), sxU = upscaleOf(u.cols, u.rows, u.cap, u.axisMax);
    assert.ok(sxU > sxW, "前提：精修档确实更细");
    assert.ok(Math.abs(u.bandS * (u.step / sxU) - w.step / sxW) < 1e-12, "bandS×精修细格边＝工作档细格边（细带的物理波长两档一致）");
    assert.strictEqual(w.bandS, 1, "工作档恒 1——×1 是位级恒等，已验收的观感逐位不变靠这条");
    const a = erodeField(w), c = erodeField({ ...w, bandS: 2 });
    assert.notDeepStrictEqual(Array.from(c.data), Array.from(a.data), "bandS 必须真接进场里，否则这条归一是摆设");
    assert.notStrictEqual(erodeKey(u), erodeKey({ ...u, bandS: 1 }), "bandS 是内容键的一元（换了值不许命中旧缓存）");
  });
  it("水域＝基准面（远岸恒 -0.35、近岸随双线性基面但封在水面 + SHORE_E 以下，不侵蚀不加噪）；陆地不穿透类型地板与水陆判据线", () => {
    const inp = mk(), f = erodeField(inp), sx = f.cols / 4;
    const geo = { bb: inp.bb, step: 1, cols: 4, rows: 4 };
    for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) {
      const pc = Math.min(3, (c / sx) | 0), pr = Math.min(3, (r / sx) | 0), h = f.data[r * f.cols + c];
      const b = elevBilinear(inp.elev0, geo, 100 + (c + 0.5) * f.step, 30 + (r + 0.5) * f.step);
      if (pc === 0) {
        if (c + 0.5 <= sx / 2) assert.strictEqual(h, Math.fround(-0.35), "远岸水面恒定");
        else assert.ok(Math.abs(h - Math.min(b, SHORE_E)) < 1e-6, "近岸水＝双线性基面，封顶在水面（此处为海 0）+ SHORE_E");
      } else {
        /* 期望有意放宽（批6）：钳制参照系是**域扭曲+羽化后**的基面（台阶圈揉山缘），逐点双线性
           下界不再成立——改用邻域最小（±2 粗格覆盖扭曲 ≤1.8 格 + 羽化 0.6 + 双线性支撑） */
        let bm = Infinity;
        for (let rr = Math.max(0, pr - 2); rr <= Math.min(3, pr + 2); rr++)
          for (let cc = Math.max(0, pc - 2); cc <= Math.min(3, pc + 2); cc++) bm = Math.min(bm, inp.elev0[rr * 4 + cc]);
        assert.ok(h >= Math.max(-0.02, Math.min(LAND_FLOOR, bm)) - 1e-6, "陆地地板随（扭过的）基面邻域收敛，且不低于水陆判据线（此处为海 0 − 0.02）");
      }
    }
  });
  it("侵蚀真的发生：山地起伏面上至少有细格被下切（相对未侵蚀基座）", () => {
    const inp = mk(), f = erodeField(inp), sx = f.cols / 4;
    /* 神谕＝erodeField 的基座公式（基面 + 起伏），只是不跑侵蚀：山地列右半是双线性纯区，
       基面恒 0.9、山地度＝amp×mountainness(0.9)＝0.7 */
    const rel = makeRelief(inp.seed, f.step * inp.kmy, inp.kmy, null, Infinity), rU = RELIEF_M / inp.unitM;
    const m = inp.amp * mountainness(0.9);
    let carved = 0;
    for (let r = 0; r < f.rows; r++) for (let c = Math.ceil(3.5 * sx); c < f.cols; c++) {
      const lon = 100 + (c + 0.5) * f.step, lat = 30 + (r + 0.5) * f.step;
      const base = 0.9 + rel(lon, lat, m) * rU;
      if (f.data[r * f.cols + c] < base - 0.01) carved++;
    }
    assert.ok(carved > 0, "山地列须有真实下切");
  });
  it("高程涂改并入侵蚀基座：章处显著隆起、边缘羽化无整章陡坎（手雕的山吃水系，2026-08-08 改判）", () => {
    const base = erodeField(mk());
    const hg = new Float32Array(16); hg[2 * 4 + 1] = 0.5;   // 平原列 (r2,c1) 雕一格 +0.5
    const f = erodeField(mk(hg));
    const sx = f.cols / 4;
    const ri = Math.floor(2.5 * sx), ci = Math.floor(1.5 * sx);   // 章心细格
    const d = f.data[ri * f.cols + ci] - base.data[ri * f.cols + ci];
    assert.ok(d > 0.25, "章心隆起须在侵蚀与钳制后仍显著：" + d);
    let mx = 0;   // 旧「侵蚀后叠平台」语义＝章边一步 0.5 的细格陡坎；并入基座后双线性羽化+侵蚀切割
    for (let c = 0; c < f.cols - 1; c++) { const i = ri * f.cols + c; mx = Math.max(mx, Math.abs(f.data[i + 1] - f.data[i])); }
    assert.ok(mx < 0.4, "行内最大相邻差须远小于整章高度：" + mx);
  });
  it("侵蚀产出标 eroded（渲染端据此给装饰按坡门控）；粗格包装不标", () => {
    assert.strictEqual(erodeField(mk()).eroded, true);
    assert.strictEqual(coarseField(mk(), new Float32Array(16)).eroded, false);
  });
  it("山系结构随基面高程渐入（2026-09-02 起山地度由高程给）：山地档的起伏跨度远大于平原档", () => {
    const mtn = span(erodeField(flatAt(ELEV_MTN))), pln = span(erodeField(flatAt(ELEV_PLN)));
    assert.ok(mtn > pln * 3, `山地跨度须数倍于平原：${mtn} vs ${pln}`);
  });
  it("平原静场：纯平原逐格糙度近零，山地照旧带糙（起伏与细节都随山地度）", () => {
    /* 平原若留下 ±1~3m 的细带，摊在百米波长上就是 3~8° 坡，坡度型光照照章显影＝
       「几米的高度差也都显示出来」（用户实证）。山地度由基面高程给之后，平原恒 0＝场自己就是静的。 */
    const rough = (f: { data: Float32Array; cols: number; rows: number }): number => {
      const a: number[] = [];
      for (let r = 2; r < f.rows - 2; r++) for (let c = 2; c < f.cols - 2; c++) {
        const i = r * f.cols + c;
        a.push(Math.abs(f.data[i] - 0.25 * (f.data[i - 1] + f.data[i + 1] + f.data[i - f.cols] + f.data[i + f.cols])));
      }
      a.sort((x, y) => x - y);
      return a[Math.floor(a.length * 0.95)];
    };
    const pln = rough(erodeField(flatAt(ELEV_PLN))), mtn = rough(erodeField(flatAt(ELEV_MTN)));
    assert.ok(pln < 0.002, `平原逐格糙度须近零：${pln}`);
    assert.ok(mtn > pln * 3, `山地细节不吃平原带限：${mtn} vs ${pln}`);
  });
  it("rowFbm：与 core/noise.fbm 逐位同值（顺行滑动/跳档/换行/回退全形态）", () => {
    /* 提速批的行滑动 fbm 是 erode 基座/细节噪声的实际取值路径——与真源 fbm 的位级等价是
       「提速不换观感」承诺的一半（另一半是 erode 神谕哈希）。Object.is 级比较（strictEqual）。 */
    const rf = rowFbm();
    for (let r = 0; r < 5; r++) for (let cc = 0; cc < 400; cc++) {
      const x = 3.1 + cc * 0.37 + (cc % 17 === 0 ? 5.5 : 0), y = 7.9 + r * 0.83;   // 滑动+周期性跳档+换行
      assert.strictEqual(rf(x, y), fbm(x, y), `(${x},${y})`);
    }
  });
  /* 多重网格（2026-09-07）：粗级只在够大的网格上跑（任一轴 ≥24 粗格），4×4 夹具走不到——另立
     48×48 的山地台地（平原底、西一列水域），工作档 cap 让细分取 6×（288²）、粗级 72² */
  const mesa = (cap = 100_000, axisMax = 8): ErodeInput => {
    const cols = 48, rows = 48, n2 = cols * rows;
    const elev0 = new Float32Array(n2).fill(0.16), water = new Uint8Array(n2);
    for (let r = 8; r < 40; r++) for (let c = 8; c < 40; c++) elev0[r * cols + c] = 0.9;
    for (let r = 0; r < rows; r++) { water[r * cols] = 1; elev0[r * cols] = -0.35; }
    return { bb: { lonMin: 100, lonMax: 100.48, latMin: 30, latMax: 30.48 }, step: 0.01, cols, rows,
      elev0, water, wsurf: new Float32Array(n2), amp: 0.7, seed: 4321, kmx: 96, kmy: 111, hovGrid: new Float32Array(n2), cap, axisMax, acrit: 300, bandS: 1, unitM: 2000, sphere: false };
  };
  it("多重网格（2026-09-07）：粗级参与的大网格同输入逐位同输出；水域格不被切割", () => {
    const inp = mesa(), a = erodeField(inp), b = erodeField(inp);
    assert.strictEqual(a.cols, 48 * 6, "细分 6×＝粗级 72 格一轴，确已过 COARSE_MIN");
    assert.deepStrictEqual(a.data, b.data);
    for (let r = 0; r < a.rows; r++) assert.ok(a.data[r * a.cols] <= -0.06 + 1e-6, `水格 (${r},0) 应在水面天花之下`);
  });
  it("多重网格：换档不换谷网——工作档与精修档按粗格块平均后高度相关（精修只是解析得更清楚）", () => {
    const w = mesa(), u = ultraInput(w, 300_000)!;
    assert.ok(u && u.bandS > 1, "精修档倍率须高于工作档");
    const fa = erodeField(w), fb = erodeField(u);
    const avg = (f: ElevField): Float64Array => { const s = f.cols / 48, o = new Float64Array(48 * 48); for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) o[((r / s) | 0) * 48 + ((c / s) | 0)] += f.data[r * f.cols + c] / (s * s); return o; };
    const P = avg(fa), Q = avg(fb);
    let mp = 0, mq = 0; for (let i = 0; i < P.length; i++) { mp += P[i]; mq += Q[i]; } mp /= P.length; mq /= Q.length;
    let cov = 0, vp = 0, vq = 0; for (let i = 0; i < P.length; i++) { cov += (P[i] - mp) * (Q[i] - mq); vp += (P[i] - mp) ** 2; vq += (Q[i] - mq) ** 2; }
    const rho = cov / Math.sqrt(vp * vq);
    assert.ok(rho > 0.97, `粗格块平均相关 ${rho.toFixed(4)}`);
  });
  /* 细格战术图试验场：西两列水域，往东平原→丘陵→山地 */
  const ramp = (cols: number, step: number, amp: number, cap: number, hovGrid?: Float32Array): ErodeInput => {
    const rows = cols, n2 = cols * rows, elev0 = new Float32Array(n2), water = new Uint8Array(n2);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c < 2) { water[i] = 1; elev0[i] = -0.35; } else elev0[i] = c < cols / 3 ? 0.16 : c < cols * 0.62 ? 0.5 : 0.9;
    }
    return { bb: { lonMin: 8, lonMax: 8 + cols * step, latMin: 46, latMax: 46 + rows * step }, step, cols, rows,
      elev0, water, wsurf: new Float32Array(n2), amp, seed: 777, kmx: 111.19, kmy: 111.19, hovGrid: hovGrid || new Float32Array(n2), cap, axisMax: 8, acrit: 300, bandS: 1, unitM: 2000, sphere: false };
  };
  const fieldHash = (f: ElevField): string => {
    let x = 0x811c9dc5 | 0;
    const u = new Uint32Array(f.data.buffer, f.data.byteOffset, f.data.length);
    for (let i = 0; i < u.length; i++) x = Math.imul(x ^ u[i], 16777619);
    return (x >>> 0).toString(36);
  };
  it("粗级物理扩散只给类型路：起伏滑杆 0 的图（真高程、纯手雕）输出逐位钉死", () => {
    const hov = new Float32Array(24 * 24);
    for (let r = 6; r < 18; r++) for (let c = 6; c < 18; c++) hov[r * 24 + c] = 0.2 + 0.03 * ((r * 7 + c * 3) % 5);
    /* 钉的是现行实现的输出：变了＝真高程与手雕图的地形跟着变了（起伏或侵蚀有意换代时才重钉） */
    assert.strictEqual(fieldHash(erodeField(ramp(24, 0.0024, 0, 40_000, hov))), "1tjz9lt");
  });
  it("粗级物理扩散以旧常数为地板：粗格大于约 224 m 的图输出逐位钉死", () => {
    /* 133 m 格 ×8 细分再 ×4 成粗格≈0.8 km＞交界；缺省尺寸以上的战术图与战略图都在这一侧 */
    assert.strictEqual(fieldHash(erodeField(ramp(24, 0.0072, 0.7, 40_000))), "4sbbam");
  });
  it("同一世界换细格分辨率（33 m / 17 m），谷网一致：粗级扩散按 km² 计", () => {
    /* 按格无量纲的扩散让谷距跟着网格走（约 5 个粗格一条谷），两档高通相关只有 0.74 */
    const lo = ramp(48, 0.0012, 0.7, 40_000), hi = ramp(48, 0.0012, 0.7, 150_000);
    const fl = erodeField(lo), fh = erodeField(hi);
    assert.deepStrictEqual([fl.cols / 48, fh.cols / 48], [4, 8], "前提：两档细分确为 4× 与 8×");
    const N = 96, R = 0.003, bb = lo.bb;
    const x0 = bb.lonMin + 3 * lo.step, x1 = bb.lonMax - 0.5 * lo.step, y0 = bb.latMin + 0.5 * lo.step, y1 = bb.latMax - 0.5 * lo.step;
    const hp = (f: ElevField): Float64Array => {
      const o = new Float64Array(N * N), at = (x: number, y: number): number => elevBilinear(f.data, f, x, y);
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        const x = x0 + (c + 0.5) * (x1 - x0) / N, y = y0 + (r + 0.5) * (y1 - y0) / N;
        let s = 0;
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) s += at(x + a * R, y + b * R);
        o[r * N + c] = at(x, y) - s / 9;
      }
      return o;
    };
    const P = hp(fl), Q = hp(fh);
    let mp = 0, mq = 0; for (let i = 0; i < P.length; i++) { mp += P[i]; mq += Q[i]; } mp /= P.length; mq /= Q.length;
    let cov = 0, vp = 0, vq = 0; for (let i = 0; i < P.length; i++) { cov += (P[i] - mp) * (Q[i] - mq); vp += (P[i] - mp) ** 2; vq += (Q[i] - mq) ** 2; }
    const rho = cov / Math.sqrt(vp * vq);
    assert.ok(rho > 0.85, `两档高通相关 ${rho.toFixed(3)}`);
  });
  /* 粗格图上的高程涂改：64×64 父格（0.06°≈6.7 km）、平原底、西一列水域，cap 把细分压到 2×＝粗格约 12 km、32 粗格一轴，
     粗级扩散按格（σ≈15 km）——窄雕刻的病只在这一档出现，细分 8× 的同图是对照。盘与环都以 (32,32) 为心 */
  const N4 = 64;
  const plainland = (sx: number, hov?: Float32Array): ErodeInput => {
    const n2 = N4 * N4, elev0 = new Float32Array(n2).fill(0.16), water = new Uint8Array(n2);
    for (let r = 0; r < N4; r++) { water[r * N4] = 1; elev0[r * N4] = -0.35; }
    return { bb: { lonMin: 100, lonMax: 100 + N4 * 0.06, latMin: 30, latMax: 30 + N4 * 0.06 }, step: 0.06, cols: N4, rows: N4,
      elev0, water, wsurf: new Float32Array(n2), amp: 0.7, seed: 4242, kmx: 96.3, kmy: 111.19, hovGrid: hov || new Float32Array(n2),
      cap: n2 * sx * sx, axisMax: 8, acrit: 300, bandS: 1, unitM: 2000, sphere: false };
  };
  const carve = (inside: (d2: number) => boolean, v: number): Float32Array => {
    const g = new Float32Array(N4 * N4);
    for (let r = 0; r < N4; r++) for (let c = 0; c < N4; c++) if (inside((r - 32) * (r - 32) + (c - 32) * (c - 32))) g[r * N4 + c] = v;
    return g;
  };
  const disc3 = carve(d2 => d2 <= 9.5, 1), ring68 = carve(d2 => d2 >= 35.5 && d2 <= 64.5, 1.5);
  /** 距盘心 rad 父格以内细格的增量均值（单点会落在起伏纹理的谷里） */
  const meanIn = (f: ElevField, f0: ElevField, rad: number): number => {
    const sx = f.cols / N4; let s = 0, k = 0;
    for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) {
      const y = (r + 0.5) / sx - 32.5, x = (c + 0.5) / sx - 32.5;
      if (x * x + y * y <= rad * rad) { s += f.data[r * f.cols + c] - f0.data[r * f.cols + c]; k++; }
    }
    return s / k;
  };
  const at32 = (f: ElevField, dr: number, dc: number): number => elevBilinear(f.data, f, 100 + (32.5 + dc) * 0.06, 30 + (32.5 + dr) * 0.06);
  it("粗格图上 47 km 宽的平顶雕刻保留八成以上、盘心不低于盘内一圈：粗级扩散对涂改只磨到 σ≤4 km", () => {
    const f0 = erodeField(plainland(2)), fd = erodeField(plainland(2, disc3));
    assert.strictEqual(fd.cols, N4 * 2, "前提：细分 2×、粗级在跑");
    const inner = meanIn(fd, f0, 2);
    assert.ok(inner >= 0.8, `盘内两格以内保留 ${inner.toFixed(3)}（不封顶时只剩约一半、体积推到外圈）`);
    let ring = 0;
    for (let k = 0; k < 24; k++) ring += (at32(fd, 2 * Math.sin(k * Math.PI / 12), 2 * Math.cos(k * Math.PI / 12)) - at32(f0, 2 * Math.sin(k * Math.PI / 12), 2 * Math.cos(k * Math.PI / 12))) / 24;
    assert.ok(meanIn(fd, f0, 1) >= ring, `盘心 ${meanIn(fd, f0, 1).toFixed(3)} 低于两格处一圈 ${ring.toFixed(3)}＝平顶成了碟`);
  });
  it("同一雕刻在细分 2× 与 8× 上保留率差不过 0.1（雕刻的磨平按公里，不随粗格边涨）", () => {
    const a = meanIn(erodeField(plainland(2, disc3)), erodeField(plainland(2)), 2);
    const b = meanIn(erodeField(plainland(8, disc3)), erodeField(plainland(8)), 2);
    assert.ok(Math.abs(a - b) <= 0.1, `2× ${a.toFixed(3)} vs 8× ${b.toFixed(3)}`);
  });
  it("涂改围出的闭合盆不被填洼抬成盆沿高的平台（粗细两级）", () => {
    for (const sx of [2, 8]) {
      const d = at32(erodeField(plainland(sx, ring68)), 0, 0) - at32(erodeField(plainland(sx)), 0, 0);
      assert.ok(d < 0.15, `${sx}× 盆心被抬 ${d.toFixed(3)}（环高 1.5）`);
    }
  });
  it("没有高程涂改的粗格图输出逐位钉死：涂改的磨平封顶与盆的不填平都不碰生成地形", () => {
    assert.strictEqual(fieldHash(erodeField(plainland(2))), "ziqki8");
  });
  /* 粗格图上的地貌涂改：真路径（buildGridCells → erodeInput）。64×64 父格 0.08°（约 14 km）平原图，缺省 cap 细分 8×、粗格约 6.4 km（λ≈0.7），
     cap 压到 2× 时粗格约 26 km（λ≈0.98）——地貌笔涂的山在后一档上被粗级扩散削掉一半。图形都以 (32,32) 为心 */
  const LF_N = 64, LF_S = 0.08;
  const lfMeta: Meta = { terrain: "plain", relief: 0.7, gridN: LF_N, bbox: { lonMin: 100, lonMax: 100 + LF_N * LF_S, latMin: 30, latMax: 30 + LF_N * LF_S } };
  const lfPaint = (inside: (d2: number) => boolean, t: string, m: Meta = lfMeta, s = LF_S) => {
    const o = [], bb = m.bbox!;
    for (let r = 0; r < LF_N; r++) for (let c = 0; c < LF_N; c++)
      if (inside((r - 32) * (r - 32) + (c - 32) * (c - 32))) o.push({ lon: bb.lonMin + (c + 0.5) * s, lat: bb.latMin + (r + 0.5) * s, t, step: s });
    return o;
  };
  const lfInput = (sx: number, ov: ReturnType<typeof lfPaint>): ErodeInput => ({ ...erodeInput(lfMeta, [], buildGridCells(lfMeta, ov, 0), 0)!, cap: LF_N * LF_N * sx * sx });
  const lfMean = (f: ElevField, f0: ElevField, rad: number): number => {
    const sx = f.cols / LF_N; let s = 0, k = 0;
    for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) {
      const y = (r + 0.5) / sx - 32.5, x = (c + 0.5) / sx - 32.5;
      if (x * x + y * y <= rad * rad) { s += f.data[r * f.cols + c] - f0.data[r * f.cols + c]; k++; }
    }
    return s / k;
  };
  const lfAt = (f: ElevField, dc: number): number => elevBilinear(f.data, f, 100 + (32.5 + dc) * LF_S, 30 + 32.5 * LF_S);
  const lfDisc = lfPaint(d2 => d2 <= 9.5, "mountain"), lfRing = lfPaint(d2 => d2 >= 35.5 && d2 <= 64.5, "alpine");
  it("erodeInput 只在粗级 λ>0 的图上挂地貌涂改增量：陆格＝带与不带涂改的基底之差、水格 0；没改地类、战术图与细格图都不挂", () => {
    const ov = [...lfDisc, ...lfPaint(d2 => d2 >= 200 && d2 <= 230, "water")];
    const g1 = buildGridCells(lfMeta, ov, 0), g0 = buildGridCells(lfMeta, [], 0), d = erodeInput(lfMeta, [], g1, 0)!.lfDelta!;
    const b1 = baseElev(lfMeta, g1), b0 = baseElev(lfMeta, g0), w = waterMask(g1);
    assert.ok(d && d.length === LF_N * LF_N && w.includes(1), "前提：挂上了、画了水");
    for (let i = 0; i < d.length; i++) assert.strictEqual(d[i], w[i] ? 0 : Math.fround(b1[i] - b0[i]), `格 ${i}`);
    assert.strictEqual(erodeInput(lfMeta, [], g0, 0)!.lfDelta, undefined, "没涂");
    assert.strictEqual(erodeInput(lfMeta, [], buildGridCells(lfMeta, lfPaint(d2 => d2 <= 9.5, "plain"), 0), 0)!.lfDelta, undefined, "涂成原地类");
    for (const m of [{ ...lfMeta, mapKind: "tactical" as const, bbox: { lonMin: 100, lonMax: 100.64, latMin: 30, latMax: 30.64 } },
      { ...lfMeta, bbox: { lonMin: 100, lonMax: 101.28, latMin: 30, latMax: 31.28 } }]) {
      const s = (m.bbox.lonMax - m.bbox.lonMin) / LF_N, g = buildGridCells(m, lfPaint(d2 => d2 <= 9.5, "mountain", m, s), 0);
      assert.ok(erodeInput(m, [], g, 0)!.elev0.some(v => v > 0.5), "前提：涂上了");
      assert.strictEqual(erodeInput(m, [], g, 0)!.lfDelta, undefined, `粗格 ≤ 约 3.33 km（${m.mapKind || "战略"}）：输入与改动前逐位同`);
    }
  });
  it("粗格图上地貌笔涂的山：盘内两格保留 ≥ 0.8（不挂增量时约一半），2× 与 8× 差不过 0.1，粗级不往山脚推体积", () => {
    const D = 0.9 - 0.16, keep: number[] = [];
    for (const sx of [2, 8]) {
      const f0 = erodeField(lfInput(sx, [])), inp = lfInput(sx, lfDisc);
      keep.push(lfMean(erodeField(inp), f0, 2) / D);
      if (sx !== 2) continue;
      assert.ok(lfMean(erodeField({ ...inp, lfDelta: undefined }), f0, 2) / D < 0.6, "对照：不挂增量时削掉近一半");
      /* 增量与类型基面要在同一个扭曲落点取样：错开时参照面的台阶不在山的台阶上，扩散沿错位处来回搬土（实测沉积约 0.4 × D） */
      const dep = Math.max(...erodeCarve(inp)!.data);
      assert.ok(dep < 0.1 * D, `粗级切割量的沉积最大 ${dep.toFixed(3)}（不挂增量时约 0.14，推成山脚裙带）`);
    }
    assert.ok(keep[0] >= 0.8, `2× 保留 ${keep[0].toFixed(3)}`);
    assert.ok(Math.abs(keep[0] - keep[1]) <= 0.1, `2× ${keep[0].toFixed(3)} vs 8× ${keep[1].toFixed(3)}`);
  });
  it("地貌笔围出的盆不被填平：高原里挖的平原、环山的盆心（粗细两级）", () => {
    const plateau = lfPaint(d2 => d2 <= 150, "mountain"), hole = [...plateau, ...lfPaint(d2 => d2 <= 9.5, "plain")];
    for (const sx of [2, 8]) {
      const dig = lfAt(erodeField(lfInput(sx, plateau)), 0) - lfAt(erodeField(lfInput(sx, hole)), 0);
      assert.ok(dig >= 0.8 * (0.9 - 0.16), `${sx}× 洞心只比高原低 ${dig.toFixed(3)}（填平时约两成）`);
      const lift = lfAt(erodeField(lfInput(sx, lfRing)), 0) - lfAt(erodeField(lfInput(sx, [])), 0);
      assert.ok(lift < 0.1 * (1.5 - 0.16), `${sx}× 盆心被抬 ${lift.toFixed(3)}`);
    }
  });
  it("地貌涂改增量只在有它时进键、一格之差即换键", () => {
    const inp = erodeInput(lfMeta, [], buildGridCells(lfMeta, lfDisc, 0), 0)!, k = erodeKey(inp);
    assert.notStrictEqual(erodeKey({ ...inp, lfDelta: undefined }), k);
    const d = inp.lfDelta!.slice(), i = d.findIndex(v => v > 0.3); d[i] -= 0.001;
    assert.notStrictEqual(erodeKey({ ...inp, lfDelta: d }), k, "增量变了键必须变");
  });
  it("erodeKey：同输入同键、键带算法代前缀；任一分量（单个格值/种子/幅度/bb/量纲）变即换键", () => {
    /* 键是场缓存（data/fieldcache）的全部正确性来源：漏进键的分量变了而键没变＝按键取回
       一整幅错误地形。逐分量各变一处，键必须跟着变。 */
    const k0 = erodeKey(mk());
    assert.strictEqual(erodeKey(mk()), k0, "同输入两算必同键");
    assert.ok(k0.startsWith(ERODE_VER + "-"), "键前缀＝算法代号（换代清场的判据）");
    /* 键的数学钉死：字序、双流常数、长度前缀任一变＝用户整库场缓存作废，只有有意改键（如输入加字段）才更新此值。
       旋钮或 EALGO 变了前缀自然变，此处只钉前缀之后的两段。 */
    assert.strictEqual(k0.slice(ERODE_VER.length), "-n6kpb0-lzg4pl", "内容键逐位同");
    const vary: [string, (i: ErodeInput) => void][] = [
      ["elev0 单格", i => { i.elev0[7] += 0.001; }],
      ["unitM", i => { i.unitM = 1000; }],
      ["water 单格", i => { i.water[5] = 1 - i.water[5]; }],
      ["hovGrid 单格", i => { i.hovGrid[2] = 0.25; }],
      ["seed", i => { i.seed = 4321; }],
      ["amp", i => { i.amp = 0.69; }],
      ["bb", i => { i.bb = { ...i.bb, lonMax: 104.001 }; }],
      ["kmx", i => { i.kmx = 97; }],
      ["step", i => { i.step = 0.5; }],
      ["cap", i => { i.cap = 1_400_000; }],   // 预算分档：同几何不同预算＝不同细分＝必须不同键
      ["axisMax", i => { i.axisMax = 16; }],  // 精修档三键同理（漏键＝按键取回错档分辨率的场）
      ["acrit", i => { i.acrit = 1200; }],
      ["wsurf 单格", i => { i.wsurf[3] = 0.16; }],
    ];
    for (const [what, v] of vary) {
      const i = mk(); v(i);
      assert.notStrictEqual(erodeKey(i), k0, `${what} 变了键必须变`);
    }
  });
  it("内陆湖岸线：侵蚀后每个细格在渲染判据（高程 < 所在格水面 − 0.02 即水）下与地貌一致", () => {
    /* 基准面若取湖床，岸边陆地被刻到湖面以下显示成水、近岸水格被双线性抬成陆——岸边一圈细水道夹细陆地 */
    const meta: Meta = { mapKind: "tactical", terrain: "plain", relief: 0.7, gridN: 20, bbox: { lonMin: 8.27, lonMax: 8.29, latMin: 46.82, latMax: 46.84 } };
    const probe = buildGridCells(meta, [], 0), st = probe.step, mid = probe.cols / 2;
    const ov = [];
    for (let r = 0; r < probe.rows; r++) for (let c = 0; c < probe.cols; c++) {
      const d = Math.hypot(r + 0.5 - mid, c + 0.5 - mid), t = d < mid * 0.45 ? "water" : d < mid * 0.85 ? "hill" : null;
      if (t) ov.push({ lon: 8.27 + (c + 0.5) * st, lat: 46.82 + (r + 0.5) * st, t, step: st });
    }
    const grid = buildGridCells(meta, ov, 0), ws = waterSurface(meta, grid);
    const inp = erodeInput(meta, [], grid, 0)!, f = erodeField(inp), sx = f.cols / grid.cols;
    assert.ok(sx > 1 && Math.max(...ws) > 0.1, "前提：细分过、湖在海平面之上");
    let bad = 0;
    for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) {
      const p = Math.min(grid.rows - 1, (r / sx) | 0) * grid.cols + Math.min(grid.cols - 1, (c / sx) | 0);
      if ((f.data[r * f.cols + c] < ws[p] - 0.02) !== (inp.water[p] === 1)) bad++;
    }
    assert.strictEqual(bad, 0, "错判的细格数");
  });
  it("协议：erode 消息不依赖 ctx，未设上下文照样应答且与直调一致", () => {
    const inp = mk();
    assert.deepStrictEqual(handleRouteMsg({}, { t: "erode", id: 9, ...inp }),
      { t: "erode", id: 9, f: erodeField(inp) });
  });
  it("erodeInput 门与栅格：「relief=0 且无涂改」＝null 旧路径；有涂改即侵蚀且按格累加（期望有意翻转）", () => {
    const { grid } = mkGrid(plainWorld());
    assert.strictEqual(erodeInput({ terrain: "plain" }, [], grid, 3100), null, "全关＝旧粗格路径逐位契约");
    // 2026-08-08 改判：此前 relief=0 一刀切走旧路径（含 hov-only），手雕战术图全渲成糊边方块——涂改即侵蚀
    const inp = erodeInput({ terrain: "plain" }, [{ lon: 100.2, lat: 30.7, dh: 0.2 }, { lon: 100.2, lat: 30.7, dh: 0.1 }], grid, 3100);
    assert.ok(inp, "有高程涂改即侵蚀（relief 缺省也走）");
    assert.strictEqual(inp!.cols, grid.cols);
    const c = Math.floor((100.2 - grid.bb.lonMin) / grid.step), r = Math.floor((30.7 - grid.bb.latMin) / grid.step);
    assert.ok(Math.abs(inp!.hovGrid[r * grid.cols + c] - 0.3) < 1e-6, "同格两章累加＝buildElevField 同几何");
    let sum = 0; for (const v of inp!.hovGrid) sum += v;
    assert.ok(Math.abs(sum - 0.3) < 1e-6, "只落这一格");
    const inp2 = erodeInput({ terrain: "plain", relief: 0.5 }, undefined, grid, 3100);
    assert.ok(inp2 && inp2.hovGrid.every(v => v === 0), "relief>0 无涂改＝零栅格照样侵蚀");
    assert.strictEqual(inp2!.cap, 2_400_000, "战略图预算（2026-09-02：区域图吃到轴上限，大陆级图归静置精修）");
    assert.strictEqual(inp2!.axisMax, 8, "工作档轴上限 8");
    assert.strictEqual(inp2!.acrit, 300, "工作档河道阈值＝旧常量逐位");
    const tacGrid = { ...grid, step: 0.01 };
    const inp3 = erodeInput({ terrain: "plain", relief: 0.5, mapKind: "tactical" }, undefined, tacGrid, 3100);
    assert.strictEqual(inp3!.cap, 1_500_000, "战术图＝150 万预算（分档随 mapKind；缺省 60 km 战场 600²×4 恰在其内）");
    assert.strictEqual(upscaleOf(600, 600, inp3!.cap, 8), 2, "缺省 60 km 战场工作档拿到 2×（2026-09-02：140 万时恰差 2.8% 落到 1×）");
  });
  it("erodeInput（2026-09-02）：基准面掩码只认地貌 water——沿海/沼泽是陆地；elev0＝连续基底；unitM 入键", () => {
    const { grid } = mkGrid(plainWorld({ terrainOverrides: [{ lon: 100.2, lat: 30.7, t: "coast" }, { lon: 101.7, lat: 30.7, t: "plain/marsh" }, { lon: 103.2, lat: 30.7, t: "water" }] }));
    const meta = { terrain: "plain" as const, relief: 0.5 };
    const inp = erodeInput(meta, undefined, grid, 3100)!;
    const at = (lon: number, lat: number) => Math.floor((lat - grid.bb.latMin) / grid.step) * grid.cols + Math.floor((lon - grid.bb.lonMin) / grid.step);
    assert.strictEqual(inp.water[at(100.2, 30.7)], 0, "沿海不是基准面（要起伏也要被侵蚀）");
    assert.strictEqual(inp.water[at(101.7, 30.7)], 0, "沼泽不是基准面");
    assert.strictEqual(inp.water[at(103.2, 30.7)], 1, "水域是基准面");
    assert.deepStrictEqual(inp.elev0, baseElev(meta, grid), "基础高程＝连续基底（含模糊）");
    assert.strictEqual(inp.unitM, 2000);
    assert.notStrictEqual(erodeKey(inp), erodeKey({ ...inp, unitM: 1000 }), "unitM 是内容键的一元");
  });
  it("侵蚀计算档（meta.erode）：缺键与非法值＝底图与涂改；关闭＝门关、输入 null（与 gate 同判）；仅底图由 host 传空涂改组装", () => {
    const { grid } = mkGrid(plainWorld());
    assert.strictEqual(erodeMode(undefined), "all"); assert.strictEqual(erodeMode({}), "all");
    assert.strictEqual(erodeMode({ erode: "base" }), "base"); assert.strictEqual(erodeMode({ erode: "none" }), "none");
    assert.strictEqual(erodeMode({ erode: "toString" } as never), "all", "非法值（含原型键）按缺省");
    const hov = [{ lon: 100.2, lat: 30.7, dh: 0.2 }];
    assert.strictEqual(erodeGate({ terrain: "plain", relief: 0.5, erode: "none" }, hov, grid, 3100), false, "关闭：relief 与涂改都不开门");
    assert.strictEqual(erodeInput({ terrain: "plain", relief: 0.5, erode: "none" }, hov, grid, 3100), null);
    assert.ok(erodeInput({ terrain: "plain", relief: 0.5, erode: "base" }, undefined, grid, 3100)!.hovGrid.every(v => v === 0), "仅底图：host 传空涂改＝零栅格");
    assert.strictEqual(erodeGate({ terrain: "plain", erode: "base" }, undefined, grid, 3100), false, "仅底图且 relief=0＝无侵蚀（涂改不参与）");
  });
  it("erodeGate 与 erodeInput 逐位同判（2026-08-13 延迟组装批:门在 rebuild 同拍、数组在结算拍,判据不许漂）", () => {
    const { grid } = mkGrid(plainWorld());
    const cases: [Record<string, unknown>, { lon: number; lat: number; dh?: number; step?: number; until?: number }[] | undefined][] = [
      [{ terrain: "plain" }, []],
      [{ terrain: "plain" }, undefined],
      [{ terrain: "plain", relief: 0.5 }, undefined],
      [{ terrain: "plain" }, [{ lon: 100.2, lat: 30.7, dh: 0.2 }]],
      [{ terrain: "plain" }, [{ lon: 100.2, lat: 30.7, dh: 0 }]],                     // dh=0＝无效章
      [{ terrain: "plain" }, [{ lon: 100.2, lat: 30.7, dh: 0.2, until: 3050 }]],      // 当刻失效
      [{ terrain: "plain" }, [{ lon: 500, lat: 90, dh: 0.2 }]],                       // 落不进图幅
      [{ terrain: "plain" }, [{ lon: 500, lat: 90, dh: 0.2, step: 3 }]],              // 粗块也在幅外
      [{ terrain: "plain" }, [{ lon: 100.1, lat: 30.5, dh: 0.2, step: 2 }]],          // 粗块与网格相交
      [{ terrain: "plain", relief: 0 }, [{ lon: 100.2, lat: 30.7, dh: -0.1 }]]
    ];
    for (const [meta, hov] of cases) {
      const g = erodeGate(meta as never, hov as never, grid, 3100);
      const i = erodeInput(meta as never, hov as never, grid, 3100);
      assert.strictEqual(g, i !== null, `gate 与 input 判据漂了：${JSON.stringify([meta, hov])}`);
    }
  });
  it("四个盖章消费者覆盖同一格集：类型格改动 = 高程场增量非零 = 侵蚀输入 hovGrid 非零（stampRect 单一真源）", () => {
    const lcg = (s: number) => () => (s = (s * 48271) % 2147483647) / 2147483647;
    const rnd = lcg(20260914);
    const { grid } = mkGrid(plainWorld());
    const { bb, step, cols, rows } = grid;
    /* 随机章：一半单格（缺 step）、一半粗块（1～4 格边、块心压在格线上），含落在图幅外与贴边的 */
    const stamps = Array.from({ length: 60 }, () => {
      const lon = bb.lonMin - 2 + rnd() * (bb.lonMax - bb.lonMin + 4), lat = bb.latMin - 2 + rnd() * (bb.latMax - bb.latMin + 4);
      return rnd() < 0.5 ? { lon, lat } : { lon: bb.lonMin + Math.round(rnd() * cols) * step, lat, step: step * (1 + Math.floor(rnd() * 4)) };
    });
    const sorted = (s: Set<number>): number[] => [...s].sort((a, b) => a - b);
    const g2 = buildGridCells(META, stamps.map(s => ({ ...s, t: "water" })), 3100);
    const typeSet = new Set<number>();
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (g2.cells[r][c] !== grid.cells[r][c]) typeSet.add(r * cols + c);
    const hov = stamps.map(s => ({ ...s, dh: 0.05 }));
    const base = baseElev(META, grid), f = buildElevField(META, hov, grid, 3100);
    const elevSet = new Set<number>();
    for (let i = 0; i < f.length; i++) if (f[i] !== base[i]) elevSet.add(i);
    const hovGrid = erodeInput(META, hov, grid, 3100)!.hovGrid;
    const hovSet = new Set<number>();
    for (let i = 0; i < hovGrid.length; i++) if (hovGrid[i] !== 0) hovSet.add(i);
    assert.ok(typeSet.size > 20 && typeSet.size < cols * rows / 2, `夹具要有章落进图幅又不铺满：${typeSet.size} 格`);
    assert.deepStrictEqual(sorted(elevSet), sorted(typeSet), "高程场增量格集 ≠ 类型格改动格集");
    assert.deepStrictEqual(sorted(hovSet), sorted(typeSet), "侵蚀输入 hovGrid 格集 ≠ 类型格改动格集");
  });
});

/* 中尺度单：v2 图挂上中尺度基底后，侵蚀不跑粗级、类型基面不扭、起伏按包络——这条路径的键与块单 */
describe("侵蚀的中尺度单（ErodeInput.mesoEnv）", () => {
  const m: Meta = { terrain: "auto", genVer: 2, genSeed: 7, genStyle: "multi", relief: 0.7, worldModel: "sphere", planetRadiusKm: 10000, gridN: 120,
    bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 } };
  const g = buildGridCells(m, [], 0), R = gen2Meso(m, g), gm: Grid = buildGridCells(m, [], 0, R);
  const inp = erodeInput(m, [], gm, 0)!;
  it("门与组装同判；有中尺度时单里带包络、elev0 取中尺度基底，没有时不带", () => {
    for (const gg of [g, gm]) for (const mm of [m, { ...m, erode: "none" }, { ...m, relief: 0 }]) {
      assert.strictEqual(erodeGate(mm as Meta, [], gg, 0), erodeInput(mm as Meta, [], gg, 0) !== null);
    }
    const plain = erodeInput(m, [], g, 0)!;
    assert.strictEqual(inp.mesoEnv, R.env); assert.ok(!("mesoEnv" in plain), "没有中尺度的单不该有这个键");
    assert.notDeepStrictEqual(inp.elev0, plain.elev0, "elev0 没换成中尺度基底");
  });
  it("扩散只磨高出中尺度基底的那部分：侵蚀后陆地的最高点不低于基底最高点的 98%（基底在收尾平滑过、峰按它标定）", () => {
    const f = erodeField(inp);
    let mb = 0, mf = 0;
    for (let i = 0; i < inp.elev0.length; i++) if (!inp.water[i]) mb = Math.max(mb, inp.elev0[i]);
    for (let i = 0; i < f.data.length; i++) mf = Math.max(mf, f.data[i]);
    assert.ok(mf >= 0.98 * mb, `侵蚀后最高 ${(mf * 2000).toFixed(0)} m，基底最高 ${(mb * 2000).toFixed(0)} m`);
  });
  it("画的盆地（干处成盐滩）：单里带盆地掩码、键只在有它时追加；盐滩是局部基准面，盆底不被细级填洼填平（去掉它同一处被填高）", () => {
    /* 单块种子 5 南部是副热带荒漠：最干的一片低地上画盆，水量不够成湖、盆底成盐滩 */
    const md: Meta = { ...m, genStyle: "mono", genSeed: 5 }, gd = buildGridCells(md, [], 0), Rd = gen2Meso(md, gd), st = mesoState(md, gd, Rd.sg);
    const out = st.pr.inp.out, fM = st.pr.fM, { cols, rows } = gd, um = 2000;
    /* 第 17 行第 30 列：探针扫出的极干低地（水汽 0.02、基底约 320 m、周围 4 格全陆），画 −100 m 的盆成盐滩；最干那几格的盆集水够多、积成咸湖 */
    const k0 = 17 * cols + 30;
    assert.ok(Rd.base[k0] * um < 800 && fM[k0] < 0.05, "夹具的那一格该是极干低地");
    for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) assert.ok(!out[k0 + dr * cols + dc], "周围 4 格全陆");
    const fidx: number[] = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) fidx.push(k0 + dr * cols + dc);
    const U = gen2Uplift(st, { idx: new Int32Array(0), peakM: new Float64Array(0), fidx: Int32Array.from(fidx).sort(), floorM: new Float64Array(9).fill(-100) }, riverParams(md));
    assert.ok(U.water && U.water.list.some(x => x.kind === 2) && U.basin!.some(v => (v & 2) !== 0), `前提：成盐滩 ${JSON.stringify(U.water && U.water.list)}`);
    const gb = buildGridCells(md, [], 0, U), ib = erodeInput(md, [], gb, 0)!;
    assert.strictEqual(ib.basin, U.basin);
    assert.ok(!("basin" in inp), "没画盆地的单不该有这个键");
    assert.notStrictEqual(erodeKey(ib), erodeKey({ ...ib, basin: undefined }), "盆地掩码进键");
    const lo = (f: ElevField): number => {
      const sx = f.cols / cols, r0 = (k0 / cols) | 0, c0 = k0 % cols; let v = Infinity;
      for (let r = (r0 - 1) * sx; r < (r0 + 2) * sx; r++) for (let c = (c0 - 1) * sx; c < (c0 + 2) * sx; c++) v = Math.min(v, f.data[r * f.cols + c]);
      return v * um;
    };
    const plan = tilePlan(ib, 4e6, 0)!, ti = tileInput(ib, plan, null, plan.tiles[0]);
    assert.strictEqual(ti.basin!.length, ti.cols * ti.rows, "块单的盆地掩码与 elev0 同窗裁");
    assert.strictEqual(ti.basin![0], ib.basin![Math.round((ti.bb.latMin - ib.bb.latMin) / ib.step) * ib.cols + Math.round((ti.bb.lonMin - ib.bb.lonMin) / ib.step)]);
    const keep = lo(erodeField(ib)), fill = lo(erodeField({ ...ib, basin: undefined }));
    assert.ok(keep <= -50, `有局部基准面：盆底侵蚀后 ${keep.toFixed(0)} m（细格是粗格心的插值，到不了 −100 整）`);
    assert.ok(fill > keep + 50, `去掉局部基准面：同一处被填到 ${fill.toFixed(0)} m（有它时 ${keep.toFixed(0)} m）`);
  });
  it("键：包络只在有它时追加，一格之差即换键", () => {
    const k = erodeKey(inp), plain = erodeKey(erodeInput(m, [], g, 0)!);
    assert.notStrictEqual(k, plain);
    const env = inp.mesoEnv!.slice(), i = env.findIndex(v => v > 0.3); env[i] -= 0.001;
    assert.notStrictEqual(erodeKey({ ...inp, mesoEnv: env }), k, "包络变了键必须变");
  });
  it("不跑粗级（切割量为 null）；两次逐位同；块单裁出包络、切割量为 null、块键各不相同", () => {
    assert.strictEqual(erodeCarve(inp), null, "中尺度图的谷网已在稳态解里，粗级只会刻出沿格轴的直线谷壁");
    const f1 = erodeField(inp), f2 = erodeField(inp);
    assert.deepStrictEqual(f1.data, f2.data);
    /* 钉现行输出：起伏封顶、不扭不羽、汇流微地形任一被改都会变（这条路径有意换代时才重钉，见 MESO_EALGO） */
    let x = 0x811c9dc5 | 0; const u = new Uint32Array(f1.data.buffer, f1.data.byteOffset, f1.data.length);
    for (let i = 0; i < u.length; i++) x = Math.imul(x ^ u[i], 16777619);
    assert.strictEqual((x >>> 0).toString(36), "dl78ic");
    const plan = tilePlan(inp, 4e6, 0)!, keys = new Set<string>();
    assert.ok(plan && plan.tiles.length >= 2, "前提：至少两块");
    for (const t of plan.tiles.slice(0, 3)) {
      const ti = tileInput(inp, plan, null, t);
      assert.strictEqual(ti.win!.carve, null);
      assert.strictEqual(ti.mesoEnv!.length, ti.cols * ti.rows, "包络要与 elev0 同窗裁");
      assert.strictEqual(ti.mesoEnv![0], inp.mesoEnv![Math.round((ti.bb.latMin - inp.bb.latMin) / inp.step) * inp.cols + Math.round((ti.bb.lonMin - inp.bb.lonMin) / inp.step)]);
      keys.add(tileKey(ti));
    }
    assert.strictEqual(keys.size, Math.min(3, plan.tiles.length));
    const t0 = tileInput(inp, plan, null, plan.tiles[0]), tf = erodeField(t0);
    assert.strictEqual(tf.cols, t0.cols * plan.geom.sx, "块单照常算得出");
  });
});

describe("A* 开集换堆（2026-08-13 规模引擎批）：弹出序与旧线性扫逐位相同、guard 随格数扩", () => {
  /* 神谕＝旧实现（Map 线性扫最小 f、平手保留先入者）,在测试里原样内联——随机世界对照,
     路径与里程 deepStrictEqual＝「(f,首入序) 字典序堆复刻平手语义」的性质锁。 */
  const scanAstar = (meta: Meta | undefined, grid: Grid, roads: Set<string> | undefined,
    startLL: [number, number], goalLL: [number, number], arm: "land" | "water") => {
    const [sr, sc] = lonlatToCell(grid, startLL[0], startLL[1]);
    const [gr, gc] = lonlatToCell(grid, goalLL[0], goalLL[1]);
    const key = (r: number, c: number) => r * grid.cols + c;
    const open = new Map<number, { r: number; c: number; f: number }>(), came = new Map<number, number>(), gScore = new Map<number, number>();
    const hK = grid.step < 1 ? 0.5 : 1;
    const h = (r: number, c: number) => {
      const [lo, la] = cellCenter(grid, r, c), [glo, gla] = cellCenter(grid, gr, gc);
      return distKm(meta, lo, la, glo, gla) * hK;
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
        const path: [number, number][] = [];
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
  };
  const lcg = (s: number) => () => (s = (s * 48271) % 2147483647) / 2147483647;
  const randGrid = (seed: number, cols: number, rows: number): Grid => {
    const rnd = lcg(seed);
    const kinds = ["plain", "hill", "mountain", "forest", "marsh", "water", "desert"];
    const cells: string[][] = [];
    for (let r = 0; r < rows; r++) { const row: string[] = []; for (let c = 0; c < cols; c++) row.push(kinds[Math.floor(rnd() * kinds.length)]); cells.push(row); }
    return { bb: { lonMin: 100, lonMax: 100 + cols * 0.01, latMin: 30, latMax: 30 + rows * 0.01 }, step: 0.01, cols, rows, cells };
  };
  it("随机世界对照：堆版与线性扫版路径/里程逐位相同（含官道平手与不可达）", () => {
    const meta = { planetRadiusKm: 6371 } as Meta;
    let reached = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const g = randGrid(seed * 7 + 1, 24, 18);
      const roads = new Set<string>();
      const rnd = lcg(seed * 131 + 7);
      for (let i = 0; i < 60; i++) roads.add(Math.floor(rnd() * 18) + "," + Math.floor(rnd() * 24));
      for (const arm of ["land", "water"] as const) {
        const A: [number, number] = [100.005, 30.005], B: [number, number] = [100 + 0.235, 30 + 0.175];
        const a = astar(meta, g, roads, A, B, arm), b = scanAstar(meta, g, roads, A, B, arm);
        assert.deepStrictEqual(a, b, `seed=${seed} arm=${arm} 堆版与神谕不同`);
        if (a) reached++;
      }
    }
    assert.ok(reached >= 8, `夹具须有足量可达用例（实得 ${reached}）`);
  });
  it("guard 随格数扩：旧 20 万步硬顶在大网格上会假报「不可达」——同一条长途在扩闸后可达", () => {
    /* 500×500 全平原＝25 万格 > 旧 guard;0.5× 启发式下对角长途的真实弹出数超 20 万,
       旧实现在中途 break 返 null（功能断裂）。guard=max(20 万,2×格数)＝50 万,走得完。 */
    const cols = 500, rows = 500;
    const cells: string[][] = [];
    for (let r = 0; r < rows; r++) cells.push(new Array(cols).fill("plain"));
    const g: Grid = { bb: { lonMin: 100, lonMax: 100 + cols * 0.001, latMin: 30, latMax: 30 + rows * 0.001 }, step: 0.001, cols, rows, cells };
    const meta = { planetRadiusKm: 6371 } as Meta;
    const res = astar(meta, g, undefined, [100.0005, 30.0005], [100 + 0.4995, 30 + 0.4995], "land");
    assert.ok(res, "25 万格对角长途须可达（旧 guard 在此假报不可达）");
    assert.ok(res!.path.length >= cols, "路径须真跨全图");
  });
});

describe("侵蚀落地渐变（core/elev.fieldMix）", () => {
  const mkF = (cols: number, rows: number, step: number, v: number, eroded = false): ElevField => ({
    bb: { lonMin: 100, lonMax: 100 + cols * step, latMin: 30, latMax: 30 + rows * step },
    step, cols, rows, data: new Float32Array(cols * rows).fill(v), eroded
  });
  it("t≥1 返回 to 本身（末帧＝真场引用，与硬切逐位一致）", () => {
    const a = mkF(4, 4, 1, 0.2), b = mkF(4, 4, 1, 0.6);
    assert.strictEqual(fieldMix(a, b, 1), b);
  });
  it("同几何中点插值；两场相同处恒不动（渐变只发生在真变了的区域）", () => {
    const a = mkF(4, 4, 1, 0.2), b = mkF(4, 4, 1, 0.6, true);
    a.data[5] = 0.6;   // 此格 from===to＝远处不动
    const m = fieldMix(a, b, 0.5);
    assert.strictEqual(m.data[0], Math.fround(0.4));
    assert.strictEqual(m.data[5], Math.fround(0.6), "两场同值处逐位稳定");
    assert.strictEqual(m.eroded, true, "过渡帧取 to 的侵蚀标记");
    assert.notStrictEqual(m, b);
  });
  it("几何不同（首次落地粗→细）按 to 细格中心双线性重采样再插", () => {
    const a = mkF(4, 4, 1, 0.2), b = mkF(8, 8, 0.5, 0.6);
    const m = fieldMix(a, b, 0.5);
    for (let i = 0; i < 64; i++) assert.ok(Math.abs(m.data[i] - 0.4) < 1e-6, "常数场重采样仍是常数：" + m.data[i]);
  });
});

describe("侵蚀等待窗合成（core/elev.fieldPlusDelta）", () => {
  /* 4×4 粗格 × 5 倍细分（k 取奇数＝细格中心能恰落粗格中心，「章心恰抬 dh」可整验） */
  const geom = { bb: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 }, step: 1, cols: 4, rows: 4 };
  const mkFine = (): ElevField => {
    const cols = 20, rows = 20, data = new Float32Array(rows * cols);
    for (let i = 0; i < rows * cols; i++) data[i] = Math.fround(0.1 + (i % 7) * 0.03);
    return { bb: geom.bb, step: 0.2, cols, rows, data, eroded: true };
  };
  it("零增量＝返回原场引用（帧指纹不动、渲染零重传）", () => {
    const fine = mkFine(), base = new Float32Array(16), now = new Float32Array(16);
    base[5] = now[5] = 0.4;   // 同值≠增量
    assert.strictEqual(fieldPlusDelta(fine, base, now, geom), fine);
  });
  it("补丁窗与全量暴力合成逐位一致（含边角章的支撑域钳制）；纯函数、侵蚀标记透传", () => {
    for (const [r, c] of [[1, 2], [0, 0], [3, 3]] as const) {
      const fine = mkFine(), keep = fine.data.slice();
      const base = new Float32Array(16), now = new Float32Array(16);
      now[r * 4 + c] = 0.6;
      const out = fieldPlusDelta(fine, base, now, geom);
      const diff = new Float32Array(16);
      for (let i = 0; i < 16; i++) diff[i] = now[i] - base[i];
      const want = fine.data.slice();   // 神谕＝逐细格全量双线性叠加（不带补丁窗）
      for (let fr = 0; fr < 20; fr++) for (let fc = 0; fc < 20; fc++)
        want[fr * 20 + fc] += elevBilinear(diff, geom, 100 + (fc + 0.5) * 0.2, 30 + (fr + 0.5) * 0.2);
      assert.deepStrictEqual(out.data, want, `章(${r},${c})：补丁窗裁掉了支撑域`);
      assert.deepStrictEqual(fine.data, keep, "纯函数：原场不被改写");
      assert.strictEqual(out.eroded, fine.eroded, "侵蚀标记透传");
      assert.notStrictEqual(out, fine);
    }
  });
  it("羽化几何：章心细格恰抬 dh、支撑域外纹丝不动、邻格介于其间", () => {
    const fine = mkFine(), base = new Float32Array(16), now = new Float32Array(16);
    now[1 * 4 + 2] = 0.6;   // 粗格 (r1,c2) 中心 (102.5, 31.5) ＝细格 (r7,c12) 中心
    const out = fieldPlusDelta(fine, base, now, geom);
    assert.ok(Math.abs(out.data[7 * 20 + 12] - fine.data[7 * 20 + 12] - 0.6) < 1e-6, "章心恰抬 dh");
    assert.strictEqual(out.data[0], fine.data[0], "远角原位不动");
    assert.strictEqual(out.data[19 * 20 + 19], fine.data[19 * 20 + 19], "对角亦不动");
    const d = out.data[7 * 20 + 13] - fine.data[7 * 20 + 13];
    assert.ok(d > 0 && d < 0.6, "邻格羽化介于 (0, dh)：" + d);
  });
  it("带格表钳制：内陆湖按本次粗格场的床面压，不按类型表（湖不在笔刷等待窗里沉回海平面）", () => {
    /* 类型表只有一个 −0.35：拿它当水域天花，会让 320 m 的内陆湖在每次落笔时被按到海平面下、
       侵蚀落地又弹回来（同「一按全图变、松开又变回」之病）。天花须取本次粗格场的该格值。 */
    const geom = { bb: { lonMin: 0, lonMax: 2, latMin: 0, latMax: 1 }, step: 1, cols: 2, rows: 1 };
    const cells = [["plain", "water"]];
    const base = Float32Array.of(0.16, 0.13);                    // 湖床＝水面 0.16 下切 SHORE_E
    const now = Float32Array.of(0.60, 0.13);                     // 笔在 c0 抬了地；湖床不动
    const fine: ElevField = { bb: geom.bb, step: 0.5, cols: 4, rows: 2, data: new Float32Array(8), eroded: false };
    for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) fine.data[r * 4 + c] = c < 2 ? 0.16 : 0.13;
    const out = fieldPlusDelta(fine, base, now, geom, cells);
    assert.ok(out.data[2] > -0.02, "湖格不被按到海平面以下（旧式取类型表 −0.35 之病）：" + out.data[2]);
    assert.ok(Math.abs(out.data[2] - 0.13) < 1e-6, "湖格压回本次粗格场的床面：" + out.data[2]);
  });
  it("带格表钳制：大负增量不穿海平面、涂水压进水面、零增量与合法低地原位不动（笔刷闪水之修）", () => {
    /* 渲染端陆/水配色纯按显示高程判（terrainGL e>=-0.02）：涂平原盖掉雕山＝增量 −2 级，
       叠上被侵蚀刻低的谷底穿透海平面＝陆地闪成水域、侵蚀落地才回正（用户实报）。 */
    const g2 = { bb: { lonMin: 0, lonMax: 4, latMin: 0, latMax: 1 }, step: 1, cols: 4, rows: 1 };
    const cells = [["plain", "plain", "plain", "water"]];        // 落笔后的格表：c0 涂平原（原雕山）、c3 涂水（原陆地）
    const base = Float32Array.of(2.5, 0.16, 0.16, 0.16);         // 旧粗格：c0 是雕出的高山
    const now = Float32Array.of(0.16, 0.16, 0.16, -0.35);
    const colV = [0.6, 0.6, 0.2, 0.2, 0.01, 0.01, 0.5, 0.5];     // c2 上 0.01＝海岸坡合法低于类型地板
    const fine: ElevField = { bb: g2.bb, step: 0.5, cols: 8, rows: 2, data: new Float32Array(16), eroded: false };
    for (let r = 0; r < 2; r++) for (let c = 0; c < 8; c++) fine.data[r * 8 + c] = colV[c];
    const naive = fieldPlusDelta(fine, base, now, g2);           // 旧语义（不传格表）＝病根复现
    const out = fieldPlusDelta(fine, base, now, g2, cells);
    assert.ok(naive.data[0] < -0.02, "未钳制时涂平原处确实穿海平面（闪水病根）：" + naive.data[0]);
    assert.ok(out.data[0] >= 0.1 - 1e-6, "涂平原处钳回类型地板：" + out.data[0]);
    assert.ok(naive.data[6] > -0.02, "未钳制时新水面上残留干斑：" + naive.data[6]);
    assert.ok(out.data[6] <= -0.06 + 1e-6, "涂水处压进水面（容差＝Float32Array 存储圆整）：" + out.data[6]);
    assert.strictEqual(out.data[3], fine.data[3], "零增量细格原位不动（钳制恒等）");
    assert.strictEqual(out.data[4], fine.data[4], "合法低于类型地板的细格（海岸坡）不被人为抬高");
  });
  it("画的盆地（free 掩码）不钳陆地地板：往下压可以低于类型地板与海面，掩码外照旧钳", () => {
    const g2 = { bb: { lonMin: 0, lonMax: 2, latMin: 0, latMax: 1 }, step: 1, cols: 2, rows: 1 };
    const cells = [["plain", "plain"]], base = Float32Array.of(0.16, 0.16), now = Float32Array.of(-0.1, -0.1);
    const fine: ElevField = { bb: g2.bb, step: 0.5, cols: 4, rows: 2, data: new Float32Array(8).fill(0.16), eroded: false };
    const out = fieldPlusDelta(fine, base, now, g2, cells, Uint8Array.of(1, 0));
    assert.ok(out.data[0] < -0.05, "盆里的细格随增量压到海面以下：" + out.data[0]);
    assert.ok(out.data[3] >= 0.06 - 1e-6, "掩码外照旧钳回类型地板：" + out.data[3]);
  });
});

describe("腿账读到 (0,1) 区间的航点速度（写端允许的正小数不能被读端静默换成基线）", () => {
  it("出发航点声明 0.5 km/日：一日走 0.64 km 判不可达；同值放在部队基线上结论相同", () => {
    const world = plainWorld();
    const { grid, roads } = mkGrid(world);
    const a = { lon: 100.5, lat: 30.5 }, b = { lon: 100.5 + 0.0064, lat: 30.5 };
    const viaTrack: Unit = { id: "u", kind: "inf", speed: 30, track: [{ t: 0, ...a, speed: 0.5 } as never, { t: 1, ...b }] };
    const viaBase: Unit = { id: "v", kind: "inf", speed: 0.5, track: [{ t: 0, ...a }, { t: 1, ...b }] };
    const [lt] = unitLegs(META, grid, roads, viaTrack), [lb] = unitLegs(META, grid, roads, viaBase);
    assert.strictEqual(lt.ok, lb.ok, "航点声明与部队基线同值＝同结论");
    assert.ok(Math.abs(lt.need - lb.need) < 1e-9, "耗时同式");
    assert.strictEqual(lt.ok, false, "0.64 km 按 0.5 km/日要一天多");
  });
});

/* 中尺度车道的画抬升单：车道按 mesoKey 留着 Sg 与求解图，每笔只发逐格目标 */
describe("中尺度车道：画抬升单（routeProto uplift）", () => {
  const m: Meta = { terrain: "auto", genVer: 2, genSeed: 7, genStyle: "multi", worldModel: "sphere", planetRadiusKm: 10000, gridN: 90,
    bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 } };
  const geom = gridGeom(m), R = gen2Meso(m, geom), st0 = mesoState(m, geom, R.sg), out = st0.pr.inp.out;
  const land = out.findIndex((v, i) => v === 0 && i > out.length / 2);
  const cells: UpliftCells = { idx: Int32Array.of(land), peakM: Float64Array.of(4000) };
  const want = gen2Uplift(st0, cells, riverParams(m));
  it("中尺度单之后不带 sg 的画抬升单＝gen2Uplift（含河）；回执的 sg 是拷贝，车道留着的原件不受 transfer 影响；中尺度单带回求解状态，画抬升不重建三角网", () => {
    const st: RouteCtx = {};
    const r = handleRouteMsg(st, { t: "meso", id: 1, meta: m, geom, sg: null });
    assert.ok(r && r.t === "meso" && r.sg);
    assert.deepStrictEqual(r.rivers, R.rivers, "回执的河按单里 meta 的滑杆抽");
    const st0Lane = st.meso!.st;
    assert.ok(st0Lane, "中尺度单就留下求解状态");
    assert.notStrictEqual(r.sg!.h, st.meso!.sg.h, "回执的 sg 与车道留着的不是同一块内存");
    assert.deepStrictEqual(r.sg!.h, st.meso!.sg.h);
    const u = handleRouteMsg(st, { t: "uplift", id: 2, meta: m, geom, sg: null, cells });
    assert.ok(u && u.t === "uplift");
    assert.deepStrictEqual(u.base, want.base); assert.deepStrictEqual(u.env, want.env); assert.deepStrictEqual(u.rivers, want.rivers);
    const keep = st.meso!.st;
    assert.strictEqual(keep, st0Lane, "画抬升单沿用中尺度单留下的求解状态");
    handleRouteMsg(st, { t: "uplift", id: 3, meta: m, geom, sg: null, cells });
    assert.strictEqual(st.meso!.st, keep, "第二笔沿用同一份求解状态（不重建三角网）");
  });
  it("车道没留着：带缓存的 sg 或现算，结果逐位同；换了图（键）就换状态", () => {
    const a: RouteCtx = {}, b: RouteCtx = {};
    const ua = handleRouteMsg(a, { t: "uplift", id: 1, meta: m, geom, sg: { h: R.sg.h.slice(), rcv: R.sg.rcv.slice() }, cells });
    const ub = handleRouteMsg(b, { t: "uplift", id: 1, meta: m, geom, sg: null, cells });
    assert.ok(ua && ua.t === "uplift" && ub && ub.t === "uplift");
    assert.deepStrictEqual(ua.base, want.base); assert.deepStrictEqual(ub.base, want.base);
    const m2 = { ...m, genSeed: 8 }, k0 = a.meso!.key;
    handleRouteMsg(a, { t: "uplift", id: 2, meta: m2, geom: gridGeom(m2), sg: null, cells });
    assert.notStrictEqual(a.meso!.key, k0);
  });
});
