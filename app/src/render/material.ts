/* 渲染材质表（纯观感，不入平价）：LANDFORM×ECO 25 复合 → 微起伏幅度 / 四类材质纹理权重 /
   反照率抖动 / 坡度岩化敏感度。GL（uniform 数组）与 CPU 兜底（直接调用）共用同一张表与同一个
   八度门控——两端观感同构的判据收在这里，别在渲染器里各写一份数值。
   ⚠ 另立一张表、不给 LANDFORM/ECO/terrainProps 加字段（它们是平价逐位比对对象，同 NODE_CATS 之例）。 */
import { CLIMATE, parseComposite, allComposites } from "../core/constants.ts";
import { elevUnitM } from "../core/elev.ts";
import { tget } from "../core/util.ts";
import { kmPerDeg } from "../core/geo.ts";
import { gridStepDeg } from "../core/grid.ts";
import type { Climate, Landform, Meta } from "../core/types.ts";

export interface Material {
  /** 四类材质纹理权重（只进光照法线，不进色阶/海岸判据）：林冠鼓包 / 沙丘波纹 / 山地棱脊 / 沼泽墩洼 */
  canopy: number; dune: number; ridge: number; marsh: number;
  /** 微起伏幅度（缩放自适应八度的振幅系数；接续宏观 fbm4 的更细起伏，世界锚定） */
  rough: number;
  /** 反照率抖动幅度（底色明暗微差，打破平色块） */
  albVar: number;
  /** 坡度岩化敏感度（陡坡掺岩色；沙丘/沼泽流沙软土不露岩=0） */
  rock: number;
}

/* 地貌基线：微起伏幅度对齐旧「高程带 rough」的量级（山 0.24 / 丘 0.08 档），观感承接不跳变 */
const LF_MAT: Record<Landform, Material> = {
  plain:    { canopy: 0, dune: 0, ridge: 0,    marsh: 0, rough: 0.05, albVar: 0.06, rock: 0.55 },
  coast:    { canopy: 0, dune: 0, ridge: 0,    marsh: 0, rough: 0.03, albVar: 0.05, rock: 0.25 },
  hill:     { canopy: 0, dune: 0, ridge: 0.12, marsh: 0, rough: 0.14, albVar: 0.04, rock: 0.85 },
  mountain: { canopy: 0, dune: 0, ridge: 0.4,  marsh: 0, rough: 0.24, albVar: 0.03, rock: 1.0 },   // 棱脊纹理降档：山系形自 2026-09 由连续基底与侵蚀给，屏幕锚定纹理只作补充
  alpine:   { canopy: 0, dune: 0, ridge: 0.4,  marsh: 0, rough: 0.28, albVar: 0.03, rock: 1.0 },
  water:    { canopy: 0, dune: 0, ridge: 0,    marsh: 0, rough: 0,    albVar: 0,    rock: 0 }
};

/** 森林的林冠纹理权重：林线淡出按「林冠权重 / 本值」认森林，改这里两处同变 */
export const FOREST_CANOPY = 0.85;

/** 复合串 → 材质（生态在地貌基线上修饰；水域基底一律全零——水下画不着地面质感，水面观感另在渲染器水分支） */
export function materialFor(cell: string): Material {
  const [lf, eco] = parseComposite(cell);
  const b = { ...LF_MAT[lf] };
  if (lf === "water") return b;
  if (eco === "forest") { b.canopy = FOREST_CANOPY; b.ridge *= 0.5; b.rough *= 0.6; b.albVar = 0.05; b.rock *= 0.5; }
  if (eco === "grassland") { b.albVar = 0.09; }
  if (eco === "marsh") { b.marsh = 0.75; b.ridge = 0; b.rough = 0.02; b.rock = 0; }
  if (eco === "desert") { b.dune = 0.8; b.ridge *= 0.4; b.rough = 0.05; b.albVar = 0.09; b.rock = 0; }   // albVar 抬档＝沙面明暗斑驳
  return b;
}

/** 全 30 复合的材质，顺序与 compositeIndex 对齐（GL 填 uniform 数组用） */
export function materialTable(): Material[] { return allComposites().map(materialFor); }

