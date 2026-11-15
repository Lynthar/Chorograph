/* 侵蚀真形（渲染层数据源，2026-08 批二）：把「ELEV[类型] + 起伏噪声」的示意高程场重铸成有
   真实谷网与连通山脊的场——上采样细分格 → 水力侵蚀（stream-power，Braun-Willett 2013 单遍
   隐式解）→ 坡面扩散。纯函数、确定性（同输入逐位同输出），Worker 与
   主线程回退共用；黄金基准零接触（分类/寻路不读本场）。
   ⚠ 调用门在 erodeInput：「relief=0 且无高程涂改」返 null＝旧 buildElevField 粗格路径逐位不变；
     heightOverrides 栅到粗格后**并入侵蚀基座**（随水系被切割、自带微地形）——手涂高程是雕刻，
     不是要保锐边的盖章（2026-08-08 改判，见 ErodeInput.hovGrid 注）。
   ⚠ 等高线与光标读数与晕渲同走本场（「画尺一致」，2026-08-07 用户拍板）：等高线自此沿真实
     谷线走，旧档（relief>0）读数会移动；战略图与其战术烘焙在同一位置的起伏也从逐位一致降为
     近似一致（侵蚀依赖网格分辨率，噪声输入仍同锚）。 */
import { hash2 as sinHash2 } from "./noise.ts";
import { baseElev, buildSurface, dhOf, DH_EPS, elevBilinear, elevUnitM, landformRel, waterMask, waterSurface, LAND_FLOOR, SHORE_E, SHORE_LAND, WATER_CEIL, WATER_EPS, type ElevField, type FieldGeom } from "./elev.ts";
import { gnoise, makeRelief, mountainness, type ReliefSampler, RELIEF_CARVE_K, RELIEF_MESO_CELLS, RELIEF_GATE_HI, RELIEF_GATE_LO, RELIEF_LAMBDA_KM, RELIEF_M,
  RELIEF_ROUGH_HI, RELIEF_ROUGH_LO, RELIEF_STRIKE, RELIEF_W, RELIEF_E0, RELIEF_E1, RIDGED_MEAN, RIDGED_MEAN3, reliefSeedOf } from "./relief.ts";
import { kmPerDegXY } from "./geo.ts";
import { activeAt } from "./time.ts";
import { buildGridCells, stampRect, type Grid } from "./grid.ts";
import { SCALE_PROFILES, scaleProfile } from "./scale.ts";
import type { BBox, HeightOverride, Meta, TerrainOverride, UpliftOverride, World } from "./types.ts";
import { nestCrop, nestKeyParts, type NestInput, type NestSrc } from "./nested.ts";

/** 侵蚀计算档（meta.erode，设置弹层一行三选）：缺键与非法值＝all。
    all＝自动（涂改后自动重算，落笔先见草稿、算完落地换真形）；base＝手动（只侵蚀 erodeBasis 给的那份，之后的涂改叠在定形后的场上＝笔落即最终，
    点「侵蚀」才把现状收进去重算）；none＝不侵蚀（门恒关＝粗格路径）。 */
export type ErodeMode = "all" | "base" | "none";
export const ERODE_MODES: Record<ErodeMode, { 名: string }> = { all: { 名: "自动" }, base: { 名: "手动" }, none: { 名: "关闭" } };
export function erodeMode(meta: Meta | undefined): ErodeMode {
  const v = (meta || {}).erode;
  return v === "base" || v === "none" ? v : "all";
}

/** 侵蚀看到的三轴涂改 */
export interface ErodeBasis { terrain: TerrainOverride[]; height: HeightOverride[] | undefined; uplift: UpliftOverride[] | undefined }
/** 手动档取 world.baseOverrides 记的那份（轴缺＝现状；整个键缺＝地貌取现状、高程与抬升为空），其余档＝现状。
    host、战术图烘焙与「侵蚀」按钮同读这一处：各读各的，同一份存档换个入口就侵蚀出另一份地形 */
export function erodeBasis(w: World): ErodeBasis {
  const terrain = w.terrainOverrides, height = w.heightOverrides, uplift = w.upliftOverrides;
  if (erodeMode(w.meta) !== "base") return { terrain, height, uplift };
  const b = w.baseOverrides;
  if (!b) return { terrain, height: undefined, uplift: undefined };
  return { terrain: b.terrain ?? terrain, height: b.height ?? height, uplift: b.uplift ?? uplift };
}
/** 手动档下有没有还没收进侵蚀的涂改（「侵蚀」按钮可不可点）：侵蚀看到的某一轴不是现状那份。
    两边都空算相同（没记过的图高程轴读作空），其余只比是不是同一个数组——钉过又画回原样的会多报一次，点了也只是命中缓存 */
export function erodePending(w: World): boolean {
  if (erodeMode(w.meta) !== "base") return false;
  const b = erodeBasis(w), off = (a: unknown[] | undefined, now: unknown[] | undefined): boolean => a !== now && !!((a && a.length) || (now && now.length));
  return off(b.terrain, w.terrainOverrides) || off(b.height, w.heightOverrides) || off(b.uplift, w.upliftOverrides);
}
/** 高程涂改的内容指纹（顺序相关；空与缺同为 ""）：host 判「侵蚀看到的高程涂改变没变」，只在数组引用换了时算 */
export function hovSig(list: HeightOverride[] | undefined): string {
  if (!list || !list.length) return "";
  const f = new Float64Array(6), u = new Uint32Array(f.buffer);
  let a = 0x811c9dc5 | 0, b = 0x6c62272e | 0;
  for (const o of list) {
    f[0] = +o.lon; f[1] = +o.lat; f[2] = +o.dh; f[3] = +(o.step as number) || 0; f[4] = o.since ?? NaN; f[5] = o.until ?? NaN;
    for (let i = 0; i < 12; i++) { a = Math.imul(a ^ u[i], 16777619); b = Math.imul(b ^ u[i], 0x85ebca6b) + i | 0; }
  }
  return list.length + "-" + (a >>> 0).toString(36) + "-" + (b >>> 0).toString(36);
}

