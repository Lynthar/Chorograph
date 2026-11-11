/* 编排 effect × 真 host 集成测试（fake 渲染器计数）：锁「开图批末恰好重建一次网格」。
   重建=开图路径最贵的单次计算（O(cols×rows) 地形判定），多建一次没有功能症状、只有变慢——
   常规测试照不出，故以计数上锁：batch() 单次冲刷 + builtFor 键去重共同保证恰一次。
   host 用真 createHost（builtFor 键逻辑是被测核心），渲染器/寻路客户端/DOM 挂点用 fake。 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { batch } from "@preact/signals";
import { createHost, type Host } from "../src/shell/host.ts";
import { landWorld, wireOrchestration, wireRoute } from "../src/shell/orchestrate.ts";
import { normalizeWorld } from "../src/core/world.ts";
import { unitLegs } from "../src/core/units.ts";
import { gridVerSig, hoverSig, landedRuleField, modeSig, mutateWorld, mutateWorldLive, routeBusySig, routePtsSig, routeResSig, ruleFieldSig,
  selSig, unitLegsSig, worldSig, yearSig } from "../src/app/state.ts";
import type { RuleField } from "../src/core/elev.ts";
import type { ComputedRoute } from "../src/core/route.ts";
import type { ShellCtx } from "../src/shell/ctx.ts";
import type { Unit, World, WorldNode } from "../src/core/types.ts";

/** 等过「防抖 LEGS_MS(80) + fake legs 的微任务」——腿账下 Worker 后编排异步填 sig */
const settleLegs = (): Promise<void> => new Promise(r => setTimeout(r, 130));

/* host.rebuild 经 $() 摸 DOM 挂点（hud 恒写；seed/style 仅无世界时读）——node 下以最小 fake 顶上 */
const els: Record<string, { dataset: Record<string, string>; value: string }> = {};
(globalThis as { document?: unknown }).document = {
  getElementById: (id: string) => (els[id] ||= { dataset: {}, value: "" })
};

function mkCtx(): { ctx: ShellCtx; counts: { rebuilds: number } } {
  const counts = { rebuilds: 0 };
  const ctx = {
    canvas: {} as HTMLCanvasElement, ov: {} as HTMLCanvasElement,
    routeClient: { setContext: () => {}, cancelUltra: () => {}, cancelErode: () => {} },
    DPR: 1, meta: {},
    view: { lon0: 102, lat0: 32, degPerPx: 0.06 },
    grid: null, elevField: null,
    R: { uploadGrid: () => { counts.rebuilds++; } },   // 每次真重建必经 uploadGrid＝计数点
    builtFor: null, repaint: null,
    lib: null, mapId: null, source: "browser", folderDir: null, fcache: {},
    bootNote: "", savedAt: null, saveErr: null, libOpen: false
  } as unknown as ShellCtx;
  /* 腿账下 Worker 后编排走 routeClient.legs——fake 直调核心纯函数（微任务返回，同真 Worker 语义序） */
  (ctx.routeClient as { legs?: (u: Unit, roads?: Set<string>) => Promise<unknown> }).legs =
    (u, roads) => Promise.resolve(unitLegs(ctx.meta, ctx.grid!, roads, u));
  return { ctx, counts };
}
const W = (extra: object = {}): World => normalizeWorld({
  meta: { 名称: "试", worldModel: "sphere", terrain: "plain", bbox: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 } },
  ...extra
});
/** 开图＝library.setWorld 同一落地函数（真护栏，非镜像抄序）+ 同款兜底调用 */
function openLikeLibrary(ctx: ShellCtx, host: Host, w: World, id: string, year?: number): void {
  landWorld(ctx, w, id, year);
  host.rebuildIfNeeded();                   // 兜底（正常已在批末建过、键相符＝零开销）
}

