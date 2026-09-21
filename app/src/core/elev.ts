/* 高程场（渲染层数据源）：格高程 = ELEV[类型] + 程序化地势起伏(meta.relief) + 高程涂改(heightOverrides)。
   两个特性全关时逐格 === ELEV[类型]——旧图渲染逐位不变（UI 1:1 验收保持）。
   GL（RG32F 纹理 R 通道）与 CPU 兜底（elevOf）共用本模块产出的场；地形类型仍是游戏真源，
   寻路/生态/涂域一概不读高程（坡度代价留作将来的显式行为变更）。
   起伏走 core/relief（波长按公里定、坐标按经纬×每度公里锚定）：战略图与其战术烘焙在同一位置
   取到同一套山系，粗格与细分场只是解析深浅不同。
   等高线等距（contourStepFor）与光标读数采样（elevBilinear）也居此——等高线与读数同源于本场。 */
import { kmPerDeg, kmPerDegXY, lonCos } from "./geo.ts";
import { terrainProps } from "./constants.ts";
import { GEN_COAST_BAND, GEN_HILL, GEN_MOUNTAIN, genHeightAt, genLandformOf, genSeaLevel } from "./terrain.ts";
import { makeRelief, mountainness, RELIEF_M } from "./relief.ts";
import { activeAt } from "./time.ts";
import { stampRect, type Grid } from "./grid.ts";
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
    水域格天花=max(WATER_CEIL, 本次粗格场该格值)——涂水后残留的陆高须压进水面，否则新画的
    水面上浮着旧地形的干斑；取粗格场而非类型表，内陆湖才不会在等待窗里被按回海平面。 */
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
        /* 水域天花取**本次粗格场**的该格值（＝所属水体的水面下切后的床面），不取类型表：
           类型表只有一个 −0.35，拿它当天花会把内陆湖在等待窗里按回海平面、侵蚀落地又弹回来。 */
        v = p.lf === "water" ? Math.min(v, Math.max(WATER_CEIL, now[pr * cols + pc]))
          : Math.max(v, Math.min(Math.min(LAND_FLOOR, p.elev), fine.data[i]));
      }
      data[i] = v;
    }
  }
  return { bb: fine.bb, step: fine.step, cols: fine.cols, rows: fine.rows, data, shadow: fine.shadow };
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


/** 等高距的场统计：陆格坡度 75 分位（米/米）与陆地高程范围（米，p1～p99）。每份规则场算一次（WeakMap 缓存）。 */
export interface ContourStats { slope75: number; rangeM: number }
const statsMemo = new WeakMap<ElevField, ContourStats>();
export function contourStats(field: ElevField, grid: Grid, wsurf: Float32Array, meta: Meta | undefined): ContourStats {
  const hit = statsMemo.get(field);
  if (hit) return hit;
  const { cols, rows, step, data, bb } = field;
  const { kmx, kmy } = kmPerDegXY(meta, bb);
  const unit = elevUnitM(meta), mx = step * kmx * 1000, my = step * kmy * 1000;   // 米/场格
  const stride = Math.max(1, Math.ceil(Math.sqrt(cols * rows / 65536)));         // 抽样 ≤ 65536 点
  const slopes: number[] = [], elevs: number[] = [];
  for (let r = stride >> 1; r < rows; r += stride) {
    const gr = Math.max(0, Math.min(grid.rows - 1, Math.floor((bb.latMin + (r + 0.5) * step - grid.bb.latMin) / grid.step)));
    const r0 = Math.max(0, r - 1), r1 = Math.min(rows - 1, r + 1);
    for (let c = stride >> 1; c < cols; c += stride) {
      const gc = Math.max(0, Math.min(grid.cols - 1, Math.floor((bb.lonMin + (c + 0.5) * step - grid.bb.lonMin) / grid.step)));
      const e = data[r * cols + c];
      if (e < wsurf[gr * grid.cols + gc] - 0.02) continue;   // 水格不计（判据同渲染器的等高线门）
      const c0 = Math.max(0, c - 1), c1 = Math.min(cols - 1, c + 1);
      const gx = (data[r * cols + c1] - data[r * cols + c0]) * unit / ((c1 - c0) * mx);
      const gy = (data[r1 * cols + c] - data[r0 * cols + c]) * unit / ((r1 - r0) * my);
      slopes.push(Math.hypot(gx, gy)); elevs.push(e * unit);
    }
  }
  const n = slopes.length;
  let st: ContourStats = { slope75: 0, rangeM: 0 };
  if (n) {
    slopes.sort((a, b) => a - b); elevs.sort((a, b) => a - b);
    st = { slope75: slopes[Math.floor(0.75 * (n - 1))], rangeM: elevs[Math.floor(0.99 * (n - 1))] - elevs[Math.floor(0.01 * (n - 1))] };
  }
  statsMemo.set(field, st);
  return st;
}

