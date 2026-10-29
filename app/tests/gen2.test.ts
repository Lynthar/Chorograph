/* 生成器 v2（core/gen2）：确定性、湖与水面、渲染端约束、滑杆方向、与 v1 的分流。
   输出哈希是冻结的基线（同 worker.test 钉字面键）：改了生成数学就会红，换代要想清楚旧图会变成什么样。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BAND_CONTRAST, BAND_U0, BAND_U1, bandMultAt, bandSpecOf, buildMacro, gen2Fine, gen2Macro, gen2Meso, gen2Uplift, mesoSmoothOf, mesoState, type BasinWaters, type MesoState, upliftRegions, gen2Params, gen2Rivers, GEN2_SEED_MAX, isGen2, riverParams, type GenRiver, type Macro, PEAK_KNEE_M, PEAK_SOFT_M, peakCapM, peakKneeM, pointOf } from "../src/core/gen2.ts";
import { buildGridCells, gridGeom } from "../src/core/grid.ts";
import { Heap } from "../src/core/steady.ts";
import { baseElev, waterSurface, NO_WATER, SHORE_E } from "../src/core/elev.ts";
import { seedTerrain, GEN_SEED_MAX } from "../src/core/terrain.ts";
import { allComposites, ECO_ORDER, LANDFORM_ORDER, MZ_MAX, terrainProps } from "../src/core/constants.ts";
import { RIV_LOOP, riverSet } from "../src/render/rivers.ts";
import { chaikinOpen } from "../src/core/geometry.ts";
import type { Landform, Meta } from "../src/core/types.ts";
import type { UpliftCells } from "../src/core/gen2.ts";
import { cellRand } from "../src/core/gen2mesh.ts";
import { BB, closedPits, dfltOf, RIV_MOUTH_X, v2 } from "./fixtures/gen2-maps.ts";

/** 画抬升单的抽河参数（缺省两档滑杆、这组图幅）：只定画哪些河，地形不随它变 */
const RP0 = riverParams({ terrain: "auto", genVer: 2, bbox: BB, worldModel: "sphere", planetRadiusKm: 10000 });

function fnv(h: number, bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function digest(m: Meta): string {
  const g = buildGridCells(m, [], 0), F = gen2Fine(m, g);
  let h = fnv(2166136261, new TextEncoder().encode(g.cells.map(r => r.join("|")).join("\n")));
  h = fnv(h, new Uint8Array(F.base.buffer, F.base.byteOffset, F.base.byteLength));
  return h.toString(16);
}
const riverDigest = (m: Meta): string => fnv(2166136261, new TextEncoder().encode(JSON.stringify(gen2Rivers(m, gridGeom(m))))).toString(16);
const landFrac = (M: Macro): number => { let n = 0; for (const v of M.s) if (v >= 0) n++; return n / M.s.length; };
/** 相邻两档宏观格的海陆翻转，与其中「前一档离岸 ≥6 格的陆地沉进海里」的部分，都占后一档陆地：纯长大时后者为 0，重洗时成片 */
function drift(A: Macro, B: Macro): { flip: number; sunk: number } {
  const { cols, rows } = A, n = cols * rows, d = new Int32Array(n).fill(-1), q = new Int32Array(n);
  let h = 0, t = 0, land = 0, flip = 0, sunk = 0;
  for (let i = 0; i < n; i++) if (A.s[i] < 0) { d[i] = 0; q[t++] = i; }
  while (h < t) {
    const i = q[h++], r = (i / cols) | 0, c = i - r * cols;
    for (const j of [c + 1 < cols ? i + 1 : -1, c > 0 ? i - 1 : -1, r + 1 < rows ? i + cols : -1, r > 0 ? i - cols : -1]) if (j >= 0 && d[j] < 0) { d[j] = d[i] + 1; q[t++] = j; }
  }
  for (let i = 0; i < n; i++) { const a = A.s[i] >= 0, b = B.s[i] >= 0; if (b) land++; if (a !== b) { flip++; if (a && (d[i] < 0 || d[i] >= 6)) sunk++; } }
  return { flip: flip / land, sunk: sunk / land };
}

describe("生成器 v2：确定性", () => {
  it("固定种子的地类与基底哈希冻结（三档风格 + 平面图）", () => {
    assert.deepStrictEqual({
      mono: digest(v2("mono", 7)), multi: digest(v2("multi", 7)), isles: digest(v2("isles", 7)),
      flat: digest(v2("mono", 7, { worldModel: "flat", kmPerDeg: 111.19, bbox: { lonMin: 0, lonMax: 40, latMin: 0, latMax: 30 }, planetRadiusKm: undefined })),
      rivers: riverDigest(v2("multi", 7)),
    }, { mono: "6cce8d3", multi: "dea5adae", isles: "ff91a5a1", flat: "c19475bc", rivers: "e87d9d10" });
  });
  /* 规则宏观格的双线性在每条节点线上折出整列同号的二阶差分（一致度≈1，晕渲成直缝）；节点抖开后折痕随节点弯折。
     一致度＝某列（行）陆格上二阶差分减去 ±3 格两处的均值后 |Σ| ÷ Σ|·|，取全图最大：大片缓坡整体弯曲时处处同号，不减会误报；
     ±3 格落在一个宏观格（缺省分辨率约 7–9 细格）之内，折痕不会被减掉。网格要用缺省分辨率，粗网格量不出格线 */
  it("细格基底没有贴着宏观格线的直折痕：每列、每行去掉缓坡弯曲后的二阶差分同号一致度都低于 0.95", () => {
    const W = 3;
    for (const [st, s] of [["mono", 1], ["multi", 2], ["isles", 1]] as const) {
      const m = v2(st, s, { gridN: undefined }), g = buildGridCells(m, [], 0), E = gen2Fine(m, g).base, { cols, rows } = g;
      const line = (len: number, other: number, at: (k: number, t: number) => number, step: number): number => {
        const d2 = (i: number): number => E[i - step] > 0 && E[i] > 0 && E[i + step] > 0 ? E[i + step] - 2 * E[i] + E[i - step] : NaN;
        let worst = 0;
        for (let k = 1 + W; k < len - 1 - W; k++) {
          let sum = 0, abs = 0, cnt = 0;
          for (let t = 0; t < other; t++) {
            const d = d2(at(k, t)) - (d2(at(k - W, t)) + d2(at(k + W, t))) / 2;
            if (Number.isNaN(d)) continue;
            sum += d; abs += Math.abs(d); cnt++;
          }
          if (cnt > other / 4 && abs > 0) worst = Math.max(worst, Math.abs(sum) / abs);
        }
        return worst;
      };
      const col = line(cols, rows, (k, t) => t * cols + k, 1), row = line(rows, cols, (k, t) => k * cols + t, cols);
      assert.ok(col < 0.95 && row < 0.95, `${st} 种子 ${s}：列 ${col.toFixed(3)}、行 ${row.toFixed(3)}`);
    }
  });
  it("v1 的种子周期在 v2 不存在：s 与 s + GEN_SEED_MAX 生成不同的图", () => {
    const a = buildMacro(gen2Params(v2("mono", 11))), b = buildMacro(gen2Params(v2("mono", 11 + GEN_SEED_MAX)));
    let diff = 0; for (let i = 0; i < a.s.length; i++) if ((a.s[i] >= 0) !== (b.s[i] >= 0)) diff++;
    assert.ok(diff > a.s.length / 10, `海陆只有 ${diff} 格不同`);
    assert.ok(GEN2_SEED_MAX <= 2 ** 31 - 1, "种子经 | 0 取整，超出 int32 会折成另一个种子");
  });
});

describe("生成器 v2：河网不沿格线", () => {
  /* 规则格上的八邻流向树顺行列走成几百公里的直谷（大河节点里约四成进出两边严格共线）；宏观节点不规则以后只剩随机碰上的 */
  it("汇流面积 ≥ 2 万 km² 的河段节点，主来水边与去水边夹角 < 5° 的不到 2 成", () => {
    for (const [st, s] of [["mono", 1], ["multi", 2], ["isles", 1]] as const) {
      const M = buildMacro(gen2Params(v2(st, s))), n = M.cols * M.rows, { X, Y } = M.mesh, land = (i: number) => M.land[i] === 1;
      const donor = new Int32Array(n).fill(-1);
      for (let u = 0; u < n; u++) { const i = M.rcv[u]; if (i !== u && land(u) && (donor[i] < 0 || M.acc[u] > M.acc[donor[i]])) donor[i] = u; }
      let tot = 0, straight = 0;
      for (let i = 0; i < n; i++) {
        const u = donor[i], j = M.rcv[i];
        if (!land(i) || M.acc[i] < 20000 || j === i || u < 0) continue;
        const ax = X[i] - X[u], ay = Y[i] - Y[u], bx = X[j] - X[i], by = Y[j] - Y[i];
        tot++; if ((ax * bx + ay * by) / Math.sqrt((ax * ax + ay * ay) * (bx * bx + by * by)) > 0.9962) straight++;
      }
      assert.ok(tot > 100 && straight < 0.2 * tot, `${st} 种子 ${s}：${straight} / ${tot} 个大河节点进出共线`);
    }
  });
});

describe("生成器 v2：湖与水面", () => {
  const m = v2("mono", 1);
  const g = buildGridCells(m, [], 0), F = gen2Fine(m, g), M = F.macro, ws = waterSurface(m, g), base = baseElev(m, g);
  const unit = 2000, { cols, rows } = g, n = cols * rows;
  const water = (i: number) => terrainProps(g.cells[(i / cols) | 0][i % cols]).lf === "water";

  it("有湖；不碰图边的水体里，含生成器海格的水面为 0（被陆地围住的海盆也是海），其余的水面都是某个湖面（外流湖＝溢出口，内流湖低于它；差 ≤1 m）", () => {
    assert.ok(M.lakeS.length > 0, "这张夹具应当有湖");
    const lab = new Int32Array(n).fill(-1);
    let lakes = 0;
    for (let s0 = 0; s0 < n; s0++) {
      if (!water(s0) || lab[s0] >= 0) continue;
      const st = [s0]; lab[s0] = s0; let edge = false, sea = false;
      while (st.length) {
        const i = st.pop()!, r = (i / cols) | 0, c = i % cols;
        if (!r || !c || r === rows - 1 || c === cols - 1) edge = true;
        if (F.sea[i]) sea = true;
        for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          const nr = r + dr, nc = c + dc; if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const j = nr * cols + nc; if (water(j) && lab[j] < 0) { lab[j] = s0; st.push(j); }
        }
      }
      if (edge) continue;
      const s = ws[s0] * unit;
      if (sea) { assert.strictEqual(s, 0, `含生成器海格的水体水面 ${s.toFixed(1)} m`); continue; }
      lakes++;
      assert.ok(M.lakeS.some(S => Math.abs(S - s) <= 1), `内陆水体水面 ${s.toFixed(1)} m 不是任何湖面（${M.lakeS.map(v => v.toFixed(0)).join(", ")}）——孤立水塘`);
    }
    assert.ok(lakes > 0, "这张夹具应当有不碰图边的湖");
  });
  it("宏观格最终地表（湖格取湖面）沿生成器自己的邻接，除内流盆地外没有残留洼地：自海与内流终点再填一遍逐格不变", () => {
    for (const MM of [M, buildMacro(gen2Params(v2("mono", 6)))]) {
      const { cols: mc, rows: mr } = MM, mn = mc * mr, sf = new Float64Array(mn), land = new Uint8Array(mn), { nbOff, nb } = MM.mesh;
      for (let i = 0; i < mn; i++) { land[i] = MM.land[i]; sf[i] = !land[i] ? 0 : MM.lake[i] >= 0 ? MM.lakeS[MM.lake[i]] : MM.h[i]; }
      /* 独立实现的填洼神谕：自海与内流终点（咸湖、盐滩）出发按地表从低到高扩张（排序数组当队列，O(n²) 但宏观格只有一万多格） */
      const done = new Uint8Array(mn), level = Float64Array.from(sf), open: number[] = [];
      const sink = (i: number) => (MM.lake[i] >= 0 && MM.lakeEnd[MM.lake[i]] === 1) || MM.salt[i] === 1;
      for (let i = 0; i < mn; i++) if (!land[i] || sink(i)) { done[i] = 1; open.push(i); }
      while (open.length) {
        let bi = 0; for (let k = 1; k < open.length; k++) if (level[open[k]] < level[open[bi]]) bi = k;
        const i = open[bi]; open[bi] = open[open.length - 1]; open.pop();
        for (let e = nbOff[i]; e < nbOff[i + 1]; e++) {
          const j = nb[e]; if (done[j]) continue;
          done[j] = 1; if (level[j] < level[i]) level[j] = level[i]; open.push(j);
        }
      }
      let raised = 0; for (let i = 0; i < mn; i++) if (level[i] > sf[i] + 1e-6) raised++;
      assert.strictEqual(raised, 0, `${raised} 个宏观格是没成湖也没填平的洼地`);
    }
  });
  it("「图幅外＝陆地」与整球图：生成器定为海的水格水面恒为 0（碰图幅边判不出海的两种情形）", () => {
    for (const mm of [v2("multi", 2, { outside: "land" }), v2("multi", 2, { bbox: { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 } })]) {
      const gg = buildGridCells(mm, [], 0), FF = gen2Fine(mm, gg), w2 = waterSurface(mm, gg);
      let sea = 0, raised = 0;
      for (let i = 0; i < w2.length; i++) if (FF.sea[i]) { sea++; if (w2[i] !== 0) raised++; }
      assert.ok(sea > 0); assert.strictEqual(raised, 0, `${raised} / ${sea} 个生成器海格的水面不是 0`);
    }
  });
  it("渲染端约束：水格基底不高于水面 + SHORE_E、陆格基底不低于 0（过 baseFields 前后都成立）", () => {
    let badW = 0, badL = 0;
    for (let i = 0; i < n; i++) {
      for (const b of [F.base[i], base[i]]) {
        if (water(i)) { if (b > ws[i] + SHORE_E + 1e-6) badW++; } else if (b < 0) badL++;
      }
    }
    assert.strictEqual(badW, 0, "有水格会被画成陆地"); assert.strictEqual(badL, 0, "有陆格低于海平面");
  });
});

