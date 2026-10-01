/* 起伏模型（渲染层数据源，纯函数）：把「山地度」变成有走向、有层次的多尺度脊线场。
   erode 的侵蚀基座与 elev 的粗格场共用本模块——两处各写一套就是「战术图与战略图两个产品」。
   ⚠ 波长按**公里**定死、坐标按经纬锚定（平面图经纬 × 每度公里、球面图单位球 × 半径的三维点）：同一世界在任何图幅、任何格粒度上都是同一套
     山系，只是细格解析得深浅不同。按格锚定时 6.67 km 战略格上最细带一格半一个周期＝混叠碎皱，
     而 100 m 战术格上同一条带只有几十米＝两种图像两个产品（2026-09-02 实拍）。
   ⚠ 山地度由**基面高程**给（不由类型表 relief 给）：高处更起伏是连续的，手雕出来的高山因此自动
     获得山地质感，不必再为雕体另开一条系数通道。 */

/* —— 整数哈希梯度噪声（确定性；与 core/noise 的 sin-hash 无关＝不入平价）——
   ridged=(1−|g|)² ＝尖脊宽谷的经典山系形（Musgrave）；平方锐化撑得起山系读感，单次 1−|g| 是软枕头。
   ⚠ 梯度集不许含坐标轴方向：两端梯度都垂直于格边时整条格边恒 0（轴向集约 1/16 的格边），晕渲上是直缝。 */
const G8X: number[] = [], G8Y: number[] = [];
for (let k = 0; k < 8; k++) { const a = (k + 0.5) * Math.PI / 4; G8X.push(Math.cos(a)); G8Y.push(Math.sin(a)); }
function hash2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 974634541)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) & 7;
}
/** 三维梯度：立方体 12 条棱方向（补 4 个重复凑 16 档），无一与坐标轴平行 */
const G12 = [1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 1, 1, 0, -1, 1, 0, 0, -1, 1, 0, -1, -1];
function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 1440662683) + Math.imul(seed, 974634541)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) & 15) * 3;
}
/** 三维梯度噪声 ≈[-1,1]（与二维同标准差） */
function gnoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const d = (cx: number, cy: number, cz: number, dx: number, dy: number, dz: number): number => {
    const g = hash3(cx, cy, cz, seed);
    return G12[g] * dx + G12[g + 1] * dy + G12[g + 2] * dz;
  };
  const x00 = d(ix, iy, iz, fx, fy, fz), x10 = d(ix, iy + 1, iz, fx, fy - 1, fz);
  const x01 = d(ix, iy, iz + 1, fx, fy, fz - 1), x11 = d(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1);
  const a = x00 + (d(ix + 1, iy, iz, fx - 1, fy, fz) - x00) * u, b = x10 + (d(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz) - x10) * u;
  const c = x01 + (d(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1) - x01) * u, e = x11 + (d(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1) - x11) * u;
  const p = a + (b - a) * v, q = c + (e - c) * v;
  return (p + (q - p) * w) * 1.31;
}
function ridged3(x: number, y: number, z: number, seed: number): number {
  const r = 1 - Math.min(1, Math.abs(gnoise3(x, y, z, seed)));
  return r * r;
}
/** 梯度噪声 ≈[-1,1] */
export function gnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const d = (cx: number, cy: number, dx: number, dy: number): number => {
    const g = hash2(cx, cy, seed);
    return G8X[g] * dx + G8Y[g] * dy;
  };
  const a = d(ix, iy, fx, fy) + (d(ix + 1, iy, fx - 1, fy) - d(ix, iy, fx, fy)) * u;
  const b = d(ix, iy + 1, fx, fy - 1) + (d(ix + 1, iy + 1, fx - 1, fy - 1) - d(ix, iy + 1, fx, fy - 1)) * u;
  return (a + (b - a) * v) * 1.6;
}
/** 脊形噪声 [0,1]：峰=1 谷=0 */
export function ridged(x: number, y: number, seed: number): number {
  const r = 1 - Math.min(1, Math.abs(gnoise(x, y, seed)));
  return r * r;
}
/** ridged / ridged3 的经验均值（居中用；probe 实测。改锐化式或梯度集须重测——否则整片山系被系统性抬高或压低） */
export const RIDGED_MEAN = 0.5711, RIDGED_MEAN3 = 0.5669;

/** 满山地的起伏总幅（米）。分布是**右偏**的（ridged² 居中后：谷宽而浅、脊窄而高）——
    实测归一值 p01 −0.20 / p50 0 / p99 +0.29 / max +0.51，故 2400 m 给出谷 −480 m、峰 +700 m、
    极峰 +1200 m：山地基面 1800 m 上峰顶 3000 m 越过 2050 m 雪线，谷底 1300 m 仍是山地色。
    ⚠ 1400 m 时战术 60 km 图的峰只到 1574 m＝够不到雪线、也读不出高差（用户实报「不够宏伟」）。 */
export const RELIEF_M = 2400;
/** 七个八度的波长（km）与权重：128 km 山系轮廓 → 2 km 支沟；权重和为 1。
    ⚠ 最长带要够长：全球图的格是 35 km，连 64 km 带都过不了混叠门——没有 128 km 这一条，整幅图
      就是一块没有山系的色斑（实拍）。真实山系本就有百公里级轮廓（阿尔卑斯宽约 150 km）。
    ⚠ 它的权重要小：波长超过图幅的带在图上只是一个整体倾斜，权重给大了就是把幅度花在看不见的
      波段上（2026-08 首版把大头押在最长带、涂山照旧平顶，已踩过）。 */
