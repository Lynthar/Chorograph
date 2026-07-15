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