/* 中尺度稳态：网格分辨率上再解一层河流功率律（山里出主脊与支谷），平原照宏观面，湖面＝溢出口不受影响 */
describe("生成器 v2：中尺度稳态（gen2Meso）", () => {
  const withMeso = (m: Meta) => {
    const g = buildGridCells(m, [], 0), R = gen2Meso(m, g);
    return { g, R, F: gen2Fine(m, g), gm: buildGridCells(m, [], 0, R) };
  };
  const mesoDigest = (m: Meta): string => {
    const { R } = withMeso(m);
    return fnv(fnv(2166136261, new Uint8Array(R.base.buffer)), new Uint8Array(R.env.buffer)).toString(16);
  };
  it("两次逐位同；给缓存的稳态解（高程与流向）派生出的基底与包络与现算逐位同；三档风格都停在流向树不变上", () => {
    for (const st of ["mono", "multi", "isles"] as const) {
      const m = v2(st, 7), g = buildGridCells(m, [], 0), A = gen2Meso(m, g), B = gen2Meso(m, g);
      assert.ok(A.converged, `${st} 中尺度 ${A.iters} 轮没停在流向树不变上`);
      assert.deepStrictEqual(B.sg.h, A.sg.h); assert.deepStrictEqual(B.sg.rcv, A.sg.rcv); assert.deepStrictEqual(B.base, A.base);
      const C = gen2Meso(m, g, { h: A.sg.h.slice(), rcv: A.sg.rcv.slice() });
      assert.deepStrictEqual(C.base, A.base, "缓存命中与现算的基底不同——开图走哪条路，地形就是哪张"); assert.deepStrictEqual(C.env, A.env);
    }
  });
  it("基底与包络哈希冻结（三档风格）", () => {
    assert.deepStrictEqual({ mono: mesoDigest(v2("mono", 7)), multi: mesoDigest(v2("multi", 7)), isles: mesoDigest(v2("isles", 7)) },
      { mono: "5cfe708d", multi: "2181f95e", isles: "80e0bbfc" });
    const clsDigest = (m: Meta): string => fnv(2166136261, withMeso(m).R.cls).toString(16);
    /* 480 列那枚：起伏窗按公里取一个宏观格（这里半宽 3 格；240 列恰 1 格，窗口按格算也看不出来） */
    assert.deepStrictEqual({ mono: clsDigest(v2("mono", 7)), multi: clsDigest(v2("multi", 7)), isles: clsDigest(v2("isles", 7)), multi480: clsDigest(v2("multi", 7, { gridN: 480 })) },
      { mono: "5aebd670", multi: "e48cab47", isles: "2d74ccc9", multi480: "1a8c6970" }, "中尺度重判的地类");
  });
  it("岩性带：规格只随宏观（240 与 480 列同一份）；造山带里 K 对去抖动基底之比只落五档、带渐入以下恒 1", () => {
    const m = v2("multi", 7), sp = bandSpecOf(gen2Macro(m), gen2Params(m)), sp2 = bandSpecOf(gen2Macro(v2("multi", 7, { gridN: 480 })), gen2Params(m));
    assert.ok(sp.umax > 0 && sp.bandN > 10 && sp.bandN < 1000, `带规格 ${JSON.stringify(sp)}`);
    assert.deepStrictEqual(sp2, sp, "带数随网格变了——规格该从宏观取");
    const { pr } = withMeso(m).R.st, { fU, fG, fK, inp: { K, out }, g: { bb, step, cols } } = pr, P = gen2Params(m), sd = P.seed * 31, c = BAND_CONTRAST;
    const tab = [1 / c, 1 / Math.sqrt(c), 1, Math.sqrt(c), c], hit = [0, 0, 0, 0, 0];
    let flat = 0, oro = 0, on = 0, full = 0;
    for (let i = 0; i < K.length; i++) {
      if (out[i]) continue;
      const ratio = K[i] / (fK[i] * (0.8 + 0.4 * cellRand(i, sd + 913))), u = fU[i] / sp.umax, r = (i / cols) | 0, cc = i - r * cols;
      const want = bandMultAt(sp, u, fG[i], pointOf(P, bb.lonMin + (cc + 0.5) * step, bb.latMin + (r + 0.5) * step), sd);
      assert.ok(Math.abs(ratio - want) < 1e-9 * want, `格 ${i}：K 对基底之比 ${ratio}，带函数在格心给 ${want}`);
      if (u <= BAND_U0) { assert.strictEqual(want, 1, `低地格 ${i} 倍率 ${want}`); flat++; continue; }
      oro++;
      if (want !== 1) on++;
      const k = tab.findIndex(t => Math.abs(want - t) < 1e-9 * t);
      if (k >= 0 && k !== 2 && u >= BAND_U1) { full++; hit[k]++; }
    }
    assert.ok(flat > 1000 && oro > 1000, `低地 ${flat}、造山带 ${oro}`);
    assert.ok(on / oro > 0.1 && on / oro < 0.7, `造山带里显带的占 ${(100 * on / oro).toFixed(0)}%——带该是少数造山带的事，不是全部`);
    assert.ok(full > 200 && hit.every((v, k) => k === 2 || v > 0), `满幅四档各有：${hit}`);
  });
  /* 缓存（mesocache）存的就是这份解：它变了而 MESO_VER 没加，旧图开图读到的旧解与现算对不上 */
  it("稳态解（Float64 高程与流向）哈希冻结（三档风格）：变了就要 MESO_VER + 1", () => {
    const sgDigest = (m: Meta): string => {
      const { R: { sg } } = withMeso(m);
      return fnv(fnv(2166136261, new Uint8Array(sg.h.buffer, sg.h.byteOffset, sg.h.byteLength)), new Uint8Array(sg.rcv.buffer, sg.rcv.byteOffset, sg.rcv.byteLength)).toString(16);
    };
    assert.deepStrictEqual({ mono: sgDigest(v2("mono", 7)), multi: sgDigest(v2("multi", 7)), isles: sgDigest(v2("isles", 7)) },
      { mono: "1ef0ed7e", multi: "667b55f0", isles: "97afe965" });
  });
  it("湖面＝溢出口不受影响：挂上中尺度后水面逐格不变；水格基底 ≤ 水面 + SHORE_E、陆格 ≥ 0", () => {
    /* 多块种子 5：有湖面高过旁边河道的湖，四邻排水的阶梯在那里压不过湖岸 */
    for (const m of [v2("mono", 1), v2("multi", 7), v2("multi", 5)]) {
      const { g, gm, F } = withMeso(m), w0 = waterSurface(m, g), w1 = waterSurface(m, gm), b1 = baseElev(m, gm);
      assert.ok(F.macro.lakeS.length > 0, "这张夹具应当有湖");
      assert.deepStrictEqual(w1, w0, "挂上中尺度后水面变了——湖岸被稳态解压到了湖面以下");
      let badW = 0, badL = 0;
      for (let i = 0; i < b1.length; i++) {
        if (terrainProps(gm.cells[(i / gm.cols) | 0][i % gm.cols]).lf === "water") { if (b1[i] > w1[i] + SHORE_E + 1e-6) badW++; } else if (b1[i] < 0) badL++;
      }
      assert.strictEqual(badW, 0, "有水格会被画成陆地"); assert.strictEqual(badL, 0, "有陆格低于海平面");
    }
  });
  it("抬升低处照宏观面：陆格里与宏观底逐位相同的占三成以上（河道与填平的洼地不算在内，35 km 一格的夹具上约占一成）；包络在 0..1、水格为 0", () => {
    for (const st of ["mono", "multi", "isles"] as const) {
      const { R, F } = withMeso(v2(st, 7));
      let land = 0, same = 0, bad = 0;
      for (let i = 0; i < R.base.length; i++) {
        const wet = R.sea[i] || F.lakeOf[i] >= 0;
        if (!(R.env[i] >= 0 && R.env[i] <= 1) || (wet && R.env[i] !== 0)) bad++;
        if (wet) continue;
        land++; if (R.base[i] === F.base[i]) same++;
      }
      assert.strictEqual(bad, 0);
      assert.ok(same > 0.3 * land, `${st}：只有 ${(same / land * 100).toFixed(0)}% 的陆格照宏观面`);
    }
  });
  it("格边不同的同一张图高度相当：网格 240 与 480 列，收尾后陆地均值差 ≤ 7%；源头修正量平滑之前的稳态解，陆地 99 分位差 ≤ 8%", () => {
    for (const m of [v2("mono", 2), v2("multi", 7)]) {
      const stat = (gn: number): [number, number] => {
        const mm = { ...m, gridN: gn }, { R, F } = withMeso(mm), v: number[] = [], h: number[] = [];
        for (let i = 0; i < R.base.length; i++) if (!(R.sea[i] || F.lakeOf[i] >= 0)) { v.push(R.base[i] * 2000); h.push(R.sg.h[i]); }
        h.sort((a, b) => a - b);
        return [v.reduce((a, b) => a + b, 0) / v.length, h[Math.floor(0.99 * h.length)]];
      };
      const [m1, p1] = stat(240), [m2, p2] = stat(480);
      assert.ok(Math.abs(m1 / m2 - 1) <= 0.07, `均值 ${m1.toFixed(0)} / ${m2.toFixed(0)} m`);
      assert.ok(Math.abs(p1 / p2 - 1) <= 0.08, `稳态解 99 分位 ${p1.toFixed(0)} / ${p2.toFixed(0)} m`);
    }
  });
  /* 地类按中尺度基底重判：宏观插值的高程在山里与中尺度差几百米，照宏观判会把中尺度的谷底标成山地 */
  it("地类按中尺度基底重判：陆格地貌与它自己的高程带一致（宏观派生的地类在中尺度谷底上有违例），水格与盐滩不变", () => {
    const ne = ECO_ORDER.length;
    for (const [st, seed] of [["mono", 7], ["multi", 7], ["isles", 7], ["mono", 5]] as const) {   // 单块种子 5 有盐滩
      const m = v2(st, seed), { R, F } = withMeso(m), um = gen2Params(m).unitM, cols = F.cells[0].length;
      /* 判法的高程门槛：3000 m 以上恒高山、1500 m 以上至少山地、900 m 以下不是山地（起伏大时 900–1500 m 才算山地） */
      const off = (lf: Landform, e: number): boolean => lf === "alpine" ? e < 3000 : lf === "mountain" ? e < 900 || e >= 3000 : e >= 1500;
      let bad = 0, badMacro = 0, land = 0, salts = 0;
      for (let i = 0; i < R.cls.length; i++) {
        const lf = LANDFORM_ORDER[(R.cls[i] / ne) | 0], eco = ECO_ORDER[R.cls[i] % ne], wet = R.sea[i] || F.lakeOf[i] >= 0;
        assert.strictEqual(lf === "water", !!wet, "水格只有长成三角洲的海格转陆");
        if (wet) continue;
        const salt = terrainProps(F.cells[(i / cols) | 0][i % cols]).eco === "salt";
        assert.strictEqual(eco === "salt", salt, "盐滩不随中尺度变");
        if (salt) { salts++; continue; }
        const e = R.base[i] * um;
        land++;
        if (off(lf, e)) bad++;
        if (off(LANDFORM_ORDER[F.lf[i]], e)) badMacro++;
      }
      assert.strictEqual(bad, 0, `${st}：${bad} 个陆格的地貌与中尺度高程不符`);
      if (seed === 5) assert.ok(salts > 0, "单块种子 5 应当有盐滩");
      assert.ok(badMacro > 0.005 * land, `${st}：宏观派生的地类只有 ${badMacro} 格不符——夹具应当能看出重判的必要`);
    }
  });
  it("挂上中尺度的网格：底稿取重判的地类、涂改照叠；改了类的格照样取中尺度基底（判「涂没涂过」认中尺度的地类）", () => {
    const m = v2("multi", 7), { R, F } = withMeso(m), ne = ECO_ORDER.length;
    const changed: number[] = [];
    for (let i = 0; i < R.cls.length; i++) if (LANDFORM_ORDER[(R.cls[i] / ne) | 0] !== LANDFORM_ORDER[F.lf[i]]) changed.push(i);
    assert.ok(changed.length > 50, `夹具里改了类的格只有 ${changed.length} 个`);
    const g0 = buildGridCells(m, [], 0), i0 = changed[changed.length >> 1], r0 = (i0 / g0.cols) | 0, c0 = i0 % g0.cols;
    const ov = [{ lon: g0.bb.lonMin + (c0 + 0.5) * g0.step, lat: g0.bb.latMin + (r0 + 0.5) * g0.step, t: "plain/desert" }];
    const gm = buildGridCells(m, ov, 0, R), b = baseElev(m, gm), names = allComposites();
    assert.strictEqual(gm.meso, R);
    assert.strictEqual(gm.cells[r0][c0], "plain/desert", "涂改叠在中尺度底稿之上");
    assert.strictEqual(gm.cells[r0][c0 + 1 < gm.cols ? c0 + 1 : c0 - 1], names[R.cls[r0 * gm.cols + (c0 + 1 < gm.cols ? c0 + 1 : c0 - 1)]]);
    let same = 0;
    for (const i of changed) if (i !== i0 && b[i] === R.base[i]) same++;
    assert.ok(same >= 0.9 * (changed.length - 1), `改了类的格只有 ${same}/${changed.length - 1} 取中尺度基底——判「涂没涂过」还在认宏观地类`);
  });
  it("收尾平滑按图幅渐入：小图幅取三成地板、缺省图幅与整球满档；平滑按格，粗格上的峰概括得更多", () => {
    const at = (bbox: object, R: number) => mesoSmoothOf({ terrain: "auto", genVer: 2, genSeed: 7, genStyle: "multi", worldModel: "sphere", planetRadiusKm: R, bbox } as Meta);
    assert.strictEqual(at({ lonMin: 100, lonMax: 108, latMin: 30, latMax: 36 }, 6371), 0.3);
    assert.strictEqual(at(BB, 10000), 1);
    assert.strictEqual(at({ lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 }, 6371), 1);
    const mid = at({ lonMin: 95, lonMax: 115, latMin: 28, latMax: 43 }, 6371);
    assert.ok(mid > 0.35 && mid < 0.9, `中图幅 ${mid}`);
    const p99 = (gn: number): number => { const { R, F } = withMeso(v2("mono", 2, { gridN: gn })), v: number[] = []; for (let i = 0; i < R.base.length; i++) if (!(R.sea[i] || F.lakeOf[i] >= 0)) v.push(R.base[i]); v.sort((a, b) => a - b); return v[Math.floor(0.99 * v.length)]; };
    assert.ok(p99(240) < p99(480), "满档平滑下 35 km 格的峰比 17 km 格的低（同真实地形降分辨率）");
  });
});

