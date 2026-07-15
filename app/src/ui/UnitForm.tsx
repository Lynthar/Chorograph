/* 部队编辑表单（UI 1:1 还原 v0.14 renderUnitInfo 编辑区/uf_save）：名称/所属/兵种/兵力/速度/射程/说明
   一次提交；删除带确认。兵种决定符号、默认速度与寻路军种（陆/水/飞）；速度留空=兵种默认。
   字段带持久小标签（.frow>label，对齐设计；填值后仍有标识）。 */
import { useRef } from "preact/hooks";
import { UNIT_KINDS } from "../core/constants.ts";
import { unitFireKm, unitKind } from "../core/units.ts";
import { applyUnitForm, removeUnit } from "./editops.ts";
import { inspEditSig, modeSig, mutateWorld, selSig, showToast, worldSig } from "./state.ts";
import type { Unit } from "../core/types.ts";

export function UnitForm({ u }: { u: Unit }) {
  const box = useRef<HTMLDivElement>(null);
  const world = worldSig.value!;
  const kDef = (unitKind(u) || UNIT_KINDS.inf).v;
  const val = (id: string) => (box.current?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("#" + id))?.value ?? "";

  const save = () => {
    mutateWorld(w => {
      const target = (w.units || []).find(x => x.id === u.id);
      if (!target) return;
      applyUnitForm(target, {
        名称: val("uf_name"), faction: val("uf_fac"), kind: val("uf_kind"),
        strength: val("uf_str"), speed: val("uf_speed"),
        range: val("uf_range"), vision: val("uf_vision"), note: val("uf_note")
      });
    });
    inspEditSig.value = false;
    showToast("已保存修改", { undo: true });
  };
  const del = () => {
    if (!confirm(`删除部队「${u.名称 || "未命名"}」及其全部动向？`)) return;
    mutateWorld(w => { removeUnit(w, u.id); });
    selSig.value = null;
  };

  return (
    <div ref={box} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div class="frow"><label>名称</label>
        <input class="fld" id="uf_name" defaultValue={u.名称 || ""} placeholder="部队名称" /></div>
      <div class="frow"><label>所属派系</label>
        <select class="fld" id="uf_fac">
          <option value="" selected={!u.faction}>（无所属）</option>
          {world.factions.map(x => <option key={x.id} value={x.id} selected={u.faction === x.id}>{x.名称 || x.id}</option>)}
        </select></div>
      <div class="frow"><label>兵种（定符号 · 默认速度 · 寻路陆/水/飞）</label>
        <select class="fld" id="uf_kind" title="兵种：决定符号、默认速度与寻路方式（陆/水/飞）">
          {Object.entries(UNIT_KINDS).map(([k, d]) => <option key={k} value={k} selected={(u.kind || "inf") === k}>{d.glyph} {d.名}（{d.v}km/日）</option>)}
        </select></div>
      <div class="frow"><label>兵力</label>
        <input class="fld" id="uf_str" defaultValue={u.strength != null ? String(u.strength) : ""} placeholder="如 三万 / 8000骑" /></div>
      <div class="frow"><label>速度 km/日（留空＝兵种默认 {kDef}）</label>
        <input class="fld" id="uf_speed" type="number" min={1} defaultValue={u.speed ? String(u.speed) : ""} placeholder={`兵种默认 ${kDef}`} /></div>
      <div class="frow"><label>火力投射半径 km（留空＝不画）</label>
        <input class="fld" id="uf_range" type="number" min={0} step={0.1}
          defaultValue={unitFireKm(u) > 0 ? String(unitFireKm(u)) : ""}
          placeholder="弓弩/火炮投射 · 派系色深填充圆"
          title="弓弩/火炮等投射半径：图上画派系色深填充圆；「军」工具下选中部队可直接拖动圈右侧手柄调节（与视野同机制）" /></div>
      <div class="frow"><label>视野/侦察半径 km（留空＝不画）</label>
        <input class="fld" id="uf_vision" type="number" min={0} step={0.1}
          defaultValue={typeof u.vision === "number" && u.vision > 0 ? String(u.vision) : ""}
          placeholder="斥候瞭望/侦骑警戒 · 派系色浅填充圆"
          title="斥候瞭望/侦骑警戒半径：图上画派系色浅填充圆；「军」工具下选中部队可直接拖动圈左侧手柄调节" /></div>
      <div class="frow"><label>说明</label>
        <textarea class="fld" id="uf_note" rows={3} placeholder="编制 / 主将 / 状态" defaultValue={typeof u.note === "string" ? u.note : ""} /></div>
      <div class="in-actions">
        <button class="bt zhu tr" onClick={save}>保存修改</button>
        {modeSig.value !== "edit" && <button class="bt ghost tr" onClick={() => { inspEditSig.value = false; }}>返回卡片</button>}
        <button class="bt danger-ghost tr" onClick={del}>删除此部队</button>
      </div>
      <div class="hint">把时间轴拖到某日再<b>拖动部队</b>=记录该日位置（同日重拖=改写）；点航点日期=时间轴跳到该日；行军里程按当日地形/道路以该兵种寻路计算。「军」工具下选中部队，<b>拖动圈上小方块</b>可直接调火力（圈右）/视野（圈左）半径；航点行的状态（交战/对峙/溃退）自该航点起生效。</div>
    </div>
  );
}