/** 等高距法则的两个阈值：75 分位坡度处首曲线线距不小于 CONTOUR_PX 个 CSS 像素；整幅陆地高程范围至少容下 CONTOUR_LEVELS 级。 */
export const CONTOUR_PX = 8, CONTOUR_LEVELS = 4;
/* 1-2-5 阶梯（米）：≥x 的最小档 / ≤x 的最大档，都不低于地板 floorM——地板本身也算一档（哪怕不在 1-2-5 上）。
   decade 防 Math.log10 的 1 ULP 误差（log10(1000) 在 V8 是 2.9999…）。 */
function decade(x: number): number {
  let b = 10 ** Math.floor(Math.log10(x));
  if (b > x) b /= 10; else if (b * 10 <= x) b *= 10;
  return b;
}
function ladderUp(x: number, floorM: number): number {
  if (x <= floorM) return floorM;
  const b = decade(x);
  for (const m of [1, 2, 5, 10]) if (m * b >= x * (1 - 1e-9)) return Math.max(floorM, m * b);
  return 10 * b;
}
function ladderDown(x: number, floorM: number): number {
  if (x <= floorM) return floorM;
  const b = decade(x);
  let v = b;
  for (const m of [1, 2, 5, 10]) if (m * b <= x * (1 + 1e-9)) v = m * b;
  return Math.max(floorM, v);
}
/** 缩放与地势自适应的等高距：aM/bM＝1-2-5 阶梯上相邻两档（A 细 B 粗，米），a/b 为抽象单位，fade＝B 系权重 0..1。
    法则：地板 contourM（缺省 10）> 上限 高程范围÷CONTOUR_LEVELS > 下限 CONTOUR_PX×坡度₇₅×米/像素。
    下限落在两档之间时交叉淡入（fade=1−(1−t)²，t 为对数位置；粗系先占、细线晚出）；粗档若已装不下四级就不向它淡；
    下限越过上限（陡坡 / 整幅视角）＝上限向下吸附、单系无淡入。stats 为 null（还没有场）按坡度 0.2、范围无穷＝旧 1.6 m/px 手感。 */
export interface ContourStep { aM: number; bM: number; a: number; b: number; fade: number; dom: number }
export function contourStepFor(degPerPx: number, meta: Meta | undefined, stats: ContourStats | null): ContourStep {
  const m = meta || {};
  const floorM = +(m.contourM as number) > 0 ? (m.contourM as number) : 10;
  const mPerPx = Math.max(1e-9, degPerPx) * kmPerDeg(m) * 1000;
  const lowM = Math.max(floorM, CONTOUR_PX * (stats ? stats.slope75 : 0.2) * mPerPx);
  const capM = Math.max(floorM, (stats ? stats.rangeM : Infinity) / CONTOUR_LEVELS);
  const unit = elevUnitM(m);
  // dom＝占优线系的等距（抽象单位）：两系交叉淡入时以权重过半者为准——等高线注记标的是它的计曲线（§9.17）
  const out = (aM: number, bM: number, fade: number): ContourStep =>
    ({ aM, bM, a: aM / unit, b: bM / unit, fade, dom: (fade < 0.5 ? aM : bM) / unit });
  if (lowM >= capM) { const v = ladderDown(capM, floorM); return out(v, v, 0); }
  const lo = ladderDown(lowM, floorM), hi = ladderUp(lowM, floorM);
  if (hi > capM || hi === lo) return out(lo, lo, 0);
  const t = Math.log(lowM / lo) / Math.log(hi / lo);
  return out(lo, hi, 1 - (1 - t) ** 2);
}

