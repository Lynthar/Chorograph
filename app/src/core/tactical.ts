/* 战术图生成（v0.14 createTacticalFromEvent 的纯内核）：以战役年份为准，把"当年在场"的
   地点/连线/布景/派系/地形涂改按战场 bbox 烘焙进一张新战术世界——
   - owners 归属沿革 → 当年归属（faction），owners 键剥离；
   - since/until 一律剥离（战术图内时间轴是"日"，年语义不再适用）；
   - 地形涂改带原块尺寸继承（step，战略=1°粗块）作为战术图初稿底子；
   - 事件点不带入（战役本身即这张图）；units 空（落地后用部队工具编辑）。
   纯函数：不 prompt、不入库、不改 ev；库链接与打开、日期戳(today)由外壳完成。 */
import { flatKmPerDeg, toRad } from "./geo.ts";
import { activeAt, ownerAt, paintLayersAt } from "./time.ts";
import { paintStep, resamplePaintCells } from "./territory.ts";
import { calOf, fmtYear, yearSpanT } from "./calendar.ts";
import type { CalendarCfg, GenStyle, Meta, PaintLayer, TerrainMode, World, WorldModel, WorldNode } from "./types.ts";

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

export interface DiaDeg { lonSpan: number; latSpan: number }
/** 战场直径(km)→经纬跨度(度)。球面：纬向=km/每纬度km，经向再除 cos(lat)（高纬保护≤85°）；平面：均分 */
export function tacDiaDeg(meta: Meta | undefined, diaKm: number, lat: number): DiaDeg {
  const m = meta || {};
  if (m.worldModel === "flat") { const k = flatKmPerDeg(m); return { lonSpan: diaKm / k, latSpan: diaKm / k }; }
  const latSpan = diaKm / (2 * Math.PI * ((+(m.planetRadiusKm as number)) || 10000) / 360);
  return { lonSpan: latSpan / Math.max(0.087, Math.cos(toRad(lat))), latSpan };
}

/* ── 直接新建战术战场（2026-07 特化柱B）：真史战役没有母图可烘——此前只能写脚本手搓 JSON。
   与烘焙共用 tacDiaDeg 与 meta 构造，只是内容全空（parent 亦无）。给校验喂的档形必须完整
   （空数组齐备，同 blankWorld 与 sampleWorld 之规）——meta-only 字面量会被导入校验拦死。 ── */
export interface BlankTacSpec {
  名称?: string;
  worldModel?: WorldModel;
  planetRadiusKm?: number;
  kmPerDeg?: number | null;
  lon: number; lat: number;      // 战场中心
  diaKm: number;                 // 战场直径 km（同烘焙钳 [20,2000]）
  battleYear: number;            // 战役年份（时间轴锚在这一年的日戳区间）
  calendar?: CalendarCfg;        // 缺省不落盘（=custom SE 12×30）；真史战役用 {kind:"earth"}
  terrain?: TerrainMode;
  genSeed?: number; genStyle?: GenStyle;
  relief?: number;
  contourM?: number;             // 最细等高距 米（战场常用 10~100；缺省不落盘=10m）
  vault?: string;
}

