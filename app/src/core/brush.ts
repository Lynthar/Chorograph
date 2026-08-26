/* 笔刷尺度（2026-08-12 用户点单）：滑杆自此不是「格数」而是**物理尺度 32 档**——
   战术 100m→20km（低端分段加密）、战略 20km→500km 线性。按图种给档表，同 HEIGHT_STEPS_* 之规。
   ⚠ 笔刷只能整格地涂（涂宽恒 2R+1 格），故档位是**名义**尺度，实际涂到多宽由网格密度定：
   名义不足一格即退化成单格。读数一律报 brushActualKm 的**实际**涂宽 + 格数——滑杆推不动时
   看得见是为什么（战略图地形格恒 1°≈111km，前十余档必然同落一格，是数据粒度使然不是缺陷；
   战术图 112m/格 时 32 档给得出 ~31 个不同尺寸）。名义值除了定档位之外不喂任何消费点。 */
import { kmPerDeg } from "./geo.ts";
import { gridStepDeg } from "./grid.ts";
import { paintStep } from "./territory.ts";
import type { Meta } from "./types.ts";

export const BRUSH_NOTCHES = 32;
export const BRUSH_KM_TAC: readonly [number, number] = [0.1, 20];      // 战术：100m → 20km（低端另有分段表）
export const BRUSH_KM_STRAT: readonly [number, number] = [20, 500];    // 战略：20km → 500km

/* 战术低端分段（2026-08-26 用户点单）：纯线性时第 2 档即 742m，100m 格上 3/5 格（300/500m）
   雕刻笔永远够不着——前七档改定值序列，其余向 20km 线性递增。战略不分段：6.67km 格边下
   线性低端本就逐档互异（相邻档差 15.48km ≈ ΔR 1）。 */
const TAC_LOW: readonly number[] = [0.1, 0.3, 0.5, 0.7, 1, 1.5, 2];

/** 第 notch 档的名义直径（公里）；notch 钳 [1,32]，非数当 1 */
export function brushNominalKm(meta: Meta | undefined, notch: number): number {
  const n = Math.min(BRUSH_NOTCHES, Math.max(1, Math.round(notch) || 1));
  if ((meta || {}).mapKind === "tactical") {
    const last = TAC_LOW[TAC_LOW.length - 1];
    return n <= TAC_LOW.length ? TAC_LOW[n - 1]
      : last + (BRUSH_KM_TAC[1] - last) * (n - TAC_LOW.length) / (BRUSH_NOTCHES - TAC_LOW.length);
  }
  const [lo, hi] = BRUSH_KM_STRAT;
  return lo + (hi - lo) * (n - 1) / (BRUSH_NOTCHES - 1);
}

/** 笔刷所在网格的格边度数：涂域笔走 paintStep（涂域自有更细网格），地形笔走地形网格步长 */
export function brushStepDeg(meta: Meta | undefined, sub: string): number {
  return sub === "paint" ? paintStep(meta) : gridStepDeg(meta);
}

/* 圆盘半径上限：涂改逐 dab 是 O((2R+1)²)，而 `meta.kmPerDeg` 是存档里的自由数值——一个
   「1 米/度」的玩具尺度世界会把 20km 档算成千万格半径，一笔就把主线程钉死（同「键名也是
   用户数据」之规，值同样是用户数据）。256 从不咬承诺域内的图：战术最大档 20km÷100m 格
   ＝R 100、战略 500km÷6.67km 格＝R 37；只有手编超密 gridN 档会被钳到 256（读数如实报实际
   涂宽）。⚠ 判据写成 `R > 0 ? … : 0` 而非 max/min——NaN 过 Math.max 会原样漏出去。 */
const MAX_R = 256;

/** 名义直径 → 圆盘半径格数 R（涂宽 2R+1 格，与 paintTerrainAt/brushCells 的 size=R+1 对齐；0＝单格） */
export function brushRadiusCells(meta: Meta | undefined, sub: string, notch: number): number {
  const cellKm = brushStepDeg(meta, sub) * kmPerDeg(meta);
  const R = Math.round((brushNominalKm(meta, notch) / cellKm - 1) / 2);
  return R > 0 ? Math.min(MAX_R, R) : 0;
}

/** 实际涂宽（公里）＝(2R+1) 格——读数报这个，名义值在不足一格时是假的 */
export function brushActualKm(meta: Meta | undefined, sub: string, R: number): number {
  return (2 * R + 1) * brushStepDeg(meta, sub) * kmPerDeg(meta);
}

/** 笔刷读数格式：相邻档相差数百米，core/util 的 fmtKm 在 ≥1km 处取整会把连着几档印成同一个数 */
export function fmtBrushKm(km: number): string {
  if (km < 1) return Math.round(km * 1000) + " m";
  if (km < 10) return (Math.round(km * 10) / 10).toFixed(1) + " km";
  return Math.round(km) + " km";
}

/* —— 笔画连续（2026-08-19）——
   一次 pointermove 只报一个点，两点之间不落笔就断线（用户实报「幅度大或速度快时断成一个个点」）。
   落笔序列的几何收在这两个纯函数里：间距怎么定 + 路径怎么补齐；取事件、换算像素在 shell/pointer。 */

/** 不留缝的最大落点间距（度）：0.75×笔刷半径——相邻圆盘在中点仍有 √(1−0.75²/4)≈97% 的半宽，
    肉眼无缝；但绝不粗于 0.9 格，否则一格笔刷（R=0）按半径取步长就是 0、成串的孤立点照旧。 */
export function brushDabStepDeg(cellDeg: number, R: number): number {
  return Math.max(0.9, 0.75 * R) * cellDeg;
}

/** 把「上一落点 + 本次这串原始位置」补成间距 ≤ step 的落笔序列（原始点之间按直线插值）。
    末点恒是原始序列的末点；整段零位移时返回它一个点（落笔那一下、原地微抖也要落一笔）。
    max 是护主线程的兜底上限，撞上了就丢尾巴——真实手速够不到，见调用点头注。 */
export function interpolatePath(raw: readonly (readonly [number, number])[],
  lastX: number, lastY: number, step: number, max: number): [number, number][] {
  const out: [number, number][] = [];
  let px = lastX, py = lastY;
  for (const [x, y] of raw) {
    const n = Math.ceil(Math.hypot(x - px, y - py) / step);   // 与上一点重合 ⇒ n=0 ⇒ 不落（合并事件末项常与派发点同点）
    for (let i = 1; i <= n && out.length < max; i++) out.push([px + (x - px) * i / n, py + (y - py) * i / n]);
    px = x; py = y;
  }
  if (!out.length && raw.length) out.push([raw[raw.length - 1][0], raw[raw.length - 1][1]]);
  return out;
}
