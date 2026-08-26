/* 编辑基座测试：撤销栈 / 自动保存调度 / 编辑操作内核 / signals 变更管线。
   组件 .tsx 不进 node:test（类型剥离不转 JSX）——表单交互靠截图与真机，此处锁逻辑。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHistory, terrKey, UNDO_MAX } from "../src/ui/history.ts";
import { createAutosave } from "../src/data/autosave.ts";
import { addEdge, addFreeEdge, addRiver, addAsset, addDecor, removeAsset, addEventNear, addLabel, addNode, addOwner, addPhaseAt, applyEdgeForm, applyNodeForm, applyUnitForm, addUnit, addUnitUnplaced, changeNodeType, dataLon, deleteUnitWaypoint, formatRanges, moveNode, paintHeightAt, paintHeightPath, paintTerrainPath, parseRanges, removeEdgeAt, removeNode, removeOwner, removePhaseAt, removeUnit, renamePhase, setNodeRangeKm, setUnitRing, setUnitWaypoint, setUnitWaypointStatus, updateOwner } from "../src/ui/editops.ts";
import { unitArm, unitFireKm, unitStatusAt } from "../src/core/units.ts";
import { adjacentPhaseT, phaseIndexAt, phasesOf } from "../src/core/time.ts";
import { buildGridCells, gridStepDeg } from "../src/core/grid.ts";
import { applyPreset, canRedoSig, canUndoSig, deleteEdgeIdx, deleteFactionAt, deleteNodeAt, editSubSig, editVerSig, gridVerSig, IMPL_LAYERS, layersSig, linkTypeSig, mutateWorld, mutateWorldLive,
  paintFactionSig, paintLayerSig, pickEditSub, pickLinkType, pushHistoryOnce, redoWorld, revealLayersFor, selMembers, selSig, setWorldState, subDaySig, timeStep, toastSig, undoWorld, worldSig, yearSig } from "../src/ui/state.ts";
import { EVENT_TYPES, LAYERS, PRESETS } from "../src/core/constants.ts";
import type { World, WorldNode } from "../src/core/types.ts";

const mkWorld = (over: Partial<World> = {}): World => ({
  meta: { 名称: "测试" }, factions: [], nodes: [], edges: [], decor: [], terrainOverrides: [], units: [], ...over
});

describe("撤销栈", () => {
  it("push/undo/redo 往返；push 清空 redo", () => {
    const h = createHistory();
    const w1 = mkWorld({ nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }] });
    h.push(w1);
    const w2 = mkWorld({ nodes: [{ id: "a", type: "city", lon: 9, lat: 9 }] });
    const back = h.undo(w2)!;
    assert.strictEqual(back.nodes[0].lon, 1);
    assert.ok(h.canRedo());
    const fwd = h.redo(back)!;
    assert.strictEqual(fwd.nodes[0].lon, 9);
    h.push(fwd);
    assert.strictEqual(h.canRedo(), false, "新改动应清空重做");
  });
  it("容量上限：最老的快照被挤掉", () => {
    const h = createHistory();
    for (let i = 0; i < UNDO_MAX + 5; i++) h.push(mkWorld({ nodes: [{ id: "n" + i, type: "city", lon: i, lat: 0 }] }));
    let last: World = mkWorld();
    let count = 0;
    for (let g = h.undo(last); g; g = h.undo(last)) { last = g; count++; }
    assert.strictEqual(count, UNDO_MAX);
    assert.strictEqual(last.nodes[0].id, "n5", "最老的 5 个应被挤掉");
  });
  it("terrKey：只对 bbox/terrain/涂改敏感", () => {
    const a = mkWorld({ terrainOverrides: [{ lon: 1, lat: 2, t: "water" }] });
    const b = mkWorld({ terrainOverrides: [{ lon: 1, lat: 2, t: "water" }], nodes: [{ id: "x", type: "city", lon: 0, lat: 0 }] });
    assert.strictEqual(terrKey(a), terrKey(b), "地点变化不影响地形键");
    const c = mkWorld({ terrainOverrides: [{ lon: 1, lat: 2, t: "forest" }] });
    assert.notStrictEqual(terrKey(a), terrKey(c));
  });
  it("分域快照：同地形连续步共享地形串——驻留≈1×地形+N×对象，而非 N×整档", () => {
    const h = createHistory();
    const to = Array.from({ length: 3000 }, (_, i) => ({ lon: i % 360, lat: (i / 360) | 0, t: "hill/forest" }));
    const full = JSON.stringify(mkWorld({ terrainOverrides: to })).length;
    for (let i = 0; i < 10; i++) h.push(mkWorld({ terrainOverrides: to, nodes: [{ id: "n" + i, type: "city", lon: i, lat: 0 }] }));
    const { steps, bytes } = h.stats();
    assert.strictEqual(steps, 10);
    assert.ok(full > 60_000, "前提自检：地形域应是体积大头");
    assert.ok(bytes < full * 2, `10 步驻留应远小于 10×整档（实际 ${bytes}，整档 ${full}）`);
  });
  it("分域快照：往返逐位等价、键的有无保留（无 heightOverrides 不凭空出现）", () => {
    const h = createHistory();
    const w1 = mkWorld({ nodes: [{ id: "甲", type: "city", lon: 1.5, lat: 2.5 }], terrainOverrides: [{ lon: 1, lat: 2, t: "water" }] });
    const keep = structuredClone(w1);
    h.push(w1);
    const back = h.undo(mkWorld())!;
    assert.deepStrictEqual(back, keep);
    assert.ok(!("heightOverrides" in back), "push 时没有的键恢复后也不该有");
  });
});

describe("自动保存调度", () => {
  it("touch 防抖 600ms；flush 立即；dispose 取消", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let saves = 0;
    const a = createAutosave(() => { saves++; }, 600);
    a.touch(); a.touch(); a.touch();
    assert.strictEqual(a.pending, true);
    t.mock.timers.tick(599);
    assert.strictEqual(saves, 0);
    t.mock.timers.tick(1);
    assert.strictEqual(saves, 1, "三次 touch 合并为一次保存");
    assert.strictEqual(a.pending, false);
    a.touch();
    a.dispose();
    t.mock.timers.tick(1000);
    assert.strictEqual(saves, 1, "dispose 后不再保存");
  });
  it("flush：有挂起才保存，且等待完成", async () => {
    let saves = 0;
    const a = createAutosave(async () => { saves++; }, 600);
    await a.flush();
    assert.strictEqual(saves, 0, "无挂起不保存");
    a.touch();
    await a.flush();
    assert.strictEqual(saves, 1);
    a.dispose();
  });
  it("保存失败：pending 复位为 true（不假已保存）、onError 收到错误、下次 flush 重试", async () => {
    let fail = true, saves = 0;
    const errs: unknown[] = [];
    const a = createAutosave(async () => { if (fail) throw new Error("配额满"); saves++; }, 600, e => errs.push(e));
    a.touch();
    await a.flush();
    assert.strictEqual(a.pending, true, "写失败后仍是脏——UI 显示●未保存");
    assert.strictEqual(errs.length, 1, "onError 被调用");
    assert.strictEqual(saves, 0);
    fail = false;
    await a.flush();
    assert.strictEqual(saves, 1, "下次 flush 自然重试成功");
    assert.strictEqual(a.pending, false);
    a.dispose();
  });
});

describe("编辑操作内核", () => {
  it("dataLon：球面折回 ±180，平面原样", () => {
    assert.strictEqual(dataLon({}, 190), -170);
    assert.strictEqual(dataLon({ worldModel: "flat" }, 190), 190);
  });
  it("addNode：city 起步、四位小数（⚠ 期望有意翻转：原三位＝111m 量子，粗于 100m 战术格）、link=名称", () => {
    const w = mkWorld();
    const n = addNode(w, "洛城", 100.12345, 30.9876);
    assert.strictEqual(n.type, "city", "缺省仍 city 起步（旧行为）");
    assert.strictEqual(addNode(w, "垒", 101, 31, "camp").type, "camp", "柱B：可预选类型落点");
    assert.strictEqual(n.type, "city");
    assert.strictEqual(n.lon, 100.1235);
    assert.strictEqual(n.lat, 30.9876);
    assert.strictEqual(n.link, "洛城");
    assert.strictEqual(w.nodes[0], n);
  });
  it("addLabel：type=label、文本=名称、经度折回四位小数（同 addNode 期望翻转）、无 link/字段", () => {
    const w = mkWorld();
    const n = addLabel(w, "申时·东北风↗", 190.12345, 30.9876);
    assert.strictEqual(n.type, "label");
    assert.strictEqual(n.名称, "申时·东北风↗");
    assert.strictEqual(n.lon, -169.8766);
    assert.strictEqual(n.lat, 30.9876);
    assert.ok(!("link" in n) && !("字段" in n), "标注不预填 link/字段");
    assert.strictEqual(w.nodes[0], n);
  });
  it("addEventNear：偏移 +0.4/+0.3、战役默认、年份=当前年", () => {
    const w = mkWorld({ nodes: [{ id: "a", 名称: "洛城", type: "city", lon: 100, lat: 30 }] });
    const ev = addEventNear(w, w.nodes[0], "之战", 3100);
    assert.strictEqual(ev.type, "event");
    assert.strictEqual(ev.evtype, "battle");
    assert.strictEqual(ev.year, 3100);
    assert.strictEqual(ev.lon, 100.4);
    assert.strictEqual(ev.lat, 30.3);
  });
  it("removeNode：连带清理连线与派系 territory 引用", () => {
    const w = mkWorld({
      nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }, { id: "b", type: "city", lon: 3, lat: 4 }],
      edges: [{ from: "a", to: "b", type: "road" }, { from: "b", to: "b2", type: "trade" }],
      factions: [{ id: "f", territory: ["a", "b"] }, { id: "g", territory: ["a"] }]
    });
    assert.strictEqual(removeNode(w, "a"), true);
    assert.deepStrictEqual(w.nodes.map(n => n.id), ["b"]);
    assert.deepStrictEqual(w.edges.map(e => e.from + ">" + e.to), ["b>b2"]);
    assert.deepStrictEqual(w.factions[0].territory, ["b"]);
    assert.ok(!("territory" in w.factions[1]), "territory 清空应整键删除");
    assert.strictEqual(removeNode(w, "没有"), false);
  });
  it("addEdge：同两端同类型不重复；自环拒绝", () => {
    const w = mkWorld({ nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }, { id: "b", type: "city", lon: 3, lat: 4 }] });
    assert.ok(addEdge(w, "a", "b", "road"));
    assert.strictEqual(addEdge(w, "b", "a", "road"), null, "反向同类型视为重复");
    assert.ok(addEdge(w, "a", "b", "river"), "不同类型允许并存");
    assert.strictEqual(addEdge(w, "a", "a", "road"), null);
    assert.strictEqual(w.edges.length, 2);
    assert.strictEqual(removeEdgeAt(w, 0), true);
    assert.strictEqual(w.edges.length, 1);
    assert.strictEqual(removeEdgeAt(w, 9), false);
  });
  it("addRiver：自由画河=一条 river 边，pts 折线、无端点", () => {
    const w = mkWorld({});
    const e = addRiver(w, [[100, 30], [105, 31], [110, 33]]);
    assert.strictEqual(e.type, "river");
    assert.deepStrictEqual(e.pts, [[100, 30], [105, 31], [110, 33]]);
    assert.ok(!("from" in e) && !("to" in e), "自由画河无端点");
    assert.strictEqual(w.edges.length, 1);
    assert.strictEqual(w.edges[0], e);
  });
  it("addFreeEdge：自由画工事=一条 wall 边（柱B），pts 折线、无端点", () => {
    const w = mkWorld({});
    const e = addFreeEdge(w, [[100, 30], [101, 30]], "wall");
    assert.strictEqual(e.type, "wall");
    assert.deepStrictEqual(e.pts, [[100, 30], [101, 30]]);
    assert.ok(!("from" in e) && !("to" in e), "自由画工事无端点");
    assert.strictEqual(w.edges.length, 1);
  });
  it("applyEdgeForm：工事齿面 reverse 真存假删、未传不动（柱B）", () => {
    const e = { type: "wall", pts: [[0, 0], [1, 1]] } as never as import("../src/core/types.ts").Edge;
    applyEdgeForm(e, { 名称: "", note: "", kv: "", since: "", until: "", reverse: true });
    assert.strictEqual(e.reverse, true);
    applyEdgeForm(e, { 名称: "", note: "", kv: "", since: "", until: "", reverse: false });
    assert.ok(!("reverse" in e), "假=删键（缺省齿朝左不落盘）");
    e.reverse = true;
    applyEdgeForm(e, { 名称: "", note: "", kv: "", since: "", until: "" });
    assert.strictEqual(e.reverse, true, "未传 reverse 不动既有值");
  });
  it("addAsset/removeAsset：幂等内嵌 + 连带删落章、空了删键", () => {
    const w = mkWorld({});
    const a = { id: "s1", name: "山", src: "data:image/webp;base64,AA", w: 100, h: 80 };
    addAsset(w, a); addAsset(w, a);                       // 幂等
    assert.strictEqual((w.assets || []).length, 1);
    addDecor(w, 10, 20, "img:s1", 1);
    addDecor(w, 11, 21, "img:s1", 1);
    addDecor(w, 12, 22, "peak", 1);                       // 内置不受连带
    assert.strictEqual(w.decor.length, 3);
    assert.ok(removeAsset(w, "s1"));
    assert.ok(!("assets" in w), "空了删 assets 键");
    assert.strictEqual(w.decor.length, 1, "连带删两枚 img:s1、留内置 peak");
    assert.strictEqual(w.decor[0].kind, "peak");
    assert.strictEqual(removeAsset(w, "s1"), false, "已无=false");
  });
  it("moveNode：经度折回、纬度钳 ±85、四位小数", () => {
    const w = mkWorld({ nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }] });
    moveNode(w, "a", 190.00006, 99);
    assert.strictEqual(w.nodes[0].lon, -169.9999);
    assert.strictEqual(w.nodes[0].lat, 85);
  });
  it("applyNodeForm：空值删键、KV 过滤空行、事件字段", () => {
    const n = { id: "e", type: "event", lon: 1, lat: 2, year: 3000, sides: "旧", radiusKm: 5 } as never as import("../src/core/types.ts").WorldNode;
    applyNodeForm(n, { 名称: "新名", note: "注", link: "L", kv: "人口：十万\n地位：\n驻军： 三千",
      year: "3107", sides: "", result: "大胜" });
    assert.strictEqual(n.名称, "新名");
    assert.deepStrictEqual(n.字段, { 人口: "十万", 驻军: "三千" });
    assert.strictEqual(n.year, 3107);
    assert.ok(!("sides" in n), "清空的对阵应删键");
    assert.strictEqual(n.result, "大胜");
    // 非事件：faction/radius/since
    const c = { id: "c", type: "city", lon: 1, lat: 2 } as never as import("../src/core/types.ts").WorldNode;
    applyNodeForm(c, { 名称: "", note: "", link: "", faction: "", radiusKm: "12", since: "3050", until: "abc", kv: "" });
    assert.strictEqual(c.faction, null);
    assert.strictEqual(c.radiusKm, 12);
    assert.strictEqual(c.since, 3050);
    assert.ok(!("until" in c));
  });
  it("applyNodeForm 标注字段：fs 缺省13不落盘、pin 空删键；非标注不受 fs/pin 影响", () => {
    const L = { id: "l", type: "label", lon: 1, lat: 2 } as never as import("../src/core/types.ts").WorldNode;
    applyNodeForm(L, { 名称: "第一行\n第二行", note: "", link: "", faction: "", kv: "", since: "3050.5", until: "", fs: "17", pin: "nw" });
    assert.strictEqual(L.名称, "第一行\n第二行", "多行文本原样入 名称");
    assert.strictEqual(L.fs, 17);
    assert.strictEqual(L.pin, "nw");
    assert.strictEqual(L.since, 3050.5, "标注吃小数时刻（亚日显隐）");
    applyNodeForm(L, { 名称: "x", note: "", link: "", faction: "", kv: "", since: "", until: "", fs: "13", pin: "" });
    assert.ok(!("fs" in L), "字号回正文 13＝缺省，应删键");
    assert.ok(!("pin" in L), "屏幕角清空应删键");
    const c = { id: "c", type: "city", lon: 1, lat: 2 } as never as import("../src/core/types.ts").WorldNode;
    applyNodeForm(c, { 名称: "x", note: "", link: "", kv: "", fs: "17", pin: "nw" });
    assert.ok(!("fs" in c) && !("pin" in c), "fs/pin 仅标注类型消费");
  });
  it("applyEdgeForm：同语义", () => {
    const e = { from: "a", to: "b", type: "river", 名称: "旧河" } as never as import("../src/core/types.ts").Edge;
    applyEdgeForm(e, { 名称: "  ", note: "深", kv: "宽度：三丈", since: "3000", until: "" });
    assert.ok(!("名称" in e));
    assert.strictEqual(e.note, "深");
    assert.deepStrictEqual(e.字段, { 宽度: "三丈" });
    assert.strictEqual(e.since, 3000);
  });
  it("笔画路径版（2026-08-19 连续批）：一盘一格只处理一次——不重复入库、同格高程一笔只叠一次", () => {
    const M = { worldModel: "sphere", terrain: "plain", gridN: 8, bbox: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 } } as never as import("../src/core/types.ts").Meta;   // 8 列＝0.5°/格
    const g = buildGridCells(M, [], 0);
    const blank = (): import("../src/core/types.ts").World =>
      ({ meta: M, factions: [], nodes: [], edges: [], decor: [], terrainOverrides: [], units: [] } as never as import("../src/core/types.ts").World);
    const key = (o: { lon: number; lat: number }): string => o.lon + "," + o.lat;
    /* 两个盘心相隔一格、半径 1 格（十字 5 格）：并集 8 格、重叠 2 格。 */
    const A: [number, number] = [101.25, 31.25], B: [number, number] = [101.75, 31.25];   // 图幅内部，免得圆盘被边界削掉

    const wp = blank(); paintHeightPath(wp, g, [A, B], 0.02, 2, null);
    assert.strictEqual(wp.heightOverrides!.length, 8, "并集 8 格，重叠格不许多出一条");
    assert.ok(wp.heightOverrides!.every(o => o.dh === 0.02), "同一笔里重叠格只叠一次（快拖不该比慢拖挖得深）");

    const wa = blank();
    paintHeightAt(wa, g, A[0], A[1], 0.02, 2, null); paintHeightAt(wa, g, B[0], B[1], 0.02, 2, null);
    assert.deepStrictEqual(new Set(wa.heightOverrides!.map(key)), new Set(wp.heightOverrides!.map(key)), "覆盖范围与逐点各落一笔相同");
    assert.strictEqual(wa.heightOverrides!.filter(o => o.dh === 0.04).length, 2, "对照：分两次落笔才是两笔叠加（每个 move 一笔的旧语义不变）");

    const wt = blank(); paintTerrainPath(wt, g, 0, [A, B], "hill", 2, false, null, "lf");
    assert.strictEqual(wt.terrainOverrides!.length, 8, "地形同理：重叠格不许写两条（新写的不在桶里，后一盘看不见它）");
    assert.strictEqual(new Set(wt.terrainOverrides!.map(key)).size, 8);
  });

  it("paintHeightAt：同格图章加性合并、下切、累加≈0 自动清除", () => {
    const M = { worldModel: "sphere", terrain: "plain", gridN: 4, bbox: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 } } as never as import("../src/core/types.ts").Meta;   // 4 列＝1°/格
    const g = buildGridCells(M, [], 0);
    const w = { meta: M, factions: [], nodes: [], edges: [], decor: [], terrainOverrides: [], units: [] } as never as import("../src/core/types.ts").World;
    paintHeightAt(w, g, 101.5, 31.5, 0.02, 1, null);
    assert.strictEqual(w.heightOverrides!.length, 1);
    assert.strictEqual(w.heightOverrides![0].dh, 0.02);
    paintHeightAt(w, g, 101.5, 31.5, 0.02, 1, null);
    assert.strictEqual(w.heightOverrides!.length, 1, "同格合并不增条目");
    assert.strictEqual(w.heightOverrides![0].dh, 0.04);
    paintHeightAt(w, g, 101.5, 31.5, -0.04, 1, null);
    assert.strictEqual(w.heightOverrides!.length, 0, "抬回原高=无痕清除");
    paintHeightAt(w, g, 101.5, 31.5, -0.02, 2, null);   // 半径 1 格圆盘=十字 5 格下切
    assert.strictEqual(w.heightOverrides!.length, 5);
    assert.ok(w.heightOverrides!.every(o => o.dh === -0.02));
  });
  it("地貌笔＝重定基面：涂到之处清当刻手雕高程；生态轴不清、橡皮不清、时段外不清（2026-08-08）", async () => {
    const { paintTerrainAt } = await import("../src/ui/editops.ts");
    const M = { worldModel: "sphere", terrain: "plain", gridN: 4, bbox: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 } } as never as import("../src/core/types.ts").Meta;   // 4 列＝1°/格
    const g = buildGridCells(M, [], 3000);
    const mk = () => {
      const w = { meta: M, factions: [], nodes: [], edges: [], decor: [], terrainOverrides: [], units: [] } as never as import("../src/core/types.ts").World;
      paintHeightAt(w, g, 101.5, 31.5, 0.5, 1, null);                       // 雕一格
      paintHeightAt(w, g, 103.5, 33.5, 0.5, 1, null);                       // 远处对照雕痕
      return w;
    };
    const w1 = mk();
    paintTerrainAt(w1, g, 3000, 101.5, 31.5, "plain", 1, false, null, "lf");
    assert.strictEqual(w1.heightOverrides!.length, 1, "地貌轴落笔＝笔下雕痕复位");
    assert.strictEqual(w1.heightOverrides![0].lat, 33.5, "笔外雕痕原样");
    const w2 = mk();
    paintTerrainAt(w2, g, 3000, 101.5, 31.5, "plain/forest", 1, false, null, "eco");
    assert.strictEqual(w2.heightOverrides!.length, 2, "生态轴不清雕痕（林可以长在雕出的山上）");
    const w3 = mk();
    paintTerrainAt(w3, g, 3000, 101.5, 31.5, "plain", 1, true, null, "lf");
    assert.strictEqual(w3.heightOverrides!.length, 2, "橡皮各轴自守＝不清雕痕");
    const w4 = mk();
    w4.heightOverrides![0].since = 3100;                                    // 笔下雕痕改成未来时段
    paintTerrainAt(w4, g, 3000, 101.5, 31.5, "plain", 1, false, null, "lf");
    assert.strictEqual(w4.heightOverrides!.length, 2, "当刻不生效的雕痕不清（时段层语义）");
  });
  it("涂改块尺寸 ov.step：格细于 1° 就记（对齐旧 paintAt·存档格式兼容）", async () => {
    const { paintTerrainAt } = await import("../src/ui/editops.ts");
    /* ⚠ **期望有意翻转**（2026-08-12 强制自动档）：判据一直是「缺 step 键＝按 1° 粗块解读」，
       从前战略图的格恰好就是 1° 所以不必记；自动档后战略图的格也恒细于 1°，于是两个图种都记。
       仍不记键的只剩「格恰好 1° 或更粗」——48° 图幅写死 48 列即是，也正是黄金基准夹具的形状。 */
    const sm = { gridN: 48, bbox: { lonMin: 100, lonMax: 148, latMin: 30, latMax: 62 } } as never as import("../src/core/types.ts").Meta;
    const sg = buildGridCells(sm, [], 3000);
    assert.strictEqual(sg.step, 1, "前提：这张战略图恰好 1°/格");
    const sw = mkWorld({ meta: sm });
    paintTerrainAt(sw, sg, 3000, 101.5, 31.5, "water", 1, false, null);
    assert.strictEqual(sw.terrainOverrides.length, 1);
    assert.ok(!("step" in sw.terrainOverrides[0]), "恰 1° 的涂改不带 step 键（v0.14 存档形状）");
    // 战术图（步长=跨度/140）：记录 +step.toFixed(7)，与继承的 1° 粗块区分
    const tm = { mapKind: "tactical", bbox: { lonMin: 100, lonMax: 101.4, latMin: 30, latMax: 31.4 } } as never as import("../src/core/types.ts").Meta;
    const tg = buildGridCells(tm, [], 3000);
    const tw = mkWorld({ meta: tm });
    paintTerrainAt(tw, tg, 3000, 100.7, 30.7, "water", 1, false, null);
    assert.strictEqual(tw.terrainOverrides.length, 1);
    assert.strictEqual(tw.terrainOverrides[0].step, +tg.step.toFixed(7), "战术涂改记录自身块尺寸");
    // 高程涂改同规则
    paintHeightAt(tw, tg, 100.7, 30.7, 0.02, 1, null);
    assert.strictEqual(tw.heightOverrides![0].step, +tg.step.toFixed(7));
    const sw2 = mkWorld({ meta: sm });
    paintHeightAt(sw2, sg, 101.5, 31.5, 0.02, 1, null);
    assert.ok(!("step" in sw2.heightOverrides![0]), "恰 1° 的高程涂改不带 step 键");
  });
  it("战略图开了网格密度即记 step——不记的话烘焙成战术图时会按 1° 粗块盖章（面积三十几倍）", async () => {
    const { paintTerrainAt } = await import("../src/ui/editops.ts");
    /* 判据自 2026-08-12 起是「格细于 1°」而非「是不是战术图」：缺 step 键＝按 1° 粗块解读
       （grid/erode/elev 三处 `+(o.step) || step` 与 core/tactical 烘焙的 `|| 1` 同规）。 */
    const dm = { gridN: 192, bbox: { lonMin: 100, lonMax: 148, latMin: 30, latMax: 62 } } as never as import("../src/core/types.ts").Meta;
    const dg = buildGridCells(dm, [], 3000);
    assert.ok(dg.step < 1, `前提：这张战略图的格细于 1°（实得 ${dg.step}）`);
    const dw = mkWorld({ meta: dm });
    paintTerrainAt(dw, dg, 3000, 101.5, 31.5, "water", 1, false, null);
    assert.strictEqual(dw.terrainOverrides[0].step, +dg.step.toFixed(7), "细格战略涂改须记块尺寸");
    paintHeightAt(dw, dg, 101.5, 31.5, 0.02, 1, null);
    assert.strictEqual(dw.heightOverrides![0].step, +dg.step.toFixed(7), "高程涂改同规则");
  });
  it("细格 step 量化不扩格（2026-08 审查修正）：涂1格重建恰1格；旧4位量化章擦得掉、并得进", async () => {
    const { paintTerrainAt } = await import("../src/ui/editops.ts");
    /* 缺省半径(10000km)母图烘出的战术格边 0.000573°——toFixed(4)=0.0006 向上偏 4.7%，旧写法在
       重建端被 1.001 容差判成粗块：一格涂改扩成 2×2、橡皮擦不掉、高程同格不合并（探针实证）。 */
    const m = { mapKind: "tactical", worldModel: "flat", kmPerDeg: 174.5329, gridN: 60, terrain: "plain",
      bbox: { lonMin: 100, lonMax: 100.03438, latMin: 30, latMax: 30.03438 } } as never as import("../src/core/types.ts").Meta;
    const g = buildGridCells(m, [], 0);
    assert.ok(+g.step.toFixed(4) > g.step * 1.001, `前提：这格边的 4 位量化会越过 1.001 容差（step=${g.step}）`);
    const w = mkWorld({ meta: m });
    const lon = g.bb.lonMin + 30.5 * g.step, lat = g.bb.latMin + 30.5 * g.step;
    paintTerrainAt(w, g, 0, lon, lat, "water", 1, false, null);
    assert.strictEqual(w.terrainOverrides[0].step, +g.step.toFixed(7));
    const g1 = buildGridCells(m, w.terrainOverrides, 0);
    let diff = 0;
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) if (g1.cells[r][c] !== g.cells[r][c]) diff++;
    assert.strictEqual(diff, 1, "涂 1 格重建后应恰变 1 格");
    // 旧档里 4 位量化的同格章：靠 hit 判据的绝对容差被橡皮擦掉（自愈只发生在笔下）
    w.terrainOverrides = [{ lon: +lon.toFixed(4), lat: +lat.toFixed(4), t: "water", step: +g.step.toFixed(4) }];
    paintTerrainAt(w, g, 0, lon, lat, "water", 1, true, null);
    assert.strictEqual(w.terrainOverrides.length, 0, "旧量化章应被擦除");
    // 高程：同格两笔并成一条；旧量化章被并入且 step 校直
    w.heightOverrides = [{ lon: +lon.toFixed(4), lat: +lat.toFixed(4), dh: 0.5, step: +g.step.toFixed(4) }];
    paintHeightAt(w, g, lon, lat, 0.5, 1, null);
    assert.strictEqual(w.heightOverrides.length, 1, "并进旧章而非另立新条");
    assert.strictEqual(w.heightOverrides[0].dh, 1);
    assert.strictEqual(w.heightOverrides[0].step, +g.step.toFixed(7), "并入时把量化 step 校直");
  });
  it("splitOverridesToStep 已删（2026-08-13 冻结批）：尺寸/密度创建后冻结,「改图幅=改格边」的迁移路不存在了", async () => {
    const ops = await import("../src/ui/editops.ts");
    assert.ok(!("splitOverridesToStep" in ops), "冻结后不该再有涂改拆分入口——它复活即说明有人重新打开了改图幅的路");
  });
  it("applyEdgeForm：河宽 widthM——>0 存、空/非法删、不传不动", () => {
    const e = { from: "a", to: "b", type: "river" } as never as import("../src/core/types.ts").Edge;
    applyEdgeForm(e, { 名称: "", note: "", kv: "", since: "", until: "", widthM: "300" });
    assert.strictEqual(e.widthM, 300);
    applyEdgeForm(e, { 名称: "", note: "", kv: "", since: "", until: "" });
    assert.strictEqual(e.widthM, 300, "不传 widthM 不改动");
    applyEdgeForm(e, { 名称: "", note: "", kv: "", since: "", until: "", widthM: "0" });
    assert.ok(!("widthM" in e), "0/空=删键");
  });
  it("changeNodeType：转事件补 evtype/year", () => {
    const n = { id: "x", type: "city", lon: 1, lat: 2 } as never as import("../src/core/types.ts").WorldNode;
    changeNodeType(n, "event", 3099, v => !!EVENT_TYPES[String(v)]);
    assert.strictEqual(n.evtype, "battle");
    assert.strictEqual(n.year, 3099);
  });
});

