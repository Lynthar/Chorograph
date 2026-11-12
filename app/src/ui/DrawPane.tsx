/* 绘面 · 子工具：
   未选子工具＝选择态（editSubSig="select"），再点当前子工具＝退回选择（Shift+1~6 同序同语义）；
   各子工具上下文（涂域派系/时段层、地形生态/高程、布景印章、连线类型、⏳新对象时段）
   语义自旧编辑面板原样转写；笔刷数值与画布上方 fprops 浮条同信号联动。 */
import { CLIMATE_SWATCH } from "../core/climzone.ts";
import { isGen2 } from "../core/gen2.ts";
import { CLIMATE, CLIMATE_ORDER, DECOR, ECO, ECO_ORDER, EDGE_STYLE, LANDFORM, LANDFORM_ORDER, NODE_CATS, NODE_CAT_ORDER, NODE_STYLE, nodeCatOf, parseComposite } from "../core/constants.ts";
import { calOf, eraPh, eraTy, fmtWhen, fmtWhenForm, parseWhenForm } from "../core/calendar.ts";
import { DH_MAX_M, UPLIFT_FLOORS_M, UPLIFT_PEAKS_M, heightStepM, upliftOn } from "../core/elev.ts";
import { erodeMode, erodePending } from "../core/erode.ts";
import { scaleProfile } from "../core/scale.ts";
import { useLayoutEffect } from "preact/hooks";
import { addFaction, foldIntoErosion, removePaintLayer, setPaintLayerSpan } from "../app/editops.ts";
import { stampPoolSig, poolAdd, poolRemove, fileToAsset } from "../app/stamps.ts";
import type { Edge, Ecotype, Landform } from "../core/types.ts";
import { addTypeSig, brushEraseSig, canRedoSig, canUndoSig, climPaintSig, decorKindSig, editSubSig, eraNewSig, erodePhaseSig, heightStepMSig, upliftPeakMSig, upliftModeSig, basinFloorMSig, isTacSig, linkFromSig, linkTypeSig,
  mutateWorld, paintFactionSig, paintLayerSig, paintTerrainSig, parseWhenInput, pickEditSub, pickLinkType, redoWorld, selSig, showToast, terrainAxisOf, terrainAxisSig, undoWorld, worldSig,
  type EditSub } from "../app/state.ts";

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
  const cur = paintFactionSig.value;
  const pf = cur && world.factions.some(f => f.id === cur) ? cur : (world.factions[0] || {}).id || null;
  /* 渲染期只读：缺省派系落回信号放到提交后（笔刷与叠加层读的是信号）——渲染期写信号在 Preact 里次序不可靠 */
  useLayoutEffect(() => { if (pf !== paintFactionSig.peek()) paintFactionSig.value = pf; }, [pf]);
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
        <button class="bt zhu tr" onClick={addFac}>＋ 新增派系</button></div>
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
                <div key={i} class={"lr2 tr" + (li === i ? " on" : "")}>
                  <button type="button" class="main" aria-pressed={li === i} onClick={() => { paintLayerSig.value = i; }}>
                    <span class="rangeY">{Lx.since == null ? "远古" : fmtWhen(cal, tac, Lx.since)} – {Lx.until == null || (!tac && Lx.until >= 9999) ? "至今" : fmtWhen(cal, tac, Lx.until)}</span>
                    <span class="cells">{(Lx.cells || []).length} 格</span>
                  </button>
                  <button type="button" class="del tr" title="删除该时段层" onClick={() => {
                    if (!confirm("删除该时段层（其全部涂域格）？")) return;
                    mutateWorld(w => { const wf = w.factions.find(x => x.id === f.id); if (wf) removePaintLayer(wf, i); });
                    paintLayerSig.value = 0;
                  }}>✕</button>
                </div>
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
                const sv = parseWhenInput(cal, tac, (box.querySelector("#pl_since") as HTMLInputElement).value);
                const uv = parseWhenInput(cal, tac, (box.querySelector("#pl_until") as HTMLInputElement).value);
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