/* 画抬升：在中尺度 Sg 上按涂抹区标定，区内最高点（收尾之后的基底）到目标峰高 */
describe("生成器 v2：画抬升（gen2Uplift）", () => {
  const setup = (extra: Partial<Meta> = {}, M = 12) => {
    const m = v2("multi", 7, extra), g = buildGridCells(m, [], 0), R = gen2Meso(m, g), st = mesoState(m, g, R.sg);
    const { cols, rows } = g, out = st.pr.inp.out, um = gen2Params(m).unitM;
    /* 低平陆地：周围 M 格全陆、基底 < 600 m；两处相隔 ≥ 30 格 */
    const ok = (r: number, c: number): boolean => {
      if (R.base[r * cols + c] * um >= 600) return false;
      for (let dr = -M; dr <= M; dr += 2) for (let dc = -M; dc <= M; dc += 2) { const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= rows || cc >= cols || out[rr * cols + cc]) return false; }
      return true;
    };
    const spots: [number, number][] = [];
    for (let r = M; r < rows - M && spots.length < 2; r++) for (let c = M; c < cols - M && spots.length < 2; c++)
      if (ok(r, c) && spots.every(([r0, c0]) => (r - r0) ** 2 + (c - c0) ** 2 >= 900)) spots.push([r, c]);
    assert.strictEqual(spots.length, 2, "夹具应有两处低平陆地");
    return { m, g, R, st, um, spots };
  };
  const disc = (map: Map<number, number>, cols: number, [r0, c0]: [number, number], R0: number, T: number): void => {
    for (let dr = -R0; dr <= R0; dr++) for (let dc = -R0; dc <= R0; dc++) if (dr * dr + dc * dc <= R0 * R0 + 0.5) map.set((r0 + dr) * cols + c0 + dc, T);
  };
  const cellsOf = (map: Map<number, number>): UpliftCells => {
    const idx = Int32Array.from(map.keys()).sort();
    return { idx, peakM: Float64Array.from(idx, i => map.get(i)!) };
  };
  it("零个区（含只涂在水上）与 gen2Meso 逐位同；从缓存拷贝的 Sg 起解与现算 Sg 起解逐位同，两次逐位同", () => {
    const { m, g, R, st, spots } = setup();
    const out = st.pr.inp.out, wet = out.findIndex(v => v === 1);
    for (const c of [cellsOf(new Map()), { idx: Int32Array.of(wet), peakM: Float64Array.of(3000) }]) {
      const Z = gen2Uplift(st, c, RP0);
      assert.deepStrictEqual(Z.base, R.base); assert.deepStrictEqual(Z.env, R.env); assert.deepStrictEqual(Z.cls, R.cls); assert.deepStrictEqual(Z.rivers, R.rivers);
    }
    const map = new Map<number, number>(); disc(map, g.cols, spots[0], 3, 4000);
    const A = gen2Uplift(st, cellsOf(map), RP0), B = gen2Uplift(mesoState(m, g, { h: R.sg.h.slice(), rcv: R.sg.rcv.slice() }), cellsOf(map), RP0), C = gen2Uplift(st, cellsOf(map), RP0);
    assert.deepStrictEqual(B.base, A.base, "缓存命中与现算的起点解出两座山"); assert.deepStrictEqual(B.env, A.env);
    assert.deepStrictEqual(C.base, A.base);
    /* 量峰模板差一项，峰高只偏零点几米、到目标的 2% 判据看不出来：钉住整份输出 */
    assert.strictEqual(fnv(fnv(2166136261, new Uint8Array(A.base.buffer)), new Uint8Array(A.env.buffer)).toString(16), "c82dd10e", "画抬升的基底与包络");
  });
  it("各区最高点（收尾之后的基底）到目标：平原两区、高过峰顶软上限的目标也到；已高过目标的区系数为 0", () => {
    const { g, st, um, spots } = setup(), { cols } = g;
    for (const T of [3000, 7000]) {
      const map = new Map<number, number>();
      disc(map, cols, spots[0], 3, T * 0.6); disc(map, cols, spots[0], 1, T); disc(map, cols, spots[1], 2, 2500);
      const U = gen2Uplift(st, cellsOf(map), RP0);
      for (const [sp, want] of [[spots[0], T], [spots[1], 2500]] as const) {
        let top = 0;
        for (const [i] of map) { const r = (i / cols) | 0, c = i % cols; if ((r - sp[0]) ** 2 + (c - sp[1]) ** 2 <= 9.5) top = Math.max(top, U.base[i] * um); }
        assert.ok(Math.abs(top - want) <= 0.02 * want, `目标 ${want} m，区内最高 ${top.toFixed(1)} m`);
        const pk = sp[0] * cols + sp[1], lf = LANDFORM_ORDER[(U.cls[pk] / ECO_ORDER.length) | 0];
        assert.ok(lf === "mountain" || lf === "alpine", `画到 ${want} m 的区心地类是 ${lf}`);
      }
      assert.ok(U.s.every(v => v > 0));
    }
    const low = new Map<number, number>(); disc(low, cols, spots[0], 2, 100);
    assert.strictEqual(gen2Uplift(st, cellsOf(low), RP0).s[0], 0, "目标低过现有地形：不抬");
  });
  it("盆地与低抬升处：盆底最深的一格、低抬升高原上只高 100 m 的目标都到（扣盆地按格反解、平原渐变取满），起伏包络随抬升长出来", () => {
    const m = v2("mono", 7), g = buildGridCells(m, [], 0), R = gen2Meso(m, g), st = mesoState(m, g, R.sg), { fB, inp: { out } } = st.pr, um = gen2Params(m).unitM;
    let bi = -1; for (let i = 0; i < fB.length; i++) if (!out[i] && (bi < 0 || fB[i] > fB[bi])) bi = i;
    assert.ok(fB[bi] > 300 && R.env[bi] === 0, `夹具应有深盆（${fB[bi].toFixed(0)} m）且原本无起伏`);
    const U = gen2Uplift(st, { idx: Int32Array.of(bi), peakM: Float64Array.of(600) }, RP0);
    assert.ok(Math.abs(U.base[bi] * um - 600) <= 12, `盆底画 600 m 读出 ${(U.base[bi] * um).toFixed(1)} m`);
    assert.ok(U.env[bi] > 0.3, "画出的山要有起伏纹理（包络按抬升后的 U）");
    /* 低抬升的高原上只比现状高 100 m：系数小、抬升后的 U 仍在平原渐变区，涂抹格要靠 kw 取满 */
    const { fU } = st.pr;
    let pi = -1; for (let i = 0; i < fU.length; i++) if (!out[i] && fU[i] < 0.12 && (pi < 0 || R.base[i] > R.base[pi])) pi = i;
    const T = Math.round(R.base[pi] * um) + 100, P = gen2Uplift(st, { idx: Int32Array.of(pi), peakM: Float64Array.of(T) }, RP0);
    assert.ok(Math.abs(P.base[pi] * um - T) <= 2, `低抬升处画 ${T} m 读出 ${(P.base[pi] * um).toFixed(1)} m`);
  });
  const basinsOf = (map: Map<number, number>): UpliftCells => {
    const fidx = Int32Array.from(map.keys()).sort();
    return { idx: new Int32Array(0), peakM: new Float64Array(0), fidx, floorM: Float64Array.from(fidx, i => map.get(i)!) };
  };
  /* 画盆地的夹具：同一张图只建一次 */
  const worlds = new Map<string, { m: Meta; g: ReturnType<typeof buildGridCells>; R: ReturnType<typeof gen2Meso>; st: MesoState; um: number }>();
  const worldOf = (style: "mono" | "multi", seed: number) => {
    const k = style + seed; let w = worlds.get(k);
    if (!w) { const m = v2(style, seed), g = buildGridCells(m, [], 0), R = gen2Meso(m, g); w = { m, g, R, st: mesoState(m, g, R.sg), um: gen2Params(m).unitM }; worlds.set(k, w); }
    return w;
  };
  /** 画盆地的地方：低地（< 700 m）且周围 5 格全陆；wet / dry 取细格水汽最大 / 最小，coast 取离海不到 3 格 */
  const siteOf = (w: ReturnType<typeof worldOf>, kind: "wet" | "dry" | "coast"): number => {
    const { g: { cols, rows }, R, st, um } = w, out = st.pr.inp.out, fM = st.pr.fM;
    const land = (r: number, c: number, M: number): boolean => {
      for (let dr = -M; dr <= M; dr++) for (let dc = -M; dc <= M; dc++) { const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= rows || cc >= cols || out[rr * cols + cc]) return false; }
      return true;
    };
    let best = -1;
    for (let r = 6; r < rows - 6; r++) for (let c = 6; c < cols - 6; c++) {
      const i = r * cols + c; if (R.base[i] * um > 700) continue;
      if (kind === "coast") { if (land(r, c, 1) && !land(r, c, 3)) return i; continue; }
      if (!land(r, c, 5)) continue;
      if (best < 0 || (kind === "wet" ? fM[i] > fM[best] : fM[i] < fM[best])) best = i;
    }
    assert.ok(best >= 0, `夹具里找不到 ${kind} 处`);
    return best;
  };
  const discAt = (w: ReturnType<typeof worldOf>, i0: number, R0: number, T: number): Map<number, number> => {
    const { g: { cols, rows }, st } = w, out = st.pr.inp.out, map = new Map<number, number>(), r0 = (i0 / cols) | 0, c0 = i0 % cols;
    for (let dr = -R0; dr <= R0; dr++) for (let dc = -R0; dc <= R0; dc++) {
      const r = r0 + dr, c = c0 + dc; if (r < 0 || c < 0 || r >= rows || c >= cols || dr * dr + dc * dc > R0 * R0 + 0.5) continue;
      if (!out[r * cols + c]) map.set(r * cols + c, T);
    }
    return map;
  };
  /** 新水域的渲染约束（同 buildFine）：渲染端被动算出的水面＝读数表的水面（岸格最低处恰为湖面、其余不低于它都靠这条）、湖床不高于水面 + SHORE_E、
      不碰图幅边、不挨着生成器的水（被海灌进的可以挨着海）、不同水面的两湖不相挨；位 2 恰是新盐滩 */
  const waterBad = (w: ReturnType<typeof worldOf>, U: ReturnType<typeof gen2Uplift>): string[] => {
    const { m, g, st, um } = w, out = st.pr.inp.out, sea = gen2Fine(m, g).sea, gm = buildGridCells(m, [], 0, U), ws = waterSurface(m, gm), b = baseElev(m, gm);
    const { cols, rows } = gm, bad: string[] = [], props = (i: number) => terrainProps(gm.cells[(i / cols) | 0][i % cols]);
    const surf = (i: number): number => { const e = U.water!.list[U.water!.at[i]]; return e.kind === 3 ? 0 : e.surfM; };
    const isNew = (i: number): boolean => !out[i] && props(i).lf === "water";
    for (let i = 0; i < cols * rows; i++) {
      const salt = !out[i] && props(i).eco === "salt" && !gen2Fine(m, g).cells[(i / cols) | 0][i % cols].endsWith("salt");
      if (!!(U.basin && U.basin[i] & 2) !== salt) bad.push(`位 2 与盐滩不符 @${i}`);
      if (!isNew(i)) continue;
      const r = (i / cols) | 0, c = i % cols, L = surf(i), kind = U.water!.list[U.water!.at[i]].kind;
      if (Math.abs(ws[i] * um - L) > 0.5) bad.push(`水面 ${(ws[i] * um).toFixed(1)} ≠ ${L.toFixed(1)} @${i}`);
      if (b[i] > ws[i] + SHORE_E + 1e-6) bad.push(`湖床高过水面 @${i}`);
      if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) { bad.push(`碰图幅边 @${i}`); continue; }
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const j = (r + dr) * cols + c + dc;
        if (out[j] && !(kind === 3 && sea[j])) bad.push(`挨着生成器的水 @${i}`);
        else if (isNew(j) && surf(j) !== L) bad.push(`两湖相挨 @${i}`);
      }
    }
    return bad;
  };
  it("画盆地（干处）：盆底恰到目标（一区取最低目标）、成盐滩且盐滩是侵蚀基准面（位 2）、盆心起伏收平、碗形、支撑外只有刻河在动、河不从盐滩流出；不该沉的逐位同", () => {
    const w = worldOf("mono", 5), { g: { cols }, R, st, um } = w, i0 = siteOf(w, "dry");
    const fl = discAt(w, i0, 3, 300); fl.set(i0 + cols, 150);
    const U = gen2Uplift(st, basinsOf(fl), RP0), B = U.basin!;
    let mn = Infinity, env0 = 0, env1 = 0, edge = 0, ne = 0;
    const r0 = (i0 / cols) | 0, c0 = i0 % cols;
    for (const [i] of fl) {
      mn = Math.min(mn, U.base[i] * um); env0 += R.env[i]; env1 += U.env[i];
      const d2 = (((i / cols) | 0) - r0) ** 2 + (i % cols - c0) ** 2; if (d2 > 4.5) { edge += R.base[i] - U.base[i]; ne++; }
    }
    assert.ok(Math.abs(mn - 150) <= 1, `一区取最低目标 150 m，区内最低 ${mn.toFixed(2)} m`);
    assert.ok(env1 <= 0.6 * env0 + 1e-9, `盆心起伏收平：包络和 ${env0.toFixed(2)} → ${env1.toFixed(2)}`);
    assert.ok(edge / ne < 0.8 * (R.base[i0] - U.base[i0]), "碗形：区界一圈沉得比区心少");
    assert.ok(U.water && U.water.list.some(x => x.kind === 2), "极干处成盐滩");
    assert.ok(B.some(v => (v & 2) !== 0), "盐滩是侵蚀基准面");
    assert.deepStrictEqual(waterBad(w, U), []);
    /* 支撑外只有刻河在动：盆截走了水，流进盆的支流新刻出河槽、下游的河水量变了下切跟着变 */
    const out = st.pr.inp.out;
    let moved = 0, dmax = 0, land = 0;
    for (let i = 0; i < B.length; i++) { if (!out[i]) land++; if (!B[i] && U.base[i] !== R.base[i]) { moved++; dmax = Math.max(dmax, Math.abs(U.base[i] - R.base[i]) * um); } }
    assert.ok(moved < 0.01 * land && dmax < 60, `支撑外动了 ${moved} 格、最多 ${dmax.toFixed(1)} m`);
    const cellOf = ([x, y]: [number, number]): number => Math.floor((y - w.g.bb.latMin) / w.g.step) * cols + Math.floor((x - w.g.bb.lonMin) / w.g.step);
    for (const rv of U.rivers) assert.ok(rv.pts.slice(0, -1).every(p => !(B[cellOf(p)] & 2)), "内流盆的终点是盐滩：河不从盐滩流出");
    const wet = st.pr.inp.out.findIndex(v => v === 1);
    for (const c of [basinsOf(discAt(w, i0, 2, 5000)), basinsOf(new Map([[wet, -100]]))]) {
      const Z = gen2Uplift(st, c, RP0);
      assert.strictEqual(Z.basin, null, "目标高过地面、或只涂在水上：不沉");
      assert.deepStrictEqual(Z.base, R.base); assert.deepStrictEqual(Z.env, R.env);
    }
  });
  /** 最终地面上的填洼水位（自生成器的水，沿求解图；新湖格取湖床）：外流湖的湖面恰是它，咸湖低于它 */
  const fillOf = (w: ReturnType<typeof worldOf>, U: ReturnType<typeof gen2Uplift>): Float64Array => {
    const { st, um } = w, { nbOff, nb } = st.G, { out, hOut } = st.pr.inp, n = out.length, f = new Float64Array(n), seen = new Uint8Array(n), hp = new Heap(64);
    for (let i = 0; i < n; i++) { f[i] = out[i] ? hOut[i] : U.base[i] * um; if (out[i]) { seen[i] = 1; hp.push(f[i], i); } }
    while (hp.n) { const i = hp.pop(); for (let e = nbOff[i]; e < nbOff[i + 1]; e++) { const j = nb[e]; if (seen[j]) continue; seen[j] = 1; if (f[j] < f[i]) f[j] = f[i]; hp.push(f[j], j); } }
    return f;
  };
  it("画盆地（湿处）成外流湖、湖面恰是溢出口；半干处成咸湖、湖面低于溢出口；新水域只经 cells 生效，渲染端算出的水面＝读数表、湖床、岸格、隔一格都守住", () => {
    /* 咸湖那处是多块种子 7 第 70 行第 40 列的半干低地（水汽 0.30；探针扫出来的，生成器冻结则恒成立）；多块种子 7 最干处画 200 m 的盆落在坡上、
       区内最低那格成一格大的洼地，平衡面积不到一格却一淹就满——湖面到了溢出口，算外流湖 */
    for (const [st, seed, pick, R0, T, want] of [["mono", 5, "wet", 3, 200, 0], ["multi", 7, "semi", 4, 0, 1], ["multi", 7, "dry", 3, 200, 0]] as const) {
      const w = worldOf(st, seed), site = pick === "semi" ? 70 * w.g.cols + 40 : siteOf(w, pick);
      const U = gen2Uplift(w.st, basinsOf(discAt(w, site, R0, T)), RP0), out = w.st.pr.inp.out;
      assert.ok(U.water && U.water.list.some(x => x.kind === want), `${st}${seed}：${JSON.stringify(U.water && U.water.list)}`);
      const f = fillOf(w, U);
      let lakes = 0;
      for (let i = 0; i < out.length; i++) {
        if (out[i] || U.cls[i] !== U.cls[out.indexOf(1)]) continue;
        lakes++;
        const e: BasinWaters["list"][number] = U.water!.list[U.water!.at[i]];
        if (e.kind === 0) assert.ok(Math.abs(f[i] - e.surfM) <= 0.5, `外流湖湖面 ${e.surfM.toFixed(1)} m，溢出口 ${f[i].toFixed(1)} m`);
        if (e.kind === 1) assert.ok(e.surfM < f[i] - 1, `咸湖湖面 ${e.surfM.toFixed(1)} m 应低于溢出口 ${f[i].toFixed(1)} m`);
      }
      assert.ok(lakes > 0, "有新水格");
      assert.deepStrictEqual(waterBad(w, U), []);
    }
  });
  it("画的咸湖没有盐滩外圈也是汇流终点：有河流进湖、没有出湖的河（多块种子 7 第 70 行第 40 列、两个河流滑杆拉满；外圈有盐滩时盐滩本身就是终点，测不出来）", () => {
    const w = worldOf("multi", 7), { g: { cols, bb, step }, st } = w, out = st.pr.inp.out;
    const U = gen2Uplift(st, basinsOf(discAt(w, 70 * cols + 40, 4, 0)), riverParams({ ...w.m, genRiv: 1, genWater: 1 })), B = U.basin!;
    assert.ok(U.water && U.water.list.length === 1 && U.water.list[0].kind === 1 && !B.some(v => (v & 2) !== 0), `前提：成没有盐滩外圈的咸湖 ${JSON.stringify(U.water && U.water.list)}`);
    const water = LANDFORM_ORDER.indexOf("water");
    const byLake = (p: [number, number]): boolean => {
      const c = Math.round((p[0] - bb.lonMin) / step - 0.5), r = Math.round((p[1] - bb.latMin) / step - 0.5);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const j = (r + dr) * cols + c + dc; if (!out[j] && (U.cls[j] / ECO_ORDER.length | 0) === water) return true; }
      return false;
    };
    const inLake = (p: [number, number]): boolean => { const j = Math.floor((p[1] - bb.latMin) / step) * cols + Math.floor((p[0] - bb.lonMin) / step); return !out[j] && (U.cls[j] / ECO_ORDER.length | 0) === water; };
    assert.ok(U.rivers.some(r => byLake(r.pts[r.pts.length - 1])), "该有河流进咸湖");
    assert.strictEqual(U.rivers.filter(r => inLake(r.pts[0])).length, 0, "咸湖流出了河");
  });
  it("画盆地挨着生成器的湖：溢进那个湖成外流湖、湖面同它，挨着它的格退成陆并钳到湖面以上；另一处成海面下的咸湖", () => {
    /* 单块种子 5 的 1 号湖（湖面 123 m）东北边、第 55 行第 125 列；第 51 行第 129 列是一片会成海面下咸湖的洼地（探针扫出来的） */
    const w = worldOf("mono", 5), { g: { cols }, st } = w, out = st.pr.inp.out, sq = (r0: number, c0: number, T: number): Map<number, number> => {
      const map = new Map<number, number>();
      for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) { const j = (r0 + a) * cols + c0 + b; if (!out[j]) map.set(j, T); }
      return map;
    };
    const U = gen2Uplift(st, basinsOf(sq(55, 125, -100)), RP0), F = gen2Fine(w.m, w.g);
    assert.ok(U.water && U.water.list.some(x => x.kind === 0 && Math.round(x.surfM) === Math.round(F.macro.lakeS[1])), JSON.stringify(U.water && U.water.list));
    let demoted = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i] || U.water!.at[i] < 0 || U.cls[i] === U.cls[out.indexOf(1)]) continue;
      const r = (i / cols) | 0, c = i % cols;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (F.lakeOf[(r + a) * cols + c + b] >= 0) demoted++;
    }
    assert.ok(demoted > 0, "前提：有盆里的格挨着生成器的湖、被退成陆");
    assert.deepStrictEqual(waterBad(w, U), []);
    const S = gen2Uplift(st, basinsOf(sq(51, 129, -100)), RP0);
    assert.ok(S.water && S.water.list.some(x => x.kind === 1 && x.surfM < 0), JSON.stringify(S.water && S.water.list));
    assert.deepStrictEqual(waterBad(w, S), []);
  });
  /* 湖的 8 邻岸格钳在湖面以上：河贴着湖岸流过时，上游河槽要是刻到湖面以下，钳回去的那格就把上游围成坑 */
  it("画盆地紧贴大河成外流湖：河道不刻到下游湖岸下界以下，最终地表两种判据都没有封闭洼地（多块种子 7 第 63 行第 62 列、盆底 3 m）", () => {
    const w = worldOf("multi", 7), U = gen2Uplift(w.st, basinsOf(discAt(w, 63 * w.g.cols + 62, 2, 3)), RP0);
    assert.ok(U.water && U.water.list.length === 1 && U.water.list[0].kind === 0, `前提：成外流湖 ${JSON.stringify(U.water && U.water.list)}`);
    for (const G of [w.st.G, null]) {
      const p = closedPits(w.m, U, G);
      assert.strictEqual(p.n, 0, `${G ? "求解图" : "格心四邻"}：${p.n} 个陆格在封闭洼地里，最深 ${p.worst.toFixed(1)} m`);
    }
  });
  it("画盆地贴着海、盆底 −200 m：被海灌进，与海连成一片、水面 0", () => {
    const w = worldOf("multi", 7), U = gen2Uplift(w.st, basinsOf(discAt(w, siteOf(w, "coast"), 3, -200)), RP0);
    assert.ok(U.water && U.water.list.some(x => x.kind === 3 && x.surfM === 0), JSON.stringify(U.water && U.water.list));
    assert.deepStrictEqual(waterBad(w, U), []);
  });
  it("海面以下的盆底（干处成盐滩）：盆里没有水邻的陆格水面记 NO_WATER，基底为负、不钳 0、渲染端不判水；没有盆地掩码就被钳回海面", () => {
    const w = worldOf("mono", 5), { m, st, um } = w, i0 = siteOf(w, "dry"), fl = discAt(w, i0, 3, -200);
    const U = gen2Uplift(st, basinsOf(fl), RP0), gm = buildGridCells(m, [], 0, U), ws = waterSurface(m, gm), b = baseElev(m, gm);
    let k = -1, wetLook = 0, noWater = 0;
    for (const [i] of fl) { if (k < 0 || U.base[i] < U.base[k]) k = i; if (ws[i] === NO_WATER) noWater++; if (b[i] < ws[i] - 0.02) wetLook++; }
    assert.strictEqual(noWater, fl.size, "涂抹格都没有水邻：水面是 NO_WATER");
    assert.strictEqual(wetLook, 0, "海面下的干地不该判成水");
    assert.ok(b[k] * um <= -195, `盆底基底 ${(b[k] * um).toFixed(0)} m`);
    const bare = buildGridCells(m, [], 0, { ...U, basin: null }), b0 = baseElev(m, bare);
    assert.ok(b0[k] >= 0, "没有盆地掩码时陆地被钳在海面以上（掩码是放开的唯一开关）");
  });
  it("分区与软边：8 邻连通各成一区、目标取区内最大、区内权重按目标比例；软边＝max(15 km, 1.5 格)、外沿为 0、水格不抬", () => {
    for (const [extra, softKm] of [[{}, 1.5 * 0.2 * 10000 * 2 * Math.PI / 360], [{ planetRadiusKm: 2500 }, 15]] as const) {
      const { g, st, spots } = setup(extra, 4), { cols } = g, out = st.pr.inp.out;
      const map = new Map<number, number>();
      disc(map, cols, spots[0], 2, 1200); map.set(spots[0][0] * cols + spots[0][1], 3000); disc(map, cols, spots[1], 0, 2000);
      const S = upliftRegions(st, cellsOf(map));
      assert.strictEqual(S.regions.length, 2);
      assert.ok(Math.abs(S.soft - softKm) < 1e-9, `软边 ${S.soft} km`);
      const R0 = S.regions.find(r => r.peak.length > 1)!;
      assert.strictEqual(R0.target, 3000, "目标取区内最大");
      for (let t = 0; t < R0.idx.length; t++) {
        const i = R0.idx[t];
        assert.strictEqual(out[i], 0, "水格不抬");
        if (map.has(i)) assert.ok(Math.abs(R0.w[t] - map.get(i)! / 3000) < 1e-12, "涂抹格权重＝目标比例");
      }
      /* 支撑只到软边：三角网节点在格内抖动，按格心量的直线距离与路程至多差一格 */
      const kmd = 10000 * (extra.planetRadiusKm ?? 10000) / 10000 * 2 * Math.PI / 360, kmy = g.step * kmd;
      let far = 0;
      for (const i of R0.idx) {
        const r = (i / cols) | 0, c = i % cols; let dmin = Infinity;
        for (const j of R0.peak) { const rj = (j / cols) | 0, cj = j % cols, kx = kmy * Math.cos((g.bb.latMin + (r + 0.5) * g.step) * Math.PI / 180); dmin = Math.min(dmin, Math.hypot((c - cj) * kx, (r - rj) * kmy)); }
        far = Math.max(far, dmin);
      }
      assert.ok(far < S.soft + kmy && far > S.soft - kmy, `支撑最远 ${far.toFixed(1)} km，软边 ${S.soft.toFixed(1)} km`);
    }
  });
});

