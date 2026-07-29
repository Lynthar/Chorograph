/* 领域常量（自 v0.14 index.html 原样迁移；黄金基准测试与旧实现深度比对——
   改这里的任何数值都是行为变更，须先想清楚旧存档兼容）。 */
import type { Arm, Ecotype, Landform, TerrainId } from "./types.ts";

/* 8 种地形：显示名 / 陆军寻路代价 / 底色 */
export const TERRAIN: Record<TerrainId, { 名: string; land: number; color: string }> = {
  plain:    { 名: "平原", land: 1.0, color: "#d7e3b8" },
  coast:    { 名: "沿海", land: 1.1, color: "#cfe6cf" },
  hill:     { 名: "丘陵", land: 1.6, color: "#c9cf9a" },
  forest:   { 名: "森林", land: 1.8, color: "#9fbf8e" },
  desert:   { 名: "荒漠", land: 1.4, color: "#e6d9ad" },
  marsh:    { 名: "水泽", land: 2.4, color: "#a9ccc4" },
  mountain: { 名: "山地", land: 3.2, color: "#c2b199" },
  water:    { 名: "水域", land: 9.0, color: "#a9c7de" }
};
export const TERRAIN_ORDER: TerrainId[] = ["plain", "coast", "hill", "forest", "desert", "marsh", "mountain", "water"];

/* 手绘布景（Inkarnate 式点缀，与寻路网格无关，纯视觉） */
export const DECOR: Record<string, { 名: string }> = {
  peak: { 名: "雪峰" }, mount: { 名: "山峰" }, hillock: { 名: "丘陵" },
  tree: { 名: "乔木" }, pine: { 名: "松林" }, shrub: { 名: "灌丛" },
  reed: { 名: "沼草" }, dune: { 名: "沙丘" }, rock: { 名: "岩石" }
};
/* 各布景印章的基准像素尺寸（× d.size × 缩放；自 v0.14 DECOR_BASE 迁移） */
export const DECOR_BASE: Record<string, number> = {
  peak: 11, mount: 9, hillock: 5.5, tree: 5, pine: 5.5, shrub: 4, reed: 4.5, dune: 6, rock: 4
};
/** 自定义印章（kind:"img:<id>"）默认基准像素（长边 × size × 缩放；与内置雪峰相当） */
export const DECOR_BASE_IMG = 14;

/* 生态区配套：每种地形自动散布的点缀（确定性哈希，不会漂移）
   条目：k=印章 p=每格概率 s=基准大小 dx/dy=格内附加偏移 */
export const TERRAIN_ECO: Partial<Record<TerrainId, { k: string; p: number; s: number; dx?: number; dy?: number }[]>> = {
  mountain: [{ k: "peak", p: 0.55, s: 10 }, { k: "peak", p: 0.22, s: 6.5, dx: 0.34, dy: 0.12 }],
  hill:     [{ k: "mount", p: 0.4, s: 5.5 }, { k: "shrub", p: 0.1, s: 2.8, dx: -0.3, dy: 0.25 }],
  forest:   [{ k: "tree", p: 0.85, s: 4.6 }, { k: "tree", p: 0.55, s: 3.8, dx: 0.3, dy: -0.22 }, { k: "pine", p: 0.4, s: 5, dx: -0.32, dy: 0.18 }],
  desert:   [{ k: "dune", p: 0.34, s: 6 }, { k: "rock", p: 0.08, s: 3.5, dx: 0.3, dy: 0.3 }],
  marsh:    [{ k: "reed", p: 0.5, s: 4.5 }, { k: "reed", p: 0.28, s: 3.6, dx: 0.35, dy: 0.2 }],
  plain:    [{ k: "shrub", p: 0.06, s: 3.2 }, { k: "tree", p: 0.045, s: 4, dx: -0.3, dy: 0.2 }],
  coast:    [{ k: "shrub", p: 0.08, s: 3 }, { k: "rock", p: 0.04, s: 2.8, dx: 0.3, dy: -0.2 }]
};

