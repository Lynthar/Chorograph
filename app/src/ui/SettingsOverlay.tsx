/* 设置弹层（UI 1:1 还原 v0.14 #settings；2026-08-13 尺度定形批改「创建时定形」）：
   两种模式（对齐旧 settingsMode）：
   · app＝改当前世界参数——**尺度冻结**：世界形态/星球半径/每度里程/经纬范围（战术=中心+直径）
     创建后锁定（同「历法结构创建后锁定」的先例与 UI 语言），此处只读摘要；可改的只剩
     名称/地形初稿/地势起伏/纪元前缀/库名与数据区。要改尺寸走「以此参数新建」＝带当前参数
     预填打开创建分支（创建时才是谈判尺寸的时刻）。
   · create＝从图库新建（隐藏数据区与应用钮）；带**实时尺度读数**（格边/最小笔刷/档数——
     物理在创建那一刻可见、可谈、然后定死，与「地势定形」同一个可读性哲学）。
   卡片以 token 为 key 整体重挂=每次打开重灌表单。 */
import { useRef, useState } from "preact/hooks";
import { blankWorld, clampWorldBBox, WORLD_KM_PER_DEG, WORLD_RADIUS_KM, type BlankWorldSpec } from "../core/world.ts";
import { blankTacticalWorld, TAC_DIA_KM, type BlankTacSpec } from "../core/tactical.ts";
import { calOf, parseYearForm } from "../core/calendar.ts";
import { DEFAULT_BBOX } from "../core/types.ts";
import type { CalendarCfg, GenStyle, Meta, TerrainMode, WorldModel } from "../core/types.ts";
import { gridStepDeg } from "../core/grid.ts";
import { kmPerDeg, flatKmPerDeg } from "../core/geo.ts";
import { brushRadiusCells, brushActualKm, fmtBrushKm, BRUSH_NOTCHES } from "../core/brush.ts";
import { calOverlaySig, calTemplatesSig, closeSettings, isTacSig, libActionsSig, mutateWorld, settingsSig, setUiPrefs, showToast, uiPrefsSig, worldSig, type SettingsMode } from "./state.ts";
import { pickCalendarCfg } from "../data/calstore.ts";
import { useModalFocus } from "./modal.ts";

const randSeed = () => Math.floor(Math.random() * 99999) + 1;

/** 一份 meta 的笔刷兑现读数（创建面板实时行与 app 摘要共用）：格边/最小档实得/互异档数 */
function brushReadout(mm: Meta): { cellKm: number; minKm: number; distinct: number } {
  const cellKm = gridStepDeg(mm) * kmPerDeg(mm);
  const rs = new Set<number>();
  for (let n = 1; n <= BRUSH_NOTCHES; n++) rs.add(brushRadiusCells(mm, "terrain", n));
  return { cellKm, minKm: brushActualKm(mm, "terrain", brushRadiusCells(mm, "terrain", 1)), distinct: rs.size };
}

