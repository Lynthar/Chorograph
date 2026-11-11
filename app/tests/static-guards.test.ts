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
