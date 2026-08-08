/* 侵蚀真形（渲染层数据源，2026-08 批二）：把「ELEV[类型] + 起伏噪声」的示意高程场重铸成有
   真实谷网与连通山脊的场——上采样细分格 → 水力侵蚀（stream-power，Braun-Willett 2013 单遍
   隐式解）→ 坡面扩散 → 定向天光遮蔽烘焙。纯函数、确定性（同输入逐位同输出），Worker 与
   主线程回退共用；黄金基准零接触（分类/寻路不读本场）。
   ⚠ 调用门在外（host）：meta.relief=0 一律走旧 buildElevField 粗格路径＝逐位不变契约，
     本模块不处理该分支；heightOverrides 在侵蚀**之后**叠加＝用户涂改仍是权威。
   ⚠ 等高线与光标读数与晕渲同走本场（「画尺一致」，2026-08-07 用户拍板）：等高线自此沿真实
     谷线走，旧档（relief>0）读数会移动；战略图与其战术烘焙在同一位置的起伏也从逐位一致降为
     近似一致（侵蚀依赖网格分辨率，噪声输入仍同锚）。 */
import { reliefNoise, elevBilinear, LAND_FLOOR, WATER_CEIL, type ElevField } from "./elev.ts";
import { terrainProps } from "./constants.ts";
import { flatKmPerDeg } from "./geo.ts";
import { activeAt } from "./time.ts";
import type { Grid } from "./grid.ts";
import type { BBox, HeightOverride, Meta } from "./types.ts";

export interface ErodeInput {
  bb: BBox; step: number; cols: number; rows: number;
  /** 粗格基础高程（ELEV[类型]，terrainProps.elev） */
  elev0: Float32Array;
  /** 粗格起伏幅（terrainProps.relief） */
  relief0: Float32Array;
  /** 粗格水域掩码（1=水；水面高程恒定＝侵蚀基准面） */
  water: Uint8Array;
  /** meta.relief（0..1；=0 时调用方不该走到这里） */
  amp: number;
  seed: number;
  /** 经/纬向 km/度（经向已含中央纬度 cos 折算；细格距离度量用） */
  kmx: number; kmy: number;
  /** 已按当年过滤的高程涂改（bs=盖章边长，度；单格章=粗格 step） */
  hov: { lon: number; lat: number; dh: number; bs: number }[];
}

/* —— 调参旋钮（观感层；改幅度看 CDP 截图，别背公式）—— */
const MAX_FINE = 400_000;   // 细分格总数上限（内存与耗时预算；540×740 战术图约 0.4s/次）
const ITERS = 5;            // 侵蚀迭代数（隐式解收敛快，5 轮已出谷网）
const KDT = 0.022;          // 河蚀强度 ×dt（f=KDT·√A/dist；A 单位 km²、dist 单位 km）
const DIFF = 0.17;          // 坡面扩散系数/迭代（4 邻均值回拉；模拟风化把 V 谷肩磨圆）
const POST_DIFF = 2;        // 收尾追加扩散轮数：磨掉陡壁上的平行冲沟毛刺与迭代台痕
const EPS = 1e-5;           // 洼地填平的单调排水梯度（抽象高程/格）
/* 遮蔽烘焙：与着色器同一套「屏幕坡度」量纲——tanScreen=Δe/Δ度×0.3214（nrm 推导），
   日高 tan=|Lz|/|Lxy|=0.9/0.8485。采样步距渐增＝近处硬阴影、远处软阴影 */
const SLOPE_SCR = 0.3214, TAN_SUN = 1.0607, OCC_GAIN = 1.15;
const SHADOW_STEPS = [1, 2, 3, 5, 8, 12, 17, 24];

/** 细分倍率：总格数不超预算、单轴最多 8×（48×32 战略→8×；140×94 战术→5×） */
export function upscaleOf(cols: number, rows: number): number {
  let sx = 1;
  while (sx < 8 && cols * (sx + 1) * rows * (sx + 1) <= MAX_FINE) sx++;
  return sx;
}

