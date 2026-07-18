/* 检查器卡片：地点/事件/派系/连线/部队/框选六卡——
   标题行(✕=清选中) + 类型/归属胶囊 + kv2 读数 + 归属沿革条(当年金显) + 双链行 + 动作钮组。
   「编辑」随时开表单（inspEditSig；编辑模式恒开＝旧语义保留），表单替换卡片视图；
   数据语义与 v0.14 卡一致（对齐旧 renderInfo 系列），航点动向沿旧行内编辑（战役复原工作流）。 */
import { EDGE_STYLE, EVENT_TYPES, NODE_STYLE, UNIT_STATUS } from "../core/constants.ts";
import { edgeLenKm, polylineKm } from "../core/geometry.ts";
import { calOf, fmtT, fmtWhen, fmtWhenRange } from "../core/calendar.ts";
import { unitArm, unitFireKm, unitKind, unitPos, unitSpeed, unitStatusAt } from "../core/units.ts";
import { activeAt, ownerAt, paintLayersAt } from "../core/time.ts";
import { fmtKm } from "../core/util.ts";
import type { Edge, Faction, Unit, World, WorldNode } from "../core/types.ts";
import { clearOpSel, inspEditSig, isTacSig, modeSig, mutateWorld, routePtsSig, routeResSig, selectOp, selEdge, selFaction, selMulti, selNode, selSig, selUnit, setMode, showToast, tacReqSig, unitLegsSig, worldSig, yearSig } from "./state.ts";
import { deleteUnitWaypoint, removeEdgeAt, removeFaction, removeNode, removeUnit, setUnitWaypoint, setUnitWaypointStatus } from "./editops.ts";
import { NodeForm } from "./NodeForm.tsx";
import { EdgeForm } from "./EdgeForm.tsx";
import { FactionForm } from "./FactionForm.tsx";
import { UnitForm } from "./UnitForm.tsx";

/** 卡片标题行：✕＝清选中（检查器随之收起） */
function CardHead({ title }: { title: string }) {
  return (
    <div class="in-head" style={{ padding: "14px 0 6px" }}>
      <span class="t">{title}</span>
      <button class="x tr" aria-label="关闭（清除选中）" title="关闭（Esc）"
        onClick={() => { selSig.value = null; clearOpSel(); }}>✕</button>
    </div>
  );
}

/** 是否显示编辑表单：卡片「编辑」钮随时开（inspEditSig）；编辑模式恒开（旧语义） */
const editingNow = () => inspEditSig.value || modeSig.value === "edit";

/** Obsidian 双链行（对齐旧 linkRow/bindCopy） */
function LinkRow({ target }: { target?: string }) {
  if (!target) return null;
  const vault = String((worldSig.value?.meta || {}).vault || "").trim();
  const href = vault ? `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(target)}` : null;
  return (
    <div class="linkrow">
      {href && <a class="ghostbt tr" href={href} title="在 Obsidian 中打开这篇笔记">🔗 打开双链</a>}
      <button class="ghostbt tr" title="复制双链文本" onClick={e => {
        if (navigator.clipboard) navigator.clipboard.writeText(`[[${target}]]`);
        (e.currentTarget as HTMLElement).textContent = "✓ 已复制";
      }}>📋 复制</button>
      <span class="sub">[[{target}]]</span>
    </div>
  );
}