export interface ErodeInput {
  bb: BBox; step: number; cols: number; rows: number;
  /** 粗格基础高程（连续基底 core/elev.baseElev：类型阶梯已展成山前带、海床自岸变深） */
  elev0: Float32Array;
  /** 粗格水域掩码（1=地貌轴为水；水面高程恒定＝侵蚀基准面）。⚠ 只认 lf==="water"：沿海与沼泽是陆地，
      要起伏也要被侵蚀；terrainProps.water 是水军通行语义，不是这里的掩码 */
  water: Uint8Array;
  /** 粗格水面高程（core/elev.waterSurface）：水陆判据线（水面 − WATER_EPS）是侵蚀基准面与陆格下限，近岸水格的细格床面
      封在水面 + SHORE_E 以下——取床面当基准面，岸边陆地被刻到线下渲染成水、近岸水格被双线性抬成陆，岸边一圈细陆地夹细水道 */
  wsurf: Float32Array;
  /** meta.relief（0..1；纯涂改图可为 0——涂改自带微地形，见 hovGrid） */
  amp: number;
  /** 起伏种子（core/relief.reliefSeedOf）；sphere＝球面图（起伏按三维取样） */
  seed: number; sphere: boolean;
  /** 细分格预算（工作档取 core/scale 按图种给的 fineCap；精修档经 ultraInput
      提到主机给的精修预算）——随输入走＝Worker 不看 ctx、erodeKey 自然分流；必填（可选+兜底
      会盖住缺省分支，同 upscaleOf cap 之训） */
  cap: number;
  /** 单轴细分上限（工作档 8 / 精修档 16）；必填同 cap 之规 */
  axisMax: number;
  /** 细带波长倍率（工作档恒 1；精修档＝sxU/sxW）：三条**锚定细格**的细带（涂改细噪 λ≈5、雕体
      支脉 λ≈14、表面细节 λ≈3）与坡度键的波长按此放大，使它们的**物理**尺度在两档之间固定。
      不归一时精修档的细带波长随分辨率一起缩而幅度不变＝微坡度陡两三倍：井陉实测每公里坡度
      中位数 精修/工作＝2.23×（p95 仅 1.11＝宏观地貌没变，变的全是细纹），停笔半分钟后硬换上屏
      就成了用户实报的「过一会又回到细密纹理，山地尤其明显」。DIFF/DETAIL_AMP **有意不归一**：
      前者让精修档保留更多真实短波、后者是幅度不是波长——精修更锐仍是本意，变的只是「不许换皮」。 */
  bandS: number;
  /** 河道起始阈值（**当前分辨率的细格数**）：工作档恒 ACRIT_CELLS=300；精修档经 ultraInput
      按 (sxU/sxW)² 放大＝**物理集水面积与工作档一致**——不归一则精修档沟壑密度凭空三倍、
      换档瞬间「换了张图」（Acrit=min(acrit,n/64)×cellKm2，格数×更小的格面积＝更小的 km² 阈值） */
  acrit: number;
  /** 经/纬向 km/度（经向已含中央纬度 cos 折算；细格距离度量用） */
  kmx: number; kmy: number;
  /** 高程涂改栅到粗格的累加场（erodeInput 按 buildElevField 同几何盖章）。
      ⚠ 涂改**并入侵蚀基座**（双线性上采样＝边缘羽化，随水系被真实切割），而非侵蚀后叠平台——
      后者曾把手涂的山渲成一堆糊边方块（2026-08-08 河洛实证）；代价＝读数是「侵蚀后」的值，
      峰顶略低于所涂 dh，属雕刻工具的预期语义 */
  hovGrid: Float32Array;
  /** 米/抽象单位（起伏幅度按米换算用；erodeInput 取 elevUnitM(meta)） */
  unitM: number;
  /** 分块精修的窗口（只由 core/tiles.tileInput 填；缺省＝全图侵蚀，键与输出逐位旧行为），见 ErodeWindow */
  win?: ErodeWindow;
  /** v2 图的中尺度起伏包络（粗格，0..1；core/gen2.gen2Meso）：有它＝elev0 已是中尺度稳态解——不跑粗级、类型基面不扭（谷网不许被扭开）、
      起伏取 amp × 包络且只加 RELIEF_MESO_CELLS 格以下的带。只在有它时进 erodeKey（同 win） */
  mesoEnv?: Float32Array;
  /** v2 图画的盆地（粗格，同 Gen2MesoField.basin）：位 2 的格是局部基准面——细级填洼从它起、侵蚀不动它，闭合盆地才不被填成盆沿高的平台。
      只在有它时进 erodeKey */
  basin?: Uint8Array;
  /** 地貌涂改造成的基面增量（粗格；陆格＝带涂改的 baseElev − 不带涂改的，水格 0）：粗级参照面与涂改盆掩码把它与高程涂改同算。
      只由 erodeInput 挂：粗级 λ > 0 的图，或带中尺度的图上有涂改换了地貌（没有增量不挂）；只在有它时进 erodeKey；窗口单必须按窗裁，否则细级盆掩码按错格取样 */
  lfDelta?: Float32Array;
  /** 嵌套解的外层裁剪（core/tiles.tileInput 给带中尺度的图的块填、workNest 给工作档填；有它的单由 core/nested.nestedField 解，不走本模块）。只在有它时进 erodeKey */
  nest?: NestInput;
  /** 带中尺度的图上地貌涂改换掉地貌的格的起伏权重（粗格，core/elev.landformRel：−1＝没换）：嵌套解收尾的细节权重在这些格上改取它（细级侵蚀不读，靠 lfDelta 认涂改）。
      只在有换掉的格时挂、只在有它时进 erodeKey；窗口单必须按窗裁，窗里没有换掉的格就不带（不带＝那一块的键与输出照旧） */
  lfRel?: Float32Array;
}
/** 粗级切割量（侵蚀后 − 侵蚀前，水域 0）与它的网格几何：只由参照细格定，同一份图的各档、各窗口共用 */
export interface CoarseCarve { data: Float32Array; geo: FieldGeom }
/** 窗口侵蚀的四个约定：粗级不自己算、改用全图那份（窗口太小粗级会被跳过，谷网也不该随窗口变；中尺度图全图也不跑粗级，carve 为 null）；
    起伏带与表面细节按 refS 倍细格取参照（粗级仍按 bandS）；球面走向中心沿用全图的 sc；acrit 已是本档的绝对细格数，不再按格数封顶。
    ⚠ 四项缺一，窗口就与全图同档的结果对不上（谷网、山脉走向或沟壑密度跟着窗口变）。
    coast＝水陆交界一圈的细格按类型基面与水面的等值线定水陆（不照搬父格）：细到看得清父格时，照搬就是一级一级的方台阶岸线 */
export interface ErodeWindow { carve: CoarseCarve | null; refS: number; sc: readonly [number, number] | null; coast: boolean }

/* —— 调参旋钮（观感层；改幅度看 CDP 截图，别背公式）—— */
/* 细分格总数预算按图种分档（2026-08-10 精度批）：战略维持 40 万＝黄金基准与已验收观感逐位不变；
   战术提到 140 万——280 密度新图 ×5＝1400×940≈132 万，旧 140 密度图靠单轴 8× 顶格＝1120×752，
   不重涂也自动更锐。代价＝战术侵蚀单 0.7s→约 2~3s（等待窗有 fieldPlusDelta 预览盖住）、
   缓存单条 3.2→约 10.6MB（fieldcache CAP 随之 20→8）。挑哪档由 erodeInput 按 mapKind 定，
   随输入进 ErodeInput.cap 与 erodeKey＝Worker 不看 ctx、缓存键自然分流。 */
/* 战略 40万→60万(2026-08-13 尺度定形批):战略格边改公里锚定(20/3km)后大陆级区域图网格
   384→200 列,预算不提则细分场 39万→24万=旗舰图显示不升反降;60 万恰令其升到 4×=43 万
   (1.67km 细格)与改前观感持平。大格数图(全球 106 万)细分自然回 1×,耗时账见设计稿。 */
/* 战略 60 万→240 万（2026-09-02）：起伏改公里锚定后，战略图的细节上限不再由「防混叠」定而由
   预算定——区域图（8° 级）自此吃到轴上限 8×＝1.7 km 细格，缩放进去有真形。大陆级图（48°，105 万
   粗格）仍是 1×，放大后的细节归分块精修（core/tiles）。 */
const MAX_FINE = SCALE_PROFILES.strategic.fineCap;
/* 140 万→150 万（2026-09-02）：缺省 60 km 战场 600²×2²＝144 万，恰差 2.8% 拿不到 2×＝缺省尺寸是第一个
   失去细分的尺寸（59 km 有 2×、60 km 没有）；放大看细节时 100 m 工作档露格子。 */
const MAX_FINE_TAC = SCALE_PROFILES.tactical.fineCap;
const ITERS = 6;            // 侵蚀迭代数（隐式解无条件稳定；批6 自 5 上调＝切割深度的老实杠杆）
const KDT = 0.04;           // 河蚀强度 ×dt（f=KDT·√A/dist；A 单位 km²、dist 单位 km）；批6 自 0.022 上调＝
                            //   让谷网切透涂改块的类型缓坡带与雕体侧翼（「珊瑚项圈」要靠径向切割破环，
                            //   雕体的大谷只有侵蚀这台「尺度自适应机器」刻得出——结构带的波长是定死的）
/* 河道起始阈值（单位＝细格数）：D8 最陡下坡在有噪声的均匀斜坡上会长出一片**规则的平行细沟**
   （井陉中景左上实拍的「梳毛纹」）——那是数值产物不是地貌。真实地形里河道要汇够面积才切得动，
   坡面归风化与扩散管。按 w=A/(A+Ac) 压制：A≫Ac 的干流逐位近似不受影响，A=Ac 时半强，
   坡面被平方律压下去，故是「压制」不是「一刀切」（硬阈值会在河源处留下可见的起切台阶）。
   ⚠ 起初试的 25 格毫无效果——坡面上 √A 本就极小，压制的是本来就可忽略的项。批5 曾取 2000
   （≈2.3km² 现实河源量级），批6 回拨到 300：2000 连同手雕体/山地坡面的**全部**支沟一起压没
   （雕体汇流至多几百格，w≤0.2＝「高程编辑回到塑料感」实证病根之一）；平行冲沟的病根另治——
   宏观山系结构（RIDGE_*）把汇流组织成谷网后，匀坡病理场本身就少了。
   ⚠ 必须随网格规模封顶：小网格（4×4 夹具上采样后仅 1024 细格）会因阈值大于全域面积而被
   整体关死侵蚀，「侵蚀真的发生」这条契约就没了。 */
const ACRIT_CELLS = 300;
const DIFF = 0.17;          // 坡面扩散系数/迭代（4 邻均值回拉；模拟风化把 V 谷肩磨圆）
const POST_DIFF = 3;        // 收尾追加扩散轮数（批5 曾 8＝把手雕细噪连同冲沟一起磨平，批6 回拨；表面质感另由 DETAIL_AMP 侵蚀后补齐）
/* 类型基面采样域扭曲：两个八度（λ≈9 粗格 ±1.2 格 + λ≈3.5 粗格 ±0.6 格）——单短波只会让台阶圈
   高频抖动而环仍是环（「珊瑚项圈」实拍），长波才把山缘扭出进退错落的山嘴与山坳；
   合幅 ≤1.8 格＝近岸水陆掩码错位可控。雕痕(hovGrid)不扭＝落在用户画的地方，水域不扭＝基准面逐位 */
const WARP1 = 1.2, WARP2 = 0.6;     // ×粗格距
const TYPE_FEATHER = 0.6;           // 类型基面 4 抽头帐篷羽化半距（×粗格距）：单格宽的类型陡坎摊成 ~2 格
                                    //   山前缓坡带，方齿台阶角被抹圆（晕渲实拍「两圈方齿」之药）
const DETAIL_AMP = 0.15;            // 侵蚀后表面细节幅（λ≈3 细格）：扩散磨不掉的收尾质感；
                                    //   ⚠ 只作细脆度地板，大了＝全图均匀砂纸（首版 0.5 踩过、0.25 仍偏噪）
/* 细节的键＝坡度键（2026-09-02 起去掉类型/雕体系数键）：**粗糙度的老实判据是坡度**——低而陡的
   雕崖该嶙峋、高而缓的丘顶该平滑；类型键曾让整片山地丘陵不分坡缓坡陡一律满幅细糙＝夸张修正后
   仍读作均匀颗粒。坡度取**侵蚀后**的最终场（沟壁天然带糙），逐格中央差读快照防次序依赖。 */
