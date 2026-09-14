/* 静态守卫：外壳拆分补类型后 src/ 已全量纳入 tsc 严格检查，
   原「@ts-nocheck 下漏 import」编译器扫描退役（其职责由 npm run typecheck 全面接管）。
   这里只防回归：任何源文件再挂 @ts-nocheck/@ts-ignore 指令都会让 typecheck 对其（局部）失明，
   漏 import 重新退化为运行时 ReferenceError——历史上三度中招，零容忍。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
});
