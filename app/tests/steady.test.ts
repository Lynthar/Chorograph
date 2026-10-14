/* 河流功率律稳态（core/steady）：影响带重解与画抬升标定——同输入逐位同、零抬升不动、带外流向与不相关节点逐位同 base、
   解与自己的流向树自洽、无回路、各区峰高到目标、桥并进带。合成图：平面 5 km 格的三角网，四边是海，中间一个湖面 150 的湖。
   两套各跑一遍：不修正源头（acrit 大过节点面积），与源头修正生效（acrit 小过节点面积）。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMesh, cellRand } from "../src/core/gen2mesh.ts";
import { Heap, bandOf, steady, steadyBand, upliftSolve, type SteadyGraph, type SteadyInput, type SteadyResult, type UpliftRegion } from "../src/core/steady.ts";

const COLS = 90, ROWS = 70, KM = 5, n = COLS * ROWS, MAXIT = 300;
const mesh = buildMesh(COLS, ROWS, 11), len = new Float64Array(mesh.nb.length);
for (let i = 0; i < n; i++) for (let e = mesh.nbOff[i]; e < mesh.nbOff[i + 1]; e++) {
  const j = mesh.nb[e], dx = (mesh.X[j] - mesh.X[i]) * KM, dy = (mesh.Y[j] - mesh.Y[i]) * KM; len[e] = Math.sqrt(dx * dx + dy * dy);
}
const G: SteadyGraph = { nbOff: mesh.nbOff, nb: mesh.nb, len, area: Float64Array.from({ length: n }, (_, i) => KM * KM * (0.8 + 0.4 * cellRand(i, 29))) };   // 面积非整数：汇流面积的求和次序才看得出来
for (const HEAD of [0, 0.75]) {
const ACRIT = HEAD ? 15 : 100;
const out = new Uint8Array(n), hOut = new Float64Array(n), U = new Float64Array(n), K = new Float64Array(n), h0 = new Float64Array(n), peakAdd = new Float64Array(n);
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
  const i = r * COLS + c;
  if (r === 0 || c === 0 || r === ROWS - 1 || c === COLS - 1) out[i] = 1;
  else if (Math.abs(r - 20) <= 1 && Math.abs(c - 62) <= 1) { out[i] = 1; hOut[i] = 150; }
  else h0[i] = 1e-3 * cellRand(i, 17);
  U[i] = 120 + 60 * Math.sin(c / 9) * Math.cos(r / 7);
  K[i] = 0.8 + 0.4 * cellRand(i, 5);
  peakAdd[i] = 30 * cellRand(i, 23);
}
const inp: SteadyInput = { U, K, acrit: ACRIT, out, hOut, head: HEAD };
const base = steady(G, inp, h0, { maxIt: MAXIT, tol: 0, canon: true });

const at = (r: number, c: number): number => r * COLS + c;
const peakOf = (h: Float64Array, reg: UpliftRegion): number => { let p = -Infinity; for (const i of reg.peak) p = Math.max(p, h[i] + peakAdd[i]); return p; };
/** 圆盘区：半径内权重 1、外一圈 0.5（出口不抬）；目标＝base 上区内峰高 + rise */
function disc(r0: number, c0: number, R: number, rise: number): UpliftRegion {
  const idx: number[] = [], w: number[] = [], peak: number[] = [];
  for (let r = r0 - R - 1; r <= r0 + R + 1; r++) for (let c = c0 - R - 1; c <= c0 + R + 1; c++) {
    if (r < 0 || c < 0 || r >= ROWS || c >= COLS) continue;
    const i = at(r, c), d2 = (r - r0) * (r - r0) + (c - c0) * (c - c0); if (out[i] || d2 > (R + 1) * (R + 1)) continue;
    idx.push(i); w.push(d2 <= R * R ? 1 : 0.5); if (d2 <= R * R) peak.push(i);
  }
  const reg = { idx: Int32Array.from(idx), w: Float64Array.from(w), peak: Int32Array.from(peak), target: 0 };
  reg.target = peakOf(base.h, reg) + rise;
  return reg;
}
const support = (regions: UpliftRegion[]): Uint8Array => { const s = new Uint8Array(n); for (const r of regions) for (const i of r.idx) s[i] = 1; return s; };
const loopFree = (rcv: Int32Array): boolean => {
  const st = new Uint8Array(n), path: number[] = [];
  for (let i0 = 0; i0 < n; i0++) {
    let i = i0; path.length = 0;
    while (!st[i] && rcv[i] !== i) { st[i] = 1; path.push(i); i = rcv[i]; }
    if (st[i] === 1 && rcv[i] !== i) return false;
    st[i] = 2; for (const p of path) st[p] = 2;
  }
  return true;
};
/** 自己的流向树上重积一遍：每个节点的 A＝本格面积 + 子节点按号降序逐个相加，h 自根沿树积（叶节点按源头修正乘系数） */
function reintegrate(S: SteadyResult, Uf: Float64Array): { h: Float64Array; A: Float64Array } {
  const kids: number[][] = Array.from({ length: n }, () => []), bfs: number[] = [];
  for (let i = 0; i < n; i++) if (S.rcv[i] === i) bfs.push(i); else kids[S.rcv[i]].push(i);
  for (let q = 0; q < bfs.length; q++) for (const c of kids[bfs[q]]) bfs.push(c);
  const A = new Float64Array(n), h = new Float64Array(n);
  for (let q = bfs.length - 1; q >= 0; q--) { const j = bfs[q]; let a = G.area[j]; for (let k = kids[j].length - 1; k >= 0; k--) a += A[kids[j][k]]; A[j] = a; }
  for (const i of bfs) {
    const j = S.rcv[i], a = G.area[i], f = HEAD && A[i] === a && a > ACRIT ? 1 + HEAD * (1 - Math.sqrt(ACRIT / a)) : 1;
    h[i] = j === i ? (out[i] ? hOut[i] : S.h[i]) : h[j] + Uf[i] / (K[i] * Math.sqrt(A[i] > ACRIT ? A[i] : ACRIT)) * S.rl[i] * f;
  }
  return { h, A };
}
/** 带内节点流到带外、而那个带外节点往下又回到带里的个数（应恒为 0） */
const backIntoBand = (S: SteadyResult & { band: Uint8Array }): number => {
  let back = 0;
  for (let i = 0; i < n; i++) {
    if (!S.band[i] || out[i] || S.band[S.rcv[i]]) continue;
    for (let j = S.rcv[i]; S.rcv[j] !== j; j = S.rcv[j]) if (S.band[S.rcv[j]]) { back++; break; }
  }
  return back;
};
const upliftU = (regions: UpliftRegion[], s: Float64Array): Float64Array => {
  const o = Float64Array.from(U); regions.forEach((r, k) => { for (let t = 0; t < r.idx.length; t++) o[r.idx[t]] += s[k] * r.w[t]; }); return o;
};

