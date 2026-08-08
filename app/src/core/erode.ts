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
import { fbm } from "./noise.ts";
import { elevBilinear, LAND_FLOOR, WATER_CEIL, type ElevField } from "./elev.ts";
import { terrainProps } from "./constants.ts";
import { flatKmPerDeg } from "./geo.ts";
import { activeAt } from "./time.ts";
import type { Grid } from "./grid.ts";
import type { BBox, HeightOverride, Meta } from "./types.ts";

export interface ErodeInput {
  bb: BBox; step: number; cols: number; rows: number;
  /** 粗格基础高程（ELEV[类型]，terrainProps.elev） */
  elev0: Float32Array;
  /** 粗格起伏幅（terrainProps.relief） */
  relief0: Float32Array;
  /** 粗格水域掩码（1=水；水面高程恒定＝侵蚀基准面） */
  water: Uint8Array;
  /** meta.relief（0..1；纯涂改图可为 0——涂改自带微地形，见 hovGrid） */
  amp: number;
  seed: number;
  /** 经/纬向 km/度（经向已含中央纬度 cos 折算；细格距离度量用） */
  kmx: number; kmy: number;
  /** 高程涂改栅到粗格的累加场（erodeInput 按 buildElevField 同几何盖章）。
      ⚠ 涂改**并入侵蚀基座**（双线性上采样＝边缘羽化，随水系被真实切割），而非侵蚀后叠平台——
      后者曾把手涂的山渲成一堆糊边方块（2026-08-08 河洛实证）；代价＝读数是「侵蚀后」的值，
      峰顶略低于所涂 dh，属雕刻工具的预期语义 */
  hovGrid: Float32Array;
}

/* —— 调参旋钮（观感层；改幅度看 CDP 截图，别背公式）—— */
const MAX_FINE = 400_000;   // 细分格总数上限（内存与耗时预算；540×740 战术图约 0.4s/次）
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
/* —— 宏观山系结构（批6）：ridged 梯度噪声按局部起伏系数渐入——预设山地/大雕体这才有连贯的
   脊线与谷网（此前只有均匀 fbm＝「平台面+类型台阶圈」，涂山场景晕渲实拍是纯平顶）。
   频率锚经纬度（三带≈50km 山系脊线 / 16km 岭距 / 4km 支脉）；逐带按「细格数/波长」门控淡入，
   小网格（战略细格/测试夹具）天然只剩最长带＝不锯齿。结构强度 s=clamp((coef−0.05)/0.13)：
   平原(coef≈0.03)恒 0＝平原带限之约不破，山地(≈0.2)/大雕体(hovCoef≥0.18)全强。 */
/* ⚠ 权重的大头必须放在**图幅内看得见**的波段：首版 [0.55,0.30,0.15] 把能量押在 λ≈50km 的
   最长带上，战术图幅内那只是一个整体倾斜——涂山场景晕渲实拍依旧平顶（探针踩过）。
   ⚠ 也别加更短的第四带（λ≈1.4km 试过）：与细节噪声、坡度增糙叠成满幅「揉皱铝箔」（t3 实拍），
   4km 以下的形交给侵蚀刻（KDT 已上调）与坡度细节。 */
const RIDGE_F = [2.2, 7, 28];       // 1/度：山系走向 ~50km / 岭距 ~16km / 支脉 ~4km
const RIDGE_W = [0.22, 0.42, 0.36];
const RIDGE_AMP = 3.0;              // × coef × s（山地档中短两带合计≈±0.2 抽象＝±400m 脊谷——须压得住类型台阶的读感）
const RIDGE_MEAN = 0.57;            // ridged² 组合的经验均值（居中用；探针实测 0.5701）
/* 类型基面采样域扭曲：两个八度（λ≈9 粗格 ±1.2 格 + λ≈3.5 粗格 ±0.6 格）——单短波只会让台阶圈
   高频抖动而环仍是环（「珊瑚项圈」实拍），长波才把山缘扭出进退错落的山嘴与山坳；
   合幅 ≤1.8 格＝近岸水陆掩码错位可控。雕痕(hovGrid)不扭＝落在用户画的地方，水域不扭＝基准面逐位 */
const WARP1 = 1.2, WARP2 = 0.6;     // ×粗格距
const TYPE_FEATHER = 0.6;           // 类型基面 4 抽头帐篷羽化半距（×粗格距）：单格宽的类型陡坎摊成 ~2 格
                                    //   山前缓坡带，方齿台阶角被抹圆（晕渲实拍「两圈方齿」之药）
