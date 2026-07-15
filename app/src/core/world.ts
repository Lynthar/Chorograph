/* 世界数据的规范化与构造（自 v0.14 index.html 原样迁移，黄金基准平价锁定）。
   normalizeWorld 是"单点迁移"哲学的载体：外部导入/旧存档缺什么补什么、旧字段就地升级，
   改这里的任何分支都是行为变更——旧档打开后的内容会跟着变，先想兼容。 */
import { LEGACY_TYPE, EVENT_TYPES, UNIT_KINDS } from "./constants.ts";
import type { BBox, CalendarCfg, GenStyle, TerrainMode, World, WorldModel } from "./types.ts";

/* eslint-disable @typescript-eslint/no-explicit-any -- 入参是任意外部 JSON，宽松索引即语义 */

/** 数据规范化：缺字段补齐 + 旧格式就地迁移（与旧实现一致：原地修改并返回同一对象）。
    另附防御性过滤（净新，合法世界零影响）：剔除各数组里非对象/畸形的成员——
    validate 会放行这些为 warning，但 normalize/渲染前提是「成员皆对象」，
    加载他人分享的坏档若不过滤则开图即崩（且旧档迁移/撤销恢复不经 validate）。 */
export function normalizeWorld(w: unknown): World {
  let o: any = w;
  if (!o || typeof o !== "object") o = {};
  if (!o.meta || typeof o.meta !== "object") o.meta = {};
  // 防御过滤只剔「非对象成员」——这类成员会让 activeAt/sort/渲染对 null 求属性直接崩；
  // 有值但字段不全的成员保留（渲染得 NaN 但不崩，且与旧 normalize 不删任何成员的行为最接近）。
  const isRec = (m: any) => !!m && typeof m === "object" && !Array.isArray(m);
  ["factions", "nodes", "edges", "decor", "terrainOverrides", "units"].forEach(k => {
    o[k] = Array.isArray(o[k]) ? o[k].filter(isRec) : [];
  });
  // heightOverrides 保持「缺键不落盘」（旧档形状不变）：仅当存在时清理，非数组则删键
  if (o.heightOverrides != null) {
    if (Array.isArray(o.heightOverrides)) o.heightOverrides = o.heightOverrides.filter(isRec);
    else delete o.heightOverrides;
  }
  // assets（自定义印章资产）同「缺键不落盘」：保 {id,src} 合法记录，空/非数组删键
  if (o.assets != null) {
    o.assets = Array.isArray(o.assets) ? o.assets.filter((a: any) => isRec(a) && a.id && typeof a.src === "string") : null;
    if (!Array.isArray(o.assets) || !o.assets.length) delete o.assets;
  }
  // v0.14 部队（战术图兵棋）：航点数组补齐、剔除非对象航点（防 sort 对 null 崩）、按日戳排序
  o.units.forEach((u: any) => {
    u.track = Array.isArray(u.track) ? u.track.filter(isRec) : [];
    u.track.sort((a: any, b: any) => a.t - b.t);
    if (!u.arm) u.arm = ((UNIT_KINDS as any)[u.kind] || {}).arm || "land";
  });
  o.factions.forEach((f: any) => {
    if (Array.isArray(f.paint)) f.paint = f.paint.filter(isRec).map((L: any) => {
      if (Array.isArray(L.cells)) L.cells = L.cells.filter((c: any) => Array.isArray(c));   // 剔除非数组格（territory 对 c[0] 崩）
      return L;
    });
  });
  o.nodes.forEach((n: any) => {
    if ((LEGACY_TYPE as any)[n.type]) n.type = LEGACY_TYPE[n.type];             // 旧地点类型自动升级
    if (n.type === "event" && !(EVENT_TYPES as any)[n.evtype]) n.evtype = "battle"; // v0.11：旧事件点默认=战役
    if (Array.isArray(n.owners)) n.owners = n.owners.filter(isRec);
    if (Array.isArray(n.ops)) n.ops = n.ops.filter((op: any) => isRec(op) && Array.isArray(op.pts));
  });
  o.edges.forEach((e: any) => {   // 自由画河道折线 pts 净化（同 ops.pts 防御）：剔非法坐标、不足 2 点删键；旧 from/to 边无 pts 零影响
    if (e.pts == null) return;
    e.pts = Array.isArray(e.pts)
      ? e.pts.filter((p: any) => Array.isArray(p) && isFinite(+p[0]) && isFinite(+p[1])).map((p: any) => [+p[0], +p[1]])
      : null;
    if (!Array.isArray(e.pts) || e.pts.length < 2) delete e.pts;
  });
  // v0.9 迁移：旧 events[](挂靠地点的战役) → 独立"事件点"地点(type:event)；arrows(两端=地点) → 自由折线 ops
  if (Array.isArray(o.events) && o.events.length) {
    const byId = (id: unknown) => (o.nodes || []).find((n: any) => n.id === id);
    o.events.forEach((ev: any, k: number) => {
      if (byId(ev.id)) return;                      // 幂等：已迁移过则跳过
      const at = byId(ev.at);
      const base = at ? [at.lon, at.lat] : [106 + (k % 5), 38];
      const nd: any = { id: ev.id || ("ev_m" + k), 名称: ev.名称 || "事件",
        lon: +((base[0] + 0.4)).toFixed(3), lat: +((base[1] + 0.3)).toFixed(3),
        type: "event", year: ev.year, note: ev.note };
      if (ev.sides) nd.sides = ev.sides;
      if (ev.result) nd.result = ev.result;
      if (Array.isArray(ev.arrows)) {
        const ops = ev.arrows.map((a: any) => {
          const A = byId(a.from), B = byId(a.to); if (!A || !B) return null;
          return { kind: "attack", pts: [[A.lon, A.lat], [B.lon, B.lat]], side: a.side || null, troop: "", label: a.label || "", w: 3 };
        }).filter(Boolean);
        if (ops.length) nd.ops = ops;
      }
      o.nodes.push(nd);
    });
  }
  delete o.events;
  return o as World;
}

