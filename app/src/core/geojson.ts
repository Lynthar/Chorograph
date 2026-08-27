/* GeoJSON 导入管线（纯函数）：扫描要素 → 猜字段映射 → 转成舆图对象。
   点→地点 · 线→连线 · 面→派系涂域与/或边界折线；properties 的年份键映射 since/until。
   只做本地转换——外部历史地理数据多禁再分发，一个字节都不进本仓库。 */
import { NODE_STYLE } from "./constants.ts";
import { paintDims } from "./territory.ts";
import { tget } from "./util.ts";
import type { Pt } from "./geometry.ts";
import type { BBox, Edge, Faction, PaintLayer, PaintRuns, WorldNode } from "./types.ts";

/* eslint-disable @typescript-eslint/no-explicit-any -- 入参是任意外部 JSON，宽松索引即语义 */

/** 规模闸：外部文件的大小也是用户数据，每一道都要有上限，否则一份坏档能冻死主线程 */
export interface GeoCaps {
  features: number;   // 要素数
  coords: number;     // 坐标点总数
  linePts: number;    // 单条折线点数（validate 的折线红线是 10 万）
  cells: number;      // 栅格化格数（cols×rows）
  runs: number;       // 行程编码三元组数
  crossings: number;  // 扫描线求交次数（防病态多边形）
  layers: number;     // 单个派系的涂域层数
  fields: number;     // 单个对象保留的属性键数
}
export const GEO_CAPS: GeoCaps = {
  features: 60000, coords: 2000000, linePts: 50000,
  cells: 4000000, runs: 1000000, crossings: 40000000, layers: 60, fields: 12
};

export type GeoKind = "point" | "line" | "poly";
/** 一个要素归一后的几何：按 kind 只填对应那一支（GeometryCollection 拆成同 props 的多个要素） */
export interface GeoFeature {
  kind: GeoKind;
  pts: Pt[];        // point：MultiPoint 展开成同一要素的多个点
  lines: Pt[][];    // line
  polys: Pt[][][];  // poly：每个多边形＝[外环, 洞…]
  props: Record<string, unknown>;
}
export interface GeoKey { key: string; sample: string; n: number }
export interface GeoScan {
  features: GeoFeature[];
  counts: Record<GeoKind, number>;
  keys: GeoKey[];
  bbox: BBox | null;
  coords: number;
  skipped: number;    // 几何无法识别或坐标全非数而丢弃的要素
  truncated: boolean; // 撞上限被截断
}

/* 先卡类型再转数：`+null` `+""` `+[]` `+false` 全是 0，缺坐标会静默变成 [0,0] 落进几内亚湾。
   量级闸同 deeplink 之规——1e300 处浮点在格心上精度归零，画出来是乱码。 */
const num = (x: unknown): number | null => {
  if (typeof x !== "number" && !(typeof x === "string" && x.trim())) return null;
  const v = +x;
  return isFinite(v) && Math.abs(v) <= 1e6 ? v : null;
};
const asPt = (c: unknown): Pt | null => {
  if (!Array.isArray(c)) return null;
  const x = num(c[0]), y = num(c[1]);
  return x == null || y == null ? null : [x, y];
};

/** 一串坐标 → 点列（非数成员就地剔除，不整条丢——真实数据里偶有单点坏值） */
function asLine(cs: unknown, budget: { left: number }): Pt[] {
  if (!Array.isArray(cs)) return [];
  const out: Pt[] = [];
  for (const c of cs) {
    if (budget.left <= 0) break;
    budget.left--;
    const p = asPt(c);
    if (p) out.push(p);
  }
  return out;
}

