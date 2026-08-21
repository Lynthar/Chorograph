/* 存档 schema 校验。
   定位：导入/打开前置检查，把问题分两级——
   · fatal：旧版导入门槛拒绝的（无 meta/nodes 非数组）+ 会让 normalize/渲染直接崩的（数组成员不是对象）；
   · warning：normalizeWorld 会补齐/改写的、以及悬空引用等数据质量问题——照常打开，仅提示写手。
   注意分级红线：凡旧版能打开的档，这里绝不能报 fatal（"旧档无损打开"是 验收）。 */
import { CERTAINTY, DECOR, EDGE_STYLE, EVENT_TYPES, LEGACY_KIND, LEGACY_TYPE, NODE_STYLE, UNIT_KINDS, isValidTerrain } from "./constants.ts";
import { parseStrength } from "./units.ts";
import { tget } from "./util.ts";

export interface Issue { path: string; msg: string }
export interface ValidateResult { ok: boolean; fatal: Issue[]; warnings: Issue[] }

const MAX_ISSUES = 50;                     // 每级上限，超出折叠为一条"从略"
const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && isFinite(x);

/** 校验一份外部 JSON 是否能作为世界打开；不修改入参。 */
export function validateWorld(w: unknown): ValidateResult {
  const fatal: Issue[] = [], warnings: Issue[] = [];
  let fOver = 0, wOver = 0;
  const F = (path: string, msg: string) => { fatal.length < MAX_ISSUES ? fatal.push({ path, msg }) : fOver++; };
  const W = (path: string, msg: string) => { warnings.length < MAX_ISSUES ? warnings.push({ path, msg }) : wOver++; };

  if (!isObj(w)) {
    F("", "不是有效的世界对象（应为 JSON 对象）");
    return { ok: false, fatal, warnings };
  }
  const o = w as Record<string, unknown>;

  /* —— 旧版导入门槛：meta 存在、nodes 是数组 —— */
  if (!o.meta) F("meta", "缺少 meta（不是舆图存档？）");
  else if (!isObj(o.meta)) W("meta", "meta 不是对象，打开时将被重置为空");
  if (!("nodes" in o)) F("nodes", "缺少 nodes 数组（不是舆图存档？）");
  else if (!Array.isArray(o.nodes)) F("nodes", "nodes 不是数组");

  /* —— 数组字段成员必须是对象（否则打开即崩=fatal）；字段本身非数组则会被清空补齐=warning —— */
  const listFields = ["factions", "nodes", "edges", "decor", "terrainOverrides", "heightOverrides", "units", "events", "assets"];
  /* 涂改上限 400 万（2026-08 审查修正，原 30 万）：闸的前提是「正常世界远够不到」，而编辑器
     自身已够得到——140km 战术图 196 万格、20km 笔刷一 dab ≈3.1 万条，重涂几分钟即破 30 万，
     导出的图再导入反被自己的闸拒掉（能保存出的档必须能再导入）。400 万＝格数上限 260 万 ×
     时段层余量，仍远低于恶意档量级。 */
  const CAP: Record<string, number> = { factions: 20000, terrainOverrides: 4000000, heightOverrides: 4000000 };  // 余项默认 200000
  for (const k of listFields) {
    const v = o[k];
    if (v == null) continue;
    if (!Array.isArray(v)) {
      if (k !== "nodes" && k !== "events") W(k, `${k} 不是数组，打开时其内容将被丢弃`);
      continue;
    }
    // 量级闸：超大数组=损坏/恶意分享档（正常世界远够不到），拒开以免 validate/normalize/建网格冻结或 OOM
    if (v.length > (CAP[k] ?? 200000)) { F(k, `${k} 含 ${v.length} 项，超出可处理上限（疑损坏或恶意档）`); continue; }
    v.forEach((m, i) => { if (!isObj(m)) F(`${k}[${i}]`, "成员不是对象"); });
  }
  if (fatal.length || fOver) {             // 结构已坏：细则检查建立在成员是对象的前提上
    if (fOver) fatal.push({ path: "", msg: `……另有 ${fOver} 条致命问题从略` });
    return { ok: false, fatal, warnings };
  }

  const meta = isObj(o.meta) ? o.meta : {};
  const label = (m: Record<string, unknown>) => (typeof m.名称 === "string" && m.名称 ? `「${m.名称}」` : "");

  /* —— meta —— */
  if (meta.worldModel != null && meta.worldModel !== "sphere" && meta.worldModel !== "flat")
    W("meta.worldModel", `未知世界模型 ${JSON.stringify(meta.worldModel)}（按球面处理）`);
  if (meta.bbox != null) {
    const b = meta.bbox as Record<string, unknown>;
    if (!isObj(b) || !isNum(b.lonMin) || !isNum(b.lonMax) || !isNum(b.latMin) || !isNum(b.latMax)
      || b.lonMin >= b.lonMax || b.latMin >= b.latMax)
      W("meta.bbox", "范围无效（需 lonMin<lonMax、latMin<latMax 的数字），将按默认范围处理");
    /* 跨度上界＝球面合法值（360/170）的 10 倍宽容：平面世界的「度」是自由标尺（kmPerDeg 自定），
       跨度合法域天然大于球面，收紧到 360/170 会误拒合法平面档；量级项防天文坐标（浮点在
       1e300 处格心精度归零＝渲染乱码，同 deeplink |n|≤1e6 之规）。 */
    else if (b.lonMax - b.lonMin > 3600 || b.latMax - b.latMin > 1700
      || Math.abs(+b.lonMin) > 1e6 || Math.abs(+b.lonMax) > 1e6 || Math.abs(+b.latMin) > 1e6 || Math.abs(+b.latMax) > 1e6)
      F("meta.bbox", "范围跨度或坐标量级过大，无法生成地形网格（疑损坏或恶意档）");
  }

  const checkTimed = (path: string, m: Record<string, unknown>) => {
    for (const k of ["since", "until"]) if (m[k] != null && !isNum(m[k])) W(`${path}.${k}`, "不是数字，时段过滤将失准");
  };
  /* 可靠性档位（柱B）：未知值按「确证」渲染——只提示，不改数据（同未知地形/兵种之规） */
  const checkCertainty = (path: string, m: Record<string, unknown>) => {
    if (m.certainty != null && !tget(CERTAINTY, String(m.certainty)))
      W(`${path}.certainty`, `未知可靠性档「${String(m.certainty)}」（将按确证渲染）`);
  };

  /* —— 派系 —— */
  const factionIds = new Set<string>();
  const factions = Array.isArray(o.factions) ? (o.factions as Record<string, unknown>[]) : [];
  factions.forEach((f, i) => {
    const p = `factions[${i}]`;
    if (typeof f.id !== "string" || !f.id) W(p, `派系${label(f)}缺 id，涂域/归属将无法关联`);
    else if (factionIds.has(f.id)) W(p, `派系 id「${f.id}」重复`);
    else factionIds.add(f.id);
    if (f.color != null && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(f.color)))
      W(`${p}.color`, `颜色 ${JSON.stringify(f.color)} 不是 #rgb/#rrggbb 格式`);
    checkTimed(p, f);
    if (f.paint != null && !Array.isArray(f.paint)) W(`${p}.paint`, "涂域层不是数组");
    else (f.paint || []).forEach((L, k) => {
      /* ⚠ 层成员可为 null/原始值（normalizeWorld 会剔除）——先挡再取 runs，否则 null.runs 直接
         抛 TypeError＝损坏档把「返回错误」的契约打穿（2026-08 审查坐实）。 */
      if (!isObj(L)) { W(`${p}.paint[${k}]`, "涂域层成员不是对象，打开时将被剔除"); return; }
      /* runs 行程编码（2026-08-13 写新格式）：形状不对只警告——渲染端 eachPaintCenter 自带
         防御（非数跳过、长度钳制），坏 runs 顶多不显示,不崩图；量级闸同顶层数组之规 */
      const R = (L as { runs?: unknown }).runs as { pd?: unknown; d?: unknown } | null | undefined;
      if (R != null && !(typeof R === "object" && +(R.pd as number) > 0 && Array.isArray(R.d) && (R.d as unknown[]).length % 3 === 0))
        W(`${p}.paint[${k}].runs`, "涂域行程编码形状无效（pd>0 且 d 为三元组数组），该层将按空处理");
      else if (R && Array.isArray(R.d) && (R.d as unknown[]).length > 12000000)
        F(`${p}.paint[${k}].runs`, "涂域行程编码过大（疑损坏或恶意档）");
      if (Array.isArray((L as { cells?: unknown }).cells) && ((L as { cells: unknown[] }).cells).length > 4000000)
        F(`${p}.paint[${k}].cells`, "涂域格坐标过多（疑损坏或恶意档）");
    });
  });
  const refFaction = (path: string, id: unknown) => {
    if (id != null && id !== "" && !factionIds.has(String(id))) W(path, `引用了不存在的派系「${String(id)}」`);
  };

  /* —— 地点 —— */
  const nodeIds = new Set<string>();
  const nodes = Array.isArray(o.nodes) ? (o.nodes as Record<string, unknown>[]) : [];
  nodes.forEach((n, i) => {
    const p = `nodes[${i}]`;
    if (typeof n.id !== "string" || !n.id) W(p, `地点${label(n)}缺 id，连线/事件将无法引用它`);
    else if (nodeIds.has(n.id)) W(p, `地点 id「${n.id}」重复`);
    else nodeIds.add(n.id);
    if (!isNum(n.lon) || !isNum(n.lat)) W(p, `地点${label(n)}经纬度无效，将不可见`);
    const t = tget(LEGACY_TYPE as Record<string, string>, n.type) ?? n.type;
    if (t != null && !tget(NODE_STYLE, t)) W(`${p}.type`, `未知地点类型「${String(n.type)}」`);
    if (t === "event" && n.evtype != null && !tget(EVENT_TYPES, String(n.evtype)))
      W(`${p}.evtype`, `未知事件子类「${String(n.evtype)}」（将按"战役"处理）`);
    refFaction(`${p}.faction`, n.faction);
    checkCertainty(p, n);
    if (Array.isArray(n.owners)) n.owners.forEach((ow, j) => {
      if (isObj(ow)) { refFaction(`${p}.owners[${j}].faction`, ow.faction); checkTimed(`${p}.owners[${j}]`, ow); }
      else W(`${p}.owners[${j}]`, "归属沿革成员不是对象");
    });
    if (Array.isArray(n.ops)) n.ops.forEach((op, j) => {   // 作战线：normalize 会剔坏成员/坏折线，这里仅提示（红线：不 fatal）
      if (!isObj(op)) { W(`${p}.ops[${j}]`, "作战线成员不是对象，打开时将被剔除"); return; }
      if (Array.isArray(op.pts) && (op.pts as unknown[]).length > 100000) { F(`${p}.ops[${j}].pts`, "折线点数过多（疑损坏或恶意档）"); return; }
      const usable = Array.isArray(op.pts)
        && (op.pts as unknown[]).filter(q => Array.isArray(q) && isFinite(Number(q[0])) && isFinite(Number(q[1]))).length >= 2;
      if (!usable) W(`${p}.ops[${j}]`, "作战线需要至少 2 个有效 [经,纬] 坐标点，打开时将被剔除");
    });
    checkTimed(p, n);
  });

  /* —— 连线 —— */
  (Array.isArray(o.edges) ? (o.edges as Record<string, unknown>[]) : []).forEach((e, i) => {
    const p = `edges[${i}]`;
    const free = Array.isArray(e.pts) && (e.pts as unknown[]).length >= 2;   // 自由折线（河流/工事）：pts 折线、无端点
    if (Array.isArray(e.pts) && (e.pts as unknown[]).length > 100000) F(`${p}.pts`, "折线点数过多（疑损坏或恶意档）");   // 逐帧遍历的嵌套数组同吃量级闸
    if (free) { if (e.type !== "river" && e.type !== "wall") W(`${p}.pts`, "只有河流与工事可用自由折线 pts"); }
    else for (const end of ["from", "to"]) if (!nodeIds.has(String(e[end]))) W(`${p}.${end}`, `连线引用了不存在的地点「${String(e[end])}」`);
    if (!tget(EDGE_STYLE, String(e.type))) W(`${p}.type`, `未知连线类型「${String(e.type)}」`);
    checkCertainty(p, e);
    checkTimed(p, e);
  });

  /* —— 布景 / 地形涂改 —— */
  const assetIds = new Set((Array.isArray(o.assets) ? o.assets as { id?: unknown }[] : []).map(a => String(a && a.id)));
  (Array.isArray(o.assets) ? (o.assets as Record<string, unknown>[]) : []).forEach((a, i) => {
    if (typeof a.src === "string" && a.src && !/^(data|blob):/.test(a.src))   // 渲染端同判（render/decor.assetImg）：外链不请求不绘制
      W(`assets[${i}].src`, "印章资产不是内嵌数据（data:/blob:），将不显示");
  });
  (Array.isArray(o.decor) ? (o.decor as Record<string, unknown>[]) : []).forEach((d, i) => {
    const k = String(d.kind);
    if (k.startsWith("img:")) { if (!assetIds.has(k.slice(4))) W(`decor[${i}].kind`, `自定义印章缺资产「${k}」`); }   // 悬空引用
    else if (!tget(DECOR, k)) W(`decor[${i}].kind`, `未知布景印章「${k}」`);
    checkTimed(`decor[${i}]`, d);
  });
  (Array.isArray(o.terrainOverrides) ? (o.terrainOverrides as Record<string, unknown>[]) : []).forEach((t, i) => {
    const p = `terrainOverrides[${i}]`;
    if (!isValidTerrain(String(t.t))) W(`${p}.t`, `未知地形「${String(t.t)}」`);
    if (!isNum(t.lon) || !isNum(t.lat)) W(p, "涂改块经纬度无效");
    checkTimed(p, t);
  });

  /* —— 部队（战术图） —— */
  (Array.isArray(o.units) ? (o.units as Record<string, unknown>[]) : []).forEach((u, i) => {
    const p = `units[${i}]`;
    const uk = tget(LEGACY_KIND as Record<string, { to: string }>, String(u.kind));
    if (u.kind != null && !uk && !tget(UNIT_KINDS, String(u.kind))) W(`${p}.kind`, `未知兵种「${String(u.kind)}」（移动方式按陆行处理）`);
    /* 兵力已是数值字段：非数值的旧文本照常打开，但要说清它会被 normalizeWorld 挪走（同上「会补齐/改写的」之级） */
    if (u.strength != null && String(u.strength).trim() && parseStrength(u.strength) == null)
      W(`${p}.strength`, `兵力「${String(u.strength).trim()}」不是数值，将移入「说明」`);
    /* 无远程投射能力的兵种带着火力半径：数据留着但一律不画（unitFireKm 判据），说一声免得写手以为图坏了 */
    const nk = tget(UNIT_KINDS, uk ? uk.to : String(u.kind));
    if (nk && nk.noFire && (u.range != null || u.ranges != null))
      W(`${p}.range`, `「${nk.名}」无远程投射能力，火力圈不会绘制`);
    refFaction(`${p}.faction`, u.faction);
    if (u.track != null && !Array.isArray(u.track)) W(`${p}.track`, "航点不是数组，将被清空");
    if (Array.isArray(u.track) && u.track.length > 100000) F(`${p}.track`, "航点数过多（疑损坏或恶意档）");   // 位置插值逐帧遍历航点
    else if (Array.isArray(u.track)) u.track.forEach((pt, j) => {
      if (!isObj(pt) || !isNum(pt.t) || !isNum(pt.lon) || !isNum(pt.lat)) W(`${p}.track[${j}]`, "航点需要数字 t/lon/lat");
    });
  });

  if (fOver) fatal.push({ path: "", msg: `……另有 ${fOver} 条致命问题从略` });
  if (wOver) warnings.push({ path: "", msg: `……另有 ${wOver} 条提示从略` });
  return { ok: fatal.length === 0, fatal, warnings };
}

/** 问题清单 → 多行文本（导入对话框/控制台用） */
export function formatIssues(list: Issue[]): string {
  return list.map(i => (i.path ? `${i.path}：${i.msg}` : i.msg)).join("\n");
}
