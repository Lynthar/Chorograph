/* 分块精修（core/tiles）：粗级切割量可注入、块拼起来就是全图同档的场、涂改只让邻近的块换键、跨块取样与等待窗合成对得上 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGridCells } from "../src/core/grid.ts";
import { erodeCarve, erodeField, erodeInput, erodeKey, type ErodeInput } from "../src/core/erode.ts";
import { applyDelta, deltaOf, elevBilinear } from "../src/core/elev.ts";
import { TILE_MAX_X, tileCells, tileCore, tileElevAt, tileField, tileInput, tilePlan, tileWeight, type TileLayer } from "../src/core/tiles.ts";
import type { HeightOverride, Meta, TerrainOverride } from "../src/core/types.ts";

/* 100×67 格的战略图：平原底、中部一片山地（起伏只长在山上）、西南角几块水；工作档 8×＝块倍率上限 */
const META: Meta = { terrain: "plain", relief: 0.7, gridN: 100, bbox: { lonMin: 100, lonMax: 115, latMin: 30, latMax: 40 } };
const probe = buildGridCells(META, [], 0), ST = probe.step, BB = probe.bb;
const OV: TerrainOverride[] = [];
for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) OV.push({ lon: BB.lonMin + (30 + i * 6) * ST, lat: BB.latMin + (20 + j * 6) * ST, t: "mountain", step: ST * 6 });
for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) OV.push({ lon: BB.lonMin + (2 + i * 8) * ST, lat: BB.latMin + (2 + j * 8) * ST, t: "water", step: ST * 8 });
const GRID = buildGridCells(META, OV, 0);
const input = (hov: HeightOverride[] = []): ErodeInput => erodeInput(META, hov, GRID, 0)!;
const INP = input(), FULL = erodeField(INP), CARVE = erodeCarve(INP)!;
const PLAN = tilePlan(INP, 1e12, 0)!;

