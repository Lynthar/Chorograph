/* URL 直达（深链）解析：#map=&preset=&sel=&year=&lon=&lat=&z=&seed=&style=&force=cpu&lib=1&hold=ms
   分析/编辑：#mode=measure|route|edit&sub=select|add|link|paint|terrain|decor|delete&pts=lon,lat,…&arm=&op=作战线序号&multi=名称1,名称2
   解析时立即落地的副作用：yearSig/armSig 赋值、相机 ctx.view、程序化种子（ctx.meta+表单）、
   /__hold__ 占位图（把 load 压后到异步启动完成，供自动化截图）。
   其余存为 want* 延迟量，由 boot 启动后按 v0.14 语义消费；urlView/urlYear 供 setWorld
   压制首次打开的快照视角/纪年（用后即清）。 */
import { armSig, yearSig } from "../ui/state.ts";
import { $ } from "./dom.ts";
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
  /** #grain=hour：战术图直开「时」粒度（时轨展开；截图/分享精确时刻用，增） */
  wantGrain: string | null;
  force: "cpu" | "webgl2" | undefined;
}

export function parseDeepLink(ctx: ShellCtx): DeepLink {
  const dl: DeepLink = {
    wantPreset: null, wantSel: null, wantMap: null, wantLib: false, urlView: false, urlYear: false,
    wantAnalysis: null, wantPts: null, wantSub: null, wantOp: null, wantMulti: null,
    wantSample: null, wantGenTac: null, wantDia: null, wantOvl: null, wantDrawer: null, wantGrain: null, force: undefined
  };
  const dec = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };  // 坏 %编码（分享链接被截断/含裸 %）不致启动崩溃
  const num = (v: string): number | null => { const n = +v; return isFinite(n) ? n : null; };   // 坏数值（#year=abc）→null 视同未提供，不污染年份/相机为 NaN（全图消失/白屏）
  (location.hash.slice(1) || "").split("&").forEach(kv => {
    const [k, v = ""] = kv.split("=");   // 无值参数（#pts 等裸键）不致启动崩溃
    if (k === "seed") { ctx.meta.genSeed = +v || 1; ($("seed") as HTMLInputElement).value = v; }
    if (k === "style") { ctx.meta.genStyle = v as GenStyle; ($("style") as HTMLSelectElement).value = v; }
    if (k === "force") dl.force = v as DeepLink["force"];
    if (k === "year" && v !== "") { const n = num(v); if (n != null) { yearSig.value = n; dl.urlYear = true; } }
    if (k === "preset") dl.wantPreset = dec(v);
    if (k === "sel") dl.wantSel = dec(v);
    if (k === "map") dl.wantMap = dec(v);
    if (k === "sample") dl.wantSample = dec(v);   // 从仓库根 fetch 指定 .json 建/开（战术夹具/演示）
    if (k === "gentac") dl.wantGenTac = dec(v);   // 从战役事件名/id 生成战术图（无头，绕过 prompt）
    if (k === "dia" && v !== "") dl.wantDia = num(v);            // 战场直径 km（配合 #gentac）
    if (k === "lib") dl.wantLib = true;   // 启动即进开始界面（截图/演示用）
    if (k === "ovl") dl.wantOvl = v;      // help|settings|create：启动即开对应弹层（截图/演示用）
    if (k === "drawer") dl.wantDrawer = v;   // layers：启动即开抽屉「层」面（截图/演示用）
    if (k === "grain") dl.wantGrain = v;     // hour：战术图直开「时」粒度（截图/分享用）
    if (k === "analysis" || k === "mode") dl.wantAnalysis = v;             // measure|route|edit
    if (k === "sub") dl.wantSub = v;                                       // 编辑子工具（select|add|link|paint|delete）
    if (k === "op" && v !== "") dl.wantOp = num(v);                        // 选中事件的第 N 条作战线（开悬浮框，演示/截图用）
    if (k === "multi") dl.wantMulti = dec(v).split(",");    // 框选多地点（名称/ id 逗号分隔，演示/截图用）
    if (k === "pts") dl.wantPts = v.split(",").map(Number);               // lon,lat,lon,lat…
    if (k === "arm" && v) armSig.value = v as Arm;
    if (k === "lon" && v !== "") { const n = num(v); if (n != null && Math.abs(n) <= 1e6) { ctx.view.lon0 = n; dl.urlView = true; } }   // |·|≤1e6：天文值=恶意/笔误链接（首帧渲染前不经 clampView）
    if (k === "lat" && v !== "") { const n = num(v); if (n != null && Math.abs(n) <= 1e6) { ctx.view.lat0 = n; dl.urlView = true; } }
    if (k === "z" && v !== "") { const n = num(v); if (n != null && n > 0) { ctx.view.degPerPx = n; dl.urlView = true; } }
    if (k === "hold") { const i = new Image(); i.style.display = "none"; i.src = "/__hold__?ms=" + (+v || 5000); document.body.appendChild(i); }   // 截图等待：压后 load 到异步启动完成后
  });
  return dl;
}
