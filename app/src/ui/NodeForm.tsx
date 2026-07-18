/* 地点/事件点编辑表单（UI 1:1 还原 v0.14 nodeEditForm/bindNodeInfo）：
   · 类型/事件子类改选立即生效（各记一步撤销），表单随之切换；
   · 其余字段「保存修改」一次提交（一步撤销）；空值删键；
   · 字段框未填过时按类型模板预填，值留空的行不保存；
   · 战术图：年份/存在时段用「年-月-日」文本（parseYMD/fmtYMD），另有据点防御火力栏。
   输入用非受控 + key=节点id：换选中即重置，重渲不丢输入。 */
import { useLayoutEffect, useRef } from "preact/hooks";
import { EVENT_TMPL, EVENT_TYPES, NODE_STYLE, NODE_TMPL, NODE_TYPES } from "../core/constants.ts";
import { calOf, eraPh, eraTy, fmtWhenForm, fmtWhenRange, parseWhenForm } from "../core/calendar.ts";
import { formatRanges } from "./editops.ts";
import { clearOpSel, inspEditSig, isTacSig, modeSig, mutateWorld, opDrawSig, selectOp, selSig, setMode, showToast, startOpDraw, tacReqSig, worldSig, yearSig } from "./state.ts";
import { addEventNear, addOwner, applyNodeForm, changeNodeType, moveNode, removeNode, removeOwner, updateOwner } from "./editops.ts";
import type { WorldNode } from "../core/types.ts";

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
  const tv = (raw: string) => { const v = parseWhenForm(cal, tac, raw); return v == null ? "" : String(v); };
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
const TEXT_FIELDS = ["ef_name", "ef_lon", "ef_lat", "ef_r", "ef_since", "ef_until", "ef_rng", "ef_kv", "ef_note", "ef_link", "ef_year", "ef_sides", "ef_result"];

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
  const cal = calOf((world.meta || {}).calendar);
  const isEv = n.type === "event";
  const isLabel = n.type === "label";
  const evt = EVENT_TYPES[String(n.evtype)] ? String(n.evtype) : "battle";
  const isBattle = isEv && evt === "battle";
  const fsCur = String(n.fs || 13);
  const kvText = (n.字段 && Object.keys(n.字段).length)
    ? Object.entries(n.字段).map(([k, v]) => `${k}：${v}`).join("\n")
    : (isEv ? (EVENT_TMPL[evt] || "") : (NODE_TMPL[n.type] || ""));
  const val = (id: string) => (box.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>("#" + id))?.value;
  /* 时间输入：战术图「年-月-日（可带时刻）」/ earth 战略「前N」经历法解析折成日戳/年份数字串
     （applyNodeForm 按 parseFloat 语义消费；空/非法=删键）；custom 战略=原样数字串（旧语义） */
  const timeVal = (id: string) => { const v = parseWhenForm(cal, tac, val(id) ?? ""); return v == null ? "" : String(v); };

  const save = () => {
    mutateWorld(w => {
      const target = w.nodes.find(x => x.id === n.id);
      if (!target) return;
      /* 经纬度数字输入（战役复原按文档坐标表精确落点）：留空/非法=不动，经 moveNode 归一钳制 */
      const lon = parseFloat(val("ef_lon") ?? ""), lat = parseFloat(val("ef_lat") ?? "");
      if (isFinite(lon) && isFinite(lat) && (lon !== target.lon || lat !== target.lat)) moveNode(w, n.id, lon, lat);
      applyNodeForm(target, {
        名称: val("ef_name") || "", note: val("ef_note") ?? "", link: val("ef_link") ?? "",
        faction: isEv ? undefined : (val("ef_fac") ?? ""),
        radiusKm: isEv ? undefined : val("ef_r"),
        since: isEv ? undefined : timeVal("ef_since"), until: isEv ? undefined : timeVal("ef_until"),
        kv: val("ef_kv") ?? "",
        ranges: !isEv && !isLabel && tac ? (val("ef_rng") ?? "") : undefined,
        year: isEv ? timeVal("ef_year") : undefined, sides: isBattle ? val("ef_sides") : undefined, result: isBattle ? val("ef_result") : undefined,
        fs: isLabel ? (val("ef_fs") ?? "") : undefined, pin: isLabel ? (val("ef_pin") ?? "") : undefined
      });
    });
    inspEditSig.value = false;
    showToast("已保存修改", { undo: true });
  };
  const del = () => {
    if (!confirm(`删除${isEv ? "事件点" : isLabel ? "标注" : "地点"}「${n.名称 || n.id}」及其连线与关联引用？`)) return;
    mutateWorld(w => removeNode(w, n.id));
    clearOpSel();          // 删事件点连带清作战线选中态，避免 opSel 悬空吞掉下次 Delete
    selSig.value = null;
  };
  const addEv = () => {
    const 名称 = prompt("新事件名称（战役/政事/灾异等，子类型在表单里选）：");
    if (!名称) return;
    let id: string | null = null;
    mutateWorld(w => {
      const at = w.nodes.find(x => x.id === n.id);
      if (at) id = addEventNear(w, at, 名称, yearSig.peek()).id;
    });
    if (id) selSig.value = { kind: "node", id };
  };
  const genTac = () => {
    const d = prompt("战术图范围（战场直径，km）：", "200");
    if (d == null) return;
    tacReqSig.value = { type: "gen", evId: n.id, dia: +d || 200 };
  };

  return (
    <div ref={box} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div class="frow"><label>{isLabel ? "标注文本" : "名称"}</label>
        {isLabel
          ? <textarea class="fld" id="ef_name" rows={3} defaultValue={n.名称 || ""}
              placeholder="可多行；风向用箭头字符如 ↗；不确定加「？」「（一说…）」" />
          : <input class="fld" id="ef_name" defaultValue={n.名称 || ""} placeholder="地点名称" />}</div>
      <div class="frow"><label>类型 · 改选立即生效</label>
        <select class="fld" id="ef_type" title="改类型立即生效（可撤销），表单随之切换" value={n.type}
          onChange={e => {
            const t = (e.currentTarget as HTMLSelectElement).value;
            captureDirty();   // 改选即重渲：先记脏字段，提交后补回（防未保存输入蒸发）
            mutateWorld(w => { const x = w.nodes.find(y => y.id === n.id); if (x) changeNodeType(x, t, yearSig.peek(), v => !!EVENT_TYPES[String(v)]); });
          }}>
          {NODE_TYPES.map(t => <option key={t} value={t}>{NODE_STYLE[t].名}</option>)}
        </select></div>
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
            : (cal.kind === "earth" ? "公元年，前N=公元前" : `${cal.era} 纪年`)}
          defaultValue={n.year != null ? fmtWhenForm(cal, tac, n.year) : ""} /></div>}
      {isEv && (
        <div class="seg">
          {n.tacmap
            ? <button type="button" class="tbtn" title="重新生成一张战术图并改链到它（旧图保留在图库）" onClick={genTac}>⟳ 重新生成战术图</button>
            : (tac ? null : <button type="button" class="tbtn" title="以此事件为中心生成小范围战场图（直径可输，默认200km；地形/地点/派系按当年快照继承）" onClick={genTac}>⚔ 生成战术图</button>)}
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
      {!isEv && (
        <div class="frow"><label>存在 · 起 / 止（留空＝远古 / 至今）</label>
          <div class="fx2">
            <input class="fld" id="ef_since" type={eraTy(cal, tac)} key={n.id + ":s" + (tac ? "t" : "n")}
              placeholder={`起(${eraPh(cal, tac)})`} defaultValue={n.since != null ? fmtWhenForm(cal, tac, n.since) : ""} />
            <input class="fld" id="ef_until" type={eraTy(cal, tac)} key={n.id + ":u" + (tac ? "t" : "n")}
              placeholder={`止(${eraPh(cal, tac)})`} defaultValue={n.until != null ? fmtWhenForm(cal, tac, n.until) : ""} />
          </div></div>
      )}
      <details class="fgroup" open>
        <summary>属性 · 说明 · 双链</summary>
        <div class="fin">
          {!isEv && !isLabel && tac && (
            <div class="frow"><label>火力/射程（每行「名称：公里数」，据点防御火力，画虚线圈）</label>
              <textarea class="fld" id="ef_rng" rows={2} defaultValue={formatRanges(n.ranges)} /></div>
          )}
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
