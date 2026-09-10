/* 侵蚀真形（渲染层数据源，2026-08 批二）：把「ELEV[类型] + 起伏噪声」的示意高程场重铸成有
   真实谷网与连通山脊的场——上采样细分格 → 水力侵蚀（stream-power，Braun-Willett 2013 单遍
   隐式解）→ 坡面扩散 → 定向天光遮蔽烘焙。纯函数、确定性（同输入逐位同输出），Worker 与
   主线程回退共用；黄金基准零接触（分类/寻路不读本场）。
   ⚠ 调用门在 erodeInput：「relief=0 且无高程涂改」返 null＝旧 buildElevField 粗格路径逐位不变；
     heightOverrides 栅到粗格后**并入侵蚀基座**（随水系被切割、自带微地形）——手涂高程是雕刻，
     不是要保锐边的盖章（2026-08-08 改判，见 ErodeInput.hovGrid 注）。
   ⚠ 等高线与光标读数与晕渲同走本场（「画尺一致」，2026-08-07 用户拍板）：等高线自此沿真实
     谷线走，旧档（relief>0）读数会移动；战略图与其战术烘焙在同一位置的起伏也从逐位一致降为
     近似一致（侵蚀依赖网格分辨率，噪声输入仍同锚）。 */
import { hash2 as sinHash2 } from "./noise.ts";
import { baseElev, elevBilinear, elevUnitM, LAND_FLOOR, WATER_CEIL, type ElevField } from "./elev.ts";
import { gnoise, makeRelief, mountainness, type ReliefSampler, RELIEF_CARVE_K, RELIEF_GATE_HI, RELIEF_GATE_LO, RELIEF_LAMBDA_KM, RELIEF_M,
  RELIEF_ROUGH_HI, RELIEF_ROUGH_LO, RELIEF_STRIKE, RELIEF_W, RELIEF_E0, RELIEF_E1, RIDGED_MEAN } from "./relief.ts";
import { terrainProps } from "./constants.ts";
import { flatKmPerDeg } from "./geo.ts";
import { activeAt } from "./time.ts";
import type { Grid } from "./grid.ts";
import type { BBox, HeightOverride, Meta } from "./types.ts";

export interface ErodeInput {
  bb: BBox; step: number; cols: number; rows: number;
  /** 粗格基础高程（连续基底 core/elev.baseElev：类型阶梯已展成山前带、海床自岸变深） */
  elev0: Float32Array;
  /** 粗格水域掩码（1=地貌轴为水；水面高程恒定＝侵蚀基准面）。⚠ 只认 lf==="water"：沿海与沼泽是陆地，
      要起伏也要被侵蚀；terrainProps.water 是水军通行语义，不是这里的掩码 */
  water: Uint8Array;
  /** meta.relief（0..1；纯涂改图可为 0——涂改自带微地形，见 hovGrid） */
  amp: number;
  seed: number;
  /** 细分格预算（战略 40 万 / 战术 140 万，erodeInput 按 mapKind 定；4K 静置精修经 ultraInput
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
  /** 米/抽象单位（遮蔽烘焙把高差换算成真实坡度用；erodeInput 取 elevUnitM(meta)） */
  unitM: number;
}

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
   粗格）仍是 1×，它的加密归静置精修（host 的 ultra 档自本日起也发给战略图）。 */
const MAX_FINE = 2_400_000;
/* 140 万→150 万（2026-09-02）：缺省 60 km 战场 600²×2²＝144 万，恰差 2.8% 拿不到 2×＝缺省尺寸是第一个
   失去细分的尺寸（59 km 有 2×、60 km 没有）；放大看细节时 100 m 工作档露格子。 */
const MAX_FINE_TAC = 1_500_000;
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
const COARSE_DIFF = 0.06;   // 粗级扩散系数：格边 K 倍＝同系数下物理扩散率 K² 倍，取原值会把刚切出的谷肩磨回去
const COARSE_MIN = 24;      // 粗级任一轴少于此格数不做（夹具级小网格，谷网无处可长）
/* 遮蔽烘焙：高差按真实坡度换算再乘 SHADOW_EXAG（着色器夸张 E∈[exagLo,exagHi] 的中值——烘焙不知道
   当前缩放，取中值两头各差一倍）；日高 tan=|Lz|/|Lxy|=0.9/0.8485。采样步距渐增＝近处硬阴影、远处软阴影 */
