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
import type { BBox, HeightOverride, Meta } from "./types.ts";

/* 起伏/涂改后的钳制：陆地不跌成海滩之下、水面不浮出海（类型才是真源，观感须与类型自洽）。
   地板/天花随类型收敛（2026-07 裁决）：地板=min(0.10, 类型基础)、天花=max(-0.06, 类型基础)——
   基础值天然合规 ⇒ 未涂改格永不因开起伏/涂高程而被钳动；否则沿海(0.06)/沼泽复合(0.03/-0.07)
   这些设计低地会在特性开启瞬间被全图统一抬到 0.10（局部动一笔、远处海岸线等高线堆聚）。 */
export const LAND_FLOOR = 0.10, WATER_CEIL = -0.06;

/** 场几何（采样只需这四样——Grid 与细分 ElevField 都满足，结构子型） */
export interface FieldGeom { bb: BBox; step: number; cols: number; rows: number }
/** 高程场（含几何）：粗格=coarseField 包装 buildElevField 产出；细分=core/erode.erodeField。
    shadow=定向天光遮蔽 0..1（烘焙产物，粗格恒 null；只进光照，不进色阶/等高线/读数）。 */
export interface ElevField extends FieldGeom { data: Float32Array; shadow: Float32Array | null }
/** 粗格场包装（旧 buildElevField 产出 + 网格几何；relief=0 契约路径） */
export function coarseField(grid: FieldGeom, data: Float32Array): ElevField {
  return { bb: grid.bb, step: grid.step, cols: grid.cols, rows: grid.rows, data, shadow: null };
}

/** 侵蚀落地渐变的一帧：display = from + (to − from)·t，几何不同（首次落地：粗格→细分）时
    from 先按 to 的细格中心双线性重采样。落地若一帧硬切，笔下区域从平滑预演跳成刻好的真形，
    读感像「出错了自己纠正」（用户实报「不可靠感」）——渐变把结算变成有意的「沉降定形」。
    远处两场逐位相同＝渐变只发生在真正变了的区域；**t≥1 返回 to 本身**（末帧＝真场引用，
    与直接换场逐位一致）。shadow 同插（from 无 shadow 按 0＝烘焙阴影淡入）。 */
export function fieldMix(from: ElevField, to: ElevField, t: number): ElevField {
  if (t >= 1) return to;
  const n = to.cols * to.rows;
  const same = from.cols === to.cols && from.rows === to.rows && from.step === to.step;
  const data = new Float32Array(n), shadow = to.shadow ? new Float32Array(n) : null;
  for (let r = 0; r < to.rows; r++) {
    const lat = to.bb.latMin + (r + 0.5) * to.step;
    for (let c = 0; c < to.cols; c++) {
      const i = r * to.cols + c;
      const f0 = same ? from.data[i] : elevBilinear(from.data, from, to.bb.lonMin + (c + 0.5) * to.step, lat);
      data[i] = f0 + (to.data[i] - f0) * t;
      if (shadow) {
        const s0 = !from.shadow ? 0 : same ? from.shadow[i] : elevBilinear(from.shadow, from, to.bb.lonMin + (c + 0.5) * to.step, lat);
        shadow[i] = s0 + (to.shadow![i] - s0) * t;
      }
    }
  }
  return { bb: to.bb, step: to.step, cols: to.cols, rows: to.rows, data, shadow };
}

/** 侵蚀等待窗的显示合成：细分场 + 粗格增量（now − base）按细格中心双线性上采样叠加。
    重建到侵蚀单落地之间隔着 150ms 防抖 + 数百 ms Worker 计算，这段空窗若直接换回粗格场，
    笔刷按下的每次重建都让全图闪回粗格观感、侵蚀落地又闪回来（「一按全图变、松开又变回」，
    河洛实证）。此函数把「本次粗格场相对细分场所出世界的增量」羽化进旧细分场——未改动格
    增量恒 0＝远处原位不动，笔下格即时起落；羽化与 erodeField 并基座同派（同一 elevBilinear
    同一粗格几何），侵蚀算好即整场换真。base/now 须同出 buildElevField 且几何同 geom；
    **无增量时返回 fine 本身**（引用不变＝帧指纹不动、渲染零重传）。
    补丁只写双线性支撑域所及的细格（笔刷增量天然局部）；正确性由测试拿全量暴力合成作神谕锁。
    ⚠ 传 cells 时补丁窗按格类型钳制（2026-08-09）：渲染端陆/水配色**纯按显示高程判**（terrainGL
    `e>=-0.02`），而「细分场＋大负增量」会穿透海平面——地貌笔落笔连清雕痕（重定基面），涂平原
    盖掉雕出的高山时增量可达 −2 以上，叠上被侵蚀刻低的谷底＝陆地闪成水域、侵蚀落地才回正
    （用户实报「平原和海岸笔刷刷完出现水域地形」）。钳制与 buildElevField 同一脉：
    陆地格地板=min(类型地板, **该细格原细分值**)——海岸旁合法低于类型地板的细格（erode 的钳制
    参照是扭曲基面邻域）不许被人为抬高，增量为零的细格因此恒等于 fine=原位不动之约保持；
    水域格天花=max(WATER_CEIL, 类型基础)——涂水后残留的陆高须压进水面，否则新画的水面上
    浮着旧地形的干斑。 */
