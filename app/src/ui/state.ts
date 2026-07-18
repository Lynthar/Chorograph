/* 应用共享状态（@preact/signals）：面板与画布外壳共同读写的低频全局态。
   刻意不进 signals 的：相机 view（拖拽每帧变化，rAF 直读普通对象）、网格 grid。
   本模块是纯 .ts（node:test 可测）；组件 .tsx 的正确性走截图目检——
   Node 的类型剥离不转 JSX，测试层只测状态逻辑，是既定分界。

   编辑管线：一切改动经 mutateWorld（先快照进撤销栈，改完浅拷贝换引用
   通知订阅者，editVer++ 驱动外壳自动保存与寻路上下文重发；grid 标记驱动网格重建）。 */
import { batch, computed, effect, signal } from "@preact/signals";
import { LAYERS, PRESETS } from "../core/constants.ts";
import { yearRangeOf } from "../core/time.ts";
import { normalizeWorld } from "../core/world.ts";
import { createHistory, terrKey } from "./history.ts";
import type { ComputedRoute, RoutePoint } from "../core/route.ts";
import type { Leg } from "../core/units.ts";
import type { Arm, Edge, Faction, Op, TerrainId, Unit, World, WorldNode } from "../core/types.ts";

/** 新壳已实现的图层子集（未实现的不出现在面板上）。units/trails/ranges/vision 为战术图专属（tacOnly） */
export const IMPL_LAYERS = ["terrain", "eco", "contour", "decor", "graticule", "politics", "range", "road", "river", "trade", "nodes", "labels", "notes", "events", "arrows", "units", "trails", "ranges", "vision"];

export const worldSig = signal<World | null>(null);
export const yearSig = signal(3107);
export const hoverSig = signal<WorldNode | null>(null);
export const layersSig = signal<Record<string, boolean>>(
  Object.fromEntries(LAYERS.filter(l => IMPL_LAYERS.includes(l.id)).map(l => [l.id, l.on])));

/* —— 选中：地点按 id（稳健）、连线按下标（删除后由清空兜底）、框选=地点 id 列表、部队按 id —— */
export type Sel = { kind: "node"; id: string } | { kind: "edge"; idx: number }
  | { kind: "faction"; id: string } | { kind: "multi"; ids: string[]; unitIds?: string[] } | { kind: "unit"; id: string } | null;
export const selSig = signal<Sel>(null);
export const selNode = (w: World | null, s: Sel): WorldNode | null =>
  (w && s && s.kind === "node" && w.nodes.find(n => n.id === s.id)) || null;
export const selEdge = (w: World | null, s: Sel): Edge | null =>
  (w && s && s.kind === "edge" && w.edges[s.idx]) || null;
export const selFaction = (w: World | null, s: Sel): Faction | null =>
  (w && s && s.kind === "faction" && w.factions.find(f => f.id === s.id)) || null;
export const selMulti = (w: World | null, s: Sel): WorldNode[] =>
  (w && s && s.kind === "multi") ? s.ids.map(id => w.nodes.find(n => n.id === id)).filter((n): n is WorldNode => !!n) : [];
export const selUnit = (w: World | null, s: Sel): Unit | null =>
  (w && s && s.kind === "unit" && (w.units || []).find(u => u.id === s.id)) || null;

/** 是否战术图（日戳时间轴 + 部队/射程层）——组件据此切换时间轴刻度、图层子集、编辑子工具 */
export const isTacSig = computed(() => (worldSig.value?.meta || {}).mapKind === "tactical");
/** 部队可达性预算缓存（外壳按网格/编辑版本重算填入；渲染层只读，帧内不算路）。键=部队 id */
export const unitLegsSig = signal<Map<string, Leg[]>>(new Map());

/** 战术图请求桥（组件→外壳）：InfoPanel 战役卡按钮设值，外壳 effect 消费做库链接/生成/导航
   （生成/打开涉及 IndexedDB/文件夹 IO，只能在外壳做；组件不碰库）。 */
export type TacReq = { type: "gen" | "open" | "parent"; evId?: string; dia?: number } | null;
export const tacReqSig = signal<TacReq>(null);

