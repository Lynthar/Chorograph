/* 战术图生成（v0.14 createTacticalFromEvent 的纯内核）：以战役年份为准，把"当年在场"的
   地点/连线/布景/派系/地形涂改按战场 bbox 烘焙进一张新战术世界——
   - owners 归属沿革 → 当年归属（faction），owners 键剥离；
   - since/until 一律剥离（战术图内时间轴是"日"，年语义不再适用）；
   - 地形涂改带原块尺寸继承（step，战略=1°粗块）作为战术图初稿底子；
   - 事件点不带入（战役本身即这张图）；units 空（落地后用部队工具编辑）。
   纯函数：不 prompt、不入库、不改 ev；库链接与打开、日期戳(today)由外壳完成。

   ⚠ **战术图恒为平面世界**（2026-08-13 尺度定形批，用户拍板「战术图取消球形星球设置」）：
   战场尺度上曲率毫无意义，平面把三处别扭一次抹平——格子成真正的 100m 正方（球面版东西向
   ×cosφ）、直径上限与纬度无关、距离账走直角。既有球面战术档照旧能开（运行时兼容路径不删），
   只是出生点不再产出球面。尺寸红线「直径或对角线 ≤200km」按两者都不得超读＝方图边长 ≤140km
   （对角线 198km），140 同时是工程甜点：1400×1400=196 万格恰保住全域 4K 精修 ≥2×。 */
import { kmPerDeg, toRad } from "./geo.ts";
import { segIntersectsRect } from "./geometry.ts";
import { autoGridN } from "./grid.ts";
import { activeAt, ownerAt, paintLayersAt } from "./time.ts";
import { paintStep, resamplePaintRuns } from "./territory.ts";
import { calOf, fmtYear, yearSpanT } from "./calendar.ts";
import type { CalendarCfg, GenStyle, Meta, PaintLayer, TerrainMode, World, WorldNode } from "./types.ts";

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

/** 战场直径钳 [20,140]km（血线「直径或对角线 ≤200km」：方图对角线=边长×√2 ⇒ 边长 ≤141.4，
    取整 140＝对角线 198km，两种读法都满足）；blank 与烘焙共用此一处。 */
export const TAC_DIA_KM: readonly [number, number] = [20, 140];
export const tacDiaClamp = (d: number): number => Math.max(TAC_DIA_KM[0], Math.min(TAC_DIA_KM[1], d || 60));
/** 战术平面世界的缺省每度里程（地球级密度＝真史战役坐标读感与文档一致） */
export const TAC_KM_PER_DEG = 111.19;

/* 2026-08-13 平面化：旧的 `tacDiaDeg`（直径 km → 经纬跨度，球面按 cosφ 拉宽经跨）已删——
   战场恒平面后跨度就是 `dia / kmPerDeg` 一行，两个出生点各自写明；既有球面战术档的 bbox
   早已烘死在存档里，运行时不需要它。 */

/* ── 直接新建战术战场（2026-07 特化柱B）：真史战役没有母图可烘——此前只能写脚本手搓 JSON。
   与烘焙共用直径钳与 meta 构造，只是内容全空（parent 亦无）。给校验喂的档形必须完整
   （空数组齐备，同 blankWorld 与 sampleWorld 之规）——meta-only 字面量会被导入校验拦死。 ── */
export interface BlankTacSpec {
  名称?: string;
  kmPerDeg?: number | null;      // 缺省 111.19（创建面板不再问星球参数;手编存档可覆写）
  lon: number; lat: number;      // 战场中心（文档锚,照战役考据抄;平面世界坐标自此起算）
  diaKm: number;                 // 战场直径 km＝方图边长（钳 [20,140]）
  battleYear: number;            // 战役年份（时间轴锚在这一年的日戳区间）
  calendar?: CalendarCfg;        // 缺省不落盘（=custom SE 12×30）；真史战役用 {kind:"earth"}
  terrain?: TerrainMode;
  genSeed?: number; genStyle?: GenStyle;
  relief?: number;
  contourM?: number;             // 最细等高距 米（战场常用 10~100；缺省不落盘=10m）
  vault?: string;
}

