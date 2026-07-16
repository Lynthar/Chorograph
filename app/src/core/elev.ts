/* 高程场（渲染层数据源）：格高程 = ELEV[类型] + 程序化地势起伏(meta.relief) + 高程涂改(heightOverrides)。
   两个特性全关时逐格 === ELEV[类型]——旧图渲染逐位不变（UI 1:1 验收保持）。
   GL（RG32F 纹理 R 通道）与 CPU 兜底（elevOf）共用本模块产出的场；地形类型仍是游戏真源，
   寻路/生态/涂域一概不读高程（坡度代价留作将来的显式行为变更）。
   起伏噪声锚定经纬度（非网格步长）：战略图与其战术烘焙在同一位置取到同一起伏；
   三个倍频（约 1.2°/0.17°/0.03°）令战略与战术两种尺度都有可见地势。
   等高线等距（contourStepFor）与光标读数采样（elevBilinear）也居此——等高线与读数同源于本场。 */
import { fbm } from "./noise.ts";
import { flatKmPerDeg } from "./geo.ts";
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
/** 纬度每度公里数：平面走 flatKmPerDeg，球面按 2πR/360——与 distKm 同轨 */
function kmPerDeg(meta: Meta | undefined): number {
  const m = meta || {};
  return m.worldModel === "flat" ? flatKmPerDeg(m) : 2 * Math.PI * (+(m.planetRadiusKm ?? 0) || 10000) / 360;
}

/** 缩放自适应等高距。测绘经验式「等距(米)≈比例尺分母/4000」在 96dpi 屏上化简为
    「理想等距≈1.6×每像素米数」；向上吸附到以 meta.contourM（缺省 10m=数据标定下限）为锚的
    ×2 阶梯（10,20,40,80…）。fade∈[0,1)=下一细分档的淡入系数（已调 f² 曲线）：×2 阶梯令线系
    严格嵌套——过渡期新线恰在旧线正中浮现，跨档时 fade 1→0 与 minor 折半在视觉上严格连续。 */
export function contourStepFor(degPerPx: number, meta: Meta | undefined): { minorM: number; minor: number; fade: number } {
  const m = meta || {};
  const baseM = +(m.contourM as number) > 0 ? (m.contourM as number) : 10;
  const idealM = 1.6 * Math.max(1e-9, degPerPx) * kmPerDeg(m) * 1000;
  const n = Math.max(0, Math.ceil(Math.log2(idealM / baseM) - 1e-9));   // −1e-9：档界恰为 2 整幂时防 fp 抖动上跳
  const minorM = baseM * 2 ** n;
  const f = n > 0 ? Math.min(1, Math.max(0, Math.log2(minorM / idealM))) : 0;
  return { minorM, minor: minorM / elevUnitM(m), fade: f * f };
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

/** 制图分析面：双线性场再做 ±半格 4 抽头帐篷平滑（GIS 出等高线前的标准预平滑）。
    跨类型的单格陡坎被摊成两格缓坡——等高线在类型边界从"糊成一条带"展开为可读的线扇。
    光标读数与等高线同源于此面（读数=线，勿一个平滑一个不平滑）。 */
export function elevSmooth(field: Float32Array, grid: Grid, lon: number, lat: number): number {
  const h = grid.step * 0.5;
  return 0.25 * (elevBilinear(field, grid, lon - h, lat - h) + elevBilinear(field, grid, lon + h, lat - h)
    + elevBilinear(field, grid, lon - h, lat + h) + elevBilinear(field, grid, lon + h, lat + h));
}

/** 高程场双线性采样（elevSmooth 的底层；渲染端晕渲同一插值）。lon 须已折回网格经度域；出格钳到边缘格。 */
export function elevBilinear(field: Float32Array, grid: Grid, lon: number, lat: number): number {
  const { bb, step, cols, rows } = grid;
  const fx = (lon - bb.lonMin) / step - 0.5, fy = (lat - bb.latMin) / step - 0.5;
  const c0 = Math.max(0, Math.min(cols - 1, Math.floor(fx))), r0 = Math.max(0, Math.min(rows - 1, Math.floor(fy)));
  const c1 = Math.min(cols - 1, c0 + 1), r1 = Math.min(rows - 1, r0 + 1);
  const tx = Math.max(0, Math.min(1, fx - c0)), ty = Math.max(0, Math.min(1, fy - r0));
  const v = (r: number, c: number) => field[r * cols + c];
  const top = v(r0, c0) + (v(r0, c1) - v(r0, c0)) * tx, bot = v(r1, c0) + (v(r1, c1) - v(r1, c0)) * tx;
  return top + (bot - top) * ty;
}