describe("signals 变更管线", () => {
  it("mutateWorld：换引用广播、可撤销、editVer 递增；grid 标记递增 gridVer", () => {
    setWorldState(mkWorld({ nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }] }));
    const ref0 = worldSig.value, ev0 = editVerSig.value, gv0 = gridVerSig.value;
    mutateWorld(w => { w.nodes[0].lon = 50; });
    assert.notStrictEqual(worldSig.value, ref0, "应换引用");
    assert.strictEqual(worldSig.value!.nodes[0].lon, 50);
    assert.strictEqual(editVerSig.value, ev0 + 1);
    assert.strictEqual(gridVerSig.value, gv0, "非地形改动不动 gridVer");
    assert.strictEqual(canUndoSig.value, true);
    mutateWorld(w => { w.terrainOverrides.push({ lon: 1, lat: 2, t: "water" }); }, { grid: true });
    assert.strictEqual(gridVerSig.value, gv0 + 1);
  });
  it("mutateWorld：fn 抛异常回收快照，不留幽灵撤销步", () => {
    setWorldState(mkWorld({ nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }] }));
    assert.strictEqual(canUndoSig.value, false);
    const ref0 = worldSig.value, ev0 = editVerSig.value;
    assert.throws(() => mutateWorld(() => { throw new Error("boom"); }));
    assert.strictEqual(canUndoSig.value, false, "抛异常不留可撤销步（幽灵快照已回收）");
    assert.strictEqual(worldSig.value, ref0, "未广播、不换引用");
    assert.strictEqual(editVerSig.value, ev0, "未递增 editVer");
  });
  it("undo/redo：世界回滚、选中清空、地形变化才动 gridVer", () => {
    setWorldState(mkWorld({ nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }] }));
    mutateWorld(w => { w.nodes[0].lon = 77; });
    selSig.value = { kind: "node", id: "a" };
    const gv = gridVerSig.value;
    undoWorld();
    assert.strictEqual(worldSig.value!.nodes[0].lon, 1);
    assert.strictEqual(selSig.value, null, "撤销后选中清空（旧引用失效）");
    assert.strictEqual(gridVerSig.value, gv, "地点移动的撤销不重建网格");
    assert.strictEqual(canRedoSig.value, true);
    redoWorld();
    assert.strictEqual(worldSig.value!.nodes[0].lon, 77);
    // 涂改类改动的撤销要重建
    mutateWorld(w => { w.terrainOverrides.push({ lon: 5, lat: 5, t: "water" }); }, { grid: true });
    const gv2 = gridVerSig.value;
    undoWorld();
    assert.strictEqual(gridVerSig.value, gv2 + 1, "terrKey 变化 → gridVer 递增");
  });
  it("拖动序列：pushHistoryOnce + mutateWorldLive 多帧 = 一步撤销", () => {
    setWorldState(mkWorld({ nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }] }));
    pushHistoryOnce();
    for (const lon of [2, 3, 4, 5]) mutateWorldLive(w => { w.nodes[0].lon = lon; });
    assert.strictEqual(worldSig.value!.nodes[0].lon, 5);
    undoWorld();
    assert.strictEqual(worldSig.value!.nodes[0].lon, 1, "一次撤销回到拖动前");
  });
  it("笔刷空步回收：beginStroke 后无广播 → endStroke 丢弃空快照；有改动则保留", async () => {
    const { beginStroke, endStroke } = await import("../src/ui/state.ts");
    setWorldState(mkWorld({ nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }] }));
    assert.strictEqual(canUndoSig.value, false);
    // 空笔：起笔 push 一步，整笔无广播（模拟涂已涂格/擦空白）→ 回收
    beginStroke();
    assert.strictEqual(canUndoSig.value, true, "起笔即入栈");
    mutateWorldLive(() => false);   // fn 返回 false=无改动，不广播
    endStroke();
    assert.strictEqual(canUndoSig.value, false, "空笔回收：栈顶空快照被丢弃");
    // 实笔：有广播 → 保留
    beginStroke();
    mutateWorldLive(w => { w.nodes[0].lon = 9; });
    endStroke();
    assert.strictEqual(canUndoSig.value, true, "有改动的笔保留撤销步");
    undoWorld();
    assert.strictEqual(worldSig.value!.nodes[0].lon, 1);
  });
  it("mutateWorldLive 返回 false：不换引用、不递增 editVer（空笔不触发自动保存）", () => {
    setWorldState(mkWorld({ nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }] }));
    const ref0 = worldSig.value, ev0 = editVerSig.value;
    mutateWorldLive(() => false);
    assert.strictEqual(worldSig.value, ref0, "无改动不换引用");
    assert.strictEqual(editVerSig.value, ev0, "无改动不递增 editVer");
  });
  it("setWorldState 清撤销栈；yearSig 按新世界钳制", () => {
    setWorldState(mkWorld());
    mutateWorld(w => { w.nodes.push({ id: "z", type: "city", lon: 1, lat: 2 }); });
    yearSig.value = 99999;
    setWorldState(mkWorld({ nodes: [{ id: "e", type: "event", evtype: "battle", lon: 1, lat: 2, year: 3100 }] }));
    assert.strictEqual(canUndoSig.value, false, "换世界清撤销栈");
    assert.strictEqual(yearSig.value, 3100, "出界年份回到上限");
  });
});

