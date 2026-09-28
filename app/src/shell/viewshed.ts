/* 视域编排：为当刻在场、带视野 / 火力 / 雷达圈的部队与地点，在**落定的**规则场（ui/state.ruleFieldSig）上算
   视线掩膜，结果进 visMaskSig（部队 / 地点 id → 圈 → 掩膜；无掩膜的圈画整圆）；飞行部队被他派的视野圈与雷达
   看见与否另算点对点视线，进 detectSig。并发形制：防抖归并 + 单飞行闸
   （shell/singleflight，与腿账同一份）+ seq 令牌丢过期结果。规则场演算中（sig 为 null）不发单、沿用上一份，
   落定换引用即重算；规则场只在换引用时推送 Worker 一次（拖部队的连发不再逐单克隆整幅场）。 */
import { effect } from "@preact/signals-core";
import { kmPerDeg, kmPerDegXY } from "../core/geo.ts";
import { elevUnitM, waterSurface, type ElevField } from "../core/elev.ts";
import { isModern, arcDegOf, nodeEyeM, nodeVisionKm, rangeDirect, unitAltAt, unitArm, unitEyeM, unitFireDirect, unitFireKm, unitPos, radarKmOf, radarMOf, radarTgtMOf, unitVantageM } from "../core/units.ts";
import { activeAt, ownerAt } from "../core/time.ts";
import { REFRACT_OPTICAL, REFRACT_RADAR, TARGET_M, noMasks, type ViewField } from "../core/viewshed.ts";
import { VANTAGE_GAIN_M, VANTAGE_M } from "../core/constants.ts";
import { layerOn } from "../render/overlay.ts";
import { worldSig, yearSig, editVerSig, layersSig, isTacSig, ruleFieldSig, visMaskSig, detectSig } from "../ui/state.ts";
import { singleFlight } from "./singleflight.ts";
import type { SightReq, SightRes, VisReq, VisTag } from "../worker/routeProto.ts";
import type { Grid } from "../core/grid.ts";
import type { Meta, World } from "../core/types.ts";
import type { ShellCtx } from "./ctx.ts";

const VIS_MS = 80;

/** 观察点的共同参数 → 各圈的单。视线类圈（视野 / 直射 / 雷达）的眼位可在驻地内挑最高处，曲射从炮位打；
    飞行部队眼位＝飞行高度（eyeAbsM），不挑驻地 */
interface Site { lon: number; lat: number; eyeM: number; vantageM: number; eyeAbsM?: number }
const visionReq = (s: Site, tag: VisTag, km: number): VisReq =>
  ({ ...tag, lon: s.lon, lat: s.lat, eyeM: s.eyeM, eyeAbsM: s.eyeAbsM, km, tgtM: TARGET_M, refract: REFRACT_OPTICAL, vantageM: s.vantageM, gainM: VANTAGE_GAIN_M });
const fireReq = (s: Site, tag: VisTag, km: number, direct: boolean, arcDeg: number): VisReq => direct
  ? visionReq(s, tag, km)
  : { ...tag, lon: s.lon, lat: s.lat, eyeM: s.eyeM, km, tgtM: 0, refract: REFRACT_OPTICAL, arcDeg };
const radarReq = (s: Site, tag: VisTag, x: { radar?: unknown; radarM?: unknown; radarTgtM?: unknown }): VisReq =>
  ({ ...tag, lon: s.lon, lat: s.lat, km: radarKmOf(x), eyeM: radarMOf(x), eyeAbsM: s.eyeAbsM, tgtM: radarTgtMOf(x), refract: REFRACT_RADAR, vantageM: s.vantageM, gainM: VANTAGE_GAIN_M });

/** 当刻要判的圈：视野圈按视线、火力圈直射按视线 / 曲射按射角弹道、雷达（现代图）按雷达折射与假定目标高度；
    层关的圈不算；飞行部队按当刻飞行高度判、没填高度不判（火力恒直射）。各圈按自己的半径与眼位成单，互不裁切——看得见不等于打得到。
    部队的驻地按阵形足印（unitVantageM），地点恒 VANTAGE_M；地点火力多圈各成一单。 */
export function visObservers(w: World, T: number, layers: Record<string, boolean>, meta: Meta): VisReq[] {
  const vision = layerOn(layers, meta, "vision"), fire = layerOn(layers, meta, "ranges");
  const radar = layerOn(layers, meta, "radar") && isModern(meta);
  const out: VisReq[] = [];
  for (const u of w.units || []) {
    const vk = +(u.vision as number) || 0, fk = unitFireKm(u);
    const wantV = vision && vk > 0, wantF = fire && fk > 0, wantR = radar && radarKmOf(u) > 0;
    if (!wantV && !wantF && !wantR) continue;
    const p = unitPos(u, T), alt = unitArm(u) === "air" ? unitAltAt(u, T) : null;
    if (!p || (unitArm(u) === "air" && alt == null)) continue;
    const s: Site = alt != null ? { lon: p.lon, lat: p.lat, eyeM: 0, vantageM: 0, eyeAbsM: alt }
      : { lon: p.lon, lat: p.lat, eyeM: unitEyeM(u), vantageM: unitVantageM(u) };
    const tag = (ring: VisTag["ring"]): VisTag => ({ owner: "unit", id: u.id, ring, idx: 0 });
    if (wantV) out.push(visionReq(s, tag("vision"), vk));
    if (wantF) out.push(fireReq(s, tag("fire"), fk, unitFireDirect(u), arcDegOf(u)));
    if (wantR) out.push(radarReq(s, tag("radar"), u));
  }
  for (const n of w.nodes || []) {
    if (!activeAt(n, T)) continue;
    const s: Site = { lon: n.lon, lat: n.lat, eyeM: nodeEyeM(n), vantageM: VANTAGE_M };
    const tag = (ring: VisTag["ring"], idx = 0): VisTag => ({ owner: "node", id: n.id, ring, idx });
    if (vision && nodeVisionKm(n) > 0) out.push(visionReq(s, tag("vision"), nodeVisionKm(n)));
    if (fire) (n.ranges || []).forEach((r, i) => {
      const km = +r.km || 0;
      if (km > 0) out.push(fireReq(s, tag("fire", i), km, rangeDirect(r), arcDegOf(r)));
    });
    if (radar && radarKmOf(n) > 0) out.push(radarReq(s, tag("radar"), n));
  }
  return out;
}

