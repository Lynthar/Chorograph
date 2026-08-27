/* GeoJSON 导入管线（core/geojson 纯函数）：扫描归一 / 字段猜测 / 年份解析 / 抽稀 /
   多边形栅格化 / 转换分层。栅格化的结果一律用真消费端 eachPaintCenter 解回来比对，
   免得编码与解码各错一半却对得上。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  convertGeoJSON, GEO_CAPS, GEO_LINE_TYPES, guessMapping, guessNodeType, padBBox,
  parseGeoYear, rasterizePolys, scanGeoJSON, simplifyLine, type GeoMapping
} from "../src/core/geojson.ts";
import { eachPaintCenter } from "../src/core/territory.ts";
import type { BBox } from "../src/core/types.ts";

const BB4: BBox = { lonMin: 0, lonMax: 4, latMin: 0, latMax: 4 };
const feat = (geometry: unknown, properties: Record<string, unknown> = {}) => ({ type: "Feature", geometry, properties });
const fc = (...features: unknown[]) => ({ type: "FeatureCollection", features });
/** 行程编码 → 排序好的 "i,j" 格键（走真消费端解码） */
const cellsOf = (runs: ReturnType<typeof rasterizePolys>, bb: BBox, pd: number): string[] => {
  const out: string[] = [];
  eachPaintCenter(runs ? { runs } : null, bb, (lon, lat) => {
    out.push(Math.round((lon - bb.lonMin) / pd - 0.5) + "," + Math.round((lat - bb.latMin) / pd - 0.5));
  });
  return out.sort();
};
const mapping = (over: Partial<GeoMapping> = {}): GeoMapping => ({
  name: "", type: "", typeDefault: "city", since: "", until: "", group: "",
  lineType: "river", outlineType: "wall", polyAs: "paint", simplify: false, ...over
});

describe("GeoJSON 扫描（scanGeoJSON）", () => {
  it("FeatureCollection：三种几何各归其类，坐标计数与总范围随之", () => {
    const s = scanGeoJSON(fc(
      feat({ type: "Point", coordinates: [10, 20] }),
      feat({ type: "LineString", coordinates: [[0, 0], [1, 1], [2, 0]] }),
      feat({ type: "Polygon", coordinates: [[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]]] })
    ), GEO_CAPS);
    assert.deepEqual(s.counts, { point: 1, line: 1, poly: 1 });
    assert.equal(s.coords, 1 + 3 + 5);
    assert.deepEqual(s.bbox, { lonMin: 0, lonMax: 10, latMin: 0, latMax: 20 });
    assert.equal(s.skipped, 0);
    assert.equal(s.truncated, false);
  });

  it("裸 Feature / 裸 geometry / 要素数组三种外壳都认", () => {
    const g = { type: "Point", coordinates: [1, 2] };
    for (const raw of [feat(g), g, [feat(g)]]) {
      const s = scanGeoJSON(raw, GEO_CAPS);
      assert.equal(s.counts.point, 1, JSON.stringify(raw).slice(0, 30));
      assert.deepEqual(s.features[0].pts, [[1, 2]]);
    }
  });

  it("MultiPoint/MultiLineString/MultiPolygon 展开进同一个要素", () => {
    const s = scanGeoJSON(fc(
      feat({ type: "MultiPoint", coordinates: [[1, 1], [2, 2]] }),
      feat({ type: "MultiLineString", coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }),
      feat({ type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[2, 2], [3, 2], [3, 3], [2, 2]]]] })
    ), GEO_CAPS);
    assert.equal(s.features[0].pts.length, 2);
    assert.equal(s.features[1].lines.length, 2);
    assert.equal(s.features[2].polys.length, 2);
  });

  it("GeometryCollection 拆成多个要素但共享同一份 properties", () => {
    const s = scanGeoJSON(fc(feat({
      type: "GeometryCollection",
      geometries: [{ type: "Point", coordinates: [1, 1] }, { type: "LineString", coordinates: [[0, 0], [1, 1]] }]
    }, { 名称: "并州" })), GEO_CAPS);
    assert.deepEqual(s.counts, { point: 1, line: 1, poly: 0 });
    assert.equal(s.features[0].props, s.features[1].props);
    assert.equal(s.features[1].props.名称, "并州");
  });

  it("坏坐标就地剔除、整个几何不可识别才计入 skipped", () => {
    const s = scanGeoJSON(fc(
      feat({ type: "LineString", coordinates: [[0, 0], ["x", 1], [null, null], [2, 2], [1e300, 0]] }),
      feat({ type: "Fantasy", coordinates: [[0, 0]] }),
      feat(null),
      "不是对象"
    ), GEO_CAPS);
    assert.deepEqual(s.features[0].lines, [[[0, 0], [2, 2]]]);
    assert.equal(s.skipped, 3);
  });

  it("属性键按出现次数排序，空值不计、样本取首个非空", () => {
    const s = scanGeoJSON(fc(
      feat({ type: "Point", coordinates: [0, 0] }, { NAME_CH: "顺天府", BEG_YR: 1644 }),
      feat({ type: "Point", coordinates: [1, 1] }, { NAME_CH: "太原府", 空: "  " })
    ), GEO_CAPS);
    assert.deepEqual(s.keys.map(k => k.key), ["NAME_CH", "BEG_YR"]);
    assert.deepEqual(s.keys[0], { key: "NAME_CH", sample: "顺天府", n: 2 });
  });

  it("要素数与坐标数各有闸；撞上限置 truncated，已收下的部分照常可用", () => {
    const many = fc(...Array.from({ length: 5 }, (_, i) => feat({ type: "Point", coordinates: [i, i] })));
    const byFeat = scanGeoJSON(many, { ...GEO_CAPS, features: 2 });
    assert.equal(byFeat.features.length, 2);
    assert.equal(byFeat.truncated, true);
    const byCoord = scanGeoJSON(many, { ...GEO_CAPS, coords: 3 });
    assert.equal(byCoord.truncated, true);
    assert.ok(byCoord.features.length <= 3);
  });
});