describe("单对象删除 helper（即时删 + 精准清选中；三门面带可撤销 toast，派系带 confirm）", () => {
  it("deleteNodeAt：删被选中项→清选中、出可撤销 toast、撤销可复原", () => {
    setWorldState(mkWorld({ nodes: [{ id: "a", type: "city", lon: 1, lat: 2, 名称: "甲" }, { id: "b", type: "city", lon: 3, lat: 4 }] }));
    selSig.value = { kind: "node", id: "a" };
    deleteNodeAt("a");
    assert.strictEqual(worldSig.value!.nodes.find(n => n.id === "a"), undefined, "已删除");
    assert.strictEqual(selSig.value, null, "被删的正是选中项→清选中");
    const t = toastSig.peek();
    assert.ok(t && t.undo, "出可撤销 toast");
    assert.strictEqual(canUndoSig.value, true);
    undoWorld();
    assert.ok(worldSig.value!.nodes.find(n => n.id === "a"), "撤销复原");
  });
  it("deleteNodeAt：删非选中项不动当前选中（删工具点删旁边对象）", () => {
    setWorldState(mkWorld({ nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }, { id: "b", type: "city", lon: 3, lat: 4 }] }));
    selSig.value = { kind: "node", id: "b" };
    deleteNodeAt("a");
    assert.deepStrictEqual(selSig.value, { kind: "node", id: "b" }, "删 a 不清对 b 的选中");
    assert.ok(worldSig.value!.nodes.find(n => n.id === "b"), "b 还在");
  });
  it("deleteEdgeIdx：按下标删、清对该下标的选中、撤销复原", () => {
    setWorldState(mkWorld({
      nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }, { id: "b", type: "city", lon: 3, lat: 4 }],
      edges: [{ from: "a", to: "b", type: "road" }],
    }));
    selSig.value = { kind: "edge", idx: 0 };
    deleteEdgeIdx(0);
    assert.strictEqual(worldSig.value!.edges.length, 0, "已删");
    assert.strictEqual(selSig.value, null, "清选中");
    undoWorld();
    assert.strictEqual(worldSig.value!.edges.length, 1, "撤销复原");
  });
  /* 派系删除单列一门面（爆炸半径大→保留 confirm、不发 toast）：卡片与表单两处调用点曾各写一份且已漂移
     （卡片那份漏清涂域目标，靠 DrawPane 的自愈守卫兜住）——下面三测锁住收口后的完整语义。 */
  it("deleteFactionAt：确认后连带中立化 + 清涂域目标 + 清选中 + 撤销复原", () => {
    setWorldState(mkWorld({
      factions: [{ id: "f1", 名称: "甲派", color: "#c00" }],
      nodes: [{ id: "a", type: "city", lon: 1, lat: 2, faction: "f1", owners: [{ faction: "f1", since: 3000 }] }],
    }));
    selSig.value = { kind: "faction", id: "f1" };
    paintFactionSig.value = "f1";
    paintLayerSig.value = 2;
    deleteFactionAt("f1", () => true);
    assert.strictEqual(worldSig.value!.factions.length, 0, "派系已删");
    assert.strictEqual(worldSig.value!.nodes[0].faction, null, "地点归属中立化");
    assert.strictEqual(worldSig.value!.nodes[0].owners, undefined, "沿革条目剔除（空则删键）");
    assert.strictEqual(paintFactionSig.value, null, "涂域目标同步清空");
    assert.strictEqual(paintLayerSig.value, 0, "涂域层归零");
    assert.strictEqual(selSig.value, null, "被删的正是选中项→清选中");
    undoWorld();
    assert.strictEqual(worldSig.value!.factions.length, 1, "撤销复原");
  });
  it("deleteFactionAt：取消＝一字不改（confirm 必须先于 mutateWorld）", () => {
    setWorldState(mkWorld({
      factions: [{ id: "f1", 名称: "甲派" }],
      nodes: [{ id: "a", type: "city", lon: 1, lat: 2, faction: "f1" }],
    }));
    selSig.value = { kind: "faction", id: "f1" };
    paintFactionSig.value = "f1";
    const before = worldSig.value;
    deleteFactionAt("f1", () => false);
    assert.strictEqual(worldSig.value, before, "世界引用未换＝根本没进 mutateWorld");
    assert.strictEqual(worldSig.value!.nodes[0].faction, "f1", "归属不动");
    assert.deepStrictEqual(selSig.value, { kind: "faction", id: "f1" }, "选中不动");
    assert.strictEqual(paintFactionSig.value, "f1", "涂域目标不动");
    assert.strictEqual(canUndoSig.value, false, "不留撤销步");
  });
  it("deleteFactionAt：删非选中派系不动当前选中与涂域目标（与三门面同规）", () => {
    setWorldState(mkWorld({ factions: [{ id: "f1", 名称: "甲" }, { id: "f2", 名称: "乙" }] }));
    selSig.value = { kind: "faction", id: "f2" };
    paintFactionSig.value = "f2";
    deleteFactionAt("f1", () => true);
    assert.strictEqual(worldSig.value!.factions.length, 1, "只删了 f1");
    assert.deepStrictEqual(selSig.value, { kind: "faction", id: "f2" }, "删 f1 不清对 f2 的选中");
    assert.strictEqual(paintFactionSig.value, "f2", "涂域目标是 f2 → 不动");
  });
});

