/* 历法与日戳（双轨）：
   · custom=自定义均匀历法（v0.14 现状）：meta.calendar={months,dpm}（默认 12月×30日=年360日），
     纪元前缀可配（era，默认 "SE"）——正年份输出与旧实现逐位一致（黄金基准锁定）；
   · earth=真实地球历法：meta.calendar={kind:"earth"}。日戳=儒略日数 JDN；日期↔JDN 用 Calendar FAQ
     （Tondering）/Fliegel–Van Flandern 的整数算法（中间量在有效域恒正，floor=trunc 无符号陷阱）；
     儒略历 ≤1582-10-04（JDN 2299160）/ 格里高利历 ≥1582-10-15（JDN 2299161），锚点已数值验证
     （G2000-01-01=2451545；闰年 1900✗/2000✓/0年双历✓）。1582-10-05~14 的儒略输入落到同一物理日
     （=格里 10-15~24），显示取格里正名。
   内部纪年一律天文纪年（0=前1年，-215=前216年）；UI 显示/解析一律「前N」，不露裸负数。
   日戳 T 为线性数字：整数=日，小数=日内时刻（0=零时）。日内时刻一律「时:分」——每日时数与
   每时分数由历法给出，缺省 24×60，earth 恒 24×60。
   activeAt/unitPos 等时间过滤只比较数字——历法只是 T 的编解码层，换历法不动时间语义。 */
import type { CalendarCfg } from "./types.ts";

/** 一日分法的上限（值也是用户数据）：时×分＝显示量子，封顶让 quantT 的整数网格远在 2^53 内 */
export const MAX_HPD = 1000, MAX_MPH = 1000;

export interface CalendarSpec {
  kind: "custom" | "earth"; months: number; dpm: number; dpy: number; era: string;
  /* —— 一日的分法：**恒有值**（缺省 24×60、earth 恒 24×60），故消费端不必各自兜底
     （同「参数可选＋内部兜底常数」一律改必填之训）。 —— */
  hpd: number;        // 每日时数
  mph: number;        // 每时分数
  /* —— 架空历法扩充的归一态：**缺省一律不落这些键**，于是 tacT/fromT/各 fmt 都走与 v0.14
     逐字相同的旧分支＝黄金基准逐位（新特性只在真配了的历法上生效）。 —— */
  lens?: number[];    // 不等长月的每月日数（全等长时不落＝退回 months×dpm 旧式）
  off?: number[];     // lens 的前缀和（off[i]=前 i 个月共几日，长度 months+1）
  names?: string[];   // 月名
}

const posInt = (v: unknown, cap: number): number => {
  const n = Math.floor(+(v as number));
  return isFinite(n) && n >= 1 ? Math.min(cap, n) : 0;
};
const strOf = (v: unknown): string => (typeof v === "string" && v.trim()) ? v.trim() : "";

/** 历法归一（容错：缺省/非法回落 custom 12×30、纪元 SE）。earth 分支不得读 months/dpm/dpy。
    ⚠ 扩充字段一律「不合法即当没给」：历法是存档与模板里的自由数据，同「键名也是用户数据」之规。 */
export function calOf(c?: CalendarCfg | null): CalendarSpec {
  const cc = c || {};
  const months = Math.max(1, ((cc.months as number) | 0) || 12);
  const dpm = Math.max(1, ((cc.dpm as number) | 0) || 30);
  const era = strOf(cc.era) || "SE";
  const spec: CalendarSpec = { kind: cc.kind === "earth" ? "earth" : "custom", months, dpm, dpy: months * dpm, era, hpd: 24, mph: 60 };
  if (spec.kind === "earth") return spec;   // earth 只认 kind；以下全是 custom 的扩充

  /* 不等长月：全等长时**收敛回等长路径**——同一份历法只该有一条数学，也免得 lens 分支去背旧式的
     越界进位语义（golden 里 m=0 / m=13 那两例正是它）。 */
  const ml = (Array.isArray(cc.monthLens) ? cc.monthLens : []).map(v => posInt(v, 9999)).filter(v => v > 0);
  if (ml.length) {
    spec.months = ml.length;
    if (ml.every(v => v === ml[0])) { spec.dpm = ml[0]; spec.dpy = ml.length * ml[0]; }
    else {
      const off = [0];
      for (const L of ml) off.push(off[off.length - 1] + L);
      spec.lens = ml; spec.off = off; spec.dpy = off[off.length - 1];
      spec.dpm = Math.round(spec.dpy / ml.length);   // 仅作「平均月长」兜底（不等长时无人该拿它算日戳）
    }
  }
  const nm = (Array.isArray(cc.monthNames) ? cc.monthNames : []).map(strOf);
  if (nm.some(v => v)) spec.names = nm;
  spec.hpd = posInt(cc.hoursPerDay, MAX_HPD) || 24;
  spec.mph = posInt(cc.minutesPerHour, MAX_MPH) || 60;
  return spec;
}