/* 图层定义 + 预设（tacOnly=战术图专属） */
export interface LayerDef { id: string; 名: string; on: boolean; tacOnly?: boolean }
export const LAYERS: LayerDef[] = [
  { id: "terrain", 名: "地形底图", on: true },
  { id: "contour", 名: "等高线", on: false },
  { id: "decor", 名: "布景(手绘点缀)", on: true },
  { id: "graticule", 名: "经纬网", on: false },
  { id: "politics", 名: "政治·派系范围", on: true },
  { id: "range", 名: "地点范围", on: true },
  { id: "road", 名: "道路", on: true },
  { id: "river", 名: "河流", on: true },
  { id: "trade", 名: "商路·经济", on: true },
  /* 工事（2026-07 特化柱B，平价白名单）：壁垒/长城/堑壕/岸线线型——不设 tacOnly（长城属战略语汇） */
  { id: "wall", 名: "工事(壁垒·岸线)", on: true },
  { id: "nodes", 名: "地点", on: true },
  { id: "labels", 名: "地名标签", on: true },
  { id: "notes", 名: "标注(自由文本)", on: true },
  { id: "events", 名: "军事·战役(事件点)", on: true },
  { id: "arrows", 名: "军事·作战线(攻势/防线)", on: true },
  { id: "units", 名: "军事·部队(兵棋)", on: true, tacOnly: true },
  { id: "trails", 名: "军事·行军尾迹", on: true, tacOnly: true },
  { id: "ranges", 名: "军事·火力射程", on: true, tacOnly: true },
  /* 视野（v0.15 新增，平价白名单）：部队侦察/瞭望半径点线圈 */
  { id: "vision", 名: "军事·视野范围", on: true, tacOnly: true }
];
export const PRESETS: Record<string, Record<string, 1>> = {
  "政治": { terrain: 1, politics: 1, range: 1, road: 1, nodes: 1, labels: 1, notes: 1 },
  "军事": { terrain: 1, politics: 1, range: 1, road: 1, river: 1, wall: 1, nodes: 1, labels: 1, notes: 1, events: 1, arrows: 1, units: 1, trails: 1, ranges: 1, vision: 1 },
  "经济": { terrain: 1, road: 1, river: 1, trade: 1, range: 1, nodes: 1, labels: 1, notes: 1 },
  "地理": { terrain: 1, contour: 1, decor: 1, graticule: 1, river: 1, range: 1, nodes: 1, labels: 1, notes: 1 },
  "战术": { terrain: 1, contour: 1, decor: 1, road: 1, river: 1, wall: 1, range: 1, nodes: 1, labels: 1, notes: 1, events: 1, arrows: 1, units: 1, trails: 1, ranges: 1, vision: 1 },   // contour: 战场地文=棱线/凹路,等高线即战术图的骨架（2026-07 特化 P0 白名单）；wall=柱B 同批白名单
  "全部": { terrain: 1, contour: 1, decor: 1, graticule: 1, politics: 1, range: 1, road: 1, river: 1, trade: 1, wall: 1, nodes: 1, labels: 1, notes: 1, events: 1, arrows: 1, units: 1, trails: 1, ranges: 1, vision: 1 }
};