/** 地形（形）：四页独立笔刷——地貌 / 生态(改地面+落真实印章) / ⛰高程抬升下切 / 气候分区（只战略图） */
function TerrainCtx() {
  const [lf, eco] = parseComposite(paintTerrainSig.value);   // 当前笔刷复合串 → 地貌/生态
  const tac = isTacSig.value, axis = terrainAxisOf(terrainAxisSig.value, tac);
  const meta = worldSig.value?.meta || {};
  const stepM = heightStepM(meta, heightStepMSig.value);   // 生效的每笔米数（0=自动档）
  const up = upliftOn(meta), pk = upliftPeakMSig.value, floor = upliftModeSig.value === "floor", fm = basinFloorMSig.value;
  const mode = erodeMode(meta);
  const setLf = (id: Landform) => { paintTerrainSig.value = eco === "none" ? id : id + "/" + eco; };
  const setEco = (id: Ecotype) => { paintTerrainSig.value = id === "none" ? lf : lf + "/" + id; };
  return (
    <>
      <div class="seg2">
        <button aria-pressed={axis === "lf"} title="只改地貌（平原/丘陵/山地…），生态保留；涂到之处的手雕高程一并复位" onClick={() => { terrainAxisSig.value = "lf"; }}>地貌</button>
        <button aria-pressed={axis === "eco"} title="只改生态：地面色调/寻路代价 + 随笔落下真实布景印章（可单独选中调整）" onClick={() => { terrainAxisSig.value = "eco"; }}>生态</button>
        <button aria-pressed={axis === "height"} title={up ? "画山或盆地：涂抹区长成所选峰高的山、压成所选盆底的盆地，地貌、寻路、等高线、读数与视域随之变" : "抬升/下切地势：等高线、读数与视域随之变，地貌与寻路不变"} onClick={() => { terrainAxisSig.value = "height"; }}>⛰ 高程</button>
        {!tac && <button aria-pressed={axis === "clim"} title="把一片涂成某种气候：配色、林线与雪线随之变，地貌、生态与寻路不变" onClick={() => { terrainAxisSig.value = "clim"; }}>气候</button>}
      </div>
      {axis === "lf" ? (
        <>
          <div class="sec" style={{ marginTop: "4px" }}>地貌<span class="mini">定高程/寻路 · 保留生态</span></div>
          <div class="chips">
            {LANDFORM_ORDER.map(id => (
              <button key={id} class="ch tr" aria-pressed={lf === id} onClick={() => setLf(id)}>
                <span class="sw" style={{ background: LANDFORM[id].color }} />{LANDFORM[id].名}
              </button>
            ))}
          </div>
          <div class="hint">只涂地貌基底（平原/丘陵/山地/高山/水域/沿海），格内生态保留——如给森林格换地貌＝<b>森林覆盖的丘陵</b>；涂到之处的<b>手雕高程一并复位</b>（涂平原＝真的变平）。<kbd>E</kbd>切橡皮＝恢复初稿 · <kbd>Alt</kbd>+点取样该格</div>
        </>
      ) : axis === "clim" ? (
        <>
          <div class="sec" style={{ marginTop: "4px" }}>气候分区<span class="mini">只改配色、林线与雪线</span></div>
          <div class="chips">
            {CLIMATE_ORDER.map(c => (
              <button key={c} class="ch tr" aria-pressed={!brushEraseSig.value && climPaintSig.value === c} onClick={() => { climPaintSig.value = c; brushEraseSig.value = false; }}>
                <span class="sw" style={{ background: CLIMATE_SWATCH[c] }} />{CLIMATE[c].名}
              </button>
            ))}
          </div>
          <div class="hint">按住拖＝把这一片涂成所选气候：陆地配色、林线与雪线随之变，相邻气候之间渐变过渡；地貌、生态与寻路不变。未涂处取{isGen2(meta) ? <>生成器按纬度与干湿派生的初稿（图上浅色），再往下取</> : null}设置里的「气候」档。<kbd>E</kbd>切橡皮＝擦回未涂 · <kbd>Alt</kbd>+点取样 · <kbd>[ ]</kbd>调大小</div>
        </>
      ) : axis === "eco" ? (
        <>
          <div class="sec" style={{ marginTop: "4px" }}>生态<span class="mini">改地面 + 落真实印章</span></div>
          <div class="chips">
            {ECO_ORDER.map(id => (
              <button key={id} class="ch tr" aria-pressed={eco === id} onClick={() => setEco(id)}>
                {ECO[id].color && <span class="sw" style={{ background: ECO[id].color! }} />}{ECO[id].名}
              </button>
            ))}
          </div>
          <div class="hint">涂生态＝改地面色调/寻路代价（保留地貌）+ 随笔<b>随机落下相应真实布景印章</b>（乔木/沼草/沙丘…，落后可在「选择」里单独点选、调整、删除）；选「无」＝清生态回纯地貌。<kbd>E</kbd>切橡皮＝抹地面并擦附近印章 · <kbd>[ ]</kbd>调笔刷</div>
        </>
      ) : up ? (
        <>
          <div class="seg2" role="group" aria-label="画山还是画盆地" style={{ marginTop: "4px" }}>
            <button aria-pressed={!floor} onClick={() => { upliftModeSig.value = "peak"; }}>山</button>
            <button aria-pressed={floor} onClick={() => { upliftModeSig.value = "floor"; }}>盆地</button>
          </div>
          {floor ? (
            <>
              <div class="sec" style={{ marginTop: "4px" }}>目标盆底<span class="mini">画盆地 · 可低于海面</span></div>
              <div class="chips">
                {UPLIFT_FLOORS_M.map(v => (
                  <button key={v} class="ch tr" aria-pressed={!brushEraseSig.value && fm === v} onClick={() => { basinFloorMSig.value = v; brushEraseSig.value = false; }}>{v}m</button>
                ))}
                <input class="fld" type="number" min={-DH_MAX_M} max={DH_MAX_M} step={50} value={fm} style={{ width: "6em" }} aria-label="目标盆底（米）"
                  onChange={e => {
                    const el = e.currentTarget as HTMLInputElement, v = Math.round(+el.value);
                    if (el.value.trim() !== "" && Math.abs(v) <= DH_MAX_M) { basinFloorMSig.value = v; brushEraseSig.value = false; } else el.value = String(basinFloorMSig.peek());
                  }} />
              </div>
              <div class="hint">按住拖动把一片地压成盆地：每片连着的涂抹区里最低的那处压到所选盆底{brushEraseSig.value ? <>（现为 <b>橡皮</b>）</> : null}，可以低于海面。整片地面往下沉，盆心被泥沙填平，盆缘的山脊与谷照旧留着。盆里成外流湖、咸湖还是盐滩由水量定（光标移到盆上读得到），与海之间没有高过海面的陆地隔着就被海灌进。同一处再涂＝改成新的盆底、不累加，涂在画过的山上＝改成盆地；<kbd>E</kbd> 切橡皮、<kbd>[ ]</kbd> 调大小。松笔后约一秒解出盆形{mode === "all" ? <>，侵蚀计算再补细节（进度见顶栏）</> : null}。地貌按新的高度重判，寻路随之变；视野、火力与雷达圈按新地势重算。</div>
            </>
          ) : (
            <>
          <div class="sec" style={{ marginTop: "4px" }}>目标峰高<span class="mini">画山 · 地貌与寻路随山变</span></div>
          <div class="chips">
            {UPLIFT_PEAKS_M.map(v => (
              <button key={v} class="ch tr" aria-pressed={!brushEraseSig.value && pk === v} onClick={() => { upliftPeakMSig.value = v; brushEraseSig.value = false; }}>{v}m</button>
            ))}
            <input class="fld" type="number" min={1} max={DH_MAX_M} step={100} value={pk} style={{ width: "6em" }} aria-label="目标峰高（米）"
              onChange={e => {
                const el = e.currentTarget as HTMLInputElement, v = Math.round(+el.value);
                if (v > 0 && v <= DH_MAX_M) { upliftPeakMSig.value = v; brushEraseSig.value = false; } else el.value = String(upliftPeakMSig.peek());
              }} />
          </div>
          <div class="hint">按住拖动把一片地画成山：每片连着的涂抹区里最高的那处长到所选峰高{brushEraseSig.value ? <>（现为 <b>橡皮</b>）</> : null}，山脊、支谷与山麓由生成器的流程长出来，山体宽窄随涂抹区。同一处再涂＝改成新的峰高、不累加；<kbd>E</kbd> 切橡皮（连旧的手雕高程一起擦）、<kbd>[ ]</kbd> 调大小。松笔后约一秒解出山形{mode === "all" ? <>，侵蚀计算再补沟谷细节（进度见顶栏）</> : null}。峰高指解出来的山顶；读数与标高点按格平滑，读到的数会比所选峰高略低，格子越粗低得越多。地貌按解出的高度重判（高处成山地、高山），寻路随之变；视野、火力与雷达圈按新地势重算。</div>
            </>
          )}
        </>
      ) : (
        <>
          {/* 幅度分档（2026-08-10 精度批，用户点单）：战术 1m 起精雕、战略 10m 起粗塑；米数经
              elevUnitM 折成抽象 dh（pointer.terrainDab）。档表按图种取＝换图自动换排 */}
          <div class="sec" style={{ marginTop: "4px" }}>幅度<span class="mini">只改高低 · 不改地貌与寻路</span></div>
          <div class="chips">
            {scaleProfile(meta).heightStepsM.map(v => (
              <button key={v} class="ch tr" aria-pressed={stepM === v} onClick={() => { heightStepMSig.value = v; }}>±{v}m</button>
            ))}
          </div>
          <div class="hint">高程画笔：按住拖动{brushEraseSig.value ? <b>▼ 下切</b> : <b>▲ 抬升</b>}地势（每笔 ±{stepM}m，可反复叠加；<kbd>E</kbd> 换向、<kbd>[ ]</kbd> 调大小）。山峰/棱线/凹路皆可雕；开「等高线」图层看效果。地貌与寻路不变，视野、火力与雷达圈按新地势重算。水域恒平、陆地不跌成滩涂。{mode === "all" ? <>笔画即时可见；松笔后侵蚀计算约需一至三秒把草稿冲出沟谷（进度见顶栏），等高线与读数都取自计算后的地势。</> : <>笔落即最终，等高线与读数随笔即变。</>}</div>
        </>
      )}
      {axis !== "clim" && <ErodeCtx />}
    </>
  );
}

