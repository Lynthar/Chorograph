/* 滩带的离水场（render/beach.bandField）：每格两项——还在带内多少格、那片水的水面。
   夹具是 40×40 格、0.1°/格的纯平原图，按需涂一片海、一个湖或一个单格的水塘 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGridCells, type Grid } from "../src/core/grid.ts";
import { buildSurface, waterSurface } from "../src/core/elev.ts";
import { bandAt, bandField } from "../src/render/beach.ts";
import { FX, beachK } from "../src/render/material.ts";
import type { HeightOverride, Meta, TerrainOverride } from "../src/core/types.ts";

const N = 40;
const M: Meta = { worldModel: "flat", terrain: "plain", gridN: N, bbox: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 } };
const wt = (c: number, r: number): TerrainOverride => ({ lon: 100.05 + c * 0.1, lat: 30.05 + r * 0.1, t: "water" });
const block = (c0: number, r0: number, c1: number, r1: number): TerrainOverride[] => {
  const o: TerrainOverride[] = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) o.push(wt(c, r));
  return o;
};
const field = (ov: TerrainOverride[]): { g: Grid; b: Float32Array; ws: Float32Array } => {
  const g = buildGridCells(M, ov, 0), ws = waterSurface(M, g);
  assert.strictEqual(g.cols, N); assert.strictEqual(g.rows, N);
  return { g, b: bandField(g, ws), ws };
};
const m = (b: Float32Array, c: number, r: number): number => b[(r * N + c) * 2];
const s = (b: Float32Array, c: number, r: number): number => b[(r * N + c) * 2 + 1];
const near = (a: number, b: number, msg?: string): void => assert.ok(Math.abs(a - b) < 1e-5, `${msg || ""} ${a} ≠ ${b}`);

describe("滩带的离水场（render/beach）", () => {
  it("大水体：带内格数＝带宽上限 − 离水格数，一路减到带外", () => {
    const { b } = field(block(0, 0, 19, N - 1));   // 西半幅是水，岸在 19 | 20 列之间
    for (let d = 1; d <= 10; d++) near(m(b, 19 + d, 20), FX.beachW - d, `离水 ${d} 格`);
    for (let d = 11; d <= 20; d++) assert.ok(m(b, 19 + d, 20) < 0, "带外是负的有限值");
    assert.ok(m(b, 19 + 7, 20) >= FX.beachFade && beachK(m(b, 19 + 7, 20), 0) === 1, "离水 7 格还是满的");
    assert.strictEqual(beachK(m(b, 19 + 9, 20), 0), 0, "离水 9 格在带外");
    near(m(b, 5, 20), FX.beachW, "水格自己取上限");
  });
  it("斜向按欧氏距离：离岸角 (3, 4) 格的陆格算 5 格", () => {
    const { b } = field(block(0, 0, 9, 9));
    near(m(b, 12, 13), FX.beachW - 5);
    near(m(b, 13, 12), FX.beachW - 5);
  });
  it("内陆湖的带宽上限比海窄：十一格见方的湖也只到 beachLakeW 格", () => {
    const { b, ws } = field(block(14, 14, 24, 24));
    assert.ok(ws[19 * N + 19] > 0.1, "不碰图幅边＝内陆湖，水面不在 0");
    near(m(b, 25, 19), FX.beachLakeW - 1);
    near(m(b, 19, 19), FX.beachLakeW, "水格自己取上限");
    assert.ok(m(b, 24 + Math.ceil(FX.beachLakeW) + 1, 19) < 0);
    assert.ok(FX.beachLakeW < FX.beachW);
  });
  it("小水体的带宽不超过水体里离陆地最远的那格到陆地的格数：单格水塘只有一圈淡边，三格宽的湖到两格", () => {
    const pond = field([wt(20, 20)]).b;
    near(m(pond, 21, 20), 0, "水塘邻格在带的外沿");
    assert.ok(m(pond, 22, 20) < 0);
    const lake = field(block(19, 19, 21, 21)).b;   // 3×3：中心格离陆地 2 格
    near(m(lake, 22, 20), 1);
    near(m(lake, 23, 20), 0);
    assert.ok(m(lake, 24, 20) < 0);
  });
  it("大水体旁边的小水塘不在大水体的带上咬出缺口", () => {
    const { b } = field([...block(0, 0, 19, N - 1), wt(23, 20)]);
    for (let c = 20; c <= 26; c++) if (c !== 23) near(m(b, c, 20), FX.beachW - (c - 19), `第 ${c} 列`);
    near(m(b, 23, 21), FX.beachW - 4, "水塘正下方的陆格仍按大水体算");
  });
  it("第二项是那片水的水面：海 0，内陆湖取它的水面", () => {
    const { b, ws, g } = field([...block(0, 0, 5, N - 1), ...block(24, 14, 34, 24)]);   // 西边一条碰图幅边的海，东边一个内陆湖
    const lakeWs = ws[20 * N + 28];
    assert.ok(lakeWs > 0.1, "内陆湖不在海平面");
    assert.strictEqual(s(b, 7, 20), 0, "海边的陆格");
    assert.strictEqual(s(b, 22, 20), lakeWs, "湖边的陆格");
    assert.strictEqual(s(b, 36, 20), lakeWs);
    /* 岸被整圈涂低、湖面跟着降：新水面是新数组，场跟着换 */
    const hov: HeightOverride[] = [];
    for (let r = 12; r <= 26; r++) for (let c = 22; c <= 36; c++) if (g.cells[r][c] !== "water") hov.push({ lon: 100.05 + c * 0.1, lat: 30.05 + r * 0.1, dh: -0.05 });
    const sf = buildSurface(M, hov, g, 0), b2 = bandField(g, sf.wsurf);
    assert.notStrictEqual(sf.wsurf, ws);
    assert.notStrictEqual(b2, b);
    near(s(b2, 22, 20), lakeWs - 0.05);
    assert.strictEqual(m(b2, 22, 20), m(b, 22, 20), "离水几何不随水面变");
  });
  it("没有水＝处处在带外；同一对（网格, 水面）拿到同一个数组", () => {
    const { g, b, ws } = field([]);
    for (let i = 0; i < N * N; i++) assert.ok(b[i * 2] < 0 && b[i * 2 + 1] === 0);
    assert.strictEqual(bandField(g, ws), b);
    const { g: g2, b: b2, ws: ws2 } = field(block(0, 0, 19, N - 1));
    assert.strictEqual(bandField(g2, ws2), b2);
  });
  it("只涂了陆地的新网格：场与原来逐格相同", () => {
    const sea = block(0, 0, 19, N - 1);
    const a = field(sea).b, c = field([...sea, { lon: 103.05, lat: 33.05, t: "hill" }]).b;
    assert.notStrictEqual(a, c);
    assert.deepStrictEqual(c, a);
  });
  it("双线性取样：格心取格值、两格之间线性、出格取边格", () => {
    const { b } = field(block(0, 0, 19, N - 1)), o = new Float64Array(2);
    bandAt(b, N, N, 22, 20, o); near(o[0], FX.beachW - 3);
    bandAt(b, N, N, 22.5, 20, o); near(o[0], FX.beachW - 3.5);
    bandAt(b, N, N, 19.5, 20, o); near(o[0], FX.beachW - 0.5, "岸线上");
    bandAt(b, N, N, N + 3, 20, o); near(o[0], m(b, N - 1, 20));
    bandAt(b, N, N, 22, -2, o); near(o[0], m(b, 22, 0));
  });
});
