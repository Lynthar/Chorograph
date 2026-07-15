/* 派系编辑表单（UI 1:1 还原 v0.14 factionEditForm/ff_save）：名称/颜色/阵营/存续/说明/双链，
   一次「保存修改」提交；删除连带（归属中立化/沿革剔除/作战线 side 清空）。字段带持久小标签（.frow>label）。 */
import { useRef } from "preact/hooks";
import { applyFactionForm, removeFaction } from "./editops.ts";
import { calOf, eraPh, eraTy, fmtWhenForm, parseWhenForm } from "../core/calendar.ts";
import { inspEditSig, isTacSig, modeSig, mutateWorld, paintFactionSig, paintLayerSig, selSig, showToast, worldSig } from "./state.ts";
import type { Faction } from "../core/types.ts";

export function FactionForm({ f }: { f: Faction }) {
  const box = useRef<HTMLDivElement>(null);
  const tac = isTacSig.value;
  const cal = calOf((worldSig.value?.meta || {}).calendar);
  const val = (id: string) => (box.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>("#" + id))?.value ?? "";
  /* 时间输入经历法解析折成数字串（applyFactionForm parseFloat 空删语义；custom 战略=原样） */
  const timeVal = (id: string) => { const v = parseWhenForm(cal, tac, val(id)); return v == null ? "" : String(v); };
  const save = () => {
    mutateWorld(w => {
      const target = w.factions.find(x => x.id === f.id);
      if (!target) return;
      applyFactionForm(target, { 名称: val("ff_name"), color: val("ff_color"), 阵营: val("ff_camp"),
        since: timeVal("ff_since"), until: timeVal("ff_until"), note: val("ff_note"), link: val("ff_link") });
    });
    inspEditSig.value = false;
    showToast("已保存修改", { undo: true });
  };
  const del = () => {
    if (!confirm(`删除派系「${f.名称 || f.id}」？其地点归属将变为中立，涂域随之删除。`)) return;
    mutateWorld(w => removeFaction(w, f.id));
    if (paintFactionSig.peek() === f.id) { paintFactionSig.value = null; paintLayerSig.value = 0; }
    selSig.value = null;
  };
  return (
    <div ref={box} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div class="frow"><label>名称</label>
        <input class="fld" id="ff_name" defaultValue={f.名称 || ""} placeholder="派系名称" /></div>
      <div class="frow"><label>颜色 · 阵营</label>
        <div class="fx2" style={{ alignItems: "center" }}>
          <input type="color" id="ff_color" defaultValue={f.color || "#888888"}
            style={{ width: "52px", height: "26px", flex: "none", padding: "0", border: "1px solid var(--q-ln)", borderRadius: "4px", background: "var(--q-pn)" }} />
          <input class="fld" id="ff_camp" defaultValue={f.阵营 || ""} placeholder="如 守序中立" />
        </div></div>
      <div class="frow"><label>存续 · 起 / 止（留空＝远古 / 至今）</label>
        <div class="fx2">
          <input class="fld" id="ff_since" type={eraTy(cal, tac)} placeholder={`起(${eraPh(cal, tac)})`} defaultValue={f.since != null && f.since !== 0 ? fmtWhenForm(cal, tac, f.since) : ""} />
          <input class="fld" id="ff_until" type={eraTy(cal, tac)} placeholder={`止(${eraPh(cal, tac)})`} defaultValue={f.until != null && (tac || f.until < 9999) ? fmtWhenForm(cal, tac, f.until) : ""} />
        </div></div>
      <div class="frow"><label>说明</label>
        <textarea class="fld" id="ff_note" rows={3} placeholder="说明" defaultValue={typeof f.note === "string" ? f.note : ""} /></div>
      <div class="frow"><label>Obsidian 双链（不含 [[]]）</label>
        <input class="fld" id="ff_link" defaultValue={f.link || ""} placeholder="目标笔记名" /></div>
      <div class="in-actions">
        <button class="bt zhu tr" onClick={save}>保存修改</button>
        {modeSig.value !== "edit" && <button class="bt ghost tr" onClick={() => { inspEditSig.value = false; }}>返回卡片</button>}
        <button class="bt danger-ghost tr" onClick={del}>删除此派系</button>
      </div>
    </div>
  );
}
