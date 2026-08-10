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
  if (eco === "desert") { b.dune = 0.8; b.ridge *= 0.4; b.rough = 0.05; b.albVar = 0.09; b.rock = 0; }   // albVar 抬档＝沙面明暗斑驳
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
  /* 陡坡增纹（2026-08-08）：战术尺度上宏观坡可达 90/度、法线量级 ~58，而屏幕锚定纹理只有 ~0.3
     ——1:200 的悬殊，纹理在晕渲里根本读不出来，这就是「越放大越空」的真因（把 texW 临时拉到 30
     即纹理铺满全图＝通路本身没问题，只是幅度不够）。⚠ 不是「软压吃掉了纹理」，那条已实证证伪，
     见软压处头注。
     律＝**细节占宏观一个大致固定的比例**：缓坡（smac≤Lo）恒 1×＝战略图与平缓战术图观感逐位不变，
     超过 Lo 才按 (smac−Lo)×k 抬幅。Lo=4 取在「河洛中位 2.5 不受影响、其 p90 19.9 已明显补纹」处。
     ⚠ 批5 曾把 Lo 误留 0.0＝增纹从坡度 0 就开吃、中位缓坡也被抬到 6×——正是「纹理太多、
     只是杂乱装饰」的直接来源（批6 用户点单实证）；k 同步 2.0→1.2＝真高差入场后纹理只作补充 */
  texSlopeLo: 4.0, texSlope: 1.2, texSlopeMax: 10.0,
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
  /* 边缘碎化（2026-08-08）：长波扭曲只能把长直边推成缓弯，跨十几格的涂改边界照旧一眼是直的
     （井陉中景成片矩形色块实拍）。补一档高频小幅（λ≈1.1 格、幅≈±0.23 格）打碎边缘读感——
     幅度有意远小于长波：色调若跑离地貌太远，山脊上会出现不属于它的地类色 */
  warp3F: 0.9, warp3Amp: 0.45,
  shoreLo: 35, shoreHi: 120,      // 近岸浅水带渐隐区间（px/°）：整幅视角的贴纸大光环由此归零
  shadowK: 0.42,     // 烘焙遮蔽（erode 定向天光通道）压暗上限——背光谷底连同暖冷响应一起走 lt
  /* 坡度补材质（|∇e|/度 → 糙度/棱脊权重）：手雕的高山常落在平原/草原类型上，材质只认类型
     就还是草地质感的光滑圆包（河洛实证）——山的质感跟着坡走，与类型取大 */
  slopeRough: 0.013, slopeRoughMax: 0.24,   // 山地档 rough=0.24；坡 18/度 拉满
  slopeRidge: 0.055,                         // 坡 18/度 → 棱脊权重 1.0（山地档）
  /* 陡坡软压（光照响应用的总坡度：膝点内原样，超出部分渐近压缩到 +slopeSoft）——手雕悬崖
     坡度动辄 8..16，法线归一化后 dot 饱和在响应区间外＝整面纯暗/纯亮，微地形隐形（河洛实证：
     「光滑圆包」其实是剪裁）。膝点 1.4 保住缓坡观感逐位（战略图/井陉大部分坡 <1.4） */
  slopeKnee: 1.4, slopeSoft: 1.3,
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
  poolLo: 30, poolHi: 110,                        // 水洼随 px/° 渐显区间
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
