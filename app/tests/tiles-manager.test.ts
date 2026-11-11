/* 分块精修的编排（shell/tiles）：先算视口里的块、视口里的块齐了才一起上屏、忙闲只在用得上块时报、
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

/* fail＝接下来几单（切割量或块）以 null 收场（车道崩了的样子） */
function rig(opts: { lanes?: number; cache?: Map<string, Float32Array> } = {}) {
  const calls: number[] = [], waiting: (() => void)[] = [], layers: (TileLayer | null)[] = [], busy: [boolean, boolean][] = [], downs: boolean[] = [];
  const cache = opts.cache ?? new Map<string, Float32Array>();
  const st = { carves: 0, fail: 0 };
  const m = createTileManager({
    client: {
      tileLanes: opts.lanes ?? 1,
      erodeCarve: async (inp: ErodeInput) => { st.carves++; return erodeCarve(inp); },
      erodeTile: (inp: ErodeInput) => new Promise<ElevField | null>(res => {
        const i = tileOf(inp); calls.push(i);
        if (st.fail > 0) { st.fail--; res(null); return; }
        waiting.push(() => res({ bb: inp.bb, step: inp.step / G.sx, cols: inp.cols * G.sx, rows: inp.rows * G.sx, data: new Float32Array(inp.cols * inp.rows * G.sx * G.sx).fill(i), eroded: true }));
      })
    },
    cacheGet: async k => cache.get(k) ?? null,
    cachePut: (k, a) => { cache.set(k, a); },
    onLayer: L => { layers.push(L); },
    onBusy: (b, c) => { busy.push([b, c]); },
    onDown: dn => { downs.push(dn); }
  }, 1e9);
  const release = async (): Promise<void> => { waiting.shift()!(); await flush(); };
  return { m, calls, release, layers, busy, downs, cache, st, waiting, last: () => layers[layers.length - 1] };
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
  it("视口里的块先算；视口里的块齐了才一起上屏，视口外的随到随上；忙闲只在用得上块时报", async () => {
    const r = rig({ lanes: 1 });
    r.m.setCoarse(COARSE, GRID);
    const [v, dpp] = viewOf(1);
    r.m.setView({ ...v, lonMin: v.lonMin - 12 * G.pstep }, dpp);   // 视口在块 1、左缘伸进块 0
    feed(r.m, INP);
    await flush();
    assert.deepStrictEqual(r.calls.slice(0, 1), [1], "离视心最近的视口块先算");
    assert.deepStrictEqual(r.busy, [[true, false]]);
    await r.release();
    assert.strictEqual(r.layers.length, 0, "视口里还缺块 0：块 1 先攒着不上屏");
    assert.strictEqual(r.calls[1], 0, "第二单是另一块视口块");
    await r.release();
    assert.deepStrictEqual([...r.last()!.tiles.keys()].sort(), [0, 1], "视口两块一起上屏");
    assert.deepStrictEqual(r.busy[r.busy.length - 1], [false, true], "视口齐了＝不忙，且这一轮真算过");
    await r.release();
    assert.ok(r.last()!.tiles.has(r.calls[2]), "视口外的块到了就上");
    await r.release();
    assert.strictEqual(r.last()!.tiles.size, 4);
    assert.ok([...r.last()!.tiles].every(([i, a]) => a[0] === i), "块号对得上块心");
  });

  it("整幅视图（块格不到一像素）：照样在后台算，但不报忙", async () => {
    const r = rig();
    r.m.setCoarse(COARSE, GRID);
    r.m.setView({ lonMin: BB.lonMin, lonMax: BB.lonMax, latMin: BB.latMin, latMax: BB.latMax }, G.step * 4);
    feed(r.m, INP);
    await flush();
    for (let k = 0; k < 4; k++) await r.release();
    assert.strictEqual(r.last()!.tiles.size, 4);
    assert.deepStrictEqual(r.busy, []);
  });

  it("编辑：旧块留在屏上叠粗格增量；键没变的块不重算，变了的算完就换", async () => {
    const r = rig({ lanes: 2 });
    r.m.setCoarse(COARSE, GRID);
    feed(r.m, INP);
    await flush();
    while (r.calls.length < 4) await r.release();
    await r.release(); await r.release();
    const before = r.last()!;
    /* 块 1 里落一笔：粗格场先变（等待窗合成），侵蚀输入随后换 */
    const now = COARSE.slice(), c = 85, rr = 50;
    now[rr * GRID.cols + c] = 0.3;
    r.m.setCoarse(now, GRID);
    const mid = r.last()!;
    assert.notStrictEqual(mid.tiles.get(1), before.tiles.get(1), "笔下的块即时叠上增量");
    assert.strictEqual(mid.tiles.get(0), before.tiles.get(0), "碰不到增量的块原样不动");
    const lon = G.lonMin + (c + 0.5) * G.pstep, lat = G.latMin + (rr + 0.5) * G.pstep;
    const f1 = tileField(G, 1, mid.tiles.get(1)!);
    const got = elevBilinear(f1.data, f1, lon, lat), raw = elevBilinear(before.tiles.get(1)!, f1, lon, lat);
    assert.ok(got > raw + 0.25, `增量落在笔下：${raw} → ${got}`);   // 细格心离粗格心半个细格，双线性峰值约 0.3×(15/16)²
    const n0 = r.calls.length;
    const inp2 = input([{ lon, lat, dh: 0.3 }]);
    feed(r.m, inp2, undefined, now);
    await flush();
    assert.strictEqual(r.last()!.tiles.size, 4, "新键的块算出来之前旧块照旧在屏");
    const redo = r.calls.slice(n0).sort();
    assert.deepStrictEqual(redo, [1, 3], "只有窗口碰到这一笔的块重算");
    await r.release(); await r.release();
    assert.ok(r.last()!.tiles.get(1)![0] === 1 && r.last()!.tiles.get(1) !== mid.tiles.get(1), "新块换上（基准＝新粗格，增量归零）");
  });

  it("放大编辑：视口里换了键的块等视口齐了同一帧换上；忙闲罩住切割量与换键块，块齐了才报完成", async () => {
    const r = rig({ lanes: 2 });
    r.m.setCoarse(COARSE, GRID);
    const [v, dpp] = rightCol();
    r.m.setView(v, dpp);
    feed(r.m, INP);
    await flush();
    while (r.waiting.length) await r.release();
    const before = r.last()!;
    assert.deepStrictEqual(r.busy[r.busy.length - 1], [false, true], "前置：开图那轮算完");
    const { now, inp } = stroke();
    r.m.setCoarse(now, GRID);
    const mid = r.last()!;
    feed(r.m, inp, undefined, now);
    assert.deepStrictEqual(r.busy[r.busy.length - 1], [true, false], "切割量还没到：视口里的块是不是当前那份还不知道＝忙");
    await flush();
    assert.deepStrictEqual([...r.calls.slice(4)].sort(), [1, 3], "视口里换了键的两块重算");
    await r.release();
    assert.strictEqual(r.last(), mid, "先到的一块不单独换上（不出现新旧拼贴）");
    assert.strictEqual(r.busy[r.busy.length - 1][0], true, "视口里还有块没换：仍忙");
    await r.release();
    const after = r.last()!;
    assert.ok(after.tiles.get(1)![0] === 1 && after.tiles.get(3)![0] === 3, "两块同一帧换上");
    assert.notStrictEqual(after.tiles.get(1), before.tiles.get(1));
    assert.deepStrictEqual(r.busy[r.busy.length - 1], [false, true], "块齐了才报不忙，且这一轮真算过");
  });

  it("切割量按输入键留在内存：撤销回到算过的输入不再要 Worker，块从内存同步换回", async () => {
    const r = rig({ lanes: 2 });
    r.m.setCoarse(COARSE, GRID);
    feed(r.m, INP);
    await flush();
    while (r.waiting.length) await r.release();
    const first = r.last()!;
    const { now, inp } = stroke();
    r.m.setCoarse(now, GRID);
    feed(r.m, inp, undefined, now);
    await flush();
    while (r.waiting.length) await r.release();
    assert.strictEqual(r.st.carves, 2);
    const n0 = r.calls.length;
    r.m.setCoarse(COARSE, GRID);
    feed(r.m, INP);
    assert.strictEqual(r.st.carves, 2, "同一输入：切割量取内存");
    assert.strictEqual(r.last()!.tiles.get(1), first.tiles.get(1), "同步换回原来那一块（不等下一拍）");
    await flush();
    assert.strictEqual(r.calls.length, n0, "块也不重算");
  });

  it("车道失败：等一会儿复位一次接着算；复位后又失败就停摆，放大看着时报不可用", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const r = rig({ lanes: 1 });
      r.m.setCoarse(COARSE, GRID);
      const [v, dpp] = viewOf(1);
      r.m.setView(v, dpp);
      r.st.fail = 1;
      feed(r.m, INP);
      await flush();
      assert.deepStrictEqual(r.calls, [1], "首单失败");
      assert.equal(warn.mock.callCount(), 1, "失败要响一声");
      assert.match(warn.mock.calls[0].arguments.join(""), /分块精修失败.*车道没有结果/);
      assert.strictEqual(r.busy[r.busy.length - 1][0], true, "等复位期间仍算忙（还会再算）");
      mock.timers.tick(TILE_RETRY_MS);
      await flush();
      assert.deepStrictEqual(r.calls, [1, 1], "复位后先补算失败的那块");
      while (r.waiting.length) await r.release();
      assert.strictEqual(r.last()!.tiles.size, 4, "复位后整批算完");
      const { now, inp } = stroke();
      r.m.setCoarse(now, GRID);
      r.st.fail = 1;
      feed(r.m, inp, undefined, now);
      await flush();
      assert.deepStrictEqual(r.downs, [true], "复位用过了又失败＝停摆，视口里的块不是当前那份＝报不可用");
      assert.equal(warn.mock.callCount(), 2, "停摆那次失败也响");
      assert.strictEqual(r.busy[r.busy.length - 1][0], false, "停摆不算忙（胶囊不悬在精修中）");
      mock.timers.tick(TILE_RETRY_MS * 4);
      await flush();
      assert.strictEqual(r.waiting.length, 0, "不再发单");
      r.m.setView(viewOf(0)[0], G.step * 4);
      assert.deepStrictEqual(r.downs, [true, false], "缩到用不上块：不报");
    } finally { mock.timers.reset(); }
  });

  it("缓存命中不发单；换几何（reset）块层下屏", async () => {
    const warm = rig();
    warm.m.setCoarse(COARSE, GRID);
    feed(warm.m, INP);
    await flush();
    for (let k = 0; k < 4; k++) await warm.release();
    const r = rig({ cache: warm.cache });
    r.m.setCoarse(COARSE, GRID);
    feed(r.m, INP);
    await flush();
    assert.strictEqual(r.calls.length, 0);
    assert.strictEqual(r.last()!.tiles.size, 4);
    r.m.reset();
    assert.strictEqual(r.last(), null);
  });

  it("中尺度单（带起伏包络）不要切割量：不发 erodeCarve，块照常排队算、齐了上屏", async () => {
    const r = rig(), mi = { ...INP, mesoEnv: new Float32Array(INP.cols * INP.rows) };
    r.m.setCoarse(COARSE, GRID);
    feed(r.m, mi);
    await flush();
    assert.strictEqual(r.st.carves, 0, "中尺度图不跑粗级，不该要切割量");
    for (let k = 0; k < 4; k++) await r.release();
    assert.strictEqual(r.calls.length, 4); assert.strictEqual(r.last()!.tiles.size, 4);
  });
});
