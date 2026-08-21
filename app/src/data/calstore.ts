/* 历法模板库（2026-08-19 用户点单：「图库页单独加一个历法按钮，自定义并命名，新建图时下拉选」）。
   ⚠ 存 localStorage 而**不**进图库：模板是**模具**不是数据——真历法在建图那一刻整份拷进
   `meta.calendar` 并就此冻结（「历法创建后锁定」的既有语义一字不动）。放本机于是：①浏览器图库与
   文件夹图库共用同一份模具 ②不必给 IndexedDB 升版（升版要接 onblocked，代价与风险都大过这件事）。
   代价如实：换机器/清站点数据即失去模具，但**已建的地图不受影响**（历法在存档里）。
   ⚠ 读写一律容错：本机自由数据，坏了当没有（同 calOf「不合法即当没给」之规）。 */
import { MAX_HPD, MAX_MPH } from "../core/calendar.ts";
import type { CalendarCfg } from "../core/types.ts";

export interface CalTemplate { id: string; 名称: string; cfg: CalendarCfg }

const KEY = "yutu2.cals";
const MAX_TEMPLATES = 200;   // 值也是用户数据：手改 localStorage 塞进十万条不该让图库页卡死

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const posInt = (v: unknown, cap: number): number | undefined => {
  const n = Math.floor(+(v as number));
  return isFinite(n) && n >= 1 ? Math.min(cap, n) : undefined;
};

/** 只留认得的历法键（模板与存档共用这一道筛：写进 meta.calendar 的也该是这个形状） */
export function pickCalendarCfg(raw: unknown): CalendarCfg {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c: CalendarCfg = {};
  if (o.kind === "earth") return { kind: "earth" };   // earth 不读其余键（同 calOf）
  const months = posInt(o.months, 999), dpm = posInt(o.dpm, 9999);
  if (months) c.months = months;
  if (dpm) c.dpm = dpm;
  const era = str(o.era);
  if (era) c.era = era;
  const lens = (Array.isArray(o.monthLens) ? o.monthLens : []).map(v => posInt(v, 9999)).filter((v): v is number => !!v);
  if (lens.length) c.monthLens = lens.slice(0, 999);
  const names = (Array.isArray(o.monthNames) ? o.monthNames : []).map(str);
  if (names.some(v => v)) c.monthNames = names.slice(0, 999);
  const hpd = posInt(o.hoursPerDay, MAX_HPD), mph = posInt(o.minutesPerHour, MAX_MPH);
  if (hpd && hpd !== 24) c.hoursPerDay = hpd;        // 与缺省同值即不落盘（同 era/months 之规）
  if (mph && mph !== 60) c.minutesPerHour = mph;
  return c;
}

/** 纯函数：任意值 → 模板数组（坏项跳过、名称去空、条数封顶） */
export function parseTemplates(raw: unknown): CalTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: CalTemplate[] = [];
  for (const it of raw) {
    const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    const id = str(o.id), 名称 = str(o.名称);
    if (!id || !名称) continue;
    out.push({ id, 名称, cfg: pickCalendarCfg(o.cfg) });
    if (out.length >= MAX_TEMPLATES) break;
  }
  return out;
}

/** 纯函数：新增或就地替换（按 id），保持原有次序 */
export function upsertTemplate(list: readonly CalTemplate[], t: CalTemplate): CalTemplate[] {
  const i = list.findIndex(x => x.id === t.id);
  if (i < 0) return [...list, t];
  const out = [...list];
  out[i] = t;
  return out;
}

export function removeTemplate(list: readonly CalTemplate[], id: string): CalTemplate[] {
  return list.filter(x => x.id !== id);
}

export function newTemplateId(): string {
  return "c" + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
}

/* —— 本机存取（无 localStorage 的环境静默返回空/失败：模具丢了不该拦住用图） —— */
export function loadTemplates(): CalTemplate[] {
  try { return parseTemplates(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch { return []; }
}

/** 落盘；配额满/隐私模式返回 false —— 调用方要**说话**（同「失败要响」之规） */
export function saveTemplates(list: readonly CalTemplate[]): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }
}
