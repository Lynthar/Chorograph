/* 时间坞纯逻辑：主轨事件标记布局（设计决议：事件间距 <10px 聚簇＝V2 逻辑并入主轨；
   标签贪心避让、当前时刻标签优先）、战术「时」细轨窗口（当前日 ±1）、时间量子化。
   纯函数无 DOM/信号——node:test 可测；组件 TimeDock.tsx 只做渲染与指针交互（截图目检）。 */

export interface EvMark { t: number; label: string }

export interface TickMark { kind: "tick"; pct: number; t: number; fut: boolean; cur: boolean; label: string | null }
export interface ClusterMark { kind: "cluster"; pct: number; n: number; fut: boolean; cur: boolean }
export type TrackMark = TickMark | ClusterMark;

const GAP_PX = 10;    // 决议阈值：相邻事件刻度像素间距 < 10px 即聚簇
const CJK_PX = 10;    // 标签每字宽估算（9.5px 字号 + .05em 字距；避让用，无需精确）

/** 主轨标记布局：范围内事件 → 刻度/「×N」聚簇 + 标签避让。
    curOf=「当前时刻命中」判定（战略=同年、战术=同日）；widthPx≤0（未测得）时不聚簇不避让。 */
export function buildMarks(evs: EvMark[], min: number, max: number, now: number,
  widthPx: number, curOf: (t: number, now: number) => boolean): TrackMark[] {
  const span = max - min;
  if (!(span > 0)) return [];
  const sorted = evs.filter(e => isFinite(e.t) && e.t >= min && e.t <= max).sort((a, b) => a.t - b.t);
  const groups: EvMark[][] = [];
  for (const e of sorted) {
    const g = groups[groups.length - 1];
    if (widthPx > 0 && g && ((e.t - g[g.length - 1].t) / span) * widthPx < GAP_PX) g.push(e);
    else groups.push([e]);
  }
  const marks: TrackMark[] = groups.map(g => {
    const cur = g.some(e => curOf(e.t, now));
    const fut = !cur && g.every(e => e.t > now);
    if (g.length > 1) {
      const mid = (g[0].t + g[g.length - 1].t) / 2;
      return { kind: "cluster", pct: ((mid - min) / span) * 100, n: g.length, fut, cur };
    }
    return { kind: "tick", pct: ((g[0].t - min) / span) * 100, t: g[0].t, fut, cur, label: g[0].label };
  });
  /* 标签避让：左→右贪心占位；撞位时当前时刻标签优先（挤掉先占位的普通标签），其余隐藏（刻度保留） */
  if (widthPx > 0) {
    let lastEnd = -Infinity, lastIdx = -1;
    marks.forEach((m, i) => {
      if (m.kind !== "tick" || !m.label) return;
      const w = m.label.length * CJK_PX + 4;
      const x0 = (m.pct / 100) * widthPx - w / 2;
      if (x0 >= lastEnd) { lastEnd = x0 + w; lastIdx = i; return; }
      const prev = lastIdx >= 0 ? marks[lastIdx] : null;
      if (m.cur && prev && prev.kind === "tick" && !prev.cur) { prev.label = null; lastEnd = x0 + w; lastIdx = i; }
      else m.label = null;
    });
  }
  return marks;
}

/** 战术「时」细轨窗口：当前日 ±1（V1 双层坞），钳在时间范围内；跨度 ≤3 日（范围更短则全范围）。
    返回 [w0,w1]，w1=末窗日次日零点（含作可拖上界）。 */
export function hourWindow(now: number, min: number, max: number): { w0: number; w1: number } {
  const lo = Math.floor(min), hi = Math.floor(max) + 1;
  const span = Math.max(1, Math.min(3, hi - lo));
  let w0 = Math.floor(now) - 1;
  if (w0 > hi - span) w0 = hi - span;
  if (w0 < lo) w0 = lo;
  return { w0, w1: w0 + span };
}

/** 时间量子化+钳制：拖拽/步进共用（战略=1 年、战术=1 日、「时」=1/24 日）。
    乘整数网格再除（而非乘 step 倒数）——与历法显示层 quantT 同族，免浮点漂移。 */
export function quantTime(v: number, step: number, min: number, max: number): number {
  const inv = Math.round(1 / step);
  return Math.min(max, Math.max(min, Math.round(v * inv) / inv));
}

export interface SubTick { pct: number; kind: "day" | "noon" | "half"; label?: string }
/** 时轨刻度：整日大刻+日名标签、正午中刻+「午」、每 1/24 日（半时辰）小刻 */
export function subTicks(w0: number, w1: number, dayLabel: (d: number) => string): SubTick[] {
  const span = w1 - w0, out: SubTick[] = [];
  for (let d = w0; d < w1; d++) {
    out.push({ pct: ((d - w0) / span) * 100, kind: "day", label: dayLabel(d) });
    for (let k = 1; k < 24; k++) {
      const pct = ((d + k / 24 - w0) / span) * 100;
      if (k === 12) out.push({ pct, kind: "noon", label: "午" });
      else out.push({ pct, kind: "half" });
    }
  }
  return out;
}
