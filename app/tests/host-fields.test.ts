/* host 的高程场记账（「高程成为数据」）：规则场 ctx.ruleField 只认工作档，精修档只进画面 ctx.elevField。
   fake routeClient 按输入预算返回可辨认的场（数据整幅填 cap），fake 渲染器记下最近一次上传的（画面, 规则）对；
   静置窗 6s 用 node:test 的 mock timers 拨过。node 下无 indexedDB＝场缓存恒未命中，走的是真算分支。 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHost } from "../src/shell/host.ts";
import { landWorld } from "../src/shell/orchestrate.ts";
import { normalizeWorld } from "../src/core/world.ts";
import { erodePhaseSig, mutateWorld, ruleFieldSig, yearSig } from "../src/ui/state.ts";
import type { ShellCtx } from "../src/shell/ctx.ts";
import type { ElevField } from "../src/core/elev.ts";
import type { ErodeInput } from "../src/core/erode.ts";
import type { World } from "../src/core/types.ts";

/* host.rebuild 经 $() 摸 DOM 挂点（hud 恒写）——node 下以最小 fake 顶上 */
const els: Record<string, { dataset: Record<string, string>; value: string }> = {};
(globalThis as { document?: unknown }).document = {
  getElementById: (id: string) => (els[id] ||= { dataset: {}, value: "" })
};

/** 可辨认的假细分场：几何按 sx 细分，数据整幅填本单预算——谁读到了哪一档一目了然 */
const fakeField = (inp: ErodeInput, sx: number): ElevField => ({
  bb: inp.bb, step: inp.step / sx, cols: inp.cols * sx, rows: inp.rows * sx,
  data: new Float32Array(inp.cols * inp.rows * sx * sx).fill(inp.cap), shadow: null
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
        return seen.holdErode ? new Promise<ElevField | null>(res => { seen.releaseE = res; }) : Promise.resolve(fakeField(inp, 2));
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
    R: { uploadGrid: (_g: unknown, _ws: unknown, field: ElevField, rule: ElevField) => { seen.field = field; seen.rule = rule; } },
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
});