describe("派系与涂域", () => {
  it("addFaction：调色板轮转；removeFaction 连带清理归属/沿革/作战线side", async () => {
    const { addFaction, removeFaction, FAC_PALETTE } = await import("../src/ui/editops.ts");
    const w = mkWorld({
      nodes: [
        { id: "a", type: "city", lon: 1, lat: 2, faction: "f1" },
        { id: "b", type: "city", lon: 3, lat: 4, owners: [{ faction: "f1", until: 3100 }, { faction: "f2", since: 3100 }] },
        { id: "e", type: "event", evtype: "battle", lon: 5, lat: 6, ops: [{ kind: "attack", pts: [[1, 2], [3, 4]], side: "f1" }] }
      ],
      factions: [{ id: "f1", 名称: "甲" }, { id: "f2", 名称: "乙" }],
      units: [{ id: "u", kind: "inf", faction: "f1", track: [] }, { id: "v", kind: "cav", faction: "f2", track: [] }]
    });
    const nf = addFaction(w);
    assert.strictEqual(nf.color, FAC_PALETTE[2], "第三个派系用调色板第 3 色");
    assert.strictEqual(removeFaction(w, "f1"), true);
    assert.strictEqual(w.nodes[0].faction, null);
    assert.deepStrictEqual(w.nodes[1].owners!.map(o => o.faction), ["f2"], "沿革中 f1 条目剔除");
    assert.strictEqual(w.nodes[2].ops![0].side, null);
    assert.strictEqual(w.units[0].faction, null, "部队 f1 归属清空（旧版同漏，一并修）");
    assert.strictEqual(w.units[1].faction, "f2", "非该派系的部队归属不动");
    assert.deepStrictEqual(w.factions.map(f => f.id), ["f2", nf.id]);
  });
  it("applyFactionForm：空值删键、名称/颜色回退保留", async () => {
    const { applyFactionForm } = await import("../src/ui/editops.ts");
    const f = { id: "f", 名称: "旧名", color: "#111111", 阵营: "旧营", note: "旧注" } as never as import("../src/core/types.ts").Faction;
    applyFactionForm(f, { 名称: "  ", color: "", 阵营: "", since: "3000", until: "abc", note: "", link: "L" });
    assert.strictEqual(f.名称, "旧名");
    assert.strictEqual(f.color, "#111111");
    assert.ok(!("阵营" in f) && !("note" in f) && !("until" in f));
    assert.strictEqual(f.since, 3000);
    assert.strictEqual(f.link, "L");
  });
  it("涂域位图：层(cells/runs 双认)↔位图↔runs 往返稳定（2026-08-13 尺度定形批,存档读旧写新）", async () => {
    const { maskFromLayer, runsFromMask } = await import("../src/ui/paint.ts");
    const { paintCellSet } = await import("../src/core/territory.ts");
    const pd = 0.5;
    const cells: [number, number][] = [[100.25, 30.25], [82.25, 22.25], [129.75, 53.75]];
    const m1 = maskFromLayer({}, { cells }, pd);
    assert.strictEqual(m1.data.reduce((a, b) => a + b, 0), 3, "三个旧坐标对各亮一格");
    const runs = runsFromMask(m1);
    assert.strictEqual(runs.pd, pd);
    assert.strictEqual(runs.d.length, 9, "三格互不相邻＝三条行程");
    // runs 解码回集合＝与 cells 解码逐位同集（读旧写新的等价性）
    const bb = m1.bb;
    assert.deepStrictEqual([...paintCellSet({ runs }, bb, pd)].sort(), [...paintCellSet(cells, bb, pd)].sort());
    // 再进位图＝定点（往返稳定）
    const m2 = maskFromLayer({}, { runs }, pd);
    assert.deepStrictEqual([...m2.data], [...m1.data]);
    // 连排格压成单条行程（行程编码真的在压）
    const row: [number, number][] = [[100.25, 30.25], [100.75, 30.25], [101.25, 30.25]];
    const r2 = runsFromMask(maskFromLayer({}, { cells: row }, pd));
    assert.strictEqual(r2.d.length, 3, "同行连排＝一条 [j,i0,len]");
    assert.strictEqual(r2.d[2], 3, "len=3");
  });
  it("brushMask：圆盘半径/越界裁剪/橡皮/无变化返回 false", async () => {
    const { paintDims, maskFromLayer, brushMask } = await import("../src/ui/paint.ts");
    const dims = paintDims({});
    const m = maskFromLayer({}, { cells: [] }, 0.5);
    const count = () => m.data.reduce((a: number, b: number) => a + b, 0);
    assert.strictEqual(brushMask(m, 100.25, 30.25, 3, false), true);
    const n3 = count();
    assert.ok(n3 >= 9 && n3 <= 21, `size=3 圆盘应 9~21 格，得 ${n3}`);
    assert.strictEqual(brushMask(m, 100.25, 30.25, 3, false), false, "重涂同处无变化");
    assert.strictEqual(brushMask(m, 100.25, 30.25, 3, true), true, "橡皮清除");
    assert.strictEqual(count(), 0);
    brushMask(m, dims.bb.lonMin + 0.1, dims.bb.latMin + 0.1, 4, false);
    assert.ok(count() > 0 && count() < 49, "贴角落笔＝越界半盘被裁剪");
  });
  it("ensurePaintLayer / removePaintLayer / setPaintLayerSpan", async () => {
    const { ensurePaintLayer } = await import("../src/ui/paint.ts");
    const { removePaintLayer, setPaintLayerSpan } = await import("../src/ui/editops.ts");
    const f = { id: "f" } as never as import("../src/core/types.ts").Faction;
    const i0 = ensurePaintLayer(f, 0);
    assert.strictEqual(i0, 0);
    assert.strictEqual(f.paint!.length, 1);
    assert.strictEqual(ensurePaintLayer(f, 0), 0, "已有层不重复建");
    assert.strictEqual(ensurePaintLayer(f, 7), 0, "越界下标钳到既有层（信号残留不建幻影空层）");
    assert.strictEqual(ensurePaintLayer(f, -3), 0, "负下标钳到 0");
    assert.strictEqual(f.paint!.length, 1, "钳制路径不新增层");
    const L = f.paint![0];
    setPaintLayerSpan(L, "3100", "");
    assert.strictEqual(L.since, 3100);
    assert.ok(!("until" in L));
    assert.strictEqual(removePaintLayer(f, 0), true);
    assert.ok(!("paint" in f), "最后一层删除后整键删除");
  });
});

