/* 标高点编排：标高点层开着时，落定的规则场（ui/state.ruleFieldSig）一换引用，就把它交 Worker 算全场峰表，结果进 spotTableSig。
   峰表要对整场排序（百万格约 0.1 s），在帧里同步算＝每次落定一个长任务；演算中与在飞期间沿用上一份。
   并发形制同视域：单飞行闸 + seq 令牌，换图与撤销重做（换 meta 对象）作废在飞的单。 */
import { effect } from "@preact/signals-core";
import { layerOn } from "../render/overlay.ts";
import { worldSig, layersSig, ruleFieldSig, spotTableSig } from "../ui/state.ts";
import { singleFlight } from "./singleflight.ts";
import { viewFieldOf } from "./viewshed.ts";
import type { ElevField } from "../core/elev.ts";
import type { Grid } from "../core/grid.ts";
import type { Meta } from "../core/types.ts";
import type { ShellCtx } from "./ctx.ts";

export function wireSpots(ctx: ShellCtx): () => void {
  let seq = 0, lineage: Meta | undefined;
  const flight = singleFlight((meta: Meta, f: ElevField, grid: Grid) => {
    const my = ++seq;
    ctx.routeClient.setViewField(viewFieldOf(meta, f, grid));
    return ctx.routeClient.peaks().then(t => {
      if (seq !== my) return;
      if (t) spotTableSig.value = { f, t };
      else flight.fire(meta, f, grid);   // 车道在飞时崩了：闸落地后补发一次，下一单走同步回退
    }, e => console.warn("标高点峰表计算失败（保持上一份）：", e));
  }, () => fire());
  function fire(): void {
    const w = worldSig.peek(), f = ruleFieldSig.peek(), meta = w ? w.meta || {} : null;
    if (!meta || !f || !ctx.grid || !layerOn(layersSig.peek(), meta, "spots")) return;
    if (spotTableSig.peek()?.f !== f) flight.fire(meta, f, ctx.grid);
  }
  const dispose = effect(() => {
    const w = worldSig.value, f = ruleFieldSig.value, L = layersSig.value;
    if (w && w.meta !== lineage) { lineage = w.meta; seq++; flight.clearDirty(); }
    if (w && f && layerOn(L, w.meta || {}, "spots")) fire();
  });
  return () => { seq++; dispose(); };
}
