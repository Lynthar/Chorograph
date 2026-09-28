/* 视域编排（shell/viewshed）：谁成单（视野圈恒判、火力圈直射按视线/曲射按射角、雷达只在现代图、飞行不判、未入场不判、层关不判；
   地点火力多圈各成一单、不在当刻的地点不判）、
   只在规则场落定时算（ruleFieldSig null＝沿用上一份）、规则场只推送一次、拒绝臂放闸。
   fake routeClient 按观察者回可辨认的掩膜；规则场用粗格包装。 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sightReqs, wireViewshed, visObservers } from "../src/shell/viewshed.ts";
import { landWorld } from "../src/shell/orchestrate.ts";
import { normalizeWorld } from "../src/core/world.ts";
import { buildGridCells } from "../src/core/grid.ts";
import { coarseField, type ElevField } from "../src/core/elev.ts";
import { detectSig, layersSig, mutateWorld, ruleFieldSig, toastSig, visFailSig, visMaskSig, worldSig, yearSig } from "../src/ui/state.ts";
import type { ShellCtx } from "../src/shell/ctx.ts";
import type { SightReq, SightRes, VisReq, VisRes } from "../src/worker/routeProto.ts";
import type { VisMask } from "../src/core/viewshed.ts";
import type { World } from "../src/core/types.ts";

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 130));   // 防抖 80 + 微任务
/** 轮询到条件成立（最多 2 s）：只数「发了几单」的断言不该押在固定等待上，机器一忙就误红 */
const until = async (ok: () => boolean): Promise<void> => { for (let t = 0; t < 200 && !ok(); t++) await new Promise(r => setTimeout(r, 10)); };

interface Seen { pushes: number; calls: VisReq[][]; sights: SightReq[][]; reject: boolean }
function mkCtx(): { ctx: ShellCtx; seen: Seen } {
  const seen: Seen = { pushes: 0, calls: [], sights: [], reject: false };
  const fakeMask = (o: VisReq): VisMask =>
    ({ bb: { lonMin: o.lon, lonMax: o.lon, latMin: o.lat, latMax: o.lat }, cols: 1, rows: 1, vis: new Uint8Array([1]), nVis: 1, nIn: 1, eyeOff: 0 });
  const ctx = {
    canvas: {}, ov: {},
    routeClient: {
      setContext: () => {},
      setViewField: () => { seen.pushes++; },
      viewshed: (obs: VisReq[]): Promise<VisRes[] | null> => {
        seen.calls.push(obs);
        return seen.reject ? Promise.reject(new Error("dead")) : Promise.resolve(obs.map(o => ({ owner: o.owner, id: o.id, ring: o.ring, idx: o.idx, mask: fakeMask(o) })));
      },
      /* 假点对点：雷达看得见、视野被挡 */
      sight: (reqs: SightReq[]): Promise<SightRes[] | null> => {
        seen.sights.push(reqs);
        return Promise.resolve(reqs.map(q => ({ owner: q.obs.owner, id: q.obs.id, ring: q.obs.ring, idx: q.obs.idx, tgt: q.tgt, hit: { inRange: true, seen: q.obs.ring === "radar" } })));
      }
    },
    DPR: 1, meta: {}, view: { lon0: 100.5, lat0: 30.5, degPerPx: 0.001 },
    grid: null, elevField: null, ruleField: null, R: null, builtFor: null, repaint: null,
    lib: null, mapId: null, source: "browser", folderDir: null, fcache: {},
    bootNote: "", savedAt: null, saveErr: null, libOpen: false
  } as unknown as ShellCtx;
  return { ctx, seen };
}
const TAC = (units: object[], meta: object = {}, nodes: object[] = []): World => normalizeWorld({
  meta: { 名称: "战", worldModel: "flat", kmPerDeg: 111.19, terrain: "plain", mapKind: "tactical",
    bbox: { lonMin: 100, lonMax: 101, latMin: 30, latMax: 31 }, ...meta },
  units, nodes
});
const size = (): number => visMaskSig.peek().unit.size + visMaskSig.peek().node.size;
/** 开图 + 手工给规则场（不走 host：这里测的是编排，不是场记账） */
function open(ctx: ShellCtx, w: World, T = 3050): ElevField {
  landWorld(ctx, w, "t1", T);
  ctx.grid = buildGridCells(ctx.meta, w.terrainOverrides, T);
  const f = coarseField(ctx.grid, new Float32Array(ctx.grid.cols * ctx.grid.rows));
  ctx.ruleField = f; ruleFieldSig.value = f;
  return f;
}
const U = (id: string, extra: object = {}) => ({ id, kind: "rng", track: [{ t: 3050, lon: 100.5, lat: 30.5 }], ...extra });

