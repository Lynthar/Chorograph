/* host 的高程场记账（「高程成为数据」）：规则场 ctx.ruleField 只认工作档，精修档只进画面 ctx.elevField；工作档到手先攒着，精修或块到齐了同一帧换上。
   fake routeClient 按输入预算返回可辨认的场（数据整幅填 cap），fake 渲染器记下最近一次上传的（画面, 规则）对与上传次数；
   防抖用 node:test 的 mock timers 拨过。node 下无 indexedDB＝场缓存恒未命中，走的是真算分支。 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHost } from "../src/shell/host.ts";
import { landWorld } from "../src/shell/orchestrate.ts";
import { applyUplift, foldIntoErosion, paintHeightPath, paintTerrainPath, paintUpliftPath } from "../src/app/editops.ts";
import { genRiverEdges, genRiverEdgesOf, normalizeWorld } from "../src/core/world.ts";
import { gridGeom } from "../src/core/grid.ts";
import { beginStroke, canUndoSig, cellsVerSig, deleteEdgeIdx, editVerSig, endStroke, erodePhaseSig, gridVerSig, mesoDownSig, mutateWorld, readOnlySig, redoWorld, ruleFieldSig, undoWorld, worldSig, yearSig } from "../src/app/state.ts";
import type { ShellCtx } from "../src/shell/ctx.ts";
import { baseElev, waterSurface, type ElevField } from "../src/core/elev.ts";
import { erodeKey, type ErodeInput } from "../src/core/erode.ts";
import type { Meta, World } from "../src/core/types.ts";
import type { FieldGeom } from "../src/core/elev.ts";
import { gen2Meso, gen2Uplift, mesoKey as mesoKeyOf, mesoState, riverParams, type UpliftCells } from "../src/core/gen2.ts";
import { nestBaseOf, nestSolOf } from "../src/core/nested.ts";
import type { MesoReply, UpliftReply } from "../src/worker/routeProto.ts";
import { viewFieldOf } from "../src/shell/viewshed.ts";
import { contourStepOf } from "../src/render/renderer.ts";
import { tileField } from "../src/core/tiles.ts";
import { allComposites, terrainProps } from "../src/core/constants.ts";

/* host.rebuild 经 $() 摸 DOM 挂点（hud 恒写）——node 下以最小 fake 顶上 */
const els: Record<string, { dataset: Record<string, string>; value: string }> = {};
(globalThis as { document?: unknown }).document = {
  getElementById: (id: string) => (els[id] ||= { dataset: {}, value: "" })
};

/** 可辨认的假细分场：几何按 sx 细分（嵌套解的单按它自己的倍率），数据整幅填本单预算——谁读到了哪一档一目了然 */
const fakeField = (inp: ErodeInput, sx: number): ElevField => ({
  bb: inp.bb, step: inp.step / sx, cols: inp.cols * sx, rows: inp.rows * sx,
  data: new Float32Array(inp.cols * inp.rows * sx * sx).fill(inp.cap), eroded: true
});

/* holdUltra＝精修单挂起不回（模拟几十秒的在飞单）；cancels 只数撤到了在飞单的那几次（host 每次重建都调，无单时是空操作） */
interface Seen { field?: ElevField; rule?: ElevField; uploads: number; workCap?: number; ultraCap?: number; holdUltra?: boolean; holdErode?: boolean; cancels: number; erodeCancels: number; erodes: number; lastInp?: ErodeInput; lastUInp?: ErodeInput; lastWork?: ElevField; release?: (f: ElevField | null) => void; releaseE?: (f: ElevField | null) => void }
function mkCtx(): { ctx: ShellCtx; seen: Seen } {
  const seen: Seen = { cancels: 0, erodeCancels: 0, erodes: 0, uploads: 0 };
  const ctx = {
    canvas: {}, ov: {},
    routeClient: {
      setContext: () => {},
      erode: (inp: ErodeInput) => {
        seen.workCap = inp.cap; seen.erodes++; seen.lastInp = inp;
        return seen.holdErode ? new Promise<ElevField | null>(res => { seen.releaseE = res; }) : Promise.resolve(seen.lastWork = fakeField(inp, inp.nest ? inp.nest.sx : 2));
      },
      cancelErode: () => { if (seen.releaseE) { seen.erodeCancels++; seen.releaseE(null); seen.releaseE = undefined; } },
      erodeUltra: (inp: ErodeInput) => {
        seen.ultraCap = inp.cap; seen.lastUInp = inp;
        return seen.holdUltra ? new Promise<ElevField | null>(res => { seen.release = res; }) : Promise.resolve(fakeField(inp, 4));
      },
      cancelUltra: () => { if (seen.release) { seen.cancels++; seen.release(null); seen.release = undefined; } }
    },
    DPR: 1, meta: {}, view: { lon0: 100.05, lat0: 30.05, degPerPx: 0.001 },
    grid: null, elevField: null, ruleField: null,
    R: { uploadGrid: (_g: unknown, _ws: unknown, field: ElevField, rule: ElevField) => { seen.field = field; seen.rule = rule; seen.uploads++; }, uploadTiles: () => {} },
    builtFor: null, repaint: null,
    lib: null, mapId: null, source: "browser", folderDir: null, fcache: {},
    bootNote: "", savedAt: null, saveErr: null, libOpen: false
  } as unknown as ShellCtx;
  return { ctx, seen };
}
/* relief>0＝侵蚀门开；0.1° 小战场＝网格约百格见方，工作档取轴上限 8×、精修档 16×（两档预算都拿得到增益） */
const W = (extra: Record<string, unknown> = {}): World => normalizeWorld({
  meta: { 名称: "战", worldModel: "sphere", terrain: "plain", mapKind: "tactical", relief: 0.5,
    bbox: { lonMin: 100, lonMax: 100.1, latMin: 30, latMax: 30.1 }, ...extra }
});
/** 让微任务与 IO 回合走完（setImmediate 不在 mock 之列）：缓存探针 → 假单应答 → 落地 */
const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
/** 拨假钟（MockTimers 只有同步 tick）：分 steps 步走，每步冲一次微任务——渐变是逐帧再排的定时器链 */
const tick = async (ms: number, steps = 1): Promise<void> => { for (let i = 0; i < steps; i++) { mock.timers.tick(ms / steps); await flush(); } };
/** 开图到换上屏的整段：粗格 → 工作档到手、精修紧跟着算 → 同一帧换上（后面两次拨钟是防抖余量） */
async function openAndSettle(ctx: ShellCtx): Promise<{ work: ElevField }> {
  const host = createHost(ctx);
  landWorld(ctx, W(), "t1", 3050);
  host.rebuildIfNeeded();
  await flush();
  const work = ctx.ruleField!;
  await tick(240, 6);
  await tick(6000);
  return { work };
}