const DETAIL_SLOPE_K = 12, DETAIL_SLOPE_CAP = 0.45;   // 每**参照**细格抽象坡 → 键（0.03/格≈45° 崖 → 0.36；见 ErodeInput.bandS）
const EPS = 1e-5;           // 洼地填平的单调排水梯度（抽象高程/格）
/* 多重网格（2026-09-07）：树枝状谷网要几十轮 stream-power 才组织得起来，细格上跑不起；先在参照细格
   ×COARSE_K 的粗级跑 COARSE_ITERS 轮，把粗级的切割量双线性铺回细格，再由细级 ITERS 轮刻支沟。
   ⚠ 粗级只由**参照细格**定＝工作档与精修档共用同一粗级（换档不换谷网）。 */
const COARSE_K = 4;
const COARSE_ITERS = 48;
const COARSE_DIFF = 0.06;   // 粗级扩散系数（雕体路主导的格，也是物理扩散的地板）：取细级的 0.17 会把刚切出的谷肩磨回去
const COARSE_MIN = 24;      // 粗级任一轴少于此格数不做（夹具级小网格，谷网无处可长）
/* 粗级扩散按物理量纲：类型路主导的格逐格系数＝4·COARSE_D_KM2/粗格边²（km），不低于 COARSE_DIFF。
   按格无量纲时谷距是网格尺度的成谷失稳（约 5 个粗格一条），格越细刮痕越密；
   ⚠ 只给类型路（起伏滑杆 > 0 且类型山地度 ≥ 雕体山地度）＋地板：真高程、手雕图与粗格图逐位不变 */
const COARSE_D_KM2 = 7.5e-4;
/** 粗级扩散对涂改本身（高程涂改与地貌涂改的基面增量）的磨平上限（σ，km）：粗格边约 3.3 km 以下时不起作用，战术图与细格战略图逐位不变 */
const COARSE_CARVE_SIG_KM = 4;
/** 涂改造出的闭合洼地的判据（米）：(基面 + 涂改) 的填深比基面自己的多出这么多，才算用户画的盆 */
const CARVED_BASIN_M = 0.5;
const DIFF_MONO = 0.5;     // 显式 4 邻扩散的单调上限：逐格系数超过它就拆子步（超 0.5 出棋盘振荡、超 1 发散）

/** 细分倍率：总格数不超预算 cap、单轴不超 axisMax（48×32 战略@40万,8→8×；140×94 战术@140万,8→8×、
    280×188 战术@140万,8→5×；精修档 axisMax=16：240×161@1050万→16×＝3840×2576）。
    cap/axisMax 必填——「可选参数+内部兜底常数」会让平价测试盖住缺省分支（haversine R 之训）。 */
export function upscaleOf(cols: number, rows: number, cap: number, axisMax: number): number {
  let sx = 1;
  while (sx < axisMax && cols * (sx + 1) * rows * (sx + 1) <= cap) sx++;
  return sx;
}

/* —— 结果缓存的键（2026-08-09）：侵蚀是纯函数（同输入逐位同输出，worker.test 确定性用例锁着），
   结果按「算法指纹＋输入内容」寻址缓存（data/fieldcache，host 消费）——开图/撤销/拨回看过的
   年份免去 1~2s 重算，「先粗后细」的可见换场（用户实报读感像「还在施工/出错了」）就不再发生。
   指纹自动涵盖上方全部旋钮值；⚠ 改**公式/流程**而不动旋钮的数值行为变更须 EALGO+1，
   否则旧缓存会以旧观感还魂。 */
/** 中尺度路径的代号（只混进带 mesoEnv 的单的键）：这条路径的流程变了而旋钮没变时加一。不进 KNOB_FP——进了就让全部旧图的缓存作废 */
const MESO_EALGO = 2;
/** 中尺度图细级侵蚀的汇流微地形（米；波长 km 与权重）：平原的基底近乎匀坡，D8 下切沿格轴与对角刻成直沟——侵蚀前叠上、侵蚀后减掉，地形本身不动 */
const MESO_MICRO_M = 8, MESO_MICRO_KM: readonly [number, number][] = [[15, 1], [6, 0.5]];
/** 负高程涂改那条路径的代号（只混进带负涂改的细级侵蚀单的键）：陆地地板随涂改下移的做法变了而旋钮没变时加一。不进 KNOB_FP，理由同 MESO_EALGO */
const HOV_EALGO = 1;
const EALGO = 14;   // 14=地貌涂改的基面增量与高程涂改同作粗级参照面、同进涂改盆掩码；13=粗级扩散对涂改的磨平按 σ≤4 km 封顶、涂改造出的闭合洼地不填平；12=起伏球面按三维取样、梯度集避开坐标轴、起伏种子分存；11=不再烘焙投影阴影（只留晕渲）；10=投影阴影光向改西北；9=侵蚀基准面与陆格下限取水陆判据线；8=粗级扩散按 km²（只给类型路）；7=多重网格（粗级先长谷网）；6=起伏改公里锚定的异质多尺度脊线场（core/relief），5=连续基底，4=细带归一，3=4K 精修
const KNOB_FP = [EALGO, MAX_FINE, MAX_FINE_TAC, ITERS, KDT, ACRIT_CELLS, DIFF, POST_DIFF, COARSE_K, COARSE_ITERS, COARSE_DIFF, COARSE_MIN, COARSE_D_KM2, COARSE_CARVE_SIG_KM, CARVED_BASIN_M, DIFF_MONO,
  WARP1, WARP2, TYPE_FEATHER, DETAIL_AMP, DETAIL_SLOPE_K, DETAIL_SLOPE_CAP, EPS,
  RELIEF_M, RELIEF_LAMBDA_KM, RELIEF_W, RELIEF_GATE_LO, RELIEF_GATE_HI, RELIEF_ROUGH_LO, RELIEF_ROUGH_HI,
  RELIEF_STRIKE, RELIEF_E0, RELIEF_E1, RELIEF_CARVE_K, RIDGED_MEAN, RIDGED_MEAN3].join("|");

/** 算法代号（指纹的 36 进制缩写）：erodeKey 的前缀；fieldcache 开库时清掉不同代的存货 */
export const ERODE_VER: string = (() => {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < KNOB_FP.length; i++) h = Math.imul(h ^ KNOB_FP.charCodeAt(i), 16777619);
  return "e" + (h >>> 0).toString(36);
})();

/** 侵蚀输入的内容键：FNV-1a 双流 64 位＋算法代前缀，同键＝同输出；键的数学（字序、双流常数、长度前缀）一个字不许动，换了就是整库缓存作废。
    ⚠ 折叠循环的状态放局部变量：经闭包写外层变量的写法在 Chromium 上慢十倍（196 万格 171ms → 15ms，2026-09-21 实测）；
    只该在发侵蚀单时算一次。 */
export function erodeKey(inp: ErodeInput): string {
  let a = 0x811c9dc5 | 0, b = 0x6c62272e | 0;
  const mixA = (u: Uint32Array | Uint8Array): void => {
    let la = a, lb = b, x = u.length;
    la = Math.imul(la ^ (x & 0xffff), 16777619); la = Math.imul(la ^ (x >>> 16), 16777619);
    lb = Math.imul(lb ^ (x >>> 16), 0x85ebca6b); lb = Math.imul(lb ^ (x & 0xffff), 0x85ebca6b);
    for (let i = 0; i < u.length; i++) {
      x = u[i];
      la = Math.imul(la ^ (x & 0xffff), 16777619); la = Math.imul(la ^ (x >>> 16), 16777619);
      lb = Math.imul(lb ^ (x >>> 16), 0x85ebca6b); lb = Math.imul(lb ^ (x & 0xffff), 0x85ebca6b);
    }
    a = la; b = lb;
  };
  const head = new Float64Array([inp.bb.lonMin, inp.bb.latMin, inp.bb.lonMax, inp.bb.latMax,
    inp.step, inp.cols, inp.rows, inp.amp, inp.seed, inp.kmx, inp.kmy, inp.cap, inp.axisMax, inp.acrit, inp.bandS, inp.unitM, inp.sphere ? 1 : 0]);
  mixA(new Uint32Array(head.buffer));
  mixA(new Uint32Array(inp.elev0.buffer, inp.elev0.byteOffset, inp.elev0.length));   // 整段独立分配＝偏移恒 4 对齐
  mixA(inp.water);
  mixA(new Uint32Array(inp.hovGrid.buffer, inp.hovGrid.byteOffset, inp.hovGrid.length));
  mixA(new Uint32Array(inp.wsurf.buffer, inp.wsurf.byteOffset, inp.wsurf.length));
  const w = inp.win;
  if (w) {   // 只在窗口单上追加：全图单的键一个字不变
    const g = w.carve ? w.carve.geo : null;
    mixA(new Uint32Array(new Float64Array([w.refS, w.sc ? w.sc[0] : NaN, w.sc ? w.sc[1] : NaN, g ? g.bb.lonMin : NaN, g ? g.bb.latMin : NaN, g ? g.step : NaN, g ? g.cols : NaN, g ? g.rows : NaN, w.coast ? 1 : 0]).buffer));
    if (w.carve) mixA(new Uint32Array(w.carve.data.buffer, w.carve.data.byteOffset, w.carve.data.length));
  }
  const me = inp.mesoEnv;
  if (me) {   // 同理只在中尺度单上追加
    mixA(new Uint32Array(new Float64Array([MESO_EALGO, RELIEF_MESO_CELLS, MESO_MICRO_M, ...MESO_MICRO_KM.flat()]).buffer));
    mixA(new Uint32Array(me.buffer, me.byteOffset, me.length));
  }
  if (inp.basin) mixA(inp.basin);   // 同理只在画了盆地的单上追加
  if (inp.lfDelta) mixA(new Uint32Array(inp.lfDelta.buffer, inp.lfDelta.byteOffset, inp.lfDelta.length));   // 同理只在有地貌涂改增量的单上追加
  if (inp.nest) for (const a of nestKeyParts(inp.nest)) mixA(a);   // 同理只在嵌套解的块单上追加
  if (inp.lfRel) mixA(new Uint32Array(inp.lfRel.buffer, inp.lfRel.byteOffset, inp.lfRel.length));   // 同理只在涂改换了地貌的中尺度单上追加
  if (!inp.nest && inp.hovGrid.some(v => v < -DH_EPS)) mixA(new Uint32Array([HOV_EALGO]));   // 同理只在带负高程涂改的细级侵蚀单上追加
  return ERODE_VER + "-" + (a >>> 0).toString(36) + "-" + (b >>> 0).toString(36);
}

