/* 编辑操作内核（纯函数，node:test 可测）：对世界对象的具体改动。
   语义对齐旧实现：删地点连带清理其连线与派系 territory 引用；新对象 id 走 core/util.newId；
   数据经度一律折回本初域（平面世界不折）。撤销/广播由调用方经 state.mutateWorld 走管线。 */
import { wrapLon } from "../core/geo.ts";
import { clampToFrame, inFrame, mapFrame } from "../core/frame.ts";
import { DH_MAX_M, elevUnitM } from "../core/elev.ts";
import { erodeMode, erodePending, type ErodeMode } from "../core/erode.ts";
import { brushZones, encodeZones, paintedZones, zoneGeom } from "../core/climzone.ts";
import { newId, parseKV, tget } from "../core/util.ts";
import { activeAt } from "../core/time.ts";
import { genRiverEdges, riverCells } from "../core/world.ts";
import { TRACK_OK, isModern, setUnitPoint, unitKind, unitPos, type TrackKey } from "../core/units.ts";
import { ALL_KINDS, armOptional, canonComposite, CERTAINTY, MZ_MAX, parseComposite, UNIT_KINDS } from "../core/constants.ts";
import type { Grid } from "../core/grid.ts";
import type { Arm, Asset, BaseOverrides, BBox, Certainty, Decor, Edge, Faction, HeightOverride, Meta, NodeRange, Op, Owner, Phase, TerrainId, TerrainOverride, TrackPt, Unit, UpliftOverride, World, WorldNode } from "../core/types.ts";

export const newNodeId = (): string => newId("n");
export const newEventId = (): string => newId("ev");

/** 数据经度：球面折回 ±180、平面原样（对应旧 wrapLonData） */
export const dataLon = (meta: Meta | undefined, lon: number): number =>
  wrapLon(lon, (meta || {}).worldModel === "flat");

/* 「⏳新对象时间段」：勾选后新画的地点/连线/布景/地形涂改带 since/until（对齐旧 applyEra；
   调用方在创建点位传 eraNewSig 当前值，本函数保持纯函数可测）。 */
export interface EraNew { on: boolean; since: number | null; until: number | null }
export function applyEra<T extends { since?: number | null; until?: number | null }>(o: T, era?: EraNew | null): T {
  if (era && era.on) {
    if (era.since != null && isFinite(era.since)) o.since = era.since;
    if (era.until != null && isFinite(era.until)) o.until = era.until;
  }
  return o;
}

/* 落点精度统一 4 位小数（2026-08 审查修正，原 3 位）：三位＝111m 量子，在 100m 战术格上新落的
   点/章/线会从光标处跳开半格（高倍下十几像素可见），且粗于移动路径（moveNode/setUnitPoint 本就
   4 位）。四位≈11m，与移动同准。 */

/** 点对象落点：先钳进图幅（拖到图廓就停在图廓上，判据在 core/frame），再折回经度、取四位小数 */
export function placeLL(meta: Meta | undefined, lon: number, lat: number): [number, number] {
  const [lo, la] = clampToFrame(mapFrame(meta), lon, lat);
  return [+dataLon(meta, lo).toFixed(4), +la.toFixed(4)];
}

/* 旧档或手编档里落在图廓外的点对象：被图廓外的纸盖住、也点不到。只算点（地点、布景、部队航点）——
   线跨出图廓是常态（河从图边流出去）；缺坐标的地点本就不画，不算在外。 */
const isOutside = (w: World) => {
  const f = mapFrame(w.meta);
  return (o: { lon: number; lat: number }) => isFinite(+o.lon) && isFinite(+o.lat) && !inFrame(f, +o.lon, +o.lat);
};

/** 图廓外的点对象数：地点、布景各按个数，部队有任一航点在外算一个 */
export function outsideCount(w: World): number {
  const out = isOutside(w);
  return w.nodes.filter(out).length + (w.decor || []).filter(out).length
    + (w.units || []).filter(u => (u.track || []).some(out)).length;
}

/** 把 outsideCount 数到的点钳到图廓上（数据只在作者点了才动，一次撤销） */
export function pullIntoFrame(w: World): void {
  const out = isOutside(w), f = mapFrame(w.meta);
  const pull = (o: { lon: number; lat: number }): void => {
    if (out(o)) { const [lo, la] = clampToFrame(f, +o.lon, +o.lat); o.lon = +lo.toFixed(4); o.lat = +la.toFixed(4); }
  };
  w.nodes.forEach(pull); (w.decor || []).forEach(pull);
  for (const u of w.units || []) (u.track || []).forEach(pull);
}

/** 新建地点（旧 addNodeAt：缺省 city 起步；柱B 起「地点」子工具类型 chips 可预选 type,类型仍可在表单里改） */
export function addNode(w: World, 名称: string, lon: number, lat: number, type = "city", id = newNodeId()): WorldNode {
  const [plon, plat] = placeLL(w.meta, lon, lat);
  const n: WorldNode = { id, 名称, lon: plon, lat: plat, type, faction: null, 字段: {}, note: "", link: 名称 };
  w.nodes.push(n);
  return n;
}

/** 新建标注（v0.15 净新）：自由文本注记——名称即图面文本，字号/屏幕角/派系色在表单里改 */
export function addLabel(w: World, 文本: string, lon: number, lat: number, id = newNodeId()): WorldNode {
  const [plon, plat] = placeLL(w.meta, lon, lat);
  const n: WorldNode = { id, 名称: 文本, lon: plon, lat: plat, type: "label", faction: null };
  w.nodes.push(n);
  return n;
}

/** 在某地点旁新建事件点（旧 addEventAt：偏移 +0.4/+0.3，默认战役、年份=当前年） */
export function addEventNear(w: World, at: WorldNode, 名称: string, yearNow: number, id = newEventId()): WorldNode {
  const [plon, plat] = placeLL(w.meta, at.lon + 0.4, at.lat + 0.3);
  const nd: WorldNode = { id, 名称, lon: plon, lat: plat,
    type: "event", evtype: "battle", year: yearNow, 字段: {}, note: "", link: 名称 };
  w.nodes.push(nd);
  return nd;
}

/** 删地点 + 连带清理（旧 removeNodeRefs）：其连线、派系 territory 里的引用 */
export function removeNode(w: World, id: string): boolean {
  const n = w.nodes.find(x => x.id === id);
  if (!n) return false;
  w.nodes = w.nodes.filter(x => x !== n);
  w.edges = w.edges.filter(e => e.from !== id && e.to !== id);
  w.factions.forEach(f => {
    if (!f.territory) return;
    f.territory = f.territory.filter(t => t !== id);
    if (!f.territory.length) delete f.territory;
  });
  return true;
}

/** 连线：同两端同类型视为已存在（不重复建） */
export function addEdge(w: World, from: string, to: string, type: Edge["type"]): Edge | null {
  if (from === to) return null;
  if (w.edges.some(e => e.type === type && ((e.from === from && e.to === to) || (e.from === to && e.to === from)))) return null;
  const e: Edge = { from, to, type };
  w.edges.push(e);
  return e;
}

export function removeEdgeAt(w: World, idx: number): boolean {
  if (!(idx >= 0 && idx < w.edges.length)) return false;
  muteGenRiver(w, w.edges[idx]);
  w.edges.splice(idx, 1);
  return true;
}

/* —— 生成的河：只换带 gen 标记的；删掉或改过的记进 genRiverOff，重抽时过半落在里面的不画（core/world.genRiverEdgesOf）—— */
const isGenRiver = (e: Edge): boolean => e.gen === true && e.type === "river";
/** 删改一条生成的河之前记下它经过的格；不是生成的河不记 */
export function muteGenRiver(w: World, e: Edge | undefined): void {
  if (!e || !isGenRiver(e) || !Array.isArray(e.pts)) return;
  const s = new Set(w.genRiverOff || []);
  for (const c of riverCells(w.meta, e.pts)) s.add(c);
  w.genRiverOff = [...s].sort((a, b) => a - b);
}
const sameNums = (a: number[] | undefined, b: number[] | undefined): boolean => a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]));
/* 生成河的可选键只有 ws / mz：逐项比过再比键数，存档里多带或少带一个键的旧河也算不同、照换 */
const sameGen = (a: Edge, b: Edge): boolean => a.widthM === b.widthM && sameNums(a.ws, b.ws) && sameNums(a.mz, b.mz) && Object.keys(a).length === Object.keys(b).length
  && !!a.pts && !!b.pts && a.pts.length === b.pts.length && a.pts.every((p, i) => p[0] === b.pts![i][0] && p[1] === b.pts![i][1]);
