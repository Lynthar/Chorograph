/* 等高线注记的纯几何（render/contourlab）：注记等高距的取法、等值线链成折线、按曲率定位。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LAB_MAX_LEVELS, labStepFor, placeLabels, tracePolylines, type LabSurf } from "../src/render/contourlab.ts";

/** 采样面：行 0 在上，v(x,y) 给值（NaN＝不出线） */
function surf(w: number, h: number, v: (x: number, y: number) => number): LabSurf {
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = v(x, y);
  return { w, h, v: a };
}

describe("等高线注记的等高距（labStepFor）", () => {
  it("默认标计曲线；不足两条改标首曲线；过密按整数倍抽稀——三种结果都是首曲线等距的整数倍", () => {
    assert.strictEqual(labStepFor(4000, 200), 1000, "4000/1000＝4 条计曲线：照标");
    assert.strictEqual(labStepFor(1000, 200), 200, "计曲线只 1 条＝数不出来，改标首曲线");
    assert.strictEqual(labStepFor(40000, 200), 4000, "40 条计曲线＝ceil(40/12)=4 倍抽稀");
    assert.strictEqual(labStepFor(40000, 200) % 1000, 0, "抽稀后仍落在计曲线上");
    assert.ok(40000 / labStepFor(40000, 200) <= LAB_MAX_LEVELS, "条数封顶");
    assert.strictEqual(labStepFor(0, 200), 1000, "无起伏＝随便，不用于出线");
    assert.strictEqual(labStepFor(4000, 0), 0, "没有首曲线等距＝不标");
  });
});

describe("等值线链成折线（tracePolylines）", () => {
  it("东西向线性坡：一条纵贯折线，交点按线性内插落在格间", () => {
    const polys = tracePolylines(surf(3, 3, x => x), 0.5);
    assert.strictEqual(polys.length, 1);
    assert.deepStrictEqual(Array.from(polys[0]), [0.5, 0, 0.5, 1, 0.5, 2]);
  });
  it("NaN 角（水或图幅外）让该格不出线：链断成两截", () => {
    const polys = tracePolylines(surf(3, 5, (x, y) => y === 2 ? NaN : x), 0.5);
    assert.strictEqual(polys.length, 2, "中间一行挖空＝上下各一条");
    for (const p of polys) assert.strictEqual(p.length, 4, "每截两点");
    assert.deepStrictEqual(Array.from(polys[0]), [0.5, 0, 0.5, 1]);
  });
  it("锥体：闭合环首尾同点，且整条线围着中心", () => {
    const polys = tracePolylines(surf(9, 9, (x, y) => 6 - Math.hypot(x - 4, y - 4)), 4);
    assert.strictEqual(polys.length, 1);
    const p = polys[0], n = p.length / 2;
    assert.ok(n > 8, "环上应有多点，实得 " + n);
    assert.deepStrictEqual([p[0], p[1]], [p[2 * n - 2], p[2 * n - 1]], "闭合");
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(p[2 * i] - 4, p[2 * i + 1] - 4);
      assert.ok(d > 1.4 && d < 2.6, `环点到中心 ${d.toFixed(2)} 应≈2`);
    }
  });
  it("等值面恰过格点（角值＝level）不出除零点：全格同值时一条线也不画", () => {
    for (const p of tracePolylines(surf(4, 4, () => 1), 1)) for (const v of p) assert.ok(isFinite(v), "不得有 NaN/Inf 交点");
    assert.deepStrictEqual(tracePolylines(surf(4, 4, () => 1), 1), [], "整片等于 level＝全在线内，无穿越");
  });
});

describe("注记定位（placeLabels）", () => {
  const line = (n: number, f: (i: number) => [number, number]): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) { const [x, y] = f(i); out.push(x, y); }
    return out;
  };
  it("按目标间距给枚数，落在各段正中", () => {
    const poly = line(101, i => [i * 10, 0]);   // 长 1000
    const pos = placeLabels(poly, 340, 110, 30);
    assert.strictEqual(pos.length / 2, 3, "1000/340 四舍五入＝3 枚");
    assert.deepStrictEqual(pos.map(v => Math.round(v)), [167, 0, 500, 0, 833, 0]);
  });
  it("短于 minLen 不标；只够一枚时给一枚", () => {
    assert.deepStrictEqual(placeLabels(line(6, i => [i * 10, 0]), 340, 110, 30), [], "长 50＜110");
    assert.strictEqual(placeLabels(line(16, i => [i * 10, 0]), 340, 110, 30).length / 2, 1, "长 150＝一枚");
  });
  it("挑曲率最小处：折角处让开，落到直段上", () => {
    // 先东行 200 再南下 200：目标弧长恰在折角，注记须落在直段
    const poly = line(41, i => i <= 20 ? [i * 10, 0] : [200, (i - 20) * 10]);
    const pos = placeLabels(poly, 400, 110, 30);
    assert.strictEqual(pos.length / 2, 1);
    const [x, y] = [pos[0], pos[1]];
    assert.ok(Math.hypot(x - 200, y - 0) > 30 * 0.75, `落点 (${x},${y}) 的量直窗没避开折角：数字会压在弯上`);
    assert.ok(y === 0 || x === 200, "落点应在某一直段上");
  });
  it("折线短于量直跨度＝弃标（不会给出 NaN 落点）", () => {
    for (const v of placeLabels(line(13, i => [i * 10, 0]), 340, 110, 200)) assert.ok(isFinite(v));
  });
});