/** 新建空白世界的参数（对应旧版 ⚙ 新建表单收集的字段） */
export interface BlankWorldSpec {
  名称?: string;
  worldModel?: WorldModel;
  planetRadiusKm?: number;
  terrain?: TerrainMode;
  bbox: BBox;
  kmPerDeg?: number | null;
  genSeed?: number;
  genStyle?: GenStyle;
  vault?: string;
  calendar?: CalendarCfg;   // 纪年历法：缺省不落盘（=custom SE 12×30）；earth/自定义纪元才写 meta
  relief?: number;          // 程序化地势起伏幅度 0..1：>0 才写 meta（缺省=无，旧图渲染不变）
}

/** 按世界参数生成空白世界。today=今日日期串(YYYY-MM-DD)——旧实现内联 new Date()，
    这里改显式传入以保持纯函数（黄金基准即以占位日期锁定其余全部字段）。 */
export function blankWorld(s: BlankWorldSpec, today: string): World {
  const span = s.bbox.lonMax - s.bbox.lonMin;
  const w: any = {
    meta: { 名称: s.名称, 说明: "（新建地图）", worldModel: s.worldModel, planetRadiusKm: s.planetRadiusKm,
      terrain: s.terrain,
      view: { lon0: (s.bbox.lonMin + s.bbox.lonMax) / 2, lat0: (s.bbox.latMin + s.bbox.latMax) / 2,
              degPerPx0: Math.max(0.004, Math.min(0.5, span / 900)) },
      bbox: s.bbox, 版本: "0.5", 更新: today },
    factions: [], nodes: [], edges: [], decor: [], terrainOverrides: []
  };
  if (s.kmPerDeg != null) w.meta.kmPerDeg = s.kmPerDeg;
  if (s.terrain === "auto") { w.meta.genSeed = s.genSeed; w.meta.genStyle = s.genStyle; }
  if (s.vault) w.meta.vault = s.vault;
  if (s.calendar) w.meta.calendar = s.calendar;   // 历法创建时定死（改 kind 会重释一切已存日戳）
  if (s.relief != null && s.relief > 0) w.meta.relief = s.relief;
  return w as World;
}

/** 图库卡片统计（地点/战役/派系；战术图另记部队数与 ⚔ 徽标） */
export interface MapCounts { nodes: number; events: number; factions: number; tac?: number; units?: number }

export function countsOf(w: unknown): MapCounts {
  const ns: any[] = ((w as any) && (w as any).nodes) || [];
  const c: MapCounts = { nodes: ns.filter(n => n.type !== "event").length, events: ns.filter(n => n.type === "event").length,
    factions: (((w as any) && (w as any).factions) || []).length };
  if ((((w as any) && (w as any).meta) || {}).mapKind === "tactical") { c.tac = 1; c.units = (((w as any) && (w as any).units) || []).length; }
  return c;
}
