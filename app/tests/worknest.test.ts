/* 工作档嵌套解（core/erode.workNest + core/nested）：带中尺度的 v2 战略图，工作档细分 ≥ 2 倍时全图一窗走块层同一套嵌套解，块的目标面改取它。
   夹具是工作档恰 2 倍的图（640×480 格、格边约 5.6 km，同缺省大陆图的档位），工作档与画山 / 画盆的那份各解一次、各条共用 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gen2Meso, gen2Params, gen2Uplift, riverParams, type Gen2Uplift } from "../src/core/gen2.ts";
import { buildGridCells, gridGeom } from "../src/core/grid.ts";
import { elevBilinear, elevSmooth, type ElevField } from "../src/core/elev.ts";
import { erodeField, erodeInput, erodeKey, ultraInput, upscaleOf, workNest, WORK_NEST_MIN, type ErodeInput } from "../src/core/erode.ts";
import { NEST_TGT_Q, nestBaseOf, nestedField, nestSolOf, nestSolve, type NestSrc } from "../src/core/nested.ts";
import { tileCells, tileCore, tileInput, tileKeyOf, tilePlan, type TilePlan } from "../src/core/tiles.ts";
import type { Meta } from "../src/core/types.ts";

const META: Meta = { terrain: "auto", genVer: 2, genSeed: 7, genStyle: "multi", worldModel: "sphere", planetRadiusKm: 6371, gridN: 640, relief: 0.7,
  bbox: { lonMin: 90, lonMax: 122, latMin: 22, latMax: 46 } };
const fieldHash = (f: ElevField): string => {
  let x = 0x811c9dc5 | 0;
  const u = new Uint32Array(f.data.buffer, f.data.byteOffset, f.data.length);
  for (let i = 0; i < u.length; i++) x = Math.imul(x ^ u[i], 16777619);
  return (x >>> 0).toString(36);
};
const q = (v: number[], p: number): number => v[Math.min(v.length - 1, Math.floor(p * v.length))];

interface Fix { R: ReturnType<typeof gen2Meso>; inp: ErodeInput; nest: NestSrc; w: ErodeInput; WN: ElevField; plan: TilePlan; um: number; cols: number; rows: number }
let FIX: Fix | null = null;
const fix = (): Fix => {
  if (FIX) return FIX;
  const geom = gridGeom(META), R = gen2Meso(META, geom), grid = buildGridCells(META, [], 0, R), inp = erodeInput(META, [], grid, 0)!;
  const nest: NestSrc = { base: nestBaseOf(R.st), sol: nestSolOf(R.st, R.st.base, null) }, w = workNest(inp, nest), WN = nestedField(w);
  FIX = { R, inp, nest, w, WN, plan: tilePlan(w, 48e6, w.nest!.sx)!, um: inp.unitM, cols: geom.cols, rows: geom.rows };
  return FIX;
};
/** 山前（宏观抬升 0.25–0.4）一处画 4500 m 的山，或最干的低地一处画 −100 m 的盆（四周 6 格都是陆地）；两样分开画——画盆让每块的单都多出盆地掩码 */
interface Paint { U: Gen2Uplift; inp: ErodeInput; src: NestSrc; w: ErodeInput; WN: ElevField; cells: number[] }
const PAINT = new Map<string, Paint>();
const paint = (kind: "peak" | "bowl"): Paint => {
  const hit = PAINT.get(kind);
  if (hit) return hit;
  const { R, cols, rows, um } = fix(), st = R.st, out = st.pr.inp.out, fU = st.pr.fU, fM = st.pr.fM;
  const land = (r: number, c: number): boolean => { for (let dr = -6; dr <= 6; dr++) for (let dc = -6; dc <= 6; dc++) if (out[(r + dr) * cols + c + dc]) return false; return true; };
  let mtn = -1, dry = -1;
  for (let r = 20; r < rows - 20; r++) for (let c = 20; c < cols - 20; c++) {
    const i = r * cols + c; if (!land(r, c)) continue;
    if (mtn < 0 && fU[i] >= 0.25 && fU[i] < 0.4) mtn = i;
    if (R.base[i] * um < 700 && (dry < 0 || fM[i] < fM[dry])) dry = i;
  }
  const disc = (c0: number): number[] => { const a: number[] = []; for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) if (dr * dr + dc * dc <= 9) a.push(c0 + dr * cols + dc); return a.sort((x, y) => x - y); };
  const cells = disc(kind === "peak" ? mtn : dry), none = new Int32Array(0);
  const U = gen2Uplift(st, kind === "peak" ? { idx: Int32Array.from(cells), peakM: new Float64Array(cells.length).fill(4500) }
    : { idx: none, peakM: new Float64Array(0), fidx: Int32Array.from(cells), floorM: new Float64Array(cells.length).fill(-100) }, riverParams(META));
  const inp = erodeInput(META, [], buildGridCells(META, [], 0, U), 0)!, src: NestSrc = { base: fix().nest.base, sol: nestSolOf(st, U.sol, U.up) }, w = workNest(inp, src);
  const P = { U, inp, src, w, WN: nestedField(w), cells };
  PAINT.set(kind, P);
  return P;
};
/** 一张场在父格 k 里光标能读到的读数（core/elev.elevSmooth）：各细格的格心、边中点与角点——读数分片双线性，极值落在这些点上 */
const readings = (f: ElevField, k: number, cols: number, sx: number): number[] => {
  const r = (k / cols) | 0, c = k % cols, out: number[] = [];
  for (let a = 0; a < 2 * sx + 1; a++) for (let b = 0; b < 2 * sx + 1; b++) out.push(elevSmooth(f.data, f, f.bb.lonMin + (c * sx + b / 2) * f.step, f.bb.latMin + (r * sx + a / 2) * f.step));
  return out;
};
/** 一张场在父格 k 里的各细格高程 */
const fineOf = (f: ElevField, k: number, cols: number, sx: number): number[] => {
  const r = (k / cols) | 0, c = k % cols, out: number[] = [];
  for (let y = 0; y < sx; y++) for (let x = 0; x < sx; x++) out.push(f.data[(r * sx + y) * f.cols + c * sx + x]);
  return out;
};
/** 山地父格（收尾的抬升权重 ≥ 0.25）最多的几块 */
const mountainTiles = (n: number): number[] => {
  const { R, plan, cols } = fix(), fU = R.st.pr.fU, cnt = (t: number): number => {
    const T = tileCells(plan.geom, t); let k = 0;
    for (let r = T.r0; r < T.r1; r++) for (let c = T.c0; c < T.c1; c++) if (fU[r * cols + c] > 0.25 && !fix().inp.water[r * cols + c]) k++;
    return k;
  };
  return plan.tiles.slice().sort((a, b) => cnt(b) - cnt(a) || a - b).slice(0, n);
};

