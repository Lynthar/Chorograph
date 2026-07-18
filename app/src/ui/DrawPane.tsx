/* 绘面 · 子工具：
   未选子工具＝选择态（editSubSig="select"），再点当前子工具＝退回选择（Shift+1~6 同序同语义）；
   各子工具上下文（涂域派系/时段层、地形生态/高程、布景印章、连线类型、⏳新对象时段）
   语义自旧编辑面板原样转写；笔刷数值与画布上方 fprops 浮条同信号联动。 */
import { DECOR, ECO, ECO_ORDER, EDGE_STYLE, LANDFORM, LANDFORM_ORDER, parseComposite } from "../core/constants.ts";
import { calOf, eraPh, eraTy, fmtWhen, fmtWhenForm, parseWhenForm } from "../core/calendar.ts";
import { elevUnitM } from "../core/elev.ts";
import { addFaction, removePaintLayer, setPaintLayerSpan } from "./editops.ts";
import { stampPoolSig, poolAdd, poolRemove, fileToAsset } from "./stamps.ts";
import type { Edge, Ecotype, Landform } from "../core/types.ts";
import { brushEraseSig, canRedoSig, canUndoSig, decorKindSig, editSubSig, eraNewSig, isTacSig, linkFromSig, linkTypeSig,
  mutateWorld, paintFactionSig, paintLayerSig, paintTerrainSig, pickEditSub, redoWorld, selSig, showToast, terrainHeightSig, undoWorld, worldSig,
  type EditSub } from "./state.ts";

const SUBS: { s: EditSub; g: string; n: string }[] = [
  { s: "terrain", g: "形", n: "地形" },
  { s: "add", g: "点", n: "地点" },
  { s: "link", g: "线", n: "连线" },
  { s: "paint", g: "域", n: "涂域" },
  { s: "decor", g: "景", n: "布景" },
  { s: "label", g: "注", n: "标注" },
];

/** 涂域（域）：派系选择/时段层管理（对齐旧 fpaint 面板；笔刷大小/橡皮/平滑在 fprops 浮条同步） */
function PaintCtx() {
  const world = worldSig.value!;
  const tac = isTacSig.value;
  const cal = calOf((world.meta || {}).calendar);
  let pf = paintFactionSig.value;
  if (!pf || !world.factions.some(f => f.id === pf)) {
    pf = (world.factions[0] || {}).id || null;
    if (pf !== paintFactionSig.peek()) paintFactionSig.value = pf;
  }
  const f = pf ? world.factions.find(x => x.id === pf) : null;
  const layers = f?.paint || [];
  let li = paintLayerSig.value;
  if (li >= layers.length) li = Math.max(0, layers.length - 1);
  const L = layers[li];
  const addFac = () => {
    let id: string | null = null;
    mutateWorld(w => { id = addFaction(w).id; });
    if (id) { paintFactionSig.value = id; paintLayerSig.value = 0; selSig.value = { kind: "faction", id }; }
  };
  if (!world.factions.length) {
    return (
      <div class="empty"><span class="ph">域</span><b>还没有派系</b>
        <p>建一个派系才能涂疆域。颜色属于你的世界——界面不会与它争色。</p>
        <button class="bt zhu tr" onClick={addFac}>＋ 新建派系</button></div>
    );
  }
  return (
    <>
      <div class="sec">派系<span class="cnt">{world.factions.length}</span><button type="button" class="mini tr" onClick={addFac}>＋ 新增派系</button></div>
      <div class="rows">
        {world.factions.map(x => (
          <button key={x.id} class={"row tr" + (pf === x.id ? " on" : "")}
            title="选为涂域目标；详情与编辑在右侧检查器"
            onClick={() => { paintFactionSig.value = x.id; paintLayerSig.value = 0; selSig.value = { kind: "faction", id: x.id }; }}>
            <span class="dot" style={{ background: x.color || "#888" }} />
            <span class="nm">{x.名称 || x.id}</span>
            {pf === x.id && <span class="eye">涂绘中</span>}
          </button>
        ))}
      </div>
      {f && (
        <>
          <div class="sec">时段层<button type="button" class="mini tr" onClick={() => {
            let ni = 0;   // 新层下标在 mutateWorld 回调里取——`layers` 别名着被 push 的数组，回调外 length 已变（2026-07-12 P1）
            mutateWorld(w => { const wf = w.factions.find(x => x.id === f.id); if (wf) { (wf.paint = wf.paint || []).push({ cells: [] }); ni = wf.paint.length - 1; } });
            paintLayerSig.value = ni;
          }}>＋ 新增时段层</button></div>
          {layers.length > 0 ? (
            <div class="lyr-strip">
              {layers.map((Lx, i) => (
                <button key={i} class={"lr2 tr" + (li === i ? " on" : "")} onClick={() => { paintLayerSig.value = i; }}>
                  <span class="rangeY">{Lx.since == null ? "远古" : fmtWhen(cal, tac, Lx.since)} – {Lx.until == null || (!tac && Lx.until >= 9999) ? "至今" : fmtWhen(cal, tac, Lx.until)}</span>
                  <span class="cells">{(Lx.cells || []).length} 格</span>
                  <span class="del" title="删除该时段层" onClick={ev => {
                    ev.stopPropagation();
                    if (!confirm("删除该时段层（其全部涂域格）？")) return;
                    mutateWorld(w => { const wf = w.factions.find(x => x.id === f.id); if (wf) removePaintLayer(wf, i); });
                    paintLayerSig.value = 0;
                  }}>✕</span>
                </button>
              ))}
            </div>
          ) : <div class="hint">（{f.名称 || f.id}尚无涂域——直接开涂即自动建层；仍按据点凸包显示）</div>}
          {L && (
            <div style={{ display: "flex", gap: "5px", alignItems: "center" }}>
              <input class="fld" id="pl_since" type={eraTy(cal, tac)} style={{ flex: 1 }} placeholder={`起(${eraPh(cal, tac)})`}
                defaultValue={L.since != null ? fmtWhenForm(cal, tac, L.since) : ""} key={pf + ":" + li + ":s:" + (L.since ?? "")} />
              <input class="fld" id="pl_until" type={eraTy(cal, tac)} style={{ flex: 1 }} placeholder={`止(${eraPh(cal, tac)})`}
                defaultValue={L.until != null && (tac || L.until < 9999) ? fmtWhenForm(cal, tac, L.until) : ""} key={pf + ":" + li + ":u:" + (L.until ?? "")} />
              <button class="ghostbt tr" id="plYear" onClick={e => {
                const box = (e.currentTarget as HTMLElement).parentElement!;
                const sv = parseWhenForm(cal, tac, (box.querySelector("#pl_since") as HTMLInputElement).value);
                const uv = parseWhenForm(cal, tac, (box.querySelector("#pl_until") as HTMLInputElement).value);
                mutateWorld(w => { const wf = w.factions.find(x => x.id === f.id); const wl = wf?.paint?.[li]; if (wl) setPaintLayerSpan(wl, sv == null ? "" : String(sv), uv == null ? "" : String(uv)); });
                showToast("已保存时段层年代", { undo: true });   // 与同量级表单保存同回执（此前静默）
              }}>保存年代</button>
            </div>
          )}
        </>
      )}
      <div class="hint">按住拖＝涂格疆域（战术图自动细密） · 橡皮＝反涂 · <kbd>[ ]</kbd>调大小 <kbd>E</kbd>切橡皮 · <kbd>Alt</kbd>+点＝取样已涂派系 · 留空年代＝全期有效</div>
    </>
  );
}