function NodeCard({ n, world }: { n: WorldNode; world: World }) {
  const y = yearSig.value;
  const tac = isTacSig.value;
  const cal = calOf((world.meta || {}).calendar);
  const isEv = n.type === "event";
  const isLabel = n.type === "label";
  const et = EVENT_TYPES[String(n.evtype)] || EVENT_TYPES.battle;
  const isBattle = isEv && (!n.evtype || n.evtype === "battle");
  const fid = ownerAt(n, y);
  const f = fid ? world.factions.find(x => x.id === fid) : null;
  const s = NODE_STYLE[n.type] || NODE_STYLE.city;
  if (editingNow()) {
    return <><CardHead title={`编辑 · ${n.名称 || n.id}`} /><NodeForm key={n.id} n={n} /></>;
  }
  const setFrom = () => { setMode("route"); routePtsSig.value = [{ lon: n.lon, lat: n.lat, node: n }]; routeResSig.value = null; };
  const setTo = () => {
    setMode("route");
    if (routePtsSig.peek().length !== 1) { alert("请先设置起点"); return; }
    routePtsSig.value = [...routePtsSig.peek(), { lon: n.lon, lat: n.lat, node: n }];
  };
  const del = () => {
    if (!confirm(`删除${isEv ? "事件点" : isLabel ? "标注" : "地点"}「${n.名称 || n.id}」及其连线与关联引用？`)) return;
    mutateWorld(w => removeNode(w, n.id));
    clearOpSel(); selSig.value = null;
  };
  return (
    <>
      <CardHead title={n.名称 || n.id} />
      <div class="tags">
        <span class="tg" style={{ background: isEv ? "#8a2f22" : "#6a5326" }}>{isEv ? `${et.sym} ${et.名}` : s.名}</span>
        {!isEv && (f
          ? <span class="tg" style={{ background: f.color || "#888" }}>{f.名称 || f.id}</span>
          : <span class="tg" style={{ background: "#8a8272" }}>中立</span>)}
      </div>
      <div class="kv2">
        {isEv && n.year != null && <><b>发生</b><span class="num">{fmtWhen(cal, tac, n.year, true)}</span></>}
        {isBattle && typeof n.sides === "string" && n.sides ? <><b>对阵</b><span>{n.sides}</span></> : null}
        {isBattle && typeof n.result === "string" && n.result ? <><b>结果</b><span>{n.result}</span></> : null}
        <b>坐标</b><span class="num">{n.lon}° · {n.lat}°</span>
        {(n.since != null || n.until != null) && <><b>存在</b><span class="num">{n.since != null ? fmtWhen(cal, tac, n.since) : "远古"} – {n.until != null ? fmtWhen(cal, tac, n.until) : "至今"}</span></>}
        {typeof n.radiusKm === "number" && n.radiusKm > 0 && <><b>范围</b><span class="num">{n.radiusKm} km</span></>}
        {(n.ranges || []).length > 0 && <><b>火力</b><span>{n.ranges!.map(r => `${r.名称 || "射程"} ${r.km}km`).join("、")}</span></>}
        {n.字段 && Object.entries(n.字段).map(([k, v]) => <><b>{k}</b><span>{String(v)}</span></>)}
      </div>
      {n.owners && n.owners.length > 0 && (
        <div class="hist"><div class="h">归属沿革 · 金＝当前{tac ? "时刻" : "纪年"}</div>
          {n.owners.map((o, i) => {
            const of = o.faction ? world.factions.find(x => x.id === o.faction) : null;
            const a = o.since ?? -Infinity, b = o.until ?? Infinity;
            const now = y >= a && y < b;
            const so = o.since == null ? "远古" : fmtWhen(cal, tac, o.since);
            const uo = (o.until == null || (!tac && o.until >= 9999)) ? "至今" : fmtWhen(cal, tac, o.until);
            return (
              <div key={i} class={"seg3" + (now ? " now" : "")}>
                <i style={{ background: (of && of.color) || "#8a8272" }} />
                <span class="nm">{of ? (of.名称 || of.id) : "中立/自由"}</span>
                <span class="yr">{so} – {uo}</span>
              </div>
            );
          })}
        </div>
      )}
      {isBattle && (n.ops || []).length > 0 && (
        <div class="hist"><div class="h">作战线 · 点击＝选中开悬浮框</div>
          {n.ops!.map((op, i) => (
            <button key={i} class="seg3 tr" onClick={() => selectOp(n.id, i)}>
              <i style={{ background: (op.side && (world.factions.find(x => x.id === op.side)?.color)) || "#c0453a" }} />
              <span class="nm">{op.kind === "defense" ? "🛡" : "⚔"} {op.troop || op.label || `作战线 ${i + 1}`}</span>
              {(op.since != null || op.until != null) &&
                <span class="yr">{fmtWhenRange(cal, tac, op.since, op.until)}</span>}
            </button>
          ))}
        </div>
      )}
      {typeof n.note === "string" && n.note && <div class="sub" style={{ lineHeight: 1.7 }}>{n.note}</div>}
      <LinkRow target={n.link} />
      <div class="in-actions">
        {isEv && n.year != null && y !== n.year && (
          <button class="bt gold tr" onClick={() => { yearSig.value = n.year as number; }}>⇢ 跳到{tac ? "当日" : "当年"} {fmtWhen(cal, tac, n.year)}</button>
        )}
        {isEv && n.tacmap && (
          <button class="bt tr" title="打开这场战役的战术地图（当前图自动保存）" onClick={() => { tacReqSig.value = { type: "open", evId: n.id }; }}>⚔ 打开战术图 {n.tacmap.name ? `· ${n.tacmap.name}` : ""}</button>
        )}
        {isBattle && !n.tacmap && !tac && (
          <button class="bt tr" title="以此事件为中心生成小范围战场图（直径可输，默认200km）" onClick={() => {
            const d = prompt("战术地图范围（战场直径，km）：", "200");
            if (d == null) return;
            tacReqSig.value = { type: "gen", evId: n.id, dia: +d || 200 };
          }}>⚔ 生成战术图</button>
        )}
        <button class="bt tr" onClick={() => { inspEditSig.value = true; }}>编辑{isEv ? "事件" : isLabel ? "标注" : "地点"}</button>
        {!isEv && !isLabel && <button class="bt ghost tr" onClick={setFrom}>⚑ 设为行军起点</button>}
        {!isEv && !isLabel && <button class="bt ghost tr" onClick={setTo}>设为行军终点</button>}
        <button class="bt danger-ghost tr" onClick={del}>删除{isEv ? "事件" : isLabel ? "标注" : "地点"}</button>
      </div>
    </>
  );
}

