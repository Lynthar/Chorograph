/* 编辑基座测试：撤销栈 / 自动保存调度 / 编辑操作内核 / signals 变更管线。
   组件 .tsx 不进 node:test（类型剥离不转 JSX）——表单交互靠截图与真机，此处锁逻辑。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHistory, terrKey, UNDO_MAX } from "../src/ui/history.ts";
import { createAutosave } from "../src/data/autosave.ts";
import { addEdge, addRiver, addAsset, addDecor, removeAsset, addEventNear, addLabel, addNode, addOwner, applyEdgeForm, applyNodeForm, applyUnitForm, addUnit, addUnitUnplaced, changeNodeType, dataLon, deleteUnitWaypoint, formatRanges, moveNode, paintHeightAt, parseRanges, removeEdgeAt, removeNode, removeOwner, removeUnit, setNodeRangeKm, setUnitRing, setUnitWaypoint, setUnitWaypointStatus, updateOwner } from "../src/ui/editops.ts";
import { unitFireKm, unitStatusAt } from "../src/core/units.ts";
import { buildGridCells } from "../src/core/grid.ts";
import { canRedoSig, canUndoSig, deleteEdgeIdx, deleteNodeAt, editSubSig, editVerSig, gridVerSig, layersSig, linkTypeSig, mutateWorld, mutateWorldLive,
  pickEditSub, pickLinkType, pushHistoryOnce, redoWorld, revealLayersFor, selSig, setWorldState, toastSig, undoWorld, worldSig, yearSig } from "../src/ui/state.ts";
import { EVENT_TYPES } from "../src/core/constants.ts";
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
  it("addNode：city 起步、三位小数、link=名称", () => {
    const w = mkWorld();
    const n = addNode(w, "洛城", 100.12345, 30.9876);
    assert.strictEqual(n.type, "city");
    assert.strictEqual(n.lon, 100.123);
    assert.strictEqual(n.lat, 30.988);
    assert.strictEqual(n.link, "洛城");
    assert.strictEqual(w.nodes[0], n);
  });
  it("addLabel：type=label、文本=名称、经度折回三位小数、无 link/字段", () => {
    const w = mkWorld();
    const n = addLabel(w, "申时·东北风↗", 190.12345, 30.9876);
    assert.strictEqual(n.type, "label");
    assert.strictEqual(n.名称, "申时·东北风↗");
    assert.strictEqual(n.lon, -169.877);
    assert.strictEqual(n.lat, 30.988);
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
  it("paintHeightAt：同格图章加性合并、下切、累加≈0 自动清除", () => {
    const M = { worldModel: "sphere", terrain: "plain", bbox: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 } } as never as import("../src/core/types.ts").Meta;
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
  it("涂改块尺寸 ov.step：战术图涂改记录自身步长（对齐旧 paintAt·存档格式兼容）、战略图不写键", async () => {
    const { paintTerrainAt } = await import("../src/ui/editops.ts");
    // 战略图（step=1）：不写 step——与 v0.14 存档形状逐字节同构
    const sm = { bbox: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 } } as never as import("../src/core/types.ts").Meta;
    const sg = buildGridCells(sm, [], 3000);
    const sw = mkWorld({ meta: sm });
    paintTerrainAt(sw, sg, 3000, 101.5, 31.5, "water", 1, false, null);
    assert.strictEqual(sw.terrainOverrides.length, 1);
    assert.ok(!("step" in sw.terrainOverrides[0]), "战略涂改不带 step 键（旧档形状不变）");
    // 战术图（步长=跨度/140）：记录 +step.toFixed(4)，与继承的 1° 粗块区分
    const tm = { mapKind: "tactical", bbox: { lonMin: 100, lonMax: 101.4, latMin: 30, latMax: 31.4 } } as never as import("../src/core/types.ts").Meta;
    const tg = buildGridCells(tm, [], 3000);
    const tw = mkWorld({ meta: tm });
    paintTerrainAt(tw, tg, 3000, 100.7, 30.7, "water", 1, false, null);
    assert.strictEqual(tw.terrainOverrides.length, 1);
    assert.strictEqual(tw.terrainOverrides[0].step, +tg.step.toFixed(4), "战术涂改记录自身块尺寸");
    // 高程涂改同规则
    paintHeightAt(tw, tg, 100.7, 30.7, 0.02, 1, null);
    assert.strictEqual(tw.heightOverrides![0].step, +tg.step.toFixed(4));
    const sw2 = mkWorld({ meta: sm });
    paintHeightAt(sw2, sg, 101.5, 31.5, 0.02, 1, null);
    assert.ok(!("step" in sw2.heightOverrides![0]), "战略高程涂改不带 step 键");
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

describe("单对象删除 helper（即时 + 可撤销 toast + 精准清选中）", () => {
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
  it("涂域格集合：cells↔Set 往返稳定（两位小数落盘）", async () => {
    const { paintDims, cellsToSet, setToCells } = await import("../src/ui/paint.ts");
    const dims = paintDims({});
    const cells: [number, number][] = [[100.25, 30.25], [82.25, 22.25], [129.75, 53.75]];
    const s = cellsToSet(dims.bb, cells);
    assert.strictEqual(s.size, 3);
    const back = setToCells(dims.bb, s).sort((a, b) => a[0] - b[0]);
    assert.deepStrictEqual(back, cells.slice().sort((a, b) => a[0] - b[0]));
  });
  it("brushCells：圆盘半径/越界裁剪/橡皮/无变化返回 false", async () => {
    const { paintDims, brushCells } = await import("../src/ui/paint.ts");
    const dims = paintDims({});
    const s = new Set<string>();
    assert.strictEqual(brushCells(s, dims, 100.25, 30.25, 3, false), true);
    const n3 = s.size;
    assert.ok(n3 >= 9 && n3 <= 21, `size=3 圆盘应 9~21 格，得 ${n3}`);
    assert.strictEqual(brushCells(s, dims, 100.25, 30.25, 3, false), false, "重涂同处无变化");
    assert.strictEqual(brushCells(s, dims, 100.25, 30.25, 3, true), true, "橡皮清除");
    assert.strictEqual(s.size, 0);
    brushCells(s, dims, dims.bb.lonMin + 0.1, dims.bb.latMin + 0.1, 4, false);
    for (const k of s) {
      const [i, j] = k.split(",").map(Number);
      assert.ok(i >= 0 && j >= 0, "越界格应被裁剪");
    }
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
    const meta = { bbox: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 } };   // 4×4 战略网格（step=1）
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
});

describe("布景 + 框选", () => {
  it("addDecor / removeDecor：挂 decor[]、三位小数、id 唯一、空则删键", async () => {
    const { addDecor, removeDecor } = await import("../src/ui/editops.ts");
    const w = mkWorld();
    const d0 = addDecor(w, 100.12345, 30.9876, "tree", 1.5);
    assert.strictEqual(d0.kind, "tree");
    assert.strictEqual(d0.lon, 100.123);
    assert.strictEqual(d0.lat, 30.988);
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
  it("addUnit：默认步兵/陆军、首航点=当日 T、坐标四位小数、无所属", () => {
    const w = mkWorld();
    const u = addUnit(w, "龙骧前军", 100.5, 30.25, 5, "u1");
    assert.strictEqual(w.units.length, 1);
    assert.strictEqual(u.kind, "inf");
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
  it("applyUnitForm：名称空则保留、兵种同步 arm、速度>0 才设否则删、火力单值+提交即归一旧多圈", () => {
    const w = mkWorld({ factions: [{ id: "f1", 名称: "东军" }] });
    const u = addUnit(w, "旧名", 1, 1, 0, "u1");
    u.ranges = [{ 名称: "床弩", km: 2 }];   // v0.14 遗留多圈
    applyUnitForm(u, { 名称: "新名", faction: "f1", kind: "navy", strength: " 三万 ", speed: "70", range: "3", note: "备注" });
    assert.strictEqual(u.名称, "新名");
    assert.strictEqual(u.faction, "f1");
    assert.strictEqual(u.kind, "navy");
    assert.strictEqual(u.arm, "water", "兵种决定军种");
    assert.strictEqual(u.strength, "三万", "兵力去空白");
    assert.strictEqual(u.speed, 70);
    assert.strictEqual(u.range, 3, "火力=单值（与视野同机制）");
    assert.ok(!("ranges" in u), "提交火力即归一：旧多圈删除");
    assert.strictEqual(u.note, "备注");
    applyUnitForm(u, { 名称: "", faction: "", kind: "air", strength: "", speed: "0", range: "", note: "" });
    assert.strictEqual(u.名称, "新名", "名称留空=保留");
    assert.strictEqual(u.faction, null, "所属留空=中立");
    assert.strictEqual(u.arm, "air");
    assert.ok(!("speed" in u), "速度≤0=删键（回退兵种默认）");
    assert.ok(!("range" in u), "火力留空=删键");
  });
  it("unitFireKm：单值优先、旧多圈只读回退首条", () => {
    const w = mkWorld();
    const u = addUnit(w, "军", 1, 1, 0, "u1");
    assert.strictEqual(unitFireKm(u), 0);
    u.ranges = [{ 名称: "弓弩", km: 2 }, { km: 9 }];
    assert.strictEqual(unitFireKm(u), 2, "回退取首条");
    u.range = 3.5;
    assert.strictEqual(unitFireKm(u), 3.5, "单值优先");
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
});