/** 侵蚀门（2026-08-13 延迟组装批）：与 erodeInput 的「返 null」判据同一条——relief>0，或有
    当刻生效、dh≠0、且**落得进图幅**的手雕高程（单格章=所在格在界内;粗块章=覆盖域与网格相交）。
    host 在 rebuild 同拍只问门（轻,O(涂改数)零分配）,数组组装挪到防抖结算时——erodeInput 每次
    组装分配 ~13B/格,196 万格图上每笔 move 白扔 26MB。⚠ 判据须与 erodeInput 逐位同判
    （「门的判定与等待窗显示分支同源」之约由此担保;worker.test 拿随机夹具锁 gate===(input!==null)）。 */
export function erodeGate(meta: Meta | undefined, hov: HeightOverride[] | undefined, grid: Grid, yearNow: number): boolean {
  const m = meta || {};
  if (erodeMode(m) === "none") return false;   // 关闭档：门恒关（与 erodeInput 同判）
  if (Math.max(0, Math.min(1, +(m.relief as number) || 0)) > 0) return true;
  for (const o of hov || []) {
    if (!activeAt(o, yearNow)) continue;
    const dh = dhOf(o, m); if (!dh) continue;
    if (stampRect(o, grid)) return true;
  }
  return false;
}

/** 组装侵蚀输入（主线程侧）。「relief=0 且无高程涂改」返 null＝旧粗格路径逐位不变契约；
    有涂改即侵蚀——手涂高程正是最该被水系切出真形的地方（2026-08-08 改判，此前 relief=0
    一刀切走旧路径，纯手雕的战术图 800 章全渲成糊边方块）。 */
export function erodeInput(meta: Meta | undefined, hov: HeightOverride[] | undefined,
  grid: Grid, yearNow: number): ErodeInput | null {
  const m = meta || {};
  if (erodeMode(m) === "none") return null;   // 关闭档（与 erodeGate 同判）
  const amp = Math.max(0, Math.min(1, +(m.relief as number) || 0));
  const { bb, step, cols, rows } = grid;
  /* 涂改先栅到粗格（几何走 stampRect，与 buildGridCells / buildElevField 的盖章同一份） */
  const hovGrid = new Float32Array(rows * cols);
  let hasHov = false;
  for (const o of hov || []) {
    if (!activeAt(o, yearNow)) continue;
    const dh = dhOf(o, m); if (!dh) continue;
    const rc = stampRect(o, grid);
    if (!rc) continue;
    for (let r = rc.r0; r <= rc.r1; r++) for (let c = rc.c0; c <= rc.c1; c++) hovGrid[r * cols + c] += dh;
    hasHov = true;
  }
  if (amp <= 0 && !hasHov) return null;
  const water = waterMask(grid), ws0 = waterSurface(m, grid), wsurf = hasHov ? buildSurface(m, hov, grid, yearNow).wsurf : ws0;
  /* 没有涂改动到水面时三份都是按 Grid 记忆的共享只读数组（postMessage 克隆）；湖面被岸边的涂改带着走了，水格床面跟着平移 */
  let elev0 = baseElev(m, grid);
  if (wsurf !== ws0) {
    elev0 = elev0.slice();
    for (let i = 0; i < elev0.length; i++) if (water[i] && wsurf[i] !== ws0[i]) elev0[i] += wsurf[i] - ws0[i];
  }
  const { kmx, kmy } = kmPerDegXY(m, bb);
  const cap = scaleProfile(m).fineCap, menv = grid.meso ? grid.meso.env : null, bas = grid.meso ? grid.meso.basin : null;
  const cg = coarseGeom(cols, rows, step, step / upscaleOf(cols, rows, cap, 8));
  /* 中尺度图：只在地貌涂改换掉了地貌时挂增量（涂出来的闭合洼地靠它不被细级填洼填平）与起伏权重；没涂过的图两样都不挂，键与输出照旧 */
  const rel = menv ? landformRel(grid) : null;
  const lfd = (menv ? !!rel : cg && carveLam(cg.cstep * Math.sqrt(kmx * kmy)) > 0) ? landformDelta(m, grid) : null;
  return { bb, step, cols, rows, elev0, water, wsurf, amp, seed: reliefSeedOf(m), sphere: m.worldModel !== "flat", kmx, kmy, hovGrid,
    cap, axisMax: 8, acrit: ACRIT_CELLS, bandS: 1, unitM: elevUnitM(m), ...(menv ? { mesoEnv: menv } : {}), ...(bas ? { basin: bas } : {}), ...(lfd ? { lfDelta: lfd } : {}), ...(rel ? { lfRel: rel } : {}) };
}

/* 按 Grid 实例记忆（同一 Grid 只配一份 meta，同 core/elev 的派生场）：高程笔每笔复用 Grid＝不重算 */
const lfMemo = new WeakMap<Grid, Float32Array | null>();
/** 地貌涂改造成的基面增量（ErodeInput.lfDelta）：与不带涂改的底稿逐格比，没有改过地类的格或增量处处为 0 时返 null */
function landformDelta(m: Meta, grid: Grid): Float32Array | null {
  const hit = lfMemo.get(grid);
  if (hit !== undefined) return hit;
  const g0 = buildGridCells(m, [], 0, grid.meso);   // 不带涂改的底稿：带中尺度的图按同一份中尺度场判
  let out: Float32Array | null = null;
  if (g0.cells.some((row, r) => row.some((t, c) => t !== grid.cells[r][c]))) {
    const b1 = baseElev(m, grid), b0 = baseElev(m, g0), water = waterMask(grid), d = new Float32Array(b1.length);
    let any = false;
    for (let i = 0; i < d.length; i++) if (!water[i] && b1[i] !== b0[i]) { d[i] = b1[i] - b0[i]; any = true; }
    if (any) out = d;
  }
  lfMemo.set(grid, out);
  return out;
}

/** 精修档输入（没有块计划的图，与工作档同一帧换上）：同一份工作档输入换预算——数组共享引用（Worker 侧
    postMessage 自会克隆）、axisMax 提到 16、acrit 按 (sxU/sxW)² 放大＝物理集水阈值与工作档
    一致（见 ErodeInput.acrit 注）。ultraCap 由主机按 deviceMemory 分档传入。
    ⚠ 倍率提不上去＝返 null 不发精修单（2026-08 审查修正）：低内存档 5.25M 预算撞上 196 万格
    大战场时 sxU==sxW，同一几何在不同缓存键下整个重算一遍＝半分钟白算＋一条重复缓存；
    工作档场就是终态，host 对 null 的处置（不排精修）现成。 */
export function ultraInput(inp: ErodeInput, ultraCap: number): ErodeInput | null {
  if (inp.nest) return null;   // 工作档是嵌套解的图不精修：精修档是细级侵蚀，中景的谷会与工作档的等高线分家；放大后的细节归块层
  const sxW = upscaleOf(inp.cols, inp.rows, inp.cap, inp.axisMax);
  const sxU = upscaleOf(inp.cols, inp.rows, ultraCap, 16);
  if (sxU <= sxW) return null;
  return { ...inp, cap: ultraCap, axisMax: 16, acrit: inp.acrit * (sxU / sxW) * (sxU / sxW), bandS: sxU / sxW };
}

/** 工作档改走嵌套解的最低细分倍率：整球这类 1 倍的图细格比河道起始面积还粗（每个节点都成河道），照旧细级侵蚀 */
export const WORK_NEST_MIN = 2;
/**
 * 带中尺度的 v2 图的工作档：全图一窗走块层同一套嵌套解（core/nested），倍率同本图的细级侵蚀工作档（只由常数预算定，与本机无关）；
 * 倍率不到 WORK_NEST_MIN 原样返回。产出的单不带包络与粗级（嵌套解不读），带外层的全图裁剪与抬升到目标的各区（校峰）。
 * @param nest 这份输入出自的中尺度场给嵌套解的那份（同一 Grid）：换一份就是另一张图的谷网
 */