/** 组装侵蚀输入（主线程侧）。meta.relief=0 返 null＝调用方保持旧粗格路径——逐位不变契约
    覆盖「关起伏」与「只有高程涂改」两类图（后者的锐利盖章边不该被扩散磨圆）。 */
export function erodeInput(meta: Meta | undefined, hov: HeightOverride[] | undefined,
  grid: Grid, yearNow: number): ErodeInput | null {
  const m = meta || {};
  const amp = Math.max(0, Math.min(1, +(m.relief as number) || 0));
  if (amp <= 0) return null;
  const { bb, step, cols, rows, cells } = grid;
  const elev0 = new Float32Array(rows * cols), relief0 = new Float32Array(rows * cols), water = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const p = terrainProps(cells[r][c]), k = r * cols + c;
    elev0[k] = p.elev; relief0[k] = p.relief; water[k] = p.water ? 1 : 0;
  }
  const kmy = m.worldModel === "flat" ? flatKmPerDeg(m) : 2 * Math.PI * (+(m.planetRadiusKm ?? 0) || 10000) / 360;
  const kmx = m.worldModel === "flat" ? kmy : kmy * Math.cos((bb.latMin + bb.latMax) / 2 * Math.PI / 180);
  const ho = (hov || []).filter(o => activeAt(o, yearNow) && (+o.dh || 0)).map(o => {
    const bs = +(o.step as number) || step;
    if (bs > step * 1.001) return { lon: o.lon, lat: o.lat, dh: +o.dh || 0, bs };
    /* 单格章＝盖「点所在的那个粗格」（buildElevField 同几何：格对齐而非以点为心）——发中心坐标使
       盖章盒边落在格界上，细分 floor 数学恰覆盖 sx×sx 细格 */
    const c = Math.floor((o.lon - bb.lonMin) / step), r = Math.floor((o.lat - bb.latMin) / step);
    return { lon: bb.lonMin + (c + 0.5) * step, lat: bb.latMin + (r + 0.5) * step, dh: +o.dh || 0, bs: step };
  });
  return { bb, step, cols, rows, elev0, relief0, water, amp, seed: ((m.genSeed as number) | 0) || 1, kmx, kmy, hov: ho };
}

/** 侵蚀重铸：细分基础场（起伏噪声按细格中心重采样——reliefNoise 锚经纬度，上采样即免费细节）
    → 填洼 → N 轮（受水者/汇流面积/隐式下切/扩散）→ 涂改叠加 → 类型钳制 → 遮蔽烘焙。 */