/** 视角跳转请求桥（组件→外壳）：事件时间线/搜索点选后要求相机移动（相机不是信号，外壳 effect 消费）。
   degPerPx=目标缩放；ifAbove 给定时仅当当前更缩小（degPerPx 更大）才应用（对齐旧 gotoResult 语义） */
export interface FlyReq { lon: number; lat: number; degPerPx?: number; ifAbove?: number }
export const flyReqSig = signal<FlyReq | null>(null);

/* —— 开始界面 · 图库（组件化：显示走 libViewSig 视图模型，操作经 libActionsSig 回外壳做 IO）——
   库的打开/迁移/自动保存/文件夹句柄全留外壳；组件（HomePanel）只渲染视图 + dispatch 动作。
   open=开始界面 #home 可见（v0.14：默认启动即进，深链直达地图；⌂ 图库/Esc 切换）。 */
export interface LibCounts { nodes?: number; factions?: number; events?: number; tac?: number; units?: number }
export interface LibEntry { id: string; name: string; counts?: LibCounts; updatedAt?: number; thumb?: string | null }
export interface LibView {
  available: boolean;                    // IndexedDB 打得开
  open: boolean;                         // 开始界面可见
  source: "browser" | "folder";
  folderName: string | null;
  fsSupported: boolean;                  // File System Access 可用（决定「链接文件夹」按钮）
  mapId: string | null;                  // 当前图（决定「↩ 返回当前地图」）
  entries: LibEntry[];
}
export const libViewSig = signal<LibView>({ available: false, open: false, source: "browser", folderName: null, fsSupported: false, mapId: null, entries: [] });
export interface LibActions {
  toggle(): void; open(id: string): void; remove(id: string): void;
  importFiles(files: File[]): void; exportCurrent(): void; newFromSample(): void;
  createWorld(w: World): void;                          // 设置弹层「创建此地图」→ 入库并打开
  replaceCurrent(json: unknown, srcName: string): void; // 设置弹层「导入 JSON」→ 替换当前图内容（可撤销）
  exportPng(): void;                                    // 设置弹层「出图 PNG」
  resetToSample(): void;                                // 设置弹层「重置为内置示例」
  linkFolder(): void; backToBrowser(): void;
}
export const libActionsSig = signal<LibActions | null>(null);

/* —— 弹层：帮助 / 设置（v0.14 .ovl；设置分 app=改当前世界参数 / create=新建地图）—— */
export const helpOpenSig = signal(false);
export type SettingsMode = "app" | "create";
/** token 每次打开 +1：设置卡以其为 key 整体重挂，实现旧版 fillSettings 的「每次打开重灌表单」 */
export const settingsSig = signal<{ mode: SettingsMode; token: number } | null>(null);
export function openSettings(mode: SettingsMode = "app"): void {
  settingsSig.value = { mode, token: ((settingsSig.peek() || { token: 0 }).token) + 1 };
}
export function closeSettings(): void {
  if (settingsSig.peek()) settingsSig.value = null;
}

/** 时间轴范围：随世界变化重算（year 用 peek——范围不因拖年份而变） */
export const rangeSig = computed(() => {
  const w = worldSig.value;
  if (!w) return { min: 2980, max: 3200 };
  const r = yearRangeOf(w, yearSig.peek());
  return { min: r.min, max: r.max };
});

/* —— 战术图时间步进粒度：日（默认，旧语义）｜时（半时辰=1/24 日；滑杆/播放/方向键共用）——
   小数日戳 core 原生支持（unitPos 连续插值、activeAt 连续比较），此处只是 UI 步长。 */
export const subDaySig = signal(false);
export function timeStep(): number { return isTacSig.peek() && subDaySig.peek() ? 1 / 24 : 1; }
/** 切回「日」粒度时把当前时刻落回整日（避免 +1 步在小数位上漂移） */
export function toggleSubDay(): void {
  batch(() => {
    subDaySig.value = !subDaySig.peek();
    if (!subDaySig.peek()) yearSig.value = Math.floor(yearSig.peek());
  });
}

