/* 标高点编排（shell/spots）：层开且规则场落定才发单、同一份场不重算、演算中沿用上一份、换图作废在飞的旧单。
   fake routeClient 手动放行峰表单；规则场用粗格包装。 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { wireSpots } from "../src/shell/spots.ts";
import { landWorld } from "../src/shell/orchestrate.ts";
import { normalizeWorld } from "../src/core/world.ts";
import { buildGridCells } from "../src/core/grid.ts";
import { coarseField, type ElevField } from "../src/core/elev.ts";
import { layersSig, ruleFieldSig, spotTableSig } from "../src/ui/state.ts";
import type { PeakTable } from "../src/core/spots.ts";
import type { ShellCtx } from "../src/shell/ctx.ts";
import type { World } from "../src/core/types.ts";

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
const until = async (ok: () => boolean): Promise<void> => { for (let t = 0; t < 200 && !ok(); t++) await new Promise(r => setTimeout(r, 10)); };
const table = (n: number): PeakTable => ({ idx: new Int32Array([n]), prom: new Float32Array([1]) });

function mkCtx(): { ctx: ShellCtx; pend: ((t: PeakTable | null) => void)[] } {
  const pend: ((t: PeakTable | null) => void)[] = [];
  const ctx = {
    routeClient: { setViewField: () => {}, peaks: () => new Promise<PeakTable | null>(res => { pend.push(res); }) },
    meta: {}, grid: null
  } as unknown as ShellCtx;
  return { ctx, pend };
}
const MAP = (name: string): World => normalizeWorld({ meta: { 名称: name, worldModel: "flat", kmPerDeg: 111.19, terrain: "plain", bbox: { lonMin: 100, lonMax: 101, latMin: 30, latMax: 31 } } });
function open(ctx: ShellCtx, w: World): ElevField {
  landWorld(ctx, w, name(w), 0);
  ctx.grid = buildGridCells(ctx.meta, w.terrainOverrides, 0);
  const f = coarseField(ctx.grid, new Float32Array(ctx.grid.cols * ctx.grid.rows));
  ruleFieldSig.value = f;
  return f;
}
const name = (w: World): string => String((w.meta || {}).名称);

describe("标高点编排（shell/spots）", () => {
  let ctx: ShellCtx, pend: ((t: PeakTable | null) => void)[], unwire: () => void;
  beforeEach(() => { ({ ctx, pend } = mkCtx()); ruleFieldSig.value = null; spotTableSig.value = null; layersSig.value = { ...layersSig.peek(), spots: true }; unwire = wireSpots(ctx); });
  afterEach(() => { unwire(); ruleFieldSig.value = null; spotTableSig.value = null; });

  it("落定即发单、结果连同它的场进 sig；同一份场不重算，演算中沿用上一份，换场再算", async () => {
    const f0 = open(ctx, MAP("甲"));
    await until(() => pend.length === 1);
    pend[0](table(1));
    await until(() => spotTableSig.peek() !== null);
    assert.equal(spotTableSig.peek()!.f, f0);
    layersSig.value = { ...layersSig.peek() };   // 无关变化不重算
    await tick();
    assert.equal(pend.length, 1);
    ruleFieldSig.value = null;
    await tick();
    assert.equal(spotTableSig.peek()!.f, f0, "演算中沿用上一份");
    const f1 = coarseField(ctx.grid!, new Float32Array(ctx.grid!.cols * ctx.grid!.rows).fill(0.1));
    ruleFieldSig.value = f1;
    await until(() => pend.length === 2);
    pend[1](table(2));
    await until(() => spotTableSig.peek()!.f === f1);
    assert.equal(spotTableSig.peek()!.t.idx[0], 2);
  });

  it("层关不发单，打开即补算", async () => {
    layersSig.value = { ...layersSig.peek(), spots: false };
    open(ctx, MAP("乙"));
    await tick();
    assert.equal(pend.length, 0);
    layersSig.value = { ...layersSig.peek(), spots: true };
    await until(() => pend.length === 1);
    assert.equal(pend.length, 1);
  });

  it("换图作废在飞的旧单：甲图的峰表不落到乙图，落地后补发乙图的单", async () => {
    open(ctx, MAP("甲"));
    await until(() => pend.length === 1);
    const fB = open(ctx, MAP("乙"));
    assert.equal(spotTableSig.peek(), null, "换图即清空");
    pend[0](table(1));
    await until(() => pend.length === 2);
    assert.equal(spotTableSig.peek(), null, "甲的结果不落");
    pend[1](table(2));
    await until(() => spotTableSig.peek() !== null);
    assert.equal(spotTableSig.peek()!.f, fB);
  });
});