export function erodeField(inp: ErodeInput): ElevField {
  const { bb, step, cols, rows, elev0, relief0, water, amp, seed, kmx, kmy } = inp;
  const sx = upscaleOf(cols, rows);
  const FC = cols * sx, FR = rows * sx, n = FC * FR, fstep = step / sx;
  const h = new Float32Array(n);
  const base = new Float32Array(n);   // 结构基面（无噪声）：钳制参照，同旧「类型基础值」之职
  const wat = new Uint8Array(n);

  /* 细分基础场：**类型高程走粗格双线性**（复现旧管线「粗格值+着色器双线性」的连续基面——
     取最近父格会让粗格 ELEV 台阶以细格锐度全图浮出格状压纹，实测踩过）+ 起伏噪声按细格
     中心重采样（reliefNoise 锚经纬度，上采样即免费细节；幅度亦双线性=岸边平滑归零）。
     sx=1 时双线性恰落格心＝逐点还原粗格值。水域不加噪＝侵蚀基准面。 */
  const geo = { bb, step, cols, rows };
  for (let r = 0; r < FR; r++) {
    const pr = Math.min(rows - 1, (r / sx) | 0), lat = bb.latMin + (r + 0.5) * fstep;
    for (let c = 0; c < FC; c++) {
      const pc = Math.min(cols - 1, (c / sx) | 0), i = r * FC + c;
      const lon = bb.lonMin + (c + 0.5) * fstep;
      const b = elevBilinear(elev0, geo, lon, lat);
      const ra = elevBilinear(relief0, geo, lon, lat);
      wat[i] = water[pr * cols + pc];
      let e = b;
      if (!wat[i] && amp > 0 && ra > 0) e += ra * amp * 2 * reliefNoise(lon, lat, seed);
      base[i] = b; h[i] = e;
    }
  }

  /* 8 邻表与距离（km；经向已折 cos） */
  const NB = [-FC - 1, -FC, -FC + 1, -1, 1, FC - 1, FC, FC + 1];
  const dxs = [1, 0, 1, 1, 1, 1, 0, 1], dys = [1, 1, 1, 0, 0, 1, 1, 1];
  const DK: number[] = NB.map((_, i) => Math.hypot(dxs[i] * fstep * kmx, dys[i] * fstep * kmy));
  const inGrid = (c: number, i: number): boolean => {
    const x = c % FC, nb = c + NB[i];
    if (nb < 0 || nb >= n) return false;
    const dx = (nb % FC) - x;
    return dx >= -1 && dx <= 1;   // 行不回绕
  };

  /* 二叉堆（h 升序、平手按索引＝确定性） */
  const heap = new Int32Array(n + 1); let hn = 0;
  const less = (a: number, b: number): boolean => h[a] < h[b] || (h[a] === h[b] && a < b);
  const push = (v: number): void => { let i = ++hn; heap[i] = v; while (i > 1 && less(heap[i], heap[i >> 1])) { const t = heap[i]; heap[i] = heap[i >> 1]; heap[i >> 1] = t; i >>= 1; } };
  const pop = (): number => {
    const top = heap[1]; heap[1] = heap[hn--];
    let i = 1;
    for (;;) { let m = i; const l = i * 2, r = l + 1; if (l <= hn && less(heap[l], heap[m])) m = l; if (r <= hn && less(heap[r], heap[m])) m = r; if (m === i) break; const t = heap[i]; heap[i] = heap[m]; heap[m] = t; i = m; }
    return top;
  };

  /* 洼地填平（priority flood + ε 排水坡）：边界=水域与图幅边缘。侵蚀会再挖新洼，每轮重填 */
  const closed = new Uint8Array(n);
  const flood = (): void => {
    closed.fill(0); hn = 0;
    for (let i = 0; i < n; i++) {
      const x = i % FC, y = (i / FC) | 0;
      if (wat[i] || x === 0 || y === 0 || x === FC - 1 || y === FR - 1) { closed[i] = 1; push(i); }
    }
    while (hn > 0) {
      const c = pop();
      for (let i = 0; i < 8; i++) {
        if (!inGrid(c, i)) continue;
        const nb = c + NB[i];
        if (closed[nb]) continue;
        closed[nb] = 1;
        if (!wat[nb] && h[nb] <= h[c]) h[nb] = h[c] + EPS;
        push(nb);
      }
    }
  };

  const rcv = new Int32Array(n), rdist = new Float32Array(n);
  const A = new Float32Array(n);
  const stack = new Int32Array(n), ndon = new Int32Array(n), don = new Int32Array(n), donPos = new Int32Array(n);
  const cellKm2 = (fstep * kmx) * (fstep * kmy);
  const h2 = new Float32Array(n);

  for (let it = 0; it < ITERS; it++) {
    flood();
    /* 受水者：最陡下坡邻格；水域与无下坡＝自身（基准面/汇口） */
    for (let c = 0; c < n; c++) {
      rcv[c] = c; rdist[c] = 1;
      if (wat[c]) continue;
      let bs = 0, bi = -1;
      for (let i = 0; i < 8; i++) {
        if (!inGrid(c, i)) continue;
        const nb = c + NB[i];
        if (h[nb] < h[c]) { const s = (h[c] - h[nb]) / DK[i]; if (s > bs) { bs = s; bi = i; } }   // 平手取先遇邻＝邻序确定性
      }
      if (bi >= 0) { rcv[c] = c + NB[bi]; rdist[c] = DK[bi]; }
    }
    /* Braun-Willett 栈序：汇口起、供水者深搜 */
    ndon.fill(0);
    for (let c = 0; c < n; c++) if (rcv[c] !== c) ndon[rcv[c]]++;
    donPos[0] = 0;
    for (let c = 1; c < n; c++) donPos[c] = donPos[c - 1] + ndon[c - 1];
    const fill = donPos.slice();
    for (let c = 0; c < n; c++) if (rcv[c] !== c) don[fill[rcv[c]]++] = c;
    let sp = 0;
    for (let c = 0; c < n; c++) if (rcv[c] === c) {
      let top = sp; stack[sp++] = c;
      while (top < sp) { const v = stack[top++]; const p0 = donPos[v], p1 = p0 + ndon[v]; for (let p = p0; p < p1; p++) stack[sp++] = don[p]; }
    }
    /* 汇流面积（栈逆序向下游累加）与隐式下切（栈正序：受水者先解） */
    A.fill(cellKm2);
    for (let s = n - 1; s >= 0; s--) { const c = stack[s]; if (rcv[c] !== c) A[rcv[c]] += A[c]; }
    for (let s = 0; s < n; s++) {
      const c = stack[s], r = rcv[c];
      if (r === c || wat[c]) continue;
      const f = KDT * Math.sqrt(A[c]) / rdist[c];
      h[c] = (h[c] + f * h[r]) / (1 + f);
    }
    diffuse();
  }
  for (let k = 0; k < POST_DIFF; k++) diffuse();   // 收尾磨圆（在涂改叠加之前——盖章锐边不受它染指）

  /* 坡面扩散（4 邻均值回拉；水域与边缘不动） */
  function diffuse(): void {
    h2.set(h);
    for (let r = 1; r < FR - 1; r++) for (let c = 1; c < FC - 1; c++) {
      const i = r * FC + c;
      if (wat[i]) continue;
      h2[i] = h[i] + DIFF * ((h[i - 1] + h[i + 1] + h[i - FC] + h[i + FC]) * 0.25 - h[i]);
    }
    h.set(h2);
  }

  /* 涂改叠加（权威，不参与侵蚀；几何同 buildElevField 的盖章，只是格距换细格） */
  for (const o of inp.hov) {
    const bs = o.bs;
    const c0 = Math.max(0, Math.floor((o.lon - bs / 2 - bb.lonMin) / fstep)), c1 = Math.min(FC - 1, Math.floor((o.lon + bs / 2 - bb.lonMin - 1e-9) / fstep));
    const r0 = Math.max(0, Math.floor((o.lat - bs / 2 - bb.latMin) / fstep)), r1 = Math.min(FR - 1, Math.floor((o.lat + bs / 2 - bb.latMin - 1e-9) / fstep));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) h[r * FC + c] += o.dh;
  }
  /* 类型钳制（同 buildElevField 的地板/天花语义，参照系换成连续基面——细分后「类型基础值」
     在格间是插值坡，按最近父格钳会把海岸缓坡重新削成台阶） */
  for (let i = 0; i < n; i++) {
    h[i] = wat[i] ? Math.min(Math.max(WATER_CEIL, base[i]), h[i]) : Math.max(Math.min(LAND_FLOOR, base[i]), h[i]);
  }

  /* 定向天光遮蔽（朝光源西南向行进采样；量纲与着色器屏幕坡度一致）——帧时零成本的投影阴影 */
  const shadow = new Float32Array(n);
  const dirC = -0.7071, dirR = -0.7071;
  for (let r = 0; r < FR; r++) for (let c = 0; c < FC; c++) {
    const i = r * FC + c;
    if (wat[i]) continue;
    let occ = 0;
    for (const s of SHADOW_STEPS) {
      const sc = Math.max(0, Math.min(FC - 1, Math.round(c + dirC * s)));
      const sr = Math.max(0, Math.min(FR - 1, Math.round(r + dirR * s)));
      const t = (h[sr * FC + sc] - h[i]) / (s * fstep * 1.4142) * SLOPE_SCR - TAN_SUN;
      if (t > occ) occ = t;
    }
    shadow[i] = Math.min(1, occ * OCC_GAIN);
  }

  return { data: h, shadow, cols: FC, rows: FR, step: fstep, bb };
}