/** 递归收集一个 geometry 的几何（GeometryCollection 就地展开进同一个收集器） */
function collect(g: any, acc: { pts: Pt[]; lines: Pt[][]; polys: Pt[][][] }, budget: { left: number }): void {
  if (!g || typeof g !== "object" || budget.left <= 0) return;
  const t = String(g.type || ""), c = g.coordinates;
  if (t === "Point") { budget.left--; const p = asPt(c); if (p) acc.pts.push(p); }
  else if (t === "MultiPoint") { for (const p of asLine(c, budget)) acc.pts.push(p); }
  else if (t === "LineString") { const l = asLine(c, budget); if (l.length >= 2) acc.lines.push(l); }
  else if (t === "MultiLineString" && Array.isArray(c)) { for (const s of c) { const l = asLine(s, budget); if (l.length >= 2) acc.lines.push(l); } }
  else if (t === "Polygon" && Array.isArray(c)) { const rs = c.map(r => asLine(r, budget)).filter(r => r.length >= 3); if (rs.length) acc.polys.push(rs); }
  else if (t === "MultiPolygon" && Array.isArray(c)) {
    for (const poly of c) {
      if (!Array.isArray(poly)) continue;
      const rs = poly.map(r => asLine(r, budget)).filter(r => r.length >= 3);
      if (rs.length) acc.polys.push(rs);
    }
  }
  else if (t === "GeometryCollection" && Array.isArray(g.geometries)) { for (const sub of g.geometries) collect(sub, acc, budget); }
}

/** 一份 JSON 里的要素列表：FeatureCollection / 单个 Feature / 裸 geometry / 要素数组都认 */
function featureList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const o = raw as any;
  if (o.type === "FeatureCollection") return Array.isArray(o.features) ? o.features : [];
  return [o];   // Feature 或裸 geometry：下面按 geometry ?? 自身取几何
}

/**
 * 扫描一份 GeoJSON：归一几何、统计属性键、算总范围。不修改入参。
 * @param raw 任意外部 JSON
 * @param caps 规模闸（必填——缺省分支零覆盖，改坏了不变红）
 * @returns 撞上限时 truncated=true，已收下的部分照常可用
 */
export function scanGeoJSON(raw: unknown, caps: GeoCaps): GeoScan {
  const out: GeoScan = {
    features: [], counts: { point: 0, line: 0, poly: 0 }, keys: [],
    bbox: null, coords: 0, skipped: 0, truncated: false
  };
  const budget = { left: caps.coords };
  const keyN = new Map<string, { n: number; sample: string }>();
  let lo0 = Infinity, lo1 = -Infinity, la0 = Infinity, la1 = -Infinity;
  const seen = (p: Pt): void => {
    if (p[0] < lo0) lo0 = p[0];
    if (p[0] > lo1) lo1 = p[0];
    if (p[1] < la0) la0 = p[1];
    if (p[1] > la1) la1 = p[1];
  };

  const list = featureList(raw);
  for (const f of list) {
    if (out.features.length >= caps.features || budget.left <= 0) { out.truncated = true; break; }
    if (!f || typeof f !== "object") { out.skipped++; continue; }
    const fo = f as any;
    const acc = { pts: [] as Pt[], lines: [] as Pt[][], polys: [] as Pt[][][] };
    collect(fo.geometry != null ? fo.geometry : fo, acc, budget);
    if (!acc.pts.length && !acc.lines.length && !acc.polys.length) { out.skipped++; continue; }

    const props = (fo.properties && typeof fo.properties === "object" && !Array.isArray(fo.properties))
      ? fo.properties as Record<string, unknown> : {};
    for (const k of Object.keys(props)) {
      const s = String(props[k] == null ? "" : props[k]).trim();
      if (!s) continue;
      const rec = keyN.get(k);
      if (rec) rec.n++;
      else keyN.set(k, { n: 1, sample: s.slice(0, 40) });
    }
    /* 一个要素可能同时有三种几何（GeometryCollection），拆成三个共享 props 的要素——
       下游按 kind 分派，共享 props 使名称/年份/分组照样各自生效。 */
    const mk = (kind: GeoKind, pts: Pt[], lines: Pt[][], polys: Pt[][][]): void => {
      out.features.push({ kind, pts, lines, polys, props });
      out.counts[kind]++;
      out.coords += pts.length + lines.reduce((a, l) => a + l.length, 0)
        + polys.reduce((a, rs) => a + rs.reduce((b, r) => b + r.length, 0), 0);
      pts.forEach(seen);
      lines.forEach(l => l.forEach(seen));
      polys.forEach(rs => rs.forEach(r => r.forEach(seen)));
    };
    if (acc.pts.length) mk("point", acc.pts, [], []);
    if (acc.lines.length) mk("line", [], acc.lines, []);
    if (acc.polys.length) mk("poly", [], [], acc.polys);
  }
  if (budget.left <= 0) out.truncated = true;
  out.keys = [...keyN.entries()].map(([key, v]) => ({ key, sample: v.sample, n: v.n }))
    .sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : 1));
  if (lo0 <= lo1 && la0 <= la1) out.bbox = { lonMin: lo0, lonMax: lo1, latMin: la0, latMax: la1 };
  return out;
}