/** 雪的起始海拔（米）出厂值。雪线按真实米数经 elevUnitM 折算成抽象高程（渲染端 uSnowE）——
    旧色阶 0.82 抽象档起发白，在标定 900m 的战术图上≈740m 即成雪山（井陉秋季 38°N 战场实证之病）；
    按米定雪线后战术图自然无雪。设了气候档（meta.climate）改用档值，见 snowSpec。 */
export const SNOW_M = 2050;
/** 地球气候雪线随 |纬度| 的参考曲线（米，分段线性）：赤道约 4800、副热带干旱带隆到 5200、45° 约 2900（阿尔卑斯）、
    60° 约 1200（北欧）、极地贴海平面。只给图幅内的纬向梯度用，绝对值由气候档定；GL 由 snowLatGLSL() 生成同式。 */
export const SNOW_LAT_M: readonly (readonly [number, number])[] = [[0, 4800], [20, 5200], [30, 4600], [45, 2900], [60, 1200], [70, 600], [80, 200], [90, 0]];
export function snowLatM(absLat: number): number {
  const K = SNOW_LAT_M, n = K.length - 1;
  if (absLat <= K[0][0]) return K[0][1];
  for (let i = 0; i < n; i++) { const a = K[i], b = K[i + 1]; if (absLat <= b[0]) return a[1] + (absLat - a[0]) / (b[0] - a[0]) * (b[1] - a[1]); }
  return K[n][1];
}
/** SNOW_LAT_M 生成的 GLSL：`float snowLatM(float a)`，a＝|纬度|（度），返回米 */
export function snowLatGLSL(): string {
  const K = SNOW_LAT_M, n = K.length - 1, f = (x: number) => x.toFixed(1);
  let g = `float snowLatM(float a){
  if(a<=${f(K[0][0])}) return ${f(K[0][1])};
`;
  for (let i = 0; i < n; i++) {
    const a = K[i], b = K[i + 1];
    g += `  if(a<=${f(b[0])}) return mix(${f(a[1])},${f(b[1])},(a-${f(a[0])})/${f(b[0] - a[0])});
`;
  }
  return g + `  return ${f(K[n][1])};
}`;
}
/** 雪线参数（GL 与 CPU 同式：snow = max(0, base + (lat ? (snowLatM(|纬度|) − refM)/unitM : 0))）。
    base＝气候档雪线（缺键或档外＝出厂 SNOW_M）经 elevUnitM 折算；lat 只在球面图且设了气候档时开——
    平面图的纬度不是气候纬度，旧图缺键则逐位不变；refM＝参考曲线在图幅中心纬度的值（米）。 */
export interface SnowSpec { base: number; lat: boolean; refM: number; unitM: number }
export function snowSpec(meta: Meta | undefined): SnowSpec {
  const m = meta || {}, unitM = elevUnitM(meta), c = tget(CLIMATE, m.climate as string);
  const lat = !!c && m.worldModel !== "flat" && !!m.bbox;
  return { base: (c ? c.snowM : SNOW_M) / unitM, lat, refM: lat ? snowLatM(Math.abs((m.bbox!.latMin + m.bbox!.latMax) / 2)) : 0, unitM };
}
/** 图幅中心处的雪线抽象高程（snowSpec.base 的门面） */
export function snowEOf(meta: Meta | undefined): number { return snowSpec(meta).base; }

/* —— 气候配色与林线（缺键＝undefined＝两端都走旧路径，逐位不变）——
   色阶按米：滩带 <180 m → 低地 V₀ → 0.6·林线 V₁ → 林线 V₂ → 林线与雪线中点（高山草甸 A）→ 雪线（岩灰 R）→ 雪线 +700 m 近白；
   极地无林＝苔原 A 直接到 R；温带沿用 ELEV_RAMP。林线以上手涂森林的染色换成高山草甸色、林冠纹理淡出。 */