/** 生成的河换成 add：逐条按值相同就不动（返回 false＝没改，开图时与存档逐字同就零写入）；非生成的连线保持原序，生成的河排在最后 */
export function syncGenRivers(w: World, add: Edge[]): boolean {
  const cur = w.edges.filter(isGenRiver);
  if (cur.length === add.length && cur.every((e, i) => sameGen(e, add[i]))) return false;
  w.edges = w.edges.filter(e => !isGenRiver(e)).concat(add);
  return true;
}

/** 新增一条自由画线（pts 折线、无端点）：河流或工事（柱B），返回新边（改线＝删了重画，同作战线） */
export function addFreeEdge(w: World, pts: [number, number][], type: "river" | "wall"): Edge {
  const e: Edge = { type, pts };
  w.edges.push(e);
  return e;
}
/** 按当前生成参数用宏观河网重画生成器的河（中尺度落地后 host 再换成中尺度的）：只换带 gen 标记的，用户改过（标记已删）的不动；
    不是 v2 自动生成的图只撤不画。clear＝地形参数换了、删改记录作废（格号对不上新地形） */
export function regenRivers(w: World, clear: boolean): { removed: number; added: number } {
  if (clear) delete w.genRiverOff;
  const keep = w.edges.filter(e => !isGenRiver(e)), add = genRiverEdges(w.meta, w.genRiverOff);
  const removed = w.edges.length - keep.length;
  w.edges = keep.concat(add);
  return { removed, added: add.length };
}
/** 新增一条自由画河道：addFreeEdge 的河流便捷形（旧名保留） */
export function addRiver(w: World, pts: [number, number][]): Edge { return addFreeEdge(w, pts, "river"); }

/** 移动地点（拖动/微调/表单共用）：钳进图幅、经度折回、四位小数（placeLL） */
export function moveNode(w: World, id: string, lon: number, lat: number): void {
  const n = w.nodes.find(x => x.id === id);
  if (!n) return;
  [n.lon, n.lat] = placeLL(w.meta, lon, lat);
}

/** 地点表单一次提交（旧 ef_save 语义：空值删键、字段 KV 过滤空值行） */
export interface NodeFormValues {
  名称: string; note: string; link: string;
  faction?: string;            // ""=中立；undefined=事件点（无此字段）
  radiusKm?: string; since?: string; until?: string;
  kv: string;
  /* 战术图地点的视域（undefined＝无此栏＝不动；空串＝删键回落缺省） */
  ranges?: NodeRangeDraft[];   // 火力圈逐行
  vision?: string; eyeM?: string;
  radar?: string; radarM?: string; radarTgtM?: string;   // 现代图才有栏
  certainty?: string;          // 可靠性档位（""=确证删键；undefined=不动此键）
  year?: string; sides?: string; result?: string;   // 事件点专属
  fs?: string; pin?: string;   // 标注（type:"label"）专属：字号 px / 屏幕角（""=地图锚定）
}
export function applyNodeForm(n: WorldNode, v: NodeFormValues): void {
  if (v.名称) n.名称 = v.名称;
  n.note = v.note; n.link = v.link;
  if (v.faction !== undefined) n.faction = v.faction || null;
  if (v.radiusKm !== undefined) { const r = parseFloat(v.radiusKm); if (r > 0) n.radiusKm = r; else delete n.radiusKm; }
  if (v.since !== undefined) { const s = parseFloat(v.since); if (isFinite(s)) n.since = s; else delete n.since; }
  if (v.until !== undefined) { const u = parseFloat(v.until); if (isFinite(u)) n.until = u; else delete n.until; }
  const kv = parseKV(v.kv);
  Object.keys(kv).forEach(k => { if (!kv[k]) delete kv[k]; });   // 值留空的模板行不保存
  if (Object.keys(kv).length) n.字段 = kv; else delete n.字段;
  if (v.ranges !== undefined) {
    const rng = v.ranges.map(rangeOfDraft).filter((r): r is NodeRange => r !== null);
    if (rng.length) n.ranges = rng; else delete n.ranges;
  }
  putPos(n, "vision", v.vision); putNonNeg(n, "eyeM", v.eyeM);
  putPos(n, "radar", v.radar); putNonNeg(n, "radarM", v.radarM); putNonNeg(n, "radarTgtM", v.radarTgtM);
  if (v.certainty !== undefined) setCertainty(n, v.certainty);
  if (n.type === "event") {
    if (v.year !== undefined) { const y = parseFloat(v.year); if (isFinite(y)) n.year = y; else delete n.year; }
    if (v.sides !== undefined) { const s = v.sides.trim(); if (s) n.sides = s; else delete n.sides; }
    if (v.result !== undefined) { const r = v.result.trim(); if (r) n.result = r; else delete n.result; }
  }
  if (n.type === "label") {
    if (v.fs !== undefined) { const f = parseFloat(v.fs); if (f > 0 && f !== 13) n.fs = f; else delete n.fs; }   // 13=缺省不落盘
    if (v.pin !== undefined) { if (v.pin) n.pin = v.pin; else delete n.pin; }
  }
}

/** 连线表单一次提交（旧 ee_save 语义；widthM=河流真宽米数，>0 存、空/非法删；
    reverse=工事齿面翻转（柱B），真存假删——缺省齿在画线方向左侧不落盘 */
export interface EdgeFormValues { 名称: string; note: string; kv: string; since: string; until: string; widthM?: string; meander?: string; reverse?: boolean; certainty?: string }
/** 表单「曲流」的档位（值＝整条的 mz）；"auto"＝随地形，逐点不同的 mz 原样留着 */
export const MEANDER_LEVELS: readonly { v: string; 名: string }[] = [{ v: "0", 名: "无" }, { v: "5", 名: "弱" }, { v: "7", 名: "中" }, { v: "9", 名: "强" }];
/** 一条河当前的曲流档：生成的河（不画弯）、没有 mz 或全 0＝"0"；有弯的点强度都一样＝那个数；逐点不同＝"auto" */
export function meanderLevelOf(e: Edge): string {
  const z = !e.gen && Array.isArray(e.mz) ? e.mz.filter(v => v > 0) : [];
  if (!z.length) return "0";
  return z.every(v => v === z[0]) ? String(z[0]) : "auto";
}
/** 按表单档位写 mz："auto" 不动、"0" 删键；档位只改有弯的点（汇合处与陡段钉住的 0 留着），没有曲流的河整条给（首尾由渲染端钉住） */
export function setMeanderLevel(e: Edge, v: string): void {
  if (v === "auto" || !Array.isArray(e.pts)) return;
  const n = Math.round(+v);
  if (!(n >= 1)) { delete e.mz; return; }
  const k = Math.min(MZ_MAX, n), old = Array.isArray(e.mz) && e.mz.length === e.pts.length && e.mz.some(z => z > 0) ? e.mz : null;
  e.mz = e.pts.map((_, i) => old ? (old[i] > 0 ? k : 0) : k);
}
/** 表单保存：生成的河先记进删改记录（一存就归用户，重抽不再在旁边冒一条一样的），再落表单 */
export function saveEdgeForm(w: World, idx: number, v: EdgeFormValues): boolean {
  const e = w.edges[idx];
  if (!e) return false;
  muteGenRiver(w, e);
  applyEdgeForm(e, v);
  return true;
}
export function applyEdgeForm(e: Edge, v: EdgeFormValues): void {
  delete e.gen;   // 改过的河归用户：重新生成时不再替换
  const nm = v.名称.trim(); if (nm) e.名称 = nm; else delete e.名称;
  const nt = v.note.trim(); if (nt) e.note = nt; else delete e.note;
  const kv = parseKV(v.kv);
  if (Object.keys(kv).length) e.字段 = kv; else delete e.字段;
  const s = parseFloat(v.since); if (isFinite(s)) e.since = s; else delete e.since;
  const u = parseFloat(v.until); if (isFinite(u)) e.until = u; else delete e.until;
  if (v.widthM !== undefined) {   // 河宽改了就删逐点宽（用户填的是整条一个宽）；曲流强度与宽无关，留着
    const w = parseFloat(v.widthM), nw = w > 0 ? w : undefined;
    if (nw !== e.widthM) delete e.ws;
    if (nw) e.widthM = nw; else delete e.widthM;
  }
  if (v.meander !== undefined) setMeanderLevel(e, v.meander);
  if (v.reverse !== undefined) { if (v.reverse) e.reverse = true; else delete e.reverse; }
  if (v.certainty !== undefined) setCertainty(e, v.certainty);
}