/* —— 字段映射 —— */

/* 无端点的自由折线只有河流与工事画得出来（render/edges 里就这两支认 pts）——道路与商路
   必须挂 from/to 两个地点，而导进来的线没有地点可挂。故写死在类型上，免得又生一个
   「存得下、导得进、就是不显示」的静默档。 */
export type GeoLineType = Extract<Edge["type"], "river" | "wall">;
export const GEO_LINE_TYPES: GeoLineType[] = ["river", "wall"];

export interface GeoMapping {
  name: string;        // 名称键（""＝不取名）
  type: string;        // 地点类型键（""＝一律用 typeDefault）
  typeDefault: string; // 类型缺省（NODE_STYLE 键）
  since: string; until: string;
  group: string;       // 派系分组键（""＝全部归一个派系）
  lineType: GeoLineType;
  outlineType: GeoLineType;    // 面的边界折线落成哪种连线
  polyAs: "paint" | "outline" | "both";
  simplify: boolean;
}

const NAME_HINT = ["name", "名称", "name_ch", "nam", "title", "label", "名"];
const SINCE_HINT = ["beg_yr", "start_date", "start", "begin", "since", "from", "beg", "起年", "始年"];
const UNTIL_HINT = ["end_yr", "end_date", "end", "until", "stop", "讫年", "终年"];
const TYPE_HINT = ["lev_rank", "feat_type", "type", "level", "rank", "class", "kind", "类型", "等级"];
const GROUP_HINT = ["dyn_ch", "dynasty", "country", "state", "owner", "admin", "faction", "朝代", "政权", "国"];

/** 按提示词挑一个属性键：先整键相等，再退到包含（都不中返 ""） */
function pickKey(keys: GeoKey[], hints: string[]): string {
  const low = keys.map(k => ({ key: k.key, l: k.key.toLowerCase() }));
  for (const h of hints) { const hit = low.find(k => k.l === h); if (hit) return hit.key; }
  for (const h of hints) { const hit = low.find(k => k.l.includes(h)); if (hit) return hit.key; }
  return "";
}

/** 扫描结果 → 一份默认映射；键名五花八门，猜错了由弹层改 */
export function guessMapping(scan: GeoScan): GeoMapping {
  return {
    name: pickKey(scan.keys, NAME_HINT),
    type: pickKey(scan.keys, TYPE_HINT),
    typeDefault: "city",
    since: pickKey(scan.keys, SINCE_HINT),
    until: pickKey(scan.keys, UNTIL_HINT),
    group: pickKey(scan.keys, GROUP_HINT),
    lineType: "river", outlineType: "wall", polyAs: "paint", simplify: false
  };
}

/* 属性值 → 地点类型的提示表（另立一张，不给平价锁定的 NODE_STYLE 加字段）。
   按序首中者胜：先具体后笼统，「都城」要排在「城」前面。 */
