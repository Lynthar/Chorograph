/* 编排 effect（自 boot.ts 原样抽出，行为不变；独立成模块以便 node 集成测试——boot 因挂载
   mount.tsx 进不了 node:test）：世界/年份/地形版本/选中/编辑改动 → 依序【同步 ctx.meta →
   按需重建网格 → 部队可达性预算】。合为一个 effect 是有意为之——多信号赋值段已 batch()，
   而 batch 冲刷按「后通知者先跑」，拆开的兄弟 effect 之间没有可依赖的次序；meta 同步
   （mutateWorld 原地改不换 meta 对象，世界整体更换时须重挂引用）、重建、legs 的先后
   只能靠 effect 内部语句顺序保证。orchestrate.test.ts 以 fake 渲染器计数锁
   「开图批末恰好重建一次」（builtFor 键 + batch 冲刷共同保证）。 */
import { batch, effect } from "@preact/signals-core";
import { roadCellSet } from "../core/grid.ts";
import { unitLegs } from "../core/units.ts";
import { worldSig, yearSig, selSig, hoverSig, editVerSig, gridVerSig, isTacSig, unitLegsSig, setWorldState } from "../ui/state.ts";
import type { World } from "../core/types.ts";
import type { ShellCtx } from "./ctx.ts";
import type { Host } from "./host.ts";

/** 开图落地（library.setWorld 与 orchestrate.test.ts 共用——测试若只镜像抄序，library 端丢 batch 测不出）：
    meta/mapId 就位、builtFor 置空＝强制按新档重建（同 id 重开时键可能相同而内容已变），单批落信号——
    批内编排 effect 冲刷时即按【最终】世界+年份重建一次；旧「先设年份、effect 拿旧世界白建全平原」的
    时序病根由 batch 杜绝。视角落地/兜底 rebuildIfNeeded 留在调用方（次序与旧行为一致）。 */
export function landWorld(ctx: ShellCtx, w: World, id: string | null, year: number | null | undefined): void {
  ctx.meta = w.meta || {};
  ctx.mapId = id;
  ctx.builtFor = null;
  batch(() => {
    selSig.value = null; hoverSig.value = null;
    if (year != null) yearSig.value = year;
    setWorldState(w);   // worldSig 赋值 + 年份按世界范围钳制
  });
}

/** 接线编排 effect；返回解除函数（生产不解除，供测试隔离用例） */
export function wireOrchestration(ctx: ShellCtx, host: Pick<Host, "rebuildIfNeeded">): () => void {
  return effect(() => {
    const w = worldSig.value;
    if (w) ctx.meta = w.meta || {};
    yearSig.value; gridVerSig.value;
    host.rebuildIfNeeded();
    /* 战术图·可达性预算：为【选中部队】算行军 legs 填 unitLegsSig（对齐旧 renderUnitInfo：只算当前查看的部队）；
       必须在重建之后（ctx.grid 新鲜）。缓存**只保留当前选中部队**（换成 new Map，不累积）——否则换年/涂改地形后，
       之前选中过的部队仍以旧地形的 legs 画超速⚠/可达性表（审计：非选中部队陈旧、换年不重算、replaceCurrent 不清缓存）。
       ⚠ isTacSig 这道门不是遗漏：战略图（2026-07-31 起也可摆部队）的航点时刻是**年**，而 unitLegs 的
       days 是日数——年差直接当日数比，会把「一年行军千里」判成超速。战略图的速度只作记账（同士气之规）。 */
    const sel = selSig.value;
    editVerSig.value;                                       // 依赖：编辑改动（拖航点实时重算）
    const u = (w && ctx.grid && isTacSig.peek() && sel && sel.kind === "unit") ? (w.units || []).find(x => x.id === sel.id) : null;
    if (!u) { if (unitLegsSig.peek().size) unitLegsSig.value = new Map(); return; }
    const roads = roadCellSet(w!.nodes, w!.edges, yearSig.peek(), ctx.grid!);
    unitLegsSig.value = new Map([[u.id, unitLegs(ctx.meta, ctx.grid!, roads, u)]]);
  });
}