/** 可靠性写入（地点/连线共用，柱B）：确证＝删键不落盘（旧档零迁移）；未知档位按确证处理 */
export function setCertainty(o: { certainty?: Certainty }, v: string): void {
  if (v && tget(CERTAINTY, v)) o.certainty = v as Certainty; else delete o.certainty;
}

/* —— 归属沿革（nodes[].owners：分时段归属；旧版仅可改 JSON，这里补编辑器内核）——
   不自动排序：ownerAt 按数组顺序取首个命中段，保持用户编排（良构数据不重叠时与顺序无关）。 */
export function addOwner(n: WorldNode, sinceYear: number): void {
  const owners = n.owners || (n.owners = []);
  const o: Owner = { faction: null };
  if (isFinite(sinceYear)) o.since = sinceYear;   // 新段默认从当年起
  owners.push(o);
}
export function removeOwner(n: WorldNode, i: number): boolean {
  if (!n.owners || !(i >= 0 && i < n.owners.length)) return false;
  n.owners.splice(i, 1);
  if (!n.owners.length) delete n.owners;
  return true;
}
export interface OwnerPatch { faction?: string; since?: string; until?: string }
/** 改一段归属（faction 空=中立/自由；起/止 parseFloat 空删语义） */
export function updateOwner(n: WorldNode, i: number, patch: OwnerPatch): void {
  const o = n.owners && n.owners[i];
  if (!o) return;
  if (patch.faction !== undefined) o.faction = patch.faction || null;
  if (patch.since !== undefined) { const s = parseFloat(patch.since); if (isFinite(s)) o.since = s; else delete o.since; }
  if (patch.until !== undefined) { const u = parseFloat(patch.until); if (isFinite(u)) o.until = u; else delete o.until; }
}

/** 改类型（立即生效那一步）：转成事件点补 evtype/year（对齐旧 ef_type onchange） */
export function changeNodeType(n: WorldNode, type: string, yearNow: number, validEvtype: (t: unknown) => boolean): void {
  n.type = type;
  if (n.type === "event") {
    if (!validEvtype(n.evtype)) n.evtype = "battle";
    if (n.year == null) n.year = yearNow;
  }
}

/* —— 作战线（事件点 ops[]；对齐旧 opDraw 落库 / opDel）—— */
/** 新增一条作战线到事件点：side/troop/label 空、w=3（同旧 push 默认）。返回新下标；非事件/缺失=null */
export function addOp(w: World, evId: string, kind: Op["kind"], pts: [number, number][]): number | null {
  const ev = w.nodes.find(n => n.id === evId);
  if (!ev || ev.type !== "event") return null;
  const ops = ev.ops || (ev.ops = []);
  ops.push({ kind, pts, side: null, troop: "", label: "", w: 3 });
  return ops.length - 1;
}

/** 删一条作战线（空了删 ops 整键，同旧 opDel） */
export function removeOp(w: World, evId: string, i: number): boolean {
  const ev = w.nodes.find(n => n.id === evId);
  if (!ev || !ev.ops || !(i >= 0 && i < ev.ops.length)) return false;
  ev.ops.splice(i, 1);
  if (!ev.ops.length) delete ev.ops;
  return true;
}

/* —— 地形涂改（terrainOverrides[]；对齐旧 paintAt）——
   圆盘笔刷（半径=size-1 格，dr²+dc²≤R²+0.5）逐格：先移除该格「当年生效且同粒度或更细」的旧涂改，
   再写入新涂改；橡皮=只移除（靠 buildGridCells 回退种子初稿/继承的粗块）。lon/lat=笔刷中心（数据经度，已折回）。
   新壳不再直改 grid.cells（改完由外壳 rebuild 重建）；era=「⏳新对象时间段」（勾选则涂改带 since/until）。 */
/* 逐 dab 涂改索引（2026-08-10 精度批）：按「涂改中心所在格」分桶。280 密度重涂改图（长平级
   ＝1.6 万条）上，原「盘内逐格 × 全表 filter」每 move 上百万次比较＝拖笔即卡；分桶后每**笔迹路径**
   一次 O(N) 建桶 + 逐格 O(命中数)（2026-08-19 连续批把桶提到路径外——插值后一次 move 可有上百个盘心）。⚠ 桶只是**预筛**，候选仍过全谓词（|Δ|<tol 且 tol=0.4 格
   <半格 ⇒ 命中者必落在中心所在桶＝无漏），负坐标的键折叠也只会多扫、被全谓词拒掉＝语义逐位。 */
const bucketByCell = <T extends { lon: number; lat: number }>(list: T[], bb: BBox, step: number): Map<number, T[]> => {
  const m = new Map<number, T[]>();
  for (const o of list) {
    const k = Math.floor((o.lat - bb.latMin) / step) * 4096 + Math.floor((o.lon - bb.lonMin) / step);
    const a = m.get(k);
    if (a) a.push(o); else m.set(k, [o]);   // 桶内保持数组序＝find 首个命中语义可复现
  }
  return m;
};

/* 高程笔的桶跨 move 留着：一笔里每个 move 都对全部高程涂改重新分桶，涂改多的图（真高程几十万条）每个 move 白付几十毫秒。
   按数组与长度认——这支笔只往数组尾上 push（同时就地补进桶）或整份换新数组；别处要在同一个数组上增删，必须换新数组，否则桶对不上 */
const hovBkt = new WeakMap<HeightOverride[], { n: number; lonMin: number; latMin: number; step: number; m: Map<number, HeightOverride[]> }>();
function heightBuckets(ovs: HeightOverride[], bb: BBox, step: number): Map<number, HeightOverride[]> {
  const hit = hovBkt.get(ovs);
  if (hit && hit.n === ovs.length && hit.lonMin === bb.lonMin && hit.latMin === bb.latMin && hit.step === step) return hit.m;
  const m = bucketByCell(ovs, bb, step);
  hovBkt.set(ovs, { n: ovs.length, lonMin: bb.lonMin, latMin: bb.latMin, step, m });
  return m;
}

/* 涂改要不要记自身块尺寸——判据自 2026-08-12 起**不再是「是不是战术图」**:缺 step 键＝按 1° 粗块
   解读(`grid.ts`/`erode.ts`/`elev.ts` 三处 `+(o.step) || step` 与 `core/tactical.ts` 烘焙的 `|| 1` 同规),
   故凡格细于 1° 都必须记。战略图一开网格密度就落在这一档,不记则烘焙成战术图时按 1° 粗块盖章
   ＝面积三十几倍。战术图恒记＝旧行为逐位(它的 step 本就 <1,这一支只是把老语义原样留着)。 */
const recordBlockStep = (w: World, step: number): boolean =>
  ((w.meta || {}) as { mapKind?: string }).mapKind === "tactical" || step < 1;

/* —— 手动档的侵蚀底图（world.baseOverrides，读端 core/erode.erodeBasis）—— */
/** 手动档下改三轴涂改之前调：这一轴还跟着现状走，就把改前那份钉成侵蚀看到的。高程轴深拷贝（高程笔原地改写记录）。
    写入口漏调＝笔下的改动悄悄进了侵蚀输入：画面当时不变，下次整图重算（开图、撤销、换设置）地形自己变 */
