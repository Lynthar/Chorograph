/* 气候分区（core/climzone · render/zones）：存档往返、一格一档、查找优先级、v2 派生、战术继承、校验，
   以及渲染端的权重与混合——单档满权重时必须等于该档自己的色阶、林线与雪线（无分区时两端走旧路径）。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { climateAt, encodeZones, paintedZones, zoneField, zoneGeom, zoneIndex, zoneStep, ZONE_MUL } from "../src/core/climzone.ts";
import { gen2Macro, gen2Zones } from "../src/core/gen2.ts";
import { gridStepDeg } from "../src/core/grid.ts";
import { createTacticalWorld } from "../src/core/tactical.ts";
import { validateWorld } from "../src/core/validate.ts";
import { normalizeWorld } from "../src/core/world.ts";
import { CLIMATE, CLIMATE_ORDER } from "../src/core/constants.ts";
import { paintClimatePath } from "../src/app/editops.ts";
import { terrKey } from "../src/app/history.ts";
import { terrainOpts } from "../src/render/renderer.ts";
import { climLook, climRampColor, rampColor, snowSpec, FX } from "../src/render/material.ts";
import { zoneColMix, zoneLooks, zoneTreeMix, zoneWeights, zoneWeightsAt, ZONE_N } from "../src/render/zones.ts";
import type { Meta, World, WorldNode } from "../src/core/types.ts";

const BB = { lonMin: 100, lonMax: 120, latMin: 20, latMax: 40 };
const world = (meta: Partial<Meta> = {}, extra: Partial<World> = {}): World =>
  ({ meta: { bbox: BB, gridN: 200, ...meta }, factions: [], nodes: [], edges: [], decor: [], terrainOverrides: [], units: [], ...extra });
const v2 = (extra: Partial<Meta> = {}): Partial<Meta> =>
  ({ terrain: "auto", genVer: 2, genSeed: 7, genStyle: "mono", worldModel: "sphere", planetRadiusKm: 6371, ...extra });

describe("气候分区：存档与编辑", () => {
  it("分区格边＝地形格边 × ZONE_MUL；栅格与存档往返逐格相同", () => {
    const w = world();
    assert.strictEqual(zoneStep(w.meta), ZONE_MUL * gridStepDeg(w.meta));
    assert.ok(paintClimatePath(w, [[105, 25], [115, 35]], zoneIndex("arid"), 2));
    assert.ok(paintClimatePath(w, [[110, 30]], zoneIndex("boreal"), 1));
    const g = paintedZones(w.meta, w.climateZones)!;
    const back = paintedZones(w.meta, JSON.parse(JSON.stringify(w.climateZones)))!;
    assert.deepStrictEqual(Array.from(back.z), Array.from(g.z), "JSON 往返后逐格相同");
    assert.deepStrictEqual(w.climateZones!.map(z => z.climate), ["boreal", "arid"], "按 CLIMATE_ORDER 每档一份 runs");
  });
  it("一格只属一档：涂寒带抹掉那格的干旱；橡皮擦空即删键；没改动返回 false", () => {
    const w = world();
    paintClimatePath(w, [[110, 30]], zoneIndex("arid"), 1);
    const n0 = paintedZones(w.meta, w.climateZones)!.z.filter(v => v > 0).length;
    paintClimatePath(w, [[110, 30]], zoneIndex("boreal"), 1);
    const z = paintedZones(w.meta, w.climateZones)!.z;
    assert.strictEqual(z.filter(v => v === zoneIndex("arid")).length, 0);
    assert.strictEqual(z.filter(v => v === zoneIndex("boreal")).length, n0);
    assert.strictEqual(paintClimatePath(w, [[110, 30]], zoneIndex("boreal"), 1), false, "涂成同档＝无改动");
    assert.ok(paintClimatePath(w, [[110, 30]], 0, 1));
    assert.ok(!("climateZones" in w), "擦空删键＝旧档形状");
  });
  it("战术图不用分区：写端无改动、zoneField 为 null", () => {
    const w = world({ mapKind: "tactical" });
    assert.strictEqual(paintClimatePath(w, [[110, 30]], 1, 1), false);
    assert.strictEqual(zoneField(world({ mapKind: "tactical" }, { climateZones: encodeZones({ ...zoneGeom(w.meta), z: new Uint8Array(zoneGeom(w.meta).cols * zoneGeom(w.meta).rows).fill(1) }) })), null);
  });
  it("分区不进 terrKey：涂分区不触发网格重建（撤销照常走对象域）", () => {
    const w = world(), k0 = terrKey(w);
    paintClimatePath(w, [[110, 30]], zoneIndex("arid"), 3);
    assert.strictEqual(terrKey(w), k0);
  });
  it("坏数据：未知档与坏 runs 解码时跳过；normalizeWorld 剔非对象成员、非数组删键", () => {
    const geo = zoneGeom(world().meta);
    const z = paintedZones(world().meta, [{ climate: "__proto__" as never, runs: { pd: geo.pd, d: [0, 0, 5] } }, { climate: "arid", runs: { pd: 1e-20, d: [0, 1e16, 5] } }]);
    assert.strictEqual(z!.z.filter(v => v).length, 0);
    const a = normalizeWorld({ meta: {}, nodes: [], climateZones: [null, 3, { climate: "arid", runs: { pd: 1, d: [] } }] } as never);
    assert.strictEqual(a.climateZones!.length, 1);
    assert.ok(!("climateZones" in normalizeWorld({ meta: {}, nodes: [], climateZones: "x" } as never)));
    assert.ok(!("climateZones" in normalizeWorld({ meta: {}, nodes: [] } as never)), "缺键不补");
  });
  it("校验：形状不对警告、过大或格边过细致命、战术图带分区警告", () => {
    const ok = (o: unknown) => validateWorld(o);
    const base = { meta: { bbox: BB }, nodes: [] };
    assert.ok(ok({ ...base, climateZones: "x" }).warnings.some(i => i.path === "climateZones"));
    assert.ok(ok({ ...base, climateZones: [{ climate: "热", runs: { pd: 1, d: [] } }] }).warnings.some(i => i.path === "climateZones[0].climate"));
    assert.ok(ok({ ...base, climateZones: [{ climate: "arid", runs: { pd: 0, d: [] } }] }).warnings.some(i => i.path === "climateZones[0].runs"));
    assert.strictEqual(ok({ ...base, climateZones: [{ climate: "arid", runs: { pd: 1e-6, d: [] } }] }).ok, false, "pd 把图幅切成上亿格");
    assert.strictEqual(ok({ ...base, climateZones: Array.from({ length: 65 }, () => ({ climate: "arid", runs: { pd: 1, d: [] } })) }).ok, false);
    assert.ok(ok({ meta: { bbox: BB, mapKind: "tactical" }, nodes: [], climateZones: [{ climate: "arid", runs: { pd: 1, d: [0, 0, 1] } }] }).warnings.some(i => i.path === "climateZones"));
    assert.strictEqual(ok({ ...base, climateZones: [{ climate: "arid", runs: { pd: 1, d: [0, 0, 3] } }] }).warnings.length, 0, "合法档无提示");
  });
});

describe("气候分区：查找优先级与 v2 派生", () => {
  it("涂的 > meta.climate；未涂、没设＝undefined", () => {
    const w = world({ climate: "temperate" });
    paintClimatePath(w, [[110, 30]], zoneIndex("tropical"), 1);
    assert.strictEqual(climateAt(w, 110, 30), "tropical");
    assert.strictEqual(climateAt(w, 102, 22), "temperate");
    assert.strictEqual(climateAt(world(), 110, 30), undefined);
    assert.strictEqual(zoneField(world()), null, "非 v2 且没涂＝无分区，渲染走旧路径");
  });
  it("v2 球面图且未设气候档：陆上按纬度带派生、海格取最近陆格的档（无 0 格），涂的压派生", () => {
    const w = world(v2({ bbox: { lonMin: 60, lonMax: 140, latMin: 5, latMax: 75 } })), f = zoneField(w)!, M = gen2Macro(w.meta);
    assert.ok(f && !f.z.some(v => v === 0), "每格都有派生档");
    const landZ = new Set<number>(); let lo = 0, hi = 0;
    for (let j = 0; j < f.rows; j++) for (let i = 0; i < f.cols; i++) {
      const lon = f.bb.lonMin + (i + 0.5) * f.pd, lat = f.bb.latMin + (j + 0.5) * f.pd, k = f.z[j * f.cols + i];
      const q = Math.min(M.cols - 1, Math.floor((lon - M.lon0) / M.dlon)), r = Math.min(M.rows - 1, Math.floor((lat - M.lat0) / M.dlat));
      if (M.s[r * M.cols + q] < 0) continue;
      landZ.add(k);
      if (lat < 18) { lo++; assert.ok([zoneIndex("tropical"), zoneIndex("arid")].includes(k), `${lat.toFixed(1)}° 陆格应为热带或干旱，得 ${k}`); }
      if (lat > 69) { hi++; assert.strictEqual(k, zoneIndex("polar"), `${lat.toFixed(1)}° 陆格应为极地`); }
    }
    assert.ok(lo + hi > 0, "种子 7、纬 5–75° 的图幅上要有低于 18° 或高于 69° 的陆格（生成器换布局后挂在这里就换个种子，不是纬度带错了）");
    assert.ok(f.z.every(k => landZ.has(k)), "海格的档都来自某个陆格");
    paintClimatePath(w, [[100, 40]], zoneIndex("polar"), 1);
    assert.strictEqual(climateAt(w, 100, 40), "polar");
  });
  it("v2 设了气候档或平面图：只派生干旱，其余落回 meta.climate", () => {
    for (const m of [v2({ climate: "boreal" }), v2({ worldModel: "flat", kmPerDeg: 111, planetRadiusKm: undefined })]) {
      const w = world(m), z = gen2Zones(w.meta, zoneGeom(w.meta)).z;
      assert.ok(z.every(v => v === 0 || v === zoneIndex("arid")), "只有干旱或 0");
    }
    const w = world(v2({ climate: "boreal" })), f = zoneField(w)!;
    const i = f.z.findIndex(v => v === 0);
    if (i >= 0) assert.strictEqual(climateAt(w, f.bb.lonMin + (i % f.cols + 0.5) * f.pd, f.bb.latMin + (Math.floor(i / f.cols) + 0.5) * f.pd), "boreal");
  });
  it("战术子图继承母图在战场中心处那一档（涂的分区优先于母图档）", () => {
    const src = world({ climate: "temperate", 名称: "母图" }, { nodes: [] });
    paintClimatePath(src, [[110, 30]], zoneIndex("arid"), 2);
    const ev = { id: "e", 名称: "战", type: "event", evtype: "battle", lon: 110, lat: 30, year: 1 } as WorldNode;
    assert.strictEqual(createTacticalWorld(src, ev, 60, {}).meta.climate, "arid");
    assert.strictEqual(createTacticalWorld(src, { ...ev, lon: 102, lat: 22 }, 60, {}).meta.climate, "temperate");
    assert.ok(!("climateZones" in createTacticalWorld(src, ev, 60, {})), "子图不带分区");
  });
});

describe("气候分区：渲染输入", () => {
  it("无分区时 terrainOpts 不带 zones（两端走 snow/clim 旧路径）", () => {
    const m = { bbox: BB, climate: "temperate" } as Meta;
    assert.strictEqual(terrainOpts(m, 0.01, {}, 1, "shaded", 1, [800, 600], 0.05, null, null).zones, undefined);
  });
  it("权重每格和为 1，过渡跨档界、远处为纯档；GL 两张 RGBA8 之和≈255", () => {
    const w = world();
    paintClimatePath(w, [[110, 30]], zoneIndex("arid"), 8);
    const f = zoneField(w)!, W = zoneWeights(f, 111.19), out = new Float32Array(ZONE_N);
    for (let i = 0; i < f.cols * f.rows; i += 37) {
      let s = 0; for (let k = 0; k < ZONE_N; k++) s += W.w[i * ZONE_N + k];
      assert.ok(Math.abs(s - 1) < 1e-4, `第 ${i} 格权重和 ${s}`);
      const t = W.tex0[i * 4] + W.tex0[i * 4 + 1] + W.tex0[i * 4 + 2] + W.tex0[i * 4 + 3] + W.tex1[i * 4] + W.tex1[i * 4 + 1] + W.tex1[i * 4 + 2];
      assert.ok(Math.abs(t - 255) <= 4, `第 ${i} 格纹理和 ${t}`);
    }
    assert.ok(zoneWeightsAt(W, 110, 30, out)[zoneIndex("arid")] > 0.99, "分区中心纯干旱");
    assert.ok(zoneWeightsAt(W, 101, 21, out)[0] > 0.99, "远处纯未涂");
    const edge = f.pd * 8;   // 笔刷半径 8 格处是档界
    const mid = zoneWeightsAt(W, 110 + edge, 30, out)[zoneIndex("arid")];
    assert.ok(mid > 0.15 && mid < 0.85, `档界处应过渡，得 ${mid}`);
  });
  it("权重增量重算与整幅重算逐位相同（笔刷每帧只重算栅格变了的那片）", () => {
    const w = world();
    paintClimatePath(w, [[110, 30]], zoneIndex("arid"), 6);
    zoneWeights(zoneField(w)!, 111.19);
    paintClimatePath(w, [[112, 31], [113, 31.5]], zoneIndex("tropical"), 3);
    const f2 = zoneField(w)!, inc = zoneWeights(f2, 111.19);
    const other = world({ bbox: { lonMin: 0, lonMax: 10, latMin: 0, latMax: 10 } });
    paintClimatePath(other, [[5, 5]], 1, 1);
    zoneWeights(zoneField(other)!, 111.19);   // 换几何：下一次只能整幅算
    const full = zoneWeights({ ...f2, z: f2.z.slice() }, 111.19);
    assert.notStrictEqual(inc, full);
    assert.ok(Buffer.from(inc.w.buffer).equals(Buffer.from(full.w.buffer)), "权重逐位相同");
    assert.ok(Buffer.from(inc.tex0).equals(Buffer.from(full.tex0)) && Buffer.from(inc.tex1).equals(Buffer.from(full.tex1)), "GL 纹理逐字节相同");
  });
  it("单档满权重＝该档自己的色阶与雪线；未涂那档带纬度改正，涂的不带", () => {
    const meta = { bbox: BB, climate: "boreal" } as Meta, Z = zoneLooks(meta), out = new Float32Array(4), wv = new Float32Array(ZONE_N);
    const sstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    for (const e of [0.05, 0.3, 0.8, 1.6]) {
      for (const c of CLIMATE_ORDER) {
        wv.fill(0); wv[zoneIndex(c)] = 1;
        const L = climLook({ ...meta, climate: c })!, col = L.n > 0 ? climRampColor(L, e, 0) : rampColor(e, false);
        zoneColMix(Z, wv, e, 0.3, false, out);
        assert.deepStrictEqual([out[0], out[1], out[2]].map(v => Math.round(v * 1000)), col.map(v => Math.round(v * 1000)), `${c} @${e}：涂的档不吃纬度改正`);
        const snE = CLIMATE[c].snowM / 2000;
        assert.ok(Math.abs(out[3] - sstep(snE, snE + FX.snowBand, e)) < 1e-6, `${c} 雪线`);
      }
      wv.fill(0); wv[0] = 1;
      const L0 = climLook(meta)!, S0 = snowSpec(meta);
      zoneColMix(Z, wv, e, 0.3, false, out);
      assert.deepStrictEqual([out[0], out[1], out[2]].map(v => Math.round(v * 1000)), climRampColor(L0, e, 0.3).map(v => Math.round(v * 1000)), "未涂＝meta.climate 那档 + 纬度改正");
      assert.ok(Math.abs(out[3] - sstep(Math.max(0, S0.base + 0.3), Math.max(0, S0.base + 0.3) + FX.snowBand, e)) < 1e-6);
    }
    wv.fill(0); wv[0] = 1;
    assert.strictEqual(zoneTreeMix(zoneLooks({ bbox: BB } as Meta), wv, 1, 0, out)[0], 0, "没设气候档的未涂处无林线");
    wv.fill(0); wv[zoneIndex("boreal")] = 0.5; wv[zoneIndex("tropical")] = 0.5;
    const t = zoneTreeMix(Z, wv, 1.0, 0, out)[0];   // 2000 m：寒带林线 700 m 之上、热带 3800 m 之下
    assert.ok(Math.abs(t - 0.5) < 1e-6, `各档林线按权重混结果，得 ${t}`);
  });
});