/** 间曲线 / 助曲线（基本等高距的 1/2 与 1/4，测绘规范里的补充等高线）：只在上一级线距 ≥ 这些像素数处浮现——
    平缓地补出微地形、山区不添乱。线距按 ±10 px 差分的**粗坡**估（局部梯度被侵蚀微起伏放大几十倍，按它算平地永远开不了门）；
    虚线节距按屏幕像素、相位锚世界坐标（平移不爬动）。GL 与 CPU 各自内联同一组数，两端同式。 */
export const SUP_LO_PX = 28, SUP_HI_PX = 56, SUP_DASH_PX = 16;

/* —— 连续高程基底（渲染层，粗格，抽象单位）——
   类型阶梯不再直接当基底：山地 0.9 与平原 0.16 在一格（战术 100 m）内完成＝65° 的悬崖圈，
   湖面 −0.35 与岸格 0.06 同理。基底按三条规则出：
   ① auto 模式的格若与生成器的地貌一致，取生成器连续高程 elevFromGenH（分类阈值同源）；
   ② 其余取类型值，再按山前最大坡 BASE_SLOPE_DEG 做下包络，台阶展成山前带、小山体自然矮；
   ③ 包络之上按 BASE_BLUR_KM 做物理尺度模糊，**再补一次包络**：包络单独作用时涂改块恰是平顶锥，
      块缘那道折角是「同心圆蛋糕」的外圈；模糊把折角摊成缓肩。半径按公里定＝战术细格上生效
      （0.6 km≈6 格）、战略 6.67 km 格上不足一格自动退化为不做。
      ⚠ 半径只取山前带宽（≈5.5 km）的一成——大了会连宏观一起吃掉：σ=1.5 km 时 auto 图 14 km 的
      主特征衰减两成、3 km 见方的山地块塌到接近平原（实测踩过）。**平顶是台地的另一半病根，
      归起伏模型治，不归模糊**。
      ⚠ 补的那次包络专治「模糊把海岸线抬起来」：0 与 0.16 在岸线两侧对称平均＝岸格凭空抬到 80 m，
      而包络从水格算起恒压回 ≤ 每格坡上限；它只降不升，块内（离水远）分毫不动。
   ④ 水格自岸边起按海床坡 SEABED_SLOPE_DEG 向外变深，深度与地板都从**所属水体的水面**算起
      （见 waterSurfaceOf）：海的水面是 0＝逐位同旧式，内陆湖的水面在岸线高度上。
   ⚠ 只改基底不改分类；水格恒 ≤ 水面 + SHORE_E＝渲染端「低于水面即水」的判据成立。 */
export const BASE_SLOPE_DEG = 15, SEABED_SLOPE_DEG = 3, SHORE_E = -0.03, BASE_BLUR_KM = 0.6;
/** 生成器连续高程 h → 抽象高程：分段线性，各地貌带的均值落回类型值（平原 0.16 / 丘陵 0.5 / 山地 0.9） */
export function elevFromGenH(h: number, meta: Meta | undefined): number {
  const sea = genSeaLevel(meta);
  const seg = (h0: number, e0: number, h1: number, e1: number): number => e0 + (e1 - e0) * (h - h0) / (h1 - h0);
  if (h < sea) return Math.max(-0.35, seg(sea - 0.12, -0.35, sea, SHORE_E));
  if (h < sea + GEN_COAST_BAND) return seg(sea, 0, sea + GEN_COAST_BAND, 0.06);
  if (h < GEN_HILL) return seg(sea + GEN_COAST_BAND, 0.06, GEN_HILL, 0.26);
  if (h < GEN_MOUNTAIN) return seg(GEN_HILL, 0.26, GEN_MOUNTAIN, 0.74);
  return seg(GEN_MOUNTAIN, 0.74, 1, 1.06);
}