/* 地点类型（11 类）→ 记号。rank 控制随缩放显隐：0=永远可见…4=贴近才见 */
export const NODE_STYLE: Record<string, { r: number; sym: string; 名: string; rank: number; shape: string }> = {
  capital:  { r: 8, sym: "★", 名: "都城", rank: 0, shape: "star" },
  major:    { r: 6.5, sym: "◉", 名: "主要城市", rank: 1, shape: "ring" },
  city:     { r: 5, sym: "●", 名: "城市", rank: 2, shape: "dot" },
  town:     { r: 4, sym: "○", 名: "城镇", rank: 3, shape: "dot" },
  village:  { r: 3, sym: "·", 名: "乡村", rank: 4, shape: "dot" },
  fortress: { r: 6, sym: "▲", 名: "要塞", rank: 1, shape: "tri" },
  port:     { r: 5, sym: "⚓", 名: "港口", rank: 2, shape: "dot" },
  ford:     { r: 4.5, sym: "═", 名: "渡口", rank: 3, shape: "rect" },
  event:    { r: 5.5, sym: "▽", 名: "事件点", rank: 2, shape: "triDown" },
  resource: { r: 5, sym: "◆", 名: "资源点", rank: 3, shape: "diamond" },
  special:  { r: 5.5, sym: "✦", 名: "特殊地点", rank: 1, shape: "spark" },
  /* 战场微地物（2026-07 特化柱B，additive 白名单）：战场测绘语汇——旧版打开回退 city 记号+导入提示 */
  camp:     { r: 5.5, sym: "▣", 名: "营垒", rank: 2, shape: "camp" },
  pass:     { r: 5, sym: "⋈", 名: "隘口", rank: 2, shape: "pass" },
  bridge:   { r: 4.5, sym: "∩", 名: "桥梁", rank: 3, shape: "bridge" },
  summit:   { r: 4.5, sym: "△", 名: "制高点", rank: 3, shape: "summit" },
  manor:    { r: 5, sym: "⌂", 名: "庄园", rank: 3, shape: "house" },
  site:     { r: 4.5, sym: "⊕", 名: "考古点", rank: 3, shape: "site" },
  /* 标注（v0.15 新增，旧版打开降级为 city 记号+文本标签）：无记号、名称即图面文本 */
  label:    { r: 4, sym: "🏷", 名: "标注", rank: 0, shape: "dot" }
};
export const NODE_TYPES = Object.keys(NODE_STYLE);
/* 旧类型迁移（旧存档/导入自动升级） */
export const LEGACY_TYPE: Record<string, string> = { vassalseat: "major", prefecture: "major", sect: "special", ruin: "special", region: "special" };

/* 事件点子类型：只有"战役"带 对阵/结果/作战线 */
export const EVENT_TYPES: Record<string, { 名: string; sym: string }> = {
  battle:   { 名: "战役", sym: "⚔" },
  politics: { 名: "政事", sym: "🏛" },
  disaster: { 名: "灾异", sym: "🌋" },
  anomaly:  { 名: "异象", sym: "✨" },
  other:    { 名: "其他", sym: "▽" }
};

/* 各地点类型的属性模板（表单"属性"框：每行「键：值」） */
export const NODE_TMPL: Record<string, string> = {
  capital: "人口：\n地位：\n经济：\n驻军：\n特产：",
  major: "人口：\n地位：\n经济：\n驻军：\n特产：",
  city: "人口：\n经济：\n驻军：\n特产：",
  town: "人口：\n经济：\n特产：",
  village: "人口：\n生业：",
  fortress: "驻军：\n指挥官：\n防务：\n补给线：",
  port: "人口：\n吞吐：\n主要航线：\n驻泊水师：",
  ford: "通行方式：\n丰水期通行：\n枯水期通行：",
  resource: "资源类型：\n储量：\n产量：\n开采方：\n输往：",
  special: "类别：\n所属/主人：\n品阶：\n出入条件：\n传承/渊源：",
  camp: "驻军：\n主将：\n垒防：\n补给：",
  pass: "通行：\n险要：\n扼守方：",
  bridge: "跨度：\n形制：\n通行：",
  summit: "高程：\n瞰制：\n驻守：",
  manor: "形制：\n驻守：\n围防：",
  site: "年代：\n发现：\n出土：\n对应事件：",
  event: "",
  label: ""
};
export const EVENT_TMPL: Record<string, string> = {
  battle: "攻方兵力：\n守方兵力：\n伤亡：",
  politics: "各方：\n决议/条约：\n影响：",
  disaster: "灾类：\n波及：\n伤亡损失：\n后续：",
  anomaly: "现象：\n波及：\n解读：\n后续：",
  other: ""
};

/* rank → degPerPx 上限（≤阈值才显示） */
export const RANK_ZOOM = [Infinity, 0.2, 0.12, 0.065, 0.045];