const SHADOW_EXAG = 6, TAN_SUN = 1.0607, OCC_GAIN = 1.15;
const SHADOW_STEPS = [1, 2, 3, 5, 8, 12, 17, 24];

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
const EALGO = 7;   // 2026-09-07：多重网格（粗级先长谷网）；6=起伏改公里锚定的异质多尺度脊线场（core/relief），5=连续基底，4=细带归一，3=4K 精修
const KNOB_FP = [EALGO, MAX_FINE, MAX_FINE_TAC, ITERS, KDT, ACRIT_CELLS, DIFF, POST_DIFF, COARSE_K, COARSE_ITERS, COARSE_DIFF, COARSE_MIN,
  WARP1, WARP2, TYPE_FEATHER, DETAIL_AMP, DETAIL_SLOPE_K, DETAIL_SLOPE_CAP, EPS,
  RELIEF_M, RELIEF_LAMBDA_KM, RELIEF_W, RELIEF_GATE_LO, RELIEF_GATE_HI, RELIEF_ROUGH_LO, RELIEF_ROUGH_HI,
  RELIEF_STRIKE, RELIEF_E0, RELIEF_E1, RELIEF_CARVE_K, RIDGED_MEAN,
  SHADOW_EXAG, TAN_SUN, OCC_GAIN, SHADOW_STEPS].join("|");

/** 算法代号（指纹的 36 进制缩写）：erodeKey 的前缀；fieldcache 开库时清掉不同代的存货 */
export const ERODE_VER: string = (() => {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < KNOB_FP.length; i++) h = Math.imul(h ^ KNOB_FP.charCodeAt(i), 16777619);
  return "e" + (h >>> 0).toString(36);
})();

/** 侵蚀输入的内容键：FNV-1a 双流 64 位＋算法代前缀。同键＝同输出（纯函数）；
    单流 32 位在「按键取错一整幅地形」的后果面前碰撞余量不够，双流异参并拼。
    ⚠ 输入的典型体量 ~200KB（粗格四场），按 32 位字折叠约 1~2ms——只该在发侵蚀单时算一次。 */
export function erodeKey(inp: ErodeInput): string {
  let a = 0x811c9dc5 | 0, b = 0x6c62272e | 0;
  const mix = (x: number): void => {
    a = Math.imul(a ^ (x & 0xffff), 16777619);
    a = Math.imul(a ^ (x >>> 16), 16777619);
    b = Math.imul(b ^ (x >>> 16), 0x85ebca6b);
    b = Math.imul(b ^ (x & 0xffff), 0x85ebca6b);
  };
  const mixA = (u: Uint32Array | Uint8Array): void => {
    mix(u.length);
    for (let i = 0; i < u.length; i++) mix(u[i]);
  };
  const head = new Float64Array([inp.bb.lonMin, inp.bb.latMin, inp.bb.lonMax, inp.bb.latMax,
    inp.step, inp.cols, inp.rows, inp.amp, inp.seed, inp.kmx, inp.kmy, inp.cap, inp.axisMax, inp.acrit, inp.bandS, inp.unitM]);
  mixA(new Uint32Array(head.buffer));
  mixA(new Uint32Array(inp.elev0.buffer, inp.elev0.byteOffset, inp.elev0.length));   // 整段独立分配＝偏移恒 4 对齐
  mixA(inp.water);
  mixA(new Uint32Array(inp.hovGrid.buffer, inp.hovGrid.byteOffset, inp.hovGrid.length));
  return ERODE_VER + "-" + (a >>> 0).toString(36) + "-" + (b >>> 0).toString(36);
}

/** 侵蚀门（2026-08-13 延迟组装批）：与 erodeInput 的「返 null」判据同一条——relief>0，或有
    当刻生效、dh≠0、且**落得进图幅**的手雕高程（单格章=所在格在界内;粗块章=覆盖域与网格相交）。
    host 在 rebuild 同拍只问门（轻,O(涂改数)零分配）,数组组装挪到防抖结算时——erodeInput 每次
    组装分配 ~13B/格,196 万格图上每笔 move 白扔 26MB。⚠ 判据须与 erodeInput 逐位同判
    （「门的判定与等待窗显示分支同源」之约由此担保;worker.test 拿随机夹具锁 gate===(input!==null)）。 */