describe("生成器 v2：水文（流向、水量与内流区）", () => {
  /* 流向在地表定型之后重算：稳态树定在叠高原、扣盆地、成湖之前，曾给湖开错出口、让河爬坡 */
  const surf = (M: Macro, i: number): number => !M.land[i] ? 0 : M.lake[i] >= 0 ? M.lakeS[M.lake[i]] : M.h[i];
  it("河不逆坡；外流湖只有一个出口、在最低的湖岸；内流湖是终点且湖岸都比湖面高；盐滩的水流不进海", () => {
    for (const [st, s] of [["mono", 1], ["mono", 5], ["mono", 6]] as const) {
      const M = buildMacro(gen2Params(v2(st, s))), n = M.rcv.length, { nbOff, nb } = M.mesh;
      let up = 0;
      for (let i = 0; i < n; i++) { const j = M.rcv[i]; if (j !== i && M.land[i] && surf(M, j) > surf(M, i) + 1e-6) up++; }
      assert.strictEqual(up, 0, `${st} 种子 ${s}：${up} 段河往高处流`);
      M.lakeS.forEach((S, id) => {
        const exits = new Set<number>();
        let shore = Infinity;
        for (let i = 0; i < n; i++) {
          if (M.lake[i] !== id) continue;
          if (M.rcv[i] !== i && M.lake[M.rcv[i]] !== id) exits.add(M.rcv[i]);
          if (M.lakeEnd[id]) assert.strictEqual(M.rcv[i], i, `${st} 种子 ${s}：内流湖 ${id} 的湖格不是终点`);
          for (let e = nbOff[i]; e < nbOff[i + 1]; e++) { const j = nb[e]; if (M.lake[j] !== id && M.land[j]) shore = Math.min(shore, M.h[j]); }
        }
        if (M.lakeEnd[id]) { assert.ok(shore >= S, `${st} 种子 ${s}：内流湖 ${id} 湖岸 ${shore.toFixed(0)} m 低于湖面 ${S.toFixed(0)} m`); return; }
        assert.strictEqual(exits.size, 1, `${st} 种子 ${s}：外流湖 ${id} 有 ${exits.size} 个出口`);
        const o = [...exits][0];
        assert.ok(surf(M, o) <= shore + 1e-6, `${st} 种子 ${s}：外流湖 ${id} 从 ${surf(M, o).toFixed(0)} m 的岸出去，最低湖岸 ${shore.toFixed(0)} m`);
      });
      for (let i = 0; i < n; i++) {   // 盐滩在内流盆地里：盆底的是终点，咸湖外圈的流进湖
        if (!M.salt[i]) continue;
        let e = i; for (let t = 0; t < n && M.rcv[e] !== e; t++) e = M.rcv[e];
        assert.ok(M.land[e], `${st} 种子 ${s}：盐滩格 ${i} 的水流进了海`);
      }
    }
  });
  it("内流区：单块种子 5（南部副热带荒漠带）有咸湖与盐滩，细格盐滩落成 plain/salt", () => {
    const m = v2("mono", 5), g = buildGridCells(m, [], 0), M = gen2Fine(m, g).macro;
    assert.ok(M.lakeEnd.some(t => t === 1), "应当有内流咸湖");
    assert.ok(M.salt.some(v => v === 1), "应当有盐滩节点");
    assert.ok(g.cells.some(r => r.includes("plain/salt")), "细格里没有盐滩");
  });
  it("河按水量：单块种子 3（南部大片荒漠）水量 ≥ 300 m³/s 的河段，落在荒漠（水汽 < 0.14）里的不到一成", () => {
    const M = buildMacro(gen2Params(v2("mono", 3))), n = M.rcv.length;
    let all = 0, dry = 0, desert = 0;
    for (let i = 0; i < n; i++) {
      if (M.land[i] && M.moist[i] < 0.14) desert++;
      if (!M.land[i] || M.rcv[i] === i || M.q[i] < 300) continue;
      all++; if (M.moist[i] < 0.14) dry++;
    }
    assert.ok(desert > n / 50, "夹具应当有大片荒漠");
    assert.ok(all > 100 && dry < 0.1 * all, `${dry} / ${all} 段大河在荒漠里`);
  });
});

