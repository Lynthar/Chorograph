/* 地形网格（游戏真源）：程序化初稿逐格分类 + 手绘涂改叠加 + 官道格标记。
   语义与旧实现逐位一致（黄金基准锁定，密度由夹具显式写死）：格边由 gridStepDeg 一处定，
   涂改可带时段（地形纪元）与块尺寸（战术图继承的战略图涂改=1°粗块盖章）。 */
import { seedTerrain } from "./terrain.ts";
import { canonComposite } from "./constants.ts";
import { activeAt } from "./time.ts";
import { kmPerDeg } from "./geo.ts";
import { DEFAULT_BBOX, type BBox, type Edge, type Meta, type TerrainOverride, type WorldNode } from "./types.ts";

/* cells 存**复合串**（"地貌" 或 "地貌/生态"；旧 8 类 id 是其兼容子集）。seedTerrain 产 canonical 复合、
   涂改经 canonComposite 归一；消费点一律走 core/constants 的 terrainProps/flatten（不再直接查旧表）。 */
export interface Grid { bb: BBox; step: number; cols: number; rows: number; cells: string[][] }

/* 地形网格的格边度数——**格边即最小笔刷**（笔刷只能整格地涂），也是涂改块与寻路格的粒度。
   缺 `meta.gridN` 走自动档（见下），写了就照写、只钳到各自域内。
   ⚠ 单一真源：笔刷尺度（core/brush）、涂域格（core/territory）、fprops 读数都要这个步长，
   而它们拿不到 ctx.grid——各自照抄一份「与 buildGridCells 同式」的注释就是漂移的起点。 */
export function gridStepDeg(meta: Meta | undefined): number {
  const m = meta || {};
  const bb = m.bbox || DEFAULT_BBOX;
  const tac = m.mapKind === "tactical";
  const raw = Math.round(+(m.gridN as number)) || 0;
  /* 显式列数只封上限不设下限（战略）：列少只是格粗，没什么可保护的，而**下限会让小图幅表达不出
     粗格**——4° 的图要 1°/格 只需 4 列，下钳 24 就把它顶成 0.167°。上限才是成本闸（列数×行数）。 */
  const gn = raw > 0 ? (tac ? Math.min(TAC_GRID_MAX, Math.max(60, raw)) : Math.min(STRAT_GRID_MAX, Math.max(1, raw)))
    : autoGridN(m);
  /* 步长地板 0.0002°（≈22m@地球）：只防退化 bbox 把 step 压成 0，不再兼任成本闸——成本由列数
     上限管。⚠ 旧值 0.001°≈111m 会把「最小笔刷 100m」这条约定顶掉（更别提缺省 10000km 半径的
     世界，一格 175m），而列数上限已经把格数封住了，地板不必再管第二件事。
     ⚠ 纬跨/2048 这一项是**覆盖保证**（2026-08 审查修正）：autoGridN 的行闸会被 60 列下限顶穿
     （0.01°×10° 的瘦高档 byRows=2 仍被抬到 60 列 → 5 万行），buildGridCells 的 2048 轴封顶随即
     把网格**静默截断**成只盖 4% 图幅——其余 96% 经 lonlatToCell 钳制复用边缘行＝地形/寻路全错
     还不报错。步长在源头抬粗到「2048 行装得下整个纬跨」，格粗而图幅完整；域内图 rows≤2000
     恒不触发＝逐位不变（经跨侧无此虞：gn≤1800<2048）。 */
  return Math.max(0.0002, (bb.lonMax - bb.lonMin) / gn, (bb.latMax - bb.latMin) / 2048);
}

