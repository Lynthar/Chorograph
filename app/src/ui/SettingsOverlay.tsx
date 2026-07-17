/* 设置弹层（UI 1:1 还原 v0.14 #settings）：世界参数（名称/形态/尺度/范围/地形初稿/库名）
   + 数据文件与出图（导入替换/导出 JSON/出图 PNG/重置示例）。
   两种模式（对齐旧 settingsMode）：app=改当前世界参数（应用即重算里程/重建地形）；
   create=从地图库新建（隐藏数据区与应用钮）。卡片以 token 为 key 整体重挂=每次打开重灌表单。 */
import { useRef, useState } from "preact/hooks";
import { blankWorld, type BlankWorldSpec } from "../core/world.ts";
import { calOf } from "../core/calendar.ts";
import type { CalendarCfg, GenStyle, TerrainMode, WorldModel } from "../core/types.ts";
import { closeSettings, flyReqSig, libActionsSig, mutateWorld, settingsSig, setUiPrefs, showToast, uiPrefsSig, worldSig, type SettingsMode } from "./state.ts";

const randSeed = () => Math.floor(Math.random() * 99999) + 1;

function SettingsCard({ mode }: { mode: SettingsMode }) {
  const create = mode === "create";
  const world = worldSig.value;
  const m = (!create && world && world.meta) || {};
  const acts = libActionsSig.value;
  const box = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /* 地形初稿联动（对齐旧 syncTerrDraftUI）：仅 auto 显示生成参数行；旧初稿只有正用时显形 */
  const [terr, setTerr] = useState<string>(create ? "auto" : (m.terrain || "sample"));
  /* 纪年历法（双轨）：create 可选 架空自定义/真实地球；既有图锁定（改 kind/月长会错位已存日戳），纪元前缀可改 */
  const [calKind, setCalKind] = useState<string>("custom");
  const curCal = calOf(m.calendar);
  const bb = m.bbox || { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 };
  const d = create
    ? { 名称: "新地图", model: "sphere", radius: 10000, kmdeg: "", lonMin: 82, lonMax: 130, latMin: 22, latMax: 54,
        genStyle: "continent", genSeed: randSeed(), vault: String((worldSig.value?.meta || {}).vault || "") }
    : { 名称: m.名称 || "", model: m.worldModel || "sphere", radius: m.planetRadiusKm != null ? m.planetRadiusKm : 10000,
        kmdeg: m.kmPerDeg != null ? String(m.kmPerDeg) : "", lonMin: bb.lonMin, lonMax: bb.lonMax, latMin: bb.latMin, latMax: bb.latMax,
        genStyle: m.genStyle === "archipelago" ? "archipelago" : "continent", genSeed: (m.genSeed as number | 0) || randSeed(), vault: m.vault || "" };

  const q = <T extends HTMLElement>(sel: string) => box.current!.querySelector<T>(sel)!;
  const readSettings = (): BlankWorldSpec => {
    const num = (id: string, dflt: number) => { const v = parseFloat(q<HTMLInputElement>("#" + id).value); return isFinite(v) ? v : dflt; };
    let lonMin = num("sw_lonmin", 82), lonMax = num("sw_lonmax", 130), latMin = num("sw_latmin", 22), latMax = num("sw_latmax", 54);
    if (lonMax <= lonMin) lonMax = lonMin + 10;
    if (latMax <= latMin) latMax = latMin + 10;
    const kmdegRaw = q<HTMLInputElement>("#sw_kmdeg").value.trim();
    const spec: BlankWorldSpec = {
      名称: q<HTMLInputElement>("#sw_name").value.trim() || "未命名世界",
      worldModel: ((box.current!.querySelector('[name=sw_model]:checked') as HTMLInputElement | null)?.value || "sphere") as WorldModel,
      planetRadiusKm: Math.max(100, num("sw_radius", 10000)),
      kmPerDeg: kmdegRaw === "" ? null : Math.max(1, parseFloat(kmdegRaw) || 175),
      bbox: { lonMin, lonMax, latMin, latMax },
      terrain: (((box.current!.querySelector('[name=sw_terr]:checked') as HTMLInputElement | null)?.value) || "auto") as TerrainMode,
      genStyle: (q<HTMLSelectElement>("#sw_genstyle").value === "archipelago" ? "archipelago" : "continent") as GenStyle,
      genSeed: Math.max(1, parseInt(q<HTMLInputElement>("#sw_genseed").value, 10) || randSeed()),
      vault: q<HTMLInputElement>("#sw_vault").value.trim() || undefined
    };
    /* 地势起伏：0=无（不落盘）；两模式都有选择器 */
    const relEl = box.current!.querySelector<HTMLSelectElement>("#sw_relief");
    if (relEl) spec.relief = parseFloat(relEl.value) || 0;
    /* 历法（仅 create 模式有选择器）：全默认（custom·SE·12×30）不落盘，保持旧档形状 */
    const kindEl = box.current!.querySelector<HTMLSelectElement>("#sw_calkind");
    if (kindEl) {
      if (kindEl.value === "earth") spec.calendar = { kind: "earth" };
      else {
        const era = q<HTMLInputElement>("#sw_era").value.trim();
        const months = Math.max(1, parseInt(q<HTMLInputElement>("#sw_calm").value, 10) || 12);
        const dpm = Math.max(1, parseInt(q<HTMLInputElement>("#sw_cald").value, 10) || 30);
        const c: CalendarCfg = {};
        if (months !== 12) c.months = months;
        if (dpm !== 30) c.dpm = dpm;
        if (era && era !== "SE") c.era = era;
        if (Object.keys(c).length) spec.calendar = c;
      }
    }
    return spec;
  };
  /* 应用到当前世界（对齐旧 swApply）：改 meta 参数 + 重建地形；视图中心落在新范围外→回中 */
  const apply = () => {
    const s = readSettings();
    mutateWorld(w => {
      const mm = w.meta;
      mm.名称 = s.名称; mm.worldModel = s.worldModel; mm.planetRadiusKm = s.planetRadiusKm;
      if (s.kmPerDeg == null) delete mm.kmPerDeg; else mm.kmPerDeg = s.kmPerDeg;
      mm.bbox = s.bbox; mm.terrain = s.terrain;
      if (s.terrain === "auto") { mm.genSeed = s.genSeed; mm.genStyle = s.genStyle; } else { delete mm.genSeed; delete mm.genStyle; }
      if (s.vault) mm.vault = s.vault; else delete mm.vault;
      if (s.relief != null) { if (s.relief > 0) mm.relief = s.relief; else delete mm.relief; }   // 地势起伏（渲染层，可随时改）
      /* 纪元前缀（custom 既有图可改，纯显示层；kind/月长锁定不动）。默认 SE 不落盘 */
      const eraEl = box.current!.querySelector<HTMLInputElement>("#sw_era_app");
      if (eraEl) {
        const ev = eraEl.value.trim();
        const cc = { ...(mm.calendar || {}) } as CalendarCfg;
        if (ev && ev !== "SE") cc.era = ev; else delete cc.era;
        if (Object.keys(cc).length) mm.calendar = cc; else delete mm.calendar;
      }
      const v = mm.view || { lon0: NaN, lat0: NaN };
      if (!(v.lon0 >= s.bbox.lonMin && v.lon0 <= s.bbox.lonMax && v.lat0 >= s.bbox.latMin && v.lat0 <= s.bbox.latMax)) {
        mm.view = { lon0: (s.bbox.lonMin + s.bbox.lonMax) / 2, lat0: (s.bbox.latMin + s.bbox.latMax) / 2,
          degPerPx0: Math.max(0.004, Math.min(0.5, (s.bbox.lonMax - s.bbox.lonMin) / 900)) };
        flyReqSig.value = { lon: mm.view.lon0, lat: mm.view.lat0, degPerPx: mm.view.degPerPx0 };
      }
    }, { grid: true });
    closeSettings();
    showToast("已应用到当前世界 · 视图出界自动回中", { undo: true });
  };
  const doNew = () => {
    if (!create && !confirm("以当前参数新建一张空白地图？\n当前地图原样保留在地图库（顶栏 ⌂）中。")) return;
    const w = blankWorld(readSettings(), new Date().toISOString().slice(0, 10));
    closeSettings();
    acts?.createWorld(w);
  };
  /* 换一换（对齐旧 swReroll）：随机新种子；当前图正用 auto 则即时重算预览（可撤销） */
  const reroll = () => {
    const el = q<HTMLInputElement>("#sw_genseed");
    el.value = String(randSeed());
    if (!create && (worldSig.peek()?.meta || {}).terrain === "auto") {
      const seed = Math.max(1, parseInt(el.value, 10) || 1);
      const style = (q<HTMLSelectElement>("#sw_genstyle").value === "archipelago" ? "archipelago" : "continent") as GenStyle;
      mutateWorld(w => { w.meta.genSeed = seed; w.meta.genStyle = style; }, { grid: true });
    }
  };

  return (
    <div class="modal" ref={box}>
      <div class="mo-head">
        <span class="t">{create ? "🆕 新建地图" : "⚙ 设置"}</span>
        <span class="s">{create ? "先定世界形态与尺度" : "界面偏好 · 世界参数 · 数据与出图"}</span>
        <button class="x tr" aria-label="关闭" onClick={closeSettings}>✕</button>
      </div>
      <div class="mo-body">
      {(() => { const p = uiPrefsSig.value; return (
        <>
          <h4 style={{ margin: "10px 0 4px" }}>界面（本机偏好，不入存档）</h4>
          <div class="setrow"><label>主题</label>
            <div class="seg">
              <button type="button" class={"tbtn" + (p.theme === "light" ? " on" : "")} aria-pressed={p.theme === "light"} onClick={() => setUiPrefs({ theme: "light" })}>亮 · 素笺</button>
              <button type="button" class={"tbtn" + (p.theme === "dark" ? " on" : "")} aria-pressed={p.theme === "dark"} onClick={() => setUiPrefs({ theme: "dark" })}>暗 · 漆</button>
            </div>
          </div>
          <div class="setrow"><label>密度</label>
            <div class="seg">
              <button type="button" class={"tbtn" + (p.den === "loose" ? " on" : "")} aria-pressed={p.den === "loose"} onClick={() => setUiPrefs({ den: "loose" })}>浏览 · 松</button>
              <button type="button" class={"tbtn" + (p.den === "tight" ? " on" : "")} aria-pressed={p.den === "tight"} onClick={() => setUiPrefs({ den: "tight" })}>兵棋 · 紧</button>
            </div>
          </div>
          <h4 style={{ margin: "12px 0 4px" }}>世界参数</h4>
        </>
      ); })()}
      <div class="setrow"><label>地图名称</label><input type="text" id="sw_name" class="wide" defaultValue={d.名称} /></div>
      <div class="setrow"><label>世界形态</label>
        <label><input type="radio" name="sw_model" value="sphere" defaultChecked={d.model === "sphere"} /> 球面星球（大圆距离）</label>
        <label><input type="radio" name="sw_model" value="flat" defaultChecked={d.model === "flat"} /> 平面·天圆地方（直线距离）</label>
      </div>
      <div class="setrow"><label>星球半径 km</label><input type="number" id="sw_radius" min={100} step={100} defaultValue={String(d.radius)} /><span class="sub">球面用。第一世界地球≈6371</span></div>
      <div class="setrow"><label>每度里程 km/°</label><input type="number" id="sw_kmdeg" min={1} step={1} defaultValue={d.kmdeg} /><span class="sub">平面用。留空=按半径换算(2πR/360)</span></div>
      <div class="setrow"><label>经度范围 °</label><input type="number" id="sw_lonmin" step={1} defaultValue={String(d.lonMin)} /> ~ <input type="number" id="sw_lonmax" step={1} defaultValue={String(d.lonMax)} /></div>
      <div class="setrow"><label>纬度范围 °</label><input type="number" id="sw_latmin" step={1} defaultValue={String(d.latMin)} /> ~ <input type="number" id="sw_latmax" step={1} defaultValue={String(d.latMax)} /><span class="sub">决定地形网格边界</span></div>
      <div class="setrow"><label>地形初稿</label>
        <label><input type="radio" name="sw_terr" value="auto" defaultChecked={terr === "auto"} onChange={() => setTerr("auto")} /> 自动生成</label>
        <label><input type="radio" name="sw_terr" value="plain" defaultChecked={terr === "plain"} onChange={() => setTerr("plain")} /> 空白平原</label>
        {!create && terr === "sample" && <label><input type="radio" name="sw_terr" value="sample" defaultChecked onChange={() => setTerr("sample")} /> 示例大陆</label>}
        {!create && terr === "island" && <label><input type="radio" name="sw_terr" value="island" defaultChecked onChange={() => setTerr("island")} /> 四海环岛</label>}
      </div>
      <div class="setrow" id="swGenRow" style={{ display: terr === "auto" ? "flex" : "none" }}><label>生成参数</label>
        <select id="sw_genstyle" title="大陆=单块居中大陆；群岛=四海散岛" defaultValue={d.genStyle}>
          <option value="continent" selected={d.genStyle === "continent"}>大陆</option>
          <option value="archipelago" selected={d.genStyle === "archipelago"}>群岛</option>
        </select>
        <input type="number" id="sw_genseed" min={1} step={1} style={{ width: "6.5em" }} title="随机种子——同一种子永远生成同一块大陆" defaultValue={String(d.genSeed)} />
        <button type="button" class="tbtn" title="随机换一个种子，生成另一块大陆" onClick={reroll}>⟳ 换一换</button>
      </div>
      <div class="setrow"><label></label><span class="sub">「自动生成」按种子程序化生成海岸线/山川/生态；初稿只是底子——编辑模式可继续涂改，已涂改的格子(terrainOverrides)始终保留其上。</span></div>
      <div class="setrow"><label>地势起伏</label>
        <select id="sw_relief" defaultValue={String(create ? 0.7 : (m.relief != null ? m.relief : 0))}>
          <option value="0">无（示意高程：同类地形等高，旧观感）</option>
          <option value="0.35">柔和</option>
          <option value="0.7">自然</option>
          <option value="1">险峻</option>
        </select>
        <span class="sub">山有高低、等高线成形；编辑→地形→⛰高程 可再手工雕琢。随时可改，不动数据。</span>
      </div>
      <div class="setrow"><label>纪年历法</label>
        {create ? (
          <>
            <select id="sw_calkind" defaultValue="custom" onChange={e => setCalKind((e.currentTarget as HTMLSelectElement).value)}>
              <option value="custom">架空历法（自定义）</option>
              <option value="earth">真实地球历法（公元）</option>
            </select>
            {calKind === "custom" && (
              <>
                <input type="text" id="sw_era" style={{ width: "4.5em" }} title="纪元前缀（如 SE）" defaultValue="SE" />
                <input type="number" id="sw_calm" min={1} step={1} style={{ width: "4em" }} title="每年月数" defaultValue="12" />月 ×
                <input type="number" id="sw_cald" min={1} step={1} style={{ width: "4em" }} title="每月日数" defaultValue="30" />日
              </>
            )}
          </>
        ) : (curCal.kind === "earth"
          ? <span class="sub">真实地球历法（公元；儒略≤1582-10-04 / 格里≥10-15）——创建后锁定</span>
          : <>
              <span class="sub">架空 {curCal.months}月×{curCal.dpm}日 · 纪元</span>
              <input type="text" id="sw_era_app" style={{ width: "4.5em" }} title="纪元前缀（仅显示用，可随时改）" defaultValue={curCal.era} />
              <span class="sub">（历法结构创建后锁定）</span>
            </>)}
      </div>
      {create && <div class="setrow"><label></label><span class="sub">真实历法=公元纪年（输入「前216」表公元前）、真实月长与闰年、1582 儒略→格里切换，战术图日程用真实日期；架空历法自定纪元/月数/月长。<b>历法在创建后锁定</b>（更改会错位已保存的日戳）。</span></div>}
      <div class="setrow"><label>Obsidian 库名</label><input type="text" id="sw_vault" class="wide" defaultValue={d.vault} /><span class="sub">双链直开用</span></div>
      {!create && (
        <div id="setDataSec">
          <h4 style={{ margin: "14px 0 4px" }}>数据文件与出图</h4>
          <div class="seg">
            <button type="button" class="tbtn" title="导入 JSON 数据文件，替换当前地图内容（可撤销）" onClick={() => fileRef.current?.click()}>📂 导入 JSON</button>
            <button type="button" class="tbtn" title="导出当前数据为 JSON" onClick={() => acts?.exportCurrent()}>💾 导出 JSON</button>
            <button type="button" class="tbtn" title="把当前视图导出为 PNG 图片" onClick={() => acts?.exportPng()}>📷 出图 PNG</button>
            <button type="button" class="tbtn" title="把当前地图内容重置为内置示例数据（可撤销）" onClick={() => acts?.resetToSample()}>↺ 重置为内置示例</button>
            <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }}
              onChange={async e => {
                const el = e.currentTarget as HTMLInputElement;
                const f = el.files && el.files[0];
                el.value = "";
                if (!f) return;
                try { acts?.replaceCurrent(JSON.parse(await f.text()), f.name); closeSettings(); }
                catch (err) { alert("JSON 解析失败：" + (err as Error).message); }
              }} />
          </div>
          <div class="hint">改动自动保存到本图的浏览器存档（保存态见顶栏）；「导出」才写回 .json 文件。此处「导入」替换当前图的内容——若想保留当前图，请回「⌂ 图库」用「📂 导入 JSON 为新图」。</div>
        </div>
      )}
      {!create && <div class="hint">「应用」保留全部地点/派系/战役数据，只改参数；「🆕 新建」在图库里开一张新的空白地图——当前图原样保留，随时从「⌂ 图库」回来。</div>}
      </div>
      <div class="mo-foot">
        <button class="bt ghost tr" onClick={closeSettings}>{create ? "取消" : "关闭"}</button>
        <span class="sp" />
        {create
          ? <button class="bt zhu tr" onClick={doNew}>✔ 创建此地图</button>
          : <>
              <button class="bt tr" onClick={doNew}>🆕 以此参数新建地图</button>
              <button class="bt zhu tr" onClick={apply}>✔ 应用到当前世界</button>
            </>}
      </div>
    </div>
  );
}

export function SettingsOverlay() {
  const st = settingsSig.value;
  if (!st) return null;
  return (
    <div id="settings" class="scrim open"
      onClick={e => { if (e.target === e.currentTarget) closeSettings(); }}>
      <SettingsCard key={st.token} mode={st.mode} />
    </div>
  );
}
