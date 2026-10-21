/* host 的高程场记账（「高程成为数据」）：规则场 ctx.ruleField 只认工作档，精修档只进画面 ctx.elevField。
   fake routeClient 按输入预算返回可辨认的场（数据整幅填 cap），fake 渲染器记下最近一次上传的（画面, 规则）对；
   静置窗 6s 用 node:test 的 mock timers 拨过。node 下无 indexedDB＝场缓存恒未命中，走的是真算分支。 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHost } from "../src/shell/host.ts";
import { landWorld } from "../src/shell/orchestrate.ts";
import { genRiverEdges, genRiverEdgesOf, normalizeWorld } from "../src/core/world.ts";
import { gridGeom } from "../src/core/grid.ts";
import { beginStroke, canUndoSig, cellsVerSig, deleteEdgeIdx, editVerSig, endStroke, erodePhaseSig, mutateWorld, readOnlySig, redoWorld, ruleFieldSig, undoWorld, worldSig, yearSig } from "../src/ui/state.ts";
import type { ShellCtx } from "../src/shell/ctx.ts";
import { waterSurface, type ElevField } from "../src/core/elev.ts";
import { erodeKey, type ErodeInput } from "../src/core/erode.ts";
import type { Edge, Meta, World } from "../src/core/types.ts";
import type { FieldGeom } from "../src/core/elev.ts";
import { gen2Meso, gen2Uplift, mesoKey as mesoKeyOf, mesoState, riverParams, type UpliftCells } from "../src/core/gen2.ts";
import { nestBaseOf, nestSolOf } from "../src/core/nested.ts";
import type { MesoReply, UpliftReply } from "../src/worker/routeProto.ts";
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
interface Seen { field?: ElevField; rule?: ElevField; workCap?: number; ultraCap?: number; holdUltra?: boolean; holdErode?: boolean; cancels: number; erodeCancels: number; erodes: number; lastInp?: ErodeInput; release?: (f: ElevField | null) => void; releaseE?: (f: ElevField | null) => void }
function mkCtx(): { ctx: ShellCtx; seen: Seen } {
  const seen: Seen = { cancels: 0, erodeCancels: 0, erodes: 0 };
  const ctx = {
    canvas: {}, ov: {},
    routeClient: {
      setContext: () => {},
      erode: (inp: ErodeInput) => {
        seen.workCap = inp.cap; seen.erodes++; seen.lastInp = inp;
        return seen.holdErode ? new Promise<ElevField | null>(res => { seen.releaseE = res; }) : Promise.resolve(fakeField(inp, inp.nest ? inp.nest.sx : 2));
      },
      cancelErode: () => { if (seen.releaseE) { seen.erodeCancels++; seen.releaseE(null); seen.releaseE = undefined; } },
      erodeUltra: (inp: ErodeInput) => {
        seen.ultraCap = inp.cap;
        return seen.holdUltra ? new Promise<ElevField | null>(res => { seen.release = res; }) : Promise.resolve(fakeField(inp, 4));
      },
      cancelUltra: () => { if (seen.release) { seen.cancels++; seen.release(null); seen.release = undefined; } }
    },
    DPR: 1, meta: {}, view: { lon0: 100.05, lat0: 30.05, degPerPx: 0.001 },
    grid: null, elevField: null, ruleField: null,
    R: { uploadGrid: (_g: unknown, _ws: unknown, field: ElevField, rule: ElevField) => { seen.field = field; seen.rule = rule; }, uploadTiles: () => {} },
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
/** 开图到精修落地的整段：粗格 → 工作档（渐变 240ms）→ 静置 6s → 精修 */
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

  it("开图：规则场先是粗格、工作档落地后换真；精修落地只换画面，规则场与渲染器的规则份不动", async () => {
    const { ctx, seen } = mkCtx();
    const host = createHost(ctx);
    landWorld(ctx, W(), "t1", 3050);
    host.rebuildIfNeeded();
    const coarse = ctx.ruleField!;
    assert.equal(coarse.cols, ctx.grid!.cols, "落地前规则场＝粗格场");
    assert.equal(ctx.elevField, coarse, "画面同一份");
    await flush();
    const work = ctx.ruleField!;
    assert.equal(work.cols, ctx.grid!.cols * 2, "工作档落地＝规则场换成 2× 细分场");
    assert.equal(work.data[0], seen.workCap, "规则场出自工作档预算");
    assert.notEqual(ctx.elevField, work, "画面走渐变，落地一拍不硬切");
    await tick(240, 6);
    assert.equal(ctx.elevField, work, "渐变末帧＝工作档引用");
    await tick(6000);
    const ultra = ctx.elevField!;
    assert.equal(ultra.cols, ctx.grid!.cols * 4, "静置后画面＝精修场（4×）");
    assert.equal(ultra.data[0], seen.ultraCap, "画面出自精修预算");
    assert.equal(ctx.ruleField, work, "规则场不随精修落地变");
    assert.equal(seen.field, ultra, "渲染器画面份＝精修");
    assert.equal(seen.rule, work, "渲染器规则份＝工作档（推演底图画它）");
  });

  it("落笔：精修即弃，画面回到规则场；规则场＝工作档叠粗格增量的合成，不退回粗格", async () => {
    const { ctx, seen } = mkCtx();
    const host = createHost(ctx);
    landWorld(ctx, W(), "t1", 3050);
    host.rebuildIfNeeded();
    await flush();
    const work = ctx.ruleField!;
    await tick(240, 6);
    await tick(6000);
    assert.equal(ctx.elevField!.cols, ctx.grid!.cols * 4, "前置：精修在屏");
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuild();   // 笔刷走 pointer 直调 rebuild，同一条路
    assert.equal(ctx.elevField, ctx.ruleField, "精修弃了：画面＝规则场");
    assert.equal(ctx.ruleField!.cols, work.cols, "规则场仍在工作档几何上（合成，不是粗格）");
    assert.notEqual(ctx.ruleField, work, "增量非零＝新合成的场");
    assert.equal(seen.field, ctx.ruleField, "渲染器两份同一对象");
    assert.equal(seen.rule, ctx.ruleField);
  });

  it("仅底图档：高程笔重建不发单、不弃精修、不撤单；规则场＝工作档叠涂改增量且立即落定；侵蚀输入不含涂改", async () => {
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

  it("在飞的精修单随重建撤掉：单以 null 收场、胶囊归位、画面留在规则场", async () => {
    const { ctx, seen } = mkCtx();
    seen.holdUltra = true;
    const host = createHost(ctx);
    landWorld(ctx, W(), "t1", 3050);
    host.rebuildIfNeeded();
    await flush();
    await tick(240, 6);
    await tick(6000);
    assert.equal(erodePhaseSig.peek(), "ultra", "前置：精修单在飞");
    assert.equal(seen.cancels, 0, "前置：此前的重建没有在飞单可撤");
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuild();
    assert.equal(seen.cancels, 1, "落笔那次重建撤了在飞的单");
    await flush();
    assert.equal(erodePhaseSig.peek(), "idle", "撤单＝胶囊归位（不悬在「精修中」）");
    assert.equal(ctx.elevField, ctx.ruleField, "画面＝规则场，没有精修上屏");
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

  it("撤销只动高程的一笔：沿用同一个 Grid（仅底图档照旧走早退支、不发单）；撤销对象编辑之后的一笔也照旧", async () => {
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

  it("撤销 / 重做回到落地过的地形：同步换上那份工作档、同拍落定，不合成也不发单", async () => {
    const { ctx, seen } = mkCtx();
    const host = createHost(ctx);
    landWorld(ctx, W(), "t1", 3050);
    host.rebuildIfNeeded();
    await flush();
    const work0 = ctx.ruleField!;
    await tick(240, 6);
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuildIfNeeded();
    assert.equal(ruleFieldSig.value, null, "前置：新的一笔走等待窗");
    await tick(60);
    const work1 = ctx.ruleField!;
    assert.notEqual(work1, work0);
    assert.equal(ruleFieldSig.value, work1, "前置：那一笔落地");
    await tick(240, 6);
    const erodes = seen.erodes;
    undoWorld();
    host.rebuildIfNeeded();
    assert.equal(ctx.ruleField, work0, "撤销：规则场就是开图落地的那份，不是合成");
    assert.equal(ruleFieldSig.value, work0, "同拍落定");
    redoWorld();
    host.rebuildIfNeeded();
    assert.equal(ctx.ruleField, work1, "重做：换回那一笔落地的那份");
    await tick(500);
    assert.equal(seen.erodes, erodes, "没有再发侵蚀单");
    await tick(240, 6);
    assert.equal(ctx.elevField, work1, "画面渐变到同一份");
  });

  it("离散换场落到在屏那一份（侵蚀单一字不变的设置改动）：只落定，不渐变、不发单；拨年照旧走等待窗", async () => {
    const { ctx, seen } = mkCtx();
    const host = createHost(ctx);
    landWorld(ctx, W(), "t1", 3050);
    host.rebuildIfNeeded();
    await flush();
    const work0 = ctx.ruleField!;
    await tick(240, 6);
    const erodes = seen.erodes;
    mutateWorld(w => { w.meta.erode = "base"; }, { grid: true });   // 没有高程涂改：两档的侵蚀单逐位相同
    host.rebuildIfNeeded();
    assert.equal(ctx.ruleField, work0, "规则场就是在屏那份");
    assert.equal(ctx.elevField, work0, "画面不走渐变");
    assert.equal(ruleFieldSig.value, work0, "同拍落定");
    await tick(500);
    assert.equal(seen.erodes, erodes, "没有发单");
    yearSig.value = 3051;
    host.rebuildIfNeeded();
    assert.equal(ruleFieldSig.value, null, "拨年不查最近落地：照旧进演算、等防抖后的那一单（播放每步不付组装求键的账）");
  });

  it("放大编辑（分块精修）：「已完成」等视口里的块换成新的才报", async () => {
    const { ctx } = mkCtx();
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
    /* 5 万格的战略图：工作档 6×、精修 7×，块 8×（15 块） */
    landWorld(ctx, normalizeWorld({ meta: { 名称: "陆", worldModel: "sphere", terrain: "plain", relief: 0.5, gridN: 280,
      bbox: { lonMin: 100, lonMax: 115, latMin: 30, latMax: 40 } } }), "s1", 3050);
    host.rebuildIfNeeded();
    const g = ctx.grid!, lon = g.bb.lonMin + 96 * g.step, lat = g.bb.latMin + 96 * g.step;
    Object.assign(ctx.view, { lon0: lon, lat0: lat, degPerPx: g.step / 8 });   // 块 6（第二行第二列）中央，一个块格一个 CSS 像素
    host.syncTiles();
    await flush();
    assert.equal(erodePhaseSig.value, "ultra", "工作档算完、视口里的块还没到：报精修中");
    held.shift()!(); await flush();
    assert.equal(erodePhaseSig.value, "done", "视口里那块到了才报完成");
    assert.ok(ctx.tileLayer?.tiles.has(6));
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon, lat, dh: 0.2 }); }, { grid: true });
    host.rebuildIfNeeded();
    const old6 = ctx.tileLayer!.tiles.get(6);
    await tick(60);
    assert.equal(erodePhaseSig.value, "ultra", "工作档落地时视口里的块还是旧的：不报完成");
    while (held.length && erodePhaseSig.value !== "done") { held.shift()!(); await flush(); }
    assert.equal(erodePhaseSig.value, "done");
    assert.notEqual(ctx.tileLayer!.tiles.get(6), old6, "报完成时视口里的块已换成新的");
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
  it("分块：中尺度到了，块单带外层裁剪（嵌套解）、不带包络；车道没有结果时块单照旧细级侵蚀（要切割量、不带裁剪）", async () => {
    for (const fail of [false, true]) {
      const { ctx } = mkCtx(), M = mesoRig(ctx), tilesIn: ErodeInput[] = [];
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
      if (fail) { M.st.q[0].done = true; M.st.q[0].res(null); } else M.answer(0);
      await flush(); await tick(240, 6); await flush();
      assert.ok(tilesIn.length >= 1, "发了块单");
      const t = tilesIn[0];
      if (!fail) {
        assert.ok(t.nest && !t.mesoEnv && !t.win, "嵌套解的块单"); assert.equal(carves, 0, "中尺度图不要切割量");
        const w = ctx.ruleField!, ne = t.nest;
        assert.ok(ne.tgt && ne.tsx === 6 && w.cols === ctx.grid!.cols * 6, "工作档是嵌套解（280 列＝6 倍）：块单带它的裁片当目标面");
        assert.equal(ne.tgt.length, t.cols * t.rows * 36, "裁片罩住单的整个裁剪");
        assert.equal(ne.tgt[0], w.data[(ne.y0 * 6) * w.cols + ne.x0 * 6], "裁的是落地的工作档（整数值量化后不变）");
        assert.equal(ne.pk, null, "块单不校峰");
      }
      else { assert.ok(!t.nest && t.win, "宏观底的块单照旧"); assert.equal(carves, 1); }
    }
  });
  it("车道没有结果（null）：这张图照旧用宏观底发单，不再等、不再要", async () => {
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx), host = createHost(ctx);
    landWorld(ctx, V2(), "v1", 3050);
    host.rebuildIfNeeded();
    await flush();
    M.st.q[0].done = true; M.st.q[0].res(null);
    await flush(); await tick(100);
    assert.equal(seen.erodes, 1);
    assert.ok(!("mesoEnv" in seen.lastInp!), "宏观底的单不带包络");
    mutateWorld(w => { (w.heightOverrides ||= []).push({ lon: 100.05, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuild(); await flush(); await tick(100);
    assert.equal(M.st.q.length, 1, "失败过的键不再要");
    assert.equal(seen.erodes, 2, "编辑照常发单");
    const v1 = cellsVerSig.value;
    mutateWorld(w => { w.heightOverrides!.push({ lon: 100.15, lat: 30.05, dh: 0.2 }); }, { grid: true });
    host.rebuild(); await flush(); await tick(100);
    assert.equal(cellsVerSig.value, v1, "只动高程涂改：类型格没换，不换代");
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
  it("仅底图档画盆地成湖：侵蚀的格没有湖、屏上的格有，规则场在新湖格上压到水面以下（画成水）", async () => {
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
  it("仅底图档：侵蚀单取只带 Sg 的 Grid；解到了不撤单、不发单，规则场＝工作档叠抬升增量、立即落定", async () => {
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
  it("三角洲的分汊线随生成的河一起落地、进存档；删一条分汊线再核不回来，删主河不连带分汊线（gridN 480 多块种子 7）", async () => {
    const { ctx } = mkCtx(), M = mesoRig(ctx), host = createHost(ctx);
    landWorld(ctx, V2(7, { gridN: 480 }), "v1", 3050);
    host.rebuildIfNeeded(); await flush(); await tick(200);
    M.answer(0); await flush(); await tick(100);
    const gen = (): Edge[] => worldSig.value!.edges.filter(e => e.gen), br = gen().filter(e => e.branch);
    assert.ok(br.length >= 5 && br.every(e => e.type === "river" && Array.isArray(e.mz)), `分汊线 ${br.length} 条`);
    const n0 = gen().length, b0 = br[0], pts0 = JSON.stringify(b0.pts);
    deleteEdgeIdx(worldSig.value!.edges.indexOf(b0));
    host.rebuild(); await flush(); await tick(100);
    assert.equal(gen().length, n0 - 1);
    assert.ok(!gen().some(e => JSON.stringify(e.pts) === pts0), "删掉的分汊线不回来");
    /* 删主河：选一条首点挨着某条分汊线首点的主河 */
    const near = (a: [number, number], b: [number, number]): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.3;
    const bs = gen().filter(e => e.branch), mainR = gen().find(e => !e.branch && bs.some(b => e.pts!.some(p => near(p, b.pts![0]))))!;
    assert.ok(mainR, "前提：有分汊线从主河上分出");
    const nb = bs.length;
    deleteEdgeIdx(worldSig.value!.edges.indexOf(mainR));
    host.rebuild(); await flush(); await tick(100);
    assert.equal(gen().filter(e => e.branch).length, nb, "删主河不连带分汊线");
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
  it("挪河流滑杆：地形不重建，用同一份格子再要一单、只换河；车道没有结果时用宏观河兜底", async () => {
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
    M2.st.q[0].done = true; M2.st.q[0].res(null);
    await flush(); await tick(100);
    assert.deepStrictEqual(worldSig.value!.edges, genRiverEdges(c2.meta, undefined), "中尺度没有结果：宏观河兜底");
  });
  it("解不出：这一份不再等也不再要，侵蚀放行、屏上回到 Sg；下一笔照常再要", async () => {
    const { ctx, seen } = mkCtx(), M = mesoRig(ctx);
    const { host, lon, lat } = await openV2(ctx, M);
    const sgF = ctx.grid!.meso, erodes0 = seen.erodes;
    paint(lon, lat, 3000); host.rebuild();
    await flush();
    M.st.uq[0].done = true; M.st.uq[0].res(null);
    await flush(); await tick(100);
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
