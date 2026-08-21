/* 寻路 Worker 协议测试 + 寻路语义行为测试。
   协议是纯函数（Worker 入口/客户端只做消息搬运，浏览器截图目检）；
   语义断言防"新旧一起错"：官道减半、水军限水、可达性判定、时间轴范围。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGridCells, roadCellSet, type Grid } from "../src/core/grid.ts";
import { astar, cellCenter, cellCost, computeRoute, lonlatToCell, measureLegs, routeReport } from "../src/core/route.ts";
import { DEPTH_RATIO, bearingDeg, footCornersLL, setUnitPoint, unitFacingAt, unitFootKm, unitLegs, unitPos } from "../src/core/units.ts";
import { pickUnit, unitSpots } from "../src/render/units.ts";
import { project, type Camera } from "../src/core/projection.ts";
import { yearRangeOf } from "../src/core/time.ts";
import { distKm } from "../src/core/geo.ts";
import { handleRouteMsg, type RouteCtx } from "../src/worker/routeProto.ts";
import { ERODE_VER, erodeField, erodeGate, erodeInput, erodeKey, rowFbm, ultraInput, upscaleOf, type ErodeInput } from "../src/core/erode.ts";
import { fbm } from "../src/core/noise.ts";
import { reliefNoise, elevBilinear, fieldMix, fieldPlusDelta, LAND_FLOOR, type ElevField } from "../src/core/elev.ts";
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
});

describe("侵蚀真形（core/erode）", () => {
  /* 4×4 粗格试验场：西一列水域＝侵蚀基准面，往东平原→丘陵→山地（数值取自 LANDFORM 表） */
  const mk = (hovGrid?: Float32Array): ErodeInput => {
    const cols = 4, rows = 4;
    const elevCol = [-0.35, 0.16, 0.5, 0.9], reliefCol = [0, 0.05, 0.14, 0.30];
    const elev0 = new Float32Array(rows * cols), relief0 = new Float32Array(rows * cols), water = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      elev0[r * cols + c] = elevCol[c]; relief0[r * cols + c] = reliefCol[c]; water[r * cols + c] = c === 0 ? 1 : 0;
    }
    return { bb: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 }, step: 1, cols, rows,
      elev0, relief0, water, amp: 0.7, seed: 1234, kmx: 96, kmy: 111, hovGrid: hovGrid || new Float32Array(rows * cols),
      cap: 400_000, axisMax: 8, acrit: 300, bandS: 1 };
  };
  it("确定性：同输入两跑逐位同输出（Worker 与主线程回退必须可互换）", () => {
    const a = erodeField(mk()), b = erodeField(mk());
    assert.deepStrictEqual(a.data, b.data);
    assert.deepStrictEqual(a.shadow, b.shadow);
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
  it("水域＝基准面（远岸恒 -0.35、近岸随双线性基面，不侵蚀不加噪）；陆地不穿透类型地板", () => {
    const inp = mk(), f = erodeField(inp), sx = f.cols / 4;
    const geo = { bb: inp.bb, step: 1, cols: 4, rows: 4 };
    for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) {
      const pc = Math.min(3, (c / sx) | 0), pr = Math.min(3, (r / sx) | 0), h = f.data[r * f.cols + c];
      const b = elevBilinear(inp.elev0, geo, 100 + (c + 0.5) * f.step, 30 + (r + 0.5) * f.step);
      if (pc === 0) {
        if (c + 0.5 <= sx / 2) assert.strictEqual(h, Math.fround(-0.35), "远岸水面恒定");
        else assert.ok(Math.abs(h - b) < 1e-6, "近岸水＝双线性基面（旧管线的海岸缓坡）");
      } else {
        /* 期望有意放宽（批6）：钳制参照系是**域扭曲+羽化后**的基面（台阶圈揉山缘），逐点双线性
           下界不再成立——改用邻域最小（±2 粗格覆盖扭曲 ≤1.8 格 + 羽化 0.6 + 双线性支撑） */
        let bm = Infinity;
        for (let rr = Math.max(0, pr - 2); rr <= Math.min(3, pr + 2); rr++)
          for (let cc = Math.max(0, pc - 2); cc <= Math.min(3, pc + 2); cc++) bm = Math.min(bm, inp.elev0[rr * 4 + cc]);
        assert.ok(h >= Math.min(LAND_FLOOR, bm) - 1e-6, "陆地地板随（扭过的）基面邻域收敛");
      }
    }
  });
  it("侵蚀真的发生：山地起伏面上至少有细格被下切（相对未侵蚀基座）", () => {
    const inp = mk(), f = erodeField(inp), sx = f.cols / 4;
    let carved = 0;
    for (let r = 0; r < f.rows; r++) for (let c = Math.ceil(3.5 * sx); c < f.cols; c++) {   // 山地列右半＝双线性纯区
      const lon = 100 + (c + 0.5) * f.step, lat = 30 + (r + 0.5) * f.step;
      const base = 0.9 + 0.30 * 0.7 * 2 * reliefNoise(lon, lat, 1234);
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
  it("遮蔽通道：值域 [0,1]、水域恒 0", () => {
    const f = erodeField(mk()), sx = f.cols / 4;
    assert.ok(f.shadow, "侵蚀场必带遮蔽通道");
    for (let i = 0; i < f.shadow!.length; i++) {
      assert.ok(f.shadow![i] >= 0 && f.shadow![i] <= 1);
      if (((i % f.cols) / sx | 0) === 0) assert.strictEqual(f.shadow![i], 0, "水域无遮蔽");
    }
  });
  it("山系结构随系数渐入：山地档的起伏跨度远大于平原档、平原不吃结构带（批6）", () => {
    const flat = (relief: number): ErodeInput => {
      const cols = 6, rows = 6, n2 = cols * rows;
      return { bb: { lonMin: 100, lonMax: 106, latMin: 30, latMax: 36 }, step: 1, cols, rows,
        elev0: new Float32Array(n2).fill(0.5), relief0: new Float32Array(n2).fill(relief),
        water: new Uint8Array(n2), amp: 0.7, seed: 1234, kmx: 96, kmy: 111, hovGrid: new Float32Array(n2),
        cap: 400_000, axisMax: 8, acrit: 300, bandS: 1 };
    };
    const span = (f: { data: Float32Array }): number => {
      const a = Float32Array.from(f.data).sort();
      return a[Math.floor(a.length * 0.95)] - a[Math.floor(a.length * 0.05)];
    };
    const mtn = span(erodeField(flat(0.30))), pln = span(erodeField(flat(0.05)));
    assert.ok(mtn > pln * 3, `山地跨度须数倍于平原（结构+起伏 vs 纯低幅噪声）：${mtn} vs ${pln}`);
  });
  it("平原静场（批7）：36/度 高频档与表面细节的系数渐入带下限——纯平原逐格糙度近零，山地照旧带糙", () => {
    /* 正比例渐入曾给平原留 15~29% 细带幅＝±1~3m 摊在百米波长上就是 3~8° 坡，坡度型光照满地显影
       （「几米的高度差也都显示出来」，河洛/井陉实证）；坡度键不受带下限影响＝沟壁雕崖照旧嶙峋 */
    const flat = (relief: number): ErodeInput => {
      const cols = 6, rows = 6, n2 = cols * rows;
      return { bb: { lonMin: 100, lonMax: 106, latMin: 30, latMax: 36 }, step: 1, cols, rows,
        elev0: new Float32Array(n2).fill(0.5), relief0: new Float32Array(n2).fill(relief),
        water: new Uint8Array(n2), amp: 0.7, seed: 1234, kmx: 96, kmy: 111, hovGrid: new Float32Array(n2),
        cap: 400_000, axisMax: 8, acrit: 300, bandS: 1 };
    };
    const rough = (f: { data: Float32Array; cols: number; rows: number }): number => {
      const a: number[] = [];
      for (let r = 2; r < f.rows - 2; r++) for (let c = 2; c < f.cols - 2; c++) {
        const i = r * f.cols + c;
        a.push(Math.abs(f.data[i] - 0.25 * (f.data[i - 1] + f.data[i + 1] + f.data[i - f.cols] + f.data[i + f.cols])));
      }
      a.sort((x, y) => x - y);
      return a[Math.floor(a.length * 0.95)];
    };
    const pln = rough(erodeField(flat(0.05))), mtn = rough(erodeField(flat(0.30)));
    assert.ok(pln < 0.002, `平原逐格糙度须近零（带下限后实测 0.00099）：${pln}`);
    assert.ok(mtn > pln * 3, `山地细节不吃带下限（实测约 7×）：${mtn} vs ${pln}`);
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
  it("erodeKey：同输入同键、键带算法代前缀；任一分量（单个格值/种子/幅度/bb/量纲）变即换键", () => {
    /* 键是场缓存（data/fieldcache）的全部正确性来源：漏进键的分量变了而键没变＝按键取回
       一整幅错误地形。逐分量各变一处，键必须跟着变。 */
    const k0 = erodeKey(mk());
    assert.strictEqual(erodeKey(mk()), k0, "同输入两算必同键");
    assert.ok(k0.startsWith(ERODE_VER + "-"), "键前缀＝算法代号（换代清场的判据）");
    const vary: [string, (i: ErodeInput) => void][] = [
      ["elev0 单格", i => { i.elev0[7] += 0.001; }],
      ["relief0 单格", i => { i.relief0[3] = 0.99; }],
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
    ];
    for (const [what, v] of vary) {
      const i = mk(); v(i);
      assert.notStrictEqual(erodeKey(i), k0, `${what} 变了键必须变`);
    }
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
    assert.strictEqual(inp2!.cap, 600_000, "战略图预算（2026-08-13 尺度定形批 40万→60万,随公里锚定的更细网格）");
    assert.strictEqual(inp2!.axisMax, 8, "工作档轴上限 8");
    assert.strictEqual(inp2!.acrit, 300, "工作档河道阈值＝旧常量逐位");
    const tacGrid = { ...grid, step: 0.01 };
    const inp3 = erodeInput({ terrain: "plain", relief: 0.5, mapKind: "tactical" }, undefined, tacGrid, 3100);
    assert.strictEqual(inp3!.cap, 1_400_000, "战术图＝140 万预算（分档随 mapKind）");
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
  const mkF = (cols: number, rows: number, step: number, v: number, shadow?: number): ElevField => ({
    bb: { lonMin: 100, lonMax: 100 + cols * step, latMin: 30, latMax: 30 + rows * step },
    step, cols, rows, data: new Float32Array(cols * rows).fill(v),
    shadow: shadow == null ? null : new Float32Array(cols * rows).fill(shadow)
  });
  it("t≥1 返回 to 本身（末帧＝真场引用，与硬切逐位一致）", () => {
    const a = mkF(4, 4, 1, 0.2), b = mkF(4, 4, 1, 0.6);
    assert.strictEqual(fieldMix(a, b, 1), b);
  });
  it("同几何中点插值；两场相同处恒不动（渐变只发生在真变了的区域）", () => {
    const a = mkF(4, 4, 1, 0.2), b = mkF(4, 4, 1, 0.6, 0.4);
    a.data[5] = 0.6;   // 此格 from===to＝远处不动
    const m = fieldMix(a, b, 0.5);
    assert.strictEqual(m.data[0], Math.fround(0.4));
    assert.strictEqual(m.data[5], Math.fround(0.6), "两场同值处逐位稳定");
    assert.strictEqual(m.shadow![0], Math.fround(0.2), "from 无遮蔽＝烘焙阴影按 t 淡入");
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
    const cols = 20, rows = 20, data = new Float32Array(rows * cols), shadow = new Float32Array(rows * cols);
    for (let i = 0; i < rows * cols; i++) { data[i] = Math.fround(0.1 + (i % 7) * 0.03); shadow[i] = (i % 5) * 0.1; }
    return { bb: geom.bb, step: 0.2, cols, rows, data, shadow };
  };
  it("零增量＝返回原场引用（帧指纹不动、渲染零重传）", () => {
    const fine = mkFine(), base = new Float32Array(16), now = new Float32Array(16);
    base[5] = now[5] = 0.4;   // 同值≠增量
    assert.strictEqual(fieldPlusDelta(fine, base, now, geom), fine);
  });
  it("补丁窗与全量暴力合成逐位一致（含边角章的支撑域钳制）；纯函数、shadow 引用透传", () => {
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
      assert.strictEqual(out.shadow, fine.shadow, "遮蔽通道引用透传（等待窗沿用旧烘焙）");
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
  it("带格表钳制：大负增量不穿海平面、涂水压进水面、零增量与合法低地原位不动（笔刷闪水之修）", () => {
    /* 渲染端陆/水配色纯按显示高程判（terrainGL e>=-0.02）：涂平原盖掉雕山＝增量 −2 级，
       叠上被侵蚀刻低的谷底穿透海平面＝陆地闪成水域、侵蚀落地才回正（用户实报）。 */
    const g2 = { bb: { lonMin: 0, lonMax: 4, latMin: 0, latMax: 1 }, step: 1, cols: 4, rows: 1 };
    const cells = [["plain", "plain", "plain", "water"]];        // 落笔后的格表：c0 涂平原（原雕山）、c3 涂水（原陆地）
    const base = Float32Array.of(2.5, 0.16, 0.16, 0.16);         // 旧粗格：c0 是雕出的高山
    const now = Float32Array.of(0.16, 0.16, 0.16, -0.35);
    const colV = [0.6, 0.6, 0.2, 0.2, 0.01, 0.01, 0.5, 0.5];     // c2 上 0.01＝海岸坡合法低于类型地板
    const fine: ElevField = { bb: g2.bb, step: 0.5, cols: 8, rows: 2, data: new Float32Array(16), shadow: null };
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
});
