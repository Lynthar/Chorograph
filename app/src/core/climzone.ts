/* 气候分区（world.climateZones，战略图专有）：作者涂的六档气候 → 分区栅格；未涂处依次取 v2 派生（不落盘）与 meta.climate。
   只进观感（配色、林线、雪线），不进地类、寻路与 terrKey。 */
import { CLIMATE, CLIMATE_ORDER } from "./constants.ts";
import { gen2Zones, isGen2, type Gen2Zones } from "./gen2.ts";
import { gridStepDeg } from "./grid.ts";
import { eachPaintCenter, paintDims } from "./territory.ts";
import { tget } from "./util.ts";
import type { BBox, Climate, ClimateZone, Meta, World } from "./types.ts";

/** 分区格边＝地形格边的倍数：战略缺省 6.67 km 格上约 20 km */
export const ZONE_MUL = 3;
export function zoneStep(meta: Meta | undefined): number { return ZONE_MUL * gridStepDeg(meta); }

/** 分区示意色（数据色，编辑时的分区示意层与气候页签的色块共用）：大类沿用柯本图的惯用色相 */
export const CLIMATE_SWATCH: Record<Climate, string> = {
  polar: "#9aa4ad", boreal: "#7a5ea8", temperate: "#3e9b4f", subtropical: "#9cc63f", tropical: "#2f74b5", arid: "#e0723c"
};

export interface ZoneGeom { bb: BBox; pd: number; cols: number; rows: number }
/** 分区栅格：z[j·cols+i]＝0 未涂、k＝CLIMATE_ORDER[k−1]；行 0 在南 */
export interface ZoneGrid extends ZoneGeom { z: Uint8Array }

export function zoneGeom(meta: Meta | undefined): ZoneGeom {
  const pd = zoneStep(meta), { bb, cols, rows } = paintDims((meta || {}).bbox, pd);
  return { bb, pd, cols, rows };
}
export const zoneIndex = (c: unknown): number => tget(CLIMATE, c) ? CLIMATE_ORDER.indexOf(c as Climate) + 1 : 0;
export const zoneClimate = (k: number): Climate | undefined => k > 0 ? CLIMATE_ORDER[k - 1] : undefined;

/* 涂的分区按数组引用记忆：数组当不可变快照，改了就换新数组（写端 paintClimatePath 守着） */
const paintedMemo = new WeakMap<object, { key: string; g: ZoneGrid }>();
const geomKey = (g: ZoneGeom): string => JSON.stringify([g.bb, g.pd, g.cols, g.rows]);

/** 涂的分区 → 栅格（后出现的层压前面的；未知档与坏 runs 跳过）。结果只读 */
export function paintedZones(meta: Meta | undefined, zones: readonly ClimateZone[] | undefined): ZoneGrid | null {
  if (!Array.isArray(zones) || !zones.length) return null;
  const geo = zoneGeom(meta), key = geomKey(geo), hit = paintedMemo.get(zones);
  if (hit && hit.key === key) return hit.g;
  const z = new Uint8Array(geo.cols * geo.rows);
  for (const L of zones) {
    const k = L && typeof L === "object" ? zoneIndex(L.climate) : 0;
    if (!k) continue;
    eachPaintCenter({ runs: L.runs }, geo.bb, (lon, lat) => {
      const i = Math.round((lon - geo.bb.lonMin) / geo.pd - 0.5), j = Math.round((lat - geo.bb.latMin) / geo.pd - 0.5);
      if (i >= 0 && j >= 0 && i < geo.cols && j < geo.rows) z[j * geo.cols + i] = k;
    });
  }
  const g = { ...geo, z };
  paintedMemo.set(zones, { key, g });
  return g;
}

/** 栅格 → 存档形态（按 CLIMATE_ORDER 每档一份 runs，空档不写）；记下解码结果，下一帧不必重栅格化 */
export function encodeZones(g: ZoneGrid): ClimateZone[] {
  const out: ClimateZone[] = [];
  for (let k = 1; k <= CLIMATE_ORDER.length; k++) {
    const d: number[] = [];
    for (let j = 0; j < g.rows; j++) {
      const b = j * g.cols;
      let run = -1;
      for (let i = 0; i < g.cols; i++) {
        const on = g.z[b + i] === k;
        if (on && run < 0) run = i;
        else if (!on && run >= 0) { d.push(j, run, i - run); run = -1; }
      }
      if (run >= 0) d.push(j, run, g.cols - run);
    }
    if (d.length) out.push({ climate: CLIMATE_ORDER[k - 1], runs: { pd: g.pd, d } });
  }
  if (out.length) paintedMemo.set(out, { key: geomKey(g), g });
  return out;
}

/** 圆盘笔刷一笔（与涂域笔同一几何：di²+dj² ≤ R²+0.5）：k＝要涂的档，0＝擦回未涂；返回是否有变化 */
export function brushZones(g: ZoneGrid, lon: number, lat: number, R: number, k: number): boolean {
  const ci = Math.floor((lon - g.bb.lonMin) / g.pd), cj = Math.floor((lat - g.bb.latMin) / g.pd);
  let ch = false;
  for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
    if (di * di + dj * dj > R * R + 0.5) continue;
    const i = ci + di, j = cj + dj;
    if (i < 0 || j < 0 || i >= g.cols || j >= g.rows) continue;
    const q = j * g.cols + i;
    if (g.z[q] !== k) { g.z[q] = k; ch = true; }
  }
  return ch;
}

/** 渲染与查找用的分区栅格：涂的 > v2 派生 > 0（0＝取 meta.climate）；key 随内容换代；painted / derivedLand 只给编辑示意 */
export interface ZoneField extends ZoneGrid { key: string; painted: ZoneGrid | null; derivedLand: Uint8Array | null }
let fieldMemo: { p: ZoneGrid | null; d: Gen2Zones | null; f: ZoneField } | null = null, fieldSeq = 0;

/** 战术图、或既没涂过也不是 v2 的图＝null：两个渲染器走无分区的旧路径 */
export function zoneField(w: World | null | undefined): ZoneField | null {
  if (!w) return null;
  const m = w.meta || {};
  if (m.mapKind === "tactical") return null;
  const p = paintedZones(m, w.climateZones), geo = p || zoneGeom(m), d = isGen2(m) ? gen2Zones(m, geo) : null;
  if (!p && !d) return null;
  if (fieldMemo && fieldMemo.p === p && fieldMemo.d === d) return fieldMemo.f;
  let z: Uint8Array;
  if (p && d) { z = Uint8Array.from(d.z); for (let i = 0; i < z.length; i++) if (p.z[i]) z[i] = p.z[i]; }
  else z = p ? p.z : d!.z;
  const f: ZoneField = { ...geo, z, key: "z" + ++fieldSeq, painted: p, derivedLand: d ? d.land : null };
  fieldMemo = { p, d, f };
  return f;
}

/** 某点的气候档（涂的 > v2 派生 > meta.climate；都没有＝undefined）：战术子图继承母图在中心处那一档 */
export function climateAt(w: World, lon: number, lat: number): Climate | undefined {
  const f = zoneField(w);
  if (f) {
    const i = Math.floor((lon - f.bb.lonMin) / f.pd), j = Math.floor((lat - f.bb.latMin) / f.pd);
    const c = i >= 0 && j >= 0 && i < f.cols && j < f.rows ? zoneClimate(f.z[j * f.cols + i]) : undefined;
    if (c) return c;
  }
  const mc = (w.meta || {}).climate;
  return tget(CLIMATE, mc) ? mc : undefined;
}