describe("作战线", () => {
  it("rdp：共线中间点全丢、离弦远的点保留、eps 阈值分界、<3 点原样副本", async () => {
    const { rdp } = await import("../src/core/geometry.ts");
    assert.deepStrictEqual(rdp([[0, 0], [1, 1], [2, 2], [3, 3]], 0.01), [[0, 0], [3, 3]], "共线只剩首末");
    assert.deepStrictEqual(rdp([[0, 0], [1, 1], [2, 0]], 0.5), [[0, 0], [1, 1], [2, 0]], "尖点离弦=1>eps 保留");
    assert.deepStrictEqual(rdp([[0, 0], [1, 1], [2, 0]], 2), [[0, 0], [2, 0]], "同尖点 eps=2 时丢弃");
    const two: [number, number][] = [[0, 0], [1, 1]];
    const r = rdp(two, 1);
    assert.deepStrictEqual(r, two);
    assert.notStrictEqual(r, two, "<3 点返回副本");
  });
  it("addOp / removeOp：挂事件点 ops[]、返回下标、空则删键、非事件=null", async () => {
    const { addOp, removeOp } = await import("../src/ui/editops.ts");
    const w = mkWorld({ nodes: [
      { id: "e", type: "event", evtype: "battle", lon: 1, lat: 2, year: 3000 },
      { id: "c", type: "city", lon: 0, lat: 0 }
    ] });
    assert.strictEqual(addOp(w, "e", "attack", [[1, 2], [3, 4]]), 0);
    assert.deepStrictEqual(w.nodes[0].ops![0], { kind: "attack", pts: [[1, 2], [3, 4]], side: null, troop: "", label: "", w: 3 });
    assert.strictEqual(addOp(w, "e", "defense", [[5, 6], [7, 8]]), 1);
    assert.strictEqual(addOp(w, "c", "attack", [[0, 0], [1, 1]]), null, "非事件点不挂线");
    assert.strictEqual(addOp(w, "没有", "attack", [[0, 0], [1, 1]]), null);
    assert.strictEqual(removeOp(w, "e", 9), false);
    assert.strictEqual(removeOp(w, "e", 0), true);
    assert.strictEqual(w.nodes[0].ops!.length, 1);
    assert.strictEqual(removeOp(w, "e", 0), true);
    assert.ok(!("ops" in w.nodes[0]), "最后一条删除后 ops 整键删除");
  });
  it("选中/编辑管线：selectOp 联动 selSig；一次选中多改=一步撤销；reverse 翻转；clearOpSel 复位", async () => {
    const { opSelSig, selectOp, clearOpSel, opEdit } = await import("../src/ui/state.ts");
    setWorldState(mkWorld({ nodes: [
      { id: "e", type: "event", evtype: "battle", lon: 1, lat: 2, year: 3000,
        ops: [{ kind: "defense", pts: [[1, 2], [3, 4]], side: null, troop: "", label: "", w: 3 }] }
    ] }));
    assert.ok(worldSig.value!.nodes[0].ops, "normalize 保留已有 ops");
    selectOp("e", 0);
    assert.deepStrictEqual(opSelSig.value, { evId: "e", i: 0 });
    assert.deepStrictEqual(selSig.value, { kind: "node", id: "e" }, "选中线=事件保持选中（跨年可见）");
    const ev0 = editVerSig.value;
    opEdit(o => { o.troop = "皇天卫"; });
    opEdit(o => { o.w = 6; });
    assert.strictEqual(worldSig.value!.nodes[0].ops![0].troop, "皇天卫");
    assert.strictEqual(worldSig.value!.nodes[0].ops![0].w, 6);
    assert.ok(editVerSig.value > ev0 && canUndoSig.value, "改动广播且可撤销");
    undoWorld();
    const op = worldSig.value!.nodes[0].ops![0];
    assert.strictEqual(op.troop, "", "一步撤销回到选中前：troop");
    assert.strictEqual(op.w, 3, "一步撤销回到选中前：w");
    assert.strictEqual(opSelSig.value, null, "撤销清空作战线选中");
    selectOp("e", 0);
    opEdit(o => { o.reverse = !o.reverse; });   // 翻转正面=切 reverse 布尔（不动几何）
    assert.strictEqual(worldSig.value!.nodes[0].ops![0].reverse, true);
    assert.deepStrictEqual(worldSig.value!.nodes[0].ops![0].pts, [[1, 2], [3, 4]], "翻转不改坐标");
    clearOpSel();
    assert.strictEqual(opSelSig.value, null);
  });
  it("随时编辑表单：同目标重选不复位 inspEdit，目标变化才复位（桌面打磨批 P2）", async () => {
    const { inspEditSig, selectOp } = await import("../src/ui/state.ts");
    setWorldState(mkWorld({ nodes: [
      { id: "e", type: "event", evtype: "battle", lon: 1, lat: 2, year: 3000,
        ops: [{ kind: "attack", pts: [[1, 2], [3, 4]], side: null, troop: "", label: "", w: 3 }] },
      { id: "b", type: "city", lon: 3, lat: 4 }
    ] }));
    selSig.value = { kind: "node", id: "e" };
    inspEditSig.value = true;                     // 浏览态「编辑」开表单
    selectOp("e", 0);                             // 表单里点作战线行：同一事件保持选中
    assert.strictEqual(inspEditSig.value, true, "同目标重选不打断编辑（不丢未保存输入）");
    selSig.value = { kind: "node", id: "e" };     // 画布再点同一地点（新对象、同 id）
    assert.strictEqual(inspEditSig.value, true, "同 id 重赋值不复位");
    selSig.value = { kind: "node", id: "b" };     // 换目标
    assert.strictEqual(inspEditSig.value, false, "选中变化即回卡片");
    selSig.value = null;
  });
});