/** 地形页底部的侵蚀一行（地貌 / 生态 / 高程三页共用）：手动档给「侵蚀」按钮，其余两档只说现在是哪一档、去哪改 */
function ErodeCtx() {
  const world = worldSig.value!, mode = erodeMode(world.meta);
  if (mode !== "base") return (
    <div class="hint">{mode === "all"
      ? <>侵蚀计算为<b>自动</b>：每次涂改后整图重算，松笔后地形还会再变一下。要笔落即最终，在设置里把「侵蚀计算」改成<b>手动</b>。</>
      : <>侵蚀计算已<b>关闭</b>：地形不细分、不刻沟谷，笔落即最终。可在设置里改。</>}</div>
  );
  const pend = erodePending(world), busy = erodePhaseSig.value === "work";
  return (
    <>
      <div class="sec" style={{ marginTop: "4px" }}>侵蚀<span class="mini">手动 · 笔落即最终</span></div>
      <button type="button" class="bt tr" id="erodeNow" disabled={!pend || busy}
        title={busy ? "侵蚀计算中…" : pend ? "把现在的涂改收进底图，整图重算一遍侵蚀（可撤销）" : "没有还没收进底图的涂改"}
        onClick={() => {
          mutateWorld(w => { foldIntoErosion(w); }, { grid: true });
          showToast("已把涂改收进底图，整图重算侵蚀（进度见顶栏）", { undo: true });
        }}>⛰ 侵蚀</button>
      <div class="hint">涂改叠在侵蚀过的地形上，画成什么样就是什么样，不会自己再变；新画的山与洼地没有沟谷。点<b>侵蚀</b>把现在的涂改收进底图、整图重算一遍（进度见顶栏，一步可撤销）；{pend ? "有涂改还没收进底图。" : "眼下没有未收进底图的涂改。"}</div>
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
          <span key={a.id} class={"stamp tr" + (!erase && kind === "img:" + a.id ? " on" : "")}>
            <button type="button" class="main tr" title={a.name || "印章"} aria-pressed={!erase && kind === "img:" + a.id} onClick={() => pick("img:" + a.id)}>
              <img src={a.src} alt="" />
            </button>
            <button type="button" class="del tr" title="从常用移除（不删已落的章）" onClick={() => poolRemove(a.id)}>✕</button>
          </span>
        ))}
        <label class="stamp add tr" title="上传图片当印章（自动缩到 256px、随本图导出/分享）">＋
          <input type="file" accept="image/*" style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }} onChange={upload} /></label>
      </div>
      <div class="hint">点<b>印章</b>放置、点<b>橡皮</b>通用擦除 · 点放或按住播撒成林/成岭 · <kbd>[ ]</kbd>调大小 · <kbd>Alt</kbd>+点取样 · 右键删单个 · 自定义印章存进本图、随导出/分享</div>
    </>
  );
}