type RGB3 = readonly [number, number, number];
const CLIM_PAL: Record<Climate, { V?: readonly [RGB3, RGB3, RGB3]; A?: RGB3; R?: RGB3; meadow: RGB3 }> = {
  polar:       { A: [184, 180, 160], R: [196, 194, 190], meadow: [182, 178, 150] },
  boreal:      { V: [[96, 138, 100], [124, 146, 108], [146, 150, 116]], A: [170, 160, 128], R: [182, 178, 174], meadow: [170, 164, 120] },
  temperate:   { meadow: [174, 164, 106] },
  subtropical: { V: [[96, 164, 70], [146, 180, 88], [178, 168, 100]], A: [172, 142, 96], R: [184, 172, 164], meadow: [176, 164, 104] },
  tropical:    { V: [[64, 146, 64], [108, 164, 76], [150, 166, 92]], A: [172, 156, 104], R: [180, 172, 166], meadow: [172, 162, 104] },
  arid:        { V: [[226, 202, 150], [214, 180, 126], [196, 152, 104]], A: [176, 134, 96], R: [184, 168, 156], meadow: [184, 162, 116] }
};
/** 气候色阶最多段数（GL uniform 数组长度同此） */
export const CLIM_STOPS = 8;
const BEACH_M = 180, TREE_BAND_M = 150, TOP_M = 700;
/** 无林（极地）的林线抽象高程：远低于任何地面，又不能大到 +带宽后丢精度（smoothstep 两沿相等＝未定义） */
const NO_TREE_E = -100;
/** 气候观感：ramp＝[抽象高程, r, g, b(0..1)]×n，n=0＝沿用 ELEV_RAMP；treeE/band＝林线与淡出带宽（抽象）；meadow 为 0..255。
    球面图的纬度改正与雪线同式（snowSpec 的 lat/refM/unitM）：色阶按 e−Δ 取、林线按 treeE+Δ 判——两端都得这样读。 */
export interface ClimLook { n: number; ramp: Float32Array; treeE: number; band: number; meadow: RGB3; key: string }
export function climLook(meta: Meta | undefined): ClimLook | undefined {
  const m = meta || {}, c = tget(CLIMATE, m.climate as string);
  if (!c) return undefined;
  const p = CLIM_PAL[m.climate as Climate], U = elevUnitM(meta), S = c.snowM, T = c.treeM;
  const st: (readonly number[])[] = [];
  if (p.A && p.R) {
    st.push([BEACH_M, ...ELEV_RAMP[0].slice(1)]);
    if (T == null || !p.V) st.push([BEACH_M, ...p.A]);
    else st.push([BEACH_M, ...p.V[0]], [0.6 * T, ...p.V[1]], [T, ...p.V[2]], [(T + S) / 2, ...p.A]);
    st.push([S, ...p.R], [S + TOP_M, ...ELEV_RAMP[ELEV_RAMP.length - 1].slice(1)]);
  }
  const ramp = new Float32Array(CLIM_STOPS * 4);
  st.forEach((s, i) => { ramp[i * 4] = s[0] / U; ramp[i * 4 + 1] = s[1] / 255; ramp[i * 4 + 2] = s[2] / 255; ramp[i * 4 + 3] = s[3] / 255; });
  return { n: st.length, ramp, treeE: T == null ? NO_TREE_E : T / U, band: TREE_BAND_M / U, meadow: p.meadow, key: `${m.climate}:${U}` };
}
/** 气候色阶取色（CPU，0..255；GL 走 climRampGLSL 同式、读同一份 ramp）。dl＝纬度改正：滩带不移（按 e 判），其上按 e−dl 取且不落回滩带——
    否则宽纬跨球面图的低纬一侧（dl 可达 +0.7）整片低地被刷成滩色 */