describe("生成器 v2：水汽与荒漠", () => {
  /* 中纬度只有西侧供水汽时，山后雨影一路干到东海岸；副热带不下沉时，荒漠只出在中纬度的山后 */
  it("单块种子 1–3：荒漠占陆 32° 以南多于 36° 以北；36–50° 各行最东的陆格（东海岸）都不偏干（水汽 ≥ 0.26）", () => {
    for (const s of [1, 2, 3]) {
      const M = buildMacro(gen2Params(v2("mono", s))), { cols, rows } = M;
      const sub = [0, 0], mid = [0, 0];
      let dryCoast = 0;
      for (let r = 0; r < rows; r++) {
        const lat = M.lat0 + (r + 0.5) * M.dlat, band = lat < 32 ? sub : lat >= 36 ? mid : null;
        let east = -1;
        for (let q = 0; q < cols; q++) {
          const i = r * cols + q;
          if (!M.land[i]) continue;
          east = i;
          if (band) { band[0]++; if (M.moist[i] < 0.14) band[1]++; }
        }
        if (lat >= 36 && lat < 50 && east >= 0 && M.moist[east] < 0.26) dryCoast++;
      }
      assert.ok(sub[1] / sub[0] > mid[1] / mid[0], `种子 ${s}：32° 以南荒漠占陆 ${(100 * sub[1] / sub[0]).toFixed(1)}%，36° 以北 ${(100 * mid[1] / mid[0]).toFixed(1)}%`);
      assert.strictEqual(dryCoast, 0, `种子 ${s}：36–50° 有 ${dryCoast} 行东海岸偏干`);
    }
  });
});