/** 地形（形）：地貌 chips × 生态 chips 两轴叠加涂改 / ⛰高程抬升下切（A 两轴重构） */
function TerrainCtx() {
  const [lf, eco] = parseComposite(paintTerrainSig.value);   // 当前笔刷复合串 → 地貌/生态
  const hMode = terrainHeightSig.value;
  const unit = elevUnitM((worldSig.value?.meta || {}));
  const setLf = (id: Landform) => { paintTerrainSig.value = eco === "none" ? id : id + "/" + eco; };
  const setEco = (id: Ecotype) => { paintTerrainSig.value = id === "none" ? lf : lf + "/" + id; };
  return (
    <>
      <div class="seg2">
        <button aria-pressed={!hMode} onClick={() => { terrainHeightSig.value = false; }}>地貌 · 生态</button>
        <button aria-pressed={hMode} title="抬升/下切地势（只改高程观感与等高线，不改类型/寻路）" onClick={() => { terrainHeightSig.value = true; }}>⛰ 高程</button>
      </div>
      {!hMode ? (
        <>
          <div class="sec" style={{ marginTop: "4px" }}>地貌<span class="mini">定高程/寻路</span></div>
          <div class="chips">
            {LANDFORM_ORDER.map(id => (
              <button key={id} class="ch tr" aria-pressed={lf === id} onClick={() => setLf(id)}>
                <span class="sw" style={{ background: LANDFORM[id].color }} />{LANDFORM[id].名}
              </button>
            ))}
          </div>
          <div class="sec">生态<span class="mini">叠加·点缀/代价</span></div>
          <div class="chips">
            {ECO_ORDER.map(id => (
              <button key={id} class="ch tr" aria-pressed={eco === id} onClick={() => setEco(id)}>
                {ECO[id].color && <span class="sw" style={{ background: ECO[id].color! }} />}{ECO[id].名}
              </button>
            ))}
          </div>
          <div class="hint">地貌定基（高程/寻路），生态叠加（点缀/色调/代价）——如 丘陵×森林＝<b>森林覆盖的丘陵</b>、平原×草原＝草甸；生态选「无」＝纯地貌。涂上自动配套点缀；<kbd>E</kbd>切橡皮＝恢复初稿 · <kbd>Alt</kbd>+点取样该格</div>
        </>
      ) : (
        <div class="hint">高程画笔：按住拖动{brushEraseSig.value ? <b>▼ 下切</b> : <b>▲ 抬升</b>}地势（每笔约 {Math.round(0.02 * unit)}m，可反复叠加；<kbd>E</kbd> 换向、<kbd>[ ]</kbd> 调大小）。山峰/棱线/凹路皆可雕；开「等高线」图层看效果。水域恒平、陆地不跌成滩涂。</div>
      )}
    </>
  );
}

