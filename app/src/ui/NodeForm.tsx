/* 地点/事件点编辑表单（UI 1:1 还原 v0.14 nodeEditForm/bindNodeInfo）：
   · 类型/事件子类改选立即生效（各记一步撤销），表单随之切换；
   · 其余字段「保存修改」一次提交（一步撤销）；空值删键；
   · 字段框未填过时按类型模板预填，值留空的行不保存；
   · 战术图：年份/存在时段用「年-月-日」文本（parseYMD/fmtYMD），另有视域栏（火力逐圈 / 视野 / 现代图雷达）。
   输入用非受控 + key=节点id：换选中即重置，重渲不丢输入。 */
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { ARC_DEG, EVENT_TMPL, EVENT_TYPES, NODE_CATS, NODE_CAT_ORDER, NODE_STYLE, NODE_TMPL, NODE_TYPES, RADAR_M, RADAR_TGT_M, nodeCatOf } from "../core/constants.ts";
import { calOf, eraPh, eraTy, fmtWhenForm, fmtWhenRange } from "../core/calendar.ts";
import { isModern, nodeEyeM } from "../core/units.ts";
import { deleteNodeAt, inspEditSig, isTacSig, modeSig, mutateWorld, noteFormWarn, opDrawSig, parseWhenInput, selectOp, selSig, setMode, showToast, startOpDraw, tacReqSig, warnNumInput, worldSig, yearSig } from "./state.ts";
import { addEventNear, addOwner, applyNodeForm, changeNodeType, draftOfRange, moveNode, removeOwner, updateOwner, type NodeRangeDraft } from "./editops.ts";
import { CertaintyChips, readCertainty } from "./CertaintyChips.tsx";
import type { WorldNode } from "../core/types.ts";
import { tget } from "../core/util.ts";

/** 战役事件点的作战线列表 + 画线按钮（对齐旧 nodeEditForm 作战线段）。
    每条线的编辑（派系/部队/标注/粗细/翻转/删除）在地图上的悬浮框 OpBox。 */
function OpList({ n }: { n: WorldNode }) {
  const world = worldSig.value!;
  const tac = isTacSig.value;
  const cal = calOf((world.meta || {}).calendar);
  const draw = opDrawSig.value;
  return (
    <>
      <div class="sub" style={{ marginTop: "4px" }}>作战线（画完自动选中；编辑在地图上的<b>悬浮框</b>——点地图上的线或下面列表可再选）</div>
      {(n.ops || []).map((op, i) => {
        const of = op.side ? world.factions.find(f => f.id === op.side) : null;
        const span = (op.since != null || op.until != null) ? ` · ${fmtWhenRange(cal, tac, op.since, op.until)}` : "";
        return (
          <div key={i} class="kv">
            <button type="button" class="link" onClick={() => selectOp(n.id, i)}>{op.kind === "defense" ? "🛡" : "⚔"} {op.troop || op.label || `作战线 ${i + 1}`}</button>
            {" "}<span class="sub">粗{op.w || 3}{of ? " · " + (of.名称 || of.id) : ""}{span}{op.dash ? " · 虚线" : ""}</span>
          </div>
        );
      })}
      <div class="seg">
        {/* 浏览态「随时编辑」里也可点：先入编辑模式（指针链只在 edit 消费画线态，工具轨随之自明），再武装 */}
        <button type="button" class="tbtn" onClick={() => { if (modeSig.peek() !== "edit") setMode("edit"); startOpDraw(n.id, "attack"); }}>⚔ 画攻势线</button>
        <button type="button" class="tbtn" onClick={() => { if (modeSig.peek() !== "edit") setMode("edit"); startOpDraw(n.id, "defense"); }}>🛡 画防线</button>
      </div>
      {draw && draw.evId === n.id && (
        <div class="hint">画线中（{draw.kind === "defense" ? <>🛡防线：正面=画线方向<b>左侧</b>，画完可翻转</> : <>⚔攻势线：末端=箭头</>}）——在地图上<b>按住拖一笔</b>，松手成线；Esc/右键取消。</div>
      )}
    </>
  );
}