describe("生成器 v2：河流折线", () => {
  const FIX = [["mono", 2], ["mono", 6], ["multi", 1], ["isles", 3]] as const;
  const draw = (m: Meta) => { const g = gridGeom(m), F = gen2Fine(m, g); return { g, F, M: F.macro, R: gen2Rivers(m, g) }; };
  const k4 = (x: number, y: number) => `${Math.round(x * 1e4) / 1e4},${Math.round(y * 1e4) / 1e4}`;
  const surf = (M: Macro, i: number): number => M.lake[i] >= 0 ? M.lakeS[M.lake[i]] : M.h[i];
  it("自源头向下游：折线上落在宏观节点的点地面不升；一段的终点是另一段的起点时，下游那段不比上游窄", () => {
    for (const [st, s] of FIX) {
      const { M, R } = draw(v2(st, s)), node = new Map<string, number>();
      for (let i = 0; i < M.rcv.length; i++) if (M.land[i]) node.set(k4(M.lon0 + (M.mesh.X[i] + 0.5) * M.dlon, M.lat0 + (M.mesh.Y[i] + 0.5) * M.dlat), i);
      let up = 0, narrow = 0;
      for (const r of R) {
        let prev = Infinity;
        for (const p of r.pts) { const i = node.get(k4(p[0], p[1])); if (i == null) continue; if (surf(M, i) > prev + 1e-6) up++; prev = surf(M, i); }
      }
      const starts = new Map<string, GenRiver[]>();
      for (const r of R) { const k = k4(...r.pts[0]); starts.set(k, [...(starts.get(k) || []), r]); }
      for (const r of R) for (const d of starts.get(k4(...r.pts[r.pts.length - 1])) || []) if (d.widthM < r.widthM) narrow++;
      assert.ok(R.length > 50, `${st} 种子 ${s}：只画了 ${R.length} 段`);
      assert.strictEqual(up, 0, `${st} 种子 ${s}：${up} 处河往高处流`);
      assert.strictEqual(narrow, 0, `${st} 种子 ${s}：${narrow} 处下游比上游窄`);
    }
  });
  it("河头往上游延到跌破门槛的 35%：河头最大的陆上来水若没画出来，就不够回差（两条支流在海边才汇过门槛时不只画一截河口）", () => {
    for (const [st, s, riv] of [["mono", 2, 0], ["mono", 2, 0.5], ["isles", 3, 0.5]] as const) {
      const m = v2(st, s, { genRiv: riv }), { M, R } = draw(m), { qmin, wf } = riverParams(m), pos = new Map<string, number>(), drawn = new Set<string>(), ends = new Set<string>();
      for (let i = 0; i < M.rcv.length; i++) if (M.land[i]) pos.set(k4(M.lon0 + (M.mesh.X[i] + 0.5) * M.dlon, M.lat0 + (M.mesh.Y[i] + 0.5) * M.dlat), i);
      for (const r of R) { r.pts.forEach(p => drawn.add(k4(p[0], p[1]))); ends.add(k4(...r.pts[r.pts.length - 1])); }
      const keyOf = (i: number) => k4(M.lon0 + (M.mesh.X[i] + 0.5) * M.dlon, M.lat0 + (M.mesh.Y[i] + 0.5) * M.dlat);
      let heads = 0, short = 0;
      for (const r of R) {
        const k = k4(...r.pts[0]), h = pos.get(k);
        if (h == null || M.lake[h] >= 0 || ends.has(k)) continue;
        heads++;
        let u = -1;
        for (let v = 0; v < M.rcv.length; v++) if (M.rcv[v] === h && v !== h && M.land[v] && (u < 0 || M.q[v] > M.q[u])) u = v;
        if (u >= 0 && M.lake[u] < 0 && !drawn.has(keyOf(u)) && M.q[u] * wf >= 0.35 * qmin) short++;
      }
      assert.ok(heads > 10, `${st} 种子 ${s}：只认出 ${heads} 个河头`);
      assert.strictEqual(short, 0, `${st} 种子 ${s} 河流多少 ${riv}：${short} 个河头还该往上游延`);
    }
  });
  it("折线不压细格水面（出湖的河首点在湖边、末点在水边）；末端落在水边或汇进别的河，半路断掉的只在干处（水汽 < 0.26）", () => {
    for (const [st, s] of FIX) {
      const { g, F, M, R } = draw(v2(st, s)), { cols, rows } = g;
      const cell = (x: number, y: number) => [Math.floor((x - g.bb.lonMin) / g.step), Math.floor((y - g.bb.latMin) / g.step)];
      const out = (c: number, r: number) => c < 0 || r < 0 || c >= cols || r >= rows;
      const wet = (c: number, r: number) => out(c, r) || F.lf[r * cols + c] === 5;
      const lakeAt = (c: number, r: number) => !out(c, r) && F.lf[r * cols + c] === 5 && !F.sea[r * cols + c];
      const pts = new Map<string, number>();
      R.forEach(r => r.pts.forEach(p => { const k = k4(p[0], p[1]); pts.set(k, (pts.get(k) || 0) + 1); }));
      let inWater = 0, wetDead = 0;
      for (const r of R) {
        for (let k = 0; k < r.pts.length - 1; k++) { const [c, rr] = cell(...r.pts[k]); if (wet(c, rr) && !(k === 0 && lakeAt(c, rr))) inWater++; }
        const e = r.pts[r.pts.length - 1], [c, rr] = cell(...e);
        let shore = false;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (wet(c + dc, rr + dr)) shore = true;
        if (shore || pts.get(k4(...e))! > 1) continue;
        let bi = 0, bd = Infinity;
        for (let i = 0; i < M.rcv.length; i++) { const dx = M.lon0 + (M.mesh.X[i] + 0.5) * M.dlon - e[0], dy = M.lat0 + (M.mesh.Y[i] + 0.5) * M.dlat - e[1]; if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; bi = i; } }
        if (M.moist[bi] >= 0.26) wetDead++;
      }
      assert.strictEqual(inWater, 0, `${st} 种子 ${s}：${inWater} 个折线点压在水面上`);
      assert.strictEqual(wetDead, 0, `${st} 种子 ${s}：${wetDead} 条河在湿润处半路断掉`);
    }
  });
  it("出海口细格上有水：被陆地围住、细格画成陆的浅海不当海（否则河流进一片看不见的海）", () => {
    for (const [st, s] of FIX) {
      const { g, F, M } = draw(v2(st, s)), reach = Math.ceil(3 * M.dlat / g.step);
      let bad = 0;
      for (let u = 0; u < M.rcv.length; u++) {
        const i = M.rcv[u]; if (i === u || !M.land[u] || M.land[i]) continue;
        const c0 = Math.floor((M.lon0 + (M.mesh.X[i] + 0.5) * M.dlon - g.bb.lonMin) / g.step), r0 = Math.floor((M.lat0 + (M.mesh.Y[i] + 0.5) * M.dlat - g.bb.latMin) / g.step);
        let found = false;
        for (let r = r0 - reach; r <= r0 + reach && !found; r++) for (let c = c0 - reach; c <= c0 + reach; c++) if (r >= 0 && c >= 0 && r < g.rows && c < g.cols && F.lf[r * g.cols + c] === 5) { found = true; break; }
        if (!found) bad++;
      }
      assert.strictEqual(bad, 0, `${st} 种子 ${s}：${bad} 个出海口方圆三格内细格全是陆`);
    }
  });
  it("「河流多少」与「水量」往右河都更多，「水量」往右最宽的河也更宽；图幅大小不同时条数同一量级", () => {
    const tot = (R: GenRiver[]) => R.reduce((a, r) => a + r.pts.length, 0);
    const [a, b, c] = [0, 0.5, 1].map(t => draw(v2("mono", 2, { genRiv: t })).R);
    assert.ok(tot(a) < tot(b) && tot(b) < tot(c), `折线点数 ${tot(a)} / ${tot(b)} / ${tot(c)}`);
    const lo = draw(v2("mono", 2, { genWater: 0 })).R, hi = draw(v2("mono", 2, { genWater: 1 })).R, wmax = (R: GenRiver[]) => Math.max(...R.map(r => r.widthM));
    assert.ok(tot(lo) < tot(b) && tot(b) < tot(hi), `水量两端与中值的折线点数 ${tot(lo)} / ${tot(b)} / ${tot(hi)}`);
    assert.ok(wmax(lo) < wmax(b) && wmax(b) < wmax(hi), `最宽 ${wmax(lo)} / ${wmax(b)} / ${wmax(hi)} m`);
    for (const bbox of [{ lonMin: 100, lonMax: 112, latMin: 28, latMax: 37 }, { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 }]) {
      const n = draw(v2("mono", 2, { bbox })).R.length;
      assert.ok(n > b.length / 4 && n < b.length * 4, `图幅 ${bbox.lonMax - bbox.lonMin}°：${n} 段，缺省图幅 ${b.length} 段`);
    }
  });
});