/* 网格密度自动档(2026-08-12 立,2026-08-13 尺度定形批改战略锚定):
   **两个图种都不再有密度设置**,列数由本函数一处说了算,`meta.gridN` 是**创建时盖章的身份**
   (三个出生点 blankWorld/blankTacticalWorld/createTacticalWorld 都写;写了就照写,钳到各自域内)
   兼手编存档的逃生口;缺键(旧档)＝自动。盖章使旧图永远按建图当天的格边打开——本函数的常数
   此后演进只影响新图,「刷不动」类幽灵从根上绝迹。
   法则＝**盯着格边定列数、列数与总格数与行数再各封一道**:常规图幅拿到约定格边,超大图幅撞
   封顶后格自动放粗(大图密度低、小图密度高),而总格数恒有界。
   格边从**笔刷承诺反推**(32 档互异 ⇔ 格边 ≤ 相邻档差÷2;最小档恰值 ⇔ 最小档÷格边=奇数):
   战术 **100m/格**(=最小档恰 1 格;相邻档差 641.9m ⇒ 互异余量 3.2×);
   战略 **20⁄3≈6.67km/格**(=最小档恰 3 格=20km;相邻档差 15.48km ⇒ 余量 1.16×)。
   ⚠ 战略必须**公里锚定**不能锚度数:⅛° 在地球是 13.9km=超互异上限近一倍(48° 图实测 18/32 档),
   在出厂 10000km 星球是 3.47km=全球图 4 倍格数白花——承诺以公里计,格边就得以公里计。
   ⚠ **三道闸缺一不可**:列数上限管「又宽又扁」的图(360°×1° 照总格数能要出上万列);总格数
   上限管「又高又窄」的图(鄱阳湖 93×158km 只封列数实得 147 万格,实测揪出);行数项管极端瘦高
   档(护 buildGridCells 的 2048 轴封顶不被行向截断)。上限按**侵蚀/寻路/内存预算**定,不按网格
   重建成本(实测 80 万格重建仅 6ms)。可创建域(创建面板钳住)内永不撞闸:战术边长 ≤140km
   =1400 列/196 万格,战略承诺域=解算格边 ≤7.74km(≈宽 1.39 万 km 且面积 9000 万 km² 内);
   撞闸只发生在导入/手编的超域档上=格边放粗+fprops 如实读数。
   ⚠ 缺键语义 2026-08-12 起有意改变(旧战术 140→自动、旧战略 1°→自动),作者裁定旧档皆测试
   产物;黄金基准不受影响——parity 把密度写进了夹具输入,冻的是数学不是默认策略。 */
export const STRAT_GRID_MAX = 1800, STRAT_CELL_CAP = 1_500_000;   // 承诺域上限:出厂星球全球图 1500×708=106 万格在内
export const TAC_GRID_MAX = 1600, TAC_CELL_CAP = 2_600_000;       // =ULTRA_CAP÷4:域内战术图 4K 精修恒 ≥2×
export const TAC_CELL_KM = 0.1;        // 战术目标格边＝笔刷最小档 100m（格边即最小笔刷）
export const STRAT_CELL_KM = 20 / 3;   // 战略目标格边＝最小档 20km 的 1/3（恰 3 格=20km,且 ≤互异上限 7.74km）
export function autoGridN(meta: Meta | undefined): number {
  const m = meta || {};
  const bb = m.bbox || DEFAULT_BBOX;
  const lon = Math.max(1e-9, bb.lonMax - bb.lonMin), lat = Math.max(1e-9, bb.latMax - bb.latMin);
  const tac = m.mapKind === "tactical";
  const want = Math.round(lon * kmPerDeg(m) / (tac ? TAC_CELL_KM : STRAT_CELL_KM));   // 照目标格边要多少列
  const byCells = Math.floor(Math.sqrt((tac ? TAC_CELL_CAP : STRAT_CELL_CAP) * lon / lat));
  const byRows = Math.floor(2000 * lon / lat);   // 行闸:rows=gn·lat/lon ≤2000（极端瘦高档 60 列下限仍可能顶穿,由 2048 轴护栏兜底截断）
  return Math.max(60, Math.min(tac ? TAC_GRID_MAX : STRAT_GRID_MAX, want, byCells, byRows));
}