describe("地形涂改", () => {
  it("paintTerrainAt：圆盘笔刷改格、经 buildGridCells 生效、同格重涂不堆叠、橡皮回种子、空擦无变化", async () => {
    const { paintTerrainAt } = await import("../src/ui/editops.ts");
    const { buildGridCells } = await import("../src/core/grid.ts");
    const meta = { gridN: 4, bbox: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 } };   // 4×4 战略网格（写死 4 列＝step=1）
    const lon = 101.5, lat = 31.5, c = 1, r = 1;                                    // 落在 (r1,c1) 格中心
    const g0 = buildGridCells(meta, [], 3000);
    const seed = g0.cells[r][c];
    const other = seed === "water" ? "mountain" : "water";

    const w = mkWorld({ meta });
    assert.strictEqual(paintTerrainAt(w, g0, 3000, lon, lat, other, 1, false), true);
    assert.strictEqual(w.terrainOverrides.length, 1);
    assert.deepStrictEqual(w.terrainOverrides[0], { lon: 101.5, lat: 31.5, t: other });
    assert.strictEqual(buildGridCells(meta, w.terrainOverrides, 3000).cells[r][c], other, "涂改经 buildGridCells 生效");

    paintTerrainAt(w, g0, 3000, lon, lat, other, 1, false);
    assert.strictEqual(w.terrainOverrides.length, 1, "同格重涂先删旧再写，不堆叠");

    assert.strictEqual(paintTerrainAt(w, g0, 3000, lon, lat, other, 1, true), true, "橡皮移除涂改");
    assert.strictEqual(w.terrainOverrides.length, 0);
    assert.strictEqual(buildGridCells(meta, w.terrainOverrides, 3000).cells[r][c], seed, "橡皮回退种子初稿");

    const w2 = mkWorld({ meta });
    paintTerrainAt(w2, g0, 3000, lon, lat, other, 2, false);   // R=1 圆盘=中心+上下左右=5 格（角点 2>1.5 排除）
    assert.strictEqual(w2.terrainOverrides.length, 5, "size=2 圆盘=5 格");

    assert.strictEqual(paintTerrainAt(mkWorld({ meta }), g0, 3000, lon, lat, other, 1, true), false, "橡皮擦空格无变化");
  });
  it("paintTerrainAt 单轴：生态轴改生态留地貌、地貌轴改地貌留生态、生态 none 清生态", async () => {
    const { paintTerrainAt } = await import("../src/ui/editops.ts");
    const { buildGridCells } = await import("../src/core/grid.ts");
    const meta = { terrain: "plain" as const, gridN: 4, bbox: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 } };   // 初稿全 plain，4 列＝1°/格
    const lon = 101.5, lat = 31.5, r = 1, c = 1;
    const w = mkWorld({ meta });
    const cell = () => buildGridCells(meta, w.terrainOverrides, 3000).cells[r][c];   // 每步按最新涂改重建取该格
    // 生态轴：plain 上叠 forest（地貌 plain 保留）
    paintTerrainAt(w, buildGridCells(meta, w.terrainOverrides, 3000), 3000, lon, lat, "plain/forest", 1, false, null, "eco");
    assert.strictEqual(cell(), "plain/forest", "生态轴：plain 上叠 forest");
    // 地貌轴：改 hill 留 forest（笔刷生态分量被忽略，只取地貌）
    paintTerrainAt(w, buildGridCells(meta, w.terrainOverrides, 3000), 3000, lon, lat, "hill/desert", 1, false, null, "lf");
    assert.strictEqual(cell(), "hill/forest", "地貌轴：改 hill 留 forest");
    // 生态轴 none：清生态回纯地貌 hill
    paintTerrainAt(w, buildGridCells(meta, w.terrainOverrides, 3000), 3000, lon, lat, "hill", 1, false, null, "eco");
    assert.strictEqual(cell(), "hill", "生态轴 none：清生态回纯地貌");
  });
});

describe("布景 + 框选", () => {
  it("addDecor / removeDecor：挂 decor[]、四位小数（同 addNode 期望翻转）、id 唯一、空则删键", async () => {
    const { addDecor, removeDecor } = await import("../src/ui/editops.ts");
    const w = mkWorld();
    const d0 = addDecor(w, 100.12345, 30.9876, "tree", 1.5);
    assert.strictEqual(d0.kind, "tree");
    assert.strictEqual(d0.lon, 100.1235);
    assert.strictEqual(d0.lat, 30.9876);
    assert.strictEqual(d0.size, 1.5);
    const d1 = addDecor(w, 110, 40, "peak", 1);
    assert.strictEqual(w.decor!.length, 2);
    assert.notStrictEqual(d0.id, d1.id, "id 唯一（序号后缀区分同毫秒）");
    assert.strictEqual(removeDecor(w, d0.id), true);
    assert.strictEqual(w.decor.length, 1);
    assert.strictEqual(removeDecor(w, "没有"), false);
    assert.strictEqual(removeDecor(w, d1.id), true);
    assert.strictEqual(w.decor.length, 0, "删空后留空数组（decor 为必备字段）");
  });
  it("moveDecor：改经纬（经度折回、四位小数，同 addNode 期望翻转）、缺失 id 无操作", async () => {
    const { addDecor, moveDecor } = await import("../src/ui/editops.ts");
    const w = mkWorld();
    const d = addDecor(w, 100, 30, "tree", 1);
    moveDecor(w, d.id, 105.98765, 31.12345);
    assert.strictEqual(d.lon, 105.9877);
    assert.strictEqual(d.lat, 31.1234);   // 31.12345 的二进制略低于半位＝toFixed 收 4（非 5）
    moveDecor(w, "没有", 0, 0);   // 不抛
    assert.strictEqual(w.decor.length, 1);
  });
  it("selDecor / selMultiDecor：按 id 取回布景、缺失跳过、类型不符返回空", async () => {
    const { selDecor, selMultiDecor } = await import("../src/ui/state.ts");
    const w = mkWorld();
    w.decor = [{ id: "a", kind: "tree", lon: 1, lat: 2 }, { id: "b", kind: "pine", lon: 3, lat: 4 }] as never;
    assert.strictEqual(selDecor(w, { kind: "decor", id: "b" })?.id, "b");
    assert.strictEqual(selDecor(w, { kind: "node", id: "a" }), null, "非 decor 返回 null");
    assert.deepStrictEqual(selMultiDecor(w, { kind: "multi", ids: [], decorIds: ["b", "没有", "a"] }).map(d => d.id), ["b", "a"]);
    assert.deepStrictEqual(selMultiDecor(w, { kind: "multi", ids: [] }), [], "无 decorIds 返回空");
  });
  it("decorsInBox：锚点落框内即选中（跨拷贝重投影；隐藏时段不入框）", async () => {
    const { decorsInBox } = await import("../src/render/decor.ts");
    const cam = { lon0: 100, lat0: 30, degPerPx: 0.01, w: 800, h: 600, flat: true };
    const meta = { worldModel: "flat" as const };
    const w = mkWorld({ meta: meta as never });
    w.decor = [{ id: "a", kind: "tree", lon: 100, lat: 30 }, { id: "b", kind: "pine", lon: 101, lat: 30 },
      { id: "c", kind: "reed", lon: 100, lat: 31 }, { id: "z", kind: "tree", lon: 100, lat: 30, since: 5000 }] as never;   // z 时段外
    // 平面 cos=1：a 锚(400,300)、b(500,300)、c(400,200)
    assert.deepStrictEqual(decorsInBox(cam as never, meta, w, 3107, 380, 280, 420, 320).sort(), ["a"], "小框只圈 a（z 未到时段被排除）");
    assert.deepStrictEqual(decorsInBox(cam as never, meta, w, 3107, 380, 180, 520, 320).sort(), ["a", "b", "c"], "大框圈 a/b/c");
  });
  it("ecoForeignIdsInDisc：生态笔替换语义——盘内异生态印章入选、自家与手摆地物豁免、时段外不动", async () => {
    const { ecoForeignIdsInDisc } = await import("../src/render/decor.ts");
    const cam = { lon0: 100, lat0: 30, degPerPx: 0.01, w: 800, h: 600, flat: true };
    const meta = { worldModel: "flat" as const };
    const w = mkWorld({ meta: meta as never });
    w.decor = [
      { id: "t1", kind: "tree", lon: 100.1, lat: 30.1 },     // 异生态·盘内
      { id: "r1", kind: "reed", lon: 100.2, lat: 29.9 },     // 异生态·盘内
      { id: "d1", kind: "dune", lon: 100.1, lat: 29.95 },    // 当前生态自家·豁免
      { id: "pk", kind: "peak", lon: 100.05, lat: 30.05 },   // 手摆地物（不在生态散布并集）·豁免
      { id: "t2", kind: "tree", lon: 103, lat: 30 },         // 异生态·盘外
      { id: "tz", kind: "tree", lon: 100.1, lat: 30.05, since: 5000 }   // 异生态·盘内但时段外
    ] as never;
    const keepDesert = new Set(["dune", "rock"]);   // 刷荒漠
    assert.deepStrictEqual(ecoForeignIdsInDisc(cam as never, meta, w, 3107, 100, 30, 0.5, keepDesert).sort(),
      ["r1", "t1"], "只扫盘内异生态；自家/手摆/盘外/时段外全豁免");
    assert.deepStrictEqual(ecoForeignIdsInDisc(cam as never, meta, w, 3107, 100, 30, 0.5, new Set()).sort(),
      ["d1", "r1", "t1"], "生态=无（keep 空）＝盘内生态散布全扫，山峰仍豁免");
  });
  it("selMulti：按 id 顺序取回地点、缺失跳过", async () => {
    const { selMulti } = await import("../src/ui/state.ts");
    const w = mkWorld({ nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }, { id: "b", type: "city", lon: 3, lat: 4 }] });
    assert.deepStrictEqual(selMulti(w, { kind: "multi", ids: ["b", "没有", "a"] }).map(n => n.id), ["b", "a"]);
    assert.deepStrictEqual(selMulti(w, { kind: "node", id: "a" }), [], "非 multi 返回空");
  });
  it("框选批量删：removeNode 逐个连带清理连线", async () => {
    const { removeNode } = await import("../src/ui/editops.ts");
    const w = mkWorld({
      nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }, { id: "b", type: "city", lon: 3, lat: 4 }, { id: "c", type: "city", lon: 5, lat: 6 }],
      edges: [{ from: "a", to: "b", type: "road" }, { from: "b", to: "c", type: "road" }]
    });
    for (const id of ["a", "b"]) removeNode(w, id);
    assert.deepStrictEqual(w.nodes.map(n => n.id), ["c"]);
    assert.strictEqual(w.edges.length, 0, "两端被删的连线连带清理");
  });
});