function FactionCard({ f, world }: { f: Faction; world: World }) {
  const y = yearSig.value;
  const tac = isTacSig.value;
  const cal = calOf((world.meta || {}).calendar);
  if (editingNow()) {
    return <><CardHead title={`编辑 · ${f.名称 || f.id}`} /><FactionForm key={f.id} f={f} /></>;
  }
  const byId = (id: string) => world.nodes.find(n => n.id === id);
  const ns = (f.territory
    ? f.territory.map(byId).filter((n): n is WorldNode => !!n)
    : world.nodes.filter(n => n.type !== "event" && ownerAt(n, y) === f.id)
  ).filter(n => activeAt(n, y));
  const nb = paintLayersAt(f, y).length;
  const del = () => {
    if (!confirm(`删除派系「${f.名称 || f.id}」？其地点归属将变为中立，涂域随之删除。`)) return;
    mutateWorld(w => { removeFaction(w, f.id); });
    selSig.value = null;
  };
  return (
    <>
      <CardHead title={f.名称 || f.id} />
      <div class="tags">
        <span class="tg" style={{ background: f.color || "#888" }}>{f.阵营 || "派系"}</span>
      </div>
      <div class="kv2">
        <b>存续</b><span class="num">{f.since ? fmtWhen(cal, tac, f.since, true) : "远古"} – {f.until == null || (!tac && f.until >= 9999) ? "至今" : fmtWhen(cal, tac, f.until, true)}</span>
        <b>据点({fmtWhen(cal, tac, y)})</b><span>{ns.length ? ns.map(n => n.名称 || n.id).join("、") : "—"}</span>
      </div>
      {nb > 0
        ? <div class="hint">涂绘疆域 {nb} 层生效（绘 → 域 可改）</div>
        : (f.territory
          ? <div class="hint">范围为显式指定(territory)——地下网络/影响范围(虚线)，非领土</div>
          : <div class="hint">范围为据点凸包近似；可在 绘 → 域 用笔刷涂出精确疆域</div>)}
      {typeof f.note === "string" && f.note && <div class="sub" style={{ lineHeight: 1.7 }}>{f.note}</div>}
      <LinkRow target={f.link} />
      <div class="in-actions">
        <button class="bt tr" onClick={() => { inspEditSig.value = true; }}>编辑派系</button>
        <button class="bt danger-ghost tr" onClick={del}>删除派系</button>
      </div>
    </>
  );
}