/** 布景（景）：印章 chips + 橡皮模式钮（与印章同级）；大小滑杆在 fprops 随模式调「印章尺寸/橡皮半径」 */
function DecorCtx() {
  const kind = decorKindSig.value, erase = brushEraseSig.value;
  const pool = stampPoolSig.value;
  const pick = (k: string) => { decorKindSig.value = k; brushEraseSig.value = false; };
  const upload = (e: Event) => {
    const inp = e.currentTarget as HTMLInputElement, file = inp.files && inp.files[0];
    if (file) fileToAsset(file).then(a => { poolAdd(a); pick("img:" + a.id); }).catch(() => showToast("图片读取失败", { err: true }));
    inp.value = "";   // 允许连传同名文件
  };
  return (
    <>
      <div class="chips">
        {Object.keys(DECOR).map(k => (
          <button key={k} class="ch tr" aria-pressed={!erase && kind === k} onClick={() => pick(k)}>{DECOR[k].名}</button>
        ))}
        <button class="ch tr" aria-pressed={erase} title="通用擦除：抹掉笔刷半径内任意种类的布景（不限当前印章）"
          onClick={() => { brushEraseSig.value = true; }}>⌫ 橡皮</button>
      </div>
      <div class="sec" style={{ marginTop: "4px" }}>常用印章<span class="mini">你上传的·跨图复用</span></div>
      <div class="stamps">
        {pool.map(a => (
          <button key={a.id} class={"stamp tr" + (!erase && kind === "img:" + a.id ? " on" : "")} title={a.name || "印章"} onClick={() => pick("img:" + a.id)}>
            <img src={a.src} alt="" />
            <span class="del" title="从常用移除（不删已落的章）" onClick={ev => { ev.stopPropagation(); poolRemove(a.id); }}>✕</span>
          </button>
        ))}
        <label class="stamp add tr" title="上传图片当印章（自动缩到 256px、随本图导出/分享）">＋
          <input type="file" accept="image/*" style={{ display: "none" }} onChange={upload} /></label>
      </div>
      <div class="hint">点<b>印章</b>放置、点<b>橡皮</b>通用擦除 · 点放或按住播撒成林/成岭 · <kbd>[ ]</kbd>调大小 · <kbd>Alt</kbd>+点取样 · 右键删单个 · 自定义印章存进本图、随导出/分享</div>
    </>
  );
}

/** 连线（线）：类型选择 + 起点状态（对齐旧 link 面板） */
function LinkCtx() {
  const world = worldSig.value!;
  const linkFrom = linkFromSig.value;
  const fromNode = linkFrom ? world.nodes.find(n => n.id === linkFrom) : null;
  return (
    <>
      <div class="chips">
        {(Object.keys(EDGE_STYLE) as Edge["type"][]).map(tp => (
          <button key={tp} class="ch tr" aria-pressed={linkTypeSig.value === tp} onClick={() => { linkTypeSig.value = tp; }}>
            <span class="sw" style={{ background: EDGE_STYLE[tp].color, borderRadius: "2px", height: "4px" }} />{EDGE_STYLE[tp].名}
          </button>
        ))}
      </div>
      <div class="hint">{linkTypeSig.value === "river"
        ? <>河流＝<b>自由画河</b>：图上按住<b>拖动</b>画出河道（不必锚地点）· 右键/Esc 取消 · 画完在检查器改名/水面宽/时段 · 改道＝删了重画</>
        : fromNode
        ? <>起点：<b>{fromNode.名称 || fromNode.id}</b>——拖到/点击另一地点成线（右键或点空白取消）</>
        : <>按住一个地点<b>拖到</b>另一地点，或依次点击两地；已有连线直接点击可查看/编辑属性</>}</div>
    </>
  );
}