describe("部队编辑内核（战术图）", () => {
  it("addUnit：默认轻步兵/陆军、首航点=当日 T、坐标四位小数、无所属", () => {
    const w = mkWorld();
    const u = addUnit(w, "龙骧前军", 100.5, 30.25, 5, "u1");
    assert.strictEqual(w.units.length, 1);
    assert.strictEqual(u.kind, "linf");
    assert.strictEqual(u.arm, "land");
    assert.strictEqual(u.faction, null);
    assert.deepStrictEqual(u.track, [{ t: 5, lon: 100.5, lat: 30.25 }]);
  });
  it("addUnitUnplaced：未入场（track 空）＝合法态，列表拖入地图＝落首航点", () => {
    const w = mkWorld();
    const u = addUnitUnplaced(w, "未命名部队 1", "u1");
    assert.strictEqual(w.units.length, 1);
    assert.deepStrictEqual(u.track, []);
    assert.strictEqual(setUnitWaypoint(w, "u1", 7, 100.5, 30.25), true);   // drop 落点
    assert.deepStrictEqual(w.units[0].track, [{ t: 7, lon: 100.5, lat: 30.25 }]);
  });
  it("setUnitWaypoint：同日改写、异日插入并按日排序", () => {
    const w = mkWorld();
    addUnit(w, "前军", 100, 30, 5, "u1");
    assert.strictEqual(setUnitWaypoint(w, "u1", 5, 101, 31), true);   // 同日=改写
    assert.deepStrictEqual(w.units[0].track, [{ t: 5, lon: 101, lat: 31 }]);
    setUnitWaypoint(w, "u1", 3, 99, 29);                              // 异日=插入前
    setUnitWaypoint(w, "u1", 8, 102, 32);                            // 异日=插入后
    assert.deepStrictEqual(w.units[0].track.map(q => q.t), [3, 5, 8], "按日戳排序");
    assert.strictEqual(setUnitWaypoint(w, "没有", 1, 0, 0), false);
  });
  it("deleteUnitWaypoint：按下标删、越界返回 false", () => {
    const w = mkWorld();
    addUnit(w, "前军", 100, 30, 5, "u1");
    setUnitWaypoint(w, "u1", 3, 99, 29);
    setUnitWaypoint(w, "u1", 8, 102, 32);
    assert.strictEqual(deleteUnitWaypoint(w, "u1", 1), true);
    assert.deepStrictEqual(w.units[0].track.map(q => q.t), [3, 8]);
    assert.strictEqual(deleteUnitWaypoint(w, "u1", 9), false, "越界");
    assert.strictEqual(deleteUnitWaypoint(w, "没有", 0), false, "无此部队");
  });
  it("removeUnit：按 id 删、缺失返回 false", () => {
    const w = mkWorld();
    addUnit(w, "甲", 1, 1, 0, "u1");
    addUnit(w, "乙", 2, 2, 0, "u2");
    assert.strictEqual(removeUnit(w, "u1"), true);
    assert.deepStrictEqual(w.units.map(u => u.id), ["u2"]);
    assert.strictEqual(removeUnit(w, "没有"), false);
  });
  it("parseRanges/formatRanges：「名称：公里」每行一条、忽略坏行与非正数、往返", () => {
    const rs = parseRanges("床弩：2\n投石机 : 1.5\n没有冒号\n弓 ：0");
    assert.deepStrictEqual(rs, [{ 名称: "床弩", km: 2 }, { 名称: "投石机", km: 1.5 }], "全/半角冒号皆可；km≤0 与无冒号行剔除");
    assert.strictEqual(formatRanges(rs), "床弩：2\n投石机：1.5");
    assert.strictEqual(formatRanges([{ km: 3 }]), "射程：3", "缺名回退「射程」");
    assert.strictEqual(formatRanges(undefined), "");
  });
  it("applyUnitForm：名称空则保留、兵种定默认移动方式、兵力×单位归一为人数、速度>0 才设否则删、火力单值+提交即归一旧多圈", () => {
    const w = mkWorld({ factions: [{ id: "f1", 名称: "东军" }] });
    const u = addUnit(w, "旧名", 1, 1, 0, "u1");
    u.ranges = [{ 名称: "床弩", km: 2 }];   // v0.14 遗留多圈
    applyUnitForm(u, { 名称: "新名", faction: "f1", kind: "navy", strength: " 3 ", strengthUnit: "10000", speed: "70", range: "3", note: "备注" });
    assert.strictEqual(u.名称, "新名");
    assert.strictEqual(u.faction, "f1");
    assert.strictEqual(u.kind, "navy");
    /* 舰船的移动方式由本体决定（armOptional 之外）＝不落显式键，读数仍回落兵种表的水行 */
    assert.ok(!("arm" in u), "不可选移动方式的兵种不落 arm 键");
    assert.strictEqual(unitArm(u), "water", "读数回落兵种表");
    assert.strictEqual(u.strength, 30000, "兵力＝输入×单位倍率，落库恒为人数");
    assert.strictEqual(u.speed, 70);
    assert.strictEqual(u.range, 3, "火力=单值（与视野同机制）");
    assert.ok(!("ranges" in u), "提交火力即归一：旧多圈删除");
    assert.strictEqual(u.note, "备注");
    applyUnitForm(u, { 名称: "", faction: "", kind: "spec", arm: "air", strength: "", speed: "0", range: "", note: "" });
    assert.strictEqual(u.名称, "新名", "名称留空=保留");
    assert.strictEqual(u.faction, null, "所属留空=中立");
    assert.strictEqual(u.arm, "air", "特殊兵种的移动方式可显式覆写（armOptional 之内）");
    assert.ok(!("strength" in u), "兵力留空=删键");
    assert.ok(!("speed" in u), "速度≤0=删键（回退兵种默认）");
    assert.ok(!("range" in u), "火力留空=删键");
    applyUnitForm(u, { 名称: "", faction: "", kind: "lcav", strength: "800", speed: "", range: "", note: "" });
    assert.ok(!("arm" in u), "换成骑兵＝移动方式回落本体，旧的显式飞行必须清掉");
    assert.strictEqual(unitArm(u), "land");
    assert.strictEqual(u.strength, 800, "单位缺省＝人");
  });
  /* 战略图的精简表单不渲染 士气/火力/视野/阵形 四行——未渲染的行**不传字段**（UnitForm 的 valOpt 返
     undefined），applyUnitForm 才不会把手编档里的这些键当成「清空」删掉。空串＝清空、缺席＝不动，两义之别。 */
  it("applyUnitForm：字段缺席＝不动那个键（战略图精简表单不误删士气/视野/阵形）", () => {
    const w = mkWorld();
    const u = addUnit(w, "军", 1, 1, 0, "u1");
    u.morale = 70; u.vision = 5; u.frontKm = 2; u.depthKm = 0.4;
    applyUnitForm(u, { 名称: "", faction: "", kind: "linf", strength: "900", speed: "", note: "" });
    assert.strictEqual(u.morale, 70, "未传士气＝不动");
    assert.strictEqual(u.vision, 5, "未传视野＝不动");
    assert.strictEqual(u.frontKm, 2, "未传阵形＝不动");
    assert.strictEqual(u.depthKm, 0.4);
    applyUnitForm(u, { 名称: "", faction: "", kind: "linf", strength: "900", speed: "", note: "", morale: "", vision: "" });
    assert.ok(!("morale" in u), "传空串＝清空");
    assert.ok(!("vision" in u), "传空串＝清空");
  });
  it("unitFireKm：单值优先、旧多圈只读回退首条、无投射能力的兵种恒 0", () => {
    const w = mkWorld();
    const u = addUnit(w, "军", 1, 1, 0, "u1");
    u.kind = "rng";                      // 远程部队＝有投射能力
    assert.strictEqual(unitFireKm(u), 0);
    u.ranges = [{ 名称: "弓弩", km: 2 }, { km: 9 }];
    assert.strictEqual(unitFireKm(u), 2, "回退取首条");
    u.range = 3.5;
    assert.strictEqual(unitFireKm(u), 3.5, "单值优先");
    /* 步/骑/后勤/侦察无远程投射：判据收在 unitFireKm 一处，数据留着也一律不成立 */
    for (const k of ["linf", "hinf", "lcav", "hcav", "log", "scout"]) {
      u.kind = k;
      assert.strictEqual(unitFireKm(u), 0, `${k} 不该有火力圈`);
    }
  });
  it("航点状态：setUnitWaypointStatus 设/清、同日改写保留 st、unitStatusAt 按航段取值", () => {
    const w = mkWorld();
    addUnit(w, "前军", 100, 30, 5, "u1");
    setUnitWaypoint(w, "u1", 8, 102, 32);
    assert.strictEqual(setUnitWaypointStatus(w, "u1", 5, "standoff"), true);
    assert.strictEqual(w.units[0].track[0].st, "standoff");
    assert.strictEqual(setUnitWaypointStatus(w, "u1", 99, "battle"), false, "无此日航点");
    const u = w.units[0];
    assert.strictEqual(unitStatusAt(u, 4.9), null, "未入场");
    assert.strictEqual(unitStatusAt(u, 5), "standoff", "自航点当日起生效");
    assert.strictEqual(unitStatusAt(u, 6.5), "standoff", "行进中沿用航段起点状态");
    assert.strictEqual(unitStatusAt(u, 8), null, "下一航点无 st=回常态");
    setUnitWaypointStatus(w, "u1", 8, "battle");
    assert.strictEqual(unitStatusAt(u, 20), "battle", "末航点驻停期沿用其状态");
    setUnitWaypoint(w, "u1", 5, 100.5, 30.5);
    assert.strictEqual(u.track[0].st, "standoff", "同日改写位置保留状态");
    setUnitWaypointStatus(w, "u1", 5, "");
    assert.ok(!("st" in u.track[0]), "空=删键回常态");
  });
  it("setUnitRing（视野/火力同机制）与 setNodeRangeKm：量级取整、近零清除/钳底、无效目标 false", () => {
    const w = mkWorld();
    const u = addUnit(w, "斥候", 100, 30, 5, "u1");
    assert.strictEqual(setUnitRing(w, "u1", "vision", 12.3456), true);
    assert.strictEqual(u.vision, 12.3, "≥10km 一位小数");
    setUnitRing(w, "u1", "vision", 123.4); assert.strictEqual(u.vision, 123, "≥100km 整数");
    setUnitRing(w, "u1", "range", 1.2345); assert.strictEqual(u.range, 1.23, "火力同机制·两位小数");
    setUnitRing(w, "u1", "vision", 0.01); assert.ok(!("vision" in u), "拖到近零=清除视野");
    setUnitRing(w, "u1", "range", 0.01); assert.ok(!("range" in u), "拖到近零=清除火力（与视野完全一致）");
    assert.strictEqual(setUnitRing(w, "没有", "vision", 5), false);
    const n: WorldNode = { id: "fort", type: "fortress", lon: 1, lat: 2, ranges: [{ km: 10 }] };
    w.nodes.push(n);
    assert.strictEqual(setNodeRangeKm(w, "fort", 0, 25.44), true);
    assert.strictEqual(n.ranges![0].km, 25.4);
    setNodeRangeKm(w, "fort", 0, 0.001);
    assert.strictEqual(n.ranges![0].km, 0.05, "据点圈钳底不删条目（删除走表单）");
    assert.strictEqual(setNodeRangeKm(w, "fort", 9, 1), false, "无此圈");
  });
  it("applyUnitForm：vision/range>0 才设、留空删键、不传不动（旧调用兼容·不误清遗留 ranges）", () => {
    const w = mkWorld();
    const u = addUnit(w, "军", 1, 1, 0, "u1");
    u.ranges = [{ 名称: "弓弩", km: 2 }];
    applyUnitForm(u, { 名称: "", faction: "", kind: "inf", strength: "", speed: "", note: "", vision: "8" });
    assert.strictEqual(u.vision, 8);
    assert.deepStrictEqual(u.ranges, [{ 名称: "弓弩", km: 2 }], "不传 range=遗留多圈不动");
    applyUnitForm(u, { 名称: "", faction: "", kind: "inf", strength: "", speed: "", note: "" });
    assert.strictEqual(u.vision, 8, "不传 vision=不动");
    applyUnitForm(u, { 名称: "", faction: "", kind: "inf", strength: "", speed: "", note: "", vision: "" });
    assert.ok(!("vision" in u), "留空=删键");
  });
});