/* 生成器连续场按几何记忆（与 grid.seedMemo 同键思路）：涂改不改它，每笔重建只重算包络 */
let genHMemo: { key: string; h: Float32Array } | null = null;
function genHField(m: Meta, grid: FieldGeom): Float32Array {
  const { bb, step, cols, rows } = grid;
  const key = `${bb.lonMin},${bb.latMin},${bb.lonMax},${bb.latMax}|${step}|${cols}x${rows}|${(m.genSeed as number) ?? ""}|${m.genStyle || ""}`;
  if (genHMemo && genHMemo.key === key) return genHMemo.h;
  const h = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) h[r * cols + c] = genHeightAt(m, bb.lonMin + (c + 0.5) * step, bb.latMin + (r + 0.5) * step);
  genHMemo = { key, h };
  return h;
}
/** 8 邻倒角下包络（前向 + 后向两趟即收敛）：b[i] = min(b[i], b[j] + 代价)，代价按轴向距离给 */
function chamferMin(b: Float32Array, cols: number, rows: number, cx: number, cy: number, cd: number): void {
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c; let v = b[i];
    if (c > 0) v = Math.min(v, b[i - 1] + cx);
    if (r > 0) { v = Math.min(v, b[i - cols] + cy); if (c > 0) v = Math.min(v, b[i - cols - 1] + cd); if (c < cols - 1) v = Math.min(v, b[i - cols + 1] + cd); }
    b[i] = v;
  }
  for (let r = rows - 1; r >= 0; r--) for (let c = cols - 1; c >= 0; c--) {
    const i = r * cols + c; let v = b[i];
    if (c < cols - 1) v = Math.min(v, b[i + 1] + cx);
    if (r < rows - 1) { v = Math.min(v, b[i + cols] + cy); if (c < cols - 1) v = Math.min(v, b[i + cols + 1] + cd); if (c > 0) v = Math.min(v, b[i + cols - 1] + cd); }
    b[i] = v;
  }
}
/** 分离式方框模糊三趟（≈高斯 σ≈r+0.5）：边缘钳制延伸、就地改写；r<1 直接返回＝粗格图不动 */
function boxBlur3(f: Float32Array, cols: number, rows: number, r: number): void {
  if (r < 1) return;
  const tmp = new Float32Array(f.length), w = 2 * r + 1;
  const cl = (v: number, hi: number) => v < 0 ? 0 : v > hi ? hi : v;
  for (let p = 0; p < 3; p++) {
    for (let y = 0; y < rows; y++) {   // 横向：滑动和
      const o = y * cols;
      let s = 0;
      for (let k = -r; k <= r; k++) s += f[o + cl(k, cols - 1)];
      for (let x = 0; x < cols; x++) {
        tmp[o + x] = s / w;
        s += f[o + cl(x + r + 1, cols - 1)] - f[o + cl(x - r, cols - 1)];
      }
    }
    for (let x = 0; x < cols; x++) {   // 纵向
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[cl(k, rows - 1) * cols + x];
      for (let y = 0; y < rows; y++) {
        f[y * cols + x] = s / w;
        s += tmp[cl(y + r + 1, rows - 1) * cols + x] - tmp[cl(y - r, rows - 1) * cols + x];
      }
    }
  }
}

/* —— 水面高程（粗格）——
   连通水体（4 邻）逐个定水面：碰到图幅边的算海、恒钉在海平面 0（既有海图逐位不变）；
   其余算内陆湖，水面取岸线最低陆地类型高程——水从最低处溢走，站不到比它更高的位置。
   meta.outside==="land"（图幅外是陆地）时无海可言，被图幅切开的湖也按湖算。
   ⚠ 陆格也记一份（相邻水体水面取最小、无水邻＝0）：渲染端按格最近取，湖面不晕开一格则
     湖岸线被粗格边切成方块；取最小＝夹在高低两湖之间的陆地不被高的那个淹掉。 */
