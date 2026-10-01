/* 掩膜屏幕栅格（render/maskraster）：逐格翻行、面积平均缩小守恒、轮廓环几何。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maskCoverage, maskOutline, type Coverage } from "../src/render/maskraster.ts";
import type { VisMask } from "../src/core/viewshed.ts";

/** 掩膜：on(c, r) 为真的格可达，行 0 在南 */
function mk(cols: number, rows: number, on: (c: number, r: number) => boolean): VisMask {
  const vis = new Uint8Array(cols * rows);
  let nVis = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (on(c, r)) { vis[r * cols + c] = 1; nVis++; }
  return { bb: { lonMin: 0, lonMax: cols, latMin: 0, latMax: rows }, cols, rows, vis, nVis, nIn: cols * rows, eyeOff: 0 };
}
const sum = (a: ArrayLike<number>): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };

describe("掩膜屏幕栅格（render/maskraster）", () => {
  it("每格 ≥1 像素：逐格原样、翻行（掩膜行 0 在南、位图行 0 在上）", () => {
    const m = mk(3, 2, (c, r) => (r === 0 && c === 0) || (r === 1 && c === 2));
    const cv = maskCoverage(m, 4);
    assert.equal(cv.w, 3); assert.equal(cv.h, 2);
    assert.deepEqual(Array.from(cv.cov), [0, 0, 1, 1, 0, 0]);
  });

  it("整除缩小：2×2 源格平均到一个像素", () => {
    const m = mk(4, 4, (c, r) => (c <= 1 && r >= 2) || (c === 2 && r === 3));   // 西北 2×2 全可达 + 北排再多一格
    const cv = maskCoverage(m, 0.5);
    assert.equal(cv.w, 2); assert.equal(cv.h, 2);
    assert.deepEqual(Array.from(cv.cov), [1, 0.25, 0, 0]);
  });

  it("非整除缩小：面积平均守恒（总覆盖 × 缩比 = 可达格数），每像素在 0..1", () => {
    const m = mk(23, 17, (c, r) => ((c * 7 + r * 3) % 5) < 2);
    for (const s of [0.37, 0.71, 0.13]) {
      const cv = maskCoverage(m, s);
      assert.equal(cv.w, Math.ceil(23 * s)); assert.equal(cv.h, Math.ceil(17 * s));
      assert.ok(Math.abs(sum(cv.cov) * (23 / cv.w) * (17 / cv.h) - m.nVis) < 1e-3, `s=${s} 守恒`);
      for (const v of cv.cov) assert.ok(v >= 0 && v <= 1 + 1e-6, `s=${s} 像素值 ${v} 越界`);
    }
  });

  /** 环的总长与点列（扁平 [x,y,…]） */
  const ringLen = (p: number[]): number => { let s = 0; for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return s; };

  it("轮廓：6×6 位图里 3×3 实心块的 0.5 等值线＝一条闭合环（8 条直边 + 4 条切角，总长 8+2√2），全在块外扩半像素之内", () => {
    const cov = new Float32Array(36);
    for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) cov[y * 6 + x] = 1;
    const rings = maskOutline({ w: 6, h: 6, cov } as Coverage);
    assert.equal(rings.length, 1, "一块＝一环（描边不再是一堆各带线帽的散段）");
    const p = rings[0];
    assert.deepEqual([p[0], p[1]], [p[p.length - 2], p[p.length - 1]], "首尾同点");
    assert.equal(p.length / 2 - 1, 12, "12 段");
    for (const v of p) assert.ok(v >= 2 && v <= 5, `点 ${v} 出框`);
    assert.ok(Math.abs(ringLen(p) - (8 + 2 * Math.SQRT2)) < 1e-6, `总长 ${ringLen(p)}`);
  });

  it("轮廓：半覆盖像素按线性插值定交点位置；全空无环、全满只有外框一环", () => {
    const cov = Float32Array.from([0, 0, 0, 0, 0.75, 0, 0, 0, 0]);   // 3×3 中央 0.75
    const rings = maskOutline({ w: 3, h: 3, cov } as Coverage);
    assert.equal(rings.length, 1); assert.equal(rings[0].length / 2 - 1, 4, "一个像素四条切角");
    for (const v of rings[0]) assert.ok(Math.abs(v - 1.5) <= 1 / 3 + 1e-6, `交点 ${v} 应在中心 ±1/3`);
    assert.equal(maskOutline({ w: 2, h: 2, cov: new Float32Array(4) } as Coverage).length, 0);
    const full = maskOutline({ w: 2, h: 2, cov: new Float32Array(4).fill(1) } as Coverage);
    assert.equal(full.length, 1, "位图外视为 0＝外框一环");
    assert.equal(full[0].length / 2 - 1, 8, "外框 8 段");
  });
});