/* 连线样式：道路=双线、河流=蓝曲流、商路=紫点线；工事=墨石齿线（2026-07 特化柱B，additive——
   壁垒/长城/堑壕/岸线同一线型，渲染先行**寻路不吃**，画法见 render/edges.strokeWall） */
export const EDGE_STYLE: Record<string, { color: string; w: number; 名: string }> = {
  road: { color: "#6f5228", w: 3.6, 名: "道路" },
  river: { color: "#3f7fc4", w: 2.6, 名: "河流" },
  trade: { color: "#a03aa0", w: 2.4, 名: "商路" },
  wall: { color: "#55504a", w: 2.8, 名: "工事" }
};
export const RIVER_TMPL = "宽度：\n深度：\n流量：\n水质：\n丰水期：\n枯水期：";
export const WALL_TMPL = "形制：\n高度：\n守方：\n存废：";

/* ── 可靠性分级（2026-07 特化柱B）：真史复原的诚实性语汇——考据有据的画成实线，推断的说明是推断。
   **缺键（及未知值）＝确证＝现渲染逐位不变**，确证不落盘＝旧档零迁移；只落地点与连线两域
   （作战线的 dash 已含「复原推断」语义、部队位置本就是复原、标注是自由文本自己会说话）。
   三档起步（用户拍板）：视觉上稳定可辨的只有虚线·淡显·问号三簇，再分读图人记不住；
   「考古确切 vs 文献确切」这类细目写进属性模板的「依据：」行。 —— */
export const CERTAINTY: Record<string, { 名: string; alpha: number; query: boolean; nodeDash: [number, number]; edgeDash: [number, number] }> = {
  inferred: { 名: "推断", alpha: 1, query: false, nodeDash: [3, 2.5], edgeDash: [7, 5] },
  legend: { 名: "传说", alpha: 0.6, query: true, nodeDash: [3, 2.5], edgeDash: [7, 5] }
};
export const CERTAINTY_ORDER = ["inferred", "legend"];
export interface CertaintyStyle { dash: number[] | null; alpha: number; query: boolean; 名: string | null }
/** 确证态（缺键/未知值）：dash=null 即「不改描边」，alpha=1、无问号——现渲染逐位 */
const CERT_SURE: CertaintyStyle = { dash: null, alpha: 1, query: false, 名: null };
/* 逐档预建（渲染热路径每对象一次调用，不在帧内分配对象） */
const CERT_STYLES: Record<"node" | "edge", Record<string, CertaintyStyle>> = { node: {}, edge: {} };
for (const k of CERTAINTY_ORDER) {
  const c = CERTAINTY[k];
  CERT_STYLES.node[k] = { dash: c.nodeDash, alpha: c.alpha, query: c.query, 名: c.名 };
  CERT_STYLES.edge[k] = { dash: c.edgeDash, alpha: c.alpha, query: c.query, 名: c.名 };
}
/** 可靠性 → 渲染样式（纯映射，绘制与图例同源）。地点与连线虚线节奏不同（记号小、线长） */
export function certaintyStyle(v: unknown, kind: "node" | "edge"): CertaintyStyle {
  return (typeof v === "string" && CERT_STYLES[kind][v]) || CERT_SURE;
}

/* 行军速度(km/日)——按军种给速度档（通用默认值） */
export const SPEEDS: Record<Arm, { 名: string; v: number }[]> = {
  land: [{ 名: "大军(辎重)", v: 20 }, { 名: "步兵", v: 30 }, { 名: "急行军", v: 45 }, { 名: "骑兵", v: 60 }],
  water: [{ 名: "漕船(载重/逆流)", v: 35 }, { 名: "帆船(顺风)", v: 70 }],
  air: [{ 名: "飞舟", v: 200 }]
};

/* 部队状态（v0.15 新增）：航点可带 st——自该航点起生效到下一航点；缺省=行军/常态。
   交战/对峙解决「双方部队挨在一起不知道在干什么」；旧版打开忽略此键，零迁移。 */
export const UNIT_STATUS: Record<string, { 名: string; color: string }> = {
  battle:   { 名: "交战", color: "#c0392b" },
  standoff: { 名: "对峙", color: "#a8741a" },
  rout:     { 名: "溃退", color: "#556270" }
};

