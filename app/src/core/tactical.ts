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
import type { Meta, PaintLayer, World, WorldNode } from "./types.ts";

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

export interface DiaDeg { lonSpan: number; latSpan: number }
/** 战场直径(km)→经纬跨度(度)。球面：纬向=km/每纬度km，经向再除 cos(lat)（高纬保护≤85°）；平面：均分 */
export function tacDiaDeg(meta: Meta | undefined, diaKm: number, lat: number): DiaDeg {
  const m = meta || {};
  if (m.worldModel === "flat") { const k = flatKmPerDeg(m); return { lonSpan: diaKm / k, latSpan: diaKm / k }; }
  const latSpan = diaKm / (2 * Math.PI * ((+(m.planetRadiusKm as number)) || 10000) / 360);
  return { lonSpan: latSpan / Math.max(0.087, Math.cos(toRad(lat))), latSpan };
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
    说明: `「${ev.名称 || ""}」战术地图（${fmtYear(cs, yr)}，直径≈${d}km），自「${m.名称 || ""}」生成：地形/地点/派系为当年快照；时间轴细化到日。`,
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
