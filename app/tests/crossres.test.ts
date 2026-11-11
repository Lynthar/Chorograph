/* 同一个世界换网格分辨率，规则场（光标读数、等高线与视域读的那张侵蚀后高程场）的读数差多少。
   钉的是现状：上限取实测值上浮约三成、比值取两侧，钉时的实测值写在各条断言旁——数字变小是进步，变大要有人解释。
   世界取内置示例「示例大陆」的参数（单块大陆、种子 6、半径 1 万 km、缺省图幅、起伏 0.7），只换 gridN */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gen2Fine, gen2Meso } from "../src/core/gen2.ts";
import { buildGridCells, gridGeom, type Grid } from "../src/core/grid.ts";
import { erodeField, erodeInput, upscaleOf, workNest, type ErodeInput } from "../src/core/erode.ts";
import { nestBaseOf, nestSolOf, nestedField } from "../src/core/nested.ts";
import { elevBilinear, elevSmooth, waterMask, waterSurface, type ElevField } from "../src/core/elev.ts";
import type { Meta } from "../src/core/types.ts";

const KMD = 2 * Math.PI * 10000 / 360;
const META = (gridN: number): Meta => ({ terrain: "auto", genVer: 2, genSeed: 6, genStyle: "mono", relief: 0.7, worldModel: "sphere", planetRadiusKm: 10000,
  bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 }, gridN });
/** 240、480 列的工作档走嵌套解，960 列细分 1 倍走细级侵蚀（这张图出生时盖的 1257 列也走这条） */
const GNS = [240, 480, 960] as const;

interface Level { grid: Grid; f: ElevField; sx: number; nest: boolean; um: number; wat: Uint8Array; ws: Float32Array; lakeOf: Int32Array }
const LV = new Map<number, Level>();
/** 一档的规则场：中尺度 → 侵蚀输入 → 工作档（同 shell/host 组装侵蚀单的那条链），每档只算一次 */
function level(gn: number): Level {
  const hit = LV.get(gn);
  if (hit) return hit;
  const m = META(gn), g = gridGeom(m), R = gen2Meso(m, g), grid = buildGridCells(m, [], 0, R), inp = erodeInput(m, [], grid, 0)!;
  const w = workNest(inp, { base: nestBaseOf(R.st), sol: nestSolOf(R.st, R.st.base, null) });
  const L: Level = { grid, f: w.nest ? nestedField(w) : erodeField(w), sx: upscaleOf(inp.cols, inp.rows, inp.cap, inp.axisMax), nest: !!w.nest, um: inp.unitM,
    wat: waterMask(grid), ws: waterSurface(m, grid), lakeOf: gen2Fine(m, g).lakeOf };
  LV.set(gn, L);
  return L;
}
const cellAt = (g: Grid, lon: number, lat: number): number => Math.floor((lat - g.bb.latMin) / g.step) * g.cols + Math.floor((lon - g.bb.lonMin) / g.step);
const fmt = (v: readonly number[]): string => v.map(x => x.toFixed(2)).join(" / ");
/** 比值的两侧：钉时 r，落在 [r / 1.3, r × 1.3] */
const near30 = (x: number, r: number): boolean => x >= r / 1.3 && x <= r * 1.3;