/* 兵棋部队兵种预设（符号/默认速度/军种） */
export const UNIT_KINDS: Record<string, { 名: string; glyph: string; v: number; arm: Arm }> = {
  inf:   { 名: "步兵", glyph: "✕", v: 30, arm: "land" },
  cav:   { 名: "骑兵", glyph: "╱", v: 60, arm: "land" },
  bow:   { 名: "弓弩", glyph: "⌒", v: 30, arm: "land" },
  siege: { 名: "器械/攻城", glyph: "◎", v: 15, arm: "land" },
  sup:   { 名: "辎重", glyph: "▭", v: 20, arm: "land" },
  navy:  { 名: "水师", glyph: "≈", v: 35, arm: "water" },
  air:   { 名: "飞舟", glyph: "▲", v: 200, arm: "air" },
  mage:  { 名: "修士", glyph: "✦", v: 150, arm: "air" },
  scout: { 名: "斥候", glyph: "◇", v: 75, arm: "land" },
  /* 主帅（2026-07 特化柱B，additive）：glyph 用汉字——单位框字形走 system-ui 粗体，跨平台恒定不入 emoji 摇摆 */
  cmd:   { 名: "主帅", glyph: "帅", v: 60, arm: "land" }
};

/* 地形 → 示意高程 / 自然色阶（渲染层）。
   ⚠ forest/desert 取平原值＝两轴模型下**生态不带高程**（同见 ECO.elevBias）：分类器里森林/荒漠
   与平原同属「低地·中地按湿度分」的同一高度带（terrain.ts），旧值 0.28/0.22 是单轴时代把二者
   当地类排在平原–丘陵之间的残留，涂一笔森林即凭空隆起一片台地。沼泽 0.03 仍保留低洼（真低地，
   亦是高程钳制的设计低地）。此为对黄金基准的 sanctioned 偏离，parity.test「TERRAIN 系列」立白名单。 */
export const ELEV: Record<TerrainId, number> = {
  water: -0.35, marsh: 0.03, coast: 0.06, plain: 0.16,
  desert: 0.16, forest: 0.16, hill: 0.5, mountain: 0.9
};
export const TINT: Partial<Record<TerrainId, [number, number, number]>> = {
  coast: [214, 203, 150], plain: [176, 196, 120], desert: [224, 206, 150],
  forest: [110, 150, 96], hill: [178, 168, 110], marsh: [150, 186, 170], mountain: [168, 150, 128]
};
/* 各类型起伏半幅（×meta.relief；渲染层高程场用，非黄金锁定）：山地最起伏、水域恒平 */
export const RELIEF_AMP: Partial<Record<TerrainId, number>> = {
  mountain: 0.30, hill: 0.14, forest: 0.06, desert: 0.06, plain: 0.05, coast: 0.02, marsh: 0.02
};

/* ── 两轴地形（重构 A）：地貌 LANDFORM × 生态 ECO；设计见 docs/设计/地形重构-设计.md ──
   核心不变式：8 个 canonical 旧复合串经 terrainProps **回退上面的旧四表取值＝逐位精确**
   （保 cellCost/黄金基准）；新组合（hill/forest、plain/grassland… 仅手绘产出）走此二表计算。 */
export type EcoScatter = { k: string; p: number; s: number; dx?: number; dy?: number };
/** 地貌（eco=none 时复合即旧同名类，逐位复现）：陆军代价/底色/生态色调/示意高程/起伏幅度 */
export const LANDFORM: Record<Landform, { 名: string; land: number; color: string; tint: [number, number, number] | null; elev: number; relief: number }> = {
  plain:    { 名: "平原", land: 1.0, color: "#d7e3b8", tint: [176, 196, 120], elev: 0.16, relief: 0.05 },
  coast:    { 名: "沿海", land: 1.1, color: "#cfe6cf", tint: [214, 203, 150], elev: 0.06, relief: 0.02 },
  hill:     { 名: "丘陵", land: 1.6, color: "#c9cf9a", tint: [178, 168, 110], elev: 0.5,  relief: 0.14 },
  mountain: { 名: "山地", land: 3.2, color: "#c2b199", tint: [168, 150, 128], elev: 0.9,  relief: 0.30 },
  water:    { 名: "水域", land: 9.0, color: "#a9c7de", tint: null,            elev: -0.35, relief: 0 }
};
/** 生态（eco≠none 覆盖 color/tint/scatter 并施 costMul/elevBias；none 时全回退地貌）。
    高程只由地貌轴给，生态不抬不降——唯沼泽例外（低洼是其地貌含义）；森林/荒漠 elevBias=0 与上面 ELEV 同源。 */