describe("字段映射猜测（guessMapping / guessNodeType）", () => {
  it("CHGIS 式键名整键命中；OHM 式日期键同样认", () => {
    const chgis = guessMapping(scanGeoJSON(fc(feat({ type: "Point", coordinates: [0, 0] },
      { NAME_CH: "顺天府", LEV_RANK: "府", BEG_YR: 1644, END_YR: 1911, DYN_CH: "清" })), GEO_CAPS));
    assert.equal(chgis.name, "NAME_CH");
    assert.equal(chgis.type, "LEV_RANK");
    assert.equal(chgis.since, "BEG_YR");
    assert.equal(chgis.until, "END_YR");
    assert.equal(chgis.group, "DYN_CH");
    const ohm = guessMapping(scanGeoJSON(fc(feat({ type: "Point", coordinates: [0, 0] },
      { name: "Chang'an", start_date: "-0202", end_date: "0904" })), GEO_CAPS));
    assert.equal(ohm.name, "name");
    assert.equal(ohm.since, "start_date");
    assert.equal(ohm.until, "end_date");
  });

  it("一个也认不出就留空，缺省仍是可用的一套", () => {
    const m = guessMapping(scanGeoJSON(fc(feat({ type: "Point", coordinates: [0, 0] }, { zzz: 1 })), GEO_CAPS));
    assert.equal(m.name, "");
    assert.equal(m.group, "");
    assert.equal(m.typeDefault, "city");
    assert.equal(m.polyAs, "paint");
  });

  it("类型值三条路：舆图类型键 / 类型中文名 / 词表；都不中回缺省", () => {
    assert.equal(guessNodeType("fortress", "city"), "fortress");
    assert.equal(guessNodeType("要塞", "city"), "fortress");
    assert.equal(guessNodeType("都城", "city"), "capital");
    assert.equal(guessNodeType("顺天府", "city"), "major");
    assert.equal(guessNodeType("Harbour", "city"), "port");
    assert.equal(guessNodeType("说不清", "town"), "town");
    assert.equal(guessNodeType(null, "village"), "village");
  });

  it("原型链上的键不能冒充类型（值也是用户数据）", () => {
    assert.equal(guessNodeType("toString", "city"), "city");
    assert.equal(guessNodeType("__proto__", "city"), "city");
  });
});

