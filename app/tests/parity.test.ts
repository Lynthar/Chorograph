/* 平价测试：src/core 各模块与冻结黄金基准（fixtures/legacy-golden.json）逐位一致。
   本文件失败 = 移植发生行为漂移（或基准被误改），一律先查移植。
   运行器：node:test + Node 类型剥离（零原生依赖）。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import goldenJson from "./fixtures/legacy-golden.json" with { type: "json" };
import * as C from "../src/core/constants.ts";
import { fbm, hash2, vnoise } from "../src/core/noise.ts";
import { seedTerrain } from "../src/core/terrain.ts";
import { distKm, flatKmPerDeg, haversine, kmPerDegLat, wrapLon } from "../src/core/geo.ts";
import { calOf, fmtT, fmtYMD, fromT, parseYMD, tacT } from "../src/core/calendar.ts";
import { clampView, minDegPerPx, panByView, project, projectSeq, unproject, visibleWorldCopies, zoomAtView, type Camera } from "../src/core/projection.ts";
import { buildGridCells, roadCellSet } from "../src/core/grid.ts";
import { territoryLoops } from "../src/core/territory.ts";
import { activeAt, ownerAt, paintLayersAt } from "../src/core/time.ts";
import { chaikin, convexHull, pointInPoly, type Pt } from "../src/core/geometry.ts";
import { clone, esc, fmtKm, hexA, parseKV, safeName } from "../src/core/util.ts";
import { blankWorld, countsOf, normalizeWorld } from "../src/core/world.ts";
import { astar, cellCenter, cellCost, computeRoute, lonlatToCell } from "../src/core/route.ts";
import { unitLegs } from "../src/core/units.ts";
import { yearRangeOf } from "../src/core/time.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const golden: any = goldenJson;

/* v0.15 起新壳对旧常量表做**纯扩展**（标注 type:"label" / 图层 "notes"）：这些表的平价保证
   ＝旧键逐位不变 + 新增键恰为显式白名单——旧值漂移照红，白名单外的暗加新键也照红。 */
const stripKeys = (o: Record<string, unknown>, added: string[]): Record<string, unknown> => {
  const c: Record<string, unknown> = { ...o };
  for (const k of added) delete c[k];
  return c;
};

describe("常量与旧实现深度一致", () => {
  const g = golden.constants;
  it("TERRAIN 系列", () => {
    assert.deepStrictEqual(C.TERRAIN, g.TERRAIN);
    assert.deepStrictEqual(C.TERRAIN_ORDER, g.TERRAIN_ORDER);
    assert.deepStrictEqual(C.TERRAIN_ECO, g.TERRAIN_ECO);
    assert.deepStrictEqual(C.ELEV, g.ELEV);
    assert.deepStrictEqual(C.TINT, g.TINT);
    assert.strictEqual(C.PD, g.PD);
  });
  it("图层/预设/布景", () => {
    // LAYERS：剔除新增 "notes"/"vision" 后与旧版逐位一致；新增各恰好一条
    assert.deepStrictEqual(C.LAYERS.filter(l => l.id !== "notes" && l.id !== "vision"), g.LAYERS);
    assert.strictEqual(C.LAYERS.filter(l => l.id === "notes").length, 1);
    assert.strictEqual(C.LAYERS.filter(l => l.id === "vision").length, 1);
    assert.strictEqual(C.LAYERS.find(l => l.id === "vision")!.tacOnly, true, "vision 应为战术图专属");
    // PRESETS：每个预设剔除 notes/vision 键后与旧版一致；标注全预设开、视野仅军事/战术/全部
    assert.deepStrictEqual(Object.keys(C.PRESETS), Object.keys(g.PRESETS));
    for (const k of Object.keys(C.PRESETS)) {
      assert.deepStrictEqual(stripKeys(C.PRESETS[k], ["notes", "vision"]), g.PRESETS[k], `预设「${k}」旧键漂移`);
      assert.strictEqual(C.PRESETS[k].notes, 1, `预设「${k}」应含标注层`);
      assert.strictEqual(C.PRESETS[k].vision, ["军事", "战术", "全部"].includes(k) ? 1 : undefined, `预设「${k}」vision 白名单`);
    }
    assert.deepStrictEqual(C.DECOR, g.DECOR);
  });
  it("地点/事件类型与模板", () => {
    // NODE_STYLE/NODE_TYPES/NODE_TMPL：剔除新增 "label" 后与旧版逐位一致
    assert.deepStrictEqual(stripKeys(C.NODE_STYLE, ["label"]), g.NODE_STYLE);
    assert.ok(C.NODE_STYLE.label, "v0.15 标注类型应存在");
    assert.deepStrictEqual(C.NODE_TYPES.filter(t => t !== "label"), g.NODE_TYPES);
    assert.deepStrictEqual(C.LEGACY_TYPE, g.LEGACY_TYPE);
    assert.deepStrictEqual(C.EVENT_TYPES, g.EVENT_TYPES);
    assert.deepStrictEqual(stripKeys(C.NODE_TMPL, ["label"]), g.NODE_TMPL);
    assert.deepStrictEqual(C.EVENT_TMPL, g.EVENT_TMPL);
    assert.deepStrictEqual(C.RANK_ZOOM.map(v => (isFinite(v) ? v : "Infinity")), g.RANK_ZOOM);
  });
  it("连线/速度/兵种", () => {
    assert.deepStrictEqual(C.EDGE_STYLE, g.EDGE_STYLE);
    assert.strictEqual(C.RIVER_TMPL, g.RIVER_TMPL);
    assert.deepStrictEqual(C.SPEEDS, g.SPEEDS);
    assert.deepStrictEqual(C.UNIT_KINDS, g.UNIT_KINDS);
  });
});