export const ECO: Record<Ecotype, { 名: string; color: string | null; tint: [number, number, number] | null; costMul: number; elevBias: number; scatter: EcoScatter[] }> = {
  none:      { 名: "无",   color: null,      tint: null,            costMul: 1.0,  elevBias: 0,     scatter: [] },
  forest:    { 名: "森林", color: "#9fbf8e", tint: [110, 150, 96],  costMul: 1.8,  elevBias: 0,     scatter: [{ k: "tree", p: 0.85, s: 4.6 }, { k: "tree", p: 0.55, s: 3.8, dx: 0.3, dy: -0.22 }, { k: "pine", p: 0.4, s: 5, dx: -0.32, dy: 0.18 }] },
  grassland: { 名: "草原", color: "#d2d69a", tint: [190, 190, 118], costMul: 1.05, elevBias: 0,     scatter: [{ k: "shrub", p: 0.14, s: 2.4 }, { k: "shrub", p: 0.07, s: 2.0, dx: 0.3, dy: -0.2 }] },
  marsh:     { 名: "沼泽", color: "#a9ccc4", tint: [150, 186, 170], costMul: 2.4,  elevBias: -0.13, scatter: [{ k: "reed", p: 0.5, s: 4.5 }, { k: "reed", p: 0.28, s: 3.6, dx: 0.35, dy: 0.2 }] },
  desert:    { 名: "荒漠", color: "#e6d9ad", tint: [224, 206, 150], costMul: 1.4,  elevBias: 0,     scatter: [{ k: "dune", p: 0.34, s: 6 }, { k: "rock", p: 0.08, s: 3.5, dx: 0.3, dy: 0.3 }] }
};
/** 旧 TerrainId → canonical 复合串（分类器重贴标签 + 旧档迁移用） */
export const LEGACY_TO_COMPOSITE: Record<TerrainId, string> = {
  plain: "plain", coast: "coast", hill: "hill", mountain: "mountain", water: "water",
  forest: "plain/forest", desert: "plain/desert", marsh: "plain/marsh"
};
const LEGACY_COMPOSITES = new Set<string>(Object.values(LEGACY_TO_COMPOSITE));

/** 复合串 → [地貌, 生态]（生态缺省 none；非法地貌→plain、非法生态→none）。
    旧 TerrainId（如 "forest"）先归一到其 canonical 复合串（"plain/forest"）再拆。 */
export function parseComposite(cell: string): [Landform, Ecotype] {
  const c = cell in LEGACY_TO_COMPOSITE ? LEGACY_TO_COMPOSITE[cell as TerrainId] : (cell || "plain");
  const parts = c.split("/");
  const lf = parts[0] in LANDFORM ? parts[0] : "plain";
  const eco = parts[1] && parts[1] in ECO ? parts[1] : "none";
  return [lf as Landform, eco as Ecotype];
}
/** 规范化为 canonical 复合串（eco=none 省略；旧 id 亦归一） */
export function canonComposite(cell: string): string {
  const [lf, eco] = parseComposite(cell);
  return eco === "none" ? lf : lf + "/" + eco;
}
/** 复合串 → 旧 8 类（渲染诊断 / 平价 flatten：生态优先取旧同名，否则取地貌） */
export function flattenTerrain(cell: string): TerrainId {
  const [lf, eco] = parseComposite(cell);
  if (eco === "forest" || eco === "desert" || eco === "marsh") return eco;
  return (lf in TERRAIN ? lf : "plain") as TerrainId;
}

