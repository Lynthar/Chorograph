/* 视域编排：为当刻在场、带视野圈或直射火力圈的部队，在**落定的**规则场（ui/state.ruleFieldSig）上算
   视线掩膜，结果进 visMaskSig（部队 id → 圈 → 掩膜；无掩膜的圈画整圆）。形制照抄腿账（orchestrate）：
   防抖归并 + 单飞行 + dirty 补发 + seq 令牌丢过期结果。规则场演算中（sig 为 null）不发单、沿用上一份，
   落定换引用即重算；规则场只在换引用时推送 Worker 一次（拖部队的连发不再逐单克隆整幅场）。 */
import { effect } from "@preact/signals-core";
import { kmPerDeg, kmPerDegXY } from "../core/geo.ts";
import { elevUnitM, waterSurface, type ElevField } from "../core/elev.ts";
import { isModern, unitArcDeg, unitArm, unitEyeM, unitFireDirect, unitFireKm, unitPos, unitRadarKm, unitRadarM, unitRadarTgtM, unitVantageM } from "../core/units.ts";
import { REFRACT_OPTICAL, REFRACT_RADAR, TARGET_M, type UnitMasks, type ViewField } from "../core/viewshed.ts";
import { VANTAGE_GAIN_M } from "../core/constants.ts";
import { layerOn } from "../render/overlay.ts";
import { worldSig, yearSig, editVerSig, layersSig, isTacSig, ruleFieldSig, visMaskSig } from "../ui/state.ts";
import type { VisReq } from "../worker/routeProto.ts";
import type { Grid } from "../core/grid.ts";
import type { Meta, World } from "../core/types.ts";
import type { ShellCtx } from "./ctx.ts";

const VIS_MS = 80;

/** 当刻要判的圈：视野圈按视线、火力圈直射按视线 / 曲射按射角弹道、雷达（现代图）按雷达折射与假定目标高度；
    层关的圈不算；飞行部队不判（高度语义另立）。各圈按自己的半径与眼位成单，互不裁切——看得见不等于打得到。
    视线类圈（视野 / 直射 / 雷达）的眼位可在驻地内挑最高处（unitVantageM），曲射从炮位打。 */
export function visObservers(w: World, T: number, layers: Record<string, boolean>, meta: Meta): VisReq[] {
  const vision = layerOn(layers, meta, "vision"), fire = layerOn(layers, meta, "ranges");
  const radar = layerOn(layers, meta, "radar") && isModern(meta);
  const out: VisReq[] = [];
  for (const u of w.units || []) {
    if (unitArm(u) === "air") continue;
    const vk = +(u.vision as number) || 0, fk = unitFireKm(u), rk = unitRadarKm(u);
    const wantV = vision && vk > 0, wantF = fire && fk > 0, wantR = radar && rk > 0;
    if (!wantV && !wantF && !wantR) continue;
    const p = unitPos(u, T);
    if (!p) continue;
    const at = { lon: p.lon, lat: p.lat, eyeM: unitEyeM(u) }, vantageM = unitVantageM(u), gainM = VANTAGE_GAIN_M;
    if (wantV) out.push({ ...at, id: u.id, ring: "vision", km: vk, tgtM: TARGET_M, refract: REFRACT_OPTICAL, vantageM, gainM });
    if (wantF) out.push(unitFireDirect(u)
      ? { ...at, id: u.id, ring: "fire", km: fk, tgtM: TARGET_M, refract: REFRACT_OPTICAL, vantageM, gainM }
      : { ...at, id: u.id, ring: "fire", km: fk, tgtM: 0, refract: REFRACT_OPTICAL, arcDeg: unitArcDeg(u) });
    if (wantR) out.push({ lon: p.lon, lat: p.lat, id: u.id, ring: "radar", km: rk, eyeM: unitRadarM(u), tgtM: unitRadarTgtM(u), refract: REFRACT_RADAR, vantageM, gainM });
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
  let seq = 0, busy = false, dirty = false, pushed: ElevField | null = null;
  const fire = (): void => {
    const w = worldSig.peek(), f = ruleFieldSig.peek(), meta = w ? w.meta || {} : null;
    if (!w || !meta || !f || !ctx.grid || !isTacSig.peek()) return;
    const obs = visObservers(w, yearSig.peek(), layersSig.peek(), meta);
    if (!obs.length) return;                                // effect 已同步清过 sig
    if (busy) { dirty = true; return; }
    busy = true;
    const my = ++seq;
    if (pushed !== f) { ctx.routeClient.setViewField(viewFieldOf(meta, f, ctx.grid)); pushed = f; }
    const again = (): void => { if (dirty) { dirty = false; fire(); } };
    ctx.routeClient.viewshed(obs).then(res => {
      busy = false;
      if (res && seq === my) {
        const m = new Map<string, UnitMasks>();
        for (const r of res) {
          if (!r.mask) continue;
          const e = m.get(r.id) || {};
          e[r.ring] = r.mask;
          m.set(r.id, e);
        }
        visMaskSig.value = m;
      }
      again();
    }, e => {                                               // 拒绝也要放闸并补发（同腿账之规）
      busy = false;
      console.warn("视域计算失败（保持上一份）：", e);
      again();
    });
  };
  const dispose = effect(() => {
    const w = worldSig.value, T = yearSig.value, L = layersSig.value, tac = isTacSig.value, f = ruleFieldSig.value;
    editVerSig.value;                                       // 依赖：拖部队/改半径/改高度（经防抖归并）
    clearTimeout(timer);
    const want = !!w && tac && visObservers(w, T, L, w.meta || {}).length > 0;
    if (!want) {
      seq++; dirty = false;                                 // 令牌作废＝换图/清圈后到货的旧结果不落 sig
      if (visMaskSig.peek().size) visMaskSig.value = new Map();
      return;
    }
    if (!f) return;                                         // 规则场演算中：沿用上一份，落定换引用后再跑
    timer = setTimeout(fire, VIS_MS);
  });
  return () => { clearTimeout(timer); seq++; dispose(); };
}
