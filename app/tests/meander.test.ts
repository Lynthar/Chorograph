/* 曲流（render/meander）：带 mz 的河在 riverGeom 里合成弯道，叠加层按缩放渐入，拾取与两个地形渲染器读同一条曲线 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MEANDER_FADE_PX, MEANDER_K, meanderFade } from "../src/render/meander.ts";
import { RIVER_WATER_PX, riverDirty, riverGeom, riverSet, riverThr } from "../src/render/rivers.ts";
import { riverShape } from "../src/render/edges.ts";
import { pickEdge } from "../src/render/pick.ts";
import { FP_CORE, FP_KW, RIV_WIDTH } from "../src/core/constants.ts";
import { kmPerDeg, lonCos } from "../src/core/geo.ts";
import type { Camera } from "../src/core/projection.ts";
import type { Edge, Meta, World } from "../src/core/types.ts";

const flat: Meta = { worldModel: "flat", kmPerDeg: 100 };
const mk = (edges: Edge[], m: Meta = flat): World => ({ meta: m, factions: [], decor: [], terrainOverrides: [], units: [], nodes: [], edges });
/** 0°–2° 的直河（200 km），逐点强度 mz、宽 w 米 */
const straight = (mz: number[], w = 400, y = 0): Edge => ({ type: "river", pts: mz.map((_, k) => [k * 2 / (mz.length - 1), y] as [number, number]), widthM: w, ws: mz.map(() => w), mz });
const camAt = (degPerPx: number, lon = 1, w = 4000): Camera => ({ lon0: lon, lat0: 0, degPerPx, w, h: 600, flat: true });
/** 弯的屏幕谷向波长恰为 lamPx 的缩放（flat 100 km/度） */
const dppFor = (lamPx: number, wM = 400): number => MEANDER_K * wM / 1000 / lamPx / 100;

describe("曲流：几何", () => {
  it("首尾与汇合点不动：曲线首尾就是原折线首尾，汇合处（孤立的 0）过底线、前后约一个波长内收平；别处真的弯", () => {
    const e = straight([0, 9, 9, 9, 0, 9, 9, 9, 0]), G = riverGeom(flat, e);
    assert.ok(G.m, "带 mz 的河有曲流");
    assert.deepStrictEqual(G.pts[0], e.pts![0]); assert.deepStrictEqual(G.pts[G.pts.length - 1], e.pts![8]);
    const lam = MEANDER_K * 0.4 / 100;   // 一个谷向波长（度）
    let dJ = Infinity, nearMax = 0, farMax = 0;
    for (let k = 0; k < G.pts.length; k++) {
      const [x, y] = G.pts[k];
      if (k) { const [x0, y0] = G.pts[k - 1], ex = x - x0, ey = y - y0, h = Math.max(0, Math.min(1, ((1 - x0) * ex - y0 * ey) / (ex * ex + ey * ey))); dJ = Math.min(dJ, Math.hypot(x0 + ex * h - 1, y0 + ey * h)); }
      if (Math.abs(x - 1) < lam / 4) nearMax = Math.max(nearMax, Math.abs(y)); else if (Math.abs(x - 1) > 2 * lam && x > 2 * lam && x < 2 - 2 * lam) farMax = Math.max(farMax, Math.abs(y));
    }
    assert.ok(dJ * 100 < 0.02 * 0.4, `汇合点离曲线 ${(dJ * 1e5).toFixed(1)} m`);
    assert.ok(farMax * 100 > 0.5 && nearMax < 0.2 * farMax, `汇合点四分之一波长内最大横移 ${(nearMax * 100).toFixed(3)} km、别处 ${(farMax * 100).toFixed(3)} km`);
    /* 收平只在汇合点前后约一个波长：再往上游与没有汇合点的同一条河逐点同（不是把相邻两段的幅度都拉低） */
    const P9 = riverGeom(flat, straight([0, 9, 9, 9, 9, 9, 9, 9, 0])).pts, up = G.pts.filter(p => p[0] < 1 - 2.5 * lam);
    assert.ok(up.length > 100 && up.every((p, k) => p[0] === P9[k][0] && p[1] === P9[k][1]), "汇合点 2.5 个波长以上的上游不受影响");
  });
  it("横移封在冲积平原平底内（FP_CORE·FP_KW·√水量，水量按河宽反推）：球面高纬、弯底线、几种宽与种子", () => {
    const sph: Meta = { worldModel: "sphere", planetRadiusKm: 6371 }, kpd = kmPerDeg(sph);
    for (const w of [60, 400, 2000]) for (const s of [0, 1, 2]) {
      const pts: [number, number][] = [];
      for (let k = 0; k <= 12; k++) pts.push([100 + s * 0.37 + k * 0.4, 55 + 0.6 * Math.sin(k * 0.9 + s)]);
      const G = riverGeom(sph, { type: "river", pts, widthM: w, ws: pts.map((_, k) => w * (0.5 + k / 24)), mz: pts.map((_, k) => k % 5 === 3 ? 4 : 9) }), M = G.m!.M;
      let worst = 0, big = 0;
      for (let i = 0; i < M.pts.length; i++) {
        const d = Math.hypot((M.pts[i][0] - M.bx[i]) * kpd * lonCos(sph, M.by[i]), (M.pts[i][1] - M.by[i]) * kpd), cap = FP_CORE * FP_KW * M.w[i] / RIV_WIDTH;
        worst = Math.max(worst, d / cap); big = Math.max(big, d);
      }
      assert.ok(worst <= 1 + 1e-9, `宽 ${w} 种子 ${s}：横移最多到平底半宽的 ${worst.toFixed(3)}`);
      assert.ok(big > 2 * w / 1000, `宽 ${w} 种子 ${s}：真的弯了（最大横移 ${big.toFixed(3)} km）`);
    }
  });
  it("同一条河逐位同一份（种子取首点）；按边记忆，改了 widthM / mz / 点就重算，mz 与点数不符不弯", () => {
    const e = straight([0, 9, 9, 0]), G = riverGeom(flat, e);
    assert.strictEqual(riverGeom(flat, e), G, "记忆");
    assert.deepStrictEqual(riverGeom(flat, { ...e }).pts, G.pts, "同内容的另一个对象逐位同");
    e.widthM = 500;
    assert.notStrictEqual(riverGeom(flat, e), G, "就地改 widthM（表单）要重算");
    assert.notDeepStrictEqual(riverGeom(flat, { ...e, pts: e.pts!.map(([x, y]) => [x, y + 0.5] as [number, number]) }).pts.map(p => p[1] - 0.5), G.pts.map(p => p[1]), "首点变了换种子");
    assert.strictEqual(riverGeom(flat, { ...e, mz: [0, 9, 9] }).m, null);
    assert.strictEqual(riverGeom(flat, { ...e, mz: [0, 0, 0, 0] }).m, null, "全 0 不弯");
    assert.strictEqual(riverGeom(flat, { ...e, mz: undefined }).m, null);
  });
});

