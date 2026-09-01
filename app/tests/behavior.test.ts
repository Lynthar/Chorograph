/* 行为意图测试：不对照黄金基准，而是把各模块"该是什么语义"直接写成断言
  （历法进退位、时段区间开闭、投影可逆、地形确定性等）——平价测试防漂移，这里防"两边一起错"。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calOf, fmtDayTime, fmtMD, fmtT, fmtWhenRange, fmtYMD, fmtYear, fmtYearForm, fromT, monthLabel, monthsOf, parseYMD, parseYearForm, tacT, yearMonthOf, yearMonthT, yearSpanT, ymdOverflow } from "../src/core/calendar.ts";
import { distKm, haversine, kmPerDeg, kmPerDegLat, wrapLon } from "../src/core/geo.ts";
import { chaikin, chaikinOpen, convexHull, edgeLenKm, meander, pointInPoly, polylineKm, segIntersectsRect } from "../src/core/geometry.ts";
import { genTerrainAt, seedTerrain } from "../src/core/terrain.ts";
import { activeAt, evCurrentAt, evFutureAt, opVisibleAt, ownerAt, paintLayersAt, strategicExtent, yearRangeOf } from "../src/core/time.ts";
import { buildElevField, contourStepFor, elevBilinear, elevSmooth, elevUnitM, heightStepM } from "../src/core/elev.ts";
import { STRAT_GRID_MAX, autoGridN, buildGridCells, gridStepDeg, roadCellSet, type Grid } from "../src/core/grid.ts";
import { BRUSH_NOTCHES, brushActualKm, brushDabStepDeg, brushNominalKm, brushRadiusCells, brushStepDeg, fmtBrushKm, interpolatePath } from "../src/core/brush.ts";
import { ELEV } from "../src/core/constants.ts";
import { clampView, minDegPerPx, minDppFor, project, unproject, type Camera } from "../src/core/projection.ts";
import { esc, errText, fmtKm, hexA, parseKV, safeName } from "../src/core/util.ts";
import { ARM_OPT_KINDS, EDGE_STYLE, LEGACY_KIND, NODE_CATS, NODE_CAT_ORDER, NODE_STYLE, NODE_TMPL, NODE_TYPES, TERRAIN, TERRAIN_ORDER, UNIT_KINDS, armOptional, certaintyStyle, flattenTerrain, isValidTerrain, nodeCatOf, parseComposite, terrainProps } from "../src/core/constants.ts";
import { fmtStrength, parseStrength, setUnitPoint, unitInheritedAt, unitLegs, unitMoraleAt, unitPos, unitSpeedAt, unitStrengthAt } from "../src/core/units.ts";
import { astar, computeRoute } from "../src/core/route.ts";
import { wallTeeth } from "../src/render/edges.ts";
import { planTile, tileCovers } from "../src/render/terrainCPU.ts";
import { blankWorld, clampWorldBBox, countsOf, normalizeWorld, WORLD_KM_PER_DEG, WORLD_RADIUS_KM } from "../src/core/world.ts";
import { BAKE_CAP, blankTacticalWorld, createTacticalWorld } from "../src/core/tactical.ts";
import { eachPaintCenter, paintCellSet, paintDims, paintStep, resamplePaintRuns, territoryLoops } from "../src/core/territory.ts";
import { layerOn, nodesInBox, pickEdge, pickNode, pinnedStackH } from "../src/render/overlay.ts";
import { DECOR_CAP, decorSizePx, drawDecor, pickDecor } from "../src/render/decor.ts";
import { legendItems } from "../src/render/legend.ts";
import { FX, MICRO_F0, decoGate, materialFor, materialTable, octaveGate, snowEOf } from "../src/render/material.ts";
import { allComposites } from "../src/core/constants.ts";
import { poolInsert } from "../src/ui/stamps.ts";
import type { Meta, World, WorldNode } from "../src/core/types.ts";
import { validateWorld } from "../src/core/validate.ts";
import { existsSync, readFileSync } from "node:fs";

const close = (a: number, b: number, digits = 9) =>
  assert.ok(Math.abs(a - b) < 10 ** -digits, `${a} ≈ ${b} (±1e-${digits})`);

describe("历法", () => {
  const cal = calOf();       // 默认 12 月 × 30 日
  it("默认历法 360 日/年", () => assert.strictEqual(cal.dpy, 360));
  it("日戳往返：任意年月日 → T → 同一年月日", () => {
    for (const [y, m, d] of [[0, 1, 1], [3107, 3, 7], [3107, 12, 30], [1, 6, 15]] as const)
      assert.deepStrictEqual(fromT(cal, tacT(cal, y, m, d)), { y, m, d });
  });
  it("月日文本 fmtMD：两轨同式「3月7日」，配了月名走月名", () => {
    assert.strictEqual(fmtMD(cal, 3, 7), "3月7日");
    assert.strictEqual(fmtMD(cal, 12, 30), "12月30日");
    assert.strictEqual(fmtMD(calOf({ kind: "earth" }), 7, 1), "7月1日");
    assert.strictEqual(fmtMD(calOf({ months: 3, dpm: 10, monthNames: ["霜月"] }), 1, 3), "霜月3日");
  });
  it("fmtT 日期格式", () => assert.strictEqual(fmtT(cal, tacT(cal, 3107, 3, 7)), "SE3107·3月7日"));
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
  it("ymdOverflow：月/日越界只回执不拦截（parseYMD 的进位语义被黄金基准锁定，不能动）", () => {
    // 未越界/未显式给月日 → 不报（「3107」＝正月初一是简写不是错）
    for (const s of ["3107-3-7", "3107", "3107-3", "3107.3.7", "3107年3月7日", "3-7", "99-1-1日", "abc", ""])
      assert.strictEqual(ymdOverflow(cal, s), null, `不该报越界：${JSON.stringify(s)}`);
    // 越界 → 回执归一后的显示串（正是 parseYMD 静默进位到的那个值）
    assert.strictEqual(ymdOverflow(cal, "3107-13-1"), "3108-1-1");
    assert.strictEqual(ymdOverflow(cal, "3107-3-31"), "3107-4-1");
    assert.strictEqual(ymdOverflow(cal, "3107-99-99"), "3115-6-9", "差出 8 年，正是要说出来的那种");
    assert.strictEqual(ymdOverflow(cal, "3107-0-0"), "3107-1-1", "0 月 0 日按 tacT 的 max(1,·) 归一");
    assert.strictEqual(ymdOverflow(cal, "3107-13-1 12:00"), "3108-1-1 12:00", "时刻随回执带出");
    // 回执与 parseYMD 同源：报什么就真存什么
    for (const s of ["3107-13-1", "3107-99-99", "3107-0-0"])
      assert.strictEqual(ymdOverflow(cal, s), fmtYMD(cal, parseYMD(cal, s)!));
    // 公历按真实月长（闰年规则生效），1582 儒略/格里空档同样回执
    const E = calOf({ kind: "earth" });
    assert.strictEqual(ymdOverflow(E, "1815-6-18"), null);
    assert.strictEqual(ymdOverflow(E, "1815-2-30"), "1815-3-2");
    assert.strictEqual(ymdOverflow(E, "2000-2-29"), null, "闰年 2/29 合法");
    assert.strictEqual(ymdOverflow(E, "1900-2-29"), "1900-3-1", "1900 非闰年");
    assert.strictEqual(ymdOverflow(E, "1582-10-10"), "1582-10-20", "历史空档：那几天现实中不存在");
    assert.strictEqual(ymdOverflow(E, "1815-6-18 25:00"), null, "时刻越界已由 parseYMD 判 null，不重复报");
    // ⚠ 这一条锁的是「为什么不能在 core 拒绝越界」：golden 第 1 组就是 10 月历且样本含 3107-12-30
    const T10 = calOf({ months: 10, dpm: 36 });
    assert.strictEqual(ymdOverflow(T10, "3107-12-30"), "3108-2-30");
    assert.strictEqual(ymdOverflow(T10, "3107-10-36"), null, "该历法下 10 月 36 日是合法的");
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
  /* 战略图月粒度（2026-07-31）：年份取小数＝年 + (月-1)/月数。锁三件事——往返一致、
     整年输出逐字不变（黄金基准）、**不落月格的任意小数年原样保全**（parseFloat 是 custom 的历史现状，
     被月吸附即静默改值）。 */
  it("战略图月粒度：年-月 往返、整年逐字不变、任意小数年原样保全", () => {
    const C = calOf(), E = calOf({ kind: "earth" });
    assert.strictEqual(monthsOf(C), 12);
    assert.strictEqual(monthsOf(calOf({ months: 10, dpm: 36 })), 10, "custom 随历法配置");
    const march = yearMonthT(C, 3107, 3);
    assert.strictEqual(march, 3107 + 2 / 12);
    assert.deepStrictEqual(yearMonthOf(C, march), { y: 3107, m: 3 });
    assert.strictEqual(fmtYear(C, march), "SE3107·3月");
    assert.strictEqual(fmtYear(C, march, true), "SE 3107·3月");
    assert.strictEqual(fmtYearForm(C, march), "3107-3");
    assert.strictEqual(parseYearForm(C, "3107-3"), march);
    assert.strictEqual(parseYearForm(C, fmtYearForm(C, march)), march, "表单互逆");
    /* 公元前（天文纪年）：-215 年 8 月＝-214.4167，floor 仍取回 -215 */
    const bc8 = yearMonthT(E, -215, 8);
    assert.deepStrictEqual(yearMonthOf(E, bc8), { y: -215, m: 8 });
    assert.strictEqual(fmtYear(E, bc8), "公元前216年8月");
    assert.strictEqual(fmtYearForm(E, bc8), "前216-8");
    assert.strictEqual(parseYearForm(E, "前216-8"), bc8);
    assert.strictEqual(parseYearForm(E, "1863-7"), 1863.5);
    assert.strictEqual(fmtYear(E, 1863.5), "公元1863年7月");
    // 整年＝旧输出逐字不变
    assert.strictEqual(fmtYear(C, 3107), "SE3107");
    assert.strictEqual(fmtYearForm(C, 3107), "3107");
    assert.strictEqual(fmtYear(E, -215), "公元前216");
    // ⚠ 不落月格的小数年：显示与回填都原样，不吸附到最近的月
    assert.strictEqual(fmtYear(C, 3107.3), "SE3107.3");
    assert.strictEqual(fmtYearForm(C, 3107.3), "3107.3");
    assert.strictEqual(parseYearForm(C, "3107.5"), 3107.5, "小数点不是年月分隔符");
    // 越界月＝解析不出（不静默进位到次年）
    assert.strictEqual(parseYearForm(C, "3107-13"), null);
    assert.strictEqual(parseYearForm(calOf({ months: 10, dpm: 36 }), "3107-11"), null);
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

describe("历法·日内时刻（小数日戳：0=零时；一律「时:分」，进制由历法给）", () => {
  const C = calOf();
  it("custom fmtT/parse：整日无时刻后缀（旧输出不变），小数带时刻且互逆", () => {
    const T = tacT(C, 3107, 3, 7);
    assert.strictEqual(fmtT(C, T), "SE3107·3月7日");
    assert.strictEqual(fmtT(C, T + 0.5), "SE3107·3月7日 12:00");
    assert.strictEqual(parseYMD(C, "3107-3-7 12:00"), T + 0.5);
    assert.strictEqual(parseYMD(C, "3107-3-7 12:30"), T + 0.5 + 30 / 1440);
    assert.strictEqual(parseYMD(C, fmtYMD(C, T + 0.5)), T + 0.5);   // 表单互逆
  });
});

describe("高程场（buildElevField：起伏+涂改+标定）", () => {
  const MP = { worldModel: "sphere" as const, terrain: "plain" as const, gridN: 4,   // 4 列＝1°/格（历史默认；密度自 2026-08-12 改自动，夹具写死以免测的东西被密度带偏）
    bbox: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 } };
  it("全关=逐格 ELEV[类型]（旧渲染逐位不变）", () => {
    const g = buildGridCells(MP, [], 0);
    const f = buildElevField(MP, undefined, g, 0);
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++)
      assert.strictEqual(f[r * g.cols + c], Math.fround(ELEV[flattenTerrain(g.cells[r][c])]));   // cells 存复合、flatten 回旧类查 ELEV；Float32 存储精度
  });
  it("relief：确定性、同类型格间起伏、水域恒平、陆地不破类型地板", () => {
    const M = { worldModel: "sphere" as const, terrain: "sample" as const, genSeed: 7, relief: 1,
      bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 } };
    const g = buildGridCells(M, [], 3107);
    const f1 = buildElevField(M, undefined, g, 3107), f2 = buildElevField(M, undefined, g, 3107);
    assert.deepStrictEqual([...f1], [...f2], "同种子确定性");
    const mts: number[] = [];
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      const i = r * g.cols + c;
      if (g.cells[r][c] === "water") assert.strictEqual(f1[i], Math.fround(ELEV.water), "水域恒平");
      else {   // 地板随类型收敛：min(0.10, 自身基础)——沿海/沼泽的低地设计不被起伏钳抬。
        // 场存 Float32：地板同过 fround 再比（fround 单调 ⇒ 数学严格，无需容差；0.06 恰向下舍）
        assert.ok(f1[i] >= Math.fround(Math.min(0.1, terrainProps(g.cells[r][c]).elev)), "陆地不破类型地板");
        if (g.cells[r][c] === "mountain") mts.push(f1[i]);
      }
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
  it("钳制地板随类型收敛：开特性不动未涂改的沿海/沼泽低地；涂改格钳在 min(0.1, 自身基础)", () => {
    const tov = [{ lon: 100.5, lat: 30.5, t: "coast" }, { lon: 101.5, lat: 31.5, t: "plain/marsh" }];
    const g = buildGridCells(MP, tov, 3107);
    const at = (f: Float32Array, lon: number, lat: number) => f[Math.floor((lat - 30) / g.step) * g.cols + Math.floor((lon - 100) / g.step)];
    // 别处涂一笔高程 → 钳制通道启动：未涂改的沿海/沼泽保持基础值（原 bug：被全图统一抬到 0.10）
    const f = buildElevField(MP, [{ lon: 103.5, lat: 33.5, dh: 0.2 }], g, 3107);
    assert.strictEqual(at(f, 100.5, 30.5), Math.fround(ELEV.coast), "沿海 0.06 不动");
    assert.strictEqual(at(f, 101.5, 31.5), Math.fround(ELEV.marsh), "沼泽 0.03 不动");
    // 沿海下切 0.5：护栏仍在，钳在自身基础 0.06（而非通用地板 0.10）
    const f2 = buildElevField(MP, [{ lon: 100.5, lat: 30.5, dh: -0.5 }], g, 3107);
    close(at(f2, 100.5, 30.5), ELEV.coast, 6);
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

describe("事件三态判据（evCurrentAt / evFutureAt：细粒度时间轴上的当刻）", () => {
  const cal = calOf(undefined), M = monthsOf(cal);
  const mar = yearMonthT(cal, 3107, 3), jun = yearMonthT(cal, 3107, 6);

  it("整年/整日数据与旧的精确相等逐位等价（旧档零迁移）", () => {
    for (const [y, T] of [[3107, 3107], [3107, 3106], [3106, 3107], [-216, -216], [0, 0]] as const) {
      assert.strictEqual(evCurrentAt(y, T), y === T, `当刻 ${y} vs ${T}`);
      assert.strictEqual(evFutureAt(y, T), y > T, `未发生 ${y} vs ${T}`);
    }
  });

  it("整年事件 + 时间轴在月格＝仍是当年（战略图开月档后红圈与无时段作战线不再全灭）", () => {
    assert.strictEqual(evCurrentAt(3107, mar), true);
    assert.strictEqual(evCurrentAt(3107, jun), true);
    assert.strictEqual(evCurrentAt(3107, yearMonthT(cal, 3108, 1)), false, "跨到次年即不是当年");
  });

  it("带月事件 + 时间轴在整年＝当年且不淡显（粗档 Math.floor 后时间轴再也回不到那个小数年）", () => {
    assert.strictEqual(evCurrentAt(jun, 3107), true);
    assert.strictEqual(evFutureAt(jun, 3107), false, "同年不算未发生——否则永久灰着");
    assert.strictEqual(evFutureAt(jun, 3106), true);
    assert.strictEqual(evCurrentAt(jun, 3108), false);
    assert.strictEqual(evFutureAt(jun, 3108), false, "已过去");
  });

  it("战术图同规：日戳整数 + 时档小数时刻＝同日", () => {
    const D = 1118520;
    assert.strictEqual(evCurrentAt(D, D + 0.25), true, "06:00 拨到时仍是当日");
    assert.strictEqual(evCurrentAt(D + 0.25, D), true, "带时刻的事件在日档下也是当日");
    assert.strictEqual(evFutureAt(D + 0.25, D), false, "同日不算未发生");
    assert.strictEqual(evCurrentAt(D, D + 1), false);
  });

  it("两态互斥且三态闭合（当刻/未发生/已过去恰居其一）", () => {
    const ys = [3106, 3107, 3108, mar, jun, -216.5, -216, 0, 1118520.25];
    for (const y of ys) for (const T of ys) {
      const c = evCurrentAt(y, T), f = evFutureAt(y, T);
      assert.ok(!(c && f), `互斥失败 ${y} vs ${T}`);
      assert.strictEqual(Number(c) + Number(f) + Number(Math.floor(y) < Math.floor(T)), 1, `三态未闭合 ${y} vs ${T}`);
    }
  });

  it("无 year 恒否（未定时刻的事件既不当刻也不未发生）", () => {
    assert.strictEqual(evCurrentAt(undefined, 3107), false);
    assert.strictEqual(evFutureAt(undefined, 3107), false);
  });

  it("负年与全月遍历：月偏移恒为 [0,1) 非负分数，floor 取回原年", () => {
    for (const y of [-3000, -216, -1, 0, 1, 1863, 3107]) {
      for (let m = 1; m <= M; m++) {
        assert.strictEqual(evCurrentAt(yearMonthT(cal, y, m), y), true, `${y} 年 ${m} 月`);
        assert.strictEqual(evFutureAt(yearMonthT(cal, y, m), y), false, `${y} 年 ${m} 月不该判未发生`);
      }
    }
  });
});

describe("作战线时间维度（opVisibleAt：分相位箭头）", () => {
  const ev = { year: 3107 };
  it("无时段=事件当刻（同年/同日；整年整日数据与旧的精确相等逐位等价）", () => {
    assert.strictEqual(opVisibleAt(ev, {}, 3107), true);
    assert.strictEqual(opVisibleAt(ev, {}, 3106), false);
    /* ⚠ 有意的语义翻转（2026-08-02）：原断言为 false 且注为「时粒度下拖过整日刻，无时段线
       不显示」——那正是要修的失真本身（战略图开月档／战术图开时档，无时段作战线整条消失）。
       判据改走 evCurrentAt 后同年/同日恒显，改公式先过这一条。 */
    assert.strictEqual(opVisibleAt(ev, {}, 3107.5), true);
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
  it("fmtKm 两档", () => {
    assert.strictEqual(fmtKm(0.5), "500 m");
    assert.strictEqual(fmtKm(37.4), "37 km");
    assert.strictEqual(fmtKm(1234), "1234 km");
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
  it("防御过滤：无效 meta.bbox 剔键（消费方回退默认范围——validate 提示以此为实），合法者保留", () => {
    for (const bad of [42, "x", [], { lonMin: 1, lonMax: 0, latMin: 0, latMax: 1 },   // 序反
      { lonMin: 0, lonMax: 10, latMin: 5, latMax: 5 },                                 // 退化（min=max）
      { lonMin: NaN, lonMax: 10, latMin: 0, latMax: 5 }, { lonMin: "a", lonMax: 10, latMin: 0, latMax: 5 }])
      assert.ok(!("bbox" in normalizeWorld({ meta: { bbox: bad } }).meta), `无效 bbox 应剔键：${JSON.stringify(bad)}`);
    const ok = { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 };
    assert.deepStrictEqual(normalizeWorld({ meta: { bbox: { ...ok } } }).meta.bbox, ok, "合法 bbox 原样保留");
    assert.ok(!("bbox" in normalizeWorld({ meta: {} }).meta), "本无此键者规范化后仍无");
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
  it("物理标定（2026-08 审查修正）：非正的半径/每度里程——validate 提示、normalize 剔键回默认", () => {
    const r = validateWorld({ meta: { planetRadiusKm: -6371, kmPerDeg: Infinity }, nodes: [] });
    assert.strictEqual(r.ok, true, "旧档无损红线：只提示不拒开");
    assert.strictEqual(r.warnings.filter(i => i.path === "meta.planetRadiusKm" || i.path === "meta.kmPerDeg").length, 2);
    const w = normalizeWorld({ meta: { planetRadiusKm: -6371, kmPerDeg: Infinity }, nodes: [] });
    assert.ok(!("planetRadiusKm" in w.meta) && !("kmPerDeg" in w.meta), "无效值剔键");
    assert.ok(distKm(w.meta, 0, 0, 1, 0) > 0, "剔键后距离按默认半径、恒为正");
    const ok = normalizeWorld({ meta: { planetRadiusKm: 6371, kmPerDeg: 111 }, nodes: [] });
    assert.strictEqual(ok.meta.planetRadiusKm, 6371, "合法值原样保留");
    assert.strictEqual(ok.meta.kmPerDeg, 111);
  });
  it("heightOverrides 成员字段提示：非数字 lon/lat/dh 报 warning（应用端自会跳过，不 fatal）", () => {
    const r = validateWorld({ meta: {}, nodes: [],
      heightOverrides: [{ lon: 1, lat: 2, dh: 0.5 }, { lon: "x", lat: 2, dh: 0.5 }, { lon: 1, lat: 2 }] });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.warnings.filter(i => i.path.startsWith("heightOverrides")).length, 2, "坏成员各报一条；合法项不受累");
  });
  /* ⚠ 仓库根的示例战术图属**使用产物**，会被作者删掉重做（2026-08-20 三张即如此）——
     故这条把关做成「文件在就验、不在就跳过」：新图放回原名即自动恢复把关，不必回来改测试。 */
  it("真史示例世界：零 fatal（井陉之战战术图）", (t) => {
    const f = new URL("../../井陉之战-战术.json", import.meta.url);
    if (!existsSync(f)) return t.skip("示例图不在（重做中）");
    assert.deepStrictEqual(validateWorld(JSON.parse(readFileSync(f, "utf8"))).fatal, []);
  });
  /* 原型键名对抗（2026-08）：查表的键名也是用户数据。`k in TABLE` / `TABLE[k] || 缺省` 沿原型链
     取得到 toString/constructor/__proto__ 这些继承成员，于是校验说「认识这个键」、缺省又兜不住
     （函数是真值）。现有测试只锁了「normalize 能整形 ⇒ 不 fatal」这一个方向，缺的正是反向性质：
     **校验说 ok ⇒ 开图不崩、判据不撒谎**。判据收在 core/util.tget 一处。 */
  const PROTO_KEYS = ["toString", "valueOf", "constructor", "hasOwnProperty", "__proto__", "isPrototypeOf",
    "propertyIsEnumerable", "toLocaleString", "__defineGetter__", "__lookupGetter__"];
  it("原型键名：查表判据不认继承成员（校验照常给出「未知××」警告）", () => {
    for (const k of PROTO_KEYS) {
      assert.strictEqual(isValidTerrain(k), false, `isValidTerrain(${k}) 应为假`);
      assert.strictEqual(isValidTerrain("plain/" + k), false, `isValidTerrain(plain/${k}) 应为假`);
      assert.deepStrictEqual(parseComposite(k), ["plain", "none"], `parseComposite(${k}) 应回落`);
      assert.deepStrictEqual(parseComposite("plain/" + k), ["plain", "none"]);
      assert.strictEqual(certaintyStyle(k, "node").名, null, `certaintyStyle(${k}) 应按确证`);
      const w = { meta: {}, nodes: [{ id: "a", type: k, lon: 1, lat: 2 }, { id: "b", type: "city", lon: 3, lat: 4, certainty: k }],
        edges: [{ from: "a", to: "b", type: k }], decor: [{ id: "d", kind: k, lon: 1, lat: 2 }],
        units: [{ id: "u", kind: k, track: [] }], terrainOverrides: [{ lon: 1, lat: 2, t: k }] };
      const r = validateWorld(w);
      assert.strictEqual(r.ok, true, `${k}：不该 fatal（旧档无损打开红线）`);
      const text = r.warnings.map(i => i.path).join("|");
      for (const frag of ["nodes[0].type", "nodes[1].certainty", "edges[0].type", "decor[0].kind", "units[0].kind", "terrainOverrides[0].t"])
        assert.ok(text.includes(frag), `${k}：应报「${frag} 未知」，实得 ${text}`);
    }
  });
  /* 2D 上下文替身：drawDecor 只调这些方法、属性一律可写——够锁住「选中即崩」那条链
     （PRIM_BOX[kind] 取到继承来的函数、对着它解构 → TypeError → 每帧「⚠ 渲染帧异常」）。 */
  const fakeCtx = (): CanvasRenderingContext2D => new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true; }
  }) as unknown as CanvasRenderingContext2D;
  it("原型键名：校验放行的档 normalize + 建网格 + 拾取 + 绘制全不崩", () => {
    for (const k of PROTO_KEYS) {
      const w = normalizeWorld({ meta: { bbox: { lonMin: 0, lonMax: 4, latMin: 0, latMax: 4 } },
        nodes: [{ id: "a", type: k, lon: 1, lat: 2 }, { id: "b", type: "city", lon: 3, lat: 2 }],
        edges: [{ from: "a", to: "b", type: k }], decor: [{ id: "d", kind: k, lon: 2, lat: 2 }],
        units: [{ id: "u", kind: k, track: [] }], terrainOverrides: [{ lon: 1, lat: 2, t: k }] });
      assert.strictEqual(typeof w.nodes[0].type, "string", `${k}：地点类型不该被写成继承来的对象/函数`);
      const g = buildGridCells(w.meta, w.terrainOverrides, 0);   // 开图必经：原先 canonComposite 在此 TypeError＝整张图再打不开
      assert.strictEqual(terrainProps(g.cells[2][1]).land > 0, true, `${k}：涂改格的通行代价不该是 NaN`);
      const cam: Camera = { lon0: 2, lat0: 2, degPerPx: 0.05, w: 200, h: 200, flat: false };
      // 未知印章仍可点选＝既定设计（PRIM_BOX_DEF 头注：旧档/未来基元取包络上界，选得中才修得掉）；
      // 要锁的是它被选中时不再崩——原先 DECOR_BASE[kind] 是函数使 s=NaN，选中即解构继承来的函数。
      const d = pickDecor(cam, w.meta, w, 0, 100, 100);
      assert.ok(d, `${k}：未知印章仍应可点选（否则改不掉它）`);
      assert.doesNotThrow(() => drawDecor(fakeCtx(), cam, w, 0, 1, { id: d!.id, ids: null }), `${k}：选中未知印章不该抛`);
      assert.strictEqual(pickEdge(cam, w.meta, w, 0, 100, 100), null, `${k}：画不出来的连线不该点得中（拾取绘制同源）`);
    }
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

describe("战场表达（柱B）：微地物/工事线/主帅", () => {
  it("微地物六类完备：记号/名/rank/属性模板齐（防白名单豁免空转）", () => {
    for (const t of ["camp", "pass", "bridge", "summit", "manor", "site"]) {
      const s = NODE_STYLE[t];
      assert.ok(s && s.名 && s.shape && s.r > 0, `${t} 样式不全`);
      assert.ok(s.rank >= 0 && s.rank <= 4, `${t} rank 越出 RANK_ZOOM 域`);
      assert.ok(typeof NODE_TMPL[t] === "string" && NODE_TMPL[t].includes("："), `${t} 缺属性模板`);
    }
  });
  /* 地点四类（2026-07-30）：落点 chips 由 16 型收成 4 类，具体型在表单里改。这条锁「覆盖闭合」——
     新增地点类型若漏归类，落点 chips 与表单下拉都摸不到它（同 wall 漏进 IMPL_LAYERS 之症）。 */
  it("地点四类覆盖闭合：除事件点/标注外每型恰属一类，默认型在本类内", () => {
    const seen = new Map<string, string>();
    assert.deepStrictEqual(NODE_CAT_ORDER.slice().sort(), Object.keys(NODE_CATS).sort(), "类别表与序表须同集");
    for (const k of NODE_CAT_ORDER) {
      const c = NODE_CATS[k];
      assert.ok(c.types.includes(c.def), `${k} 的默认型 ${c.def} 不在本类`);
      for (const t of c.types) {
        assert.ok(NODE_STYLE[t], `${k} 列了不存在的类型 ${t}`);
        assert.strictEqual(seen.get(t), undefined, `${t} 被 ${seen.get(t)} 与 ${k} 重复收入`);
        seen.set(t, k);
        assert.strictEqual(nodeCatOf(t), k);
      }
    }
    for (const t of NODE_TYPES) {
      if (t === "event" || t === "label") { assert.strictEqual(nodeCatOf(t), null, `${t} 不该入四类（各有专属入口）`); continue; }
      assert.ok(seen.has(t), `地点类型 ${t} 没归类＝落点 chips 与表单下拉都摸不到它`);
    }
    assert.strictEqual(NODE_CATS.settle.def, "city", "定居点默认型须为城市＝旧缺省落点行为逐位");
    assert.strictEqual(nodeCatOf("vassalseat"), null, "旧类型未归类＝表单回退全量下拉（不锁死）");
  });
  it("工事线型与指挥兵种就位（渲染先行，寻路不吃 wall）", () => {
    assert.deepStrictEqual(EDGE_STYLE.wall, { color: "#55504a", w: 2.8, 名: "工事" });
    assert.deepStrictEqual(UNIT_KINDS.cmd, { 名: "指挥", glyph: "帅", v: 60, arm: "land" });
  });
  it("兵种换代：旧键全可解析、新表恰十四类、旧速度与移动方式由 normalizeWorld 就地保住", () => {
    assert.strictEqual(Object.keys(UNIT_KINDS).length, 14);
    for (const [old, lg] of Object.entries(LEGACY_KIND)) {
      assert.ok(UNIT_KINDS[lg.to], `旧兵种「${old}」的迁移目标「${lg.to}」须在新表里`);
      assert.ok(!UNIT_KINDS[old], `旧键「${old}」不该同时留在新表里——否则迁移永不触发`);
    }
    /* 三种情形各一：速度与新键不同（修士 150·飞行→落显式键）／相同（骑兵 60→不落，档形不因升级变胖）／
       旧键原样存活（飞舟 air 即新的飞行部队，同键同速同军种＝逐位不变，故根本不进迁移表） */
    const w = normalizeWorld({ meta: {}, units: [{ id: "a", kind: "mage" }, { id: "b", kind: "cav" }, { id: "c", kind: "air" }] });
    assert.deepStrictEqual(w.units.map(u => [u.kind, u.speed, u.arm]),
      [["spec", 150, "air"], ["lcav", undefined, "land"], ["air", undefined, "air"]]);
  });
  /* 移动方式（旧称军种）只对编制上真有陆运/水运/空运之分的兵种可选（2026-07-31 用户点单）：
     判据只在 armOptional 一处——表单显隐与 applyUnitForm 的删键同走它，漏一个即「换了兵种却留着
     够不着又相矛盾的水行」。 */
  it("移动方式可选集：骑兵/舰船等由本体决定不给选项，后勤/运输/侦察/特殊/指挥才可另择", () => {
    for (const k of ARM_OPT_KINDS) assert.ok(UNIT_KINDS[k], `可选集里的「${k}」须是真兵种`);
    for (const k of ["log", "trans", "scout", "spec", "cmd"]) assert.strictEqual(armOptional(k), true, k);
    for (const k of ["linf", "hinf", "lcav", "hcav", "rng", "comb", "siege", "navy", "air"])
      assert.strictEqual(armOptional(k), false, `${k} 的移动方式由本体决定`);
    assert.strictEqual(armOptional("未知兵种"), false);
    assert.deepStrictEqual(UNIT_KINDS.trans, { 名: "运输", glyph: "▤", v: 20, arm: "land", noFire: true });
  });
  it("逐航点存量：兵力/速度/士气自该航点起生效，未声明＝沿用而非回默认", () => {
    const u = {
      id: "u1", kind: "linf", strength: 100000, morale: 80,
      track: [{ t: 0, lon: 0, lat: 0 }, { t: 1, lon: 0, lat: 0, strength: 30000, speed: 40, morale: 0 }, { t: 2, lon: 0, lat: 0 }]
    } as unknown as import("../src/core/types.ts").Unit;
    assert.strictEqual(unitStrengthAt(u, 0), 100000, "首段用部队级基线");
    assert.strictEqual(unitStrengthAt(u, 1), 30000, "自该航点起改写");
    assert.strictEqual(unitStrengthAt(u, 2), 30000, "⚠ 下一航点未声明＝没变，打光的兵不会自己长回来");
    assert.strictEqual(unitSpeedAt(u, 0), 30, "速度三级回落：航点→部队→兵种表默认");
    assert.strictEqual(unitSpeedAt(u, 2), 40, "速度同样沿用");
    assert.strictEqual(unitMoraleAt(u, 0), 80);
    assert.strictEqual(unitMoraleAt(u, 2), 0, "士气 0＝崩溃是有意义的值，不能当空处理");
    assert.strictEqual(unitStrengthAt(u, -5), 100000, "未入场回落基线（回溯不到航点）");
    /* 占位符口径：只看**之前**的航点——所见即「这一格留空后会变成什么」 */
    assert.strictEqual(unitInheritedAt(u, 1, "strength"), 100000, "第 1 个航点若不声明则沿用基线");
    assert.strictEqual(unitInheritedAt(u, 2, "strength"), 30000, "第 2 个航点若不声明则沿用上一次声明");
  });
  it("兵力数值化：半数值不吞、显示按万折算、旧文本挪进说明不丢", () => {
    assert.strictEqual(parseStrength(" 8000 "), 8000);
    assert.strictEqual(parseStrength("8000骑"), null, "半数值＝整条不收：parseFloat 会悄悄取走 8000 丢掉「骑」");
    assert.strictEqual(parseStrength("数十万"), null);
    assert.strictEqual(parseStrength(0), null);
    assert.strictEqual(fmtStrength(450000), "45万");
    assert.strictEqual(fmtStrength(25000), "2.5万");
    assert.strictEqual(fmtStrength(10500), "1.05万");
    assert.strictEqual(fmtStrength(9999), "9999", "不足一万原样，「9.999千」反而更难读");
    assert.strictEqual(fmtStrength(undefined), "");
    assert.strictEqual(fmtStrength("号称二十万"), "号称二十万", "未经归一的旧数据原样返回，显示层不吞内容");
    const w = normalizeWorld({ meta: {}, units: [
      { id: "a", kind: "linf", strength: "号称二十万（实数无定论）", note: "旧注" },
      { id: "b", kind: "linf", strength: "25000" },
      { id: "c", kind: "linf", strength: "" }
    ] });
    assert.ok(!("strength" in w.units[0]), "非数值兵力删键");
    assert.strictEqual(w.units[0].note, "旧注\n兵力：号称二十万（实数无定论）", "史料注记挪进说明，接在既有说明之后");
    assert.strictEqual(w.units[1].strength, 25000, "数字串归一为数");
    assert.ok(!("strength" in w.units[2]), "空串＝无兵力");
    assert.ok(!("note" in w.units[2]), "空串不该留下一条空说明");
  });
  it("wallTeeth：直线等距布齿（起步 0.6×gap）、齿垂直于线、reverse 翻面", () => {
    const teeth = wallTeeth([[0, 0], [100, 0]], 9, 4.5);
    assert.strictEqual(teeth.length, 11, "5.4 起每 9px 一齿至 95.4");
    close(teeth[0].x, 5.4); close(teeth[0].y, 0);
    close(teeth[0].tx, 5.4); close(teeth[0].ty, -4.5);   // 行进向右,左侧=屏幕上方（y 向下）
    const rev = wallTeeth([[0, 0], [100, 0]], 9, 4.5, true);
    close(rev[0].ty, 4.5, 6);                             // 翻面=下方
  });
  it("wallTeeth：跨段累计弧长（拐角不重置步进）、<0.5px 短段跳过不崩", () => {
    const teeth = wallTeeth([[0, 0], [10, 0], [10, 0.1], [10, 40]], 9, 4.5);
    assert.strictEqual(teeth.length, 5, "总弧长 50：5.4/14.4/23.4/32.4/41.4");
    const past = teeth.filter(t => t.y > 0.2);            // 拐角后落在竖段上的齿
    assert.strictEqual(past.length, 4);
    for (const t of past) { close(t.x, 10); close(t.tx, 14.5); }   // 行进向下,左侧=+x
  });
  it("validate：工事与河流可用自由折线 pts，道路带 pts 仍警告", () => {
    const ok = validateWorld({ meta: {}, nodes: [], edges: [{ type: "wall", pts: [[1, 1], [2, 2]], reverse: true }] });
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(ok.warnings, []);
    const bad = validateWorld({ meta: {}, nodes: [], edges: [{ type: "road", pts: [[1, 1], [2, 2]] }] });
    assert.ok(bad.warnings.some(i => i.msg.includes("河流与工事")), "道路带 pts 应警告");
  });
});

describe("可靠性分级 certainty（柱B）", () => {
  it("缺键/未知值＝确证＝现渲染逐位（dash null · alpha 1 · 无问号）", () => {
    for (const v of [undefined, null, "", "确证", "sure", 3, {}]) {
      for (const k of ["node", "edge"] as const) {
        const s = certaintyStyle(v, k);
        assert.strictEqual(s.dash, null, `${String(v)} 不该改描边`);
        assert.strictEqual(s.alpha, 1);
        assert.strictEqual(s.query, false);
        assert.strictEqual(s.名, null);
      }
    }
  });
  it("推断=虚描不淡显；传说=虚描+淡显+问号；地点与连线虚线节奏各别", () => {
    const ni = certaintyStyle("inferred", "node"), ei = certaintyStyle("inferred", "edge");
    assert.deepStrictEqual(ni.dash, [3, 2.5]); assert.deepStrictEqual(ei.dash, [7, 5]);
    assert.strictEqual(ni.alpha, 1); assert.strictEqual(ni.query, false); assert.strictEqual(ni.名, "推断");
    const nl = certaintyStyle("legend", "node");
    assert.ok(nl.alpha < 1, "传说应淡显"); assert.strictEqual(nl.query, true); assert.strictEqual(nl.名, "传说");
  });
  it("同档同类返回同一对象（渲染热路径不在帧内分配）", () => {
    assert.strictEqual(certaintyStyle("legend", "node"), certaintyStyle("legend", "node"));
    assert.strictEqual(certaintyStyle(undefined, "node"), certaintyStyle("乱值", "edge"), "确证态共用同一常量");
    assert.notStrictEqual(certaintyStyle("legend", "node"), certaintyStyle("legend", "edge"));
  });
  it("validate：未知档位仅警告（按确证渲染），合法档位无警告", () => {
    const ok = validateWorld({ meta: {}, nodes: [{ id: "a", type: "city", lon: 1, lat: 2, certainty: "legend" }],
      edges: [], factions: [] });
    assert.deepStrictEqual(ok.warnings, []);
    const w = validateWorld({ meta: {}, nodes: [{ id: "a", type: "city", lon: 1, lat: 2, certainty: "存疑" }] });
    assert.strictEqual(w.ok, true);
    assert.ok(w.warnings.some(i => i.path.endsWith(".certainty")), "未知档位应有警告");
  });
});

describe("新建战术战场 blankTacticalWorld（柱B）", () => {
  const S = { 名称: "试战场", lon: 114, lat: 38, diaKm: 20, battleYear: 3000 };
  it("档形完整（空数组齐备）且过校验零 fatal——meta-only 会被导入校验拦死", () => {
    const w = blankTacticalWorld(S, "2026-07-28");
    for (const k of ["factions", "nodes", "edges", "decor", "terrainOverrides", "units"]) {
      assert.ok(Array.isArray((w as unknown as Record<string, unknown>)[k]), `${k} 应为数组`);
      assert.strictEqual(((w as unknown as Record<string, unknown[]>)[k]).length, 0);
    }
    assert.deepStrictEqual(validateWorld(w).fatal, []);
    assert.deepStrictEqual(validateWorld(w).warnings, []);
  });
  it("bbox 由中心＋直径推出（平面＝经纬跨度均分 dia/kmPerDeg）；中心即视角", () => {
    const w = blankTacticalWorld(S, "2026-07-28");
    const span = 20 / 111.19;
    close(w.meta.bbox!.lonMax - w.meta.bbox!.lonMin, span, 3);
    close(w.meta.bbox!.latMax - w.meta.bbox!.latMin, span, 3);
    close((w.meta.bbox!.lonMin + w.meta.bbox!.lonMax) / 2, 114, 3);
    assert.strictEqual(w.meta.view!.lon0, 114);
    assert.strictEqual(w.meta.mapKind, "tactical");
    assert.deepStrictEqual(w.meta.tacSpan, yearSpanT(calOf(), 3000));
  });
  it("直径钳 [20,140]（对角线红线 200km,⚠ 期望有意翻转:原 [20,2000]）；纬度钳 ±85；缺省键不落盘；起伏缺省 0.6", () => {
    assert.deepStrictEqual(blankTacticalWorld({ ...S, diaKm: 1 }, "d").meta.bbox, blankTacticalWorld({ ...S, diaKm: 20 }, "d").meta.bbox, "过小直径钳到 20km");
    assert.deepStrictEqual(blankTacticalWorld({ ...S, diaKm: 9e9 }, "d").meta.bbox, blankTacticalWorld({ ...S, diaKm: 140 }, "d").meta.bbox, "过大直径钳到 140km（边长 140＝对角线 198≤200）");
    const polar = blankTacticalWorld({ ...S, lat: 89 }, "d");
    assert.ok(polar.meta.bbox!.latMax <= 85 && polar.meta.view!.lat0 === 85);
    const m = blankTacticalWorld(S, "d").meta;
    for (const k of ["calendar", "contourM", "genSeed", "parent", "planetRadiusKm"]) assert.ok(!(k in m), `${k} 缺省不该落盘`);
    // 2026-08-08 改判：新战场起伏缺省 0.6——没有起伏＝类型与手雕高程都渲成光滑圆包（河洛实证）；显式 0＝有意全平仍不落盘
    assert.strictEqual(m.relief, 0.6, "起伏缺省 0.6 落盘");
    assert.ok(!("relief" in blankTacticalWorld({ ...S, relief: 0 }, "d").meta), "显式 0＝有意全平，不落盘");
    assert.strictEqual(blankTacticalWorld({ ...S, relief: 0.3 }, "d").meta.relief, 0.3, "显式值原样");
    const e = blankTacticalWorld({ ...S, calendar: { kind: "earth" }, contourM: 100, battleYear: -204 }, "d").meta;
    assert.deepStrictEqual(e.calendar, { kind: "earth" });
    assert.strictEqual(e.contourM, 100);
    assert.deepStrictEqual(e.tacSpan, yearSpanT(calOf({ kind: "earth" }), -204), "earth 历法的年区间");
  });
  it("战场恒平面（2026-08-13 尺度定形批,用户拍板「战术图取消球形星球设置」）：flat + kmPerDeg 缺省 111.19", () => {
    const m = blankTacticalWorld(S, "d").meta;
    assert.strictEqual(m.worldModel, "flat", "新战场恒平面——战场尺度曲率无意义,格子成真正的 100m 正方");
    assert.strictEqual(m.kmPerDeg, 111.19, "每度里程缺省地球级密度（平面世界必须显式,否则回落出厂半径换算）");
    assert.strictEqual(blankTacticalWorld({ ...S, kmPerDeg: 100 }, "d").meta.kmPerDeg, 100, "手编存档可覆写");
  });
  it("创建盖章 meta.gridN（⚠ 期望有意翻转:2026-08-12 曾裁定不落盘;2026-08-13 改「创建时定形」——密度是图的身份）", () => {
    const m = blankTacticalWorld(S, "d").meta;
    assert.strictEqual(m.gridN, autoGridN(m), "盖章值＝创建当刻的自动档解算（此后法则常数演进不动旧图）");
    assert.ok(m.gridN! >= 195 && m.gridN! <= 205, `20km 战场 ≈200 列（实得 ${m.gridN}）`);
    const cellM = gridStepDeg(m) * kmPerDeg(m) * 1000;
    assert.ok(Math.abs(cellM - 100) < 1.5, `格边恰 100m（实得 ${cellM.toFixed(1)}m）`);
    const max = blankTacticalWorld({ ...S, diaKm: 140 }, "d").meta;
    assert.ok(max.gridN! >= 1395 && max.gridN! <= 1405, `140km 上限图 ≈1400 列（实得 ${max.gridN}）＝196 万格,4K 精修仍 ≥2×`);
  });
  it("笔刷兑现定理（战术）：任何可创建尺寸下 32 档互异、最小档恰 1 格＝100m", () => {
    for (const dia of [20, 60, 140]) {
      const m = blankTacticalWorld({ ...S, diaKm: dia }, "d").meta;
      const rs = new Set<number>();
      for (let n = 1; n <= 32; n++) rs.add(brushRadiusCells(m, "terrain", n));
      assert.strictEqual(rs.size, 32, `${dia}km 战场 32 档须全互异`);
      assert.strictEqual(brushRadiusCells(m, "terrain", 1), 0, "最小档＝单格");
      const minM = brushActualKm(m, "terrain", 0) * 1000;
      assert.ok(Math.abs(minM - 100) < 1.5, `${dia}km 战场最小笔刷恰 100m（实得 ${minM.toFixed(1)}m）`);
    }
  });
});

describe("战术网格密度 meta.gridN（2026-08-10 精度批）", () => {
  const tacMeta = (gridN?: number) => ({ mapKind: "tactical" as const, terrain: "plain" as const,
    bbox: { lonMin: 100, lonMax: 101.4, latMin: 30, latMax: 31 }, ...(gridN != null ? { gridN } : {}) });
  it("缺键＝自动（盯 100m/格）；显式值钳 [60,1600]；非法值回落自动", () => {
    const span = 1.4;
    /* ⚠ **期望有意翻转两次**（2026-08-12 同日）：缺键先从「140 列」改成「自动」，自动档又从
       「恒 280 列」改成「盯着 100m/格 定列数」——固定列数下格边正比于图幅，220km 的战场一格
       793m，用户实报「最小笔刷怎么又回到 800 多米」。黄金基准不受影响（parity 把密度写进夹具输入）。
       上钳 1000→1600（2026-08-13 尺度定形批）：可创建域顶到 140km 方图＝1400 列。 */
    const auto = autoGridN(tacMeta());
    assert.ok(Math.abs(buildGridCells(tacMeta(), [], 3100).step - span / auto) < 1e-12, "缺键=自动");
    assert.ok(Math.abs(buildGridCells(tacMeta(140), [], 3100).step - span / 140) < 1e-12, "手编 140 仍照写");
    assert.ok(Math.abs(buildGridCells(tacMeta(9999), [], 3100).step - span / 1600) < 1e-12, "上钳 1600");
    assert.ok(Math.abs(buildGridCells(tacMeta(3), [], 3100).step - span / 60) < 1e-12, "下钳 60");
    assert.ok(Math.abs(buildGridCells(tacMeta(NaN), [], 3100).step - span / auto) < 1e-12, "NaN 回落自动");
  });
  it("战术自动档盯着 100m/格：可创建域（≤140km）全域 100m,超域导入档撞闸自动放粗", () => {
    /* 最小笔刷＝一格，故「笔刷最小 100m」这条约定是由**格边**兑现的，不是笔刷自己能决定的。
       2026-08-13 起可创建域钳 ≤140km、闸值抬到 1600 列/260 万格＝域内永不撞闸;
       闸只咬导入/手编的超域档（如 500km），格自动放粗+读数如实。 */
    const tac = (km: number) => ({ mapKind: "tactical" as const, planetRadiusKm: 6371,
      bbox: { lonMin: 0, lonMax: km / 111.19, latMin: 0, latMax: km / 111.19 * 0.7 } });
    const cellM = (km: number) => gridStepDeg(tac(km)) * kmPerDeg(tac(km)) * 1000;
    for (const km of [20, 27, 50, 93, 140]) assert.ok(Math.abs(cellM(km) - 100) < 2, `${km}km 战场须得 100m/格，实得 ${cellM(km).toFixed(0)}m`);
    assert.strictEqual(autoGridN(tac(500)), 1600, "500km 超域档撞列数封顶");
    assert.ok(cellM(500) > 300, `撞顶后格自动放粗（实得 ${cellM(500).toFixed(0)}m）＝大图密度低之约`);
    let prev = 0;   // 格边随图幅单调不减
    for (const km of [20, 50, 100, 200, 500]) { assert.ok(cellM(km) >= prev - 1e-9, `${km}km`); prev = cellM(km); }
    /* 鄱阳湖形（93km 宽×158km 高,导入档）：旧 70 万格闸压成 145m,新闸下拿到真 100m——
       又高又窄靠总格数闸与行数闸兜住（1.47M ≤ 2.6M、1580 行 ≤ 2000） */
    const py = { mapKind: "tactical" as const, planetRadiusKm: 6371,
      bbox: { lonMin: 0, lonMax: 93 / 111.19, latMin: 0, latMax: 158 / 111.19 } };
    assert.ok(Math.abs(gridStepDeg(py) * kmPerDeg(py) * 1000 - 100) < 2, "鄱阳湖级窄高图现在拿到真 100m");
    /* 行数闸：极端瘦高档不再把行数顶穿 2048 轴护栏（宽 1° 高 20°） */
    const tall = { mapKind: "tactical" as const, planetRadiusKm: 6371, bbox: { lonMin: 0, lonMax: 1, latMin: 0, latMax: 20 } };
    const g = buildGridCells(tall, [], 3100);
    assert.ok(g.rows <= 2048 && Math.ceil(20 / gridStepDeg(tall)) <= 2048, `行数须被行闸兜住（实得 ${g.rows}）`);
  });
  it("同一涂改在两档密度下同域生效：140 上涂的粗块在 280 网格按粗块盖章铺满", () => {
    const coarse = 1.4 / 140;
    const ov = { lon: +(100 + 3.5 * coarse).toFixed(4), lat: +(30 + 3.5 * coarse).toFixed(4), t: "hill", step: +coarse.toFixed(4) };
    const g = buildGridCells(tacMeta(280), [ov], 3100);
    // 四象限探点各偏块心 ±0.25 粗格＝必落在四个不同细格的**格内**（块边恰在细格线上，按边判归浮点不稳）
    for (const [dx, dy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]] as const) {
      const c = Math.floor((ov.lon + dx * coarse - 100) / g.step), r = Math.floor((ov.lat + dy * coarse - 30) / g.step);
      assert.strictEqual(g.cells[r][c], "hill", `旧粗块须铺满所覆盖的 2×2 细格 (${r},${c})`);
    }
  });
});

describe("战略网格密度 · 自动档随图幅（2026-08-12 用户点单「密度随地图尺寸而定」）", () => {
  const strat = (lonSpan: number, latSpan: number, gridN?: number) => ({
    planetRadiusKm: 6371, bbox: { lonMin: 0, lonMax: lonSpan, latMin: 0, latMax: latSpan },
    ...(gridN != null ? { gridN } : {}) });

  it("缺键＝自动（⚠ 期望有意翻转：从前恒 1°/格）；写死列数仍取得回 1°＝黄金基准夹具的形状", () => {
    for (const span of [10, 48, 120, 360]) assert.notStrictEqual(gridStepDeg(strat(span, span * 0.7)), 1.0);
    assert.strictEqual(gridStepDeg(strat(48, 32, 48)), 1.0, "48° 图幅写死 48 列＝恰好 1°/格");
  });

  it("战略格边公里锚定 20⁄3km（⚠ 期望有意翻转:2026-08-12 曾锚 ⅛°）——承诺以公里计,格边就得以公里计", () => {
    /* ⅛° 在地球是 13.9km＝超互异上限（15.48/2=7.74km）近一倍,48° 图实测只剩 18/32 档;
       在出厂 10000km 半径星球是 21.8km 更糟。20⁄3 的由来:最小档 20km 恰 3 格（恰值）,
       且 6.67 ≤ 7.74（互异,余量 1.16×）。 */
    const cellKm = (m: ReturnType<typeof strat>) => gridStepDeg(m) * kmPerDeg(m);
    assert.ok(Math.abs(cellKm(strat(48, 32)) - 20 / 3) < 0.07, `地球 48° 区域格边恰 20⁄3km（实得 ${cellKm(strat(48, 32)).toFixed(3)}）`);
    assert.strictEqual(autoGridN(strat(48, 32)), 801, "48°×111.19km/°÷(20/3)≈801 列");
    assert.strictEqual(autoGridN(strat(2, 1.4)), 60, "极小图触列数下限＝格比 20⁄3 更细（最小档实得 20~25km,读数如实）");
    // 格边随图幅单调不减；总格数恒封在预算内（byCells 取整+行 ceil 留 ~2% 余隙）
    let prevStep = 0;
    for (const [lo, la] of [[10, 7], [48, 32], [120, 80], [360, 170]] as const) {
      const m = strat(lo, la);
      const step = gridStepDeg(m), cells = Math.ceil(lo / step) * Math.ceil(la / step);
      assert.ok(step >= prevStep - 1e-12, `图幅 ${lo}° 的格边不得比更小的图更细`);
      assert.ok(cells <= 1_540_000, `图幅 ${lo}° 总格数 ${cells} 须封在预算内`);
      prevStep = step;
    }
  });

  it("笔刷兑现定理（战略）：承诺域内 32 档互异+最小档恰 3 格=20km;整球图出域＝放粗+档数如实变少", () => {
    const distinct = (m: ReturnType<typeof strat>) => new Set(Array.from({ length: 32 }, (_, i) => brushRadiusCells(m, "terrain", i + 1))).size;
    const dom = strat(48, 32);   // 地球 48° 区域（约 5300km 宽）＝承诺域内
    assert.strictEqual(distinct(dom), 32, "域内 32 档全互异");
    assert.strictEqual(brushRadiusCells(dom, "terrain", 1), 1, "最小档恰 3 格（R=1）");
    assert.ok(Math.abs(brushActualKm(dom, "terrain", 1) - 20) < 0.3, "最小档实得恰 20km");
    /* 整球图（地球级 360°）出承诺域：闸把格放粗到 ~23km——最小档仍贴着 20km,但相邻档差
       15.48km < 一格增量＝档数变少。物理不可避,创建面板明码标价（读数行）,不是缺陷。 */
    const globe = strat(360, 170);
    const gCell = gridStepDeg(globe) * kmPerDeg(globe);
    assert.ok(gCell > 7.74, `整球图格边 ${gCell.toFixed(1)}km 超互异上限＝出域`);
    assert.ok(distinct(globe) >= 8 && distinct(globe) < 32, `整球图档数如实变少（实得 ${distinct(globe)}/32）`);
    assert.ok(brushActualKm(globe, "terrain", brushRadiusCells(globe, "terrain", 1)) < 26, "最小档实得仍贴着 20km 量级");
  });

  it("显式列数只封上限不设下限；`gridStepDeg` 与 `buildGridCells` 的 step 在战略图上同样同值", () => {
    assert.ok(Math.abs(gridStepDeg(strat(48, 32, 9999)) - 48 / STRAT_GRID_MAX) < 1e-12, "上钳＝成本闸");
    /* ⚠ 不设下限是有依据的：列少只是格粗，没什么可保护的，而下限会让**小图幅表达不出粗格**
       ——4° 的图要 1°/格 只需 4 列，下钳 24 就把它顶成 0.167°（黄金基准夹具正是这种小图）。 */
    assert.ok(Math.abs(gridStepDeg(strat(4, 4, 4)) - 1) < 1e-12, "4° 图写 4 列＝1°/格，不被下限顶掉");
    for (const m of [strat(48, 32), strat(48, 32, 192), strat(10, 7, 64)]) {
      assert.strictEqual(gridStepDeg(m), buildGridCells(m, [], 3100).step);
    }
  });

  it("blankWorld 创建盖章 gridN（战略出生点,2026-08-13）＝创建当刻的自动档解算", () => {
    const w = blankWorld({ bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 }, planetRadiusKm: 6371 }, "@d@");
    assert.strictEqual(w.meta.gridN, 801, "地球 48° 区域盖章 801 列");
    const w2 = blankWorld({ bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 } }, "@d@");
    assert.strictEqual(w2.meta.gridN, autoGridN(w2.meta), "出厂半径同规盖章");
  });

  it("⚠ 密度一开,寻路两处按「格细不细」翻进细格支——有意如此,不是漏网", () => {
    /* 40 段定数采样在细网格上会漏掉沿线大部分格（官道减速带断续、A* 不认路）。这两处判据
       从来就该按格粗细而非图种,2026-08-12 只是把名字改对并把行为锁住。 */
    const m = strat(48, 32, 192);
    const nodes = [{ id: "a", lon: 2, lat: 2 }, { id: "b", lon: 30, lat: 20 }] as never;
    const edges = [{ type: "road", from: "a", to: "b" }] as never;
    const fine = roadCellSet(nodes, edges, 3100, buildGridCells(m, [], 3100));
    const coarse = roadCellSet(nodes, edges, 3100, buildGridCells(strat(48, 32, 48), [], 3100));   // 写死 48 列＝1°/格
    assert.ok(coarse.size <= 41, `粗网格仍走 40 段定数采样＝至多 41 个格（实得 ${coarse.size}）`);
    assert.ok(fine.size > 41, `细网格须逐格走满（实得 ${fine.size} 格，40 段采样至多 41 个点）`);
    // 精确走格的产物必首尾相连：任意两相邻格差恰一步（曼哈顿或对角）
    const rc = [...fine].map(k => k.split(",").map(Number) as [number, number]);
    const set = new Set(fine);
    for (const [r, c] of rc) {
      const linked = [[r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]].some(([r2, c2]) => set.has(r2 + "," + c2));
      assert.ok(linked, `格 (${r},${c}) 与四邻不相连＝走格漏了`);
    }
  });
});

describe("笔刷物理档位 core/brush（2026-08-12 用户点单）", () => {
  /* 半径 6371＝地球，好让「一格≈111km」这类数字读得懂；出厂缺省 10000km 的世界一格≈174.5km，
     结论同向只是更极端（见「战略图格粒度」一测的头注）。 */
  const TAC = { mapKind: "tactical" as const, planetRadiusKm: 6371,
    bbox: { lonMin: 100, lonMax: 101.4, latMin: 30, latMax: 31 }, gridN: 280 };
  const STRAT = { planetRadiusKm: 6371, bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 } };

  it("档表两端点：战术 100m→20km（低端分段）、战略 20km→500km 线性", () => {
    assert.strictEqual(BRUSH_NOTCHES, 32);
    assert.ok(Math.abs(brushNominalKm(TAC, 1) - 0.1) < 1e-12, "战术首档 100m");
    assert.ok(Math.abs(brushNominalKm(TAC, 32) - 20) < 1e-12, "战术末档 20km");
    assert.ok(Math.abs(brushNominalKm(STRAT, 1) - 20) < 1e-12, "战略首档 20km");
    assert.ok(Math.abs(brushNominalKm(STRAT, 32) - 500) < 1e-12, "战略末档 500km");
    /* ⚠ 期望有意翻转（2026-08-26 低端分段）：原「32 档等距」锁线性——纯线性第 2 档即 742m，
       100m 格上 300/500m（3/5 格）雕刻笔永远够不着。前七档改定值序列，其余线性到 20km。 */
    assert.deepStrictEqual(Array.from({ length: 7 }, (_, i) => brushNominalKm(TAC, i + 1)), [0.1, 0.3, 0.5, 0.7, 1, 1.5, 2]);
    const d = brushNominalKm(TAC, 9) - brushNominalKm(TAC, 8);
    for (let n = 9; n <= 32; n++)
      assert.ok(Math.abs(brushNominalKm(TAC, n) - brushNominalKm(TAC, n - 1) - d) < 1e-12, `第 ${n} 档与前档等距（分段点之上线性）`);
    for (let n = 2; n <= 32; n++)
      assert.ok(brushNominalKm(TAC, n) > brushNominalKm(TAC, n - 1), `第 ${n} 档须严格递增`);
  });

  it("100m 格上分段加密的兑现：3/5 格雕刻笔够得着，32 档全互异", () => {
    const fine = { mapKind: "tactical" as const, worldModel: "flat" as const, kmPerDeg: 111.19,
      bbox: { lonMin: 100, lonMax: 101.2591, latMin: 30, latMax: 31.2591 }, gridN: 1400 };
    assert.ok(Math.abs(brushStepDeg(fine, "terrain") * kmPerDeg(fine) - 0.1) < 1e-3, "前提：格边恰 100m");
    assert.strictEqual(brushRadiusCells(fine, "terrain", 2), 1, "第 2 档 300m＝3 格（旧线性档表：742m＝7 格）");
    assert.strictEqual(brushRadiusCells(fine, "terrain", 3), 2, "第 3 档 500m＝5 格");
    const distinct = new Set(Array.from({ length: BRUSH_NOTCHES }, (_, i) => brushRadiusCells(fine, "terrain", i + 1)));
    assert.strictEqual(distinct.size, 32, "100m 格上 32 档全互异");
  });

  it("档位钳 [1,32]、非数当 1——滑杆够不到越界，但存档/快捷键别的路子不许产出 NaN 半径", () => {
    assert.strictEqual(brushNominalKm(TAC, 0), brushNominalKm(TAC, 1));
    assert.strictEqual(brushNominalKm(TAC, 99), brushNominalKm(TAC, 32));
    assert.strictEqual(brushNominalKm(TAC, NaN), brushNominalKm(TAC, 1));
    assert.strictEqual(brushRadiusCells(TAC, "terrain", NaN), 0);
  });

  it("半径上限 256：手编的玩具尺度世界不许把一笔涂改撑成千万格（O(R²) 会钉死主线程）", () => {
    /* kmPerDeg 是存档里的自由数值——1 米/度 的世界里 20km 档折算下来是千万格半径。
       上限从不咬合法图：gridN 上钳 400＝满幅 R=200、战略 360° 满幅 R=180。 */
    const toy = { ...TAC, worldModel: "flat" as const, kmPerDeg: 0.001 };
    assert.ok(brushStepDeg(toy, "terrain") * kmPerDeg(toy) < 1e-5, "前提：这张图的格小到微米量级");
    assert.strictEqual(brushRadiusCells(toy, "terrain", BRUSH_NOTCHES), 256);
    assert.ok(brushRadiusCells({ ...TAC, gridN: 400 }, "terrain", BRUSH_NOTCHES) < 256, "合法图不该碰到上限");
  });

  it("名义→格半径：非负整数、单调不减、不足一格＝单格（涂宽恒 2R+1 奇数格）", () => {
    let prev = -1;
    for (let n = 1; n <= BRUSH_NOTCHES; n++) {
      const R = brushRadiusCells(TAC, "terrain", n);
      assert.ok(Number.isInteger(R) && R >= 0, `第 ${n} 档半径须非负整数，实得 ${R}`);
      assert.ok(R >= prev, `第 ${n} 档不得比前档小`);
      prev = R;
    }
    assert.strictEqual(brushRadiusCells(TAC, "terrain", 1), 0, "首档 100m 不足一格＝单格");
  });

  it("战略笔刷靠网格密度自动档活过来——1°/格 时 20km 下限物理不可达，自动档下可达", () => {
    /* ⚠ **期望有意翻转**（2026-08-12 同日两批的因果）：笔刷只能整格地涂，故 20km 下限能不能用
       完全由格粒度决定。写死 1°/格 时一格 111km，前十余档必然同落一格（读数因此报实际不报名义）；
       改成密度自动档后 48° 图幅得 ⅛°≈14km，20km 下限这才真的够得着。 */
    const pinned = { ...STRAT, gridN: 48 };   // 48° 图幅写死 48 列＝旧的 1°/格
    const oneCell = brushActualKm(pinned, "terrain", 0);
    assert.ok(oneCell > 110 && oneCell < 112, `1°/格 时一格 ${oneCell}km`);
    assert.ok(brushNominalKm(pinned, 1) < oneCell, "名义 20km 小于一格＝该档的名义值是假的");
    assert.strictEqual(brushRadiusCells(pinned, "terrain", 1), 0, "1°/格 时首档退化成单格");
    // 自动档（缺键）：格细到 ⅛°，首档终于落在一格上下而非远小于一格
    assert.ok(gridStepDeg(STRAT) < 0.2, `前提：自动档给出细格（实得 ${gridStepDeg(STRAT)}°）`);
    const autoCell = brushActualKm(STRAT, "terrain", 0);
    assert.ok(autoCell < 20, `自动档一格 ${autoCell}km 须小于 20km 下限＝下限可达`);
    const distinct = new Set(Array.from({ length: BRUSH_NOTCHES }, (_, i) => brushRadiusCells(STRAT, "terrain", i + 1)));
    assert.ok(distinct.size > 10, `自动档下 32 档须给出十个以上不同尺寸（实得 ${distinct.size}）`);
  });

  it("实际涂宽＝(2R+1)×格边×每度公里；涂域笔走 paintStep、地形笔走 gridStepDeg", () => {
    for (const sub of ["terrain", "paint"]) {
      const step = brushStepDeg(TAC, sub);
      assert.ok(Math.abs(brushActualKm(TAC, sub, 3) - 7 * step * kmPerDeg(TAC)) < 1e-9, `${sub}：R=3 即 7 格`);
    }
    assert.strictEqual(brushStepDeg(TAC, "paint"), paintStep(TAC), "涂域走 paintStep（2026-08-13 起＝地形格,涂域笔与地形笔同粒）");
    assert.strictEqual(brushStepDeg(TAC, "terrain"), gridStepDeg(TAC));
  });

  it("gridStepDeg 与 buildGridCells 的 step 同值（抽出来的那一份不许漂）", () => {
    const cases = [TAC, { ...TAC, gridN: 140 }, STRAT,
      { ...TAC, bbox: { lonMin: 0, lonMax: 0.02, latMin: 0, latMax: 0.02 } }];   // 末例触 0.001° 地板
    for (const m of cases) assert.strictEqual(gridStepDeg(m), buildGridCells(m, [], 3100).step);
  });

  it("读数格式：低端报米、中段留一位小数——相邻档差数百米，fmtKm 的整 km 会把连着几档印成同一个数", () => {
    assert.strictEqual(fmtBrushKm(0.112), "112 m");
    assert.strictEqual(fmtBrushKm(1.44), "1.4 km");
    assert.strictEqual(fmtBrushKm(20), "20 km");
    assert.strictEqual(fmtKm(1.4), fmtKm(1.44), "前提：fmtKm 在此处确实分不开");
    assert.notStrictEqual(fmtBrushKm(1.4), fmtBrushKm(2.0), "笔刷读数须分得开相邻档");
  });
});

describe("高程笔米制分档 heightStepM（2026-08-10 精度批）", () => {
  it("自动档：战术 10m / 战略 50m（≈旧硬编码 0.02×2000 的手感）；显式档钳到图种下限", () => {
    assert.strictEqual(heightStepM({ mapKind: "tactical" }, 0), 10);
    assert.strictEqual(heightStepM({}, 0), 50);
    assert.strictEqual(heightStepM(undefined, 0), 50);
    assert.strictEqual(heightStepM({ mapKind: "tactical" }, 1), 1, "战术可精雕到 1m");
    assert.strictEqual(heightStepM({}, 1), 10, "战略下限 10m（换图后残留的战术档位被钳）");
    assert.strictEqual(heightStepM({ mapKind: "tactical" }, 250), 250, "上不封（档表之外的显式值原样）");
    assert.strictEqual(heightStepM({}, NaN), 50, "非法值＝自动档");
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
    assert.strictEqual(fmtWhenRange(C, true, c + 0.5, c + 13 / 24), "SE3107·3月7日 12:00–13:00");
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
  it("layerOn：tacOnly 层在非战术图上一律不画（层面板没有它们的行＝用户关不掉）", () => {
    const tacM = { mapKind: "tactical" } as const, strM = {};
    /* ⚠ units 2026-07-31 起**不再** tacOnly（战略图可摆基础部队）；战场尺度的三层仍是战术图专属 */
    for (const id of ["trails", "ranges", "vision"]) {
      assert.strictEqual(layerOn({}, strM, id), false, `${id} 在战略图上不该画`);
      assert.strictEqual(layerOn({}, tacM, id), true, `${id} 在战术图上缺省开`);
      assert.strictEqual(layerOn({ [id]: false }, tacM, id), false, "战术图上开关照旧生效");
    }
    for (const id of ["nodes", "road", "wall", "arrows", "events", "units"]) {   // 非 tacOnly：两种图一视同仁
      assert.strictEqual(layerOn({}, strM, id), true);
      assert.strictEqual(layerOn({ [id]: false }, strM, id), false);
    }
    assert.strictEqual(layerOn(undefined, undefined, "trails"), false, "无 meta＝非战术图");
    assert.strictEqual(layerOn(undefined, undefined, "units"), true, "部队层不再是战术图专属");
  });
  it("pinnedStackH：屏幕角标注堆的占高（出图图例据此让开 se）", () => {
    const T = 3107;
    // 块高=行数×(字号+3)；se 基线 42、条间 8、衬底外扩 3
    const one = mkWorld([{ type: "label", 名称: "图注一\n第二行", pin: "se" }]);
    assert.strictEqual(pinnedStackH(one, T, "se"), 42 + 32 + 3);
    const two = mkWorld([{ type: "label", 名称: "图注一\n第二行", pin: "se" }, { type: "label", 名称: "图注二", pin: "se" }]);
    assert.strictEqual(pinnedStackH(two, T, "se"), 42 + 32 + 16 + 8 + 3);
    assert.strictEqual(pinnedStackH(one, T, "sw"), 0, "该角无标注=0：图例位置逐位不变");
    assert.strictEqual(pinnedStackH(mkWorld([{ type: "label", 名称: "帧题", pin: "nw" }]), T, "nw"), 46 + 16 + 3, "nw 基线让开图名");
    assert.strictEqual(pinnedStackH(mkWorld([{ type: "label", 名称: "大", fs: 24, pin: "se" }]), T, "se"), 42 + 27 + 3);
    // 时限同 drawPinnedNotes：过期不占位，但选中的过期标注照画照占（画布与出图一致）
    const past = mkWorld([{ type: "label", 名称: "旧注", pin: "se", since: 3100, until: 3105 }]);
    assert.strictEqual(pinnedStackH(past, T, "se"), 0);
    assert.strictEqual(pinnedStackH(past, T, "se", "n0"), 42 + 16 + 3);
    assert.strictEqual(pinnedStackH(mkWorld([{ type: "city", pin: "se" }]), T, "se"), 0, "只认标注：pin 记在别的类型上不占位");
  });
  /* ⚠ 期望有意翻转（2026-08-20 显隐门改公里锚定）：判据自此是 km/px＝degPerPx×每度公里。
     夹具 meta 为空＝出厂 10000km 星球（174.5 km/°），故 0.1°/px ＝ **17.5 km/px**：
     都城(∞)与主要城市(22)可见，城市(13)、乡村(5)都不可见——同一个 degPerPx 换个星球半径
     结论就不同，这正是这次要修的（绝对度数在地球上是 11.1 km/px，城市那时是可见的）。 */
  it("rank 缩放门：浏览态按显隐拾取，编辑态全见（与 drawNodes 同规）", () => {
    const w = mkWorld([{ type: "village" }]);              // rank4：17.5 > 5 km/px = 浏览不可见
    assert.strictEqual(pick(w, {}), null, "浏览态隐藏的乡村不可点");
    assert.strictEqual(pick(w, { editing: true })!.id, "n0", "编辑态全部地点可见=可点");
    assert.strictEqual(pick(mkWorld([{ type: "capital" }]), {})!.id, "n0", "都城 rank0 恒可见");
    assert.strictEqual(pick(mkWorld([{ type: "city" }]), {}), null, "城市阈值 13 km/px：这颗大星球上 0.1°/px 已经太远");
    const earth = mkWorld([{ type: "city" }]);
    earth.meta = { planetRadiusKm: 6371 };                 // 同一个 degPerPx，地球上＝11.1 km/px
    assert.strictEqual(pick(earth, {})!.id, "n0", "换成地球半径即可见＝阈值锚的是公里不是度");
  });
  it("nodesInBox 同一套门：隐形对象不被框进批量删", () => {
    const w = mkWorld([{ type: "capital" }, { type: "village" }, { type: "label", 名称: "题", pin: "se" }]);
    assert.deepStrictEqual(nodesInBox(cam, w.meta, w, 3107, 380, 280, 420, 320, { editing: true }).sort(), ["n0", "n1"]);
    assert.deepStrictEqual(nodesInBox(cam, w.meta, w, 3107, 380, 280, 420, 320, {}), ["n0"], "浏览态 rank 隐藏的乡村不入框");
    assert.deepStrictEqual(nodesInBox(cam, w.meta, w, 3107, 380, 280, 420, 320, { editing: true, layers: { nodes: false } }), []);
  });
  it("标注按文本体拾取（逐行判中）：大字远离锚点可点、参差留白不算、记号优先、无度量退回锚点", () => {
    const M = (t: string) => t.length * 10;             // 假度量：每字 10px（真实走离屏 ctx.measureText）
    const at = (x: number, y: number) => unproject(cam, x, y);
    // 两行 24px 标注锚在屏幕中心：lh=27、块高 54 → 行0 y∈[273,300) x∈[370,430]；行1 y∈[300,327) x∈[390,410]
    const mkNote = (extra: Partial<WorldNode>[] = []): World =>
      mkWorld([{ type: "label", 名称: "北疆巡狩总图\n附记", fs: 24 }, ...extra]);
    const hit = (w: World, x: number, y: number, o: Parameters<typeof pickNode>[6] = {}) =>
      pickNode(cam, w.meta, w, 3107, x, y, { editing: true, measure: M, ...o });
    const w = mkNote();
    assert.strictEqual(hit(w, 425, 285)!.id, "n0", "行0 右端（离锚点 25px，旧版 12px 锚点判中落空）");
    assert.strictEqual(hit(w, 400, 320)!.id, "n0", "行1 上（离锚点 20px）");
    assert.strictEqual(hit(w, 375, 315), null, "行1 参差留白：在整块外框内、不在行框内＝不命中（免遮住底下的布景）");
    assert.strictEqual(hit(w, 400, 340), null, "块下缘外出余量");
    assert.strictEqual(hit(w, 440, 285), null, "行0 右缘外出余量");
    // 记号优先：标注文本压着一个城市记号，点在记号锚点 12px 内 → 取记号（记号画在标注之上）
    const [clon, clat] = at(428, 283);
    const wc = mkNote([{ type: "city", lon: clon, lat: clat }]);
    assert.strictEqual(hit(wc, 425, 285)!.id, "n1", "锚点先判＝压在标注上的记号不被抢走");
    assert.strictEqual(hit(wc, 400, 320)!.id, "n0", "离记号远处仍按文本体取标注");
    // 退化路径：无度量（node 无 document）＝旧的纯锚点判定；层门/pin 门对文本体同样生效
    assert.strictEqual(hit(w, 425, 285, { measure: null }), null, "无度量→退回锚点判定（旧行为）");
    assert.strictEqual(hit(w, 400, 300, { measure: null })!.id, "n0", "退回后锚点仍可点");
    assert.strictEqual(hit(w, 425, 285, { layers: { notes: false } }), null, "标注层关＝文本体也不可点");
    const wp = mkWorld([{ type: "label", 名称: "北疆巡狩总图\n附记", fs: 24, pin: "nw" }]);
    assert.strictEqual(hit(wp, 425, 285), null, "pin 屏幕角标注：文本体同样不可点");
  });
  it("pickEdge 宽河走廊随渲染河宽（点在河面即可选中）；无 widthM／道路仍 6px", () => {
    const zoom: Camera = { lon0: 100, lat0: 30, degPerPx: 0.001, w: 800, h: 600, flat: false };   // 战术级缩放
    const mkw = (widthM?: number): World => ({
      meta: { worldModel: "sphere", planetRadiusKm: 10000 }, factions: [], decor: [], terrainOverrides: [], units: [], nodes: [],
      edges: [{ type: "river", pts: [[99.9, 30], [100.1, 30]], ...(widthM ? { widthM } : {}) }]
    });
    // widthM=3000m → 渲染宽 ≈17.2px → 走廊 ≈12.6px：距中轴 10px 可选中（旧固定 6px 选不中）
    const wide = mkw(3000);
    assert.ok(pickEdge(zoom, wide.meta, wide, 3107, 400, 310), "宽河 10px 偏移命中");
    // 无 widthM（底宽 2.6px）：走廊仍 6px——10px 不中、5px 中（旧行为逐位保留）
    const thin = mkw();
    assert.strictEqual(pickEdge(zoom, thin.meta, thin, 3107, 400, 310), null, "窄河 10px 不中");
    assert.ok(pickEdge(zoom, thin.meta, thin, 3107, 400, 305), "窄河 5px 命中");
    // 多条命中取距中轴最近者：宽河河面上叠一条更近的道路 → 道路胜
    const both = mkw(3000);
    both.nodes = [{ id: "a", type: "city", lon: 99.9, lat: 30.008 }, { id: "b", type: "city", lon: 100.1, lat: 30.008 }] as WorldNode[];
    both.edges.push({ type: "road", from: "a", to: "b" });   // 道路在 y≈292，点击 (400,294)：距路 2px、距河 6px
    const hit = pickEdge(zoom, both.meta, both, 3107, 400, 294);
    assert.strictEqual(hit && hit.edge.type, "road", "重叠处取距中轴最近者");
  });
  it("decorSizePx：线性段与旧公式逐位；KNEE 后缓增单调；深放大封顶 CAP；id 抖动 ±10% 有界", () => {
    assert.strictEqual(decorSizePx("peak", 1, 0.02, 0.001), 11 * 1 * ((0.02 / 0.001) / 14), "线性段=旧公式（同结合序）");
    assert.strictEqual(decorSizePx("没有这种", 1, 0.02, 0.001), 5 * 1 * ((0.02 / 0.001) / 14), "未知种类回退基准 5");
    const atKnee = decorSizePx("peak", 1, 46 * 14 / 11 * 0.001, 0.001);
    assert.ok(Math.abs(atKnee - 46) < 1e-9, "拐点处连续");
    let prev = 0;
    for (const st of [0.06, 0.1, 0.2, 0.5, 2, 10]) { const s = decorSizePx("peak", 1, st, 0.001); assert.ok(s >= prev, "缓增段单调不减（封顶后持平）"); prev = s; }
    assert.ok(Math.abs(decorSizePx("peak", 1, 1e5, 0.001) - DECOR_CAP) < 1e-9, "深放大封顶（原 420px 退场语义已改：符号永不消失）");
    const plain = decorSizePx("peak", 1, 0.02, 0.001);
    for (const id of ["a", "d0", "任意-id"]) {
      const s = decorSizePx("peak", 1, 0.02, 0.001, id);
      assert.ok(s >= plain * 0.9 - 1e-9 && s <= plain * 1.1 + 1e-9, "id 抖动有界");
      assert.strictEqual(s, decorSizePx("peak", 1, 0.02, 0.001, id), "同 id 恒同值（出图逐次一致）");
    }
  });
  it("pickDecor 命中所画的体（印章站在锚点上、体在其上方）：顶尖可点、体外 13px 余量、并列取锚点最近", () => {
    const cam: Camera = { lon0: 100, lat0: 30, degPerPx: 0.001, w: 800, h: 600, flat: true };
    const meta = { worldModel: "flat" as const };
    const mk = (...lons: number[]): World => ({
      meta, factions: [], nodes: [], edges: [], units: [], terrainOverrides: [],
      decor: lons.map((lon, i) => ({ id: "d" + i, kind: "peak", lon, lat: 30 }))
    });
    // step .05／degPerPx .001 → 线性段：s=decorSizePx(含 d0 的 id 抖动)；体=PRIM_BOX.peak [0.92,1,0.5]×s。
    // 期望按 decorSizePx 同源推出＝锁「拾取与绘制用同一几何」；尺寸函数自身另有精确值测试防同表自证。
    const w = mk(100);
    const s = decorSizePx("peak", 1, 0.05, 0.001, "d0");
    assert.ok(s > 30 && s <= 46, "此机位落在线性段");
    const hit = (x: number, y: number) => pickDecor(cam, meta, w, 3107, x, y, 0.05);
    assert.ok(hit(400, 300 - s - 5), "顶尖上方 5px 在余量内（旧对称圆拾取在此落空）");
    assert.ok(hit(400 - 0.92 * s - 8, 300), "左缘外 8px 在余量内");
    assert.ok(hit(400, 300 + 0.5 * s + 12), "体下缘外 12px 仍在余量内");
    assert.ok(!hit(400, 300 + 0.5 * s + 15), "体下缘外 15px 出余量");
    assert.ok(!hit(400 - 0.92 * s - 15, 300), "体左缘外 15px 出余量");
    assert.ok(!hit(400, 300 - s - 15), "顶尖外 15px 出余量");
    // 并列（两枚体重叠、点落在公共部分）：比锚点距离取最近者，不按数组序先到先得
    const two = mk(100, 100.02);   // 锚点 400 与 420
    const near = (x: number) => pickDecor(cam, meta, two, 3107, x, 300, 0.05);
    assert.strictEqual(near(428)?.id, "d1", "点在两体内、离 d1 锚点近");
    assert.strictEqual(near(400)?.id, "d0", "点在两体内、离 d0 锚点近");
    // 深放大封顶（⚠ 期望有意翻转：原「s>420 退场＝不按体拾取」——缓增封顶后符号永不消失，体照拾）
    const sBig = decorSizePx("peak", 1, 0.6, 0.001, "d0");
    assert.ok(sBig > 46 && sBig <= DECOR_CAP + 1e-9, "深放大走缓增封顶");
    const big = (x: number, y: number) => pickDecor(cam, meta, w, 3107, x, y, 0.6);
    assert.ok(big(400, 300 - sBig + 2), "封顶后顶尖仍可点（符号不再蒸发）");
    assert.ok(!big(400, 300 - sBig - 16), "封顶体之外仍拾不中");
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

  it("meta：mapKind/battleYear/tacSpan/parent/名称/继承字段/view；子图恒平面+盖章（⚠ 期望有意翻转,2026-08-13 平面化）", () => {
    const w = createTacticalWorld(srcWorld(), ev, 200, { parentMapId: "m1", today: "2026-07-05" });
    assert.strictEqual(w.meta.mapKind, "tactical");
    assert.strictEqual(w.meta.battleYear, 3107);
    assert.deepStrictEqual(w.meta.tacSpan, [3107 * 360, 3108 * 360 - 1]);
    assert.strictEqual(w.meta.名称, "会战·战术");
    assert.deepStrictEqual(w.meta.parent, { map: "m1", mapName: "母图", event: "evHL", eventName: "会战" });
    /* 平面化三处：worldModel 恒 flat；kmPerDeg＝母图每纬度里程（球面母图按半径换算,原样携带的
       旧 kmPerDeg 111 只对平面母图有意义）；星球半径不携带（平面无半径） */
    assert.strictEqual(w.meta.worldModel, "flat");
    assert.ok(!("planetRadiusKm" in w.meta), "平面子图不带星球半径");
    assert.ok(Math.abs(w.meta.kmPerDeg! - 2 * Math.PI * 10000 / 360) < 0.001, `kmPerDeg＝母图每纬度里程（实得 ${w.meta.kmPerDeg}）`);
    assert.strictEqual(w.meta.terrain, "sample");
    assert.strictEqual(w.meta.vault, "V");
    assert.deepStrictEqual(w.meta.calendar, { months: 12, dpm: 30 });
    assert.strictEqual(w.meta.更新, "2026-07-05");
    assert.strictEqual(w.meta.view!.lon0, 112.0);
    assert.strictEqual(w.meta.view!.lat0, 34.5);
    assert.ok(w.meta.view!.degPerPx0! > 0);
    assert.deepStrictEqual(w.units, []);
    /* 直径钳 [20,140]（红线）+ 盖章：200 请求钳成 140＝1400 列上下、格边恰 100m */
    const span = (w.meta.bbox!.latMax - w.meta.bbox!.latMin) * w.meta.kmPerDeg!;
    assert.ok(Math.abs(span - 140) < 0.5, `dia=200 钳成 140km（实得 ${span.toFixed(1)}）`);
    assert.strictEqual(w.meta.gridN, autoGridN(w.meta), "烘焙同规盖章");
    assert.ok(w.meta.gridN! >= 1395 && w.meta.gridN! <= 1405, `≈1400 列（实得 ${w.meta.gridN}）`);
  });
  it("切平面投影：带入内容的经度按中心纬度折算（lon′=心+(lon−心)×cosφ）＝落真实公里位", () => {
    const w = createTacticalWorld(srcWorld(), ev, 60, {});
    const cosc = Math.cos(34.5 * Math.PI / 180);
    const in2 = w.nodes.find(n => n.id === "in2")!;
    assert.strictEqual(in2.lon, +(112 + 0.2 * cosc).toFixed(4), "东偏 0.2° 的城按 cosφ 折进平面");
    assert.strictEqual(in2.lat, 34.4, "纬向不折");
    assert.strictEqual(w.nodes.find(n => n.id === "in1")!.lon, 112, "中心处的点不动");
    const ov = w.terrainOverrides.find(o => o.t === "water")!;
    assert.strictEqual(ov.lon, +(112 + 0.1 * cosc).toFixed(4), "涂改块心同规投影（块尺寸 step 原样＝粗块初稿的既有近似）");
    /* 物理核对：in2 与中心的东西向距离,平面账 ＝ 母图球面账（这正是投影的目的;照抄经纬会 +27%@34.5°） */
    const flatKm = Math.abs(in2.lon - 112) * w.meta.kmPerDeg!;
    const sphereKm = 0.2 * (2 * Math.PI * 10000 / 360) * cosc;
    assert.ok(Math.abs(flatKm - sphereKm) < 0.2, `平面账 ${flatKm.toFixed(1)}km ≈ 球面账 ${sphereKm.toFixed(1)}km`);
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
  /* —— 底稿快照物化（2026-08-26）：auto/island 底稿锚图框,子图换 bbox 即重摇（实测同点 78~94% 不同）——
     烘焙改为把母图当年可见网格烙成子图涂改、子图底稿 plain。下三测锁「母子图同点地貌一致」不变量。 —— */
  const cellOf = (g: Grid, lon: number, lat: number): string => {
    const c = Math.floor((lon - g.bb.lonMin) / g.step), r = Math.floor((lat - g.bb.latMin) / g.step);
    return g.cells[Math.max(0, Math.min(g.rows - 1, r))][Math.max(0, Math.min(g.cols - 1, c))];
  };

  it("auto 母图（平面）烘焙＝真快照：子图任意点最终地貌与母图同点一致，且叠上母图涂改", () => {
    const src = srcWorld();
    src.meta = { ...src.meta, worldModel: "flat", kmPerDeg: 111.19, terrain: "auto", genSeed: 1234, genStyle: "continent",
      bbox: { lonMin: 105, lonMax: 118, latMin: 28, latMax: 41 } };
    src.terrainOverrides = [{ lon: 112.02, lat: 34.52, t: "water", step: 1 }];   // 母图手涂的湖（1° 粗块）
    const w = createTacticalWorld(src, ev, 140, {});
    assert.strictEqual(w.meta.terrain, "plain", "底稿改 plain＝快照即全部");
    assert.ok(!("genSeed" in w.meta) && !("genStyle" in w.meta), "不再携带生成器参数");
    assert.ok(w.terrainOverrides.length > 0 && w.terrainOverrides.length <= BAKE_CAP);
    const mg = buildGridCells(src.meta, src.terrainOverrides, 3107);
    const sg = buildGridCells(w.meta, w.terrainOverrides, 3107);
    /* 平面母图 cosφ=1＝坐标恒等,可在整个子图幅上撒点逐点比对（避开母格边界半格取样） */
    let same = 0, total = 0;
    for (let i = 0; i < 15; i++) for (let j = 0; j < 15; j++) {
      const lon = mg.bb.lonMin + (Math.floor((112 - 0.6 + i * 0.08 - mg.bb.lonMin) / mg.step) + 0.5) * mg.step;
      const lat = mg.bb.latMin + (Math.floor((34.5 - 0.6 + j * 0.08 - mg.bb.latMin) / mg.step) + 0.5) * mg.step;
      if (lon < w.meta.bbox!.lonMin || lon > w.meta.bbox!.lonMax || lat < w.meta.bbox!.latMin || lat > w.meta.bbox!.latMax) continue;
      total++;
      if (cellOf(sg, lon, lat) === cellOf(mg, lon, lat)) same++;
    }
    assert.ok(total > 100, `采样量足（实得 ${total}）`);
    assert.strictEqual(same, total, `母子图同点地貌逐点一致（${same}/${total}）`);
    assert.strictEqual(cellOf(sg, 112.02, 34.52), "water", "母图手涂的湖烙进快照");
  });

  it("island 母图（球面）烘焙＝真快照：子图边缘不再凭空落水，物化章与母图同点一致", () => {
    const src = srcWorld();
    src.meta = { ...src.meta, terrain: "island", bbox: { lonMin: 90, lonMax: 130, latMin: 20, latMax: 50 } };
    src.terrainOverrides = [];
    const w = createTacticalWorld(src, ev, 140, {});   // ev 在 112/34.5＝母图腹地（island 腹地恒 plain）
    assert.strictEqual(w.meta.terrain, "plain");
    const mg = buildGridCells(src.meta, [], 3107);
    for (const o of w.terrainOverrides)
      assert.strictEqual(o.t, cellOf(mg, 112 + (o.lon - 112) / Math.cos(34.5 * Math.PI / 180), o.lat),
        `物化章=母图同点类别（逆投影后取样,${o.lon},${o.lat}）`);
    const sg = buildGridCells(w.meta, w.terrainOverrides, 3107);
    const bb = w.meta.bbox!;
    for (const [lon, lat] of [[bb.lonMin + sg.step, bb.latMin + sg.step], [bb.lonMax - sg.step, bb.latMax - sg.step]] as const)
      assert.strictEqual(cellOf(sg, lon, lat), "plain", "子图边缘＝母图腹地的平原（旧行为：island 重摇＝边缘落水）");
  });

  it("细格母图（旧 auto 战术图再烘）：k×k 粗采封章数 ≤BAKE_CAP、章尺寸随之放大", () => {
    const src = srcWorld();
    const half = 15 / 111.19;   // 30km 战场
    src.meta = { ...src.meta, mapKind: "tactical", worldModel: "flat", kmPerDeg: 111.19, terrain: "auto", genSeed: 7,
      bbox: { lonMin: 112 - half, lonMax: 112 + half, latMin: 34.5 - half, latMax: 34.5 + half } };
    src.terrainOverrides = [];
    const w = createTacticalWorld(src, { ...ev, lon: 112, lat: 34.5 } as WorldNode, 30, {});
    assert.ok(w.terrainOverrides.length > 0 && w.terrainOverrides.length <= BAKE_CAP, `章数 ${w.terrainOverrides.length} ≤ ${BAKE_CAP}`);
    const mstep = gridStepDeg(src.meta);
    assert.ok(w.terrainOverrides.every(o => (o.step as number) > mstep * 1.5), "粗采瓦片的章尺寸＝k×母格边（k>1）");
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
  it("涂域重采样：源格经逆投影铺进战术细网格、产物写 runs、与渲染解码链连成单一色块", () => {
    const src = srcWorld();
    // [112.0,34.5]=战场中心附近（其所在源格投影后整块落在 20km 战场内）；[10,10]=出界格
    src.factions.push({ id: "fq", 名称: "丁", color: "#440", paint: [{ cells: [[112.0, 34.5], [10, 10]] }] });
    const w = createTacticalWorld(src, ev, 20, {});
    const bb = w.meta.bbox!;
    const L = w.factions.find(f => f.id === "fq")!.paint![0];
    assert.ok(L.runs && L.runs.d.length > 0, "烘焙产物写 runs（写新之约）");
    assert.ok(!("cells" in L), "不再落坐标对");
    const pd = paintStep(w.meta);
    assert.strictEqual(L.runs!.pd, pd, "runs 自记编码格边");
    // 源格块（母图细网格一格）经切平面逆投影落进战场：解码后的格心须全在战场 bbox 内,且成一整块
    const srcPd = paintStep(src.meta);
    const cosc = Math.cos(34.5 * Math.PI / 180);
    const si = Math.round((112.0 - 82) / srcPd - 0.5), sj = Math.round((34.5 - 22) / srcPd - 0.5);   // 源格（DEFAULT_BBOX 原点 82,22）
    const sx0 = 82 + si * srcPd, sy0 = 22 + sj * srcPd;   // 源块在母图空间的下缘
    const tx = (lon: number) => 112 + (lon - 112) * cosc;
    let n = 0;
    eachPaintCenter(L, bb, (x, y) => {
      n++;
      assert.ok(x >= bb.lonMin && x <= bb.lonMax && y >= bb.latMin && y <= bb.latMax, `细格心应在战场 bbox 内：${x},${y}`);
      assert.ok(x >= tx(sx0) - pd && x <= tx(sx0 + srcPd) + pd, `细格心经向应落在投影后的源块内：${x}`);
      assert.ok(y >= sy0 - pd && y <= sy0 + srcPd + pd, `细格心纬向应落在源块内：${y}`);
    });
    const expect = Math.round(srcPd * cosc / pd) * Math.round(srcPd / pd);
    assert.ok(n >= expect * 0.85 && n <= expect * 1.15, `源块应铺满 ≈${expect} 细格（得 ${n}）`);
    // 与 overlay 同一条解码链：重采样后应连成单一边界环（修前=每个粗格只亮一个孤立细格的碎点）
    assert.strictEqual(territoryLoops(L, bb, 0, pd).length, 1, "应为单一连续色块");
  });
  it("resamplePaintRuns：粗→细铺满、细→粗格心采样、同网格等值往返、空入 null、行程按行压紧", () => {
    const srcBB = { lonMin: 0, lonMax: 10, latMin: 0, latMax: 10 };
    // 粗→细：源 1° 格 [2,3)×[3,4) → 目标 0.5° 网格（bbox 2..4×3..5）＝每行一条 [j,i0,len] 行程
    assert.deepStrictEqual(
      resamplePaintRuns([[2.5, 3.5]], srcBB, 1, { lonMin: 2, lonMax: 4, latMin: 3, latMax: 5 }, 0.5),
      { pd: 0.5, d: [0, 0, 2, 1, 0, 2] });
    // 细→粗：目标格心 (2.5,2.5) 不在细格 [2,2.5) 内=不亮；在 [2.5,3) 内=亮（分辨率损失语义）
    assert.strictEqual(resamplePaintRuns([[2.25, 2.25]], srcBB, 0.5, srcBB, 1), null);
    assert.deepStrictEqual(resamplePaintRuns([[2.75, 2.75]], srcBB, 0.5, srcBB, 1), { pd: 1, d: [2, 2, 1] });
    // 同 bbox 同 pd：等值往返（解码回同一格）
    const rt = resamplePaintRuns([[2.5, 3.5]], srcBB, 1, srcBB, 1)!;
    assert.deepStrictEqual([...paintCellSet({ runs: rt }, srcBB, 1)], [...paintCellSet([[2.5, 3.5]], srcBB, 1)]);
    // 空入 null（层保 cells:[] 的旧形状,「有涂域」语义由层的存在担保）；runs 源双认
    assert.strictEqual(resamplePaintRuns([], srcBB, 1, srcBB, 1), null);
    assert.strictEqual(resamplePaintRuns(undefined, srcBB, 1, srcBB, 1), null);
    assert.deepStrictEqual(resamplePaintRuns({ runs: rt }, srcBB, 1, srcBB, 1), rt, "runs 进 runs 出＝定点");
  });
  it("子图跨度＝dia/kmPerDeg 均分（平面化后经纬同跨，⚠ 期望有意翻转：原 tacDiaDeg 球面经跨按 cosφ 拉宽）", () => {
    const w = createTacticalWorld(srcWorld(), ev, 60, {});
    const bb = w.meta.bbox!, k = w.meta.kmPerDeg!;
    assert.ok(Math.abs((bb.lonMax - bb.lonMin) - 60 / k) < 1e-3, "经跨");
    assert.ok(Math.abs((bb.latMax - bb.latMin) - 60 / k) < 1e-3, "纬跨与经跨相等＝平面方图");
  });
});

/* —— 出图图例：内容＝「这一帧真出现的」（2026-08 补测：修过一次相位口径，此前只有 CDP 锁） —— */
describe("出图图例条目 legendItems", () => {
  const W = {
    meta: { mapKind: "tactical" as const },
    factions: [{ id: "f1", 名称: "秦", color: "#000" }, { id: "f2", 名称: "赵", color: "#fff", since: 200 }],
    nodes: [{ id: "n1", type: "city", lon: 1, lat: 1, certainty: "inferred" },
            { id: "n2", type: "city", lon: 2, lat: 2, certainty: "legend", since: 200 }],
    edges: [{ from: "n1", to: "n2", type: "road", certainty: "legend" },
            { from: "n1", to: "n2", type: "wall", certainty: "inferred" }],
    units: [{ id: "u1", kind: "linf", track: [{ t: 0, lon: 1, lat: 1, st: "battle" }] },
            { id: "u2", kind: "lcav", track: [{ t: 300, lon: 2, lat: 2 }] }],
    decor: [], terrainOverrides: []
  } as unknown as Parameters<typeof legendItems>[0];

  it("当刻不在场的不列（派系时段、未入场的部队、当刻无该状态）", () => {
    const at0 = legendItems(W, 0);
    assert.deepStrictEqual(at0.facs.map(f => f.id), ["f1"], "f2 的时段还没开始");
    assert.deepStrictEqual(at0.kinds, ["linf"], "u2 在 t=300 才入场");
    assert.deepStrictEqual(at0.stats, ["battle"]);
    const at300 = legendItems(W, 300);
    assert.deepStrictEqual(at300.facs.map(f => f.id), ["f1", "f2"]);
    assert.deepStrictEqual(at300.kinds.sort(), ["lcav", "linf"]);
  });

  it("关掉的层不列：部队层关＝兵种与状态行一并消失（原先关了层仍照列）", () => {
    const off = legendItems(W, 0, { units: false });
    assert.deepStrictEqual([off.kinds, off.stats], [[], []]);
    assert.deepStrictEqual(off.facs.map(f => f.id), ["f1"], "派系还由地点/涂域撑着，不该跟着消失");
  });

  it("派系行三层任一开着就列，全关才收（涂域/地点/部队都看不见时才谈不上「出现」）", () => {
    assert.deepStrictEqual(legendItems(W, 0, { politics: false, nodes: false }).facs.map(f => f.id), ["f1"]);
    assert.deepStrictEqual(legendItems(W, 0, { politics: false, nodes: false, units: false }).facs, []);
  });

  it("可靠性档按各自的层收：关地点只剩连线那档，关掉线型层则该边不算", () => {
    assert.deepStrictEqual(legendItems(W, 0).certs.sort(), ["inferred", "legend"]);
    assert.deepStrictEqual(legendItems(W, 0, { nodes: false }).certs.sort(), ["inferred", "legend"], "两条边各带一档");
    assert.deepStrictEqual(legendItems(W, 0, { nodes: false, wall: false }).certs, ["legend"], "只剩 road 边的传说档");
    assert.deepStrictEqual(legendItems(W, 0, { nodes: false, wall: false, road: false }).certs, []);
  });

  it("战术专属层在战略图上不算「出现」（同 layerOn 的 tacOnly 门）", () => {
    const strat = { ...W, meta: {} } as typeof W;
    assert.deepStrictEqual(legendItems(strat, 0).kinds, ["linf"], "units 不是 tacOnly，战略图照列");
  });
});

/* —— 渲染材质表与八度门控（render/material.ts；GL/CPU 观感同构的数值真源）—— */
describe("渲染材质表", () => {
  it("水域基底一律全零：任何生态叠上去都画不出地面质感", () => {
    for (const eco of ["", "/forest", "/grassland", "/marsh", "/desert"]) {
      const m = materialFor("water" + eco);
      assert.deepStrictEqual([m.canopy, m.dune, m.ridge, m.marsh, m.rough, m.albVar, m.rock], [0, 0, 0, 0, 0, 0, 0], "water" + eco);
    }
  });
  it("生态签名各归其位：森林=林冠、荒漠=沙丘且不岩化、沼泽=墩洼且不岩化、山地=棱脊最大", () => {
    assert.ok(materialFor("plain/forest").canopy > 0);
    assert.ok(materialFor("plain/desert").dune > 0);
    assert.strictEqual(materialFor("plain/desert").rock, 0);
    assert.ok(materialFor("plain/marsh").marsh > 0);
    assert.strictEqual(materialFor("plain/marsh").rock, 0);
    const ridges = allComposites().map(c => materialFor(c).ridge);
    assert.strictEqual(Math.max(...ridges), materialFor("mountain").ridge, "纯山地的棱脊权重是全表最大");
  });
  it("旧 8 类与未知串走 parseComposite 回退：forest=plain/forest 同值、垃圾串=平原", () => {
    assert.deepStrictEqual(materialFor("forest"), materialFor("plain/forest"));
    assert.deepStrictEqual(materialFor("__proto__"), materialFor("plain"));
  });
  it("materialTable 与 allComposites 同序同长（GL uniform 数组按 compositeIndex 对齐）", () => {
    assert.strictEqual(materialTable().length, allComposites().length);
  });
  it("八度门控：整幅视角（≈33px/度）恒零＝旧缩放档观感保持；放大单调增到 1", () => {
    assert.strictEqual(octaveGate(33, MICRO_F0), 0, "fit 视角下微八度基频必须为零");
    assert.strictEqual(octaveGate(14, MICRO_F0), 0, "更远视角同理");
    assert.ok(octaveGate(120, MICRO_F0) > 0, "放大后淡入");
    assert.strictEqual(octaveGate(8 * MICRO_F0 + 1, MICRO_F0), 1, "波长 ≥8px 全强");
    let prev = -1;
    for (const p of [30, 60, 90, 120, 150, 200]) { const g = octaveGate(p, MICRO_F0); assert.ok(g >= prev); prev = g; }
  });
  it("域扭曲总幅 <半格：主副频合成的最坏位移不吃掉相邻格（类型斑块不漂出本格邻域）", () => {
    assert.ok((0.5 + 0.5 * 0.35) * FX.warpAmp < 0.5, "0.675×warpAmp 须 <0.5 格");
  });
  it("装饰噪声门（批7 下半）：平坦低地关死、真坡与丘/山类型恒 1、水域与粗格场恒 1＝旧观感", () => {
    const plain = materialFor("plain").rough, hill = materialFor("hill").rough, mtn = materialFor("mountain").rough;
    assert.strictEqual(decoGate(0.3, plain, 1, 1), 0, "平原内部平地（smac p50 0.1~0.4）＝装饰归零");
    assert.strictEqual(decoGate(6, plain, 1, 1), 1, "平原上的真坡（沟壁 smac≥4）＝装饰全强");
    assert.strictEqual(decoGate(0, hill, 1, 1), 1, "丘陵类型 rough 兜底恒 1＝已验收观感不动");
    assert.strictEqual(decoGate(0, mtn, 1, 1), 1, "山地同理");
    assert.strictEqual(decoGate(0.3, plain, 0, 1), 1, "水域(land=0)恒 1＝水面观感逐位");
    assert.strictEqual(decoGate(0.3, plain, 1, 0), 1, "粗格场(fine=0)恒 1＝relief=0 旧图逐位契约");
    const mid = decoGate(2.5, plain, 1, 1);
    assert.ok(mid > 0 && mid < 1, "渐入区间内连续过渡：" + mid);
  });
  it("雪线按米折算：战术图标定 900m 时高于全部可及高程＝秋季战场不再画成雪山；缺省标定只剩最高峰挂雪", () => {
    // 井陉 elevUnitM=900：山地 0.9 + 起伏噪声(0.30×amp×2×±0.5) + 宏观 fbm(±0.24) 也够不着 → 无雪
    assert.ok(snowEOf({ elevUnitM: 900 }) > 0.9 + 0.30 + 0.24, "900m 标定下雪线不可及");
    // 缺省 2000m：只有山地起伏峰顶（>1.0）越线——旧 0.82 起整片发白的病由此根除
    const e = snowEOf(undefined);
    assert.ok(e > 0.95 && e < 1.2, "缺省标定下雪线落在 0.95..1.2（仅最高峰）：" + e);
    assert.strictEqual(snowEOf({ elevUnitM: 2000 }), snowEOf(undefined), "显式 2000 与缺省同值");
  });
});

/* —— 印章池：头注早写着「纯逻辑 poolInsert 走 node:test」，而 tests 里一直零引用 —— */
describe("自定义印章池 poolInsert", () => {
  const A = (id: string) => ({ id, src: "data:" + id }) as Parameters<typeof poolInsert>[1];
  it("新章插到最前；同 id 去重（重传一张即置顶而非留两份）", () => {
    assert.deepStrictEqual(poolInsert([A("a"), A("b")], A("c")).map(x => x.id), ["c", "a", "b"]);
    assert.deepStrictEqual(poolInsert([A("a"), A("b")], A("b")).map(x => x.id), ["b", "a"]);
  });
  it("满容量按 cap 截尾（最老的挤掉），不改入参", () => {
    const pool = ["a", "b", "c"].map(A);
    assert.deepStrictEqual(poolInsert(pool, A("d"), 3).map(x => x.id), ["d", "a", "b"]);
    assert.deepStrictEqual(pool.map(x => x.id), ["a", "b", "c"], "入参须原样");
  });
});

describe("异常文本 errText（报错要说得出是哪一回事）", () => {
  it("Chromium 真配额的 QuotaExceededError：message 是空串，仍须报出错误名", () => {
    /* 形状取自 2026-08-07 的 CDP 实测：把配额压到 1KB 后写 3MB，事务 abort 给出的
       t.error 就是这个——name 有、message 为空串。末尾那条 `|| e` 兜底正是为它而在，
       删掉它这里就变成一句空话（底栏原先直读 .message，退成了「存储异常」）。 */
    const quota = new DOMException("", "QuotaExceededError");
    assert.strictEqual(quota.message, "", "前提：真配额的 message 就是空串");
    assert.strictEqual(errText(quota), "QuotaExceededError");
  });
  it("有 message 的照常取 message；null/undefined 才回落「未知错误」", () => {
    assert.strictEqual(errText(new Error("配额超限")), "配额超限");
    assert.strictEqual(errText({ message: "与另一处的改动冲突——保存已暂停" }), "与另一处的改动冲突——保存已暂停");
    assert.strictEqual(errText(null), "未知错误");
    assert.strictEqual(errText(undefined), "未知错误");
  });
});

/* —— 2026-08 审查修复批：覆盖保证 / 涂域取整同式 / 校验加固 / 折线穿越烘焙 —— */
describe("网格覆盖保证（gridStepDeg 行向项）", () => {
  it("瘦高图幅不再被 2048 行封顶静默截断：行×步长盖满纬跨", () => {
    // 0.01°×10°：行闸 byRows=2 被 60 列下限顶穿，旧步长 ⇒ 5 万行→截断成 4% 覆盖（审查实测）
    const m = { bbox: { lonMin: 0, lonMax: 0.01, latMin: 0, latMax: 10 } };
    const g = buildGridCells(m, [], 3100);
    assert.ok(g.rows <= 2048, `行数在轴护栏内（得 ${g.rows}）`);
    assert.ok(g.rows * g.step >= 10 - 1e-6, `覆盖整个纬跨（${(g.rows * g.step).toFixed(3)}°/10°）`);
    assert.ok(g.cols * g.step >= 0.01 - 1e-9, "经跨同样盖满");
  });
  it("常规图幅步长逐位不变（行向项不咬）", () => {
    const m = { bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 } };
    assert.strictEqual(gridStepDeg(m), Math.max(0.0002, 48 / autoGridN(m)), "缺省档＝旧式");
    const tac = { mapKind: "tactical" as const, worldModel: "flat" as const, kmPerDeg: 111.19,
      bbox: { lonMin: 0, lonMax: 1.2592, latMin: 34, latMax: 35.2592 }, gridN: 1400 };
    assert.strictEqual(gridStepDeg(tac), 1.2592 / 1400, "140km 战术盖章档＝旧式（1.26/2048 更小不咬）");
  });
});

describe("涂域行列与地形网格同式（ceil−1e-9）", () => {
  it("跨度÷步长带分数时 paintDims 与 buildGridCells 行列一致（旧 round 少一行＝贴边涂不上）", () => {
    const m = { bbox: { lonMin: 0, lonMax: 48, latMin: 0, latMax: 25 }, gridN: 801 };   // 25/step=417.19
    const g = buildGridCells(m, [], 3100);
    const d = paintDims(m.bbox, paintStep(m));
    assert.strictEqual(d.cols, g.cols, "列一致");
    assert.strictEqual(d.rows, g.rows, `行一致（得 ${d.rows}/${g.rows}）`);
    assert.strictEqual(g.rows, 418, "ceil 把 417.19 收成 418（round 曾给 417）");
  });
  it("黄金域（DEFAULT_BBOX÷0.5 整除）两式同值＝逐位不变", () => {
    const d = paintDims(undefined, 0.5);
    assert.strictEqual(d.cols, 96);
    assert.strictEqual(d.rows, 64);
  });
});

describe("存档校验加固（2026-08 审查批）", () => {
  it("factions[].paint 成员为 null/原始值：不抛、报警告（旧实现 null.runs 直接 TypeError）", () => {
    const r = validateWorld({ meta: {}, nodes: [], factions: [{ id: "f", paint: [null, 5, { cells: [] }] }] });
    assert.strictEqual(r.ok, true);
    assert.ok(r.warnings.filter(i => i.msg.includes("涂域层成员不是对象")).length === 2, "两个坏成员各报一条");
  });
  it("嵌套数组量级闸：超长 track/pts/作战线 pts 报 fatal（逐帧遍历的 DoS 面）", () => {
    const big = new Array(100001).fill(0);
    assert.strictEqual(validateWorld({ meta: {}, nodes: [], units: [{ track: big }] }).ok, false, "航点");
    assert.strictEqual(validateWorld({ meta: {}, nodes: [], edges: [{ type: "river", pts: big }] }).ok, false, "折线");
    assert.strictEqual(validateWorld({ meta: {}, nodes: [{ id: "e", type: "event", lon: 1, lat: 2, ops: [{ kind: "adv", pts: big }] }] }).ok, false, "作战线");
    const okTrack = new Array(200).fill({ t: 1, lon: 1, lat: 2 });
    assert.strictEqual(validateWorld({ meta: {}, nodes: [], units: [{ track: okTrack }] }).ok, true, "常规量级放行");
  });
  it("涂改上限随编辑器能力抬高：31 万条不再被拒（能保存出的档必须能再导入）", () => {
    const ov = { lon: 1, lat: 2, t: "plain", step: 0.001 };
    const r = validateWorld({ meta: {}, nodes: [], terrainOverrides: new Array(310000).fill(ov) });
    assert.strictEqual(r.ok, true);
  });
  it("bbox 坐标量级闸：跨度合法但坐标天文（>1e6°）拒开（浮点格心精度劣化＝渲染乱码）", () => {
    assert.strictEqual(validateWorld({ meta: { bbox: { lonMin: 5e6, lonMax: 5e6 + 10, latMin: 0, latMax: 1 } }, nodes: [] }).ok, false);
    assert.strictEqual(validateWorld({ meta: { bbox: { lonMin: -180, lonMax: 180, latMin: -85, latMax: 85 } }, nodes: [] }).ok, true, "合法球面幅照旧放行");
  });
  it("印章资产外链（非 data:/blob:）报警告——渲染端同判不请求不绘制", () => {
    const r = validateWorld({ meta: {}, nodes: [], assets: [{ id: "a", src: "https://evil.example/x.png" }],
      decor: [{ id: "d", kind: "img:a", lon: 1, lat: 2 }] });
    assert.strictEqual(r.ok, true);
    assert.ok(r.warnings.some(i => i.msg.includes("内嵌数据")), "外链要说话");
  });
});

describe("线段∩矩形（segIntersectsRect）与折线穿越烘焙", () => {
  it("两端都在框外的横贯段＝相交；旁过/NaN＝不相交；端点在框内＝相交", () => {
    assert.strictEqual(segIntersectsRect(-5, 0.5, 5, 0.5, 0, 0, 1, 1), true, "横贯");
    assert.strictEqual(segIntersectsRect(-5, 2, 5, 2, 0, 0, 1, 1), false, "旁过");
    assert.strictEqual(segIntersectsRect(0.5, 0.5, 9, 9, 0, 0, 1, 1), true, "一端在内");
    assert.strictEqual(segIntersectsRect(0.5, 0.5, 0.5, 0.5, 0, 0, 1, 1), true, "退化点在内");
    assert.strictEqual(segIntersectsRect(2, 2, 2, 2, 0, 0, 1, 1), false, "退化点在外");
    assert.strictEqual(segIntersectsRect(NaN, 0.5, 5, 0.5, 0, 0, 1, 1), false, "NaN 不得空放行");
    assert.strictEqual(segIntersectsRect(-5, -5, 5, 5, 0, 0, 1, 1), true, "对角穿越");
  });
  it("烘焙：两端都在战场外的横贯河带入（RDP 直河曾整条消失）；远处河仍剔除", () => {
    const src: World = {
      meta: { 名称: "母", worldModel: "sphere", planetRadiusKm: 10000, terrain: "plain", calendar: { months: 12, dpm: 30 } },
      factions: [], decor: [], terrainOverrides: [], units: [],
      nodes: [],
      edges: [
        { type: "river", pts: [[105, 34.5], [119, 34.5]] },   // 横贯：顶点全在 60km 框外
        { type: "river", pts: [[105, 40], [119, 40]] }        // 远处：不带入
      ]
    } as unknown as World;
    const ev = { id: "e", 名称: "役", type: "event", lon: 112, lat: 34.5, year: 3107 } as WorldNode;
    const w = createTacticalWorld(src, ev, 60, {});
    assert.strictEqual(w.edges.length, 1, "横贯河带入、远河剔除");
    assert.strictEqual(w.edges[0].type, "river");
    const cosc = Math.cos(34.5 * Math.PI / 180);
    assert.strictEqual(w.edges[0].pts![0][0], +(112 + (105 - 112) * cosc).toFixed(4), "折线顶点仍走切平面投影");
  });
});

describe("笔画连续 core/brush（2026-08-19 用户实报「涂域/地形笔刷拖快或笔刷大就断成一个个点」）", () => {
  const CELL = 0.001;   // 格边（度）；断言一律折成「格」来读
  it("落点间距：单格笔不粗于 0.9 格、大笔取 0.75×半径——相邻两盘必相接", () => {
    assert.ok(brushDabStepDeg(CELL, 0) / CELL <= 0.9 + 1e-12, "R=0 时按半径取步长会得 0，必须由 0.9 格兜住");
    for (const R of [1, 2, 5, 40, 256]) {
      const cells = brushDabStepDeg(CELL, R) / CELL;
      assert.ok(cells <= R, `R=${R}：相邻盘心位移 ${cells} 格须 ≤ R，否则两盘脱开＝断线`);
      assert.ok(cells >= 0.9, `R=${R}：步长不得细于 0.9 格（白落一堆同格的笔）`);
    }
  });

  it("插值：相邻落点间距 ≤ step、末点恒是原始末点、原地不动也落一笔", () => {
    const step = 4;
    const raw: [number, number][] = [[10, 10], [23, 44], [23, 44], [80, 12]];
    const out = interpolatePath(raw, 0, 0, step, 10000);
    let px = 0, py = 0;
    for (const [x, y] of out) {
      assert.ok(Math.hypot(x - px, y - py) <= step + 1e-9, "两落点之间不许留缝");
      px = x; py = y;
    }
    assert.deepStrictEqual(out[out.length - 1], [80, 12], "末点恒是这一串的终点");
    assert.deepStrictEqual(interpolatePath([[7, 9]], 7, 9, step, 10000), [[7, 9]], "零位移＝落笔那一下，仍须落一笔");
    assert.deepStrictEqual(interpolatePath([], 7, 9, step, 10000), [], "没有原始点就没有落笔");
  });

  it("上限封顶：极端位移丢尾巴而不是把主线程钉死", () => {
    const out = interpolatePath([[100000, 0]], 0, 0, 1, 400);
    assert.strictEqual(out.length, 400);
  });
});

describe("世界尺寸硬上限 core/world（2026-08-19 用户点单「新建图是不是没有硬上限」）", () => {
  it("球面＝物理域：纬钳 ±90、经跨钳 360", () => {
    const b = clampWorldBBox("sphere", { lonMin: -5000, lonMax: 5000, latMin: -300, latMax: 300 });
    assert.strictEqual(b.latMin, -90); assert.strictEqual(b.latMax, 90);
    assert.ok(b.lonMax - b.lonMin <= 360 + 1e-9, "整颗星球就是 360°，再多是重复自己");
  });
  it("平面＝自由标尺，但收在 validate 的致命线上——建得出来的一定导得回去", () => {
    const b = clampWorldBBox("flat", { lonMin: 0, lonMax: 99999, latMin: 0, latMax: 99999 });
    assert.ok(b.lonMax - b.lonMin <= 3600, "同 validate 的经跨红线");
    assert.ok(b.latMax - b.latMin <= 1700, "同 validate 的纬跨红线");
    /* 这条断言是本节存在的理由：钳之前，面板能建出一张过不了自己导入闸的图 */
    const w = blankWorld({ bbox: { lonMin: 0, lonMax: 99999, latMin: 0, latMax: 99999 }, worldModel: "flat" }, "2026-08-19");
    assert.ok(w.meta.bbox!.lonMax - w.meta.bbox!.lonMin <= 3600, "blankWorld 是真闸门（面板那道只为读数如实）");
  });
  it("退化/倒置图幅留一条最小跨度（零跨度的图幅网格与投影都不吃）", () => {
    const b = clampWorldBBox("sphere", { lonMin: 10, lonMax: 10, latMin: 20, latMax: 5 });
    assert.ok(b.lonMax > b.lonMin && b.latMax > b.latMin);
  });
  it("半径与每度里程钳到域内（值也是用户数据，同 MAX_R 之规）", () => {
    const big = blankWorld({ bbox: { lonMin: 0, lonMax: 10, latMin: 0, latMax: 10 }, planetRadiusKm: 9e12, kmPerDeg: 9e12 }, "2026-08-19");
    assert.strictEqual(big.meta.planetRadiusKm, WORLD_RADIUS_KM[1]);
    assert.strictEqual(big.meta.kmPerDeg, WORLD_KM_PER_DEG[1]);
    const tiny = blankWorld({ bbox: { lonMin: 0, lonMax: 10, latMin: 0, latMax: 10 }, planetRadiusKm: 1 }, "2026-08-19");
    assert.strictEqual(tiny.meta.planetRadiusKm, WORLD_RADIUS_KM[0]);
  });
  it("域内的图一字不动（钳只咬荒谬值——出厂默认与三张示例图的图幅都在域内）", () => {
    const bb = { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 };
    assert.deepStrictEqual(clampWorldBBox("sphere", bb), bb);
    assert.deepStrictEqual(clampWorldBBox("flat", { lonMin: -0.63, lonMax: 0.63, latMin: 37.4, latMax: 38.6 }),
      { lonMin: -0.63, lonMax: 0.63, latMin: 37.4, latMax: 38.6 });
  });
});

describe("架空历法扩充 core/calendar（月名/不等长月/一日的时与分）", () => {
  /* 总纲：四项全可选，**缺键＝旧行为逐位**（黄金基准锁着等长路径）；新特性只在真配了的历法上生效。 */
  const UNEVEN = calOf({ monthLens: [31, 28, 31, 30], era: "启" });   // 年长 120 日

  it("不等长月：年长＝各月之和，日戳与年月日往返一致", () => {
    assert.strictEqual(UNEVEN.months, 4);
    assert.strictEqual(UNEVEN.dpy, 120);
    assert.deepStrictEqual(UNEVEN.lens, [31, 28, 31, 30]);
    for (const [y, m, d] of [[0, 1, 1], [0, 1, 31], [0, 2, 1], [0, 2, 28], [0, 4, 30], [7, 3, 15], [-3, 2, 4]]) {
      const T = tacT(UNEVEN, y, m, d);
      assert.deepStrictEqual(fromT(UNEVEN, T), { y, m, d }, `${y}-${m}-${d} 往返`);
    }
    assert.strictEqual(tacT(UNEVEN, 0, 2, 1), 31, "二月初一＝正月 31 日之后");
    assert.strictEqual(tacT(UNEVEN, 1, 1, 1), 120, "次年正月初一＝一整年");
  });

  it("不等长月：越界月按整年进位（与等长式同规）", () => {
    assert.strictEqual(tacT(UNEVEN, 0, 5, 1), tacT(UNEVEN, 1, 1, 1), "第 5 月＝次年正月");
    assert.strictEqual(tacT(UNEVEN, 0, 9, 1), tacT(UNEVEN, 2, 1, 1));
  });

  it("全等长的 monthLens 收敛回等长路径——同一份历法只该有一条数学", () => {
    const c = calOf({ monthLens: [30, 30, 30] });
    assert.ok(!c.lens && !c.off, "不落 lens＝走 months×dpm 旧式（越界语义也跟着旧式，golden 的 m=0/m=13 靠它）");
    assert.strictEqual(c.months, 3); assert.strictEqual(c.dpm, 30); assert.strictEqual(c.dpy, 90);
    for (const [y, m, d] of [[3, 1, 1], [3, 2, 15], [3, 3, 30]]) {
      assert.strictEqual(tacT(c, y, m, d), tacT(calOf({ months: 3, dpm: 30 }), y, m, d));
    }
  });

  it("月名：显示走 monthLabel 单一真源，配了名就不再补「月」字", () => {
    const c = calOf({ months: 3, dpm: 10, monthNames: ["霜月", "", "苍月"] });
    assert.strictEqual(monthLabel(c, 1), "霜月");
    assert.strictEqual(monthLabel(c, 2), "2月", "缺项回退「2月」式");
    assert.strictEqual(monthLabel(c, 3), "苍月");
    assert.ok(fmtT(c, tacT(c, 5, 1, 3)).includes("霜月3日"), "fmtT 用月名且不出「霜月月」");
    assert.strictEqual(monthLabel(calOf(), 3), "3月", "没配月名＝与地球历同式");
  });

  it("一日的时与分：缺省 24×60 与地球历同式，进制可配", () => {
    const C0 = calOf();
    assert.strictEqual(fmtDayTime(C0, 0), "00:00");
    assert.strictEqual(fmtDayTime(C0, 0.5), "12:00");
    assert.strictEqual(fmtDayTime(C0, 0.5 + 30 / 1440), "12:30");
    const c = calOf({ months: 12, dpm: 30, hoursPerDay: 10, minutesPerHour: 100 });
    assert.strictEqual(c.hpd, 10); assert.strictEqual(c.mph, 100);
    assert.strictEqual(fmtDayTime(c, 0), "0:00", "位宽随进制走（10 时制＝一位）");
    assert.strictEqual(fmtDayTime(c, 0.5), "5:00");
    const T = parseYMD(c, "3107-3-7 3:45")!;
    assert.strictEqual(fmtYMD(c, T), "3107-3-7 3:45", "解析↔显示往返");
    assert.strictEqual(parseYMD(c, "3107-3-7 10:00"), null, "越出本历法的时数＝解析不出（不静默进位到次日）");
    assert.strictEqual(parseYMD(c, "3107-3-7 3:100"), null, "分同理");
    assert.strictEqual(parseYMD(C0, "3107-3-7 24:00"), null, "缺省 24×60 与旧判据 h>23||mi>59 逐位等价");
  });

  it("防御：不合法的扩充字段一律当没给（历法是存档与模板里的自由数据）", () => {
    const c = calOf({ monthLens: ["x", -3, 0] as never, monthNames: ["", "  "], hoursPerDay: 0, minutesPerHour: "x" as never });
    assert.ok(!c.lens && !c.names);
    assert.strictEqual(c.hpd, 24); assert.strictEqual(c.mph, 60, "非正/非数的一日分法＝回落 24×60");
    assert.strictEqual(c.months, 12); assert.strictEqual(c.dpy, 360);
  });
});

/* 缩放两头（2026-08-20 用户点单「战术图最小到 500m、战略图最小到 50km 比例尺」）：
   放大到底＝比例尺档位，配「任何图至少 10× 可放大」的小图护栏，最内层是物理地板 minDegPerPx。
   ⚠ 夹具自己算 fit（与 pointer.fitDpp 同式），免得拿实现自证。 */
describe("缩放极限 minDppFor（比例尺档位 + 小图护栏 + 物理地板）", () => {
  const W = 1440, H = 900;
  const fitOf = (m: Meta): number => {
    const bb = m.bbox!;
    const cosLat = m.worldModel === "flat" ? 1 : Math.max(0.05, Math.cos((bb.latMin + bb.latMax) / 2 * Math.PI / 180));
    return Math.max((bb.lonMax - bb.lonMin) * cosLat / W, (bb.latMax - bb.latMin) / H) * 1.1;
  };
  const kmPx = (m: Meta, dpp: number): number => dpp * kmPerDegLat(m);   // ＝比例尺读数的口径
  const TAC: Meta = { mapKind: "tactical", worldModel: "flat", kmPerDeg: 111.19,
    bbox: { lonMin: 0, lonMax: 1.2591, latMin: 38, latMax: 39.2591 } };          // 140km 战场
  const STRAT: Meta = { worldModel: "sphere", planetRadiusKm: 10000,
    bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 } };                 // 48°×32°
  const SMALL: Meta = { worldModel: "sphere", planetRadiusKm: 6371,
    bbox: { lonMin: 100, lonMax: 103, latMin: 30, latMax: 33 } };                // 3°×3°≈330km

  it("战术图：物理地板 5m/px 更严，档位轮不到说话＝现状逐位不变", () => {
    const v = minDppFor(TAC, fitOf(TAC));
    assert.strictEqual(v, minDegPerPx(TAC));
    assert.ok(Math.abs(kmPx(TAC, v) - 0.005) < 1e-9, "5 m/px ⇒ 比例尺目标 0.55km ⇒ 恰停在「500 m」档");
  });
  it("战略大图：恰停在 50km 档（≈455 m/px）", () => {
    const v = minDppFor(STRAT, fitOf(STRAT));
    assert.ok(Math.abs(kmPx(STRAT, v) - 50 / 110) < 1e-9);
    assert.ok(v < fitOf(STRAT), "放大到底必须严格细于缩小到底");
  });
  it("中小战略图走护栏：档位比全图整屏还粗时不许把相机钉死", () => {
    const fit = fitOf(SMALL), byScale = 50 / (110 * kmPerDegLat(SMALL));
    assert.ok(byScale > fit, "前提：3° 的图按 50km 档，放大极限会落在缩小极限之外");
    const v = minDppFor(SMALL, fit);
    assert.ok(Math.abs(v - fit / 10) < 1e-12, "护栏＝至少 10 倍可放大");
    assert.ok(v < fit);
  });
  it("无图幅（fit 非正）＝只按档位与地板定，不产 NaN", () => {
    for (const f of [0, -1, NaN, Infinity]) {
      const v = minDppFor(STRAT, f);
      assert.ok(isFinite(v) && v > 0, `fit=${f} 应有有限正值`);
      assert.ok(Math.abs(kmPx(STRAT, v) - 50 / 110) < 1e-9);
    }
  });
});


/* 端点契约（2026-08-31 审查）：A* 的返回是**格心口径**——它的头注就这么写。坏的是消费端
   把格心里程当端到端里程用，故断言分两层：astar 保持格心语义（黄金基准锁着），
   computeRoute/unitLegs 必须把退化情形翻译成用户读得懂的里程。 */
describe("寻路端点契约（起格通行门与同格退化）", () => {
  const META: Meta = { worldModel: "flat", kmPerDeg: 100 };
  const mkGrid = (cells: string[][]): Grid => ({
    bb: { lonMin: 0, latMin: 0, lonMax: cells[0].length, latMax: cells.length },
    step: 1, cols: cells[0].length, rows: cells.length, cells
  });
  const fill = (t: string) => Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => t));
  const LAND = mkGrid(fill("plain"));
  const world = { meta: META, factions: [], nodes: [], edges: [], decor: [], terrainOverrides: [], units: [] } as unknown as World;
  const cr = (g: Grid, a: [number, number], b: [number, number], arm: "land" | "water" | "air") =>
    computeRoute(META, g, undefined, world, 0, { lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] }, arm);

  it("起讫同格：astar 仍是单点格心 dist=0（格心口径不变）", () => {
    const r = astar(META, LAND, undefined, [1.1, 1.1], [1.9, 1.9], "land")!;
    assert.deepStrictEqual(r.path, [[1.5, 1.5]]);
    assert.strictEqual(r.dist, 0);
  });
  it("起讫同格：computeRoute 报端点直线而非 0（0 km/0 日/迂回 ×0 是谎报）", () => {
    const c = cr(LAND, [1.1, 1.1], [1.9, 1.9], "land");
    assert.ok(c.dist != null && c.dist > 100, `同格里程应≈113km，实得 ${c.dist}`);
    assert.strictEqual(c.dist, c.straight);
  });
  it("起讫同格：unitLegs 不把同格行军记成零里程，route 仍记可达", () => {
    const u = { id: "u", kind: "infantry", speed: 30, track: [{ t: 0, lon: 1.1, lat: 1.1 }, { t: 5, lon: 1.9, lat: 1.9 }] };
    const [leg] = unitLegs(META, LAND, undefined, u as never);
    assert.ok(leg.km > 100, `同格腿里程应≈113km，实得 ${leg.km}`);
    assert.strictEqual(leg.route, true);
  });
  it("完全同一点：里程 0 且不产 NaN（迂回率的 0/0 由读数层守）", () => {
    const c = cr(LAND, [1.5, 1.5], [1.5, 1.5], "land");
    assert.strictEqual(c.dist, 0);
    assert.strictEqual(c.straight, 0);
  });

  const water = fill("plain"); water[5][5] = "water"; water[5][6] = "water";
  const SEA = mkGrid(water);
  it("起格不可通行＝不可达：水军不得自陆格起步（旧码沿 ∞ 松弛给出非法航路）", () => {
    assert.strictEqual(astar(META, SEA, undefined, [4.5, 4.5], [6.5, 5.5], "water"), null);
    assert.strictEqual(cr(SEA, [4.5, 4.5], [6.5, 5.5], "water").fail, true);
  });
  it("终格不可通行＝不可达（邻格代价门本就守着，防回归）", () => {
    assert.strictEqual(astar(META, SEA, undefined, [5.5, 5.5], [4.5, 4.5], "water"), null);
  });
  it("起讫同格且该格不可通行：返回不可达，不是 dist=0", () => {
    assert.strictEqual(astar(META, SEA, undefined, [7.2, 7.2], [7.8, 7.8], "water"), null);
    assert.strictEqual(cr(SEA, [7.2, 7.2], [7.8, 7.8], "water").fail, true);
  });
  it("合法水路不受起格门影响（防守卫把正常航路一起挡了）", () => {
    const r = astar(META, SEA, undefined, [5.5, 5.5], [6.5, 5.5], "water");
    assert.ok(r && r.path.length === 2, "相邻两水格应连通");
  });

  /* 端到端里程（2026-08-31）：格心折线漏掉两端连接段，端点靠近格边时行程会短过直线
     ——迂回率 <1 几何上不可能，而这个里程直接喂耗时档与超速判定。 */
  it("行程恒不短于直线（旧口径在细格上会算出迂回 ×0.69）", () => {
    // 相邻两格、两端各贴一侧格边：格心距 100km，而端点直线接近 200km
    const c = cr(LAND, [1.01, 5.5], [2.99, 5.5], "land");
    assert.ok(c.dist != null && c.dist >= c.straight - 1e-9, `行程 ${c.dist} 短过直线 ${c.straight}`);
  });
  it("路径以精确起点开头、精确终点结束（画布上起终记号与路线不留断口）", () => {
    const c = cr(LAND, [1.01, 5.5], [4.99, 5.5], "land");
    assert.deepStrictEqual(c.path![0], [1.01, 5.5]);
    assert.deepStrictEqual(c.path![c.path!.length - 1], [4.99, 5.5]);
    assert.ok(c.path!.length > 2, "中间仍走格心");
  });
  it("端点恰在格心上时不留零长段", () => {
    const c = cr(LAND, [1.5, 5.5], [4.5, 5.5], "land");
    const dup = c.path!.some((q, i) => i > 0 && q[0] === c.path![i - 1][0] && q[1] === c.path![i - 1][1]);
    assert.strictEqual(dup, false, "折线里不该有重合点");
  });
  it("沿途地形分段恰好铺满全程（连接段也计入）", () => {
    const c = cr(LAND, [1.01, 5.5], [4.99, 5.5], "land");
    const sum = Object.values(c.report!.terr).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - c.dist!) < 1e-9, `分段合计 ${sum} ≠ 全程 ${c.dist}`);
  });
});

/* 时间轴范围（2026-08-31 审查）：原先只看 事件年 / 派系·地点·连线的 since 四样，于是「归属沿革」
   「涂绘疆域」「只写讫点」「战略图部队」四类图的真史料在时间轴上根本走不到（钳在默认 2980–3107）。 */
describe("战略时间轴范围涵盖全部时段来源（strategicExtent）", () => {
  const W = (o: Partial<World>): World =>
    ({ meta: {}, factions: [], nodes: [], edges: [], decor: [], terrainOverrides: [], units: [], ...o }) as World;
  const rangeOf = (o: Partial<World>) => { const r = yearRangeOf(W(o), NaN); return [r.min, r.max]; };

  it("只有归属沿革 owners 的图：范围罩住 100–200，不再落回默认", () => {
    const w = W({ nodes: [{ id: "n", type: "city", lon: 1, lat: 1, owners: [{ faction: "f", since: 100, until: 200 }] }] as WorldNode[] });
    const r = yearRangeOf(w, 150);
    assert.ok(r.min <= 100 && r.max >= 200, `实得 ${r.min}–${r.max}`);
    assert.strictEqual(r.year, 150, "当前年在范围内就不该被弹走");
  });
  it("只有涂绘疆域 paint 时段的图", () => {
    assert.deepStrictEqual(rangeOf({ factions: [{ id: "f", paint: [{ since: 500, until: 600, cells: [] }] }] as never }), [480, 607]);
  });
  it("战略图部队航点撑开范围（原先只有战术分支收航点）", () => {
    assert.deepStrictEqual(rangeOf({ units: [{ id: "u", track: [{ t: 700, lon: 1, lat: 1 }, { t: 800, lon: 2, lat: 2 }] }] as never }), [680, 807]);
  });
  it("只写讫点的地点：范围留出看得见它的余量", () => {
    const w = W({ nodes: [{ id: "n", type: "city", lon: 1, lat: 1, until: 150 }] as WorldNode[] });
    const r = yearRangeOf(w, NaN);
    assert.ok(r.min < 150, `应能拨到 until 之前，实得 min=${r.min}`);
    assert.ok(activeAt(w.nodes[0], r.min), "范围下限上该地点必须真看得见");
  });
  it("作战线时段与涂改时段同样计入", () => {
    assert.deepStrictEqual(rangeOf({ nodes: [{ id: "e", type: "event", lon: 1, lat: 1, ops: [{ kind: "attack", pts: [[0, 0], [1, 1]], since: 900, until: 910 }] }] as never }), [880, 917]);
    assert.deepStrictEqual(rangeOf({ terrainOverrides: [{ lon: 1, lat: 1, t: "water", since: 1200 }] as never }), [1180, 1207]);
  });
  it("「至今」哨兵 until>=9999 不计入上界（否则时间轴撑到近万年）", () => {
    assert.deepStrictEqual(rangeOf({ factions: [{ id: "f", since: 3000, until: 9999 }] as never }), [2980, 3007]);
  });
  it("全无时段＝仍回默认区间（旧档零变化）", () => {
    assert.strictEqual(strategicExtent(W({ nodes: [{ id: "n", type: "city", lon: 1, lat: 1 }] as WorldNode[] })), null);
    assert.deepStrictEqual(rangeOf({ nodes: [{ id: "n", type: "city", lon: 1, lat: 1 }] as WorldNode[] }), [2980, 3107]);
  });
});

/* 嵌套集合形状守卫（2026-08-31 审查）：坏档的一个字符串就能让帧循环每帧抛异常且无法局部恢复。 */
describe("嵌套集合非数组＝删键（normalizeWorld 统一守卫）", () => {
  const BAD = () => ({
    meta: {},
    factions: [{ id: "f", paint: "坏", territory: "坏" }],
    nodes: [{ id: "n", type: "city", lon: 1, lat: 1, owners: "坏", ops: "坏", ranges: [null, { km: 3 }] }],
    units: [{ id: "u", kind: "inf", ranges: "坏" }]
  });
  it("五个嵌套集合非数组一律删键，消费端拿到的形状都是「没有」", () => {
    const w = normalizeWorld(BAD()) as unknown as Record<string, never[]>;
    assert.strictEqual((w.factions[0] as Record<string, unknown>).paint, undefined);
    assert.strictEqual((w.factions[0] as Record<string, unknown>).territory, undefined);
    assert.strictEqual((w.nodes[0] as Record<string, unknown>).owners, undefined);
    assert.strictEqual((w.nodes[0] as Record<string, unknown>).ops, undefined);
    assert.strictEqual((w.units[0] as Record<string, unknown>).ranges, undefined);
  });
  it("防御圈里的 null 成员被剔除（drawRanges 读 null.km 会抛）", () => {
    const w = normalizeWorld(BAD());
    assert.deepStrictEqual(w.nodes[0].ranges, [{ km: 3 }]);
  });
  it("坏档走完 normalize 后，消费端不再抛（原先每帧红条）", () => {
    const w = normalizeWorld(BAD());
    assert.deepStrictEqual(paintLayersAt(w.factions[0], 100), []);
    assert.strictEqual(ownerAt(w.nodes[0], 100), null);
    assert.doesNotThrow(() => (w.nodes[0].ranges || []).forEach(r => void (+r.km || 0)));
  });
  it("一次 normalize 即到位：再跑一遍不再变（这些键的不动点）", () => {
    const a = JSON.parse(JSON.stringify(normalizeWorld(BAD())));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(normalizeWorld(JSON.parse(JSON.stringify(a))))), a);
  });
  it("validate 对这五个都出声（旧版能开的档不许 fatal）", () => {
    const v = validateWorld(BAD());
    assert.strictEqual(v.ok, true, "不许升为 fatal");
    const paths = v.warnings.map(w => w.path);
    for (const k of ["factions[0].paint", "factions[0].territory", "nodes[0].owners", "nodes[0].ops"])
      assert.ok(paths.includes(k), `缺 ${k} 的提示：${paths.join(" / ")}`);
  });
});

/* 数据不变量提示（2026-08-31 审查）：这些原先一声不吭地进库，坏在看不见的地方。 */
describe("导入不变量提示（一律 warning，不拒开）", () => {
  const V = (o: object) => validateWorld({ meta: {}, nodes: [], ...o }).warnings.map(w => `${w.path}|${w.msg}`);
  it("起讫倒置：该对象在任何时刻都不存在", () => {
    assert.ok(V({ nodes: [{ id: "n", type: "city", lon: 1, lat: 1, since: 300, until: 100 }] }).some(m => m.includes("起讫倒置")));
  });
  it("负行军速度：need 会变负并被判成不超速", () => {
    assert.ok(V({ units: [{ id: "u", kind: "inf", speed: -0.1 }] }).some(m => m.includes("speed")));
  });
  it("部队 / 布景 id 重复", () => {
    assert.ok(V({ units: [{ id: "u", kind: "inf" }, { id: "u", kind: "inf" }] }).some(m => m.includes("部队 id")));
    assert.ok(V({ decor: [{ id: "d", kind: "tree" }, { id: "d", kind: "tree" }] }).some(m => m.includes("布景 id")));
  });
  it("同刻多个航点：只有最后一个生效", () => {
    assert.ok(V({ units: [{ id: "u", kind: "inf", track: [{ t: 5, lon: 1, lat: 1 }, { t: 5, lon: 9, lat: 9 }] }] }).some(m => m.includes("只有最后一个生效")));
  });
  it("合法档零噪音（防守卫把正常数据也报一遍）", () => {
    assert.deepStrictEqual(V({ nodes: [{ id: "n", type: "city", lon: 1, lat: 1, since: 100, until: 200 }],
      units: [{ id: "u", kind: "inf", speed: 30, track: [{ t: 1, lon: 1, lat: 1 }, { t: 2, lon: 2, lat: 2 }] }] }), []);
  });
});

/* 同刻航点的改写与显示同源（2026-08-31 审查）：unitPos 反向扫描取末一个，setUnitPoint 原先用
   findIndex 改首个＝「选中当日拖一下」画面纹丝不动。 */
describe("同刻航点：改写与显示指同一点", () => {
  const mkU = (track: { t: number; lon: number; lat: number }[]) =>
    ({ id: "u", kind: "inf", track }) as unknown as Parameters<typeof setUnitPoint>[0];
  it("拖动改的是 unitPos 显示的那一个", () => {
    const u = mkU([{ t: 5, lon: 1, lat: 1 }, { t: 5, lon: 9, lat: 9 }]);
    assert.deepStrictEqual(unitPos(u, 5), { lon: 9, lat: 9, i: 1 });
    setUnitPoint(u, 5, 4, 4);
    assert.deepStrictEqual(unitPos(u, 5), { lon: 4, lat: 4, i: 1 });
  });
  it("无重复时刻时行为不变（异日插入仍按日排序、同日只改坐标）", () => {
    const u = mkU([{ t: 1, lon: 1, lat: 1 }]);
    setUnitPoint(u, 3, 2, 2);
    setUnitPoint(u, 2, 5, 5);
    assert.deepStrictEqual((u.track || []).map(q => q.t), [1, 2, 3]);
    setUnitPoint(u, 1, 7, 7);
    assert.deepStrictEqual((u.track || [])[0], { t: 1, lon: 7, lat: 7 });
  });
});