export function fieldPlusDelta(fine: ElevField, base: Float32Array, now: Float32Array, geom: FieldGeom, cells?: string[][]): ElevField {
  const { cols, rows } = geom;
  let c0 = cols, c1 = -1, r0 = rows, r1 = -1;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (now[r * cols + c] !== base[r * cols + c]) {
      if (c < c0) c0 = c; if (c > c1) c1 = c;
      if (r < r0) r0 = r; if (r > r1) r1 = r;
    }
  }
  if (c1 < 0) return fine;
  const diff = new Float32Array(rows * cols);
  for (let i = 0; i < rows * cols; i++) diff[i] = now[i] - base[i];
  /* 补丁窗＝变化粗格 [c0..c1]×[r0..r1] 的双线性支撑域折到细格（k=粗细步长比），外留 1 格余量；
     出界钳到边缘格＝边缘章的支撑域自然含边界细格 */
  const k = geom.step / fine.step;
  const fc0 = Math.max(0, Math.floor(k * (c0 - 0.5) - 0.5) - 1), fc1 = Math.min(fine.cols - 1, Math.ceil(k * (c1 + 1.5) - 0.5) + 1);
  const fr0 = Math.max(0, Math.floor(k * (r0 - 0.5) - 0.5) - 1), fr1 = Math.min(fine.rows - 1, Math.ceil(k * (r1 + 1.5) - 0.5) + 1);
  const data = fine.data.slice();
  for (let r = fr0; r <= fr1; r++) {
    const lat = fine.bb.latMin + (r + 0.5) * fine.step;
    const pr = cells ? Math.max(0, Math.min(rows - 1, Math.floor((lat - geom.bb.latMin) / geom.step))) : 0;
    for (let c = fc0; c <= fc1; c++) {
      const i = r * fine.cols + c;
      const lon = fine.bb.lonMin + (c + 0.5) * fine.step;
      let v = fine.data[i] + elevBilinear(diff, geom, lon, lat);
      if (cells) {
        const pc = Math.max(0, Math.min(cols - 1, Math.floor((lon - geom.bb.lonMin) / geom.step)));
        const p = terrainProps(cells[pr][pc]);
        v = p.lf === "water" ? Math.min(v, Math.max(WATER_CEIL, p.elev))
          : Math.max(v, Math.min(Math.min(LAND_FLOOR, p.elev), fine.data[i]));
      }
      data[i] = v;
    }
  }
  return { bb: fine.bb, step: fine.step, cols: fine.cols, rows: fine.rows, data, shadow: fine.shadow };
}

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
/** 高程笔幅度档（米/笔；2026-08-10 精度批，用户点单「战术 1m 起、战略 10m 起」）。 */
export const HEIGHT_STEPS_TAC = [1, 5, 10, 25, 50];
export const HEIGHT_STEPS_STRAT = [10, 25, 50, 100, 250];
/** 生效的每笔米数：chosen≤0/缺省＝自动（战术 10 / 战略 50≈旧硬编码 0.02×2000m=40m 的手感）；
    显式值钳到该图种档域下限（战术 ≥1 / 战略 ≥10）——换图后残留的另一图种档位不至于越下限。 */
export function heightStepM(meta: Meta | undefined, chosen: number): number {
  const tac = ((meta || {}) as { mapKind?: string }).mapKind === "tactical";
  if (!(chosen > 0)) return tac ? 10 : 50;
  return Math.max(tac ? 1 : 10, chosen);
}
/** 纬度每度公里数：平面走 flatKmPerDeg，球面按 2πR/360——与 distKm 同轨（笔刷实尺寸读数亦用） */
export function kmPerDeg(meta: Meta | undefined): number {
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
      const p = terrainProps(cells[r][c]);
      f[i] = p.lf === "water" ? Math.min(Math.max(WATER_CEIL, p.elev), f[i]) : Math.max(Math.min(LAND_FLOOR, p.elev), f[i]);
    }
  }
  return f;
}

/** 制图分析面：双线性场再做 ±半格 4 抽头帐篷平滑（GIS 出等高线前的标准预平滑）。
    跨类型的单格陡坎被摊成两格缓坡——等高线在类型边界从"糊成一条带"展开为可读的线扇。
    光标读数与等高线同源于此面（读数=线，勿一个平滑一个不平滑）。
    细分场（侵蚀）下 grid 传 ElevField 本身＝半细格帐篷——谷线细节不被粗格平滑抹掉。 */
export function elevSmooth(field: Float32Array, grid: FieldGeom, lon: number, lat: number): number {
  const h = grid.step * 0.5;
  return 0.25 * (elevBilinear(field, grid, lon - h, lat - h) + elevBilinear(field, grid, lon + h, lat - h)
    + elevBilinear(field, grid, lon - h, lat + h) + elevBilinear(field, grid, lon + h, lat + h));
}

/** 高程场双线性采样（elevSmooth 的底层；渲染端晕渲同一插值）。lon 须已折回网格经度域；出格钳到边缘格。 */
export function elevBilinear(field: Float32Array, grid: FieldGeom, lon: number, lat: number): number {
  const { bb, step, cols, rows } = grid;
  const fx = (lon - bb.lonMin) / step - 0.5, fy = (lat - bb.latMin) / step - 0.5;
  const c0 = Math.max(0, Math.min(cols - 1, Math.floor(fx))), r0 = Math.max(0, Math.min(rows - 1, Math.floor(fy)));
  const c1 = Math.min(cols - 1, c0 + 1), r1 = Math.min(rows - 1, r0 + 1);
  const tx = Math.max(0, Math.min(1, fx - c0)), ty = Math.max(0, Math.min(1, fy - r0));
  const v = (r: number, c: number) => field[r * cols + c];
  const top = v(r0, c0) + (v(r0, c1) - v(r0, c0)) * tx, bot = v(r1, c0) + (v(r1, c1) - v(r1, c0)) * tx;
  return top + (bot - top) * ty;
}