/* 程序化底稿 memo(2026-08-13 规模引擎批):seedTerrain 确定性纯函数,同几何同参数＝同底稿。
   实时笔刷每笔都全格重建(pointer 直调 rebuild),auto 模式逐格分类实测 ~276ns/格——百万格图
   每笔 293ms＝画不动;memo 命中改逐行拷贝(实测 106 万格 3.6ms,80×+)。单槽即可(一次只开一张
   图);存的是**未叠涂改的底稿**,发出去的恒是行拷贝(overrides 就地改格,不许写穿底稿)。
   键含 seedTerrain 读到的全部分量(几何定格心坐标、terrain/genSeed/genStyle 定分类),
   命中输出与不 memo 逐位一致(黄金基准即神谕)。 */
let seedMemo: { key: string; base: string[][] } | null = null;

export function buildGridCells(meta: Meta | undefined, overrides: TerrainOverride[] | undefined, yearNow: number): Grid {
  const m = meta || {};
  const bb = m.bbox || DEFAULT_BBOX;
  const step = gridStepDeg(m);
  /* cols/rows 封顶 2048（合法图幅经三道闸均不及——逐位不变）：防超大/损坏 bbox 的 O(cols×rows) 分配 OOM。
     ⚠ ceil 前减 1e-9：方图的经跨与纬跨是两次不同的浮点减法（bbox 四位小数），140km 战场实测
     经跨 1.2591999999999928 / 纬跨 1.259200000000007 —— 后者 ÷step 得 1400.000000000016，
     ceil 出**整整一行**贴边细条（读数报 1400×1400 而实得 1400×1401，2026-08-13 CDP 揪出）。
     容差 1e-9 远大于千级格数的浮点误差（~5e-13）、又远小于任何真实的分数行。 */
  const cols = Math.min(2048, Math.max(1, Math.ceil((bb.lonMax - bb.lonMin) / step - 1e-9))), rows = Math.min(2048, Math.max(1, Math.ceil((bb.latMax - bb.latMin) / step - 1e-9)));
  const mk = `${bb.lonMin},${bb.latMin},${bb.lonMax},${bb.latMax}|${step}|${cols}x${rows}|${m.terrain || ""}|${(m.genSeed as number) ?? ""}|${m.genStyle || ""}`;
  let cells: string[][];
  if (seedMemo && seedMemo.key === mk) {
    cells = seedMemo.base.map(row => row.slice());
  } else {
    const base: string[][] = [];
    for (let r = 0; r < rows; r++) {
      const row: string[] = [];
      for (let c = 0; c < cols; c++) row.push(seedTerrain(m, bb.lonMin + (c + 0.5) * step, bb.latMin + (r + 0.5) * step));
      base.push(row);
    }
    seedMemo = { key: mk, base };
    cells = base.map(row => row.slice());
  }
  (overrides || []).forEach(o => {
    if (!activeAt(o, yearNow)) return;          // 地形涂改可带时段（山川随时间变化）
    const ot = canonComposite(o.t);             // 归一为 canonical 复合串（旧 id→复合，与 seed 一致；新组合原样）
    const bs = +(o.step as number) || step;     // 涂改块尺寸：继承的战略图涂改=1°粗块，本图涂的=本图步长
    if (bs <= step * 1.001) {                   // 常规：单格
      const c = Math.floor((o.lon - bb.lonMin) / step), r = Math.floor((o.lat - bb.latMin) / step);
      if (cells[r] && cells[r][c]) cells[r][c] = ot;
    } else {                                    // 粗块盖章：铺满所覆盖的细格（o.lon/lat=块中心）
      const c0 = Math.max(0, Math.floor((o.lon - bs / 2 - bb.lonMin) / step)), c1 = Math.min(cols - 1, Math.floor((o.lon + bs / 2 - bb.lonMin - 1e-9) / step));
      const r0 = Math.max(0, Math.floor((o.lat - bs / 2 - bb.latMin) / step)), r1 = Math.min(rows - 1, Math.floor((o.lat + bs / 2 - bb.latMin - 1e-9) / step));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r][c] = ot;
    }
  });
  return { bb, step, cols, rows, cells };
}