describe("噪声逐位一致", () => {
  it("hash2 / vnoise / fbm", () => {
    for (const s of golden.noise.hash2) assert.strictEqual(hash2(s.x, s.y), s.v);
    for (const s of golden.noise.vnoise) assert.strictEqual(vnoise(s.x, s.y), s.v);
    for (const s of golden.noise.fbm) assert.strictEqual(fbm(s.x, s.y), s.v);
  });
});

describe("程序化地形逐格一致", () => {
  for (const tc of golden.terrain) {
    it(`meta=${JSON.stringify(tc.meta)}（${tc.samples.length} 格）`, () => {
      const bad: unknown[] = [];
      for (const s of tc.samples) {
        const t = C.flattenTerrain(seedTerrain(tc.meta, s.lon, s.lat));   // 分类器输出复合串、flatten 回旧类比对（「重贴标签」验证：底层类型未变）
        if (t !== s.t) bad.push({ lon: s.lon, lat: s.lat, want: s.t, got: t });
      }
      assert.deepStrictEqual(bad, []);
    });
  }
});

describe("地理距离一致", () => {
  for (const gc of golden.geo) {
    it(`meta=${JSON.stringify(gc.meta)}`, () => {
      for (const pr of gc.pairs) assert.strictEqual(distKm(gc.meta, pr.p[0], pr.p[1], pr.p[2], pr.p[3]), pr.distKm);
      assert.strictEqual(kmPerDegLat(gc.meta), gc.kmPerDegLat);
      assert.strictEqual(flatKmPerDeg(gc.meta), gc.flatKmPerDeg);
      assert.strictEqual(minDegPerPx(gc.meta), gc.minDegPerPx);
      const flat = gc.meta.worldModel === "flat";
      for (const wl of gc.wrapLonData) assert.strictEqual(wrapLon(wl.l, flat), wl.v);
    });
  }
  it("haversine 指定半径", () => {
    for (const s of golden.haversine) assert.strictEqual(haversine(s.p[0], s.p[1], s.p[2], s.p[3], 6371), s.R6371);
  });
});

describe("历法一致", () => {
  for (const cc of golden.calendar) {
    it(`calendar=${JSON.stringify(cc.calendar)}`, () => {
      const cal = calOf(cc.calendar ?? undefined);
      // 黄金基准锁 months/dpm/dpy 归一化数值；kind/era 是双轨历法的新增运行时字段（不入存档），投影比较
      assert.deepStrictEqual({ months: cal.months, dpm: cal.dpm, dpy: cal.dpy }, cc.CAL);
      for (const s of cc.tacT) assert.strictEqual(tacT(cal, s.y, s.m, s.d), s.T);
      for (const s of cc.fromT) assert.deepStrictEqual(fromT(cal, s.T), { y: s.y, m: s.m, d: s.d });
      for (const s of cc.fmtT) assert.strictEqual(fmtT(cal, s.T), s.s);
      for (const s of cc.fmtYMD) assert.strictEqual(fmtYMD(cal, s.T), s.s);
      for (const s of cc.parseYMD) assert.strictEqual(parseYMD(cal, s.s), s.T);
    });
  }
});

