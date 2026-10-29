/* 块层嵌套解（core/nested）：带中尺度的 v2 战略图，块不跑细级侵蚀，照外层稳态解再解一层。
   夹具是真实尺度的小图幅（格边约 6.7 km、块倍率 8），同缺省大陆图的细格大小；整张图的块只解一次、各条共用 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bandMultAt, gen2Meso, gen2Uplift, mesoKey, pointOf, riverParams, type Gen2Meso } from "../src/core/gen2.ts";
import { buildGridCells, gridGeom, type Grid } from "../src/core/grid.ts";
import { elevBilinear, SHORE_E, WATER_EPS, type ElevField } from "../src/core/elev.ts";
import { erodeField, erodeInput, erodeKey, type ErodeInput } from "../src/core/erode.ts";
import { FLOOR_MAX_KM, NEST_MARGIN, NEST_PAD, UPLIFT_ACH_KM2, UPLIFT_T, VF_MIN_KM2, nestBaseOf, nestedField, nestHistory, nestSolOf, nestSolve, resample, type NestInput, type NestSrc } from "../src/core/nested.ts";
import { Heap } from "../src/core/steady.ts";
import { tileCells, tileCore, tileInput, tileKey, tileKeyOf, tilePlan, type TilePlan } from "../src/core/tiles.ts";
import { handleRouteMsg, type RouteCtx } from "../src/worker/routeProto.ts";
import type { Meta } from "../src/core/types.ts";

const META: Meta = { terrain: "auto", genVer: 2, genSeed: 7, genStyle: "multi", worldModel: "sphere", planetRadiusKm: 6371, gridN: 265, relief: 0.7,
  bbox: { lonMin: 90, lonMax: 106, latMin: 28, latMax: 40 } };
interface Fix { m: Meta; R: Gen2Meso; grid: Grid; inp: ErodeInput; plan: TilePlan; nest: NestSrc }
let FIX: Fix | null = null;
const fix = (): Fix => {
  if (FIX) return FIX;
  const geom = gridGeom(META), R = gen2Meso(META, geom), grid = buildGridCells(META, [], 0, R), inp = erodeInput(META, [], grid, 0)!;
  FIX = { m: META, R, grid, inp, plan: tilePlan(inp, 48e6, 0)!, nest: { base: nestBaseOf(R.st), sol: nestSolOf(R.st, R.st.base, null) } };
  return FIX;
};
const FIELDS = new Map<number, ElevField>();
const field = (i: number): ElevField => {
  let f = FIELDS.get(i);
  if (!f) { const F = fix(); f = nestedField(tileInput(F.inp, F.plan, null, i, F.nest)); FIELDS.set(i, f); }
  return f;
};
const q = (v: number[], p: number): number => v[Math.min(v.length - 1, Math.floor(p * v.length))];

describe("块层嵌套解（core/nested）", () => {
  it("夹具：真实尺度（格边 6–7 km）、块倍率 8、有陆有水", () => {
    const { grid, plan, inp } = fix(), km = grid.step * 6371 * Math.PI / 180;
    assert.ok(km > 6 && km < 7.5 && plan.geom.sx === 8 && plan.tiles.length >= 10, `格边 ${km.toFixed(2)} km、倍率 ${plan.geom.sx}、${plan.tiles.length} 块`);
    assert.ok(inp.water.includes(1) && inp.water.includes(0));
  });

  it("不带目标面的块（整球这类工作档 1 倍的图）输出与键钉死", () => {
    const { inp, plan, nest } = fix(), t = tileInput(inp, plan, null, plan.tiles[1], nest), f = field(plan.tiles[1]);
    assert.ok(t.nest!.tgt === null && t.nest!.pk === null);
    let x = 0x811c9dc5 | 0;
    const u = new Uint32Array(f.data.buffer, f.data.byteOffset, f.data.length);
    for (let i = 0; i < u.length; i++) x = Math.imul(x ^ u[i], 16777619);
    assert.strictEqual((x >>> 0).toString(36), "9o7u1r");
    assert.strictEqual(erodeKey(t), "e10p5v2a-4zzswn-1242z64");
  });

  it("岩性带按细格心取：块里 K 对父 K 双线性之比＝抖动 × 带函数在细格心的值（带规格、折皱带占比随静态场交下来）", () => {
    const { inp, plan, nest } = fix(), tinp = tileInput(inp, plan, null, plan.tiles[5], nest), ne = tinp.nest!, { F } = nestSolve(tinp), { FC, FR, gc0, gr0, fs } = F, { sx } = ne, { cols, rows } = tinp;
    assert.ok(ne.bandN > 0 && ne.umax > 0 && ne.fG.length === cols * rows, "带规格与折皱带占比在单里");
    const bil = (f: ArrayLike<number>, fx: number, fy: number): number => {
      const c0 = Math.max(0, Math.min(cols - 1, Math.floor(fx))), r0 = Math.max(0, Math.min(rows - 1, Math.floor(fy))), c1 = Math.min(cols - 1, c0 + 1), r1 = Math.min(rows - 1, r0 + 1);
      const tx = Math.max(0, Math.min(1, fx - c0)), ty = Math.max(0, Math.min(1, fy - r0)), a = f[r0 * cols + c0], b = f[r0 * cols + c1], c = f[r1 * cols + c0], d = f[r1 * cols + c1];
      return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
    };
    let banded = 0, n = 0;
    for (let r = 0; r < FR; r += 7) for (let c = 0; c < FC; c += 7) {
      const i = r * FC + c; if (F.wat[i]) continue;
      const gc = gc0 + c, gr = gr0 + r, cx = (gc + 0.5) / sx - 0.5 - ne.x0, cy = (gr + 0.5) / sx - 0.5 - ne.y0, lon = ne.lon0 + (gc + 0.5) * fs, lat = ne.lat0 + (gr + 0.5) * fs;
      const band = bandMultAt(ne, bil(ne.fU, cx, cy) / ne.umax, bil(ne.fG, cx, cy), pointOf(ne, lon, lat), ne.seed), jit = F.K[i] / (bil(ne.K, cx, cy) * band);
      assert.ok(jit > 0.8 - 1e-9 && jit < 1.2 + 1e-9, `细格 ${i}：去掉带之后剩 ${jit}，不是 ±20% 的抖动`);
      n++; if (band !== 1) banded++;
    }
    assert.ok(n > 2000 && banded > 0, `抽样 ${n} 格、显带 ${banded}`);
  });

  it("两次逐位同：同一单两次、结构化克隆后再解（Worker 收到的就是克隆）都一样；产出罩住块心、余量按产出原点去掉", () => {
    const { inp, plan, nest } = fix(), ti = plan.tiles[1], tinp = tileInput(inp, plan, null, ti, nest);
    const a = nestedField(tinp), b = nestedField(tinp), c = nestedField(structuredClone(tinp));
    assert.ok(a.data.every((v, i) => v === b.data[i] && v === c.data[i]), "同一单解出两样");
    const { c0, r0, c1, r1 } = tileCells(plan.geom, ti), core = tileCore(a, plan, ti), sx = plan.geom.sx;
    assert.strictEqual(core.length, (c1 - c0) * (r1 - r0) * sx * sx);
    const ox = Math.round((plan.geom.lonMin + c0 * plan.geom.pstep - a.bb.lonMin) / a.step), oy = Math.round((plan.geom.latMin + r0 * plan.geom.pstep - a.bb.latMin) / a.step);
    assert.strictEqual(ox, Math.min(c0, NEST_MARGIN) * sx, "解的窗口＝块心外扩 NEST_MARGIN");
    assert.strictEqual(core[5 * (c1 - c0) * sx + 7], a.data[(oy + 5) * a.cols + ox + 7]);
  });

  it("相邻两窗在块心交界上一致：全部相邻块对、交界两侧的陆细格，两窗之差 p99 < 1 m", () => {
    const { inp, plan } = fix(), g = plan.geom, sx = g.sx, um = inp.unitM, set = new Set(plan.tiles), mis: number[] = [];
    const at = (f: ElevField, gx: number, gy: number): number => f.data[(gy - Math.round((f.bb.latMin - g.latMin) / f.step)) * f.cols + gx - Math.round((f.bb.lonMin - g.lonMin) / f.step)];
    for (const a of plan.tiles) for (const [b, ew] of [[a + 1, true], [a + g.nx, false]] as const) {
      if (!set.has(b) || (ew && a % g.nx === g.nx - 1)) continue;
      const A = tileCells(g, a), [s0, s1] = ew ? [A.r0 * sx, A.r1 * sx] : [A.c0 * sx, A.c1 * sx], e = ew ? A.c1 * sx : A.r1 * sx;
      for (let s = s0; s < s1; s++) for (const k of [-1, 0]) {
        const [x, y] = ew ? [e + k, s] : [s, e + k];
        if (!inp.water[Math.floor(y / sx) * g.cols + Math.floor(x / sx)]) mis.push(Math.abs(at(field(a), x, y) - at(field(b), x, y)) * um);
      }
    }
    mis.sort((x, y) => x - y);
    assert.ok(mis.length > 2000, `交界陆细格 ${mis.length}`);
    assert.ok(q(mis, 0.99) < 1, `交界之差 p99 ${q(mis, 0.99).toFixed(2)} m、最大 ${mis[mis.length - 1].toFixed(1)} m`);
  });

  it("块的大形照父基底：块心陆细格的均值与父基底双线性的均值相差不到 10 m（低通校正只取陆格）", () => {
    const { inp, plan, grid } = fix(), g = plan.geom, sx = g.sx, um = inp.unitM;
    for (const ti of [plan.tiles[1], plan.tiles[4], plan.tiles[5]]) {
      const core = tileCore(field(ti), plan, ti), { c0, r0, c1, r1 } = tileCells(g, ti), W = (c1 - c0) * sx;
      let s = 0, s0 = 0, n = 0;
      for (let r = 0; r < (r1 - r0) * sx; r++) for (let c = 0; c < W; c++) {
        if (inp.water[(r0 + ((r / sx) | 0)) * g.cols + c0 + ((c / sx) | 0)]) continue;
        s += core[r * W + c]; s0 += elevBilinear(inp.elev0, grid, g.lonMin + (c0 * sx + c + 0.5) * g.step, g.latMin + (r0 * sx + r + 0.5) * g.step); n++;
      }
      assert.ok(n > 10000 && Math.abs(s - s0) / n * um < 10, `块 ${ti}：块心均值比父基底差 ${((s - s0) / n * um).toFixed(1)} m`);
    }
  });

  it("陆细格不低于所在父格的水陆判据线、水细格不高于水面 + SHORE_E；岸边一圈不成坑（父基底磨平与低通不混进水格）", () => {
    const { inp, plan, nest } = fix(), um = inp.unitM;
    let pits = 0, near = 0;
    for (const ti of plan.tiles.slice(0, 6)) {
      const tinp = tileInput(inp, plan, null, ti, nest), { F } = nestSolve(tinp), o = field(ti).data, { FC, FR, wat, par } = F, n = FC * FR;
      for (let i = 0; i < n; i++) {
        if (wat[i]) assert.ok(o[i] <= tinp.wsurf[par[i]] + SHORE_E + 1e-6, "水细格高过水面 + SHORE_E");
        else assert.ok(o[i] >= tinp.wsurf[par[i]] - WATER_EPS, "陆细格低于水陆判据线（渲染成水）");
      }
      /* 水细格（按水面）与窗口边作源，四邻优先洪泛；挨着水的陆细格里填深过 1 m 的算岸边坑 */
      const fill = new Float64Array(n), seen = new Uint8Array(n), heap = new Heap(n);
      for (let i = 0; i < n; i++) { const c = i % FC, r = (i / FC) | 0; if (wat[i] || !c || !r || c === FC - 1 || r === FR - 1) { seen[i] = 1; fill[i] = wat[i] ? tinp.wsurf[par[i]] : o[i]; heap.push(fill[i], i); } }
      while (heap.n) {
        const i = heap.pop(), c = i % FC, r = (i / FC) | 0;
        for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) { const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= FR || cc >= FC) continue; const j = rr * FC + cc; if (seen[j]) continue; seen[j] = 1; fill[j] = Math.max(o[j], fill[i]); heap.push(fill[j], j); }
      }
      for (let i = 0; i < n; i++) {
        if (wat[i]) continue;
        const c = i % FC, r = (i / FC) | 0; let adj = false;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const rr = r + dr, cc = c + dc; if (rr >= 0 && cc >= 0 && rr < FR && cc < FC && wat[rr * FC + cc]) adj = true; }
        if (adj) { near++; if ((fill[i] - o[i]) * um > 1) pits++; }
      }
    }
    assert.ok(near > 3000 && pits / near < 0.15, `岸边陆细格 ${near}，成坑 ${(100 * pits / near).toFixed(1)}%`);
  });

  it("节点值挪回格心：平面上的抖动节点外推回格心逐格是那个平面；块里坡面细格的高通残差与「坡度 · 抖距」不相关", () => {
    const FC = 6, FR = 5, n = FC * FR, jx = new Float64Array(n), jy = new Float64Array(n), nbOff = new Int32Array(n + 1), nb: number[] = [], h = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      jx[i] = 0.4 * Math.sin(i * 1.7); jy[i] = 0.4 * Math.cos(i * 2.3);
      const c = i % FC, r = (i / FC) | 0;
      h[i] = 3 + 0.7 * (c + jx[i]) - 1.3 * (r + jy[i]);
      for (const [dr, dc] of [[-1, -1], [-1, 0], [0, -1], [0, 1], [1, 0], [1, 1]]) { const rr = r + dr, cc = c + dc; if (rr >= 0 && cc >= 0 && rr < FR && cc < FC) nb.push(rr * FC + cc); }
      nbOff[i + 1] = nb.length;
    }
    const out = new Uint8Array(n); out[7] = 1;
    const o = resample({ nbOff, nb: Int32Array.from(nb), jx, jy }, h, out, FC);
    for (let i = 0; i < n; i++) if (!out[i]) assert.ok(Math.abs(o[i] - (3 + 0.7 * (i % FC) - 1.3 * ((i / FC) | 0))) < 1e-9, `格 ${i} 没回到平面`);
    assert.strictEqual(o[7], h[7], "出口不动");
    /* 没挪回格心时，块的高通残差带着节点抖距 × 坡度（相关 0.1–0.2） */
    const { inp, plan, nest } = fix();
    for (const ti of [plan.tiles[4], plan.tiles[5]]) {
      const S = nestSolve(tileInput(inp, plan, null, ti, nest)), f = field(ti).data, { FC: W, FR: H, out: ot, wat } = S.F, { jx: X, jy: Y } = S.G;
      let sxy = 0, sxx = 0, syy = 0;
      for (let r = 2; r < H - 2; r++) for (let c = 2; c < W - 2; c++) {
        const i = r * W + c; if (ot[i] || wat[i]) continue;
        const p = (f[i + 1] - f[i - 1]) / 2 * X[i] + (f[i + W] - f[i - W]) / 2 * Y[i], hp = f[i] - (f[i - 1] + f[i + 1] + f[i - W] + f[i + W]) / 4;
        sxy += p * hp; sxx += p * p; syy += hp * hp;
      }
      assert.ok(Math.abs(sxy / Math.sqrt(sxx * syy)) < 0.05, `块 ${ti}：高通残差与坡度·抖距相关 ${(sxy / Math.sqrt(sxx * syy)).toFixed(3)}`);
    }
  });

  it("骨架：外层稳态树上汇流面积 ≥ 4 个本格面积的非出口边，按父格数不按 km²；块里骨架节点所在细格是出口、高程不高于外层解", () => {
    for (const a of [1, 400]) {   // 同一棵树换格面积：门槛跟着格面积走
      const cols = 5, n = 10, area = new Float64Array(n).fill(a), out = new Uint8Array(n); out[8] = 1; out[9] = 1;   // 8 是水（出口）却还指向下游
      const rcv = Int32Array.from({ length: n }, (_, i) => i === 9 ? 9 : i + 1), A = Float64Array.from([1, 2, 3, 3.99, 4, 7, 9, 12, 20, 30], x => x * a);
      const st = { pr: { g: { cols }, area, inp: { out, K: new Float64Array(n).fill(1) } } } as unknown as Parameters<typeof nestSolOf>[0];
      const s = nestSolOf(st, { h: new Float64Array(n), rcv, A, rl: new Float64Array(n).fill(1) }, null);
      assert.deepStrictEqual(Array.from(s.sk, v => v ? 1 : 0), [0, 0, 0, 0, 1, 1, 1, 1, 0, 0], `格面积 ${a} km²`);
      assert.strictEqual(s.sk[5], 1 + 7 * 15 + 1 + 7, "受水者在右邻：编码 dx=+1、dy=0");
      assert.strictEqual(s.sk[4], 1 + 8 * 15 - 4 + 7, "行末的受水者在下一行行首：dx=−4、dy=+1");
    }
    /* 一条骨架边画进细格：节点那一格恰为外层解、受水者那一格恰为它的解，中间沿边单调；别的细格（窗口边除外）不是出口 */
    const cols = 24, rows = 20, n = cols * rows, sx = 4, step = 0.06, fill = (v: number): Float32Array => new Float32Array(n).fill(v);
    const sk = new Uint8Array(n), k0 = 10 * cols + 6; sk[k0] = 1 + 7 * 15 + 1 + 7;   // (6, 10) → (7, 10)
    const ne: NestInput = { wx: 2, wy: 2, wcols: 20, wrows: 16, x0: 0, y0: 0, gcols: cols, sx, lon0: 100, lat0: 30, step, seed: 31, kmd: 111, sphere: false, umax: 1, bandN: 0, fG: fill(0),
      h: Float32Array.from({ length: n }, (_, k) => 100 + 10 * (k % cols)), sk, X: Float32Array.from({ length: n }, (_, k) => k % cols), Y: Float32Array.from({ length: n }, (_, k) => (k / cols) | 0),
      fU: fill(0.5), du: null, kw: null, K: fill(1), P: fill(0), B: fill(0), tauUp: fill(0), A: fill(1), bsig: "t", tgt: null, tsx: 0, pk: null };
    const z = new Float32Array(n), syn: ErodeInput = { bb: { lonMin: 100, latMin: 30, lonMax: 100 + cols * step, latMax: 30 + rows * step }, step, cols, rows, elev0: fill(0.1), water: new Uint8Array(n), wsurf: z,
      amp: 0.7, seed: 1, sphere: false, cap: n * sx * sx, axisMax: sx, bandS: 1, acrit: 300, kmx: 111, kmy: 111, hovGrid: z, unitM: 2000, nest: ne };
    const { F } = nestSolve(syn), hit: number[] = [];
    for (let i = 0; i < F.FC * F.FR; i++) { const c = i % F.FC, r = (i / F.FC) | 0; if (F.out[i] && c > 0 && r > 0 && c < F.FC - 1 && r < F.FR - 1) hit.push(i); }
    assert.deepStrictEqual(hit.map(i => [i % F.FC + 8, ((i / F.FC) | 0) + 8]), [[26, 42], [27, 42], [28, 42], [29, 42], [30, 42]], "骨架边落在全图细格 (26..30, 42)");
    assert.strictEqual(F.hOut[hit[0]], 160); assert.strictEqual(F.hOut[hit[4]], 170);
    for (let t = 1; t < hit.length; t++) assert.ok(F.hOut[hit[t]] > F.hOut[hit[t - 1]], "沿边单调");
    /* 真图上：骨架节点所在细格都是出口、不高于外层解（同一格取各段最低） */
    const { inp, plan, nest, R } = fix(), tinp = tileInput(inp, plan, null, plan.tiles[5], nest), nr = tinp.nest!, S = nestSolve(tinp).F;
    let cnt = 0;
    for (let y = nr.wy + 1; y < nr.wy + nr.wrows - 1; y++) for (let x = nr.wx + 1; x < nr.wx + nr.wcols - 1; x++) {
      const kc = (y - nr.y0) * tinp.cols + x - nr.x0; if (!nr.sk[kc]) continue;
      const c = Math.floor((nr.X[kc] + 0.5) * nr.sx) - nr.wx * nr.sx, r = Math.floor((nr.Y[kc] + 0.5) * nr.sx) - nr.wy * nr.sx, i = r * S.FC + c;
      if (S.wat[i]) continue;
      cnt++; assert.ok(S.out[i] === 1 && S.hOut[i] <= nr.h[kc], "骨架节点那一格不是出口或高过外层解");
    }
    assert.ok(cnt > 300, `骨架节点 ${cnt}`);
    assert.strictEqual(nr.h[0], Math.fround(R.sg.h[nr.y0 * fix().grid.cols + nr.x0]), "裁的是外层稳态解 Sg");
  });

  it("老面：抬升暂态的 τ 自海湖 0 起、窗边与骨架钉外层的；老面占陆格一两成到九成之间、只在 τ > t 的河道与它们的坡面上，缩完沿树仍单调；画的山（kw 1）不缩", () => {
    const { inp, plan, nest } = fix(), tinp = tileInput(inp, plan, null, plan.tiles[5], nest), { F, G, sol } = nestSolve(tinp), h0 = Float64Array.from(sol.h);
    const H = nestHistory(F, G, sol), { rcv } = sol, n = F.FC * F.FR;
    let water0 = true, pinned = 0, moved = 0, land = 0;
    for (let i = 0; i < n; i++) { if (F.wat[i] && F.tauUpOut[i] !== 0) water0 = false; if (F.out[i] && !F.wat[i] && F.tauUpOut[i] > 0) pinned++; if (!F.wat[i]) { land++; if (sol.h[i] !== h0[i]) moved++; } }
    assert.ok(water0 && pinned > 500, `水格 τ 全 0、钉了 τ 的陆出口 ${pinned}`);
    assert.ok(H.rel > 0.02 && H.rel < 0.9 && moved / land > 0.02, `老面份额 ${H.rel.toFixed(3)}、动了的陆格 ${(100 * moved / land).toFixed(1)}%`);
    for (let i = 0; i < n; i++) {
      const j = rcv[i]; if (j === i) continue;
      assert.ok(sol.h[i] >= sol.h[j] - 1e-9, `缩完逆坡：格 ${i}`);
      if (sol.h[i] !== h0[i]) assert.ok(sol.h[i] <= h0[i] + 1e-9 && (H.Af[i] < UPLIFT_ACH_KM2 || H.tauUp[i] > UPLIFT_T), "老面只降不升、河道上只在 τ > t 处");
    }
    /* 画的山：软边权重 1 的格不缩（同一单加一份 kw 全 1 的画抬升，解不变、老面份额归零） */
    const ne = tinp.nest!, kw1 = { ...tinp, nest: { ...ne, kw: new Float32Array(tinp.cols * tinp.rows).fill(1) } }, S1 = nestSolve(kw1), H1 = nestHistory(S1.F, S1.G, S1.sol);
    assert.ok(S1.F.kw && S1.F.kw.every(v => v === 1) && S1.sol.h.every((v, i) => v === h0[i]), "kw 全 1：解一格不动");
    assert.strictEqual(H1.rel, H.rel, "状态照判（老面份额同），只是不缩");
  });

  it("谷底：汇流 ≥ 30 km² 的河道两侧归最近的河道格、取它的高（不低于所在父格的水面、只降不升）；画的盆地与目标面块不盖", () => {
    const { inp, plan, nest } = fix(), ti = plan.tiles[5], tinp = tileInput(inp, plan, null, ti, nest), { F, G, sol } = nestSolve(tinp), H = nestHistory(F, G, sol), o = field(ti).data, n = F.FC * F.FR;
    let nvf = 0, ok = 0, bad = 0;
    for (let i = 0; i < n; i++) {
      const t = H.vfi[i]; if (t < 0) continue;
      nvf++;
      assert.ok(!F.wat[i] && !F.wat[t] && H.Af[t] >= VF_MIN_KM2, "谷底格或它归属的河道格是水、或河道不够宽");
      const ws = tinp.wsurf[F.par[i]], v = o[t] < ws ? ws : o[t];
      if (o[i] <= v + 1e-6) ok++; else bad++;
    }
    assert.ok(nvf > 500 && bad === 0, `谷底格 ${nvf}，高过归属河道的 ${bad}`);
    const km = F.fs * 6371 * Math.PI / 180;
    assert.ok(km < FLOOR_MAX_KM / 2, "夹具的细格要比谷底半径上限小，谷底才展得出");
    /* 目标面是工作档的块、工作档单（带校峰区）：不留老面不展谷底（两级各留一份对不上；工作档的输出钉在 worknest.test 里） */
    const w2 = nestedField({ ...tinp, nest: { ...tinp.nest!, pk: [] } }).data;
    let diff = 0, lower = 0;
    for (let i = 0; i < n; i++) { if (w2[i] !== o[i]) diff++; if (H.vfi[i] >= 0 && o[i] < w2[i] - 1e-6) lower++; }
    assert.ok(diff > 1000 && lower > 100, `带校峰区的单与块的产出不同的细格 ${diff}、块里被谷底压低的 ${lower}`);
  });

  it("细格流向没有 10 km 以上的直段（抖动四边形网；规则网格上的流向沿格轴排成直谷）", () => {
    const { inp, plan, nest, grid } = fix(), ti = plan.tiles[5], S = nestSolve(tileInput(inp, plan, null, ti, nest)), { FC, FR, fs } = S.F, { rcv, A } = S.sol, { jx, jy } = S.G;
    const kmx = fs * 6371 * Math.PI / 180 * Math.cos((grid.bb.latMin + grid.bb.latMax) / 2 * Math.PI / 180), kmy = fs * 6371 * Math.PI / 180, seen = new Uint8Array(FC * FR);
    let max = 0, runs = 0;
    for (let i0 = 0; i0 < FC * FR; i0++) {
      if (A[i0] < 10 || seen[i0] || rcv[i0] === i0) continue;
      let i = i0, len = 0, prev = NaN;
      while (rcv[i] !== i && !seen[i] && A[i] >= 10) {
        seen[i] = 1;
        const j = rcv[i], dx = ((j % FC) - (i % FC) + jx[j] - jx[i]) * kmx, dy = (((j / FC) | 0) - ((i / FC) | 0) + jy[j] - jy[i]) * kmy, a = Math.atan2(dy, dx), el = Math.hypot(dx, dy);
        let d = Math.abs(a - prev); if (d > Math.PI) d = 2 * Math.PI - d;
        if (d < 5 * Math.PI / 180) len += el; else { max = Math.max(max, len); len = el; runs++; }
        prev = a; i = j;
      }
      max = Math.max(max, len);
    }
    assert.ok(runs > 5000 && max < 10, `直段最长 ${max.toFixed(1)} km（${runs} 段）`);
  });

  it("「地势起伏」进坡面细节：0 档就是目标面，柔和（0.35）的细节恰是自然（0.7）的一半", () => {
    const { inp, plan, nest } = fix(), tinp = tileInput(inp, plan, null, plan.tiles[5], nest);
    const o = (a: number): Float32Array => nestedField({ ...tinp, amp: a }).data, o0 = o(0), o35 = o(0.35), o70 = field(plan.tiles[5]).data;
    let s35 = 0, s70 = 0;
    for (let i = 0; i < o0.length; i++) { s35 += (o35[i] - o0[i]) ** 2; s70 += (o70[i] - o0[i]) ** 2; }
    assert.ok(s70 > 0 && Math.abs(Math.sqrt(s35 / s70) - 0.5) < 0.01, `细节之比 ${Math.sqrt(s35 / s70).toFixed(3)}`);
  });

  it("高程涂改照叠：粗格涂改双线性叠到陆细格上（底图与涂改档下块里也有它），水细格不动", () => {
    const { inp, plan, nest } = fix(), tinp = tileInput(inp, plan, null, plan.tiles[5], nest), dh = 0.1;
    const a = field(plan.tiles[5]).data, b = nestedField({ ...tinp, hovGrid: new Float32Array(tinp.hovGrid.length).fill(dh) }).data, { wat } = nestSolve(tinp).F;
    let land = 0, exact = 0;
    for (let i = 0; i < a.length; i++) { if (wat[i]) { assert.strictEqual(b[i], a[i]); continue; } land++; if (Math.abs(b[i] - a[i] - dh) < 1e-6) exact++; }
    assert.ok(exact / land > 0.99, `叠上整格 ${dh} 的陆细格 ${(100 * exact / land).toFixed(1)}%`);
  });

  it("画的盆地：支撑格里照目标面——盆心（双线性取到的四个父格都在支撑里）的细格与起伏档无关", () => {
    const { m, R, inp: inp0, plan } = fix(), { cols, rows } = gridGeom(m), out = R.st.pr.inp.out, fU = R.st.pr.fU;
    /* 山前（宏观抬升在平原渐变带以上，块里有细节）挑一片全陆的地方画盆，盆底比现地面低 300 m */
    let c0 = -1;
    for (let i = 0; i < cols * rows && c0 < 0; i++) {
      const r = (i / cols) | 0, c = i % cols; if (r < 8 || c < 8 || r >= rows - 8 || c >= cols - 8 || !(fU[i] > 0.3)) continue;
      let ok = true; for (let dr = -6; dr <= 6 && ok; dr++) for (let dc = -6; dc <= 6; dc++) if (out[(r + dr) * cols + c + dc]) { ok = false; break; }
      if (ok) c0 = i;
    }
    assert.ok(c0 >= 0, "夹具里找不到山前全陆的地方");
    const fidx: number[] = [], floorM: number[] = [], r0 = (c0 / cols) | 0, q0 = c0 % cols;
    for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) if (dr * dr + dc * dc <= 17) { const i = (r0 + dr) * cols + q0 + dc; fidx.push(i); floorM.push(R.base[i] * inp0.unitM - 300); }
    const order = fidx.map((_, k) => k).sort((a, b) => fidx[a] - fidx[b]);
    const U = gen2Uplift(R.st, { idx: new Int32Array(0), peakM: new Float64Array(0), fidx: Int32Array.from(order, k => fidx[k]), floorM: Float64Array.from(order, k => floorM[k]) }, riverParams(m));
    assert.ok(U.basin, "盆沉下去了");
    const grid = buildGridCells(m, [], 0, U), inp = erodeInput(m, [], grid, 0)!, nest: NestSrc = { base: nestBaseOf(R.st), sol: nestSolOf(R.st, U.sol, U.up) };
    const ti = plan.tiles.find(t => { const T = tileCells(plan.geom, t); return q0 >= T.c0 && q0 < T.c1 && r0 >= T.r0 && r0 < T.r1; })!;
    const tinp = tileInput(inp, plan, null, ti, nest), a = nestedField(tinp).data, b = nestedField({ ...tinp, amp: 0 }).data, ne = tinp.nest!, sx = ne.sx, bas = tinp.basin!;
    let deep = 0, diff = 0, outside = 0;
    for (let i = 0; i < a.length; i++) {
      const gc = ne.wx * sx + (i % (ne.wcols * sx)), gr = ne.wy * sx + ((i / (ne.wcols * sx)) | 0), fx = (gc + 0.5) / sx - 0.5 - ne.x0, fy = (gr + 0.5) / sx - 0.5 - ne.y0;
      const x = Math.floor(fx), y = Math.floor(fy); let all = true;
      for (const [dy, dx] of [[0, 0], [0, 1], [1, 0], [1, 1]]) if (!(bas[(y + dy) * tinp.cols + x + dx] & 1)) all = false;
      if (all) { deep++; if (a[i] !== b[i]) diff++; } else if (a[i] !== b[i]) outside++;
    }
    assert.ok(deep > 500 && diff === 0, `盆心细格 ${deep}，随起伏档变了 ${diff}`);
    assert.ok(outside > 10000, "前提：盆外照常有细节");
  });

  it("键：全图单不带 nest 一字不变；块单带 nest 才追加、裁剪变了即换键；tileKeyOf 与 tileKey(tileInput(…)) 一字不差；画一处山只换碰到它的块的键", () => {
    const { m, R, inp, plan, nest } = fix(), k0 = erodeKey(inp);
    assert.strictEqual(erodeKey({ ...inp, nest: undefined }), k0);
    for (const ti of plan.tiles.slice(0, 4)) {
      const full = tileInput(inp, plan, null, ti, nest);
      assert.strictEqual(tileKeyOf(inp, plan, null, ti, nest), tileKey(full));
      assert.strictEqual(tileKeyOf(inp, plan, null, ti), tileKey(tileInput(inp, plan, null, ti)), "非嵌套单同样一致");
      assert.notStrictEqual(tileKey(full), tileKey(tileInput(inp, plan, null, ti)), "带 nest 与不带不同键");
      const h = full.nest!.h.slice(); h[h.length >> 1] += 1;
      assert.notStrictEqual(erodeKey({ ...full, nest: { ...full.nest!, h } }), erodeKey(full), "外层解一格之差即换键");
    }
    /* 画一处 4000 m 的山：只有外层解、抬升或基底变了的块换键（影响带外的块不动） */
    /* 画在陆地最多那一块的块心附近 */
    const { cols } = gridGeom(m), out = R.st.pr.inp.out, landOf = (t: number): number => { const T = tileCells(plan.geom, t); let k = 0; for (let r = T.r0; r < T.r1; r++) for (let x = T.c0; x < T.c1; x++) if (!out[r * cols + x]) k++; return k; };
    const last = plan.tiles.reduce((a, b) => landOf(b) > landOf(a) ? b : a), T0 = tileCells(plan.geom, last);
    let c = -1, best = Infinity;
    for (let r = T0.r0; r < T0.r1; r++) for (let x = T0.c0; x < T0.c1; x++) { const d = (r - (T0.r0 + T0.r1) / 2) ** 2 + (x - (T0.c0 + T0.c1) / 2) ** 2; if (!out[r * cols + x] && d < best) { best = d; c = r * cols + x; } }
    const U = gen2Uplift(R.st, { idx: Int32Array.of(c), peakM: Float64Array.of(4000) }, riverParams(m)), grid = buildGridCells(m, [], 0, U), inp2 = erodeInput(m, [], grid, 0)!;
    const nest2: NestSrc = { base: nest.base, sol: nestSolOf(R.st, U.sol, U.up) };
    let same = 0, changed = 0;
    for (const ti of plan.tiles) { if (tileKeyOf(inp, plan, null, ti, nest) === tileKeyOf(inp2, plan, null, ti, nest2)) same++; else changed++; }
    assert.ok(changed >= 1 && same >= 1, `换键 ${changed}、不变 ${same}`);
    assert.notStrictEqual(tileKeyOf(inp, plan, null, last, nest), tileKeyOf(inp2, plan, null, last, nest2), "画山的那块换键");
  });

  it("画抬升进求解抬升：山里（平原渐变本就取满）画的山，块里比不带抬升的同一单高出一截", () => {
    const { m, R, inp: inp0, plan } = fix(), { cols } = gridGeom(m), out = R.st.pr.inp.out, fU = R.st.pr.fU;
    let c = -1;
    for (let i = 0; i < out.length && c < 0; i++) { const r = (i / cols) | 0, q0 = i % cols; if (!out[i] && fU[i] > 0.6 && r > 20 && q0 > 20 && r < gridGeom(m).rows - 20 && q0 < cols - 20) c = i; }
    assert.ok(c >= 0, "夹具里找不到高抬升的陆格");
    const U = gen2Uplift(R.st, { idx: Int32Array.of(c), peakM: Float64Array.of(R.base[c] * inp0.unitM + 2500) }, riverParams(m)), grid = buildGridCells(m, [], 0, U), inp = erodeInput(m, [], grid, 0)!;
    const ti = plan.tiles.find(t => { const T = tileCells(plan.geom, t); return c % cols >= T.c0 && c % cols < T.c1 && ((c / cols) | 0) >= T.r0 && ((c / cols) | 0) < T.r1; })!;
    const tinp = tileInput(inp, plan, null, ti, { base: fix().nest.base, sol: nestSolOf(R.st, U.sol, U.up) });
    assert.ok(tinp.nest!.du, "裁剪里带抬升");
    const a = nestedField(tinp).data, b = nestedField({ ...tinp, nest: { ...tinp.nest!, du: null } }).data;
    let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, (a[i] - b[i]) * inp.unitM);
    assert.ok(d > 100, `带抬升的块最多高出 ${d.toFixed(0)} m`);
  });

  it("块单：带 nest 的不带 win 与 mesoEnv、裁剪＝窗口外扩 NEST_PAD；不带的照旧（中尺度图带包络、切割量 null）", () => {
    const { inp, plan, nest } = fix(), ti = plan.tiles[5], a = tileInput(inp, plan, null, ti, nest), b = tileInput(inp, plan, null, ti);
    assert.ok(inp.mesoEnv, "前提：中尺度图的工作档单带包络");
    assert.ok(a.nest && !a.win && !a.mesoEnv);
    assert.strictEqual(a.nest.x0, Math.max(0, a.nest.wx - NEST_PAD));
    assert.strictEqual(a.cols, Math.min(plan.geom.cols, a.nest.wx + a.nest.wcols + NEST_PAD) - a.nest.x0);
    assert.ok(!b.nest && b.win && b.mesoEnv && b.win.carve === null);
  });

  it("Worker 按 nest 分流：带 nest 的侵蚀单走嵌套解，不带的走 erodeField；中尺度单回执带静态场与 Sg 的骨架，画抬升单带那份解的", () => {
    const { m, inp, plan, nest, R } = fix(), st: RouteCtx = {}, tinp = tileInput(inp, plan, null, plan.tiles[1], nest);
    const r = handleRouteMsg(st, { t: "erode", id: 1, ...tinp });
    const want1 = field(plan.tiles[1]).data;
    assert.ok(r && r.t === "erode" && r.f.data.every((v, i) => v === want1[i]));
    const plain = tileInput(inp, plan, null, plan.tiles[1]), r2 = handleRouteMsg(st, { t: "erode", id: 2, ...plain });
    const want0 = erodeField(plain).data;
    assert.ok(r2 && r2.t === "erode" && r2.f.data.every((v, i) => v === want0[i]));
    const geom = gridGeom(m), me = handleRouteMsg(st, { t: "meso", id: 3, meta: m, geom, sg: { h: R.sg.h.slice(), rcv: R.sg.rcv.slice() } });
    assert.ok(me && me.t === "meso");
    assert.deepStrictEqual(me.nest.sol.sk, nest.sol.sk); assert.deepStrictEqual(me.nest.base.fK, nest.base.fK);
    assert.notStrictEqual(me.nest.base.X, st.meso!.st!.G.X, "静态场是拷贝（回执整份交出，车道的三角网不能被摘走）");
    assert.strictEqual(st.meso!.key, mesoKey(m, geom));
    const cells = { idx: Int32Array.of(R.st.pr.inp.out.findIndex((v, i) => !v && i > 20000)), peakM: Float64Array.of(3500) };
    const up = handleRouteMsg(st, { t: "uplift", id: 4, meta: m, geom, sg: null, cells }), want = gen2Uplift(R.st, cells, riverParams(m));
    assert.ok(up && up.t === "uplift" && up.nest.up);
    assert.deepStrictEqual(up.nest, nestSolOf(R.st, want.sol, want.up));
  });
});
