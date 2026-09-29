/* 图幅判据（core/frame）：平面 / 球面部分经跨 / 球面满 360° 三种图幅上的包含、钳制、取景与屏幕矩形 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clampToFrame, frameRectsPx, frameView, inFrame, mapFrame, FRAME_SLACK } from "../src/core/frame.ts";
import { project, VIEW_LAT_MAX, type Camera } from "../src/core/projection.ts";
import { DEFAULT_BBOX, type Meta } from "../src/core/types.ts";

const FLAT: Meta = { worldModel: "flat", bbox: { lonMin: 0, lonMax: 100, latMin: 0, latMax: 50 } };
const DATELINE: Meta = { bbox: { lonMin: 150, lonMax: 210, latMin: -10, latMax: 30 } };   // 球面，跨对跖线
const GLOBE: Meta = { bbox: { lonMin: -180, lonMax: 180, latMin: -60, latMax: 75 } };

describe("mapFrame", () => {
  it("缺 bbox 与网格同取 DEFAULT_BBOX；缺 worldModel 是球面；满 360° 经跨才环绕", () => {
    const f = mapFrame({});
    assert.deepEqual([f.lonMin, f.lonMax, f.latMin, f.latMax], [DEFAULT_BBOX.lonMin, DEFAULT_BBOX.lonMax, DEFAULT_BBOX.latMin, DEFAULT_BBOX.latMax]);
    assert.equal(f.sphere, true);
    assert.equal(f.wrap, false);
    assert.equal(mapFrame(FLAT).sphere, false);
    assert.equal(mapFrame(GLOBE).wrap, true);
    assert.equal(mapFrame({ worldModel: "flat", bbox: GLOBE.bbox }).wrap, false, "平面图经跨 360 也有东西两条图廓");
  });
});

describe("inFrame / clampToFrame", () => {
  it("平面：四边为界，钳到最近的图廓", () => {
    const f = mapFrame(FLAT);
    assert.equal(inFrame(f, 50, 25), true);
    assert.equal(inFrame(f, 101, 25), false);
    assert.equal(inFrame(f, 50, -1), false);
    assert.deepEqual(clampToFrame(f, 130, -20), [100, 0]);
    assert.deepEqual(clampToFrame(f, 50, 25), [50, 25], "图内原样");
  });
  it("球面跨对跖线：经度按 360° 周期判，钳到近的一侧并折回 [-180,180)", () => {
    const f = mapFrame(DATELINE);
    assert.equal(inFrame(f, -170, 0), true, "-170 即 190");
    assert.equal(inFrame(f, 170, 0), true);
    assert.equal(inFrame(f, 0, 0), false);
    assert.deepEqual(clampToFrame(f, -100, 0), [-150, 0], "-100 离东图廓 210（-150）更近");
    assert.deepEqual(clampToFrame(f, 100, 0), [150, 0], "100 离西图廓 150 更近");
  });
  it("满经跨球面：经向无边，只钳纬度", () => {
    const f = mapFrame(GLOBE);
    assert.equal(inFrame(f, 1234, 10), true);
    assert.equal(inFrame(f, 0, 80), false);
    assert.deepEqual(clampToFrame(f, 1234, 80), [1234, 75]);
  });
  it("贴边容差：钳到图廓的点按存档四位小数舍入后仍判在图内", () => {
    const f = mapFrame({ worldModel: "flat", bbox: { lonMin: 0, lonMax: 10.123456, latMin: 0, latMax: 1 } });
    const [lon] = clampToFrame(f, 99, 0.5);
    assert.equal(inFrame(f, +lon.toFixed(4), 0.5), true);
  });
});

describe("frameView（相机取景）", () => {
  const W = 1000, H = 600;
  it("图幅装得下就居中", () => {
    const v = frameView({ lon0: -300, lat0: 999, degPerPx: 0.5 }, FLAT, W, H);   // 100° 宽 × 0.5 度/像素 ＝ 200 px < 1000
    assert.deepEqual(v, { lon0: 50, lat0: 25 });
  });
  it("装不下：图廓边至多进到视口的 1/4", () => {
    const dpp = 0.01;   // 图幅 10000 × 5000 px
    const cam = (v: { lon0: number; lat0: number }): Camera => ({ ...v, degPerPx: dpp, w: W, h: H, flat: true });
    const left = frameView({ lon0: -50, lat0: -50, degPerPx: dpp }, FLAT, W, H);
    const [x0, y1] = project(cam(left), 0, 0);
    assert.ok(Math.abs(x0 - FRAME_SLACK * W) < 1e-6, `西图廓在 x=${x0}`);
    assert.ok(Math.abs(y1 - (1 - FRAME_SLACK) * H) < 1e-6, `南图廓在 y=${y1}`);
    const mid = { lon0: 40, lat0: 20, degPerPx: dpp };
    assert.deepEqual(frameView(mid, FLAT, W, H), { lon0: 40, lat0: 20 }, "图内随意停");
  });
  it("球面跨对跖线：取离视中心最近的那份图幅，结果折回 [-180,180)", () => {
    const dpp = 0.01;
    const inside = frameView({ lon0: -170, lat0: 10, degPerPx: dpp }, DATELINE, W, H);
    assert.deepEqual(inside, { lon0: -170, lat0: 10 });
    const out = frameView({ lon0: -100, lat0: 10, degPerPx: dpp }, DATELINE, W, H);
    assert.ok(out.lon0 >= -180 && out.lon0 < 180, `lon0=${out.lon0}`);
    assert.ok(inFrame(mapFrame(DATELINE), out.lon0, out.lat0), "视中心回到图幅里（东图廓一侧）");
    assert.ok(out.lon0 < -150 && out.lon0 > -160, `lon0=${out.lon0}`);
  });
  it("球面视中心纬度守 ±VIEW_LAT_MAX；满经跨不动经度", () => {
    const v = frameView({ lon0: 123, lat0: 74, degPerPx: 0.001 }, { bbox: { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 } }, W, H);
    assert.equal(v.lat0, 74);
    const top = frameView({ lon0: 123, lat0: 89.9, degPerPx: 0.001 }, { bbox: { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 } }, W, H);
    assert.equal(top.lat0, VIEW_LAT_MAX);
    assert.equal(top.lon0, 123);
  });
});

describe("frameRectsPx", () => {
  it("平面一块；满经跨球面是一条横带（x 为 ∓∞）", () => {
    const cam: Camera = { lon0: 50, lat0: 25, degPerPx: 0.2, w: 800, h: 600, flat: true };
    const [r] = frameRectsPx(cam, FLAT);
    assert.deepEqual([r.x0, r.y0], project(cam, 0, 50));
    assert.deepEqual([r.x1, r.y1], project(cam, 100, 0));
    const g = frameRectsPx({ lon0: 0, lat0: 0, degPerPx: 0.5, w: 800, h: 600, flat: false }, GLOBE);
    assert.equal(g.length, 1);
    assert.equal(g[0].x0, -Infinity);
    assert.equal(g[0].x1, Infinity);
  });
});