describe("工作档嵌套解（core/erode.workNest）", () => {
  it("工作档单：全图一窗、倍率同细级侵蚀工作档（这张图 2 倍）、不带包络；1 倍的图（整球）原样返回；嵌套解的图不发精修单", () => {
    const { inp, nest, w, WN, cols, rows } = fix();
    assert.strictEqual(upscaleOf(inp.cols, inp.rows, inp.cap, inp.axisMax), 2, "夹具：工作档 2 倍");
    const ne = w.nest!;
    assert.ok(ne.wx === 0 && ne.wy === 0 && ne.wcols === cols && ne.wrows === rows && ne.x0 === 0 && ne.sx === 2 && ne.tgt === null);
    assert.deepStrictEqual(ne.pk, [], "没画山：校峰区为空（不是 null——null 是块单）");
    assert.ok(inp.mesoEnv && !("mesoEnv" in w), "中尺度单的包络嵌套解不读：不进单、不进键");
    assert.ok(WN.cols === cols * 2 && WN.rows === rows * 2 && WN.bb.lonMax === inp.bb.lonMax && WN.eroded);
    const one = { ...inp, cap: inp.cols * inp.rows };
    assert.ok(upscaleOf(one.cols, one.rows, one.cap, one.axisMax) < WORK_NEST_MIN && workNest(one, nest) === one, "1 倍的图照旧细级侵蚀");
    assert.strictEqual(ultraInput(w, 10_500_000), null, "嵌套解的工作档不精修");
    assert.ok(ultraInput(inp, 10_500_000), "前提：同一张图的细级侵蚀工作档本来要精修");
  });

  it("两次逐位同、结构化克隆后同（Worker 收到的就是克隆）；输出钉死", () => {
    const { w, WN } = fix();
    const b = nestedField(w), c = nestedField(structuredClone(w));
    assert.ok(WN.data.every((v, i) => v === b.data[i] && v === c.data[i]), "同一单解出两样");
    assert.strictEqual(fieldHash(WN), "1qpn6pm");
  });

  it("块与工作档之差：目标面取工作档的块，山地块心细格对工作档 p90 不到旧块（目标面取父基底）的 80%；父格均值之差 p90 < 40 m", () => {
    const { w, nest, WN, plan, um, cols, R } = fix(), fU = R.st.pr.fU, sx = plan.geom.sx, srcW: NestSrc = { ...nest, work: { data: WN.data, sx: 2 } };
    const dNew: number[] = [], dOld: number[] = [], dPar: number[] = [];
    for (const ti of mountainTiles(3)) {
      const T = tileCells(plan.geom, ti), Wd = (T.c1 - T.c0) * sx;
      const a = tileCore(nestedField(tileInput(w, plan, null, ti, srcW)), plan, ti), b = tileCore(nestedField(tileInput(w, plan, null, ti, nest)), plan, ti);
      for (let pr = T.r0; pr < T.r1; pr++) for (let pc = T.c0; pc < T.c1; pc++) {
        const k = pr * cols + pc; if (w.water[k] || !(fU[k] > 0.25)) continue;
        let sa = 0, sw = 0;
        for (let y = 0; y < sx; y++) for (let x = 0; x < sx; x++) {
          const j = ((pr - T.r0) * sx + y) * Wd + (pc - T.c0) * sx + x, e = elevBilinear(WN.data, WN, plan.geom.lonMin + (pc * sx + x + 0.5) * plan.geom.step, plan.geom.latMin + (pr * sx + y + 0.5) * plan.geom.step);
          dNew.push(Math.abs(a[j] - e) * um); dOld.push(Math.abs(b[j] - e) * um); sa += a[j];
        }
        for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) sw += WN.data[(pr * 2 + y) * WN.cols + pc * 2 + x];
        dPar.push(Math.abs(sa / (sx * sx) - sw / 4) * um);
      }
    }
    for (const v of [dNew, dOld, dPar]) v.sort((x, y) => x - y);
    assert.ok(dNew.length > 100000, `山地块细格 ${dNew.length}`);
    assert.ok(q(dNew, 0.9) < 0.8 * q(dOld, 0.9), `块对工作档 p90：新 ${q(dNew, 0.9).toFixed(1)} m、旧 ${q(dOld, 0.9).toFixed(1)} m`);
    assert.ok(q(dPar, 0.9) < 40, `父格均值之差 p90 ${q(dPar, 0.9).toFixed(1)} m`);
  });

  it("等高线跟谷：块里的河道（汇流 ≥ 50 km²）在工作档上是谷（比一个工作格外的环低）的占 85% 以上，中位谷深是细级侵蚀工作档的 2 倍以上", () => {
    const { w, nest, WN, plan, inp, um, cols, R } = fix(), fU = R.st.pr.fU, sx = plan.geom.sx, D8 = erodeField(inp), srcW: NestSrc = { ...nest, work: { data: WN.data, sx: 2 } };
    const depth = (F: ElevField, lon: number, lat: number): number => {
      let s = 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) s += elevSmooth(F.data, F, lon + dx * F.step, lat + dy * F.step);
      return (s / 8 - elevSmooth(F.data, F, lon, lat)) * um;
    };
    const dW: number[] = [], dD: number[] = [];
    for (const ti of mountainTiles(3)) {
      const tinp = tileInput(w, plan, null, ti, srcW), S = nestSolve(tinp), ne = tinp.nest!, FC = S.F.FC, T = tileCells(plan.geom, ti);
      for (let i = 0; i < S.sol.A.length; i++) {
        if (S.F.wat[i] || S.sol.A[i] < 50) continue;
        const gc = ne.wx * sx + (i % FC), gr = ne.wy * sx + ((i / FC) | 0), pc = (gc / sx) | 0, pr = (gr / sx) | 0;
        if (pc < T.c0 || pc >= T.c1 || pr < T.r0 || pr >= T.r1 || !(fU[pr * cols + pc] > 0.25)) continue;
        const lon = plan.geom.lonMin + (gc + 0.5) * plan.geom.step, lat = plan.geom.latMin + (gr + 0.5) * plan.geom.step;
        dW.push(depth(WN, lon, lat)); dD.push(depth(D8, lon, lat));
      }
    }
    dW.sort((a, b) => a - b); dD.sort((a, b) => a - b);
    const inV = dW.filter(x => x > 0).length / dW.length;
    assert.ok(dW.length > 5000, `块河道细格 ${dW.length}`);
    assert.ok(inV > 0.85, `工作档上是谷 ${(100 * inV).toFixed(1)}%（细级侵蚀 ${(100 * dD.filter(x => x > 0).length / dD.length).toFixed(1)}%）`);
    assert.ok(q(dW, 0.5) > 2 * q(dD, 0.5), `中位谷深：嵌套 ${q(dW, 0.5).toFixed(1)} m、细级侵蚀 ${q(dD, 0.5).toFixed(1)} m`);
  });

  it("画的山峰高＝目标：涂抹格里细格高程的最大值与 4500 m 差不到 1 m，不校时高出一截，光标读数（elevSmooth，含半格点）略低；平移沿软边渐退、只动支撑外扩一格之内", () => {
    const { um, cols } = fix(), P = paint("peak"), ne = P.w.nest!;
    assert.ok(P.U.up && P.U.up.regs.length === 1 && ne.pk!.length === 1 && ne.pk![0].T === 4500, "一区抬到了目标、进了工作档单");
    const raw = nestedField({ ...P.w, nest: { ...ne, pk: [] } });
    const top = (f: ElevField): number => Math.max(...P.cells.flatMap(k => fineOf(f, k, cols, 2))) * um;
    const read = Math.max(...P.cells.flatMap(k => readings(P.WN, k, cols, 2))) * um;
    assert.ok(Math.abs(top(P.WN) - 4500) < 1, `细格的峰 ${top(P.WN).toFixed(2)} m`);
    assert.ok(top(raw) - top(P.WN) > 10, `不校峰 ${top(raw).toFixed(1)} m`);
    assert.ok(read <= top(P.WN) && read > 4350, `读到的峰 ${read.toFixed(1)} m`);
    const sup = new Set<number>();
    for (const k of ne.pk![0].idx) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) sup.add(k + dr * cols + dc);
    let moved = 0, far = 0;
    for (let i = 0; i < raw.data.length; i++) if (raw.data[i] !== P.WN.data[i]) { moved++; if (!sup.has(((((i / P.WN.cols) | 0) / 2) | 0) * cols + (((i % P.WN.cols) / 2) | 0))) far++; }
    assert.ok(moved > 100 && far === 0, `校峰动了 ${moved} 格、支撑外扩一格之外 ${far} 格`);
    /* 平移量＝Δ × 软边权重（父格双线性）：区心整移 Δ、向外渐退到 0，支撑边上没有台阶 */
    const F = new Float32Array(cols * fix().rows), R0 = ne.pk![0], g = gridGeom(META);
    R0.idx.forEach((k, t) => { F[k] = R0.f[t]; });
    assert.ok(R0.f.every((v, t) => v === ne.kw![R0.idx[t]]) && Math.min(...R0.f) < 0.2, "平移权重就是画抬升的软边权重（区心 1、向外渐退）");
    const wAt = (i: number): number => elevBilinear(F, g, P.WN.bb.lonMin + ((i % P.WN.cols) + 0.5) * P.WN.step, P.WN.bb.latMin + (((i / P.WN.cols) | 0) + 0.5) * P.WN.step);
    let D = NaN, n = 0, worst = 0;
    for (let i = 0; i < raw.data.length && D !== D; i++) if (wAt(i) === 1) D = raw.data[i] - P.WN.data[i];
    for (let i = 0; i < raw.data.length; i++) { const wv = wAt(i); if (!(wv > 0)) continue; n++; worst = Math.max(worst, Math.abs(raw.data[i] - P.WN.data[i] - D * wv)); }
    assert.ok(D > 0 && n > 400 && worst * um < 0.5, `区心平移 ${(D * um).toFixed(1)} m，${n} 个细格里偏离「Δ × 软边权重」最多 ${(worst * um).toFixed(2)} m`);
  });

  it("目标低于现地面的区不抬，也不校峰（读数照地面）", () => {
    const { R, um, cols } = fix(), st = R.st, out = st.pr.inp.out;
    let c = -1; for (let i = 0; i < out.length && c < 0; i++) if (!out[i] && R.base[i] * um > 2500 && !out[i - 1] && !out[i + 1] && !out[i - cols] && !out[i + cols]) c = i;
    const U = gen2Uplift(st, { idx: Int32Array.of(c), peakM: Float64Array.of(500) }, riverParams(META));
    assert.ok(U.s.length === 1 && U.s[0] === 0 && U.up!.regs.length === 0, "已高过目标的区：不抬、不进校峰");
  });

  it("画的盆地与盐滩：盐滩格都在下沉支撑里；盆心（四个父格都在支撑里）的细格照目标面、与起伏档无关；盆底读数不低于中尺度盆底", () => {
    const { um, cols } = fix(), P = paint("bowl"), bas = P.w.basin!;
    let salt = 0;
    for (let k = 0; k < bas.length; k++) if (bas[k] & 2) { salt++; assert.ok(bas[k] & 1, "盐滩不在支撑里（会叠上坡面细节）"); }
    assert.ok(salt > 0 && P.U.water!.list.some(x => x.kind === 2), "夹具：盆里成了盐滩");
    const flat = nestedField({ ...P.w, amp: 0 }), F = P.WN;
    let deep = 0, diff = 0;
    for (let i = 0; i < F.data.length; i++) {
      const fx = ((i % F.cols) + 0.5) / 2 - 0.5, fy = (((i / F.cols) | 0) + 0.5) / 2 - 0.5, x = Math.floor(fx), y = Math.floor(fy);
      if (x < 0 || y < 0 || x + 1 >= cols || !(bas[y * cols + x] & 1 && bas[y * cols + x + 1] & 1 && bas[(y + 1) * cols + x] & 1 && bas[(y + 1) * cols + x + 1] & 1)) continue;
      deep++; if (F.data[i] !== flat.data[i]) diff++;
    }
    assert.ok(deep > 100 && diff === 0, `盆心细格 ${deep}，随起伏档变了 ${diff}`);
    const floor = Math.min(...P.cells.map(k => P.U.base[k])) * um, low = Math.min(...P.cells.flatMap(k => readings(F, k, cols, 2))) * um;
    assert.ok(low >= floor - 0.01 && low < floor + 30, `盆底读数 ${low.toFixed(1)} m、中尺度盆底 ${floor.toFixed(1)} m`);
  });

  it("旧高程涂改：工作档照叠（陆细格整格 dh、水细格不动）；块的目标面是工作档时不再叠第二份", () => {
    const { w, nest, plan } = fix(), dh = 0.05, wh = { ...w, hovGrid: new Float32Array(w.hovGrid.length).fill(dh) };
    const a = fix().WN.data, b = nestedField(wh), wat = nestSolve(w).F.wat;
    let land = 0, exact = 0;
    for (let i = 0; i < a.length; i++) { if (wat[i]) { assert.strictEqual(b.data[i], a[i]); continue; } land++; if (Math.abs(b.data[i] - a[i] - dh) < 1e-6) exact++; }
    assert.ok(exact / land > 0.99, `叠上整格 dh 的陆细格 ${(100 * exact / land).toFixed(1)}%`);
    const ti = mountainTiles(1)[0], src: NestSrc = { ...nest, work: { data: b.data, sx: 2 } };
    const x = nestedField(tileInput(wh, plan, null, ti, src)).data, y = nestedField(tileInput(w, plan, null, ti, src)).data;
    assert.ok(x.every((v, i) => v === y[i]), "块单带着涂改又取了带涂改的工作档：涂改叠了两份");
  });

  it("低通半径取整数格：块 7 倍对工作档 2 倍（3.5 个细格）照常出场——没有 NaN、陆细格贴着工作档（非整数半径的低通出 NaN，再被陆地下限钳成一片水面高）", () => {
    const { w, nest, WN } = fix(), all = tilePlan(w, 1e12, 2)!, area = all.tiles.reduce((s, t) => { const T = tileCells(all.geom, t); return s + (T.c1 - T.c0) * (T.r1 - T.r0); }, 0);
    const plan7 = tilePlan(w, area * 50, 2)!;
    assert.strictEqual(plan7.geom.sx, 7);
    const ti = mountainTiles(1)[0], tinp = tileInput(w, plan7, null, ti, { ...nest, work: { data: WN.data, sx: 2 } }), f = nestedField(tinp), wat = nestSolve(tinp).F.wat, d: number[] = [];
    assert.ok(f.data.every(v => Number.isFinite(v)), "出了 NaN");
    for (let i = 0; i < f.data.length; i++) if (!wat[i]) d.push(Math.abs(f.data[i] - elevBilinear(WN.data, WN, f.bb.lonMin + ((i % f.cols) + 0.5) * f.step, f.bb.latMin + (((i / f.cols) | 0) + 0.5) * f.step)) * fix().um);
    d.sort((a, b) => a - b);
    assert.ok(d.length > 10000 && q(d, 0.9) < 100, `陆细格对工作档 p90 ${q(d, 0.9).toFixed(1)} m`);
  });

  it("键：工作档单与细级侵蚀单不同键、校峰区变了即换键；块单带量化的工作档裁片——不到半步的扰动不换键、差一步换键", () => {
    const { inp, w, nest, WN, plan } = fix(), P = paint("peak");
    assert.notStrictEqual(erodeKey(w), erodeKey(inp));
    const kp = erodeKey(P.w), pk = P.w.nest!.pk!;
    assert.notStrictEqual(erodeKey({ ...P.w, nest: { ...P.w.nest!, pk: [{ ...pk[0], T: 4600 }] } }), kp, "目标峰高变了");
    assert.notStrictEqual(erodeKey({ ...P.w, nest: { ...P.w.nest!, pk: [] } }), kp, "校峰区没了");
    const ti = mountainTiles(1)[0], T = tileCells(plan.geom, ti), j = ((T.r0 + 5) * 2) * WN.cols + (T.c0 + 5) * 2;
    const key = (d: Float32Array): string => tileKeyOf(w, plan, null, ti, { ...nest, work: { data: d, sx: 2 } });
    const base = Float32Array.from(WN.data), k0 = Math.floor(base[j] / NEST_TGT_Q + 0.5) * NEST_TGT_Q;
    base[j] = k0; const k = key(base);
    base[j] = k0 + NEST_TGT_Q / 8; assert.strictEqual(key(base), k, "不到半步的扰动换了键");
    base[j] = k0 - NEST_TGT_Q / 8; assert.strictEqual(key(base), k);
    base[j] = k0 + NEST_TGT_Q; assert.notStrictEqual(key(base), k, "差一步没换键");
    assert.notStrictEqual(tileKeyOf(w, plan, null, ti, nest), k, "带裁片与不带不同键");
    const tq = tileInput(w, plan, null, ti, { ...nest, work: { data: WN.data, sx: 2 } }).nest!.tgt!;
    assert.ok(tq.every(v => Number.isInteger(v / NEST_TGT_Q)), "裁片按量化步长存（解与键同一份）");
  });

  it("一笔只换碰到它的块：画一处山，带工作档裁片的块键换掉的不到一成", () => {
    const { w, nest, WN, plan } = fix(), P = paint("peak");
    let n = 0;
    for (const ti of plan.tiles) if (tileKeyOf(w, plan, null, ti, { ...nest, work: { data: WN.data, sx: 2 } }) !== tileKeyOf(P.w, plan, null, ti, { ...P.src, work: { data: P.WN.data, sx: 2 } })) n++;
    assert.ok(n >= 1 && n < plan.tiles.length / 10, `换键 ${n} / ${plan.tiles.length}`);
  });
});
