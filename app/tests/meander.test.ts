/* 曲流（render/meander）：带 mz 的河在 riverGeom 里合成弯道，叠加层按缩放渐入，拾取与两个地形渲染器读同一条曲线 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MEANDER_FADE_WPX, MEANDER_K_MAX, MEANDER_K_MIN, meanderFade, meanderLamM } from "../src/render/meander.ts";
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
/** 河的屏幕真宽恰为 wPx 的缩放（flat 100 km/度） */
const dppFor = (wPx: number, wM = 400): number => wM / 1000 / wPx / 100;

describe("曲流：几何", () => {
  it("首尾与汇合点不动：曲线首尾就是原折线首尾，汇合处（孤立的 0）过底线、前后约一个波长内收平；别处真的弯", () => {
    const e = straight([0, 9, 9, 9, 0, 9, 9, 9, 0]), G = riverGeom(flat, e);
    assert.ok(G.m, "带 mz 的河有曲流");
    assert.deepStrictEqual(G.pts[0], e.pts![0]); assert.deepStrictEqual(G.pts[G.pts.length - 1], e.pts![8]);
    const lam = meanderLamM(400) / 1000 / 100;   // 一个谷向波长（度）
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
      assert.ok(big > w / 1000, `宽 ${w} 种子 ${s}：真的弯了（最大横移 ${big.toFixed(3)} km，不到一个河宽）`);
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
  it("生成的河不合成曲流：带 gen 的只画底线，同一条河归了用户才弯", () => {
    const e = straight([0, 9, 9, 9, 9, 0]), G = riverGeom(flat, e), g = riverGeom(flat, { ...e, gen: true });
    assert.ok(G.m, "归用户的河有曲流");
    assert.strictEqual(g.m, null);
    assert.deepStrictEqual(g.pts, G.m!.base, "画的就是底线");
    assert.deepStrictEqual(riverShape(flat, camAt(dppFor(6)), { ...e, gen: true }).pts, G.m!.base, "叠加层在满幅的缩放下也是底线");
  });
});

describe("曲流：叠加层渐入、水面与拾取", () => {
  it("渐入门：河的屏幕真宽不到下限＝底线原样（细线不弯）、到上限＝满幅曲线（与地形渲染器读的同一份）、中间按 smoothstep", () => {
    const e = straight([0, 9, 9, 9, 9, 0]), G = riverGeom(flat, e), M = G.m!.M, [a, b] = MEANDER_FADE_WPX;
    assert.deepStrictEqual(riverShape(flat, camAt(dppFor(a * 0.9)), e).pts, G.m!.base, "不到下限：底线");
    assert.deepStrictEqual(riverShape(flat, camAt(dppFor(b)), e).pts, G.pts, "到上限：满幅");
    const mid = riverShape(flat, camAt(dppFor((a + b) / 2)), e), f = meanderFade((a + b) / 2);
    assert.ok(Math.abs(f - 0.5) < 1e-12 && mid.pts.length === M.pts.length);
    assert.ok(mid.pts.every((p, i) => Math.abs(p[1] - f * M.pts[i][1]) < 1e-12 && Math.abs(p[0] - (M.bx[i] + f * (M.pts[i][0] - M.bx[i]))) < 1e-12), "半幅");
  });
  it("画成水面的段恒是满幅：满幅门 ≤ 水面门槛（都按屏幕真宽）；真宽恰到门槛的那一缩放，叠加层折线逐点就是满幅曲线", () => {
    assert.ok(MEANDER_FADE_WPX[1] <= RIVER_WATER_PX && MEANDER_FADE_WPX[0] > 0);
    assert.strictEqual(meanderFade(RIVER_WATER_PX), 1);
    const e = straight([0, 9, 9, 9, 0]), G = riverGeom(flat, e), dpp = 0.4 / 100 / RIVER_WATER_PX;   // 400 m 真宽恰 3 px
    const sh = riverShape(flat, camAt(dpp), e), thr = riverThr(dpp);
    assert.ok(sh.g.some((g, k) => k && Math.min(g, sh.g[k - 1]) >= thr * (1 - 1e-9)), "前提：有段过门槛");
    assert.deepStrictEqual(sh.pts, G.pts);
  });
  it("离屏幕远的那几段换回底线点（只省点数，屏内与满幅逐点同）", () => {
    const e = straight([0, 9, 9, 9, 9, 9, 9, 9, 0]), G = riverGeom(flat, e), cam = camAt(dppFor(4), 0.3, 800);
    const sh = riverShape(flat, cam, e), M = G.m!.M;
    assert.ok(sh.pts.length < M.pts.length / 2, `点数 ${sh.pts.length} / ${M.pts.length}`);
    const inView = M.pts.filter(p => Math.abs((p[0] - 0.3) / cam.degPerPx) < 400);
    assert.ok(inView.length > 20 && inView.every(p => sh.pts.some(q => q[0] === p[0] && q[1] === p[1])), "屏内的点都是满幅曲线上的点");
  });
  it("拾取走廊跟着曲线：点在弯顶选得中，点在弯顶下的底线位置选不中", () => {
    const e = straight([0, 9, 9, 9, 9, 0]), w = mk([e]), dpp = dppFor(6), cam = camAt(dpp, 1, 1200), G = riverGeom(flat, e);
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

describe("曲流：波长随河宽、形态落在真河的范围", () => {
  it("谷向波长＝倍数 × 河宽：窄河 21、宽河 9、其间随 ln 河宽平滑过渡，波长随河宽单调不减", () => {
    assert.strictEqual(meanderLamM(60) / 60, MEANDER_K_MAX); assert.strictEqual(meanderLamM(90) / 90, MEANDER_K_MAX);
    assert.strictEqual(meanderLamM(500) / 500, MEANDER_K_MIN); assert.strictEqual(meanderLamM(3000) / 3000, MEANDER_K_MIN);
    const k150 = meanderLamM(150) / 150, k250 = meanderLamM(250) / 250;
    assert.ok(k150 > 17 && k150 < 19.5 && k250 > 12 && k250 < 14.5, `150 m ${k150.toFixed(1)} 250 m ${k250.toFixed(1)}`);
    let prev = 0;
    for (let w = 1; w < 20000; w *= 1.01) { const l = meanderLamM(w); assert.ok(l >= prev && l / w <= MEANDER_K_MAX + 1e-9 && l / w >= MEANDER_K_MIN - 1e-9, `宽 ${w}`); prev = l; }
  });
  it("满档直河：10 个波长一窗的弯曲度中位 1.08–1.30、九成在 1.6 以下、一成以上的窗是直的，最弯的弯在 1.5–2.4，一成的弯是直的，半弯有长有短", () => {
    for (const w of [80, 400]) {
      const lam = meanderLamM(w) / 1000 / 100, n = 600;   // 一个谷向波长（度）；300 个波长的直河
      const pts = Array.from({ length: n + 1 }, (_, k) => [k * 300 * lam / n, 0] as [number, number]);
      const P = riverGeom(flat, { type: "river", pts, widthM: w, ws: pts.map(() => w), mz: pts.map((_, k) => k === 0 || k === n ? 0 : 9) }).pts;
      const X = P.map(p => p[0]), Y = P.map(p => p[1]), arc = [0];
      for (let i = 1; i < X.length; i++) arc[i] = arc[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]);
      const arcAt = (x: number): number => { let lo = 0, hi = X.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (X[m] < x) lo = m + 1; else hi = m; } return arc[lo]; };
      const win: number[] = [];
      for (let a = 3 * lam; a + 10 * lam <= 297 * lam; a += 5 * lam) win.push((arcAt(a + 10 * lam) - arcAt(a)) / (10 * lam));
      win.sort((a, b) => a - b);
      const med = win[win.length >> 1], p90 = win[Math.floor(win.length * 0.9)];
      assert.ok(med > 1.08 && med < 1.30 && p90 < 1.6, `宽 ${w}：窗弯曲度中位 ${med.toFixed(2)} p90 ${p90.toFixed(2)}`);
      const straightShare = win.filter(v => v < 1.05).length / win.length;
      assert.ok(straightShare >= 0.1, `宽 ${w}：直的窗只占 ${(100 * straightShare).toFixed(0)}%`);
      const cross: number[] = [];   // 过零点切半弯
      for (let i = 1; i < X.length; i++) if (X[i] > 3 * lam && X[i] < 297 * lam && (Y[i] >= 0) !== (Y[i - 1] >= 0)) cross.push(i);
      const bend: number[] = [], hl: number[] = [];
      for (let c = 0; c + 2 < cross.length; c += 2) { const a = cross[c], b = cross[c + 2]; bend.push((arc[b] - arc[a]) / (X[b] - X[a])); }
      for (let c = 0; c + 1 < cross.length; c++) hl.push((X[cross[c + 1]] - X[cross[c]]) / lam);
      bend.sort((a, b) => a - b); hl.sort((a, b) => a - b);
      const top = bend[bend.length - 1];
      assert.ok(top > 1.5 && top < 2.4, `宽 ${w}：最弯的弯 ${top.toFixed(2)}`);
      assert.ok(bend[Math.floor(bend.length * 0.1)] < 1.03, `宽 ${w}：一成的弯是直的（p10 ${bend[Math.floor(bend.length * 0.1)].toFixed(3)}）`);
      assert.ok(hl[Math.floor(hl.length * 0.9)] > 1.4 * hl[Math.floor(hl.length * 0.1)], `宽 ${w}：半弯长 p10 ${hl[Math.floor(hl.length * 0.1)].toFixed(2)} p90 ${hl[Math.floor(hl.length * 0.9)].toFixed(2)}`);
    }
  });
});