const TYPE_WORDS: [RegExp, string][] = [
  [/都城|首都|京师|capital/i, "capital"],
  [/府|州|prefect|province|major/i, "major"],
  [/县|市|城|city|town_?c/i, "city"],
  [/镇|town/i, "town"],
  [/乡|村|village|hamlet/i, "village"],
  [/关|隘|pass/i, "pass"],
  [/塞|堡|要塞|fort|castle|citadel/i, "fortress"],
  [/营|垒|camp/i, "camp"],
  [/港|harbo|port/i, "port"],
  [/桥|bridge/i, "bridge"],
  [/渡|ford/i, "ford"],
  [/山|峰|岭|summit|peak|mount/i, "summit"],
  [/庄|园|manor|estate/i, "manor"],
  [/遗址|故城|site|ruin|archae/i, "site"],
  [/矿|盐|resource|mine/i, "resource"]
];
const TYPE_BY_NAME = new Map(Object.keys(NODE_STYLE).map(k => [NODE_STYLE[k].名, k]));

/**
 * 属性值 → 地点类型键。
 * @param v 属性值（外部数据，任意类型）
 * @param def 认不出时的缺省类型（调用方须保证是 NODE_STYLE 里的键）
 * @returns 一定是 NODE_STYLE 里的键——调用方可直接落进 node.type
 */
export function guessNodeType(v: unknown, def: string): string {
  const s = String(v == null ? "" : v).trim();
  if (!s) return def;
  if (tget(NODE_STYLE, s)) return s;                 // 值本身就是舆图类型键
  const byName = TYPE_BY_NAME.get(s);
  if (byName) return byName;                          // 值＝类型中文名
  for (const [re, t] of TYPE_WORDS) if (re.test(s)) return t;
  return def;
}

/**
 * 属性值 → 年份。认 ISO 8601（`1644-01-01` / `-0221`）、纯数字、带 BC/公元前 的写法。
 * @returns 认不出返 null；量级超 1e6 一律判为坏值（同坐标之规）
 */
export function parseGeoYear(v: unknown): number | null {
  if (typeof v === "number") return isFinite(v) && Math.abs(v) <= 1e6 ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  const m = /(-?)(\d{1,7})/.exec(s);
  if (!m) return null;
  const y = parseInt(m[2], 10);
  if (!isFinite(y) || y > 1e6) return null;
  const bc = !!m[1] || /\bbce?\b|b\.c\./i.test(s) || s.includes("公元前");
  return bc ? -y : y;
}

/* —— 折线抽稀 —— */

/**
 * Douglas–Peucker 抽稀（迭代式，不递归——真实河网单条能有几万点，递归会爆栈）。
 * @param pts 折线点列
 * @param tol 容差（度）；≤0 原样返回
 */
export function simplifyLine(pts: Pt[], tol: number): Pt[] {
  const n = pts.length;
  if (n < 3 || !(tol > 0)) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const t2 = tol * tol;
  const stack: number[] = [0, n - 1];
  while (stack.length) {
    const b = stack.pop()!, a = stack.pop()!;
    if (b - a < 2) continue;
    const ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay, dd = dx * dx + dy * dy;
    let best = -1, bd = 0;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] - ax, py = pts[i][1] - ay;
      let d2: number;
      if (dd > 0) {
        let t = (px * dx + py * dy) / dd;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - t * dx, ey = py - t * dy;
        d2 = ex * ex + ey * ey;
      } else d2 = px * px + py * py;
      if (d2 > bd) { bd = d2; best = i; }
    }
    if (bd > t2 && best > 0) { keep[best] = 1; stack.push(a, best, best, b); }
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/* —— 多边形栅格化 —— */

/* 逐行扫描线（偶奇填充）落进位图：行桶让每行只看跨越它的边——政区级多边形上比全量遍历
   快一个量级。半开判据 `(y0<=cy)!==(y1<=cy)` 与列的 [x0,x1) 同源，防共享边重复填。 */