describe("视域编排（shell/viewshed）", () => {
  it("视线类圈带驻地半径（无足印 100 m、有足印按长边一半），曲射不带", () => {
    const w = TAC([U("a", { vision: 3, range: 2, fire: "direct" }), U("b", { range: 2, frontKm: 2 }), U("c", { vision: 3, frontKm: 1, depthKm: 3 })]);
    const obs = visObservers(w, 3050, { vision: true, ranges: true }, w.meta);
    assert.deepEqual(obs.map(o => `${o.id}:${o.ring}:${o.vantageM ?? "-"}:${o.gainM ?? "-"}`), ["a:vision:100:1", "a:fire:100:1", "b:fire:-:-", "c:vision:1500:1"]);
  });

  let ctx: ShellCtx, seen: Seen, unwire: () => void;
  beforeEach(() => { ({ ctx, seen } = mkCtx()); ruleFieldSig.value = null; unwire = wireViewshed(ctx); });
  afterEach(() => { unwire(); ruleFieldSig.value = null; });

  it("成单规则：视野圈恒判、火力圈直射与曲射都判、飞行/未入场/层关不判；掩膜按 id→圈落 sig", async () => {
    const w = TAC([
      U("v", { vision: 3 }),
      U("fd", { range: 2, fire: "direct" }),
      U("fi", { range: 2 }),
      U("air", { kind: "air", vision: 5, range: 2, fire: "direct" }),
      U("late", { vision: 3, track: [{ t: 3060, lon: 100.5, lat: 30.5 }] }),
      U("both", { vision: 4, range: 1, fire: "direct", eyeM: 12 })
    ]);
    open(ctx, w);
    await settle();
    assert.equal(seen.calls.length, 1, "一次防抖归并成一单");
    const obs = seen.calls[0].map(o => `${o.id}:${o.ring}:${o.km}:${o.eyeM}`).sort();
    assert.deepEqual(obs, ["both:fire:1:12", "both:vision:4:12", "fd:fire:2:2", "fi:fire:2:2", "v:vision:3:2"]);
    assert.deepEqual([...visMaskSig.peek().unit.keys()].sort(), ["both", "fd", "fi", "v"]);
    assert.equal(seen.calls[0].find(o => o.id === "fi")!.arcDeg, 45, "曲射缺键按 45° 成单");
    assert.equal(seen.calls[0].find(o => o.id === "fd")!.arcDeg, undefined, "直射不带射角");
    assert.ok(visMaskSig.peek().unit.get("both")!.vision && visMaskSig.peek().unit.get("both")!.fire![0], "两圈各一张");
    assert.equal(visMaskSig.peek().unit.get("fd")!.vision, undefined, "只直射无视野＝只有火力掩膜");
    assert.equal(seen.pushes, 1, "规则场推送一次");
    layersSig.value = { ...layersSig.peek(), vision: false };
    await settle();
    assert.deepEqual(seen.calls[1].map(o => o.ring), ["fire", "fire", "fire"], "视野层关＝只剩火力单");
    layersSig.value = { ...layersSig.peek(), vision: true };
    await settle();
  });

  it("规则场演算中（sig 为 null）不发单、沿用上一份；落定换引用再算且再推送一次", async () => {
    const w = TAC([U("v", { vision: 3 })]);
    const f0 = open(ctx, w);
    await settle();
    assert.equal(seen.calls.length, 1);
    const kept = visMaskSig.peek();
    ruleFieldSig.value = null;
    mutateWorld(x => { x.units[0].track[0].lon = 100.6; });   // 演算中拖部队
    await settle();
    assert.equal(seen.calls.length, 1, "不发单");
    assert.equal(visMaskSig.peek(), kept, "掩膜沿用上一份");
    const f1 = coarseField(ctx.grid!, new Float32Array(ctx.grid!.cols * ctx.grid!.rows).fill(0.1));
    ruleFieldSig.value = f1;
    await settle();
    assert.equal(seen.calls.length, 2, "落定即算");
    assert.equal(seen.calls[1][0].lon, 100.6, "按最新位置");
    assert.equal(seen.pushes, 2, "换引用再推送一次");
    ruleFieldSig.value = f0;
    await settle();
    assert.equal(seen.pushes, 3, "换回 f0＝与上次推送的不同引用，再推");
    ruleFieldSig.value = f1;
    await settle();
    assert.equal(seen.pushes, 4);
    assert.equal(seen.calls.length, 4, "每次落定各算一次");
  });

  it("拖部队（editVer）重算；无成单部队或战略图＝清空且不发单", async () => {
    const w = TAC([U("v", { vision: 3 })]);
    open(ctx, w);
    await settle();
    mutateWorld(x => { x.units[0].track[0].lat = 30.6; });
    await settle();
    assert.equal(seen.calls.length, 2);
    assert.equal(seen.calls[1][0].lat, 30.6);
    mutateWorld(x => { delete x.units[0].vision; });
    await settle();
    assert.equal(seen.calls.length, 2, "无圈可判＝不发单");
    assert.equal(size(), 0, "掩膜清空");
    const strat = normalizeWorld({ meta: { 名称: "略", terrain: "plain", gridN: 48 }, units: [U("v", { vision: 3 })] });
    open(ctx, strat);
    await settle();
    assert.equal(seen.calls.length, 2, "战略图不算");
    assert.equal(size(), 0);
  });

  it("拒绝臂放闸：一单失败后下一次改动照常发单", async () => {
    const w = TAC([U("v", { vision: 3 })]);
    seen.reject = true;
    const warn = console.warn; console.warn = () => {};
    try {
      open(ctx, w);
      await settle();
      assert.equal(seen.calls.length, 1);
      assert.equal(size(), 0, "失败＝无掩膜");
      assert.equal(visFailSig.value, true, "失败态给卡片标「未算出」");
      assert.match(toastSig.value!.text, /视域计算失败/);
      seen.reject = false;
      mutateWorld(x => { x.units[0].track[0].lat = 30.6; });
      await settle();
      assert.equal(seen.calls.length, 2, "闸已放");
      assert.equal(size(), 1);
      assert.equal(visFailSig.value, false, "成功即清失败态");
    } finally { console.warn = warn; }
  });

  it("换图作废在飞的旧单：A 图结果不落到同 id 的 B 图；B 返回 null 也不残留 A", async () => {
    const pend: { obs: VisReq[]; res: (v: VisRes[] | null) => void }[] = [];
    ctx.routeClient.viewshed = (obs: VisReq[]) => new Promise<VisRes[] | null>(res => { pend.push({ obs, res }); });
    const mask = (o: VisReq): VisMask =>
      ({ bb: { lonMin: o.lon, lonMax: o.lon, latMin: o.lat, latMax: o.lat }, cols: 1, rows: 1, vis: new Uint8Array([1]), nVis: 1, nIn: 1, eyeOff: 0 });
    open(ctx, TAC([U("v", { vision: 3 })]));
    await until(() => pend.length === 1);
    assert.equal(pend.length, 1);
    open(ctx, TAC([U("v", { vision: 3, track: [{ t: 3050, lon: 100.7, lat: 30.5 }] })]));
    await settle();
    pend[0].res(pend[0].obs.map(o => ({ owner: o.owner, id: o.id, ring: o.ring, idx: o.idx, mask: mask(o) })));
    await until(() => pend.length === 2);
    assert.equal(size(), 0, "A 的掩膜不落到 B");
    assert.equal(pend.length, 2, "落地后补发 B 的单");
    assert.equal(pend[1].obs[0].lon, 100.7);
    pend[1].res(null);
    await settle();
    assert.equal(size(), 0, "B 失败也不残留 A");
    assert.equal(visFailSig.value, true);
  });

  it("visObservers：曲射按射角成单（缺键 45°）、直射不带射角；观察高度走兵种缺省（舰船 15 m）", () => {
    const w = TAC([U("n", { kind: "navy", vision: 2, range: 1 }), U("d", { kind: "navy", range: 1, fire: "direct" }), U("a", { kind: "siege", range: 8, arcDeg: 70 })]);
    const obs = visObservers(w, 3050, layersSig.peek(), w.meta);
    assert.deepEqual(obs.map(o => `${o.id}:${o.ring}:${o.eyeM}:${o.arcDeg ?? "-"}:${o.tgtM}`), ["n:vision:15:-:2", "n:fire:15:45:0", "d:fire:15:-:2", "a:fire:2:70:0"]);
    yearSig.value = 3050;
  });

  it("visObservers：雷达只在现代战术图且层开时成单，眼位＝天线高度、目标＝假定高度、折射 1/4；古代图与飞行部队不成单", () => {
    const units = [U("r", { radar: 40 }), U("rr", { radar: 30, radarM: 25, radarTgtM: 500 }), U("air", { kind: "air", radar: 50 })];
    const anc = TAC(units), mod = TAC(units, { period: "modern" });
    assert.deepEqual(visObservers(anc, 3050, layersSig.peek(), anc.meta), [], "古代图：雷达不成单");
    const obs = visObservers(mod, 3050, layersSig.peek(), mod.meta);
    assert.deepEqual(obs.map(o => `${o.id}:${o.ring}:${o.km}:${o.eyeM}:${o.tgtM}:${o.refract.toFixed(2)}`), ["r:radar:40:10:100:0.25", "rr:radar:30:25:500:0.25"]);
    assert.deepEqual(visObservers(mod, 3050, { ...layersSig.peek(), radar: false }, mod.meta), [], "雷达层关＝不成单");
  });

  it("现代图上开图即算雷达掩膜，落 sig 的 radar 槽", async () => {
    const w = TAC([U("r", { radar: 40, vision: 3 })], { period: "modern" });
    open(ctx, w);
    await settle();
    assert.deepEqual(seen.calls[0].map(o => o.ring).sort(), ["radar", "vision"]);
    const m = visMaskSig.peek().unit.get("r")!;
    assert.ok(m.radar && m.vision && !m.fire);
  });

  it("visObservers：地点火力多圈各成一单（按下标、各自直射/曲射）、视野与雷达同部队；眼位走类型缺省、驻地恒 100 m；不在当刻不判", () => {
    const nodes = [
      { id: "b", type: "battery", lon: 100.5, lat: 30.5, ranges: [{ 名称: "岸炮", km: 6, fire: "direct" }, { km: 0 }, { 名称: "臼炮", km: 3, arcDeg: 70 }], vision: 8 },
      { id: "r", type: "radarsite", lon: 100.4, lat: 30.4, radar: 60, radarM: 30 },
      { id: "gone", type: "fortress", lon: 100.6, lat: 30.6, until: 3000, ranges: [{ km: 2 }] }
    ];
    const anc = TAC([], {}, nodes), mod = TAC([], { period: "modern" }, nodes);
    const fmt = (o: VisReq) => `${o.owner}:${o.id}:${o.ring}:${o.idx}:${o.km}:${o.eyeM}:${o.arcDeg ?? "-"}:${o.vantageM ?? "-"}`;
    assert.deepEqual(visObservers(anc, 3050, layersSig.peek(), anc.meta).map(fmt),
      ["node:b:vision:0:8:5:-:100", "node:b:fire:0:6:5:-:100", "node:b:fire:2:3:5:70:-"], "古代：无雷达；零半径圈不成单但下标照原数组");
    assert.deepEqual(visObservers(mod, 3050, layersSig.peek(), mod.meta).map(fmt).filter(s => s.includes(":radar:")),
      ["node:r:radar:0:60:30:-:100"], "现代：雷达站按天线高度成单");
    assert.deepEqual(visObservers(anc, 3050, { ...layersSig.peek(), ranges: false, vision: false }, anc.meta), [], "层关不判");
  });

  it("visObservers：飞行部队按当刻飞行高度成单（眼位海拔、不挑驻地、火力恒直射），没填高度不判", () => {
    const w = TAC([
      U("j", { kind: "mftr", vision: 20, range: 5, altM: 3000 }),
      U("b", { kind: "mbmb", range: 5, track: [{ t: 3050, lon: 100.5, lat: 30.5, altM: 800 }] }),
      U("n", { kind: "air", vision: 5 })
    ], { period: "modern" });
    const obs = visObservers(w, 3050, layersSig.peek(), w.meta);
    assert.deepEqual(obs.map(o => `${o.id}:${o.ring}:${o.eyeAbsM ?? "-"}:${o.vantageM ?? "-"}:${o.arcDeg ?? "-"}`),
      ["j:vision:3000:0:-", "j:fire:3000:0:-", "b:fire:800:0:-"], "轰炸机缺键也不走曲射；没填高度的飞行部队不成单");
  });

  it("sightReqs：飞行目标 × 他派的视野圈与雷达（火力圈不算）；同派不算，无所属对无所属算同派", () => {
    const w = TAC([
      U("jet", { kind: "mftr", faction: "A", altM: 5000 }),
      U("radA", { radar: 40, faction: "A" }),
      U("radB", { radar: 40, vision: 5, range: 3, fire: "direct", faction: "B" }),
      U("free", { vision: 5 }),
      U("free2", { kind: "mftr", altM: 1000 })
    ], { period: "modern" }, [{ id: "site", type: "radarsite", lon: 100.4, lat: 30.4, faction: "B", radar: 60 }]);
    const reqs = sightReqs(w, 3050, visObservers(w, 3050, layersSig.peek(), w.meta));
    assert.deepEqual(reqs.map(q => `${q.obs.owner}:${q.obs.id}:${q.obs.ring}>${q.tgt}`).sort(), [
      "node:site:radar>free2", "node:site:radar>jet", "unit:free:vision>jet", "unit:radA:radar>free2",
      "unit:radB:radar>free2", "unit:radB:radar>jet", "unit:radB:vision>free2", "unit:radB:vision>jet"]);
    assert.equal(reqs.find(q => q.tgt === "jet")!.altM, 5000);
  });

  it("点对点结果落 detectSig（按目标分组）；没有观察者时清空", async () => {
    const w = TAC([U("jet", { kind: "mftr", faction: "A", altM: 5000 }), U("rad", { radar: 40, vision: 3, faction: "B" })], { period: "modern" });
    open(ctx, w);
    await settle();
    assert.equal(seen.sights.length, 1, "与掩膜同一单发出");
    assert.deepEqual(detectSig.peek().get("jet")!.map(r => `${r.id}:${r.ring}:${r.hit!.seen}`).sort(), ["rad:radar:true", "rad:vision:false"]);
    mutateWorld(x => { delete x.units[1].radar; delete x.units[1].vision; });
    await settle();
    assert.equal(detectSig.peek().size, 0, "无观察者＝清空");
  });

  it("地点掩膜落 node 表、火力按下标；与同名部队互不覆盖", async () => {
    const w = TAC([U("x", { vision: 3 })], {}, [{ id: "x", type: "battery", lon: 100.5, lat: 30.5, ranges: [{ km: 2 }, { km: 4, fire: "direct" }] }]);
    open(ctx, w);
    await settle();
    const nm = visMaskSig.peek().node.get("x")!, um = visMaskSig.peek().unit.get("x")!;
    assert.ok(nm.fire && nm.fire[0] && nm.fire[1] && !nm.vision, "两圈各一张");
    assert.ok(um.vision && !um.fire, "部队那张不被地点覆盖");
  });
});