export function climRampColor(L: ClimLook, e0: number, dl = 0): [number, number, number] {
  const r = L.ramp, n = L.n;
  if (e0 < r[0]) return [r[1] * 255, r[2] * 255, r[3] * 255];
  const e = Math.max(r[0], e0 - dl);
  for (let i = 0; i < n - 1; i++) {
    const a = i * 4, b = a + 4;
    if (e < r[b]) {
      if (!(r[b] > r[a])) return [r[b + 1] * 255, r[b + 2] * 255, r[b + 3] * 255];
      const t = (e - r[a]) / (r[b] - r[a]);
      return [(r[a + 1] + (r[b + 1] - r[a + 1]) * t) * 255, (r[a + 2] + (r[b + 2] - r[a + 2]) * t) * 255, (r[a + 3] + (r[b + 3] - r[a + 3]) * t) * 255];
    }
  }
  const z = (n - 1) * 4;
  return [r[z + 1] * 255, r[z + 2] * 255, r[z + 3] * 255];
}
/** climRampColor 的 GLSL 同式：`vec3 climRamp(float e0, float dl)`（uClimRamp / uClimN），返回 0..1 色 */
export function climRampGLSL(): string {
  return `vec3 climRamp(float e0,float dl){
  if(e0<uClimRamp[0].x) return uClimRamp[0].yzw;
  float e=max(uClimRamp[0].x, e0-dl);
  for(int i=0;i<${CLIM_STOPS - 1};i++){
    if(i+1>=uClimN) break;
    vec4 a=uClimRamp[i], b=uClimRamp[i+1];
    if(e<b.x) return b.x>a.x ? mix(a.yzw,b.yzw,(e-a.x)/(b.x-a.x)) : b.yzw;
  }
  return uClimRamp[uClimN-1].yzw;
}`;
}

/* —— 陆地分层设色（抽象高程 → RGB 0..255）——
   段内线性；相邻两档同高程＝一道色阶台阶（滩带→绿）。GL 由 rampGLSL() 生成同式的着色器函数、
   CPU 兜底走 rampColor()：改分界只动这张表。水段不在此表（渲染器按水面深度另算）。
   转折按 2026-09-02 真实地区对照标定（绿转褐曾早 200 m、褐转灰早 900 m、顶端只到 206 灰）：
   出厂 elevUnitM 2000 下 0.09＝180 m 滩带、0.40＝800 m 绿顶、0.75＝1500 m、1.25＝2500 m 褐顶、1.80＝3600 m 近白。 */
export const ELEV_RAMP: readonly (readonly [number, number, number, number])[] = [
  [0.09, 214, 205, 168],   // 滩带 <180 m（其下恒此色；压灰半档——原 224,216,172 在整幅下发白光）
  [0.09, 132, 174, 98],    // 绿 180→800 m
  [0.40, 170, 172, 110],
  [0.40, 170, 166, 110],   // 黄褐 800→1500 m（同高程两档＝旧表留下的一道浅台阶，随色保留）
  [0.75, 178, 154, 106],
  [0.75, 178, 152, 118],   // 褐 1500→2500 m
  [1.25, 150, 128, 96],
  [1.50, 183, 172, 168],   // 岩灰 3000 m
  [1.80, 240, 239, 240]    // 近白 3600 m 顶满（原 3200 m 只到 206 灰＝四千米级读不出高）
];
/** 陆地色阶取色（CPU 兜底；GL 走 rampGLSL 生成的同式函数） */
export function rampColor(e: number): [number, number, number] {
  const R = ELEV_RAMP, n = R.length - 1;
  if (e < R[0][0]) return [R[0][1], R[0][2], R[0][3]];
  for (let i = 0; i < n; i++) {
    const a = R[i], b = R[i + 1];
    if (e < b[0]) { const t = (e - a[0]) / (b[0] - a[0]); return [a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2]), a[3] + t * (b[3] - a[3])]; }
  }
  return [R[n][1], R[n][2], R[n][3]];
}
/** ELEV_RAMP 生成的 GLSL：`vec3 elevLand(float e)`，返回 0..1 色 */
export function rampGLSL(): string {
  const R = ELEV_RAMP, n = R.length - 1;
  const v = (s: readonly number[]) => `vec3(${s[1]}.0,${s[2]}.0,${s[3]}.0)`;
  const f = (x: number) => x.toFixed(6);
  let g = `vec3 elevLand(float e){
  if(e<${f(R[0][0])}) return ${v(R[0])}/255.0;
`;
  for (let i = 0; i < n; i++) {
    const a = R[i], b = R[i + 1];
    if (b[0] === a[0]) continue;   // 同高程两档＝台阶，不成段
    g += `  if(e<${f(b[0])}){ float t=(e-${f(a[0])})/${f(b[0] - a[0])}; return mix(${v(a)},${v(b)},t)/255.0; }
`;
  }
  return g + `  return ${v(R[n])}/255.0;
}`;
}