function fillPoly(mask: Uint8Array, cols: number, rows: number, bb: BBox, pd: number,
                  rings: Pt[][], budget: { left: number }): void {
  const ax: number[] = [], ay: number[] = [], bx: number[] = [], by: number[] = [];
  let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] === q[1]) continue;              // 水平边不产生交点
      ax.push(p[0]); ay.push(p[1]); bx.push(q[0]); by.push(q[1]);
    }
  }
  if (!(y0 <= y1)) return;
  const jOf = (lat: number) => (lat - bb.latMin) / pd - 0.5;    // 格心 j 的实数位置（与 eachPaintCenter 同约定）
  const jLo = Math.max(0, Math.ceil(jOf(y0))), jHi = Math.min(rows - 1, Math.ceil(jOf(y1)) - 1);
  let painted = false;
  if (jHi >= jLo) {
    const bucket: number[][] = [];
    for (let e = 0; e < ay.length; e++) {
      const lo = Math.min(ay[e], by[e]), hi = Math.max(ay[e], by[e]);
      const e0 = Math.max(jLo, Math.ceil(jOf(lo))), e1 = Math.min(jHi, Math.ceil(jOf(hi)) - 1);
      for (let j = e0; j <= e1; j++) {
        if (budget.left-- <= 0) return;
        (bucket[j - jLo] || (bucket[j - jLo] = [])).push(e);
      }
    }
    const iOf = (lon: number) => (lon - bb.lonMin) / pd - 0.5;
    const xs: number[] = [];
    for (let j = jLo; j <= jHi; j++) {
      const es = bucket[j - jLo];
      if (!es) continue;
      const cy = bb.latMin + (j + 0.5) * pd;
      xs.length = 0;
      for (const e of es) {
        if ((ay[e] <= cy) === (by[e] <= cy)) continue;
        xs.push(ax[e] + (cy - ay[e]) * (bx[e] - ax[e]) / (by[e] - ay[e]));
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      const row = j * cols;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(iOf(xs[k]))), i1 = Math.min(cols - 1, Math.ceil(iOf(xs[k + 1])) - 1);
        for (let i = i0; i <= i1; i++) { mask[row + i] = 1; painted = true; }
      }
    }
  }
  /* 比一格还细的多边形一个格心都罩不住＝整块政区凭空消失。兜底涂它外接框的中心格：
     宁可粗一格，也不能让导进来的东西看不见。 */
  if (!painted && x0 <= x1) {
    const i = Math.round(((x0 + x1) / 2 - bb.lonMin) / pd - 0.5);
    const j = Math.round(((y0 + y1) / 2 - bb.latMin) / pd - 0.5);
    if (i >= 0 && i < cols && j >= 0 && j < rows) mask[j * cols + i] = 1;
  }
}

/** 位图 → 行程编码（三元组 [行, 起列, 长]，与 eachPaintCenter 的解码同约定） */
function maskToRuns(mask: Uint8Array, cols: number, rows: number, pd: number, cap: number): PaintRuns | null {
  const d: number[] = [];
  for (let j = 0; j < rows; j++) {
    const row = j * cols;
    let run = -1;
    for (let i = 0; i < cols; i++) {
      if (mask[row + i]) { if (run < 0) run = i; }
      else if (run >= 0) { d.push(j, run, i - run); run = -1; if (d.length >= cap * 3) return { pd, d }; }
    }
    if (run >= 0) { d.push(j, run, cols - run); if (d.length >= cap * 3) return { pd, d }; }
  }
  return d.length ? { pd, d } : null;
}

/**
 * 一组多边形 → 涂域行程编码（并集；单个多边形内部按偶奇填充，洞自然扣掉）。
 * @param polys 每个成员＝一个多边形的环列表 [外环, 洞…]
 * @param bb 目标图范围；pd 涂域格边（须＝地形格边，否则涂域与地形错格）
 * @returns 一格都没盖到返 null；格数或三元组撞上限时返回已算出的部分
 */
export function rasterizePolys(polys: Pt[][][], bb: BBox, pd: number, caps: GeoCaps): PaintRuns | null {
  const { cols, rows } = paintDims(bb, pd);
  if (cols * rows > caps.cells) return null;
  const mask = new Uint8Array(cols * rows);
  const budget = { left: caps.crossings };
  for (const rings of polys) fillPoly(mask, cols, rows, bb, pd, rings, budget);
  return maskToRuns(mask, cols, rows, pd, caps.runs);
}