describe("年份解析（parseGeoYear）", () => {
  it("数字、纯年、ISO 日期、负年、BC 与公元前", () => {
    assert.equal(parseGeoYear(1644), 1644);
    assert.equal(parseGeoYear("1644"), 1644);
    assert.equal(parseGeoYear("1644-01-01"), 1644);
    assert.equal(parseGeoYear("-0221"), -221);
    assert.equal(parseGeoYear("221 BC"), -221);
    assert.equal(parseGeoYear("公元前221年"), -221);
    assert.equal(parseGeoYear("AD 1644"), 1644);
    assert.equal(parseGeoYear(0), 0);
  });

  it("认不出与离谱量级一律 null（不能让坏值当成合法年份落盘）", () => {
    for (const v of ["", "   ", "未详", null, undefined, {}, [], NaN, Infinity, 1e7, "12345678"])
      assert.equal(parseGeoYear(v), null, String(v));
  });
});

describe("折线抽稀（simplifyLine）", () => {
  it("共线中点删净，首末点一定留", () => {
    const line: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0]];
    assert.deepEqual(simplifyLine(line, 0.1), [[0, 0], [3, 0]]);
  });

  it("超出容差的拐点留下", () => {
    const line: [number, number][] = [[0, 0], [1, 1], [2, 0]];
    assert.equal(simplifyLine(line, 0.1).length, 3);
    assert.equal(simplifyLine(line, 2).length, 2);
  });

  it("容差 ≤0 或点数不足三，原样返回同一个引用", () => {
    const line: [number, number][] = [[0, 0], [1, 1], [2, 0]];
    const two: [number, number][] = [[0, 0], [1, 1]];
    assert.equal(simplifyLine(line, 0), line);
    assert.equal(simplifyLine(line, -1), line);
    assert.equal(simplifyLine(two, 1), two);
  });

  it("几万点的长折线不爆栈（迭代式的理由）", () => {
    const long: [number, number][] = Array.from({ length: 50000 }, (_, i) => [i * 1e-4, (i % 2) * 1e-6]);
    assert.ok(simplifyLine(long, 1e-3).length < long.length);
  });
});

describe("多边形栅格化（rasterizePolys）", () => {
  it("方形按半开格心判中：[1,3)×[1,3) 恰是四格", () => {
    const runs = rasterizePolys([[[[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]]], BB4, 1, GEO_CAPS);
    assert.deepEqual(cellsOf(runs, BB4, 1), ["1,1", "1,2", "2,1", "2,2"]);
    assert.equal(runs!.pd, 1);
  });

  it("洞被扣掉（偶奇填充）：外环 16 格减内环 4 格", () => {
    const runs = rasterizePolys([[
      [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
      [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]
    ]], BB4, 1, GEO_CAPS);
    const cells = cellsOf(runs, BB4, 1);
    assert.equal(cells.length, 12);
    for (const inner of ["1,1", "1,2", "2,1", "2,2"]) assert.ok(!cells.includes(inner), inner);
  });

  it("多个多边形取并集，不因重叠互相抵消", () => {
    const a: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]];
    const b: [number, number][] = [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]];
    const cells = cellsOf(rasterizePolys([[a], [b]], BB4, 1, GEO_CAPS), BB4, 1);
    assert.deepEqual(cells, ["0,0", "0,1", "1,0", "1,1", "1,2", "2,1", "2,2"]);
  });

  it("比一格还细的多边形兜底涂中心格——政区不能凭空消失", () => {
    const cells = cellsOf(rasterizePolys([[[[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.1]]]], BB4, 1, GEO_CAPS), BB4, 1);
    assert.deepEqual(cells, ["0,0"]);
  });

  it("图外的多边形一格不落；网格超闸返 null", () => {
    assert.equal(rasterizePolys([[[[90, 80], [91, 80], [91, 81], [90, 80]]]], BB4, 1, GEO_CAPS), null);
    assert.equal(rasterizePolys([[[[1, 1], [3, 1], [3, 3], [1, 1]]]], BB4, 1, { ...GEO_CAPS, cells: 4 }), null);
  });
});

