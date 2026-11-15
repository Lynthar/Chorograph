/* 高程场与水面同一次算出（core/elev.buildSurface）：水面由岸定，陆地高程由涂改定。
   夹具是 8×8 格、1°/格的纯平原图（基底处处 0.16，粗格上包络与模糊都不起作用），按需涂一片海或一个两格的湖 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGridCells, type Grid } from "../src/core/grid.ts";
import { baseElev, buildElevField, buildSurface, fieldPlusDelta, waterSurface, LAND_FLOOR, NO_WATER, SHORE_LAND } from "../src/core/elev.ts";
import { erodeField, erodeInput, erodeKey } from "../src/core/erode.ts";
import type { HeightOverride, Meta, TerrainOverride } from "../src/core/types.ts";

const M: Meta = { worldModel: "sphere", terrain: "plain", gridN: 8, bbox: { lonMin: 100, lonMax: 108, latMin: 30, latMax: 38 } };
const MR: Meta = { ...M, relief: 0.5 };
const U = 2000, PLAIN = Math.fround(0.16);
const at = (g: Grid, c: number, r: number): number => r * g.cols + c;
const hv = (c: number, r: number, dh: number): HeightOverride => ({ lon: 100.5 + c, lat: 30.5 + r, dh });
const wt = (c: number, r: number): TerrainOverride => ({ lon: 100.5 + c, lat: 30.5 + r, t: "water" });
const near = (a: number, b: number, msg?: string): void => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ""} ${a} ≠ ${b}`);
/** 一个父格里的细格（k 倍）：最低与均值 */
const inCell = (f: { data: Float32Array; cols: number }, g: Grid, c: number, r: number): { lo: number; mean: number } => {
  const k = f.cols / g.cols; let lo = Infinity, s = 0;
  for (let rr = r * k; rr < (r + 1) * k; rr++) for (let cc = c * k; cc < (c + 1) * k; cc++) { const v = f.data[rr * f.cols + cc]; if (v < lo) lo = v; s += v; }
  return { lo, mean: s / (k * k) };
};

describe("陆地高程由涂改定（buildSurface）", () => {
  it("平原上一格压到 10 m 就读 10 m；没碰到水面，水面还是按 Grid 记的那份", () => {
    const g = buildGridCells(M, [], 0), dh = 10 / U - 0.16;
    const sf = buildSurface(M, [hv(3, 3, dh)], g, 0);
    near(sf.field[at(g, 3, 3)], 10 / U);
    assert.strictEqual(sf.wsurf, waterSurface(M, g));
    assert.ok(sf.low);
    near(sf.low[at(g, 3, 3)], dh);
    for (let i = 0; i < sf.field.length; i++) if (i !== at(g, 3, 3)) { assert.strictEqual(sf.field[i], PLAIN); assert.strictEqual(sf.low[i], 0); }
    assert.deepStrictEqual(buildElevField(M, [hv(3, 3, dh)], g, 0), sf.field, "buildElevField 就是它的 field");
  });
  it("没有负涂改＝low 为 null；涂改合计非负的格照旧钳在类型地板上", () => {
    const g = buildGridCells(M, [{ lon: 100.5, lat: 30.5, t: "coast" }], 0);
    const sf = buildSurface(M, [hv(0, 0, 0.3), hv(0, 0, -0.3), hv(5, 5, 0.2)], g, 0);
    assert.strictEqual(sf.low, null);
    near(sf.field[at(g, 5, 5)], 0.36);
    near(sf.field[at(g, 0, 0)], 0.06, "沿海格一加一减回到自身基础");
  });
  it("起伏挖不穿类型地板；涂改把地板一起带下去（与没涂过的邻格连续）", () => {
    const S: Meta = { worldModel: "sphere", terrain: "sample", genSeed: 7, relief: 1, bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 } };
    const g = buildGridCells(S, [], 3107), base = baseElev(S, g), ws = waterSurface(S, g);
    const u = buildElevField(S, undefined, g, 3107), dh = -0.03;
    const sf = buildSurface(S, [{ lon: 106, lat: 38, dh, step: 64 }], g, 3107);   // 一枚粗块盖满全图
    let floored = 0, checked = 0;
    for (let r = 1; r < g.rows - 1; r++) for (let c = 1; c < g.cols - 1; c++) {
      const i = at(g, c, r);
      if (g.cells[r][c] === "water" || ws[i] !== 0 || u[i] + dh <= 0) continue;   // 只看不挨水、涂后仍在海面以上的陆格
      let lone = true;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (g.cells[r + dr][c + dc] === "water") lone = false;
      if (!lone) continue;
      near(sf.field[i], u[i] + dh);
      if (u[i] === Math.fround(Math.min(LAND_FLOOR, base[i]))) floored++;
      checked++;
    }
    assert.ok(checked > 100 && floored > 0, `夹具里要有被起伏压到地板上的格（${floored} / ${checked}）`);
  });
});