/* 中尺度河网：湖与盐滩定下之后在最终地表上填洼、汇流、刻河、抽河；刻地形只认物理水量，两个河流滑杆只管抽哪些、画多宽 */
describe("生成器 v2：中尺度河网", () => {
  const FIX = [["mono", 7], ["multi", 7], ["isles", 7], ["mono", 5]] as const;
  const sets = new Map<string, { m: Meta; g: ReturnType<typeof buildGridCells>; R: ReturnType<typeof gen2Meso>; F: ReturnType<typeof gen2Fine> }>();
  const setOf = (st: "mono" | "multi" | "isles", seed: number) => {
    const k = st + seed; let s = sets.get(k);
    if (!s) { const m = v2(st, seed), g = buildGridCells(m, [], 0); s = { m, g, R: gen2Meso(m, g), F: gen2Fine(m, g) }; sets.set(k, s); }
    return s;
  };
  const len = (R: GenRiver[]): number => R.reduce((a, r) => { for (let k = 1; k < r.pts.length; k++) a += Math.hypot(r.pts[k][0] - r.pts[k - 1][0], r.pts[k][1] - r.pts[k - 1][1]); return a; }, 0);
  it("两个河流滑杆不进地形：挪了基底、包络、地类逐位同；往右河更长，「水量」往右最宽的河也更宽", () => {
    const { m, g, R } = setOf("multi", 7), sg = (): { h: Float64Array; rcv: Int32Array } => ({ h: R.sg.h.slice(), rcv: R.sg.rcv.slice() });
    const lo = gen2Meso({ ...m, genRiv: 0 }, g, sg()), hi = gen2Meso({ ...m, genRiv: 1 }, g, sg()), wet = gen2Meso({ ...m, genWater: 1 }, g, sg());
    for (const X of [lo, hi, wet]) { assert.deepStrictEqual(X.base, R.base); assert.deepStrictEqual(X.env, R.env); assert.deepStrictEqual(X.cls, R.cls); }
    assert.ok(len(lo.rivers) < len(R.rivers) && len(R.rivers) < len(hi.rivers), `河长 ${len(lo.rivers).toFixed(0)} / ${len(R.rivers).toFixed(0)} / ${len(hi.rivers).toFixed(0)}°`);
    const wmax = (X: GenRiver[]): number => Math.max(...X.map(r => r.widthM));
    assert.ok(wmax(wet.rivers) > wmax(R.rivers), `水量往右最宽 ${wmax(R.rivers)} → ${wmax(wet.rivers)} m`);
  });
  it("河只画在陆上（出湖的首点、入水的末点在岸边）；逐点水面宽与点数一致、河宽取其最大（河口展宽的那点不算）；九成的河入水或汇进别的河，入水的多数带河口展宽", () => {
    for (const [st, s] of FIX) {
      const { g, R } = setOf(st, s), { cols, rows, bb, step } = g;
      const water = (c: number, r: number): boolean => c < 0 || r < 0 || c >= cols || r >= rows || (R.cls[r * cols + c] / ECO_ORDER.length | 0) === LANDFORM_ORDER.indexOf("water");
      const cell = ([x, y]: [number, number]): [number, number] => [Math.round((x - bb.lonMin) / step - 0.5), Math.round((y - bb.latMin) / step - 0.5)];
      let onWater = 0, ended = 0, shores = 0, mouths = 0;
      const segs = R.rivers.map(r => r.pts);
      const nearLine = (p: [number, number], self: [number, number][]): boolean => segs.some(L => L !== self && L.some((q, k) => {
        if (!k) return false;
        const [ax, ay] = L[k - 1], dx = q[0] - ax, dy = q[1] - ay, t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy) < 0.5 * step;
      }));
      for (const r of R.rivers) {
        const m = r.ws!.length, mouth = r.ws![m - 1] === RIV_MOUTH_X * r.ws![m - 2];
        assert.strictEqual(m, r.pts.length); assert.ok(r.ws!.every(w => w >= 1)); assert.strictEqual(r.widthM, Math.max(...(mouth ? r.ws!.slice(0, -1) : r.ws!)));
        for (let k = 1; k < r.pts.length - 1; k++) { const [c, rr] = cell(r.pts[k]); if (water(c, rr)) onWater++; }
        const e = r.pts[r.pts.length - 1], [c, rr] = cell(e);
        let shore = false;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (water(c + dc, rr + dr)) shore = true;
        if (shore) { shores++; if (mouth) mouths++; }
        if (shore || nearLine(e, r.pts) || R.cls[rr * cols + c] % ECO_ORDER.length === ECO_ORDER.indexOf("salt")) ended++;
      }
      assert.strictEqual(onWater, 0, `${st} 种子 ${s}：${onWater} 个内点压在水上`);
      assert.ok(ended >= 0.9 * R.rivers.length, `${st} 种子 ${s}：${R.rivers.length} 条里只有 ${ended} 条入水、汇流或到盐滩`);
      assert.ok(mouths >= 0.6 * shores, `${st} 种子 ${s}：${shores} 条末点在岸边的只有 ${mouths} 条带河口展宽`);
    }
  });
  it("河在谷里：九成的内点所在格不高于四邻陆格的均值（刻了河槽、平原上压了冲积平原）", () => {
    for (const [st, s] of FIX) {
      const { g, R, F } = setOf(st, s), { cols, bb, step } = g;
      let low = 0, all = 0;
      for (const r of R.rivers) for (let k = 1; k < r.pts.length - 1; k++) {
        const [x, y] = r.pts[k], c = Math.round((x - bb.lonMin) / step - 0.5), rr = Math.round((y - bb.latMin) / step - 0.5), i = rr * cols + c;
        let sum = 0, nn = 0;
        for (const j of [i - 1, i + 1, i - cols, i + cols]) if (!R.sea[j] && F.lakeOf[j] < 0) { sum += R.base[j]; nn++; }
        if (!nn) continue;
        all++; if (R.base[i] <= sum / nn) low++;
      }
      assert.ok(all > 100 && low >= 0.9 * all, `${st} 种子 ${s}：${all} 个内点里只有 ${low} 个在谷里`);
    }
  });
  it("最终地表上没有封闭洼地：自海、湖与盐滩沿求解图填洼，陆格一格都填不起来（没成湖的洼地已填到溢出口）", () => {
    for (const [st, s] of FIX) {
      const { m, R } = setOf(st, s), p = closedPits(m, R, R.st.G);
      assert.strictEqual(p.n, 0, `${st} 种子 ${s}：${p.n} 个陆格在封闭洼地里`);
    }
  });
  /* 渲染端按格心双线性插值、地面只沿格边相通：流向斜跨一格的河道在画面上是一串封闭的坑，侵蚀细级还会把坑填平、刻出的河谷就没了 */
  it("格心双线性下也没有封闭洼地：自海、湖与盐滩按四邻填洼，陆格一格都填不起来", () => {
    for (const [st, s] of [...FIX, ["multi", 5] as const]) {   // 多块种子 5：有一步的阶梯要压过湖岸下界，得绕另一边
      const { m, R } = setOf(st, s), p = closedPits(m, R, null);
      assert.strictEqual(p.n, 0, `${st} 种子 ${s}：${p.n} 个陆格在四邻封闭洼地里，最深 ${p.worst.toFixed(1)} m`);
    }
  });
  /* 四邻排水只认不高过本格的水与汇当出口：高原上的盐滩高过旁边的格，当它是出口，那一格就留成坑 */
  it("高过本格的盐滩不是出口：单块种子 5 缺省图幅（2085 m 高原上挨着盐滩的一格）格心四邻没有封闭洼地", () => {
    const { m, R } = dfltOf("mono", 5), p = closedPits(m, R, null);
    assert.strictEqual(p.n, 0, `${p.n} 个陆格在四邻封闭洼地里，最深 ${p.worst.toFixed(1)} m`);
  });
  it("生成器的咸湖（内流）没有出湖的河，外流湖有：出湖的河首点在湖格格心", () => {
    const { g, R, F } = setOf("mono", 5), { cols, bb, step } = g;
    let fromEnd = 0, fromOpen = 0;
    for (const r of R.rivers) {
      const lk = F.lakeOf[Math.floor((r.pts[0][1] - bb.latMin) / step) * cols + Math.floor((r.pts[0][0] - bb.lonMin) / step)];
      if (lk < 0) continue;
      if (F.macro.lakeEnd[lk] === 1) fromEnd++; else fromOpen++;
    }
    assert.ok(F.macro.lakeEnd.some(v => v === 1), "前提：单块种子 5 有咸湖");
    assert.strictEqual(fromEnd, 0, `${fromEnd} 条河从咸湖流出`);
    assert.ok(fromOpen > 0, "外流湖该有出湖的河");
  });
  /* 曲流强度：渲染端在 mz 为 0 处拉直——两头与支流汇入的节点必须是 0，且抽稀不能把汇入点抽掉 */
  it("逐点曲流强度：与点数一致、0..MZ_MAX 的整数、两头为 0；支流末点落在干流的点上且那一点为 0；平缓处有满档", () => {
    for (const [st, s] of FIX) {
      const { R } = setOf(st, s), at = new Map<string, number>();
      let full = 0, joins = 0;
      for (const r of R.rivers) {
        const z = r.mz!;
        assert.strictEqual(z.length, r.pts.length);
        assert.ok(z.every(v => Number.isInteger(v) && v >= 0 && v <= MZ_MAX) && z[0] === 0 && z[z.length - 1] === 0, `${st} 种子 ${s}：${z.join(",")}`);
        for (let k = 1; k < r.pts.length - 1; k++) { at.set(r.pts[k].join(), z[k]); if (z[k] === MZ_MAX) full++; }
      }
      for (const r of R.rivers) { const v = at.get(r.pts[r.pts.length - 1].join()); if (v !== undefined) { joins++; assert.strictEqual(v, 0, `${st} 种子 ${s}：汇入点 ${r.pts[r.pts.length - 1]}`); } }
      assert.ok(joins > 5 && full > 20, `${st} 种子 ${s}：汇入 ${joins} 处、满档 ${full} 点`);
      /* 汇入点被抽稀抽掉时，干流在那里按两侧插值的强度也到不了 MZ_KEEP（2 档）：渲染端照样在那里几乎不弯 */
      const step = setOf(st, s).g.step;
      for (const r of R.rivers) {
        const [ex, ey] = r.pts[r.pts.length - 1];
        let best = Infinity, zAt = 0;
        for (const q of R.rivers) if (q !== r) for (let k = 1; k < q.pts.length; k++) {
          const [ax, ay] = q.pts[k - 1], dx = q.pts[k][0] - ax, dy = q.pts[k][1] - ay, t = Math.max(0, Math.min(1, ((ex - ax) * dx + (ey - ay) * dy) / (dx * dx + dy * dy || 1)));
          const d = Math.hypot(ax + dx * t - ex, ay + dy * t - ey);
          if (d < best) { best = d; zAt = q.mz![k - 1] + (q.mz![k] - q.mz![k - 1]) * t; }
        }
        if (best < 0.25 * step) assert.ok(zAt < 2, `${st} 种子 ${s}：汇入点 ${ex},${ey} 处干流强度 ${zAt.toFixed(2)}`);
      }
    }
  });
  it("曲流后的河段集在深放大（0.0005°/px）下每桶不超过取样上限（多块种子 7）", () => {
    const { m, R } = setOf("multi", 7), w = { meta: m, nodes: [], factions: [], decor: [], terrainOverrides: [], units: [], edges: R.rivers.map(r => ({ type: "river" as const, pts: r.pts, widthM: r.widthM, ws: r.ws, mz: r.mz })) };
    const s = riverSet(m, w, 0, 0.0005)!;
    let mx = 0;
    for (let b = 0; b < s.nx * s.ny; b++) mx = Math.max(mx, s.idx[2 * b + 1]);
    assert.ok(s.n > 1000 && mx <= RIV_LOOP, `${s.n} 段、一桶最多 ${mx}`);
  });
  /* 战略尺度的河线保弯：平滑只去节点尺度的锯齿、不缩谷尺度的弯，抽稀留住一两格的小弯——画出来的大河在百公里窗里仍弯，也不出折角 */
  it("河线保弯：画出的大河（水面宽 ≥ 190 m，Chaikin 两遍后）100 km 窗弯曲度 ≥ 1.069；全部河的折线上转角 > 60° 的折角每 100 km 不到 0.3 个（gridN 480 多块种子 7、单块种子 5）", () => {
    for (const [st, s] of [["multi", 7], ["mono", 5]] as const) {
      const m = v2(st, s, { gridN: 480 }), R = gen2Meso(m, buildGridCells(m, [], 0)), kmd = gen2Params(m).kmd, BIG = 6 * Math.sqrt(1000);
      const km = (a: [number, number], b: [number, number]): number => Math.hypot((b[0] - a[0]) * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180), b[1] - a[1]) * kmd;
      let sum = 0, win = 0, k60 = 0, tot = 0;
      for (const r of R.rivers) {
        const P = r.pts;
        for (let k = 1; k < P.length; k++) {
          tot += km(P[k - 1], P[k]);
          if (k + 1 >= P.length) continue;
          const cx = Math.cos(P[k][1] * Math.PI / 180), ux = (P[k][0] - P[k - 1][0]) * cx, uy = P[k][1] - P[k - 1][1], vx = (P[k + 1][0] - P[k][0]) * cx, vy = P[k + 1][1] - P[k][1];
          if ((ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)) < 0.5) k60++;
        }
        if (r.widthM < BIG) continue;
        /* 画出的折线每 1 km 取一点，100 km 弧长 ÷ 弦长，窗每 25 km 挪一次 */
        const D = chaikinOpen(P, 2), S: [number, number][] = [D[0]];
        let carry = 0;
        for (let k = 1; k < D.length; k++) {
          const L = km(D[k - 1], D[k]); if (!(L > 0)) continue;
          let t = 1 - carry;
          for (; t <= L; t += 1) S.push([D[k - 1][0] + (D[k][0] - D[k - 1][0]) * t / L, D[k - 1][1] + (D[k][1] - D[k - 1][1]) * t / L]);
          carry = L - (t - 1);
        }
        for (let a = 0; a + 100 < S.length; a += 25) { sum += 100 / km(S[a], S[a + 100]); win++; }
      }
      assert.ok(win > 50 && sum / win >= 1.069, `${st} 种子 ${s}：${win} 个窗、弯曲度 ${(sum / win).toFixed(4)}`);
      assert.ok(100 * k60 / tot < 0.3, `${st} 种子 ${s}：折角每 100 km ${(100 * k60 / tot).toFixed(2)} 个`);
    }
  });
  it("零抬升的画抬升单与中尺度单的河逐位同；河的指纹冻结（多块种子 7）", () => {
    const { R } = setOf("multi", 7);
    assert.deepStrictEqual(gen2Uplift(R.st, { idx: new Int32Array(0), peakM: new Float64Array(0) }, RP0).rivers, R.rivers);
    assert.strictEqual(fnv(2166136261, new TextEncoder().encode(JSON.stringify(R.rivers))).toString(16), "71405b2e");
  });
});