const regions = [disc(40, 25, 3, 1500), disc(45, 58, 2, 700), disc(15, 20, 2, -10)];
const band = bandOf(G, support(regions), 60);
const S1 = upliftSolve(G, inp, base, band, regions, peakAdd, MAXIT);

describe(`河流功率律稳态：影响带重解与画抬升标定（源头修正 ${HEAD}）`, () => {
  it("前提：全图稳态在规范积分下严格收敛（流向树不变），且无回路", () => {
    assert.ok(base.converged, `全图稳态 ${base.iters} 轮未收敛`);
    assert.ok(loopFree(base.rcv));
  });
  it("同输入两次逐位同（h、流向、汇流面积、各区系数）", () => {
    const S2 = upliftSolve(G, inp, base, band, regions, peakAdd, MAXIT);
    assert.deepStrictEqual(S2.h, S1.h); assert.deepStrictEqual(S2.rcv, S1.rcv); assert.deepStrictEqual(S2.A, S1.A); assert.deepStrictEqual(S2.s, S1.s);
  });
  it("零抬升：带内重解与 base 逐位同", () => {
    const Z = steadyBand(G, inp, base, band, MAXIT);
    assert.deepStrictEqual(Z.h, base.h); assert.deepStrictEqual(Z.rcv, base.rcv); assert.deepStrictEqual(Z.A, base.A);
  });
  it("带外流向逐位同 base；不在带上游、也不在带下游链上的节点 h 与 A 逐位同 base，且这类节点占全图三成以上", () => {
    let flips = 0; for (let i = 0; i < n; i++) if (!S1.band[i] && S1.rcv[i] !== base.rcv[i]) flips++;
    assert.strictEqual(flips, 0);
    const aff = new Int8Array(n).fill(-1), path: number[] = [];
    for (let i0 = 0; i0 < n; i0++) {
      let i = i0; path.length = 0;
      while (aff[i] < 0) { if (S1.band[i] || S1.A[i] !== base.A[i]) { aff[i] = 1; break; } if (S1.rcv[i] === i) { aff[i] = 0; break; } path.push(i); i = S1.rcv[i]; }
      for (let k = path.length - 1; k >= 0; k--) { const p = path[k]; aff[p] = aff[S1.rcv[p]]; }
    }
    let free = 0, bad = 0;
    for (let i = 0; i < n; i++) if (!aff[i]) { free++; if (S1.h[i] !== base.h[i] || S1.A[i] !== base.A[i]) bad++; }
    assert.strictEqual(bad, 0);
    assert.ok(free > 0.3 * n, `不相关节点只有 ${free}`);
  });
  it("解与自己的流向树逐位自洽：在这棵树上按 U + Σ s·w 重积一遍，h 与 A 逐位同（标定的终解与带内重解各一份）", () => {
    const R = reintegrate(S1, upliftU(regions, S1.s));
    assert.deepStrictEqual(R.A, S1.A); assert.deepStrictEqual(R.h, S1.h);
    const Uw = upliftU(regions, Float64Array.of(500, 300, 0)), B = steadyBand(G, { ...inp, U: Uw }, base, band, MAXIT), RB = reintegrate(B, Uw);
    assert.deepStrictEqual(RB.A, B.A); assert.deepStrictEqual(RB.h, B.h);
  });
  it("无回路；带内的水只流向带内、出口，或此后再也不回带的带外节点", () => {
    assert.ok(loopFree(S1.rcv));
    assert.strictEqual(backIntoBand(S1), 0);
  });
  it("余量为 0、山很高（带边被抬得高过上游的带外支流）时，带内的水也不流向会回带的带外节点", () => {
    for (const [r0, c0, R] of [[45, 58, 2], [50, 40, 4]]) {
      const reg = [disc(r0, c0, R, 3000)], S = upliftSolve(G, inp, base, bandOf(G, support(reg), 0), reg, peakAdd, MAXIT);
      assert.strictEqual(backIntoBand(S), 0); assert.ok(loopFree(S.rcv));
    }
  });
  it("各区最高点到目标（≤ 2%）；不抬就已高过目标的区系数为 0；带内重解停在流向树不变上", () => {
    for (const k of [0, 1]) {
      assert.ok(S1.s[k] > 0, `区 ${k} 没抬`);
      assert.ok(Math.abs(peakOf(S1.h, regions[k]) - regions[k].target) <= 0.02 * regions[k].target, `区 ${k} 峰高 ${peakOf(S1.h, regions[k])}，目标 ${regions[k].target}`);
    }
    assert.strictEqual(S1.s[2], 0);
    assert.ok(S1.converged, "最后一轮带内重解撞上了轮数上限");
  });
  it("量峰模板：量峰点换成邻点加权和时，区内加权和的最大值到目标（单点峰高于目标——平滑把它压回来）", () => {
    const reg = disc(40, 25, 3, 1500), off = [0], atN: number[] = [], wt: number[] = [];
    for (const i of reg.peak) {
      const r = (i / COLS) | 0, c = i % COLS, nb = [[0, 0, 0.5], [0, 1, 0.125], [0, -1, 0.125], [1, 0, 0.125], [-1, 0, 0.125]];
      for (const [dr, dc, w] of nb) { atN.push(at(r + dr, c + dc)); wt.push(w); }
      off.push(atN.length);
    }
    const st = { ...reg, stencil: { off: Int32Array.from(off), at: Int32Array.from(atN), w: Float64Array.from(wt) } };
    const S = upliftSolve(G, inp, base, bandOf(G, support([st]), 60), [st], peakAdd, MAXIT);
    let m = -Infinity; for (let p = 0; p < st.peak.length; p++) { let v = peakAdd[st.peak[p]]; for (let t = off[p]; t < off[p + 1]; t++) v += wt[t] * S.h[atN[t]]; m = Math.max(m, v); }
    assert.ok(Math.abs(m - st.target) <= 0.02 * st.target, `加权峰 ${m.toFixed(1)}，目标 ${st.target.toFixed(1)}`);
    assert.ok(peakOf(S.h, reg) > st.target, "单点峰应高过目标");
  });
  it("桥：两块带被同一条河在带外串起来时，中间的河段并进带，仍无回路、带外流向不变", () => {
    /* 汇流最大的河自河口逆流而上，取相隔 ≥ 25 格的两点各画一个小区，余量 10 km 不让两块带连上 */
    let m = -1; for (let i = 0; i < n; i++) if (!out[i] && (m < 0 || base.A[i] > base.A[m])) m = i;
    const stem = [m];
    for (;;) { const j = stem[stem.length - 1]; let best = -1; for (let i = 0; i < n; i++) if (base.rcv[i] === j && i !== j && (best < 0 || base.A[i] > base.A[best])) best = i; if (best < 0) break; stem.push(best); }
    assert.ok(stem.length > 30, `主干只有 ${stem.length} 个节点`);
    const rc = (i: number): [number, number] => [(i / COLS) | 0, i % COLS], [ra, ca] = rc(stem[2]), [rb, cb] = rc(stem[28]);
    const pair = [disc(ra, ca, 1, 400), disc(rb, cb, 1, 400)], raw = bandOf(G, support(pair), 10);
    const S = upliftSolve(G, inp, base, raw, pair, peakAdd, MAXIT);
    let bridges = 0, flips = 0; for (let i = 0; i < n; i++) { if (S.band[i] && !raw[i]) bridges++; if (!S.band[i] && S.rcv[i] !== base.rcv[i]) flips++; }
    assert.ok(bridges > 0, "没有桥——这一例没测到闭包");
    assert.strictEqual(flips, 0);
    assert.ok(loopFree(S.rcv));
  });
});
}

describe("最小堆（steady.Heap）", () => {
  it("开得比用量小也照常：满了按倍增长，弹出按（键, 节点号）升序", () => {
    const h = new Heap(2), keys: [number, number][] = [];
    for (let i = 0; i < 1000; i++) { const k = (i * 7919) % 101; h.push(k, 999 - i); keys.push([k, 999 - i]); }
    keys.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const got: number[] = []; while (h.n) got.push(h.pop());
    assert.deepStrictEqual(got, keys.map(x => x[1]));
  });
});