/** 地点（点）：落点**类别**预选 chips（2026-07-30 由 16 个类型收成 4 类——一排全铺认不过来）。
    落的是该类默认型，具体型在检查器表单里改（那儿的下拉只列本类）。
    事件/标注不入四类：事件走表单「▽ 在此地新增事件点」、标注有专属「注」子工具 */
function AddCtx() {
  const cat = nodeCatOf(addTypeSig.value);
  return (
    <>
      <div class="chips">
        {NODE_CAT_ORDER.map(k => (
          <button key={k} class="ch tr" aria-pressed={cat === k}
            title={NODE_CATS[k].types.map(t => NODE_STYLE[t].名).join(" / ")}
            onClick={() => { addTypeSig.value = NODE_CATS[k].def; }}>
            {NODE_STYLE[NODE_CATS[k].def].sym}{NODE_CATS[k].名}
          </button>
        ))}
      </div>
      <div class="hint">落点为该类默认型「{NODE_STYLE[addTypeSig.value]?.名 || "城市"}」，具体类型在检查器表单里改</div>
    </>
  );
}

/** 连线（线）：类型选择 + 起点状态（对齐旧 link 面板）。战术图不供商路（战场图上是战略语汇噪音;
    残留选中态由 boot 的守卫 effect 回落 road,与军工具非战术回落同规） */