describe("同一个世界换网格分辨率：规则场读数", () => {
  it("夹具：240 / 480 列走嵌套解（7 倍、3 倍），960 列细分 1 倍走细级侵蚀；规则场细格边 4.99 / 5.82 / 8.73 km", () => {
    assert.deepStrictEqual(GNS.map(gn => { const L = level(gn); return [L.sx, L.nest, +(L.f.step * KMD).toFixed(2)]; }), [[7, true, 4.99], [3, true, 5.82], [1, false, 8.73]]);
  });

  it("五个固定点的光标读数（elevSmooth）：各档之间的最大差", () => {
    /* 山顶附近＝480 列中尺度基底最高的格心；山麓、平原、河谷（中尺度河上）取自 480 列；湖岸陆侧挨着 240 列的 0 号湖（水面 323.93 m）。
       列：名、经、纬、钉时各档读数（米，240 / 480 / 960 列）、最大差上限（米） */
    const PTS: [string, number, number, readonly number[], number][] = [
      ["山顶附近", 102.05, 40.15, [3970.05, 5855.40, 4929.12], 2450],
      ["山麓", 101.55, 41.75, [739.76, 717.96, 1004.87], 373],
      ["平原", 99.35, 44.35, [242.59, 253.36, 225.04], 37],
      ["河谷", 99.9267, 40.9184, [427.88, 410.51, 366.22], 80],
      ["湖岸陆侧", 111.1, 32.7, [351.68, 365.22, 341.32], 31],
    ];
    for (const [name, lon, lat, was, cap] of PTS) {
      const v = GNS.map(gn => { const L = level(gn); assert.ok(!L.wat[cellAt(L.grid, lon, lat)], `${name} 在 ${gn} 列落进了水格`); return elevSmooth(L.f.data, L.f, lon, lat) * L.um; });
      const d = Math.max(...v) - Math.min(...v);
      assert.ok(d <= cap, `${name}：${fmt(v)} m，最大差 ${d.toFixed(2)} m（钉时 ${fmt(was)} m、差 ${(Math.max(...was) - Math.min(...was)).toFixed(2)} m；上限 ${cap} m）`);
    }
  });

  it("陆地高程（陆格里的细格）p50 / p99：各档最高比最低多出的比例", () => {
    const pct = GNS.map(gn => {
      const { f, grid, wat, um, sx } = level(gn), v: number[] = [];
      for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) if (!wat[((r / sx) | 0) * grid.cols + ((c / sx) | 0)]) v.push(f.data[r * f.cols + c] * um);
      v.sort((a, b) => a - b);
      return [v[Math.floor(0.5 * v.length)], v[Math.floor(0.99 * v.length)]];
    });
    const rel = (k: number): number => Math.max(...pct.map(p => p[k])) / Math.min(...pct.map(p => p[k])) - 1;
    /* 钉时：p50 462.07 / 461.84 / 460.86 m（0.26%），p99 3692.77 / 4049.08 / 4012.97 m（9.65%，240 列最低） */
    assert.ok(rel(0) <= 0.0034, `p50 ${fmt(pct.map(p => p[0]))} m，相对差 ${(100 * rel(0)).toFixed(3)}%（钉时 0.263%）`);
    assert.ok(rel(1) <= 0.125, `p99 ${fmt(pct.map(p => p[1]))} m，相对差 ${(100 * rel(1)).toFixed(2)}%（钉时 9.65%）`);
  });

  it("湖面：三档共有的湖逐个比水面；960 列多出的 8 号湖只在那一档", () => {
    const lakes = GNS.map(gn => {
      const { lakeOf, wat, ws, um } = level(gn), s = new Map<number, number[]>();
      for (let i = 0; i < lakeOf.length; i++) if (lakeOf[i] >= 0 && wat[i]) { const a = s.get(lakeOf[i]) || []; a.push(ws[i] * um); s.set(lakeOf[i], a); }
      return s;
    });
    assert.deepStrictEqual(lakes.map(s => [...s.keys()].sort((a, b) => a - b)), [[0, 1, 3, 4, 5, 6, 7], [0, 1, 3, 4, 5, 6, 7], [0, 1, 3, 4, 5, 6, 7, 8]], "各档的湖");
    let worst = 0, at = -1;
    for (const id of lakes[0].keys()) {
      const v = lakes.flatMap(s => s.get(id)!), d = Math.max(...v) - Math.min(...v);
      if (d > worst) { worst = d; at = id; }
    }
    /* 钉时：0–6 号湖三档逐值相同；7 号湖 240 列（只 4 格）240.10 m、480 与 960 列 240.53 m */
    assert.ok(worst <= 0.56, `同一个湖的水面最大差 ${worst.toFixed(3)} m（${at} 号湖；钉时 0.430 m、7 号湖）`);
  });

  it("山区窗口的局部起伏：24 km 见方窗内最高减最低的中位数，各档对 480 列之比", () => {
    /* 窗口以山顶附近为心 4°×3°（约 535×524 km，七成半高过 1500 m）；1 km 取样，窗心每 4 km 一个，窗里碰到水格的不算 */
    const lon0 = 100.05, lat0 = 38.65, dla = 1 / KMD, dlo = 1 / (KMD * Math.cos(40.15 * Math.PI / 180)), NX = Math.floor(4 / dlo), NY = Math.floor(3 / dla), H = 12;
    const med = GNS.map(gn => {
      const { f, grid, wat, um } = level(gn), v = new Float64Array(NX * NY), wet = new Uint8Array(NX * NY), rel: number[] = [];
      for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
        const lon = lon0 + (x + 0.5) * dlo, lat = lat0 + (y + 0.5) * dla;
        v[y * NX + x] = elevBilinear(f.data, f, lon, lat) * um; wet[y * NX + x] = wat[cellAt(grid, lon, lat)];
      }
      for (let y = H; y < NY - H; y += 4) for (let x = H; x < NX - H; x += 4) {
        let lo = Infinity, hi = -Infinity, w = 0;
        for (let dy = -H; dy <= H && !w; dy++) for (let dx = -H; dx <= H; dx++) { const j = (y + dy) * NX + x + dx; if (wet[j]) { w = 1; break; } if (v[j] < lo) lo = v[j]; if (v[j] > hi) hi = v[j]; }
        if (!w) rel.push(hi - lo);
      }
      rel.sort((a, b) => a - b);
      return rel[rel.length >> 1];
    });
    /* 钉时：1347.08 / 1546.40 / 967.07 m，对 480 列之比 0.871 / 1 / 0.625 */
    const r240 = med[0] / med[1], r960 = med[2] / med[1];
    assert.ok(near30(r240, 0.871) && near30(r960, 0.625), `中位起伏 ${fmt(med)} m，240 / 960 列对 480 列 ${r240.toFixed(3)} / ${r960.toFixed(3)}（钉时 0.871 / 0.625）`);
  });
});