/** 新建一张空白战术战场。today=YYYY-MM-DD（外部传入以保持纯函数，同 blankWorld） */
export function blankTacticalWorld(s: BlankTacSpec, today: string): World {
  const d = Math.max(20, Math.min(2000, s.diaKm || 200));
  const lat = Math.max(-85, Math.min(85, s.lat));
  const base: Meta = { worldModel: s.worldModel || "sphere", planetRadiusKm: s.planetRadiusKm };
  const { lonSpan, latSpan } = tacDiaDeg(base, d, lat);
  const bbox = {
    lonMin: +(s.lon - lonSpan / 2).toFixed(4), lonMax: +(s.lon + lonSpan / 2).toFixed(4),
    latMin: +Math.max(-85, lat - latSpan / 2).toFixed(4), latMax: +Math.min(85, lat + latSpan / 2).toFixed(4)
  };
  const cs = calOf(s.calendar);
  const meta: Meta = {
    名称: s.名称 || "新战场",
    说明: `战术战场（${fmtYear(cs, s.battleYear)}，直径≈${d}km）：时间轴细化到日与时辰。`,
    mapKind: "tactical", worldModel: base.worldModel, planetRadiusKm: s.planetRadiusKm,
    terrain: s.terrain || "plain", battleYear: s.battleYear,
    tacSpan: yearSpanT(cs, s.battleYear),
    view: { lon0: s.lon, lat0: lat, degPerPx0: Math.max(0.0004, (bbox.lonMax - bbox.lonMin) / 900) },
    bbox, 版本: "0.6", 更新: today
  };
  if (s.kmPerDeg != null) meta.kmPerDeg = s.kmPerDeg;
  if (s.calendar) meta.calendar = s.calendar;             // 历法创建时定死（改 kind 会重释一切已存日戳）
  if (s.terrain === "auto") { meta.genSeed = s.genSeed; meta.genStyle = s.genStyle; }
  if (s.relief != null && s.relief > 0) meta.relief = s.relief;
  if (s.contourM != null && s.contourM > 0) meta.contourM = s.contourM;
  if (s.vault) meta.vault = s.vault;
  return { meta, factions: [], nodes: [], edges: [], decor: [], terrainOverrides: [], units: [] };
}

export interface TacBakeOpts {
  parentMapId?: string | null;   // 双向链接：meta.parent.map（外壳传当前图 id）
  yearNow?: number;              // 事件无 year 时的年份兜底
  today?: string;               // 更新戳 YYYY-MM-DD（外壳传，保持纯函数）
}