function EdgeCard({ e, idx, world }: { e: Edge; idx: number; world: World }) {
  const tac = isTacSig.value;
  const cal = calOf((world.meta || {}).calendar);
  const st = EDGE_STYLE[e.type] || { color: "#888", w: 2, 名: e.type };
  const a = world.nodes.find(n => n.id === e.from), b = world.nodes.find(n => n.id === e.to);
  const free = Array.isArray(e.pts) && e.pts.length >= 2;   // 自由画河：无两端、沿 pts 量长
  const len = free ? polylineKm(world.meta, e.pts!) : (a && b ? edgeLenKm(world.meta, a, b, e.type, (e.from || "") + (e.to || "")) : 0);
  if (editingNow()) {
    return <><CardHead title={`编辑 · ${e.名称 || st.名}`} /><EdgeForm key={`${e.from}|${e.to}|${e.type}|${idx}`} e={e} idx={idx} /></>;
  }
  const del = () => {
    if (!confirm(`删除这条${st.名}${e.名称 ? `「${e.名称}」` : ""}？`)) return;
    mutateWorld(w => { removeEdgeAt(w, idx); });
    selSig.value = null;
  };
  return (
    <>
      <CardHead title={e.名称 || (free ? st.名 : `${a ? a.名称 : e.from} — ${b ? b.名称 : e.to}`)} />
      <div class="tags"><span class="tg" style={{ background: st.color }}>{st.名}</span></div>
      <div class="kv2">
        {!free && <><b>两端</b><span>{a ? a.名称 : e.from} ↔ {b ? b.名称 : e.to}</span></>}
        <b>沿线长</b><span class="num">≈ {fmtKm(len)}{e.type === "river" ? "（含曲流）" : ""}</span>
        {(e.since != null || e.until != null) && <><b>存在</b><span class="num">{e.since != null ? fmtWhen(cal, tac, e.since) : "远古"} – {e.until != null ? fmtWhen(cal, tac, e.until) : "至今"}</span></>}
        {e.type === "river" && typeof e.widthM === "number" && e.widthM > 0 && <><b>水面宽</b><span class="num">约 {e.widthM} m</span></>}
        {e.字段 && Object.entries(e.字段).map(([k, v]) => <><b>{k}</b><span>{String(v) || "—"}</span></>)}
      </div>
      {typeof e.note === "string" && e.note && <div class="sub" style={{ lineHeight: 1.7 }}>{e.note}</div>}
      <div class="in-actions">
        <button class="bt tr" onClick={() => { inspEditSig.value = true; }}>编辑连线</button>
        <button class="bt danger-ghost tr" onClick={del}>删除连线</button>
      </div>
    </>
  );
}

const ARM_NAME: Record<string, string> = { land: "陆行", water: "水行", air: "飞行" };

