/* 河当水体（render/rivers）：叠加层与两个渲染器共用的河段、门槛、分桶与有向距离 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RIV_LOOP, RIVER_WATER_PX, riverDirty, riverGeom, riverSD, riverSet, riverTexels, riverThr, type RiverSet } from "../src/render/rivers.ts";
import { riverShape } from "../src/render/edges.ts";
import { terrainOpts } from "../src/render/renderer.ts";
import { waterGLSL } from "../src/render/material.ts";
import { coastInk } from "../src/render/terrainCPU.ts";
import type { Camera } from "../src/core/projection.ts";
import type { Edge, Meta, World } from "../src/core/types.ts";

const meta: Meta = { worldModel: "sphere", planetRadiusKm: 10000, bbox: { lonMin: 95, lonMax: 105, latMin: 25, latMax: 35 } };
const mk = (edges: Edge[], m: Meta = meta): World => ({ meta: m, factions: [], decor: [], terrainOverrides: [], units: [], nodes: [], edges });
const kmDeg = 2 * Math.PI * 10000 / 360;
/** 放大到这一档，河段集收进所有带宽的段（档底远低于任何夹具河宽） */
const DPP = 1e-6;

/** 逐段暴力求真宽 ≥ thr 的段的最小有向距离（riverSD 的式子，不分桶） */
function brute(s: RiverSet, lon: number, lat: number, thr: number): number {
  const q = s.seg, px = lon - s.ox, py = lat - s.oy;
  let sd = 1e9;
  for (let o = 0; o < s.n * 8; o += 8) {
    if (q[o + 6] < thr) continue;
    const c = q[o + 7], ax = (px - q[o]) * c, ay = py - q[o + 1], ex = (q[o + 2] - q[o]) * c, ey = q[o + 3] - q[o + 1];
    const h = Math.max(0, Math.min(1, (ax * ex + ay * ey) / Math.max(ex * ex + ey * ey, 1e-30))), dx = ax - ex * h, dy = ay - ey * h;
    sd = Math.min(sd, Math.sqrt(dx * dx + dy * dy) - (q[o + 4] + (q[o + 5] - q[o + 4]) * h));
  }
  return sd;
}
/** 确定性伪随机（测试夹具用） */
function lcg(seed: number): () => number { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

describe("河当水体：河段与门槛", () => {
  it("riverShape 的折线与真宽出自 riverGeom（叠加层与渲染器同一份）；球面图跨 ±180° 的河接成连续经度", () => {
    const cam: Camera = { lon0: 100, lat0: 30, degPerPx: 0.001, w: 800, h: 600, flat: false };
    const e: Edge = { type: "river", pts: [[99.8, 30], [100, 30.1], [100.2, 30]], widthM: 900, ws: [100, 500, 1800] };
    const G = riverGeom(meta, e), sh = riverShape(meta, cam, e);
    assert.deepStrictEqual(sh.pts, G.pts);
    assert.deepStrictEqual(sh.g, G.g, "判水面的真宽同一份");
    assert.ok(G.g.every((g, k) => Math.abs(g - Math.min(G.w[k], 900) / 1000 / kmDeg) < 1e-15), "真宽封顶在 widthM（河口展宽推不过门槛）");
    const seam = riverGeom(meta, { type: "river", pts: [[179.6, 0], [-179.8, 0], [-179.4, 0]], widthM: 100 });
    assert.ok(seam.pts.every((p, k) => !k || Math.abs(p[0] - seam.pts[k - 1][0]) < 1), `经度连续：${seam.pts.map(p => p[0].toFixed(2)).join(" ")}`);
    const flat = riverGeom({ worldModel: "flat", kmPerDeg: 100 }, { type: "river", pts: [[179.6, 0], [-179.8, 0]], widthM: 100 });
    assert.strictEqual(flat.pts[flat.pts.length - 1][0], -179.8, "平面图不折经度");
  });
  it("riverSet 只收确证、当年在场、带宽的自由折线河；内容不变沿用同一份（id 不变），改一个点换代", () => {
    const A: Edge = { type: "river", pts: [[99, 30], [100, 30], [101, 30]], widthM: 600 };
    const w = mk([A, { type: "river", pts: [[99, 31], [101, 31]], widthM: 600, certainty: "inferred" },
      { type: "river", pts: [[99, 32], [101, 32]], widthM: 600, since: 4000 }, { type: "river", pts: [[99, 33], [101, 33]] },
      { type: "road", from: "a", to: "b" }]);
    const s = riverSet(meta, w, 3107, DPP)!;
    assert.strictEqual(s.n, riverGeom(meta, A).pts.length - 1, "只有第一条进来（虚线、未到年份、没有宽度的都不进）");
    assert.ok([...Array(s.n).keys()].every(i => Math.abs(s.seg[i * 8 + 1] + s.oy - 30) < 1e-9), "段都在 30°N 上");
    assert.strictEqual(riverSet(meta, { ...w }, 3107, DPP), s, "世界对象换了、内容没变：同一份");
    A.pts![1] = [100, 30.2];
    const s2 = riverSet(meta, { ...w }, 3107, DPP)!;
    assert.ok(s2 !== s && s2.id > s.id, "改了点就换代");
    assert.strictEqual(riverSet(meta, mk([{ type: "river", pts: [[99, 33], [101, 33]] }]), 3107, DPP), null, "没有带宽的河＝null");
  });
  it("riverSD：河里为负、岸外为正、窄于门槛的段不算；分桶查到的与逐段暴力同值", () => {
    const rnd = lcg(7), edges: Edge[] = [];
    for (let r = 0; r < 40; r++) {   // 40 条随机游走的河，宽 50–2000 m
      let x = 96 + rnd() * 8, y = 26 + rnd() * 8;
      const pts: [number, number][] = [], ws: number[] = [];
      for (let k = 0; k < 12; k++) { pts.push([x, y]); ws.push(50 + rnd() * 1950); x += (rnd() - 0.5) * 0.4; y += (rnd() - 0.5) * 0.4; }
      edges.push({ type: "river", pts, widthM: 2000, ws });
    }
    const s = riverSet(meta, mk(edges), 3107, DPP)!;
    for (const thr of [0, 300 / 1000 / kmDeg, 1200 / 1000 / kmDeg]) {
      let rmin = Infinity;
      for (let o = 0; o < s.n * 8; o += 8) if (s.seg[o + 6] >= thr) rmin = Math.min(rmin, s.seg[o + 4], s.seg[o + 5]);
      let near = 0, inside = 0;
      for (let i = 0; i < 4000; i++) {
        const o = Math.floor(rnd() * s.n) * 8, t = rnd(), lon = s.ox + s.seg[o] + (s.seg[o + 2] - s.seg[o]) * t + (rnd() - 0.5) * 0.04, lat = s.oy + s.seg[o + 1] + (s.seg[o + 3] - s.seg[o + 1]) * t + (rnd() - 0.5) * 0.04;
        const b = brute(s, lon, lat, thr);
        if (b > 1.5 * rmin) continue;   // 离最近的够宽段不到 1.5 个最小半宽：一定落在那一段的桶里
        near++; if (b < 0) inside++;
        assert.strictEqual(riverSD(s, lon, lat, thr), b, `(${lon}, ${lat}) 门槛 ${thr}`);
      }
      assert.ok(near > 200 && inside > 50, `样本够：${near} / 水里 ${inside}`);
    }
    assert.strictEqual(riverSD(s, s.ox + s.seg[0], s.oy + s.seg[1], s.gmax * 1.01), 1e9, "门槛高过最宽的段：处处没有水面");
  });
  it("分桶：每桶至多 RIV_LOOP 段（取样不截断）；纹理按行铺、与河段逐位同（Float32）", () => {
    const edges: Edge[] = [];
    for (let r = 0; r < 300; r++) edges.push({ type: "river", pts: [[99, 30 + r * 0.002], [100, 30 + r * 0.002], [101, 30.3 + r * 0.002]], widthM: 120 });
    const s = riverSet(meta, mk(edges), 3107, DPP)!;
    let mx = 0;
    for (let b = 0; b < s.nx * s.ny; b++) mx = Math.max(mx, s.idx[2 * b + 1]);
    assert.ok(mx <= RIV_LOOP, `最多 ${mx} 段/桶`);
    const T = riverTexels(s);
    assert.deepStrictEqual(Array.from(T.seg.subarray(0, s.seg.length)), Array.from(s.seg, Math.fround));
    assert.deepStrictEqual(Array.from(T.idx.subarray(0, s.idx.length)), Array.from(s.idx));
    for (let b = 0; b < s.nx * s.ny; b++) {   // 桶内按真宽降序（取样遇到不够宽的就停）
      const st = s.idx[2 * b], g = Array.from(s.idx.subarray(st, st + s.idx[2 * b + 1]), i => s.seg[i * 8 + 6]);
      assert.ok(g.every((v, k) => !k || v <= g[k - 1]), `桶 ${b} 降序`);
    }
  });
  it("球面图：伸出经度折回域的河另放一份平移 360° 的，图幅中心对面两侧都取得到水", () => {
    const glob: Meta = { worldModel: "sphere", planetRadiusKm: 10000, bbox: { lonMin: -180, lonMax: 180, latMin: -80, latMax: 80 } };
    const s = riverSet(glob, mk([{ type: "river", pts: [[179.5, 10], [-179.5, 10]], widthM: 20000 }], glob), 3107, DPP)!;
    for (const lon of [179.9, -179.9]) assert.ok(riverSD(s, lon, 10, 0) < 0, `${lon} 在水里`);
    assert.ok(riverSD(s, 0, 10, 0) > 1, "不横穿整幅");
  });
  it("riverDirty：同一份且门槛以上段数相同＝空；门槛降到多放进一段＝只框那一段；改河＝框旧段与新段", () => {
    const e1: Edge = { type: "river", pts: [[99, 30], [100, 30]], widthM: 400 }, e2: Edge = { type: "river", pts: [[101, 31], [102, 31]], widthM: 900 };
    const w = mk([e1, e2]), s = riverSet(meta, w, 3107, DPP)!, t400 = 390 / 1000 / kmDeg, t900 = 890 / 1000 / kmDeg;   // 门槛略低于真宽：避开乘除次序不同的末位差
    assert.deepStrictEqual(riverDirty({ set: s, thr: t900 }, { set: s, thr: t900 * 0.99 }), [], "门槛挪了、过门槛的段没变");
    const d = riverDirty({ set: s, thr: t900 }, { set: s, thr: t400 });
    assert.ok(d.length > 0 && d.every(r => r.lonMax <= 100.01 && r.latMin < 30 && r.latMax > 30), "只框窄的那条（新放进来的）");
    assert.ok(riverDirty({ set: s, thr: t400 }, undefined).length > 0, "河不画了：框原来画着的");
    assert.deepStrictEqual(riverDirty(undefined, { set: s, thr: t900 * 2 }), [], "两边都没有过门槛的段");
    e2.pts = [[101, 32], [102, 32]];
    const s2 = riverSet(meta, { ...w }, 3107, DPP)!, d2 = riverDirty({ set: s, thr: t400 }, { set: s2, thr: t400 });
    assert.ok(d2.some(r => r.latMin < 31 && r.latMax > 31) && d2.some(r => r.latMin < 32 && r.latMax > 32) && d2.every(r => r.lonMin > 100.5), "框旧位置与新位置、没动的那条不框");
  });
  it("terrainOpts：只在观感底图、河流层开着时带河；门槛＝RIVER_WATER_PX 个 CSS 像素的纬度当量", () => {
    const s = riverSet(meta, mk([{ type: "river", pts: [[99, 30], [100, 30]], widthM: 400 }]), 3107, DPP)!;
    const o = terrainOpts(meta, 0.002, {}, 1, "shaded", 1, [800, 600], 0.05, null, s);
    assert.strictEqual(o.rivers!.set, s); assert.strictEqual(o.rivers!.thr, RIVER_WATER_PX * 0.002); assert.strictEqual(riverThr(0.002), o.rivers!.thr);
    assert.strictEqual(terrainOpts(meta, 0.002, {}, 1, "flat", 1, [800, 600], 0.05, null, s).rivers, undefined, "推演底图不画河面（像素＝读数那一格）");
    assert.strictEqual(terrainOpts(meta, 0.002, { river: false }, 1, "shaded", 1, [800, 600], 0.05, null, s).rivers, undefined, "河流层关了");
  });
  it("CPU 岸线墨：河里也算水——河与湖之间不描线，河与陆之间描", () => {
    const W = 10, H = 6, elev = new Float32Array(W * H), wsv = new Float32Array(W * H), rsd = new Float32Array(W * H).fill(1e9);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { elev[y * W + x] = x <= 2 ? -1 : 1; if (x >= 3 && y >= 1 && y <= 4) rsd[y * W + x] = -2; }   // 西三列是湖，东边 1–4 行是河
    const ink = (r: Float32Array | null): number[] => { const d = new Uint8ClampedArray(W * H * 4).fill(200); coastInk(d, elev, wsv, W, H, 1, r); return Array.from({ length: W * H }, (_, i) => d[i * 4]); };
    const no = ink(null), yes = ink(rsd), at = (a: number[], x: number, y: number) => a[y * W + x];
    assert.ok(at(no, 2, 2) < 200 && at(no, 3, 2) < 200, "没有河：湖岸照描");
    assert.ok([[2, 2], [3, 2], [2, 3], [3, 3]].every(([x, y]) => at(yes, x, y) === 200), "河口：湖与河之间不描线");
    assert.ok(at(yes, 6, 0) < 200 && at(yes, 6, 1) < 200 && at(yes, 6, 5) < 200 && at(no, 6, 0) === 200, "河岸照描");
    assert.ok(at(yes, 2, 0) < 200 && at(yes, 3, 0) < 200, "河外的湖岸照描");
  });
  it("水面配色单一真源：GLSL 字面量由 material.WATER 生成、与湖海旧式逐字同", () => {
    const W = waterGLSL();
    assert.strictEqual(W.ramp, "vec3(40.0+t*60.0,90.0+t*70.0,132.0+t*66.0)/255.0");
    assert.strictEqual(W.shore, "vec3(0.55,0.72,0.75)");
    assert.strictEqual(W.ink, "vec3(38.0,66.0,86.0)/255.0");
    assert.strictEqual(W.deep, "vec3(40.0,90.0,132.0)/255.0");
  });
});