function pinBase(w: World, axis: keyof BaseOverrides): void {
  if (erodeMode(w.meta) !== "base") return;
  const b = w.baseOverrides || (w.baseOverrides = { height: [], uplift: [] });   // 键缺＝没记过：高程与抬升不进侵蚀（erodeBasis 同读法）
  if (b[axis]) return;
  if (axis === "terrain") b.terrain = w.terrainOverrides || [];
  else if (axis === "height") b.height = (w.heightOverrides || []).map(o => ({ ...o }));
  else b.uplift = w.upliftOverrides || [];
}
/** 「侵蚀」命令：把现在的三轴涂改整个收进侵蚀（只在手动档有东西可收时动）。返回动了没有 */
export function foldIntoErosion(w: World): boolean {
  if (!erodePending(w)) return false;
  w.baseOverrides = {};
  return true;
}
/** 换侵蚀计算档：进手动档＝现状整个算侵蚀过的（从自动档来画面不变）；离开手动档删记录，免得日后切回来读到过期的那份 */
export function setErodeMode(w: World, mode: ErodeMode): void {
  if (mode === erodeMode(w.meta)) return;
  if (mode === "all") delete w.meta.erode; else w.meta.erode = mode;
  if (mode === "base") w.baseOverrides = {}; else delete w.baseOverrides;
}

export function paintTerrainAt(w: World, grid: Grid, yearNow: number, lon: number, lat: number,
  t: string, size: number, erase: boolean, era?: EraNew | null,
  axis: "both" | "lf" | "eco" = "both"): boolean {   // t=复合串（两轴）；axis=单轴笔刷时只并入该轴、另一轴留旧格值
  return paintTerrainPath(w, grid, yearNow, [[lon, lat]], t, size, erase, era, axis);
}

/* 一次落一串盘心（2026-08-19 笔画连续批：一次 pointermove 的插值路径）。逐点各调一次
   paintTerrainAt 也能画出连续笔迹，但有两处代价：① 每点重建一次 O(涂改数) 的桶；② **同一格被
   相邻两盘覆盖时会重复入库**（新写的涂改不在桶里，后一盘看不见它）——一笔下来能把同一格涂改
   翻两三倍。故收成路径版：桶只建一次，`seen` 保证同一格只处理一次（同一笔同一格的写入值恒等
   ——笔刷与基面格值在这一串里都不变，故跳过后来者与写两遍等价）。 */
export function paintTerrainPath(w: World, grid: Grid, yearNow: number,
  path: readonly (readonly [number, number])[],
  t: string, size: number, erase: boolean, era?: EraNew | null,
  axis: "both" | "lf" | "eco" = "both", wiped?: { n: number }): boolean {   // wiped＝跨调用累加本笔清掉的手雕高程条数（收笔回执用）
  const { bb, step, cells } = grid;
  const recStep = recordBlockStep(w, step);
  const R = size - 1, prec = step >= 0.05 ? 2 : 4, tol = step * 0.4;
  const [brLf, brEco] = parseComposite(t);   // 笔刷复合的两轴分量（单轴模式各取其一并入现格）
  const ovs = w.terrainOverrides || [];
  /* 地貌笔＝重定基面：涂到的格子把**当刻生效的手雕高程一并复位**（同粒度或更细，同类型涂改
     移除之规）——雕痕存在独立的 heightOverrides 层，地貌笔不清它时「涂平原盖不掉雕出的山」，
     且雕痕下的格子往往本就是平原类型＝涂平原零改动、字面意义的「刷不动」（2026-08-08 用户实报）。
     只在**落笔**时清（橡皮各轴自守）；生态轴不清——林可以长在雕出的山上。 */
  const wipeHov = !erase && axis !== "eco";
  const hovs = w.heightOverrides;
  const bkt = bucketByCell(ovs, bb, step);
  const hbkt = wipeHov && hovs && hovs.length ? bucketByCell(hovs, bb, step) : null;
  /* 尺寸判据带绝对项 +5.1e-5：吸收旧档 step 的 toFixed(4) 量化（最多 +5e-5，细格上超过 1.001 的
     相对容差），被量化撑成「粗块」的同格旧章才擦得掉、盖得掉。重建端（grid/elev/erode）的同式
     判据锁着黄金基准不能同改——旧章的自愈只发生在笔下：涂过/擦过即除。 */
  const hit = (o: { lon: number; lat: number; step?: number; since?: number | null; until?: number | null },
    clon: number, clat: number): boolean =>
    Math.abs(o.lon - clon) < tol && Math.abs(o.lat - clat) < tol
      && (+(o.step as number) || step) <= step * 1.001 + 5.1e-5 && activeAt(o, yearNow);
  const deadT = new Set<TerrainOverride>(), deadH = new Set<HeightOverride>();
  const added: TerrainOverride[] = [];
  const seen = new Set<number>();
  let changed = false;
  for (const [lon, lat] of path) {
    const c0 = Math.floor((lon - bb.lonMin) / step), r0 = Math.floor((lat - bb.latMin) / step);
    for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
      if (dr * dr + dc * dc > R * R + 0.5) continue;
      const r = r0 + dr, c = c0 + dc;
      if (!(cells[r] && cells[r][c] !== undefined)) continue;   // 越界跳过
      const clon = bb.lonMin + (c + 0.5) * step, clat = bb.latMin + (r + 0.5) * step;
      const k = r * 4096 + c;                                   // 界内 ⇒ c<cols≤2048 ⇒ 键唯一（桶的折叠只多扫，seen 不能有假命中）
      if (seen.has(k)) continue;                                // 同一格只处理一次（见函数头注）
      seen.add(k);
      for (const o of bkt.get(k) || []) if (!deadT.has(o) && hit(o, clon, clat)) { deadT.add(o); changed = true; }
      if (hbkt) for (const o of hbkt.get(k) || []) if (!deadH.has(o) && hit(o, clon, clat)) { deadH.add(o); changed = true; }
      if (!erase) {
        // 单轴笔刷：并入现格值的对应轴（地貌笔改地貌留生态、生态笔改生态留地貌）——现格=cells 已含旧涂改+初稿
        let cellT = t;
        if (axis !== "both") {
          const [cLf, cEco] = parseComposite(cells[r][c]);
          cellT = axis === "lf" ? canonComposite(brLf + (cEco === "none" ? "" : "/" + cEco))
                                : canonComposite(cLf + (brEco === "none" ? "" : "/" + brEco));
        }
        const ov: TerrainOverride = { lon: +clon.toFixed(prec), lat: +clat.toFixed(prec), t: cellT };
        /* step 记 7 位小数（原 4 位，对齐旧 paintAt 的存档格式，键语义不变）：4 位在细格上可向上量化
           超过 0.1%（0.000573→0.0006），重建被 1.001 容差判成粗块＝一格涂改扩成 2×2 且橡皮擦不掉；
           7 位误差 ≤5e-8，对合法最细格 0.0002° 恒在容差内。 */
        if (recStep) ov.step = +step.toFixed(7);   // 细格涂改记录自身块尺寸（与继承的 1° 粗块区分）
        added.push(applyEra(ov, era)); changed = true;
      }
    }
  }
  // 与旧逐格 filter+push 的产物同序：存活者按原序 + 新涂按盘序追加（新涂中心互异＝不会互相命中）
  if (deadT.size || added.length) pinBase(w, "terrain");
  w.terrainOverrides = deadT.size || added.length ? (deadT.size ? ovs.filter(o => !deadT.has(o)) : ovs).concat(added) : ovs;
  if (deadH.size) { pinBase(w, "height"); w.heightOverrides = hovs!.filter(o => !deadH.has(o)); }   // 只在真移除时赋回（缺键不落盘之约）
  if (wiped) wiped.n += deadH.size;
  return changed;
}

