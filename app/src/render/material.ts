/* 渲染材质表（纯观感，不入平价）：LANDFORM×ECO 25 复合 → 微起伏幅度 / 四类材质纹理权重 /
   反照率抖动 / 坡度岩化敏感度。GL（uniform 数组）与 CPU 兜底（直接调用）共用同一张表与同一个
   八度门控——两端观感同构的判据收在这里，别在渲染器里各写一份数值。
   ⚠ 另立一张表、不给 LANDFORM/ECO/terrainProps 加字段（它们是平价逐位比对对象，同 NODE_CATS 之例）。 */
import { CLIMATE, SNOW_LAT_M, WATER_EPS, parseComposite, allComposites, snowLatM } from "../core/constants.ts";
import { elevUnitM, SUP_DASH_PX, SUP_HI_PX, SUP_LO_PX } from "../core/elev.ts";
import { tget } from "../core/util.ts";
import { hash2, vnoise } from "../core/noise.ts";
import { kmPerDeg } from "../core/geo.ts";
import { gridStepDeg } from "../core/grid.ts";
import type { Climate, Landform, Meta } from "../core/types.ts";

/** 光源方向（指向太阳，东 / 北 / 天顶三分量，未归一）：晕渲唯一的光向，西北光是制图惯例 */
const SUN = { east: -0.6, north: 0.6, up: 0.9 } as const;
/** 晕渲光向量（单位长）：两个渲染器的法线 y 取北减南＝y 轴朝南，故 SUN 的北分量取负 */
export const SHADE_LIGHT: readonly [number, number, number] = (() => {
  const v = [SUN.east, -SUN.north, SUN.up], l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

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
  if (eco === "salt") { b.ridge = 0; b.rough = 0.01; b.albVar = 0.03; b.rock = 0; }   // 盐壳：平而亮，几乎没有纹理
  return b;
}

/** 全部复合（地貌 × 生态）的材质，顺序与 compositeIndex 对齐（GL 填 uniform 数组用） */
export function materialTable(): Material[] { return allComposites().map(materialFor); }

/** 雪的起始海拔（米）出厂值。雪线按真实米数经 elevUnitM 折算成抽象高程（渲染端 uSnowE）——
    旧色阶 0.82 抽象档起发白，在标定 900m 的战术图上≈740m 即成雪山（井陉秋季 38°N 战场实证之病）；
    按米定雪线后战术图自然无雪。设了气候档（meta.climate）改用档值，见 snowSpec。 */
export const SNOW_M = 2050;
/** 雪线曲线的真源在 core/constants（生成器的峰顶软上限同读），这里转出给渲染端；GL 由 snowLatGLSL() 生成同式 */
export { SNOW_LAT_M, snowLatM };
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
   色阶按米：海平面低地（lowOf）→ 180 m V₀ → 0.6·林线 V₁ → 林线 V₂ → 林线与雪线中点（高山草甸 A）→ 雪线（岩灰 R）→ 雪线 +700 m 近白；
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
const LOWLAND_M = 180, TREE_BAND_M = 150, TOP_M = 700;
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
    const v0 = T == null || !p.V ? p.A : p.V[0];   // 180 m 处的颜色
    st.push([0, ...lowOf(v0)], [LOWLAND_M, ...v0]);
    if (T != null && p.V) st.push([0.6 * T, ...p.V[1]], [T, ...p.V[2]], [(T + S) / 2, ...p.A]);
    st.push([S, ...p.R], [S + TOP_M, ...ELEV_RAMP[ELEV_RAMP.length - 1].slice(1)]);
  }
  const ramp = new Float32Array(CLIM_STOPS * 4);
  st.forEach((s, i) => { ramp[i * 4] = s[0] / U; ramp[i * 4 + 1] = s[1] / 255; ramp[i * 4 + 2] = s[2] / 255; ramp[i * 4 + 3] = s[3] / 255; });
  return { n: st.length, ramp, treeE: T == null ? NO_TREE_E : T / U, band: TREE_BAND_M / U, meadow: p.meadow, key: `${m.climate}:${U}` };
}
/** 气候色阶取色（CPU，0..255；GL 走 climRampGLSL 同式、读同一份 ramp）。dl＝纬度改正：首档以下不移（按 e 判），其上按 e−dl 取且不落回首档以下 */
export function climRampColor(L: Pick<ClimLook, "n" | "ramp">, e0: number, dl = 0): [number, number, number] {
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
   段内线性；相邻两档同高程＝一道色阶台阶。GL 由 rampGLSL() 生成同式的着色器函数、
   CPU 兜底走 rampColor()：改分界只动这张表。水段不在此表（渲染器按水面深度另算）。
   转折按 2026-09-02 真实地区对照标定（绿转褐曾早 200 m、褐转灰早 900 m、顶端只到 206 灰）：
   出厂 elevUnitM 2000 下 0.09＝180 m（其下由 LOW_RAMP 接到海平面色）、0.40＝800 m 绿顶、0.75＝1500 m、1.25＝2500 m 褐顶、1.80＝3600 m 近白。 */
export const ELEV_RAMP: readonly (readonly [number, number, number, number])[] = [
  [0.09, 132, 168, 122],   // 绿 180→800 m
  [0.40, 170, 172, 110],
  [0.40, 170, 166, 110],   // 黄褐 800→1500 m（同高程两档＝旧表留下的一道浅台阶，随色保留）
  [0.75, 178, 154, 106],
  [0.75, 178, 152, 118],   // 褐 1500→2500 m
  [1.25, 150, 128, 96],
  [1.50, 183, 172, 168],   // 岩灰 3000 m
  [1.80, 240, 239, 240]    // 近白 3600 m 顶满（原 3200 m 只到 206 灰＝四千米级读不出高）
];
/** 滩带只在战术图画（TerrainRenderOpts.beach）：水边一条浅色带，份额见 beachK。按高程画（<180 m 一律滩色）＝低地战场整片沙色 */
export function beachOf(meta: Meta | undefined): boolean { return (meta || {}).mapKind === "tactical"; }
/** 低地：由 180 m 处的颜色推出海平面的颜色，0→180 m 线性接上＝无台阶；出厂色阶与各气候色阶同用 */
function lowOf(c: readonly number[]): [number, number, number] {
  const k = LOW_K[0], ch = (i: number): number => Math.round(c[i] * k + LOW_K[i + 1] * (1 - k));
  return [ch(0), ch(1), ch(2)];
}
/** [保留比例, 掺入色 r, g, b]：海平面色＝180 m 色 × 保留比例 + 掺入色 × 其余。
    掺一半浅灰绿＝越低越浅，海岸一带留一点亮度但不是沙色（作者从三候选中挑定） */
const LOW_K = [0.5, 206, 206, 176] as const;
/** 陆地色阶：ELEV_RAMP 前面补海平面一档 */
const LOW_RAMP: readonly (readonly [number, number, number, number])[] = [[0, ...lowOf(ELEV_RAMP[0].slice(1))], ...ELEV_RAMP];
/** 陆地色阶取色（CPU 兜底；GL 走 rampGLSL 生成的同式函数） */
export function rampColor(e: number): [number, number, number] {
  const R = LOW_RAMP, n = R.length - 1;
  if (e < R[0][0]) return [R[0][1], R[0][2], R[0][3]];
  for (let i = 0; i < n; i++) {
    const a = R[i], b = R[i + 1];
    if (e < b[0]) { const t = (e - a[0]) / (b[0] - a[0]); return [a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2]), a[3] + t * (b[3] - a[3])]; }
  }
  return [R[n][1], R[n][2], R[n][3]];
}
/** rampColor 的 GLSL：`vec3 elevLand(float e)`，返回 0..1 色 */
export function rampGLSL(): string {
  const v = (s: readonly number[]) => `vec3(${s[1]}.0,${s[2]}.0,${s[3]}.0)`;
  const f = (x: number) => x.toFixed(6);
  const fn = (name: string, R: typeof ELEV_RAMP): string => {
    const n = R.length - 1;
    let g = `vec3 ${name}(float e){
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
  };
  return fn("elevLand", LOW_RAMP);
}

/** 纸色：图廓外的纸与出图垫纸（tokens.css 的 canvas-wrap 底色另留一份同值字面量） */
export const PAPER = "#d9d2c0";
/** 纸色的 0–255 三分量：地形画布上的图幅外（GL 着色器与 CPU 推演底图） */
export const PAPER_RGB: readonly number[] = [1, 3, 5].map(i => parseInt(PAPER.slice(i, i + 2), 16));

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
   「不如之前」），锚点按 ×2 取，再由本机偏好「山影深浅」乘 0.5～2 供用户自调。
   ⚠ 格边取 gridStepDeg(meta)＝地形粗格，不取细分场格：精修落地不许换夸张。
   ⚠ 旧式法线 nrm=4.5·uPXPD/14 的量纲是「每(抽象/度)」，在战术图上等于 64 倍夸张、且不随比例尺变——
   增益必须由三个 render 调用点按 shadeGain 传入。 —— */
/** 旧式法线的两个数：nrm＝NRM_K·(px/度 ÷ NRM_PX)·增益（两端同式），NRM0＝NRM_K / NRM_PX */
export const NRM_K = 4.5, NRM_PX = 14;
export const NRM0 = NRM_K / NRM_PX;
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

/** 八度门控的屏幕波长两沿（像素）：自 [0] 起淡入、[1] 全强（GL gate() 同读） */
export const OCT_GATE_PX = [3, 8] as const;
/** 八度门控：该八度的屏幕波长（px/度 ÷ 频率）自 3px 起淡入、8px 全强。
    战略图整幅视角（≈33px/度）下所有新增细节恒为 0——旧缩放档观感保持的判据就是这一个函数。 */
export function octaveGate(pxPerDeg: number, freq: number): number {
  const t = Math.max(0, Math.min(1, (pxPerDeg / freq - OCT_GATE_PX[0]) / (OCT_GATE_PX[1] - OCT_GATE_PX[0])));
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
  albRot: [0.61, -1.03],          // 反照率两档梯度噪声各转一角：值噪声的格点平台沿屏幕轴排成方格（草地与荒漠满屏棋盘）
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
  /* 滩带：带宽上限海 beachW 格、内陆湖 beachLakeW 格（render/beach 的离水场按它算），外沿 beachFade 格淡出；
     高出那片水的水面 beachHi0 以内满、到 beachHi1（180 m）淡尽，沉在水面以下 beachLo0 起淡、到 beachLo1 淡尽（抽象高程） */
  beachC: [0.839, 0.804, 0.659], beachW: 8.5, beachLakeW: 3, beachFade: 1.5, beachHi0: 0.082, beachHi1: 0.09, beachLo0: -0.02, beachLo1: -0.05,
  marshMix: 0.30, marshC: [0.44, 0.54, 0.47],    // 沼泽湿绿定调（比 tint 更沉的水草绿）
  poolLo: 2, poolHi: 7,                           // 水洼随 px/格 渐显区间（同 shoreLo/Hi 之规：战略 6.67 km 格整幅 2 px 即归零）
  poolF: 0.4,                                     // 水洼斑块频率（周期/格＝格锚定；0.8 时屏上 ~8px 斑点=细碎噪点而非浅水滩，放宽成 ~2.5 格的塘）
  poolRot: [0.5, -0.85], poolK: 1.06,             // 两八度梯度噪声各转一角（值噪声的塘沿格线连成方块）；K＝与旧式同覆盖率（水洼 22%、湿泥 30%）
  marshSlopeLo: 2, marshSlopeHi: 3,               // 沼泽按宏观坡淡出（度）：湿地只在缓坡，坡上不画湿绿、水洼与墩洼；规则照旧算沼泽
  poolMix: 0.62, poolC: [0.36, 0.50, 0.50],       // 积水色（青灰，近岸带同族更沉）
  mudMix: 0.30, mudC: [0.40, 0.37, 0.29],         // 洼间湿泥压暗
  wMin: 0.003,                                    // 材质与生态权重的门：不过门的那一段整段跳过
  tintMix: 0.45,                                  // 生态色调混入（× 四角色调权重和）
  cavLo: -0.10, cavHi: 0.16,                      // 谷影的上下限（负＝脊上提亮）
  rockC: [0.36, 0.33, 0.30], rockSpan: [0.26, 0.27, 0.27], rockK: 1.1,   // 岩色＝rockC + rockSpan·clamp(e·rockK)：越高越浅
  snowC: [0.93, 0.94, 0.965], snowSlopeCut: 0.6,  // 雪色；陡坡挂不住雪：坡满时雪盖扣掉这一份
  luma: [0.299, 0.587, 0.114],                    // 亮度权：等高线亮晕按底色亮度渐隐
  macroNrm: 0.3214,                               // 宏观坡的法线系数＝细节法线对基础坡度响应之半（取 NRM0 的四位近似，换成 NRM0 会改像素）
  fbmE: [0.4, 0.2], fbmRough: [0.24, 0.08, 0.025], fbmEroded: 0.25, fbmF: 1.1   // 宏观 fbm4：高程过 fbmE[0] / [1] 取对应幅度、其余取末项，侵蚀场再乘 fbmEroded；频率按 1/度
} as const;

/** GLSL 浮点字面量：整数补「.0」，其余取最短往返写法——解析回同一个 double，舍入成 float32 与手写的字面量同值 */
export function glslF(x: number): string { return Number.isInteger(x) ? x.toFixed(1) : String(x); }

/** 观感噪声的取样常数（两端逐处同式：GL 经 glslF 注入、CPU 直接引用）：o＝各噪声的种子偏移 [x, y]，即同一噪声场里互不相关的取样窗；
    f2 / w＝第二档的频率比与两档权重，sx＝横向拉伸。改任何一个数都是换一套花样，两端必须一起换 */
export const NOISE = {
  tau: 6.2831853,   // 梯度噪声：格点哈希 × tau＝梯度方向角
  ridgeK: 1.9,      // 梯度噪声 → 脊形：1 − min(1, |n|·ridgeK)
  warp: { f2: 3.1, a2: 0.35, o: [[13.7, 91.2], [57.1, 33.9], [7.3, 44.9], [99.1, 5.7]] },   // 域扭曲：主频 x、y，副频 x、y（副频 ×f2、幅 ×a2）
  warp2: [[3.9, 71.3], [41.7, 9.1]],     // 长波扭曲 x、y
  warp3: [[17.1, 53.7], [88.3, 25.9]],   // 边缘碎化 x、y
  micro: { rot: [0.7986, 0.6018], k: [19.7, 7.9] },   // 微八度：逐档旋转 37° 的 cos、sin；第 k 档偏移 k·(x, y)
  canopy: [[7.7, 3.1], [3.3, 8.9]],      // 林冠：lod 两档
  dune: { sx: 0.3, o: [[11.1, 0.7], [0.9, 17.3]] },
  ridge: { main: 0.36, mix: [0.55, 0.45], o: [[77.7, 13.9], [23.1, 9.3], [5.3, 31.7]] },   // 棱脊：主脉频率 ×main；主脉²、主脉×支脉的权；主脉、支脉两档
  marsh: [[41.3, 2.9], [3.7, 55.1]],
  patch: { f2: 2.7, w: [0.65, 0.35], edge: [0.32, 0.68], o: [[19.3, 5.7], [63.1, 28.9]] },   // 纹理疏密调制：两八度、smoothstep 两沿
  pool: { f2: 2.7, w: [0.65, 0.35], edge: [0.40, 0.58, 0.68], o: [[7.3, 3.9], [51.3, 17.9]] },   // 水洼：湿泥自 edge[0] 到 [1]、积水自 [1] 到 [2]
  alb: [[19.9, 7.1], [2.3, 27.9]],       // 反照率两档
  wave: { sx: 0.35, o: [[3.1, 9.7], [21.3, 1.1]] }   // 水面静态波纹
} as const;

/** 等高线着墨（两端同式）：带宽＝到等值面像素距的 smoothstep 两沿；crowd＝线距（像素）的挤线门；index＝计曲线每第几条；dash＝间曲线 / 助曲线虚线空段的半宽（周期分数）；
    ink＝首 / 计 / 间 / 助曲线的墨；color＝线色 0–255；gcPx＝间曲线浮现门那个粗坡的差分半距（CSS 像素，CPU 补画外缘按它留） */
export const CONTOUR = {
  minorW: [0.8, 1.5], indexW: [0.9, 1.65], crowd: [2.5, 6], index: 5, dash: [0.125, 0.25],
  ink: [0.5, 0.7, 0.5, 0.42], color: [90, 70, 40], gcPx: 10,
  stepDef: 0.12   // 调用方没给等高距时的缺省（抽象单位）
} as const;

/** 整圈图的判据（经跨超过它）：岸值的列首尾相接，两端同读 */
export const FULL_WRAP_DEG = 359.99;
/** 细分场的判据（场格边 < 类型格边 × 它）：装饰噪声门只在细分或侵蚀场上生效，两端同读 */
export const FINE_STEP_K = 0.999;

/** smoothstep（同 GLSL）：两端同式的规则与 CPU 兜底共用这一份 */
export const sstep01 = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 水面配色与水下分档（两端渲染器同读，GL 的颜色字面量由 waterGLSL 生成）：水段色阶 deep→shallow（0–255，自水面下 rampE 起跨 rampSpan 线性；deep 也是图外深海底色）、
    近岸浅水 shore（0–1，水面下 shoreE 起渐显、按 FX.shoreMix 混入）、岸线墨 ink（0–255）按 inkA 混入；陆上的河面取水面下 riverE＝紧贴判据线下的浅水。
    河当水体画（render/rivers），湖海与河同用这一份。rampE 必须等于 gen2.ISL_SHOAL_U（static-guards 锁着）：群岛的浅滩靠它压到深海色 */
export const WATER = { deep: [40, 90, 132], shallow: [100, 160, 198], shore: [0.55, 0.72, 0.75], ink: [38, 66, 86], inkA: 0.55,
  rampE: 0.35, rampSpan: 0.33, shoreE: 0.10, riverE: WATER_EPS + 1e-4,
  /* 岸线墨的宽（两端画法不同，各一组数）：GL 是到岸值零点的有向距离上 inkBandPx 宽的软带（CSS 像素）；
     CPU 是格边上 4×4 超采样的线，宽 max(1, min(inkWPx·dpr, 瓦片像素每度 ÷ inkWK))——只按后者放大，战术图放大后每段描成上百像素 */
  inkBandPx: 1.4, inkWPx: 1.5, inkWK: 14 } as const;
/** WATER 的 GLSL 字面量（整数补「.0」）：ramp＝按 t 取水段色阶、shore＝近岸色、ink＝岸线墨、deep＝深海色 */
export function waterGLSL(): { ramp: string; shore: string; ink: string; deep: string } {
  const f = glslF, D = WATER.deep, S = WATER.shallow;
  return { ramp: `vec3(${D.map((d, k) => `${f(d)}+t*${f(S[k] - d)}`).join(",")})/255.0`, shore: `vec3(${WATER.shore.map(f).join(",")})`,
    ink: `vec3(${WATER.ink.map(f).join(",")})/255.0`, deep: `vec3(${D.map(f).join(",")})/255.0` };
}
const SHARP = new Float64Array(4);
/** 四角权重按「同类合并后的占比平方」锐化（就地改 w；t＝四角的复合索引；GL matAt 同式）。
    色界走双线性过半的那条线、过渡仍约半格宽；把坐标压窄来收窄过渡，色界就退回类型格的直角台阶 */
export function blendSharp(w: Float64Array, t: Int32Array): void {
  let s = 0;
  for (let i = 0; i < 4; i++) { let W = 0; for (let j = 0; j < 4; j++) if (t[j] === t[i]) W += w[j]; s += SHARP[i] = w[i] * W * W; }
  for (let i = 0; i < 4; i++) w[i] = SHARP[i] / s;
}
/** 岸线重采样的常数（抽象高程）：lift＝贴岸处陆地至少高出、水至少低于判据线这么多，在 liftT 个岸值内升满；capK＝贴岸一小段的起坡上限 */
export const SHORE = { lift: 0.0015, liftT: 0.05, capK: 1 } as const;
/**
 * 把画面高程挪到重采样后的岸线两侧（观感底图；CPU 直接调用，GL 由 shoreGLSL 生成同式）。
 * 类型格的水陆是直角台阶，画面改按四角水陆标志的双线性插值过半定岸；规则场、读数与推演底图不走这里。
 * @param s 岸值＝四角陆占比 − 0.5：>0 画成陆、<0 画成水，画面的水陆只由它定
 * @returns 高程落在 s 那一侧（陆 ≥ 判据线、水严格低于），离岸处原样返回 e；贴岸按 s 起坡、对 e 与 s 连续——邻像素差分出的法线不在岸边起假崖
 */
export function shoreElev(e: number, ws: number, s: number): number {
  const t = Math.abs(s), k = 1 - 2 * t, wl = ws - WATER_EPS;
  const lift = Math.min(SHORE.lift * t / SHORE.liftT, SHORE.lift) * k + 1e-5, cap = SHORE.capK * t / Math.max(k, 1e-6);
  const d = s > 0 ? e - wl : wl - e, f = Math.min(Math.max(d, lift), cap);
  return f === d ? e : s > 0 ? wl + f : wl - f;
}
/** shoreElev 的 GLSL（函数名 shoreFix，同式） */
export function shoreGLSL(): string {
  return `float shoreFix(float e,float ws,float s){
  float t=abs(s), k=1.0-2.0*t, wl=ws-${WATER_EPS};
  float lift=min(${SHORE.lift / SHORE.liftT}*t,${SHORE.lift})*k+1e-5, cap=${SHORE.capK.toFixed(1)}*t/max(k,1e-6);
  float d=s>0.0 ? e-wl : wl-e, f=min(max(d,lift),cap);
  return f==d ? e : (s>0.0 ? wl+f : wl-f);
}`;
}
/** 装饰噪声门（CPU 兜底直接调用；GL 经着色器模板注入同一组 FX 常数，两端同式）。
    细分场（侵蚀）的陆地上，装饰按「真坡或粗糙类型」渐入；水域(land=0)与粗格场(fine=0)恒 1
    ＝旧图/水面观感逐位。land/fine 取 [0,1]（land 由调用方按数据面高程 smoothstep 出连续过渡——
    硬分支会在岸线处给 e 造出阶跃，邻像素差分出的法线在岸边起一道假棱）。 */
export function decoGate(smac: number, matRough: number, land: number, fine: number): number {
  const dk = Math.max(sstep01(FX.decoSlopeLo, FX.decoSlopeHi, smac), sstep01(FX.decoRoughLo, FX.decoRoughHi, matRough));
  return 1 + (dk - 1) * land * fine;
}
/** 宏观坡 smac（抽象高程/度）换成坡角正切的系数：本图米/抽象单位 ÷ 每度米数 */
export function slopeKOf(meta: Meta | undefined): number { return elevUnitM(meta) / (kmPerDeg(meta) * 1000); }
/** 沼泽权重的坡度门（CPU 直接调用；GL 同式）：宏观坡 marshSlopeLo→Hi 度之间渐隐。slopeK＝slopeKOf(meta)，0＝不门控 */
export function marshGate(smac: number, slopeK: number): number {
  return 1 - sstep01(FX.marshSlopeLo, FX.marshSlopeHi, Math.atan(smac * slopeK) * 180 / Math.PI);
}
/** 水洼噪声两八度的旋转（cos, sin）：GL 与 CPU 同取 */
export const POOL_ROT: readonly [number, number, number, number] = [Math.cos(FX.poolRot[0]), Math.sin(FX.poolRot[0]), Math.cos(FX.poolRot[1]), Math.sin(FX.poolRot[1])];
/** 反照率噪声两档的坐标变换＝旋转 × ½（cos, sin）：梯度噪声的斑块约半个格距，格距加倍才与旧值噪声同尺寸；GL 与 CPU 同取 */
export const ALB_ROT: readonly [number, number, number, number] = [0.5 * Math.cos(FX.albRot[0]), 0.5 * Math.sin(FX.albRot[0]), 0.5 * Math.cos(FX.albRot[1]), 0.5 * Math.sin(FX.albRot[1])];

/* —— 两端同式的观感规则：每条一个 TS 函数（CPU 兜底直接调用）+ 同名 GLSL（shadeGLSL / contourGLSL 生成，GL 着色器注入），写在一起。
   改一条必须两份同改，否则 GL 与 CPU 观感分家（e2e「观感底图两端差不越线」只兜得住大的）。两份各留各的运算次序：
   颜色量纲不同（TS 0–255、GLSL 0–1），GLSL 的 mix 与 a+(b−a)t 舍入不同，GL 有些常数预先折成一个字面量——改写其中一份的次序＝那一端的像素变 —— */

/** 陡坡软压：坡长超过膝点 slopeKnee 的部分按 soft/(soft+超出) 压缩，膝内恒等——写成 knee + … 会把任何微坡拉到膝点、平原满是褶皱 */
export function slopeSoft(sl: number): number {
  const x = Math.max(0, sl - FX.slopeKnee);
  return Math.min(sl, FX.slopeKnee) + x * FX.slopeSoft / (FX.slopeSoft + x);
}
/** 暖冷晕渲（Imhof）：受光 dn → o[0] 明暗倍率、o[1..3] 冷暖色偏（受光面暖、背光面冷） */
export function shadeOf(dn: number, o: Float64Array): void {
  const lt = sstep01(FX.shadeKnee, 1, dn);
  o[0] = FX.shadeLo + (FX.shadeHi - FX.shadeLo) * lt;
  o[1] = FX.cool[0] + (FX.warm[0] - FX.cool[0]) * lt; o[2] = FX.cool[1] + (FX.warm[1] - FX.cool[1]) * lt; o[3] = FX.cool[2] + (FX.warm[2] - FX.cool[2]) * lt;
}
/** 谷影（帐篷差的廉价 AO，负＝脊上提亮）：de＝制图面 − 双线性（场的抽象单位），按真实坡度并随夸张走 */
export function cavOf(de: number, fstep: number, gain: number): number {
  return Math.max(FX.cavLo, Math.min(FX.cavHi, de / fstep * gain * 2 * NRM0 * (1 + FX.macroW) * FX.cavAmp));
}
/** 球面图气候带的纬度改正（抽象高程）：雪线、林线、色阶同用这一个 */
export function latShift(lat: number, refM: number, unitM: number): number { return (snowLatM(Math.abs(lat)) - refM) / unitM; }
/** 林线淡出：高程 e 自 treeE + dl 起、band 之内从 0 到 1 */
export function treeFade(treeE: number, dl: number, band: number, e: number): number { const t = treeE + dl; return sstep01(t, t + band, e); }
/** 林线以上换成草甸色的份额：淡出量 × 林冠满度（canopy ÷ FOREST_CANOPY） */
export function meadowK(fade: number, canopy: number): number { return fade * Math.max(0, Math.min(1, canopy / FOREST_CANOPY)); }
/** 生态色调的混入份额（× 四角色调权重和） */
export function tintK(tintW: number): number { return FX.tintMix * tintW; }
/** 荒漠暖沙定调的份额（沙丘权重 d） */
export function sandK(d: number): number { return d * FX.sandMix; }
/** 滩带的份额：m＝还在带内多少格（render/beach 的离水场），h＝画面高程高出那片水的水面多少。带外、高出水面 180 m 以上、沉在水面以下的都不画 */
export function beachK(m: number, h: number): number {
  return sstep01(0, FX.beachFade, m) * sstep01(FX.beachLo1, FX.beachLo0, h) * (1 - sstep01(FX.beachHi0, FX.beachHi1, h));
}
/** 沼泽湿绿定调的份额（坡门之后的沼泽权重 m） */
export function marshK(m: number): number { return m * FX.marshMix; }
/** 水洼的显隐：一格占几像素 pxCell 渐显 × 沼泽权重 m × paper（只在战术图：战略格上两格半的塘是十几公里的湖） */
export function poolGate(pxCell: number, m: number, paper: number): number { return sstep01(FX.poolLo, FX.poolHi, pxCell) * m * paper; }
/** 水洼噪声 pn → o[0] 湿泥份额、o[1] 积水份额（都还没乘显隐与各自的 mix） */
export function poolMask(pn: number, o: Float64Array): void {
  const E = NOISE.pool.edge, pw = sstep01(E[1], E[2], pn);
  o[0] = sstep01(E[0], E[1], pn) * (1 - pw); o[1] = pw;
}
/** 反照率抖动的倍率：av＝两档梯度噪声的 crossfade，g＝八度门 */
export function albM(av: number, albVar: number, g: number): number { return 1 + av * albVar * FX.albAmp * g; }
/** 坡度岩化的份额：缩放无关坡度 slp × 材质岩化敏感度 rock */
export function rockK(slp: number, rock: number): number { return sstep01(FX.rockSlopeLo, FX.rockSlopeHi, slp) * rock; }
/** 岩色的高度位置：岩色＝rockC + rockSpan·它（越高越浅） */
export function rockT(e: number): number { return Math.max(0, Math.min(1, e * FX.rockK)); }
/** 雪线（抽象高程）：基准 + 纬度改正，不低于海面 */
export function snowLine(base: number, dl: number): number { return Math.max(0, base + dl); }
/** 雪盖：高程 e 自雪线 snE 起 snowBand 内从 0 到 1 */
export function snowAt(snE: number, e: number): number { return sstep01(snE, snE + FX.snowBand, e); }
/** 陡坡挂不住雪的折扣（乘在雪盖上） */
export function snowSlope(slp: number): number { return 1 - FX.snowSlopeCut * sstep01(FX.snowSlopeLo, FX.snowSlopeHi, slp); }
/** 空气透视的份额：越高越淡蓝 */
export function airK(e: number): number { return sstep01(FX.airLo, FX.airHi, e) * FX.airMix; }
/** 近岸浅水带的份额：水下 shoreE 起渐显到判据线，按一格占几像素 pxCell 渐显（整幅视角下摊成贴纸大光环） */
export function shoreK(ec: number, ws: number, pxCell: number): number {
  return sstep01(ws - WATER.shoreE, ws - WATER_EPS, ec) * sstep01(FX.shoreLo, FX.shoreHi, pxCell) * FX.shoreMix;
}
/** 水面静态波纹的倍率：wv＝两档 ridged 值噪声的 crossfade，g＝八度门 */
export function waveM(wv: number, g: number): number { return 1 + (wv - 0.5) * FX.waveAmp * g; }
/** 水段色阶的位置：水下 rampE 起、跨 rampSpan 自深到浅 */
export function waterT(e: number, ws: number): number { return Math.max(0, Math.min(1, (e - ws + WATER.rampE) / WATER.rampSpan)); }
/** 等高线亮晕的份额：只画核外环（kh − k），按底色亮度 lum（0–1）在 haloLo..haloHi 渐隐 */
export function haloK(lum: number, k: number, kh: number): number { return (1 - sstep01(FX.haloLo, FX.haloHi, lum)) * Math.max(0, kh - k); }
/** 上面这些规则的 GLSL（同名、同式；颜色 0–1）。cavOf / latShift 的场格边、增益与纬度改正参数由调用方传 uniform */
export function shadeGLSL(): string {
  const f = glslF;
  return `float slopeSoft(float sl){ float x=max(0.0,sl-float(${FX.slopeKnee})); return min(sl,float(${FX.slopeKnee}))+x*float(${FX.slopeSoft})/(float(${FX.slopeSoft})+x); }
void shadeOf(float dn,out float sh,out vec3 shT){ float lt=smoothstep(float(${FX.shadeKnee}),1.0,dn); sh=mix(float(${FX.shadeLo}),float(${FX.shadeHi}),lt); shT=mix(vec3(${FX.cool.join(",")}),vec3(${FX.warm.join(",")}),lt); }
float cavOf(float de,float fstep,float gain){ return clamp(de/fstep*gain*float(${2 * NRM0 * (1 + FX.macroW)})*float(${FX.cavAmp}), ${f(FX.cavLo)}, ${f(FX.cavHi)}); }
float latShift(float lat,float on,float ref,float unit){ return on*(snowLatM(abs(lat))-ref)*unit; }
float treeFade(float treeE,float dl,float band,float e){ return smoothstep(treeE+dl,treeE+dl+band,e); }
float meadowK(float fade,float canopy){ return fade*clamp(canopy/float(${FOREST_CANOPY}),0.0,1.0); }
float tintK(float tintW){ return ${f(FX.tintMix)}*tintW; }
float sandK(float d){ return d*float(${FX.sandMix}); }
float beachK(float m,float h){ return smoothstep(0.0,float(${FX.beachFade}),m)*smoothstep(float(${FX.beachLo1}),float(${FX.beachLo0}),h)*(1.0-smoothstep(float(${FX.beachHi0}),float(${FX.beachHi1}),h)); }
float marshK(float m){ return m*float(${FX.marshMix}); }
float poolGate(float pxCell,float m,float paper){ return smoothstep(float(${FX.poolLo}),float(${FX.poolHi}),pxCell)*m*paper; }
vec2 poolMask(float pn){ float pw=smoothstep(${f(NOISE.pool.edge[1])},${f(NOISE.pool.edge[2])},pn); return vec2(smoothstep(${f(NOISE.pool.edge[0])},${f(NOISE.pool.edge[1])},pn)*(1.0-pw), pw); }
float albM(float av,float albVar,float g){ return 1.0+av*albVar*float(${FX.albAmp})*g; }
float rockK(float slp,float rock){ return smoothstep(float(${FX.rockSlopeLo}),float(${FX.rockSlopeHi}),slp)*rock; }
float rockT(float e){ return clamp(e*${f(FX.rockK)},0.0,1.0); }
float snowLine(float base,float dl){ return max(0.0, base+dl); }
float snowAt(float snE,float e){ return smoothstep(snE,snE+float(${FX.snowBand}),e); }
float snowSlope(float slp){ return 1.0-${f(FX.snowSlopeCut)}*smoothstep(float(${FX.snowSlopeLo}),float(${FX.snowSlopeHi}),slp); }
float airK(float e){ return smoothstep(float(${FX.airLo}),float(${FX.airHi}),e)*float(${FX.airMix}); }
float shoreK(float ec,float ws,float pxCell){ return smoothstep(ws-${f(WATER.shoreE)},ws-${f(WATER_EPS)},ec)*smoothstep(float(${FX.shoreLo}),float(${FX.shoreHi}),pxCell)*float(${FX.shoreMix}); }
float waveM(float wv,float g){ return 1.0+(wv-0.5)*float(${FX.waveAmp})*g; }
float waterT(float e,float ws){ return clamp((e-ws+${f(WATER.rampE)})/${f(WATER.rampSpan)},0.0,1.0); }
float haloK(float lum,float k,float kh){ return max(0.0,kh-k)*(1.0-smoothstep(float(${FX.haloLo}),float(${FX.haloHi}),lum)); }`;
}

/** 等高线到最近整倍等值面的线强：d＝像素距（+1e-6 防零梯度平台整面刷线），w0..w1 是 smoothstep 的两沿 */
function contourW(eh: number, itv: number, ad: number, w0: number, w1: number): number {
  const u = eh / itv, d = (Math.abs(u - Math.round(u)) * itv + 1e-6) / ad;
  return 1 - sstep01(w0, w1, d);
}
/** 等值面倍数的奇偶（间曲线、助曲线只补奇数倍＝首曲线之间的新线） */
const oddK = (eh: number, itv: number): number => Math.round(eh / itv) % 2 === 0 ? 0 : 1;
/**
 * 一套线系在此像素的着墨（GL 由 contourGLSL 生成同式）：首曲线（挤线抑制：线距不足数像素的陡坎隐去）、计曲线（每第 CONTOUR.index 条，按自身线距评估）、
 * 间曲线（1/2 距，长虚线）与助曲线（1/4 距，短虚线）——上一级线距 ≥ core/elev.SUP_* 才浮现。
 * @param ad 线宽量（每 CSS 像素的高程变化）　@param gsl 粗坡（高程 / CSS 像素）　@param sdp 沿等值线切向的像素坐标（虚线相位）　@param bo 带宽外扩像素（亮晕用）
 */
export function contourK(eh: number, itv: number, ad: number, gsl: number, sdp: number, bo: number): number {
  const C = CONTOUR, mn = contourW(eh, itv, ad, C.minorW[0] + bo, C.minorW[1] + bo) * sstep01(C.crowd[0], C.crowd[1], itv / ad);
  const ix = contourW(eh, itv * C.index, ad, C.indexW[0] + bo, C.indexW[1] + bo) * sstep01(C.crowd[0], C.crowd[1], itv * C.index / ad);
  const sp1 = itv / gsl, g1 = sstep01(SUP_LO_PX, SUP_HI_PX, sp1), g2 = g1 * sstep01(SUP_LO_PX, SUP_HI_PX, sp1 * 0.5);
  let m2 = 0, m4 = 0;
  if (g1 > 0) {
    const sd = sdp / SUP_DASH_PX, fr = sd - Math.floor(sd), fr2 = 2 * sd - Math.floor(2 * sd);
    const d1 = Math.abs(fr - 0.5) >= C.dash[0] ? 1 : 0, d2 = Math.abs(fr2 - 0.5) >= C.dash[1] ? 1 : 0;
    m2 = contourW(eh, itv * 0.5, ad, C.minorW[0] + bo, C.minorW[1] + bo) * oddK(eh, itv * 0.5) * g1 * d1;
    m4 = contourW(eh, itv * 0.25, ad, C.minorW[0] + bo, C.minorW[1] + bo) * oddK(eh, itv * 0.25) * g2 * d2;
  }
  return Math.max(mn * C.ink[0], ix * C.ink[1], m2 * C.ink[2], m4 * C.ink[3]);
}
/** contourK 的 GLSL（cwMinor / cwIndex＝首曲线与计曲线两组带宽的 contourW） */
export function contourGLSL(): string {
  const f = glslF, C = CONTOUR, lo = SUP_LO_PX.toFixed(1), hi = SUP_HI_PX.toFixed(1);
  return `float cwMinor(float eh,float itv,float aa,float bo){ float u=eh/itv; float d=(abs(u-round(u))*itv+1e-6)/aa; return 1.0-smoothstep(${f(C.minorW[0])}+bo,${f(C.minorW[1])}+bo,d); }
float cwIndex(float eh,float itv,float aa,float bo){ float u=eh/itv; float d=(abs(u-round(u))*itv+1e-6)/aa; return 1.0-smoothstep(${f(C.indexW[0])}+bo,${f(C.indexW[1])}+bo,d); }
float oddK(float eh,float itv){ return mod(round(eh/itv),2.0); }
float contourK(float eh,float itv,float aa,float gsl,float sdp,float bo){
  float mn=cwMinor(eh,itv,aa,bo)*smoothstep(${f(C.crowd[0])},${f(C.crowd[1])},itv/aa);
  float ix=cwIndex(eh,itv*${f(C.index)},aa,bo)*smoothstep(${f(C.crowd[0])},${f(C.crowd[1])},itv*${f(C.index)}/aa);
  float sp1=itv/gsl;
  float g1=smoothstep(${lo},${hi},sp1), g2=g1*smoothstep(${lo},${hi},sp1*0.5);
  float sd=sdp/${SUP_DASH_PX.toFixed(1)};
  float d1=step(${f(C.dash[0])},abs(fract(sd)-0.5)), d2=step(${f(C.dash[1])},abs(fract(sd*2.0)-0.5));
  float m2=cwMinor(eh,itv*0.5,aa,bo)*oddK(eh,itv*0.5)*g1*d1;
  float m4=cwMinor(eh,itv*0.25,aa,bo)*oddK(eh,itv*0.25)*g2*d2;
  return max(max(mn*${f(C.ink[0])}, ix*${f(C.ink[1])}), max(m2*${f(C.ink[2])}, m4*${f(C.ink[3])}));
}`;
}

/* —— 两端同式的取样与纹理规则（第一趟）：同上一段的约定；GLSL 版由 textureGLSL 生成，读着色器的 uPXPD（像素/度）与 uGridBB.z（类型格边，度），
   噪声基元两端有意不同（GL 是 PCG2D fp32 的 vnoise2 / gnoise2，TS 是 core/noise.vnoise 与下面的 gnoise）——观感同构而非逐位一致 —— */

/* 梯度噪声（±0.7，TS 版）：四角梯度按 (xi, yi) 精确比中记忆——命中返回同一批 double＝输出逐位不变；不记忆则每像素多十几次 sin / cos */
const GC = 2048;
const gcK = new Float64Array(GC * 2).fill(NaN), gcV = new Float64Array(GC * 8);   // [xi, yi] 键 · 四角 (cos, sin)
/** 梯度噪声（Perlin 型）：棱脊、沙丘的 ridged 变换与反照率用——值噪声 ridged 后是迷宫纹 */
export function gnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const s = ((Math.imul(xi | 0, 0x9e3779b1) ^ Math.imul(yi | 0, 0x85ebca77)) >>> 0) & (GC - 1), o = s * 8;
  if (gcK[s * 2] !== xi || gcK[s * 2 + 1] !== yi) {
    const t0 = hash2(xi, yi) * NOISE.tau, t1 = hash2(xi + 1, yi) * NOISE.tau;
    const t2 = hash2(xi, yi + 1) * NOISE.tau, t3 = hash2(xi + 1, yi + 1) * NOISE.tau;
    gcV[o] = Math.cos(t0); gcV[o + 1] = Math.sin(t0); gcV[o + 2] = Math.cos(t1); gcV[o + 3] = Math.sin(t1);
    gcV[o + 4] = Math.cos(t2); gcV[o + 5] = Math.sin(t2); gcV[o + 6] = Math.cos(t3); gcV[o + 7] = Math.sin(t3);
    gcK[s * 2] = xi; gcK[s * 2 + 1] = yi;
  }
  const a = gcV[o] * xf + gcV[o + 1] * yf, b = gcV[o + 2] * (xf - 1) + gcV[o + 3] * yf;
  const c = gcV[o + 4] * xf + gcV[o + 5] * (yf - 1), d = gcV[o + 6] * (xf - 1) + gcV[o + 7] * (yf - 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** 梯度噪声 → 脊形（峰 1 谷 0） */
const rgd = (n: number): number => 1 - Math.min(1, Math.abs(n) * NOISE.ridgeK);
/** 屏幕波长 tpx 锚定的两档世界频率与 crossfade：[f, 2f, 份额]（×2 阶梯嵌套，缩放连续无跳档） */
export function lodF(pxpd: number, tpx: number): [number, number, number] {
  const fi = Math.max(MICRO_F0, pxpd / tpx);
  const n = Math.floor(Math.log2(fi / MICRO_F0));
  return [MICRO_F0 * 2 ** n, MICRO_F0 * 2 ** (n + 1), Math.log2(fi / MICRO_F0) - n];
}
/** 域扭曲（色调 / 材质查找与晕渲高程共用）：双频、幅度 < 半格、格空间标定＝缩放稳定。rx / ry＝图幅局部坐标（度），o ← [wx, wy] */
export function warpOf(rx: number, ry: number, step: number, o: Float64Array): void {
  const wf = FX.warpF / step, { f2, a2, o: k } = NOISE.warp;
  const w1x = vnoise(rx * wf + k[0][0], ry * wf + k[0][1]) - 0.5, w1y = vnoise(rx * wf + k[1][0], ry * wf + k[1][1]) - 0.5;
  const w2x = vnoise(rx * wf * f2 + k[2][0], ry * wf * f2 + k[2][1]) - 0.5, w2y = vnoise(rx * wf * f2 + k[3][0], ry * wf * f2 + k[3][1]) - 0.5;
  o[0] = (w1x + w2x * a2) * step * FX.warpAmp; o[1] = (w1y + w2y * a2) * step * FX.warpAmp;
}
/** 长波扭曲与边缘碎化（只喂色调 / 材质查找，有意超半格；不进高程）：o ← [长波 x, y, 碎化 x, y]——调用方逐项依次加，合成一项再加会差一位 */
export function warp2Of(rx: number, ry: number, step: number, o: Float64Array): void {
  const w2f = FX.warp2F / step, w3f = FX.warp3F / step, o2 = NOISE.warp2, o3 = NOISE.warp3;
  o[0] = (vnoise(rx * w2f + o2[0][0], ry * w2f + o2[0][1]) - 0.5) * step * FX.warp2Amp; o[1] = (vnoise(rx * w2f + o2[1][0], ry * w2f + o2[1][1]) - 0.5) * step * FX.warp2Amp;
  o[2] = (vnoise(rx * w3f + o3[0][0], ry * w3f + o3[0][1]) - 0.5) * step * FX.warp3Amp; o[3] = (vnoise(rx * w3f + o3[1][0], ry * w3f + o3[1][1]) - 0.5) * step * FX.warp3Amp;
}
/** 微八度：世界锚定 ×2 阶梯接续宏观 fbm 频谱，逐档按屏幕波长门控（整幅视角全零）、逐档旋转 37° 打散值噪声的格向（不旋＝梳毛状流纹） */
export function micro(rx: number, ry: number, pxpd: number): number {
  let s = 0, a = 0.5, f = MICRO_F0, px = rx, py = ry;
  const [rc, rs] = NOISE.micro.rot, [kx, ky] = NOISE.micro.k;
  for (let k = 0; k < MICRO_OCTAVES; k++) {
    const g = octaveGate(pxpd, f); if (g <= 0) break;
    s += a * g * (vnoise(px * f + k * kx, py * f + k * ky) - 0.5);
    const nx = rc * px + rs * py, ny = -rs * px + rc * py;   // 同 GLSL 的 ROT（列主序展开）
    px = nx; py = ny; f *= 2; a *= FX.microPers;
  }
  return s;
}
/** 材质纹理（只进光照法线）：林冠 / 沙丘 / 棱脊 / 沼泽各一对 lod 档 crossfade，权重为零的类整段跳过 */
export function texAt(rx: number, ry: number, twc: number, twd: number, twr: number, twm: number, pxpd: number): number {
  let h = 0;
  if (twc > FX.wMin) {
    const [f1, f2, fr] = lodF(pxpd, FX.canopyPx), g = octaveGate(pxpd, f1);
    if (g > 0) {
      const o = NOISE.canopy, a = vnoise(rx * f1 + o[0][0], ry * f1 + o[0][1]) - 0.5, b = vnoise(rx * f2 + o[1][0], ry * f2 + o[1][1]) - 0.5;   // 软鼓包（阈值化＝迷宫蠕虫纹）
      h += twc * FX.canopyAmp * g * (a + (b - a) * fr);
    }
  }
  if (twd > FX.wMin) {
    const [f1, f2, fr] = lodF(pxpd, FX.dunePx), g = octaveGate(pxpd, f1);
    if (g > 0) {
      const { sx, o } = NOISE.dune, a = rgd(gnoise(rx * sx * f1 + o[0][0], ry * f1 + o[0][1])), b = rgd(gnoise(rx * sx * f2 + o[1][0], ry * f2 + o[1][1]));
      h += twd * FX.duneAmp * g * (a + (b - a) * fr);
    }
  }
  if (twr > FX.wMin) {
    const [f1, f2, fr] = lodF(pxpd, FX.ridgePx), g = octaveGate(pxpd, f1);
    if (g > 0) {   // 棱脊两级：主脉（×main 波长）调制支脉＝山系层级感
      const { main, mix, o } = NOISE.ridge, m1 = rgd(gnoise(rx * f1 * main + o[0][0], ry * f1 * main + o[0][1]));
      const a = rgd(gnoise(rx * f1 + o[1][0], ry * f1 + o[1][1])), b = rgd(gnoise(rx * f2 + o[2][0], ry * f2 + o[2][1]));
      const r = a + (b - a) * fr;
      h += twr * FX.ridgeAmp * g * (mix[0] * m1 * m1 + mix[1] * m1 * r);
    }
  }
  if (twm > FX.wMin) {
    const [f1, f2, fr] = lodF(pxpd, FX.marshPx), g = octaveGate(pxpd, f1);
    if (g > 0) {
      const o = NOISE.marsh, a = vnoise(rx * f1 + o[0][0], ry * f1 + o[0][1]), b = vnoise(rx * f2 + o[1][0], ry * f2 + o[1][1]);
      h += twm * FX.marshAmp * g * (a + (b - a) * fr - 0.5);
    }
  }
  return h;
}
/** 宏观 fbm 的幅度：按高程分三档，侵蚀过的场降到 fbmEroded 倍（真形自己带起伏） */
export function fbmRough(e: number, eroded: number): number {
  return (e > FX.fbmE[0] ? FX.fbmRough[0] : (e > FX.fbmE[1] ? FX.fbmRough[1] : FX.fbmRough[2])) * (eroded ? FX.fbmEroded : 1);
}
/** 坡度补糙度（smac＝宏观坡，抽象高程 / 度）：山的质感跟着坡走，与类型的糙度取大——手雕高山落在平原类型上也有岩理 */
export function slopeRough(smac: number, rough: number): number { return Math.max(rough, Math.min(FX.slopeRoughMax, smac * FX.slopeRough)); }
/** 坡度补棱脊权重（同上，与类型的棱脊权重取大） */
export function slopeRidge(smac: number, ridge: number): number { return Math.max(ridge, Math.min(1, smac * FX.slopeRidge)); }
/** 纹理疏密调制的噪声：世界锚定两八度（λ≈20 格） */
export function patchN(rx: number, ry: number, step: number): number {
  const pf = FX.texPatchF / step, P = NOISE.patch;
  return P.w[0] * vnoise(rx * pf + P.o[0][0], ry * pf + P.o[0][1]) + P.w[1] * vnoise(rx * pf * P.f2 + P.o[1][0], ry * pf * P.f2 + P.o[1][1]);
}
/** 纹理幅度的疏密倍率（同一片林 / 沼 / 山有疏有密） */
export function texPatchK(pn: number): number { return FX.texPatchLo + (FX.texPatchHi - FX.texPatchLo) * sstep01(NOISE.patch.edge[0], NOISE.patch.edge[1], pn); }
/** 水洼噪声（世界锚定两八度梯度噪声，各转一角：值噪声的塘沿格线连成方块）；step＝类型格边（度） */
export function poolN(rx: number, ry: number, step: number): number {
  const pf = FX.poolF / step, qx = rx * pf, qy = ry * pf, [c1, s1, c2, s2] = POOL_ROT, { f2, w, o } = NOISE.pool;
  return 0.5 + FX.poolK * (w[0] * gnoise(qx * c1 - qy * s1 + o[0][0], qx * s1 + qy * c1 + o[0][1]) + w[1] * gnoise(f2 * (qx * c2 - qy * s2) + o[1][0], f2 * (qx * s2 + qy * c2) + o[1][1]));
}
/** 反照率抖动的噪声：屏幕锚定两档（lodF 的 f1 / f2 / fr）梯度噪声，各转一角并缩半（ALB_ROT） */
export function albAv(rx: number, ry: number, f1: number, f2: number, fr: number): number {
  const [c1, s1, c2, s2] = ALB_ROT, o = NOISE.alb;
  return gnoise((c1 * rx - s1 * ry) * f1 + o[0][0], (s1 * rx + c1 * ry) * f1 + o[0][1]) * (1 - fr) + gnoise((c2 * rx - s2 * ry) * f2 + o[1][0], (s2 * rx + c2 * ry) * f2 + o[1][1]) * fr;
}
/** 水面静态波纹的噪声：两档 ridged 值噪声（横向拉伸 NOISE.wave.sx）的 crossfade */
export function waveWv(rx: number, ry: number, f1: number, f2: number, fr: number): number {
  const { sx, o } = NOISE.wave, ra = 1 - Math.abs(2 * vnoise(rx * sx * f1 + o[0][0], ry * f1 + o[0][1]) - 1);
  const rb = 1 - Math.abs(2 * vnoise(rx * sx * f2 + o[1][0], ry * f2 + o[1][1]) - 1);
  return ra + (rb - ra) * fr;
}
/** 宏观坡（±1 格差分）进法线的系数 */
export function macroK(step: number, gain: number): number { return FX.macroNrm / step * FX.macroW * gain; }
/** 上面这些规则的 GLSL（同名、同式）；另含沼泽坡门 marshGate 与装饰门 decoGate（它们的 TS 版在本文件前面） */
export function textureGLSL(): string {
  const f = glslF, N = NOISE, v2 = (p: readonly number[]): string => `vec2(${f(p[0])},${f(p[1])})`;
  return `float gate(float f){ return smoothstep(${f(OCT_GATE_PX[0])},${f(OCT_GATE_PX[1])},uPXPD/f); }
float rg(float n){ return 1.0-min(1.0,abs(n)*${f(N.ridgeK)}); }
float ridged(float n){ return 1.0-abs(2.0*n-1.0); }
float poolN(vec2 rel){
  float pf=float(${FX.poolF})/uGridBB.z;
  vec2 pq=rel*pf;
  return 0.5+float(${FX.poolK})*(${f(N.pool.w[0])}*gnoise2(vec2(pq.x*float(${POOL_ROT[0]})-pq.y*float(${POOL_ROT[1]}),pq.x*float(${POOL_ROT[1]})+pq.y*float(${POOL_ROT[0]}))+${v2(N.pool.o[0])})
    +${f(N.pool.w[1])}*gnoise2(${f(N.pool.f2)}*vec2(pq.x*float(${POOL_ROT[2]})-pq.y*float(${POOL_ROT[3]}),pq.x*float(${POOL_ROT[3]})+pq.y*float(${POOL_ROT[2]}))+${v2(N.pool.o[1])}));
}
float albAv(vec2 rel,vec3 LA){
  return mix(gnoise2(mat2(${ALB_ROT[0]},${ALB_ROT[1]},${-ALB_ROT[1]},${ALB_ROT[0]})*rel*LA.x+${v2(N.alb[0])}),
             gnoise2(mat2(${ALB_ROT[2]},${ALB_ROT[3]},${-ALB_ROT[3]},${ALB_ROT[2]})*rel*LA.y+${v2(N.alb[1])}), LA.z);
}
float waveWv(vec2 rel,vec3 LW){
  return mix(ridged(vnoise2(vec2(rel.x*${f(N.wave.sx)},rel.y)*LW.x+${v2(N.wave.o[0])})),
             ridged(vnoise2(vec2(rel.x*${f(N.wave.sx)},rel.y)*LW.y+${v2(N.wave.o[1])})), LW.z);
}
vec3 lodF(float tpx){ float fi=max(MF0, uPXPD/tpx); float f=MF0*exp2(floor(log2(fi/MF0)));
  return vec3(f, f*2.0, fract(log2(fi/MF0))); }
vec2 warpOf(vec2 rel){
  float wf=float(${FX.warpF})/uGridBB.z;
  vec2 w1=vec2(vnoise2(rel*wf+${v2(N.warp.o[0])}), vnoise2(rel*wf+${v2(N.warp.o[1])}))-0.5;
  vec2 w2=vec2(vnoise2(rel*wf*${f(N.warp.f2)}+${v2(N.warp.o[2])}), vnoise2(rel*wf*${f(N.warp.f2)}+${v2(N.warp.o[3])}))-0.5;
  return (w1+w2*${f(N.warp.a2)})*(uGridBB.z*float(${FX.warpAmp}));
}
vec2 warp2Of(vec2 rel){
  float wf=float(${FX.warp2F})/uGridBB.z;
  vec2 lo=(vec2(vnoise2(rel*wf+${v2(N.warp2[0])}), vnoise2(rel*wf+${v2(N.warp2[1])}))-0.5)*(uGridBB.z*float(${FX.warp2Amp}));
  float hf=float(${FX.warp3F})/uGridBB.z;
  vec2 hi=(vec2(vnoise2(rel*hf+${v2(N.warp3[0])}), vnoise2(rel*hf+${v2(N.warp3[1])}))-0.5)*(uGridBB.z*float(${FX.warp3Amp}));
  return lo+hi;
}
const mat2 ROT=mat2(${f(N.micro.rot[0])},${f(-N.micro.rot[1])},${f(N.micro.rot[1])},${f(N.micro.rot[0])});
float micro(vec2 rel){
  float s=0.0,a=0.5,f=MF0;
  vec2 p=rel;
  for(int k=0;k<${MICRO_OCTAVES};k++){
    float g=gate(f); if(g<=0.0) break;
    s+=a*g*(vnoise2(p*f+vec2(float(k)*${f(N.micro.k[0])},float(k)*${f(N.micro.k[1])}))-0.5);
    p=ROT*p; f*=2.0; a*=float(${FX.microPers});
  }
  return s;
}
float texAt(vec2 rel, vec4 tw){
  float h=0.0;
  if(tw.x>${f(FX.wMin)}){ vec3 L=lodF(float(${FX.canopyPx})); float g=gate(L.x);
    if(g>0.0){ float a=vnoise2(rel*L.x+${v2(N.canopy[0])})-0.5;
      float b=vnoise2(rel*L.y+${v2(N.canopy[1])})-0.5;
      h+=tw.x*float(${FX.canopyAmp})*g*mix(a,b,L.z); } }
  if(tw.y>${f(FX.wMin)}){ vec3 L=lodF(float(${FX.dunePx})); float g=gate(L.x);
    if(g>0.0){ float a=rg(gnoise2(vec2(rel.x*${f(N.dune.sx)},rel.y)*L.x+${v2(N.dune.o[0])}));
      float b=rg(gnoise2(vec2(rel.x*${f(N.dune.sx)},rel.y)*L.y+${v2(N.dune.o[1])}));
      h+=tw.y*float(${FX.duneAmp})*g*mix(a,b,L.z); } }
  if(tw.z>${f(FX.wMin)}){ vec3 L=lodF(float(${FX.ridgePx})); float g=gate(L.x);
    if(g>0.0){ float m1=rg(gnoise2(rel*L.x*${f(N.ridge.main)}+${v2(N.ridge.o[0])}));
      float a=rg(gnoise2(rel*L.x+${v2(N.ridge.o[1])}));
      float b=rg(gnoise2(rel*L.y+${v2(N.ridge.o[2])}));
      float r=mix(a,b,L.z);
      h+=tw.z*float(${FX.ridgeAmp})*g*(${f(N.ridge.mix[0])}*m1*m1+${f(N.ridge.mix[1])}*m1*r); } }
  if(tw.w>${f(FX.wMin)}){ vec3 L=lodF(float(${FX.marshPx})); float g=gate(L.x);
    if(g>0.0){ float a=vnoise2(rel*L.x+${v2(N.marsh[0])});
      float b=vnoise2(rel*L.y+${v2(N.marsh[1])});
      h+=tw.w*float(${FX.marshAmp})*g*(mix(a,b,L.z)-0.5); } }
  return h;
}
float fbmRough(float e,float eroded){ return (e>${f(FX.fbmE[0])}?${f(FX.fbmRough[0])}:(e>${f(FX.fbmE[1])}?${f(FX.fbmRough[1])}:${f(FX.fbmRough[2])}))*mix(1.0,${f(FX.fbmEroded)},eroded); }
float slopeRough(float smac,float rough){ return max(rough, min(float(${FX.slopeRoughMax}), smac*float(${FX.slopeRough}))); }
float slopeRidge(float smac,float ridge){ return max(ridge, min(1.0, smac*float(${FX.slopeRidge}))); }
float patchN(vec2 rel){ float pf=float(${FX.texPatchF})/uGridBB.z;
  return ${f(N.patch.w[0])}*vnoise2(rel*pf+${v2(N.patch.o[0])})+${f(N.patch.w[1])}*vnoise2(rel*pf*${f(N.patch.f2)}+${v2(N.patch.o[1])}); }
float texPatchK(float pn){ return mix(float(${FX.texPatchLo}), float(${FX.texPatchHi}), smoothstep(${f(N.patch.edge[0])},${f(N.patch.edge[1])},pn)); }
float macroK(float cell,float gain){ return ${f(FX.macroNrm)}/cell*float(${FX.macroW})*gain; }
float marshGate(float smac,float slopeK){ return 1.0-smoothstep(float(${FX.marshSlopeLo}),float(${FX.marshSlopeHi}),degrees(atan(smac*slopeK))); }
float decoGate(float smac,float rough,float land,float fine){
  float dk=max(smoothstep(float(${FX.decoSlopeLo}),float(${FX.decoSlopeHi}),smac), smoothstep(float(${FX.decoRoughLo}),float(${FX.decoRoughHi}),rough));
  return 1.0+(dk-1.0)*land*fine;
}`;
}