export function erodeGate(meta: Meta | undefined, hov: HeightOverride[] | undefined, grid: Grid, yearNow: number): boolean {
  const m = meta || {};
  if (Math.max(0, Math.min(1, +(m.relief as number) || 0)) > 0) return true;
  const { bb, step, cols, rows } = grid;
  for (const o of hov || []) {
    if (!activeAt(o, yearNow)) continue;
    const dh = +o.dh || 0; if (!dh) continue;
    const bs = +(o.step as number) || step;
    if (bs <= step * 1.001) {
      const c = Math.floor((o.lon - bb.lonMin) / step), r = Math.floor((o.lat - bb.latMin) / step);
      if (r >= 0 && r < rows && c >= 0 && c < cols) return true;
    } else {
      const c0 = Math.max(0, Math.floor((o.lon - bs / 2 - bb.lonMin) / step)), c1 = Math.min(cols - 1, Math.floor((o.lon + bs / 2 - bb.lonMin - 1e-9) / step));
      const r0 = Math.max(0, Math.floor((o.lat - bs / 2 - bb.latMin) / step)), r1 = Math.min(rows - 1, Math.floor((o.lat + bs / 2 - bb.latMin - 1e-9) / step));
      if (c1 >= c0 && r1 >= r0) return true;
    }
  }
  return false;
}

/** 组装侵蚀输入（主线程侧）。「relief=0 且无高程涂改」返 null＝旧粗格路径逐位不变契约；
    有涂改即侵蚀——手涂高程正是最该被水系切出真形的地方（2026-08-08 改判，此前 relief=0
    一刀切走旧路径，纯手雕的战术图 800 章全渲成糊边方块）。 */
export function erodeInput(meta: Meta | undefined, hov: HeightOverride[] | undefined,
  grid: Grid, yearNow: number): ErodeInput | null {
  const m = meta || {};
  const amp = Math.max(0, Math.min(1, +(m.relief as number) || 0));
  const { bb, step, cols, rows, cells } = grid;
  /* 涂改先栅到粗格（几何与 buildElevField 的盖章逐位同规：单格章=点所在格、粗块章=铺满覆盖格） */
  const hovGrid = new Float32Array(rows * cols);
  let hasHov = false;
  for (const o of hov || []) {
    if (!activeAt(o, yearNow)) continue;
    const dh = +o.dh || 0; if (!dh) continue;
    const bs = +(o.step as number) || step;
    if (bs <= step * 1.001) {
      const c = Math.floor((o.lon - bb.lonMin) / step), r = Math.floor((o.lat - bb.latMin) / step);
      if (r >= 0 && r < rows && c >= 0 && c < cols) { hovGrid[r * cols + c] += dh; hasHov = true; }
    } else {
      const c0 = Math.max(0, Math.floor((o.lon - bs / 2 - bb.lonMin) / step)), c1 = Math.min(cols - 1, Math.floor((o.lon + bs / 2 - bb.lonMin - 1e-9) / step));
      const r0 = Math.max(0, Math.floor((o.lat - bs / 2 - bb.latMin) / step)), r1 = Math.min(rows - 1, Math.floor((o.lat + bs / 2 - bb.latMin - 1e-9) / step));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { hovGrid[r * cols + c] += dh; hasHov = true; }
    }
  }
  if (amp <= 0 && !hasHov) return null;
  const elev0 = baseElev(m, grid), water = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) water[r * cols + c] = terrainProps(cells[r][c]).lf === "water" ? 1 : 0;
  const kmy = m.worldModel === "flat" ? flatKmPerDeg(m) : 2 * Math.PI * (+(m.planetRadiusKm ?? 0) || 10000) / 360;
  const kmx = m.worldModel === "flat" ? kmy : kmy * Math.cos((bb.latMin + bb.latMax) / 2 * Math.PI / 180);
  const cap = m.mapKind === "tactical" ? MAX_FINE_TAC : MAX_FINE;
  return { bb, step, cols, rows, elev0, water, amp, seed: ((m.genSeed as number) | 0) || 1, kmx, kmy, hovGrid,
    cap, axisMax: 8, acrit: ACRIT_CELLS, bandS: 1, unitM: elevUnitM(m) };
}

/** 精修档输入（4K 静置精修，2026-08-11）：同一份工作档输入换预算——数组共享引用（Worker 侧
    postMessage 自会克隆）、axisMax 提到 16、acrit 按 (sxU/sxW)² 放大＝物理集水阈值与工作档
    一致（见 ErodeInput.acrit 注）。ultraCap 由主机按 deviceMemory 分档传入。
    ⚠ 倍率提不上去＝返 null 不发精修单（2026-08 审查修正）：低内存档 5.25M 预算撞上 196 万格
    大战场时 sxU==sxW，同一几何在不同缓存键下整个重算一遍＝半分钟白算＋一条重复缓存；
    工作档场就是终态，host 对 null 的处置（不排精修）现成。 */