/** 新建一张空白战术战场（恒平面）。today=YYYY-MM-DD（外部传入以保持纯函数，同 blankWorld） */
export function blankTacticalWorld(s: BlankTacSpec, today: string): World {
  const d = tacDiaClamp(s.diaKm);
  const lat = Math.max(-85, Math.min(85, s.lat));
  const kmdeg = +(s.kmPerDeg as number) > 0 ? +(s.kmPerDeg as number) : TAC_KM_PER_DEG;
  const span = d / kmdeg;
  const bbox = {
    lonMin: +(s.lon - span / 2).toFixed(4), lonMax: +(s.lon + span / 2).toFixed(4),
    latMin: +Math.max(-85, lat - span / 2).toFixed(4), latMax: +Math.min(85, lat + span / 2).toFixed(4)
  };
  const cs = calOf(s.calendar);
  const meta: Meta = {
    名称: s.名称 || "新战场",
    说明: `战术战场（${fmtYear(cs, s.battleYear)}，边长≈${d}km）：时间轴细化到日与时。`,
    mapKind: "tactical", worldModel: "flat", kmPerDeg: kmdeg,
    terrain: s.terrain || "plain", battleYear: s.battleYear,
    tacSpan: yearSpanT(cs, s.battleYear),
    view: { lon0: s.lon, lat0: lat, degPerPx0: Math.max(0.0004, (bbox.lonMax - bbox.lonMin) / 900) },
    bbox, 版本: "0.6", 更新: today
  };
  if (s.calendar) meta.calendar = s.calendar;             // 历法创建时定死（改 kind 会重释一切已存日戳）
  if (s.terrain === "auto") { meta.genSeed = s.genSeed; meta.genStyle = s.genStyle; }
  /* 起伏缺省 0.6：新战场没有起伏＝类型与手雕高程都渲成光滑圆包（2026-08-08 实证——侵蚀与
     微地形全系于此系数；三张示例战术图均取 0.7 同档）。显式给 0 仍尊重＝有意全平,不落盘 */
  const relief = s.relief ?? 0.6;
  if (relief > 0) meta.relief = relief;
  if (s.contourM != null && s.contourM > 0) meta.contourM = s.contourM;
  if (s.vault) meta.vault = s.vault;
  meta.gridN = autoGridN(meta);   // 尺度身份盖章（创建时定形）：此后法则常数演进不动旧图
  return { meta, factions: [], nodes: [], edges: [], decor: [], terrainOverrides: [], units: [] };
}

export interface TacBakeOpts {
  parentMapId?: string | null;   // 双向链接：meta.parent.map（外壳传当前图 id）
  yearNow?: number;              // 事件无 year 时的年份兜底
  today?: string;               // 更新戳 YYYY-MM-DD（外壳传，保持纯函数）
}

/** 从战役事件点烘焙一张战术世界（子图恒平面）。dia 内部钳 [20,140]；units:[] 空。
    ⚠ **切平面投影**（2026-08-13）：母图多为球面而子图是平面——带入内容的经度按战场中心纬度
    折算 lon′=心+(lon−心)×cosφ、kmPerDeg 取母图每纬度里程,内容才落在**真实的公里位置**上
    （照抄经纬会把东西向整体拉宽 1/cosφ,38° 处 +27%）。两处如实注记：继承的 1° 粗块涂改经向
    覆盖宽会差一个 cosφ（本就是「粗块初稿」）；起伏噪声锚经纬度,投影后子图程序化起伏细节不再
    与母图逐点同位（类型与涂改才是地形主体）。母图本就是平面时 cosφ=1＝退化为原样。 */