describe("编排 effect × host 重建计数（开图批末恰建一次）", () => {
  let ctx: ShellCtx, counts: { rebuilds: number }, host: Host, unwire: () => void;
  beforeEach(() => {
    ({ ctx, counts } = mkCtx());
    host = createHost(ctx);
    unwire = wireOrchestration(ctx, host);
    counts.rebuilds = 0;                    // 接线首刷（承接上例遗留信号态）不计入用例
  });
  afterEach(() => unwire());

  /** 读 ctx.grid 在 (lon,lat) 的格值——内容断言用：只数次数会漏「次数对但建自旧世界」的病形 */
  const cellAt = (lon: number, lat: number): string => {
    const g = ctx.grid!;
    return g.cells[Math.floor((lat - g.bb.latMin) / g.step)][Math.floor((lon - g.bb.lonMin) / g.step)];
  };

  it("开图序列恰好重建一次，且网格建自【最终】世界（非中途旧世界白建）", () => {
    openLikeLibrary(ctx, host, W({ terrainOverrides: [{ lon: 101.5, lat: 31.5, t: "water" }] }), "m1", 3050);
    assert.equal(counts.rebuilds, 1, "batch 冲刷一次 + builtFor 去重 ⇒ 恰一次");
    /* 去 batch 的病形：年份先落时以旧世界白建、键即相符，世界随后落地却不再重建——
       次数仍=1 但网格陈旧。内容断言把这形态咬住（历史 bug「拿旧世界白建全平原」）。 */
    assert.equal(cellAt(101.5, 31.5), "water", "网格含新档的地形涂改=建自最终世界");
    assert.equal(ctx.builtFor, `m1@${yearSig.peek()}@${gridVerSig.peek()}`, "去重键=最终 世界@年份@地形版本");
  });

  it("同 id 重开（内容已变）：builtFor 置空强制重建，恰一次且内容为新档", () => {
    openLikeLibrary(ctx, host, W(), "m1", 3050);
    assert.equal(cellAt(101.5, 31.5), "plain");
    counts.rebuilds = 0;
    openLikeLibrary(ctx, host, W({ terrainOverrides: [{ lon: 101.5, lat: 31.5, t: "water" }] }), "m1", 3050);
    assert.equal(counts.rebuilds, 1);
    assert.equal(cellAt(101.5, 31.5), "water", "同 id 同年同 gridVer 重开：键相同也必须重建出新内容");
  });

  it("与网格无关的信号不触发重建：选中/悬停/非地形编辑", () => {
    openLikeLibrary(ctx, host, W({ nodes: [{ id: "a", type: "city", lon: 101, lat: 31 }] }), "m1", 3050);
    counts.rebuilds = 0;
    selSig.value = { kind: "node", id: "a" };
    hoverSig.value = worldSig.peek()!.nodes[0];
    mutateWorld(w => { (w.nodes[0] as WorldNode).名称 = "改名"; });   // editVer++（无 grid 标记）
    assert.equal(counts.rebuilds, 0);
  });

  it("换年/涂改地形各恰一次；批内年+地形版本同改仍恰一次", () => {
    openLikeLibrary(ctx, host, W(), "m1", 3050);
    counts.rebuilds = 0;
    yearSig.value = 3060;                                             // 年份进键（时段地形随年重算）
    assert.equal(counts.rebuilds, 1, "换年一次");
    mutateWorld(w => { w.terrainOverrides.push({ lon: 101, lat: 31, t: "water" }); }, { grid: true });
    assert.equal(counts.rebuilds, 2, "地形涂改一次");
    batch(() => { yearSig.value = 3070; gridVerSig.value++; });
    assert.equal(counts.rebuilds, 3, "批内两键同变=一次冲刷一次重建");
  });

  it("战术图·可达性预算随选中部队：选中算入缓存、且只留选中者；取消选中清空", async () => {
    const tac = W({
      meta: { 名称: "战", worldModel: "sphere", terrain: "plain", mapKind: "tactical",
        bbox: { lonMin: 100, lonMax: 101, latMin: 30, latMax: 31 } },
      units: [{ id: "u1", kind: "inf", track: [{ t: 3050, lon: 100.5, lat: 30.5 }] },
              { id: "u2", kind: "cav", track: [{ t: 3050, lon: 100.6, lat: 30.6 }] }]
    });
    openLikeLibrary(ctx, host, tac, "t1", 3050);
    assert.equal(unitLegsSig.peek().size, 0, "开图清预算缓存");
    selSig.value = { kind: "unit", id: "u1" };
    await settleLegs();
    assert.deepEqual([...unitLegsSig.peek().keys()], ["u1"], "只算当前选中的部队（异步落账）");
    selSig.value = { kind: "unit", id: "u2" };
    assert.deepEqual([...unitLegsSig.peek().keys()], ["u1"], "防抖窗内仍是旧账（未闪空）");
    await settleLegs();
    assert.deepEqual([...unitLegsSig.peek().keys()], ["u2"], "换选=换缓存（不累积）");
    selSig.value = null;
    assert.equal(unitLegsSig.peek().size, 0, "取消选中**同步**清空（撤旧账不等防抖）");
    await settleLegs();
    assert.equal(unitLegsSig.peek().size, 0, "清选后无过期结果还魂（seq 令牌）");
  });

  it("腿账拒绝要放闸并补发 dirty：飞行中失败 + 期间有改动 ⇒ 自动重算落账（不等下一次编辑）", async () => {
    const tac = W({
      meta: { 名称: "战", worldModel: "sphere", terrain: "plain", mapKind: "tactical",
        bbox: { lonMin: 100, lonMax: 101, latMin: 30, latMax: 31 } },
      units: [{ id: "u1", kind: "inf", track: [{ t: 3050, lon: 100.5, lat: 30.5 }] }]
    });
    openLikeLibrary(ctx, host, tac, "t1", 3050);
    const rc = ctx.routeClient as unknown as { legs: (u: Unit, roads?: Set<string>) => Promise<unknown> };
    const realLegs = rc.legs;
    let rejectFirst!: (e: Error) => void, calls = 0;
    rc.legs = (u, roads) => ++calls === 1 ? new Promise((_, rej) => { rejectFirst = rej; }) : realLegs(u, roads);
    const warn0 = console.warn;
    console.warn = () => {};                // 拒绝分支要 warn 一声——测试输出保持零警告
    try {
      selSig.value = { kind: "unit", id: "u1" };
      await settleLegs();                   // 首单已发、悬在飞行中（deferred 不归）
      mutateWorld(w => { w.nodes.push({ id: "n1", type: "city", lon: 100.2, lat: 30.2 }); });   // editVer++ ⇒ 防抖后 fireLegs ⇒ busy ⇒ dirty
      await settleLegs();
      assert.equal(unitLegsSig.peek().size, 0, "前提：首单未归、无账");
      rejectFirst(new Error("拟真失败"));
      await settleLegs();
      assert.deepEqual([...unitLegsSig.peek().keys()], ["u1"], "拒绝放闸并补发 dirty ⇒ 重算落账");
    } finally { console.warn = warn0; }
  });

  it("笔刷节流的重建（不涨 gridVer）换了类型网格 ⇒ 腿账按新网格重算", async () => {
    const tac = W({
      meta: { 名称: "战", worldModel: "sphere", terrain: "plain", mapKind: "tactical",
        bbox: { lonMin: 100, lonMax: 100.2, latMin: 30, latMax: 30.2 } },
      units: [{ id: "u1", kind: "inf", arm: "water", track: [{ t: 3050, lon: 100.04, lat: 30.1 }, { t: 3060, lon: 100.16, lat: 30.1 }] }]
    });
    openLikeLibrary(ctx, host, tac, "t1", 3050);
    selSig.value = { kind: "unit", id: "u1" };
    await settleLegs();
    assert.equal(unitLegsSig.peek().get("u1")![0].route, false, "前提：平原上水行走不通");
    /* 地貌笔一笔：世界先改（editVer++），重建由指针节流稍后直调——中间这一拍腿账按旧网格算出 */
    const g = ctx.grid!, canal = Array.from({ length: g.cols }, (_, c) => ({ lon: g.bb.lonMin + (c + 0.5) * g.step, lat: 30.1, t: "water" }));
    mutateWorldLive(w => { w.terrainOverrides = w.terrainOverrides.concat(canal); });
    await settleLegs();
    assert.equal(unitLegsSig.peek().get("u1")![0].route, false, "前提：重建之前落的账还是旧网格的");
    host.rebuild();
    assert.equal(cellAt(100.1, 30.1), "water", "前提：整行成水");
    await settleLegs();
    assert.equal(unitLegsSig.peek().get("u1")![0].route, true, "水道通了：账跟着新网格变");
  });

  it("effect 未接线时开图仍有兜底重建（且只兜一次）", () => {
    unwire();                               // 模拟接线缺失/回归：批末无 effect 冲刷
    openLikeLibrary(ctx, host, W(), "m9", 3050);
    assert.equal(counts.rebuilds, 1, "显式 rebuildIfNeeded 兜底恰一次");
    unwire = wireOrchestration(ctx, host);  // 归位给 afterEach（重复 unwire 无害但保持对称）
  });
});