export function workNest(inp: ErodeInput, nest: NestSrc): ErodeInput {
  const sx = upscaleOf(inp.cols, inp.rows, inp.cap, inp.axisMax);
  if (sx < WORK_NEST_MIN || inp.win || inp.nest) return inp;
  const { mesoEnv: _m, lfDelta: _l, ...rest } = inp;
  return { ...rest, nest: nestCrop({ base: nest.base, sol: nest.sol }, 0, inp.cols, 0, inp.rows, 0, inp.cols, 0, inp.rows, sx, inp.bb.lonMin, inp.bb.latMin, inp.step, true, true) };
}

/* —— 行滑动值噪声/fbm（2026-08-09 提速批）：erodeField 全部按行扫描——y 不变时 xi+1 的新四角
   恰是旧四角右移（新a=旧b、新c=旧d），补两次 sin 哈希即可；跳档/换行整组重算＝任何访问形态
   都正确。与 core/noise 的 vnoise/fbm **同式**（八度权/频与求和序逐项对照；x*1===x、0+x===x
   皆位级恒等），返回值逐位同（worker.test 直比 + 提速神谕锁）。⚠ 每个调用位各持一套滑窗态
   （rowFbm() 工厂），共享实例＝交替采样互相冲掉滑窗、退化为全重算。 */
const rowNoise = (): ((x: number, y: number) => number) => {
  let cxi = NaN, cyi = NaN, a = 0, b = 0, c = 0, d = 0;
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    if (xi !== cxi || yi !== cyi) {
      if (yi === cyi && xi === cxi + 1) { a = b; c = d; b = sinHash2(xi + 1, yi); d = sinHash2(xi + 1, yi + 1); }
      else { a = sinHash2(xi, yi); b = sinHash2(xi + 1, yi); c = sinHash2(xi, yi + 1); d = sinHash2(xi + 1, yi + 1); }
      cxi = xi; cyi = yi;
    }
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
};
/** 行滑动 fbm（导出仅供测试直比 core/noise.fbm） */
export const rowFbm = (): ((x: number, y: number) => number) => {
  const o0 = rowNoise(), o1 = rowNoise(), o2 = rowNoise(), o3 = rowNoise();
  return (x, y) => 0.5 * o0(x, y) + 0.25 * o1(x * 2, y * 2) + 0.125 * o2(x * 4, y * 4) + 0.0625 * o3(x * 8, y * 8);
};

/** 一级网格上的 stream-power 侵蚀：iters 轮（填洼 → D8 受水者 → 汇流面积 → 隐式下切 → 扩散）＋ postDiff 轮
    收尾扩散，原地改 L.h；水域格与图幅边缘是基准面，不动。mfd＝汇流面积多向分配（粗级必开：D8 在匀坡上
    把水束成沿格轴的平行沟，几十轮就是一把梳子）；下切仍沿最陡受水者解，隐式解要单受水者。 */
interface Level {
  h: Float32Array; wat: Uint8Array; FC: number; FR: number; fstep: number; kmx: number; kmy: number; acritKm2: number;
  /** 逐格扩散系数（有则替代 diff） */
  dcell?: Float64Array | null;
  /** 扩散的参照面（有则只磨 h − ref）：中尺度图传基底（峰按它标定，再磨就低了）；粗级传 λ × 涂改（见 COARSE_CARVE_SIG_KM） */
  ref?: Float32Array;
  /** 填洼只给路由、不写回的格（涂改造出的闭合洼地）：写回会把用户画的盆填成盆沿高的平台 */
  keep?: Uint8Array | null;
}
function streamPower(L: Level, iters: number, diff: number, postDiff: number, mfd: boolean): void {
  const { h, wat, FC, FR, fstep, kmx, kmy, acritKm2: Acrit, dcell, ref } = L, n = FC * FR, keep = L.keep || null;
  const hf = keep ? new Float32Array(n) : h;   // 路由面（填洼后）：没有 keep 时就是 h 本身＝填高写回，逐位旧行为
  let lapRef: Float32Array | null = null;   // 参照面的 4 邻拉普拉斯：扩散减去它＝只磨高出参照面的那部分
  if (ref) {
    lapRef = new Float32Array(n);
    for (let r = 1; r < FR - 1; r++) for (let c = 1; c < FC - 1; c++) { const i = r * FC + c; lapRef[i] = (ref[i - 1] + ref[i + 1] + ref[i - FC] + ref[i + FC]) * 0.25 - ref[i]; }
  }
  /* 8 邻表与距离（km；经向已折 cos） */
  const NB = [-FC - 1, -FC, -FC + 1, -1, 1, FC - 1, FC, FC + 1];
  const dxs = [1, 0, 1, 1, 1, 1, 0, 1], dys = [1, 1, 1, 0, 0, 1, 1, 1];
  const DK: number[] = NB.map((_, i) => Math.hypot(dxs[i] * fstep * kmx, dys[i] * fstep * kmy));
  const DXNB = [-1, 0, 1, -1, 1, -1, 0, 1];   // NB 各邻的 Δ列（行回绕判据；配合 0≤nb<n＝旧 inGrid 同一接受集）

  /* 4 叉堆（h 升序、平手按索引＝确定性；0 基，父=(i-1)>>2）。键随堆携带（push 时快照 h——
     flood 里格子只在 close 前被抬升、close 即 push，此后 h 不再动＝快照恒有效），省掉 sift 里对
     h 的间接读；4 叉深度减半、下滤比较有局部性。⚠ 逐位安全的依据：严格全序（h 同则索引分
     胜负，重复索引不存在）下每次弹出都是当前集合的**唯一**最小元，任何正确的优先队列弹出序
     都相同——堆的叉数/形状不进输出（2026-08-09 提速批，神谕哈希三输入逐位核过）。 */
  const heap = new Int32Array(n), heapK = new Float64Array(n); let hn = 0;

  /* 洼地填平（priority flood + ε 排水坡）：边界=水域与图幅边缘。侵蚀会再挖新洼，每轮重填 */
  const closed = new Uint8Array(n);
  const order = mfd ? new Int32Array(n) : null;   // 弹出序：键非降＝按高程升序的拓扑序（多向汇流倒着走）
  let popN = 0;
  const flood = (): void => {
    closed.fill(0); hn = 0; popN = 0;
    if (keep) hf.set(h);
    const push = (v: number, key: number): void => {
      let i = hn++;
      while (i > 0) {
        const p = (i - 1) >> 2, pk = heapK[p];
        if (key < pk || (key === pk && v < heap[p])) { heap[i] = heap[p]; heapK[i] = pk; i = p; }
        else break;
      }
      heap[i] = v; heapK[i] = key;
    };
    for (let r = 0; r < FR; r++) for (let c = 0; c < FC; c++) {
      const i = r * FC + c;
      if (wat[i] || c === 0 || r === 0 || c === FC - 1 || r === FR - 1) { closed[i] = 1; push(i, hf[i]); }
    }
    while (hn > 0) {
      const c = heap[0], ck = heapK[0];   // 顶＝当前最小；ck===h[c]（close 后 h 不动）
      if (order) order[popN++] = c;
      const lv = heap[--hn], lk = heapK[hn];   // 末元下滤补位
      let i = 0;
      for (;;) {
        const c0 = i * 4 + 1;
        if (c0 >= hn) break;
        let m = c0, mk = heapK[c0];
        const ce = c0 + 4 < hn ? c0 + 4 : hn;
        for (let j = c0 + 1; j < ce; j++) {
          const jk = heapK[j];
          if (jk < mk || (jk === mk && heap[j] < heap[m])) { m = j; mk = jk; }
        }
        if (mk < lk || (mk === lk && heap[m] < lv)) { heap[i] = heap[m]; heapK[i] = mk; i = m; }
        else break;
      }
      heap[i] = lv; heapK[i] = lk;
      const x = c % FC;
      for (let k = 0; k < 8; k++) {
        const dx = DXNB[k];
        if (dx < 0 ? x === 0 : dx > 0 && x === FC - 1) continue;
        const nb = c + NB[k];
        if (nb < 0 || nb >= n || closed[nb]) continue;
        closed[nb] = 1;
        if (!wat[nb] && hf[nb] <= ck) { hf[nb] = ck + EPS; if (keep && !keep[nb]) h[nb] = hf[nb]; }
        push(nb, hf[nb]);
      }
    }
  };

  const rcv = new Int32Array(n), rdist = new Float32Array(n);
  const A = new Float32Array(n);
  const stack = new Int32Array(n), ndon = new Int32Array(n), don = new Int32Array(n), donPos = new Int32Array(n), fillBuf = new Int32Array(n);
  const cellKm2 = (fstep * kmx) * (fstep * kmy);
  const h2 = new Float32Array(n);
  /* 多向汇流（Quinn 1991：按坡度分给所有下坡邻）。走 flood 弹出序的**倒序**＝按高程降序，
     填洼后严格单调、任何下坡路由都合法，免去每轮一次全场排序。水域格只收不发＝汇口。 */
  const mw = new Float64Array(8);
  const accumulateMFD = (): void => {
    for (let s = popN - 1; s >= 0; s--) {
      const c = order![s];
      if (wat[c]) continue;
      const x = c % FC, hc = hf[c];
      let sum = 0;
      for (let k = 0; k < 8; k++) {
        mw[k] = 0;
        const dx = DXNB[k];
        if (dx < 0 ? x === 0 : dx > 0 && x === FC - 1) continue;
        const nb = c + NB[k];
        if (nb < 0 || nb >= n) continue;
        const d = hc - hf[nb];
        if (d <= 0) continue;
        mw[k] = d / DK[k]; sum += mw[k];
      }
      if (sum <= 0) continue;
      const a = A[c] / sum;
      for (let k = 0; k < 8; k++) if (mw[k] > 0) A[c + NB[k]] += a * mw[k];
    }
  };
  /* 坡面扩散（4 邻均值回拉；水域与边缘不动） */
  let dMax = diff;
  if (dcell) { dMax = 0; for (let i = 0; i < n; i++) if (dcell[i] > dMax) dMax = dcell[i]; }
  const nsub = Math.max(1, Math.ceil(dMax / DIFF_MONO));
  const dstep = dcell ? dcell.map(v => v / nsub) : null;
  const diffuse = (): void => {
    for (let q = 0; q < nsub; q++) {
      h2.set(h);
      for (let r = 1; r < FR - 1; r++) for (let c = 1; c < FC - 1; c++) {
        const i = r * FC + c;
        if (wat[i]) continue;
        h2[i] = h[i] + (dstep ? dstep[i] : diff) * ((h[i - 1] + h[i + 1] + h[i - FC] + h[i + FC]) * 0.25 - h[i] - (lapRef ? lapRef[i] : 0));
      }
      h.set(h2);
    }
  };

  for (let it = 0; it < iters; it++) {
    flood();
    /* 受水者：最陡下坡邻格；水域与无下坡＝自身（基准面/汇口）。内域（四边内缩一格）八邻恒
       有效＝免逐邻越界/回绕判（此段是迭代 × 全格 × 8 邻的热路，原 inGrid 每邻两次取模）；
       边缘格走带判分支。邻序 0..7 两支不变＝「平手取先遇邻」逐位保持。 */
    for (let c = 0; c < n; c++) { rcv[c] = c; rdist[c] = 1; }
    for (let r = 0; r < FR; r++) {
      const rEdge = r === 0 || r === FR - 1;
      for (let x = 0; x < FC; x++) {
        const c = r * FC + x;
        if (wat[c]) continue;
        let bs = 0, bi = -1;
        const hc = hf[c];
        if (rEdge || x === 0 || x === FC - 1) {
          for (let i = 0; i < 8; i++) {
            const dx = DXNB[i];
            if (dx < 0 ? x === 0 : dx > 0 && x === FC - 1) continue;
            const nb = c + NB[i];
            if (nb < 0 || nb >= n) continue;
            if (hf[nb] < hc) { const s = (hc - hf[nb]) / DK[i]; if (s > bs) { bs = s; bi = i; } }
          }
        } else {
          for (let i = 0; i < 8; i++) {
            const nb = c + NB[i];
            if (hf[nb] < hc) { const s = (hc - hf[nb]) / DK[i]; if (s > bs) { bs = s; bi = i; } }
          }
        }
        if (bi >= 0) { rcv[c] = c + NB[bi]; rdist[c] = DK[bi]; }
      }
    }
    /* Braun-Willett 栈序：汇口起、供水者深搜 */
    ndon.fill(0);
    for (let c = 0; c < n; c++) if (rcv[c] !== c) ndon[rcv[c]]++;
    donPos[0] = 0;
    for (let c = 1; c < n; c++) donPos[c] = donPos[c - 1] + ndon[c - 1];
    fillBuf.set(donPos);   // 复用缓冲（原每迭代 slice 一份 1.3MB）
    for (let c = 0; c < n; c++) if (rcv[c] !== c) don[fillBuf[rcv[c]]++] = c;
    let sp = 0;
    for (let c = 0; c < n; c++) if (rcv[c] === c) {
      let top = sp; stack[sp++] = c;
      while (top < sp) { const v = stack[top++]; const p0 = donPos[v], p1 = p0 + ndon[v]; for (let p = p0; p < p1; p++) stack[sp++] = don[p]; }
    }
    /* 汇流面积（栈逆序向下游累加）与隐式下切（栈正序：受水者先解） */
    A.fill(cellKm2);
    if (mfd) accumulateMFD();
    else for (let s = n - 1; s >= 0; s--) { const c = stack[s]; if (rcv[c] !== c) A[rcv[c]] += A[c]; }
    for (let s = 0; s < n; s++) {
      const c = stack[s], r = rcv[c];
      if (r === c || wat[c]) continue;
      if (keep && (hf[c] > h[c] || h[r] >= h[c])) continue;   // 积水的盆里不下切；受水者不比自己低时下切会把格往上抬
      const f = KDT * Math.sqrt(A[c]) * (A[c] / (A[c] + Acrit)) / rdist[c];   // 河道起始压制，见 ACRIT_CELLS
      h[c] = (h[c] + f * h[r]) / (1 + f);
    }
    diffuse();
  }
  for (let k = 0; k < postDiff; k++) diffuse();   // 收尾磨圆：压掉陡壁上的平行冲沟毛刺与迭代台痕
}