export function createTacticalWorld(src: World, ev: WorldNode, dia: number, opts: TacBakeOpts = {}): World {
  const d = tacDiaClamp(dia);
  const m = src.meta || {};
  const yr = isFinite(ev.year as number) ? (ev.year as number) : (opts.yearNow ?? 0);
  const kmdeg = +kmPerDeg(m).toFixed(4);   // 母图每纬度里程＝子图平面尺度（4 位小数够 4e-5 相对精度）
  const cosc = m.worldModel === "flat" ? 1 : Math.max(0.087, Math.cos(toRad(ev.lat)));
  const tx = (lon: number): number => +(ev.lon + (lon - ev.lon) * cosc).toFixed(4);   // 母图经度→子图平面经度
  const span = d / kmdeg;
  const bbox = {
    lonMin: +(ev.lon - span / 2).toFixed(4), lonMax: +(ev.lon + span / 2).toFixed(4),
    latMin: +Math.max(-85, ev.lat - span / 2).toFixed(4), latMax: +Math.min(85, ev.lat + span / 2).toFixed(4)
  };
  /* 已知边界（2026-07 审阅裁定不改）：inBB 纯数值比较、不做 ±180 经度环绕——全球图上贴反经线
     （半径 1° 内）的战役烘焙会漏采另一侧；寻路网格同样不绕缝（平价锁定域）。实际用图（区域
     大陆/历史战场）触不到该缝，环绕改造涉及重采样/视角/寻路多处，收益不抵风险。
     判定在**子图空间**做（先投影再比框）＝「投影后落进战场」才带入。 */
  const inBB = (o: { lon: number; lat: number }) => { const l = tx(o.lon); return l >= bbox.lonMin && l <= bbox.lonMax && o.lat >= bbox.latMin && o.lat <= bbox.latMax; };
  const strip = <T extends object>(o: T): T => { delete (o as { since?: unknown }).since; delete (o as { until?: unknown }).until; return o; };

  // 当年在场的地点（事件点不带入）；归属沿革烘焙为当年归属；坐标投影到子图平面
  const nodes = src.nodes.filter(n => n.type !== "event" && inBB(n) && activeAt(n, yr)).map(n => {
    const c = strip(clone(n));
    c.lon = tx(n.lon);
    const f = ownerAt(n, yr); if (f) c.faction = f; else delete c.faction;
    delete c.owners; return c;
  });
  const ids = new Set(nodes.map(n => n.id));
  /* 自由折线（河/工事）＝任一**线段**穿过战场即带入（先投影再判，同 inBB 之规）——「任一顶点
     在框内」会漏掉两端都在框外的横贯河道（RDP 把长直段简化到零内部顶点；背水一战的那条河
     不能凭空消失）。带入后折线整条保留不裁剪＝与「一点在框内」时的既有行为一致（框外段画在
     图幅外纸面上，无害）。from/to 连线仍须两端地点都在框内（悬空引用表达不了，已知边界）。 */
  const ptsHitBB = (pts: [number, number][]): boolean => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      if (segIntersectsRect(tx(+a[0]), +a[1], tx(+b[0]), +b[1], bbox.lonMin, bbox.latMin, bbox.lonMax, bbox.latMax)) return true;
    }
    return false;
  };
  const edges = src.edges.filter(e => activeAt(e, yr) && (
    Array.isArray(e.pts) && e.pts.length >= 2
      ? ptsHitBB(e.pts)
      : (!!e.from && !!e.to && ids.has(e.from) && ids.has(e.to))
  )).map(e => {
    const c = strip(clone(e));
    if (Array.isArray(c.pts)) c.pts = c.pts.map(p => [tx(p[0]), p[1]] as [number, number]);
    return c;
  });
  const decor = (src.decor || []).filter(dc => inBB(dc) && activeAt(dc, yr)).map(dc => {
    const c = strip(clone(dc)); c.lon = tx(dc.lon); return c;
  });
  // 带入被引用的自定义印章资产（否则子图 img: 断链）
  const usedAssets = new Set(decor.map(dc => typeof dc.kind === "string" && dc.kind.startsWith("img:") ? dc.kind.slice(4) : "").filter(Boolean));
  const assets = usedAssets.size ? (src.assets || []).filter(a => usedAssets.has(a.id)).map(a => clone(a)) : [];
  const terrainOverrides = (src.terrainOverrides || []).filter(o => inBB(o) && activeAt(o, yr)).map(o => {
    const c = strip(clone(o)); c.lon = tx(o.lon); c.step = +(o.step as number) || 1; return c;   // 记原块尺寸(战略=1°)，战术细网格上按粗块盖章为初稿
  });
  const heightOverrides = (src.heightOverrides || []).filter(o => inBB(o) && activeAt(o, yr)).map(o => {
    const c = strip(clone(o)); c.lon = tx(o.lon); c.step = +(o.step as number) || 1; return c;   // 高程涂改同规则继承
  });

  const cal = clone(m.calendar || { months: 12, dpm: 30 });
  const cs = calOf(cal);
  const meta: Meta = {
    名称: (ev.名称 || "战役") + "·战术",
    说明: `「${ev.名称 || ""}」战术图（${fmtYear(cs, yr)}，边长≈${d}km），自「${m.名称 || ""}」生成：地形/地点/派系为当年快照；时间轴细化到日。`,
    mapKind: "tactical", worldModel: "flat", kmPerDeg: kmdeg,   // 子图恒平面（切平面投影落地,见头注）
    terrain: m.terrain || "sample", battleYear: yr, calendar: cal,
    tacSpan: yearSpanT(cs, yr),
    parent: { map: opts.parentMapId || undefined, mapName: m.名称 || "", event: ev.id, eventName: ev.名称 || "" },
    view: { lon0: ev.lon, lat0: ev.lat, degPerPx0: Math.max(0.0004, (bbox.lonMax - bbox.lonMin) / 900) },
    bbox, 版本: "0.6", 更新: opts.today || ""
  };
  if (m.terrain === "auto") { meta.genSeed = m.genSeed; meta.genStyle = m.genStyle; }
  if (m.relief != null) meta.relief = m.relief;           // 地势起伏与高程标定随图继承
  if (m.elevUnitM != null) meta.elevUnitM = m.elevUnitM;
  if (m.contourM != null) meta.contourM = m.contourM;
  if (m.vault) meta.vault = m.vault;
  meta.gridN = autoGridN(meta);   // 尺度身份盖章（同 blankTacticalWorld）

  /* 涂域随图重采样：源格按「母图 bbox/pd」解读（cells/runs 双认）,目标格心**逆投影回母图空间**
     采样（lon_src=心+(lon−心)/cosφ）,产物直接写 runs（写新之约）。空层保留（「有涂域」即不回退
     据点凸包，语义与烘焙前一致）。dstPd 用**盖章后的完整 meta** 算（paintStep 经 gridStepDeg
     读 kmPerDeg/gridN——合成残缺 meta 会静默落回出厂尺度,behavior.test 逮住过）。 */
  const srcPd = paintStep(m), dstPd = paintStep(meta);
  const invLon = (lon: number): number => ev.lon + (lon - ev.lon) / cosc;
  const factions = src.factions.filter(f => activeAt(f, yr)).map(f => {
    const c = strip(clone(f));
    const paint = paintLayersAt(f, yr).map(L => {
      const p = strip(clone(L)) as PaintLayer;
      const rr = resamplePaintRuns(L, m.bbox, srcPd, bbox, dstPd, invLon);
      delete p.cells; delete p.runs;
      if (rr) p.runs = rr; else p.cells = [];
      return p;
    });
    if (paint.length) c.paint = paint; else delete c.paint;
    return c;
  });

  const out: World = { meta, factions, nodes, edges, decor, terrainOverrides, units: [] };
  if (heightOverrides.length) out.heightOverrides = heightOverrides;
  if (assets.length) out.assets = assets;
  return out;
}
