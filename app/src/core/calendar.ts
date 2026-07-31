/* 历法与日戳（双轨）：
   · custom=自定义均匀历法（v0.14 现状）：meta.calendar={months,dpm}（默认 12月×30日=年360日），
     纪元前缀可配（era，默认 "SE"）——正年份输出与旧实现逐位一致（黄金基准锁定）；
   · earth=真实地球历法：meta.calendar={kind:"earth"}。日戳=儒略日数 JDN；日期↔JDN 用 Calendar FAQ
     （Tondering）/Fliegel–Van Flandern 的整数算法（中间量在有效域恒正，floor=trunc 无符号陷阱）；
     儒略历 ≤1582-10-04（JDN 2299160）/ 格里高利历 ≥1582-10-15（JDN 2299161），锚点已数值验证
     （G2000-01-01=2451545；闰年 1900✗/2000✓/0年双历✓）。1582-10-05~14 的儒略输入落到同一物理日
     （=格里 10-15~24），显示取格里正名。
   内部纪年一律天文纪年（0=前1年，-215=前216年）；UI 显示/解析一律「前N」，不露裸负数。
   日戳 T 为线性数字：整数=日，小数=日内时刻（0=午夜；custom 显示时辰·96刻制，earth 显示 HH:MM）。
   activeAt/unitPos 等时间过滤只比较数字——历法只是 T 的编解码层，换历法不动时间语义。 */
import type { CalendarCfg } from "./types.ts";

export interface CalendarSpec { kind: "custom" | "earth"; months: number; dpm: number; dpy: number; era: string }

/** 历法归一（容错：缺省/非法回落 custom 12×30、纪元 SE）。earth 分支不得读 months/dpm/dpy */
export function calOf(c?: CalendarCfg | null): CalendarSpec {
  const cc = c || {};
  const months = Math.max(1, ((cc.months as number) | 0) || 12);
  const dpm = Math.max(1, ((cc.dpm as number) | 0) || 30);
  const era = (typeof cc.era === "string" && cc.era.trim()) ? cc.era.trim() : "SE";
  return { kind: cc.kind === "earth" ? "earth" : "custom", months, dpm, dpy: months * dpm, era };
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
  return y * cal.dpy + (Math.max(1, m) - 1) * cal.dpm + (Math.max(1, d) - 1);
}

/** 日戳 T → {年, 月, 日}（1 基；小数部分忽略——时刻由 fmt 层处理） */
export function fromT(cal: CalendarSpec, T: number): { y: number; m: number; d: number } {
  const D = Math.floor(T);
  if (cal.kind === "earth") return jdnToEarth(D);
  const y = Math.floor(D / cal.dpy), r = D - y * cal.dpy;
  return { y, m: Math.floor(r / cal.dpm) + 1, d: (r % cal.dpm) + 1 };
}

const CN_NUM = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
export function cnMonth(m: number): string { return m <= 12 ? CN_NUM[m] : String(m); }
/** 初七/十七/廿七 式古典日名；>30 回退数字 */
export function cnDay(d: number): string {
  if (d <= 10) return "初" + CN_NUM[d];
  if (d < 20) return "十" + CN_NUM[d - 10];
  if (d === 20) return "二十";
  if (d < 30) return "廿" + CN_NUM[d - 20];
  if (d === 30) return "三十";
  return String(d) + "日";
}

/* —— 日内时刻（T 的小数部分，0=午夜）——
   custom：十二时辰·96 刻制（每时辰 8 刻=初/正各 4 刻；子初=23:00、子正=00:00、午正=12:00，
   刻名 初刻(略)/一刻/二刻/三刻）；earth：HH:MM。显示按各自量子四舍五入（刻/分），不改存储值。 */
const SHICHEN = "子丑寅卯辰巳午未申酉戌亥";
const KE = ["", "一", "二", "三"];