function SettingsCard({ mode, from }: { mode: SettingsMode; from?: Meta }) {
  const create = mode === "create";
  const world = worldSig.value;
  const m = (!create && world && world.meta) || {};
  /* 预填源：app=当前图 meta;create=「以此参数新建」带来的 meta（普通新建为空） */
  const base: Meta | null = create ? (from || null) : m;
  const acts = libActionsSig.value;
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(box);   // 卡片按 key={token} 每次打开重挂＝进场收焦点、关闭时还原（父件 st 为 null 时整件卸载）
  const fileRef = useRef<HTMLInputElement>(null);
  /* 地形初稿联动（对齐旧 syncTerrDraftUI）：仅 auto 显示生成参数行；旧初稿只有正用时显形。
     ⚠ 未知/旧 id（如改名前的示例大陆）一律归 "sample"＝与 seedTerrain 的兜底分派同判——
     否则四个单选无一命中，readSettings 落回 "auto"，「打开设置只调起伏点应用」就把整块大陆
     静默换成随机种子的程序化地形（真实存档踩到，同 sw_relief 首项抹值之症） */
  const [terr, setTerr] = useState<string>(base
    ? (["auto", "plain", "island", "sample"].includes(base.terrain as string) ? base.terrain as string : "sample")
    : "auto");
  /* 纪年历法（双轨）：create 可选 架空自定义/真实地球；既有图锁定（改 kind/月长会错位已存日戳），纪元前缀可改 */
  /* 历法自 2026-08-19 改「选模板」：下拉值＝earth / default（内置 12×30，缺省不落盘）/ 模板 id。
     架空历法的细节在图库页「📅 历法」里编，那里才有月名、逐月月长、一日的时与分这些。 */
  /* ⚠ 「以此参数新建」带进来的历法必须有个自己的选项：档外值在下拉里无一命中＝浏览器选首项，
     于是「以此参数新建」会把原图的历法静默换成默认 12×30（同 sw_relief 抹值那一类坑，见表单坑位）。 */
  const baseCalKeep = create && base && base.calendar && (base.calendar.kind !== "earth")
    && Object.keys(pickCalendarCfg(base.calendar)).length > 0;
  const [calSel, setCalSel] = useState<string>(
    create && base && (base.calendar || {}).kind === "earth" ? "earth" : (baseCalKeep ? "keep" : "default"));
  const calKind = calSel === "earth" ? "earth" : "custom";
  /* 新建的图种（柱B）：战略图（世界/疆域，按年）／战术战场（一战，按日与时，**恒平面**） */
  const [tacNew, setTacNew] = useState(create && !!base && base.mapKind === "tactical");
  /* 实时尺度读数的重算扳机（表单非受控,onInput 冒泡到卡片容器时 bump 一下） */
  const [, setRoTick] = useState(0);
  const bumpRo = () => setRoTick(t => t + 1);
  /* —— 数值框离焦即钳并**说出来**（2026-08-19 用户实报「直径仍能填很大的数，没有任何提示和限制，
     还能输入数字之外的字符」）——
     ⚠ HTML 的 `min/max` 只管校验与微调按钮，**拦不住键入**；而 `type=number` 打不进合法值时
     `.value` 恒是空串（判据只能是 `validity.badInput`，同「数值字段的静默变形要报回执」之规）。
     此前两条都只在建图那一刻由 core 的钳兜住＝用户填 9999 却拿到 140，全程零反馈。
     现在：change（离焦/回车）即把合法值写回输入框，并在尺度读数下方留一句 ⚠ 回执。
     ⚠ 挂 change 不挂 input——逐键钳会让「140」在敲到「1」时就跳成 20。 */
  const [numWarn, setNumWarn] = useState("");
  /* 世界形态改受控（2026-08-20）：形态决定哪一行出现，非受控 radio 拿不到「刚切过去」那一帧。
     战术分支恒平面，故有效形态＝tacNew ? flat : model。 */
  const [model, setModel] = useState<WorldModel>((base?.worldModel === "flat" ? "flat" : "sphere") as WorldModel);
  const snapNum = (lo: number, hi: number, dflt: number, 名: string, unit = "") =>
    (e: Event): void => {
      const el = e.currentTarget as HTMLInputElement;
      let v = parseFloat(el.value), msg = "";
      if (el.validity.badInput || !isFinite(v)) { v = dflt; msg = `${名}只收数字，已回到 ${dflt}${unit}`; }
      else if (v < lo || v > hi) {
        const c = Math.min(hi, Math.max(lo, v));
        msg = `${名} ${v}${unit} 超出 ${lo}~${hi}${unit}，已钳到 ${c}${unit}`;
        v = c;
      }
      el.value = String(v);
      setNumWarn(msg);
      bumpRo();
    };
  /** 经纬四框是**一体**的（跨度红线管的是两两之差），故一处改动即整框过 clampWorldBBox 再写回 */
  const snapBox = (): void => {
    const el = box.current;
    if (!el) return;
    const g = (id: string, dflt: number): number => {
      const i = el.querySelector<HTMLInputElement>("#" + id)!;
      const v = parseFloat(i.value);
      return i.validity.badInput || !isFinite(v) ? dflt : v;
    };
    const model = ((el.querySelector('[name=sw_model]:checked') as HTMLInputElement | null)?.value || "sphere") as WorldModel;
    const raw = { lonMin: g("sw_lonmin", +d.lonMin), lonMax: g("sw_lonmax", +d.lonMax), latMin: g("sw_latmin", +d.latMin), latMax: g("sw_latmax", +d.latMax) };
    const c = clampWorldBBox(model, raw);
    let changed = false;
    for (const k of ["lonMin", "lonMax", "latMin", "latMax"] as const) {
      const i = el.querySelector<HTMLInputElement>("#sw_" + k.toLowerCase())!;
      if (+i.value !== c[k] || i.validity.badInput) changed = true;
      i.value = String(c[k]);
    }
    setNumWarn(changed ? `经纬范围已钳到 ${model === "flat" ? "平面上限（经跨 3600、纬跨 1700，与导入闸同线）" : "球面物理域（纬 ±90、经跨 ≤360）"}` : "");
    bumpRo();
  };
  const curCal = calOf(m.calendar);
  /* 地势起伏的当前档：纯新建缺省 0.7、带预填/既有图取存档值（缺键=0=无）——档位落在 option 的 selected 上 */
  const relCur = create ? (base ? (base.relief != null ? +base.relief : 0) : 0.7) : (m.relief != null ? +m.relief : 0);
  const bb = (base && base.bbox) || { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 };
  const d = base
    ? { 名称: base.名称 || "新地图", model: base.worldModel || "sphere", radius: base.planetRadiusKm != null ? base.planetRadiusKm : 10000,
        kmdeg: base.kmPerDeg != null ? String(base.kmPerDeg) : "", lonMin: bb.lonMin, lonMax: bb.lonMax, latMin: bb.latMin, latMax: bb.latMax,
        genStyle: base.genStyle === "archipelago" ? "archipelago" : "continent", genSeed: (base.genSeed as number | 0) || randSeed(), vault: base.vault || "" }
    : { 名称: "新地图", model: "sphere", radius: 10000, kmdeg: "", lonMin: 82, lonMax: 130, latMin: 22, latMax: 54,
        genStyle: "continent", genSeed: randSeed(), vault: String((worldSig.value?.meta || {}).vault || "") };
  /* 战术分支预填（「以此参数新建」自战术图进来）：中心=图幅中心、直径=纬跨×每度里程 */
  const tacPre = base && base.mapKind === "tactical" && base.bbox
    ? { clon: +((base.bbox.lonMin + base.bbox.lonMax) / 2).toFixed(3), clat: +((base.bbox.latMin + base.bbox.latMax) / 2).toFixed(3),
        dia: Math.max(TAC_DIA_KM[0], Math.min(TAC_DIA_KM[1], Math.round((base.bbox.latMax - base.bbox.latMin) * kmPerDeg(base)))) }
    : { clon: 114, clat: 38, dia: 20 };
  /* 平面世界的每度里程预填与留空兜底：既有档带了就用它，否则按预填半径换算——这正是原先
     「留空＝按半径换算 2πR/360」那条**隐藏**兜底，半径行在平面下不再出现，故把它显式摆出来。 */
  const flatKmDefault = +(2 * Math.PI * (+d.radius || 10000) / 360).toFixed(2);
  const kmdegPre = d.kmdeg || String(flatKmDefault);

  const q = <T extends HTMLElement>(sel: string) => box.current!.querySelector<T>(sel)!;
  /* readSettings 只在 create 模式调用（app 模式的尺度行是只读文本,q() 会因行不渲染而崩——
     旧「display:none 僵尸输入」的续命法随冻结一起退役） */
  const readSettings = (): BlankWorldSpec => {
    /* ⚠ 行可能没渲染（形态互斥的那半边、战术分支的经纬四框）：一律「不在就退回预填值」，
       不再靠 display:none 的僵尸输入撑住 querySelector!。 */
    const num = (id: string, dflt: number) => {
      const el = box.current!.querySelector<HTMLInputElement>("#" + id);
      const v = el ? parseFloat(el.value) : NaN;
      return isFinite(v) ? v : dflt;
    };
    let lonMin = num("sw_lonmin", +d.lonMin), lonMax = num("sw_lonmax", +d.lonMax),
      latMin = num("sw_latmin", +d.latMin), latMax = num("sw_latmax", +d.latMax);
    if (lonMax <= lonMin) lonMax = lonMin + 10;   // 倒置＝当没填（钳只保底不猜意图）
    if (latMax <= latMin) latMax = latMin + 10;
    const mdl: WorldModel = tacNew ? "flat" : model;          // 战场恒平面
    const kmdegEl = box.current!.querySelector<HTMLInputElement>("#sw_kmdeg");
    const kmdegRaw = kmdegEl ? kmdegEl.value.trim() : "";
    const spec: BlankWorldSpec = {
      名称: q<HTMLInputElement>("#sw_name").value.trim() || "未命名世界",
      worldModel: mdl,
      /* 形态互斥＝只落该形态真读的那一项：球面只落半径（kmPerDeg 全仓一处不读）、平面只落每度里程。
         ⚠ 战术分支不渲染每度里程行，取预填 d.kmdeg——「以此参数新建」自战场进来时要把 111.19 带过去；
         预填为空即 null＝blankTacticalWorld 用它自己的缺省。 */
      planetRadiusKm: mdl === "sphere" ? Math.max(100, num("sw_radius", +d.radius)) : undefined,
      kmPerDeg: mdl === "sphere" ? null
        : kmdegEl ? (kmdegRaw === "" ? flatKmDefault : Math.max(1, parseFloat(kmdegRaw) || flatKmDefault))
          : (d.kmdeg ? Math.max(1, parseFloat(d.kmdeg) || 111) : null),
      /* 尺寸硬上限走 core.clampWorldBBox 单一真源（blankWorld 里还会再钳一道＝幂等）：
         此处先钳，是为了让下面那行实时尺度读数报的就是**真会建出来的**那张图 */
      bbox: clampWorldBBox(mdl, { lonMin, lonMax, latMin, latMax }),
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
      const v = kindEl.value;
      if (v === "earth") spec.calendar = { kind: "earth" };
      else if (v === "keep") { const c = pickCalendarCfg((base && base.calendar) || {}); if (Object.keys(c).length) spec.calendar = c; }
      else if (v !== "default") {
        /* 模板整份拷进 meta.calendar 并就此冻结——之后改模板不追改已建的图（历法一改，
           已存日戳全要重释）。空配置（等于内置默认）照旧不落盘，保持旧档形状。 */
        const t = calTemplatesSig.peek().find(x => x.id === v);
        const c = t ? pickCalendarCfg(t.cfg) : {};
        if (Object.keys(c).length) spec.calendar = c;
      }
    }
    return spec;
  };
  /* 应用到当前世界（app 模式）：只写**未冻结**的参数——名称/地形初稿/起伏/纪元前缀/库名。
     尺度（形态/半径/每度里程/范围）创建后锁定,此处一律不读不写；旧「改范围→拆分涂改→视图
     回中」链随之退役（splitOverridesToStep 已删）。 */
  const apply = () => {
    mutateWorld(w => {
      const mm = w.meta;
      mm.名称 = q<HTMLInputElement>("#sw_name").value.trim() || "未命名世界";
      mm.terrain = (((box.current!.querySelector('[name=sw_terr]:checked') as HTMLInputElement | null)?.value) || "auto") as TerrainMode;
      if (mm.terrain === "auto") {
        mm.genSeed = Math.max(1, parseInt(q<HTMLInputElement>("#sw_genseed").value, 10) || randSeed());
        mm.genStyle = (q<HTMLSelectElement>("#sw_genstyle").value === "archipelago" ? "archipelago" : "continent") as GenStyle;
      } else { delete mm.genSeed; delete mm.genStyle; }
      const vault = q<HTMLInputElement>("#sw_vault").value.trim();
      if (vault) mm.vault = vault; else delete mm.vault;
      const relEl = box.current!.querySelector<HTMLSelectElement>("#sw_relief");
      if (relEl) { const r = parseFloat(relEl.value) || 0; if (r > 0) mm.relief = r; else delete mm.relief; }   // 地势起伏（渲染层，可随时改）
      /* 纪元前缀（custom 既有图可改，纯显示层；kind/月长锁定不动）。默认 SE 不落盘 */
      const eraEl = box.current!.querySelector<HTMLInputElement>("#sw_era_app");
      if (eraEl) {
        const ev = eraEl.value.trim();
        const cc = { ...(mm.calendar || {}) } as CalendarCfg;
        if (ev && ev !== "SE") cc.era = ev; else delete cc.era;
        if (Object.keys(cc).length) mm.calendar = cc; else delete mm.calendar;
      }
    }, { grid: true });
    closeSettings();
    showToast("已应用到当前世界", { undo: true });
  };
  /* 战术战场参数（仅 create + 战术分支）：中心经纬 + 直径 + 战役年份 + 等高距。
     ⚠ 战场恒平面：不再收世界形态/星球半径;每度里程缺省 111.19（core 兜底） */
  const readTacSettings = (): BlankTacSpec => {
    const s = readSettings();
    const num = (id: string, dflt: number) => { const v = parseFloat(q<HTMLInputElement>("#" + id).value); return isFinite(v) ? v : dflt; };
    const cal = calOf(s.calendar);
    const yr = parseYearForm(cal, q<HTMLInputElement>("#sw_byear").value);
    const cm = num("sw_contourm", 0);
    return {
      名称: s.名称, kmPerDeg: s.kmPerDeg,
      lon: num("sw_clon", 114), lat: num("sw_clat", 38),
      diaKm: num("sw_dia", 20),
      battleYear: yr == null ? 0 : yr,
      calendar: s.calendar, terrain: s.terrain, genSeed: s.genSeed, genStyle: s.genStyle,
      relief: s.relief, contourM: cm > 0 ? cm : undefined, vault: s.vault
    };
  };
  const doNew = () => {
    if (!create) {
      /* 以此参数新建＝换到 create 模式并带当前图 meta 预填（token +1＝卡片整体重挂重灌表单）。
         尺寸在创建表单里可改——「创建时决定」的另一半：这里才是谈判尺寸的地方。 */
      settingsSig.value = { mode: "create", token: ((settingsSig.peek() || { token: 0 }).token) + 1, from: { ...m } };
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const w = tacNew ? blankTacticalWorld(readTacSettings(), today) : blankWorld(readSettings(), today);
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
      showToast(`已按种子 ${seed} 重生成地形`, { undo: true });   // 与「应用」同回执（此前静默）
    }
  };
  /* app 模式的尺度摘要（只读;边长按纬跨×每度里程＝两种世界模型同式） */
  const scaleDesc = (): string => {
    const b = m.bbox || DEFAULT_BBOX;
    const ro = brushReadout(m);
    if (m.mapKind === "tactical") {
      const side = Math.round((b.latMax - b.latMin) * kmPerDeg(m));
      return `${m.worldModel === "flat" ? "平面战场" : "球面战场（旧档）"} · 边长≈${side} km · 格边 ${fmtBrushKm(ro.cellKm)}`;
    }
    const md = m.worldModel === "flat" ? `平面 · 每度 ${Math.round(flatKmPerDeg(m))} km` : `球面 · 半径 ${m.planetRadiusKm != null ? m.planetRadiusKm : 10000} km`;
    return `${md} · 经度 ${b.lonMin}~${b.lonMax}° · 纬度 ${b.latMin}~${b.latMax}° · 格边 ${fmtBrushKm(ro.cellKm)}`;
  };
  /* create 模式的实时尺度读数：格边/最小笔刷/档数——从当前表单值合成 meta 现算（纯函数现成）。
     首帧 box 未挂,退回 d 默认值。 */
  const readoutText = (): string => {
    const gv = (id: string, dflt: number): number => {
      const el = box.current?.querySelector<HTMLInputElement>("#" + id);
      const v = el ? parseFloat(el.value) : NaN;
      return isFinite(v) ? v : dflt;
    };
    if (tacNew) {
      const dia = Math.max(TAC_DIA_KM[0], Math.min(TAC_DIA_KM[1], gv("sw_dia", tacPre.dia)));
      return `平面战场 · 边长 ${dia} km ⇒ 网格 ${Math.round(dia * 10)}×${Math.round(dia * 10)} · 格边恒 100 m · 笔刷 32 档全兑现（100 m → 20 km）· 直径上限 ${TAC_DIA_KM[1]} km`;
    }
    /* 形态取受控 state（半径/每度里程两行按形态互斥出场，DOM 里只会有其中一个） */
    const kmdegEl = box.current?.querySelector<HTMLInputElement>("#sw_kmdeg");
    const kmdegRaw = kmdegEl ? kmdegEl.value.trim() : "";
    const mm: Meta = {
      worldModel: model,
      planetRadiusKm: Math.max(100, gv("sw_radius", +d.radius)),
      bbox: clampWorldBBox(model,
        { lonMin: gv("sw_lonmin", +d.lonMin), lonMax: gv("sw_lonmax", +d.lonMax), latMin: gv("sw_latmin", +d.latMin), latMax: gv("sw_latmax", +d.latMax) })
    };
    if (model === "flat") mm.kmPerDeg = kmdegRaw === "" ? flatKmDefault : Math.max(1, parseFloat(kmdegRaw) || flatKmDefault);
    if (!(mm.bbox!.lonMax > mm.bbox!.lonMin)) mm.bbox!.lonMax = mm.bbox!.lonMin + 10;
    if (!(mm.bbox!.latMax > mm.bbox!.latMin)) mm.bbox!.latMax = mm.bbox!.latMin + 10;
    const ro = brushReadout(mm);
    return `格边 ${fmtBrushKm(ro.cellKm)} · 最小笔刷实得 ${fmtBrushKm(ro.minKm)} · ${ro.distinct}/32 档` +
      (ro.distinct < BRUSH_NOTCHES ? "——图幅超出承诺域（宽 ≤约 1.39 万 km 且面积 ≤约 9000 万 km² 内 32 档全兑现），格被放粗、相邻档并档" : "");
  };

  /* 本机偏好三行（主题/密度/出图图例）：app 模式照旧在顶部；create 模式后置到「纪年历法」
     之后（2026-08-26）——新建流程先谈世界参数，本机偏好排在首屏徒增首次决策负担。 */
  const uiP = uiPrefsSig.value;
  const prefsBlock = (
    <>
      <h4 style={{ margin: "10px 0 4px" }}>界面（本机偏好，不入存档）</h4>
      <div class="setrow"><label>主题</label>
        <div class="seg">
          <button type="button" class={"tbtn" + (uiP.theme === "light" ? " on" : "")} aria-pressed={uiP.theme === "light"} onClick={() => setUiPrefs({ theme: "light" })}>亮 · 素笺</button>
          <button type="button" class={"tbtn" + (uiP.theme === "dark" ? " on" : "")} aria-pressed={uiP.theme === "dark"} onClick={() => setUiPrefs({ theme: "dark" })}>暗 · 漆</button>
        </div>
      </div>
      <div class="setrow"><label>密度</label>
        <div class="seg">
          <button type="button" class={"tbtn" + (uiP.den === "loose" ? " on" : "")} aria-pressed={uiP.den === "loose"} onClick={() => setUiPrefs({ den: "loose" })}>浏览 · 松</button>
          <button type="button" class={"tbtn" + (uiP.den === "tight" ? " on" : "")} aria-pressed={uiP.den === "tight"} onClick={() => setUiPrefs({ den: "tight" })}>兵棋 · 紧</button>
        </div>
      </div>
      <div class="setrow"><label>出图图例</label>
        <label><input type="checkbox" checked={uiP.legend !== false}
          onChange={e => setUiPrefs({ legend: (e.currentTarget as HTMLInputElement).checked })} /> 战术图导出附图例块（派系·兵种·状态，右下角）</label>
      </div>
    </>
  );
  return (
    <div class="modal" ref={box} role="dialog" aria-modal="true" aria-labelledby="setTitle" tabIndex={-1}>
      <div class="mo-head">
        <span class="t" id="setTitle">{create ? "🆕 新建地图" : "⚙ 设置"}</span>
        <span class="s">{create ? (tacNew ? "先定战场位置与尺度" : "先定世界形态与尺度") : "界面偏好 · 世界参数 · 数据与出图"}</span>
        <button class="x tr" aria-label="关闭" onClick={closeSettings}>✕</button>
      </div>
      <div class="mo-body" onInput={bumpRo}>
      {!create && prefsBlock}
      <h4 style={{ margin: "12px 0 4px" }}>世界参数</h4>
      {create && (
        <div class="setrow"><label>地图种类</label>
          <div class="seg">
            <button type="button" class={"tbtn" + (tacNew ? "" : " on")} aria-pressed={!tacNew} onClick={() => setTacNew(false)}>🗺 战略图（世界·按年）</button>
            <button type="button" class={"tbtn" + (tacNew ? " on" : "")} aria-pressed={tacNew} onClick={() => setTacNew(true)}>⚔ 战术战场（一战·按日与时）</button>
          </div>
          <span class="sub">战场＝以一点为心的<b>平面</b>方图（战场尺度曲率无意义），时间轴细到日与时，兵棋与公里网随之开启；更大的战区请用战略图（20km 起步的笔刷语汇）</span>
        </div>
      )}
      {/* 换图种即换默认名（key 换＝重挂）：战场叫「新地图」与标签打架；已输入的名字让位于图种切换 */}
      <div class="setrow"><label>{create && tacNew ? "战场名称" : "地图名称"}</label>
        <input type="text" id="sw_name" class="wide" key={create && tacNew ? "tacname" : "name"}
          defaultValue={create && tacNew ? (base && base.mapKind === "tactical" ? d.名称 : "新战场") : d.名称} /></div>
      {!create && (
        /* —— 尺度冻结摘要（app 模式）：同「历法结构创建后锁定」之例——待决的是身份不是参数 —— */
        <div class="setrow"><label>世界尺度</label>
          <span class="sub">{scaleDesc()} ——<b>创建后锁定</b>（尺寸与分辨率是图的身份;要改尺寸用下方「🆕 以此参数新建地图」）</span>
        </div>
      )}
      {/* 形态相关行（2026-08-20 用户点单「不同形态显示不同设置项」）：**球面出星球半径、平面出每度里程**——
          两者本就互斥（球面的里程只由半径定、kmPerDeg 一处不读；平面只认 kmPerDeg），原先并列同屏、
          各在 sub 里写着「球面用/平面用」，填了不生效的那半边就是静默无效输入。
          ⚠ 行**真删**、不留 display:none 僵尸输入（那条老办法随尺度冻结已退役），故 readSettings 与
          readoutText 一律「行不在就用预填值」。战术分支恒平面且 bbox 由中心＋直径推出，整块不出。 */}
      {create && !tacNew && (
        <>
          <div class="setrow"><label>世界形态</label>
            <label><input type="radio" name="sw_model" value="sphere" checked={model === "sphere"} onChange={() => { setModel("sphere"); bumpRo(); }} /> 球面星球（大圆距离）</label>
            <label><input type="radio" name="sw_model" value="flat" checked={model === "flat"} onChange={() => { setModel("flat"); bumpRo(); }} /> 平面·天圆地方（直线距离）</label>
          </div>
          {model === "sphere"
            ? <div class="setrow"><label>星球半径 km</label><input type="number" id="sw_radius" min={WORLD_RADIUS_KM[0]} max={WORLD_RADIUS_KM[1]} step={100} defaultValue={String(d.radius)}
                onChange={snapNum(WORLD_RADIUS_KM[0], WORLD_RADIUS_KM[1], 10000, "星球半径", " km")} /><span class="sub">大圆距离与每度里程都由它定。第一世界地球≈6371；钳 {WORLD_RADIUS_KM[0]}~{WORLD_RADIUS_KM[1]}</span></div>
            : <div class="setrow"><label>每度里程 km/°</label><input type="number" id="sw_kmdeg" min={WORLD_KM_PER_DEG[0]} max={WORLD_KM_PER_DEG[1]} step={1} defaultValue={kmdegPre}
                onChange={e => { const el = e.currentTarget as HTMLInputElement; if (el.value.trim() === "") { setNumWarn(""); bumpRo(); return; } snapNum(WORLD_KM_PER_DEG[0], WORLD_KM_PER_DEG[1], 111, "每度里程", " km")(e); }} /><span class="sub">平面世界一度折多少公里——直线距离与格边都由它定。地球口径 111.19；留空＝{kmdegPre}</span></div>}
          <div class="setrow"><label>经度范围 °</label><input type="number" id="sw_lonmin" step={1} defaultValue={String(d.lonMin)} onChange={snapBox} /> ~ <input type="number" id="sw_lonmax" step={1} defaultValue={String(d.lonMax)} onChange={snapBox} /></div>
          <div class="setrow"><label>纬度范围 °</label><input type="number" id="sw_latmin" step={1} defaultValue={String(d.latMin)} onChange={snapBox} /> ~ <input type="number" id="sw_latmax" step={1} defaultValue={String(d.latMax)} onChange={snapBox} /><span class="sub">决定地形网格边界（创建后锁定）。{model === "sphere" ? "球面钳在纬 ±90、经跨 ≤360" : "平面的度是自由标尺，钳在导入闸的红线上（经跨 3600、纬跨 1700）"}</span></div>
        </>
      )}
      {create && tacNew && (
        <>
          {/* 图库新建＝独立战场（2026-08-19 用户拍板）：想要跟随战略图历法与位置的战场，路径收窄到
              「战略图内选中战役事件点 → ⚔ 生成战术图」一条——那里才看得见母图的经纬度。 */}
          <div class="setrow"><label>关联</label>
            <span class="sub">此处建的是<b>独立战场</b>，历法与年份自成一套。要让战场跟随某张战略图的历法与位置，请在那张战略图里选中战役事件点、点「⚔ 生成战术图」。</span></div>
          <div class="setrow"><label>战场中心 °</label>
            <input type="number" id="sw_clon" min={-360} max={360} step={0.001} defaultValue={String(tacPre.clon)} title="中心经度（东经为正）"
              onChange={snapNum(-360, 360, 114, "中心经度", "°")} /> ,
            <input type="number" id="sw_clat" min={-85} max={85} step={0.001} defaultValue={String(tacPre.clat)} title="中心纬度（北纬为正）"
              onChange={snapNum(-85, 85, 38, "中心纬度", "°")} />
            <span class="sub">图幅正中那一点的经纬度。它定两件事：地形初稿取自程序化世界的哪一块、本图的经纬度读数与量距基准；与真实地理无关就随手填（战场恒平面，纬度不再影响格子形状）</span></div>
          <div class="setrow"><label>战场直径 km</label>
            <input type="number" id="sw_dia" min={TAC_DIA_KM[0]} max={TAC_DIA_KM[1]} step={1} defaultValue={String(tacPre.dia)}
              onChange={snapNum(TAC_DIA_KM[0], TAC_DIA_KM[1], 60, "战场直径", " km")} />
            <span class="sub">图幅边长（钳 {TAC_DIA_KM[0]}~{TAC_DIA_KM[1]}，对角线红线 200km）；野战 15~40、会战 40~120</span></div>
          <div class="setrow"><label>战役年份</label>
            <input type="text" id="sw_byear" defaultValue="" placeholder={calKind === "earth" ? "如 前204 / 1815" : "如 3107"} />
            <span class="sub">时间轴锚在这一年的日戳区间；细节日期落图后在时间轴上拨</span></div>
          <div class="setrow"><label>最细等高距 米</label>
            <input type="number" id="sw_contourm" min={0} step={5} defaultValue={base && base.contourM != null ? String(base.contourM) : ""} placeholder="留空＝10" />
            <span class="sub">等高线的最细一档；平原战场 10、山地战场 50~100</span></div>
        </>
      )}
      <div class="setrow"><label>地形初稿</label>
        <label><input type="radio" name="sw_terr" value="auto" defaultChecked={terr === "auto"} onChange={() => setTerr("auto")} /> 自动生成</label>
        <label><input type="radio" name="sw_terr" value="plain" defaultChecked={terr === "plain"} onChange={() => setTerr("plain")} /> 空白平原</label>
        {terr === "sample" && <label><input type="radio" name="sw_terr" value="sample" defaultChecked onChange={() => setTerr("sample")} /> 示例大陆</label>}
        {terr === "island" && <label><input type="radio" name="sw_terr" value="island" defaultChecked onChange={() => setTerr("island")} /> 四海环岛</label>}
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
        {/* ⚠ 初值必须落在 option 的 selected 上（同 sw_genstyle / ef_fs 之法）：核心 Preact 只在
            `name in dom` 时写属性，而 HTMLSelectElement **没有** defaultValue——单靠它会落成惰性
            attribute、选中项永远停在首项「无」，于是「打开设置什么都不改点应用」就把这张图的
            地势起伏静默抹掉并落盘（三张示例图全是 0.7）。 */}
        <select id="sw_relief">
          {/* 手编档的档外值另立一项（同 ef_fs 之法）：否则无一 option 命中＝浏览器选首项，一点「应用」照样抹掉 */}
          {![0, 0.35, 0.7, 1].includes(relCur) && <option value={String(relCur)} selected>{relCur}（自定义）</option>}
          {[["0", "无（示意高程：同类地形等高，旧观感）"], ["0.35", "柔和"], ["0.7", "自然"], ["1", "险峻"]].map(([v, 名]) => (
            <option key={v} value={v} selected={+v === relCur}>{名}</option>
          ))}
        </select>
        <span class="sub">山有高低、等高线成形；编辑→地形→⛰高程 可再手工雕琢。随时可改，不动数据。</span>
      </div>
      {/* 网格密度不是设置项（2026-08-12 作者裁定强制自动;2026-08-13 起创建时按 core/grid.autoGridN
          解算并**盖章进 meta.gridN**＝图的身份）——「格边随图幅走」是算出来的,不是选出来的。 */}
      {create && (
        <>
          <div class="setrow"><label>尺度读数</label>
            <span class="sub"><b>{readoutText()}</b></span>
          </div>
          {numWarn && <div class="setrow"><label></label>
            <span class="sub" style={{ color: "var(--q-zhu)" }}>⚠ {numWarn}</span></div>}
        </>
      )}
      <div class="setrow"><label>纪年历法</label>
        {create ? (
          <>
            {/* ⚠ 选中态落在 option 的 selected 上：核心 Preact 的 <select defaultValue> 不生效（见令牌/表单坑位） */}
            <select id="sw_calkind" onChange={e => setCalSel((e.currentTarget as HTMLSelectElement).value)}>
              {baseCalKeep && <option value="keep" selected={calSel === "keep"}>沿用原图的历法</option>}
              <option value="default" selected={calSel === "default"}>默认架空历法（12 月 × 30 日）</option>
              {calTemplatesSig.value.map(t => (
                <option key={t.id} value={t.id} selected={calSel === t.id}>{t.名称}</option>
              ))}
              <option value="earth" selected={calSel === "earth"}>真实地球历法（公元）</option>
            </select>
            <button type="button" class="tbtn" title="自定义架空历法（月名/月长/每日时数）并命名存下"
              onClick={() => { calOverlaySig.value = true; }}>📅 编辑历法…</button>
          </>
        ) : (curCal.kind === "earth"
          ? <span class="sub">真实地球历法（公元；儒略≤1582-10-04 / 格里≥10-15）——创建后锁定</span>
          : <>
              <span class="sub">架空 {curCal.months}月×{curCal.lens ? "逐月不等" : curCal.dpm + "日"}{curCal.names ? " · 有月名" : ""}{curCal.hpd !== 24 || curCal.mph !== 60 ? ` · 一日${curCal.hpd}时×${curCal.mph}分` : ""} · 纪元</span>
              <input type="text" id="sw_era_app" style={{ width: "4.5em" }} title="纪元前缀（仅显示用，可随时改）" defaultValue={curCal.era} />
              <span class="sub">（历法结构创建后锁定）</span>
            </>)}
      </div>
      {create && <div class="setrow"><label></label><span class="sub">真实历法=公元纪年（输入「前216」表公元前）、真实月长与闰年、1582 儒略→格里切换，战术图日程用真实日期。架空历法在「📅 历法」里自定月数/月长/月名/每日时数并命名存下，此处直接选用。<b>历法在创建后锁定</b>（更改会错位已保存的日戳）。</span></div>}
      {create && prefsBlock}
      <div class="setrow"><label>Obsidian 库名</label><input type="text" id="sw_vault" class="wide" defaultValue={d.vault} /><span class="sub">双链直开用</span></div>
      {!create && (
        <div id="setDataSec">
          <h4 style={{ margin: "14px 0 4px" }}>数据文件与出图</h4>
          <div class="seg">
            <button type="button" class="tbtn" title="导入 JSON 数据文件，替换当前地图内容（可撤销）" onClick={() => fileRef.current?.click()}>📂 导入 JSON</button>
            <button type="button" class="tbtn" title="导出当前数据为 JSON" onClick={() => acts?.exportCurrent()}>💾 导出 JSON</button>
            <button type="button" class="tbtn" title="把当前视图导出为 PNG 图片" onClick={() => acts?.exportPng()}>📷 出图 PNG</button>
            {isTacSig.value && <button type="button" class="tbtn" title="按「览 → 相位」清单逐相位各出一张 PNG（当前视角与图层；浏览器会请求一次连续下载授权）" onClick={() => acts?.exportFrames()}>🎞 分帧出图</button>}
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
      {!create && <div class="hint">「应用」保留全部地点/派系/战役数据，只改可变参数；尺寸与分辨率创建后锁定——「🆕 以此参数新建」带当前参数打开创建面板，在那里改尺寸开一张新图（当前图原样保留，随时从「⌂ 图库」回来）。</div>}
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
      <SettingsCard key={st.token} mode={st.mode} from={st.from} />
    </div>
  );
}
