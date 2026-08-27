/* URL 直达（深链）解析：#map=&preset=&sel=&year=&lon=&lat=&z=&seed=&style=&force=cpu&lib=1&hold=ms
   只读分享：#ro=1&d=<base64url 压缩的整张图>（core/share 编解码，链接自带数据、不需服务端）
   分析/编辑：#mode=measure|route|edit&sub=select|add|link|paint|terrain|decor|label|delete&pts=lon,lat,…&arm=&op=作战线序号&multi=名称1,名称2

   分两层（同 openplan 之例）：**parseHash 是纯函数**（hash 串 → DeepLink，可测），
   parseDeepLink 只负责把它落到 ctx/信号/DOM 上。

   ⚠ **枚举参数一律过白名单**。同一个文件对数值参数守得极细（num()、|n|≤1e6、n>0），枚举却曾裸奔，
   代价有两种：① 原型键名——`PRESETS["__proto__"]` 取到 Object.prototype 是真值，早退兜不住，
   于是把所有图层一次性关掉；`SUB_LAYERS["__proto__"]` 更直接让切工具时崩在 `.filter` 上。
   ② 拼错的普通值——`#sub=node`（正确是 add）照单全收，把 editSubSig 设成一个不存在的工具态：
   界面看着像绘制工具、点画布却什么都不发生。**一个无效值不报错、不回落、静默产出一个死工具，
   比崩溃更难排查**，故非法值一律当作没给过。 */
import { armSig, yearSig } from "../ui/state.ts";
import { PRESETS, ARM_NAME } from "../core/constants.ts";
import { tget } from "../core/util.ts";
import type { ShellCtx } from "./ctx.ts";
import type { Arm, GenStyle } from "../core/types.ts";

export interface DeepLink {
  wantPreset: string | null;
  wantSel: string | null;
  wantMap: string | null;
  wantLib: boolean;
  /** URL 显式给了相机（lon/lat/z）——首次开图不用存档快照视角 */
  urlView: boolean;
  /** URL 显式给了纪年——首次开图不用存档快照年份 */
  urlYear: boolean;
  wantAnalysis: string | null;
  wantPts: number[] | null;
  wantSub: string | null;
  wantOp: number | null;
  wantMulti: string[] | null;
  wantSample: string | null;
  wantGenTac: string | null;
  wantDia: number | null;
  wantOvl: string | null;
  /** #drawer=layers：启动即开抽屉「层」面（截图/演示用，增） */
  wantDrawer: string | null;
  /** #grain=hour｜month：直开细粒度（战术＝时轨展开、战略＝月档；截图/分享精确时刻用，增） */
  wantGrain: string | null;
  /** #d=<base64url>：分享链接自带的整张图（deflate-raw 压缩，core/share 解包） */
  wantData: string | null;
  /** #ro=1：把本机图开成只读（演示/投屏）。带数据的分享不看它——那两条恒只读 */
  wantRo: boolean;
  force: "cpu" | "webgl2" | undefined;
  /* —— 以下由 parseDeepLink 即时落地（ctx.meta / 信号 / DOM），纯函数只负责解析出来 —— */
  /** 程序化地形种子（ctx.meta.genSeed 是唯一真源） */
  seed: number | null;
  style: GenStyle | null;
  year: number | null;
  lon: number | null;
  lat: number | null;
  z: number | null;
  arm: Arm | null;
  /** #hold=ms：压后 load 到异步启动完成（无头截图用） */
  hold: number | null;
}

/** 编辑子工具白名单＝ui/state.EditSub 的全部取值（此处另写一份，免深链把类型层的自由度当运行时许可） */
const SUBS = ["select", "add", "link", "paint", "terrain", "decor", "label", "unit", "delete"];
const ANALYSIS = ["measure", "route", "edit"];
const OVLS = ["help", "settings", "create"];
const DRAWERS = ["layers"];
const GRAINS = ["hour", "month"];
const FORCES = ["cpu", "webgl2"];
const STYLES = ["continent", "archipelago"];

