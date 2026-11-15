/* 两个地形渲染器同式的观感规则（render/material 里 TS 函数 + 同名 GLSL）：TS 版的行为，与「每条都有 GLSL 一份」的配对。
   GLSL 版没有单测——它与 TS 版写在一起、由冒烟的观感底图两端差兜着，这里只钉住它存在、同名 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  airK, albAv, albM, cavOf, contourGLSL, contourK, fbmRough, gnoise, haloK, latShift, lodF, macroK, marshK, meadowK, micro, patchN, poolGate, poolMask, poolN,
  rockK, rockT, sandK, shadeGLSL, shadeOf, shoreK, slopeRidge, slopeRough, slopeSoft, snowAt, snowLine, snowSlope, texAt, texPatchK, textureGLSL, tintK, treeFade,
  warp2Of, warpOf, waterT, waveM, waveWv, CONTOUR, FOREST_CANOPY, FX, MICRO_F0, WATER
} from "../src/render/material.ts";
import { WATER_EPS } from "../src/core/constants.ts";

describe("两端同式的观感规则（render/material）", () => {
  it("每条规则都有同名 GLSL：TS 改了、GLSL 没跟（或反过来）就是两端观感分家", () => {
    const glsl = shadeGLSL() + "\n" + contourGLSL() + "\n" + textureGLSL();
    const names = ["slopeSoft", "shadeOf", "cavOf", "latShift", "treeFade", "meadowK", "tintK", "sandK", "beachK", "marshK", "poolGate", "poolMask", "albM", "rockK", "rockT",
      "snowLine", "snowAt", "snowSlope", "airK", "shoreK", "waveM", "waterT", "haloK", "contourK", "lodF", "warpOf", "warp2Of", "micro", "texAt", "fbmRough",
      "slopeRough", "slopeRidge", "patchN", "texPatchK", "macroK", "marshGate", "decoGate", "poolN", "albAv", "waveWv"];
    const missing = names.filter(n => !new RegExp(`\\b(?:float|vec2|vec3|void) ${n}\\(`).test(glsl));
    assert.deepStrictEqual(missing, [], "这几条只有 TS 版");
    const defs = [...glsl.matchAll(/^(?:float|vec2|vec3|void) (\w+)\(/gm)].map(m => m[1]);
    assert.strictEqual(new Set(defs).size, defs.length, "GLSL 里有重名函数");
  });

  it("陡坡软压：膝内恒等、膝外单调递增且有上界（knee + soft）", () => {
    assert.strictEqual(slopeSoft(0), 0);
    assert.strictEqual(slopeSoft(FX.slopeKnee * 0.5), FX.slopeKnee * 0.5, "膝内恒等：写成 knee + … 会把微坡拉到膝点");
    let prev = slopeSoft(FX.slopeKnee);
    for (const s of [1.01, 2, 5, 50, 1e6].map(k => FX.slopeKnee * k)) { const v = slopeSoft(s); assert.ok(v > prev && v < FX.slopeKnee + FX.slopeSoft); prev = v; }
  });

  it("暖冷晕渲：背光到受光，明暗倍率自 shadeLo 到 shadeHi，色偏自冷到暖", () => {
    const o = new Float64Array(4);
    shadeOf(-1, o); assert.deepStrictEqual([...o], [FX.shadeLo, ...FX.cool]);
    shadeOf(1, o); assert.deepStrictEqual([...o].map(v => +v.toFixed(12)), [FX.shadeHi, ...FX.warm]);
  });

  it("谷影钳在 [cavLo, cavHi]，零差为零、随增益同号放大", () => {
    assert.strictEqual(cavOf(0, 0.01, 1), 0);
    assert.strictEqual(cavOf(1e3, 0.01, 1), FX.cavHi); assert.strictEqual(cavOf(-1e3, 0.01, 1), FX.cavLo);
    const a = cavOf(1e-6, 0.01, 1), b = cavOf(1e-6, 0.01, 2);
    assert.ok(a > 0 && Math.abs(b - 2 * a) < 1e-15);
  });

  it("林线、雪线、草甸：边界两侧 0 与 1，纬度改正同号平移", () => {
    assert.strictEqual(treeFade(0.5, 0, 0.1, 0.5), 0); assert.strictEqual(treeFade(0.5, 0, 0.1, 0.6), 1);
    assert.strictEqual(treeFade(0.5, 0.2, 0.1, 0.6), 0, "纬度改正把林线抬高");
    assert.strictEqual(meadowK(1, FOREST_CANOPY * 2), 1); assert.strictEqual(meadowK(1, 0), 0); assert.strictEqual(meadowK(0.5, FOREST_CANOPY), 0.5);
    assert.strictEqual(snowLine(0.3, -1), 0, "雪线不低于海面"); assert.strictEqual(snowLine(0.3, 0.1), 0.4);
    assert.strictEqual(snowAt(1, 1), 0); assert.strictEqual(snowAt(1, 1 + FX.snowBand), 1);
    assert.strictEqual(snowSlope(0), 1); assert.strictEqual(snowSlope(1e3), 1 - FX.snowSlopeCut);
    assert.strictEqual(latShift(10, 1000, 2000) < latShift(60, 1000, 2000), false, "高纬雪线（米）低于低纬，改正随纬度减小");
  });

  it("混色份额：色调、荒漠、沼泽、空气透视、岩化都随权重线性或单调", () => {
    assert.strictEqual(tintK(1), FX.tintMix); assert.strictEqual(sandK(1), FX.sandMix); assert.strictEqual(marshK(1), FX.marshMix);
    assert.strictEqual(airK(-1), 0); assert.strictEqual(airK(10), FX.airMix);
    assert.strictEqual(rockK(0, 1), 0); assert.strictEqual(rockK(1e3, 0.5), 0.5);
    assert.strictEqual(rockT(-1), 0); assert.strictEqual(rockT(1e3), 1);
    assert.strictEqual(albM(0, 1, 1), 1); assert.strictEqual(albM(0.3, 1, 0), 1, "门关＝不抖");
    assert.strictEqual(waveM(0.5, 1), 1);
  });

  it("水洼：只在战术图（paper）、一格够几像素才显；积水与湿泥两份额互补地分在噪声两段", () => {
    assert.strictEqual(poolGate(100, 1, 0), 0, "战略图不画水洼");
    assert.strictEqual(poolGate(0, 1, 1), 0); assert.strictEqual(poolGate(100, 0.8, 1), 0.8);
    const o = new Float64Array(2);
    poolMask(0, o); assert.deepStrictEqual([...o], [0, 0]);
    poolMask(1, o); assert.deepStrictEqual([...o], [0, 1], "积水满处没有湿泥");
    for (let i = 0; i < 64; i++) { const v = poolN(i * 0.37, i * 0.11, 0.01); assert.ok(v > 0 && v < 1); }
  });

  it("近岸带：深水与陆上为零，判据线下、放大够了才有", () => {
    assert.strictEqual(shoreK(-1, 0, 100), 0);
    assert.strictEqual(shoreK(-WATER_EPS, 0, 100), FX.shoreMix);
    assert.strictEqual(shoreK(-WATER_EPS, 0, 0), 0, "整幅视角下近岸带归零");
    assert.strictEqual(waterT(-1, 0), 0); assert.strictEqual(waterT(0, 0), 1);
    assert.strictEqual(waterT(-WATER.rampE, 0), 0); assert.ok(Math.abs(waterT(-WATER.rampE + WATER.rampSpan / 2, 0) - 0.5) < 1e-12);
  });

  it("等高线：线落在等距整倍数上、两倍之间不着墨；计曲线墨更深；亮晕只给暗底", () => {
    const itv = 0.1, ad = 0.001;
    assert.strictEqual(contourK(0.3, itv, ad, 1, 0, 0), CONTOUR.ink[0], "首曲线");
    assert.strictEqual(contourK(0.5, itv, ad, 1, 0, 0), CONTOUR.ink[1], "第 5 条＝计曲线");
    assert.strictEqual(contourK(0.35, itv, ad, 1, 0, 0), 0, "两条线之间");
    assert.strictEqual(contourK(0.3, itv, itv / 2, 1, 0, 0), 0, "线距不到挤线门的下沿：陡坎上的线隐去");
    assert.ok(contourK(0.3, itv, ad, 1, 0, FX.haloPx) >= contourK(0.3, itv, ad, 1, 0, 0), "外扩带只更宽");
    assert.strictEqual(haloK(1, 0, 1), 0, "亮底不画晕"); assert.strictEqual(haloK(0, 0.5, 1), 0.5);
  });

  it("取样与纹理：lodF 两档成二倍、份额在 [0,1)；整幅视角下微八度与材质纹理为零；扭曲小于半格", () => {
    const [f1, f2, fr] = lodF(5000, 30);
    assert.ok(f2 === 2 * f1 && fr >= 0 && fr < 1 && f1 >= MICRO_F0);
    assert.deepStrictEqual(lodF(1, 30), [MICRO_F0, 2 * MICRO_F0, 0], "缩小到底停在基频");
    assert.strictEqual(micro(0.3, 0.7, 1), 0); assert.strictEqual(texAt(0.3, 0.7, 1, 1, 1, 1, 1), 0);
    assert.strictEqual(texAt(0.3, 0.7, 0, 0, 0, 0, 1e6), 0, "权重全零");
    const o = new Float64Array(2), o4 = new Float64Array(4), step = 0.05;
    for (let i = 0; i < 64; i++) { warpOf(i * 0.013, i * 0.029, step, o); assert.ok(Math.hypot(o[0], o[1]) < step * 0.5 * Math.SQRT2); }
    warp2Of(0.4, 0.2, step, o4); assert.ok(o4.every(v => Math.abs(v) < step * 2));
    for (let i = 0; i < 64; i++) { const g = gnoise(i * 0.31, i * 0.17); assert.ok(Math.abs(g) <= 1); }
    assert.ok(Math.abs(albAv(0.2, 0.3, 50, 100, 0.5)) <= 1);
    const wv = waveWv(0.2, 0.3, 50, 100, 0.5); assert.ok(wv >= 0 && wv <= 1);
  });

  it("坡度补材质、宏观 fbm 幅度、纹理疏密与宏观法线系数", () => {
    assert.strictEqual(slopeRough(0, 0.1), 0.1); assert.strictEqual(slopeRough(1e6, 0), FX.slopeRoughMax);
    assert.strictEqual(slopeRidge(0, 0.3), 0.3); assert.strictEqual(slopeRidge(1e6, 0), 1);
    assert.strictEqual(fbmRough(1, 0), FX.fbmRough[0]); assert.strictEqual(fbmRough(1, 1), FX.fbmRough[0] * FX.fbmEroded, "侵蚀过的场降档");
    assert.strictEqual(fbmRough(0.3, 0), FX.fbmRough[1]); assert.strictEqual(fbmRough(0, 0), FX.fbmRough[2]);
    assert.strictEqual(texPatchK(-1), FX.texPatchLo); assert.strictEqual(texPatchK(2), FX.texPatchHi);
    const pn = patchN(0.5, 0.5, 0.05); assert.ok(pn > 0 && pn < 1);
    assert.strictEqual(macroK(0.1, 2), FX.macroNrm / 0.1 * FX.macroW * 2);
  });
});