const DETAIL_AMP = 0.15;            // 侵蚀后表面细节幅（λ≈3 细格）：扩散磨不掉的收尾质感；
                                    //   ⚠ 只作细脆度地板，大了＝全图均匀砂纸（首版 0.5 踩过、0.25 仍偏噪）
/* 细节的键＝max(类型/雕体系数, 坡度键)：**粗糙度的老实判据是坡度**——低而陡的雕崖该嶙峋、
   高而缓的丘顶该平滑（河洛岸崖 h4 实拍：键只挂雕体高度时低崖依旧软）。坡度取**侵蚀后**的
   最终场（沟壁天然带糙），逐格中央差读快照防次序依赖。 */
const DETAIL_SLOPE_K = 12, DETAIL_SLOPE_CAP = 0.45;   // 每细格抽象坡 → 键（0.03/格≈45° 崖 → 0.36）
/* 雕体支脉带（格锚定 λ≈14 细格，只随膨胀雕体系数）：世界锚定四带对一座几十细格的雕体全是
   「看不见的倾斜」，唯一合波长的带只占 0.18 权重（手雕晕渲三轮不变实拍）——雕体的支脉肌理
   必须锚定它自身的尺度。类型地形不吃这条（sCoef 的类型分量不进来），战略图不受扰。 */
const RIDGE5_AMP = 1.4;
const EPS = 1e-5;           // 洼地填平的单调排水梯度（抽象高程/格）
/* 遮蔽烘焙：与着色器同一套「屏幕坡度」量纲——tanScreen=Δe/Δ度×0.3214（nrm 推导），
   日高 tan=|Lz|/|Lxy|=0.9/0.8485。采样步距渐增＝近处硬阴影、远处软阴影 */
const SLOPE_SCR = 0.3214, TAN_SUN = 1.0607, OCC_GAIN = 1.15;
const SHADOW_STEPS = [1, 2, 3, 5, 8, 12, 17, 24];

/** 细分倍率：总格数不超预算、单轴最多 8×（48×32 战略→8×；140×94 战术→5×） */
export function upscaleOf(cols: number, rows: number): number {
  let sx = 1;
  while (sx < 8 && cols * (sx + 1) * rows * (sx + 1) <= MAX_FINE) sx++;
  return sx;
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
  const elev0 = new Float32Array(rows * cols), relief0 = new Float32Array(rows * cols), water = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const p = terrainProps(cells[r][c]), k = r * cols + c;
    elev0[k] = p.elev; relief0[k] = p.relief; water[k] = p.water ? 1 : 0;
  }
  const kmy = m.worldModel === "flat" ? flatKmPerDeg(m) : 2 * Math.PI * (+(m.planetRadiusKm ?? 0) || 10000) / 360;
  const kmx = m.worldModel === "flat" ? kmy : kmy * Math.cos((bb.latMin + bb.latMax) / 2 * Math.PI / 180);
  return { bb, step, cols, rows, elev0, relief0, water, amp, seed: ((m.genSeed as number) | 0) || 1, kmx, kmy, hovGrid };
}

/* —— 结构噪声：整数哈希 8 向梯度噪声（确定性、无三角函数；与 core/noise 的 sin-hash 无关＝不入平价）。
   ridged=1−|gnoise|＝尖脊宽谷的经典山系形（Musgrave ridged），值域 [0,1]。 —— */
