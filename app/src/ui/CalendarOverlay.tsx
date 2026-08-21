/* 历法编辑弹层（2026-08-19 用户点单）：图库页「📅 历法」进来，在这里把架空历法调好并**命名存下**，
   新建地图时在下拉里直接选。模板存本机（data/calstore，理由见其头注）；建图那一刻整份拷进
   meta.calendar 并冻结——改模板不会追改已建的图，这是有意的（历法一改，已存日戳全要重释）。
   表单沿用非受控 + 提交时读回（同设置弹层之规）；⚠ 唯独实时预览要跟着敲，故 onInput 弹一个计数。 */
import { useRef, useState } from "preact/hooks";
import { calOf, fmtT, fmtYear, MAX_HPD, MAX_MPH, tacT } from "../core/calendar.ts";
import { loadTemplates, newTemplateId, pickCalendarCfg, removeTemplate, saveTemplates, upsertTemplate, type CalTemplate } from "../data/calstore.ts";
import type { CalendarCfg } from "../core/types.ts";
import { useModalFocus } from "./modal.ts";
import { calOverlaySig, calTemplatesSig, showToast } from "./state.ts";

const nums = (s: string): number[] => s.split(/[,，、\s]+/).map(x => parseInt(x, 10)).filter(n => isFinite(n) && n >= 1);
const words = (s: string): string[] => s.split(/[,，、\n]+/).map(x => x.trim()).filter(x => x);

/** 表单 → 历法配置（模板与 meta.calendar 同一个形状；筛选交给 pickCalendarCfg） */
function readForm(box: HTMLElement): { 名称: string; cfg: CalendarCfg } {
  const v = (id: string): string => (box.querySelector<HTMLInputElement | HTMLTextAreaElement>("#" + id)?.value || "").trim();
  const lens = nums(v("cal_len"));
  const cfg: CalendarCfg = { era: v("cal_era") || "SE" };
  if (lens.length > 1) cfg.monthLens = lens;                      // 逐月不同
  else { cfg.months = parseInt(v("cal_m"), 10) || 12; cfg.dpm = lens[0] || 30; }
  const names = words(v("cal_names"));
  if (names.length) cfg.monthNames = names;
  cfg.hoursPerDay = parseInt(v("cal_hpd"), 10) || 24;
  cfg.minutesPerHour = parseInt(v("cal_mph"), 10) || 60;
  return { 名称: v("cal_name") || "未命名历法", cfg: pickCalendarCfg(cfg) };
}

