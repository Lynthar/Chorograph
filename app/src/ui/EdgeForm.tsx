/* 连线编辑表单（UI 1:1 还原 v0.14 edgeEditForm/ee_save）：名称/存在时段/属性/说明一次提交；
   删除带确认。类型在创建时定死（与旧版一致，改类型=删了重连）。字段带持久小标签（.frow>label）。 */
import { useRef } from "preact/hooks";
import { EDGE_STYLE, RIVER_TMPL } from "../core/constants.ts";
import { calOf, eraPh, eraTy, fmtWhenForm, parseWhenForm } from "../core/calendar.ts";
import { deleteEdgeIdx, inspEditSig, isTacSig, modeSig, mutateWorld, showToast, worldSig } from "./state.ts";
import { applyEdgeForm } from "./editops.ts";
import type { Edge } from "../core/types.ts";

export function EdgeForm({ e, idx }: { e: Edge; idx: number }) {
  const box = useRef<HTMLDivElement>(null);
  const tac = isTacSig.value;
  const cal = calOf((worldSig.value?.meta || {}).calendar);
  const st = EDGE_STYLE[e.type] || { 名: e.type };
  const kvText = (e.字段 && Object.keys(e.字段).length)
    ? Object.entries(e.字段).map(([k, v]) => `${k}：${v}`).join("\n")
    : (e.type === "river" ? RIVER_TMPL : "");
  const val = (id: string) => (box.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>("#" + id))?.value ?? "";
  /* 时间输入经历法解析折成数字串（applyEdgeForm parseFloat 空删语义；custom 战略=原样） */
  const timeVal = (id: string) => { const v = parseWhenForm(cal, tac, val(id)); return v == null ? "" : String(v); };

  const save = () => {
    mutateWorld(w => {
      const target = w.edges[idx];
      if (!target) return;
      applyEdgeForm(target, { 名称: val("ee_name"), note: val("ee_note"), kv: val("ee_kv"), since: timeVal("ee_since"), until: timeVal("ee_until"),
        widthM: e.type === "river" ? val("ee_width") : undefined });
    });
    inspEditSig.value = false;
    showToast("已保存修改", { undo: true });
  };
  const del = () => deleteEdgeIdx(idx);

  return (
    <div ref={box} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div class="frow"><label>名称</label>
        <input class="fld" id="ee_name" defaultValue={e.名称 || ""} placeholder="如 梓泽江" /></div>
      <div class="frow"><label>存在 · 起 / 止（留空＝远古 / 至今）</label>
        <div class="fx2">
          <input class="fld" id="ee_since" type={eraTy(cal, tac)} placeholder={`起(${eraPh(cal, tac)})`} defaultValue={e.since != null ? fmtWhenForm(cal, tac, e.since) : ""} />
          <input class="fld" id="ee_until" type={eraTy(cal, tac)} placeholder={`止(${eraPh(cal, tac)})`} defaultValue={e.until != null ? fmtWhenForm(cal, tac, e.until) : ""} />
        </div></div>
      {e.type === "river" && <div class="frow"><label>水面宽 米（留空＝示意细线；放大后按真实尺度显宽）</label>
        <input class="fld" id="ee_width" type="number" min={0} step={10}
          placeholder="如 200" defaultValue={e.widthM != null ? String(e.widthM) : ""} /></div>}
      <div class="frow"><label>属性（每行「键：值」，值留空的行不保存）</label>
        <textarea class="fld" id="ee_kv" rows={7} placeholder={e.type === "river" ? "河流建议：宽度/深度/流量/水质/丰水期/枯水期" : "键：值"} defaultValue={kvText} /></div>
      <div class="frow"><label>说明</label>
        <textarea class="fld" id="ee_note" rows={2} placeholder="说明" defaultValue={typeof e.note === "string" ? e.note : ""} /></div>
      <div class="in-actions">
        <button class="bt zhu tr" onClick={save}>保存修改</button>
        {modeSig.value !== "edit" && <button class="bt ghost tr" onClick={() => { inspEditSig.value = false; }}>返回卡片</button>}
        <button class="bt danger-ghost tr" onClick={del}>删除此连线</button>
      </div>
    </div>
  );
}