describe("投影一致", () => {
  const SEQ = [[170, 10], [-170, 12], [175, -5], [160, 0]] as const;
  golden.projection.forEach((pc: any, i: number) => {
    it(`case#${i} ${pc.meta.worldModel} lon0=${pc.view.lon0}`, () => {
      const cam: Camera = {
        lon0: pc.view.lon0, lat0: pc.view.lat0, degPerPx: pc.view.degPerPx,
        w: pc.w, h: pc.h, flat: pc.meta.worldModel === "flat", lonShift: pc.shift
      };
      for (const s of pc.project) assert.deepStrictEqual(project(cam, s.lon, s.lat), s.xy);
      for (const s of pc.unproject) assert.deepStrictEqual(unproject(cam, s.x, s.y), s.ll);
      assert.deepStrictEqual(projectSeq(cam, SEQ.map(([lon, lat]) => ({ lon, lat }))), pc.projectSeq);
      assert.deepStrictEqual(visibleWorldCopies(cam, pc.meta), pc.visibleWorldCopies);
    });
  });
  it("clampView（纯函数版与旧实现结果一致）", () => {
    for (const cc of golden.clampView) {
      const r = clampView(cc.view, cc.meta);
      assert.deepStrictEqual({ lon0: r.lon0, lat0: r.lat0 }, cc.after);
    }
  });
});

describe("地形网格构建一致", () => {
  for (const gc of golden.buildGrid) {
    it(gc.name, () => {
      const g = buildGridCells(gc.meta, gc.overrides, gc.yearNow);
      assert.deepStrictEqual({ cols: g.cols, rows: g.rows, step: g.step, bb: g.bb }, gc.grid);
      assert.deepStrictEqual(g.cells.map(r => r.map(C.flattenTerrain).join(",")), gc.cells);   // cells 存复合串、flatten 回旧类比对
      assert.deepStrictEqual([...roadCellSet(gc.nodes, gc.edges, gc.yearNow, g)].sort(), gc.roadCells);
    });
  }
});

describe("势力涂域边界环一致", () => {
  for (const tc of golden.territory) {
    it(tc.name, () => {
      assert.deepStrictEqual(territoryLoops(tc.cells, undefined, tc.smooth), tc.loops);
    });
  }
});

describe("相机操作一致", () => {
  it("zoomAt / panBy（含触底触顶与边界钳制）", () => {
    for (const c of golden.cameraOps) {
      const r = c.op[0] === "zoom"
        ? zoomAtView(c.view, c.meta, 1200, 700, c.op[1], c.op[2], c.op[3])
        : panByView(c.view, c.meta, c.op[1], c.op[2]);
      assert.deepStrictEqual({ lon0: r.lon0, lat0: r.lat0, degPerPx: r.degPerPx }, c.after);
    }
  });
});

describe("世界规范化/构造一致", () => {
  const g = golden.world;
  it("normalizeWorld（缺字段补齐 / 旧类型升级 / v0.9 events 迁移）", () => {
    for (const c of g.normalize)
      assert.deepStrictEqual(JSON.parse(JSON.stringify(normalizeWorld(clone(c.input)))), c.output);
  });
  it("blankWorld（更新 字段以占位日期锁定其余全部）", () => {
    for (const c of g.blank)
      assert.deepStrictEqual(JSON.parse(JSON.stringify(blankWorld(c.spec, "@today@"))), c.output);
  });
  it("countsOf / safeName", () => {
    for (const c of g.counts) assert.deepStrictEqual(countsOf(clone(c.input)), c.output);
    for (const c of g.safeName) assert.strictEqual(safeName(c.input), c.output);
  });
});