/** 航点动向（沿旧行内编辑语义：坐标数字栏/状态选择/删航点；editable=编辑态） */
function TrackList({ u, editable }: { u: Unit; editable: boolean }) {
  const world = worldSig.value!;
  const cal = calOf((world.meta || {}).calendar);
  const legs = unitLegsSig.value.get(u.id) || [];
  const track = u.track || [];
  return (
    <>
      <div class="sec" style={{ marginTop: "4px" }}>动向<span class="cnt">{track.length} 航点</span></div>
      {track.length === 0 && <div class="sub">（尚无航点——拖动部队即记录当日位置）</div>}
      {track.map((q, i) => {
        const L = legs.find(g => g.i === i);
        const setPt = (lon: number, lat: number) => { mutateWorld(w => { setUnitWaypoint(w, u.id, q.t, lon, lat); }); };
        return (
          <div key={i} class="kv">
            <button type="button" class="link" onClick={() => { yearSig.value = q.t; }}>{fmtT(cal, q.t)}</button>
            {editable ? <>{" "}
              <input class="fld" type="number" step={0.0001} title="经度°" key={i + ":lon" + q.lon}
                style={{ width: "5.4em", display: "inline-block", padding: "1px 3px", margin: 0 }}
                defaultValue={String(q.lon)}
                onChange={e => { const v = parseFloat((e.currentTarget as HTMLInputElement).value); if (isFinite(v)) setPt(v, q.lat); }} />{" "}
              <input class="fld" type="number" step={0.0001} title="纬度°" key={i + ":lat" + q.lat}
                style={{ width: "5.4em", display: "inline-block", padding: "1px 3px", margin: 0 }}
                defaultValue={String(q.lat)}
                onChange={e => { const v = parseFloat((e.currentTarget as HTMLInputElement).value); if (isFinite(v)) setPt(q.lon, v); }} />
            </> : <> · {q.lon}°, {q.lat}°</>}
            {editable ? <>{" "}
              <select class="fld" title="自该航点起的状态（到下一航点为止）" key={i + ":st" + (q.st || "")}
                style={{ width: "4.4em", display: "inline-block", padding: "1px 2px", margin: 0 }}
                onChange={e => { const v = (e.currentTarget as HTMLSelectElement).value; mutateWorld(w => { setUnitWaypointStatus(w, u.id, q.t, v); }); }}>
                <option value="" selected={!q.st}>常态</option>
                {Object.entries(UNIT_STATUS).map(([k, d]) => <option key={k} value={k} selected={q.st === k}>{d.名}</option>)}
              </select>
            </> : (q.st && UNIT_STATUS[q.st] ? <> <span class="tg" style={{ background: UNIT_STATUS[q.st].color, fontSize: "10px", padding: "1px 6px" }}>{UNIT_STATUS[q.st].名}</span></> : null)}
            {L && <span class="sub" style={L.ok ? undefined : { color: "var(--q-zhu)" }}> {Math.round(L.km)}km{L.route ? "" : "(直线)"}/{L.days}日·需{L.need.toFixed(1)}日{L.ok ? "" : " ⚠"}</span>}
            {editable && <button type="button" class="link" style={{ color: "var(--q-zhu)" }} title="删此航点" onClick={() => { mutateWorld(w => { deleteUnitWaypoint(w, u.id, i); }); }}> ✕</button>}
          </div>
        );
      })}
    </>
  );
}

function UnitCard({ u, world }: { u: Unit; world: World }) {
  const T = yearSig.value;
  const cal = calOf((world.meta || {}).calendar);
  const k = unitKind(u);
  const f = u.faction ? world.factions.find(x => x.id === u.faction) : null;
  const p = unitPos(u, T);
  const legs = unitLegsSig.value.get(u.id) || [];
  const bad = legs.filter(L => !L.ok);
  const strength = u.strength != null ? String(u.strength).trim() : "";
  if (editingNow()) {
    return <><CardHead title={`编辑 · ${u.名称 || "未命名部队"}`} /><UnitForm key={u.id} u={u} /><TrackList u={u} editable={true} /></>;
  }
  const del = () => {
    if (!confirm(`删除部队「${u.名称 || u.id}」及其全部动向？`)) return;
    mutateWorld(w => removeUnit(w, u.id));
    selSig.value = null;
  };
  return (
    <>
      <CardHead title={u.名称 || "未命名部队"} />
      <div class="tags">
        {f && <span class="tg" style={{ background: f.color || "#888" }}>{f.名称 || f.id}</span>}
        <span class="tg" style={{ background: "#6a5326" }}>{k ? `${k.glyph} ${k.名}` : (u.kind || "部队")}</span>
        {(() => { const st = p ? unitStatusAt(u, T) : null; const sd = st ? UNIT_STATUS[st] : null;
          return sd ? <span class="tg" style={{ background: sd.color }}>{sd.名}</span> : null; })()}
      </div>
      <div class="kv2">
        {strength && <><b>兵力</b><span class="num">{strength}</span></>}
        <b>速度</b><span class="num">{unitSpeed(u)} km/日 · {ARM_NAME[unitArm(u)] || "陆行"}</span>
        <b>当前({fmtT(cal, T)})</b><span class="num">{p ? `${p.lon.toFixed(3)}° · ${p.lat.toFixed(3)}°` : "未入场 / 已离场"}</span>
        {unitFireKm(u) > 0 && <><b>火力圈</b><span class="num">{unitFireKm(u)} km</span></>}
        {typeof u.vision === "number" && u.vision > 0 && <><b>视野圈</b><span class="num">{u.vision} km</span></>}
      </div>
      {bad.length > 0 && <div class="err">⚠ {bad.length} 段行程超出速度上限——拉长间隔天数、绕开险地或调整速度（超速段在图上标红）</div>}
      <TrackList u={u} editable={false} />
      {typeof u.note === "string" && u.note && <div class="sub" style={{ lineHeight: 1.7 }}>{u.note}</div>}
      <div class="hint">切到「军」工具（4）后，图上拖<b>右手柄</b>调火力圈、<b>左手柄</b>调视野圈（一次拖动＝一步撤销）</div>
      <div class="in-actions">
        <button class="bt tr" onClick={() => { inspEditSig.value = true; }}>编辑部队</button>
        <button class="bt danger-ghost tr" onClick={del}>删除部队</button>
      </div>
    </>
  );
}

