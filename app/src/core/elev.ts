/* 高程场（渲染层数据源）：格高程 = ELEV[类型] + 程序化地势起伏(meta.relief) + 高程涂改(heightOverrides)。
   两个特性全关时逐格 === ELEV[类型]——旧图渲染逐位不变（UI 1:1 验收保持）。
   GL（RG32F 纹理 R 通道）与 CPU 兜底（elevOf）共用本模块产出的场；地形类型仍是游戏真源，
   寻路/生态/涂域一概不读高程（坡度代价留作将来的显式行为变更）。
   起伏噪声锚定经纬度（非网格步长）：战略图与其战术烘焙在同一位置取到同一起伏；
   三个倍频（约 1.2°/0.17°/0.03°）令战略与战术两种尺度都有可见地势。 */
import { fbm } from "./noise.ts";
import { terrainProps } from "./constants.ts";
import { activeAt } from "./time.ts";
import type { Grid } from "./grid.ts";
import type { HeightOverride, Meta } from "./types.ts";

/* 起伏/涂改后的钳制：陆地不跌成海滩之下、水面不浮出海（类型才是真源，观感须与类型自洽） */
const LAND_FLOOR = 0.10, WATER_CEIL = -0.06;

/** 程序化起伏（约 -0.5..0.5）：种子移相 + 三倍频跨尺度 */
export function reliefNoise(lon: number, lat: number, seed: number): number {
  const sx = (seed % 233) * 0.517 + 21.3, sy = (Math.floor(seed / 233) % 233) * 0.731 + 11.7;
  return 0.5 * fbm(lon * 0.8 + sx, lat * 0.8 + sy)
    + 0.35 * fbm(lon * 6.0 + sx * 1.3 + 60, lat * 6.0 + sy + 60)
    + 0.15 * fbm(lon * 36 + sx + 140, lat * 36 + sy + 140) - 0.5;
}

/** 默认高程标定：1 抽象单位 = 2000 米（雪线 0.82≈1640m、示意山 0.9≈1800m 的合理观感） */
export function elevUnitM(meta: Meta | undefined): number {
  return +((meta || {}).elevUnitM as number) || 2000;
}
/** 等高距（抽象单位）：meta.contourM 换算；缺省=0.12（与旧着色器常数逐位一致） */
export function contourInterval(meta: Meta | undefined): number {
  const m = meta || {};
  return +(m.contourM as number) > 0 ? (m.contourM as number) / elevUnitM(m) : 0.12;
}

/** 整幅高程场（行主序 rows×cols，与 grid.cells 对齐）。relief 与涂改全无 → 逐格 === ELEV[类型] */
export function buildElevField(meta: Meta | undefined, hov: HeightOverride[] | undefined,
  grid: Grid, yearNow: number): Float32Array {
  const m = meta || {};
  const amp = Math.max(0, Math.min(1, +(m.relief as number) || 0));
  const seed = ((m.genSeed as number) | 0) || 1;
  const { bb, step, cols, rows, cells } = grid;
  const f = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const p = terrainProps(cells[r][c]);
    let e: number = p.elev;
    const ra = amp > 0 ? p.relief : 0;
    if (ra > 0) e += ra * amp * 2 * reliefNoise(bb.lonMin + (c + 0.5) * step, bb.latMin + (r + 0.5) * step, seed);
    f[r * cols + c] = e;
  }
  (hov || []).forEach(o => {
    if (!activeAt(o, yearNow)) return;
    const dh = +o.dh || 0; if (!dh) return;
    const bs = +(o.step as number) || step;
    if (bs <= step * 1.001) {                     // 常规：单格
      const c = Math.floor((o.lon - bb.lonMin) / step), r = Math.floor((o.lat - bb.latMin) / step);
      if (r >= 0 && r < rows && c >= 0 && c < cols) f[r * cols + c] += dh;
    } else {                                      // 粗块盖章：铺满所覆盖细格（同 buildGridCells 几何）
      const c0 = Math.max(0, Math.floor((o.lon - bs / 2 - bb.lonMin) / step)), c1 = Math.min(cols - 1, Math.floor((o.lon + bs / 2 - bb.lonMin - 1e-9) / step));
      const r0 = Math.max(0, Math.floor((o.lat - bs / 2 - bb.latMin) / step)), r1 = Math.min(rows - 1, Math.floor((o.lat + bs / 2 - bb.latMin - 1e-9) / step));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) f[r * cols + c] += dh;
    }
  });
  if (amp > 0 || (hov && hov.length)) {           // 钳制只在特性生效时跑（全关路径零改动）
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      f[i] = terrainProps(cells[r][c]).lf === "water" ? Math.min(WATER_CEIL, f[i]) : Math.max(LAND_FLOOR, f[i]);
    }
  }
  return f;
}
