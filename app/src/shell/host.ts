/* 画布宿主：画布尺寸、相机取景、地形网格/高程场重建。
   全部经 ctx 共享态工作；rebuild 同步把寻路上下文送进 Worker（官道格按当年连线重算）。 */
import { buildGridCells, roadCellSet } from "../core/grid.ts";
import { buildElevField, coarseField } from "../core/elev.ts";
import { erodeInput } from "../core/erode.ts";
import { worldSig, yearSig, gridVerSig } from "../ui/state.ts";
import { $ } from "./dom.ts";
import type { ShellCtx } from "./ctx.ts";
import type { Camera } from "../core/projection.ts";
import type { BBox } from "../core/types.ts";

export interface Host {
  /** 画布物理像素跟随 CSS 尺寸与 DPR（缩放/换屏后重读 devicePixelRatio） */
  resize(): void;
  /** 画布 CSS 尺寸 [宽, 高] */
  cssSize(): [number, number];
  /** 当前视口的经纬度包围盒 */
  viewBB(): BBox;
  /** 纬度余弦（球面世界经度视觉压缩系数；平面=按 lat0 同式，旧行为） */
  cosk(): number;
  /** 当前帧相机（投影/拾取共用参数包） */
  cam(): Camera;
  /** 重建地形网格与高程场并上传渲染器（无世界=程序化兜底参数） */
  rebuild(): void;
  /** 年份/换图/地形版本变化时才重建（builtFor 去重键） */
  rebuildIfNeeded(): void;
}

export function createHost(ctx: ShellCtx): Host {
  const { canvas, ov } = ctx;
  function resize(): void {
    const dpr = Math.max(1, devicePixelRatio || 1);   // 重读：缩放/换屏后 devicePixelRatio 变，帧内各处每帧读 ctx 自动跟新
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (dpr === ctx.DPR && canvas.width === w && canvas.height === h) return;   // 尺寸没变不碰画布（设宽高即清屏）
    ctx.DPR = dpr;
    canvas.width = w; canvas.height = h;
    ov.width = w; ov.height = h;
    /* 设完尺寸立即同步补画：ResizeObserver 回调跑在当帧 rAF 之后，清空的画布会先被合成上屏、
       下一帧才补画——检查器滑开/收起（0.22s 过渡逐帧触发 resize）期间空白帧与画面帧交替＝整屏闪烁。 */
    if (ctx.repaint) ctx.repaint();
  }
  function cssSize(): [number, number] { return [canvas.clientWidth, canvas.clientHeight]; }
  function viewBB(): BBox {
    const [w, h] = cssSize();
    return { lonMin: ctx.view.lon0 - w / 2 * ctx.view.degPerPx / cosk(), lonMax: ctx.view.lon0 + w / 2 * ctx.view.degPerPx / cosk(),
             latMin: ctx.view.lat0 - h / 2 * ctx.view.degPerPx, latMax: ctx.view.lat0 + h / 2 * ctx.view.degPerPx };
  }
  const cosk = (): number => Math.cos(ctx.view.lat0 * Math.PI / 180);

  /* 侵蚀细化的并发闸：150ms 防抖（同拍的 legs/route 先进同一 Worker 队列、连续拨年/连笔只算
     最后一帧）+ 同一时刻至多一单在 Worker 里；飞行中再来重建只记「还有活」，回来后按最新网格
     补一单（最新一次为准，旧结果按 builtFor 令牌丢弃）。 */
  let eroding = false, erodeDirty = false, erodeTimer: ReturnType<typeof setTimeout> | undefined;
  function requestErode(): void {
    clearTimeout(erodeTimer);
    erodeTimer = setTimeout(fireErode, 150);
  }
  function fireErode(): void {
    if (!ctx.grid) return;
    const w = worldSig.value;
    const inp = erodeInput(ctx.meta, w ? w.heightOverrides : undefined, ctx.grid, yearSig.value);
    if (!inp) return;   // relief=0＝旧粗格路径逐位不变（含 hov-only 图，盖章锐边不磨圆）
    if (eroding) { erodeDirty = true; return; }
    eroding = true;
    const token = ctx.builtFor;
    ctx.routeClient.erode(inp).then(f => {
      eroding = false;
      if (f && ctx.builtFor === token && ctx.grid) {   // 网格没换才换场（换了＝结果过期作废）
        ctx.elevField = f;
        ctx.R!.uploadGrid(ctx.grid, f);
        if (ctx.repaint) ctx.repaint();
      }
      if (erodeDirty) { erodeDirty = false; fireErode(); }
    });
  }

  function rebuild(): void {
    const w = worldSig.value;
    /* 无世界（程序化预览）时的 genSeed/genStyle 直接用 ctx.meta——它有出厂默认
       （createShellCtx: auto/1234/continent），深链 #seed=/#style= 也已落在同一处。 */
    const t0 = performance.now();
    ctx.grid = buildGridCells(ctx.meta, w ? w.terrainOverrides : [], yearSig.value);
    ctx.elevField = coarseField(ctx.grid, buildElevField(ctx.meta, w ? w.heightOverrides : undefined, ctx.grid, yearSig.value));
    const ms = performance.now() - t0;
    ctx.R!.uploadGrid(ctx.grid, ctx.elevField);   // rebuild 只在渲染器就绪后发生（boot 先建 R）；缺 R=启动即错
    ctx.builtFor = ctx.mapId + "@" + yearSig.value + "@" + gridVerSig.value;
    $("hud").dataset.grid = `${ctx.grid.cols}×${ctx.grid.rows} 网格 ${ms.toFixed(0)} ms`;
    // 寻路上下文随网格重建同步进 Worker（官道格按当年连线重算）
    if (w) ctx.routeClient.setContext({ meta: ctx.meta, grid: ctx.grid, roads: roadCellSet(w.nodes, w.edges, yearSig.value, ctx.grid), world: w, yearNow: yearSig.value });
    requestErode();   // relief>0 的图异步细化：先出粗格帧（旧观感），谷网算好即换入重画
  }
  function rebuildIfNeeded(): void {
    if (!ctx.R) return;
    if (ctx.mapId + "@" + yearSig.value + "@" + gridVerSig.value !== ctx.builtFor) rebuild();
  }
  function cam(): Camera {
    const [w, h] = cssSize();
    return { lon0: ctx.view.lon0, lat0: ctx.view.lat0, degPerPx: ctx.view.degPerPx, w, h, flat: ctx.meta.worldModel === "flat" };
  }
  return { resize, cssSize, viewBB, cosk, cam, rebuild, rebuildIfNeeded };
}