export interface TerrainProps { lf: Landform; eco: Ecotype; 名: string; land: number; color: string; tint: [number, number, number] | null; elev: number; relief: number; water: boolean; scatter: EcoScatter[] }
const PROPS_CACHE = new Map<string, TerrainProps>();   // 按 cell 串记忆（distinct cell 极少；渲染/高程/寻路热路径免逐格分配）
/** 解析复合地形的有效属性（记忆化，返回对象请只读）。**8 个 canonical 旧复合串回退旧四表＝逐位精确**
    （cellCost/golden 全保）；其余（新组合）由 LANDFORM×ECO 计算。旧 TerrainId 直接传入亦可（内部归一）。 */
export function terrainProps(cell: string): TerrainProps {
  let p = PROPS_CACHE.get(cell);
  if (p) return p;
  const [lf, eco] = parseComposite(cell);
  /* 显示名：纯地貌=地貌名；plain 基底的生态=生态名（"森林"/"沼泽"/"草原"，承旧单轴命名，含水泽→沼泽）；
     非 plain 基底的组合=「地貌·生态」（如 丘陵·森林、水域·沼泽）。名为显示用、不入平价。 */
  const 名 = eco === "none" ? LANDFORM[lf].名 : lf === "plain" ? ECO[eco].名 : LANDFORM[lf].名 + "·" + ECO[eco].名;
  const canon = eco === "none" ? lf : lf + "/" + eco;
  if (LEGACY_COMPOSITES.has(canon)) {
    const t = flattenTerrain(canon);
    p = { lf, eco, 名, land: TERRAIN[t].land, color: TERRAIN[t].color,
      tint: TINT[t] || null, elev: ELEV[t], relief: RELIEF_AMP[t] || 0,
      water: t === "water" || t === "marsh" || t === "coast", scatter: TERRAIN_ECO[t] || [] };
  } else {
    const L = LANDFORM[lf], E = ECO[eco];
    p = { lf, eco, 名, land: L.land * E.costMul,
      color: E.color ?? L.color, tint: E.tint ?? L.tint, elev: L.elev + E.elevBias, relief: L.relief,
      water: lf === "water" || lf === "coast" || eco === "marsh",
      scatter: eco === "none" ? (TERRAIN_ECO[lf as TerrainId] || []) : E.scatter };
  }
  PROPS_CACHE.set(cell, p);
  return p;
}

/* GPU G 通道编码：复合 → 整数索引 lf*5+eco（0–24），shader 据此查 uTColor/uTint（25 项）。 */
export const LANDFORM_ORDER: Landform[] = ["plain", "coast", "hill", "mountain", "water"];
export const ECO_ORDER: Ecotype[] = ["none", "forest", "grassland", "marsh", "desert"];
export const COMPOSITE_COUNT = LANDFORM_ORDER.length * ECO_ORDER.length;   // 25
export function compositeIndex(cell: string): number {
  const [lf, eco] = parseComposite(cell);
  return LANDFORM_ORDER.indexOf(lf) * ECO_ORDER.length + ECO_ORDER.indexOf(eco);
}
/** 按 G 索引顺序枚举全部复合串（renderer 填 uniform 数组用；顺序与 compositeIndex 对齐） */
export function allComposites(): string[] {
  const out: string[] = [];
  for (const lf of LANDFORM_ORDER) for (const eco of ECO_ORDER) out.push(eco === "none" ? lf : lf + "/" + eco);
  return out;
}
/** 复合串是否合法（validate 白名单）：旧 8 类，或 "地貌"/"地貌/生态"（各部分在 LANDFORM/ECO 表内） */
export function isValidTerrain(cell: string): boolean {
  if (cell in LEGACY_TO_COMPOSITE) return true;
  const parts = cell.split("/");
  if (!(parts[0] in LANDFORM)) return false;
  return parts.length === 1 || (parts.length === 2 && parts[1] in ECO);
}

/* 势力涂域格尺寸（0.5°） */
export const PD = 0.5;
