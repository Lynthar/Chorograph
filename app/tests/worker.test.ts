/* 寻路 Worker 协议测试 + 寻路语义行为测试。
   协议是纯函数（Worker 入口/客户端只做消息搬运，浏览器截图目检）；
   语义断言防"新旧一起错"：官道减半、水军限水、可达性判定、时间轴范围。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGridCells, roadCellSet } from "../src/core/grid.ts";
import { astar, cellCost, computeRoute, measureLegs, routeReport } from "../src/core/route.ts";
import { setUnitPoint, unitLegs, unitPos } from "../src/core/units.ts";
import { yearRangeOf } from "../src/core/time.ts";
import { distKm } from "../src/core/geo.ts";
import { handleRouteMsg, type RouteCtx } from "../src/worker/routeProto.ts";
import type { Meta, Unit, World } from "../src/core/types.ts";

/* 全平原世界：语义可手推 */
const META: Meta = { terrain: "plain" };
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
  it("unitLegs：速度×天数容 1e-9 齿隙；同日两点=不可达", () => {
    const world = plainWorld();
    const { grid, roads } = mkGrid(world);
    const kmPerDay = distKm(META, 100.5, 30.5, 101.5, 30.5);   // 走 1 格的里程
    const u: Unit = { id: "u", kind: "inf", speed: kmPerDay, track: [
      { t: 0, lon: 100.5, lat: 30.5 }, { t: 1, lon: 101.5, lat: 30.5 }, { t: 1.5, lon: 102.5, lat: 30.5 }] };
    const legs = unitLegs(META, grid, roads, u);
    assert.strictEqual(legs[0].ok, true, "恰好等于速度上限应可达");
    assert.strictEqual(legs[1].ok, false, "半天走一格不可达");
    const dup: Unit = { id: "d", kind: "inf", track: [{ t: 5, lon: 100.5, lat: 30.5 }, { t: 5, lon: 100.5, lat: 30.5 }] };
    assert.strictEqual(unitLegs(META, grid, roads, dup)[0].ok, false, "days=0 恒不可达");
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
