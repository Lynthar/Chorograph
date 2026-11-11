/* 静态守卫：外壳拆分补类型后 src/ 已全量纳入 tsc 严格检查，
   原「@ts-nocheck 下漏 import」编译器扫描退役（其职责由 npm run typecheck 全面接管）。
   这里只防回归：任何源文件再挂 @ts-nocheck/@ts-ignore 指令都会让 typecheck 对其（局部）失明，
   漏 import 重新退化为运行时 ReferenceError——历史上三度中招，零容忍。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ISL_SHOAL_U } from "../src/core/gen2.ts";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(d.name) ? [p] : [];
  });
}

describe("静态守卫：src/ 不得回归 @ts-nocheck / @ts-ignore", () => {
  it("全部源文件在 tsc 视野内", () => {
    const bad = walk(SRC)
      .filter(f => /^\s*\/\/\s*@ts-(nocheck|ignore)/m.test(readFileSync(f, "utf8")))
      .map(f => path.relative(SRC, f).replace(/\\/g, "/"));
    assert.deepStrictEqual(bad, [],
      "以下文件挂了 @ts-nocheck/@ts-ignore 指令（typecheck 对其失明，漏 import 会静默成运行时错误）：\n" + bad.join("\n"));
  });
});

/* 单一真源守卫：已收成一份的几何 / 工厂 / 闸，第二份一出现即红——注释里的「与 X 同式」拦不住抄，正则拦得住。 */
describe("静态守卫：单一真源", () => {
  const files = walk(SRC).map(f => [path.relative(SRC, f).replace(/\\/g, "/"), readFileSync(f, "utf8").split(/\r?\n/)] as const);
  /** 命中 re 的 文件:行号，only 里的文件不计 */
  const hitsOutside = (re: RegExp, only: string[]): string[] =>
    files.flatMap(([f, ls]) => only.includes(f) ? [] : ls.flatMap((l, i) => re.test(l) ? [`${f}:${i + 1}`] : []));
  const linesIn = (file: string, re: RegExp): number => files.find(([f]) => f === file)![1].filter(l => re.test(l)).length;

  it("涂改章的格矩形只有 core/grid.stampRect 一份", () => {
    assert.deepStrictEqual(hitsOutside(/bs \/ 2 - bb/, ["core/grid.ts"]), [], "粗块章矩形又被抄了一份——走 stampRect");
    assert.strictEqual(linesIn("core/grid.ts", /bs \/ 2 - bb/), 2, "grid.ts 里粗块矩形应恰两行（c0/c1 与 r0/r1）");
  });
  it("对象 id 工厂只有 core/util.newId 一份", () => {
    assert.deepStrictEqual(hitsOutside(/Date\.now\(\)\.toString\(36\)/, ["core/util.ts"]), [], "又出现一个 id 工厂——走 newId(prefix)");
  });
  it("经向 cos 折算的极区地板只有 core/geo.lonCos 一份", () => {
    const re = /Math\.max\((0\.0\d+|COS_LAT_FLOOR),\s*Math\.cos/;
    assert.deepStrictEqual(hitsOutside(re, ["core/geo.ts"]), [], "cos 地板又被内联了一份——走 lonCos(meta, lat)");
    assert.strictEqual(linesIn("core/geo.ts", re), 1);
  });
  it("相机经向压缩只有 core/projection.viewCosK 一份", () => {
    assert.deepStrictEqual(hitsOutside(/\? 1 : Math\.cos\(\w+\.lat0 \* Math\.PI \/ 180\)/, []), [], "相机 cos 又被内联了一份——走 viewCosK(cam)");
  });
  it("晕渲光向只有 render/material.SUN 一份", () => {
    assert.deepStrictEqual(hitsOutside(/-?0\.6,\s*-?0\.6,\s*0\.9/, []), [], "光向又写成了字面量——两个渲染器读 material.SHADE_LIGHT");
  });
  it("水面配色只有 render/material.WATER 一份", () => {
    const re = /0\.55,\s*0\.72,\s*0\.75|\b38(\.0)?,\s*66(\.0)?,\s*86\b|\b40(\.0)?,\s*90(\.0)?,\s*132\b|\b100(\.0)?,\s*160(\.0)?,\s*198\b/;
    assert.deepStrictEqual(hitsOutside(re, ["render/material.ts"]), [], "水色又写成了字面量——两个渲染器读 material.WATER，河口与湖面才接得上色");
  });
  it("水段色阶的深端（水面下多少个高程单位到最深色）两个渲染器同值，且等于生成器压群岛浅滩的深度", () => {
    const re = /e\s*-\s*ws\s*\+\s*([\d.]+)\)\s*\/\s*0\.33/;
    for (const f of ["render/terrainGL.ts", "render/terrainCPU.ts"]) {
      const hit = files.find(([n]) => n === f)![1].map(l => re.exec(l)).filter(Boolean);
      assert.strictEqual(hit.length, 1, `${f} 里水段色阶那一行应恰一处`);
      assert.strictEqual(+hit[0]![1], ISL_SHOAL_U, `${f} 的水段色阶深端与 gen2.ISL_SHOAL_U 不同——群岛的浅滩会压不到深海色，或压过了头`);
    }
  });
  it("单飞行闸只有 shell/singleflight 一份", () => {
    assert.deepStrictEqual(hitsOutside(/\b\w*(busy|Busy|eroding)\s*=\s*true\b/, ["shell/singleflight.ts"]), [], "又手写了一份 busy/dirty 闸——走 singleFlight(run, refire)");
  });
});