/* 快照视角、复位、跳转与深链都从 setView 进：带缩放的一律钳到本图的放大上限。
   不带缩放的只挪位置——可见区变窄（检查器滑开）也走 setView，那时改缩放＝画面自己退一档。 */
describe("相机缩放钳制（host.setView）", () => {
  const GLOBE = (): World => normalizeWorld({ meta: { 名称: "球", worldModel: "sphere", terrain: "plain", planetRadiusKm: 10000, gridN: 1732,
    bbox: { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 } } });
  let ctx: ShellCtx, host: Host;
  beforeEach(() => {
    (els as Record<string, object>).canvasWrap = { dataset: {}, value: "", clientWidth: 1440, clientHeight: 900 };
    ({ ctx } = mkCtx());
    host = createHost(ctx);
    landWorld(ctx, GLOBE(), "g1", 3050);
  });
  afterEach(() => { delete els.canvasWrap; });

  it("带缩放：比放大上限细的钳到上限，上限以内的原样", () => {
    const { min, max } = host.dppRange();
    assert.ok(min < max, "前提：两头不倒挂");
    host.setView({ lon0: 0, lat0: 0, degPerPx: min / 5 });
    assert.equal(ctx.view.degPerPx, min);
    host.setView({ lon0: 0, lat0: 0, degPerPx: min * 3 });
    assert.equal(ctx.view.degPerPx, min * 3);
  });
  it("不带缩放：只挪位置，缩放一个字不动", () => {
    const z = ctx.view.degPerPx = host.dppRange().min / 5;
    host.setView({ lon0: 10, lat0: 5 });
    assert.equal(ctx.view.degPerPx, z);
    assert.deepEqual([ctx.view.lon0, ctx.view.lat0], [10, 5]);
  });
});

