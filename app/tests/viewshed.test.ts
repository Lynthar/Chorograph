/* 视域（core/viewshed）语义测试 + Worker 协议。场用 1 单位＝1000 m、100 m 细格（step 0.001° × 100 km/度）手推：
   平地全可达、墙后遮挡、眼位/目标高度抬过墙、曲率地平线对解析式、湖面抬船、均匀上坡、驻地最高处眼位、R2 对逐格直算的一致率。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REFRACT_OPTICAL, REFRACT_RADAR, viewshed, type Observer, type ViewField, type VisMask } from "../src/core/viewshed.ts";
import { handleRouteMsg, type RouteCtx } from "../src/worker/routeProto.ts";
import { elevBilinear } from "../src/core/elev.ts";

const STEP = 0.001, KMD = 100, UNIT = 1000;   // 100 m/格
function mkField(cols: number, rows: number, h: (c: number, r: number) => number, over: Partial<ViewField> = {}): ViewField {
  const data = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) data[r * cols + c] = h(c, r);
  return {
    bb: { lonMin: 100, lonMax: 100 + cols * STEP, latMin: 30, latMax: 30 + rows * STEP }, step: STEP, cols, rows, data,
    wsurf: new Float32Array(cols * rows).fill(-9), gstep: STEP, gcols: cols, grows: rows,
    unitM: UNIT, kmx: KMD, kmy: KMD, curvKm: 0, ...over
  };
}
/** 观察者放在格 (c,r) 的格心 */
const obsAt = (c: number, r: number, km: number, o: Partial<Observer> = {}): Observer =>
  ({ lon: 100 + (c + 0.5) * STEP, lat: 30 + (r + 0.5) * STEP, eyeM: 2, tgtM: 2, km, refract: 0, ...o });
/** 读掩膜在场格 (c,r) 的值（窗外＝0） */
function visAt(f: ViewField, m: VisMask, c: number, r: number): number {
  const c0 = Math.round((m.bb.lonMin - f.bb.lonMin) / f.step), r0 = Math.round((m.bb.latMin - f.bb.latMin) / f.step);
  const cc = c - c0, rr = r - r0;
  return cc >= 0 && cc < m.cols && rr >= 0 && rr < m.rows ? m.vis[rr * m.cols + cc] : 0;
}