describe("规则场只认工作档，精修档只进画面（host 高程场记账）", () => {
  const nav = navigator as { deviceMemory?: number };
  beforeEach(() => { mock.timers.enable({ apis: ["setTimeout"] }); delete nav.deviceMemory; });
  afterEach(() => { mock.timers.reset(); delete nav.deviceMemory; });

  it("开图：工作档到手不单独换上，精修到了同一帧换；规则场只认工作档，精修只进画面", async () => {
    const { ctx, seen } = mkCtx();
    seen.holdUltra = true;
    const host = createHost(ctx);
    landWorld(ctx, W(), "t1", 3050);
    host.rebuildIfNeeded();
    const coarse = ctx.ruleField!;
    assert.equal(coarse.cols, ctx.grid!.cols, "换上之前规则场＝粗格场");
    assert.equal(ctx.elevField, coarse, "画面同一份");
    assert.equal(coarse.src, "coarse");
    let done = false;
    void host.settled().then(() => { done = true; });
    await flush();
    assert.equal(seen.erodes, 1);
    assert.ok(ctx.ruleField === coarse && ctx.elevField === coarse, "工作档到手、精修还在算：屏上不动");
    assert.equal(ruleFieldSig.peek(), null, "也不落定");
    assert.equal(erodePhaseSig.peek(), "ultra", "胶囊报精修中");
    assert.ok(!done, "「算完了」还没兑现");
    const ups = seen.uploads;
    seen.release!(fakeField(seen.lastUInp!, 4)); seen.release = undefined;
    await flush();
    const work = ctx.ruleField!, ultra = ctx.elevField!;
    assert.equal(seen.uploads, ups + 1, "换上屏只上传一次");
    assert.equal(work.cols, ctx.grid!.cols * 2, "规则场换成 2× 细分场");
    assert.equal(work.src, "work", "工作档车道交出来的场带规则场标记");
    assert.equal(work.data[0], seen.workCap, "规则场出自工作档预算");
    assert.equal(ultra.cols, ctx.grid!.cols * 4, "画面＝精修场（4×）");
    assert.equal(ultra.data[0], seen.ultraCap, "画面出自精修预算");
    assert.ok(!("src" in ultra), "精修场不带规则场标记");
    assert.equal(ruleFieldSig.peek(), work, "同拍落定");
    assert.equal(seen.field, ultra, "渲染器画面份＝精修");
    assert.equal(seen.rule, work, "渲染器规则份＝工作档（推演底图画它）");
    assert.ok(done, "换上屏＝算完了");
    assert.equal(erodePhaseSig.peek(), "done");
    await tick(20000);
    assert.ok(ctx.ruleField === work && ctx.elevField === ultra && seen.uploads === ups + 1, "之后静置：什么都不再变");
  });

  it("落笔（自动档）：屏上的工作档与精修都留着叠粗格增量，新的一份算齐才一起换", async () => {
    const { ctx, seen } = mkCtx();
    const host = createHost(ctx);
    landWorld(ctx, W(), "t1", 3050);
    host.rebuildIfNeeded();
    await flush();
    const work = ctx.ruleField!, ultra = ctx.elevField!;
    assert.equal(ultra.cols, ctx.grid!.cols * 4, "前置：精修在屏");
    seen.holdUltra = true;
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuild();   // 笔刷走 pointer 直调 rebuild，同一条路
    const mid = ctx.elevField!;
    assert.ok(mid.cols === ultra.cols && mid !== ultra, "画面＝旧精修叠增量（新合成的场），不退回工作档");
    assert.ok(ctx.ruleField!.cols === work.cols && ctx.ruleField !== work, "规则场＝旧工作档叠增量，不退回粗格");
    assert.equal(ruleFieldSig.peek(), null, "演算中");
    assert.equal(seen.field, mid); assert.equal(seen.rule, ctx.ruleField);
    await tick(60);
    assert.equal(seen.erodes, 2, "新工作档单发了并回来了");
    assert.ok(ctx.elevField === mid && ruleFieldSig.peek() === null, "新工作档到手、新精修没到：屏上还是那份合成");
    seen.release!(fakeField(seen.lastUInp!, 4)); seen.release = undefined;
    await flush();
    assert.ok(ctx.ruleField !== work && ctx.ruleField!.src === "work" && ctx.elevField!.cols === ultra.cols && ctx.elevField !== mid, "到齐：工作档与精修一起换");
    assert.equal(ruleFieldSig.peek(), ctx.ruleField);
  });

  it("手动档：高程笔重建不发单、不弃精修、不撤单；规则场＝工作档叠涂改增量且立即落定；侵蚀输入不含涂改", async () => {
    const { ctx, seen } = mkCtx();
    const host = createHost(ctx);
    landWorld(ctx, W({ erode: "base" }), "t1", 3050);
    host.rebuildIfNeeded();
    await flush();
    const work = ctx.ruleField!;
    await tick(240, 6);
    await tick(6000);
    assert.equal(ctx.elevField!.cols, ctx.grid!.cols * 4, "前置：精修在屏");
    const erodes0 = seen.erodes, grid0 = ctx.grid;
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuild();
    await tick(500);
    assert.equal(ctx.grid, grid0, "只动高程＝Grid 实例复用");
    assert.equal(seen.erodes, erodes0, "没有再发侵蚀单");
    assert.equal(ctx.elevField!.cols, ctx.grid!.cols * 4, "精修仍在屏（叠了涂改增量）");
    assert.equal(ctx.ruleField!.cols, work.cols, "规则场在工作档几何上");
    assert.notEqual(ctx.ruleField, work, "规则场＝工作档叠涂改增量（非零）");
    assert.equal(ruleFieldSig.value, ctx.ruleField, "立即落定，不进演算中");
    assert.notEqual(erodePhaseSig.value, "work", "胶囊不亮");
    assert.ok(seen.lastInp!.hovGrid.every(v => v === 0), "侵蚀输入不含高程涂改");
    assert.equal(seen.field, ctx.elevField); assert.equal(seen.rule, ctx.ruleField);
  });

  /** 手动档开图到工作档落地，再用地貌笔换掉侵蚀的 Grid，新单挂在飞行中 */
  async function baseWithJobInFlight(ctx: ShellCtx, seen: Seen, host: ReturnType<typeof createHost>): Promise<void> {
    landWorld(ctx, W({ erode: "base" }), "t1", 3050);
    host.rebuildIfNeeded();
    await flush();
    await tick(240, 6);
    assert.ok(ruleFieldSig.value === ctx.ruleField, "前置：工作档落定");
    seen.holdErode = true;
    mutateWorld(w => { w.terrainOverrides = [...w.terrainOverrides, { lon: 100.05, lat: 30.05, t: "hill" }]; }, { grid: true });
    host.rebuildIfNeeded();
    await tick(100);
    assert.equal(seen.erodes, 2, "前置：地貌笔换了侵蚀的 Grid，新单在飞");
    assert.ok(ruleFieldSig.value === null, "前置：演算中");
  }
  const sculpt = (): void => mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.02, lat: 30.02, dh: 0.2 }); }, { grid: true });

  it("手动档：换了侵蚀 Grid 的新单在飞时落高程笔：画面跟笔、不撤单、不落定，新单落地才落定", async () => {
    const { ctx, seen } = mkCtx();
    const host = createHost(ctx);
    await baseWithJobInFlight(ctx, seen, host);
    const g1 = ctx.grid, rule0 = ctx.ruleField;
    sculpt();
    host.rebuild();
    assert.ok(ctx.grid === g1, "只动高程＝同一 Grid");
    assert.ok(ctx.ruleField !== rule0 && seen.field === ctx.elevField, "画面跟笔");
    assert.ok(ruleFieldSig.value === null, "工作档出自旧 Grid：不落定，等新单");
    assert.equal(seen.erodeCancels, 0, "不撤在飞的单");
    seen.releaseE!(fakeField(seen.lastInp!, 2)); seen.releaseE = undefined;
    await flush();
    assert.ok(ruleFieldSig.value === ctx.ruleField, "新单落地才落定");
    assert.equal(ctx.ruleField!.cols, ctx.grid!.cols * 2);
    assert.equal(seen.erodes, 2, "高程笔没有另发单");
  });

  it("手动档：换了侵蚀 Grid 的那一单算不出：落定当下那份；下一笔重发单，落地前不落定", async () => {
    const { ctx, seen } = mkCtx();
    const host = createHost(ctx);
    await baseWithJobInFlight(ctx, seen, host);
    let done = false;
    void host.settled().then(() => { done = true; });
    seen.releaseE!(null); seen.releaseE = undefined;   // 车道崩溃：单以 null 收场
    await flush();
    assert.ok(done, "算不出也打开「算完了」的闩（开图的加载页不悬着）");
    assert.ok(ruleFieldSig.value === ctx.ruleField && ctx.elevField!.cols === ctx.grid!.cols * 4, "算不出：落定在当下那份（旧工作档叠增量；屏上的精修留着）");
    seen.holdErode = false;
    sculpt();
    host.rebuild();
    assert.ok(ruleFieldSig.value === null, "下一笔不再把旧工作档的合成当落定");
    await tick(100);
    assert.equal(seen.erodes, 3, "重发了一单");
    assert.ok(ruleFieldSig.value === ctx.ruleField, "落地后落定");
    sculpt();
    host.rebuild();
    assert.ok(ruleFieldSig.value === ctx.ruleField, "工作档出自当前 Grid：高程笔照旧立即落定");
    await tick(500);
    assert.equal(seen.erodes, 3, "高程笔不发单");
  });

  /** 手动档开图到工作档与精修换上；brush＝走写入口的一笔地貌（丘陵）加一次重建 */
  async function manualSettled(ctx: ShellCtx, w0: World): Promise<{ host: ReturnType<typeof createHost>; brush: () => void }> {
    const host = createHost(ctx);
    landWorld(ctx, w0, "t1", 3050);
    host.rebuildIfNeeded();
    await flush(); await tick(240, 6); await tick(6000);
    assert.equal(ctx.elevField!.cols, ctx.grid!.cols * 4, "前置：精修在屏");
    return { host, brush: () => { mutateWorld(w => { paintTerrainPath(w, ctx.grid!, 3050, [[100.05, 30.05]], "hill", 2, false, null, "lf"); }, { grid: true }); host.rebuild(); } };
  }
  it("手动档地貌笔：侵蚀看到的仍是改前那份——不发单、不弃精修、规则场＝工作档叠增量且立即落定；屏上的格换成新地类", async () => {
    const { ctx, seen } = mkCtx();
    const { host, brush } = await manualSettled(ctx, W({ erode: "base" }));
    const work = ctx.ruleField!, g0 = ctx.grid!, erodes0 = seen.erodes;
    brush();
    await tick(500);
    assert.notEqual(ctx.grid, g0, "屏上的格换了实例（地类变了，寻路与配色跟着变）");
    assert.ok(ctx.grid!.cells.some(row => row.includes("hill")));
    assert.equal(seen.erodes, erodes0, "没有再发侵蚀单");
    assert.equal(seen.erodeCancels, 0);
    assert.equal(ctx.elevField!.cols, ctx.grid!.cols * 4, "精修仍在屏（叠了地貌增量）");
    assert.equal(ctx.ruleField!.cols, work.cols);
    assert.notEqual(ctx.ruleField, work, "规则场＝工作档叠地貌增量");
    assert.equal(ruleFieldSig.value, ctx.ruleField, "立即落定");
    assert.notEqual(erodePhaseSig.value, "work", "胶囊不亮");
    /* 涂成丘陵的格：旧的侵蚀细节作废，读到的是未侵蚀的新地貌（粗格场的值），不是假工作档的满幅数；没涂到的格照旧是工作档 */
    const g = ctx.grid!, f = ctx.ruleField!, k = f.cols / g.cols, r = Math.floor((30.05 - g.bb.latMin) / g.step), c = Math.floor((100.05 - g.bb.lonMin) / g.step);
    assert.equal(g.cells[r][c], "hill");
    const center = f.data[(r * k + (k >> 1)) * f.cols + c * k + (k >> 1)];
    assert.ok(center < seen.workCap! / 10, "笔下的格大半取粗格场（细格心离粗格心四分之一格，权重 15/16）：" + center);
    assert.equal(f.data[0], seen.workCap, "远处纹丝不动");
    assert.ok(ctx.elevField!.data[(r * 4 + 2) * ctx.elevField!.cols + c * 4 + 2] < seen.ultraCap! / 10, "精修场上同样");
    brush();   // 同一处再涂＝零改动；再换一处
    mutateWorld(w => { paintTerrainPath(w, ctx.grid!, 3050, [[100.02, 30.02]], "mountain", 2, false, null, "lf"); }, { grid: true });
    host.rebuild(); await tick(500);
    assert.equal(seen.erodes, erodes0, "第二笔照旧不发单");
    assert.equal(ruleFieldSig.value, ctx.ruleField);
  });
  it("手动档点「侵蚀」：发一单，单里是现在的地貌与高程；撤销、重做都换回最近落地过的那份，不再发单", async () => {
    const { ctx, seen } = mkCtx();
    const { host, brush } = await manualSettled(ctx, W({ erode: "base" }));
    const erodes0 = seen.erodes, elev0 = seen.lastInp!.elev0.slice();
    brush();
    mutateWorld(w => { paintHeightPath(w, ctx.grid!, [[100.08, 30.08]], 0.05, 2, null); }, { grid: true }); host.rebuild();
    await tick(500);
    assert.equal(seen.erodes, erodes0);
    mutateWorld(w => { assert.ok(foldIntoErosion(w)); }, { grid: true });
    host.rebuildIfNeeded();
    assert.ok(ruleFieldSig.value === null, "演算中");
    await tick(100); await tick(240, 6);
    assert.equal(seen.erodes, erodes0 + 1, "发了一单");
    assert.ok(seen.lastInp!.elev0.some((v, i) => v !== elev0[i]), "单里是涂过的地貌");
    assert.ok(seen.lastInp!.hovGrid.some(v => v !== 0), "单里带高程涂改");
    assert.equal(ruleFieldSig.value, ctx.ruleField, "落地即落定");
    assert.ok(ctx.ruleField!.data[0] === seen.workCap && ctx.elevField!.data[0] === seen.ultraCap, "涂改全在单里：没有增量可叠，规则场与画面就是新工作档与新精修本身");
    const folded = ctx.ruleField;
    undoWorld(); host.rebuildIfNeeded();
    await flush(); await tick(240, 6);
    assert.equal(seen.erodes, erodes0 + 1, "撤销：换回上一份工作档，不发单");
    assert.ok(ctx.ruleField !== folded && ctx.ruleField !== ctx.elevField, "规则场＝旧工作档叠涂改增量（新合成的场），画面＝它的精修叠同一份增量");
    assert.equal(ruleFieldSig.value, ctx.ruleField);
    redoWorld(); host.rebuildIfNeeded();
    await flush(); await tick(240, 6);
    assert.equal(seen.erodes, erodes0 + 1, "重做：同样不发单");
    assert.deepEqual(worldSig.value!.baseOverrides, {});
  });
  it("手动档撤销一笔地貌笔：回到改前那个 Grid 实例，早退支——不发单、精修留屏", async () => {
    const { ctx, seen } = mkCtx();
    const { host, brush } = await manualSettled(ctx, W({ erode: "base" }));
    const g0 = ctx.grid!, work = ctx.ruleField!, erodes0 = seen.erodes;
    brush();
    undoWorld(); host.rebuildIfNeeded();
    await tick(500);
    assert.equal(ctx.grid, g0, "屏上的格就是侵蚀用的那个实例");
    assert.equal(ctx.ruleField, work, "没有增量＝工作档本身");
    assert.equal(seen.erodes, erodes0);
    assert.equal(ctx.elevField!.cols, ctx.grid!.cols * 4, "精修仍在屏");
    redoWorld(); host.rebuildIfNeeded();
    await tick(500);
    assert.equal(seen.erodes, erodes0, "重做那一笔：侵蚀看到的还是改前那份");
    assert.notEqual(ctx.ruleField, work);
    assert.equal(ruleFieldSig.value, ctx.ruleField);
  });
  it("手动档收进侵蚀之后的高程笔：开图的单里带着收进去的涂改；再落笔不发单，侵蚀看到的还是那一份", async () => {
    const { ctx, seen } = mkCtx();
    const w0 = W({ erode: "base" });
    w0.heightOverrides = [{ lon: 100.03, lat: 30.03, dh: 0.1 }]; w0.baseOverrides = {};
    const { host } = await manualSettled(ctx, w0);
    const erodes0 = seen.erodes, hov0 = seen.lastInp!.hovGrid.slice();
    assert.ok(hov0.some(v => v !== 0), "前置：收进去的高程涂改在单里");
    assert.equal(ctx.ruleField, ruleFieldSig.value);
    const g0 = ctx.grid;
    for (let i = 0; i < 3; i++) { mutateWorld(w => { paintHeightPath(w, ctx.grid!, [[100.05, 30.05]], 0.05, 2, null); }, { grid: true }); host.rebuild(); }
    await tick(500);
    assert.equal(ctx.grid, g0);
    assert.equal(seen.erodes, erodes0, "不发单");
    assert.equal(ctx.elevField!.cols, ctx.grid!.cols * 4, "精修仍在屏");
    assert.equal(ruleFieldSig.value, ctx.ruleField, "立即落定");
    assert.deepEqual(worldSig.value!.baseOverrides, { height: [{ lon: 100.03, lat: 30.03, dh: 0.1 }] });
    yearSig.value = 3051; host.rebuildIfNeeded(); await flush(); await tick(240, 6);
    assert.equal(seen.erodes, erodes0 + 1, "拨年走全路径");
    assert.deepEqual(seen.lastInp!.hovGrid, hov0, "全路径的单里仍只有收进去的那份");
    mutateWorld(w => { foldIntoErosion(w); }, { grid: true });
    host.rebuildIfNeeded(); await tick(100); await tick(240, 6);
    assert.equal(seen.erodes, erodes0 + 2, "只有高程涂改要收（侵蚀的 Grid 没换），点侵蚀照样发单");
    assert.ok(seen.lastInp!.hovGrid.some((v, i) => v !== hov0[i]), "单里是现在的高程涂改");
  });

  it("在飞的工作档单随重建撤掉：单以 null 收场、不进缓存、胶囊不闪、新单接管落地", async () => {
    const { ctx, seen } = mkCtx();
    seen.holdErode = true;
    const host = createHost(ctx);
    landWorld(ctx, W(), "t1", 3050);
    host.rebuildIfNeeded();
    await flush();
    assert.equal(seen.erodes, 1, "前置：首单在飞");
    assert.equal(erodePhaseSig.value, "work");
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    seen.holdErode = false;
    host.rebuild();
    assert.equal(seen.erodeCancels, 1, "重建即撤在飞的单");
    await flush();
    assert.equal(erodePhaseSig.value, "work", "被撤的单以 null 收场不撤胶囊——新单接管");
    assert.equal(ruleFieldSig.value, null, "落定信号仍在演算中");
    await tick(100);   // 防抖 60ms 后新单发出并立即应答
    await tick(240, 6);
    assert.equal(seen.erodes, 2, "新单发出");
    assert.equal(ctx.ruleField!.cols, ctx.grid!.cols * 2, "新单落地＝规则场换真");
    assert.equal(ruleFieldSig.value, ctx.ruleField);
  });

  it("落定信号：门开＝演算中 null、工作档落地＝工作档、精修不动它、落笔回 null；门关＝粗格即落定", async () => {
    const { ctx } = mkCtx();
    const host = createHost(ctx);
    landWorld(ctx, W(), "t1", 3050);
    host.rebuildIfNeeded();
    assert.equal(ruleFieldSig.peek(), null, "门开：粗格是过渡，未落定");
    await flush();
    const work = ctx.ruleField!;
    assert.equal(ruleFieldSig.peek(), work, "工作档落地＝落定");
    await tick(240, 6);
    await tick(6000);
    assert.equal(ruleFieldSig.peek(), work, "精修落地不动落定信号");
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuild();
    assert.equal(ruleFieldSig.peek(), null, "落笔＝重新演算，落定信号撤回");
    await tick(60);
    await flush();
    assert.notEqual(ruleFieldSig.peek(), null, "新工作档落地再落定");
    assert.equal(ruleFieldSig.peek(), ctx.ruleField);
    const flat = normalizeWorld({ meta: { 名称: "平", worldModel: "sphere", terrain: "plain", mapKind: "tactical",
      bbox: { lonMin: 100, lonMax: 100.1, latMin: 30, latMax: 30.1 } } });
    landWorld(ctx, flat, "t2", 3050);
    host.rebuildIfNeeded();
    assert.equal(ruleFieldSig.peek(), ctx.ruleField, "门关：粗格就是终态，同拍落定");
    assert.equal(ruleFieldSig.peek()!.cols, ctx.grid!.cols);
  });

  it("在飞的精修单随重建撤掉：单以 null 收场、没有半份换上，新一轮照常起、到齐才换", async () => {
    const { ctx, seen } = mkCtx();
    seen.holdUltra = true;
    const host = createHost(ctx);
    landWorld(ctx, W(), "t1", 3050);
    host.rebuildIfNeeded();
    await flush();
    assert.equal(erodePhaseSig.peek(), "ultra", "前置：精修单在飞");
    assert.equal(seen.cancels, 0, "前置：此前的重建没有在飞单可撤");
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuild();
    assert.equal(seen.cancels, 1, "落笔那次重建撤了在飞的单");
    await flush();
    assert.ok(ctx.elevField === ctx.ruleField && ctx.ruleField!.cols === ctx.grid!.cols, "被撤的那一轮什么都没换上：屏上还是粗格");
    await tick(60);
    assert.equal(seen.erodes, 2, "新一轮的工作档单");
    assert.equal(erodePhaseSig.peek(), "ultra", "新一轮的精修在飞");
    seen.release!(fakeField(seen.lastUInp!, 4)); seen.release = undefined;
    await flush();
    assert.equal(ctx.elevField!.cols, ctx.grid!.cols * 4, "到齐才换上");
    assert.equal(erodePhaseSig.peek(), "done");
  });

  it("类型网格按实例复用：只动高程不换 Grid；涂改 / 年份 / meta 任一变即换新实例", () => {
    const { ctx } = mkCtx();
    const host = createHost(ctx);
    landWorld(ctx, W(), "t1", 3050);
    host.rebuildIfNeeded();
    const g0 = ctx.grid!;
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuild();
    assert.equal(ctx.grid, g0, "只动高程＝同一 Grid 实例（基底/水面/起伏/纹理的记忆全部命中）");
    mutateWorld(w => { w.terrainOverrides = [...w.terrainOverrides, { lon: 100.05, lat: 30.05, t: "hill" }]; }, { grid: true });
    host.rebuild();
    assert.notEqual(ctx.grid, g0, "涂改变了＝新实例");
    const g1 = ctx.grid!;
    assert.equal(g1.cells[Math.floor(0.05 / g1.step)][Math.floor(0.05 / g1.step)], "hill", "新实例带着新涂改");
    yearSig.value = 3051;
    host.rebuildIfNeeded();
    assert.notEqual(ctx.grid, g1, "年份变了＝新实例（涂改可带时段）");
    const g2 = ctx.grid!;
    mutateWorld(w => { (w.meta ||= {}).outside = "land"; }, { grid: true });   // ctx.meta 与 w.meta 同一对象（生产由编排 effect 同步）
    host.rebuild();
    assert.notEqual(ctx.grid, g2, "meta 里进派生场的键变了＝新实例（水面记忆随之作废）");
  });

  it("同一存档、两种精修预算：规则场逐位相同，画面随预算变；deviceMemory 测不出＝低档", async () => {
    nav.deviceMemory = 16;
    const hi = mkCtx();
    const { work: hiWork } = await openAndSettle(hi.ctx);
    nav.deviceMemory = 4;   // 低内存档：精修预算减半
    const lo = mkCtx();
    const { work: loWork } = await openAndSettle(lo.ctx);
    delete nav.deviceMemory;   // Firefox / Safari 读不到：按低档，不按够用算
    const na = mkCtx();
    await openAndSettle(na.ctx);
    assert.equal(hi.seen.workCap, lo.seen.workCap, "工作档预算是图种常量");
    assert.notEqual(hi.seen.ultraCap, lo.seen.ultraCap, "精修预算确实随本机内存分档（前置）");
    assert.equal(na.seen.ultraCap, lo.seen.ultraCap, "测不出内存＝低档预算");
    assert.deepEqual(hiWork.data, loWork.data, "规则场逐位相同＝读数与规则不随机器变");
    assert.notEqual(hi.ctx.elevField!.data[0], lo.ctx.elevField!.data[0], "画面随预算变（精修只进画面）");
  });

  it("撤销只动高程的一笔：沿用同一个 Grid（手动档照旧走早退支、不发单）；撤销对象编辑之后的一笔也照旧", async () => {
    const { ctx, seen } = mkCtx();
    const host = createHost(ctx);
    landWorld(ctx, W({ erode: "base" }), "t1", 3050);
    host.rebuildIfNeeded();
    await flush();
    await tick(240, 6);
    const grid0 = ctx.grid, erodes0 = seen.erodes;
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuildIfNeeded();
    const sculpted = ctx.ruleField;
    undoWorld();
    host.rebuildIfNeeded();
    assert.equal(ctx.grid, grid0, "撤销：涂改数组沿用＝同一 Grid 实例");
    assert.notEqual(ctx.ruleField, sculpted, "高程回到落笔前");
    assert.equal(ruleFieldSig.value, ctx.ruleField, "早退支：立即落定");
    mutateWorld(w => { w.nodes.push({ id: "n1", 名称: "城", type: "city", lon: 100.02, lat: 30.02 } as unknown as World["nodes"][number]); });
    undoWorld();
    host.rebuildIfNeeded();
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuildIfNeeded();
    await tick(500);
    assert.equal(ctx.grid, grid0, "撤销对象编辑之后的一笔仍沿用 Grid");
    assert.equal(seen.erodes, erodes0, "全程没有再发侵蚀单");
  });

  it("撤销 / 重做回到落地过的地形：换上最近那份工作档（它的精修取缓存或补算，到了同一帧换），不合成也不发工作档单", async () => {
    const { ctx, seen } = mkCtx();
    const host = createHost(ctx);
    landWorld(ctx, W(), "t1", 3050);
    host.rebuildIfNeeded();
    await flush();
    const work0 = ctx.ruleField!;
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuildIfNeeded();
    assert.equal(ruleFieldSig.value, null, "前置：新的一笔走等待窗");
    await tick(60);
    const work1 = ctx.ruleField!;
    assert.notEqual(work1, work0);
    assert.equal(ruleFieldSig.value, work1, "前置：那一笔换上了");
    const erodes = seen.erodes;
    undoWorld();
    host.rebuildIfNeeded();
    await flush();
    assert.equal(ctx.ruleField, work0, "撤销：规则场就是开图那份，不是合成");
    assert.equal(ruleFieldSig.value, work0, "同拍落定");
    assert.equal(ctx.elevField!.cols, ctx.grid!.cols * 4, "画面是它的精修");
    redoWorld();
    host.rebuildIfNeeded();
    await flush();
    assert.equal(ctx.ruleField, work1, "重做：换回那一笔的那份");
    await tick(500);
    assert.equal(seen.erodes, erodes, "没有再发工作档单");
  });

  it("离散换场落到在屏那一份（侵蚀单一字不变的设置改动）：同一次重建里落定，屏上的工作档与精修原样、不发单；拨年照旧走等待窗", async () => {
    const { ctx, seen } = mkCtx();
    const host = createHost(ctx);
    landWorld(ctx, W(), "t1", 3050);
    host.rebuildIfNeeded();
    await flush();
    const work0 = ctx.ruleField!, ultra0 = ctx.elevField!;
    const erodes = seen.erodes;
    mutateWorld(w => { w.meta.erode = "base"; }, { grid: true });   // 没有高程涂改：两档的侵蚀单逐位相同
    host.rebuildIfNeeded();
    assert.equal(ctx.ruleField, work0, "规则场就是在屏那份");
    assert.equal(ctx.elevField, ultra0, "精修也还是那一份（没有重要、没有重算）");
    assert.equal(ruleFieldSig.value, work0, "同拍落定");
    await tick(500);
    assert.equal(seen.erodes, erodes, "没有发单");
    yearSig.value = 3051;
    host.rebuildIfNeeded();
    assert.equal(ruleFieldSig.value, null, "拨年不查最近落地：照旧进演算、等防抖后的那一单（播放每步不付组装求键的账）");
  });

  it("设置应用（grid: ifChanged）：不动地形的项不重建——在飞的精修单不撤、不发工作档单、换上的照旧在屏；动地形的项照旧重建", async () => {
    const { ctx, seen } = mkCtx();
    seen.holdUltra = true;
    const host = createHost(ctx);
    landWorld(ctx, W(), "t1", 3050);
    host.rebuildIfNeeded();
    await flush();
    assert.equal(erodePhaseSig.peek(), "ultra", "前置：精修单在飞");
    const erodes0 = seen.erodes, ver0 = gridVerSig.peek();
    mutateWorld(w => { Object.assign(w.meta, { climate: "arid", contourM: 50, period: "modern" }); }, { grid: "ifChanged" });
    host.rebuildIfNeeded();
    assert.equal(gridVerSig.peek(), ver0, "气候 / 等高距 / 时代不进地形键：不要求重建");
    assert.equal(seen.cancels, 0, "在飞的精修单没撤");
    seen.release!(fakeField(seen.lastUInp!, 4)); seen.release = undefined;
    await flush();
    const ultra = ctx.elevField!, work = ctx.ruleField!;
    assert.equal(ultra.cols, ctx.grid!.cols * 4, "这一轮照常到齐、换上");
    mutateWorld(w => { w.meta.名称 = "改名"; w.meta.vault = "库"; }, { grid: "ifChanged" });
    host.rebuildIfNeeded();
    await tick(500);
    assert.ok(ctx.elevField === ultra && ruleFieldSig.value === work, "换上的那份原样在屏，落定的规则场不动");
    assert.equal(seen.erodes, erodes0, "没有新的工作档单");
    mutateWorld(w => { w.meta.relief = 1; }, { grid: "ifChanged" });
    host.rebuildIfNeeded();
    assert.equal(gridVerSig.peek(), ver0 + 1, "地势起伏进地形键：照旧重建");
    assert.ok(ctx.elevField!.cols === ultra.cols && ruleFieldSig.value === null, "重建：进演算；屏上还是旧解（叠增量），等新的到齐");
    await tick(100);
    assert.equal(seen.erodes, erodes0 + 1, "发了新单");
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: "ifChanged" });
    assert.equal(gridVerSig.peek(), ver0 + 2, "原地改涂改数组也认得出");
  });

  it("分块的战略图：工作档到手不单独换上，全图的块到齐了同一帧换；编辑后同理，「已完成」与换上同拍；撤销同一次重建里换回", async () => {
    const { ctx, seen } = mkCtx();
    const held: (() => void)[] = [];
    Object.assign(ctx.routeClient, {
      tileLanes: 1,
      erodeCarve: async (inp: ErodeInput) => ({ data: new Float32Array(inp.cols * inp.rows), geo: { bb: inp.bb, step: inp.step, cols: inp.cols, rows: inp.rows } }),
      erodeTile: (inp: ErodeInput) => new Promise<ElevField>(res => {
        const sx = inp.axisMax;
        held.push(() => res({ bb: inp.bb, step: inp.step / sx, cols: inp.cols * sx, rows: inp.rows * sx, data: new Float32Array(inp.cols * inp.rows * sx * sx), eroded: true }));
      })
    });
    els.canvasWrap = { dataset: {}, value: "", clientWidth: 200, clientHeight: 150 } as never;
    const host = createHost(ctx);
    /* 5 万格的战略图：工作档 6×，块 8×（15 块）；不精修 */
    landWorld(ctx, normalizeWorld({ meta: { 名称: "陆", worldModel: "sphere", terrain: "plain", relief: 0.5, gridN: 280,
      bbox: { lonMin: 100, lonMax: 115, latMin: 30, latMax: 40 } } }), "s1", 3050);
    host.rebuildIfNeeded();
    const g = ctx.grid!, lon = g.bb.lonMin + 96 * g.step, lat = g.bb.latMin + 96 * g.step;
    Object.assign(ctx.view, { lon0: lon, lat0: lat, degPerPx: g.step / 16 });   // 块 6（第二行第二列）中央，一个块格两个 CSS 像素
    host.syncTiles();
    let done = false;
    void host.settled().then(() => { done = true; });
    await flush();
    assert.equal(seen.ultraCap, undefined, "分块的图不发精修单");
    assert.equal(erodePhaseSig.value, "ultra", "工作档算完、块还没到齐：报精修中");
    assert.ok(ctx.ruleField!.cols === g.cols && ruleFieldSig.value === null && !ctx.tileLayer, "屏上还是粗格，块层没上");
    const ups = seen.uploads;
    held.shift()!(); await flush();
    assert.ok(erodePhaseSig.value === "ultra" && !ctx.tileLayer && !done, "视口里那块到了也不换：等全图");
    while (held.length) { held.shift()!(); await flush(); }
    assert.equal(erodePhaseSig.value, "done", "全图的块到齐才报完成");
    assert.ok(done, "「算完了」同拍兑现");
    assert.equal(seen.uploads, ups + 1, "工作档只上传一次");
    assert.ok(ctx.ruleField!.src === "work" && ruleFieldSig.value === ctx.ruleField, "工作档同拍换上并落定");
    assert.equal(ctx.tileLayer!.tiles.size, 15, "十五块一起上屏");
    const rule0 = ctx.ruleField, t60 = ctx.tileLayer!.tiles.get(6);
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon, lat, dh: 0.2 }); }, { grid: true });
    host.rebuildIfNeeded();
    const old6 = ctx.tileLayer!.tiles.get(6), rule1 = ctx.ruleField;
    await tick(60);
    assert.equal(erodePhaseSig.value, "ultra", "新工作档到手、换了键的块还没到：不报完成");
    assert.ok(ctx.ruleField === rule1 && ctx.tileLayer!.tiles.get(6) === old6 && ruleFieldSig.value === null, "屏上还是旧解叠增量，一样都没换");
    while (held.length) { held.shift()!(); await flush(); }
    assert.equal(erodePhaseSig.value, "done");
    assert.ok(ctx.ruleField !== rule1 && ctx.tileLayer!.tiles.get(6) !== old6, "工作档与换了键的块同拍换上");
    const erodes = seen.erodes;
    undoWorld();
    host.rebuildIfNeeded();
    assert.ok(ctx.ruleField === rule0 && ruleFieldSig.value === rule0 && ctx.tileLayer!.tiles.get(6) === t60, "撤销：工作档与块都在内存，不等下一拍就换回");
    assert.equal(held.length, 0, "没有发块单");
    await tick(500);
    assert.equal(seen.erodes, erodes, "也没有发工作档单");
  });
});