export const RELIEF_LAMBDA_KM = [128, 64, 32, 16, 8, 4, 2];
export const RELIEF_W = [0.16, 0.24, 0.20, 0.16, 0.12, 0.07, 0.05];
/** 逐带防混叠门（λ/参照细格）：低于 2 全关、高于 3.5 全开——大图自动只剩长带，不出碎皱。
    ⚠ 下限贴着奈奎斯特（2 采样/波长）走：取 2.5/5 时全球图 22 km 格上连最长的 64 km 带都只开 7%，
    整幅是一块没有山系的色斑（实拍）。 */
export const RELIEF_GATE_LO = 2, RELIEF_GATE_HI = 3.5;
/** 异质权重区间：下一带的幅度随本带取值在此区间内取——峰区糙、谷区缓（均匀权重＝满幅砂纸） */
export const RELIEF_ROUGH_LO = 0.30, RELIEF_ROUGH_HI = 1.25;
/** 最长两带沿走向的拉伸倍率：山脉成条带而非斑块 */
export const RELIEF_STRIKE = 2.2;
/** 山地度的基面高程区间（抽象）：平原 0.16→0、丘陵 0.5→0.42、山地 0.9→1 */
export const RELIEF_E0 = 0.22, RELIEF_E1 = 0.85;
/** 雕体高度 → 山地度：dh=1.25 抽象（2500 m）即满档 */
export const RELIEF_CARVE_K = 0.8;

const sstep = (t: number): number => { const x = t < 0 ? 0 : t > 1 ? 1 : t; return x * x * (3 - 2 * x); };

/** 山地度（基面高程 → 0..1） */
export function mountainness(baseE: number): number {
  return sstep((baseE - RELIEF_E0) / (RELIEF_E1 - RELIEF_E0));
}

/** 起伏采样器：(经度, 纬度, 山地度) → 归一起伏（约 ±0.5，乘 RELIEF_M/elevUnitM 得抽象高程） */
export type ReliefSampler = (lon: number, lat: number, m: number) => number;

/** refCellKm＝参照细格边长（防混叠门的判据）；kmd＝每纬度公里；sphere＝球面图的图幅中心 [经, 纬]（null＝平面图）。同参数下确定性。
    ⚠ 球面图必须按单位球 × 半径的三维坐标取样：「经度 × 每纬度公里」在纬度 φ 处把东西向压成 cos φ 倍，
    山纹被拉成南北向（54° 处东西/南北梯度能量比 3 倍）。平面图按经纬 × kmd 取二维。 */
export function makeRelief(seed: number, refCellKm: number, kmd: number, sphere: readonly [number, number] | null): ReliefSampler {
  const th = ((Math.imul(seed | 0, 2654435761) >>> 0) / 4294967296) * Math.PI;   // 每图一个山脉走向角
  const ct = Math.cos(th), st = Math.sin(th);
  const R = kmd * 180 / Math.PI, D = Math.PI / 180, sq = 1 / RELIEF_STRIKE - 1;
  /* 球面的走向轴取图幅中心切平面上、按走向角转出的方向：固定的三维轴在地面上的投影随位置变，
     轴近乎竖直的那片地方条带拉伸就没了（战略图只解析得出最长几条带，山系成斑块） */
  const l0 = sphere ? sphere[0] * D : 0, p0 = sphere ? sphere[1] * D : 0;
  const ax = -ct * Math.sin(l0) - st * Math.sin(p0) * Math.cos(l0), ay = ct * Math.cos(l0) - st * Math.sin(p0) * Math.sin(l0), az = st * Math.cos(p0);
  const gate = RELIEF_LAMBDA_KM.map(l => sstep((l / Math.max(1e-9, refCellKm) - RELIEF_GATE_LO) / (RELIEF_GATE_HI - RELIEF_GATE_LO)));
  const wsum = RELIEF_W.reduce((a, w, k) => a + w * gate[k], 0);
  if (wsum <= 0) return () => 0;
  return (lon, lat, m) => {
    if (m <= 0) return 0;
    let X = 0, Y = 0, Z = 0;
    if (sphere) { const cp = Math.cos(lat * D); X = R * cp * Math.cos(lon * D); Y = R * cp * Math.sin(lon * D); Z = R * Math.sin(lat * D); }
    else { X = lon * kmd; Y = lat * kmd; }
    let s = 0, w = 1;
    for (let k = 0; k < RELIEF_LAMBDA_KM.length; k++) {
      if (gate[k] <= 0) continue;
      const f = 1 / RELIEF_LAMBDA_KM[k], sd = seed + 7000 + k * 97;
      let x = X * f, y = Y * f, n: number, mean: number;
      if (sphere) {
        let z = Z * f;
        if (k < 2) { const t = (x * ax + y * ay + z * az) * sq; x += t * ax; y += t * ay; z += t * az; }
        n = ridged3(x, y, z, sd); mean = RIDGED_MEAN3;
      } else {
        if (k < 2) { const a = (x * ct + y * st) / RELIEF_STRIKE, b = -x * st + y * ct; x = a; y = b; }
        n = ridged(x, y, sd); mean = RIDGED_MEAN;
      }
      s += w * RELIEF_W[k] * gate[k] * (n - mean);
      w = RELIEF_ROUGH_LO + (RELIEF_ROUGH_HI - RELIEF_ROUGH_LO) * n;   // 异质：本带在脊上，下一带就更糙
    }
    return m * s / wsum;
  };
}
/** 起伏种子：meta.reliefSeed（缺键＝生成器种子，再缺＝1，即旧行为）；烘焙子图带母图的值过去＝同一套山系 */
export function reliefSeedOf(meta: { reliefSeed?: unknown; genSeed?: unknown } | undefined): number {
  const m = meta || {};
  return ((m.reliefSeed as number) | 0) || ((m.genSeed as number) | 0) || 1;
}