/** 纸色：图廓外的纸与出图垫纸（GLSL 与 tokens.css 的 canvas-wrap 底色各留一份同值字面量） */
export const PAPER = "#d9d2c0";

/** 地形画布的纸模式：画布上图幅外铺纸色、开小水塘（战术图恒开，战略图看 meta.outside＝内陆图声明）。
    屏上看得见的图廓外纸由叠加层一律铺上（overlay 的 drawMargin），与本判据无关。 */
export function paperOf(meta: Meta | undefined): boolean {
  const m = meta || {};
  return m.mapKind === "tactical" || m.outside === "land";
}

/* —— 晕渲夸张：显示坡度 = E × 真实坡度，E = 格边档 × 缩放档。
   格边档 exagCell(格边 km)：战术 100 m 格 16 倍、战略 6.67 km 格 96 倍，对数插值、封顶 exagMax——格越粗，
   图上一格代表的真实坡越缓，要同样读得出山，夸张就得越大（小比例尺制图的常规）；4 倍对 6.67 km 格
   是纯分层设色（用户实报「地形层次完全没有了」）。
   缩放档 zoomK：一格在屏上 ≥ zoomPxHi 像素（放大看细节）×1，≤ zoomPxLo 像素（整幅）× zoomKLo，对数插值。
   ⚠ 用户拍板的「8 或 4」是在软膝 bug（膝下微坡一律拉到膝点）之下看的图；bug 修掉后 8 倍偏淡（用户实报
   「不如之前」），锚点按 ×2 取，再由本机偏好「地形立体感」乘 0.5～2 供用户自调。
   ⚠ 格边取 gridStepDeg(meta)＝地形粗格，不取细分场格：精修落地不许换夸张。
   ⚠ 旧式法线 nrm=4.5·uPXPD/14 的量纲是「每(抽象/度)」，在战术图上等于 64 倍夸张、且不随比例尺变——
   增益必须由三个 render 调用点按 shadeGain 传入。 —— */
export const NRM0 = 4.5 / 14;
export function exagFor(cellKm: number, kmPerPx: number): number {
  const p = Math.log(FX.exagE1 / FX.exagE0) / Math.log(FX.exagCellKm1 / FX.exagCellKm0);
  const eCell = Math.max(FX.exagE0, Math.min(FX.exagMax, FX.exagE0 * Math.pow(Math.max(1e-9, cellKm) / FX.exagCellKm0, p)));
  const pxPerCell = cellKm / Math.max(1e-9, kmPerPx);
  const t = Math.max(0, Math.min(1, (Math.log(Math.max(1e-9, pxPerCell)) - Math.log(FX.zoomPxLo)) / (Math.log(FX.zoomPxHi) - Math.log(FX.zoomPxLo))));
  return eCell * (FX.zoomKLo + (1 - FX.zoomKLo) * t);
}
/** 渲染器法线增益：旧式每度法线（细节路 2·NRM0 + 宏观路 ×macroW）换算成 E 倍真实坡度 */
export function shadeGain(meta: Meta | undefined, degPerPx: number): number {
  const kmd = kmPerDeg(meta), U = elevUnitM(meta);
  return exagFor(gridStepDeg(meta) * kmd, degPerPx * kmd) * U / (2 * NRM0 * (1 + FX.macroW) * kmd * 1000);
}

/** 微八度基频（1/度）：接续宏观 fbm4 频谱（1.1×2³=8.8/度）的下一档 */
export const MICRO_F0 = 17.6;
/** 微八度档数上限（世界锚定 ×2 阶梯；fp32 下噪声坐标以图幅原点为局部原点，12 档内不失谐） */
export const MICRO_OCTAVES = 12;

/** 八度门控：该八度的屏幕波长（px/度 ÷ 频率）自 3px 起淡入、8px 全强。
    战略图整幅视角（≈33px/度）下所有新增细节恒为 0——旧缩放档观感保持的判据就是这一个函数。 */
export function octaveGate(pxPerDeg: number, freq: number): number {
  const t = Math.max(0, Math.min(1, (pxPerDeg / freq - 3) / 5));
  return t * t * (3 - 2 * t);
}

