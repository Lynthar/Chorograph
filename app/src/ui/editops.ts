/* 编辑操作内核（纯函数，node:test 可测）：对世界对象的具体改动。
   语义对齐旧实现：删地点连带清理其连线与派系 territory 引用；新对象 id 用时间戳 base36；
   数据经度一律折回本初域（平面世界不折）。撤销/广播由调用方经 state.mutateWorld 走管线。 */
import { wrapLon } from "../core/geo.ts";
import { parseKV } from "../core/util.ts";
import { activeAt } from "../core/time.ts";
import { setUnitPoint, unitKind } from "../core/units.ts";
import { CERTAINTY, UNIT_KINDS, armOptional, canonComposite, parseComposite } from "../core/constants.ts";
import type { Grid } from "../core/grid.ts";
import type { Arm, Asset, Certainty, Decor, Edge, Faction, HeightOverride, Meta, Op, Owner, Phase, TerrainId, TerrainOverride, Unit, World, WorldNode } from "../core/types.ts";

export const newNodeId = (): string => "n" + Date.now().toString(36);
export const newEventId = (): string => "ev" + Date.now().toString(36);

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

/** 新建地点（旧 addNodeAt：缺省 city 起步；柱B 起「地点」子工具类型 chips 可预选 type,类型仍可在表单里改） */
export function addNode(w: World, 名称: string, lon: number, lat: number, type = "city", id = newNodeId()): WorldNode {
  const n: WorldNode = { id, 名称, lon: +dataLon(w.meta, lon).toFixed(3), lat: +lat.toFixed(3),
    type, faction: null, 字段: {}, note: "", link: 名称 };
  w.nodes.push(n);
  return n;
}

/** 新建标注（v0.15 净新）：自由文本注记——名称即图面文本，字号/屏幕角/派系色在表单里改 */
export function addLabel(w: World, 文本: string, lon: number, lat: number, id = newNodeId()): WorldNode {
  const n: WorldNode = { id, 名称: 文本, lon: +dataLon(w.meta, lon).toFixed(3), lat: +lat.toFixed(3),
    type: "label", faction: null };
  w.nodes.push(n);
  return n;
}