describe("行军计算编排（wireRoute）", () => {
  const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
  it("清点即作废在飞的单：旧结果落地不写回，之后的单照常落", async () => {
    const pend: ((r: ComputedRoute | null) => void)[] = [];
    const ctx = { routeClient: { route: () => new Promise<ComputedRoute | null>(res => { pend.push(res); }) } } as unknown as ShellCtx;
    const mode0 = modeSig.peek(), unwire = wireRoute(ctx);
    try {
      batch(() => { modeSig.value = "route"; routePtsSig.value = [{ lon: 100.2, lat: 30.5 }, { lon: 100.8, lat: 30.5 }]; });
      assert.equal(pend.length, 1);
      assert.equal(routeBusySig.peek(), true);
      routePtsSig.value = [];                 // 清点（撤销、换图走的也是这一支）
      assert.equal(routeBusySig.peek(), false);
      pend[0]({ dist: 1 } as unknown as ComputedRoute);
      await tick();
      assert.equal(routeResSig.peek(), null, "清点之后到货的旧路线不写回");
      routePtsSig.value = [{ lon: 100.3, lat: 30.5 }, { lon: 100.7, lat: 30.5 }];
      const fresh = { dist: 2 } as unknown as ComputedRoute;
      pend[1](fresh);
      await tick();
      assert.equal(routeResSig.peek(), fresh);
    } finally { unwire(); batch(() => { modeSig.value = mode0; routePtsSig.value = []; routeResSig.value = null; routeBusySig.value = false; }); }
  });
});

describe("落定的规则场不跨图", () => {
  afterEach(() => { ruleFieldSig.value = null; });
  it("同图演算中沿用上一份；换图即清，新图落定前读不到上一张图的场", () => {
    const { ctx } = mkCtx(), fA = { cols: 1 } as unknown as RuleField, fB = { cols: 2 } as unknown as RuleField;
    landWorld(ctx, W(), "甲", 3050);
    ruleFieldSig.value = fA;
    assert.equal(landedRuleField(), fA);
    ruleFieldSig.value = null;
    assert.equal(landedRuleField(), fA, "同图演算中沿用上一份");
    ruleFieldSig.value = fA;
    landWorld(ctx, W(), "乙", 3050);
    assert.equal(ruleFieldSig.peek(), null, "新图的规则场还没落定");
    assert.equal(landedRuleField(), null, "上一张图的场不留给新图");
    ruleFieldSig.value = fB;
    assert.equal(landedRuleField(), fB);
  });
});