function waterSurfaceOf(t: Float32Array, water: Uint8Array, cols: number, rows: number, inland: boolean): Float32Array {
  const n = cols * rows, lab = new Int32Array(n).fill(-1), surf: number[] = [], st: number[] = [];
  const DR = [0, 0, 1, -1], DC = [1, -1, 0, 0];
  for (let s0 = 0; s0 < n; s0++) {
    if (!water[s0] || lab[s0] >= 0) continue;
    const id = surf.length;
    let sea = false, lo = Infinity;
    lab[s0] = id; st.push(s0);
    while (st.length) {
      const i = st.pop()!, r = (i / cols) | 0, c = i % cols;
      if (!inland && (r === 0 || c === 0 || r === rows - 1 || c === cols - 1)) sea = true;
      for (let k = 0; k < 4; k++) {
        const nr = r + DR[k], nc = c + DC[k];
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const j = nr * cols + nc;
        if (!water[j]) lo = Math.min(lo, t[j]);
        else if (lab[j] < 0) { lab[j] = id; st.push(j); }
      }
    }
    surf.push(sea || !isFinite(lo) ? 0 : lo);   // 整幅皆水（无岸）同样按海平面
  }
  const ws = new Float32Array(n);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    if (water[i]) { ws[i] = surf[lab[i]]; continue; }
    let v = Infinity;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      if (water[nr * cols + nc]) v = Math.min(v, surf[lab[nr * cols + nc]]);
    }
    ws[i] = isFinite(v) ? v : 0;
  }
  return ws;
}

/* —— 按 Grid 实例记忆的派生场（水域掩码 / 基底与水面 / 基底+起伏）——
   ⚠ 键是 Grid 的引用，值却还读 meta：调用方须保证一个 Grid 实例只与一份 meta 配对
   （host 按 terrMetaKey 换键即换 Grid），否则改「图幅外」「起伏」后旧场还魂。数组都是共享只读的。 */
const waterMemo = new WeakMap<Grid, Uint8Array>();
/** 每格水域掩码（1＝地貌 water）：基底、起伏钳制、侵蚀输入与水面标高共用一份，别各自再扫一遍 terrainProps */
export function waterMask(grid: Grid): Uint8Array {
  let w = waterMemo.get(grid);
  if (w) return w;
  const { cols, rows, cells } = grid;
  w = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) w[r * cols + c] = terrainProps(cells[r][c]).lf === "water" ? 1 : 0;
  waterMemo.set(grid, w);
  return w;
}
const baseMemo = new WeakMap<Grid, { base: Float32Array; wsurf: Float32Array }>();
/** 连续高程基底（同一 Grid 实例按引用记忆：一次重建里 buildElevField 与 erodeInput 各取一次） */
export function baseElev(meta: Meta | undefined, grid: Grid): Float32Array { return baseFields(meta, grid).base; }
/** 每格水面高程（海 0 / 内陆湖在岸线高度；陆格取相邻水体水面）：渲染端水陆判据与深浅色的基准。
    ⚠ 与 baseElev 同源同一次计算——两处各算一遍就会出「水面判在这、基底刻在那」的错位。 */
export function waterSurface(meta: Meta | undefined, grid: Grid): Float32Array { return baseFields(meta, grid).wsurf; }
function baseFields(meta: Meta | undefined, grid: Grid): { base: Float32Array; wsurf: Float32Array } {
  const hit = baseMemo.get(grid);
  if (hit) return hit;
  const m = meta || {};
  const { bb, step, cols, rows, cells } = grid, n = cols * rows;
  const kmd = kmPerDeg(m);
  const cosc = lonCos(m, (bb.latMin + bb.latMax) / 2);
  const dxKm = step * kmd * cosc, dyKm = step * kmd, ddKm = Math.hypot(dxKm, dyKm);
  const U = elevUnitM(m);
  const gLand = Math.tan(BASE_SLOPE_DEG * Math.PI / 180) * 1000 / U;   // 抽象/km
  const gSea = Math.tan(SEABED_SLOPE_DEG * Math.PI / 180) * 1000 / U;
  const gen = m.terrain === "auto" ? genHField(m, grid) : null;
  const t = new Float32Array(n), water = waterMask(grid);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c, p = terrainProps(cells[r][c]);
    t[i] = p.elev;
    if (gen && genLandformOf(gen[i], m) === p.lf) t[i] = elevFromGenH(gen[i], m);
  }
  const ws = waterSurfaceOf(t, water, cols, rows, m.outside === "land");
  const b = new Float32Array(n), d = new Float32Array(n);
  for (let i = 0; i < n; i++) { b[i] = water[i] ? ws[i] : t[i]; d[i] = water[i] ? Infinity : 0; }
  chamferMin(b, cols, rows, gLand * dxKm, gLand * dyKm, gLand * ddKm);   // 陆地：水格作源（海=0，湖=湖面），坡不超山前坡
  boxBlur3(b, cols, rows, Math.round(BASE_BLUR_KM / Math.max(dxKm, dyKm)));   // 磨掉块缘折角（水格此刻是水面，随即被海床式覆盖）
  for (let i = 0; i < n; i++) if (water[i]) b[i] = ws[i];                // 补包络前把水源复位到水面（模糊抬过它们）
  chamferMin(b, cols, rows, gLand * dxKm, gLand * dyKm, gLand * ddKm);   // 补一次：只降不升，把被模糊抬起的岸线压回
  chamferMin(d, cols, rows, dxKm, dyKm, ddKm);                           // 水：到最近陆格的距离 km
  for (let i = 0; i < n; i++) if (water[i]) b[i] = Math.max(t[i], ws[i] - 0.35, ws[i] + SHORE_E - gSea * d[i]);
  else if (b[i] < ws[i]) b[i] = ws[i];                                   // 模糊后的陆地不许跌破身旁的水面（钳制参照系之约）
  const out = { base: b, wsurf: ws };
  baseMemo.set(grid, out);
  return out;
}