/* v2 图的中尺度阶段：稳态解在独立车道上算，到了之前不发侵蚀单（先侵蚀宏观底再换形＝多一次可见换场），到了换一个带它的新 Grid 再发单 */
describe("中尺度阶段（host）", () => {
  beforeEach(() => { mock.timers.enable({ apis: ["setTimeout"] }); });
  afterEach(() => { mock.timers.reset(); });
  const V2 = (seed = 7, extra: Record<string, unknown> = {}): World => normalizeWorld({ meta: { 名称: "生", worldModel: "sphere", planetRadiusKm: 10000, terrain: "auto", genVer: 2, genSeed: seed, genStyle: "multi",
    relief: 0.7, gridN: 60, bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 }, ...extra } });
  /** 假中尺度车道：单挂起，answer 按真算放行；撤单把在飞的单以 null 收场、只数撤到了在飞单的那几次（同 routeClient） */
  function mesoRig(ctx: ShellCtx) {
    const q: { meta: Meta; geom: FieldGeom; res: (r: MesoReply | null) => void; done: boolean }[] = [];
    /* 画抬升单同一车道：holds＝车道手里留着 Sg 的那把键（假车道在中尺度单落地时记上） */
    const uq: { meta: Meta; geom: FieldGeom; cells: UpliftCells; sg: unknown; res: (r: UpliftReply | null) => void; done: boolean }[] = [];
    const st = { cancels: 0, q, uq, holds: "" };
    Object.assign(ctx.routeClient, {
      meso: (meta: Meta, geom: FieldGeom) => new Promise<MesoReply | null>(res => { q.push({ meta, geom, res, done: false }); }),
      cancelMeso: () => { const live = [...q, ...uq].filter(x => !x.done); if (live.length) st.cancels++; for (const x of live) { x.done = true; x.res(null); } st.holds = ""; },
      mesoHolds: (k: string) => k === st.holds,
      uplift: (meta: Meta, geom: FieldGeom, cells: UpliftCells, sg: unknown) => new Promise<UpliftReply | null>(res => { uq.push({ meta, geom, cells, sg, res, done: false }); })
    });
    const answer = (k: number): void => {
      const x = q[k], R = gen2Meso(x.meta, x.geom);
      x.done = true; x.res({ base: R.base, env: R.env, cls: R.cls, basin: R.basin, water: R.water, rivers: R.rivers, sg: R.sg, iters: R.iters, converged: R.converged,
        nest: { base: nestBaseOf(R.st), sol: nestSolOf(R.st, R.st.base, null) } });
      st.holds = mesoKeyOf(x.meta, x.geom);
    };
    const answerUp = (k: number): void => {
      const x = uq[k], S = mesoState(x.meta, x.geom, gen2Meso(x.meta, x.geom).sg), U = gen2Uplift(S, x.cells, riverParams(x.meta));
      x.done = true; x.res({ base: U.base, env: U.env, cls: U.cls, basin: U.basin, water: U.water, rivers: U.rivers, iters: U.iters, converged: U.converged, nest: nestSolOf(S, U.sol, U.up) });
    };
    return { st, answer, answerUp };
  }
  /** 让最近一份中尺度单以 null 收场 n 次（缺省两次＝头一回与复位后那一回） */
  async function failMeso(M: ReturnType<typeof mesoRig>, n = 2): Promise<void> {
    for (let i = 0; i < n; i++) { const x = M.st.q[M.st.q.length - 1]; x.done = true; x.res(null); await flush(); await tick(100); }
  }
  it("到之前不发侵蚀单、胶囊报计算中；到了换一个带它的新 Grid，发一单：工作档走全图嵌套解（不带包络、不精修）", async () => {
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx), host = createHost(ctx);
    landWorld(ctx, V2(), "v1", 3050);
    host.rebuildIfNeeded();
    await flush(); await tick(200);
    assert.equal(M.st.q.length, 1, "要了一份中尺度");
    assert.equal(seen.erodes, 0, "中尺度到之前不发侵蚀单");
    assert.equal(erodePhaseSig.value, "work");
    const mesoOf = () => ctx.grid!.meso;   // 读成函数：断言收窄了属性类型，await 之后 TS 仍当它是 undefined
    assert.ok(!mesoOf(), "到之前网格不带中尺度");
    const g0 = ctx.grid, v0 = cellsVerSig.value;
    M.answer(0);
    await flush(); await tick(100);
    assert.notEqual(ctx.grid, g0, "中尺度到了要换新 Grid——按实例记忆的基底不会自己刷新");
    assert.equal(cellsVerSig.value, v0 + 1, "地类换了：类型网格换代（测距按新上下文重算）");
    assert.ok(mesoOf(), "新 Grid 带着中尺度");
    const names = allComposites(), cls = mesoOf()!.cls;
    assert.ok(ctx.grid!.cells.every((row, r) => row.every((t, c) => t === names[cls[r * ctx.grid!.cols + c]])), "底稿地类按中尺度重判");
    assert.equal(seen.erodes, 1, "只发一单");
    const ne = seen.lastInp!.nest!;
    assert.ok(ne && !("mesoEnv" in seen.lastInp!), "工作档单是嵌套解、不带包络");
    assert.ok(ne.wx === 0 && ne.wy === 0 && ne.wcols === ctx.grid!.cols && ne.wrows === ctx.grid!.rows && ne.sx === 8, "全图一窗、倍率同细级侵蚀工作档（60 列＝8 倍）");
    assert.deepEqual(ne.pk, [], "没画山：校峰区为空");
    await tick(240, 6);
    assert.equal(ctx.ruleField!.cols, ctx.grid!.cols * 8, "工作档落地");
    await tick(6000);
    assert.equal(seen.ultraCap, undefined, "工作档是嵌套解的图不发精修单");
    assert.equal(ctx.elevField, ctx.ruleField, "画面＝工作档");
  });
  it("分块：中尺度到了，块单带外层裁剪（嵌套解）、不带包络；车道复位后仍没有结果时块单照旧细级侵蚀（要切割量、不带裁剪）", async (tc) => {
    const warn = tc.mock.method(console, "warn", () => {});
    for (const fail of [false, true]) {
      const { ctx, seen } = mkCtx(), M = mesoRig(ctx), tilesIn: ErodeInput[] = [];
      let carves = 0;
      Object.assign(ctx.routeClient, {
        tileLanes: 1,
        erodeCarve: async (inp: ErodeInput) => { carves++; return { data: new Float32Array(inp.cols * inp.rows), geo: { bb: inp.bb, step: inp.step, cols: inp.cols, rows: inp.rows } }; },
        erodeTile: (inp: ErodeInput) => { tilesIn.push(inp); return new Promise<ElevField | null>(() => {}); }
      });
      const host = createHost(ctx);
      landWorld(ctx, V2(7, { gridN: 280 }), "v1", 3050);   // 280 列：工作档与精修都不到 8 倍，才分块
      host.rebuildIfNeeded();
      await flush();
      if (fail) await failMeso(M); else M.answer(0);
      await flush(); await tick(240, 6); await flush();
      assert.equal(warn.mock.callCount(), fail ? 2 : 0, "没有结果每回响一声（头一回与复位后那一回），有结果不响");
      assert.ok(tilesIn.length >= 1, "发了块单");
      const t = tilesIn[0];
      if (!fail) {
        assert.ok(t.nest && !t.mesoEnv && !t.win, "嵌套解的块单"); assert.equal(carves, 0, "中尺度图不要切割量");
        const w = seen.lastWork!, ne = t.nest;   // 块还没到齐，工作档攒着没换上：取车道交出来的那份
        assert.ok(ne.tgt && ne.tsx === 6 && w.cols === ctx.grid!.cols * 6, "工作档是嵌套解（280 列＝6 倍）：块单带它的裁片当目标面");
        assert.equal(ne.tgt.length, t.cols * t.rows * 36, "裁片罩住单的整个裁剪");
        assert.equal(ne.tgt[0], w.data[(ne.y0 * 6) * w.cols + ne.x0 * 6], "裁的是到手的工作档（整数值量化后不变）");
        assert.equal(ne.pk, null, "块单不校峰");
      }
      else { assert.ok(!t.nest && t.win, "宏观底的块单照旧"); assert.equal(carves, 1); }
    }
  });
  it("车道复位一次后仍没有结果（null）：这张图照旧用宏观底发单，不再等、不再要", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx), host = createHost(ctx);
    landWorld(ctx, V2(), "v1", 3050);
    host.rebuildIfNeeded();
    await flush();
    await failMeso(M);
    assert.equal(warn.mock.callCount(), 2, "头一回与复位后各响一声");
    assert.match(warn.mock.calls[1].arguments.join(""), /中尺度稳态没有结果.*车道不可用/);
    assert.equal(seen.erodes, 1);
    assert.ok(!("mesoEnv" in seen.lastInp!), "宏观底的单不带包络");
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuild(); await flush(); await tick(100);
    assert.equal(M.st.q.length, 2, "复位过又失败的键不再要");
    assert.equal(seen.erodes, 2, "编辑照常发单");
    const v1 = cellsVerSig.value;
    mutateWorld(w => { w.heightOverrides!.push({ lon: 100.15, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuild(); await flush(); await tick(100);
    assert.equal(cellsVerSig.value, v1, "只动高程涂改：类型格没换，不换代");
    assert.equal(warn.mock.callCount(), 2, "失败过的键不再要，也不再响");
  });
  it("换生成参数：在飞的单撤掉、按新键再要；撤掉的单不落地", async () => {
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx), host = createHost(ctx);
    landWorld(ctx, V2(7), "v1", 3050);
    host.rebuildIfNeeded();
    await flush();
    landWorld(ctx, V2(8), "v1", 3050);
    host.rebuildIfNeeded();
    await flush(); await tick(200);
    assert.equal(M.st.cancels, 1, "旧键的单撤了");
    assert.equal(M.st.q.length, 2, "按新键再要");
    assert.equal(seen.erodes, 0, "撤掉的单以 null 收场，不该被当成失败放行侵蚀");
    M.answer(1);
    await flush(); await tick(100);
    assert.equal(ctx.grid!.meso!.base.length, ctx.grid!.cols * ctx.grid!.rows);
    assert.equal(seen.erodes, 1);
  });
  it("等中尺度期间的高程笔：照常重建、不发单；中尺度到了才发一单，单里带涂改", async () => {
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx), host = createHost(ctx);
    landWorld(ctx, V2(), "v1", 3050);
    host.rebuildIfNeeded();
    await flush();
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuild(); await flush(); await tick(200);
    assert.equal(seen.erodes, 0);
    M.answer(0);
    await flush(); await tick(100);
    assert.equal(seen.erodes, 1);
    assert.ok(seen.lastInp!.hovGrid.some(v => v !== 0), "单里带着等待期间落的笔");
  });

  /* 画抬升：开图到中尺度与工作档都落地，返回一处陆格的经纬（涂在它上面） */
  async function openV2(ctx: ShellCtx, M: ReturnType<typeof mesoRig>, extra: Record<string, unknown> = {}) {
    const host = createHost(ctx);
    landWorld(ctx, V2(7, extra), "v1", 3050);
    host.rebuildIfNeeded();
    await flush();
    M.answer(0);
    await flush(); await tick(240, 6);
    const g = ctx.grid!, r = g.rows >> 1;
    let c = g.cols >> 1;
    while (g.cells[r][c].startsWith("water")) c++;
    return { host, lon: g.bb.lonMin + (c + 0.5) * g.step, lat: g.bb.latMin + (r + 0.5) * g.step };
  }
  const paint = (lon: number, lat: number, peakM: number): void =>
    mutateWorld(w => { w.upliftOverrides = [...(w.upliftOverrides || []).filter(o => o.lon !== lon || o.lat !== lat), { lon, lat, peakM }]; }, { grid: true });

  it("画抬升：解到之前屏上不动、不发侵蚀单；解到了换带它的新 Grid、地类随新基底重判，发一单，单里带抬升后的包络", async () => {
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx);
    const { host, lon, lat } = await openV2(ctx, M);
    const g0 = ctx.grid!, sgF = g0.meso!, erodes0 = seen.erodes, rule0 = ctx.ruleField;
    paint(lon, lat, 3000); host.rebuild();
    await flush(); await tick(200);
    assert.equal(M.st.uq.length, 1, "要了一份画抬升");
    assert.equal(M.st.uq[0].sg, null, "车道留着 Sg：单里不带");
    assert.equal(ctx.grid, g0, "解到之前沿用屏上那份 Grid");
    assert.equal(ctx.ruleField!.data, rule0!.data, "画面不画草稿");
    assert.equal(seen.erodes, erodes0, "解到之前不发侵蚀单");
    M.answerUp(0);
    await flush(); await tick(100);
    assert.notEqual(ctx.grid, g0, "解到了换新 Grid");
    const g = ctx.grid!, at = (gg: typeof g) => terrainProps(gg.cells[Math.floor((lat - gg.bb.latMin) / gg.step)][Math.floor((lon - gg.bb.lonMin) / gg.step)]).lf;
    assert.notEqual(g.cells, g0.cells, "格随新底稿重建（换新数组，寻路上下文才会重发）");
    assert.ok(at(g) === "mountain" || at(g) === "alpine", `画到 3000 m 的格地类是 ${at(g)}`);
    assert.notEqual(ctx.grid!.meso, sgF);
    assert.equal(seen.erodes, erodes0 + 1, "发一单");
    const ne = seen.lastInp!.nest!;
    assert.ok(ne.du && ne.pk!.length === 1 && ne.pk![0].T === 3000, "单里是画抬升的解：带抬升、一个校峰区、目标 3000 m");
  });
  it("画盆地走同一车道：盆底改了（格不变）也要再要一份解，不当成解过的那份", async () => {
    const { ctx } = mkCtx(), M = mesoRig(ctx);
    const { host, lon, lat } = await openV2(ctx, M);
    const basin = (floorM: number): void => mutateWorld(w => { w.upliftOverrides = [{ lon, lat, floorM }]; }, { grid: true });
    basin(200); host.rebuild(); await flush(); await tick(200);
    assert.equal(M.st.uq.length, 1);
    assert.deepEqual(Array.from(M.st.uq[0].cells.floorM!), [200]);
    M.answerUp(0); await flush(); await tick(100);
    basin(-100); host.rebuild(); await flush(); await tick(200);
    assert.equal(M.st.uq.length, 2, "盆底变了要再要");
    assert.deepEqual(Array.from(M.st.uq[1].cells.floorM!), [-100]);
  });
  it("连笔：在飞时只记最新那份，落地后补发最新的；撤销回到解过的那份直接换上、不再要", async () => {
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx);
    const { host, lon, lat } = await openV2(ctx, M);
    for (const pk of [1000, 2000, 3000]) { paint(lon, lat, pk); host.rebuild(); await flush(); }
    assert.equal(M.st.uq.length, 1, "在飞时不再发");
    M.answerUp(0);
    await flush(); await tick(100);
    assert.equal(M.st.uq.length, 2, "落地后补发一单");
    assert.equal(M.st.uq[1].cells.peakM[0], 3000, "补发的是最新那份");
    M.answerUp(1);
    await flush(); await tick(240, 6);
    const f3 = ctx.grid!.meso;
    undoWorld(); host.rebuildIfNeeded(); await flush(); await tick(100);
    assert.equal(M.st.uq.length, 3, "撤到 2000：这份没解过（在飞时被 3000 顶掉），再要");
    assert.equal(ctx.grid!.meso, f3, "解到之前屏上沿用 3000 那份");
    undoWorld(); host.rebuildIfNeeded(); await flush(); await tick(100);
    assert.equal(M.st.uq.length, 3, "撤到 1000：解过，直接换上");
    assert.notEqual(ctx.grid!.meso, f3);
    const erodes = seen.erodes;
    redoWorld(); redoWorld(); host.rebuildIfNeeded(); await flush(); await tick(100);
    assert.equal(ctx.grid!.meso, f3, "重做回 3000：直接换上同一份解");
    assert.equal(M.st.uq.length, 3, "不再要");
    assert.equal(seen.erodes, erodes, "3000 那份的工作档落地过：同步换上、不发单");
    assert.equal(ruleFieldSig.value, ctx.ruleField, "同拍落定");
  });
  it("手动档画盆地成湖：侵蚀的格没有湖、屏上的格有，规则场在新湖格上压到水面以下（画成水）", async () => {
    const { ctx } = mkCtx(), M = mesoRig(ctx);
    const { host } = await openV2(ctx, M, { erode: "base" });
    await tick(6000);
    /* 湿处画一片盆：取细格水汽最大、周围全陆的低地 */
    const g0 = ctx.grid!, st = mesoState(ctx.meta, { bb: g0.bb, step: g0.step, cols: g0.cols, rows: g0.rows }, gen2Meso(ctx.meta, g0).sg), out = st.pr.inp.out, fM = st.pr.fM, { cols, rows } = g0;
    let k0 = -1;
    for (let r = 3; r < rows - 3; r++) for (let c = 3; c < cols - 3; c++) {
      let ok = true; for (let dr = -2; dr <= 2 && ok; dr++) for (let dc = -2; dc <= 2; dc++) if (out[(r + dr) * cols + c + dc]) { ok = false; break; }
      if (ok && (k0 < 0 || fM[r * cols + c] > fM[k0])) k0 = r * cols + c;
    }
    const ups: { lon: number; lat: number; floorM: number }[] = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const r = ((k0 / cols) | 0) + dr, c = (k0 % cols) + dc;
      ups.push({ lon: +(g0.bb.lonMin + (c + 0.5) * g0.step).toFixed(4), lat: +(g0.bb.latMin + (r + 0.5) * g0.step).toFixed(4), floorM: 100 });
    }
    mutateWorld(w => { w.upliftOverrides = ups; }, { grid: true });
    host.rebuild(); await flush(); await tick(200);
    M.answerUp(M.st.uq.length - 1);
    await flush(); await tick(500);
    const g = ctx.grid!, ws = waterSurface(ctx.meta, g), f = ctx.ruleField!, kx = f.cols / g.cols;
    let lakes = 0, dry = 0;
    for (let i = 0; i < g.cols * g.rows; i++) {
      if (out[i] || terrainProps(g.cells[(i / g.cols) | 0][i % g.cols]).lf !== "water") continue;
      lakes++;
      const fr = ((i / g.cols) | 0) * kx + (kx >> 1), fc = (i % g.cols) * kx + (kx >> 1);
      if (!(f.data[fr * f.cols + fc] < ws[i] - 0.02)) dry++;
    }
    assert.ok(lakes > 0, `前提：湿处的盆成湖 ${JSON.stringify(g.meso!.water && g.meso!.water.list)}`);
    assert.strictEqual(dry, 0, `新湖格里有 ${dry} 格规则场高过水面（会画成陆）`);
  });
  it("手动档：侵蚀单取只带 Sg 的 Grid；解到了不撤单、不发单，规则场＝工作档叠抬升增量、立即落定", async () => {
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx);
    const { host, lon, lat } = await openV2(ctx, M, { erode: "base" });
    await tick(6000);
    const sgF = ctx.grid!.meso!, work = ctx.ruleField!, erodes0 = seen.erodes;
    assert.ok(seen.lastInp!.nest && !seen.lastInp!.nest.du && seen.lastInp!.hovGrid.every(v => v === 0), "前置：工作档出自 Sg（嵌套解，不带抬升与涂改）");
    assert.equal(ctx.elevField, ctx.ruleField, "前置：不精修，画面＝工作档");
    paint(lon, lat, 3000); host.rebuild();
    await flush(); await tick(200);
    M.answerUp(0);
    await flush(); await tick(500);
    assert.notEqual(ctx.grid!.meso, sgF, "屏上换成画抬升的解");
    assert.equal(seen.erodes, erodes0, "侵蚀输入没变：不发单");
    assert.equal(ctx.elevField, ctx.ruleField, "画面＝规则场");
    assert.notEqual(ctx.ruleField!.data, work.data, "规则场＝工作档叠抬升增量");
    assert.equal(ruleFieldSig.value, ctx.ruleField, "立即落定");
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon, lat, dh: 0.2 }); }, { grid: true });
    host.rebuild(); await flush(); await tick(500);
    assert.equal(seen.erodes, erodes0, "抬升在屏时再落旧式涂改：侵蚀的 Grid 仍是 Sg 那个，照旧走早退支");
    yearSig.value = 3051; host.rebuildIfNeeded(); await flush(); await tick(200);
    assert.ok(seen.erodes > erodes0, "拨年＝换网格，走全路径发单");
    assert.ok(seen.lastInp!.nest && !seen.lastInp!.nest.du, "全路径的单也取只带 Sg 的 Grid（侵蚀不看笔）");
    assert.notEqual(ctx.grid!.meso, sgF, "屏上仍是画抬升的解");
  });
  it("手动档：画抬升等解时改了地貌（单被扣着），解到了补发那一单、落地才落定", async () => {
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx);
    const { host, lon, lat } = await openV2(ctx, M, { erode: "base" });
    const erodes0 = seen.erodes;
    paint(lon, lat, 3000); host.rebuild(); await flush();
    assert.ok(ruleFieldSig.value === ctx.ruleField, "前置：侵蚀的 Grid 没换，照旧落定");
    mutateWorld(w => { w.terrainOverrides = [...w.terrainOverrides, { lon, lat, t: "hill" }]; }, { grid: true });
    host.rebuild(); await flush(); await tick(200);
    assert.equal(seen.erodes, erodes0, "抬升还没解到：单扣着");
    assert.ok(ruleFieldSig.value === null, "演算中");
    M.answerUp(0);
    await flush(); await tick(100);
    assert.equal(seen.erodes, erodes0 + 1, "解到了：补发地貌改过的那一单");
    assert.ok(!seen.lastInp!.nest!.du, "单取只带 Sg 的 Grid");
    assert.ok(ruleFieldSig.value === ctx.ruleField, "落地才落定");
  });
  it("手动档点「侵蚀」把画的山收进去：单取带抬升的 Grid；之后再画，侵蚀看到的仍是收进去那份——不发单、那份解不随后来的解轮换掉", async () => {
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx);
    const { host, lon, lat } = await openV2(ctx, M, { erode: "base" });
    await tick(6000);
    const erodes0 = seen.erodes;
    paint(lon, lat, 3000); host.rebuild(); await flush(); await tick(200);
    M.answerUp(0); await flush(); await tick(500);
    assert.equal(seen.erodes, erodes0, "前置：没点侵蚀，画的山不进侵蚀");
    mutateWorld(w => { foldIntoErosion(w); }, { grid: true });
    host.rebuildIfNeeded(); await flush(); await tick(500);
    assert.equal(seen.erodes, erodes0 + 1, "点侵蚀：发一单");
    assert.ok(seen.lastInp!.nest && seen.lastInp!.nest.du, "单取带抬升的 Grid");
    assert.equal(M.st.uq.length, 1, "屏上已有这份解：不重解");
    const g1 = ctx.grid;
    /* 侵蚀看到的抬升钉在收进去那一份上（界面上「应用」总是连抬升一起收，这种分叉只在存档里带着记录时出现），屏上的再改五回 */
    mutateWorld(w => { w.baseOverrides = { uplift: w.upliftOverrides }; }, { grid: true });
    host.rebuildIfNeeded(); await flush(); await tick(300);
    assert.equal(seen.erodes, erodes0 + 1, "钉的就是现状：侵蚀输入没变");
    for (let i = 1; i <= 5; i++) {   // 多过留着的解数：收进去那份若只靠最近几份留着，这里就被挤掉了
      paint(lon, lat, 3000 + 200 * i);
      host.rebuild(); await flush(); await tick(200);
      M.answerUp(M.st.uq.length - 1); await flush(); await tick(300);
    }
    assert.equal(M.st.uq.length, 6, "每笔只解屏上那一份");
    assert.equal(seen.erodes, erodes0 + 1, "侵蚀看到的还是收进去那份：不发单");
    assert.notEqual(ctx.grid, g1, "屏上换成新画的解");
    assert.equal(ruleFieldSig.value, ctx.ruleField, "立即落定");
    assert.deepEqual(worldSig.value!.baseOverrides, { uplift: [{ lon, lat, peakM: 3000 }] });
    yearSig.value = 3051; host.rebuildIfNeeded(); await flush(); await tick(300);
    assert.equal(M.st.uq.length, 6, "拨年：两份解都在手，不重解");
    assert.equal(seen.erodes, erodes0 + 2);
    assert.ok(seen.lastInp!.nest!.du, "全路径的单仍取收进去那份抬升");
    undoWorld(); undoWorld(); undoWorld(); undoWorld(); undoWorld(); undoWorld();
    host.rebuildIfNeeded(); await flush(); await tick(300);
    assert.equal(M.st.uq.length, 6, "撤回到刚点完侵蚀：屏上与侵蚀看到的是同一份，就是留着的那份");
  });
  it("造山的草稿不动地形；点「应用」才解中尺度，接着发的侵蚀单只多了抬升——手雕高程与没收进去的地貌涂改都不在单里", async () => {
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx);
    const { host, lon, lat } = await openV2(ctx, M, { erode: "base" });
    await tick(6000);
    mutateWorld(w => { paintHeightPath(w, ctx.grid!, [[lon, lat + ctx.grid!.step * 3]], 0.05, 1, null); }, { grid: true }); host.rebuild();
    mutateWorld(w => { paintTerrainPath(w, ctx.grid!, 3050, [[lon + ctx.grid!.step * 3, lat]], "hill", 1, false, null, "lf"); }, { grid: true }); host.rebuild();
    await flush(); await tick(300);
    const erodes0 = seen.erodes, g0 = ctx.grid, rule0 = ctx.ruleField, elev0 = seen.lastInp!.elev0.slice();
    mutateWorld(w => { paintUpliftPath(w, ctx.grid!, 3050, [[lon, lat]], { peakM: 3000 }, 2, false); });
    host.rebuildIfNeeded(); await flush(); await tick(500);
    assert.ok(worldSig.value!.upliftDraft && !worldSig.value!.upliftOverrides, "前置：只有草稿");
    assert.equal(M.st.uq.length, 0, "草稿不解中尺度");
    assert.ok(ctx.grid === g0 && ctx.ruleField === rule0 && seen.erodes === erodes0, "地形、规则场与侵蚀单都没动");
    mutateWorld(w => { assert.ok(applyUplift(w)); }, { grid: true });
    host.rebuildIfNeeded(); await flush(); await tick(200);
    assert.equal(M.st.uq.length, 1, "应用：要了一份解");
    assert.equal(seen.erodes, erodes0, "解回来之前不发单");
    assert.equal(erodePhaseSig.value, "work", "等解的这一会儿胶囊已经亮了");
    M.answerUp(0); await flush(); await tick(500);
    assert.equal(seen.erodes, erodes0 + 1, "解到了：发一单");
    assert.ok(seen.lastInp!.nest && seen.lastInp!.nest.du, "单里带抬升");
    assert.ok(seen.lastInp!.hovGrid.every(v => v === 0), "手雕高程没被顺带收进去");
    const gE = ctx.grid!, k = Math.floor((lat - gE.bb.latMin) / gE.step) * gE.cols + Math.floor((lon + gE.step * 3 - gE.bb.lonMin) / gE.step);
    assert.equal(terrainProps(gE.cells[(k / gE.cols) | 0][k % gE.cols]).lf, "hill", "前置：屏上那格是涂的丘陵");
    assert.notEqual(seen.lastInp!.elev0[k], baseElev(ctx.meta, gE)[k], "单里那格还是涂之前的地貌（地貌涂改没被顺带收进去）");
    assert.deepEqual(worldSig.value!.baseOverrides, { height: [], terrain: [] }, "只删了抬升那一轴");
    assert.equal(ruleFieldSig.value, ctx.ruleField, "落地即落定");
    undoWorld(); host.rebuildIfNeeded(); await flush(); await tick(500);
    assert.ok(worldSig.value!.upliftDraft && !worldSig.value!.upliftOverrides, "撤销应用：回到只有草稿");
    assert.equal(seen.erodes, erodes0 + 1, "换回最近落地过的那份，不发单");
  });
  it("生成的河跟着中尺度场：落地就把带标记的河换成它抽的、手画的留着、不推撤销；同一份再核零写入；删掉的不回来", async () => {
    const { ctx } = mkCtx(), M = mesoRig(ctx), host = createHost(ctx), w0 = V2();
    w0.edges.push({ type: "river", pts: [[90, 30], [91, 31]], widthM: 50, gen: true }, { type: "river", pts: [[100, 40], [101, 41]] });   // 存档里的旧生成河与一条手画的
    landWorld(ctx, w0, "v1", 3050);
    host.rebuildIfNeeded(); await flush(); await tick(200);
    assert.equal(worldSig.value!.edges.length, 2, "中尺度到之前留着存档里的河");
    const undo0 = canUndoSig.value;
    M.answer(0); await flush(); await tick(100);
    const want = genRiverEdgesOf(ctx.meta, gen2Meso(ctx.meta, gridGeom(ctx.meta)).rivers, undefined), gen = worldSig.value!.edges.filter(e => e.gen);
    assert.ok(want.length > 5);
    assert.deepStrictEqual(gen, want, "带标记的河换成中尺度抽的");
    assert.ok(worldSig.value!.edges.some(e => !e.gen && e.pts![0][0] === 100), "手画的留着");
    assert.equal(canUndoSig.value, undo0, "不推撤销：河是场的函数，撤销换回旧场、河跟着换回");
    const v = editVerSig.value;
    host.rebuild(); await flush(); await tick(100);
    assert.equal(editVerSig.value, v, "同一份再核：零写入（开图不白存一次）");
    deleteEdgeIdx(worldSig.value!.edges.indexOf(gen[0]));
    host.rebuildIfNeeded(); await flush();
    assert.equal(worldSig.value!.edges.filter(e => e.gen).length, gen.length - 1, "删掉的不回来");
  });
  it("笔画中途不换河（会让空笔回收误判），收笔后再换；只读态不换", async () => {
    const { ctx } = mkCtx(), M = mesoRig(ctx), host = createHost(ctx);
    landWorld(ctx, V2(), "v1", 3050);
    host.rebuildIfNeeded(); await flush(); await tick(200);
    beginStroke();
    M.answer(0); await flush(); await tick(100);
    assert.equal(worldSig.value!.edges.length, 0, "笔画中途不写");
    endStroke(); await tick(300);
    assert.ok(worldSig.value!.edges.length > 5, "收笔后换上");
    const { ctx: c2 } = mkCtx(), M2 = mesoRig(c2), h2 = createHost(c2);
    readOnlySig.value = true;
    try {
      landWorld(c2, V2(), "v2", 3050);
      h2.rebuildIfNeeded(); await flush(); await tick(200);
      M2.answer(0); await flush(); await tick(300);
      assert.equal(worldSig.value!.edges.length, 0, "只读态不写");
    } finally { readOnlySig.value = false; }
  });
  it("挪河流滑杆：地形不重建，用同一份格子再要一单、只换河；车道不可用时存档里的河不动、零写入", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const { ctx } = mkCtx(), M = mesoRig(ctx), host = createHost(ctx);
    landWorld(ctx, V2(), "v1", 3050);
    host.rebuildIfNeeded(); await flush(); await tick(200);
    M.answer(0); await flush(); await tick(100);
    const n0 = worldSig.value!.edges.length, g0 = ctx.grid;
    mutateWorld(w => { w.meta.genRiv = 1; });
    host.rebuildIfNeeded(); await flush();
    assert.equal(ctx.grid, g0, "地形不重建");
    assert.equal(M.st.uq.length, 1, "要了一单重抽");
    assert.equal(M.st.uq[0].cells.idx.length, 0, "零个区＝中尺度那份地形");
    M.answerUp(0); await flush(); await tick(10);
    assert.ok(worldSig.value!.edges.length > n0, `河流多少拉满：${n0} → ${worldSig.value!.edges.length} 条`);
    const { ctx: c2 } = mkCtx(), M2 = mesoRig(c2), h2 = createHost(c2);
    landWorld(c2, V2(), "v2", 3050);
    h2.rebuildIfNeeded(); await flush();
    assert.equal(warn.mock.callCount(), 0, "有结果的那张图不响");
    assert.ok(genRiverEdges(c2.meta, undefined).length > 0, "前提：宏观河网有河可顶替");
    const v = editVerSig.value;
    for (const k of [0, 1]) { M2.st.q[k].done = true; M2.st.q[k].res(null); await flush(); await tick(100); }
    assert.equal(warn.mock.callCount(), 2, "没有结果、复位后又没有结果，各响一声");
    assert.deepStrictEqual(worldSig.value!.edges, [], "中尺度不可用：存档里的河不动（不拿宏观河顶替）");
    assert.equal(editVerSig.value, v, "零写入");
    mutateWorld(w => { w.meta.genRiv = 1; });
    h2.rebuildIfNeeded(); await flush(); await tick(100);
    assert.equal(editVerSig.value, v + 1, "挪滑杆只有它自己那一笔，河不跟着写");
    assert.equal(M2.st.uq.length, 0, "没有中尺度场：不要重抽单");
  });
  const oldGenRiver = (): World["edges"][number] => ({ type: "river", pts: [[90, 30], [91, 31]], widthM: 50, gen: true });
  it("车道头一回没有结果：复位再要一次、侵蚀照旧等；到了照常换场换河，不报不可用", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx), host = createHost(ctx), w0 = V2();
    w0.edges.push(oldGenRiver());
    landWorld(ctx, w0, "v1", 3050);
    host.rebuildIfNeeded(); await flush();
    await failMeso(M, 1);
    assert.equal(warn.mock.callCount(), 1, "没有结果要响一声");
    assert.match(warn.mock.calls[0].arguments.join(""), /中尺度稳态没有结果.*复位/);
    assert.equal(M.st.q.length, 2, "复位后按同一把键再要");
    assert.equal(seen.erodes, 0, "侵蚀照旧等");
    assert.equal(erodePhaseSig.value, "work", "胶囊照报计算中");
    assert.equal(mesoDownSig.value, false, "复位还没用完：不报不可用");
    M.answer(1);
    await flush(); await tick(100);
    assert.ok(ctx.grid!.meso, "到了换上中尺度");
    assert.equal(seen.erodes, 1);
    assert.equal(mesoDownSig.value, false);
    assert.deepStrictEqual(worldSig.value!.edges.filter(e => e.gen), genRiverEdgesOf(ctx.meta, gen2Meso(ctx.meta, gridGeom(ctx.meta)).rivers, undefined), "河照常换成中尺度的");
  });
  it("复位后又没有结果：报不可用；存档里的河不动、零写入；侵蚀在宏观底上照常落定；同一把键不再要", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx), host = createHost(ctx), w0 = V2();
    w0.edges.push(oldGenRiver());
    landWorld(ctx, w0, "v1", 3050);
    const v = editVerSig.value, edges0 = worldSig.value!.edges;
    host.rebuildIfNeeded(); await flush();
    await failMeso(M);
    assert.equal(warn.mock.callCount(), 2, "两次没有结果各响一声");
    assert.match(warn.mock.calls[1].arguments.join(""), /中尺度稳态没有结果.*宏观底/);
    assert.equal(mesoDownSig.value, true, "报不可用");
    assert.equal(editVerSig.value, v, "世界零写入（不触发自动保存）");
    assert.equal(worldSig.value!.edges, edges0, "存档里的河原样：带标记的生成河没被宏观河替换");
    assert.ok(!ctx.grid!.meso, "屏上是宏观底");
    assert.equal(seen.erodes, 1, "侵蚀不再等，在宏观底上发单");
    assert.ok(!seen.lastInp!.nest && !("mesoEnv" in seen.lastInp!), "宏观底的单：不是嵌套解、不带包络");
    await tick(240, 6);
    assert.ok(ruleFieldSig.value === ctx.ruleField && ctx.ruleField!.src === "work", "工作档照常落定");
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuild(); await flush(); await tick(100);
    assert.equal(M.st.q.length, 2, "同一把键不再要");
    assert.equal(mesoDownSig.value, true, "编辑之后照旧报不可用");
    assert.equal(warn.mock.callCount(), 2, "不再要也不再响");
  });
  it("不可用之后：换图即清；重开同一张图再试一次；换了生成参数再试，到了不报、河换成中尺度的", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const { ctx } = mkCtx(), M = mesoRig(ctx), host = createHost(ctx);
    landWorld(ctx, V2(), "v1", 3050);
    host.rebuildIfNeeded(); await flush();
    await failMeso(M);
    assert.equal(mesoDownSig.value, true, "前置：不可用");
    landWorld(ctx, W(), "t1", 3050);
    host.rebuildIfNeeded(); await flush();
    assert.equal(mesoDownSig.value, false, "换成别的图：清掉");
    landWorld(ctx, V2(), "v1", 3050);
    host.rebuildIfNeeded(); await flush();
    assert.equal(M.st.q.length, 3, "重开同一张图：同一把键再要");
    assert.equal(mesoDownSig.value, false, "再试期间不报不可用");
    await failMeso(M);
    assert.equal(M.st.q.length, 4, "重开也只复位一次");
    assert.equal(mesoDownSig.value, true);
    mutateWorld(w => { w.meta.genSeed = 8; }, { grid: true });
    host.rebuildIfNeeded(); await flush();
    assert.equal(M.st.q.length, 5, "换了生成参数：按新键再要");
    assert.equal(mesoDownSig.value, false, "新键不报不可用");
    M.answer(4);
    await flush(); await tick(100);
    assert.ok(ctx.grid!.meso, "到了换上中尺度");
    assert.equal(mesoDownSig.value, false);
    assert.deepStrictEqual(worldSig.value!.edges.filter(e => e.gen), genRiverEdgesOf(ctx.meta, gen2Meso(ctx.meta, gridGeom(ctx.meta)).rivers, undefined), "河换成中尺度的");
    assert.equal(warn.mock.callCount(), 4, "每次没有结果各响一声");
  });
  it("解不出：这一份不再等也不再要，侵蚀放行、屏上回到 Sg；下一笔照常再要", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx);
    const { host, lon, lat } = await openV2(ctx, M);
    const sgF = ctx.grid!.meso, erodes0 = seen.erodes;
    paint(lon, lat, 3000); host.rebuild();
    await flush();
    M.st.uq[0].done = true; M.st.uq[0].res(null);
    await flush(); await tick(100);
    assert.equal(warn.mock.callCount(), 1, "解不出要响一声");
    assert.match(warn.mock.calls[0].arguments.join(""), /画抬升没有解出.*车道不可用/);
    assert.equal(ctx.grid!.meso, sgF);
    assert.equal(seen.erodes, erodes0 + 1, "侵蚀放行");
    host.rebuild(); await flush(); await tick(100);
    assert.equal(M.st.uq.length, 1, "同一份不再要");
    const erodes1 = seen.erodes;
    paint(lon, lat, 2000); host.rebuild(); await flush(); await tick(100);
    assert.equal(M.st.uq.length, 2, "下一笔照常再要");
    assert.equal(seen.erodes, erodes1, "在等这一笔：不发单");
  });
  it("工作档嵌套解与本机内存无关：两种 deviceMemory 下工作档单同键、都不发精修单", async () => {
    const nav = navigator as { deviceMemory?: number }, keys: string[] = [];
    try {
      for (const dm of [16, 4]) {
        nav.deviceMemory = dm;
        const { ctx, seen } = mkCtx(), M = mesoRig(ctx);
        await openV2(ctx, M);
        await tick(6000);
        assert.ok(seen.lastInp!.nest, "工作档单是嵌套解");
        assert.equal(seen.ultraCap, undefined, `deviceMemory ${dm}：不发精修单`);
        keys.push(erodeKey(seen.lastInp!));
      }
    } finally { delete nav.deviceMemory; }
    assert.equal(keys[0], keys[1], "工作档单（读数、等高线的来源）随本机内存变了");
  });
  it("关闭档：中尺度到了也不发工作档单（嵌套解也不跑），规则场是粗格且立即落定", async () => {
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx), host = createHost(ctx);
    landWorld(ctx, V2(7, { erode: "none" }), "v1", 3050);
    host.rebuildIfNeeded();
    await flush();
    M.answer(0);
    await flush(); await tick(240, 6); await tick(6000);
    assert.ok(ctx.grid!.meso, "中尺度照常到（底稿要它）");
    assert.equal(seen.erodes, 0, "关闭档不发单");
    assert.equal(ctx.ruleField!.cols, ctx.grid!.cols, "规则场是粗格");
    assert.equal(ruleFieldSig.value, ctx.ruleField, "立即落定");
  });
});

/* 类型层的锁（tsc 即门禁，函数不运行）：画面场、没过工作档车道的侵蚀产出、块层裁出来的场都传不进规则侧；
   哪一条不再报错，就是规则场与画面场又能互换了 */
export function ruleFieldTypeLocks(ctx: ShellCtx, meta: Meta, raw: ElevField): void {
  // @ts-expect-error 画面场可能是精修档
  ruleFieldSig.value = ctx.elevField;
  // @ts-expect-error
  ctx.ruleField = ctx.elevField;
  // @ts-expect-error
  viewFieldOf(meta, ctx.elevField!, ctx.grid!);
  // @ts-expect-error
  contourStepOf(meta, 1, ctx.grid, ctx.elevField, null, ctx.grid!.bb);
  // @ts-expect-error 侵蚀产出没过工作档车道
  ruleFieldSig.value = raw;
  // @ts-expect-error 块层裁出来的场
  viewFieldOf(meta, tileField(ctx.tileLayer!.geom, 0, ctx.tileLayer!.tiles.get(0)!), ctx.grid!);
  // @ts-expect-error 渲染器的规则份必传
  ctx.R!.uploadGrid(ctx.grid!, new Float32Array(0), raw);
}
