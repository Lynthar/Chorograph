/* 分块精修的编排（shell/tiles）：先算视口里的块；新一份输入的块全攒着、到齐报一次、commit 才一起上屏；
   编辑后旧块留在屏上叠增量、键没变的块不重算、缓存命中不发单。假 Worker：块的数据整块填块号，手动逐单放行 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { buildGridCells } from "../src/core/grid.ts";
import { erodeCarve, erodeInput, erodeKey, type ErodeInput } from "../src/core/erode.ts";
import { elevBilinear, type ElevField } from "../src/core/elev.ts";
import { TILE_MARGIN, tileCells, tileField, tilePlan, type TileLayer } from "../src/core/tiles.ts";
import { createTileManager, TILE_RETRY_MS, type TileManager } from "../src/shell/tiles.ts";
import type { BBox, HeightOverride, Meta, TerrainOverride } from "../src/core/types.ts";

const META: Meta = { terrain: "plain", relief: 0.7, gridN: 100, bbox: { lonMin: 100, lonMax: 115, latMin: 30, latMax: 40 } };
const probe = buildGridCells(META, [], 0), ST = probe.step, BB = probe.bb;
const OV: TerrainOverride[] = [];
for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) OV.push({ lon: BB.lonMin + (30 + i * 6) * ST, lat: BB.latMin + (20 + j * 6) * ST, t: "mountain", step: ST * 6 });
const GRID = buildGridCells(META, OV, 0);
const input = (hov: HeightOverride[] = []): ErodeInput => erodeInput(META, hov, GRID, 0)!;
const INP = input(), PLAN = tilePlan(INP, 1e12, 0)!, G = PLAN.geom;
/** 一块的父格数（预算按「陆地块的父格数 × 倍率²」给，用来凑出低一档的块倍率） */
const TILE_P_CELLS = G.P * G.P;
const COARSE = new Float32Array(GRID.cols * GRID.rows);
const feed = (m: TileManager, inp: ErodeInput, plan = tilePlan(inp, 1e12, 0)!, base: Float32Array = COARSE): void => m.setInput(inp, plan, base, erodeKey(inp));

/** 块号 → 该块的视口（缩放＝一块格两个 CSS 像素，块权重满） */
const viewOf = (i: number): [BBox, number] => {
  const { c0, r0, c1, r1 } = tileCells(G, i);
  return [{ lonMin: G.lonMin + (c0 + 2) * G.pstep, lonMax: G.lonMin + (c1 - 2) * G.pstep, latMin: G.latMin + (r0 + 2) * G.pstep, latMax: G.latMin + (r1 - 2) * G.pstep }, G.step / 2];
};
/** 窗口单 → 块号（按窗口原点对：块心外扩 TILE_MARGIN、钳到图幅） */
const tileOf = (inp: ErodeInput): number => {
  const a0 = Math.round((inp.bb.lonMin - G.lonMin) / G.pstep), b0 = Math.round((inp.bb.latMin - G.latMin) / G.pstep);
  return PLAN.tiles.find(i => { const { c0, r0 } = tileCells(G, i); return Math.max(0, c0 - TILE_MARGIN) === a0 && Math.max(0, r0 - TILE_MARGIN) === b0; })!;
};
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

/* fail＝接下来几单（切割量或块）以 null 收场（车道崩了的样子）。ready＝每次 onReady 的 [到齐, 真算过]，prog＝每次 onProgress 的 [已是当前那份, 总数] */
function rig(opts: { lanes?: number; cache?: Map<string, Float32Array> } = {}) {
  const calls: number[] = [], waiting: (() => void)[] = [], layers: (TileLayer | null)[] = [], ready: [boolean, boolean][] = [], prog: [number, number][] = [], downs: boolean[] = [];
  const cache = opts.cache ?? new Map<string, Float32Array>();
  const st = { carves: 0, fail: 0 };
  const m = createTileManager({
    client: {
      tileLanes: opts.lanes ?? 1,
      erodeCarve: async (inp: ErodeInput) => { st.carves++; return erodeCarve(inp); },
      erodeTile: (inp: ErodeInput) => new Promise<ElevField | null>(res => {
        const i = tileOf(inp); calls.push(i);
        if (st.fail > 0) { st.fail--; res(null); return; }
        waiting.push(() => { const sx = inp.axisMax; res({ bb: inp.bb, step: inp.step / sx, cols: inp.cols * sx, rows: inp.rows * sx, data: new Float32Array(inp.cols * inp.rows * sx * sx).fill(i), eroded: true }); });   // 块倍率随计划（axisMax＝块倍率）
      })
    },
    cacheGet: async k => cache.get(k) ?? null,
    cachePut: (k, a) => { cache.set(k, a); },
    onLayer: L => { layers.push(L); },
    onProgress: (dn, n) => { prog.push([dn, n]); },
    onReady: (ok, c) => { ready.push([ok, c]); },
    onDown: dn => { downs.push(dn); }
  }, 1e9);
  const release = async (): Promise<void> => { waiting.shift()!(); await flush(); };
  /** 放行到没有在等的单（每放一单可能又排出下一单） */
  const drain = async (): Promise<void> => { while (waiting.length) await release(); };
  return { m, calls, release, drain, layers, ready, prog, downs, cache, st, waiting, last: () => layers[layers.length - 1] };
}
/** 视口罩住右列两块（1、3），缩放到块权重满 */
const rightCol = (): [BBox, number] => {
  const [v1] = viewOf(1), [v3, dpp] = viewOf(3);
  return [{ lonMin: v1.lonMin, lonMax: v1.lonMax, latMin: v1.latMin, latMax: v3.latMax }, dpp];
};
/** 块 1 里落一笔：粗格场与侵蚀输入（块 1、3 换键） */
const stroke = (): { now: Float32Array; inp: ErodeInput } => {
  const now = COARSE.slice(), c = 85, rr = 50;
  now[rr * GRID.cols + c] = 0.3;
  return { now, inp: input([{ lon: G.lonMin + (c + 0.5) * G.pstep, lat: G.latMin + (rr + 0.5) * G.pstep, dh: 0.3 }]) };
};