describe("视域（core/viewshed）", () => {
  it("平地无曲率：圈内格全部可达、圈外为 0，窗口恰好盖住半径", () => {
    const f = mkField(41, 41, () => 0);
    const m = viewshed(f, obsAt(20, 20, 1))!;
    assert.equal(m.nIn, m.nVis, "圈内全可达");
    assert.ok(m.nIn > 300 && m.nIn < 330, `半径 10 格的圆约 314 格，实得 ${m.nIn}`);
    assert.equal(m.cols, 21); assert.equal(m.rows, 21);
    assert.equal(visAt(f, m, 20, 20), 1, "观察点自身");
    assert.equal(visAt(f, m, 29, 20), 1, "东 900 m 处可达");
    assert.equal(visAt(f, m, 31, 20), 0, "东 1.1 km 处圈外");
    assert.equal(visAt(f, m, 27, 27), 1, "东北 990 m 处可达");
    assert.equal(visAt(f, m, 28, 28), 0, "东北 1.13 km 处圈外");
    const big = mkField(121, 121, () => 0), mb = viewshed(big, obsAt(60, 60, 5))!;
    assert.equal(mb.nIn, mb.nVis, "半径 50 格：格心在圈内而射线采样点在圈外的贴边格也要判到");
  });

  it("墙后遮挡：眼位或目标抬过墙才重见", () => {
    const wall = (c: number) => c === 25 ? 0.05 : 0;   // 500 m 外一道 50 m 高的墙
    const f = mkField(41, 41, wall);
    const m = viewshed(f, obsAt(20, 20, 1.5))!;
    assert.equal(visAt(f, m, 24, 20), 1, "墙前可达");
    assert.equal(visAt(f, m, 25, 20), 1, "墙顶本身看得见");
    assert.equal(visAt(f, m, 30, 20), 0, "墙后 1 km 遮挡");
    assert.equal(visAt(f, m, 10, 20), 1, "反方向不受影响");
    const hi = viewshed(f, obsAt(20, 20, 1.5, { eyeM: 120 }))!;
    assert.equal(visAt(f, hi, 30, 20), 1, "眼位 120 m 越过墙");
    const tall = viewshed(f, obsAt(20, 20, 1.5, { tgtM: 120 }))!;
    assert.equal(visAt(f, tall, 30, 20), 1, "目标 120 m 高也重见");
    const low = viewshed(f, obsAt(20, 20, 1.5, { eyeM: 60 }))!;
    assert.equal(visAt(f, low, 30, 20), 0, "眼位 60 m 仍被 500 m 外 50 m 的墙挡住 1 km 处的 2 m 目标（视线在墙处只有 31 m）");
  });

  it("曲率地平线：平地上可达距离对解析式 √(2R′h₁)+√(2R′h₂)，折射把地平线推远", () => {
    const f = mkField(401, 3, () => 0);
    const R = 6371;
    const horizonKm = (Rk: number) => 2 * Math.sqrt(2 * Rk * 1000 * 2) / 1000;   // 眼 2 m、目标 2 m
    for (const [k, name] of [[0, "无折射"], [REFRACT_OPTICAL, "光学折射"]] as const) {
      const m = viewshed({ ...f, curvKm: R }, obsAt(0, 1, 30, { refract: k }))!;
      const h = horizonKm(R / (1 - k));
      let last = 0;
      for (let c = 1; c < 400; c++) if (visAt(f, m, c, 1)) last = c;
      assert.ok(Math.abs((last + 0.5) * 0.1 - h) <= 0.15, `${name}：可达到 ${(last + 0.5) * 0.1} km，解析地平线 ${h.toFixed(2)} km`);
    }
    /* 雷达：4/3 地球（k=1/4），天线 10 m 对 20 m 目标：√(2R′·10)+√(2R′·20) */
    const Rr = R / (1 - REFRACT_RADAR);
    const radar = viewshed({ ...f, curvKm: R }, obsAt(0, 1, 40, { eyeM: 10, tgtM: 20, refract: REFRACT_RADAR }))!;
    const hr = (Math.sqrt(2 * Rr * 1000 * 10) + Math.sqrt(2 * Rr * 1000 * 20)) / 1000;
    let lastR = 0;
    for (let c = 1; c < 400; c++) if (visAt(f, radar, c, 1)) lastR = c;
    assert.ok(Math.abs((lastR + 0.5) * 0.1 - hr) <= 0.15, `雷达：可达到 ${(lastR + 0.5) * 0.1} km，解析地平线 ${hr.toFixed(2)} km`);
    assert.ok(hr > horizonKm(R / (1 - REFRACT_OPTICAL)) * 2, "雷达地平线远超同曲率的光学地平线（天线与目标都更高、折射更强）");
  });

  it("曲射弹道（固定射角）：平地全可达；45° 越过 500 m 外 50 m 墙、5° 越不过、300 m 墙挡 45° 而 60° 越过；目标高过发射切线不可达", () => {
    const flat = mkField(41, 41, () => 0);
    const mf = viewshed(flat, obsAt(20, 20, 1.5, { arcDeg: 45 }))!;
    assert.equal(mf.nVis, mf.nIn, "平地：q(d)=tanθ/d 单调递减＝格格可达");
    const wall = (h: number) => mkField(41, 3, c => c === 25 ? h : 0);
    const at = (f: ViewField, deg: number) => visAt(f, viewshed(f, obsAt(20, 1, 1.5, { arcDeg: deg }))!, 30, 1);
    assert.equal(at(wall(0.05), 45), 1, "45° 到 1 km 的弹道中点高 250 m，越过 50 m 墙");
    assert.equal(at(wall(0.05), 5), 0, "5° 低伸弹道被 50 m 墙挡");
    assert.equal(at(wall(0.3), 45), 0, "300 m 墙挡住 45°（弹道在 500 m 处约 187 m）");
    assert.equal(at(wall(0.3), 60), 1, "60° 越过 300 m 墙（同处约 433 m）");
    const m = viewshed(wall(0.05), obsAt(20, 1, 1.5, { arcDeg: 45 }))!;
    assert.equal(visAt(wall(0.05), m, 25, 1), 1, "墙顶本身打得到");
    const high = mkField(41, 3, c => c === 30 ? 1.1 : 0);   // 1 km 外 1100 m 高地：高过 45° 切线（1000 m）
    assert.equal(visAt(high, viewshed(high, obsAt(20, 1, 1.5, { arcDeg: 45 }))!, 30, 1), 0, "目标高过发射切线＝该射角打不到");
    assert.equal(visAt(high, viewshed(high, obsAt(20, 1, 1.5, { arcDeg: 60 }))!, 30, 1), 1, "抬到 60°（切线 1732 m）就打得到");
  });

  it("湖面抬船：水格按水面判，湖上 2 m 的目标从岸上看得见（湖底判则被岸沿挡住）", () => {
    const f = mkField(41, 3, c => c >= 26 ? -0.2 : 0.1, { wsurf: new Float32Array(41 * 3).fill(0.1) });
    const m = viewshed(f, obsAt(20, 1, 1.5))!;
    assert.equal(visAt(f, m, 30, 1), 1, "湖面上 1 km 处可达");
    const bed = viewshed({ ...f, wsurf: new Float32Array(41 * 3).fill(-9) }, obsAt(20, 1, 1.5))!;
    assert.equal(visAt(f, bed, 30, 1), 0, "对照：不抬水面则湖底目标被遮");
  });

  it("观察者在水上：眼位从水面起算，船看得见岸（眼位从湖底起算则整圈全盲）", () => {
    const f = mkField(41, 3, c => c >= 10 && c <= 30 ? -0.2 : 0.1, { wsurf: new Float32Array(41 * 3).fill(0.1) });
    const m = viewshed(f, obsAt(20, 1, 1.5, { eyeM: 15 }))!;
    assert.equal(visAt(f, m, 25, 1), 1, "湖面");
    assert.equal(visAt(f, m, 8, 1), 1, "西岸 1.2 km");
    assert.equal(visAt(f, m, 32, 1), 1, "东岸");
    assert.equal(m.nVis, m.nIn, "平湖平岸＝圈内全可达");
  });

  it("边界：观察点在场外或半径非正＝null；窗口贴场边裁切", () => {
    const f = mkField(21, 21, () => 0);
    assert.equal(viewshed(f, { ...obsAt(10, 10, 1), lon: 99 }), null);
    assert.equal(viewshed(f, obsAt(10, 10, 0)), null);
    const m = viewshed(f, obsAt(1, 1, 1))!;
    assert.equal(m.cols, 12, "西侧被场边裁掉");
    assert.equal(m.bb.lonMin, f.bb.lonMin);
  });

  it("确定性：同输入逐位同输出", () => {
    const f = mkField(61, 61, (c, r) => 0.02 * Math.sin(c / 3) * Math.cos(r / 4));
    const a = viewshed(f, obsAt(30, 30, 2.5))!, b = viewshed(f, obsAt(30, 30, 2.5))!;
    assert.deepEqual(a, b);
  });

  it("均匀上坡：沿线地面是双线性连续面，2 m 眼位看得见整面坡（读格心台阶则相邻格就把上坡挡死）", () => {
    const f = mkField(41, 3, c => 0.01 * c);   // 每格升 10 m＝10% 坡
    const m = viewshed(f, obsAt(10, 1, 2))!;
    for (let c = 11; c <= 29; c++) assert.equal(visAt(f, m, c, 1), 1, `上坡 ${c - 10} 格`);
    for (let c = 1; c <= 9; c++) assert.equal(visAt(f, m, c, 1), 1, `下坡 ${10 - c} 格`);
  });

  it("眼位取驻地最高处：脊后 100 m 的观察者本看不过脊，给 150 m 驻地半径即从脊顶看；圈仍以部队为心；平地与亚米级噪声眼位不动", () => {
    const f = mkField(41, 3, c => c === 21 ? 0.02 : 0);   // 观察者 c=20 东侧 100 m 一道 20 m 的脊
    const base = viewshed(f, obsAt(20, 1, 1.5))!;
    assert.equal(visAt(f, base, 30, 1), 0, "脊后 1 km 被挡");
    assert.equal(base.eyeOff, 0);
    const v = viewshed(f, obsAt(20, 1, 1.5, { vantageM: 150 }))!;
    assert.equal(visAt(f, v, 30, 1), 1, "眼位挪到脊顶＝看得见脊后");
    assert.equal(visAt(f, v, 20, 1), 1, "自己脚下仍可达");
    assert.ok(Math.abs(v.eyeOff - 100) < 1e-6, `眼位偏 ${v.eyeOff} m（同高取最近：脊上同排那格，不是斜角那格）`);
    assert.equal(v.nIn, base.nIn, "圈仍以部队位置为心");
    assert.equal(viewshed(f, obsAt(20, 1, 1.5, { vantageM: 50 }))!.eyeOff, 0, "驻地半径不及脊＝原地");
    assert.equal(viewshed(f, obsAt(20, 1, 1.5, { vantageM: 150, gainM: 25 }))!.eyeOff, 0, "抬升 20 m 不够 25 m 门槛＝原地");
    const noise = mkField(41, 3, c => c === 25 ? 0.0002 : 0);   // 1 km 外一处 0.4 m 的细节噪声
    assert.equal(viewshed(noise, obsAt(20, 1, 1.5, { vantageM: 1000, gainM: 1 }))!.eyeOff, 0, "亚米级噪声不值得挪眼位");
    assert.ok(viewshed(noise, obsAt(20, 1, 1.5, { vantageM: 1000 }))!.eyeOff > 0, "对照：无门槛就会为 0.4 m 挪 1 km");
    const flat = mkField(41, 41, () => 0), mf = viewshed(flat, obsAt(20, 20, 1, { vantageM: 9000 }))!;
    assert.equal(mf.eyeOff, 0, "平地无更高处＝眼位不动（半径钳到射程内不越窗）");
    assert.equal(mf.nVis, mf.nIn);
  });

  it("R2 对逐格直算（每格独立沿线密采样）的一致率 ≥ 95%", () => {
    const f = mkField(81, 81, (c, r) => 0.03 * (Math.sin(c / 4.3) * Math.cos(r / 3.7) + 0.5 * Math.sin((c + r) / 2.9)));
    const o = obsAt(40, 40, 3);
    const m = viewshed(f, o)!;
    const ox = 40.5, oy = 40.5, z0 = f.data[40 * 81 + 40] * UNIT + o.eyeM;
    let agree = 0, n = 0;
    for (let r = 0; r < 81; r++) for (let c = 0; c < 81; c++) {
      const dx = c + 0.5 - ox, dy = r + 0.5 - oy, d = Math.hypot(dx, dy) * 100;
      if (d > 3000 || d === 0) continue;
      const N = Math.ceil(Math.hypot(dx, dy) * 6);   // 每格 6 个采样点
      let maxTan = -Infinity, seen = 1;
      for (let i = 1; i <= N; i++) {
        const t = i / N, px = ox + dx * t, py = oy + dy * t, di = d * t;
        const zg = elevBilinear(f.data, f, f.bb.lonMin + px * STEP, f.bb.latMin + py * STEP) * UNIT;   // 与算法同一张双线性面
        if (i === N) seen = (zg + o.tgtM - z0) / di >= maxTan ? 1 : 0;
        else maxTan = Math.max(maxTan, (zg - z0) / di);
      }
      n++;
      if (seen === visAt(f, m, c, r)) agree++;
    }
    assert.ok(agree / n >= 0.95, `一致率 ${(100 * agree / n).toFixed(1)}%（${agree}/${n}）`);
  });
});

describe("视域 Worker 协议", () => {
  it("未推规则场＝res null；推后与直调逐位同，观察者按 id/ring 回", () => {
    const st: RouteCtx = {};
    assert.deepStrictEqual(handleRouteMsg(st, { t: "viewshed", id: 1, obs: [] }), { t: "viewshed", id: 1, res: null });
    const f = mkField(41, 41, c => c === 25 ? 0.05 : 0);
    assert.strictEqual(handleRouteMsg(st, { t: "vfield", field: f }), null);
    const o = obsAt(20, 20, 1.5);
    const r = handleRouteMsg(st, { t: "viewshed", id: 2, obs: [{ ...o, id: "u", ring: "vision" }, { ...o, km: 0, id: "u", ring: "fire" }] });
    assert.deepStrictEqual(r, { t: "viewshed", id: 2, res: [{ id: "u", ring: "vision", mask: viewshed(f, o) }, { id: "u", ring: "fire", mask: null }] });
  });
});