/** 日内分数 → 时辰名（如 午正 / 午正二刻 / 子初）。按刻(1/96日)取整 */
export function fmtShichen(frac: number): string {
  const k = ((Math.round(frac * 96) % 96) + 96) % 96;
  const s = (k + 4) % 96;                          // 平移使 0=子初(23:00)
  const idx = fl(s / 8), half = fl((s % 8) / 4), r = s % 4;
  return SHICHEN[idx] + (half ? "正" : "初") + (r ? KE[r] + "刻" : "");
}
export function fmtHM(frac: number): string {
  const t = ((Math.round(frac * 1440) % 1440) + 1440) % 1440;
  const h = fl(t / 60), mi = t % 60;
  return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
}
/** 显示前按历法量子取整（custom=刻、earth=分），进位自然跨日 */
function quantT(cal: CalendarSpec, T: number): number {
  const q = cal.kind === "earth" ? 1440 : 96;
  return Math.round(+T * q) / q;
}
/** 天文纪年 → 「前N」显示年（earth 专属；custom 按 v0.14 冻结语义渲染裸数字，含 0/负年） */
function bcYear(y: number): string { return y > 0 ? String(y) : "前" + (1 - y); }

/** 古典/历史格式：SE3107·三月初七（·午正）｜ 1863年7月1日 09:30 ｜ 公元前216年8月2日 */
export function fmtT(cal: CalendarSpec, T: number): string {
  const Tq = quantT(cal, +T);
  const { y, m, d } = fromT(cal, Tq);
  const frac = Tq - Math.floor(Tq);
  if (cal.kind === "earth")
    return `${y > 0 ? String(y) : "公元前" + (1 - y)}年${m}月${d}日${frac ? " " + fmtHM(frac) : ""}`;
  return `${cal.era}${y}·${cnMonth(m)}月${cnDay(d)}${frac ? "·" + fmtShichen(frac) : ""}`;
}
/** 表单格式：3107-3-7（ 午正）｜ 1815-6-18 13:30 ｜ 前216-8-2——与 parseYMD 互逆 */
export function fmtYMD(cal: CalendarSpec, T: number): string {
  const Tq = quantT(cal, +T);
  const { y, m, d } = fromT(cal, Tq);
  const frac = Tq - Math.floor(Tq);
  const time = frac ? (cal.kind === "earth" ? " " + fmtHM(frac) : " " + fmtShichen(frac)) : "";
  return `${cal.kind === "earth" ? bcYear(y) : String(y)}-${m}-${d}${time}`;
}

/** 解析日期输入："3107-3-7 / 3107.3.7 / 3107年3月7日 / 3107"(仅年=正月初一)；
    「前216-8-2」/「-215-8-2」=公元前（天文纪年 1-N / -N）；可带时刻「 13:30」或「午正二刻」；空/非法→null */
const YMD_RE = /^(前|-)?(\d{1,6})(?:[-./年]\s*(\d{1,2}))?(?:[-./月]\s*(\d{1,2}))?\s*日?(?:\s*(?:(\d{1,2})[:：](\d{1,2})|([子丑寅卯辰巳午未申酉戌亥])\s*([初正])\s*(?:([一二三])\s*刻|初刻)?))?\s*$/;
export function parseYMD(cal: CalendarSpec, s: unknown): number | null {
  const str = String(s == null ? "" : s).trim();
  if (!str) return null;
  const m = str.match(YMD_RE);
  if (!m) return null;
  const y = m[1] === "前" ? 1 - +m[2] : (m[1] === "-" ? -+m[2] : +m[2]);
  let frac = 0;
  if (m[5] != null) {
    const h = +m[5], mi = +m[6];
    if (h > 23 || mi > 59) return null;
    frac = (h * 60 + mi) / 1440;
  } else if (m[7] != null) {
    const idx = SHICHEN.indexOf(m[7]), half = m[8] === "正" ? 1 : 0, r = m[9] ? KE.indexOf(m[9]) : 0;
    frac = ((idx * 8 + half * 4 + r - 4 + 96) % 96) / 96;
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
      : `${cal.era}${spaced ? " " : ""}${gy}·${cnMonth(m)}月`;
  }
  if (cal.kind === "earth") return y > 0 ? `公元${y}` : `公元前${1 - y}`;
  return cal.era + (spaced ? " " : "") + y;
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
      const t = (f: number) => cal.kind === "earth" ? fmtHM(f) : (f ? fmtShichen(f) : "子正");
      return cal.kind === "earth" ? `${day} ${t(fa)}–${t(fb)}` : `${day}·${t(fa)}–${t(fb)}`;
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