describe("曲流：叠加层渐入、水面与拾取", () => {
  it("渐入门：弯的屏幕波长不到下限＝底线原样、到上限＝满幅曲线（与地形渲染器读的同一份）、中间按 smoothstep", () => {
    const e = straight([0, 9, 9, 9, 9, 0]), G = riverGeom(flat, e), M = G.m!.M, [a, b] = MEANDER_FADE_PX;
    assert.deepStrictEqual(riverShape(flat, camAt(dppFor(a * 0.9)), e).pts, G.m!.base, "不到下限：底线");
    assert.deepStrictEqual(riverShape(flat, camAt(dppFor(b)), e).pts, G.pts, "到上限：满幅");
    const mid = riverShape(flat, camAt(dppFor((a + b) / 2)), e), f = meanderFade((a + b) / 2);
    assert.ok(Math.abs(f - 0.5) < 1e-12 && mid.pts.length === M.pts.length);
    assert.ok(mid.pts.every((p, i) => Math.abs(p[1] - f * M.pts[i][1]) < 1e-12 && Math.abs(p[0] - (M.bx[i] + f * (M.pts[i][0] - M.bx[i]))) < 1e-12), "半幅");
  });
  it("画成水面的段恒是满幅：满幅门 ≤ MEANDER_K × 水面门槛；真宽恰到门槛的那一缩放，叠加层折线逐点就是满幅曲线", () => {
    assert.ok(MEANDER_K * RIVER_WATER_PX >= MEANDER_FADE_PX[1]);
    assert.strictEqual(meanderFade(MEANDER_K * RIVER_WATER_PX), 1);
    const e = straight([0, 9, 9, 9, 0]), G = riverGeom(flat, e), dpp = 0.4 / 100 / RIVER_WATER_PX;   // 400 m 真宽恰 3 px
    const sh = riverShape(flat, camAt(dpp), e), thr = riverThr(dpp);
    assert.ok(sh.g.some((g, k) => k && Math.min(g, sh.g[k - 1]) >= thr * (1 - 1e-9)), "前提：有段过门槛");
    assert.deepStrictEqual(sh.pts, G.pts);
  });
  it("离屏幕远的那几段换回底线点（只省点数，屏内与满幅逐点同）", () => {
    const e = straight([0, 9, 9, 9, 9, 9, 9, 9, 0]), G = riverGeom(flat, e), cam = camAt(dppFor(40), 0.3, 800);
    const sh = riverShape(flat, cam, e), M = G.m!.M;
    assert.ok(sh.pts.length < M.pts.length / 2, `点数 ${sh.pts.length} / ${M.pts.length}`);
    const inView = M.pts.filter(p => Math.abs((p[0] - 0.3) / cam.degPerPx) < 400);
    assert.ok(inView.length > 20 && inView.every(p => sh.pts.some(q => q[0] === p[0] && q[1] === p[1])), "屏内的点都是满幅曲线上的点");
  });
  it("拾取走廊跟着曲线：点在弯顶选得中，点在弯顶下的底线位置选不中", () => {
    const e = straight([0, 9, 9, 9, 9, 0]), w = mk([e]), dpp = dppFor(60), cam = camAt(dpp, 1, 1200), G = riverGeom(flat, e);
    const px = (p: [number, number]): [number, number] => [cam.w / 2 + (p[0] - 1) / dpp, cam.h / 2 - p[1] / dpp];
    let k = -1;
    for (let i = 0; i < G.pts.length; i++) if (Math.abs(G.pts[i][0] - 1) < 0.3 && (k < 0 || Math.abs(G.pts[i][1]) > Math.abs(G.pts[k][1]))) k = i;
    const apex = px(G.pts[k]), under = px([G.m!.M.bx[k], G.m!.M.by[k]]);
    const far = Math.min(...G.pts.map(p => Math.hypot(px(p)[0] - under[0], px(p)[1] - under[1])));
    assert.ok(far > 12, `前提：弯顶下的底线位置离曲线 ${far.toFixed(1)} px（走廊半宽 ${(0.4 / 100 / dpp / 2 + 4).toFixed(1)} px）`);
    assert.strictEqual(pickEdge(cam, flat, w, 0, apex[0], apex[1])?.edge, e, "弯顶");
    assert.strictEqual(pickEdge(cam, flat, w, 0, under[0], under[1]), null, "底线上");
  });
});