describe("归属沿革编辑（owners）", () => {
  const nd = (): WorldNode => ({ id: "a", type: "city", lon: 1, lat: 2 });
  it("addOwner：建数组、新段默认从当年起、faction 空", () => {
    const n = nd();
    addOwner(n, 3105);
    assert.deepStrictEqual(n.owners, [{ faction: null, since: 3105 }]);
    addOwner(n, NaN);   // 非法年份=不带 since（远古起）
    assert.deepStrictEqual(n.owners![1], { faction: null });
  });
  it("updateOwner：faction 空=中立(null)、起/止 parseFloat 空删语义", () => {
    const n = nd(); addOwner(n, 3105);
    updateOwner(n, 0, { faction: "imperium", since: "3106", until: "3108" });
    assert.deepStrictEqual(n.owners![0], { faction: "imperium", since: 3106, until: 3108 });
    updateOwner(n, 0, { faction: "", until: "" });   // 中立 + 清止（至今）
    const o0 = n.owners![0];
    assert.strictEqual(o0.faction, null);
    assert.strictEqual(o0.until, undefined, "止留空=删键（至今）");
    assert.strictEqual(o0.since, 3106, "未传的字段不动");
  });
  it("removeOwner：按下标删、删空清 owners 键、越界 false", () => {
    const n = nd(); addOwner(n, 3105); addOwner(n, 3108);
    assert.strictEqual(removeOwner(n, 0), true);
    assert.strictEqual(n.owners!.length, 1);
    assert.strictEqual(removeOwner(n, 9), false, "越界");
    assert.strictEqual(removeOwner(n, 0), true);
    assert.ok(!("owners" in n), "删空后整键移除（回退固定 faction）");
  });
});

describe("子工具自动开图层（隐藏层上放置＝幽灵编辑，切入即亮层）", () => {
  const snap = (): Record<string, boolean> => ({ ...layersSig.peek() });
  it("切入布景：隐藏的 decor 层自动打开", () => {
    const s0 = snap();
    layersSig.value = { ...s0, decor: false };
    editSubSig.value = "select";
    pickEditSub("decor");
    assert.strictEqual(editSubSig.peek(), "decor");
    assert.strictEqual(layersSig.peek().decor, true);
    layersSig.value = s0; editSubSig.value = "select";
  });
  it("标注要过 nodes 总门+notes 子门：两层都开", () => {
    const s0 = snap();
    layersSig.value = { ...s0, nodes: false, notes: false };
    pickEditSub("label");
    assert.strictEqual(layersSig.peek().nodes, true);
    assert.strictEqual(layersSig.peek().notes, true);
    layersSig.value = s0; editSubSig.value = "select";
  });
  it("退回选择态不动图层：刚藏起的层保持隐藏", () => {
    const s0 = snap();
    editSubSig.value = "decor";
    layersSig.value = { ...s0, decor: false };
    pickEditSub("decor");   // 再点当前＝退回 select
    assert.strictEqual(editSubSig.peek(), "select");
    assert.strictEqual(layersSig.peek().decor, false, "select 无映射＝不代开");
    layersSig.value = s0;
  });
  it("线型切换亮对应线层；全已开时原引用不动（防无谓重渲）", () => {
    const s0 = snap();
    layersSig.value = { ...s0, river: false };
    pickLinkType("river");
    assert.strictEqual(linkTypeSig.peek(), "river");
    assert.strictEqual(layersSig.peek().river, true);
    const ref = layersSig.peek();
    revealLayersFor("link");   // river 已开 → 无操作
    assert.strictEqual(layersSig.peek(), ref);
    layersSig.value = s0; linkTypeSig.value = "road";
  });
  /* 图层接线闭合（2026-07-29）：`wall` 曾只做了一半——LAYERS 与三个预设里都有，却漏进 IMPL_LAYERS，
     于是 layersSig 没有 wall 键 → 面板无此行关不掉、applyPreset 只遍历现有键故「地理」也关不掉、
     drawEdges 的 on("wall") 读到 undefined 恒为真＝永远画。下面两条断言各咬住其中一环。 */
  it("图层接线闭合：IMPL_LAYERS ⊆ LAYERS 且预设列出的层都可开关", () => {
    const ids = new Set(LAYERS.map(l => l.id));
    for (const id of IMPL_LAYERS) assert.ok(ids.has(id), `IMPL_LAYERS 的 ${id} 不在 LAYERS`);
    for (const [k, p] of Object.entries(PRESETS))
      for (const id of Object.keys(p))
        assert.ok(IMPL_LAYERS.includes(id), `预设「${k}」列了 ${id}，但它不在 IMPL_LAYERS＝applyPreset 关不掉它`);
  });
  it("applyPreset 真能关掉工事层（白名单外的预设）", () => {
    const s0 = snap();
    applyPreset("地理");
    assert.strictEqual(layersSig.peek().wall, false, "地理预设不含工事＝须关掉");
    applyPreset("战术");
    assert.strictEqual(layersSig.peek().wall, true);
    layersSig.value = s0;
  });
});

describe("相位（战术分帧命名时刻）", () => {
  it("增删改名：同刻去重、按时刻排序、删空整键不落盘、空名回落", () => {
    const w = mkWorld();
    const p1 = addPhaseAt(w, 100.25)!;
    assert.strictEqual(p1.名称, "相位 1");
    assert.strictEqual(addPhaseAt(w, 100.25), null, "同刻不重复");
    addPhaseAt(w, 100.5); addPhaseAt(w, 100.125);
    assert.deepStrictEqual(w.meta.phases!.map(p => p.t), [100.125, 100.25, 100.5], "按时刻升序");
    assert.ok(renamePhase(w, 100.25, "  渡河列阵 "));
    assert.strictEqual(w.meta.phases![1].名称, "渡河列阵");
    renamePhase(w, 100.25, "  ");
    assert.strictEqual(w.meta.phases![1].名称, undefined, "空名回落＝删 名称 键");
    assert.strictEqual(removePhaseAt(w, 999), false, "无匹配一字不改");
    removePhaseAt(w, 100.125); removePhaseAt(w, 100.25); removePhaseAt(w, 100.5);
    assert.strictEqual("phases" in w.meta, false, "删空整键不落盘");
  });
  it("phasesOf 防御过滤+排序；phaseIndexAt 段语义；adjacentPhaseT 严格相邻", () => {
    const meta = { phases: [{ t: 3 }, null, { t: 1, 名称: "一" }, { t: "坏" }, { t: 2 }] } as never;
    const ph = phasesOf(meta);
    assert.deepStrictEqual(ph.map(p => p.t), [1, 2, 3], "滤坏项+升序（原数组不动）");
    assert.strictEqual(phaseIndexAt(ph, 0.5), -1, "早于首相位");
    assert.strictEqual(phaseIndexAt(ph, 2.5), 1, "段语义 [t, 下一)");
    assert.strictEqual(phaseIndexAt(ph, 3), 2, "恰在相位上＝该相位");
    assert.strictEqual(adjacentPhaseT(ph, 2, -1), 1, "站在相位上：上一＝严格更早");
    assert.strictEqual(adjacentPhaseT(ph, 2, 1), 3);
    assert.strictEqual(adjacentPhaseT(ph, 1, -1), null, "首相位无上一");
    assert.strictEqual(adjacentPhaseT(ph, 3, 1), null, "末相位无下一");
    assert.strictEqual(phasesOf(undefined).length, 0);
    assert.strictEqual(phasesOf({ phases: "垃圾" } as never).length, 0, "非数组防御");
  });
});

describe("整组成员集合 selMembers（批删／方向键微调／整组拖移的单一真源）", () => {
  it("框选：三种对象各就各位，缺席的可选键当空数组（旧档只有 ids）", () => {
    assert.deepStrictEqual(selMembers({ kind: "multi", ids: ["n1", "n2"], unitIds: ["u1"], decorIds: ["d1", "d2"] }),
      { nodeIds: ["n1", "n2"], unitIds: ["u1"], decorIds: ["d1", "d2"] });
    /* ⚠ 这一条锁的是曾经真漂移过的那处：微调那份漏读 decorIds，只圈印章时方向键成死键 */
    assert.deepStrictEqual(selMembers({ kind: "multi", ids: ["n1"] }),
      { nodeIds: ["n1"], unitIds: [], decorIds: [] });
  });
  it("单选按「一人成组」归位；edge/faction/空选一律三空数组", () => {
    assert.deepStrictEqual(selMembers({ kind: "node", id: "n1" }), { nodeIds: ["n1"], unitIds: [], decorIds: [] });
    assert.deepStrictEqual(selMembers({ kind: "unit", id: "u1" }), { nodeIds: [], unitIds: ["u1"], decorIds: [] });
    assert.deepStrictEqual(selMembers({ kind: "decor", id: "d1" }), { nodeIds: [], unitIds: [], decorIds: ["d1"] });
    const empty = { nodeIds: [], unitIds: [], decorIds: [] };
    assert.deepStrictEqual(selMembers({ kind: "edge", idx: 0 }), empty);
    assert.deepStrictEqual(selMembers({ kind: "faction", id: "f1" }), empty);
    assert.deepStrictEqual(selMembers(null), empty);
  });
});

/* 时间轴细档随历法走（2026-08-20 历法通用化）：战术图的「时」档一步＝一日的 1/时数。
   缺省 24 时制＝1/24 日，与旧的硬编码逐位相同；配了 10 时制的世界，时间轴就真按 10 时走。 */
describe("时间步进粒度 timeStep", () => {
  const withWorld = (calendar: unknown, tac: boolean, fn: () => void): void => {
    const w0 = worldSig.peek(), s0 = subDaySig.peek();
    worldSig.value = { meta: { mapKind: tac ? "tactical" : "strategic", calendar }, nodes: [] } as never;
    subDaySig.value = true;
    try { fn(); } finally { worldSig.value = w0; subDaySig.value = s0; }
  };
  it("粗档恒 1（日/年）", () => {
    const s0 = subDaySig.peek();
    subDaySig.value = false;
    assert.strictEqual(timeStep(), 1);
    subDaySig.value = s0;
  });
  it("战术图细档＝1/每日时数（缺省 24 与旧硬编码逐位同）", () => {
    withWorld({}, true, () => assert.strictEqual(timeStep(), 1 / 24));
    withWorld({ hoursPerDay: 10 }, true, () => assert.strictEqual(timeStep(), 1 / 10));
    withWorld({ kind: "earth" }, true, () => assert.strictEqual(timeStep(), 1 / 24, "地球历恒 24 时"));
  });
  it("战略图细档＝1/月数（不受一日时数影响）", () => {
    withWorld({ months: 10, dpm: 36, hoursPerDay: 10 }, false, () => assert.strictEqual(timeStep(), 1 / 10));
    withWorld({}, false, () => assert.strictEqual(timeStep(), 1 / 12));
  });
});