/* —— 高程涂改（heightOverrides[]；渲染层专用，不动地形类型/寻路）——
   圆盘笔刷逐格**加性**叠加 dh（抬升正/下切负）；同格、同粒度、同时段的图章合并累加，
   累加到恰 0 自动清除（涂上去再涂回来=无痕）。几何与 paintTerrainAt 同（半径 size-1 格）。
   精度 6 位小数（2026-08-10 米制分档批，原 4 位）：1m/笔 在自定义 elevUnitM（如 3000＝
   0.000333/笔）下 4 位会削去 10%＝雕 100 笔少 10m；清除阈值随之 1e-4→1e-6（0.2m 的旧阈值
   会把大 elevUnitM 下的整笔 1m 当零吞掉）。 */
export function paintHeightAt(w: World, grid: Grid, lon: number, lat: number,
  dh: number, size: number, era?: EraNew | null): boolean {
  return paintHeightPath(w, grid, [[lon, lat]], dh, size, era);
}

/* 路径版（同 paintTerrainPath 之规，见其头注）。⚠ 这里 `seen` 还兼着一条语义：dh 是**加性**的，
   一次 pointermove 的插值路径上同一格若被相邻几个盘反复叠加，快拖一下就会比慢拖挖深好几倍。
   一格一次＝「每个事件每格加一笔」，慢拖仍因事件更多而叠得更深（笔速控制落料，与手感相符）。 */
export function paintHeightPath(w: World, grid: Grid, path: readonly (readonly [number, number])[],
  dh: number, size: number, era?: EraNew | null): boolean {
  const { bb, step, cells } = grid;
  const recStep = recordBlockStep(w, step);   // 同 paintTerrainAt：细格涂改记录块尺寸
  const R = size - 1, prec = step >= 0.05 ? 2 : 4, tol = step * 0.4;
  const ovs = w.heightOverrides || (w.heightOverrides = []);
  const es = era && era.on && era.since != null && isFinite(era.since) ? era.since : null;
  const eu = era && era.on && era.until != null && isFinite(era.until) ? era.until : null;
  const bkt = heightBuckets(ovs, bb, step);   // 逐 dab 索引（预筛，候选仍过全谓词；桶内保数组序＝find 首个命中）；跨 move 留着
  const cap = DH_MAX_M / elevUnitM(w.meta);   // 写端与读端 dhOf 同一上限：笔下存不出读端会钳掉的值
  const dead = new Set<HeightOverride>();
  const seen = new Set<number>();
  let changed = false;
  for (const [lon, lat] of path) {
    const c0 = Math.floor((lon - bb.lonMin) / step), r0 = Math.floor((lat - bb.latMin) / step);
    for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
      if (dr * dr + dc * dc > R * R + 0.5) continue;
      const r = r0 + dr, c = c0 + dc;
      if (!(cells[r] && cells[r][c] !== undefined)) continue;
      const k = r * 4096 + c;
      if (seen.has(k)) continue;                  // 同一格一笔只叠一次（见函数头注）
      seen.add(k);
      const clon = +(bb.lonMin + (c + 0.5) * step).toFixed(prec), clat = +(bb.latMin + (r + 0.5) * step).toFixed(prec);
      const ex = (bkt.get(k) || []).find(o => !dead.has(o) && Math.abs(o.lon - clon) < tol && Math.abs(o.lat - clat) < tol
        && (+(o.step as number) || step) <= step * 1.001 + 5.1e-5 && (o.since ?? null) === es && (o.until ?? null) === eu);   // 尺寸判据同 paintTerrainPath 的 hit：绝对项吸收旧档 4 位量化
      if (ex) {
        const nd = Math.max(-cap, Math.min(cap, +(ex.dh + dh).toFixed(6)));
        if (nd === ex.dh) continue;               // 已到幅度上限：这一格不再叠，也不记改动
        pinBase(w, "height");                     // 原地改写之前：钉过即空操作
        ex.dh = nd;
        if (recStep) ex.step = +step.toFixed(7);   // 顺手把旧章的量化 step 校直——不然它在重建端仍按粗块解读
        if (Math.abs(ex.dh) < 1e-6) dead.add(ex);
      } else {
        const ov: HeightOverride = { lon: clon, lat: clat, dh: +dh.toFixed(6) };
        if (recStep) ov.step = +step.toFixed(7);   // 7 位防细格量化误判粗块（同 paintTerrainPath 之规）
        pinBase(w, "height");
        ovs.push(applyEra(ov, era));
        const bk = Math.floor((ov.lat - bb.latMin) / step) * 4096 + Math.floor((ov.lon - bb.lonMin) / step), ba = bkt.get(bk);   // 与 bucketByCell 同一个键
        if (ba) ba.push(ov); else bkt.set(bk, [ov]);
        hovBkt.get(ovs)!.n = ovs.length;
      }
      changed = true;
    }
  }
  if (dead.size) w.heightOverrides = ovs.filter(o => !dead.has(o));
  return changed;
}

/** 写回已应用的造山 / 造盆地目标：删空则删键（缺键不落盘） */
function setUplifts(w: World, list: UpliftOverride[]): void {
  if (list.length) w.upliftOverrides = list; else delete w.upliftOverrides;
}
const UP_KEYS = ["lon", "lat", "peakM", "floorM", "step", "since", "until"] as const;
/** 写回草稿：与已应用的那份逐条相同＝没有待应用的，删键（「应用」按钮据此置灰） */
function setDraft(w: World, list: UpliftOverride[]): void {
  const cur = w.upliftOverrides || [];
  if (list.length === cur.length && list.every((o, i) => UP_KEYS.every(k => (o[k] ?? null) === (cur[i][k] ?? null)))) delete w.upliftDraft;
  else w.upliftDraft = list;
}
/** 「应用」：草稿成为已应用的目标（host 据此重解中尺度）；手动档下顺带把抬升那一轴收进侵蚀，地貌与高程两轴不动。没有草稿＝不动 */
export function applyUplift(w: World): boolean {
  if (!w.upliftDraft) return false;
  setUplifts(w, w.upliftDraft);
  delete w.upliftDraft;
  if (erodeMode(w.meta) === "base") delete (w.baseOverrides || (w.baseOverrides = { height: [] })).uplift;   // 键缺＝没记过：高程照旧不进侵蚀
  return true;
}
/** 「放弃」：丢掉没应用的草稿 */
export function discardUplift(w: World): boolean {
  if (!w.upliftDraft) return false;
  delete w.upliftDraft;
  return true;
}

/** 画抬升一笔的目标：山＝峰高（米，> 0），盆地＝盆底（米，可为负） */
export type UpliftAim = { peakM: number } | { floorM: number };
/* —— 造山 / 造盆地的目标（v2 战略图高程页，core/elev.upliftOn）：笔只改草稿 upliftDraft（没有就从已应用的那份起），地形等点「应用」——
   圆盘逐格记目标峰高或盆底：同格、同粒度、同时段再涂＝覆盖（不累加，量是「要多高 / 多低」不是「再加多少」；山盆互相覆盖）；
   橡皮擦掉笔下当刻生效的目标（已应用的也擦，应用后那座山才消失）。改了就换新数组。 */