/** 归属沿革编辑器（净新——v0.14 仅提示改 JSON）：分时段归属的增删改，段序保持用户编排。 */
function OwnersEditor({ n }: { n: WorldNode }) {
  const world = worldSig.value!;
  const tac = isTacSig.value;
  const cal = calOf((world.meta || {}).calendar);
  const owners = n.owners || [];
  const mut = (fn: (x: WorldNode) => void) => mutateWorld(w => { const x = w.nodes.find(y => y.id === n.id); if (x) fn(x); });
  /* 输入→updateOwner 数字串（parseFloat 空删语义）：日期/「前N」经历法解析折成数字 */
  const tv = (raw: string) => { const v = parseWhenInput(cal, tac, raw); return v == null ? "" : String(v); };
  return (
    <>
      <div class="sub" style={{ marginTop: "4px" }}>归属沿革（分时段归属，覆盖上方固定归属；留空起/止=远古/至今）</div>
      {owners.map((o, i) => (
        <div key={n.id + ":o" + i}>
          <select class="fld" value={o.faction || ""} onChange={e => mut(x => updateOwner(x, i, { faction: (e.currentTarget as HTMLSelectElement).value }))}>
            <option value="">中立/自由</option>
            {world.factions.map(f => <option key={f.id} value={f.id}>{f.名称 || f.id}</option>)}
          </select>
          <div class="seg">
            <input class="fld" type={eraTy(cal, tac)} style={{ width: "40%" }} placeholder={`起(${eraPh(cal, tac)})`}
              defaultValue={o.since != null ? fmtWhenForm(cal, tac, o.since) : ""} key={n.id + ":os" + i + ":" + (o.since ?? "")}
              onChange={e => mut(x => updateOwner(x, i, { since: tv((e.currentTarget as HTMLInputElement).value) }))} />
            <input class="fld" type={eraTy(cal, tac)} style={{ width: "40%" }} placeholder={`止(${eraPh(cal, tac)})`}
              defaultValue={o.until != null ? fmtWhenForm(cal, tac, o.until) : ""} key={n.id + ":ou" + i + ":" + (o.until ?? "")}
              onChange={e => mut(x => updateOwner(x, i, { until: tv((e.currentTarget as HTMLInputElement).value) }))} />
            <button type="button" class="link" style={{ color: "var(--q-zhu)", alignSelf: "center" }} title="删除此段" onClick={() => mut(x => removeOwner(x, i))}>✕</button>
          </div>
        </div>
      ))}
      <div class="seg"><button type="button" class="tbtn" onClick={() => mut(x => addOwner(x, yearSig.peek()))}>＋ 加一段归属</button></div>
    </>
  );
}

/** 切类型时须防丢的文本控件 id（select 不参与：无 defaultValue 可比对；同版面的选择框靠 DOM 复用天然保值） */
const TEXT_FIELDS = ["ef_name", "ef_lon", "ef_lat", "ef_r", "ef_since", "ef_until", "ef_kv", "ef_note", "ef_link", "ef_year", "ef_sides", "ef_result",
  "ef_vision", "ef_eye", "ef_radar", "ef_radarm", "ef_radartgt"];

/** 火力圈的一行：k＝行键（增删行时其余行的非受控输入不串位）；射击方式受控——射角格随它出没 */
interface RangeRow { k: number; init: NodeRangeDraft; fire: "direct" | "arc" }
/** 雷达站只在现代图的下拉里出；当前就是它时照列（否则「什么都不改就保存」会被换成清单第一项） */
const offEraType = (t: string, modern: boolean, cur: string) => t === "radarsite" && !modern && cur !== t;