/* —— 时间轴播放（对齐旧 togglePlay：300ms 一年/一日（时粒度=半时辰），到头自停；再按=暂停）—— */
export const playingSig = signal(false);
let playTimer: ReturnType<typeof setInterval> | null = null;
/** 停止播放（换图/撤销/回库共用——否则计时器继续推新世界的年份，见审计）。 */
export function stopPlay(): void {
  if (playTimer != null) { clearInterval(playTimer); playTimer = null; }
  if (playingSig.peek()) playingSig.value = false;
}
export function togglePlay(): void {
  if (playTimer != null) { stopPlay(); return; }
  const { min, max } = rangeSig.peek();
  batch(() => {
    if (yearSig.peek() >= max) yearSig.value = min;
    playingSig.value = true;
  });
  playTimer = setInterval(() => {
    if (yearSig.peek() >= rangeSig.peek().max) { togglePlay(); return; }
    yearSig.value = yearSig.peek() + timeStep();
  }, 300);
}

/* —— 撤销/重做 + 变更版本 —— */
const hist = createHistory();
export const canUndoSig = signal(false);
export const canRedoSig = signal(false);
/** 每次世界改动 +1（外壳订阅：自动保存 touch + 寻路上下文重发） */
export const editVerSig = signal(0);
/** 需要重建地形网格的改动 +1（terrainOverrides/meta 地形参数；撤销重做按 terrKey 判定） */
export const gridVerSig = signal(0);

function syncHistFlags(): void {
  batch(() => {
    canUndoSig.value = hist.canUndo();
    canRedoSig.value = hist.canRedo();
  });
}

/* —— 多信号赋值段一律 batch()：中间态不触发 effect（同类时序 bug 的结构性杜绝——
   「图库重开全平原」即「先设年份、effect 拿旧世界重建」这类中间态惹的祸）。
   注意 batch 冲刷是「后通知的 effect 先跑」，兄弟 effect 之间没有可依赖的次序——
   顺序敏感的反应已合并进 boot 的编排 effect（meta 同步→网格重建→legs 依内部语句序）。 —— */

/** 一切编辑的总入口：快照 → 原地改 → 浅拷贝换引用广播。opts.grid=改了地形（须重建网格） */
export function mutateWorld(fn: (w: World) => void, opts: { grid?: boolean } = {}): void {
  const w = worldSig.peek();
  if (!w) return;
  hist.push(w);
  fn(w);
  batch(() => {
    worldSig.value = { ...w };
    if (opts.grid) gridVerSig.value++;
    syncHistFlags();
    editVerSig.value++;
  });
}

/** 拖动等连续操作：起手 pushHistoryOnce 记一步，随后每帧 mutateWorldLive（不进撤销栈） */
export function pushHistoryOnce(): void {
  const w = worldSig.peek();
  if (!w) return;
  hist.push(w);
  syncHistFlags();
}
export function mutateWorldLive(fn: (w: World) => void | boolean): void {
  const w = worldSig.peek();
  if (!w) return;
  if (fn(w) === false) return;   // fn 显式返回 false=本次无实际改动（空笔），不广播、不 editVer++（不触发自动保存）
  batch(() => {
    worldSig.value = { ...w };
    editVerSig.value++;
  });
}

/* —— 笔刷描画的空步回收：起笔即 push 一步撤销，若整笔零广播（涂已涂格/擦空白）则丢弃那步空快照 —— */
let strokeVer = -1;
export function beginStroke(): void { pushHistoryOnce(); strokeVer = editVerSig.peek(); }
export function endStroke(): void {
  if (strokeVer >= 0 && editVerSig.peek() === strokeVer) { hist.dropLast(); syncHistFlags(); }
  strokeVer = -1;
}