/** 飞行目标 × 他派的视野圈与雷达（成单同 visObservers，层关的圈不算）：派系不同才算，无所属与无所属算同派 */
export function sightReqs(w: World, T: number, obs: VisReq[]): SightReq[] {
  const tgts: { id: string; fac: string | null; lon: number; lat: number; altM: number }[] = [];
  for (const u of w.units || []) {
    if (unitArm(u) !== "air") continue;
    const p = unitPos(u, T), altM = unitAltAt(u, T);
    if (p && altM != null) tgts.push({ id: u.id, fac: u.faction || null, lon: p.lon, lat: p.lat, altM });
  }
  if (!tgts.length) return [];
  const unitFac = new Map<string, string | null>(), nodeFac = new Map<string, string | null>();
  for (const u of w.units || []) if (!unitFac.has(u.id)) unitFac.set(u.id, u.faction || null);
  for (const n of w.nodes || []) if (!nodeFac.has(n.id)) nodeFac.set(n.id, ownerAt(n, T) || null);
  const out: SightReq[] = [];
  for (const o of obs) {
    if (o.ring === "fire") continue;
    const fac = (o.owner === "unit" ? unitFac : nodeFac).get(o.id) ?? null;
    for (const t of tgts) if (t.fac !== fac) out.push({ obs: o, tgt: t.id, lon: t.lon, lat: t.lat, altM: t.altM });
  }
  return out;
}

/** 规则场 + 粗格水面 + 物理标定 → 视线场。曲率半径按每度里程反推（战术图是切平面投影，圆周＝360×km/度） */
export function viewFieldOf(meta: Meta, f: ElevField, grid: Grid): ViewField {
  const { kmx, kmy } = kmPerDegXY(meta, f.bb);
  return {
    bb: f.bb, step: f.step, cols: f.cols, rows: f.rows, data: f.data,
    wsurf: waterSurface(meta, grid), gstep: grid.step, gcols: grid.cols, grows: grid.rows,
    unitM: elevUnitM(meta), kmx, kmy, curvKm: kmPerDeg(meta) * 180 / Math.PI
  };
}

export function wireViewshed(ctx: ShellCtx): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0, pushed: ElevField | null = null;
  const flight = singleFlight((meta: Meta, f: ElevField, grid: Grid, obs: VisReq[], sights: SightReq[]) => {
    const my = ++seq;
    if (pushed !== f) { ctx.routeClient.setViewField(viewFieldOf(meta, f, grid)); pushed = f; }
    const sp: Promise<SightRes[] | null> = sights.length ? ctx.routeClient.sight(sights) : Promise.resolve([]);
    return Promise.all([ctx.routeClient.viewshed(obs), sp]).then(([res, sres]) => {
      if (seq !== my) return;
      if (res) {
        const m = noMasks();
        for (const r of res) {
          if (!r.mask) continue;
          const tab = m[r.owner], e = tab.get(r.id) || {};
          if (r.ring === "fire") (e.fire || (e.fire = []))[r.idx] = r.mask;
          else e[r.ring] = r.mask;
          tab.set(r.id, e);
        }
        visMaskSig.value = m;
      }
      if (sres) {
        const d = new Map<string, SightRes[]>();
        for (const r of sres) if (r.hit) (d.get(r.tgt) || d.set(r.tgt, []).get(r.tgt)!).push(r);
        if (d.size || detectSig.peek().size) detectSig.value = d;   // 空换空不广播：否则每轮视域都白重画一帧
      }
    }, e => console.warn("视域计算失败（保持上一份）：", e));   // 拒绝也要落定——闸自会放闸并补发
  }, () => fire());
  function fire(): void {
    const w = worldSig.peek(), f = ruleFieldSig.peek(), meta = w ? w.meta || {} : null;
    if (!w || !meta || !f || !ctx.grid || !isTacSig.peek()) return;
    const obs = visObservers(w, yearSig.peek(), layersSig.peek(), meta);
    if (obs.length) flight.fire(meta, f, ctx.grid, obs, sightReqs(w, yearSig.peek(), obs));   // effect 已同步清过 sig
  }
  const dispose = effect(() => {
    const w = worldSig.value, T = yearSig.value, L = layersSig.value, tac = isTacSig.value, f = ruleFieldSig.value;
    editVerSig.value;                                       // 依赖：拖部队/改半径/改高度（经防抖归并）
    clearTimeout(timer);
    const want = !!w && tac && visObservers(w, T, L, w.meta || {}).length > 0;
    if (!want) {
      seq++; flight.clearDirty();                           // 令牌作废＝换图/清圈后到货的旧结果不落 sig，也不为它补发
      const cur = visMaskSig.peek();
      if (cur.unit.size || cur.node.size) visMaskSig.value = noMasks();
      if (detectSig.peek().size) detectSig.value = new Map();
      return;
    }
    if (!f) return;                                         // 规则场演算中：沿用上一份，落定换引用后再跑
    timer = setTimeout(fire, VIS_MS);
  });
  return () => { clearTimeout(timer); seq++; dispose(); };
}