/* —— 地球历法内核（JDN）—— */
const fl = Math.floor;
const GRE_START = 2299161;   // 格里高利历首日 1582-10-15 的 JDN

function dateToJDN(y: number, m: number, d: number, gregorian: boolean): number {
  const a = fl((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3;
  const base = d + fl((153 * mm + 2) / 5) + 365 * yy + fl(yy / 4);
  return gregorian ? base - fl(yy / 100) + fl(yy / 400) - 32045 : base - 32083;
}
function earthToJDN(y: number, m: number, d: number): number {
  const greg = y > 1582 || (y === 1582 && (m > 10 || (m === 10 && d >= 15)));
  return dateToJDN(y, m, d, greg);
}
function jdnToEarth(J: number): { y: number; m: number; d: number } {
  let b: number, c: number;
  if (J >= GRE_START) { const a = J + 32044; b = fl((4 * a + 3) / 146097); c = a - fl(146097 * b / 4); }
  else { b = 0; c = J + 32082; }
  const dd = fl((4 * c + 3) / 1461), e = c - fl(1461 * dd / 4), mm = fl((5 * e + 2) / 153);
  return { y: 100 * b + dd - 4800 + fl(mm / 10), m: mm + 3 - 12 * fl(mm / 10), d: e - fl((153 * mm + 2) / 5) + 1 };
}

/** 年/月/日（1 基；年=天文纪年）→ 日戳 T（整日） */
export function tacT(cal: CalendarSpec, y: number, m: number, d: number): number {
  if (cal.kind === "earth") return earthToJDN(y, Math.max(1, m), Math.max(1, d));
  /* 不等长月：先把越界月按整年进位归一（等长式里这是 (m-1)×dpm 自然带出来的），再查前缀和。
     ⚠ 等长历法**不走这条**（calOf 已收敛回等长），故 v0.14 的越界语义与黄金基准逐位不动。 */
  if (cal.off) {
    const M = cal.months, mi0 = Math.max(1, Math.floor(m)) - 1, carry = Math.floor(mi0 / M);
    return (y + carry) * cal.dpy + cal.off[mi0 - carry * M] + (Math.max(1, d) - 1);
  }
  return y * cal.dpy + (Math.max(1, m) - 1) * cal.dpm + (Math.max(1, d) - 1);
}

/** 日戳 T → {年, 月, 日}（1 基；小数部分忽略——时刻由 fmt 层处理） */
export function fromT(cal: CalendarSpec, T: number): { y: number; m: number; d: number } {
  const D = Math.floor(T);
  if (cal.kind === "earth") return jdnToEarth(D);
  const y = Math.floor(D / cal.dpy), r = D - y * cal.dpy;
  if (cal.off) {   // 月数不多，线性找即可（前缀和有序：off[i] ≤ r < off[i+1]）
    let i = cal.months - 1;
    while (i > 0 && cal.off[i] > r) i--;
    return { y, m: i + 1, d: r - cal.off[i] + 1 };
  }
  return { y, m: Math.floor(r / cal.dpm) + 1, d: (r % cal.dpm) + 1 };
}

/** 月的显示名——**全 app 单一真源**（同 ARM_NAME 之训：配了月名却有几处还印「3月」就是漂移）。
    配了月名取月名且**不补「月」字**（「霜月月」不成话）；没配＝「3月」式，两轨同式。 */
export function monthLabel(cal: CalendarSpec, m: number): string {
  const nm = cal.kind === "custom" && cal.names ? cal.names[m - 1] : "";
  return nm || m + "月";
}
/** 月日文本（日期串/时间轴日名/事件列表共用的单一真源）：「3月7日」/「霜月7日」 */
export function fmtMD(cal: CalendarSpec, m: number, d: number): string {
  return monthLabel(cal, m) + d + "日";
}

/* —— 日内时刻（T 的小数部分，0=零时）——
   一律「时:分」：每日时数 hpd × 每时分数 mph 由历法给出（缺省与地球历同为 24×60）。
   显示按量子（1/(hpd×mph) 日）四舍五入，不改存储值；位宽随进制走（24×60 制＝09:30，与旧式逐字同）。 */

/** 补零到「该位最大值」同宽：24 时制＝两位、10 时制＝一位 */
const pad = (v: number, max: number): string => String(v).padStart(String(Math.max(1, max - 1)).length, "0");

/** 一日几个量子（显示与时间轴最细一档共用）＝时数 × 每时分数 */
function dayQuanta(cal: CalendarSpec): number { return cal.hpd * cal.mph; }

/** 日内时刻文本——**全 app 单一真源**（两轨同式；调用点别再各写一遍分支）。 */
export function fmtDayTime(cal: CalendarSpec, frac: number): string {
  const tot = dayQuanta(cal);
  const t = ((Math.round(frac * tot) % tot) + tot) % tot;
  return pad(Math.floor(t / cal.mph), cal.hpd) + ":" + pad(t % cal.mph, cal.mph);
}
/** 显示前按历法量子取整（缺省=分），进位自然跨日 */
function quantT(cal: CalendarSpec, T: number): number {
  return Math.round(+T * dayQuanta(cal)) / dayQuanta(cal);
}
/** 天文纪年 → 「前N」显示年（earth 专属；custom 按 v0.14 冻结语义渲染裸数字，含 0/负年） */
function bcYear(y: number): string { return y > 0 ? String(y) : "前" + (1 - y); }

/** custom 的纪年文本＝纪元前缀 + 天文纪年数字（「SE3107」）；表单值恒是同一个数字。 */
function yearLabel(cal: CalendarSpec, y: number, spaced?: boolean): string {
  return cal.era + (spaced ? " " : "") + y;
}

/** 日期格式：SE3107·3月7日（ 12:30）｜ 1863年7月1日 09:30 ｜ 公元前216年8月2日 */
export function fmtT(cal: CalendarSpec, T: number): string {
  const Tq = quantT(cal, +T);
  const { y, m, d } = fromT(cal, Tq);
  const frac = Tq - Math.floor(Tq);
  const head = cal.kind === "earth" ? `${y > 0 ? String(y) : "公元前" + (1 - y)}年` : `${yearLabel(cal, y)}·`;
  return head + fmtMD(cal, m, d) + (frac ? " " + fmtDayTime(cal, frac) : "");
}
/** 表单格式：3107-3-7（ 午正）｜ 1815-6-18 13:30 ｜ 前216-8-2——与 parseYMD 互逆 */
export function fmtYMD(cal: CalendarSpec, T: number): string {
  const Tq = quantT(cal, +T);
  const { y, m, d } = fromT(cal, Tq);
  const frac = Tq - Math.floor(Tq);
  const time = frac ? " " + fmtDayTime(cal, frac) : "";
  return `${cal.kind === "earth" ? bcYear(y) : String(y)}-${m}-${d}${time}`;
}

/** 解析日期输入："3107-3-7 / 3107.3.7 / 3107年3月7日 / 3107"(仅年=正月初一)；
    「前216-8-2」/「-215-8-2」=公元前（天文纪年 1-N / -N）；可带时刻「 13:30」（按本历法的时/分进制）；空/非法→null */
const YMD_RE = /^(前|-)?(\d{1,6})(?:[-./年]\s*(\d{1,2}))?(?:[-./月]\s*(\d{1,2}))?\s*日?(?:\s*(\d{1,3})[:：](\d{1,3}))?\s*$/;
export function parseYMD(cal: CalendarSpec, s: unknown): number | null {
  const str = String(s == null ? "" : s).trim();
  if (!str) return null;
  const m = str.match(YMD_RE);
  if (!m) return null;
  const y = m[1] === "前" ? 1 - +m[2] : (m[1] === "-" ? -+m[2] : +m[2]);
  let frac = 0;
  if (m[5] != null) {
    const h = +m[5], mi = +m[6];
    // 时刻越界＝解析不出（不静默进位到次日）；进制随历法，24×60 时与旧判据 h>23||mi>59 逐位等价
    if (h >= cal.hpd || mi >= cal.mph) return null;
    frac = (h * cal.mph + mi) / (cal.hpd * cal.mph);
  }
  // 注：月/日越界（13月/32日）经 tacT 静默进位到相邻年月，是 v0.14 既有语义、黄金基准逐位锁定——
  // core 层不改（改则破坏平价）；越界录入的防护若要做，应放 UI 表单层，不动此编解码函数。
  return tacT(cal, y, m[3] ? +m[3] : 1, m[4] ? +m[4] : 1) + frac;
}

/** 越界回执（表单层用）：录入串里**显式给出**的月/日经日戳编解码取不回原值＝越界，
    返回归一后的显示串；未越界/未给月日/解析不出→null。
    ⚠ 只做「说出来」，不改 parseYMD 的进位语义——那是 v0.14 既有行为且被黄金基准逐位锁定
    （fixtures 里 10 月历的 `3107-12-30`、dpm 归一为 1 的 `3107-3-7` 都是越界进位样本），
    core 层拒绝越界＝破平价，防护只能放在这一层。
    「只给年」(`3107`＝正月初一) 是简写不是错，不报；公历 1582-10-05~14 这段历史空档
    也会走到这里，回执正是它该有的说明（那几天在现实中不存在）。 */
export function ymdOverflow(cal: CalendarSpec, s: unknown): string | null {
  const str = String(s == null ? "" : s).trim();
  const m = str.match(YMD_RE);
  if (!m || (m[3] == null && m[4] == null)) return null;
  const y = m[1] === "前" ? 1 - +m[2] : (m[1] === "-" ? -+m[2] : +m[2]);
  const mo = m[3] ? +m[3] : 1, d = m[4] ? +m[4] : 1;
  const back = fromT(cal, tacT(cal, y, mo, d));
  if (back.y === y && back.m === mo && back.d === d) return null;
  const T = parseYMD(cal, str);
  return T == null ? null : fmtYMD(cal, T);
}

/* —— 纪年显示/表单助手（战略图年份与信息卡共用；custom 正年份输出与旧字符串逐字一致）—— */

/* —— 战略图「月」粒度（2026-07-31）：年份取小数＝年 + (月-1)/月数。
   custom 的小数年本就是历史现状（parseYearForm 走 parseFloat），故这是**纯 additive**——
   整数年的显示与解析逐字不变（黄金基准锁定），activeAt 等数值比较天然照旧。
   ⚠ 不落月格的任意小数年（如手编的 3107.3）一律**原样保全**：显示走旧式、表单回填原数字串，
   免得「打开表单再保存」把它静默吸附到最近的月上。 —— */

/** 一年几个月：custom 取历法配置、earth 恒 12 */
export function monthsOf(cal: CalendarSpec): number { return cal.kind === "earth" ? 12 : cal.months; }

/** 年 + 月（1 基）→ 小数年 */
export function yearMonthT(cal: CalendarSpec, y: number, m: number): number {
  const M = monthsOf(cal);
  return y + (Math.min(M, Math.max(1, m)) - 1) / M;
}

/** 小数年 → {年, 月}（1 基）。⚠ 负年同规：y=-215、m=7 → -214.5，floor 取回 -215 */
export function yearMonthOf(cal: CalendarSpec, v: number): { y: number; m: number } {
  const M = monthsOf(cal), y = Math.floor(v);
  return { y, m: Math.min(M, Math.max(1, Math.round((v - y) * M) + 1)) };
}

/** 恰落在月格上（往返取得回原值）＝可按「年-月」显示；否则原样走整年式 */
function onMonth(cal: CalendarSpec, v: number): boolean {
  if (Number.isInteger(v)) return false;
  const { y, m } = yearMonthOf(cal, v);
  return Math.abs(v - yearMonthT(cal, y, m)) < 1e-9;
}

/** 纪年标签：SE3107 / SE 3107(spaced) / 公元1863 / 公元前216（earth 不受 spaced 影响）；
    月粒度＝SE3107·三月 / 公元1863年7月 */
export function fmtYear(cal: CalendarSpec, y: number, spaced?: boolean): string {
  if (onMonth(cal, y)) {
    const { y: gy, m } = yearMonthOf(cal, y);
    return cal.kind === "earth"
      ? `${gy > 0 ? "公元" + gy : "公元前" + (1 - gy)}年${m}月`
      : `${yearLabel(cal, gy, spaced)}·${monthLabel(cal, m)}`;
  }
  if (cal.kind === "earth") return y > 0 ? `公元${y}` : `公元前${1 - y}`;
  return yearLabel(cal, y, spaced);
}
/** 表单年份值：custom=原数字串（含小数年，历史现状）；earth=「1863」/「前216」；月粒度=「3107-3」 */
export function fmtYearForm(cal: CalendarSpec, y: number): string {
  if (onMonth(cal, y)) {
    const { y: gy, m } = yearMonthOf(cal, y);
    return `${cal.kind === "earth" ? bcYear(gy) : String(gy)}-${m}`;
  }
  return cal.kind === "earth" ? bcYear(y) : String(y);
}
/* 「年-月」输入（两轨共用）。⚠ 分隔符**不含小数点**——custom 的 "3107.5" 必须继续走 parseFloat
   （小数年是历史现状且黄金语义），当成 3107 年 5 月即是静默改值。 */
const YM_RE = /^(前|-)?(\d{1,6})[-/年]\s*(\d{1,2})\s*月?$/;
/** 表单年份解析：先认「年-月」；否则 custom=parseFloat（旧语义）、earth=整数年收「前N」/「-N」/「N」；空/非法→null */
export function parseYearForm(cal: CalendarSpec, s: unknown): number | null {
  const str = String(s == null ? "" : s).trim();
  if (!str) return null;
  const ym = str.match(YM_RE);
  if (ym) {
    const y = ym[1] === "前" ? 1 - +ym[2] : (ym[1] === "-" ? -+ym[2] : +ym[2]);
    const mo = +ym[3];
    return (mo >= 1 && mo <= monthsOf(cal)) ? yearMonthT(cal, y, mo) : null;
  }
  if (cal.kind !== "earth") { const v = parseFloat(str); return isFinite(v) ? v : null; }
  const m = str.match(/^(前|-)?(\d{1,6})$/);
  if (!m) return null;
  return m[1] === "前" ? 1 - +m[2] : (m[1] === "-" ? -+m[2] : +m[2]);
}

/* —— 「时刻值」助手：战略图=年份、战术图=日戳，同一调用点两态复用 —— */
export function fmtWhen(cal: CalendarSpec, tac: boolean, v: number, spaced?: boolean): string {
  return tac ? fmtT(cal, v) : fmtYear(cal, v, spaced);
}
export function fmtWhenForm(cal: CalendarSpec, tac: boolean, v: number): string {
  return tac ? fmtYMD(cal, v) : fmtYearForm(cal, v);
}
/** 时段显示（作战线/卡片列表用）：起止同刻→只写一遍；战术图同日不同刻→日期一遍+「时刻A–时刻B」
    （双全日期在 292px 窄栏挤爆版式）；其余→「A–B」；缺省侧写「…」。 */
export function fmtWhenRange(cal: CalendarSpec, tac: boolean, since: number | null | undefined, until: number | null | undefined): string {
  const a = since != null ? fmtWhen(cal, tac, since) : "…";
  const b = until != null ? fmtWhen(cal, tac, until) : "…";
  if (a === b) return a;
  if (tac && since != null && until != null) {
    const qa = quantT(cal, +since), qb = quantT(cal, +until);
    if (Math.floor(qa) === Math.floor(qb)) {
      const fa = qa - Math.floor(qa), fb = qb - Math.floor(qb);
      const day = fmtT(cal, Math.floor(qa));
      return `${day} ${fmtDayTime(cal, fa)}–${fmtDayTime(cal, fb)}`;
    }
  }
  return `${a}–${b}`;
}
export function parseWhenForm(cal: CalendarSpec, tac: boolean, s: unknown): number | null {
  return tac ? parseYMD(cal, s) : parseYearForm(cal, s);
}

/** 某年的日戳范围 [首日, 末日]（战术图 tacSpan 缺省/时间轴包络用）。custom 与旧 y*dpy 算式逐位一致 */
export function yearSpanT(cal: CalendarSpec, y: number): [number, number] {
  if (cal.kind === "earth") return [earthToJDN(y, 1, 1), earthToJDN(y + 1, 1, 1) - 1];
  return [y * cal.dpy, (y + 1) * cal.dpy - 1];
}

/* —— 表单输入策略（各编辑表单共用；custom 战略图与 v0.14 现状逐字一致）—— */
/** 时段输入占位符：战术图=年-月-日、earth 战略=公元年、custom 战略=纪元名（默认 SE）；战略两轨均可带「-月」 */
export function eraPh(cal: CalendarSpec, tac: boolean): string {
  return tac ? "年-月-日" : (cal.kind === "earth" ? "公元年[-月]" : `${cal.era}[-月]`);
}
/** 时段输入控件类型：一律 text。⚠ custom 战略原为 number（旧语义），战略图加月粒度后
    number 打不进「3107-3」——数据解析仍由 parseYearForm 兜住纯数字与小数年。 */
export function eraTy(_cal: CalendarSpec, _tac: boolean): "text" | "number" {
  return "text";
}