function applyRestored(cur: World, snapshot: World): void {
  const restored = normalizeWorld(snapshot);
  const gridChanged = terrKey(cur) !== terrKey(restored);   // 地形没变就不重建（撤销秒回）
  batch(() => {
    stopPlay();                                            // 撤销/重做换世界：停播，避免计时器推新态
    selSig.value = null;                                    // 旧引用失效，与旧版一致
    routePtsSig.value = []; routeResSig.value = null;
    linkFromSig.value = null;
    cancelOpDraw(); clearOpSel();
    unitLegsSig.value = new Map();                          // 部队可达性缓存失效（外壳按新网格重算）
    worldSig.value = restored;
    yearSig.value = yearRangeOf(restored, yearSig.peek()).year;
    if (gridChanged) gridVerSig.value++;
    syncHistFlags();
    editVerSig.value++;
  });
}
export function undoWorld(): void {
  const cur = worldSig.peek();
  if (!cur) return;
  const s = hist.undo(cur);
  if (s) applyRestored(cur, s);
}
export function redoWorld(): void {
  const cur = worldSig.peek();
  if (!cur) return;
  const s = hist.redo(cur);
  if (s) applyRestored(cur, s);
}

/** 换世界：赋值 + 年份按新世界范围钳制 + 清撤销栈/选中/分析态（对应旧 enterWorld） */
export function setWorldState(w: World): void {
  batch(() => {
    stopPlay();                        // 换图：停播（覆盖战术图父子导航/replaceCurrent 等非 goHome 路径）
    hist.clear();
    syncHistFlags();
    selSig.value = null; hoverSig.value = null;
    routePtsSig.value = []; routeResSig.value = null;
    linkFromSig.value = null;
    cancelOpDraw(); clearOpSel();
    unitLegsSig.value = new Map();
    worldSig.value = w;
    yearSig.value = yearRangeOf(w, yearSig.peek()).year;
  });
}

/** 图层预设一键切换（未实现图层忽略） */
export function applyPreset(name: string): void {
  const p = PRESETS[name];
  if (!p) return;
  layersSig.value = Object.fromEntries(Object.keys(layersSig.peek()).map(id => [id, !!p[id]]));
}

export function toggleLayer(id: string, on: boolean): void {
  layersSig.value = { ...layersSig.peek(), [id]: on };
}

/* —— 模式（浏览/量距/行军/编辑）与编辑子工具 —— */
export type ShellMode = "browse" | "measure" | "route" | "edit";
export type EditSub = "select" | "add" | "link" | "paint" | "terrain" | "decor" | "label" | "unit" | "delete";
export const modeSig = signal<ShellMode>("browse");
export const editSubSig = signal<EditSub>("select");

/* —— 工具轨：览/测/绘/军 为 modeSig+editSubSig 的表现层映射，状态机语义不动 ——
   览→browse、测→measure|route（记住上次分析子工具）、绘→edit(非 unit 子工具)、军→edit+unit（仅战术图）。 */
export type RailTool = "browse" | "measure" | "draw" | "units";
/** 「测」记住上次用的分析子工具（对齐旧 modeBar 的 analysisSub 记忆；boot 的 effect 随 modeSig 同步） */
export const analysisSubSig = signal<"measure" | "route">("measure");
/** 抽屉「层」面开关（压过当前工具面；再点或切工具即回） */
export const layersOpenSig = signal(false);
/** 上下文抽屉展开/收起 */
export const drawerOpenSig = signal(true);
/** 当前模式/子工具对应的工具轨条目 */
export function railToolOf(m: ShellMode, sub: EditSub): RailTool {
  return m === "browse" ? "browse" : m === "edit" ? (sub === "unit" ? "units" : "draw") : "measure";
}
/** 点工具轨/按 1~4：切工具并关「层」、展开抽屉（对齐设计 setTool）。units 由调用方保证仅战术图。
    画线态（opDraw）是临时武装态：任何工具轨操作一律解除——绘↔军同为 edit 模式、setMode 早退不会代劳。 */
export function setRailTool(t: RailTool): void {
  batch(() => {
    layersOpenSig.value = false;
    drawerOpenSig.value = true;
    cancelOpDraw();
    if (t === "browse") setMode("browse");
    else if (t === "measure") setMode(analysisSubSig.peek());
    else if (t === "draw") { setMode("edit"); if (editSubSig.peek() === "unit") { editSubSig.value = "select"; clearOpSel(); } revealLayersFor(editSubSig.peek()); }
    else { setMode("edit"); if (editSubSig.peek() !== "unit") { editSubSig.value = "unit"; clearOpSel(); } revealLayersFor("unit"); }
  });
}