export function ultraInput(inp: ErodeInput, ultraCap: number): ErodeInput | null {
  const sxW = upscaleOf(inp.cols, inp.rows, inp.cap, inp.axisMax);
  const sxU = upscaleOf(inp.cols, inp.rows, ultraCap, 16);
  if (sxU <= sxW) return null;
  return { ...inp, cap: ultraCap, axisMax: 16, acrit: inp.acrit * (sxU / sxW) * (sxU / sxW), bandS: sxU / sxW };
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
interface Level { h: Float32Array; wat: Uint8Array; FC: number; FR: number; fstep: number; kmx: number; kmy: number; acritKm2: number }
function streamPower(L: Level, iters: number, diff: number, postDiff: number, mfd: boolean): void {
  const { h, wat, FC, FR, fstep, kmx, kmy, acritKm2: Acrit } = L, n = FC * FR;
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
      if (wat[i] || c === 0 || r === 0 || c === FC - 1 || r === FR - 1) { closed[i] = 1; push(i, h[i]); }
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
        if (!wat[nb] && h[nb] <= ck) h[nb] = ck + EPS;
        push(nb, h[nb]);
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
      const x = c % FC, hc = h[c];
      let sum = 0;
      for (let k = 0; k < 8; k++) {
        mw[k] = 0;
        const dx = DXNB[k];
        if (dx < 0 ? x === 0 : dx > 0 && x === FC - 1) continue;
        const nb = c + NB[k];
        if (nb < 0 || nb >= n) continue;
        const d = hc - h[nb];
        if (d <= 0) continue;
        mw[k] = d / DK[k]; sum += mw[k];
      }
      if (sum <= 0) continue;
      const a = A[c] / sum;
      for (let k = 0; k < 8; k++) if (mw[k] > 0) A[c + NB[k]] += a * mw[k];
    }
  };
  /* 坡面扩散（4 邻均值回拉；水域与边缘不动） */
  const diffuse = (): void => {
    h2.set(h);
    for (let r = 1; r < FR - 1; r++) for (let c = 1; c < FC - 1; c++) {
      const i = r * FC + c;
      if (wat[i]) continue;
      h2[i] = h[i] + diff * ((h[i - 1] + h[i + 1] + h[i - FC] + h[i + FC]) * 0.25 - h[i]);
    }
    h.set(h2);
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
        const hc = h[c];
        if (rEdge || x === 0 || x === FC - 1) {
          for (let i = 0; i < 8; i++) {
            const dx = DXNB[i];
            if (dx < 0 ? x === 0 : dx > 0 && x === FC - 1) continue;
            const nb = c + NB[i];
            if (nb < 0 || nb >= n) continue;
            if (h[nb] < hc) { const s = (hc - h[nb]) / DK[i]; if (s > bs) { bs = s; bi = i; } }
          }
        } else {
          for (let i = 0; i < 8; i++) {
            const nb = c + NB[i];
            if (h[nb] < hc) { const s = (hc - h[nb]) / DK[i]; if (s > bs) { bs = s; bi = i; } }
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
      const f = KDT * Math.sqrt(A[c]) * (A[c] / (A[c] + Acrit)) / rdist[c];   // 河道起始压制，见 ACRIT_CELLS
      h[c] = (h[c] + f * h[r]) / (1 + f);
    }
    diffuse();
  }
  for (let k = 0; k < postDiff; k++) diffuse();   // 收尾磨圆：压掉陡壁上的平行冲沟毛刺与迭代台痕
}

/** 侵蚀重铸：细分基础场（类型基面域扭曲揉台阶圈＋雕痕＋按山地度渐入的起伏）
    → 粗级 COARSE_ITERS 轮长谷网、切割量铺回细格 → 细级 ITERS 轮（填洼/受水者/汇流面积/隐式下切/扩散）
    → 侵蚀后表面细节 → 类型钳制 → 遮蔽烘焙。 */
