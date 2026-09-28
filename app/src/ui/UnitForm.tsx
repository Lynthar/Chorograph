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
import { ALL_KINDS, ARC_DEG, ARM_NAME, MODERN_KINDS, RADAR_M, RADAR_TGT_M, UNIT_KINDS, armOptional } from "../core/constants.ts";
import { DEPTH_RATIO, isModern, unitArm, unitEyeM, unitFireDirect, unitFireKm, unitFootKm, unitKind } from "../core/units.ts";
import { applyUnitForm } from "./editops.ts";
import { deleteUnitAt, inspEditSig, isTacSig, modeSig, mutateWorld, showToast, warnNumInput, worldSig } from "./state.ts";
import type { Arm, Unit } from "../core/types.ts";
import { tget } from "../core/util.ts";

export function UnitForm({ u }: { u: Unit }) {
  const box = useRef<HTMLDivElement>(null);
  const world = worldSig.value!;
  const tac = isTacSig.value;
  /* 兵种在表单里是**受控**的：换兵种要即时改变「有没有火力行/移动方式行」与速度占位的默认值，
     纯非受控的话切到步兵后火力行还杵在那儿、提交时又被清掉＝眼见与落库不一致。
     移动方式同为受控——它随兵种出现/消失，靠 querySelector 写 DOM 会在「刚出现的那一帧」扑空。 */
  const modern = isModern(world.meta);
  const [kind, setKind] = useState(u.kind || (modern ? "mcomb" : "linf"));
  const [arm, setArm] = useState<Arm>(unitArm(u));
  /* 直射/曲射同为受控：射角那一格只在曲射时出现，靠 DOM 查不到「刚出现的那一帧」（同 arm 之规） */
  const [fireMode, setFireMode] = useState<"arc" | "direct">(unitFireDirect(u) ? "direct" : "arc");
  const fw = modern ? "防区" : "阵形";   // 现代图的正面·纵深叫防区（防御地段，不是战列），数据键不变
  /* 兵种下拉按时代给清单（古代表被平价基线锁着，现代另立一张）；查表仍走合表。
     当前兵种不在本代清单里时**必须另立一项**——否则「打开表单什么都不改就保存」会把它静默换成清单第一项。 */
  const kindList = modern ? MODERN_KINDS : UNIT_KINDS;
  const kd = tget(ALL_KINDS, kind) || UNIT_KINDS.linf;
  const offEra = tget(kindList, kind) ? null : tget(ALL_KINDS, kind);
  const kDef = kd.v;
  const armOn = armOptional(kind);
  /* 飞行部队：眼位与天线＝飞行高度（观察高度、天线高度两格不出），火力恒直射（射击方式不出） */
  const air = (armOn ? arm : kd.arm) === "air";
  const foot = unitFootKm(u);
  const val = (id: string) => (box.current?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("#" + id))?.value ?? "";
  /** 未渲染的行＝undefined＝applyUnitForm 不动那个键（区别于空串的「清空」语义） */
  const valOpt = (id: string) => (box.current?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("#" + id))?.value;
  /* 兵力回填：显示口径与 fmtStrength 同源——≥1 万用「万」，以下用「人」（所见即所填） */
  const sRaw = typeof u.strength === "number" && isFinite(u.strength) && u.strength > 0 ? u.strength : 0;
  const sMul = sRaw >= 10000 ? 10000 : 1;
  const sVal = sRaw ? String(+(sRaw / sMul).toFixed(4)) : "";

  /* 数值字段的静默变形回执：空删语义会把打错的原值抹掉而毫无声响——只报不改，同 parseWhenInput 之规 */
  const warnNum = (id: string, 名: string, tail: string, allowZero = false) =>
    warnNumInput(box.current?.querySelector<HTMLInputElement>("#" + id), 名, tail, allowZero);

  const save = () => {
    /* 每个数值字段都要有回执——原先只覆盖兵力与速度，其余打错即静默删键而 toast 照说「已保存修改」，
       正是本项目自订「数值字段静默变形要报回执」针对的失败模式。⚠ 士气 0＝崩溃是有意义的值，故放行 0。 */
    warnNum("uf_str", "兵力", "该项已清空");
    warnNum("uf_speed", "速度", "已回落兵种默认");
    warnNum("uf_morale", "士气", "该项已清空", true);
    warnNum("uf_range", "火力半径", "该项已清空");
    warnNum("uf_arc", "射角", `已回落 ${ARC_DEG}°`);
    warnNum("uf_vision", "视野半径", "该项已清空");
    warnNum("uf_eye", "观察高度", "已回落兵种缺省", true);
    warnNum("uf_radar", "雷达探测半径", "该项已清空");
    warnNum("uf_radarm", "天线高度", `已回落 ${RADAR_M} m`, true);
    warnNum("uf_radartgt", "雷达目标高度", `已回落 ${RADAR_TGT_M} m`, true);
    warnNum("uf_alt", "飞行高度", "该项已清空", true);
    warnNum("uf_front", `${fw}正面`, "该项已清空");
    warnNum("uf_depth", `${fw}纵深`, "该项已清空");
    mutateWorld(w => {
      const target = (w.units || []).find(x => x.id === u.id);
      if (!target) return;
      applyUnitForm(target, {
        名称: val("uf_name"), faction: val("uf_fac"), kind, arm: armOn ? arm : "",
        strength: val("uf_str"), strengthUnit: val("uf_strunit"), speed: val("uf_speed"), morale: valOpt("uf_morale"),
        range: valOpt("uf_range"), fire: valOpt("uf_fire"), arcDeg: valOpt("uf_arc"), vision: valOpt("uf_vision"), eyeM: valOpt("uf_eye"),
        radar: valOpt("uf_radar"), radarM: valOpt("uf_radarm"), radarTgtM: valOpt("uf_radartgt"), altM: valOpt("uf_alt"), note: val("uf_note"),
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
            const d = tget(ALL_KINDS, nk);
            if (d) setArm(d.arm);   // 移动方式跟到新兵种的默认（受控，不必摸 DOM）
          }}>
          {offEra && <option value={kind} selected>{offEra.glyph} {offEra.名}（他代 · {offEra.v}km/日）</option>}
          {Object.entries(kindList).map(([k, d]) => <option key={k} value={k} selected={kind === k}>{d.glyph} {d.名}（{d.v}km/日）</option>)}
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
          : <div class="frow"><label>火力投射半径 km（留空＝不画）· {air ? "飞行部队恒直射" : <>直射 / 曲射{fireMode === "arc" ? " · 射角°" : ""}</>}</label>
              <div class="fx2">
                <input class="fld" id="uf_range" type="number" min={0} step={0.1}
                  defaultValue={unitFireKm(u) > 0 ? String(unitFireKm(u)) : ""}
                  placeholder="弓弩/火炮投射 · 按视线或弹道裁"
                  title="弓弩/火炮等投射半径：图上只填打得到的格，圈线是名义半径；「军」工具下选中部队可直接拖动圈右侧手柄调节（与视野同机制）" />
                {!air && <select class="fld" id="uf_fire" value={fireMode} onChange={e => setFireMode((e.currentTarget as HTMLSelectElement).value === "direct" ? "direct" : "arc")}
                  title="直射＝按视线裁（眼位＝所在处高程＋观察高度）；曲射＝按固定射角的弹道裁，弹道最高点＝射程×tan(射角)/4，挡在弹道之上的山打不过去">
                  <option value="arc" selected={fireMode === "arc"}>曲射（弹道）</option>
                  <option value="direct" selected={fireMode === "direct"}>直射（视线）</option>
                </select>}
                {!air && fireMode === "arc" && <input class="fld" id="uf_arc" type="number" min={5} max={85} step={1}
                  defaultValue={typeof u.arcDeg === "number" && u.arcDeg > 0 && u.arcDeg < 90 ? String(u.arcDeg) : ""}
                  placeholder={`射角 缺省 ${ARC_DEG}°`}
                  title={`曲射射角（度）：${ARC_DEG}° 是最大射程射角；迫击炮 45～85、榴弹炮高角 45、投石机约 45。留空＝${ARC_DEG}°`} />}
              </div></div>}
        {air && <div class="frow"><label>飞行高度 m（海拔；留空＝三种圈都不判视线）</label>
          <input class="fld" id="uf_alt" type="number" min={0} step="any"
            defaultValue={typeof u.altM === "number" && u.altM >= 0 ? String(u.altM) : ""} placeholder="如 8000"
            title="海拔高度：低于地面按地面算。这是基线——动向里逐航点可改，航点之间按两端的高度线性过渡（爬升 / 下滑）" /></div>}
        <div class="frow"><label>视野/侦察半径 km（留空＝不画）{air ? " · 眼位＝飞行高度" : " · 观察高度 m"}</label>
          <div class="fx2">
            <input class="fld" id="uf_vision" type="number" min={0} step={0.1}
              defaultValue={typeof u.vision === "number" && u.vision > 0 ? String(u.vision) : ""}
              placeholder="斥候瞭望/侦骑警戒 · 按视线裁"
              title="斥候瞭望/侦骑警戒半径：圈内只填视线可达的格（地形遮挡与地平线都计入），圈线是名义半径；「军」工具下选中部队可直接拖动圈左侧手柄调节。飞行部队不判视线" />
            {!air && <input class="fld" id="uf_eye" type="number" min={0} step="any"
              defaultValue={typeof u.eyeM === "number" && u.eyeM >= 0 ? String(u.eyeM) : ""}
              placeholder={`观察高度 缺省 ${unitEyeM({ ...u, eyeM: undefined })} m`}
              title="眼位离地面的高度（米）：瞭望塔/桅顶/高地上的哨位填高些；留空＝兵种缺省（陆行 2 m、舰船 15 m）。视野圈与直射火力圈共用" />}
          </div></div>
        {modern && <div class="frow"><label>雷达 探测半径 km（留空＝无）{air ? "" : " · 天线高度 m"} · 目标高度 m</label>
          <div class="fx2">
            <input class="fld" id="uf_radar" type="number" min={0} step={1}
              defaultValue={typeof u.radar === "number" && u.radar > 0 ? String(u.radar) : ""}
              placeholder="探测半径 如 40"
              title="雷达探测半径：图上只填雷达视线可达的格（折射按 4/3 地球半径），圈线点划。飞行部队的天线在飞行高度上" />
            {!air && <input class="fld" id="uf_radarm" type="number" min={0} step="any"
              defaultValue={typeof u.radarM === "number" && u.radarM >= 0 ? String(u.radarM) : ""}
              placeholder={`天线 缺省 ${RADAR_M} m`}
              title={`天线离地面的高度（米）；留空＝${RADAR_M} m`} />}
            <input class="fld" id="uf_radartgt" type="number" min={0} step="any"
              defaultValue={typeof u.radarTgtM === "number" && u.radarTgtM >= 0 ? String(u.radarTgtM) : ""}
              placeholder={`目标 缺省 ${RADAR_TGT_M} m`}
              title={`假定目标离地面的高度（米）：低空 ${RADAR_TGT_M}、中空数千；目标越高，地平线越远。留空＝${RADAR_TGT_M} m`} />
          </div></div>}
        <div class="frow"><label>{fw}正面 · 纵深 km（留空＝标准兵棋框；纵深留空＝正面÷{DEPTH_RATIO}）</label>
          <div class="fx2">
            <input class="fld" id="uf_front" type="number" min={0} step={0.1}
              defaultValue={typeof u.frontKm === "number" && u.frontKm > 0 ? String(u.frontKm) : ""}
              placeholder="正面 如 2"
              title={`${fw}正面宽 km：放大到正面够宽时，兵棋框改画按比例的${modern ? "防区框" : "阵位条"}（朝向取航点 facing，缺省=行进方向）；视线眼位可在其长边一半内挑最高处`} />
            <input class="fld" id="uf_depth" type="number" min={0} step={0.1}
              defaultValue={typeof u.depthKm === "number" && u.depthKm > 0 ? String(u.depthKm) : ""}
              placeholder={foot ? `纵深 缺省 ${+foot.depth.toFixed(2)}` : "纵深"}
              title={`${fw}纵深 km：留空按正面派生${modern ? "" : "（战列常见观感）"}`} />
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
