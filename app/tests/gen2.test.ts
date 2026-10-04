/* 生成器 v2（core/gen2）：确定性、湖与水面、渲染端约束、滑杆方向、与 v1 的分流。
   输出哈希是冻结的基线（同 worker.test 钉字面键）：改了生成数学就会红，换代要想清楚旧图会变成什么样。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMacro, gen2Fine, gen2Params, gen2Rivers, GEN2_SEED_MAX, isGen2, riverParams, type GenRiver, type Macro } from "../src/core/gen2.ts";
import { buildGridCells, gridGeom } from "../src/core/grid.ts";
import { baseElev, waterSurface, SHORE_E } from "../src/core/elev.ts";
import { seedTerrain, GEN_SEED_MAX } from "../src/core/terrain.ts";
import { terrainProps } from "../src/core/constants.ts";
import type { Meta } from "../src/core/types.ts";

const BB = { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 };
const v2 = (style: "mono" | "multi" | "isles", seed: number, extra: Partial<Meta> = {}): Meta =>
  ({ terrain: "auto", genVer: 2, genSeed: seed, genStyle: style, bbox: BB, worldModel: "sphere", planetRadiusKm: 10000, gridN: 240, ...extra });

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
    }, { mono: "1bac1d29", multi: "deb1e73e", isles: "ff91a5a1", flat: "c19475bc", rivers: "b19d85d9" });
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
  it("峰顶软上限：陆地占比与山地多少拉满也不过 8.5 km", () => {
    for (const st of ["mono", "multi"] as const) { const M = buildMacro(gen2Params(v2(st, 1, { genLand: 1, genMtn: 1 }))); let mx = 0; for (const v of M.h) if (v > mx) mx = v; assert.ok(mx < 8500, `${st} 最高 ${Math.round(mx)} m`); }
  });
});