export function erodeField(inp: ErodeInput): ElevField {
  const { bb, step, cols, rows, elev0, water, amp, seed, kmx, kmy } = inp;
  const sx = upscaleOf(cols, rows, inp.cap, inp.axisMax);
  const FC = cols * sx, FR = rows * sx, n = FC * FR, fstep = step / sx;
  /* 参照细格边＝工作档的细格（精修档 bandS>1 时把它撑回去，见 ErodeInput.bandS）。凡「锚定细格」
     的波长与逐格坡度都按它算，两档的细纹遂是同一张皮、精修只是把它解析得更清楚。 */
  const rstep = fstep * inp.bandS;
  const h = new Float32Array(n);
  const base = new Float32Array(n);   // 结构基面（无噪声）：钳制参照，同旧「类型基础值」之职
  const wat = new Uint8Array(n);

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
      （含雕体）× meta.relief；雕体路＝|dh| 自带（与 meta.relief 解耦＝纯手雕图 relief=0 也有真形）。 */
  const initInto = (dstB: Float32Array, dstH: Float32Array, i: number, lon: number, lat: number, isWater: boolean, relief: ReliefSampler): void => {
    let b: number;
    if (!isWater) {
      const sl = lon + wA1 * gnoise(lon * fw1, lat * fw1, seed + 101) + wA2 * gnoise(lon * fw2, lat * fw2, seed + 303);
      const sa = lat + wA1 * gnoise(lon * fw1 + 53.7, lat * fw1 + 17.3, seed + 202) + wA2 * gnoise(lon * fw2 + 11.9, lat * fw2 + 41.2, seed + 404);
      b = 0.25 * (elevBilinear(elev0, geo, sl - ft, sa - ft) + elevBilinear(elev0, geo, sl + ft, sa - ft)
        + elevBilinear(elev0, geo, sl - ft, sa + ft) + elevBilinear(elev0, geo, sl + ft, sa + ft));
    } else b = elevBilinear(elev0, geo, lon, lat);
    const hb = noHov ? 0 : elevBilinear(inp.hovGrid, geo, lon, lat);
    let e = b + hb;
    if (!isWater) {
      const m = Math.max(amp > 0 ? amp * mountainness(e) : 0, Math.min(1, Math.abs(hb) * RELIEF_CARVE_K));
      if (m > 0) e += relief(lon * kmy, lat * kmy, m) * reliefU;
    }
    dstB[i] = b; dstH[i] = e;
  };
  /* 起伏场（core/relief）：波长按公里定、坐标按经纬×每度公里锚定、逐带按参照细格防混叠。
     ⚠ 参照细格用 rstep（含 bandS）＝精修档不许比工作档多长出一条带（换档换地貌之训）。 */
  const relief = makeRelief(seed, rstep * kmy);
  for (let r = 0; r < FR; r++) {
    const pr = Math.min(rows - 1, (r / sx) | 0), lat = bb.latMin + (r + 0.5) * fstep;
    for (let c = 0; c < FC; c++) {
      const pc = Math.min(cols - 1, (c / sx) | 0), i = r * FC + c;
      wat[i] = water[pr * cols + pc];
      initInto(base, h, i, bb.lonMin + (c + 0.5) * fstep, lat, wat[i] === 1, relief);
    }
  }

  const cellKm2 = (fstep * kmx) * (fstep * kmy);
  const acritKm2 = Math.min(inp.acrit, n / 64) * cellKm2;   // 封顶见 ACRIT_CELLS 头注；工作档 acrit≡300，精修档经 ultraInput 面积归一；粗级同用此 km² 阈值

  /* 粗级：同一套初始场按粗级格心重采样（起伏只取粗级解析得了的带），跑 COARSE_ITERS 轮，
     切割量（侵蚀后−侵蚀前，水域恒 0）双线性铺回细格陆地。 */
  const cstep = rstep * COARSE_K, CC = Math.ceil(cols * step / cstep - 1e-9), CR = Math.ceil(rows * step / cstep - 1e-9);
  if (CC >= COARSE_MIN && CR >= COARSE_MIN) {
    const nc = CC * CR, hc = new Float32Array(nc), h0 = new Float32Array(nc), bc = new Float32Array(nc), wc = new Uint8Array(nc);
    const reliefC = makeRelief(seed, cstep * kmy);
    for (let r = 0; r < CR; r++) {
      const lat = bb.latMin + (r + 0.5) * cstep, pr = Math.max(0, Math.min(rows - 1, Math.floor((lat - bb.latMin) / step)));
      for (let c = 0; c < CC; c++) {
        const lon = bb.lonMin + (c + 0.5) * cstep, pc = Math.max(0, Math.min(cols - 1, Math.floor((lon - bb.lonMin) / step))), i = r * CC + c;
        wc[i] = water[pr * cols + pc];
        initInto(bc, hc, i, lon, lat, wc[i] === 1, reliefC);
      }
    }
    h0.set(hc);
    streamPower({ h: hc, wat: wc, FC: CC, FR: CR, fstep: cstep, kmx, kmy, acritKm2 }, COARSE_ITERS, COARSE_DIFF, 0, true);
    for (let i = 0; i < nc; i++) hc[i] -= h0[i];
    const geoC = { bb, step: cstep, cols: CC, rows: CR };
    for (let r = 0; r < FR; r++) {
      const lat = bb.latMin + (r + 0.5) * fstep;
      for (let c = 0; c < FC; c++) { const i = r * FC + c; if (!wat[i]) h[i] += elevBilinear(hc, geoC, bb.lonMin + (c + 0.5) * fstep, lat); }
    }
  }

  streamPower({ h, wat, FC, FR, fstep, kmx, kmy, acritKm2 }, ITERS, DIFF, POST_DIFF, false);
  const h2 = new Float32Array(n);

  /* 侵蚀后表面细节（批6）：λ≈3 细格的收尾质感，放在扩散**之后**＝不会被磨掉（批5 的 POST_DIFF=8
     把基座里的细噪声磨掉三成＝「雕形回糊」病根之二）；键＝max(系数, 坡度键)（见 DETAIL_SLOPE_K 注），
     平原近零、水域恒 0。在钳制之前＝地板天花之约不破。 */
  if (DETAIL_AMP > 0) {
    const dF = 1 / (3 * rstep), dx2 = (seed % 83) * 1.7 + 9.1, dy2 = (seed % 79) * 1.13 + 27.4;
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
        const k = Math.min(DETAIL_SLOPE_CAP, Math.hypot(gx, gy) * DETAIL_SLOPE_K * inp.bandS);
        if (k > 0.02) h[i] += k * DETAIL_AMP * (fD((bb.lonMin + (c + 0.5) * fstep) * dF + dx2, lat * dF + dy2) - 0.47);
      }
    }
  }

  /* 类型钳制（同 buildElevField 的地板/天花语义，参照系换成连续基面——细分后「类型基础值」
     在格间是插值坡，按最近父格钳会把海岸缓坡重新削成台阶；⚠ 参照恒为**类型基面**（不含涂改）
     ＝挖地仍不穿类型地板，与旧粗格路径同规） */
  for (let i = 0; i < n; i++) {
    h[i] = wat[i] ? Math.min(Math.max(WATER_CEIL, base[i]), h[i]) : Math.max(Math.min(LAND_FLOOR, base[i]), h[i]);
  }

  /* 定向天光遮蔽（朝光源西南向行进采样；量纲与着色器屏幕坡度一致）——帧时零成本的投影阴影 */
  const shadow = new Float32Array(n);
  const dirC = -0.7071, dirR = -0.7071;
  /* 逐步距常量外提（同式同值：乘积/被除数逐位同，除法照旧是除法——换成乘倒数会漂位）。
     步距同样按 bandS 撑回**参照细格**：不撑则精修档的光线只走到工作档 1/bandS 的距离处
     （井陉 480m→170m），山投下的影子当场短一截＝换档又换了张皮（工作档 ×1＝逐位不变）。 */
  const sstep = SHADOW_STEPS.map(s => s * inp.bandS);
  const offC = sstep.map(s => dirC * s), offR = sstep.map(s => dirR * s);
  const dKm = sstep.map(s => s * fstep * Math.hypot(kmx, kmy));   // 对角步距 km（经向已折 cos）
  const kE = inp.unitM / 1000 * SHADOW_EXAG;                        // 抽象高差 → 米 → 真实 tan × 夸张
  for (let r = 0; r < FR; r++) for (let c = 0; c < FC; c++) {
    const i = r * FC + c;
    if (wat[i]) continue;
    let occ = 0;
    for (let k = 0; k < SHADOW_STEPS.length; k++) {
      const sc = Math.max(0, Math.min(FC - 1, Math.round(c + offC[k])));
      const sr = Math.max(0, Math.min(FR - 1, Math.round(r + offR[k])));
      const t = (h[sr * FC + sc] - h[i]) / dKm[k] * kE - TAN_SUN;
      if (t > occ) occ = t;
    }
    shadow[i] = Math.min(1, occ * OCC_GAIN);
  }

  return { data: h, shadow, cols: FC, rows: FR, step: fstep, bb };
}
