/* 寻路 Worker 协议测试 + 寻路语义行为测试。
   协议是纯函数（Worker 入口/客户端只做消息搬运，浏览器截图目检）；
   语义断言防"新旧一起错"：官道减半、水军限水、可达性判定、时间轴范围。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGridCells, roadCellSet } from "../src/core/grid.ts";
import { astar, cellCenter, cellCost, computeRoute, lonlatToCell, measureLegs, routeReport } from "../src/core/route.ts";
import { DEPTH_RATIO, bearingDeg, footCornersLL, setUnitPoint, unitFacingAt, unitFootKm, unitLegs, unitPos } from "../src/core/units.ts";
import { pickUnit, unitSpots } from "../src/render/units.ts";
import { project, type Camera } from "../src/core/projection.ts";
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

describe("寻路（战术尺度）", () => {
  /* 战术细网格三处尺度修正的判别测试（战略 1° 路径由 golden 平价锁定,此处专锁细网格域） */
  it("roadCellSet：战术细网格采样加密,官道格不断续", () => {
    const meta: Meta = { mapKind: "tactical", terrain: "plain", bbox: { lonMin: 0, lonMax: 0.28, latMin: 0, latMax: 0.2 } };
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
  it("unitLegs：跨日=日配额旧语义；亚日按一日行军 8 小时折算（时辰级不再摊薄误报）", () => {
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
  it("unitLegs：时辰级航段的可达按小时速率（v/8 km/时）记账", () => {
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