export function paintUpliftPath(w: World, grid: Grid, yearNow: number, path: readonly (readonly [number, number])[],
  aim: UpliftAim, size: number, erase: boolean, era?: EraNew | null): boolean {
  const { bb, step, cells } = grid;
  const recStep = recordBlockStep(w, step);
  const R = size - 1, prec = step >= 0.05 ? 2 : 4, tol = step * 0.4;
  const pk = "peakM" in aim ? Math.round(Math.min(DH_MAX_M, aim.peakM)) : NaN, fl = "floorM" in aim ? Math.round(Math.max(-DH_MAX_M, Math.min(DH_MAX_M, aim.floorM))) : NaN;
  if (!erase && !(pk > 0) && !isFinite(fl)) return false;
  const ups = w.upliftDraft || w.upliftOverrides || [];
  const es = era && era.on && era.since != null && isFinite(era.since) ? era.since : null;
  const eu = era && era.on && era.until != null && isFinite(era.until) ? era.until : null;
  const ubkt = bucketByCell(ups, bb, step);
  const near = (o: { lon: number; lat: number; step?: number }, clon: number, clat: number): boolean =>
    Math.abs(o.lon - clon) < tol && Math.abs(o.lat - clat) < tol && (+(o.step as number) || step) <= step * 1.001 + 5.1e-5;   // 尺寸判据同 paintTerrainPath 的 hit
  const deadU = new Set<UpliftOverride>(), added: UpliftOverride[] = [], seen = new Set<number>();
  for (const [lon, lat] of path) {
    const c0 = Math.floor((lon - bb.lonMin) / step), r0 = Math.floor((lat - bb.latMin) / step);
    for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
      if (dr * dr + dc * dc > R * R + 0.5) continue;
      const r = r0 + dr, c = c0 + dc;
      if (!(cells[r] && cells[r][c] !== undefined)) continue;
      const k = r * 4096 + c;
      if (seen.has(k)) continue;
      seen.add(k);
      const clon = +(bb.lonMin + (c + 0.5) * step).toFixed(prec), clat = +(bb.latMin + (r + 0.5) * step).toFixed(prec);
      if (erase) {
        for (const o of ubkt.get(k) || []) if (!deadU.has(o) && near(o, clon, clat) && activeAt(o, yearNow)) deadU.add(o);
        continue;
      }
      const ex = (ubkt.get(k) || []).find(o => !deadU.has(o) && near(o, clon, clat) && (o.since ?? null) === es && (o.until ?? null) === eu);
      if (ex && (pk > 0 ? ex.peakM === pk : ex.floorM === fl) && (!recStep || ex.step === +step.toFixed(7))) continue;
      if (ex) deadU.add(ex);
      const ov: UpliftOverride = pk > 0 ? { lon: clon, lat: clat, peakM: pk } : { lon: clon, lat: clat, floorM: fl };
      if (recStep) ov.step = +step.toFixed(7);   // 7 位防细格量化误判粗块（同 paintTerrainPath 之规）
      added.push(applyEra(ov, era));
    }
  }
  if (deadU.size || added.length) setDraft(w, (deadU.size ? ups.filter(o => !deadU.has(o)) : ups).concat(added));
  return deadU.size + added.length > 0;
}

/** 气候分区一笔（路径版）：k＝CLIMATE_ORDER 序号 +1，0＝擦回未涂；R＝分区格半径。一格只属一档（涂 X 即抹掉它档）；
    改了就换新数组（分区栅格按数组引用记忆），擦空则删键。返回是否有变化。 */
export function paintClimatePath(w: World, path: readonly (readonly [number, number])[], k: number, R: number): boolean {
  if (w.meta && w.meta.mapKind === "tactical") return false;   // 战术图不用分区（继承母图那一档）
  const cur = paintedZones(w.meta, w.climateZones), geo = zoneGeom(w.meta);
  const g = { ...geo, z: cur ? cur.z.slice() : new Uint8Array(geo.cols * geo.rows) };
  let changed = false;
  for (const [lon, lat] of path) if (brushZones(g, lon, lat, R, k)) changed = true;
  if (!changed) return false;
  const enc = encodeZones(g);
  if (enc.length) w.climateZones = enc; else delete w.climateZones;
  return true;
}

/* 2026-08-13 冻结批：splitOverridesToStep 已删——它唯一的存在理由是「改图幅=改格边」的涂改
   迁移,而尺寸/密度自此创建后冻结（设置弹层不再改 bbox）,那条路不存在了。 */

/* —— 手绘布景（decor[]；对齐旧 placeDecor/decorEraseAt）—— */
/** 落一枚布景印章（placeLL） */
export function addDecor(w: World, lon: number, lat: number, kind: string, size: number): Decor {
  const [plon, plat] = placeLL(w.meta, lon, lat);
  const d: Decor = { id: newId("d"), lon: plon, lat: plat, kind, size };
  (w.decor || (w.decor = [])).push(d);
  return d;
}
/** 移一枚布景到新经纬（placeLL；单枚拖移与框选整组拖移共用） */
export function moveDecor(w: World, id: string, lon: number, lat: number): void {
  const d = (w.decor || []).find(x => x.id === id);
  if (!d) return;
  [d.lon, d.lat] = placeLL(w.meta, lon, lat);
}
/** 删一枚布景（按 id）。World.decor 恒为数组（normalizeWorld 保证），空了留空数组不删键 */
export function removeDecor(w: World, id: string): boolean {
  const before = (w.decor || []).length;
  w.decor = (w.decor || []).filter(d => d.id !== id);
  return w.decor.length !== before;
}

/** 内嵌一枚自定义印章资产（幂等：已存同 id 不重复；首次落章时补入，见 pointer decorDab） */
export function addAsset(w: World, a: Asset): void {
  const assets = w.assets || (w.assets = []);
  if (!assets.some(x => x.id === a.id)) assets.push({ id: a.id, name: a.name, src: a.src, w: a.w, h: a.h });
}
/** 删一枚自定义印章资产 + 连带删引用它的全部 decor（对齐 removeFaction 连带语义）；空了删 assets 键（旧档形状） */
export function removeAsset(w: World, id: string): boolean {
  const had = (w.assets || []).some(a => a.id === id);
  if (w.assets) { w.assets = w.assets.filter(a => a.id !== id); if (!w.assets.length) delete w.assets; }
  if (w.decor) w.decor = w.decor.filter(d => d.kind !== "img:" + id);
  return had;
}

/* —— 派系（对齐旧 newFaction/deleteFaction/ff_save）—— */
export const FAC_PALETTE = ["#c9a227", "#3aa675", "#8a5cd0", "#3d7bd0", "#c0392b", "#e07b3a", "#2a9d8f", "#b5651d", "#6d6875", "#457b9d"];

export function addFaction(w: World): Faction {
  const f: Faction = { id: newId("f"), 名称: "新派系", color: FAC_PALETTE[w.factions.length % FAC_PALETTE.length] };
  w.factions.push(f);
  return f;
}

/** 删派系 + 连带：地点归属变中立、归属沿革条目剔除、作战线 side 清空、部队归属清空 */
export function removeFaction(w: World, id: string): boolean {
  const f = w.factions.find(x => x.id === id);
  if (!f) return false;
  w.factions = w.factions.filter(x => x !== f);
  w.nodes.forEach(n => {
    if (n.faction === id) n.faction = null;
    if (n.owners) { n.owners = n.owners.filter(o => o.faction !== id); if (!n.owners.length) delete n.owners; }
  });
  w.nodes.forEach(n => { (n.ops || []).forEach(op => { if (op.side === id) op.side = null; }); });
  (w.units || []).forEach(u => { if (u.faction === id) u.faction = null; });   // 部队悬空归属（旧版同漏，一并修）
  return true;
}

export interface FactionFormValues { 名称: string; color: string; 阵营: string; since: string; until: string; note: string; link: string }
export function applyFactionForm(f: Faction, v: FactionFormValues): void {
  f.名称 = v.名称.trim() || f.名称;
  f.color = v.color || f.color;
  const cp = v.阵营.trim(); if (cp) f.阵营 = cp; else delete f.阵营;
  const s = parseFloat(v.since); if (isFinite(s)) f.since = s; else delete f.since;
  const u = parseFloat(v.until); if (isFinite(u)) f.until = u; else delete f.until;
  const nt = v.note.trim(); if (nt) f.note = nt; else delete f.note;
  const lk = v.link.trim(); if (lk) f.link = lk; else delete f.link;
}

/** 删涂域时段层（层空了整键删除，同旧） */
export function removePaintLayer(f: Faction, idx: number): boolean {
  if (!f.paint || !(idx >= 0 && idx < f.paint.length)) return false;
  f.paint.splice(idx, 1);
  if (!f.paint.length) delete f.paint;
  return true;
}

/** 层时段（保存年代）：parseFloat 空删语义 */
export function setPaintLayerSpan(L: { since?: number | null; until?: number | null }, since: string, until: string): void {
  const s = parseFloat(since); if (isFinite(s)) L.since = s; else delete L.since;
  const u = parseFloat(until); if (isFinite(u)) L.until = u; else delete L.until;
}