/* —— 转换 —— */

export interface GeoConvertOpts {
  bbox: BBox;                            // 目标图范围（涂域栅格与其同格）
  pd: number;                            // 涂域格边＝地形格边 gridStepDeg(meta)
  palette: string[];                     // 新派系配色（取模轮用）
  existingIds: Set<string>;              // 已占用的对象 id：并入时防撞
  factionByName: Map<string, string>;    // 已有派系「名称→id」：同名复用而不是再建一个
  caps: GeoCaps;
}
export interface GeoPaintAdd { fid: string; layers: PaintLayer[] }
export interface GeoResult {
  nodes: WorldNode[];
  edges: Edge[];
  newFactions: Faction[];       // 不带 paint——涂域一律走 paintAdd，新旧派系同一条路
  paintAdd: GeoPaintAdd[];
  notes: string[];              // 给用户的提示：跳过、钳档、截断
}

/** 剩余属性 → 字段表（键数与值长都钳；空值不留） */
function fieldsOf(props: Record<string, unknown>, used: Set<string>, cap: number): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let n = 0;
  for (const k of Object.keys(props)) {
    if (n >= cap) break;
    if (used.has(k)) continue;
    const v = props[k];
    if (v == null || typeof v === "object") continue;
    const s = String(v).trim();
    if (!s) continue;
    out[k] = s.slice(0, 200);
    n++;
  }
  return n ? out : undefined;
}

/**
 * 扫描结果 + 映射 → 舆图对象。不修改入参。
 * @returns 涂域按「派系 × (起年,讫年)」分层；同名派系复用已有 id，其余新建
 */
