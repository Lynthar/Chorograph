/* 部队编辑表单（UI 1:1 还原 v0.14 renderUnitInfo 编辑区/uf_save）：名称/所属/兵种/移动方式/兵力/速度/
   士气/火力/视野/阵形/说明一次提交；删除带确认。兵种决定符号与默认速度、默认移动方式；速度留空=兵种默认。
   兵力＝数值字段，存档统一记人数，输入端给单位（人/千/万）免数零。
   **移动方式**（旧称军种，数据键仍是 u.arm）只对编制上真有陆运/水运/空运之分的兵种（后勤/运输/侦察/
   特殊/指挥）出这一行——骑兵肯定陆行、舰船肯定水行，给个选项只是噪音（判据 core 的 armOptional）。
   ⚠ **战略图**（2026-07-31 起可放基础部队）只出 名称/归属/兵种/移动方式/兵力/速度/说明：士气与火力/
   视野/阵形足印都是战场尺度的账目，年尺度上没有意义。未渲染的行**不传字段**（valOpt 返 undefined），
   applyUnitForm 才不会把手编档里的这些键当成「清空」删掉。
   字段带持久小标签（.frow>label，对齐设计；填值后仍有标识）。 */
import { useRef, useState } from "preact/hooks";
import { ARM_NAME, UNIT_KINDS, armOptional } from "../core/constants.ts";
import { DEPTH_RATIO, unitArm, unitFireKm, unitFootKm, unitKind } from "../core/units.ts";
import { applyUnitForm } from "./editops.ts";
import { deleteUnitAt, inspEditSig, isTacSig, modeSig, mutateWorld, noteFormWarn, showToast, worldSig } from "./state.ts";
import type { Arm, Unit } from "../core/types.ts";
import { tget } from "../core/util.ts";

