/* 览面 · 事件时间线：全部事件按年排序；点击＝跳年＋定位＋选中；
   当年金显、未来淡显、选中描边；空态＝几何印引导。语义同旧 EventTimeline。
   战术图另有「相位」节（分帧命名时刻的列表管理,与时间坞金菱标记同源）。 */
import { EVENT_TYPES } from "../core/constants.ts";
import { calOf, fmtDayTime, fmtMD, fmtT, fmtWhen, fromT, type CalendarSpec } from "../core/calendar.ts";
import { evCurrentAt, evFutureAt, phaseIndexAt, phasesOf } from "../core/time.ts";
import { addPhaseAt, removePhaseAt, renamePhase } from "./editops.ts";
import { clearOpSel, flyReqSig, isTacSig, mutateWorld, selSig, showToast, stopPlay, worldSig, yearSig, readOnlySig } from "./state.ts";
import type { World } from "../core/types.ts";
import { tget } from "../core/util.ts";

/** 相位行内短时刻：战役图内年份是常量,行内只报「几月几日 时刻」（同坞轨标签式）,
    全格式（含纪年）留给悬停提示——否则挤瘪改名框。 */
function phLab(cal: CalendarSpec, t: number): string {
  const p = fromT(cal, t);
  const frac = t - Math.floor(t);
  const hm = frac > 1e-9 ? " " + fmtDayTime(cal, frac) : "";   // 月名/时刻一律走 calendar 的显示单一真源
  return fmtMD(cal, p.m, p.d) + hm;
}

/** 相位节（战术图专属）：「＋ 新增相位」记当前时刻、行内改名（失焦即存）、
    时刻金链跳转、✕ 即时删+可撤销 toast；金菱＝当前所在相位段（与坞标记同判据）。 */
function PhaseSec({ world, T, cal }: { world: World; T: number; cal: CalendarSpec }) {
  const ph = phasesOf(world.meta);
  const cur = phaseIndexAt(ph, T);
  const add = () => {
    if (ph.some(p => Math.abs(p.t - T) < 1e-9)) { showToast("该时刻已有相位", { err: true }); return; }
    mutateWorld(w => { addPhaseAt(w, T); });
    showToast(`已新增相位 ${fmtT(cal, T)}`, { undo: true });
  };
  return (
    <>
      <div class="sec">相位<span class="cnt">{ph.length}</span>
        <button type="button" class="mini tr" title="把当前时刻记为一个相位（战役分帧锚点）" onClick={add}>＋ 新增相位</button></div>
      {ph.length === 0 && <div class="hint">相位＝战役分帧的命名时刻：把时间轴拨到要出帧的一刻，点「＋ 新增相位」；<kbd>PgUp</kbd>/<kbd>PgDn</kbd> 上下相位跳转，⚙ 设置「🎞 分帧出图」逐相位导出 PNG</div>}
      {ph.map((p, i) => (
        <div key={p.t} class="phrow">
          <span class={"phdot" + (i === cur ? " cur" : "")} aria-hidden="true" />
          <button type="button" class="link time" title={`拨时间轴到该相位 · ${fmtT(cal, p.t)}`} onClick={() => { stopPlay(); yearSig.value = p.t; }}>{phLab(cal, p.t)}</button>
          <input class="fld" type="text" placeholder={`相位 ${i + 1}`} defaultValue={p.名称 || ""} key={p.t + ":" + (p.名称 || "")}
            title="相位名（改完失焦即存）"
            onChange={e => { const v = (e.currentTarget as HTMLInputElement).value; mutateWorld(w => { renamePhase(w, p.t, v); }); showToast("已保存相位名", { undo: true }); }} />
          <button type="button" class="link del" title="删此相位" onClick={() => { mutateWorld(w => { removePhaseAt(w, p.t); }); showToast("已删除相位", { undo: true }); }}>✕</button>
        </div>
      ))}
    </>
  );
}

export function EventsPane() {
  const world = worldSig.value!;
  const yearNow = yearSig.value;
  const tac = isTacSig.value;
  const cal = calOf((world.meta || {}).calendar);
  const sel = selSig.value;
  const evs = world.nodes.filter(n => n.type === "event" && n.year != null)
    .sort((a, b) => (a.year as number) - (b.year as number));
  if (!evs.length) {
    return (
      <>
        {tac && <PhaseSec world={world} T={yearNow} cal={cal} />}
        <div class="empty"><span class="ph">史</span><b>时间线还空着</b>
          <p>{readOnlySig.value
            ? "这张图里还没有带年份的事件点——拖时间轴仍可看痆域与部队随纪年演变。"
            : "放一个事件点（绘 → 点 → 类型选「事件」），它会同时出现在这里与时间轴刻度上。"}</p></div>
      </>
    );
  }
  return (
    <>
      {tac && <PhaseSec world={world} T={yearNow} cal={cal} />}
      <div class="hint">全部事件按{tac ? "日" : "年"}排序 · 未来事件淡显 · <b>点击＝跳{tac ? "日" : "年"}＋定位＋选中</b></div>
      <div class="rows" id="ev-list">
        {evs.map(ev => {
          const y = ev.year as number;
          const et = tget(EVENT_TYPES, ev.evtype) || EVENT_TYPES.battle;
          const isSel = !!(sel && sel.kind === "node" && sel.id === ev.id);
          return (
            <button key={ev.id}
              class={"ev tr" + (evFutureAt(y, yearNow) ? " fut" : evCurrentAt(y, yearNow) ? " cur" : "") + (isSel ? " sel" : "")}
              onClick={() => {
                flyReqSig.value = { lon: ev.lon, lat: ev.lat };
                clearOpSel();
                selSig.value = { kind: "node", id: ev.id };
                if (y !== yearNow) yearSig.value = y;   // 时间轴自动跳到事件当年/当日
              }}>
              <span class="yr">{fmtWhen(cal, tac, y)}</span>
              <span class="ic">{et.sym}</span>
              <span class="tt"><b>{ev.名称 || ev.id}</b>{typeof ev.sides === "string" && ev.sides ? <span>{ev.sides}</span> : null}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
