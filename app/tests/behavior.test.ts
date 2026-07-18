/* 行为意图测试：不对照黄金基准，而是把各模块"该是什么语义"直接写成断言
  （历法进退位、时段区间开闭、投影可逆、地形确定性等）——平价测试防漂移，这里防"两边一起错"。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calOf, cnDay, cnMonth, fmtShichen, fmtT, fmtWhenRange, fmtYMD, fmtYear, fmtYearForm, fromT, parseYMD, parseYearForm, tacT, yearSpanT } from "../src/core/calendar.ts";
import { distKm, haversine, wrapLon } from "../src/core/geo.ts";
import { chaikin, chaikinOpen, convexHull, edgeLenKm, meander, pointInPoly, polylineKm } from "../src/core/geometry.ts";
import { genTerrainAt, seedTerrain } from "../src/core/terrain.ts";
import { activeAt, opVisibleAt, ownerAt, yearRangeOf } from "../src/core/time.ts";
import { buildElevField, contourStepFor, elevBilinear, elevSmooth, elevUnitM } from "../src/core/elev.ts";
import { buildGridCells, type Grid } from "../src/core/grid.ts";
import { ELEV } from "../src/core/constants.ts";
import { clampView, project, unproject, type Camera } from "../src/core/projection.ts";
import { esc, fmtKm, hexA, parseKV, safeName } from "../src/core/util.ts";
import { TERRAIN, TERRAIN_ORDER, flattenTerrain } from "../src/core/constants.ts";
import { planTile, tileCovers } from "../src/render/terrainCPU.ts";
import { blankWorld, countsOf, normalizeWorld } from "../src/core/world.ts";
import { createTacticalWorld, tacDiaDeg } from "../src/core/tactical.ts";
import { paintStep, resamplePaintCells, territoryLoops } from "../src/core/territory.ts";
import { nodesInBox, pickNode } from "../src/render/overlay.ts";
import type { World, WorldNode } from "../src/core/types.ts";
import { validateWorld } from "../src/core/validate.ts";
import { readFileSync } from "node:fs";

const close = (a: number, b: number, digits = 9) =>
  assert.ok(Math.abs(a - b) < 10 ** -digits, `${a} ≈ ${b} (±1e-${digits})`);

describe("历法", () => {
  const cal = calOf();       // 默认 12 月 × 30 日
  it("默认历法 360 日/年", () => assert.strictEqual(cal.dpy, 360));
  it("日戳往返：任意年月日 → T → 同一年月日", () => {
    for (const [y, m, d] of [[0, 1, 1], [3107, 3, 7], [3107, 12, 30], [1, 6, 15]] as const)
      assert.deepStrictEqual(fromT(cal, tacT(cal, y, m, d)), { y, m, d });
  });
  it("古典日名：初十/十七/二十/廿一/三十，超出回退数字", () => {
    assert.strictEqual(cnDay(10), "初十");
    assert.strictEqual(cnDay(17), "十七");
    assert.strictEqual(cnDay(20), "二十");
    assert.strictEqual(cnDay(21), "廿一");
    assert.strictEqual(cnDay(30), "三十");
    assert.strictEqual(cnDay(31), "31日");
    assert.strictEqual(cnMonth(3), "三");
    assert.strictEqual(cnMonth(13), "13");
  });
  it("fmtT 古典格式", () => assert.strictEqual(fmtT(cal, tacT(cal, 3107, 3, 7)), "SE3107·三月初七"));
  it("parseYMD 多格式，仅年=正月初一，非法→null", () => {
    const T = tacT(cal, 3107, 3, 7);
    assert.strictEqual(parseYMD(cal, "3107-3-7"), T);
    assert.strictEqual(parseYMD(cal, "3107年3月7日"), T);
    assert.strictEqual(parseYMD(cal, "3107.3.7"), T);
    assert.strictEqual(parseYMD(cal, "3107"), tacT(cal, 3107, 1, 1));
    assert.strictEqual(parseYMD(cal, ""), null);
    assert.strictEqual(parseYMD(cal, "abc"), null);
    assert.strictEqual(parseYMD(cal, null), null);
  });
  it("自定义历法：10 月 × 36 日", () => {
    const c = calOf({ months: 10, dpm: 36 });
    assert.strictEqual(c.dpy, 360);
    assert.strictEqual(tacT(c, 1, 2, 1), 360 + 36);
  });
});

describe("历法·真实地球（earth：日戳=JDN，儒略≤1582-10-04/格里≥10-15，天文纪年）", () => {
  const E = calOf({ kind: "earth" });
  it("锚点：G2000-01-01=2451545、切换两侧相邻（2299160/2299161）", () => {
    assert.strictEqual(tacT(E, 2000, 1, 1), 2451545);
    assert.strictEqual(tacT(E, 1582, 10, 15), 2299161);
    assert.strictEqual(tacT(E, 1582, 10, 4), 2299160);
    assert.strictEqual(tacT(E, 1582, 10, 15), tacT(E, 1582, 10, 4) + 1);
  });
  it("战役锚点：前216-08-02(儒略)=1642743、1363-08-30=2219135、1815-06-18=2384143、1863-07-01=2401688", () => {
    assert.strictEqual(tacT(E, -215, 8, 2), 1642743);   // 坎尼：前216 → 天文纪年 -215
    assert.strictEqual(tacT(E, 1363, 8, 30), 2219135);  // 鄱阳湖（儒略）
    assert.strictEqual(tacT(E, 1815, 6, 18), 2384143);  // 滑铁卢（格里）
    assert.strictEqual(tacT(E, 1863, 7, 1), 2401688);   // 葛底斯堡
  });
  it("往返：闰年边界/月末/公元前全部复原", () => {
    for (const [y, m, d] of [[2000, 2, 29], [1600, 2, 29], [2000, 12, 31], [1815, 6, 18],
                             [-215, 8, 2], [0, 2, 29], [-44, 3, 15], [1582, 10, 4], [1582, 10, 15], [1, 1, 1]] as const)
      assert.deepStrictEqual(fromT(E, tacT(E, y, m, d)), { y, m, d });
  });
  it("闰年规则：格里 1900 非闰(2-29→3-1)、儒略/格里 0 年皆闰", () => {
    assert.deepStrictEqual(fromT(E, tacT(E, 1900, 2, 29)), { y: 1900, m: 3, d: 1 });
    assert.deepStrictEqual(fromT(E, tacT(E, 0, 2, 29)), { y: 0, m: 2, d: 29 });   // 0=前1年，儒略闰
  });
  it("切换空洞：儒略纪日 1582-10-05..14 落到同一物理日（=格里 10-15..24）", () => {
    assert.deepStrictEqual(fromT(E, tacT(E, 1582, 10, 5)), { y: 1582, m: 10, d: 15 });
    assert.deepStrictEqual(fromT(E, tacT(E, 1582, 10, 10)), { y: 1582, m: 10, d: 20 });
  });
  it("parse/fmt：「前N」与时刻 HH:MM", () => {
    assert.strictEqual(parseYMD(E, "前216-8-2"), 1642743);
    assert.strictEqual(parseYMD(E, "前216年8月2日"), 1642743);
    assert.strictEqual(parseYMD(E, "-215-8-2"), 1642743);
    assert.strictEqual(parseYMD(E, "1815-6-18 13:30"), 2384143 + (13 * 60 + 30) / 1440);
    assert.strictEqual(parseYMD(E, "1815-6-18 25:00"), null);
    assert.strictEqual(fmtT(E, 1642743), "公元前216年8月2日");
    assert.strictEqual(fmtT(E, 2384143 + 13.5 / 24), "1815年6月18日 13:30");
    assert.strictEqual(fmtYMD(E, 1642743), "前216-8-2");
    assert.strictEqual(fmtYMD(E, 2384143 + 13.5 / 24), "1815-6-18 13:30");
    assert.strictEqual(parseYMD(E, fmtYMD(E, 2384143 + 13.5 / 24)), 2384143 + 13.5 / 24);   // 表单互逆
  });
  it("纪年助手：fmtYear/fmtYearForm/parseYearForm 双轨", () => {
    assert.strictEqual(fmtYear(E, 1863), "公元1863");
    assert.strictEqual(fmtYear(E, -215), "公元前216");
    assert.strictEqual(fmtYearForm(E, -215), "前216");
    assert.strictEqual(parseYearForm(E, "前216"), -215);
    assert.strictEqual(parseYearForm(E, "-215"), -215);
    assert.strictEqual(parseYearForm(E, "1863"), 1863);
    assert.strictEqual(parseYearForm(E, "16世纪"), null);
    const C = calOf();
    assert.strictEqual(fmtYear(C, 3107), "SE3107");
    assert.strictEqual(fmtYear(C, 3107, true), "SE 3107");
    assert.strictEqual(fmtYear(calOf({ era: "天启" }), 88), "天启88");
    assert.strictEqual(parseYearForm(C, "3107.5"), 3107.5);   // custom 保 parseFloat 旧语义
    assert.strictEqual(parseYearForm(C, ""), null);
  });
  it("yearSpanT：custom 与旧 y*dpy 一致；earth=当年 JDN 闭区间", () => {
    assert.deepStrictEqual(yearSpanT(calOf(), 3107), [3107 * 360, 3108 * 360 - 1]);
    assert.deepStrictEqual(yearSpanT(E, 1863), [tacT(E, 1863, 1, 1), tacT(E, 1864, 1, 1) - 1]);
    assert.strictEqual(yearSpanT(E, 1863)[1] - yearSpanT(E, 1863)[0] + 1, 365);   // 1863 平年
    assert.strictEqual(yearSpanT(E, 1864)[1] - yearSpanT(E, 1864)[0] + 1, 366);   // 1864 闰年
  });
  it("yearRangeOf：earth 战术图默认范围=当年 JDN 跨度，出界回下限", () => {
    const w = { meta: { mapKind: "tactical", battleYear: 1863, calendar: { kind: "earth" } },
      nodes: [], factions: [], edges: [], decor: [], terrainOverrides: [], units: [] } as unknown as World;
    const r = yearRangeOf(w, 0);
    assert.strictEqual(r.min, tacT(E, 1863, 1, 1));
    assert.strictEqual(r.max, tacT(E, 1864, 1, 1) - 1);
    assert.strictEqual(r.year, r.min);
  });
});

describe("历法·日内时刻（小数日戳：0=午夜；custom 时辰·96刻，earth HH:MM）", () => {
  const C = calOf();
  it("时辰名：子正=0、午正=正午、子初=23:00、刻名初(略)/一/二/三", () => {
    assert.strictEqual(fmtShichen(0), "子正");
    assert.strictEqual(fmtShichen(0.5), "午正");
    assert.strictEqual(fmtShichen(23 / 24), "子初");
    assert.strictEqual(fmtShichen(0.5 + 2 / 96), "午正二刻");   // 12:30
    assert.strictEqual(fmtShichen(11 / 24), "午初");
  });
  it("custom fmtT/parse：整日无时刻后缀（旧输出不变），小数带时辰且互逆", () => {
    const T = tacT(C, 3107, 3, 7);
    assert.strictEqual(fmtT(C, T), "SE3107·三月初七");
    assert.strictEqual(fmtT(C, T + 0.5), "SE3107·三月初七·午正");
    assert.strictEqual(parseYMD(C, "3107-3-7 午正"), T + 0.5);
    assert.strictEqual(parseYMD(C, "3107-3-7 午正二刻"), T + 50 / 96);
    assert.strictEqual(parseYMD(C, "3107-3-7 12:00"), T + 0.5);
    assert.strictEqual(parseYMD(C, fmtYMD(C, T + 0.5)), T + 0.5);   // 表单互逆
  });
});

describe("高程场（buildElevField：起伏+涂改+标定）", () => {
  const MP = { worldModel: "sphere" as const, terrain: "plain" as const, bbox: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 } };
  it("全关=逐格 ELEV[类型]（旧渲染逐位不变）", () => {
    const g = buildGridCells(MP, [], 0);
    const f = buildElevField(MP, undefined, g, 0);
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++)
      assert.strictEqual(f[r * g.cols + c], Math.fround(ELEV[flattenTerrain(g.cells[r][c])]));   // cells 存复合、flatten 回旧类查 ELEV；Float32 存储精度
  });
  it("relief：确定性、同类型格间起伏、水域恒平、陆地不破下限", () => {
    const M = { worldModel: "sphere" as const, terrain: "sample" as const, genSeed: 7, relief: 1,
      bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 } };
    const g = buildGridCells(M, [], 3107);
    const f1 = buildElevField(M, undefined, g, 3107), f2 = buildElevField(M, undefined, g, 3107);
    assert.deepStrictEqual([...f1], [...f2], "同种子确定性");
    const mts: number[] = [];
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      const i = r * g.cols + c;
      if (g.cells[r][c] === "water") assert.strictEqual(f1[i], Math.fround(ELEV.water), "水域恒平");
      else { assert.ok(f1[i] >= 0.1 - 1e-9, "陆地不破下限"); if (g.cells[r][c] === "mountain") mts.push(f1[i]); }
    }
    assert.ok(new Set(mts.map(v => v.toFixed(4))).size > 5, "山与山高度不同");
  });
  it("高程涂改：单格加性、粗块盖章、时段过滤、下切钳制", () => {
    const g = buildGridCells(MP, [], 3107);
    const f = buildElevField(MP, [
      { lon: 101.5, lat: 31.5, dh: 0.3 }, { lon: 101.5, lat: 31.5, dh: 0.1 },   // 同格两章相加
      { lon: 103, lat: 33, dh: 0.2, step: 2 },                                   // 粗块铺 2°
      { lon: 100.5, lat: 30.5, dh: 0.5, since: 3200 },                           // 未生效
      { lon: 100.5, lat: 33.5, dh: -0.5 }                                        // 下切→钳制
    ], g, 3107);
    const at = (lon: number, lat: number) => f[Math.floor((lat - 30) / g.step) * g.cols + Math.floor((lon - 100) / g.step)];
    close(at(101.5, 31.5), 0.16 + 0.4, 6);
    close(at(102.5, 32.5), 0.16 + 0.2, 6);
    close(at(103.5, 33.5), 0.16 + 0.2, 6);
    close(at(100.5, 30.5), 0.16, 6);   // 时段外涂改不生效（Float32 容差）
    close(at(100.5, 33.5), 0.1, 6);
  });
  it("标定：elevUnitM 缺省 2000；contourStepFor＝×2 阶梯、contourM 下限、跨档连续、随缩小单调", () => {
    assert.strictEqual(elevUnitM({}), 2000);
    assert.strictEqual(elevUnitM({ elevUnitM: 1500 }), 1500);
    // 深缩放贴 contourM 下限（缺省 10m），fade=0
    assert.deepStrictEqual(contourStepFor(1e-9, {}), { minorM: 10, minor: 10 / 2000, fade: 0 });
    assert.deepStrictEqual(contourStepFor(1e-9, { contourM: 100, elevUnitM: 1000 }), { minorM: 100, minor: 0.1, fade: 0 });
    // 法则：理想等距=1.6×米/像素（缺省球面 R=10000 → 174.53 km/度），向上吸附 ×2 阶梯
    const a = contourStepFor(0.001, {});   // 174.53 m/px → 理想 279.3m → 10×2^5=320m
    assert.strictEqual(a.minorM, 320);
    assert.ok(a.fade > 0 && a.fade < 1);
    // 平面世界按 meta.kmPerDeg：100 m/px → 理想 160m=整档 → fade=0
    assert.deepStrictEqual(contourStepFor(0.001, { worldModel: "flat", kmPerDeg: 100 }), { minorM: 160, minor: 0.08, fade: 0 });
    // 跨档连续：档界两侧 minor 折半、fade 1→0（旧档半距线全显 ≡ 新档整距线）
    const mpd = 2 * Math.PI * 10000 / 360 * 1000, dppAt = (idealM: number) => idealM / 1.6 / mpd;   // 米/度
    const lo = contourStepFor(dppAt(160 * 1.0001), {}), hi = contourStepFor(dppAt(160 * 0.9999), {});
    assert.strictEqual(lo.minorM, 320); assert.ok(lo.fade > 0.99);
    assert.strictEqual(hi.minorM, 160); assert.ok(hi.fade < 0.01);
    let prev = 0;
    for (const dpp of [1e-4, 3e-4, 1e-3, 3e-3, 1e-2, 3e-2, 0.1]) { const v = contourStepFor(dpp, {}).minorM; assert.ok(v >= prev, "随缩小单调不减"); prev = v; }
  });
  it("elevBilinear：格心=场值、格心间线性、出格钳到边缘（读数与渲染采样同源）", () => {
    const g = { bb: { lonMin: 0, latMin: 0, lonMax: 2, latMax: 2 }, step: 1, cols: 2, rows: 2,
      cells: [["plain", "plain"], ["plain", "plain"]] } as unknown as Grid;
    const f = new Float32Array([0, 1, 2, 3]);   // 行主序 (r0c0,r0c1,r1c0,r1c1)
    close(elevBilinear(f, g, 0.5, 0.5), 0);
    close(elevBilinear(f, g, 1.5, 0.5), 1);
    close(elevBilinear(f, g, 1.0, 0.5), 0.5);    // 两格心中点＝均值
    close(elevBilinear(f, g, 1.0, 1.0), 1.5);    // 四格心中心＝均值
    close(elevBilinear(f, g, -5, -5), 0);        // 出格钳到角
    close(elevBilinear(f, g, 5, 5), 3);
    // elevSmooth（制图面=±半格 4 抽头帐篷平滑）：均匀场不变、对称中心不变、角部为钳制平均
    close(elevSmooth(new Float32Array([2, 2, 2, 2]), g, 1.0, 1.0), 2);
    close(elevSmooth(f, g, 1.0, 1.0), 1.5);
    close(elevSmooth(f, g, 0.5, 0.5), 0.75);     // avg(0, 0.5, 1, 1.5)
  });
});

describe("作战线时间维度（opVisibleAt：分相位箭头）", () => {
  const ev = { year: 3107 };
  it("无时段=事件当年/当日精确相等（旧语义，旧档零迁移）", () => {
    assert.strictEqual(opVisibleAt(ev, {}, 3107), true);
    assert.strictEqual(opVisibleAt(ev, {}, 3106), false);
    assert.strictEqual(opVisibleAt(ev, {}, 3107.5), false);   // 时粒度下拖过整日刻，无时段线不显示
  });
  it("带时段=[since,until) 区间显隐，独立于事件时刻", () => {
    const op = { since: 1118520, until: 1118523 };            // 战术图日戳三日相位
    assert.strictEqual(opVisibleAt(ev, op, 1118520), true);
    assert.strictEqual(opVisibleAt(ev, op, 1118522.75), true);   // 小数时刻在段内
    assert.strictEqual(opVisibleAt(ev, op, 1118523), false);     // until 不含
    assert.strictEqual(opVisibleAt(ev, op, 1118519.9), false);
    assert.strictEqual(opVisibleAt({ year: 9999 }, op, 1118521), true, "与事件自身时刻无关");
  });
  it("单边时段：只有 since / 只有 until", () => {
    assert.strictEqual(opVisibleAt(ev, { since: 3100 }, 3200), true);
    assert.strictEqual(opVisibleAt(ev, { since: 3100 }, 3099), false);
    assert.strictEqual(opVisibleAt(ev, { until: 3100 }, 3099), true);
    assert.strictEqual(opVisibleAt(ev, { until: 3100 }, 3100), false);
  });
});

describe("时间过滤（[since, until) 半开区间）", () => {
  it("since 含、until 不含", () => {
    assert.strictEqual(activeAt({ since: 3100, until: 3105 }, 3100), true);
    assert.strictEqual(activeAt({ since: 3100, until: 3105 }, 3105), false);
    assert.strictEqual(activeAt({}, -99999), true);
  });
  it("归属沿革：命中区间→该派系；owners 空数组→回退固定 faction；有 owners 但无命中→null", () => {
    const n = { owners: [{ faction: "a", until: 3100 }, { faction: "b", since: 3100, until: 3105 }], faction: "z" };
    assert.strictEqual(ownerAt(n, 3099), "a");
    assert.strictEqual(ownerAt(n, 3100), "b");
    assert.strictEqual(ownerAt(n, 3200), null);
    assert.strictEqual(ownerAt({ owners: [], faction: "z" }, 1), "z");
  });
});

describe("地理", () => {
  it("零距离与对称性", () => {
    assert.strictEqual(distKm({}, 100, 30, 100, 30), 0);
    close(distKm({}, 100, 30, 110, 40), distKm({}, 110, 40, 100, 30), 9);
  });
  it("平面世界=直角坐标：3-4-5 勾股", () => {
    close(distKm({ worldModel: "flat", kmPerDeg: 1 }, 0, 0, 3, 4), 5, 12);
  });
  it("球面半圈 = πR", () => {
    close(haversine(0, 0, 180, 0, 6371), Math.PI * 6371, 6);
  });
  it("经度环绕仅球面", () => {
    assert.strictEqual(wrapLon(190, false), -170);
    assert.strictEqual(wrapLon(190, true), 190);
    assert.strictEqual(wrapLon(-180, false), -180);
    assert.strictEqual(wrapLon(180, false), -180);
  });
});

describe("投影", () => {
  const cam: Camera = { lon0: 108, lat0: 36, degPerPx: 0.06, w: 1200, h: 700, flat: false };
  it("视中心投到画布中心", () => assert.deepStrictEqual(project(cam, 108, 36), [600, 350]));
  it("project ↔ unproject 互逆", () => {
    for (const [lon, lat] of [[108, 36], [96.3, 41.7], [130, 54]] as const) {
      const [x, y] = project(cam, lon, lat);
      const [lo, la] = unproject(cam, x, y);
      close(lo, lon, 9);
      close(la, lat, 9);
    }
  });
  it("平面世界 cos=1：经度间距不随纬度收缩", () => {
    const f: Camera = { ...cam, flat: true };
    const dx = project(f, 109, 36)[0] - project(f, 108, 36)[0];
    const dy = project(f, 108, 35)[1] - project(f, 108, 36)[1];
    close(dx, dy, 9);
  });
  it("clampView 坏档守卫：非有限/天文经纬度 O(1) 收敛（旧 while±360 冻页甚至死循环）", () => {
    assert.deepStrictEqual(clampView({ lon0: NaN, lat0: NaN }, {}), { lon0: 0, lat0: 0, wrapShift: 0 });
    assert.deepStrictEqual(clampView({ lon0: Infinity, lat0: -Infinity }, {}), { lon0: 0, lat0: 0, wrapShift: 0 });
    assert.deepStrictEqual(clampView({ lon0: 1e300, lat0: 40 }, {}), { lon0: 0, lat0: 40, wrapShift: 0 }, "亿度开外＝坏档，归零且不携带天文 wrapShift");
    assert.deepStrictEqual(clampView({ lon0: 3.6e10, lat0: 0 }, {}), { lon0: 0, lat0: 0, wrapShift: 0 }, "旧实现此处 1 亿次循环；新实现直接判坏档");
    const c = clampView({ lon0: 36123.5, lat0: 0 }, {});   // 亿度以内多圈环绕：O(1) 折返且与逐圈递减逐位一致
    assert.strictEqual(c.lon0, 123.5);
    assert.strictEqual(c.wrapShift, -36000);
    // 常规环绕逐位不变（黄金基准另有锁定；此处防守卫误伤）
    assert.deepStrictEqual(clampView({ lon0: 190, lat0: 99 }, {}), { lon0: -170, lat0: 85, wrapShift: -360 });
    assert.deepStrictEqual(clampView({ lon0: -541, lat0: -99 }, {}), { lon0: 179, lat0: -85, wrapShift: 720 });
  });
});

describe("程序化地形", () => {
  const meta = { terrain: "auto" as const, genSeed: 1234 };
  it("确定性：同参数同输出", () => {
    for (let i = 0; i < 50; i++) {
      const lon = 82 + (i % 10) * 4.8, lat = 22 + Math.floor(i / 10) * 6.4;
      assert.strictEqual(genTerrainAt(meta, lon, lat), genTerrainAt({ ...meta }, lon, lat));
    }
  });
  it("产出均为合法地形（复合 flatten 回旧 8 类）", () => {
    const legal = new Set<string>(TERRAIN_ORDER);
    for (let lat = 23; lat < 54; lat += 3.7) for (let lon = 83; lon < 130; lon += 4.9)
      assert.ok(legal.has(flattenTerrain(seedTerrain(meta, lon, lat))));
  });
  it("换种子换大陆（采样有差异）", () => {
    let diff = 0;
    for (let lat = 23; lat < 54; lat += 2.3) for (let lon = 83; lon < 130; lon += 2.9)
      if (genTerrainAt({ ...meta, genSeed: 1234 }, lon, lat) !== genTerrainAt({ ...meta, genSeed: 5678 }, lon, lat)) diff++;
    assert.ok(diff > 20, `差异格数 ${diff} 应 > 20`);
  });
  it("plain 模式恒为平原", () => assert.strictEqual(seedTerrain({ terrain: "plain" }, 100, 30), "plain"));
});

describe("几何", () => {
  it("点在多边形内/外", () => {
    const sq: [number, number][] = [[0, 0], [4, 0], [4, 4], [0, 4]];
    assert.strictEqual(pointInPoly(2, 2, sq), true);
    assert.strictEqual(pointInPoly(5, 2, sq), false);
  });
  it("凸包剔除内点", () => {
    assert.strictEqual(convexHull([[0, 0], [4, 0], [4, 4], [0, 4], [2, 2], [1, 1]]).length, 4);
  });
  it("Chaikin 每轮点数×2", () => {
    assert.strictEqual(chaikin([[0, 0], [4, 0], [4, 4], [0, 4]], 3).length, 4 * 2 ** 3);
  });
  it("河流曲流：15 点、端点精确、同 seed 确定同形", () => {
    const a = { lon: 100, lat: 30 }, b = { lon: 110, lat: 34 };
    const pts = meander(a, b, "n1n2");
    assert.strictEqual(pts.length, 15);
    assert.deepStrictEqual(pts[0], [100, 30]);
    assert.ok(Math.abs(pts[14][0] - 110) < 1e-9 && Math.abs(pts[14][1] - 34) < 1e-9);
    assert.deepStrictEqual(pts, meander(a, b, "n1n2"));
    assert.notDeepStrictEqual(pts, meander(a, b, "n2n3"));   // 换 seed 换形
  });
  it("沿线长：河流含曲流 > 两端直线；道路 = 直线", () => {
    const meta = { worldModel: "sphere" as const, planetRadiusKm: 10000 };
    const a = { lon: 100, lat: 30 }, b = { lon: 110, lat: 34 };
    const straight = edgeLenKm(meta, a, b, "road", "n1n2");
    const river = edgeLenKm(meta, a, b, "river", "n1n2");
    assert.ok(river > straight);
    assert.ok(river < straight * 1.6);   // 曲流有限度（振幅 0.14×长度）
  });
  it("polylineKm：折线逐段累加（整段=分段之和；单点=0）", () => {
    const meta = { worldModel: "sphere" as const, planetRadiusKm: 10000 };
    const A: [number, number] = [100, 30], B: [number, number] = [105, 30], C: [number, number] = [110, 34];
    const whole = polylineKm(meta, [A, B, C]);
    assert.ok(Math.abs(whole - (polylineKm(meta, [A, B]) + polylineKm(meta, [B, C]))) < 1e-9);
    assert.ok(whole > 0);
    assert.strictEqual(polylineKm(meta, [[1, 1]]), 0);
  });
  it("chaikinOpen：端点固定、开折线不闭合、<3 点原样", () => {
    const s = chaikinOpen([[0, 0], [4, 0], [4, 4]], 1);
    assert.deepStrictEqual(s[0], [0, 0], "首点保留");
    assert.deepStrictEqual(s[s.length - 1], [4, 4], "末点保留");
    assert.strictEqual(s.length, 6, "N=3 一轮=2N；端点保留是与闭环 chaikin 的区别（闭环会切掉首尾角）");
    assert.deepStrictEqual(chaikinOpen([[0, 0], [1, 1]], 3), [[0, 0], [1, 1]], "<3 点无内部转角，原样");
  });
});

describe("CPU 兜底瓦片复用判定", () => {
  const gridBB = { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 };
  const tile = { bb: { lonMin: 90, lonMax: 120, latMin: 25, latMax: 50 }, pxpd: 20 };
  it("视口在瓦片内、分辨率同档 → 复用", () => {
    assert.strictEqual(tileCovers(tile, { lonMin: 95, lonMax: 115, latMin: 30, latMax: 45 }, 20, gridBB), true);
  });
  it("平移越出瓦片 → 重渲", () => {
    assert.strictEqual(tileCovers(tile, { lonMin: 85, lonMax: 105, latMin: 30, latMax: 45 }, 20, gridBB), false);
  });
  it("缩放变档（超 1.5×）→ 重渲；档内 → 复用", () => {
    assert.strictEqual(tileCovers(tile, { lonMin: 95, lonMax: 115, latMin: 30, latMax: 45 }, 31, gridBB), false);
    assert.strictEqual(tileCovers(tile, { lonMin: 95, lonMax: 115, latMin: 30, latMax: 45 }, 29, gridBB), true);
  });
  it("视口越界部分被网格范围裁掉后仍算覆盖", () => {
    assert.strictEqual(tileCovers({ bb: gridBB, pxpd: 15 }, { lonMin: 60, lonMax: 140, latMin: 10, latMax: 60 }, 15, gridBB), true);
  });
  it("planTile：请求超像素预算时记录请求分辨率——下一帧同口径复用（记录封顶值则永判重建）", () => {
    const vb = { lonMin: 100, lonMax: 110, latMin: 35, latMax: 40 };
    const plan = planTile(null, "", vb, 2000, gridBB);
    assert.ok(typeof plan === "object", "无瓦片必重建");
    assert.ok(plan.renderPxpd < 2000 * 0.66, "前提：预算封顶已远低于请求档");
    assert.strictEqual(plan.pxpd, 2000, "瓦片记录请求分辨率而非封顶值");
    assert.strictEqual(planTile({ bb: plan.bb, pxpd: plan.pxpd, key: "" }, "", vb, 2000, gridBB), "keep", "同视口下一帧必须复用");
    assert.notStrictEqual(planTile({ bb: plan.bb, pxpd: plan.renderPxpd, key: "" }, "", vb, 2000, gridBB), "keep", "（反例=旧缺陷）记录封顶值则永不复用");
  });
  it("planTile：视口全在网格外 → none；等高线参数换档 → 重建", () => {
    assert.strictEqual(planTile(null, "", { lonMin: 200, lonMax: 210, latMin: 60, latMax: 70 }, 20, gridBB), "none");
    assert.strictEqual(typeof planTile({ bb: gridBB, pxpd: 20, key: "c0.12f0" }, "c0.24f0", { lonMin: 95, lonMax: 115, latMin: 30, latMax: 45 }, 20, gridBB), "object");
  });
});

describe("工具", () => {
  it("esc 全量转义", () => assert.strictEqual(esc(`<a b="c">&'</a>`), "&lt;a b=&quot;c&quot;&gt;&amp;&#39;&lt;/a&gt;"));
  it("fmtKm 三档", () => {
    assert.strictEqual(fmtKm(0.5), "500 m");
    assert.strictEqual(fmtKm(37.4), "37 km");
    assert.strictEqual(fmtKm(1234), "1.23 千km");
  });
  it("hexA 展开短色值，非法原样返回", () => {
    assert.strictEqual(hexA("#abc", 0.5), "rgba(170,187,204,0.5)");
    assert.strictEqual(hexA("red", 0.5), "red");
    assert.strictEqual(hexA(undefined, 0.5), "#888");
  });
  it("parseKV 中英冒号、裁剪空白、跳过空键", () => {
    assert.deepStrictEqual(parseKV("人口：十万\n地位: 州府\n：无键\n驻军：  三千 "), { 人口: "十万", 地位: "州府", 驻军: "三千" });
  });
  it("TERRAIN 寻路代价单调合理（平原最低、水域最高）", () => {
    assert.strictEqual(TERRAIN.plain.land, 1.0);
    assert.strictEqual(TERRAIN.water.land, 9.0);
    for (const t of TERRAIN_ORDER) assert.ok(TERRAIN[t].land >= 1.0);
  });
});

describe("世界规范化（语义）", () => {
  it("任意垃圾输入 → 六大数组补齐 + meta 对象，可安全渲染", () => {
    for (const bad of [null, undefined, 42, "x", { meta: "y", nodes: "z" }]) {
      const w = normalizeWorld(bad);
      assert.ok(w.meta && typeof w.meta === "object");
      for (const k of ["factions", "nodes", "edges", "decor", "terrainOverrides", "units"] as const)
        assert.ok(Array.isArray(w[k]), `${k} 应为数组`);
    }
  });
  it("收敛：第二次规范化起是不动点（首轮 v0.9 迁移的事件点要到次轮才补 evtype——旧版原语义）", () => {
    const raw = { meta: {}, nodes: [{ id: "a", type: "vassalseat", lon: 1, lat: 2 }],
      events: [{ id: "e1", at: "a", year: 3000 }], units: [{ id: "u", kind: "cav", track: [{ t: 2, lon: 0, lat: 0 }, { t: 1, lon: 1, lat: 1 }] }] };
    const J = (x: unknown) => JSON.parse(JSON.stringify(x));
    const once = J(normalizeWorld(J(raw)));
    const twice = J(normalizeWorld(J(once)));
    const thrice = J(normalizeWorld(J(twice)));
    assert.deepStrictEqual(thrice, twice);
    // 首轮 → 次轮唯一的差异 = 迁移事件点补上 evtype:battle
    const e1 = (once.nodes as { id: string }[]).findIndex(n => n.id === "e1");
    once.nodes[e1].evtype = "battle";
    assert.deepStrictEqual(once, twice);
  });
  it("部队航点按日戳升序，稳定排序保留同刻相对顺序", () => {
    const w = normalizeWorld({ meta: {}, nodes: [], units: [{ id: "u", kind: "inf",
      track: [{ t: 3, tag: "c" }, { t: 1, tag: "a" }, { t: 3, tag: "d" }, { t: 2, tag: "b" }] }] });
    assert.deepStrictEqual(w.units[0].track.map(p => (p as { tag?: string }).tag), ["a", "b", "c", "d"]);
  });
  it("防御过滤：剔除数组里的非对象成员（否则 activeAt/sort/渲染对 null 崩）", () => {
    // 加载他人分享的坏档：各数组混入 null/标量；normalize 后应只剩合法对象成员，且不抛
    const w = normalizeWorld({
      meta: {},
      nodes: [null, { id: "a", type: "city", lon: 1, lat: 2, owners: [null, { faction: "f" }], ops: [null, { kind: "attack", pts: [[1, 2], [3, 4]] }] }, 42],
      edges: [null, { from: "a", to: "a", type: "road" }],
      units: [{ id: "u", kind: "inf", track: [null, { t: 1, lon: 0, lat: 0 }, "x"] }],
      factions: [{ id: "f", paint: [null, { cells: [null, [1, 2]] }] }],
      terrainOverrides: [null, { lon: 1, lat: 2, t: "water" }],
      heightOverrides: [null, { lon: 1, lat: 2, dh: 0.1 }]
    });
    assert.deepStrictEqual(w.nodes.map(n => n.id), ["a"], "非对象地点被剔除");
    assert.strictEqual(w.nodes[0].owners!.length, 1);
    assert.strictEqual(w.nodes[0].ops!.length, 1);
    assert.strictEqual(w.edges.length, 1);
    assert.strictEqual(w.units[0].track.length, 1, "非对象航点被剔除");
    assert.strictEqual(w.factions[0].paint!.length, 1);
    assert.deepStrictEqual(w.factions[0].paint![0].cells, [[1, 2]], "非数组格被剔除");
    assert.strictEqual(w.terrainOverrides.length, 1);
    assert.strictEqual(w.heightOverrides!.length, 1);
  });
  it("防御过滤：heightOverrides 非数组则删键（保持旧档不落多余空键）", () => {
    assert.ok(!("heightOverrides" in normalizeWorld({ meta: {}, heightOverrides: "x" })));
    assert.ok(!("heightOverrides" in normalizeWorld({ meta: {} })), "本无此键者规范化后仍无");
  });
  it("自由画河 pts：合法折线保留、非法坐标剔除、不足 2 点删键；旧 from/to 边不受影响", () => {
    const w = normalizeWorld({ meta: {}, edges: [
      { type: "river", pts: [[100, 30], [105, 31], [110, 33]] },
      { type: "river", pts: [[1, 2], ["x", 3], [4, 5], [6, "y"]] },   // 非法坐标行剔除 → 剩 2 点
      { type: "river", pts: [[1, 2]] },                                // 不足 2 点 → 删键
      { type: "road", from: "a", to: "b" }                             // 经典边无 pts
    ] });
    assert.deepStrictEqual(w.edges[0].pts, [[100, 30], [105, 31], [110, 33]]);
    assert.deepStrictEqual(w.edges[1].pts, [[1, 2], [4, 5]]);
    assert.ok(!("pts" in w.edges[2]), "不足 2 点应删键");
    assert.ok(!("pts" in w.edges[3]) && w.edges[3].from === "a", "经典边不受影响");
  });
  it("作战线 ops[].pts：非法坐标剔除、有效点不足 2 剔整条（渲染/拾取对 null 成员会崩）", () => {
    const w = normalizeWorld({ meta: {}, nodes: [{ id: "e", type: "event", lon: 1, lat: 2, ops: [
      { kind: "attack", pts: [[100, 30], null, [110, 33], ["x", 1]] },   // 剔 2 个非法成员 → 剩 2 点保留
      { kind: "defense", pts: [[1, 2], null] },                          // 有效点不足 2 → 整条剔除
      { kind: "attack", pts: 7 }                                         // pts 非数组 → 剔除（旧行为）
    ] }] });
    assert.strictEqual(w.nodes[0].ops!.length, 1);
    assert.deepStrictEqual(w.nodes[0].ops![0].pts, [[100, 30], [110, 33]]);
  });
  it("assets（自定义印章）：合法保留、非法/空删键；旧档无此键仍无", () => {
    const w = normalizeWorld({ meta: {}, assets: [
      { id: "s1", src: "data:x", w: 10, h: 10 },
      { id: "s2" },              // 缺 src → 剔
      "junk"                     // 非对象 → 剔
    ] });
    assert.strictEqual((w.assets || []).length, 1);
    assert.strictEqual(w.assets![0].id, "s1");
    assert.ok(!("assets" in normalizeWorld({ meta: {}, assets: [] })), "空数组删键");
    assert.ok(!("assets" in normalizeWorld({ meta: {} })), "本无此键仍无");
    assert.ok(!("assets" in normalizeWorld({ meta: {}, assets: "x" })), "非数组删键");
  });
  it("v0.9 events 迁移：转事件点、字段删除、同 id 不重复迁移", () => {
    const w = normalizeWorld({ meta: {}, nodes: [{ id: "n1", type: "city", lon: 10, lat: 20 }],
      events: [{ id: "e1", at: "n1", year: 3000 }, { id: "e1", at: "n1", year: 3001 }] });
    assert.ok(!("events" in w));
    const evs = w.nodes.filter(n => n.type === "event");
    assert.strictEqual(evs.length, 1);
    assert.strictEqual(evs[0].year, 3000);
    assert.strictEqual(evs[0].lon, 10.4);
  });
  it("blankWorld：说明/版本固定，视角落 bbox 中心，auto 才带种子", () => {
    const bb = { lonMin: 100, lonMax: 120, latMin: 20, latMax: 40 };
    const a = blankWorld({ 名称: "甲", worldModel: "sphere", planetRadiusKm: 10000, terrain: "auto", genSeed: 7, genStyle: "continent", bbox: bb }, "2026-07-04");
    assert.strictEqual(a.meta.更新, "2026-07-04");
    assert.strictEqual(a.meta.view!.lon0, 110);
    assert.strictEqual(a.meta.genSeed, 7);
    const b = blankWorld({ 名称: "乙", worldModel: "sphere", planetRadiusKm: 10000, terrain: "sample", bbox: bb }, "2026-07-04");
    assert.ok(!("genSeed" in b.meta));
  });
  it("countsOf：事件点不计入地点数；战术图带 ⚔ 徽标与部队数", () => {
    assert.deepStrictEqual(countsOf({ nodes: [{ type: "city" }, { type: "event" }], factions: [] }), { nodes: 1, events: 1, factions: 0 });
    assert.deepStrictEqual(countsOf({ meta: { mapKind: "tactical" }, nodes: [], units: [{}, {}] }), { nodes: 0, events: 0, factions: 0, tac: 1, units: 2 });
  });
  it("safeName 不产非法文件名字符", () => {
    assert.ok(!/[\/:*?"<>|\n\r\t]/.test(safeName('战/图:第"一"卷')));
    assert.strictEqual(safeName(undefined), "未命名");
  });
});

describe("存档校验 validateWorld", () => {
  it("最小有效世界 ok，无警告", () => {
    const r = validateWorld({ meta: {}, nodes: [] });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.warnings, []);
  });
  it("旧版导入门槛：非对象 / 无 meta / nodes 非数组 = fatal", () => {
    for (const bad of [null, [], "x", { nodes: [] }, { meta: {} }, { meta: {}, nodes: "x" }])
      assert.strictEqual(validateWorld(bad).ok, false, JSON.stringify(bad));
  });
  it("数组成员不是对象 = fatal（打开即崩的结构）", () => {
    const r = validateWorld({ meta: {}, nodes: [null] });
    assert.strictEqual(r.ok, false);
    assert.match(r.fatal[0].path, /nodes\[0\]/);
    assert.strictEqual(validateWorld({ meta: {}, nodes: [], units: [3] }).ok, false);
    assert.strictEqual(validateWorld({ meta: {}, nodes: [], events: ["x"] }).ok, false);
  });
  it("悬空引用/未知类型/坏时段 = 仅警告，不拦截打开", () => {
    const r = validateWorld({ meta: {}, factions: [{ id: "f1", color: "红" }],
      nodes: [{ id: "a", type: "city", lon: 1, lat: 2, faction: "没有" }, { id: "a", type: "怪", lon: NaN, lat: 2, since: "三千年" }],
      edges: [{ from: "a", to: "无", type: "路" }] });
    assert.strictEqual(r.ok, true);
    const text = r.warnings.map(i => i.path + i.msg).join("|");
    for (const frag of ["color", "没有", "重复", "无效", "since", "edges[0].to", "edges[0].type"])
      assert.ok(text.includes(frag), `应含警告片段 ${frag}：${text}`);
  });
  it("作战线坏成员/坏折线 = 仅警告（normalize 剔除后照常打开）", () => {
    const r = validateWorld({ meta: {}, nodes: [{ id: "e", type: "event", lon: 1, lat: 2,
      ops: [{ kind: "attack", pts: [[1, 2], null] }, null, { kind: "attack", pts: [[1, 2], [3, 4]] }] }] });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.warnings.filter(i => i.path.includes(".ops[")).length, 2, "坏折线+非对象成员各 1 条；合法 op 不受累");
  });
  it("红线：normalizeWorld 能整形的输入绝不报 fatal", () => {
    for (const fixable of [{ meta: "x", nodes: [] }, { meta: {}, nodes: [], factions: "坏", events: { 不是: "数组" } }])
      assert.strictEqual(validateWorld(fixable).ok, true, JSON.stringify(fixable));
  });
  it("真史示例世界：零 fatal（井陉之战战术图）", () => {
    const sample = JSON.parse(readFileSync(new URL("../../井陉之战-战术.json", import.meta.url), "utf8"));
    assert.deepStrictEqual(validateWorld(sample).fatal, []);
  });
  it("量级闸：超大数组 / 超大 bbox 跨度 = fatal（防损坏或恶意分享档冻结）", () => {
    const huge = new Array(200001).fill({ id: "x", type: "city", lon: 1, lat: 2 });
    assert.strictEqual(validateWorld({ meta: {}, nodes: huge }).ok, false, "20 万+地点应 fatal");
    assert.strictEqual(validateWorld({ meta: { bbox: { lonMin: 0, lonMax: 9000, latMin: 0, latMax: 1 } }, nodes: [] }).ok, false, "经度跨度过大应 fatal");
    // 正常量级（数千地点、±180/±85）不受影响
    assert.strictEqual(validateWorld({ meta: { bbox: { lonMin: -180, lonMax: 180, latMin: -85, latMax: 85 } },
      nodes: new Array(5000).fill({ id: "x", type: "city", lon: 1, lat: 2 }) }).ok, true);
  });
});

describe("时段显示 fmtWhenRange（同刻合并/同日压缩）", () => {
  const E = calOf({ kind: "earth" }), C = calOf();
  it("起止同刻只写一遍；同日不同刻＝日期一遍+时刻区间", () => {
    const d = tacT(E, -204, 10, 20);   // 公元前205年10月20日
    assert.strictEqual(fmtWhenRange(E, true, d, d), "公元前205年10月20日");
    assert.strictEqual(fmtWhenRange(E, true, d + 6 / 24, d + 10 / 24), "公元前205年10月20日 06:00–10:00");
    assert.strictEqual(fmtWhenRange(E, true, d, d + 6 / 24), "公元前205年10月20日 00:00–06:00");
    const c = tacT(C, 3107, 3, 7);
    assert.strictEqual(fmtWhenRange(C, true, c + 0.5, c + 13 / 24), "SE3107·三月初七·午正–未初");
  });
  it("跨日/战略年/缺省侧＝原样区间", () => {
    const d = tacT(E, -204, 10, 20);
    assert.strictEqual(fmtWhenRange(E, true, d, d + 1), "公元前205年10月20日–公元前205年10月21日");
    assert.strictEqual(fmtWhenRange(C, false, 3100, 3200), "SE3100–SE3200");
    assert.strictEqual(fmtWhenRange(C, false, null, 3200), "…–SE3200");
    assert.strictEqual(fmtWhenRange(E, true, d + 0.25, null), "公元前205年10月20日 06:00–…");
  });
});

describe("拾取图层门（绘制与拾取同源，防隐形可选）", () => {
  const cam: Camera = { lon0: 100, lat0: 30, degPerPx: 0.1, w: 800, h: 600, flat: false };   // 屏幕中心=(400,300)
  const mkWorld = (nodes: Partial<WorldNode>[]): World => ({
    meta: {}, factions: [], edges: [], decor: [], terrainOverrides: [], units: [],
    nodes: nodes.map((n, i) => ({ id: "n" + i, lon: 100, lat: 30, type: "city", ...n })) as WorldNode[]
  });
  const pick = (w: World, opts?: Parameters<typeof pickNode>[6]) => pickNode(cam, w.meta, w, 3107, 400, 300, opts);
  it("图层门：nodes 总门/事件·标注子门关了不拾取（编辑态同样生效）", () => {
    const w = mkWorld([{ type: "city" }]);
    assert.strictEqual(pick(w, { editing: true })!.id, "n0");
    assert.strictEqual(pick(w, { editing: true, layers: { nodes: false } }), null);
    const we = mkWorld([{ type: "event", evtype: "battle", year: 3107 }]);
    assert.strictEqual(pick(we, { editing: true, layers: { events: false } }), null);
    const wl = mkWorld([{ type: "label", 名称: "注" }]);
    assert.strictEqual(pick(wl, { editing: true, layers: { notes: false } }), null);
    assert.strictEqual(pick(wl, { editing: true })!.id, "n0");
  });
  it("pin 屏幕角标注：画布一律不可点选（锚点隐形；经搜索/撤销管理）", () => {
    const w = mkWorld([{ type: "label", 名称: "帧题", pin: "nw" }]);
    assert.strictEqual(pick(w, { editing: true }), null);
    assert.strictEqual(pick(w, {}), null);
  });
  it("rank 缩放门：浏览态按显隐拾取，编辑态全见（与 drawNodes 同规）", () => {
    const w = mkWorld([{ type: "village" }]);              // rank4：degPerPx 0.1 > 0.045 = 浏览不可见
    assert.strictEqual(pick(w, {}), null, "浏览态隐藏的乡村不可点");
    assert.strictEqual(pick(w, { editing: true })!.id, "n0", "编辑态全部地点可见=可点");
    assert.strictEqual(pick(mkWorld([{ type: "capital" }]), {})!.id, "n0", "都城 rank0 恒可见");
  });
  it("nodesInBox 同一套门：隐形对象不被框进批量删", () => {
    const w = mkWorld([{ type: "city" }, { type: "village" }, { type: "label", 名称: "题", pin: "se" }]);
    assert.deepStrictEqual(nodesInBox(cam, w.meta, w, 3107, 380, 280, 420, 320, { editing: true }).sort(), ["n0", "n1"]);
    assert.deepStrictEqual(nodesInBox(cam, w.meta, w, 3107, 380, 280, 420, 320, {}), ["n0"], "浏览态 rank 隐藏的乡村不入框");
    assert.deepStrictEqual(nodesInBox(cam, w.meta, w, 3107, 380, 280, 420, 320, { editing: true, layers: { nodes: false } }), []);
  });
});

describe("战术图生成（快照烘焙）", () => {
  const srcWorld = (): World => ({
    meta: { 名称: "母图", worldModel: "sphere", planetRadiusKm: 10000, terrain: "sample", calendar: { months: 12, dpm: 30 }, vault: "V", kmPerDeg: 111 },
    factions: [
      { id: "fa", 名称: "甲", color: "#a00" },
      { id: "fb", 名称: "乙", color: "#00a", since: 3200 },                                     // yr=3107 未存续
      { id: "fp", 名称: "丙", color: "#0a0", paint: [
        { cells: [[10, 10]], since: 3100, until: 3110 }, { cells: [[20, 20]], since: 3120 }]     // 仅第一层当年生效
      }
    ],
    nodes: [
      { id: "in1", 名称: "城A", type: "city", lon: 112.0, lat: 34.5, faction: "fa", since: 3000, until: 3200,
        owners: [{ faction: "fa", until: 3105 }, { faction: "fp", since: 3105 }] },              // yr=3107 归 fp
      { id: "in2", 名称: "城B", type: "town", lon: 112.2, lat: 34.4 },
      { id: "out", 名称: "远城", type: "city", lon: 120.0, lat: 40.0, faction: "fa" },
      { id: "gone", 名称: "废城", type: "city", lon: 112.1, lat: 34.5, until: 3050 },
      { id: "evX", 名称: "旁役", type: "event", evtype: "battle", lon: 112.05, lat: 34.5, year: 3107 }
    ],
    edges: [{ from: "in1", to: "in2", type: "road", since: 3000 }, { from: "in1", to: "out", type: "road" }],
    decor: [{ id: "d1", lon: 112.0, lat: 34.5, kind: "tree" }, { id: "d2", lon: 120.0, lat: 40.0, kind: "pine" }],
    terrainOverrides: [
      { id: undefined, lon: 112.0, lat: 34.5, t: "mountain" } as never,                          // 无 step → 应补 1
      { lon: 112.1, lat: 34.5, t: "water", step: 1 }, { lon: 120.0, lat: 40.0, t: "forest" }
    ],
    units: []
  });
  const ev = { id: "evHL", 名称: "会战", type: "event", evtype: "battle", lon: 112.0, lat: 34.5, year: 3107 } as WorldNode;

  it("meta：mapKind/battleYear/tacSpan/parent/名称/继承字段/view", () => {
    const w = createTacticalWorld(srcWorld(), ev, 200, { parentMapId: "m1", today: "2026-07-05" });
    assert.strictEqual(w.meta.mapKind, "tactical");
    assert.strictEqual(w.meta.battleYear, 3107);
    assert.deepStrictEqual(w.meta.tacSpan, [3107 * 360, 3108 * 360 - 1]);
    assert.strictEqual(w.meta.名称, "会战·战术");
    assert.deepStrictEqual(w.meta.parent, { map: "m1", mapName: "母图", event: "evHL", eventName: "会战" });
    assert.strictEqual(w.meta.worldModel, "sphere");
    assert.strictEqual(w.meta.terrain, "sample");
    assert.strictEqual(w.meta.planetRadiusKm, 10000);
    assert.strictEqual(w.meta.kmPerDeg, 111);
    assert.strictEqual(w.meta.vault, "V");
    assert.deepStrictEqual(w.meta.calendar, { months: 12, dpm: 30 });
    assert.strictEqual(w.meta.更新, "2026-07-05");
    assert.strictEqual(w.meta.view!.lon0, 112.0);
    assert.strictEqual(w.meta.view!.lat0, 34.5);
    assert.ok(w.meta.view!.degPerPx0! > 0);
    assert.deepStrictEqual(w.units, []);
  });
  it("高程涂改与起伏随烘焙继承（bbox 内当年、step 补 1、时段剥离）", () => {
    const src = srcWorld();
    src.meta.relief = 0.7; src.meta.elevUnitM = 1500; src.meta.contourM = 100;
    src.heightOverrides = [
      { lon: 112.0, lat: 34.5, dh: 0.2 },                    // 带入，step 补 1
      { lon: 120.0, lat: 40.0, dh: 0.3 },                    // 出界剔除
      { lon: 112.1, lat: 34.4, dh: 0.1, until: 3050 }        // 当年失效剔除
    ];
    const w = createTacticalWorld(src, ev, 200, {});
    assert.deepStrictEqual(w.heightOverrides, [{ lon: 112.0, lat: 34.5, dh: 0.2, step: 1 }]);
    assert.strictEqual(w.meta.relief, 0.7);
    assert.strictEqual(w.meta.elevUnitM, 1500);
    assert.strictEqual(w.meta.contourM, 100);
  });
  it("earth 历法母图：calendar 原样继承、tacSpan=当年 JDN、说明用公元纪年", () => {
    const src = srcWorld();
    src.meta.calendar = { kind: "earth" };
    const w = createTacticalWorld(src, { ...ev, year: 1863 } as WorldNode, 200, {});
    const E = calOf({ kind: "earth" });
    assert.deepStrictEqual(w.meta.calendar, { kind: "earth" });
    assert.strictEqual(w.meta.battleYear, 1863);
    assert.deepStrictEqual(w.meta.tacSpan, [tacT(E, 1863, 1, 1), tacT(E, 1864, 1, 1) - 1]);
    assert.ok(String(w.meta.说明).includes("公元1863"));
  });
  it("地点：出界/失效/事件点剔除，归属沿革烘焙为当年归属，since/until/owners 剥离", () => {
    const w = createTacticalWorld(srcWorld(), ev, 200, {});
    assert.deepStrictEqual(w.nodes.map(n => n.id), ["in1", "in2"], "出界(out)/失效(gone)/事件点(evX)不带入");
    const in1 = w.nodes[0];
    assert.strictEqual(in1.faction, "fp", "owners 沿革烘焙为 yr=3107 当年归属");
    assert.ok(!("owners" in in1), "owners 键剥离");
    assert.ok(!("since" in in1) && !("until" in in1), "存在时段剥离");
    assert.ok(!("faction" in w.nodes[1]), "无归属者不留 faction 键");
  });
  it("连线：仅两端都在的当年连线；布景/涂改按 bbox+当年，涂改补 step；派系按存续+涂域烘焙", () => {
    const w = createTacticalWorld(srcWorld(), ev, 200, {});
    assert.strictEqual(w.edges.length, 1, "一端出界的连线剔除");
    assert.ok(!("since" in w.edges[0]));
    assert.deepStrictEqual(w.decor.map(d => d.id), ["d1"], "出界布景剔除");
    assert.strictEqual(w.terrainOverrides.length, 2, "出界涂改剔除");
    assert.strictEqual(w.terrainOverrides[0].step, 1, "无 step 的涂改补 1（战略粗块）");
    assert.deepStrictEqual(w.factions.map(f => f.id), ["fa", "fp"], "未存续派系(fb)剔除");
    const fp = w.factions.find(f => f.id === "fp")!;
    assert.strictEqual(fp.paint!.length, 1, "仅当年生效涂域层(空层保留=不回退据点凸包)");
    assert.deepStrictEqual(fp.paint![0].cells, [], "出战场 bbox 的涂域格随重采样剔除");
    assert.ok(!("since" in fp.paint![0]), "涂域层时段剥离");
    assert.ok(!("paint" in w.factions.find(f => f.id === "fa")!), "无涂域者不留 paint 键");
  });
  it("涂域重采样：战略粗格在战术图铺满为细格块，且与渲染解码链连成单一色块", () => {
    const src = srcWorld();
    // [112.25,34.25]=DEFAULT_BBOX 0.5° 网格的合法格心（战场内）；[10,10]=出界格
    src.factions.push({ id: "fq", 名称: "丁", color: "#440", paint: [{ cells: [[112.25, 34.25], [10, 10]] }] });
    const w = createTacticalWorld(src, ev, 200, {});
    const bb = w.meta.bbox!;
    const cells = w.factions.find(f => f.id === "fq")!.paint![0].cells;
    // 源格块 [112.0,112.5)×[34.0,34.5)，战术 pd=paintStep(bbox)≈0.05 → 约 (0.5/pd)² 个细格
    const pd = paintStep(w.meta);
    const n1 = Math.round(0.5 / pd);
    assert.ok(cells.length >= (n1 - 1) ** 2 && cells.length <= (n1 + 1) ** 2, `粗格应铺满 ≈${n1}² 细格，得 ${cells.length}`);
    for (const [x, y] of cells) {
      assert.ok(x >= 112.0 && x < 112.5 && y >= 34.0 && y < 34.5, `细格心应落在源格块内：${x},${y}`);
      assert.ok(x >= bb.lonMin && x <= bb.lonMax && y >= bb.latMin && y <= bb.latMax, `细格心应在战场 bbox 内：${x},${y}`);
    }
    // 与 overlay 同一条解码链：重采样后应连成单一边界环（修前=每个粗格只亮一个孤立细格的碎点）
    assert.strictEqual(territoryLoops(cells, bb, 0, pd).length, 1, "应为单一连续色块");
  });
  it("resamplePaintCells：粗→细铺满、细→粗格心采样、同网格等值往返、空入空出", () => {
    const srcBB = { lonMin: 0, lonMax: 10, latMin: 0, latMax: 10 };
    // 粗→细：源 1° 格 [2,3)×[3,4) → 目标 0.5° 网格（bbox 2..4×3..5）内的 4 个格心
    assert.deepStrictEqual(
      resamplePaintCells([[2.5, 3.5]], srcBB, 1, { lonMin: 2, lonMax: 4, latMin: 3, latMax: 5 }, 0.5),
      [[2.25, 3.25], [2.75, 3.25], [2.25, 3.75], [2.75, 3.75]]);
    // 细→粗：目标格心 (2.5,2.5) 不在细格 [2,2.5) 内=不亮；在 [2.5,3) 内=亮（分辨率损失语义）
    assert.deepStrictEqual(resamplePaintCells([[2.25, 2.25]], srcBB, 0.5, srcBB, 1), []);
    assert.deepStrictEqual(resamplePaintCells([[2.75, 2.75]], srcBB, 0.5, srcBB, 1), [[2.5, 2.5]]);
    // 同 bbox 同 pd：等值往返（格心归一）
    assert.deepStrictEqual(resamplePaintCells([[2.5, 3.5]], srcBB, 1, srcBB, 1), [[2.5, 3.5]]);
    assert.deepStrictEqual(resamplePaintCells([], srcBB, 1, srcBB, 1), []);
    assert.deepStrictEqual(resamplePaintCells(undefined, srcBB, 1, srcBB, 1), []);
  });
  it("tacDiaDeg：球面按半径/纬度、平面按 kmPerDeg 均分", () => {
    const s = tacDiaDeg({ worldModel: "sphere", planetRadiusKm: 10000 }, 200, 30);
    assert.ok(Math.abs(s.latSpan - 200 / (2 * Math.PI * 10000 / 360)) < 1e-9);
    assert.ok(Math.abs(s.lonSpan - s.latSpan / Math.cos(30 * Math.PI / 180)) < 1e-9);
    const f = tacDiaDeg({ worldModel: "flat", kmPerDeg: 100 }, 200, 30);
    assert.ok(Math.abs(f.lonSpan - 2) < 1e-9 && Math.abs(f.latSpan - 2) < 1e-9);
  });
});