/** 切换绘子工具（stgrid 点击 / Shift+1~7 共用）：再点当前＝退回选择态；
    连带清理连线起点、作战线画线态与选中线（子工具语义互斥，残留即模式泄漏）。 */
export function pickEditSub(s: EditSub): void {
  batch(() => {
    const next: EditSub = editSubSig.peek() === s ? "select" : s;
    editSubSig.value = next;
    linkFromSig.value = null;
    cancelOpDraw(); clearOpSel();
    revealLayersFor(next);
  });
}

/** 子工具 → 产出所落图层：切入时若对应图层隐藏则自动打开——否则放置成「看不见的幽灵编辑」
    （拾取/擦除已按层门控，此处补放置侧）。label 要过 nodes 总门+notes 子门，两层都保；
    连线按当前线型落 road/river/trade（线型 id 与图层 id 同名）。 */
const SUB_LAYERS: Partial<Record<EditSub, string[]>> = {
  add: ["nodes"], paint: ["politics"], terrain: ["terrain"], decor: ["decor"],
  label: ["nodes", "notes"], unit: ["units"],
};
export function revealLayersFor(s: EditSub): void {
  const ids = s === "link" ? [linkTypeSig.peek()] : SUB_LAYERS[s];
  const cur = layersSig.peek();
  const off = (ids || []).filter(id => cur[id] === false);
  if (off.length) layersSig.value = { ...cur, ...Object.fromEntries(off.map(id => [id, true])) };
}

/** 连线线型切换：换型即把该型图层亮出来（与切子工具同一契约） */
export function pickLinkType(tp: Edge["type"]): void {
  batch(() => { linkTypeSig.value = tp; revealLayersFor("link"); });
}

/* —— 界面偏好：主题（亮·素笺默认/暗·漆）×密度（浏览·松/兵棋·紧）两轴。
   本机 localStorage 持久化、不入存档；boot 读写存储并把 data-theme/data-den 落到 #app。 —— */
export interface UiPrefs { theme: "light" | "dark"; den: "loose" | "tight" }
export const uiPrefsSig = signal<UiPrefs>({ theme: "light", den: "loose" });
export function setUiPrefs(p: Partial<UiPrefs>): void { uiPrefsSig.value = { ...uiPrefsSig.peek(), ...p }; }

/* —— toast：一次提交＝一步撤销的确认回执。错误一律朱、撤销键金（时间倒回语义）；
   停留 2.6s（Toast 组件计时）；action=逃生门动作（如保存失败→立即导出）。 —— */
export interface ToastMsg { text: string; err?: boolean; undo?: boolean; action?: { label: string; run(): void }; token: number }
export const toastSig = signal<ToastMsg | null>(null);
let toastToken = 0;
export function showToast(text: string, opts: { err?: boolean; undo?: boolean; action?: { label: string; run(): void } } = {}): void {
  toastSig.value = { text, ...opts, token: ++toastToken };
}

/* —— 图库开图加载舞台：朱印+图名+金进度+步骤行。library 开图流程步进
   0 读取存档→1 地形烘焙→2 时段过滤→3 泥金落款；null=关（LoadStage 组件自带淡出）。 —— */
export interface LoadStageState { name: string; step: number; renderer?: string }
export const loadStageSig = signal<LoadStageState | null>(null);

/* —— 检查器「随时编辑」：卡片「编辑」钮随时开表单，不再锁编辑模式
   （编辑模式下仍恒开表单=旧语义保留）；选中变化即退回卡片视图。 —— */
export const inspEditSig = signal(false);
/** 「选中变化即回卡片」的「变化」按语义比较：同目标重赋值（点同一地点、selectOp 保持事件选中）
    不打断进行中的表单编辑——否则浏览态表单里点作战线行会静默丢弃未保存输入（2026-07-12 P2）。 */
const selKeyOf = (s: Sel): string =>
  !s ? "" : s.kind === "edge" ? "edge:" + s.idx : s.kind === "multi" ? "multi:" + s.ids.join("|") + (s.unitIds && s.unitIds.length ? "|u:" + s.unitIds.join("|") : "") : s.kind + ":" + s.id;
