/* 生成器 v2 测试共用的图与量具（gen2 / gen2-delta 两组测试同用一份） */
import { gen2Meso, gen2Params, type Gen2MesoField } from "../../src/core/gen2.ts";
import { autoGridN, buildGridCells } from "../../src/core/grid.ts";
import { Heap } from "../../src/core/steady.ts";
import { waterSurface } from "../../src/core/elev.ts";
import { ECO_ORDER, LANDFORM_ORDER } from "../../src/core/constants.ts";
import { DEFAULT_BBOX, type Meta } from "../../src/core/types.ts";

export const BB = { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 };
/** 河口展宽的倍数（core/gen2 的 RIV_MOUTH） */
export const RIV_MOUTH_X = 2;
/** 夹具图幅（48°×32°、半径 1 万 km），缺省 240 列 */
export const v2 = (style: "mono" | "multi" | "isles", seed: number, extra: Partial<Meta> = {}): Meta =>
  ({ terrain: "auto", genVer: 2, genSeed: seed, genStyle: style, bbox: BB, worldModel: "sphere", planetRadiusKm: 10000, gridN: 240, ...extra });

/** 缺省图幅（地球半径、陆地与山地居中）的中尺度场：同一张图只算一次 */
const dflts = new Map<string, { m: Meta; R: ReturnType<typeof gen2Meso> }>();
export function dfltOf(style: "mono" | "multi", seed: number): { m: Meta; R: ReturnType<typeof gen2Meso> } {
  const k = style + seed; let d = dflts.get(k);
  if (!d) {
    const m: Meta = { terrain: "auto", genVer: 2, genSeed: seed, genStyle: style, genLand: 0.5, genMtn: 0.5, bbox: { ...DEFAULT_BBOX }, worldModel: "sphere", planetRadiusKm: 6371 };
    m.gridN = autoGridN(m);
    d = { m, R: gen2Meso(m, buildGridCells(m, [], 0)) }; dflts.set(k, d);
  }
  return d;
}

/** 封闭洼地：自水（渲染端的水面）与盐滩填洼，G 给了沿求解图、否则按格心四邻；陆格被填高过 1e-3 m 的个数与最深（米） */
export function closedPits(m: Meta, R: Gen2MesoField, G: { nbOff: Int32Array; nb: Int32Array } | null): { n: number; worst: number } {
  const gm = buildGridCells(m, [], 0, R), ws = waterSurface(m, gm), um = gen2Params(m).unitM, { cols, rows } = gm, n = cols * rows;
  const ne = ECO_ORDER.length, W = LANDFORM_ORDER.indexOf("water"), salt = ECO_ORDER.indexOf("salt"), f = new Float64Array(n), seen = new Uint8Array(n), hp = new Heap(64);
  for (let i = 0; i < n; i++) {
    const w = ((R.cls[i] / ne) | 0) === W;
    f[i] = w ? ws[i] * um : R.base[i] * um;
    if (w || R.cls[i] % ne === salt) { seen[i] = 1; hp.push(f[i], i); }
  }
  let k = 0, worst = 0;
  while (hp.n) {
    const i = hp.pop(), r = (i / cols) | 0, c = i - r * cols;
    const nbs = G ? Array.from(G.nb.subarray(G.nbOff[i], G.nbOff[i + 1])) : [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1];
    for (const j of nbs) {
      if (j < 0 || seen[j]) continue;
      seen[j] = 1;
      if (f[j] < f[i] - 1e-3) { k++; if (f[i] - f[j] > worst) worst = f[i] - f[j]; f[j] = f[i]; }
      hp.push(f[j], j);
    }
  }
  return { n: k, worst };
}