/** 涂改造出的闭合洼地（Level.keep）：(base + hb) 的填深比不带涂改的基面 (base − lf) 多出 CARVED_BASIN_M 的非基准面格；没有返 null。
    base＝带地貌涂改的基面，hb＝高程涂改，lf＝地貌涂改的基面增量（null 按 0）。出口与 streamPower 的填洼同为基准面格（lev）与图幅边——窗口单因此按窗口边判，与全图同处一致 */
function carvedBasins(base: Float32Array, hb: Float32Array | null, lf: Float32Array | null, lev: Uint8Array, FC: number, FR: number, unitM: number): Uint8Array | null {
  const n = FC * FR, z = new Float32Array(n), d0 = new Float32Array(n), d1 = new Float32Array(n);
  const heap = new Int32Array(n), key = new Float64Array(n), closed = new Uint8Array(n);
  const depth = (withHb: boolean, out: Float32Array): void => {   // 填平值与弹出次序无关，二叉堆平手不必定序
    for (let i = 0; i < n; i++) z[i] = withHb ? (hb ? base[i] + hb[i] : base[i]) : lf ? base[i] - lf[i] : base[i];
    closed.fill(0);
    let hn = 0;
    const push = (v: number, k: number): void => {
      let i = hn++;
      while (i > 0) { const p = (i - 1) >> 1; if (key[p] <= k) break; heap[i] = heap[p]; key[i] = key[p]; i = p; }
      heap[i] = v; key[i] = k;
    };
    for (let r = 0; r < FR; r++) for (let c = 0; c < FC; c++) {
      const i = r * FC + c;
      if (lev[i] || c === 0 || r === 0 || c === FC - 1 || r === FR - 1) { closed[i] = 1; out[i] = 0; push(i, z[i]); }
    }
    while (hn > 0) {
      const c = heap[0], ck = key[0];
      if (--hn > 0) {
        const lv = heap[hn], lk = key[hn];
        let i = 0;
        for (;;) {
          let m = 2 * i + 1;
          if (m >= hn) break;
          if (m + 1 < hn && key[m + 1] < key[m]) m++;
          if (key[m] >= lk) break;
          heap[i] = heap[m]; key[i] = key[m]; i = m;
        }
        heap[i] = lv; key[i] = lk;
      }
      const x = c % FC;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const xx = x + dx, nb = c + dy * FC + dx;
        if (xx < 0 || xx >= FC || nb < 0 || nb >= n || closed[nb]) continue;
        closed[nb] = 1;
        const k = z[nb] > ck ? z[nb] : ck;
        out[nb] = k - z[nb]; push(nb, k);
      }
    }
  };
  depth(false, d0); depth(true, d1);
  const tau = CARVED_BASIN_M / unitM, keep = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) if (!lev[i] && d1[i] - d0[i] > tau) { keep[i] = 1; any = true; }
  return any ? keep : null;
}