/* —— 兵棋部队（战术图 units[]；对齐旧 addUnitAt/deleteUnit/uf_save）——
   航点坐标只 toFixed(4)、不折回本初域（对齐旧实现：战术图为小范围战场，无环绕）。 */
export const newUnitId = (): string => newId("u");

/** 新建未入场部队（track 空＝不在图上）：军面板「＋ 新增部队」用——先入列表改名设属性，再从列表拖入地图落首航点 */
export function addUnitUnplaced(w: World, 名称: string, id = newUnitId()): Unit {
  const u: Unit = { id, 名称, faction: null, kind: isModern(w.meta) ? "mcomb" : "linf", arm: "land", track: [] };
  (w.units || (w.units = [])).push(u);
  return u;
}

/** 航点坐标钳进图幅（同 placeLL，但航点经度沿用旧约定不折回） */
const unitLL = (w: World, lon: number, lat: number): [number, number] => {
  const [lo, la] = clampToFrame(mapFrame(w.meta), +lon, +lat);
  return [+lo.toFixed(4), +la.toFixed(4)];
};

/** 新建部队：默认步兵、track 首航点=当日 T（对齐旧 addUnitAt；名称由外壳 prompt 后传入） */
export function addUnit(w: World, 名称: string, lon: number, lat: number, T: number, id = newUnitId()): Unit {
  const [plon, plat] = unitLL(w, lon, lat);
  const u: Unit = { id, 名称, faction: null, kind: isModern(w.meta) ? "mcomb" : "linf", arm: "land",
    track: [{ t: +T, lon: plon, lat: plat }] };
  (w.units || (w.units = [])).push(u);
  return u;
}

export function removeUnit(w: World, id: string): boolean {
  const before = (w.units || []).length;
  w.units = (w.units || []).filter(u => u.id !== id);
  return w.units.length !== before;
}

/** 写/改某日航点（拖动部队记录当日位置；同日改写、异日插入按日排序，见 core.setUnitPoint） */
export function setUnitWaypoint(w: World, id: string, T: number, lon: number, lat: number): boolean {
  const u = (w.units || []).find(x => x.id === id);
  if (!u) return false;
  setUnitPoint(u, T, ...unitLL(w, lon, lat));
  return true;
}

/** 删某航点（对齐旧 data-tdel） */
export function deleteUnitWaypoint(w: World, id: string, i: number): boolean {
  const u = (w.units || []).find(x => x.id === id);
  if (!u || !u.track || !(i >= 0 && i < u.track.length)) return false;
  u.track.splice(i, 1);
  return true;
}

/* 动向列表的行内编辑一律按**行下标**定位（同 deleteUnitWaypoint）：按时刻 find 会在同刻两行时改到首行——
   第二行填 10、第一行变 10。图上拖动仍按时刻走 setUnitWaypoint（那是「当刻」的意图，取末一个同刻点）。 */
const trackRow = (w: World, id: string, i: number): TrackPt | null => {
  const u = (w.units || []).find(x => x.id === id);
  return u && u.track && i >= 0 && i < u.track.length ? u.track[i] : null;
};

/** 改第 i 行航点的坐标（整点展开，时刻不动故不必重排） */
export function setUnitWaypointAt(w: World, id: string, i: number, lon: number, lat: number): boolean {
  const u = (w.units || []).find(x => x.id === id);
  if (!u || !u.track || !trackRow(w, id, i)) return false;
  const [plon, plat] = unitLL(w, lon, lat);
  u.track[i] = { ...u.track[i], lon: plon, lat: plat };
  return true;
}

/** 设/清第 i 行航点的状态（st：UNIT_STATUS 键；空=常态删键）——自该航点起生效到下一航点 */
export function setUnitWaypointStatus(w: World, id: string, i: number, st: string): boolean {
  const p = trackRow(w, id, i);
  if (!p) return false;
  if (st) p.st = st; else delete p.st;
  return true;
}

/** 设/清第 i 行航点的朝向（度；空/非法=删键回落行进方向）——自该航点起生效到下一航点，同 st 之规 */
export function setUnitWaypointFacing(w: World, id: string, i: number, deg: string): boolean {
  const p = trackRow(w, id, i);
  if (!p) return false;
  const v = parseFloat(deg);
  if (isFinite(v)) p.facing = ((v % 360) + 360) % 360; else delete p.facing;
  return true;
}

/** 设/清第 i 行航点的存量（兵力/速度/士气/飞行高度；空或非法=删键回落到上一次声明或部队级基线）。
    ⚠ 与 st/facing 不同，存量缺省＝「没变」而非「回默认」——回溯语义在 core 的 unitStrengthAt 一族里，
    这里只管落键：兵力/速度须 >0，士气收 0–100、飞行高度 ≥0（0 都是有意义的值，不能当空处理）。 */
export function setUnitWaypointNum(w: World, id: string, i: number, key: TrackKey, raw: string): boolean {
  const p = trackRow(w, id, i);
  if (!p) return false;
  const v = parseFloat(raw);
  if (!isFinite(v)) { delete p[key]; return true; }
  if (key === "morale") p.morale = Math.min(100, Math.max(0, Math.round(v)));
  else if (key === "altM") { if (TRACK_OK.altM(v)) p.altM = v; else delete p.altM; }
  else if (v > 0) p[key] = key === "strength" ? Math.round(v) : v;
  else delete p[key];
  return true;
}

/* —— 视野/火力圈半径（拖动手柄调节）——半径按量级取整（≥100km 整数、≥10 一位小数、再小两位）。 */
const roundKm = (km: number): number => km >= 100 ? Math.round(km) : km >= 10 ? +km.toFixed(1) : +km.toFixed(2);

/** 设部队视野/火力半径（两者同机制）：拖到近零（<0.05km）=清除该圈 */
export function setUnitRing(w: World, id: string, key: "vision" | "range", km: number): boolean {
  const u = (w.units || []).find(x => x.id === id);
  if (!u || !isFinite(km)) return false;
  const v = roundKm(km);
  if (v >= 0.05) u[key] = v; else delete u[key];
  return true;
}

/** 设阵形/防区朝向（度，0＝正北顺时针）：写**所处航段起点**那一航点——`unitFacingAt` 读的正是它，
    于是拖一次只改当前这一段的朝向，后面几段各自保留。⚠ 整点展开（`{...旧点, facing}`）＝别的键不掉。 */
export function setUnitFacing(w: World, id: string, T: number, deg: number): boolean {
  const u = (w.units || []).find(x => x.id === id);
  if (!u || !isFinite(deg)) return false;
  const p = unitPos(u, T);
  if (!p) return false;
  const tr = u.track || [];
  tr[p.i] = { ...tr[p.i], facing: ((Math.round(deg) % 360) + 360) % 360 };
  return true;
}

/** 设地点视野半径（同部队视野：拖到近零＝清除该圈） */
export function setNodeVision(w: World, id: string, km: number): boolean {
  const n = w.nodes.find(x => x.id === id);
  if (!n || !isFinite(km)) return false;
  const v = roundKm(km);
  if (v >= 0.05) n.vision = v; else delete n.vision;
  return true;
}

/** 设地点第 i 个火力圈半径（钳制 ≥0.05km——误拖不删条目，删除走表单） */
export function setNodeRangeKm(w: World, id: string, i: number, km: number): boolean {
  const n = w.nodes.find(x => x.id === id);
  const r = n && n.ranges && n.ranges[i];
  if (!r || !isFinite(km)) return false;
  r.km = Math.max(0.05, roundKm(km));
  return true;
}

