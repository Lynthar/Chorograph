/* 览面 · 事件时间线：全部事件按年排序；点击＝跳年＋定位＋选中；
   当年金显、未来淡显、选中描边；空态＝几何印引导。语义同旧 EventTimeline。 */
import { EVENT_TYPES } from "../core/constants.ts";
import { calOf, fmtWhen } from "../core/calendar.ts";
import { clearOpSel, flyReqSig, isTacSig, selSig, worldSig, yearSig } from "./state.ts";

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
      <div class="empty"><span class="ph">史</span><b>时间线还空着</b>
        <p>放一个事件点（绘 → 点 → 类型选「事件」），它会同时出现在这里与时间坞刻度上。</p></div>
    );
  }
  return (
    <>
      <div class="hint">全部事件按{tac ? "日" : "年"}排序 · 未来事件淡显 · <b>点击＝跳{tac ? "日" : "年"}＋定位＋选中</b></div>
      <div class="rows" id="ev-list">
        {evs.map(ev => {
          const y = ev.year as number;
          const et = EVENT_TYPES[ev.evtype as string] || EVENT_TYPES.battle;
          const isSel = !!(sel && sel.kind === "node" && sel.id === ev.id);
          return (
            <button key={ev.id}
              class={"ev tr" + (y > yearNow ? " fut" : y === yearNow ? " cur" : "") + (isSel ? " sel" : "")}
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