/** 一次侵蚀的公用设置（细级与粗级共用的初始场采样器、参照格、集水阈值）：erodeField 与 erodeCarve 各取所需 */
function erodeSetup(inp: ErodeInput) {
  const { bb, step, cols, rows, elev0, amp, seed, kmx, kmy } = inp;
  const sx = upscaleOf(cols, rows, inp.cap, inp.axisMax);
  const FC = cols * sx, FR = rows * sx, n = FC * FR, fstep = step / sx;
  /* 参照细格边＝工作档的细格（精修档 bandS>1 时把它撑回去，见 ErodeInput.bandS）。凡「锚定细格」
     的波长与逐格坡度都按它算，两档的细纹遂是同一张皮、精修只是把它解析得更清楚。窗口单的起伏带另按 win.refS（见 ErodeWindow）。 */
  const rstep = fstep * inp.bandS, rstepB = inp.win ? fstep * inp.win.refS : rstep;
  /* 基础场：**类型高程走粗格双线性**（复现旧管线「粗格值+着色器双线性」的连续基面——取最近父格
     会让粗格 ELEV 台阶以细格锐度全图浮出格状压纹，实测踩过）+ 起伏按采样点重采样（锚经纬度，
     上采样即免费细节）。水域不加噪＝侵蚀基准面。 */
  const geo = { bb, step, cols, rows };
  /* 无雕痕快路（提速批）：类型驱动的图 hovGrid 全零——全零场的双线性恒为 +0、e=b+0===b，故跳过
     逐点的 hov 采样＝逐位同值（神谕锁） */
  let noHov = true;
  for (let k = 0; k < inp.hovGrid.length && noHov; k++) if (inp.hovGrid[k] !== 0) noHov = false;
  /* 类型基面域扭曲（两八度）与羽化半距在循环外定死 */
  const fw1 = 1 / (9 * step), fw2 = 1 / (3.5 * step), wA1 = WARP1 * step, wA2 = WARP2 * step, ft = TYPE_FEATHER * step;
  const reliefU = RELIEF_M / inp.unitM;
  /** 一点的初始场（细级与粗级共用）：类型基面按域扭曲采样＋4 抽头帐篷羽化（水域不扭不羽＝基准面逐位、
      雕痕不扭＝落在用户画的地方）＋雕痕＋起伏，写入 dstB/dstH[i]。山地度两路取大：类型路＝基面高程
      （含雕体）× meta.relief；雕体路＝往上雕的 dh 自带（与 meta.relief 解耦＝纯手雕图 relief=0 也有真形；往下涂的不给——
      涂低的平原按涂改幅度加山的起伏，读数就不在涂的高度上）。dstT 有则逐格记「类型路主导」（粗级物理扩散的门）。 */
  /** 类型基面（陆地那一支：域扭曲 + 帐篷羽化，不含雕痕与起伏）：子格海岸线按它与水面的等值线定（见 ErodeWindow.coast） */
  const menv = inp.mesoEnv;
  const lfd = inp.lfDelta;
  /* dLf 有则把地貌涂改增量按与基面同一落点写进 dLf[i]（中尺度图不扭，直接取） */
  const landBase: (lon: number, lat: number, dLf?: Float32Array | null, i?: number) => number = menv
    ? (lon, lat, dLf, i) => { if (dLf) dLf[i!] = elevBilinear(lfd!, geo, lon, lat); return elevBilinear(elev0, geo, lon, lat); }   // 中尺度图：谷网就是基底，扭与羽都会把它挪开、磨钝
    : (lon, lat, dLf, i) => {
    const sl = lon + wA1 * gnoise(lon * fw1, lat * fw1, seed + 101) + wA2 * gnoise(lon * fw2, lat * fw2, seed + 303);
    const sa = lat + wA1 * gnoise(lon * fw1 + 53.7, lat * fw1 + 17.3, seed + 202) + wA2 * gnoise(lon * fw2 + 11.9, lat * fw2 + 41.2, seed + 404);
    if (dLf) dLf[i!] = 0.25 * (elevBilinear(lfd!, geo, sl - ft, sa - ft) + elevBilinear(lfd!, geo, sl + ft, sa - ft)
      + elevBilinear(lfd!, geo, sl - ft, sa + ft) + elevBilinear(lfd!, geo, sl + ft, sa + ft));
    return 0.25 * (elevBilinear(elev0, geo, sl - ft, sa - ft) + elevBilinear(elev0, geo, sl + ft, sa - ft)
      + elevBilinear(elev0, geo, sl - ft, sa + ft) + elevBilinear(elev0, geo, sl + ft, sa + ft));
  };
  const initInto = (dstB: Float32Array, dstH: Float32Array, i: number, lon: number, lat: number, isWater: boolean, ws: number, relief: ReliefSampler,
    dstT: Uint8Array | null, dstHb: Float32Array | null, dstLf: Float32Array | null): void => {
    const b = !isWater ? landBase(lon, lat, dstLf, i) : Math.min(elevBilinear(elev0, geo, lon, lat), ws + SHORE_E);   // 水格：双线性会把岸上的陆地值插进来
    const hb = noHov ? 0 : elevBilinear(inp.hovGrid, geo, lon, lat);
    if (dstHb) dstHb[i] = isWater ? 0 : hb;   // 水格侵蚀时站在判据线上，不带涂改
    let e = b + hb;
    if (!isWater) {
      const mT = amp > 0 ? amp * (menv ? elevBilinear(menv, geo, lon, lat) : mountainness(e)) : 0, mC = hb < -DH_EPS ? 0 : Math.min(1, Math.abs(hb) * RELIEF_CARVE_K), m = Math.max(mT, mC);
      if (m > 0) e += relief(lon, lat, m) * reliefU;
      if (dstT) dstT[i] = amp > 0 && mT >= mC ? 1 : 0;
    }
    dstB[i] = b; dstH[i] = e;
  };
  /* 起伏场（core/relief）：波长按公里定、坐标按经纬×每度公里锚定、逐带按参照细格防混叠。
     ⚠ 参照细格用 rstep（含 bandS）＝精修档不许比工作档多长出一条带（换档换地貌之训）。 */
  const sc = inp.win ? inp.win.sc : inp.sphere ? [(bb.lonMin + bb.lonMax) / 2, (bb.latMin + bb.latMax) / 2] as const : null;   // 球面图的图幅中心（走向轴的切平面）
  const relief = makeRelief(seed, rstepB * kmy, kmy, sc, menv ? RELIEF_MESO_CELLS * step * kmy : Infinity);
  const cellKm2 = (fstep * kmx) * (fstep * kmy);
  const acritKm2 = (inp.win ? inp.acrit : Math.min(inp.acrit, n / 64)) * cellKm2;   // 封顶见 ACRIT_CELLS 头注；工作档 acrit≡300，精修档经 ultraInput 面积归一；粗级同用此 km² 阈值
  return { sx, FC, FR, n, fstep, rstep, rstepB, sc, initInto, landBase, relief, acritKm2, noHov };
}

/** 粗级格边（度）与格数：只由参照细格 rstep 定（工作档与精修档同一份）；任一轴不足 COARSE_MIN 粗格＝粗级不跑（null） */
function coarseGeom(cols: number, rows: number, step: number, rstep: number): { cstep: number; CC: number; CR: number } | null {
  const cstep = rstep * COARSE_K, CC = Math.ceil(cols * step / cstep - 1e-9), CR = Math.ceil(rows * step / cstep - 1e-9);
  return CC < COARSE_MIN || CR < COARSE_MIN ? null : { cstep, CC, CR };
}
/** 粗级扩散里涂改那一份被参照面抵掉的比例 λ（σ² = 轮数 × 系数 × 格边² / 2，涂改只被磨到 COARSE_CARVE_SIG_KM）：粗格边 ≤ 约 3.33 km 时 ≤ 0＝不抵 */
function carveLam(cKm: number): number { return 1 - 2 * COARSE_CARVE_SIG_KM * COARSE_CARVE_SIG_KM / (COARSE_ITERS * cKm * cKm * COARSE_DIFF); }

/** 粗级：同一套初始场按粗级格心重采样（起伏只取粗级解析得了的带），跑 COARSE_ITERS 轮，
    产出切割量（侵蚀后−侵蚀前，水域恒 0）；任一轴不足 COARSE_MIN 粗格＝不做（null） */
function carveOf(inp: ErodeInput, S: ReturnType<typeof erodeSetup>): CoarseCarve | null {
  if (inp.mesoEnv) return null;   // 中尺度图：谷网已在中尺度稳态解里，粗级的 D8 下切只会刻出沿格轴的直线谷壁
  const { bb, step, cols, rows, water, wsurf, seed, kmx, kmy } = inp, { initInto, sc, acritKm2 } = S;
  const cg = coarseGeom(cols, rows, step, S.rstep);
  if (!cg) return null;
  const { cstep, CC, CR } = cg, nc = CC * CR, hc = new Float32Array(nc), h0 = new Float32Array(nc), bc = new Float32Array(nc), wc = new Uint8Array(nc);
  const tc = new Uint8Array(nc), hbc = S.noHov ? null : new Float32Array(nc), lfc = inp.lfDelta ? new Float32Array(nc) : null;
  const reliefC = makeRelief(seed, cstep * kmy, kmy, sc, Infinity);
  for (let r = 0; r < CR; r++) {
    const lat = bb.latMin + (r + 0.5) * cstep, pr = Math.max(0, Math.min(rows - 1, Math.floor((lat - bb.latMin) / step)));
    for (let c = 0; c < CC; c++) {
      const lon = bb.lonMin + (c + 0.5) * cstep, pc = Math.max(0, Math.min(cols - 1, Math.floor((lon - bb.lonMin) / step))), i = r * CC + c;
      wc[i] = water[pr * cols + pc];
      initInto(bc, hc, i, lon, lat, wc[i] === 1, wsurf[pr * cols + pc], reliefC, tc, hbc, lfc);
      if (wc[i]) hc[i] = wsurf[pr * cols + pc] + SHORE_LAND;   // 基准面＝渲染端的水陆判据线；切割量在水格恒 0
    }
  }
  h0.set(hc);
  const cKm = cstep * Math.sqrt(kmx * kmy), dPhys = 4 * COARSE_D_KM2 / (cKm * cKm);
  let dcell: Float64Array | null = null;
  if (dPhys > COARSE_DIFF && tc.includes(1)) {
    dcell = new Float64Array(nc);
    for (let i = 0; i < nc; i++) dcell[i] = tc[i] ? dPhys : COARSE_DIFF;
  }
  let keep: Uint8Array | null = null, ref: Float32Array | null = null;
  if (hbc || lfc) {
    keep = carvedBasins(bc, hbc, lfc, wc, CC, CR, inp.unitM);
    /* 涂改（高程涂改＋地貌涂改的基面增量）作参照面、抵掉 λ 份扩散：否则窄雕刻与地貌笔堆的山中心剩一半。
       谷网的数值低通仍按格——改按物理值在细粗格上刻出沿格轴的直谷、在地类台阶边刻出粗格间距的珠串 */
    const lam = dcell ? 0 : carveLam(cKm);
    if (lam > 0) {
      ref = hbc || lfc!;
      if (hbc && lfc) for (let i = 0; i < nc; i++) ref[i] += lfc[i];
      for (let i = 0; i < nc; i++) ref[i] *= lam;
    }
  }
  streamPower({ h: hc, wat: wc, FC: CC, FR: CR, fstep: cstep, kmx, kmy, acritKm2, dcell, keep, ...(ref ? { ref } : {}) }, COARSE_ITERS, COARSE_DIFF, 0, true);
  for (let i = 0; i < nc; i++) hc[i] -= h0[i];
  return { data: hc, geo: { bb, step: cstep, cols: CC, rows: CR } };
}