describe("分块精修（core/tiles）", () => {
  it("注入 erodeCarve 的切割量＝全图自己算的那份：输出逐位相同", () => {
    const sc = [(BB.lonMin + BB.lonMax) / 2, (BB.latMin + BB.latMax) / 2] as const;
    const f = erodeField({ ...INP, win: { carve: CARVE, refS: INP.bandS, sc, coast: false } });
    assert.ok(f.data.every((v, i) => v === FULL.data[i]), "注入切割量后场变了");
  });

  it("计划：倍率封顶 TILE_MAX_X、按预算降档、不比现有画面场细就不分块；全是水的块不算", () => {
    assert.strictEqual(PLAN.geom.sx, TILE_MAX_X);
    assert.deepStrictEqual(PLAN.tiles, [0, 1, 2, 3]);
    const land = GRID.cols * GRID.rows;
    assert.strictEqual(tilePlan(INP, land * 9.5, 0)!.geom.sx, 3, "预算只够 3 倍");
    assert.strictEqual(tilePlan(INP, 1e12, TILE_MAX_X), null, "画面场已经这么细");
    const water = INP.water.slice(), { c0, r0, c1, r1 } = tileCells(PLAN.geom, 0);
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) water[r * GRID.cols + c] = 1;
    assert.deepStrictEqual(tilePlan({ ...INP, water }, 1e12, 0)!.tiles, [1, 2, 3]);
  });

  it("各块单独侵蚀再拼起来＝全图同档的场（块心之外的余量够细级用）", () => {
    const sc = [(BB.lonMin + BB.lonMax) / 2, (BB.latMin + BB.latMax) / 2] as const;
    const FULL = erodeField({ ...INP, win: { carve: CARVE, refS: 1, sc, coast: true } });   // 同语义的全图窗口单（夹具工作档恰是 8×）
    const tiles = new Map<number, Float32Array>();
    for (const i of PLAN.tiles) tiles.set(i, tileCore(erodeField(tileInput(INP, PLAN, CARVE, i)), PLAN, i));
    const L: TileLayer = { geom: PLAN.geom, tiles }, ds: number[] = [];
    for (let r = 0; r < FULL.rows; r++) for (let c = 0; c < FULL.cols; c++) {
      const v = tileElevAt(L, FULL.bb.lonMin + (c + 0.5) * FULL.step, FULL.bb.latMin + (r + 0.5) * FULL.step);
      ds.push(Math.abs(v - FULL.data[r * FULL.cols + c]));
    }
    ds.sort((a, b) => a - b);
    assert.ok(!ds.some(Number.isNaN), "块层上有洞");
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length, p99 = ds[Math.floor(ds.length * 0.99)];
    assert.ok(mean < 5e-4 && p99 < 5e-3, `拼块与全图差太大：均值 ${mean} p99 ${p99}（场的标准差约 0.28）`);
  });

  it("子格海岸线：水陆交界的父格里细格有水有陆（不照搬父格＝不再是方台阶）；不开时整格一致", () => {
    const sc = [(BB.lonMin + BB.lonMax) / 2, (BB.latMin + BB.latMax) / 2] as const, ws = INP.wsurf;
    const mixed = (coast: boolean): number => {
      const f = erodeField({ ...INP, win: { carve: CARVE, refS: 1, sc, coast } }), sx = f.cols / GRID.cols;
      let n = 0;
      for (let r = 0; r < GRID.rows; r++) for (let c = 0; c < GRID.cols; c++) {
        let w = 0;
        for (let y = 0; y < sx; y++) for (let x = 0; x < sx; x++) if (f.data[(r * sx + y) * f.cols + c * sx + x] < ws[r * GRID.cols + c] - 0.02) w++;
        if (w > 0 && w < sx * sx) n++;
      }
      return n;
    };
    assert.strictEqual(mixed(false), 0);
    assert.ok(mixed(true) > 20, "交界父格里应有细格级的岸线");
  });

  it("一处涂改只让窗口碰到它的块换键（切割量量化后远处的位级扰动不算数）", () => {
    const keys = (inp: ErodeInput) => { const p = tilePlan(inp, 1e12, 0)!, cv = erodeCarve(inp)!; return p.tiles.map(i => erodeKey(tileInput(inp, p, cv, i))); };
    const k0 = keys(INP), k1 = keys(input([{ lon: BB.lonMin + 85.5 * ST, lat: BB.latMin + 50.5 * ST, dh: 0.3 }]));
    assert.deepStrictEqual(k0.map((k, i) => k !== k1[i]), [false, true, false, true]);
  });

  it("跨块取样：块内与全图同式双线性；四角缺一块＝NaN", () => {
    const g = PLAN.geom, tiles = new Map<number, Float32Array>();
    const geoFine = { bb: FULL.bb, step: FULL.step, cols: FULL.cols, rows: FULL.rows };
    for (const i of PLAN.tiles) {   // 块心直接从全图场抠：取样结果应与全图双线性一致
      const { c0, r0, c1, r1 } = tileCells(g, i), w = (c1 - c0) * g.sx, h = (r1 - r0) * g.sx, a = new Float32Array(w * h);
      for (let r = 0; r < h; r++) a.set(FULL.data.subarray((r0 * g.sx + r) * FULL.cols + c0 * g.sx, (r0 * g.sx + r) * FULL.cols + c0 * g.sx + w), r * w);
      tiles.set(i, a);
    }
    const L: TileLayer = { geom: g, tiles };
    for (const [lon, lat] of [[101.3, 31.1], [109.6, 36.6], [BB.lonMin + 64 * ST, BB.latMin + 64 * ST + 1e-4], [BB.lonMax - 1e-6, BB.latMax - 1e-6]]) {
      const want = elevBilinear(FULL.data, geoFine, lon, lat), got = tileElevAt(L, lon, lat);
      assert.ok(Math.abs(got - want) < 1e-6, `(${lon},${lat}) ${got} vs ${want}`);
    }
    const holes: TileLayer = { geom: g, tiles: new Map([...tiles].filter(([i]) => i !== 3)) };
    assert.ok(Number.isNaN(tileElevAt(holes, BB.lonMin + 64 * ST, BB.latMin + 64 * ST)), "跨到缺失的块必须报缺");
    assert.ok(!Number.isNaN(tileElevAt(holes, BB.lonMin + 10 * ST, BB.latMin + 10 * ST)));
  });

  it("等待窗合成施到一块上＝施到全图再取这一块；补丁碰不到的块原样返回", () => {
    const now = new Float32Array(GRID.cols * GRID.rows), base = now.slice();
    for (let r = 40; r < 44; r++) for (let c = 80; c < 84; c++) now[r * GRID.cols + c] = 0.25;
    const d = deltaOf(base, now, GRID)!, g = PLAN.geom;
    const whole = applyDelta(FULL, d, now, GRID);
    for (const i of PLAN.tiles) {
      const { c0, r0, c1, r1 } = tileCells(g, i), w = (c1 - c0) * g.sx, h = (r1 - r0) * g.sx, a = new Float32Array(w * h);
      for (let r = 0; r < h; r++) a.set(FULL.data.subarray((r0 * g.sx + r) * FULL.cols + c0 * g.sx, (r0 * g.sx + r) * FULL.cols + c0 * g.sx + w), r * w);
      const tf = tileField(g, i, a), out = applyDelta(tf, d, now, GRID);
      if (i === 0) { assert.strictEqual(out, tf, "西南块碰不到补丁"); continue; }
      let mx = 0;
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) mx = Math.max(mx, Math.abs(out.data[r * w + c] - whole.data[(r0 * g.sx + r) * FULL.cols + c0 * g.sx + c]));
      assert.ok(mx < 1e-6, `块 ${i} 与全图合成差 ${mx}`);
    }
  });

  it("权重随一个块格的 CSS 像素连续过渡：半像素以下不用、一像素起全用", () => {
    assert.strictEqual(tileWeight(0.4), 0);
    assert.strictEqual(tileWeight(1.2), 1);
    let prev = -1;
    for (let v = 0.5; v <= 1; v += 0.05) { const w = tileWeight(v); assert.ok(w >= prev); prev = w; }
  });
});
