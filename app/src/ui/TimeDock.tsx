/* 时间坞：接替旧的时间轴滑杆。
   战略＝年轨（事件刻度+<10px 聚簇+标签避让+金填充+步进钮）；
   战术＝V1 双层坞（日轨常驻；「时」粒度时滑出时辰细轨：当前日±1 窗口、半时辰小刻，回「日」即收）。
   金＝时间语法：播放钮/填充/刻度/当年标签/游标一律金。状态机不动：值=yearSig、粒度=subDaySig、
   播放=togglePlay（P 键共用）；轨道=scrubber（按下即停播+落点、拖动跟随），刻度/标签纯显示。
   时轨拖拽期间窗口冻结（dragSub），否则跨日界会重取窗口导致指针↔值映射抖动；抬手 subBump 重取。 */
import { Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import type { JSX } from "preact";
import { calOf, cnDay, cnMonth, fmtHM, fmtShichen, fmtYear, fromT, type CalendarSpec } from "../core/calendar.ts";
import { isTacSig, playingSig, rangeSig, stopPlay, subDaySig, timeStep, togglePlay, toggleSubDay, worldSig, yearSig } from "./state.ts";
import { buildMarks, hourWindow, quantTime, subTicks, type EvMark } from "./timedock.ts";

/** 主轨实测宽（聚簇/避让的像素判定；ResizeObserver 更新，未测得前用 800 估） */
const trackW = signal(800);
/** 时轨拖拽结束后 +1：强制重渲以解冻窗口 */
const subBump = signal(0);

/** 同槽判定：战略=同年、战术=同日（事件刻度 cur 高亮用） */
const sameSlot = (t: number, now: number): boolean => Math.floor(t) === Math.floor(now);

function dayShort(cal: CalendarSpec, T: number): string {
  const p = fromT(cal, T);
  return cal.kind === "earth" ? `${p.m}月${p.d}日` : `${cnMonth(p.m)}月${cnDay(p.d)}`;
}

export function TimeDock() {
  subBump.value;
  const { min, max } = rangeSig.value;
  const y = yearSig.value;
  const tac = isTacSig.value;
  const playing = playingSig.value;
  const cal = calOf((worldSig.value?.meta || {}).calendar);
  const sub = tac && subDaySig.value;
  const span = max - min;
  const pct = span > 0 ? Math.min(100, Math.max(0, ((y - min) / span) * 100)) : 0;

  const trackRef = useRef<HTMLDivElement>(null);
  const dragMain = useRef(false);
  const dragSub = useRef<{ w0: number; w1: number } | null>(null);
  useEffect(() => {
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { const w = el.clientWidth; if (w && w !== trackW.peek()) trackW.value = w; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const evs: EvMark[] = (worldSig.value ? worldSig.value.nodes : [])
    .filter(n => n.type === "event" && n.year != null)
    .map(n => ({ t: n.year as number, label: n.名称 || n.id }));
  const marks = buildMarks(evs, min, max, y, trackW.value, sameSlot);

  let mainLab: string, subLab: string;
  if (tac) {
    const p = fromT(cal, y);
    const frac = y - Math.floor(y);
    mainLab = cal.kind === "earth" ? `${p.m}月${p.d}日` : `${cnMonth(p.m)}月${cnDay(p.d)}`;
    subLab = fmtYear(cal, p.y, true) + (sub ? " · " + (cal.kind === "earth" ? fmtHM(frac) : fmtShichen(frac)) : "");
  } else {
    mainLab = fmtYear(cal, Math.round(y), true);
    subLab = "纪年 · 步进 1 年";
  }
  const mmMin = tac ? dayShort(cal, min) : fmtYear(cal, Math.round(min), true);
  const mmMax = tac ? dayShort(cal, max) : fmtYear(cal, Math.round(max), true);

  const stepBy = (dir: number): void => {
    const r = rangeSig.peek(), st = timeStep();
    yearSig.value = quantTime(yearSig.peek() + dir * st, st, r.min, r.max);
  };
  const scrubMain = (el: HTMLElement, clientX: number): void => {
    const r = rangeSig.peek(), rect = el.getBoundingClientRect();
    if (!(rect.width > 0) || !(r.max > r.min)) return;
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    yearSig.value = quantTime(r.min + f * (r.max - r.min), timeStep(), r.min, r.max);
  };
  const endMain: JSX.PointerEventHandler<HTMLDivElement> = e => {
    dragMain.current = false;
    e.currentTarget.classList.remove("dragging");
  };

  /* —— 战术「时」细轨（V1 下层）——拖拽映射用冻结窗口，渲染窗口同源 —— */
  const win = dragSub.current || hourWindow(y, min, max);
  const wspan = win.w1 - win.w0;
  const dayLab = (d: number): string => {
    const p = fromT(cal, d);
    const withMonth = p.d === 1 || d === win.w0;
    return cal.kind === "earth" ? (withMonth ? `${p.m}月${p.d}日` : `${p.d}日`)
      : (withMonth ? `${cnMonth(p.m)}月${cnDay(p.d)}` : cnDay(p.d));
  };
  const ticks = sub ? subTicks(win.w0, win.w1, dayLab) : [];
  const d0 = Math.floor(y);
  const tp = Math.min(100, Math.max(0, ((y - win.w0) / wspan) * 100));
  const scrubSub = (el: HTMLElement, clientX: number): void => {
    const w = dragSub.current;
    if (!w) return;
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const r = rangeSig.peek();
    yearSig.value = quantTime(w.w0 + f * (w.w1 - w.w0), 1 / 24, Math.max(w.w0, r.min), Math.min(w.w1, r.max));
  };
  const endSub: JSX.PointerEventHandler<HTMLDivElement> = e => {
    dragSub.current = null;
    e.currentTarget.classList.remove("dragging");
    subBump.value++;
  };

  return (
    <>
      <button class="dk-play tr" title="播放时间轴 (P)" aria-label={playing ? "暂停" : "播放"} onClick={togglePlay}>{playing ? "⏸" : "▶"}</button>
      <button class="dk-step tr" title={tac ? (sub ? "后退半时辰" : "后退一日") : "后退一年"} aria-label="后退一步" onClick={() => stepBy(-1)}>‹</button>
      <button class="dk-step tr" title={tac ? (sub ? "前进半时辰" : "前进一日") : "前进一年"} aria-label="前进一步" onClick={() => stepBy(1)}>›</button>
      <div class="dk-year" title="时间为基底：疆域·归属·战役·地点/道路/地形的存在时段，一切依纪年显示">
        <span class="y">{mainLab}</span><span class="s">{subLab}</span>
      </div>
      <div class="dk-mid">
        <div class="dk-track" ref={trackRef}
          onPointerDown={e => {
            stopPlay();
            dragMain.current = true;
            const el = e.currentTarget;
            el.classList.add("dragging");
            try { el.setPointerCapture(e.pointerId); } catch (x) {}
            scrubMain(el, e.clientX);
          }}
          onPointerMove={e => { if (dragMain.current) scrubMain(e.currentTarget, e.clientX); }}
          onPointerUp={endMain} onPointerCancel={endMain}>
          <div class="dk-rail"></div>
          <div class="fill" style={{ width: pct + "%" }}></div>
          {marks.map((m, i) => m.kind === "cluster"
            ? <span key={i} class={"cl" + (m.cur ? " cur" : "") + (m.fut ? " fut" : "")} style={{ left: m.pct + "%" }}>×{m.n}</span>
            : <Fragment key={i}>
                <span class={"tick" + (m.fut ? " fut" : "")} style={{ left: m.pct + "%" }}></span>
                {m.label != null && <span class={"tlab" + (m.cur ? " cur" : "") + (m.fut ? " fut" : "")} style={{ left: m.pct + "%" }}>{m.label}</span>}
              </Fragment>)}
          <span class="thumb" style={{ left: pct + "%" }}></span>
          <span class="mm" style={{ left: "0" }}>{mmMin}</span>
          <span class="mm" style={{ right: "0" }}>{mmMax}</span>
        </div>
        {tac && (
          <div class={"dk-sub" + (sub ? " on" : "")}
            onPointerDown={sub ? e => {
              stopPlay();
              const r = rangeSig.peek();
              dragSub.current = hourWindow(yearSig.peek(), r.min, r.max);
              const el = e.currentTarget;
              el.classList.add("dragging");
              try { el.setPointerCapture(e.pointerId); } catch (x) {}
              scrubSub(el, e.clientX);
            } : undefined}
            onPointerMove={sub ? e => { if (dragSub.current) scrubSub(e.currentTarget, e.clientX); } : undefined}
            onPointerUp={sub ? endSub : undefined} onPointerCancel={sub ? endSub : undefined}>
            {sub && <>
              {d0 >= win.w0 && d0 < win.w1 && <span class="zone" style={{ left: ((d0 - win.w0) / wspan) * 100 + "%", width: (100 / wspan) + "%" }}></span>}
              {ticks.map((t, i) => <Fragment key={i}>
                <span class={"htk" + (t.kind === "day" ? " big" : t.kind === "noon" ? " noon" : "")} style={{ left: t.pct + "%" }}></span>
                {t.label != null && <span class={"hlb" + (t.kind === "noon" ? " noon" : "") + (t.pct === 0 ? " edge" : "")} style={{ left: t.pct + "%" }}>{t.label}</span>}
              </Fragment>)}
              <span class="hth" style={{ left: tp + "%" }}></span>
            </>}
          </div>
        )}
      </div>
      <div class="dk-seg">
        <button disabled={tac} aria-pressed={!tac} title={tac ? "战术图为日/时粒度" : "步进 1 年"}>年</button>
        <button disabled={!tac} aria-pressed={tac && !subDaySig.value} title={tac ? "时间步进：按日" : "战术图可用"}
          onClick={() => { if (subDaySig.peek()) toggleSubDay(); }}>日</button>
        <button disabled={!tac} aria-pressed={sub} title={tac ? "时间步进：半时辰（1/24 日）——小时级战役分帧" : "战术图可用"}
          onClick={() => { if (!subDaySig.peek()) toggleSubDay(); }}>时</button>
      </div>
    </>
  );
}
