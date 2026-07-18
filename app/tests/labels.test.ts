/* 标签避让场（render/labels.ts 纯逻辑）：占位/让位语义与碰撞余量。
   接线（drawNodes/drawUnits 的候选位次序、当日事件提位、部队让地名）走截图目检。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLabelField } from "../src/render/labels.ts";

describe("标签避让场", () => {
  it("先占先得：同位再试被拒；claim 无条件不检查", () => {
    const f = createLabelField();
    assert.equal(f.tryPlace({ x: 10, y: 10, w: 40, h: 15 }), true);
    assert.equal(f.tryPlace({ x: 12, y: 12, w: 40, h: 15 }), false, "重叠被拒");
    f.claim({ x: 12, y: 12, w: 40, h: 15 });   // 标注/选中：无条件占位不抛
    assert.equal(f.tryPlace({ x: 14, y: 14, w: 10, h: 8 }), false, "claim 的占位同样挡人");
  });
  it("碰撞余量与旧 drawNodes.collide 一致：横向缝 ≤2px 算撞、3px 放行；纵向 ≤1px 算撞、2px 放行", () => {
    const f = createLabelField();
    f.claim({ x: 0, y: 0, w: 50, h: 15 });
    assert.equal(f.tryPlace({ x: 52, y: 0, w: 20, h: 15 }), false, "横缝 2px 撞");
    assert.equal(f.tryPlace({ x: 53, y: 0, w: 20, h: 15 }), true, "横缝 3px 过");
    const g = createLabelField();
    g.claim({ x: 0, y: 0, w: 50, h: 15 });
    assert.equal(g.tryPlace({ x: 0, y: 16, w: 50, h: 15 }), false, "纵缝 1px 撞");
    assert.equal(g.tryPlace({ x: 0, y: 17, w: 50, h: 15 }), true, "纵缝 2px 过");
  });
  it("跨哈希格边界（格宽 96）也能撞上", () => {
    const f = createLabelField();
    assert.equal(f.tryPlace({ x: 90, y: 90, w: 20, h: 12 }), true);    // 跨 (0,0)/(1,0)/(0,1)/(1,1) 四格
    assert.equal(f.tryPlace({ x: 100, y: 95, w: 30, h: 12 }), false, "邻格矩形照样判撞");
    assert.equal(f.tryPlace({ x: 300, y: 300, w: 30, h: 12 }), true, "远处不受影响");
  });
});