describe("转换（convertGeoJSON）", () => {
  const opts = () => ({
    bbox: BB4, pd: 1, palette: ["#111111", "#222222"],
    existingIds: new Set<string>(), factionByName: new Map<string, string>(), caps: GEO_CAPS
  });

  it("点→地点：名称/类型/起讫各就各位，余下属性进「字段」", () => {
    const scan = scanGeoJSON(fc(feat({ type: "Point", coordinates: [1, 2] },
      { NAME_CH: "晋阳", LEV_RANK: "府", BEG_YR: -497, END_YR: 1375, 备注: "并州治所" })), GEO_CAPS);
    const r = convertGeoJSON(scan, mapping({ name: "NAME_CH", type: "LEV_RANK", since: "BEG_YR", until: "END_YR" }), opts());
    assert.equal(r.nodes.length, 1);
    const n = r.nodes[0];
    assert.equal(n.名称, "晋阳");
    assert.equal(n.type, "major");
    assert.equal(n.lon, 1);
    assert.equal(n.lat, 2);
    assert.equal(n.since, -497);
    assert.equal(n.until, 1375);
    assert.deepEqual(n.字段, { 备注: "并州治所" });
  });

  it("线→连线：落成选定线型的自由折线，两端不挂地点", () => {
    const scan = scanGeoJSON(fc(feat({ type: "LineString", coordinates: [[0, 0], [1, 1], [2, 2]] }, { name: "汾水" })), GEO_CAPS);
    const r = convertGeoJSON(scan, mapping({ name: "name", lineType: "river" }), opts());
    assert.equal(r.edges.length, 1);
    assert.equal(r.edges[0].type, "river");
    assert.equal(r.edges[0].名称, "汾水");
    assert.equal(r.edges[0].from, undefined);
    assert.deepEqual(r.edges[0].pts, [[0, 0], [1, 1], [2, 2]]);
  });

  it("面→涂域：按「分组键 × 起讫」分层，同组不同沿革各成一层", () => {
    const sq = (x: number): [number, number][] => [[x, 1], [x + 1, 1], [x + 1, 3], [x, 3], [x, 1]];
    const scan = scanGeoJSON(fc(
      feat({ type: "Polygon", coordinates: [sq(1)] }, { DYN: "汉", BEG: 0, END: 220 }),
      feat({ type: "Polygon", coordinates: [sq(2)] }, { DYN: "汉", BEG: 0, END: 220 }),
      feat({ type: "Polygon", coordinates: [sq(1)] }, { DYN: "汉", BEG: 221, END: 265 }),
      feat({ type: "Polygon", coordinates: [sq(2)] }, { DYN: "魏", BEG: 221, END: 265 })
    ), GEO_CAPS);
    const r = convertGeoJSON(scan, mapping({ group: "DYN", since: "BEG", until: "END" }), opts());
    assert.equal(r.newFactions.length, 2);
    assert.deepEqual(r.newFactions.map(f => f.名称), ["汉", "魏"]);
    assert.deepEqual(r.newFactions.map(f => f.color), ["#111111", "#222222"]);
    const han = r.paintAdd.find(p => p.fid === r.newFactions[0].id)!;
    assert.equal(han.layers.length, 2);
    assert.deepEqual(han.layers.map(L => [L.since, L.until]), [[0, 220], [221, 265]]);
    // 前一层是两块相邻方形的并集，后一层只有一块
    assert.deepEqual(cellsOf(han.layers[0].runs!, BB4, 1), ["1,1", "1,2", "2,1", "2,2"]);
    assert.deepEqual(cellsOf(han.layers[1].runs!, BB4, 1), ["1,1", "1,2"]);
  });

  it("线只落自由折线画得出来的类型——道路/商路要挂两端地点，导进来的线没有地点可挂", () => {
    // render/edges 里只有 river 与 wall 这两支认无端点的 pts；落成别的＝存得下也导得进，就是不显示
    assert.deepEqual(GEO_LINE_TYPES, ["river", "wall"]);
    const m = guessMapping(scanGeoJSON(fc(feat({ type: "LineString", coordinates: [[0, 0], [1, 1]] })), GEO_CAPS));
    assert.ok(GEO_LINE_TYPES.includes(m.lineType), m.lineType);
    assert.ok(GEO_LINE_TYPES.includes(m.outlineType), m.outlineType);
    const scan = scanGeoJSON(fc(
      feat({ type: "LineString", coordinates: [[0, 0], [1, 1]] }),
      feat({ type: "Polygon", coordinates: [[[1, 1], [3, 1], [3, 3], [1, 1]]] })
    ), GEO_CAPS);
    const r = convertGeoJSON(scan, mapping({ polyAs: "both" }), opts());
    assert.equal(r.edges.length, 2);
    for (const e of r.edges) {
      assert.ok(GEO_LINE_TYPES.includes(e.type as typeof GEO_LINE_TYPES[number]), e.type);
      assert.ok(Array.isArray(e.pts) && e.pts.length >= 2, "自由折线必须带 pts");
    }
  });

  it("面可只落边界折线，也可两条都落", () => {
    const scan = scanGeoJSON(fc(feat({ type: "Polygon", coordinates: [[[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]] })), GEO_CAPS);
    const only = convertGeoJSON(scan, mapping({ polyAs: "outline", outlineType: "wall" }), opts());
    assert.equal(only.edges.length, 1);
    assert.equal(only.edges[0].type, "wall");
    assert.equal(only.paintAdd.length, 0);
    const both = convertGeoJSON(scan, mapping({ polyAs: "both" }), opts());
    assert.equal(both.edges.length, 1);
    assert.equal(both.paintAdd.length, 1);
  });

  it("同名派系复用已有 id，不再建一个重名的", () => {
    const scan = scanGeoJSON(fc(feat({ type: "Polygon", coordinates: [[[1, 1], [3, 1], [3, 3], [1, 1]]] }, { DYN: "汉" })), GEO_CAPS);
    const o = { ...opts(), factionByName: new Map([["汉", "f_old"]]) };
    const r = convertGeoJSON(scan, mapping({ group: "DYN" }), o);
    assert.equal(r.newFactions.length, 0);
    assert.deepEqual(r.paintAdd.map(p => p.fid), ["f_old"]);
  });

  it("生成的 id 绕开图里已占用的（并入不能覆盖别人）", () => {
    const scan = scanGeoJSON(fc(
      feat({ type: "Point", coordinates: [1, 1] }),
      feat({ type: "Point", coordinates: [2, 2] })
    ), GEO_CAPS);
    const o = { ...opts(), existingIds: new Set(["gn1"]) };
    const r = convertGeoJSON(scan, mapping(), o);
    const ids = r.nodes.map(n => n.id);
    assert.ok(!ids.includes("gn1"));
    assert.equal(new Set(ids).size, 2);
  });

  it("跳过与截断都要出声（静默丢数据比报错更难查）", () => {
    const scan = scanGeoJSON(fc(
      feat({ type: "Point", coordinates: [1, 1] }),
      feat({ type: "Fantasy", coordinates: [0, 0] })
    ), { ...GEO_CAPS, features: 1 });
    const r = convertGeoJSON(scan, mapping(), opts());
    assert.ok(r.notes.some(s => s.includes("跳过")) || r.notes.some(s => s.includes("只导入了前一部分")), r.notes.join("｜"));
  });

  it("时段层数撞闸：多出来的沿革不导，但必须报出来", () => {
    const scan = scanGeoJSON(fc(...Array.from({ length: 4 }, (_, i) =>
      feat({ type: "Polygon", coordinates: [[[1, 1], [3, 1], [3, 3], [1, 1]]] }, { Y: i }))), GEO_CAPS);
    const r = convertGeoJSON(scan, mapping({ since: "Y" }), { ...opts(), caps: { ...GEO_CAPS, layers: 2 } });
    assert.equal(r.paintAdd[0].layers.length, 2);
    assert.ok(r.notes.some(s => s.includes("未导入")), r.notes.join("｜"));
  });
});

describe("建新图的范围（padBBox）", () => {
  it("四周各留一成余量", () => {
    assert.deepEqual(padBBox({ lonMin: 0, lonMax: 10, latMin: 0, latMax: 20 }, 0),
      { lonMin: -1, lonMax: 11, latMin: -2, latMax: 22 });
  });

  it("退化成一个点时靠最小跨度撑开（否则 bbox 的 min<max 过不了校验）", () => {
    const b = padBBox({ lonMin: 5, lonMax: 5, latMin: 5, latMax: 5 }, 1);
    assert.equal(b.lonMax - b.lonMin, 1);
    assert.equal(b.latMax - b.latMin, 1);
  });
});