/** 整幅高程场（行主序 rows×cols，与 grid.cells 对齐）。relief 与涂改全无 → 逐格 === 连续基底 baseElev。
    ⚠ 起伏与侵蚀细分场同走 core/relief 的同一采样器，只是参照细格取粗格边——粗帧与定形后的真形
    是同一套山系的两种解析度，换场时不再「换了张图」。 */
export function buildElevField(meta: Meta | undefined, hov: HeightOverride[] | undefined,
  grid: Grid, yearNow: number): Float32Array {
  const m = meta || {};
  const amp = Math.max(0, Math.min(1, +(m.relief as number) || 0));
  const { cols } = grid;
  const base = baseElev(m, grid), water = waterMask(grid);
  const f = reliefField(m, grid).slice();   // 涂改逐笔叠在记忆的「基底+起伏」上：高程笔每个 move 只剩这三步
  (hov || []).forEach(o => {
    if (!activeAt(o, yearNow)) return;
    const dh = +o.dh || 0; if (!dh) return;
    const rc = stampRect(o, grid);
    if (!rc) return;
    for (let r = rc.r0; r <= rc.r1; r++) for (let c = rc.c0; c <= rc.c1; c++) f[r * cols + c] += dh;
  });
  if (amp > 0 || (hov && hov.length)) {           // 钳制只在特性生效时跑（全关路径零改动）；参照系＝连续基底
    for (let i = 0; i < f.length; i++)
      f[i] = water[i] ? Math.min(Math.max(WATER_CEIL, base[i]), f[i]) : Math.max(Math.min(LAND_FLOOR, base[i]), f[i]);
  }
  return f;
}
const reliefMemo = new WeakMap<Grid, Float32Array>();
/** 基底 + 起伏（涂改之前的场，按 Grid 记忆）；relief=0 ＝ 基底逐位拷贝 */
function reliefField(m: Meta, grid: Grid): Float32Array {
  const hit = reliefMemo.get(grid);
  if (hit) return hit;
  const amp = Math.max(0, Math.min(1, +(m.relief as number) || 0));
  const seed = ((m.genSeed as number) | 0) || 1;
  const { bb, step, cols, rows } = grid;
  const base = baseElev(m, grid), water = waterMask(grid);
  const kmd = kmPerDeg(m);
  const relief = makeRelief(seed, step * kmd), reliefU = RELIEF_M / elevUnitM(m);
  const f = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    let e: number = base[i];
    if (amp > 0 && !water[i]) {
      const mm = amp * mountainness(e);
      if (mm > 0) e += relief((bb.lonMin + (c + 0.5) * step) * kmd, (bb.latMin + (r + 0.5) * step) * kmd, mm) * reliefU;
    }
    f[i] = e;
  }
  reliefMemo.set(grid, f);
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
