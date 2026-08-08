/* 渲染材质表（纯观感，不入平价）：LANDFORM×ECO 25 复合 → 微起伏幅度 / 四类材质纹理权重 /
   反照率抖动 / 坡度岩化敏感度。GL（uniform 数组）与 CPU 兜底（直接调用）共用同一张表与同一个
   八度门控——两端观感同构的判据收在这里，别在渲染器里各写一份数值。
   ⚠ 另立一张表、不给 LANDFORM/ECO/terrainProps 加字段（它们是平价逐位比对对象，同 NODE_CATS 之例）。 */
import { parseComposite, allComposites } from "../core/constants.ts";
import { elevUnitM } from "../core/elev.ts";
import type { Landform, Meta } from "../core/types.ts";

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
  hill:     { canopy: 0, dune: 0, ridge: 0.30, marsh: 0, rough: 0.14, albVar: 0.04, rock: 0.85 },
  mountain: { canopy: 0, dune: 0, ridge: 1.0,  marsh: 0, rough: 0.24, albVar: 0.03, rock: 1.0 },
  water:    { canopy: 0, dune: 0, ridge: 0,    marsh: 0, rough: 0,    albVar: 0,    rock: 0 }
};

/** 复合串 → 材质（生态在地貌基线上修饰；水域基底一律全零——水下画不着地面质感，水面观感另在渲染器水分支） */
export function materialFor(cell: string): Material {
  const [lf, eco] = parseComposite(cell);
  const b = { ...LF_MAT[lf] };
  if (lf === "water") return b;
  if (eco === "forest") { b.canopy = 0.85; b.ridge *= 0.5; b.rough *= 0.6; b.albVar = 0.05; b.rock *= 0.5; }
  if (eco === "grassland") { b.albVar = 0.09; }
  if (eco === "marsh") { b.marsh = 0.75; b.ridge = 0; b.rough = 0.02; b.rock = 0; }
  if (eco === "desert") { b.dune = 0.8; b.ridge *= 0.4; b.rough = 0.05; b.rock = 0; }
  return b;
}

/** 全 25 复合的材质，顺序与 compositeIndex 对齐（GL 填 uniform 数组用） */
export function materialTable(): Material[] { return allComposites().map(materialFor); }

/** 雪的起始海拔（米）。雪线按真实米数经 elevUnitM 折算成抽象高程（渲染端 uSnowE）——
    旧色阶 0.82 抽象档起发白，在标定 900m 的战术图上≈740m 即成雪山（井陉秋季 38°N 战场实证之病）；
    按米定雪线后战术图自然无雪，战略图（标定 2000m）只剩最高峰挂雪。 */
export const SNOW_M = 2050;
export function snowEOf(meta: Meta | undefined): number { return SNOW_M / elevUnitM(meta); }

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
  microAmp: 0.34,   // 微八度总幅（×材质 rough）——过大即「抓挠感」
  microPers: 0.42,  // 微八度持续度（<0.5=高频档法线贡献递减）
  warpF: 0.77,      // 域扭曲主频（1/格）；副频 ×3.1、幅 ×0.35
  warpAmp: 0.7,     // 域扭曲总幅（×格距；主+副合成后 <半格）
  canopyPx: 30, canopyAmp: 3.2,   // 林冠鼓包
  dunePx: 26,   duneAmp: 2.0,     // 沙丘波纹（纵向拉伸 0.3）
  ridgePx: 52,  ridgeAmp: 5.5,    // 山地棱脊（主脉 ×0.36 波长调制支脉）
  marshPx: 34,  marshAmp: 1.0,    // 沼泽墩洼
  texW: 2.0,        // 屏幕锚定纹理 → 法线幅度的折算分子（÷像素密度＝明暗对比不随缩放）
  albPx: 44,    albAmp: 2.0,      // 反照率抖动（×材质 albVar）
  wavePx: 38,   waveAmp: 0.07,    // 水面静态波纹
  shoreMix: 0.28,   // 近岸浅水带混入
  rockMix: 0.55,    // 坡度岩化最大混入
  cavAmp: 6.0,      // 谷影幅度（帐篷差 × 此系数，钳 [-0.10, 0.16]）
  /* —— 2026-08 光照与色彩批 —— */
  shadeLo: 0.50, shadeHi: 1.22,   // 光照响应两端（旧 0.6+0.75·d 最亮:最暗仅 2.2:1＝整图挤中灰）
  shadeKnee: -0.55,               // 响应软肩（smoothstep 下界；上界恒 1.0）
  cool: [0.83, 0.88, 1.03], warm: [1.05, 1.0, 0.92],   // 暖冷晕渲（Imhof：受光面暖、背光面冷紫）
  macroW: 0.8,      // 宏观场法线权重（±1 格、无噪声的地貌坡再计一份——压低噪声皱纹在光照里的话语权）
  snowBand: 0.22,   // 雪线过渡带宽（抽象高程；起点见 SNOW_M/snowEOf）
  warp2F: 0.16, warp2Amp: 1.7,    // 长波扭曲（λ≈6 格、幅≈±0.85 格）——只喂色调/材质查找，把多格
                                  //   涂改色块的直边揉出有机走向；有意超半格（warpOf 守半格是为晕渲高程）
  shoreLo: 35, shoreHi: 120,      // 近岸浅水带渐隐区间（px/°）：整幅视角的贴纸大光环由此归零
  shadowK: 0.42      // 烘焙遮蔽（erode 定向天光通道）压暗上限——背光谷底连同暖冷响应一起走 lt
} as const;