/** 框选多地点（对齐旧 renderMultiInfo） */
function MultiCard({ nodes, units, world }: { nodes: WorldNode[]; units: Unit[]; world: World }) {
  const y = yearSig.value;
  const what = [nodes.length ? `${nodes.length} 个地点` : "", units.length ? `${units.length} 支部队` : ""].filter(Boolean).join(" + ");
  const del = () => {
    const detail = [nodes.length ? `${nodes.length} 个地点及其连线与关联引用` : "",
      units.length ? `${units.length} 支部队及其全部动向` : ""].filter(Boolean).join("与");
    if (!confirm(`删除框选的 ${detail}？`)) return;
    const ids = nodes.map(n => n.id), uids = units.map(u => u.id);
    mutateWorld(w => { for (const id of ids) removeNode(w, id); for (const id of uids) removeUnit(w, id); });
    selSig.value = null;
  };
  return (
    <>
      <CardHead title={`框选 ${what}`} />
      <div class="rows">
        {nodes.map(n => {
          const fid = ownerAt(n, y);
          const f = fid ? world.factions.find(x => x.id === fid) : null;
          const s = NODE_STYLE[n.type] || NODE_STYLE.city;
          return (
            <button key={n.id} class="row tr" onClick={() => { selSig.value = { kind: "node", id: n.id }; }}>
              <span class="dot" style={{ background: (f && f.color) || "#8a8272" }} />
              <span class="nm">{n.名称 || n.id}</span>
              <span class="eye">{s.名}</span>
            </button>
          );
        })}
        {units.map(u => {
          const f = u.faction ? world.factions.find(x => x.id === u.faction) : null;
          const k = unitKind(u);
          return (
            <button key={u.id} class="row tr" onClick={() => { selSig.value = { kind: "unit", id: u.id }; }}>
              <span class="dot" style={{ background: (f && f.color) || "#a03030" }} />
              <span class="nm">{u.名称 || "未命名部队"}</span>
              <span class="eye">{k ? k.名 : "部队"}</span>
            </button>
          );
        })}
      </div>
      <div class="hint">点名称查看单个对象 · <kbd>Delete</kbd> 批量删除 · 按住框选成员可整体拖移（部队＝改写当前时刻航点）</div>
      <div class="in-actions">
        <button class="bt ghost tr" onClick={() => { selSig.value = null; }}>清除选择</button>
        <button class="bt danger-ghost tr" onClick={del}>删除全部 (Del)</button>
      </div>
    </>
  );
}

export function InfoPanel() {
  const world = worldSig.value;
  const sel = selSig.value;
  const n = world ? selNode(world, sel) : null;
  const e = world ? selEdge(world, sel) : null;
  const f = world ? selFaction(world, sel) : null;
  const u = world ? selUnit(world, sel) : null;
  const multi = world ? selMulti(world, sel) : [];
  const multiUnits = (world && sel && sel.kind === "multi" ? sel.unitIds || [] : [])
    .map(id => (world!.units || []).find(x => x.id === id)).filter((x): x is Unit => !!x);
  if (!world || (!n && !e && !f && !u && !multi.length && !multiUnits.length)) return null;   // 无选中＝检查器收起（Inspector 壳控制）
  return n ? <NodeCard n={n} world={world} />
    : e ? <EdgeCard e={e} idx={(sel as { idx: number }).idx} world={world} />
    : f ? <FactionCard f={f} world={world} />
    : u ? <UnitCard u={u} world={world} />
    : <MultiCard nodes={multi} units={multiUnits} world={world} />;
}
