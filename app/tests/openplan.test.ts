/* 开图计划（shell 编排纯函数化第一步）：年份/视角决策与 v0.14 语义逐条锁定。
   历史时序 bug（图库重开全平原/深链被快照覆盖/坏档 NaN 写坏相机）都发生在这段决策上；
   IO 与信号落地仍在 shell/library.ts 的 setWorld——此处只锁决策。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickBootEntry, planOpen, wantsDeepStart } from "../src/shell/openplan.ts";
import { clampView } from "../src/core/projection.ts";

const dl0 = { urlYear: false, urlView: false };
const raw = (meta: Record<string, unknown> = {}): unknown =>
  ({ meta: { 名称: "测", ...meta }, nodes: [], factions: [], edges: [] });

describe("开图计划：年份", () => {
  it("快照年份优先；深链 #year 抢开局则忽略快照", () => {
    assert.equal(planOpen(raw(), { year: 3050 }, dl0).year, 3050);
    assert.equal(planOpen(raw(), { year: 3050 }, { urlYear: true, urlView: false }).year, null);
  });
  it("无快照/坏年份＝null（保持当前，落地方按世界范围钳制兜底）", () => {
    assert.equal(planOpen(raw(), null, dl0).year, null);
    assert.equal(planOpen(raw(), {}, dl0).year, null);
    assert.equal(planOpen(raw(), { year: NaN }, dl0).year, null);
  });
  it("0 是合法时刻（公元前 1 年/日戳 0），不得当假值丢掉", () => {
    assert.equal(planOpen(raw(), { year: 0 }, dl0).year, 0);
  });
});

describe("开图计划：视角三级回退（快照 → 档内 meta.view → 不动）", () => {
  it("快照 view 优先；degPerPx 缺省 0.06", () => {
    const p = planOpen(raw(), { view: { lon0: 100, lat0: 30 } }, dl0);
    assert.deepEqual(p.view, { lon0: 100, lat0: 30, degPerPx: 0.06 });
    const q = planOpen(raw(), { view: { lon0: 100, lat0: 30, degPerPx: 0.02 } }, dl0);
    assert.equal(q.view!.degPerPx, 0.02);
  });
  it("快照 lon0 坏 → 落到档内 meta.view；degPerPx0 缺省＝null（保持当前缩放）", () => {
    const p = planOpen(raw({ view: { lon0: 108, lat0: 36 } }), { view: { lon0: NaN, lat0: 0 } }, dl0);
    assert.deepEqual(p.view, { lon0: 108, lat0: 36, degPerPx: null });
    const q = planOpen(raw({ view: { lon0: 108, lat0: 36, degPerPx0: 0.05 } }), null, dl0);
    assert.equal(q.view!.degPerPx, 0.05);
  });
  it("两级都缺/都坏 → null（不动相机）", () => {
    assert.equal(planOpen(raw(), null, dl0).view, null);
    assert.equal(planOpen(raw({ view: { lon0: NaN, lat0: 1 } }), null, dl0).view, null);
  });
  it("深链 #lon/#lat/#z 抢开局 → 快照与档内一律不动", () => {
    const p = planOpen(raw({ view: { lon0: 108, lat0: 36 } }),
      { view: { lon0: 100, lat0: 30 } }, { urlYear: false, urlView: true });
    assert.equal(p.view, null);
  });
  it("超界/病值经 clampView 钳制（与相机同一把尺；lat0=NaN 也不放行）", () => {
    const p = planOpen(raw(), { view: { lon0: 725, lat0: 99 } }, dl0);
    const c = clampView({ lon0: 725, lat0: 99 }, (planOpen(raw(), null, dl0).world.meta)!);
    assert.equal(p.view!.lon0, c.lon0);
    assert.equal(p.view!.lat0, c.lat0);
    const q = planOpen(raw(), { view: { lon0: 100, lat0: NaN } }, dl0);
    assert.ok(isFinite(q.view!.lat0), "lat0 病值须被钳成有限数");
  });
});

describe("开图计划：世界归一化", () => {
  it("坏档过 normalizeWorld（非数组字段补齐、非对象成员剔除）", () => {
    const p = planOpen({ meta: null, nodes: "junk", factions: [null, { id: "f" }] }, null, dl0);
    assert.ok(Array.isArray(p.world.nodes) && p.world.nodes.length === 0);
    assert.equal(p.world.factions.length, 1);
  });
});

describe("启动分流：深链判定与选图", () => {
  const noDl = { wantMap: null, wantPreset: null, wantSel: null, wantAnalysis: null,
    wantGenTac: null, wantMulti: null, wantOp: null, wantPts: null, urlView: false, urlYear: false };
  it("任一深链要素在场＝直达；#op=0 也算（!=null 而非真值）", () => {
    assert.equal(wantsDeepStart(noDl), false);
    assert.equal(wantsDeepStart({ ...noDl, wantMap: "某图" }), true);
    assert.equal(wantsDeepStart({ ...noDl, urlYear: true }), true);
    assert.equal(wantsDeepStart({ ...noDl, wantOp: 0 }), true);
  });
  it("选图：#map 指名（名称或 id）→ lastMap → 首张 → 空库 null", () => {
    const es = [{ id: "a", name: "甲图" }, { id: "b", name: "乙图" }, { id: "c", name: "丙图" }];
    assert.equal(pickBootEntry(es, "乙图", "c")!.id, "b", "指名按名称命中");
    assert.equal(pickBootEntry(es, "c", null)!.id, "c", "指名按 id 命中");
    assert.equal(pickBootEntry(es, null, "c")!.id, "c", "无指名回 lastMap");
    assert.equal(pickBootEntry(es, "没这图", "c")!.id, "c", "指名落空回 lastMap（尽力直达）");
    assert.equal(pickBootEntry(es, null, null)!.id, "a", "都没有取首张");
    assert.equal(pickBootEntry([], "任意", "任意"), null, "空库 null");
  });
});
