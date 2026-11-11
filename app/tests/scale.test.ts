/* 按图种取的尺度参数表（core/scale）：两份逐字钉住，改任何一个尺度参数都要在这里留下痕迹 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SCALE_PROFILES, mapKindOf, scaleProfile } from "../src/core/scale.ts";
import type { Meta } from "../src/core/types.ts";

describe("尺度参数表 SCALE_PROFILES", () => {
  it("两份参数逐字等于字面快照", () => {
    assert.deepStrictEqual(Object.keys(SCALE_PROFILES), ["tactical", "strategic"]);
    assert.strictEqual(JSON.stringify(SCALE_PROFILES.tactical),
      '{"gridNMin":60,"gridNMax":1600,"cellKm":0.1,"cellCap":2600000,"fineCap":1500000,"ultraCapK":1,"tiles":false,' +
      '"scaleFloorKm":0.5,"zoomDataCap":false,"brushLowKm":[0.1,0.3,0.5,0.7,1,1.5,2],"brushTopKm":20,"heightStepsM":[1,5,10,25,50],"heightAutoM":10}');
    assert.strictEqual(JSON.stringify(SCALE_PROFILES.strategic),
      '{"gridNMin":1,"gridNMax":1800,"cellKm":6.666666666666667,"cellCap":1500000,"fineCap":2400000,"ultraCapK":0.5,"tiles":true,' +
      '"scaleFloorKm":50,"zoomDataCap":true,"brushLowKm":[20],"brushTopKm":500,"heightStepsM":[10,25,50,100,250],"heightAutoM":50}');
  });

  it("mapKind 恰为 tactical 才是战术图，缺 meta、缺键与拼错的值都是战略图", () => {
    assert.strictEqual(mapKindOf({ mapKind: "tactical" }), "tactical");
    assert.strictEqual(mapKindOf(undefined), "strategic");
    assert.strictEqual(mapKindOf({}), "strategic");
    for (const v of ["Tactical", "tactical ", "strategic", "", null, 1])
      assert.strictEqual(mapKindOf({ mapKind: v } as unknown as Meta), "strategic", `mapKind=${JSON.stringify(v)}`);
  });

  it("scaleProfile 取的就是表里那一份对象", () => {
    for (const m of [undefined, {}, { mapKind: "tactical" }, { mapKind: "Tactical" }] as (Meta | undefined)[])
      assert.strictEqual(scaleProfile(m), SCALE_PROFILES[mapKindOf(m)]);
  });

  it("笔刷低端定值档至少一项、严格递增且低于末档", () => {
    for (const P of Object.values(SCALE_PROFILES)) {
      const L = P.brushLowKm;
      assert.ok(L.length >= 1);
      L.forEach((v, i) => assert.ok(i === 0 || v > L[i - 1]));
      assert.ok(L[L.length - 1] < P.brushTopKm);
    }
  });
});