export function NodeForm({ n }: { n: WorldNode }) {
  const box = useRef<HTMLDivElement>(null);
  /* 切类型防丢字（2026-07-16 P2）：类型/事件子类「改选立即生效」即重渲表单——标注↔其他时
     名称控件在 textarea/input 间重挂、途经他类再切回时期间不在版面上的栏重挂，重挂的控件会
     被重置为存档值，已键入未保存的内容蒸发（实测 Preact 静态子槽 diff 不串位，丢的只是重挂控件）。
     对策：改选前把**脏字段**（值≠defaultValue＝用户改过）记入 dirtyRef，提交后把仍在/复现的
     控件值补回；未动过的字段不记录（属性 kv 的模板才能随新类型正常刷新），改回默认值的从记录剔除，
     不在版面上的栏保留既有记录（切回时恢复）。 */
  const dirtyRef = useRef<Record<string, string>>({});
  const restoreRef = useRef(false);
  const captureDirty = () => {
    const b = box.current;
    if (!b) return;
    for (const id of TEXT_FIELDS) {
      const el = b.querySelector<HTMLInputElement | HTMLTextAreaElement>("#" + id);
      if (!el) continue;
      if (el.value !== el.defaultValue) dirtyRef.current[id] = el.value;
      else delete dirtyRef.current[id];
    }
    restoreRef.current = true;
  };
  useLayoutEffect(() => {
    if (!restoreRef.current) return;
    restoreRef.current = false;
    const b = box.current;
    if (!b) return;
    for (const [id, v] of Object.entries(dirtyRef.current)) {
      const el = b.querySelector<HTMLInputElement | HTMLTextAreaElement>("#" + id);
      if (el && el.value !== v) el.value = v;
    }
  });
  const world = worldSig.value!;
  const tac = isTacSig.value;
  const modern = isModern(world.meta);
  const cal = calOf((world.meta || {}).calendar);
  const isEv = n.type === "event";
  const isLabel = n.type === "label";
  const sight = tac && !isEv && !isLabel;   // 视域栏：战术图的普通地点
  const nextK = useRef(0);
  const [rows, setRows] = useState<RangeRow[]>(() =>
    (n.ranges || []).map(r => { const init = draftOfRange(r); return { k: nextK.current++, init, fire: init.fire }; }));
  const cat = nodeCatOf(n.type);   // 类型两级选择的当前类别；null=事件/标注/未知型
  const evt = tget(EVENT_TYPES, String(n.evtype)) ? String(n.evtype) : "battle";
  const isBattle = isEv && evt === "battle";
  const fsCur = String(n.fs || 13);
  const kvText = (n.字段 && Object.keys(n.字段).length)
    ? Object.entries(n.字段).map(([k, v]) => `${k}：${v}`).join("\n")
    : (isEv ? (EVENT_TMPL[evt] || "") : (NODE_TMPL[n.type] || ""));
  const val = (id: string) => (box.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>("#" + id))?.value;
  const numEl = (id: string) => box.current?.querySelector<HTMLInputElement>("#" + id);
  /* 时间输入：战术图「年-月-日（可带时刻）」/ earth 战略「前N」经历法解析折成日戳/年份数字串
     （applyNodeForm 按 parseFloat 语义消费；空/非法=删键）；custom 战略=原样数字串（旧语义） */
  const timeVal = (id: string) => { const v = parseWhenInput(cal, tac, val(id) ?? ""); return v == null ? "" : String(v); };

  const save = () => {
    /* 经纬度数字输入（战役复原按文档坐标表精确落点）：留空/非法=不动，经 moveNode 归一钳制。
       一填一空/非法＝这次坐标没落上（其余字段照存）——回执点明，别再静默报「已保存」 */
    const lonRaw = (val("ef_lon") ?? "").trim(), latRaw = (val("ef_lat") ?? "").trim();
    const lon = parseFloat(lonRaw), lat = parseFloat(latRaw);
    const coordSkipped = (lonRaw !== "" || latRaw !== "") && !(isFinite(lon) && isFinite(lat));
    const ranges: NodeRangeDraft[] | undefined = sight
      ? rows.map(r => ({ 名称: val("ef_rgn" + r.k) ?? "", km: val("ef_rgk" + r.k) ?? "", fire: r.fire, arcDeg: val("ef_rga" + r.k) ?? "" }))
      : undefined;
    /* 数值回执（只报不改）：整行空白的圈静默丢弃，填了名称或半径却没有正数半径的圈要说出来 */
    if (ranges) ranges.forEach((d, i) => {
      const k = rows[i].k, bad = !!numEl("ef_rgk" + k)?.validity?.badInput;
      if ((d.名称.trim() || d.km.trim() || bad) && !(parseFloat(d.km) > 0)) noteFormWarn(`第 ${i + 1} 个火力圈的半径须为正数　该圈未保存`);
      warnNumInput(numEl("ef_rga" + k), `第 ${i + 1} 个火力圈的射角`, `已回落 ${ARC_DEG}°`);
    });
    warnNumInput(numEl("ef_vision"), "视野半径", "该项已清空");
    warnNumInput(numEl("ef_eye"), "观察高度", "已回落类型缺省", true);
    warnNumInput(numEl("ef_radar"), "雷达探测半径", "该项已清空");
    warnNumInput(numEl("ef_radarm"), "天线高度", `已回落 ${RADAR_M} m`, true);
    warnNumInput(numEl("ef_radartgt"), "雷达目标高度", `已回落 ${RADAR_TGT_M} m`, true);
    mutateWorld(w => {
      const target = w.nodes.find(x => x.id === n.id);
      if (!target) return;
      if (isFinite(lon) && isFinite(lat) && (lon !== target.lon || lat !== target.lat)) moveNode(w, n.id, lon, lat);
      applyNodeForm(target, {
        名称: val("ef_name") || "", note: val("ef_note") ?? "", link: val("ef_link") ?? "",
        faction: isEv ? undefined : (val("ef_fac") ?? ""),
        radiusKm: isEv ? undefined : val("ef_r"),
        since: isEv ? undefined : timeVal("ef_since"), until: isEv ? undefined : timeVal("ef_until"),
        kv: val("ef_kv") ?? "",
        ranges, vision: val("ef_vision"), eyeM: val("ef_eye"),
        radar: val("ef_radar"), radarM: val("ef_radarm"), radarTgtM: val("ef_radartgt"),
        certainty: isLabel ? undefined : readCertainty(box.current, "ef_cert"),
        year: isEv ? timeVal("ef_year") : undefined, sides: isBattle ? val("ef_sides") : undefined, result: isBattle ? val("ef_result") : undefined,
        fs: isLabel ? (val("ef_fs") ?? "") : undefined, pin: isLabel ? (val("ef_pin") ?? "") : undefined
      });
    });
    inspEditSig.value = false;
    showToast(coordSkipped ? "已保存——经纬度需成对填有效数字，坐标未改" : "已保存修改", { undo: true });
  };
  /* 改类型：先记脏字段（改选即重渲表单，重挂的控件会被重置＝未保存输入蒸发），提交后补回 */
  const setType = (t: string) => {
    captureDirty();
    mutateWorld(w => { const x = w.nodes.find(y => y.id === n.id); if (x) changeNodeType(x, t, yearSig.peek(), v => !!tget(EVENT_TYPES, String(v))); });
  };
  const del = () => deleteNodeAt(n.id);
  const addEv = () => {
    let id: string | null = null;
    mutateWorld(w => {
      const at = w.nodes.find(x => x.id === n.id);
      if (at) id = addEventNear(w, at, "新事件", yearSig.peek()).id;
    });
    if (id) selSig.value = { kind: "node", id };   // 落默认名并选中→表单改名（去 prompt）
  };
  const genTac = () => {
    tacReqSig.value = { type: "gen", evId: n.id, dia: Math.max(1, +(val("ef_tacdia") ?? "") || 60) };
  };

  return (
    <div ref={box} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div class="frow"><label>{isLabel ? "标注文本" : "名称"}</label>
        {isLabel
          ? <textarea class="fld" id="ef_name" rows={3} defaultValue={n.名称 || ""}
              placeholder="可多行；风向用箭头字符如 ↗；不确定加「？」「（一说…）」" />
          : <input class="fld" id="ef_name" defaultValue={n.名称 || ""} placeholder="地点名称" />}</div>
      {!isEv && !isLabel && (
        <div class="frow"><label>类型 · 改选立即生效</label>
          {/* 两级（2026-07-30）：类别 chips + 只列本类的下拉。换类别＝换成该类默认型（各记一步撤销）。
              未知/旧类型（nodeCatOf 取不到）回退全量下拉，免得归不了类的地点被锁死改不了型。 */}
          {cat && (
            <div class="chips" style={{ marginBottom: "5px" }}>
              {NODE_CAT_ORDER.map(k => (
                <button key={k} type="button" class="ch tr" aria-pressed={cat === k}
                  title={NODE_CATS[k].types.map(t => NODE_STYLE[t].名).join(" / ")}
                  onClick={() => { if (k !== cat) setType(NODE_CATS[k].def); }}>{NODE_CATS[k].名}</button>
              ))}
            </div>
          )}
          <select class="fld" id="ef_type" title="改类型立即生效（可撤销），表单随之切换" value={n.type}
            onChange={e => setType((e.currentTarget as HTMLSelectElement).value)}>
            {(cat ? NODE_CATS[cat].types : NODE_TYPES).filter(t => !offEraType(t, modern, n.type))
              .map(t => <option key={t} value={t}>{NODE_STYLE[t].sym} {NODE_STYLE[t].名}</option>)}
          </select></div>
      )}
      <div class="frow"><label>经纬度°（东经 / 北纬为正，±85）</label>
        <div class="fx2">
          <input class="fld" id="ef_lon" type="number" step={0.0001} key={n.id + ":lon" + n.lon}
            defaultValue={String(n.lon)} placeholder="经度°" title="经度（东经为正）——按坐标精确落点；拖动地点亦可" />
          <input class="fld" id="ef_lat" type="number" step={0.0001} key={n.id + ":lat" + n.lat}
            defaultValue={String(n.lat)} placeholder="纬度°" title="纬度（北纬为正，±85）" />
        </div></div>
      {isEv && (
        <div class="frow"><label>事件子类型（仅战役带 对阵/结果/作战线）</label>
          <select class="fld" id="ef_evtype" title="事件子类型：只有战役带 对阵/结果/作战线" value={evt}
            onChange={e => {
              const v = (e.currentTarget as HTMLSelectElement).value;
              captureDirty();   // 战役↔其他子类切换会插拔 对阵/结果 行，同样防丢
              mutateWorld(w => { const x = w.nodes.find(y => y.id === n.id); if (x) x.evtype = v; });
            }}>
            {Object.keys(EVENT_TYPES).map(k => <option key={k} value={k}>{EVENT_TYPES[k].sym} {EVENT_TYPES[k].名}</option>)}
          </select></div>
      )}
      {isEv && <div class="frow"><label>{tac ? "发生日" : "发生年份"} · 时间轴据此定位</label>
        <input class="fld" id="ef_year" type={eraTy(cal, tac)} key={n.id + ":y" + (tac ? "t" : "n")}
          placeholder={tac
            ? (cal.kind === "earth" ? "年-月-日，可带时刻 13:30；前N=公元前" : "年-月-日，如 3107-3-7")
            : (cal.kind === "earth" ? "公元年 或 年-月；前N=公元前" : `${cal.era} 纪年，可带 -月`)}
          defaultValue={n.year != null ? fmtWhenForm(cal, tac, n.year) : ""} /></div>}
      {isEv && (n.tacmap || !tac) && (
        <div class="seg" style={{ alignItems: "center" }}>
          <button type="button" class="tbtn" title={n.tacmap ? "重新生成一张战术图并改链到它（旧图保留在图库）" : "以此事件为中心生成小范围战场图（地形/地点/派系按当年快照继承）"} onClick={genTac}>{n.tacmap ? "⟳ 重新生成战术图" : "⚔ 生成战术图"}</button>
          <input class="fld" id="ef_tacdia" type="number" min={20} max={140} step={10} defaultValue="60" style={{ width: "5em" }} title="战场直径 km——生成范围（默认 60,钳 20~140）" />
          <span class="sub">km 直径</span>
        </div>
      )}
      {isBattle && <div class="frow"><label>对阵</label>
        <input class="fld" id="ef_sides" defaultValue={typeof n.sides === "string" ? n.sides : ""} placeholder="如 起义军 vs 帝国" /></div>}
      {isBattle && <div class="frow"><label>结果</label>
        <input class="fld" id="ef_result" defaultValue={typeof n.result === "string" ? n.result : ""} placeholder="如 官军克偃师" /></div>}
      {isBattle && <OpList n={n} />}
      {isLabel && (
        <div class="frow"><label>字号 · 屏幕锚定</label>
          <div class="fx2">
            <select class="fld" id="ef_fs" title="字号（图面文字大小）">
              {![11, 13, 17].includes(+fsCur) && <option value={fsCur} selected>{fsCur}px（自定义）</option>}
              <option value="11" selected={+fsCur === 11}>小注 11px</option>
              <option value="13" selected={+fsCur === 13}>正文 13px</option>
              <option value="17" selected={+fsCur === 17}>标题 17px</option>
            </select>
            <select class="fld" id="ef_pin" title="屏幕角固定：帧标题/图注块不随地图平移，同角多条按时段轮换；固定后画布不可点选，经搜索或撤销管理">
              <option value="" selected={!n.pin}>📍 地图锚定</option>
              <option value="nw" selected={n.pin === "nw"}>⌜ 左上角固定</option>
              <option value="ne" selected={n.pin === "ne"}>⌝ 右上角固定</option>
              <option value="sw" selected={n.pin === "sw"}>⌞ 左下角固定</option>
              <option value="se" selected={n.pin === "se"}>⌟ 右下角固定</option>
            </select>
          </div></div>
      )}
      {!isEv && (
        <div class="frow"><label>归属</label>
          <select class="fld" id="ef_fac">
            <option value="" selected={!n.faction}>（无/中立）</option>
            {world.factions.map(f => <option key={f.id} value={f.id} selected={n.faction === f.id}>{f.名称 || f.id}</option>)}
          </select></div>
      )}
      {!isEv && !isLabel && (
        <details class="fgroup" open>
          <summary>归属沿革</summary>
          <div class="fin"><OwnersEditor n={n} /></div>
        </details>
      )}
      {!isEv && !isLabel && <div class="frow"><label>范围半径 km（{n.type === "resource" ? "矿脉/产区幅员" : "城郊/地域幅员"}，留空＝仅一点）</label>
        <input class="fld" id="ef_r" type="number" min={0} step={1} defaultValue={n.radiusKm ? String(n.radiusKm) : ""} placeholder="如 120" /></div>}
      {!isLabel && <CertaintyChips id="ef_cert" value={typeof n.certainty === "string" ? n.certainty : ""} />}
      {!isEv && (
        <div class="frow"><label>存在 · 起 / 止（留空＝远古 / 至今）</label>
          <div class="fx2">
            <input class="fld" id="ef_since" type={eraTy(cal, tac)} key={n.id + ":s" + (tac ? "t" : "n")}
              placeholder={`起(${eraPh(cal, tac)})`} defaultValue={n.since != null ? fmtWhenForm(cal, tac, n.since) : ""} />
            <input class="fld" id="ef_until" type={eraTy(cal, tac)} key={n.id + ":u" + (tac ? "t" : "n")}
              placeholder={`止(${eraPh(cal, tac)})`} defaultValue={n.until != null ? fmtWhenForm(cal, tac, n.until) : ""} />
          </div></div>
      )}
      {sight && (
        <details class="fgroup" open>
          <summary>视域 · 火力 / 视野{modern ? " / 雷达" : ""}</summary>
          <div class="fin">
            <div class="sub">火力圈可多个，各自选直射（按视线裁）或曲射（按射角弹道裁）；圈线是名义半径，图上只填打得到的格</div>
            {rows.map((r, i) => (
              <div key={r.k} class="frow"><label>火力圈 {i + 1} · 名称 / 半径 km · 直射 / 曲射{r.fire === "arc" ? " · 射角°" : ""}</label>
                <div class="fx2">
                  <input class="fld" id={"ef_rgn" + r.k} defaultValue={r.init.名称} placeholder="如 岸炮 / 床弩" />
                  <button type="button" class="link" style={{ color: "var(--q-zhu)", alignSelf: "center" }} title="删除此圈"
                    onClick={() => setRows(rows.filter(x => x.k !== r.k))}>✕</button>
                </div>
                <div class="fx2">
                  <input class="fld" id={"ef_rgk" + r.k} type="number" min={0} step={0.1} defaultValue={r.init.km} placeholder="半径 km" />
                  <select class="fld" value={r.fire} title="直射＝按视线裁（眼位＝所在处高程＋观察高度）；曲射＝按固定射角的弹道裁，挡在弹道之上的山打不过去"
                    onChange={e => { const f = (e.currentTarget as HTMLSelectElement).value === "direct" ? "direct" : "arc"; setRows(rows.map(x => x.k === r.k ? { ...x, fire: f } : x)); }}>
                    <option value="arc" selected={r.fire === "arc"}>曲射（弹道）</option>
                    <option value="direct" selected={r.fire === "direct"}>直射（视线）</option>
                  </select>
                  {r.fire === "arc" && <input class="fld" id={"ef_rga" + r.k} type="number" min={5} max={85} step={1} defaultValue={r.init.arcDeg}
                    placeholder={`射角 缺省 ${ARC_DEG}°`} title={`曲射射角（度）：${ARC_DEG}° 是最大射程射角；迫击炮 45～85、投石机约 45。留空＝${ARC_DEG}°`} />}
                </div></div>
            ))}
            <div class="seg"><button type="button" class="tbtn" onClick={() => setRows([...rows, { k: nextK.current++, init: { 名称: "", km: "", fire: "arc", arcDeg: "" }, fire: "arc" }])}>＋ 加一个火力圈</button></div>
            <div class="frow"><label>视野半径 km（留空＝不画）· 观察高度 m</label>
              <div class="fx2">
                <input class="fld" id="ef_vision" type="number" min={0} step={0.1} defaultValue={typeof n.vision === "number" && n.vision > 0 ? String(n.vision) : ""}
                  placeholder="烽燧瞭望 · 按视线裁" title="瞭望半径：圈内只填视线可达的格（地形遮挡与地平线都计入）；编辑态选中后可拖圈左侧手柄调节" />
                <input class="fld" id="ef_eye" type="number" min={0} step="any" defaultValue={typeof n.eyeM === "number" && n.eyeM >= 0 ? String(n.eyeM) : ""}
                  placeholder={`观察高度 缺省 ${nodeEyeM({ ...n, eyeM: undefined })} m`}
                  title="眼位离地面的高度（米）：城楼、望楼、炮台胸墙；留空＝按类型缺省。视野圈与直射火力圈共用" />
              </div></div>
            {modern && <div class="frow"><label>雷达 探测半径 km（留空＝无）· 天线高度 m · 目标高度 m</label>
              <div class="fx2">
                <input class="fld" id="ef_radar" type="number" min={0} step={1} defaultValue={typeof n.radar === "number" && n.radar > 0 ? String(n.radar) : ""}
                  placeholder="探测半径 如 80" title="雷达探测半径：图上只填雷达视线可达的格（折射按 4/3 地球半径），圈线点划" />
                <input class="fld" id="ef_radarm" type="number" min={0} step="any" defaultValue={typeof n.radarM === "number" && n.radarM >= 0 ? String(n.radarM) : ""}
                  placeholder={`天线 缺省 ${RADAR_M} m`} title={`天线离地面的高度（米）；留空＝${RADAR_M} m`} />
                <input class="fld" id="ef_radartgt" type="number" min={0} step="any" defaultValue={typeof n.radarTgtM === "number" && n.radarTgtM >= 0 ? String(n.radarTgtM) : ""}
                  placeholder={`目标 缺省 ${RADAR_TGT_M} m`} title={`假定目标离地面的高度（米）：低空 ${RADAR_TGT_M}、中空数千；目标越高，地平线越远。留空＝${RADAR_TGT_M} m`} />
              </div></div>}
          </div>
        </details>
      )}
      <details class="fgroup" open>
        <summary>属性 · 说明 · 双链</summary>
        <div class="fin">
          <div class="frow"><label>属性（每行「键：值」，值留空的行不保存）</label>
            <textarea class="fld" id="ef_kv" rows={5} defaultValue={kvText} /></div>
          <div class="frow"><label>说明</label>
            <textarea class="fld" id="ef_note" rows={3} defaultValue={n.note || ""} placeholder="说明" /></div>
          <div class="frow"><label>Obsidian 双链（不含 [[]]）</label>
            <input class="fld" id="ef_link" defaultValue={n.link || ""} placeholder="目标笔记名" /></div>
        </div>
      </details>
      <div class="in-actions">
        <button class="bt zhu tr" onClick={save}>保存修改</button>
        {modeSig.value !== "edit" && <button class="bt ghost tr" onClick={() => { inspEditSig.value = false; }}>返回卡片</button>}
        {!isEv && !isLabel && <button class="bt ghost tr" onClick={addEv}>▽ 在此地新增事件点</button>}
        <button class="bt danger-ghost tr" onClick={del}>删除此{isEv ? "事件点" : isLabel ? "标注" : "地点"}</button>
      </div>
    </div>
  );
}