describe("生成器 v2：滑杆与分流", () => {
  /* 挪滑杆应当是同一张图长大、变高，而不是重洗：随机数共用一条序列时，滑杆一跨门槛，后面的抽取整体错位 */
  const sweep = (st: "mono" | "multi" | "isles", s: number, key: "genLand" | "genMtn" | "genIsl", ts: number[]): Macro[] =>
    ts.map(t => buildMacro(gen2Params(v2(st, s, { [key]: t }))));
  it("「陆地占比」逐档调大时陆地递增，且是同一批陆地长大：前一档离岸 ≥6 格的陆地沉进海里的不到陆地的 3%", () => {
    for (const [st, s] of [["mono", 3], ["multi", 2]] as const) {
      const Ms = sweep(st, s, "genLand", [0, 0.25, 0.5, 0.75, 1]);
      for (let k = 1; k < Ms.length; k++) {
        const a = landFrac(Ms[k - 1]), b = landFrac(Ms[k]), { sunk } = drift(Ms[k - 1], Ms[k]);
        assert.ok(b > a && sunk < 0.03, `${st} 种子 ${s} 第 ${k} 档：陆地 ${a.toFixed(3)} → ${b.toFixed(3)}、内陆沉海 ${(sunk * 100).toFixed(1)}%`);
      }
    }
  });
  /* 陆壳冲不冲向洋壳随山地多少变：跨过门槛的那块板块换了运动方式、海岸整段改变属设计（别的种子上有），这两颗没有 */
  it("「山地多少」0 与 1 的海陆翻转不到陆地的 2%，山地格变多", () => {
    const mtn = (M: Macro): number => { let k = 0; for (let i = 0; i < M.h.length; i++) if (M.s[i] >= 0 && M.h[i] >= 1500) k++; return k; };
    for (const [st, s] of [["mono", 3], ["multi", 2]] as const) {
      const [M0, M1] = sweep(st, s, "genMtn", [0, 1]), { flip } = drift(M0, M1);
      assert.ok(flip < 0.02 && mtn(M1) > mtn(M0), `${st} 种子 ${s}：翻转 ${(flip * 100).toFixed(1)}%、山地格 ${mtn(M0)} → ${mtn(M1)}`);
    }
  });
  it("「近岸岛多少」0 < 中值 < 1 时陆块数递增、只动近岸（每半程翻转不到陆地的 1 成，内陆不沉海），群岛一档不读它", () => {
    const Ms = sweep("mono", 2, "genIsl", [0, 0.5, 1]), k = Ms.map(M => masses(M).length);
    assert.ok(k[0] < k[1] && k[1] < k[2], k.join(" < "));
    for (let j = 1; j < Ms.length; j++) { const { flip, sunk } = drift(Ms[j - 1], Ms[j]); assert.ok(flip < 0.1 && sunk === 0, `第 ${j} 程：翻转 ${(flip * 100).toFixed(1)}%、内陆沉海 ${(sunk * 100).toFixed(1)}%`); }
    const [I0, I1] = sweep("isles", 2, "genIsl", [0, 1]);
    assert.strictEqual(masses(I0).length, masses(I1).length);
  });
  it("genVer 缺键逐位走 v1，且网格记忆不被同参数的 v2 图串用", () => {
    const m1: Meta = { terrain: "auto", genSeed: 7, genStyle: "continent", bbox: BB, worldModel: "sphere", planetRadiusKm: 10000, gridN: 120 };
    const g2 = buildGridCells({ ...m1, genVer: 2 }, [], 0), g1 = buildGridCells(m1, [], 0);
    let diffV1 = 0, diffV2 = 0;
    for (let r = 0; r < g1.rows; r++) for (let c = 0; c < g1.cols; c++) {
      const t = seedTerrain(m1, g1.bb.lonMin + (c + 0.5) * g1.step, g1.bb.latMin + (r + 0.5) * g1.step);
      if (g1.cells[r][c] !== t) diffV1++; if (g2.cells[r][c] !== t) diffV2++;
    }
    assert.strictEqual(diffV1, 0, "缺 genVer 的图没走 v1");
    assert.ok(diffV2 > 0, "genVer 2 的图与 v1 逐格相同——分流没生效");
    assert.ok(!isGen2({ ...m1, genVer: 2, terrain: "plain" }), "非自动生成的图不走 v2");
  });
});

/* 三档风格的构图承诺（板块骨架）：单块＝一块主陆；多块＝至少两块像样的陆地；群岛＝最大岛不独大。按宏观格 4 邻连通数陆块 */
function masses(M: Macro): number[] {
  const { cols, rows } = M, n = cols * rows, lab = new Int32Array(n).fill(-1), out: number[] = [], st: number[] = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (M.s[s0] < 0 || lab[s0] >= 0) continue;
    let sz = 0; lab[s0] = out.length; st.push(s0);
    while (st.length) {
      const i = st.pop()!, r = (i / cols) | 0, c = i - r * cols; sz++;
      for (const j of [c + 1 < cols ? i + 1 : -1, c > 0 ? i - 1 : -1, r + 1 < rows ? i + cols : -1, r > 0 ? i - cols : -1])
        if (j >= 0 && M.s[j] >= 0 && lab[j] < 0) { lab[j] = out.length; st.push(j); }
    }
    out.push(sz);
  }
  const tot = out.reduce((a, b) => a + b, 0);
  return out.map(v => v / tot).sort((a, b) => b - a);
}
describe("生成器 v2：板块骨架的构图", () => {
  const seeds = [1, 2, 3, 4];
  it("单块大陆：主陆占陆地八成五以上", () => {
    for (const s of seeds) { const m = masses(buildMacro(gen2Params(v2("mono", s)))); assert.ok(m[0] >= 0.85, `种子 ${s} 主陆只占 ${(m[0] * 100).toFixed(1)}%`); }
  });
  it("多块大陆：至少两块陆地各占一成以上", () => {
    for (const s of seeds) { const m = masses(buildMacro(gen2Params(v2("multi", s)))); assert.ok(m.filter(v => v >= 0.1).length >= 2, `种子 ${s} 的陆块占比 ${m.slice(0, 4).map(v => (v * 100).toFixed(1)).join("/")}`); }
  });
  it("群岛：最大的岛不超过陆地六成，且岛多", () => {
    for (const s of seeds) { const m = masses(buildMacro(gen2Params(v2("isles", s)))); assert.ok(m[0] <= 0.6 && m.length >= 10, `种子 ${s}：最大 ${(m[0] * 100).toFixed(1)}%、${m.length} 块`); }
  });
  /* 海岸碎度：岸线格数 ÷ 等面积圆周长（光滑椭圆约 1），与不足陆地 1% 的小陆块数；光滑陆块的海岸噪声只推得动几十公里 */
  const coastStats = (M: Macro): { wind: number; isles: number } => {
    const { cols, rows } = M, L = (i: number) => M.s[i] >= 0;
    let land = 0, coast = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c; if (!L(i)) continue; land++;
      if ((c > 0 && !L(i - 1)) || (c < cols - 1 && !L(i + 1)) || (r > 0 && !L(i - cols)) || (r < rows - 1 && !L(i + cols))) coast++;
    }
    return { wind: coast / (2 * Math.sqrt(Math.PI * land)), isles: masses(M).filter(v => v < 0.01).length };
  };
  it("海岸曲折、近岸有岛：单块岸线 ≥ 等面积圆的 1.8 倍、多块 ≥ 3 倍，小岛各 ≥ 12 个", () => {
    for (const s of seeds) for (const [st, k] of [["mono", 1.8], ["multi", 3]] as const) {
      const { wind, isles } = coastStats(buildMacro(gen2Params(v2(st, s))));
      assert.ok(wind >= k && isles >= 12, `${st} 种子 ${s}：曲折 ${wind.toFixed(2)}、小岛 ${isles}`);
    }
  });
  it("峰顶软上限随纬度：膝点＝雪线曲线 + 700 m（赤道恰 5.5 km、45° 3.6 km、极地 0.7 km，平面图恒 5.5 km）；拉满的整球图逐节点不过膝点 + 3 km，高纬最高峰低于低纬", () => {
    assert.deepStrictEqual([0, 20, 45, 60, 90, -45].map(l => peakKneeM(true, l)), [5500, 5900, 3600, 1900, 700, 3600]);
    assert.strictEqual(peakKneeM(false, 60), PEAK_KNEE_M);
    assert.strictEqual(peakCapM(3000, 3600, 0), 3000, "膝点以下不动");
    assert.strictEqual(peakCapM(9000, 3600, 1), 9000, "画抬升的涂抹格让开");
    assert.ok(peakCapM(9000, 3600, 0) < 3600 + PEAK_SOFT_M && peakCapM(9000, 3600, 0) > peakCapM(6000, 3600, 0), "压缩单调且不过膝点 + 软度");
    assert.ok(Math.abs(peakCapM(9000, 3600, 0.5) - (peakCapM(9000, 3600, 0) + 9000) / 2) < 1e-9, "软边按 kw 混合");
    for (const st of ["mono", "multi"] as const) {
      const p = gen2Params(v2(st, 1, { genLand: 1, genMtn: 1, bbox: { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 } })), M = buildMacro(p);
      let hi = 0, lo = 0;
      for (let i = 0; i < M.h.length; i++) {
        const lat = M.lat0 + (M.mesh.Y[i] + 0.5) * M.dlat, knee = peakKneeM(p.sphere, lat);
        assert.ok(M.h[i] < knee + PEAK_SOFT_M, `${st} 节点 ${i} 纬 ${lat.toFixed(1)} 高 ${Math.round(M.h[i])} m 过了膝点 + 软度 ${Math.round(knee + PEAK_SOFT_M)}`);
        if (Math.abs(lat) >= 60) hi = Math.max(hi, M.h[i]); else if (Math.abs(lat) <= 30) lo = Math.max(lo, M.h[i]);
      }
      assert.ok(hi > 0 && lo > hi, `${st}：|纬| ≥ 60° 最高 ${Math.round(hi)} m 应低于 |纬| ≤ 30° 最高 ${Math.round(lo)} m`);
    }
  });
});
