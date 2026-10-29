/* 生成器 v2 的三角洲（core/gen2 的 buildDeltas 与分汊线）：只给入海大河，水还是原来的水，洲是陆、主河从洲上入海。
   夹具与量具见 fixtures/gen2-maps.ts；基底与河的哈希随 gen2.test 的中尺度钉值一起冻结 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gen2Fine, gen2Meso, gen2Params, type GenRiver } from "../src/core/gen2.ts";
import { buildGridCells } from "../src/core/grid.ts";
import { baseElev, waterSurface } from "../src/core/elev.ts";
import { ECO_ORDER, LANDFORM_ORDER, MZ_MAX, terrainProps } from "../src/core/constants.ts";
import type { Meta } from "../src/core/types.ts";
import { closedPits, dfltOf, RIV_MOUTH_X, v2 } from "./fixtures/gen2-maps.ts";

/* 三角洲：入海大河的河口先走分汊槽、再长叶瓣；水还是原来的水（湖面、水体个数不变），洲是陆、主河从自家的洲入海 */
describe("生成器 v2：三角洲", () => {
  /* gridN 480 的四张（240 上只剩零到三个洲）与缺省图幅三张；缺省图幅一格 6.67 km，洲更像样，河口附近的走法也细 */
  const sets = new Map<string, { m: Meta; g: ReturnType<typeof buildGridCells>; R: ReturnType<typeof gen2Meso>; F: ReturnType<typeof gen2Fine> }>();
  const fx = (st: "mono" | "multi" | "isles", s: number, gn: number) => {
    const k = st + s + "/" + gn; let x = sets.get(k);
    if (!x) {
      const d = gn ? null : dfltOf(st as "mono" | "multi", s), m = d ? d.m : v2(st, s, { gridN: gn }), g = buildGridCells(m, [], 0);
      x = { m, g, R: d ? d.R : gen2Meso(m, g), F: gen2Fine(m, g) }; sets.set(k, x);
    }
    return x;
  };
  const ALL = [["multi", 7, 480], ["mono", 5, 480], ["isles", 1, 480], ["multi", 3, 480], ["multi", 7, 0], ["mono", 5, 0], ["multi", 3, 0]] as const;
  const W = LANDFORM_ORDER.indexOf("water"), ne = ECO_ORDER.length;
  const wetCls = (c: number): boolean => ((c / ne) | 0) === W;
  /** 四连通水体：含生成器海格（或碰图幅边）的算海，其余算湖 */
  const bodies = (cols: number, rows: number, wet: (i: number) => boolean, sea: Uint8Array): [number, number] => {
    const lab = new Uint8Array(cols * rows); let s = 0, l = 0;
    for (let s0 = 0; s0 < cols * rows; s0++) {
      if (!wet(s0) || lab[s0]) continue;
      const q = [s0]; lab[s0] = 1; let isSea = false;
      while (q.length) {
        const i = q.pop()!, r = (i / cols) | 0, c = i - r * cols;
        if (sea[i] || r === 0 || c === 0 || r === rows - 1 || c === cols - 1) isSea = true;
        for (const j of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1]) if (j >= 0 && wet(j) && !lab[j]) { lab[j] = 1; q.push(j); }
      }
      if (isSea) s++; else l++;
    }
    return [s, l];
  };
  it("洲只长在入海水量 ≥ 500 m³/s 的大河口，只占生成器的海格（入湖的河口不长）；水量是物理量，两个河流滑杆拉到两头洲一格不变", () => {
    for (const [st, s, gn] of ALL) {
      const { R, F } = fx(st, s, gn), D = R.deltas!;
      assert.ok(D && D.list.length >= 5, `${st} 种子 ${s} / ${gn}：洲 ${D ? D.list.length : 0} 个`);
      for (const d of D.list) assert.ok(d.q >= 500 && F.sea[d.j] && !F.sea[d.i] && d.area > 0, JSON.stringify({ q: d.q, i: d.i, j: d.j }));
      let bad = 0;
      for (let i = 0; i < D.owner.length; i++) if (D.owner[i] >= 0 && !(F.sea[i] && F.lakeOf[i] < 0 && !R.sea[i])) bad++;
      assert.strictEqual(bad, 0, `${st} 种子 ${s} / ${gn}：${bad} 个洲格不是原先的海或还是水`);
    }
    const { m, g, R } = fx("multi", 7, 480), sg = (): { h: Float64Array; rcv: Int32Array } => ({ h: R.sg.h.slice(), rcv: R.sg.rcv.slice() });
    for (const x of [{ genRiv: 0 }, { genRiv: 1, genWater: 1 }]) assert.deepStrictEqual(gen2Meso({ ...m, ...x }, g, sg()).deltas!.owner, R.deltas!.owner);
  });
  it("水还是原来的水：剩下的水格渲染端算出的水面逐格不变，四连通的海与湖个数不变", () => {
    for (const [st, s, gn] of ALL) {
      const { m, g, R, F } = fx(st, s, gn), gm = buildGridCells(m, [], 0, R), w0 = waterSurface(m, g), w1 = waterSurface(m, gm), { cols, rows } = g;
      const wet0 = (i: number): boolean => terrainProps(g.cells[(i / cols) | 0][i % cols]).lf === "water", wet1 = (i: number): boolean => wetCls(R.cls[i]);
      let moved = 0;
      for (let i = 0; i < cols * rows; i++) if (wet0(i) && wet1(i) && w0[i] !== w1[i]) moved++;
      assert.strictEqual(moved, 0, `${st} 种子 ${s} / ${gn}：${moved} 个水格的水面变了`);
      assert.deepStrictEqual(bodies(cols, rows, wet1, F.sea), bodies(cols, rows, wet0, F.sea), `${st} 种子 ${s} / ${gn}：长洲切断了水体或围出了水塘`);
    }
  });
  it("洲是陆：渲染端判陆、基底不低于槽尖（0.5 m）、四邻连到大陆；九成以上是近岸带（湿处沼泽），不是盐滩", () => {
    for (const [st, s, gn] of ALL) {
      const { m, R } = fx(st, s, gn), D = R.deltas!, gm = buildGridCells(m, [], 0, R), b = baseElev(m, gm), ws = waterSurface(m, gm), um = gen2Params(m).unitM, { cols, rows } = gm, n = cols * rows;
      let wet = 0, low = 0, coast = 0, salt = 0, cells = 0;
      for (let i = 0; i < n; i++) {
        if (D.owner[i] < 0) continue;
        cells++;
        if (wetCls(R.cls[i]) || b[i] < ws[i] - 0.02) wet++;
        if (R.base[i] * um < 0.5 - 1e-6) low++;
        if (((R.cls[i] / ne) | 0) === LANDFORM_ORDER.indexOf("coast")) coast++;
        if (R.cls[i] % ne === ECO_ORDER.indexOf("salt")) salt++;
      }
      const ok = new Uint8Array(n), q: number[] = [];
      for (let i = 0; i < n; i++) if (!wetCls(R.cls[i]) && D.owner[i] < 0) { ok[i] = 1; q.push(i); }
      while (q.length) { const i = q.pop()!, r = (i / cols) | 0, c = i - r * cols; for (const j of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1]) if (j >= 0 && !ok[j] && D.owner[j] >= 0) { ok[j] = 1; q.push(j); } }
      let isl = 0; for (let i = 0; i < n; i++) if (D.owner[i] >= 0 && !ok[i]) isl++;
      assert.deepStrictEqual({ wet, low, isl, salt }, { wet: 0, low: 0, isl: 0, salt: 0 }, `${st} 种子 ${s} / ${gn}`);
      assert.ok(coast >= 0.9 * cells, `${st} 种子 ${s} / ${gn}：${cells} 个洲格里近岸带只有 ${coast} 个`);
    }
  });
  it("主河从洲上入海：自河口上游三格沿最终流向走，入水前的末个陆格在洲上（自家的，或与它连成一片的邻洲）；槽格（槽尖除外）在三角网上挨水的不到三成——挨水的槽格把主河从半路放进海里", () => {
    for (const [st, s, gn] of ALL) {
      const { R } = fx(st, s, gn), D = R.deltas!, G = R.st.G;
      let off = 0, all = 0, wet = 0;
      D.list.forEach(d => {
        if (D.owner[d.end] < 0) off++;
        for (const C of d.chans) for (let t = 0; t < C.length - 1; t++) { all++; for (let e = G.nbOff[C[t]]; e < G.nbOff[C[t] + 1]; e++) if (R.sea[G.nb[e]]) { wet++; break; } }
      });
      assert.strictEqual(off, 0, `${st} 种子 ${s} / ${gn}：${D.list.length} 个洲里有 ${off} 个主河绕开了洲`);
      assert.ok(wet < 0.3 * all, `${st} 种子 ${s} / ${gn}：${all} 个槽格里 ${wet} 个在三角网上挨水`);
    }
  });
  it("长洲之后格心四邻没有封闭洼地，求解图上也没有", () => {
    for (const [st, s, gn] of ALL) {
      const { m, R } = fx(st, s, gn), p4 = closedPits(m, R, null);
      /* 多块种子 7 缺省图幅：两格等高的 4 邻对，流向树上的受水者比它们高 0.3 m，gridDrain 换最低邻格换到了对方——留账的坑 */
      const tol = st === "multi" && s === 7 && gn === 0 ? 2 : 0;
      assert.ok(p4.n <= tol, `${st} 种子 ${s} / ${gn}：${p4.n} 个陆格在四邻封闭洼地里，最深 ${p4.worst.toFixed(1)} m`);
      /* 四邻排水压下的阶梯格会在求解图上留下零星的坑（长洲之前就有，各夹具一两格）：渲染只沿格边相通，求解图上的坑不进画面 */
      const pm = closedPits(m, R, R.st.G);
      assert.ok(pm.n <= 3, `${st} 种子 ${s} / ${gn}：${pm.n} 个陆格在求解图的封闭洼地里`);
    }
  });
  it("河画到洲外的水里：入水的河（带河口展宽）末点落在水格上；分汊线带标记、整条一个宽、曲流强度两头 0 中间满档，首点在主河（或别的分汊线）上、内点在陆上、末点在水上", () => {
    let branches = 0;
    for (const [st, s, gn] of ALL) {
      const { g: { bb, step, cols }, R } = fx(st, s, gn), cellOf = ([x, y]: [number, number]): number => Math.floor((y - bb.latMin) / step) * cols + Math.floor((x - bb.lonMin) / step);
      const main = R.rivers.filter(r => !r.branch), near = (p: [number, number], rs: GenRiver[], d: number): boolean => rs.some(r => r.pts.some((q, k) => {
        if (!k) return false;
        const [ax, ay] = r.pts[k - 1], dx = q[0] - ax, dy = q[1] - ay, t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy) < d * step;
      }));
      let dry = 0;
      for (const r of main) { const m = r.ws!.length; if (r.ws![m - 1] === RIV_MOUTH_X * r.ws![m - 2] && !wetCls(R.cls[cellOf(r.pts[m - 1])])) dry++; }
      assert.strictEqual(dry, 0, `${st} 种子 ${s} / ${gn}：${dry} 条入水的河末点不在水上`);
      for (const r of R.rivers.filter(r => r.branch)) {
        branches++;
        const m = r.pts.length, w = r.ws!;
        assert.ok(r.branch === true && w.length === m && w.slice(0, -1).every(v => v === r.widthM) && w[m - 1] === RIV_MOUTH_X * r.widthM, JSON.stringify(r));
        assert.deepStrictEqual(r.mz, r.pts.map((_, t) => t === 0 || t === m - 1 ? 0 : MZ_MAX));
        assert.ok(near(r.pts[0], main, 1) || near(r.pts[0], R.rivers.filter(q => q.branch && q !== r), 0.5), `${st} 种子 ${s} / ${gn}：分汊线首点 ${r.pts[0]} 不在主河上、也不在别的分汊线上`);
        assert.ok(wetCls(R.cls[cellOf(r.pts[m - 1])]) && r.pts.slice(1, -1).every(p => !wetCls(R.cls[cellOf(p)])), `${st} 种子 ${s} / ${gn}：分汊线 ${JSON.stringify(r.pts)}`);
      }
    }
    assert.ok(branches >= 10, `分汊线只有 ${branches} 条`);
  });
});