/** 地点火力圈的表单一行（受控输入的原文） */
export interface NodeRangeDraft { 名称: string; km: string; fire: "direct" | "arc"; arcDeg: string }
export function draftOfRange(r: NodeRange): NodeRangeDraft {
  return { 名称: r.名称 || "", km: +r.km > 0 ? String(r.km) : "", fire: r.fire === "direct" ? "direct" : "arc",
    arcDeg: +(r.arcDeg as number) > 0 && +(r.arcDeg as number) < 90 ? String(r.arcDeg) : "" };
}
/** 表单一行 → 火力圈：半径 >0 才成圈；两档都落键（同部队）；射角只收 (0,90)、直射不带 */
function rangeOfDraft(d: NodeRangeDraft): NodeRange | null {
  const km = parseFloat(d.km);
  if (!(km > 0)) return null;
  const name = d.名称.trim(), a = parseFloat(d.arcDeg);
  return { ...(name ? { 名称: name } : {}), km, fire: d.fire === "direct" ? "direct" : "arc",
    ...(d.fire !== "direct" && a > 0 && a < 90 ? { arcDeg: a } : {}) };
}

/* 表单数值键（部队与地点共用）：缺席＝不动；putPos 只收正数、putNonNeg 收 0（伏地/贴地合法），其余删键回落缺省 */
function putPos<K extends string>(o: { [P in K]?: number }, key: K, s: string | undefined): void {
  if (s === undefined) return;
  const x = parseFloat(s);
  if (x > 0) o[key] = x; else delete o[key];
}
function putNonNeg<K extends string>(o: { [P in K]?: number }, key: K, s: string | undefined): void {
  if (s === undefined) return;
  const x = parseFloat(s);
  if (isFinite(x) && x >= 0) o[key] = x; else delete o[key];
}

/** 部队表单一次提交（旧 uf_save 语义：名称空则保留、速度>0 才设否则删；火力/视野同机制：>0 才设否则删。
    提交火力时一并清掉旧多圈 ranges（归一为单值 range；旧档只读回退在渲染层）。 */
export interface UnitFormValues { 名称: string; faction: string; kind: string; arm?: string; strength: string; strengthUnit?: string; speed: string; morale?: string; note: string; range?: string; fire?: string; arcDeg?: string; vision?: string; eyeM?: string; radar?: string; radarM?: string; radarTgtM?: string; altM?: string; frontKm?: string; depthKm?: string }
export function applyUnitForm(u: Unit, v: UnitFormValues): void {
  if (v.名称) u.名称 = v.名称;
  u.faction = v.faction || null;
  u.kind = v.kind;
  /* 移动方式（旧称军种）：只对「可选」兵种收表单值（后勤/运输/侦察/特殊/指挥——编制上真有陆运水运空运之分）；
     其余兵种的移动方式由本体决定，一律**删键**回落兵种默认（unitArm 以 u.arm 优先）——
     否则换成步兵后留着个够不着又与兵种矛盾的水行，同 noFire 清 range 之规。 */
  const kindArm = ((tget(ALL_KINDS, u.kind) || {}).arm || "land") as Arm;
  if (armOptional(u.kind)) u.arm = (v.arm === "land" || v.arm === "water" || v.arm === "air") ? v.arm : kindArm;
  else delete u.arm;
  /* 兵力＝「人」数值单值：输入 × 单位倍率（人/千/万）后取整（人数无小数），>0 才存否则删键（同速度/火力之规） */
  const sv = parseFloat(v.strength) * Math.max(1, parseFloat(v.strengthUnit || "1") || 1);
  if (isFinite(sv) && sv > 0) u.strength = Math.round(sv); else delete u.strength;
  const spv = parseFloat(v.speed);
  if (spv > 0) u.speed = spv; else delete u.speed;
  /* 士气 0–100：0＝崩溃是有意义的值，故判据是 isFinite 而非 >0；空/非法＝删键（未记录） */
  if (v.morale !== undefined) {
    const mv = parseFloat(v.morale);
    if (isFinite(mv)) u.morale = Math.min(100, Math.max(0, Math.round(mv))); else delete u.morale;
  }
  /* 火力：无投射能力的兵种连表单行都不出，故提交即清键——否则换成步兵后留着个够不着又不生效的半径 */
  if ((tget(ALL_KINDS, u.kind) || {}).noFire) { delete u.range; delete u.ranges; delete u.fire; delete u.arcDeg; }
  else if (v.range !== undefined) {
    const rk = parseFloat(v.range);
    if (rk > 0) u.range = rk; else delete u.range;
    delete u.ranges;   // 表单保存即归一（旧多圈并入单值）
  }
  /* 视域各键：缺席＝不动。两档都落键（缺键＝按兵种缺省，现代装甲缺键是直射）；射角只收 (0,90)，档外删键回落 45°；
     观察高度 / 天线高度 / 目标高度 0 合法，空/非法＝删键回落缺省；雷达半径 >0 才设 */
  if (v.fire !== undefined) { if (v.fire === "direct") u.fire = "direct"; else if (v.fire === "arc") u.fire = "arc"; else delete u.fire; }
  if (v.arcDeg !== undefined) { const a = parseFloat(v.arcDeg); if (a > 0 && a < 90) u.arcDeg = a; else delete u.arcDeg; }
  putPos(u, "vision", v.vision); putNonNeg(u, "eyeM", v.eyeM);
  putPos(u, "radar", v.radar); putNonNeg(u, "radarM", v.radarM); putNonNeg(u, "radarTgtM", v.radarTgtM);
  putNonNeg(u, "altM", v.altM);   // 飞行高度基线（海拔 0 合法）
  /* 阵形足印（柱B）：>0 才存否则删键——无正面＝无足印＝标准框逐位不变 */
  if (v.frontKm !== undefined) { const fk = parseFloat(v.frontKm); if (fk > 0) u.frontKm = fk; else delete u.frontKm; }
  if (v.depthKm !== undefined) { const dk = parseFloat(v.depthKm); if (dk > 0) u.depthKm = dk; else delete u.depthKm; }
  u.note = v.note;
}

/** 改兵种（立即生效那一步；同步移动方式，对齐旧 uf_kind——不可选的兵种删键回落默认，同 applyUnitForm） */
export function changeUnitKind(u: Unit, kind: string): void {
  u.kind = kind;
  if (armOptional(kind)) u.arm = ((tget(ALL_KINDS, kind) || {}).arm || "land") as Arm;
  else delete u.arm;
}

/** 兵种默认速度（表单占位/展示用；unitKind 已导出于 core） */
export function unitKindDefaultSpeed(u: Unit): number { return (unitKind(u) || UNIT_KINDS.linf).v; }

/* —— 相位（战术图分帧命名时刻;meta.phases 纯书签,时间为基底）—— */

/** 记 T 时刻为相位（默认名「相位 N」,检查器/览面改名）；同刻已有（1e-9）不改档返回 null */
export function addPhaseAt(w: World, T: number): Phase | null {
  const m = w.meta || (w.meta = {});
  const list = Array.isArray(m.phases) ? m.phases : (m.phases = []);
  if (list.some(p => p && isFinite(+p.t) && Math.abs(+p.t - T) < 1e-9)) return null;
  const p: Phase = { t: +T, 名称: `相位 ${list.length + 1}` };
  const tOf = (q: Phase | null) => (q && +q.t) || 0;   // 成员可为 null（手编档）；新表排好再赋值＝中途抛错不留半截
  m.phases = [...list, p].sort((a, b) => tOf(a) - tOf(b));
  return p;
}

/** 删指定时刻的相位；无匹配=false（一字不改）。删空后整键不落盘（同 heightOverrides 之例） */
export function removePhaseAt(w: World, t: number): boolean {
  const list = (w.meta || {}).phases;
  if (!Array.isArray(list)) return false;
  const i = list.findIndex(p => p && Math.abs(+p.t - t) < 1e-9);
  if (i < 0) return false;
  list.splice(i, 1);
  if (!list.length) delete w.meta.phases;
  return true;
}

/** 改相位名；空名=回落无名（删 名称 键,显示端给缺省） */
export function renamePhase(w: World, t: number, name: string): boolean {
  const list = (w.meta || {}).phases;
  const p = Array.isArray(list) ? list.find(q => q && Math.abs(+q.t - t) < 1e-9) : null;
  if (!p) return false;
  const nm = String(name || "").trim();
  if (nm) p.名称 = nm; else delete p.名称;
  return true;
}