describe("时间过滤与杂项一致", () => {
  const m = golden.misc;
  it("activeAt / ownerAt / paintLayersAt", () => {
    for (const s of m.activeAt) assert.strictEqual(activeAt(s.o, s.yr), s.v);
    for (const s of m.ownerAt) assert.strictEqual(ownerAt(s.n, s.yr), s.v);
    const f = { paint: [{ cells: [[100, 30]] as Pt[] }, { since: 3100, until: 3105, cells: [[101, 31]] as Pt[] }, { since: 3105, cells: [[102, 32]] as Pt[] }] };
    for (const s of m.paintLayersAt) assert.strictEqual(paintLayersAt(f, s.yr).length, s.n);
  });
  it("几何", () => {
    for (const s of m.pointInPoly) assert.strictEqual(pointInPoly(s.x, s.y, [[0, 0], [1, 0], [1, 1], [0, 1]]), s.v);
    assert.deepStrictEqual(convexHull(m.convexHull.pts), m.convexHull.v);
    assert.deepStrictEqual(chaikin(m.chaikin.loop, m.chaikin.it), m.chaikin.v);
  });
  it("hexA / fmtKm / esc / parseKV", () => {
    for (const s of m.hexA) assert.strictEqual(hexA(s.hex, s.a), s.v);
    for (const s of m.fmtKm) assert.strictEqual(fmtKm(s.km), s.v);
    assert.strictEqual(esc(m.esc.s), m.esc.v);
    assert.deepStrictEqual(parseKV(m.parseKV.s), m.parseKV.v);
  });
});

describe("寻路/行军/时间轴范围一致", () => {
  const R = golden.route;
  // 场景网格重建：与旧 buildGrid 同源（网格本身已由 buildGrid 平价锁定）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const grids: Record<string, any> = {};
  for (const [k, v] of Object.entries<any>(R.worlds)) {
    const grid = buildGridCells(v.world.meta, v.world.terrainOverrides, v.yearNow);
    grids[k] = { meta: v.world.meta, grid, roads: roadCellSet(v.world.nodes, v.world.edges, v.yearNow, grid), world: v.world, yearNow: v.yearNow };
  }
  it("astar（官道/同格/水军走廊/不可达）", () => {
    for (const c of R.astar) {
      const G = grids[c.world];
      assert.deepStrictEqual(JSON.parse(JSON.stringify(astar(G.meta, G.grid, G.roads, c.s, c.g, c.arm) ?? null)), c.res, c.name);
    }
  });
  it("cellCost / cellCenter / lonlatToCell", () => {
    const G = grids.R;
    for (const s of R.cellHelpers.cost) {
      const v = cellCost(G.grid, G.roads, s.r, s.c, s.arm);
      assert.deepStrictEqual(isFinite(v) ? v : "Infinity", s.v);
    }
    for (const s of R.cellHelpers.center) assert.deepStrictEqual(cellCenter(G.grid, s.r, s.c), s.v);
    for (const s of R.cellHelpers.toCell) assert.deepStrictEqual(lonlatToCell(G.grid, s.lon, s.lat), s.v);
  });
  it("computeRoute（陆/空/水，含沿途报告）", () => {
    for (const c of R.computeRoute) {
      const G: any = grids[c.world];
      const byId = (id: string) => G.world.nodes.find((n: any) => n.id === id);
      const res = computeRoute(G.meta, G.grid, G.roads, G.world, G.yearNow,
        { lon: c.A.lon, lat: c.A.lat, node: byId(c.A.nodeId) }, { lon: c.B.lon, lat: c.B.lat, node: byId(c.B.nodeId) }, c.arm);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(res)), c.route, c.arm);
    }
  });
  it("unitLegs（骑兵超速/水师回退直线/飞舟/零间隔）", () => {
    const G: any = grids.R;
    for (const c of R.unitLegs) {
      const u = { id: c.id, kind: c.kind, speed: c.speed, track: clone(c.track) };
      assert.deepStrictEqual(JSON.parse(JSON.stringify(unitLegs(G.meta, G.grid, G.roads, u as never))), c.legs, c.id);
    }
  });
  it("yearRangeOf ↔ updateYearRange", () => {
    for (const c of R.yearRange) {
      const r = yearRangeOf(c.world, c.yearBefore);
      assert.deepStrictEqual({ min: r.min, max: r.max, year: r.year }, { min: c.min, max: c.max, year: c.yearAfter }, c.name);
    }
  });
});