/** 从战役事件点烘焙一张战术世界。dia 内部钳 [20,2000]；units:[] 空 */
export function createTacticalWorld(src: World, ev: WorldNode, dia: number, opts: TacBakeOpts = {}): World {
  const d = Math.max(20, Math.min(2000, dia || 200));
  const m = src.meta || {};
  const yr = isFinite(ev.year as number) ? (ev.year as number) : (opts.yearNow ?? 0);
  const { lonSpan, latSpan } = tacDiaDeg(m, d, ev.lat);
  const bbox = {
    lonMin: +(ev.lon - lonSpan / 2).toFixed(4), lonMax: +(ev.lon + lonSpan / 2).toFixed(4),
    latMin: +Math.max(-85, ev.lat - latSpan / 2).toFixed(4), latMax: +Math.min(85, ev.lat + latSpan / 2).toFixed(4)
  };
  /* 已知边界（2026-07 审阅裁定不改）：inBB 纯数值比较、不做 ±180 经度环绕——全球图上贴反经线
     （半径 1° 内）的战役烘焙会漏采另一侧；寻路网格同样不绕缝（平价锁定域）。实际用图（区域
     大陆/历史战场）触不到该缝，环绕改造涉及重采样/视角/寻路多处，收益不抵风险。 */
  const inBB = (o: { lon: number; lat: number }) => o.lon >= bbox.lonMin && o.lon <= bbox.lonMax && o.lat >= bbox.latMin && o.lat <= bbox.latMax;
  const strip = <T extends object>(o: T): T => { delete (o as { since?: unknown }).since; delete (o as { until?: unknown }).until; return o; };

  // 当年在场的地点（事件点不带入）；归属沿革烘焙为当年归属
  const nodes = src.nodes.filter(n => n.type !== "event" && inBB(n) && activeAt(n, yr)).map(n => {
    const c = strip(clone(n));
    const f = ownerAt(n, yr); if (f) c.faction = f; else delete c.faction;
    delete c.owners; return c;
  });
  const ids = new Set(nodes.map(n => n.id));
  const edges = src.edges.filter(e => activeAt(e, yr) && (
    Array.isArray(e.pts) && e.pts.length >= 2
      ? e.pts.some(p => inBB({ lon: p[0], lat: p[1] }))          // 自由画河：河道任一点入战场即带入
      : (!!e.from && !!e.to && ids.has(e.from) && ids.has(e.to))
  )).map(e => strip(clone(e)));
  const decor = (src.decor || []).filter(dc => inBB(dc) && activeAt(dc, yr)).map(dc => strip(clone(dc)));
  // 带入被引用的自定义印章资产（否则子图 img: 断链）
  const usedAssets = new Set(decor.map(dc => typeof dc.kind === "string" && dc.kind.startsWith("img:") ? dc.kind.slice(4) : "").filter(Boolean));
  const assets = usedAssets.size ? (src.assets || []).filter(a => usedAssets.has(a.id)).map(a => clone(a)) : [];
  const terrainOverrides = (src.terrainOverrides || []).filter(o => inBB(o) && activeAt(o, yr)).map(o => {
    const c = strip(clone(o)); c.step = +(o.step as number) || 1; return c;   // 记原块尺寸(战略=1°)，战术细网格上按粗块盖章为初稿
  });
  const heightOverrides = (src.heightOverrides || []).filter(o => inBB(o) && activeAt(o, yr)).map(o => {
    const c = strip(clone(o)); c.step = +(o.step as number) || 1; return c;   // 高程涂改同规则继承
  });
  /* 涂域随图重采样：cells 是按源图 bbox/pd 存的格心，战术图 paintStep 按 bbox 派生更细步长，
     逐字拷入会被解码成一格一点的碎点（0.5° 粗格只亮 0.05° 一格）——按目标网格重栅格化铺满、出界剔除。
     空层保留（「有涂域」即不回退据点凸包，语义与烘焙前一致）。 */
  const srcPd = paintStep(m), dstPd = paintStep({ mapKind: "tactical", bbox });
  const factions = src.factions.filter(f => activeAt(f, yr)).map(f => {
    const c = strip(clone(f));
    const paint = paintLayersAt(f, yr).map(L => {
      const p = strip(clone(L)) as PaintLayer;
      p.cells = resamplePaintCells(L.cells, m.bbox, srcPd, bbox, dstPd);
      return p;
    });
    if (paint.length) c.paint = paint; else delete c.paint;
    return c;
  });

  const cal = clone(m.calendar || { months: 12, dpm: 30 });
  const cs = calOf(cal);
  const meta: Meta = {
    名称: (ev.名称 || "战役") + "·战术",
    说明: `「${ev.名称 || ""}」战术图（${fmtYear(cs, yr)}，直径≈${d}km），自「${m.名称 || ""}」生成：地形/地点/派系为当年快照；时间轴细化到日。`,
    mapKind: "tactical", worldModel: m.worldModel || "sphere", planetRadiusKm: m.planetRadiusKm,
    terrain: m.terrain || "sample", battleYear: yr, calendar: cal,
    tacSpan: yearSpanT(cs, yr),
    parent: { map: opts.parentMapId || undefined, mapName: m.名称 || "", event: ev.id, eventName: ev.名称 || "" },
    view: { lon0: ev.lon, lat0: ev.lat, degPerPx0: Math.max(0.0004, (bbox.lonMax - bbox.lonMin) / 900) },
    bbox, 版本: "0.6", 更新: opts.today || ""
  };
  if (m.kmPerDeg != null) meta.kmPerDeg = m.kmPerDeg;
  if (m.terrain === "auto") { meta.genSeed = m.genSeed; meta.genStyle = m.genStyle; }
  if (m.relief != null) meta.relief = m.relief;           // 地势起伏与高程标定随图继承（起伏噪声锚定经纬度，战略/战术同位一致）
  if (m.elevUnitM != null) meta.elevUnitM = m.elevUnitM;
  if (m.contourM != null) meta.contourM = m.contourM;
  if (m.vault) meta.vault = m.vault;

  const out: World = { meta, factions, nodes, edges, decor, terrainOverrides, units: [] };
  if (heightOverrides.length) out.heightOverrides = heightOverrides;
  if (assets.length) out.assets = assets;
  return out;
}