export function UnitForm({ u }: { u: Unit }) {
  const box = useRef<HTMLDivElement>(null);
  const world = worldSig.value!;
  const tac = isTacSig.value;
  /* 兵种在表单里是**受控**的：换兵种要即时改变「有没有火力行/移动方式行」与速度占位的默认值，
     纯非受控的话切到步兵后火力行还杵在那儿、提交时又被清掉＝眼见与落库不一致。
     移动方式同为受控——它随兵种出现/消失，靠 querySelector 写 DOM 会在「刚出现的那一帧」扑空。 */
  const [kind, setKind] = useState(u.kind || "linf");
  const [arm, setArm] = useState<Arm>(unitArm(u));
  const kd = tget(UNIT_KINDS, kind) || UNIT_KINDS.linf;
  const kDef = kd.v;
  const armOn = armOptional(kind);
  const foot = unitFootKm(u);
  const val = (id: string) => (box.current?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("#" + id))?.value ?? "";
  /** 未渲染的行＝undefined＝applyUnitForm 不动那个键（区别于空串的「清空」语义） */
  const valOpt = (id: string) => (box.current?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("#" + id))?.value;
  /* 兵力回填：显示口径与 fmtStrength 同源——≥1 万用「万」，以下用「人」（所见即所填） */
  const sRaw = typeof u.strength === "number" && isFinite(u.strength) && u.strength > 0 ? u.strength : 0;
  const sMul = sRaw >= 10000 ? 10000 : 1;
  const sVal = sRaw ? String(+(sRaw / sMul).toFixed(4)) : "";

  /* 数值字段的静默变形回执：type=number 打不进合法值时 .value 恒为空串，空删语义会把原值抹掉而毫无声响。
     判据用 validity.badInput（浏览器才知道用户到底敲进去了什么），非正数另报——只报不改，同 parseWhenInput 之规。 */
  const warnNum = (id: string, 名: string, tail: string) => {
    const el = box.current?.querySelector<HTMLInputElement>("#" + id);
    if (!el) return;
    if (el.validity?.badInput) noteFormWarn(`${名}不是数值　${tail}`);
    else if (el.value.trim() && !(parseFloat(el.value) > 0)) noteFormWarn(`${名}须为正数　${tail}`);
  };

  const save = () => {
    warnNum("uf_str", "兵力", "该项已清空");
    warnNum("uf_speed", "速度", "已回落兵种默认");
    mutateWorld(w => {
      const target = (w.units || []).find(x => x.id === u.id);
      if (!target) return;
      applyUnitForm(target, {
        名称: val("uf_name"), faction: val("uf_fac"), kind, arm: armOn ? arm : "",
        strength: val("uf_str"), strengthUnit: val("uf_strunit"), speed: val("uf_speed"), morale: valOpt("uf_morale"),
        range: valOpt("uf_range"), vision: valOpt("uf_vision"), note: val("uf_note"),
        frontKm: valOpt("uf_front"), depthKm: valOpt("uf_depth")
      });
    });
    inspEditSig.value = false;
    showToast("已保存修改", { undo: true });
  };
  const del = () => deleteUnitAt(u.id);

  return (
    <div ref={box} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div class="frow"><label>名称</label>
        <input class="fld" id="uf_name" defaultValue={u.名称 || ""} placeholder="部队名称" /></div>
      <div class="frow"><label>所属派系</label>
        <select class="fld" id="uf_fac">
          <option value="" selected={!u.faction}>（无所属）</option>
          {world.factions.map(x => <option key={x.id} value={x.id} selected={u.faction === x.id}>{x.名称 || x.id}</option>)}
        </select></div>
      <div class="frow"><label>兵种（定符号 · 默认速度 · 默认移动方式）</label>
        <select class="fld" id="uf_kind" title="兵种：决定图上符号、默认速度、默认移动方式与有无火力投射"
          onChange={e => {
            const nk = (e.currentTarget as HTMLSelectElement).value;
            setKind(nk);
            const d = UNIT_KINDS[nk];
            if (d) setArm(d.arm);   // 移动方式跟到新兵种的默认（受控，不必摸 DOM）
          }}>
          {Object.entries(UNIT_KINDS).map(([k, d]) => <option key={k} value={k} selected={kind === k}>{d.glyph} {d.名}（{d.v}km/日）</option>)}
        </select></div>
      {armOn && (
        <div class="frow"><label>移动方式（换兵种即回默认，可另择）</label>
          <select class="fld" id="uf_arm" value={arm} title="移动方式决定寻路：陆行翻山绕水、水行只走水域、飞行走直线"
            onChange={e => setArm((e.currentTarget as HTMLSelectElement).value as Arm)}>
            {(Object.keys(ARM_NAME) as Arm[]).map(a => <option key={a} value={a}>{ARM_NAME[a]}</option>)}
          </select></div>
      )}
      <div class="frow"><label>兵力（数值 · 存档统一记人数）</label>
        <div class="fx2">
          <input class="fld" id="uf_str" type="number" min={0} step="any" defaultValue={sVal} placeholder="如 45"
            title="只收数值：图上标签与列表按人数自动折算显示（≥1 万记作「45万」）" />
          <select class="fld" id="uf_strunit" title="输入单位：仅为免数零，存档一律折成人数">
            <option value="1" selected={sMul === 1}>人</option>
            <option value="1000">千</option>
            <option value="10000" selected={sMul === 10000}>万</option>
          </select>
        </div></div>
      <div class="frow"><label>速度 km/日（留空＝兵种默认 {kDef}）</label>
        <input class="fld" id="uf_speed" type="number" min={1} step="any" defaultValue={u.speed ? String(u.speed) : ""} placeholder={`兵种默认 ${kDef}`}
          title={tac ? "行军可达性按它逐段校验（超速段在图上标红）" : "战略图只记不算：年尺度的行军账目不做逐段校验"} /></div>
      {tac && <>
        <div class="frow"><label>士气 0–100（留空＝不记）</label>
          <input class="fld" id="uf_morale" type="number" min={0} max={100} step={1}
            defaultValue={typeof u.morale === "number" && u.morale >= 0 ? String(u.morale) : ""}
            placeholder="如 70"
            title="士气基线：逐航点可在「动向」里改写（自该航点起生效）。工具只记账，不参与任何胜负推演" /></div>
        {kd.noFire
          ? <div class="frow"><label>火力投射半径</label>
              <div class="sub">「{kd.名}」无远程投射能力，不设火力圈——视野/侦察圈照常可用</div></div>
          : <div class="frow"><label>火力投射半径 km（留空＝不画）</label>
              <input class="fld" id="uf_range" type="number" min={0} step={0.1}
                defaultValue={unitFireKm(u) > 0 ? String(unitFireKm(u)) : ""}
                placeholder="弓弩/火炮投射 · 派系色深填充圆"
                title="弓弩/火炮等投射半径：图上画派系色深填充圆；「军」工具下选中部队可直接拖动圈右侧手柄调节（与视野同机制）" /></div>}
        <div class="frow"><label>视野/侦察半径 km（留空＝不画）</label>
          <input class="fld" id="uf_vision" type="number" min={0} step={0.1}
            defaultValue={typeof u.vision === "number" && u.vision > 0 ? String(u.vision) : ""}
            placeholder="斥候瞭望/侦骑警戒 · 派系色浅填充圆"
            title="斥候瞭望/侦骑警戒半径：图上画派系色浅填充圆；「军」工具下选中部队可直接拖动圈左侧手柄调节" /></div>
        <div class="frow"><label>阵形正面 · 纵深 km（留空＝标准兵棋框；纵深留空＝正面÷{DEPTH_RATIO}）</label>
          <div class="fx2">
            <input class="fld" id="uf_front" type="number" min={0} step={0.1}
              defaultValue={typeof u.frontKm === "number" && u.frontKm > 0 ? String(u.frontKm) : ""}
              placeholder="正面 如 2"
              title="阵形正面宽 km：放大到正面够宽时，兵棋框改画按比例的阵位条（朝向取航点 facing，缺省=行进方向）" />
            <input class="fld" id="uf_depth" type="number" min={0} step={0.1}
              defaultValue={typeof u.depthKm === "number" && u.depthKm > 0 ? String(u.depthKm) : ""}
              placeholder={foot ? `纵深 缺省 ${+foot.depth.toFixed(2)}` : "纵深"}
              title="阵形纵深 km：留空按正面派生（战列常见观感）" />
          </div></div>
      </>}
      <div class="frow"><label>说明</label>
        <textarea class="fld" id="uf_note" rows={3} placeholder="编制 / 主将 / 状态" defaultValue={typeof u.note === "string" ? u.note : ""} /></div>
      <div class="in-actions">
        <button class="bt zhu tr" onClick={save}>保存修改</button>
        {modeSig.value !== "edit" && <button class="bt ghost tr" onClick={() => { inspEditSig.value = false; }}>返回卡片</button>}
        <button class="bt danger-ghost tr" onClick={del}>删除此部队</button>
      </div>
      <div class="hint">{tac
        ? <>把时间轴拖到某日再<b>拖动部队</b>=记录该日位置（同日重拖=改写）；点航点日期=时间轴跳到该日；行军里程按当日地形/道路以该兵种寻路计算。「军」工具下选中部队，<b>拖动圈上小方块</b>可直接调火力（圈右）/视野（圈左）半径；航点行的状态（交战/对峙/溃退）自该航点起生效。</>
        : <>把时间轴拨到某年再<b>拖动部队</b>=记录该年位置（同年重拖=改写），多个年份即构成军团的逐年推进；点航点年份=时间轴跳到该年。战场尺度的账目（士气/火力/视野/阵形）只在战术图上出现。</>}</div>
    </div>
  );
}