describe("低于海面的干地与海岸（buildSurface）", () => {
  it("不挨水的陆格涂到海面以下＝干地：它与八邻记 NO_WATER，高程照涂", () => {
    const g = buildGridCells(M, [], 0), sf = buildSurface(M, [hv(3, 3, -0.4)], g, 0);
    near(sf.field[at(g, 3, 3)], 0.16 - 0.4);
    assert.notStrictEqual(sf.wsurf, waterSurface(M, g));
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++)
      assert.strictEqual(sf.wsurf[at(g, c, r)], Math.abs(c - 3) <= 1 && Math.abs(r - 3) <= 1 ? NO_WATER : 0, `(${c},${r})`);
    assert.strictEqual(sf.field[at(g, 2, 3)], PLAIN, "邻格高程不动");
  });
  it("紧挨着海的陆格不低于海面；隔一格可以，挨海的那一圈照旧记海面", () => {
    const sea = Array.from({ length: 8 }, (_, r) => wt(0, r));
    const g = buildGridCells(M, sea, 0), ws0 = waterSurface(M, g);
    const a = buildSurface(M, [hv(1, 3, -0.4)], g, 0);
    assert.strictEqual(a.field[at(g, 1, 3)], 0);
    assert.strictEqual(a.wsurf, ws0, "海不动，水面数组还是记忆的那份");
    const b = buildSurface(M, [hv(2, 3, -0.4)], g, 0);
    near(b.field[at(g, 2, 3)], 0.16 - 0.4);
    assert.strictEqual(b.wsurf[at(g, 2, 3)], NO_WATER);
    for (const r of [2, 3, 4]) { assert.strictEqual(b.wsurf[at(g, 1, r)], 0, "挨海的岸格"); assert.strictEqual(b.wsurf[at(g, 3, r)], NO_WATER); }
    assert.strictEqual(b.wsurf[at(g, 0, 3)], 0, "海");
  });
});

describe("湖面跟岸走（buildSurface）", () => {
  const LAKE = [wt(3, 3), wt(4, 3)];
  const SIDE: [number, number][] = [[2, 3], [5, 3], [3, 2], [4, 2], [3, 4], [4, 4]], DIAG: [number, number][] = [[2, 2], [5, 2], [2, 4], [5, 4]];
  const g = buildGridCells(M, LAKE, 0), ws0 = waterSurface(M, g), f0 = buildElevField(M, undefined, g, 0);
  const L = at(g, 3, 3);
  it("夹具：内陆湖水面＝岸线最低陆格的类型高程，岸格记湖面", () => {
    assert.strictEqual(ws0[L], PLAIN);
    for (const [c, r] of [...SIDE, ...DIAG]) assert.strictEqual(ws0[at(g, c, r)], PLAIN);
    assert.strictEqual(ws0[at(g, 0, 0)], 0);
  });
  it("挖低一处岸：湖面降到那里，水格床面跟着平移，别的岸不动", () => {
    const sf = buildSurface(M, [hv(2, 3, -0.1)], g, 0), v = sf.field[at(g, 2, 3)];
    near(v, 0.06);
    assert.strictEqual(sf.wsurf[L], v);
    assert.strictEqual(sf.wsurf[at(g, 4, 3)], v);
    for (const [c, r] of [...SIDE, ...DIAG]) assert.strictEqual(sf.wsurf[at(g, c, r)], v, "岸格记新湖面");
    near(sf.field[L], f0[L] - 0.1);
    assert.strictEqual(sf.field[at(g, 5, 3)], PLAIN);
    assert.strictEqual(sf.wsurf[at(g, 0, 0)], 0);
  });
  it("只抬一段岸：还有没涂过的岸，湖面不动", () => {
    assert.strictEqual(buildSurface(M, [hv(2, 3, 0.2)], g, 0).wsurf, ws0);
    assert.strictEqual(buildSurface(M, SIDE.map(([c, r]) => hv(c, r, 0.2)), g, 0).wsurf, ws0, "四邻全抬、对角的岸还在原处");
  });
  it("整圈岸都抬了：湖面跟着升", () => {
    const sf = buildSurface(M, [...SIDE, ...DIAG].map(([c, r]) => hv(c, r, 0.2)), g, 0);
    near(sf.wsurf[L], 0.36);
    near(sf.field[L], f0[L] + 0.2);
    assert.strictEqual(sf.wsurf[L], sf.field[at(g, 2, 3)]);
  });
  it("整圈岸压到 100 m：水面 100 m，岸格都不在水陆判据线以下", () => {
    const sf = buildSurface(M, [...SIDE, ...DIAG].map(([c, r]) => hv(c, r, 100 / U - 0.16)), g, 0);
    near(sf.wsurf[L], 100 / U);
    for (const [c, r] of [...SIDE, ...DIAG]) { const i = at(g, c, r); assert.ok(sf.field[i] >= sf.wsurf[i] + SHORE_LAND); }
  });
  it("湖岸挖到海面以下：湖面跟下去，那一格是岸不是干地", () => {
    const sf = buildSurface(M, [hv(2, 3, -0.3)], g, 0), i = at(g, 2, 3);
    near(sf.field[i], 0.16 - 0.3);
    assert.strictEqual(sf.wsurf[i], sf.field[i]);
    assert.strictEqual(sf.wsurf[L], sf.field[i]);
  });
});