const G8X = [1, -1, 0, 0, 0.7071, -0.7071, 0.7071, -0.7071];
const G8Y = [0, 0, 1, -1, 0.7071, 0.7071, -0.7071, -0.7071];
function hash2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 974634541)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) & 7;
}
function gnoise(x: number, y: number, seed: number): number {   // ≈[-1,1]
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
const ridged = (x: number, y: number, seed: number): number => {
  const r = 1 - Math.min(1, Math.abs(gnoise(x, y, seed)));
  return r * r;   // 平方锐化：脊线尖、谷底宽（单次 1−|g| 是软枕头，撑不起山系读感）
};

/** 侵蚀重铸：细分基础场（起伏噪声按细格中心重采样——reliefNoise 锚经纬度，上采样即免费细节；
    ＋ridged 山系结构按系数渐入、类型基面域扭曲揉台阶圈）
    → 填洼 → N 轮（受水者/汇流面积/隐式下切/扩散）→ 侵蚀后表面细节 → 类型钳制 → 遮蔽烘焙。 */
export function erodeField(inp: ErodeInput): ElevField {
  const { bb, step, cols, rows, elev0, relief0, water, amp, seed, kmx, kmy } = inp;
  const sx = upscaleOf(cols, rows);
  const FC = cols * sx, FR = rows * sx, n = FC * FR, fstep = step / sx;
  const h = new Float32Array(n);
  const base = new Float32Array(n);   // 结构基面（无噪声）：钳制参照，同旧「类型基础值」之职
  const wat = new Uint8Array(n);

  /* 细分基础场：**类型高程走粗格双线性**（复现旧管线「粗格值+着色器双线性」的连续基面——
     取最近父格会让粗格 ELEV 台阶以细格锐度全图浮出格状压纹，实测踩过）+ 起伏噪声按细格
     中心重采样（reliefNoise 锚经纬度，上采样即免费细节；幅度亦双线性=岸边平滑归零）。
     sx=1 时双线性恰落格心＝逐点还原粗格值。水域不加噪＝侵蚀基准面。 */
  const geo = { bb, step, cols, rows };
  const fnF = 1 / (5 * fstep);   // 涂改细噪声频率：波长≈5 细格（fbm 内含 4 倍频＝再往下细三档）
  const sx1 = (seed % 97) * 1.31 + 41.7, sy1 = (seed % 89) * 0.97 + 13.9;   // 种子移相（与起伏噪声相位独立）
  /* 起伏噪声＝reliefNoise 同式同相位，唯 36/度 高频档按局部起伏系数渐入（coef≥0.12 时 ===reliefNoise）：
     细分场把高频档完整解析出来后，平原（系数小）的低幅高频起伏在坡度型光照里渲成满地褶皱棱角
     （用户实证「杂乱」）——旧粗格路径等于替平原做了带限，此处把带限找回来；山地细节不受影响 */
  const sxr = (seed % 233) * 0.517 + 21.3, syr = (Math.floor(seed / 233) % 233) * 0.731 + 11.7;
  const rNoise = (lon: number, lat: number, coef: number): number => {
    const hf = Math.min(1, coef / 0.12);
    return 0.5 * fbm(lon * 0.8 + sxr, lat * 0.8 + syr)
      + 0.35 * fbm(lon * 6 + sxr * 1.3 + 60, lat * 6 + syr + 60)
      + 0.15 * (hf * fbm(lon * 36 + sxr + 140, lat * 36 + syr + 140) + (1 - hf) * 0.47) - 0.5;
  };
  /* 类型基面域扭曲（两八度）、羽化半距与 ridged 山系带的别名门控（细格/波长 <2.5 淡出）在循环外定死 */
  const fw1 = 1 / (9 * step), fw2 = 1 / (3.5 * step), wA1 = WARP1 * step, wA2 = WARP2 * step, ft = TYPE_FEATHER * step;
  /* 雕体幅 5×5 膨胀（两趟可分离 max）：结构强度按**整座雕体**给——点态 |hb| 在雕体侧翼早已衰减，
     结构恰好在可见坡面上缺席（首版实拍踩过）；噪声幅仍用点态（「按局部雕高成比例」之约不变） */
  const hovMax = new Float32Array(rows * cols);
  {
    const t = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      let m = 0;
      for (let d = -2; d <= 2; d++) m = Math.max(m, Math.abs(inp.hovGrid[r * cols + Math.min(cols - 1, Math.max(0, c + d))]));
      t[r * cols + c] = m;
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      let m = 0;
      for (let d = -2; d <= 2; d++) m = Math.max(m, t[Math.min(rows - 1, Math.max(0, r + d)) * cols + c]);
      hovMax[r * cols + c] = m;
    }
  }
  const gw = RIDGE_W.map((w, k) => {
    const t = Math.max(0, Math.min(1, (1 / (RIDGE_F[k] * fstep) - 2.5) / 2.5));
    return w * t * t * (3 - 2 * t);
  });
  const gwSum = gw.reduce((a, x) => a + x, 0);
  const f5 = 1 / (14 * fstep);   // 雕体支脉带频率（格锚定）
  const dcoef = new Float32Array(n);   // 侵蚀后表面细节的逐格系数（水域恒 0）
  for (let r = 0; r < FR; r++) {
    const pr = Math.min(rows - 1, (r / sx) | 0), lat = bb.latMin + (r + 0.5) * fstep;
    for (let c = 0; c < FC; c++) {
      const pc = Math.min(cols - 1, (c / sx) | 0), i = r * FC + c;
      const lon = bb.lonMin + (c + 0.5) * fstep;
      wat[i] = water[pr * cols + pc];
      /* 类型基面按域扭曲采样＋4 抽头帐篷羽化＝涂改块的台阶圈揉成有机的山前缓坡（涂山场景晕渲
         实拍原是「平顶+两圈方齿台阶」）；水域不扭不羽（基准面逐位）、雕痕 hovGrid 不扭（落在
         用户画的地方，读数可循） */
      let b: number, ra: number;
      if (!wat[i]) {
        const sl = lon + wA1 * gnoise(lon * fw1, lat * fw1, seed + 101) + wA2 * gnoise(lon * fw2, lat * fw2, seed + 303);
        const sa = lat + wA1 * gnoise(lon * fw1 + 53.7, lat * fw1 + 17.3, seed + 202) + wA2 * gnoise(lon * fw2 + 11.9, lat * fw2 + 41.2, seed + 404);
        b = 0.25 * (elevBilinear(elev0, geo, sl - ft, sa - ft) + elevBilinear(elev0, geo, sl + ft, sa - ft)
          + elevBilinear(elev0, geo, sl - ft, sa + ft) + elevBilinear(elev0, geo, sl + ft, sa + ft));
        ra = 0.25 * (elevBilinear(relief0, geo, sl - ft, sa - ft) + elevBilinear(relief0, geo, sl + ft, sa - ft)
          + elevBilinear(relief0, geo, sl - ft, sa + ft) + elevBilinear(relief0, geo, sl + ft, sa + ft));
      } else {
        b = elevBilinear(elev0, geo, lon, lat);
        ra = elevBilinear(relief0, geo, lon, lat);
      }
      const hb = elevBilinear(inp.hovGrid, geo, lon, lat);
      let e = b + hb;
      /* 微地形系数：「类型起伏×全图 relief」与「涂改自带起伏」取大——手雕的山按**雕体高度成比例**
         获得质感（|hb|×0.35 封 0.7：dh=2 的巨雕要 ±0.5 级扰动才读得出山系；±0.05 摊在高 2 的
         圆包上＝隐形，数值实测踩过），与 meta.relief 解耦＝纯涂改图 relief=0 也有真形 */
      const hovCoef = Math.min(0.7, Math.abs(hb) * 0.35);
      const coef = Math.max(amp > 0 ? ra * amp : 0, hovCoef);
      if (!wat[i]) {
        if (coef > 0) e += coef * 2 * rNoise(lon, lat, coef);
        /* ridged 山系结构按强度渐入：均匀 fbm 给不了连贯脊谷，预设山地曾渲成纯平台面。
           键用 sCoef（类型档与**膨胀后**雕体幅取大）＝整座雕体连同侧翼共享结构 */
        const hovS = Math.min(0.7, elevBilinear(hovMax, geo, lon, lat) * 0.35);
        const sCoef = Math.max(amp > 0 ? ra * amp : 0, hovS);
        const st = Math.max(0, Math.min(1, (sCoef - 0.05) / 0.13));
        if (st > 0 && gwSum > 0) {
          let rs = 0;
          for (let k = 0; k < RIDGE_F.length; k++) if (gw[k] > 0) rs += gw[k] * ridged(lon * RIDGE_F[k], lat * RIDGE_F[k], seed + 7000 + k * 97);
          e += sCoef * RIDGE_AMP * st * (rs - RIDGE_MEAN * gwSum);
        }
        /* 雕体支脉带（见 RIDGE5_AMP 注）：λ 锚定细格＝无论雕体多大都有合尺度的肌理 */
        const s5 = Math.max(0, Math.min(1, (hovS - 0.05) / 0.13));
        if (s5 > 0) e += hovS * RIDGE5_AMP * s5 * (ridged(lon * f5, lat * f5, seed + 9001) - 0.57);
        /* 涂改区补一段**锚定细格**的细起伏（λ≈5 细格）：reliefNoise 最细一档 36/度是战略尺度的
           （对战术细格≈常数），手雕的山没有它就是光滑圆包——细噪声给侵蚀当沟槽种子，也直接成
           微地形。只随 hovCoef（类型驱动的地形有材质纹理兜着，战略图不受此项影响）。
           增益 3.2：fbm 方差集中在均值 ±0.12 附近，还要再被坡面扩散磨掉约一半 */
        if (hovCoef > 0) e += hovCoef * 3.2 * (fbm(lon * fnF + sx1, lat * fnF + sy1) - 0.47);
        dcoef[i] = coef;
      }
      base[i] = b; h[i] = e;
    }
  }

  /* 8 邻表与距离（km；经向已折 cos） */
  const NB = [-FC - 1, -FC, -FC + 1, -1, 1, FC - 1, FC, FC + 1];
  const dxs = [1, 0, 1, 1, 1, 1, 0, 1], dys = [1, 1, 1, 0, 0, 1, 1, 1];
  const DK: number[] = NB.map((_, i) => Math.hypot(dxs[i] * fstep * kmx, dys[i] * fstep * kmy));
  const inGrid = (c: number, i: number): boolean => {
    const x = c % FC, nb = c + NB[i];
    if (nb < 0 || nb >= n) return false;
    const dx = (nb % FC) - x;
    return dx >= -1 && dx <= 1;   // 行不回绕
  };

  /* 二叉堆（h 升序、平手按索引＝确定性） */
  const heap = new Int32Array(n + 1); let hn = 0;
  const less = (a: number, b: number): boolean => h[a] < h[b] || (h[a] === h[b] && a < b);
  const push = (v: number): void => { let i = ++hn; heap[i] = v; while (i > 1 && less(heap[i], heap[i >> 1])) { const t = heap[i]; heap[i] = heap[i >> 1]; heap[i >> 1] = t; i >>= 1; } };
  const pop = (): number => {
    const top = heap[1]; heap[1] = heap[hn--];
    let i = 1;
    for (;;) { let m = i; const l = i * 2, r = l + 1; if (l <= hn && less(heap[l], heap[m])) m = l; if (r <= hn && less(heap[r], heap[m])) m = r; if (m === i) break; const t = heap[i]; heap[i] = heap[m]; heap[m] = t; i = m; }
    return top;
  };

  /* 洼地填平（priority flood + ε 排水坡）：边界=水域与图幅边缘。侵蚀会再挖新洼，每轮重填 */
  const closed = new Uint8Array(n);
  const flood = (): void => {
    closed.fill(0); hn = 0;
    for (let i = 0; i < n; i++) {
      const x = i % FC, y = (i / FC) | 0;
      if (wat[i] || x === 0 || y === 0 || x === FC - 1 || y === FR - 1) { closed[i] = 1; push(i); }
    }
    while (hn > 0) {
      const c = pop();
      for (let i = 0; i < 8; i++) {
        if (!inGrid(c, i)) continue;
        const nb = c + NB[i];
        if (closed[nb]) continue;
        closed[nb] = 1;
        if (!wat[nb] && h[nb] <= h[c]) h[nb] = h[c] + EPS;
        push(nb);
      }
    }
  };

  const rcv = new Int32Array(n), rdist = new Float32Array(n);
  const A = new Float32Array(n);
  const stack = new Int32Array(n), ndon = new Int32Array(n), don = new Int32Array(n), donPos = new Int32Array(n);
  const cellKm2 = (fstep * kmx) * (fstep * kmy);
  const Acrit = Math.min(ACRIT_CELLS, n / 64) * cellKm2;   // 封顶见 ACRIT_CELLS 头注
  const h2 = new Float32Array(n);

  for (let it = 0; it < ITERS; it++) {
    flood();
    /* 受水者：最陡下坡邻格；水域与无下坡＝自身（基准面/汇口） */
    for (let c = 0; c < n; c++) {
      rcv[c] = c; rdist[c] = 1;
      if (wat[c]) continue;
      let bs = 0, bi = -1;
      for (let i = 0; i < 8; i++) {
        if (!inGrid(c, i)) continue;
        const nb = c + NB[i];
        if (h[nb] < h[c]) { const s = (h[c] - h[nb]) / DK[i]; if (s > bs) { bs = s; bi = i; } }   // 平手取先遇邻＝邻序确定性
      }
      if (bi >= 0) { rcv[c] = c + NB[bi]; rdist[c] = DK[bi]; }
    }
    /* Braun-Willett 栈序：汇口起、供水者深搜 */
    ndon.fill(0);
    for (let c = 0; c < n; c++) if (rcv[c] !== c) ndon[rcv[c]]++;
    donPos[0] = 0;
    for (let c = 1; c < n; c++) donPos[c] = donPos[c - 1] + ndon[c - 1];
    const fill = donPos.slice();
    for (let c = 0; c < n; c++) if (rcv[c] !== c) don[fill[rcv[c]]++] = c;
    let sp = 0;
    for (let c = 0; c < n; c++) if (rcv[c] === c) {
      let top = sp; stack[sp++] = c;
      while (top < sp) { const v = stack[top++]; const p0 = donPos[v], p1 = p0 + ndon[v]; for (let p = p0; p < p1; p++) stack[sp++] = don[p]; }
    }
    /* 汇流面积（栈逆序向下游累加）与隐式下切（栈正序：受水者先解） */
    A.fill(cellKm2);
    for (let s = n - 1; s >= 0; s--) { const c = stack[s]; if (rcv[c] !== c) A[rcv[c]] += A[c]; }
    for (let s = 0; s < n; s++) {
      const c = stack[s], r = rcv[c];
      if (r === c || wat[c]) continue;
      const f = KDT * Math.sqrt(A[c]) * (A[c] / (A[c] + Acrit)) / rdist[c];   // 河道起始压制，见 ACRIT_CELLS
      h[c] = (h[c] + f * h[r]) / (1 + f);
    }
    diffuse();
  }
  for (let k = 0; k < POST_DIFF; k++) diffuse();   // 收尾磨圆：压掉陡壁上的平行冲沟毛刺与迭代台痕

  /* 侵蚀后表面细节（批6）：λ≈3 细格的收尾质感，放在扩散**之后**＝不会被磨掉（批5 的 POST_DIFF=8
     把基座里的细噪声磨掉三成＝「雕形回糊」病根之二）；键＝max(系数, 坡度键)（见 DETAIL_SLOPE_K 注），
     平原近零、水域恒 0。在钳制之前＝地板天花之约不破。 */
  if (DETAIL_AMP > 0) {
    const dF = 1 / (3 * fstep), dx2 = (seed % 83) * 1.7 + 9.1, dy2 = (seed % 79) * 1.13 + 27.4;
    h2.set(h);   // 坡度读快照（h 正被逐格改写）
    for (let r = 0; r < FR; r++) {
      const lat = bb.latMin + (r + 0.5) * fstep;
      for (let c = 0; c < FC; c++) {
        const i = r * FC + c;
        if (wat[i]) continue;
        const gx = (h2[i + (c < FC - 1 ? 1 : 0)] - h2[i - (c > 0 ? 1 : 0)]) * 0.5;
        const gy = (h2[(r < FR - 1 ? r + 1 : r) * FC + c] - h2[(r > 0 ? r - 1 : r) * FC + c]) * 0.5;
        const k = Math.max(dcoef[i], Math.min(DETAIL_SLOPE_CAP, Math.hypot(gx, gy) * DETAIL_SLOPE_K));
        if (k > 0.02) h[i] += k * DETAIL_AMP * (fbm((bb.lonMin + (c + 0.5) * fstep) * dF + dx2, lat * dF + dy2) - 0.47);
      }
    }
  }

  /* 坡面扩散（4 邻均值回拉；水域与边缘不动） */
  function diffuse(): void {
    h2.set(h);
    for (let r = 1; r < FR - 1; r++) for (let c = 1; c < FC - 1; c++) {
      const i = r * FC + c;
      if (wat[i]) continue;
      h2[i] = h[i] + DIFF * ((h[i - 1] + h[i + 1] + h[i - FC] + h[i + FC]) * 0.25 - h[i]);
    }
    h.set(h2);
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
  for (let r = 0; r < FR; r++) for (let c = 0; c < FC; c++) {
    const i = r * FC + c;
    if (wat[i]) continue;
    let occ = 0;
    for (const s of SHADOW_STEPS) {
      const sc = Math.max(0, Math.min(FC - 1, Math.round(c + dirC * s)));
      const sr = Math.max(0, Math.min(FR - 1, Math.round(r + dirR * s)));
      const t = (h[sr * FC + sc] - h[i]) / (s * fstep * 1.4142) * SLOPE_SCR - TAN_SUN;
      if (t > occ) occ = t;
    }
    shadow[i] = Math.min(1, occ * OCC_GAIN);
  }

  return { data: h, shadow, cols: FC, rows: FR, step: fstep, bb };
}