describe("分块精修的编排（shell/tiles）", () => {
  it("视口里的块先算；全图的块到齐之前一块也不上屏，到齐报一次，commit 才一起上屏", async () => {
    const r = rig({ lanes: 1 });
    r.m.setCoarse(COARSE, GRID, null, null);
    const [v, dpp] = viewOf(1);
    r.m.setView({ ...v, lonMin: v.lonMin - 12 * G.pstep }, dpp);   // 视口在块 1、左缘伸进块 0
    feed(r.m, INP);
    await flush();
    assert.deepStrictEqual(r.calls.slice(0, 1), [1], "离视心最近的视口块先算");
    await r.release();
    assert.strictEqual(r.calls[1], 0, "第二单是另一块视口块");
    await r.release();
    assert.strictEqual(r.layers.length, 0, "视口里的两块都到了也不上屏：等全图");
    assert.deepStrictEqual(r.ready, [], "还没到齐");
    assert.deepStrictEqual(r.prog[r.prog.length - 1], [2, 4], "进度：四块到了两块");
    await r.drain();
    assert.deepStrictEqual(r.ready, [[true, true]], "到齐报一次，且这一份是真算出来的");
    assert.strictEqual(r.layers.length, 0, "到齐了也不自己上屏：等 commit");
    r.m.commit();
    assert.strictEqual(r.layers.length, 1, "commit：一次上屏");
    assert.strictEqual(r.last()!.tiles.size, 4);
    assert.ok([...r.last()!.tiles].every(([i, a]) => a[0] === i), "块号对得上块心");
    r.m.commit();
    assert.strictEqual(r.layers.length, 1, "没有攒着的：再 commit 不重发块层");
  });

  it("整幅视图（块格不到一像素）：照样算、照样报到齐", async () => {
    const r = rig();
    r.m.setCoarse(COARSE, GRID, null, null);
    r.m.setView({ lonMin: BB.lonMin, lonMax: BB.lonMax, latMin: BB.latMin, latMax: BB.latMax }, G.step * 4);
    feed(r.m, INP);
    await flush();
    await r.drain();
    assert.deepStrictEqual(r.ready, [[true, true]]);
    r.m.commit();
    assert.strictEqual(r.last()!.tiles.size, 4);
  });

  it("编辑：旧块留在屏上叠粗格增量；键没变的块不重算；换了键的块到齐之前不换，commit 同一帧换上", async () => {
    const r = rig({ lanes: 2 });
    r.m.setCoarse(COARSE, GRID, null, null);
    feed(r.m, INP);
    await flush();
    await r.drain();
    r.m.commit();
    const before = r.last()!;
    /* 块 1 里落一笔：粗格场先变（等待窗合成），侵蚀输入随后换 */
    const now = COARSE.slice(), c = 85, rr = 50;
    now[rr * GRID.cols + c] = 0.3;
    r.m.setCoarse(now, GRID, null, null);
    const mid = r.last()!;
    assert.notStrictEqual(mid.tiles.get(1), before.tiles.get(1), "笔下的块即时叠上增量");
    assert.strictEqual(mid.tiles.get(0), before.tiles.get(0), "碰不到增量的块原样不动");
    const lon = G.lonMin + (c + 0.5) * G.pstep, lat = G.latMin + (rr + 0.5) * G.pstep;
    const f1 = tileField(G, 1, mid.tiles.get(1)!);
    const got = elevBilinear(f1.data, f1, lon, lat), raw = elevBilinear(before.tiles.get(1)!, f1, lon, lat);
    assert.ok(got > raw + 0.25, `增量落在笔下：${raw} → ${got}`);   // 细格心离粗格心半个细格，双线性峰值约 0.3×(15/16)²
    const n0 = r.calls.length;
    feed(r.m, input([{ lon, lat, dh: 0.3 }]), undefined, now);
    await flush();
    assert.deepStrictEqual(r.calls.slice(n0).sort(), [1, 3], "只有窗口碰到这一笔的块重算");
    assert.deepStrictEqual(r.prog[r.prog.length - 1], [2, 4], "键没变的两块算已到");
    await r.release();
    assert.strictEqual(r.last(), mid, "先到的一块不单独换上（不出现新旧拼贴）");
    assert.strictEqual(r.ready.length, 1, "还差一块：不报到齐");
    await r.release();
    assert.deepStrictEqual(r.ready[1], [true, true]);
    assert.strictEqual(r.last(), mid, "到齐了也等 commit");
    r.m.commit();
    const after = r.last()!;
    assert.ok(after.tiles.get(1)![0] === 1 && after.tiles.get(3)![0] === 3, "两块同一帧换上（基准＝新粗格，增量归零）");
    assert.notStrictEqual(after.tiles.get(1), mid.tiles.get(1));
    assert.strictEqual(after.tiles.get(0), mid.tiles.get(0), "没换键的块还是那一份");
  });

  it("切割量按输入键留在内存：撤销回到算过的输入不再要 Worker，setInput 里同步报到齐，commit 换回原来那一块", async () => {
    const r = rig({ lanes: 2 });
    r.m.setCoarse(COARSE, GRID, null, null);
    feed(r.m, INP);
    await flush();
    await r.drain();
    r.m.commit();
    const first = r.last()!;
    const { now, inp } = stroke();
    r.m.setCoarse(now, GRID, null, null);
    feed(r.m, inp, undefined, now);
    await flush();
    await r.drain();
    r.m.commit();
    assert.strictEqual(r.st.carves, 2);
    const n0 = r.calls.length, k0 = r.ready.length;
    r.m.setCoarse(COARSE, GRID, null, null);
    feed(r.m, INP);
    assert.strictEqual(r.st.carves, 2, "同一输入：切割量取内存");
    assert.deepStrictEqual(r.ready.slice(k0), [[true, false]], "块全在内存：不等下一拍就报到齐，且不算真算过");
    r.m.commit();
    assert.strictEqual(r.last()!.tiles.get(1), first.tiles.get(1), "换回原来那一块");
    await flush();
    assert.strictEqual(r.calls.length, n0, "块也不重算");
  });

  it("上一份输入的块还没换上就换了输入（等的时候撤销）：攒着的那几块作废，commit 放上屏的是当前输入的", async () => {
    const r = rig({ lanes: 1 });
    r.m.setCoarse(COARSE, GRID, null, null);
    feed(r.m, INP);
    await flush();
    await r.drain();
    r.m.commit();
    const first = r.last()!;
    const { now, inp } = stroke();
    r.m.setCoarse(now, GRID, null, null);
    feed(r.m, inp, undefined, now);
    await flush();
    await r.release();   // 换了键的两块里先到一块：攒着
    const k0 = r.ready.length;
    r.m.setCoarse(COARSE, GRID, null, null);
    feed(r.m, INP);      // 撤销：回到屏上那一份
    assert.deepStrictEqual(r.ready.slice(k0), [[true, false]], "屏上的块就是这一份：立即到齐");
    r.m.commit();
    assert.strictEqual(r.last()!.tiles.get(1), first.tiles.get(1), "攒着的那块没被放上屏");
    await r.drain();
    r.m.commit();
    assert.strictEqual(r.last()!.tiles.get(1), first.tiles.get(1), "迟到的旧单只进内存与缓存");
  });

  it("车道失败：等一会儿复位一次接着算；复位后又失败就停摆——报到头（没到齐）、放大看着时报不可用", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const r = rig({ lanes: 1 });
      r.m.setCoarse(COARSE, GRID, null, null);
      const [v, dpp] = viewOf(1);
      r.m.setView(v, dpp);
      r.st.fail = 1;
      feed(r.m, INP);
      await flush();
      assert.deepStrictEqual(r.calls, [1], "首单失败");
      assert.equal(warn.mock.callCount(), 1, "失败要响一声");
      assert.match(warn.mock.calls[0].arguments.join(""), /分块精修失败.*车道没有结果/);
      assert.deepStrictEqual(r.ready, [], "等复位期间不报到头（还会再算）");
      mock.timers.tick(TILE_RETRY_MS);
      await flush();
      assert.deepStrictEqual(r.calls, [1, 1], "复位后先补算失败的那块");
      await r.drain();
      assert.deepStrictEqual(r.ready, [[true, true]], "复位后整批算完");
      r.m.commit();
      assert.strictEqual(r.last()!.tiles.size, 4);
      const { now, inp } = stroke();
      r.m.setCoarse(now, GRID, null, null);
      const mid = r.last()!;
      r.st.fail = 1;
      feed(r.m, inp, undefined, now);
      await flush();
      assert.deepStrictEqual(r.downs, [true], "复位用过了又失败＝停摆，视口里的块不是当前那份＝报不可用");
      assert.equal(warn.mock.callCount(), 2, "停摆那次失败也响");
      assert.deepStrictEqual(r.ready[1], [false, false], "不会再有了：报到头，host 照现有的换上");
      r.m.commit();
      assert.strictEqual(r.last(), mid, "没有新块可换：屏上还是旧块叠增量");
      mock.timers.tick(TILE_RETRY_MS * 4);
      await flush();
      assert.strictEqual(r.waiting.length, 0, "不再发单");
      r.m.setView(viewOf(0)[0], G.step * 4);
      assert.deepStrictEqual(r.downs, [true, false], "缩到用不上块：不报");
    } finally { mock.timers.reset(); }
  });

  it("块几何换了（倍率随陆地格数变）：旧块层原样留在屏上，新几何的块到齐、commit 才一起换", async () => {
    const r = rig({ lanes: 2 });
    r.m.setCoarse(COARSE, GRID, null, null);
    feed(r.m, INP);
    await flush();
    await r.drain();
    r.m.commit();
    const old = r.last()!, n0 = r.layers.length;
    const small = tilePlan(INP, PLAN.tiles.length * TILE_P_CELLS * 4, 0)!;
    assert.notStrictEqual(small.geom.sx, PLAN.geom.sx, "前置：预算小一档，块倍率不同");
    feed(r.m, INP, small);
    await flush();
    assert.strictEqual(r.layers.length, n0, "换几何不当场下屏");
    r.m.setCoarse(COARSE.slice(), GRID, null, null);
    assert.strictEqual(r.layers.length, n0, "旧块层冻着：不按新几何叠增量");
    await r.drain();
    assert.strictEqual(r.layers.length, n0, "到齐了也等 commit");
    r.m.commit();
    assert.ok(r.last() !== old && r.last()!.geom.sx === small.geom.sx, "commit：新几何的块一起换上");
  });

  it("上一份的块攒着没换上就来了新一份，新一份又停摆：只放上屏仍是当前那份的块", async (t) => {
    t.mock.method(console, "warn", () => {});
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const r = rig({ lanes: 1 });
      r.m.setCoarse(COARSE, GRID, null, null);
      feed(r.m, INP);
      await flush();
      await r.drain();   // 第一份全到，但没 commit（host 那一轮被新的重建作废了）
      const { now, inp } = stroke();
      r.m.setCoarse(now, GRID, null, null);
      r.st.fail = 2;
      feed(r.m, inp, undefined, now);
      await flush();
      mock.timers.tick(TILE_RETRY_MS);
      await flush();
      assert.deepStrictEqual(r.ready[r.ready.length - 1], [false, false], "复位后又失败：报到头");
      r.m.commit();
      assert.deepStrictEqual([...r.last()!.tiles.keys()].sort(), [0, 2], "键没变的两块上屏；换了键的 1、3 是上一份的，不放");
    } finally { mock.timers.reset(); }
  });

  it("缓存命中不发单（到齐但不算真算过）；换几何（reset）块层下屏", async () => {
    const warm = rig();
    warm.m.setCoarse(COARSE, GRID, null, null);
    feed(warm.m, INP);
    await flush();
    await warm.drain();
    const r = rig({ cache: warm.cache });
    r.m.setCoarse(COARSE, GRID, null, null);
    feed(r.m, INP);
    await flush();
    assert.strictEqual(r.calls.length, 0);
    assert.deepStrictEqual(r.ready, [[true, false]]);
    r.m.commit();
    assert.strictEqual(r.last()!.tiles.size, 4);
    r.m.reset();
    assert.strictEqual(r.last(), null);
  });

  it("中尺度单（带起伏包络）不要切割量：不发 erodeCarve，块照常排队算、到齐", async () => {
    const r = rig(), mi = { ...INP, mesoEnv: new Float32Array(INP.cols * INP.rows) };
    r.m.setCoarse(COARSE, GRID, null, null);
    feed(r.m, mi);
    await flush();
    assert.strictEqual(r.st.carves, 0, "中尺度图不跑粗级，不该要切割量");
    await r.drain();
    assert.strictEqual(r.calls.length, 4);
    r.m.commit();
    assert.strictEqual(r.last()!.tiles.size, 4);
  });
});