/** 纯解析：hash 串（可带或不带前导 #）→ DeepLink。无副作用、不碰 DOM，供 deeplink.test.ts 逐条锁语义 */
export function parseHash(hash: string): DeepLink {
  const dl: DeepLink = {
    wantPreset: null, wantSel: null, wantMap: null, wantLib: false, urlView: false, urlYear: false,
    wantAnalysis: null, wantPts: null, wantSub: null, wantOp: null, wantMulti: null,
    wantSample: null, wantGenTac: null, wantDia: null, wantOvl: null, wantDrawer: null, wantGrain: null,
    wantData: null, wantRo: false,
    force: undefined, seed: null, style: null, year: null, lon: null, lat: null, z: null, arm: null, hold: null
  };
  const dec = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };  // 坏 %编码（分享链接被截断/含裸 %）不致启动崩溃
  const num = (v: string): number | null => { const n = +v; return isFinite(n) ? n : null; };   // 坏数值（#year=abc）→null 视同未提供，不污染年份/相机为 NaN（全图消失/白屏）
  const oneOf = (list: string[], v: string): string | null => (list.includes(v) ? v : null);    // 非法枚举＝当作没给过（见文件头注）
  (hash.replace(/^#/, "") || "").split("&").forEach(kv => {
    const [k, v = ""] = kv.split("=");   // 无值参数（#pts 等裸键）不致启动崩溃
    if (k === "seed") dl.seed = +v || 1;
    if (k === "style") dl.style = oneOf(STYLES, v) as GenStyle | null;
    if (k === "force") dl.force = (oneOf(FORCES, v) as DeepLink["force"]) ?? undefined;
    if (k === "year" && v !== "") dl.year = num(v);
    if (k === "preset") { const p = dec(v); dl.wantPreset = tget(PRESETS, p) ? p : null; }   // 原型键取到的是 Object.prototype，applyPreset 的早退兜不住
    if (k === "sel") dl.wantSel = dec(v);
    if (k === "map") dl.wantMap = dec(v);
    if (k === "sample") dl.wantSample = dec(v);   // 从仓库根 fetch 指定 .json 建/开（战术夹具/演示）
    if (k === "gentac") dl.wantGenTac = dec(v);   // 从战役事件名/id 生成战术图（无头，绕过 prompt）
    if (k === "dia" && v !== "") dl.wantDia = num(v);            // 战场直径 km（配合 #gentac）
    if (k === "d" && v !== "") dl.wantData = v;   // 分享载荷：base64url 不含 & 与 =，无须解码
    if (k === "ro") dl.wantRo = v !== "0";       // 只读态（只管 #map= 开本机图那条；带数据的分享恒只读）
    if (k === "lib") dl.wantLib = true;   // 启动即进开始界面（截图/演示用）
    if (k === "ovl") dl.wantOvl = oneOf(OVLS, v);         // help|settings|create：启动即开对应弹层（截图/演示用）
    if (k === "drawer") dl.wantDrawer = oneOf(DRAWERS, v);   // layers：启动即开抽屉「层」面（截图/演示用）
    if (k === "grain") dl.wantGrain = oneOf(GRAINS, v);      // hour=战术「时」/ month=战略「月」（截图/分享用）
    if (k === "analysis" || k === "mode") dl.wantAnalysis = oneOf(ANALYSIS, v);   // measure|route|edit
    if (k === "sub") dl.wantSub = oneOf(SUBS, v);                                 // 编辑子工具
    if (k === "op" && v !== "") dl.wantOp = num(v);                        // 选中事件的第 N 条作战线（开悬浮框，演示/截图用）
    if (k === "multi") dl.wantMulti = dec(v).split(",");    // 框选多地点（名称/ id 逗号分隔，演示/截图用）
    if (k === "pts") dl.wantPts = v.split(",").map(Number);               // lon,lat,lon,lat…
    if (k === "arm" && v) dl.arm = tget(ARM_NAME, v) ? (v as Arm) : null;
    if (k === "lon" && v !== "") { const n = num(v); if (n != null && Math.abs(n) <= 1e6) dl.lon = n; }   // |·|≤1e6：天文值=恶意/笔误链接（首帧渲染前不经 clampView）
    if (k === "lat" && v !== "") { const n = num(v); if (n != null && Math.abs(n) <= 1e6) dl.lat = n; }
    if (k === "z" && v !== "") { const n = num(v); if (n != null && n > 0) dl.z = n; }
    if (k === "hold") dl.hold = +v || 5000;
  });
  dl.urlYear = dl.year != null;
  dl.urlView = dl.lon != null || dl.lat != null || dl.z != null;
  return dl;
}

/** 解析当前 URL 并把即时项落地：yearSig/armSig、相机 ctx.view、程序化种子（ctx.meta 唯一真源）、
    /__hold__ 占位图（把 load 压后到异步启动完成，供自动化截图）。其余存为 want* 延迟量，由 boot 消费。 */
export function parseDeepLink(ctx: ShellCtx): DeepLink {
  const dl = parseHash(location.hash);
  /* 程序化地形参数直落 ctx.meta（唯一真源）。原先同时写一份进 #devbar 的隐藏 input，
     再由 host.rebuild 从 DOM 读回覆盖 ctx.meta——那两个元素恒 display:none、用户够不着，
     纯属让 DOM 当中间人转一道手。 */
  if (dl.seed != null) ctx.meta.genSeed = dl.seed;
  if (dl.style) ctx.meta.genStyle = dl.style;
  if (dl.year != null) yearSig.value = dl.year;
  if (dl.arm) armSig.value = dl.arm;
  if (dl.lon != null) ctx.view.lon0 = dl.lon;
  if (dl.lat != null) ctx.view.lat0 = dl.lat;
  if (dl.z != null) ctx.view.degPerPx = dl.z;
  if (dl.hold != null) {   // 截图等待：压后 load 到异步启动完成后
    const i = new Image(); i.style.display = "none"; i.src = "/__hold__?ms=" + dl.hold;
    document.body.appendChild(i);
  }
  return dl;
}
