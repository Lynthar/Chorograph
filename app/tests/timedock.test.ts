/* 时间坞纯逻辑：主轨聚簇/标签避让、战术「时」窗口、量子化、时轨刻度。
   语义断言（组件 TimeDock.tsx 走截图目检；此处锁的是设计决议的可测部分：
   「事件间距 <10px 聚簇」「当前日 ±1 窗口」「半时辰步进网格」）。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMarks, hourWindow, quantTime, subTicks } from "../src/ui/timedock.ts";
import type { EvMark, TickMark, ClusterMark } from "../src/ui/timedock.ts";

const sameSlot = (t: number, now: number): boolean => Math.floor(t) === Math.floor(now);

describe("buildMarks：事件刻度与聚簇", () => {
  const evs: EvMark[] = [
    { t: 3000, label: "开国" }, { t: 3050, label: "北伐" },
    { t: 3051, label: "会盟" }, { t: 3107, label: "河洛会战" }
  ];
  it("间距 <10px 聚簇为 ×N；远者独立成刻", () => {
    // 范围 2980..3180（span=200），宽 800px → 1 年 = 4px；3050/3051 相距 4px < 10px 聚簇
    const marks = buildMarks(evs, 2980, 3180, 3107, 800, sameSlot);
    const clusters = marks.filter((m): m is ClusterMark => m.kind === "cluster");
    const ticks = marks.filter((m): m is TickMark => m.kind === "tick");
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].n, 2);
    assert.equal(ticks.length, 2);
    // 簇心在两事件中点
    assert.ok(Math.abs(clusters[0].pct - ((3050.5 - 2980) / 200) * 100) < 1e-9);
  });
  it("宽度未测得（0）时不聚簇、不避让", () => {
    const marks = buildMarks(evs, 2980, 3180, 3107, 0, sameSlot);
    assert.equal(marks.filter(m => m.kind === "cluster").length, 0);
    assert.equal(marks.length, 4);
  });
  it("cur=同槽（同年/同日）、fut=整组在未来；范围外事件被滤除", () => {
    const marks = buildMarks(evs.concat([{ t: 9999, label: "域外" }]), 2980, 3180, 3050, 800, sameSlot);
    assert.equal(marks.length, 3);   // 9999 滤除；3050+3051 成簇
    const cl = marks.find((m): m is ClusterMark => m.kind === "cluster")!;
    assert.equal(cl.cur, true);      // 簇内含当年事件
    assert.equal(cl.fut, false);
    const last = marks.find((m): m is TickMark => m.kind === "tick" && m.t === 3107)!;
    assert.equal(last.fut, true);
  });
  it("标签避让：贴近的两标签只留先者，当前时刻标签抢占", () => {
    const near: EvMark[] = [{ t: 3000, label: "甲甲甲甲" }, { t: 3003, label: "乙乙乙乙" }];
    // span 200 × 800px → 3 年 = 12px ≥10px 不聚簇，但 4 字标签 ≈44px 宽必然互撞
    const a = buildMarks(near, 2980, 3180, 2990, 800, sameSlot);
    assert.deepEqual(a.map(m => (m as TickMark).label), ["甲甲甲甲", null]);
    // 后者是当年事件 → 挤掉先占位者
    const b = buildMarks(near, 2980, 3180, 3003, 800, sameSlot);
    assert.deepEqual(b.map(m => (m as TickMark).label), [null, "乙乙乙乙"]);
  });
});

describe("hourWindow：当前日 ±1、钳在范围内", () => {
  it("居中：初四 → 初三..初六前夜", () => {
    assert.deepEqual(hourWindow(4.5, 1, 9.9), { w0: 3, w1: 6 });
  });
  it("左缘：首日 → 从首日起三日", () => {
    assert.deepEqual(hourWindow(1, 1, 9.9), { w0: 1, w1: 4 });
  });
  it("右缘：末日 → 收尾三日", () => {
    assert.deepEqual(hourWindow(9.2, 1, 9.9), { w0: 7, w1: 10 });
  });
  it("范围不足三日：全范围", () => {
    assert.deepEqual(hourWindow(4, 4, 5.5), { w0: 4, w1: 6 });
    assert.deepEqual(hourWindow(4, 4, 4.2), { w0: 4, w1: 5 });
  });
});

describe("quantTime：步进网格+钳制", () => {
  it("年粒度四舍五入", () => {
    assert.equal(quantTime(3106.6, 1, 2980, 3180), 3107);
  });
  it("半时辰网格（1/24 日）", () => {
    assert.equal(quantTime(4.03, 1 / 24, 1, 9), Math.round(4.03 * 24) / 24);
  });
  it("出界钳制", () => {
    assert.equal(quantTime(9999, 1, 2980, 3180), 3180);
    assert.equal(quantTime(0, 1 / 24, 1, 9), 1);
  });
});

describe("subTicks：时轨刻度", () => {
  it("三日窗：每日 大刻+日名、午 中刻、22 半时辰小刻", () => {
    const ts = subTicks(3, 6, d => "日" + d);
    assert.equal(ts.filter(t => t.kind === "day").length, 3);
    assert.equal(ts.filter(t => t.kind === "noon").length, 3);
    assert.equal(ts.filter(t => t.kind === "half").length, 3 * 22);
    assert.deepEqual(ts.filter(t => t.kind === "day").map(t => t.label), ["日3", "日4", "日5"]);
    // 首日大刻在 0%、次日在 1/3 处；正午在日内 12/24
    const days = ts.filter(t => t.kind === "day");
    assert.equal(days[0].pct, 0);
    assert.ok(Math.abs(days[1].pct - 100 / 3) < 1e-9);
    const noon = ts.find(t => t.kind === "noon")!;
    assert.ok(Math.abs(noon.pct - (0.5 / 3) * 100) < 1e-9);
  });
});