let lastSelKey = "";
effect(() => {
  const k = selKeyOf(selSig.value);
  if (k !== lastSelKey) {
    lastSelKey = k;
    if (inspEditSig.peek()) inspEditSig.value = false;
  }
});
export const linkTypeSig = signal<Edge["type"]>("road");
export const linkFromSig = signal<string | null>(null);   // 连线工具：已选起点地点 id
export const armSig = signal<Arm>("land");
/* —— 派系涂域画笔 —— */
export const paintFactionSig = signal<string | null>(null);   // 涂给谁
export const paintLayerSig = signal(0);                       // 涂进第几个时段层
export const brushSizeSig = signal(3);                        // 半径=size-1 格（涂域/地形共用，1–12）
export const brushEraseSig = signal(false);
export const brushSmoothSig = signal(2);                      // 涂域边界平滑（Chaikin 轮数 0–3；笔刷框调）
/** 「⏳ 新对象时间段」（编辑左栏）：勾选后新画的地点/连线/布景/地形涂改带 since/until（对齐旧 eraNew） */
export const eraNewSig = signal<{ on: boolean; since: number | null; until: number | null }>({ on: false, since: null, until: null });
export const paintTerrainSig = signal<string>("water");       // 地形涂改：当前笔刷复合串（"地貌"/"地貌/生态"；两轴）
export const terrainHeightSig = signal(false);                // 地形子工具：false=生态类型 / true=高程起伏画笔
export const decorKindSig = signal<string>("tree");           // 布景：当前印章种类
export const decorSizeSig = signal(1);                        // 布景印章尺寸（0.5–2.5）
export const routePtsSig = signal<RoutePoint[]>([]);
export const routeResSig = signal<ComputedRoute | null>(null);
export const routeBusySig = signal(false);
/* —— 作战线（战役事件点 ops[]）：绘制态 + 选中态 —— */
export const opDrawSig = signal<{ evId: string; kind: Op["kind"] } | null>(null);   // 画线态：地图上按住拖一笔成线
export const opSelSig = signal<{ evId: string; i: number } | null>(null);           // 选中的作战线（悬浮框编辑）

/** 切换模式：清空分析拾取点与连线起点（外壳据 modeSig 切换点击语义与光标） */
export function setMode(m: ShellMode): void {
  if (modeSig.peek() === m) return;
  batch(() => {
    modeSig.value = m;
    routePtsSig.value = [];
    routeResSig.value = null;
    linkFromSig.value = null;
    cancelOpDraw(); clearOpSel();   // 离开编辑=退出画线/选中态
  });
}

/* —— 作战线编辑（对齐旧 startOpDraw/selectOp/clearOpSel/opEdit）——
   选中一条线时同时把其事件设为选中（selSig），线在非当年也随之可见（overlay 的 selId）；
   一次选中期间的多次改动合并为一步撤销（opDirty），与拖动同为 pushHistoryOnce + mutateWorldLive。 */
let opDirty = false;
/** 进入画线态（检查器「画攻势线/防线」按钮触发）：清掉当前选中 */
export function startOpDraw(evId: string, kind: Op["kind"]): void {
  clearOpSel();
  opDrawSig.value = { evId, kind };
}
export function cancelOpDraw(): void {
  if (opDrawSig.peek()) opDrawSig.value = null;
}
/** 选中一条作战线：开悬浮框，事件保持选中（线跨年可见） */
export function selectOp(evId: string, i: number): void {
  batch(() => {
    opDrawSig.value = null;
    opSelSig.value = { evId, i };
    selSig.value = { kind: "node", id: evId };
  });
  opDirty = false;
}
export function clearOpSel(): void {
  if (opSelSig.peek()) opSelSig.value = null;
  opDirty = false;
}
/** 编辑选中线的一个字段：首次改动记一步撤销，随后同一选中期间的改动实时广播但不再入栈 */
export function opEdit(fn: (op: Op) => void): void {
  const sel = opSelSig.peek();
  if (!sel || !worldSig.peek()) return;
  if (!opDirty) { pushHistoryOnce(); opDirty = true; }
  mutateWorldLive(w => {
    const ev = w.nodes.find(n => n.id === sel.evId);
    const op = ev && ev.ops && ev.ops[sel.i];
    if (op) fn(op);
  });
}