function CalendarCard() {
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(box);
  const list = calTemplatesSig.value;
  const [curId, setCurId] = useState<string>(list[0] ? list[0].id : "");
  const [tick, bump] = useState(0);
  const cur = list.find(t => t.id === curId) || null;
  /* 预览用当刻表单值现算（同设置弹层的实时尺度读数之规：首帧未挂就退回已存值） */
  const preview = (): string => {
    const el = box.current;
    const cfg = el ? readForm(el).cfg : (cur ? cur.cfg : {});
    const cal = calOf(cfg);
    const y = 3107;
    const T = tacT(cal, y, Math.min(3, cal.months), 7) + 1 / 3;
    return `${fmtYear(cal, y)} ｜ ${fmtT(cal, T)} ｜ 一年 ${cal.dpy} 日 · 一日 ${cal.hpd} 时 × ${cal.mph} 分`;
  };
  const persist = (next: CalTemplate[], sel: string, note: string): void => {
    if (!saveTemplates(next)) { showToast("历法没能存进本机（浏览器存储被占满或处于隐私模式）", { err: true }); return; }
    calTemplatesSig.value = next;
    setCurId(sel);
    showToast(note);
  };
  const doSave = (): void => {
    const el = box.current;
    if (!el) return;
    const { 名称, cfg } = readForm(el);
    const id = curId || newTemplateId();
    persist(upsertTemplate(list, { id, 名称, cfg }), id, `已保存历法「${名称}」`);
  };
  const doNew = (): void => { setCurId(""); bump(tick + 1); };
  const doDel = (t: CalTemplate): void => {
    if (!confirm(`删除历法「${t.名称}」？\n已经用它建好的地图不受影响（历法在各自存档里）。`)) return;
    const next = removeTemplate(list, t.id);
    persist(next, next[0] ? next[0].id : "", `已删除「${t.名称}」`);
  };
  const c = cur ? cur.cfg : {};
  const lenText = c.monthLens && c.monthLens.length ? c.monthLens.join("，") : String(c.dpm || 30);
  return (
    <div class="modal" ref={box} role="dialog" aria-modal="true" aria-labelledby="calTitle" tabIndex={-1}>
      <div class="mo-head">
        <span class="t" id="calTitle">📅 历法</span>
        <span class="s">自定义架空历法并命名存下，新建地图时直接选用</span>
        <button class="x tr" aria-label="关闭" onClick={() => { calOverlaySig.value = false; }}>✕</button>
      </div>
      <div class="mo-body" onInput={() => bump(tick + 1)} key={curId}>
        <div class="setrow"><label>已存历法</label>
          <div class="seg" style={{ flexWrap: "wrap" }}>
            {list.map(t => (
              <button key={t.id} type="button" class={"tbtn" + (t.id === curId ? " on" : "")} aria-pressed={t.id === curId}
                onClick={() => setCurId(t.id)}>{t.名称}</button>
            ))}
            <button type="button" class="tbtn" onClick={doNew}>＋ 新增历法</button>
          </div>
        </div>
        {cur && <div class="setrow"><label></label>
          <span class="sub">改动要点「保存」才落；地球历法是内置的，不在此列。</span>
          <span class="sp" />
          <button type="button" class="bt danger-ghost tr" onClick={() => doDel(cur)}>删除这个历法</button>
        </div>}

        <h4 style={{ margin: "14px 0 4px" }}>基本</h4>
        <div class="setrow"><label>名称</label>
          <input type="text" id="cal_name" class="wide" defaultValue={cur ? cur.名称 : "新历法"} /></div>
        <div class="setrow"><label>纪元前缀</label>
          <input type="text" id="cal_era" style={{ width: "6em" }} defaultValue={c.era || "SE"} />
          <span class="sub">纪年前缀，印在年份之前，如 SE3107</span></div>

        <h4 style={{ margin: "14px 0 4px" }}>月</h4>
        <div class="setrow"><label>月数</label>
          <input type="number" id="cal_m" min={1} step={1} style={{ width: "5em" }} defaultValue={String(c.months || (c.monthLens ? c.monthLens.length : 12))} />
          <span class="sub">填了「逐月日数」时以那一串的长度为准</span></div>
        <div class="setrow"><label>每月日数</label>
          <input type="text" id="cal_len" class="wide" defaultValue={lenText} />
          <span class="sub">填一个数＝各月等长；填一串（如 31，28，31，30）＝逐月不同</span></div>
        <div class="setrow"><label>月名</label>
          <input type="text" id="cal_names" class="wide" defaultValue={(c.monthNames || []).join("，")} placeholder="霜月，苍月，玄月" />
          <span class="sub">按次序分隔，逗号与顿号都认；留空＝1月、2月…，缺的那几个也按「3月」式回退</span></div>

        <h4 style={{ margin: "14px 0 4px" }}>一日</h4>
        <div class="setrow"><label>每日几时</label>
          <input type="number" id="cal_hpd" min={1} max={MAX_HPD} step={1} style={{ width: "5em" }} defaultValue={String(c.hoursPerDay || 24)} />
          <span class="sub">时间轴「时」档一步＝一日的 1/时数</span></div>
        <div class="setrow"><label>每时几分</label>
          <input type="number" id="cal_mph" min={1} max={MAX_MPH} step={1} style={{ width: "5em" }} defaultValue={String(c.minutesPerHour || 60)} />
          <span class="sub">时 × 分＝日内时刻的最细刻度，显示成「08:15」式</span></div>

        <div class="setrow" style={{ marginTop: "12px" }}><label>预览</label>
          <b style={{ fontFamily: "var(--f-mono)" }}>{tick >= 0 ? preview() : ""}</b></div>
      </div>
      <div class="mo-foot">
        <button class="bt ghost tr" onClick={() => { calOverlaySig.value = false; }}>关闭</button>
        <span class="sp" />
        <button class="bt zhu tr" onClick={doSave}>✔ 保存历法</button>
      </div>
    </div>
  );
}

export function CalendarOverlay() {
  if (!calOverlaySig.value) return null;   // 真卸载：useModalFocus 的清理靠它跑（同帮助弹层之训）
  return (
    <div id="calpanel" class="scrim open"
      onClick={e => { if (e.target === e.currentTarget) calOverlaySig.value = false; }}>
      <CalendarCard />
    </div>
  );
}

/** 启动时把本机模板灌进信号（boot 调用一次） */
export function initCalTemplates(): void {
  calTemplatesSig.value = loadTemplates();
}