/** 渲染两端共用的观感系数（GL 经着色器模板注入、CPU 兜底直接引用）。
    ⚠ 单一真源：两端各写一份数值＝观感分家的温床；调参只动这里。
    *Px=屏幕锚定波长（像素）；*Amp=纹理进法线的幅度；micro*=世界锚定微八度。 */
export const FX = {
  exagCellKm0: 0.1, exagE0: 16,                // 格边档锚点一：战术 100 m 格 → 16 倍（见 exagFor 头注）
  exagCellKm1: 20 / 3, exagE1: 96,             // 格边档锚点二：战略 6.67 km 格 → 96 倍
  exagMax: 128,                                // 全球级粗格（22 km）封顶
  zoomPxLo: 0.5, zoomPxHi: 5, zoomKLo: 0.5,    // 缩放档：一格 ≤0.5 px ×0.5、≥5 px ×1
  rockSlopeLo: 1.2, rockSlopeHi: 3.0,          // 坡度岩化的显示 tan 区间（8 倍下真实 8.5°～20° 起露岩）
  snowSlopeLo: 1.5, snowSlopeHi: 3.5,          // 陡坡挂不住雪的显示 tan 区间
  microAmp: 0.34,   // 微八度总幅（×材质 rough）——过大即「抓挠感」
  microPers: 0.42,  // 微八度持续度（<0.5=高频档法线贡献递减）
  warpF: 0.77,      // 域扭曲主频（1/格）；副频 ×3.1、幅 ×0.35
  warpAmp: 0.7,     // 域扭曲总幅（×格距；主+副合成后 <半格）
  canopyPx: 30, canopyAmp: 2.0,   // 林冠鼓包（2026-09-02 起软鼓包：阈值化值噪声是迷宫蠕虫纹，夸张降到 4～8 倍后一眼可辨）
  dunePx: 26,   duneAmp: 2.0,     // 沙丘波纹（纵向拉伸 0.3）
  ridgePx: 52,  ridgeAmp: 5.5,    // 山地棱脊（主脉 ×0.36 波长调制支脉）
  marshPx: 34,  marshAmp: 1.0,    // 沼泽墩洼
  texW: 2.0,        // 屏幕锚定纹理 → 法线幅度的折算分子（÷像素密度＝明暗对比不随缩放）
  /* 陡坡增纹已删（2026-09-02）：它是给 64 倍夸张下「宏观坡 90/度 vs 纹理 0.3」补的 ×7 幅度；夸张
     降到 4～8 倍后宏观坡本就在线性区，再乘 7 倍就是战略图满屏蠕虫纹（用户实报）。纹理自此只按
     基础幅度随 gain 走，是补充不是主体。 */
  /* 纹理疏密（2026-08-19，用户实报「一大片都是规律的细密的纹理，观感不好」）：材质纹理按**屏幕**
     波长锚定（明暗对比不随缩放变的既有契约），代价是无论放多大都是同一个像素尺度的均匀颗粒——
     一整片林/沼/山全是一个密度。加一层**世界锚定**的低频调制，让同一片有疏有密。
     ⚠ 只调幅度不调频率：调频率会让林冠在缩放里「呼吸」。⚠ 两个八度：单一频率的值噪声本身
     也是规律的，拿它当调制等于换一个规律花样。⚠ 均值居中（(Lo+Hi)/2≈1）＝整体纹理量不变，
     动的只是分布。GL 的四点采样共用中心 texW，故调制不会给法线添假坡；CPU 逐像素算（同构不逐位）。 */
  texPatchF: 0.05,                    // 调制主频（1/格 ⇒ λ≈20 格；副频 ×2.7、权 0.35）
  texPatchLo: 0.3, texPatchHi: 1.3,   /* 最疏 / 最密处的纹理幅度倍率。⚠ 量程必须下探到膝点以下才看得见：
     实测响应在 0.5~0.6 倍处有个膝——0.6~1.4 那档（±40%）全图平均亮度只差 0.10＝肉眼零变化（法线归一化
     ＋陡坡软压把大幅度一起压平，同批5「光滑其实是 dot 饱和剪裁」之训）；0.3~1.3 才有 15.8 的差。
     ⚠ 与「均匀降幅到 0.8」实拍相差 10.4（接近有无纹理的量级）＝疏密确实带来了均匀降幅给不了的东西。 */
  albPx: 44,    albAmp: 2.0,      // 反照率抖动（×材质 albVar）
  wavePx: 38,   waveAmp: 0.07,    // 水面静态波纹
  shoreMix: 0.28,   // 近岸浅水带混入
  rockMix: 0.55,    // 坡度岩化最大混入
  /* 谷影（2026-09-02 改按真实坡度）：帐篷差是「半格距上的高差」，格越大差越大——6.67 km 战略格上
     类型台阶的帐篷差 0.17 × 6 恒饱和，夸张降到 4 倍后它成了画面里唯一的强项＝满屏蠕虫纹。
     现按 (帐篷差 ÷ 场格边) × 增益 × 2·NRM0·(1+macroW) 折成「E 倍真实坡度」再乘此系数；0.019 使
     战术 8 倍下与旧 6.0 同量（50 m 细格），战略 4 倍下自然近零。 */
  cavAmp: 0.019,
  /* —— 2026-08 光照与色彩批 —— */
  /* 背光底 0.50→0.62（2026-09-02）：晕渲的背光面按制图惯例不低于六成亮，0.50 叠上冷调、谷影与
     烘焙投影三层后山体阴面近黑＝读成一团暗物而不是山（实拍）。 */
  shadeLo: 0.62, shadeHi: 1.22,   // 光照响应两端（旧 0.6+0.75·d 最亮:最暗仅 2.2:1＝整图挤中灰）
  shadeKnee: -0.55,               // 响应软肩（smoothstep 下界；上界恒 1.0）
  cool: [0.83, 0.88, 1.03], warm: [1.05, 1.0, 0.92],   // 暖冷晕渲（Imhof：受光面暖、背光面冷紫）
  macroW: 0.8,      // 宏观场法线权重（±1 格、无噪声的地貌坡再计一份——压低噪声皱纹在光照里的话语权）
  snowBand: 0.22,   // 雪线过渡带宽（抽象高程；起点见 SNOW_M/snowEOf）
  /* 空气透视（Imhof）：高处清冷明亮、低处厚重——山体的「宏伟」有一半来自这条纵深线索，
     不是来自更强的明暗。按抽象高程渐入，只动地表色不动光照。 */
  airLo: 0.45, airHi: 1.50, airMix: 0.20, airC: [0.88, 0.91, 0.98],
  warp2F: 0.16, warp2Amp: 1.7,    // 长波扭曲（λ≈6 格、幅≈±0.85 格）——只喂色调/材质查找，把多格
                                  //   涂改色块的直边揉出有机走向；有意超半格（warpOf 守半格是为晕渲高程）
  /* 边缘碎化（2026-08-08）：长波扭曲只能把长直边推成缓弯，跨十几格的涂改边界照旧一眼是直的
     （井陉中景成片矩形色块实拍）。补一档高频小幅（λ≈1.1 格、幅≈±0.23 格）打碎边缘读感——
     幅度有意远小于长波：色调若跑离地貌太远，山脊上会出现不属于它的地类色 */
  warp3F: 0.9, warp3Amp: 0.45,
  shoreLo: 2.5, shoreHi: 7,       // 近岸浅水带渐显区间（px/格）：一格不到两三像素时归零——按 px/° 判在战术图上恒开（0.54° 图整幅已 2000 px/°）
  shadowK: 0.25,     // 烘焙遮蔽（erode 定向天光通道）压暗上限——背光谷底连同暖冷响应一起走 lt（0.42 与新背光底叠成近黑）
  /* 坡度补材质（|∇e|/度 → 糙度/棱脊权重）：手雕的高山常落在平原/草原类型上，材质只认类型
     就还是草地质感的光滑圆包（河洛实证）——山的质感跟着坡走，与类型取大 */
  slopeRough: 0.013, slopeRoughMax: 0.24,   // 山地档 rough=0.24；坡 18/度 拉满
  slopeRidge: 0.022,                         // 坡 18/度 → 棱脊权重 0.4（与山地档表值同上限；1.0 时战略图类型缓坡也满屏棱脊蠕虫）
  /* 陡坡软压（光照响应用的总坡度：膝点内原样，超出部分渐近压缩到 +slopeSoft）：夸张 ≤8 倍后
     只有真实 27° 以上（8 倍）/45° 以上（4 倍）才进压缩区，山坡的明暗层次留在线性段。
     ⚠ 2026-09-02 修正：原实现 `slc = knee + 压缩(超出)` 在膝点以下不是恒等而是把任何微坡拉长到
     膝点——几米的起伏也按 54°（旧膝 1.4）显示，这是「平原褶皱」「几米高差也显示」的元凶；
     现 `min(sl, knee) + …`。 */
  slopeKnee: 4.0, slopeSoft: 2.0,
  /* 等高线亮晕（2026-09-20）：夸张晕渲把背光坡压到亮度 ≈0.3，与棕线（0.285）同亮＝线在暗坡上消失
     （琉森陡坡视角实拍两成陆地像素亮度 <0.35）。线色不变，只在核外加 haloPx 宽的浅沙色环，按底色亮度
     haloLo..haloHi 渐隐——核与环的内部反差不随底色变，亮处环自动归零＝旧观感。 */
  haloC: [0.925, 0.84, 0.69], haloPx: 1.0, haloLo: 0.32, haloHi: 0.50,
  /* 装饰高程噪声跟坡走（2026-08-08 批7 下半，见 decoGate）：fbm4 宏观档与微八度不进读数/等高线
     却进晕渲法线，在平坦低地画出 ±15~35m 的假起伏——「读数只差几米、图上褶皱十几米/几十米、
     零高差处也有褶皱」（用户真机实证）。坡门=宏观坡 smac 渐入（平原内部平地 p50 0.1~0.4、
     真坡 4.5 起，实测三图）；rough 门=丘(0.14)/山(0.24) 类型兜底恒 1＝已验收的山地观感不动 */
  decoSlopeLo: 1.5, decoSlopeHi: 4.0,
  decoRoughLo: 0.06, decoRoughHi: 0.12,
  /* —— 生态辨识度（2026-08-09，用户点单「荒漠更像沙漠、沼泽要浅水滩和泥泞」）——
     键＝材质签名权重（dune 只随荒漠、marsh 只随沼泽，tw 现成，不另立字段）；只动地表色，
     不进色阶/海岸/等高线判据；水洼静态无动画（空闲降频之约）。定调项不随缩放＝战略图同样一眼可辨；
     水洼/湿泥按 px/° 渐显（整幅视角斑点读不出、徒增噪）。 */
  sandMix: 0.42, sandC: [0.855, 0.745, 0.52],    // 荒漠暖沙定调
  marshMix: 0.30, marshC: [0.44, 0.54, 0.47],    // 沼泽湿绿定调（比 tint 更沉的水草绿）
  poolLo: 2, poolHi: 7,                           // 水洼随 px/格 渐显区间（同 shoreLo/Hi 之规：战略 6.67 km 格整幅 2 px 即归零）
  poolF: 0.4,                                     // 水洼斑块频率（周期/格＝格锚定；0.8 时屏上 ~8px 斑点=细碎噪点而非浅水滩，放宽成 ~2.5 格的塘）
  poolMix: 0.62, poolC: [0.36, 0.50, 0.50],       // 积水色（青灰，近岸带同族更沉）
  mudMix: 0.30, mudC: [0.40, 0.37, 0.29]          // 洼间湿泥压暗
} as const;

const sstep01 = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** 装饰噪声门（CPU 兜底直接调用；GL 经着色器模板注入同一组 FX 常数，两端同式）。
    细分场（侵蚀）的陆地上，装饰按「真坡或粗糙类型」渐入；水域(land=0)与粗格场(fine=0)恒 1
    ＝旧图/水面观感逐位。land/fine 取 [0,1]（land 由调用方按数据面高程 smoothstep 出连续过渡——
    硬分支会在岸线处给 e 造出阶跃，fwidth 海岸带即出毛边）。 */
export function decoGate(smac: number, matRough: number, land: number, fine: number): number {
  const dk = Math.max(sstep01(FX.decoSlopeLo, FX.decoSlopeHi, smac), sstep01(FX.decoRoughLo, FX.decoRoughHi, matRough));
  return 1 + (dk - 1) * land * fine;
}