function LinkCtx() {
  const world = worldSig.value!;
  const tac = isTacSig.value;
  const linkFrom = linkFromSig.value;
  const fromNode = linkFrom ? world.nodes.find(n => n.id === linkFrom) : null;
  return (
    <>
      <div class="chips">
        {(Object.keys(EDGE_STYLE) as Edge["type"][]).filter(tp => tp !== "trade" || !tac).map(tp => (
          <button key={tp} class="ch tr" aria-pressed={linkTypeSig.value === tp} onClick={() => pickLinkType(tp)}>
            <span class="sw" style={{ background: EDGE_STYLE[tp].color, borderRadius: "2px", height: "4px" }} />{EDGE_STYLE[tp].名}
          </button>
        ))}
      </div>
      <div class="hint">{linkTypeSig.value === "river"
        ? <>河流＝<b>自由画河</b>：图上按住<b>拖动</b>画出河道（不必锚地点）· 右键/Esc 取消 · 画完在检查器改名/水面宽/时段 · 改道＝删了重画</>
        : linkTypeSig.value === "wall"
        ? <>工事＝<b>自由画线</b>：图上按住<b>拖动</b>画出壁垒/长城/堑壕/岸线（不必锚地点）· 右键/Esc 取消 · 检查器改名/时段/翻转齿面 · 改线＝删了重画</>
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
        {sub === "add" && <>先选类型、点空白落点（缺省城市）；改名/归属/沿革在检查器表单（事件点＝落点后类型下拉换「事件」，标注走「注」子工具）</>}
        {sub === "label" && <>点空白＝落自由文本标注（钟点/风向/兵力/争议注记…），检查器改 多行文本/字号/派系色/屏幕角固定，可配 ⏳时段分相位显示</>}
        {sub === "unit" && <>兵棋部队：军面板<b>「＋ 新增部队」</b>先入列表（未入场），按住列表项<b>拖入地图放置</b>；按住图上部队<b>拖动＝记录当日位置</b>（先把时间轴拖到目标日）；同日重拖＝改写航点；<b>Shift+拖</b>＝框选；<kbd>Delete</kbd>＝删部队</>}
        {sub === "terrain" && <>各页分开涂：🗺地貌／🌿生态（随笔落布景印章）／⛰高程＝抬升·下切（<kbd>E</kbd> 换向）{isTacSig.value ? null : <>／气候（只改配色、林线与雪线）</>}</>}
        {sub === "link" && <>选类型：河流/工事＝自由画线（拖动，不必锚地点）· 道路/商路＝地点连地点</>}
        {sub === "paint" && <>笔刷直涂派系疆域（优先于据点凸包）· 橡皮＝反涂 · 开涂自动建层</>}
        {sub === "decor" && <>9 印章 · 点放或按住播撒 · 右键删单个 · <kbd>Alt</kbd>+点取样</>}
      </div>
      {sub === "add" && <AddCtx />}
      {sub === "paint" && <PaintCtx />}
      {sub === "terrain" && <TerrainCtx />}
      {sub === "decor" && <DecorCtx />}
      {sub === "link" && <LinkCtx />}
      {["add", "link", "terrain", "decor", "label"].includes(sub) && <EraCtx sub={sub} />}
      <div class="hint">改动<b>自动保存</b>到浏览器存档；「导出」才写回 JSON 文件</div>
    </>
  );
}