describe("曲流：河段集按缩放分档", () => {
  const wide = straight([0, 9, 9, 9, 0], 400), mid = straight([0, 9, 9, 9, 0], 150, 0.3), thin = straight([0, 9, 9, 9, 0], 50, 0.6);
  it("一档只收真宽够得上档底的段；档内换缩放是同一份；整条够不上＝null；收进来的是满幅曲线", () => {
    const w = mk([wide, mid, thin]), s = riverSet(flat, w, 0, 0.001)!;   // 门槛 0.003°、档底 2⁻⁹°（195 m）
    assert.strictEqual(s.n, riverGeom(flat, wide).pts.length - 1, "只有 400 m 那条");
    assert.strictEqual(riverSet(flat, w, 0, 0.0011), s, "同一档");
    assert.strictEqual(riverSet(flat, w, 0, 0.004), null, "档底高过最宽的河");
    const G = riverGeom(flat, wide);
    assert.ok([0, 7, s.n - 1].every(i => Math.abs(s.seg[i * 8] + s.ox - G.pts[i][0]) < 1e-12 && Math.abs(s.seg[i * 8 + 1] + s.oy - G.pts[i][1]) < 1e-12));
  });
  it("跨档：riverDirty 只框过门槛的段变了的那条河（同一条河在两档里几何逐位同）", () => {
    const w = mk([wide, mid, thin]), a = riverSet(flat, w, 0, 0.001)!, b = riverSet(flat, w, 0, 0.00049)!;
    assert.ok(a !== b && b.n > a.n, "细一档多收了 150 m 那条");
    const d = riverDirty({ set: a, thr: riverThr(0.001) }, { set: b, thr: riverThr(0.00049) });
    assert.ok(d.length > 0 && d.every(r => r.latMin > 0.2 && r.latMax < 0.4), `只框 150 m 那条：${JSON.stringify(d.slice(0, 2))}`);
    assert.deepStrictEqual(riverDirty({ set: a, thr: riverThr(0.001) }, { set: b, thr: riverThr(0.001) }), [], "门槛相同：两档过门槛的段逐位同");
  });
});