/* 分层依赖只许自下而上：core < worker < data < render < app < shell < ui。
   按源码文本取相对 import 的说明符，import type、export … from 与动态 import 同算。 */
describe("静态守卫：分层依赖", () => {
  /** 每条相对 import：[源文件, 说明符, 目标（相对 src/）] */
  const edges = walk(SRC).flatMap(abs => {
    const f = path.relative(SRC, abs).replace(/\\/g, "/");
    const src = readFileSync(abs, "utf8");
    const re = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;
    return [...src.matchAll(re)].map(m => m[1] ?? m[2] ?? m[3]).filter(s => s.startsWith("."))
      .map(s => [f, s, path.posix.join(path.posix.dirname(f), s)] as const);
  });
  /** from 目录下引到 bad(目标顶层目录) 为真的边，allow 里的「源文件 → 目标」不计 */
  const crossing = (from: string, bad: (top: string) => boolean, allow: string[] = []): string[] =>
    edges.filter(([f, , t]) => f.startsWith(from + "/") && bad(t.split("/")[0]) && !allow.includes(`${f} → ${t}`))
      .map(([f, s]) => `${f} import 了 "${s}"`);
  const none = (hits: string[], why: string) => assert.deepStrictEqual(hits, [], `${why}\n${hits.join("\n")}`);

  it("core/ 只引 core/ 内部（import type 也算）", () => {
    none(crossing("core", d => d !== "core"),
      "core 是最底层的纯逻辑，Worker 与 node:test 直接加载它——引上层会把渲染、状态或外壳一起拖进去：");
  });
  it("app/ 不引 shell/ 与 ui/", () => {
    none(crossing("app", d => d === "shell" || d === "ui"),
      "app 是应用状态与写入口层，外壳与组件都依赖它——它反引 shell / ui 就成环：");
  });
  it("ui/ 不引 shell/", () => {
    none(crossing("ui", d => d === "shell"),
      "shell/boot 挂载组件，组件与外壳之间只经 app 层的信号与写入口交换——组件反引外壳就成环：");
  });
  it("shell/ 不引 ui/，组合根 boot.ts 挂载组件的那一条除外", () => {
    none(crossing("shell", d => d === "ui", ["shell/boot.ts → ui/mount.tsx"]),
      "外壳在组件之下，只有组合根 shell/boot.ts 挂载组件——别的外壳模块要组件的东西，先把它下沉到 app/：");
  });
});

/* 生成器 v2 的跨引擎确定性：流向树会把 1 ULP 放大成整片流域翻转，而 Math.sin / exp / pow 这类函数各引擎可差 1 ULP——
   单测在 Node 里永远绿，只有在另一个浏览器上才翻，所以靠正则守住纪律。 */