export function convertGeoJSON(scan: GeoScan, map: GeoMapping, opts: GeoConvertOpts): GeoResult {
  const res: GeoResult = { nodes: [], edges: [], newFactions: [], paintAdd: [], notes: [] };
  const taken = new Set(opts.existingIds);
  let seq = 0;
  const uid = (p: string): string => {
    let id = "";
    do { id = p + (++seq).toString(36); } while (taken.has(id));
    taken.add(id);
    return id;
  };
  const used = new Set([map.name, map.type, map.since, map.until, map.group].filter(k => k));
  const str = (props: Record<string, unknown>, k: string): string =>
    k ? String(props[k] == null ? "" : props[k]).trim() : "";
  const timed = (props: Record<string, unknown>): { since?: number; until?: number } => {
    const t: { since?: number; until?: number } = {};
    const a = map.since ? parseGeoYear(props[map.since]) : null;
    const b = map.until ? parseGeoYear(props[map.until]) : null;
    if (a != null) t.since = a;
    if (b != null) t.until = b;
    return t;
  };
  const tol = map.simplify ? opts.pd * 0.5 : 0;
  const wantPaint = map.polyAs !== "outline", wantOutline = map.polyAs !== "paint";

  /* 涂域按「派系名 × 起讫」分桶：CHGIS 那类沿革数据一族政区各有起讫，合成一层就把沿革抹平了 */
  const buckets = new Map<string, { name: string; since?: number; until?: number; polys: Pt[][][] }>();
  let longLines = 0;

  for (const f of scan.features) {
    const t = timed(f.props);
    const nm = str(f.props, map.name);
    const 字段 = fieldsOf(f.props, used, opts.caps.fields);
    if (f.kind === "point") {
      const type = map.type ? guessNodeType(f.props[map.type], map.typeDefault) : map.typeDefault;
      for (const p of f.pts) {
        const n: WorldNode = { id: uid("gn"), lon: p[0], lat: p[1], type, ...t };
        if (nm) n.名称 = nm;
        if (字段) n.字段 = { ...字段 };
        res.nodes.push(n);
      }
    } else if (f.kind === "line") {
      for (const l of f.lines) {
        const pts = simplifyLine(l, tol);
        if (pts.length > opts.caps.linePts) { longLines++; continue; }
        const e: Edge = { type: map.lineType, pts: pts.map(p => [p[0], p[1]] as [number, number]), ...t };
        if (nm) e.名称 = nm;
        if (字段) e.字段 = { ...字段 };
        res.edges.push(e);
      }
    } else {
      if (wantOutline) for (const rings of f.polys) for (const r of rings) {
        const pts = simplifyLine(r, tol);
        if (pts.length < 2 || pts.length > opts.caps.linePts) { if (pts.length > opts.caps.linePts) longLines++; continue; }
        const e: Edge = { type: map.outlineType, pts: pts.map(p => [p[0], p[1]] as [number, number]), ...t };
        if (nm) e.名称 = nm;
        res.edges.push(e);
      }
      if (wantPaint && f.polys.length) {
        const gname = str(f.props, map.group) || "导入的疆域";
        const key = gname + " " + (t.since == null ? "" : t.since) + " " + (t.until == null ? "" : t.until);
        const b = buckets.get(key) || { name: gname, since: t.since, until: t.until, polys: [] };
        for (const rings of f.polys) b.polys.push(rings);
        buckets.set(key, b);
      }
    }
  }

  /* 栅格化：按派系归拢分层，层数撞闸就并进最后一层——宁可少几段沿革，也不让一份档生出上千层 */
  const byFaction = new Map<string, { name: string; layers: PaintLayer[]; dropped: number }>();
  const { cols, rows } = paintDims(opts.bbox, opts.pd);
  const tooBig = cols * rows > opts.caps.cells;
  if (tooBig && buckets.size) res.notes.push(`目标地图的涂域网格 ${cols}×${rows} 超出可栅格化上限，面已改为只落边界线`);
  for (const b of buckets.values()) {
    if (tooBig) continue;
    const g = byFaction.get(b.name) || { name: b.name, layers: [], dropped: 0 };
    byFaction.set(b.name, g);
    if (g.layers.length >= opts.caps.layers) { g.dropped++; continue; }
    const runs = rasterizePolys(b.polys, opts.bbox, opts.pd, opts.caps);
    if (!runs) continue;
    const L: PaintLayer = { runs };
    if (b.since != null) L.since = b.since;
    if (b.until != null) L.until = b.until;
    g.layers.push(L);
  }
  if (tooBig && !wantOutline) {   // 上面那轮没画过边界才补，否则每个环会落两条重线
    for (const b of buckets.values()) for (const rings of b.polys) for (const r of rings) {
      const pts = simplifyLine(r, tol);
      if (pts.length >= 2 && pts.length <= opts.caps.linePts)
        res.edges.push({ type: map.outlineType, pts: pts.map(p => [p[0], p[1]] as [number, number]) });
    }
  }

  let ci = 0;
  for (const g of byFaction.values()) {
    if (!g.layers.length) continue;
    let fid = opts.factionByName.get(g.name);
    if (!fid) {
      fid = uid("gf");
      res.newFactions.push({ id: fid, 名称: g.name, color: opts.palette[ci++ % opts.palette.length] });
    }
    res.paintAdd.push({ fid, layers: g.layers });
    if (g.dropped) res.notes.push(`「${g.name}」的时段层超过 ${opts.caps.layers} 个，${g.dropped} 段沿革未导入`);
  }

  if (scan.skipped) res.notes.push(`${scan.skipped} 个要素没有可识别的几何，已跳过`);
  if (longLines) res.notes.push(`${longLines} 条折线点数过多，已跳过（可勾选「折线抽稀」再试）`);
  if (scan.truncated) res.notes.push("文件超出可处理规模，只导入了前一部分");
  return res;
}

/** 要素范围 → 建新图用的 bbox：四周留一成余量，再钳进合法域（度） */
export function padBBox(bb: BBox, minSpan: number): BBox {
  const dx = Math.max((bb.lonMax - bb.lonMin) * 0.1, minSpan / 2);
  const dy = Math.max((bb.latMax - bb.latMin) * 0.1, minSpan / 2);
  return { lonMin: bb.lonMin - dx, lonMax: bb.lonMax + dx, latMin: bb.latMin - dy, latMax: bb.latMax + dy };
}
