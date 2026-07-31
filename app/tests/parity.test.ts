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
    /* ELEV：森林/荒漠的示意高程 sanctioned 重基线到**平原值**——两轴模型下生态不带高程偏置
       （分类器里 forest/desert 与 plain 同属「低地·中地按湿度分」的同一高度带，旧 0.28/0.22 系
       单轴时代把二者当地类排在平原–丘陵之间的残留）。右式由 golden.plain 推出：其余键、以及
       plain 自身漂移照红。 */
    assert.deepStrictEqual(C.ELEV, { ...g.ELEV, forest: g.ELEV.plain, desert: g.ELEV.plain });
    assert.strictEqual(C.ECO.forest.elevBias, 0, "森林生态不施高程偏置（新组合路径与 ELEV 同源）");
    assert.strictEqual(C.ECO.desert.elevBias, 0, "荒漠生态不施高程偏置（新组合路径与 ELEV 同源）");
    assert.strictEqual(C.ECO.marsh.elevBias, g.ELEV.marsh - g.ELEV.plain, "沼泽低洼保留（两路径同幅）");
    assert.deepStrictEqual(C.TINT, g.TINT);
    assert.strictEqual(C.PD, g.PD);
  });
  it("图层/预设/布景", () => {
    // LAYERS：新增 "notes"/"vision"/"wall"（柱B 工事）、移除 "eco"（自动生态点缀改为生态笔刷落真实印章）后与旧版逐位一致
    assert.deepStrictEqual(C.LAYERS.filter(l => l.id !== "notes" && l.id !== "vision" && l.id !== "wall"), g.LAYERS.filter((l: { id: string }) => l.id !== "eco"));
    assert.strictEqual(C.LAYERS.filter(l => l.id === "notes").length, 1);
    assert.strictEqual(C.LAYERS.filter(l => l.id === "vision").length, 1);
    assert.strictEqual(C.LAYERS.filter(l => l.id === "wall").length, 1);
    assert.strictEqual(C.LAYERS.find(l => l.id === "eco"), undefined, "eco 自动点缀层已移除（生态改由笔刷落真实印章）");
    assert.strictEqual(C.LAYERS.find(l => l.id === "vision")!.tacOnly, true, "vision 应为战术图专属");
    assert.strictEqual(C.LAYERS.find(l => l.id === "wall")!.tacOnly, undefined, "工事不设 tacOnly（长城属战略语汇）");
    // PRESETS：每个预设剔除新增 notes/vision/wall、移除 eco 后与旧版一致；标注全预设开、视野与工事按白名单
    assert.deepStrictEqual(Object.keys(C.PRESETS), Object.keys(g.PRESETS));
    for (const k of Object.keys(C.PRESETS)) {
      // 战术预设另剔 contour（2026-07 特化 P0 白名单：战场地文=棱线/凹路,等高线默认开）——只豁免战术,地理/全部的 contour 漂移照红
      assert.deepStrictEqual(stripKeys(C.PRESETS[k], k === "战术" ? ["notes", "vision", "contour", "wall"] : ["notes", "vision", "wall"]), stripKeys(g.PRESETS[k], ["eco"]), `预设「${k}」旧键漂移`);
      assert.strictEqual(C.PRESETS[k].notes, 1, `预设「${k}」应含标注层`);
      assert.strictEqual(C.PRESETS[k].eco, undefined, `预设「${k}」eco 已移除`);
      assert.strictEqual(C.PRESETS[k].vision, ["军事", "战术", "全部"].includes(k) ? 1 : undefined, `预设「${k}」vision 白名单`);
      assert.strictEqual(C.PRESETS[k].wall, ["军事", "战术", "全部"].includes(k) ? 1 : undefined, `预设「${k}」wall 白名单（柱B）`);
    }
    assert.strictEqual(C.PRESETS.战术.contour, 1, "战术预设应含等高线（白名单成员须真在,防豁免空转）");
    assert.deepStrictEqual(C.DECOR, g.DECOR);
  });
  it("地点/事件类型与模板", () => {
    // NODE_STYLE/NODE_TYPES/NODE_TMPL：剔除新增 "label"（v0.15）与柱B 微地物六类后与旧版逐位一致
    const NEW_NODE_TYPES = ["label", "camp", "pass", "bridge", "summit", "manor", "site"];
    assert.deepStrictEqual(stripKeys(C.NODE_STYLE, NEW_NODE_TYPES), g.NODE_STYLE);
    for (const t of NEW_NODE_TYPES) assert.ok(C.NODE_STYLE[t], `新增类型「${t}」应存在（防豁免空转）`);
    assert.deepStrictEqual(C.NODE_TYPES.filter(t => !NEW_NODE_TYPES.includes(t)), g.NODE_TYPES);
    assert.deepStrictEqual(C.LEGACY_TYPE, g.LEGACY_TYPE);
    assert.deepStrictEqual(C.EVENT_TYPES, g.EVENT_TYPES);
    assert.deepStrictEqual(stripKeys(C.NODE_TMPL, NEW_NODE_TYPES), g.NODE_TMPL);
    assert.deepStrictEqual(C.EVENT_TMPL, g.EVENT_TMPL);
    assert.deepStrictEqual(C.RANK_ZOOM.map(v => (isFinite(v) ? v : "Infinity")), g.RANK_ZOOM);
  });
  it("连线/速度/兵种", () => {
    // EDGE_STYLE/UNIT_KINDS：剔除柱B 新增 "wall"/"cmd" 后与旧版逐位一致
    assert.deepStrictEqual(stripKeys(C.EDGE_STYLE, ["wall"]), g.EDGE_STYLE);
    assert.ok(C.EDGE_STYLE.wall, "柱B 工事线型应存在（防豁免空转）");
    assert.strictEqual(C.RIVER_TMPL, g.RIVER_TMPL);
    assert.deepStrictEqual(C.SPEEDS, g.SPEEDS);
    /* UNIT_KINDS：2026-07-30 整表换代为通用十一类（用户点单）＝对黄金基准的 sanctioned 偏离。
       逐位比对换成「每个旧键仍解析得到，且速度档与军种一分不差」——换表唯一不能破的是旧档的行军账房。
       ⚠ 映射在此**另写一份**字面表，与 constants 的 LEGACY_KIND 互为对证（同表自证等于没测）。 */
    const UP: Record<string, string> = { inf: "linf", cav: "lcav", bow: "rng", sup: "log", mage: "spec" };   // air 原样存活＝旧「飞舟」即新「飞行部队」
    for (const [old, gk] of Object.entries(g.UNIT_KINDS as Record<string, { v: number; arm: string }>)) {
      const to = UP[old] || old, lg = C.LEGACY_KIND[old];
      assert.ok(C.UNIT_KINDS[to], `旧兵种「${old}」应解析到新表的「${to}」`);
      assert.strictEqual(lg ? lg.to : old, to, `旧兵种「${old}」的迁移目标`);
      assert.strictEqual(lg ? lg.v : C.UNIT_KINDS[to].v, gk.v, `旧兵种「${old}」速度档须保住`);
      assert.strictEqual(lg ? lg.arm : C.UNIT_KINDS[to].arm, gk.arm, `旧兵种「${old}」军种须保住`);
    }
    assert.strictEqual(Object.keys(C.UNIT_KINDS).length, 13, "新表恰十三类（防豁免空转）");
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
      const rc = [...roadCellSet(gc.nodes, gc.edges, gc.yearNow, g)].sort();
      if (g.step >= 1) {
        assert.deepStrictEqual(rc, gc.roadCells);   // 战略 1° 网格：官道格与黄金逐位一致（N=40 不变）
      } else {
        /* sanctioned（2026-07 战术特化 P0）：战术细网格官道采样由定数 40 段改为按跨格数加密——
           黄金冻结的是**漏格**输出（对角官道 13,14→15,16 跳过线经的 14,14/14,15/15,15，
           约 2/3 沿线格未标记，官道减速带断续、A* 不认路）。⚠ 本用例道路恰穿 15 个精确格角
           （中点 (101,30.7) 即格点），采样落在角上的取整是浮点伪影（黄金的 48,70 属此类）——
           故守卫按几何而非逐位：线段∩格矩形（Liang-Barsky），收缩 ε＝「实穿」、外扩 ε＝「沿线」。
           ① 黄金里被实穿的格必须全保（只准丢角擦伪影）；② 新集不得含线外格；
           ③ 4× 过采样发现的实穿格必须全在（防仍漏格）。 */
        const byId = (id: string) => gc.nodes.find((n: { id: string }) => n.id === id);
        const segs = gc.edges.filter((e: { type: string; since?: number; until?: number }) => e.type === "road" && activeAt(e, gc.yearNow))
          .map((e: { from: string; to: string }) => [byId(e.from), byId(e.to)]).filter((p: unknown[]) => p[0] && p[1]);
        const hits = (r: number, c: number, e: number): boolean => segs.some(([a, b]: { lon: number; lat: number }[]) => {
          const x0 = g.bb.lonMin + c * g.step - e, x1 = g.bb.lonMin + (c + 1) * g.step + e;
          const y0 = g.bb.latMin + r * g.step - e, y1 = g.bb.latMin + (r + 1) * g.step + e;
          let t0 = 0, t1 = 1;
          const dx = b.lon - a.lon, dy = b.lat - a.lat;
          const clip = (p: number, q: number): boolean => {
            if (p === 0) return q >= 0;
            const t = q / p;
            if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
            else { if (t < t0) return false; if (t < t1) t1 = t; }
            return true;
          };
          return clip(-dx, a.lon - x0) && clip(dx, x1 - a.lon) && clip(-dy, a.lat - y0) && clip(dy, y1 - a.lat) && t0 <= t1;
        });
        const EPS = g.step * 1e-6;
        const cell = (k: string): [number, number] => { const [r, c] = k.split(",").map(Number); return [r, c]; };
        for (const k of gc.roadCells) {
          const [r, c] = cell(k);
          if (hits(r, c, -EPS)) assert.ok(rc.includes(k), `黄金实穿格 ${k} 不得丢失`);
        }
        for (const k of rc) { const [r, c] = cell(k); assert.ok(hits(r, c, EPS), `官道格 ${k} 不在线上`); }
        for (const [a, b] of segs) {
          const M = Math.ceil((Math.abs(b.lon - a.lon) + Math.abs(b.lat - a.lat)) / (g.step / 4)) || 1;
          for (let i = 0; i <= M; i++) {
            const lon = a.lon + (b.lon - a.lon) * i / M, lat = a.lat + (b.lat - a.lat) * i / M;
            const r = Math.floor((lat - g.bb.latMin) / g.step), c = Math.floor((lon - g.bb.lonMin) / g.step);
            if (hits(r, c, -EPS)) assert.ok(rc.includes(r + "," + c), `实穿格 ${r},${c} 漏标`);
          }
        }
      }
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
    /* 2026-07-30 兵种换代：normalizeWorld 现把旧兵种键就地升级（同 LEGACY_TYPE 之例），旧速度/军种与
       新键不同者落成显式键。golden 侧期望按**另写的**字面映射改造，其余任何漂移照红。 */
    const UP: Record<string, { kind: string; speed?: number }> = {
      inf: { kind: "linf" }, cav: { kind: "lcav" }, bow: { kind: "rng" },
      sup: { kind: "log" }, mage: { kind: "spec", speed: 150 }   // air 原样存活，不在迁移表内
    };
    for (const c of g.normalize) {
      const want = clone(c.output) as { units?: Record<string, unknown>[] };
      (want.units || []).forEach(u => {
        const up = UP[String(u.kind)];
        if (!up) return;
        u.kind = up.kind;
        if (up.speed != null && !(+(u.speed as number) > 0)) u.speed = up.speed;
      });
      assert.deepStrictEqual(JSON.parse(JSON.stringify(normalizeWorld(clone(c.input)))), want);
    }
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
      /* 2026-07-30 兵种换代：夹具用的是旧兵种键，而旧档进画布必经 normalizeWorld 升级——这里就走那条真实路径。
         断言仍是腿账逐位一致，即「换表不动行军账房」这条硬承诺（改写期望反而测不出它）。 */
      const raw = { id: c.id, kind: c.kind, speed: c.speed, track: clone(c.track) };
      const u = normalizeWorld({ meta: {}, units: [raw] }).units[0];
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