/** ⏳ 新对象时间段（对齐旧 eraNew）：勾选后新画的对象带 since/until */
function EraCtx({ sub }: { sub: EditSub }) {
  const world = worldSig.value!;
  const tac = isTacSig.value;
  const cal = calOf((world.meta || {}).calendar);
  const era = eraNewSig.value;
  return (
    <>
      <div class="sec" style={{ marginTop: "4px" }}>⏳ 该对象存在时间段
        <span class="mini"><input type="checkbox" checked={era.on}
          onChange={e => { eraNewSig.value = { ...eraNewSig.peek(), on: (e.currentTarget as HTMLInputElement).checked }; }} /></span>
      </div>
      <div style={{ display: "flex", gap: "5px" }}>
        <input class="fld" type={eraTy(cal, tac)} style={{ flex: 1 }} placeholder={`起(${eraPh(cal, tac)})`}
          defaultValue={era.since != null ? fmtWhenForm(cal, tac, era.since) : ""} disabled={!era.on} key={"eraS:" + sub}
          onInput={e => { const v = parseWhenForm(cal, tac, (e.currentTarget as HTMLInputElement).value); eraNewSig.value = { ...eraNewSig.peek(), since: v }; }} />
        <input class="fld" type={eraTy(cal, tac)} style={{ flex: 1 }} placeholder={`止(${eraPh(cal, tac)})`}
          defaultValue={era.until != null ? fmtWhenForm(cal, tac, era.until) : ""} disabled={!era.on} key={"eraU:" + sub}
          onInput={e => { const v = parseWhenForm(cal, tac, (e.currentTarget as HTMLInputElement).value); eraNewSig.value = { ...eraNewSig.peek(), until: v }; }} />
      </div>
      <div class="hint">勾选后，新画的对象只在该时段存在（留空一侧＝不限）；已有对象的时段在检查器表单里改</div>
    </>
  );
}

export function DrawPane() {
  const world = worldSig.value;
  if (!world) return null;
  const sub = editSubSig.value;
  const pick = pickEditSub;   // 再点当前子工具＝退回选择态；连带清理见 state.pickEditSub
  return (
    <>
      <div class="sec">子工具
        <button type="button" class="mini tr" title="撤销 (Ctrl+Z)" disabled={!canUndoSig.value} onClick={undoWorld}>↶ 撤销</button>
        <button type="button" class="mini tr" title="重做 (Ctrl+Y)" disabled={!canRedoSig.value} onClick={redoWorld}>↷ 重做</button>
      </div>
      <div class="stgrid" id="stgrid">
        {SUBS.map(({ s, g, n }, i) => (
          <button key={s} class="st tr" aria-pressed={sub === s} title={`Shift+${i + 1}`} onClick={() => pick(s)}>
            <span class="g">{g}</span><span class="n">{n}</span>
          </button>
        ))}
      </div>
      <div class="hint" id="draw-tip">
        {sub === "select" && <><b>默认＝选择</b>：点击选中 · 空白拖＝框选（Shift+拖＝强制框选）· 按住对象拖＝移动 · 方向键微调 · <kbd>Delete</kbd> 删除 · 点作战线＝选中开悬浮框（再点子工具可切换）</>}
        {sub === "add" && <>点空白＝落新地点（名称先填，类型/归属/沿革在检查器表单里改，11 类）</>}
        {sub === "label" && <>点空白＝落自由文本标注（钟点/风向/兵力/争议注记…），检查器改 多行文本/字号/派系色/屏幕角固定，可配 ⏳时段分相位显示</>}
        {sub === "unit" && <>兵棋部队：军面板<b>「＋新增部队」</b>新建（未入场），按住列表项<b>拖入地图放置</b>；按住图上部队<b>拖动＝记录当日位置</b>（先把时间坞拖到目标日）；同日重拖＝改写航点；<b>Shift+拖</b>＝框选；<kbd>Delete</kbd>＝删部队</>}
        {sub === "terrain" && <>生态类型 8 色画笔逐格改地形 · ⛰高程＝抬升/下切（<kbd>E</kbd> 换向）</>}
        {sub === "link" && <>选类型：河流＝自由画河道（拖动画线，不必锚地点）· 道路/商路＝地点连地点</>}
        {sub === "paint" && <>笔刷直涂派系疆域（优先于据点凸包）· 橡皮＝反涂 · 开涂自动建层</>}
        {sub === "decor" && <>9 印章 · 点放或按住播撒 · 右键删单个 · <kbd>Alt</kbd>+点取样</>}
      </div>
      {sub === "paint" && <PaintCtx />}
      {sub === "terrain" && <TerrainCtx />}
      {sub === "decor" && <DecorCtx />}
      {sub === "link" && <LinkCtx />}
      {["add", "link", "terrain", "decor", "label"].includes(sub) && <EraCtx sub={sub} />}
      <div class="hint">改动<b>自动保存</b>到浏览器存档；「导出」才写回 JSON 文件</div>
    </>
  );
}