/** 在某地点旁新建事件点（旧 addEventAt：偏移 +0.4/+0.3，默认战役、年份=当前年） */
export function addEventNear(w: World, at: WorldNode, 名称: string, yearNow: number, id = newEventId()): WorldNode {
  const nd: WorldNode = { id, 名称,
    lon: +dataLon(w.meta, at.lon + 0.4).toFixed(3), lat: +(at.lat + 0.3).toFixed(3),
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
  w.edges.splice(idx, 1);
  return true;
}

/** 新增一条自由画线（pts 折线、无端点）：河流或工事（柱B），返回新边（改线＝删了重画，同作战线） */
export function addFreeEdge(w: World, pts: [number, number][], type: "river" | "wall"): Edge {
  const e: Edge = { type, pts };
  w.edges.push(e);
  return e;
}
/** 新增一条自由画河道：addFreeEdge 的河流便捷形（旧名保留） */
export function addRiver(w: World, pts: [number, number][]): Edge { return addFreeEdge(w, pts, "river"); }

/** 移动地点（拖动/微调共用）：经度折回、纬度钳 ±85、四位小数（对齐旧 nudgeSel） */
export function moveNode(w: World, id: string, lon: number, lat: number): void {
  const n = w.nodes.find(x => x.id === id);
  if (!n) return;
  n.lon = +dataLon(w.meta, lon).toFixed(4);
  n.lat = +Math.max(-85, Math.min(85, lat)).toFixed(4);
}

/** 地点表单一次提交（旧 ef_save 语义：空值删键、字段 KV 过滤空值行） */
export interface NodeFormValues {
  名称: string; note: string; link: string;
  faction?: string;            // ""=中立；undefined=事件点（无此字段）
  radiusKm?: string; since?: string; until?: string;
  kv: string;
  ranges?: string;             // 战术图据点防御火力（每行「名称：公里数」；undefined=无此栏）
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
  if (v.ranges !== undefined) { const rng = parseRanges(v.ranges); if (rng.length) n.ranges = rng; else delete n.ranges; }
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
export interface EdgeFormValues { 名称: string; note: string; kv: string; since: string; until: string; widthM?: string; reverse?: boolean; certainty?: string }
export function applyEdgeForm(e: Edge, v: EdgeFormValues): void {
  const nm = v.名称.trim(); if (nm) e.名称 = nm; else delete e.名称;
  const nt = v.note.trim(); if (nt) e.note = nt; else delete e.note;
  const kv = parseKV(v.kv);
  if (Object.keys(kv).length) e.字段 = kv; else delete e.字段;
  const s = parseFloat(v.since); if (isFinite(s)) e.since = s; else delete e.since;
  const u = parseFloat(v.until); if (isFinite(u)) e.until = u; else delete e.until;
  if (v.widthM !== undefined) { const w = parseFloat(v.widthM); if (w > 0) e.widthM = w; else delete e.widthM; }
  if (v.reverse !== undefined) { if (v.reverse) e.reverse = true; else delete e.reverse; }
  if (v.certainty !== undefined) setCertainty(e, v.certainty);
}

/** 可靠性写入（地点/连线共用，柱B）：确证＝删键不落盘（旧档零迁移）；未知档位按确证处理 */
export function setCertainty(o: { certainty?: Certainty }, v: string): void {
  if (v && v in CERTAINTY) o.certainty = v as Certainty; else delete o.certainty;
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
export function paintTerrainAt(w: World, grid: Grid, yearNow: number, lon: number, lat: number,
  t: string, size: number, erase: boolean, era?: EraNew | null,
  axis: "both" | "lf" | "eco" = "both"): boolean {   // t=复合串（两轴）；axis=单轴笔刷时只并入该轴、另一轴留旧格值
  const { bb, step, cells } = grid;
  const tac = ((w.meta || {}) as { mapKind?: string }).mapKind === "tactical";   // 旧 isTac() 语义
  const c0 = Math.floor((lon - bb.lonMin) / step), r0 = Math.floor((lat - bb.latMin) / step);
  const R = size - 1, prec = step >= 0.05 ? 2 : 4, tol = step * 0.4;
  const [brLf, brEco] = parseComposite(t);   // 笔刷复合的两轴分量（单轴模式各取其一并入现格）
  let ovs = w.terrainOverrides || [];
  let changed = false;
  for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
    if (dr * dr + dc * dc > R * R + 0.5) continue;
    const r = r0 + dr, c = c0 + dc;
    if (!(cells[r] && cells[r][c] !== undefined)) continue;   // 越界跳过
    const clon = bb.lonMin + (c + 0.5) * step, clat = bb.latMin + (r + 0.5) * step;
    const n = ovs.length;
    ovs = ovs.filter(o => !(Math.abs(o.lon - clon) < tol && Math.abs(o.lat - clat) < tol
      && (+(o.step as number) || step) <= step * 1.001 && activeAt(o, yearNow)));
    if (ovs.length !== n) changed = true;
    if (!erase) {
      // 单轴笔刷：并入现格值的对应轴（地貌笔改地貌留生态、生态笔改生态留地貌）——现格=cells 已含旧涂改+初稿
      let cellT = t;
      if (axis !== "both") {
        const [cLf, cEco] = parseComposite(cells[r][c]);
        cellT = axis === "lf" ? canonComposite(brLf + (cEco === "none" ? "" : "/" + cEco))
                              : canonComposite(cLf + (brEco === "none" ? "" : "/" + brEco));
      }
      const ov: TerrainOverride = { lon: +clon.toFixed(prec), lat: +clat.toFixed(prec), t: cellT };
      if (tac) ov.step = +step.toFixed(4);   // 战术细格涂改记录自身块尺寸（与继承的 1° 粗块区分）——对齐旧 paintAt（index.html:2739），存档格式兼容硬约束
      ovs.push(applyEra(ov, era)); changed = true;
    }
  }
  w.terrainOverrides = ovs;
  return changed;
}

/* —— 高程涂改（heightOverrides[]；渲染层专用，不动地形类型/寻路）——
   圆盘笔刷逐格**加性**叠加 dh（抬升正/下切负）；同格、同粒度、同时段的图章合并累加，
   累加到 ≈0 自动清除（涂上去再涂回来=无痕）。几何与 paintTerrainAt 同（半径 size-1 格）。 */
export function paintHeightAt(w: World, grid: Grid, lon: number, lat: number,
  dh: number, size: number, era?: EraNew | null): boolean {
  const { bb, step, cells } = grid;
  const tac = ((w.meta || {}) as { mapKind?: string }).mapKind === "tactical";   // 同 paintTerrainAt：战术涂改记录块尺寸
  const c0 = Math.floor((lon - bb.lonMin) / step), r0 = Math.floor((lat - bb.latMin) / step);
  const R = size - 1, prec = step >= 0.05 ? 2 : 4, tol = step * 0.4;
  const ovs = w.heightOverrides || (w.heightOverrides = []);
  const es = era && era.on && era.since != null && isFinite(era.since) ? era.since : null;
  const eu = era && era.on && era.until != null && isFinite(era.until) ? era.until : null;
  const dead = new Set<HeightOverride>();
  let changed = false;
  for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
    if (dr * dr + dc * dc > R * R + 0.5) continue;
    const r = r0 + dr, c = c0 + dc;
    if (!(cells[r] && cells[r][c] !== undefined)) continue;
    const clon = +(bb.lonMin + (c + 0.5) * step).toFixed(prec), clat = +(bb.latMin + (r + 0.5) * step).toFixed(prec);
    const ex = ovs.find(o => !dead.has(o) && Math.abs(o.lon - clon) < tol && Math.abs(o.lat - clat) < tol
      && (+(o.step as number) || step) <= step * 1.001 && (o.since ?? null) === es && (o.until ?? null) === eu);
    if (ex) {
      ex.dh = +(ex.dh + dh).toFixed(4);
      if (Math.abs(ex.dh) < 1e-4) dead.add(ex);
    } else {
      const ov: HeightOverride = { lon: clon, lat: clat, dh: +dh.toFixed(4) };
      if (tac) ov.step = +step.toFixed(4);
      ovs.push(applyEra(ov, era));
    }
    changed = true;
  }
  if (dead.size) w.heightOverrides = ovs.filter(o => !dead.has(o));
  return changed;
}

/* —— 手绘布景（decor[]；对齐旧 placeDecor/decorEraseAt）—— */
/** 落一枚布景印章（经度折回、三位小数；id 同旧 d+base36+序号%97） */
export function addDecor(w: World, lon: number, lat: number, kind: string, size: number): Decor {
  const d: Decor = { id: "d" + Date.now().toString(36) + ((w.decor || []).length % 97),
    lon: +dataLon(w.meta, lon).toFixed(3), lat: +lat.toFixed(3), kind, size };
  (w.decor || (w.decor = [])).push(d);
  return d;
}
/** 移一枚布景到新经纬（经度折回、三位小数；单枚拖移与框选整组拖移共用） */
export function moveDecor(w: World, id: string, lon: number, lat: number): void {
  const d = (w.decor || []).find(x => x.id === id);
  if (!d) return;
  d.lon = +dataLon(w.meta, lon).toFixed(3);
  d.lat = +lat.toFixed(3);
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
  const f: Faction = { id: "f" + Date.now().toString(36), 名称: "新派系", color: FAC_PALETTE[w.factions.length % FAC_PALETTE.length] };
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
export const newUnitId = (): string => "u" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);

/** 新建未入场部队（track 空＝不在图上）：军面板「＋ 新增部队」用——先入列表改名设属性，再从列表拖入地图落首航点 */
export function addUnitUnplaced(w: World, 名称: string, id = newUnitId()): Unit {
  const u: Unit = { id, 名称, faction: null, kind: "linf", arm: "land", track: [] };
  (w.units || (w.units = [])).push(u);
  return u;
}

/** 新建部队：默认步兵、track 首航点=当日 T（对齐旧 addUnitAt；名称由外壳 prompt 后传入） */
export function addUnit(w: World, 名称: string, lon: number, lat: number, T: number, id = newUnitId()): Unit {
  const u: Unit = { id, 名称, faction: null, kind: "linf", arm: "land",
    track: [{ t: +T, lon: +(+lon).toFixed(4), lat: +(+lat).toFixed(4) }] };
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
  setUnitPoint(u, T, lon, lat);
  return true;
}

/** 删某航点（对齐旧 data-tdel） */
export function deleteUnitWaypoint(w: World, id: string, i: number): boolean {
  const u = (w.units || []).find(x => x.id === id);
  if (!u || !u.track || !(i >= 0 && i < u.track.length)) return false;
  u.track.splice(i, 1);
  return true;
}

/** 设/清某日航点的状态（st：UNIT_STATUS 键；空=常态删键）——自该航点起生效到下一航点 */
export function setUnitWaypointStatus(w: World, id: string, t: number, st: string): boolean {
  const u = (w.units || []).find(x => x.id === id);
  const p = u && (u.track || []).find(q => q.t === +t);
  if (!p) return false;
  if (st) p.st = st; else delete p.st;
  return true;
}

/** 设/清某日航点的朝向（度；空/非法=删键回落行进方向）——自该航点起生效到下一航点，同 st 之规 */
export function setUnitWaypointFacing(w: World, id: string, t: number, deg: string): boolean {
  const u = (w.units || []).find(x => x.id === id);
  const p = u && (u.track || []).find(q => q.t === +t);
  if (!p) return false;
  const v = parseFloat(deg);
  if (isFinite(v)) p.facing = ((v % 360) + 360) % 360; else delete p.facing;
  return true;
}

/** 设/清某日航点的存量（兵力/速度/士气；空或非法=删键回落到上一次声明或部队级基线）。
    ⚠ 与 st/facing 不同，这三样缺省＝「没变」而非「回默认」——回溯语义在 core 的 unitStrengthAt 一族里，
    这里只管落键：兵力/速度须 >0，士气收 0–100（0＝崩溃是有意义的值，不能当空处理）。 */
export function setUnitWaypointNum(w: World, id: string, t: number, key: "strength" | "speed" | "morale", raw: string): boolean {
  const u = (w.units || []).find(x => x.id === id);
  const p = u && (u.track || []).find(q => q.t === +t);
  if (!p) return false;
  const v = parseFloat(raw);
  if (!isFinite(v)) { delete p[key]; return true; }
  if (key === "morale") p.morale = Math.min(100, Math.max(0, Math.round(v)));
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

/** 设据点第 i 个防御火力圈半径（钳制 ≥0.05km——误拖不删条目，删除走表单文本） */
export function setNodeRangeKm(w: World, id: string, i: number, km: number): boolean {
  const n = w.nodes.find(x => x.id === id);
  const r = n && n.ranges && n.ranges[i];
  if (!r || !isFinite(km)) return false;
  r.km = Math.max(0.05, roundKm(km));
  return true;
}

/** 射程文本 ↔ 数据：「名称：公里数」每行一条（对齐旧 parseRanges/uf_rng） */
export function parseRanges(text: string): { 名称: string; km: number }[] {
  const out: { 名称: string; km: number }[] = [];
  (text || "").split(/\n/).forEach(line => {
    const m = line.match(/^\s*([^:：]+)[:：]\s*([\d.]+)\s*$/);
    if (m && +m[2] > 0) out.push({ 名称: m[1].trim(), km: +m[2] });
  });
  return out;
}
export function formatRanges(ranges: { 名称?: string; km: number }[] | undefined): string {
  return (ranges || []).map(r => `${r.名称 || "射程"}：${r.km}`).join("\n");
}

/** 部队表单一次提交（旧 uf_save 语义：名称空则保留、速度>0 才设否则删；火力/视野同机制：>0 才设否则删。
    提交火力时一并清掉旧多圈 ranges（归一为单值 range；旧档只读回退在渲染层）。 */
export interface UnitFormValues { 名称: string; faction: string; kind: string; arm?: string; strength: string; strengthUnit?: string; speed: string; morale?: string; note: string; range?: string; vision?: string; frontKm?: string; depthKm?: string }
export function applyUnitForm(u: Unit, v: UnitFormValues): void {
  if (v.名称) u.名称 = v.名称;
  u.faction = v.faction || null;
  u.kind = v.kind;
  /* 移动方式（旧称军种）：只对「可选」兵种收表单值（后勤/运输/侦察/特殊/指挥——编制上真有陆运水运空运之分）；
     其余兵种的移动方式由本体决定，一律**删键**回落兵种默认（unitArm 以 u.arm 优先）——
     否则换成步兵后留着个够不着又与兵种矛盾的水行，同 noFire 清 range 之规。 */
  const kindArm = ((UNIT_KINDS[u.kind] || {}).arm || "land") as Arm;
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
  if ((UNIT_KINDS[u.kind] || {}).noFire) { delete u.range; delete u.ranges; }
  else if (v.range !== undefined) {
    const rk = parseFloat(v.range);
    if (rk > 0) u.range = rk; else delete u.range;
    delete u.ranges;   // 表单保存即归一（旧多圈并入单值）
  }
  if (v.vision !== undefined) { const vk = parseFloat(v.vision); if (vk > 0) u.vision = vk; else delete u.vision; }
  /* 阵形足印（柱B）：>0 才存否则删键——无正面＝无足印＝标准框逐位不变 */
  if (v.frontKm !== undefined) { const fk = parseFloat(v.frontKm); if (fk > 0) u.frontKm = fk; else delete u.frontKm; }
  if (v.depthKm !== undefined) { const dk = parseFloat(v.depthKm); if (dk > 0) u.depthKm = dk; else delete u.depthKm; }
  u.note = v.note;
}

/** 改兵种（立即生效那一步；同步移动方式，对齐旧 uf_kind——不可选的兵种删键回落默认，同 applyUnitForm） */
export function changeUnitKind(u: Unit, kind: string): void {
  u.kind = kind;
  if (armOptional(kind)) u.arm = ((UNIT_KINDS[kind] || {}).arm || "land") as Arm;
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
  list.push(p);
  list.sort((a, b) => (+a.t || 0) - (+b.t || 0));
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