describe("涂低的地在增量合成与侵蚀里都不被抬回类型地板", () => {
  const g = buildGridCells(MR, [], 0), f0 = buildElevField(MR, undefined, g, 0);
  const to10: HeightOverride[] = [];   // 3×3 格压到 10 m：单格的涂改按双线性羽化，只有块心那一格吃满
  for (let c = 2; c <= 4; c++) for (let r = 2; r <= 4; r++) to10.push(hv(c, r, 10 / U - f0[at(g, c, r)]));
  const eBase = erodeField(erodeInput(MR, undefined, g, 0)!);
  it("手动档叠增量（fieldPlusDelta 带 Surface）：那一格落到目标上下，不低于水陆判据线；不带 Surface 仍停在类型地板", () => {
    const sf = buildSurface(MR, to10, g, 0);
    const a = inCell(fieldPlusDelta(eBase, f0, sf.field, g, g.cells, null, null, sf), g, 3, 3);
    assert.ok(a.mean < 0.05 && a.lo >= SHORE_LAND - 1e-6, `均值 ${a.mean * U} m、最低 ${a.lo * U} m`);
    const b = inCell(fieldPlusDelta(eBase, f0, sf.field, g, g.cells), g, 3, 3);
    assert.ok(b.lo >= LAND_FLOOR - 1e-6, `最低 ${b.lo * U} m`);
  });
  it("涂改进侵蚀：压到 10 m 的格侵蚀后还在目标上下", () => {
    const e = inCell(erodeField(erodeInput(MR, to10, g, 0)!), g, 3, 3);
    assert.ok(Math.abs(e.mean - 10 / U) < 10 / U && e.lo >= SHORE_LAND - 1e-6, `均值 ${e.mean * U} m、最低 ${e.lo * U} m`);   // 往下涂的不按涂改幅度加起伏：加了均值掉到海面以下
  });
  it("涂到海面以下的干地：侵蚀输入带 NO_WATER，侵蚀后仍在海面以下", () => {
    const pit: HeightOverride[] = [];
    for (let c = 2; c <= 4; c++) for (let r = 2; r <= 4; r++) pit.push(hv(c, r, -0.5));
    const inp = erodeInput(MR, pit, g, 0)!;
    assert.strictEqual(inp.wsurf[at(g, 3, 3)], NO_WATER);
    const e = inCell(erodeField(inp), g, 3, 3);
    assert.ok(e.mean < -0.2, `均值 ${e.mean * U} m`);
  });
  it("侵蚀输入：涂改没带走湖面时三份数组是按 Grid 记忆的那份；带走了，水面与水格床面一起换、键跟着换", () => {
    const gl = buildGridCells(M, [wt(3, 3), wt(4, 3)], 0), L = at(gl, 3, 3);
    const a = erodeInput(M, [hv(6, 6, 0.1)], gl, 0)!;
    assert.strictEqual(a.wsurf, waterSurface(M, gl));
    assert.strictEqual(a.elev0, baseElev(M, gl));
    const b = erodeInput(M, [hv(6, 6, 0.1), hv(2, 3, -0.1)], gl, 0)!;
    near(b.wsurf[L], 0.06);
    near(b.elev0[L], a.elev0[L] - 0.1);
    assert.strictEqual(b.elev0[at(gl, 6, 6)], a.elev0[at(gl, 6, 6)], "陆格基底不动");
    assert.notStrictEqual(erodeKey(a), erodeKey(b));
  });
});