/** 只算粗级切割量（分块精修的公共底，见 ErodeWindow）：与 erodeField(inp) 内部用的那份逐位相同；粗级被跳过的小图与中尺度图返 null */
export function erodeCarve(inp: ErodeInput): CoarseCarve | null { return carveOf(inp, erodeSetup(inp)); }

/** 侵蚀重铸：细分基础场（类型基面域扭曲揉台阶圈＋雕痕＋按山地度渐入的起伏）
    → 粗级 COARSE_ITERS 轮长谷网、切割量铺回细格 → 细级 ITERS 轮（填洼/受水者/汇流面积/隐式下切/扩散）
    → 侵蚀后表面细节 → 类型钳制。 */
export function erodeField(inp: ErodeInput): ElevField {
  const S = erodeSetup(inp);
  const { bb, cols, rows, water, wsurf, seed, kmx, kmy } = inp, { sx, FC, FR, n, fstep, rstepB, initInto, landBase, relief } = S;
  /* 水陆交界一圈的父格（自己或八邻有水有陆）：窗口单在这里按基面等值线定细格水陆（ErodeWindow.coast） */
  let shore: Uint8Array | null = null;
  if (inp.win && inp.win.coast) {
    shore = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const w0 = water[r * cols + c];
      for (let dr = -1; dr <= 1 && !shore[r * cols + c]; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && water[rr * cols + cc] !== w0) { shore[r * cols + c] = 1; break; }
      }
    }
  }
  const h = new Float32Array(n);
  const base = new Float32Array(n);   // 结构基面（无噪声）：钳制参照，同旧「类型基础值」之职
  const wat = new Uint8Array(n), hbf = S.noHov ? null : new Float32Array(n), lff = inp.lfDelta ? new Float32Array(n) : null;
  for (let r = 0; r < FR; r++) {
    const pr = Math.min(rows - 1, (r / sx) | 0), lat = bb.latMin + (r + 0.5) * fstep;
    for (let c = 0; c < FC; c++) {
      const pc = Math.min(cols - 1, (c / sx) | 0), i = r * FC + c;
      const lon = bb.lonMin + (c + 0.5) * fstep, k = pr * cols + pc;
      wat[i] = shore && shore[k] ? (landBase(lon, lat) < wsurf[k] - WATER_EPS ? 1 : 0) : water[k];
      initInto(base, h, i, lon, lat, wat[i] === 1, wsurf[k], relief, null, hbf, lff);
    }
  }
  const acritKm2 = S.acritKm2;
  /* 细级的基准面：水格，加画的盆地的局部基准面（父格位 2）——后者是陆地，不换床面、不受水格钳制，只让填洼与下切把它当出口 */
  let lev = wat;
  if (inp.basin) {
    lev = Uint8Array.from(wat);
    for (let r = 0; r < FR; r++) {
      const pr = Math.min(rows - 1, (r / sx) | 0);
      for (let c = 0; c < FC; c++) if (inp.basin[pr * cols + Math.min(cols - 1, (c / sx) | 0)] & 2) lev[r * FC + c] = 1;
    }
  }

  /* 粗级切割量双线性铺回细格陆地（窗口单用全图那份，见 ErodeWindow） */
  const cv = inp.win ? inp.win.carve : carveOf(inp, S);
  if (cv) {
    for (let r = 0; r < FR; r++) {
      const lat = bb.latMin + (r + 0.5) * fstep;
      for (let c = 0; c < FC; c++) { const i = r * FC + c; if (!wat[i]) h[i] += elevBilinear(cv.data, cv.geo, bb.lonMin + (c + 0.5) * fstep, lat); }
    }
  }

  const bed = new Float32Array(n);   // 细级同理：侵蚀期间水格站在判据线上，收尾换回床面
  for (let r = 0; r < FR; r++) {
    const pr = Math.min(rows - 1, (r / sx) | 0);
    for (let c = 0; c < FC; c++) {
      const i = r * FC + c;
      if (wat[i]) { bed[i] = h[i]; h[i] = wsurf[pr * cols + Math.min(cols - 1, (c / sx) | 0)] + SHORE_LAND; }
    }
  }
  const micro = inp.mesoEnv ? new Float32Array(n) : null;
  if (micro) {
    const mu = MESO_MICRO_M / inp.unitM;
    for (let r = 0; r < FR; r++) {
      const y = (bb.latMin + (r + 0.5) * fstep) * kmy;
      for (let c = 0; c < FC; c++) {
        const i = r * FC + c; if (wat[i]) continue;
        const x = (bb.lonMin + (c + 0.5) * fstep) * kmx;
        let v = 0; for (const [lam, w] of MESO_MICRO_KM) v += w * gnoise(x / lam, y / lam, seed + 811 + lam);
        micro[i] = mu * v; h[i] += micro[i];
      }
    }
  }
  const keep = hbf || lff ? carvedBasins(base, hbf, lff, lev, FC, FR, inp.unitM) : null;
  streamPower({ h, wat: lev, FC, FR, fstep, kmx, kmy, acritKm2, keep, ...(inp.mesoEnv ? { ref: base } : {}) }, ITERS, DIFF, POST_DIFF, false);
  for (let i = 0; i < n; i++) if (wat[i]) h[i] = bed[i];
  if (micro) for (let i = 0; i < n; i++) h[i] -= micro[i];
  const h2 = new Float32Array(n);

  /* 侵蚀后表面细节（批6）：λ≈3 细格的收尾质感，放在扩散**之后**＝不会被磨掉（批5 的 POST_DIFF=8
     把基座里的细噪声磨掉三成＝「雕形回糊」病根之二）；键＝max(系数, 坡度键)（见 DETAIL_SLOPE_K 注），
     平原近零、水域恒 0。在钳制之前＝地板天花之约不破。 */
  if (DETAIL_AMP > 0) {
    const dF = 1 / (3 * rstepB), dx2 = (seed % 83) * 1.7 + 9.1, dy2 = (seed % 79) * 1.13 + 27.4;
    const fD = rowFbm();   // 本段自己的行滑窗（按行扫描）
    h2.set(h);   // 坡度读快照（h 正被逐格改写）
    for (let r = 0; r < FR; r++) {
      const lat = bb.latMin + (r + 0.5) * fstep;
      for (let c = 0; c < FC; c++) {
        const i = r * FC + c;
        if (wat[i]) continue;
        const gx = (h2[i + (c < FC - 1 ? 1 : 0)] - h2[i - (c > 0 ? 1 : 0)]) * 0.5;
        const gy = (h2[(r < FR - 1 ? r + 1 : r) * FC + c] - h2[(r > 0 ? r - 1 : r) * FC + c]) * 0.5;
        /* 坡度键 ×bandS：gx/gy 是「每细格的高差」，精修档的格更小＝同一面真坡读出来的键更小；
           乘回倍率就是「每参照细格」的坡，与工作档同量纲。 */
        const k = Math.min(DETAIL_SLOPE_CAP, Math.hypot(gx, gy) * DETAIL_SLOPE_K * (inp.win ? inp.win.refS : inp.bandS));
        if (k > 0.02) h[i] += k * DETAIL_AMP * (fD((bb.lonMin + (c + 0.5) * fstep) * dF + dx2, lat * dF + dy2) - 0.47);
      }
    }
  }

  /* 类型钳制（地板/天花同 buildSurface；参照＝连续类型基面：按最近父格钳会把海岸缓坡削回台阶）。涂改为负的细格，地板随涂改一起下移。
     陆格另不低于所在粗格的水陆判据线：低于它就在渲染端判成水，岸边出现细水道与孤立的细陆地。 */
  for (let r = 0; r < FR; r++) {
    const pr = Math.min(rows - 1, (r / sx) | 0);
    for (let c = 0; c < FC; c++) {
      const i = r * FC + c;
      h[i] = wat[i] ? Math.min(Math.max(WATER_CEIL, base[i]), h[i])
        : Math.max(Math.min(LAND_FLOOR, base[i]) + (hbf && hbf[i] < -DH_EPS ? hbf[i] : 0), wsurf[pr * cols + Math.min(cols - 1, (c / sx) | 0)] + SHORE_LAND, h[i]);
    }
  }

  return { data: h, eroded: true, cols: FC, rows: FR, step: fstep, bb };
}