describe("静态守卫：生成器 v2 只用四则、开方与整数哈希", () => {
  /* 生成链与块层嵌套解的文件、各自许引的运行时模块（noise / relief / geo / elev / erode 内部都用 Math.sin 或 Math.cos，一个都不许进） */
  const FILES: [string, string[]][] = [["core/gen2.ts", ["./constants.ts", "./gen2mesh.ts", "./steady.ts", "./types.ts"]], ["core/gen2mesh.ts", []], ["core/steady.ts", []],
    ["core/nested.ts", ["./constants.ts", "./gen2.ts", "./gen2mesh.ts", "./steady.ts"]]];
  for (const [f, allowed] of FILES) {
    const src = readFileSync(path.join(SRC, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    it(`${f} 不调超越函数`, () => {
      const hits = src.match(/\bMath\.(sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|exp|expm1|log|log1p|log2|log10|pow|hypot|cbrt)\s*\(/g) || [];
      assert.deepStrictEqual(hits, [], `${f} 用了各引擎结果可差 1 ULP 的函数——正余弦走 sinR/cosD 多项式`);
    });
    it(`${f} 不用 ** 运算符（等同 Math.pow）`, () => {
      assert.deepStrictEqual(src.match(/[\w)\]]\s*\*\*=?\s*[\w(+-]/g) || [], [], `${f} 出现了 ** 或 **=——整数次幂写成连乘`);
    });
    it(`${f} 运行时只引 ${allowed.join("、") || "（无）"}`, () => {
      const mods = [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)].map(m => m[1]).sort();
      assert.deepStrictEqual(mods, allowed);
    });
  }
});

/* 尺度常数的锚定登记：侵蚀、嵌套解、生成器与分块的每个顶层数值常数，都在下面四张表里登记它按什么锚定、是什么量。
   按格的量换格边时物理含义跟着变，而同一套算法要在 100 m 到 36 km 的格边上跑——新常数落笔前必须先答它按什么锚定。 */
type Anchor = { by: "phys" | "grid" | "extent" | "px" | "none"; unit: string };
/** phys 物理量纲（换格边含义不变）· grid 按格（格数、格距倍数、每格每轮的系数、格上的迭代轮数）· px 按屏幕像素 · none 比例、权重、抽象高程、代号 */
const phys = (unit: string): Anchor => ({ by: "phys", unit }), grid = (unit: string): Anchor => ({ by: "grid", unit });
const px = (unit: string): Anchor => ({ by: "px", unit }), none = (unit: string): Anchor => ({ by: "none", unit });
/** 按图幅：宏观格数固定，所以「缺省图幅上的公里 × 图幅线尺度比」与「宏观格边的倍数」是同一种锚定，都记在这一类 */
const extent = (unit: string): Anchor => ({ by: "extent", unit });

const ERODE_ANCHORS: Record<string, Anchor> = {
  MAX_FINE: grid("细格数预算（战略图工作档）"),
  MAX_FINE_TAC: grid("细格数预算（战术图工作档）"),
  ITERS: grid("细级迭代轮数"),
  KDT: phys("每轮的河蚀强度 K·dt（f＝KDT·√A/dist，A 取 km²、dist 取 km）"),
  ACRIT_CELLS: grid("河道起始的参照细格数"),
  DIFF: grid("细级每轮每格的扩散系数（4 邻）"),
  POST_DIFF: grid("细级收尾扩散轮数"),
  WARP1: grid("类型格距的倍数（长波扭曲幅度）"),
  WARP2: grid("类型格距的倍数（短波扭曲幅度）"),
  TYPE_FEATHER: grid("类型格距的倍数（羽化半距）"),
  DETAIL_AMP: none("抽象高程（表面细节幅度，乘坡度键）"),
  DETAIL_SLOPE_K: grid("每参照细格的抽象坡折成细节键的增益"),
  DETAIL_SLOPE_CAP: none("细节键的上限"),
  EPS: grid("抽象高程/格（填洼的排水梯度）"),
  COARSE_K: grid("参照细格数（粗级的格边）"),
  COARSE_ITERS: grid("粗级迭代轮数"),
  COARSE_DIFF: grid("粗级每轮每格的扩散系数（兼物理扩散的地板）"),
  COARSE_MIN: grid("粗级格数（任一轴不足即不跑粗级）"),
  COARSE_D_KM2: phys("km²（粗级每轮的物理扩散量）"),
  COARSE_CARVE_SIG_KM: phys("km（涂改被磨平的 σ 上限）"),
  CARVED_BASIN_M: phys("m"),
  DIFF_MONO: grid("每轮每格扩散系数的单调上限（4 邻显式格式）"),
  SHORE_LAND: none("抽象高程"),
  MESO_EALGO: none("代号"),
  MESO_MICRO_M: phys("m"),
  MESO_MICRO_KM: phys("（波长 km，权重）"),
  EALGO: none("代号"),
  WORK_NEST_MIN: grid("细分倍率（每类型格边的细格数）"),
};
const NESTED_ANCHORS: Record<string, Anchor> = {
  NEST_VER: none("代号"),
  NEST_MARGIN: grid("父格数（解的窗口外扩）"),
  NEST_REACH: grid("父格数（骨架源点的外扩）"),
  NEST_PAD: grid("父格数（单的裁剪外扩）"),
  NEST_SKEL_CELLS: grid("父格面积的倍数（骨架的汇流门槛）"),
  SK_R: grid("父格偏移上限（骨架编码）"),
  SK_W: grid("骨架编码一行的父格偏移数"),
  NEST_JIT: grid("细格（节点抖动全幅）"),
  NEST_KJIT: none("K 的相对抖动全幅"),
  NEST_ITERS: grid("细格三角网上的求解轮数"),
  HILL_KM2: phys("km²（坡面扩散的汇流门槛）"),
  HILL_PASSES: grid("坡面扩散遍数（细格）"),
  HILL_K: grid("每遍每细格的扩散系数"),
  LOW_PASSES: grid("低通遍数（半径一个目标格）"),
  NEST_AMP_REF: none("地势起伏档（0..1）的参照值"),
  SEED_K: none("种子偏移"),
  SEED_H0: none("种子偏移"),
  SEED_JIT: none("种子偏移"),
  UPLIFT_T: phys("τ（Σ 边长 km ÷ (K·√汇流 km²)）"),
  UPLIFT_R: none("比例（老面相对膝点的缩放）"),
  UPLIFT_ACH_KM2: phys("km²"),
  VF_KM: phys("km/√km²（谷底半宽＝VF_KM·√A/2）"),
  VF_MIN_KM2: phys("km²"),
  FLOOR_MAX_KM: phys("km"),
  FLOOR_MAX_M: phys("m"),
  TAU_INF: none("τ 的有限「无穷」"),
  NEST_TGT_Q: none("抽象高程（目标面量化步长）"),
  WORK_NEST_VER: none("代号"),
  CAL_STEPS: none("牛顿步数上限（一维求根，与格无关）"),
};
const GEN2_ANCHORS: Record<string, Anchor> = {
  MACRO_CAP: grid("宏观格数预算"),
  GEN2_SEED_MAX: none("种子值域"),
  PI: none("数学常数"),
  TAU: none("数学常数"),
  D2R: none("每度的弧度"),
  G12: none("噪声梯度向量表"),
  COAST_G: none("海岸噪声逐倍频幅度比"),
  COAST_OCT: none("海岸噪声倍频数"),
  CO_LIN: extent("缺省图幅上的 km，乘图幅线尺度比 ks"),
  CO_LOUT: extent("缺省图幅上的 km，乘 ks"),
  CO_ZONE: extent("缺省图幅上的 km，乘 ks"),
  CO_AMP: none("陆地度（海岸噪声幅度）"),
  CO_WARP: none("海岸噪声首波长的倍数"),
  CO_HW: extent("缺省图幅上的 km，乘 ks"),
  CO_LAM: extent("缺省图幅上的 km，乘 ks"),
  CO_HWK: none("到中轴距离与倍频波长之比"),
  ISL_D: extent("缺省图幅上的 km，乘 ks"),
  ISL_W: extent("缺省图幅上的 km，乘 ks"),
  ISL_LAM: extent("缺省图幅上的 km，乘 ks"),
  CO_ISL: none("陆地度（近岸岛拉满时的幅度）"),
  ISL_T: none("噪声门槛"),
  ISL_AMP: none("陆地度（群岛的海岸噪声幅度）"),
  DEFAULT_AREA_KM2: phys("km²（缺省图幅的名义面积）"),
  BACKARC_P: none("概率"),
  PEAK_KNEE_M: phys("m"),
  PEAK_SOFT_M: phys("m"),
  STEADY_TOL: none("相对容差"),
  KAPPA_M: phys("m/抬升单位"),
  LAKE_MIN_M: phys("m"),
  ACRIT_KM2: phys("km²"),
  PREC_MM: phys("mm/年（水汽为 1 时的降水）"),
  LAKE_END_MIN: extent("平均宏观格面积的倍数"),
  SALT_FRAC: none("比例（占洼地面积）"),
  SALT_RING_P: phys("mm/年"),
  SALT_RING: none("比例（占湖面面积）"),
  ENDO_RIM_M: phys("m"),
  BOWL_MAX: none("比例（占原地高程）"),
  LOSS_K: phys("1/km（每单位干燥度）"),
  EVAP_LAT: phys("（|纬度| °，潜在蒸散 mm/年）"),
  D4R: grid("四邻的行偏移（格）"),
  D4C: grid("四邻的列偏移（格）"),
  D8R: grid("八邻的行偏移（格）"),
  D8C: grid("八邻的列偏移（格）"),
  SUB_DRY: none("比例"),
  SUB_ET: none("比例"),
  SUB_RAIN: none("比例"),
  MESH_SMOOTH: extent("宏观格边的倍数（细格磨平半径）"),
  WATER_CLS: none("复合类号"),
  SALT_CLS: none("复合类号"),
  CF_COAST: none("判据位"),
  CF_SALT: none("判据位"),
  CF_MARSH: none("判据位"),
  CF_DESERT: none("判据位"),
  CF_GRASS: none("判据位"),
  CF_FOREST: none("判据位"),
  SHELF_BREAK_M: phys("m"),
  SHELF_KM: phys("km"),
  SLOPE_TAN: phys("坡度（tan）"),
  ISL_SHELF_SMOOTH: extent("宏观格边的倍数（陆地度磨平半径）"),
  ISL_SHELF_K: none("比例"),
  ISL_SHOAL_U: none("抽象高程"),
  SHORE_U: none("抽象高程"),
  RIV_Q: extent("（滑杆位置，缺省图幅上的 m³/s），按图幅面积比缩放"),
  RIV_WATER: none("（滑杆位置，径流倍率）"),
  RIV_KEEP: none("比例（占起画水量）"),
  RIV_CLIP_N: extent("每段宏观折线的取样数"),
  RIV_REACH: extent("宏观格距的倍数"),
  ARID_MOIST: none("水汽门槛"),
  SEA: none("占位码"),
  WET_MARSH: phys("m³/s ÷ m/km"),
  MESO_KAPPA_M: phys("m/抬升单位"),
  MESO_ACRIT_KM2: phys("km²"),
  MESO_HEAD: none("源头修正系数"),
  MESO_SMOOTH: extent("宏观格边的倍数（细格磨平半径）"),
  MESO_PLAIN_U0: none("宏观抬升（抽象单位）"),
  MESO_PLAIN_U1: none("宏观抬升（抽象单位）"),
  MESO_ENV_U0: none("宏观抬升（抽象单位）"),
  MESO_ENV_U1: none("宏观抬升（抽象单位）"),
  MESO_ENV_A0: phys("km²"),
  MESO_ENV_A1: phys("km²"),
  MESO_U_MIN: none("宏观抬升（抽象单位）"),
  MESO_MAXIT: grid("细格三角网上的稳态轮数上限"),
  MESO_KERN: grid("5×5 格的二项式核权重"),
  MESO_GEN_KM0: phys("km（图幅 √(宽×高)）"),
  MESO_GEN_KM1: phys("km（图幅 √(宽×高)）"),
  MESO_GEN_MIN: none("平滑强度地板"),
  MESO_VER: none("代号"),
  BAND_KM: phys("km"),
  BAND_CONTRAST: none("倍率比"),
  BAND_BEND_KM: phys("km"),
  BAND_BEND: none("带数"),
  BAND_U0: none("U/Umax"),
  BAND_U1: none("U/Umax"),
  BAND_VAR_KM: phys("km"),
  BAND_GATE_W: none("噪声值"),
  BAND_SHARE: none("比例"),
  BAND_CAP: none("比例"),
  BAND_FOLD_MIN: none("比例"),
  BAND_GATE_MAX: none("噪声偏移"),
  BAND_TAB: none("倍率表"),
  UPLIFT_SOFT_KM: phys("km"),
  UPLIFT_SOFT_CELLS: grid("细格边的倍数"),
  BASIN_LAKE_KM2: phys("km²"),
  RIV_MICRO_M: phys("m"),
  RIV_MICRO_KM: phys("km（两档波长）"),
  FP_Q: phys("m³/s"),
  FP_SMAX: phys("比降 m/km"),
  FP_WMOD: none("比例（半宽起伏幅度）"),
  FP_WMOD_KM: phys("km"),
  FP_G: phys("m/km（谷底横坡）"),
  FP_OUT: none("离河路程与半宽之比"),
  INC_K: phys("m ÷ (m³/s)^(11/32)"),
  INC_CAP: none("比例（占离海面高度）"),
  RIV_MOUTH: none("倍数（河口展宽）"),
  RIV_SIMPLIFY: grid("格（折线抽稀容差）"),
  RIV_TAUBIN_L: grid("每轮每节点的平滑系数 λ（节点约一格一个）"),
  RIV_TAUBIN_M: grid("每轮每节点的平滑系数 μ（节点约一格一个）"),
  RIV_TAUBIN_N: grid("平滑轮数（按节点）"),
  MZ_S0: phys("比降 m/km"),
  MZ_S1: phys("比降 m/km"),
  MZ_KEEP: none("曲流强度档"),
};
const TILES_ANCHORS: Record<string, Anchor> = {
  TILE_P: grid("父格数（块心边长）"),
  TILE_MARGIN: grid("父格数（块的外扩）"),
  TILE_MAX_X: grid("每父格边的块格数上限"),
  CARVE_Q: none("抽象高程（切割量量化步长）"),
  TILE_VER: none("代号"),
  TILE_W_LO: px("CSS 像素/块格（块开始渐入）"),
  TILE_W_HI: px("CSS 像素/块格（块全权）"),
};
const ANCHOR_TABLES: [file: string, table: string, anchors: Record<string, Anchor>][] = [["core/erode.ts", "ERODE_ANCHORS", ERODE_ANCHORS],
  ["core/nested.ts", "NESTED_ANCHORS", NESTED_ANCHORS], ["core/gen2.ts", "GEN2_ANCHORS", GEN2_ANCHORS], ["core/tiles.ts", "TILES_ANCHORS", TILES_ANCHORS]];
/** 名字后缀所说的锚定 */
const SUFFIX_BY: [RegExp, Anchor["by"]][] = [[/_KM2?$|_M$/, "phys"], [/_CELLS$/, "grid"], [/_PX$/, "px"]];
/** 后缀与登记的锚定不一致、但名字留着的常数：值是为什么 */
const SUFFIX_EXCEPT: Record<string, string> = { RIV_TAUBIN_M: "Taubin 平滑的 λ / μ 一对系数，M 指 μ，不是米" };

/** 跳过 i 处起头的字符串字面量，返回闭引号之后的位置 */
function strEnd(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) { if (s[j] === "\\") j++; else if (s[j] === s[i]) return j + 1; }
  return s.length;
}
/** 注释换成等长空白（换行留着，行首缩进不变）；字符串里的 // 与 /* 不算 */
function stripComments(src: string): string {
  let out = "", from = 0;
  for (let i = 0; i < src.length;) {
    const c = src[i], d = src[i + 1];
    if (c === "\"" || c === "'" || c === "`") i = strEnd(src, i);
    else if (c === "/" && (d === "/" || d === "*")) {
      const k = d === "/" ? src.indexOf("\n", i) : src.indexOf("*/", i + 2), e = k < 0 ? src.length : d === "/" ? k : k + 2;
      out += src.slice(from, i) + src.slice(i, e).replace(/[^\n]/g, " ");
      i = from = e;
    } else i++;
  }
  return out + src.slice(from);
}
/** 自 i 起到括号深度 0 处 stops 里的字符为止（types＝类型注解：尖括号也算深度、跳过 =>）；下一行顶格另起一句也停 */
function scanTo(s: string, i: number, stops: string, types: boolean): number {
  for (let d = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\"" || c === "'" || c === "`") i = strEnd(s, i) - 1;
    else if (types && c === "=" && s[i + 1] === ">") i++;
    else if ("([{".includes(c) || types && c === "<") d++;
    else if (")]}".includes(c) || types && c === ">") d--;
    else if (d === 0 && (stops.includes(c) || c === "\n" && /[A-Za-z_$]/.test(s[i + 1] ?? ""))) return i;
  }
  return i;
}
/** 初值只由数字、标识符（含属性访问）、Math.* 调用、算术与位运算、括号、方括号与逗号组成：数值、数值表达式与数值元组都算 */
function numericInit(init: string): boolean {
  const t = init.replace(/\bas\s+const\b/g, "").replace(/\bMath\.\w+/g, "0");
  return /\S/.test(t) && /^[\w\s.+\-*\/%()[\],|&^~<>]*$/.test(t) && !/[A-Za-z_$][\w$]*\s*\(/.test(t) && !/\b(true|false|null|undefined|new|typeof|void)\b/.test(t);
}
/** 顶层（顶格的 const / export const）全大写命名、初值是数值的常数名：一句里逗号并列的、初值跨行的都算 */
function scaleConsts(src: string): string[] {
  const s = stripComments(src), out: string[] = [];
  for (const m of s.matchAll(/^(?:export[ \t]+)?const[ \t]+/gm)) {
    for (let i = m.index + m[0].length; ;) {
      const id = /^\s*([A-Za-z_$][\w$]*)\s*/.exec(s.slice(i, i + 256));
      if (!id) break;
      i += id[0].length;
      if (s[i] === ":") i = scanTo(s, i + 1, "=", true);
      if (s[i] !== "=") break;
      const end = scanTo(s, i + 1, ",;", false);
      if (/^[A-Z][A-Z0-9_]*$/.test(id[1]) && numericInit(s.slice(i + 1, end))) out.push(id[1]);
      if (s[end] !== ",") break;
      i = end + 1;
    }
  }
  return out;
}

describe("静态守卫：尺度常数都登记了锚定方式", () => {
  const found = ANCHOR_TABLES.map(([f, t, A]) => ({ f, t, A, names: scaleConsts(readFileSync(path.join(SRC, f), "utf8")) }));
  it("四个文件的顶层尺度常数个个登记在表", () => {
    const miss = found.flatMap(({ f, t, A, names }) => names.filter(nm => !Object.hasOwn(A, nm))
      .map(nm => `${f} 新增了尺度常数 ${nm}：先回答它按什么锚定（物理量纲 / 按格 / 按图幅 / 按像素 / 无量纲），再登记到 ${t}`));
    assert.deepStrictEqual(miss, [], miss.join("\n"));
  });
  it("登记表里没有源码中已不存在的常数", () => {
    const stale = found.flatMap(({ f, t, A, names }) => Object.keys(A).filter(nm => !names.includes(nm))
      .map(nm => `${t} 登记了 ${nm}，但 ${f} 里已没有这个顶层尺度常数：从表里删掉`));
    assert.deepStrictEqual(stale, [], stale.join("\n"));
  });
  it("名字后缀与登记一致：_KM / _KM2 / _M 是物理量纲，_CELLS 按格，_PX 按像素", () => {
    const want = (nm: string) => SUFFIX_BY.find(([re]) => re.test(nm))?.[1];
    const all = ANCHOR_TABLES.flatMap(([, t, A]) => Object.entries(A).map(([nm, a]) => ({ t, nm, by: a.by, w: want(nm) })));
    const bad = all.filter(x => x.w && x.w !== x.by && !Object.hasOwn(SUFFIX_EXCEPT, x.nm))
      .map(x => `${x.t}.${x.nm} 的后缀说它是 ${x.w}，却登记为 ${x.by}：改名或改登记，确属例外就写进 SUFFIX_EXCEPT 并说明为什么`);
    const stale = Object.keys(SUFFIX_EXCEPT).filter(nm => !all.some(x => x.nm === nm && x.w && x.w !== x.by))
      .map(nm => `SUFFIX_EXCEPT 放行的 ${nm} 已不存在或已与后缀一致：从例外表删掉`);
    assert.deepStrictEqual([...bad, ...stale], [], [...bad, ...stale].join("\n"));
  });
});
