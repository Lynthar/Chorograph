/* 作战线悬浮编辑框（UI 1:1 还原 v0.14 #opBox）：选中一条作战线后浮现于地图右上，
   派系/部队/标注/粗细即时生效（一次选中=一步撤销，经 state.opEdit）；防线可翻转正面；删除。
   标题栏可拖动改位置；渲染进 #canvasWrap 的 #opMount。
   部队/标注用非受控输入 + key=选中标识：切换选中即重置，实时输入不被重渲打断（IME 友好）。 */
import { useRef, useState } from "preact/hooks";
import { calOf, eraPh, eraTy, fmtWhenForm, parseWhenForm } from "../core/calendar.ts";
import { clearOpSel, isTacSig, mutateWorld, opEdit, opSelSig, worldSig } from "./state.ts";
import { removeOp } from "./editops.ts";

export function OpBox() {
  const sel = opSelSig.value;
  const world = worldSig.value;
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  if (!sel || !world) return null;
  const ev = world.nodes.find(n => n.id === sel.evId);
  const op = ev && ev.ops && ev.ops[sel.i];
  if (!ev || !op) return null;
  const tac = isTacSig.value;
  const cal = calOf((world.meta || {}).calendar);
  /* 存在·起/止（分相位）：日期/「前N」经历法解析；空/非法=删键（对齐各表单空删语义） */
  const setSpan = (key: "since" | "until") => (e: Event) => {
    const v = parseWhenForm(cal, tac, (e.currentTarget as HTMLInputElement).value);
    opEdit(o => { if (v == null) delete o[key]; else o[key] = v; });
  };

  const onHeadDown = (e: PointerEvent) => {
    const box = (e.currentTarget as HTMLElement).parentElement!;
    const wrap = document.getElementById("canvasWrap")!;
    const r = box.getBoundingClientRect(), w0 = wrap.getBoundingClientRect();
    drag.current = { dx: e.clientX - (r.left - w0.left), dy: e.clientY - (r.top - w0.top) };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHeadMove = (e: PointerEvent) => {
    if (!drag.current) return;
    const wrap = document.getElementById("canvasWrap");
    const W = wrap ? wrap.clientWidth : 99999, H = wrap ? wrap.clientHeight : 99999;
    // 钳制左上角在画布内（留余量让标题栏始终可抓回）——否则可拖出 overflow:hidden 的 wrap 不可见
    setPos({ x: Math.max(0, Math.min(W - 60, e.clientX - drag.current.dx)), y: Math.max(0, Math.min(H - 28, e.clientY - drag.current.dy)) });
  };
  const onHeadUp = (e: PointerEvent) => {
    drag.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* cancel 时可能已释放 */ }
  };
  const del = () => { mutateWorld(w => { removeOp(w, sel.evId, sel.i); }); clearOpSel(); };
  const k = sel.evId + ":" + sel.i;

  return (
    <div id="opBox" style={{ display: "block", ...(pos ? { left: pos.x + "px", top: pos.y + "px", right: "auto" } : {}) }}>
      <div class="bb-head" id="obHead" onPointerDown={onHeadDown} onPointerMove={onHeadMove} onPointerUp={onHeadUp} onPointerCancel={onHeadUp}>
        <span id="obKind">{op.kind === "defense" ? "🛡 防线" : "⚔ 攻势线"}</span>
        <span class="sp"></span>
        <button type="button" id="obClose" title="关闭 (Esc)" onClick={() => clearOpSel()}>✕</button>
      </div>
      <div class="bb-row"><label>派系</label>
        <select class="fld" id="obSide" style={{ flex: "1" }} title="所属派系（决定线色）" value={op.side || ""}
          onChange={e => opEdit(o => { o.side = (e.currentTarget as HTMLSelectElement).value || null; })}>
          <option value="">（默认红）</option>
          {world.factions.map(f => <option key={f.id} value={f.id}>{f.名称 || f.id}</option>)}
        </select>
      </div>
      <div class="bb-row"><label>部队</label>
        <input class="fld" id="obTroop" style={{ flex: "1" }} key={k + ":troop"} defaultValue={op.troop || ""} placeholder="如 皇天卫"
          onInput={e => opEdit(o => { o.troop = (e.currentTarget as HTMLInputElement).value.trim(); })} />
      </div>
      <div class="bb-row"><label>标注</label>
        <input class="fld" id="obLabel" style={{ flex: "1" }} key={k + ":label"} defaultValue={op.label || ""} placeholder="如 南下"
          onInput={e => opEdit(o => { o.label = (e.currentTarget as HTMLInputElement).value.trim(); })} />
      </div>
      <div class="bb-row"><label>粗细</label>
        <input type="range" id="obW" min={1} max={8} step={1} value={op.w || 3}
          onInput={e => opEdit(o => { o.w = Math.max(1, Math.min(8, +(e.currentTarget as HTMLInputElement).value || 3)); })} />
        <span class="bb-v" id="obWV">{op.w || 3}</span>
      </div>
      <div class="bb-row"><label>线型</label>
        <label style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer", flex: "1", whiteSpace: "nowrap" }}>
          <input type="checkbox" id="obDash" checked={!!op.dash}
            onChange={e => opEdit(o => { if ((e.currentTarget as HTMLInputElement).checked) o.dash = true; else delete o.dash; })} />
          虚线（佯动/隐蔽/撤退）
        </label>
      </div>
      <div class="bb-row"><label>存在</label>
        <input class="fld" id="obSince" type={eraTy(cal, tac)} style={{ flex: "1", minWidth: "0" }} key={k + ":s"}
          placeholder={`起(${eraPh(cal, tac)})`} defaultValue={op.since != null ? fmtWhenForm(cal, tac, op.since) : ""}
          onChange={setSpan("since")} />
        <input class="fld" id="obUntil" type={eraTy(cal, tac)} style={{ flex: "1", minWidth: "0" }} key={k + ":u"}
          placeholder={`止(${eraPh(cal, tac)})`} defaultValue={op.until != null ? fmtWhenForm(cal, tac, op.until) : ""}
          onChange={setSpan("until")} />
      </div>
      <div class="bb-row sub" style={{ paddingTop: "0" }}>留空=只在事件{tac ? "当日" : "当年"}显示；填起/止=按时段显隐（战役分相位）。</div>
      <div class="bb-row">
        {op.kind === "defense" && <button type="button" class="tbtn" id="obFlip" title="防线齿=正面(对敌)，翻到另一侧" onClick={() => opEdit(o => { o.reverse = !o.reverse; })}>⇄ 翻转正面</button>}
        <button type="button" class="tbtn" id="obDel" style={{ color: "var(--q-zhu)" }} title="删除这条作战线 (Delete)" onClick={del}>🗑 删此线</button>
      </div>
      <div class="bb-row sub" id="obEvName" style={{ paddingTop: "0" }}>所属事件：{ev.名称 || ev.id}</div>
    </div>
  );
}