/** 官道降低沿途寻路代价：当年生效的道路连线按 40 段插值标记所经格（"r,c"） */
export function roadCellSet(nodes: WorldNode[], edges: Edge[], yearNow: number, grid: Grid): Set<string> {
  /* ⚠ 建索引而非 `nodes.find`：本函数在**每次网格重建与每次拨年**都跑（boot/host/orchestrate 三个调用点），
     原先每条 road 边查两次、每次 O(N)——几千地点 + 上千官道即每次拨年千万次字符串比较，拖时间轴直接卡住。
     ⚠ **必须首个命中优先**（`has` 后才 `set`）：`nodes.find` 取的是第一个同 id 者，而 `new Map(nodes.map(…))`
     是后者覆盖前者——重复 id 的档上两者结果不同，这里是平价锁定模块，不能换语义。 */
  const idx = new Map<string, WorldNode>();
  for (const n of nodes) if (!idx.has(n.id)) idx.set(n.id, n);
  const byId = (id: string) => idx.get(id);
  const s = new Set<string>();
  edges.filter(e => e.type === "road" && activeAt(e, yearNow)).forEach(e => {
    if (!e.from || !e.to) return;   // 道路必有两端；自由画河（pts、无 from/to）不入官道格
    const a = byId(e.from), b = byId(e.to); if (!a || !b) return;
    if (grid.step >= 1) {
      /* 1° 及更粗的网格：40 段定数采样（黄金基准逐位不变）。⚠ 判据是**格粗不粗**不是图种
         （2026-08-12 正名）——战略图开了网格密度即走下面的精确走格，那正是对的：40 段在细网格上
         同样漏格，与「战术」二字无关。缺 gridN 的战略图 step 恒 1.0＝仍走这一支。 */
      const N = 40;
      for (let i = 0; i <= N; i++) {
        const lon = a.lon + (b.lon - a.lon) * i / N, lat = a.lat + (b.lat - a.lat) * i / N;
        const c = Math.floor((lon - grid.bb.lonMin) / grid.step), r = Math.floor((lat - grid.bb.latMin) / grid.step);
        s.add(r + "," + c);
      }
      return;
    }
    /* 细网格（2026-07 特化 P0，当时只有战术图会走到）：定数采样步距达 3 格/段＝官道减速带断续、A* 不认路,
       且对角线在格内的弦可任意短（近角掠过）,加密倍率关不死漏格——改精确走格
       （Amanatides-Woo：按与格线的交点次序逐格推进,含起讫格;角上取整偏向恒定,无漏无飞格）。 */
    const ux0 = (a.lon - grid.bb.lonMin) / grid.step, uy0 = (a.lat - grid.bb.latMin) / grid.step;
    const ux1 = (b.lon - grid.bb.lonMin) / grid.step, uy1 = (b.lat - grid.bb.latMin) / grid.step;
    let cx = Math.floor(ux0), cy = Math.floor(uy0);
    const gx = Math.floor(ux1), gy = Math.floor(uy1);
    const dx = ux1 - ux0, dy = uy1 - uy0;
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
    const tdx = dx === 0 ? Infinity : Math.abs(1 / dx), tdy = dy === 0 ? Infinity : Math.abs(1 / dy);
    let tmx = dx === 0 ? Infinity : (dx > 0 ? cx + 1 - ux0 : ux0 - cx) * tdx;
    let tmy = dy === 0 ? Infinity : (dy > 0 ? cy + 1 - uy0 : uy0 - cy) * tdy;
    s.add(cy + "," + cx);
    for (let i = Math.abs(gx - cx) + Math.abs(gy - cy); i > 0 && (cx !== gx || cy !== gy); i--) {
      if (tmx < tmy) { cx += sx; tmx += tdx; } else { cy += sy; tmy += tdy; }
      s.add(cy + "," + cx);
    }
    s.add(gy + "," + gx);   // 端点恰落格线时浮点可致提前收尾——终点格（乙地所在格）恒补
  });
  return s;
}