/* 0.5 m/km 的匀坡（160×128 格、西图幅边是出口、细分 1 倍，格数够粗级跑、河道起始阈值不封顶），只换格边 20/3 km 与 23 km（战略图自动档与整球图的格）。
   起伏滑杆取 0：坡的上段高过山地度门槛，叠上的真起伏会混进残差；坡脚取在地类地板 0.10 上，地板不另截谷 */
const SLOPE_U = 0.5 / 2000;
function slopePlain(cellKm: number, meso: boolean): ErodeInput {
  const cols = 160, rows = 128, n = cols * rows, step = cellKm / 111.19, elev0 = new Float32Array(n);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) elev0[r * cols + c] = 0.10 + SLOPE_U * (c + 0.5) * cellKm;
  return { bb: { lonMin: 100, lonMax: 100 + cols * step, latMin: 30, latMax: 30 + rows * step }, step, cols, rows, elev0, water: new Uint8Array(n), wsurf: new Float32Array(n),
    amp: 0, seed: 4242, kmx: 111.19, kmy: 111.19, hovGrid: new Float32Array(n), cap: n, axisMax: 8, acrit: 300, bandS: 1, unitM: 2000, sphere: false, ...(meso ? { mesoEnv: new Float32Array(n) } : {}) };
}
/** 内圈（四边各让 4 格）对最小二乘平面的残差（米）：RMS 与最大绝对值 */
function planeResid(f: ElevField, cellKm: number): { rms: number; max: number } {
  const M = 4, pts: [number, number, number][] = [];
  for (let r = M; r < f.rows - M; r++) for (let c = M; c < f.cols - M; c++) pts.push([c * cellKm, r * cellKm, f.data[r * f.cols + c] * 2000]);
  const mean = (k: number): number => pts.reduce((s, p) => s + p[k], 0) / pts.length, mx = mean(0), my = mean(1), mz = mean(2);
  let sxx = 0, syy = 0, sxz = 0, syz = 0;
  for (const [x, y, z] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxz += (x - mx) * (z - mz); syz += (y - my) * (z - mz); }
  const bx = sxz / sxx, by = syz / syy;   // 整矩形格点上 x、y 去均值后正交，两个斜率各自回归就是联立解
  let ss = 0, max = 0;
  for (const [x, y, z] of pts) { const e = z - mz - bx * (x - mx) - by * (y - my); ss += e * e; if (Math.abs(e) > max) max = Math.abs(e); }
  return { rms: Math.sqrt(ss / pts.length), max };
}

describe("平原上的假起伏：0.5 m/km 匀坡侵蚀后对最佳拟合平面的残差", () => {
  /* 列：名、带不带中尺度包络、钉时 [RMS, 最大] 与上限 [RMS, 最大]（米；先 20/3 km、后 23 km） */
  const CASES: [string, boolean, [number, number][], [number, number][]][] = [
    ["细级侵蚀的最小输入（粗级参与、类型基面域扭曲）", false, [[29.79, 110.02], [112.06, 460.42]], [[39, 143], [146, 599]]],
    ["带中尺度包络（v2 图细分 1 倍时的路径；包络在平原上为 0）", true, [[2.97, 21.47], [8.41, 61.56]], [[3.9, 28], [10.9, 80]]],
  ];
  for (const [name, meso, was, cap] of CASES) {
    it(name, () => {
      [20 / 3, 23].forEach((km, k) => {
        const { rms, max } = planeResid(erodeField(slopePlain(km, meso)), km);
        assert.ok(rms <= cap[k][0] && max <= cap[k][1], `格边 ${km.toFixed(2)} km：RMS ${rms.toFixed(2)} m、最大 ${max.toFixed(2)} m（钉时 ${was[k][0]} / ${was[k][1]} m；上限 ${cap[k][0]} / ${cap[k][1]} m）`);
      });
    });
  }
});
