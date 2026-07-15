/* 画布宿主：画布尺寸、相机取景、地形网格/高程场重建。
   全部经 ctx 共享态工作；rebuild 同步把寻路上下文送进 Worker（官道格按当年连线重算）。 */
import { buildGridCells, roadCellSet } from "../core/grid.ts";
import { buildElevField } from "../core/elev.ts";
import { worldSig, yearSig, gridVerSig } from "../ui/state.ts";
import { $ } from "./dom.ts";
import type { ShellCtx } from "./ctx.ts";
import type { Camera } from "../core/projection.ts";
import type { BBox, GenStyle } from "../core/types.ts";

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
    ctx.DPR = Math.max(1, devicePixelRatio || 1);   // 重读：缩放/换屏后 devicePixelRatio 变，帧内各处每帧读 ctx 自动跟新
    canvas.width = Math.round(canvas.clientWidth * ctx.DPR);
    canvas.height = Math.round(canvas.clientHeight * ctx.DPR);
    ov.width = canvas.width; ov.height = canvas.height;
  }
  function cssSize(): [number, number] { return [canvas.clientWidth, canvas.clientHeight]; }
  function viewBB(): BBox {
    const [w, h] = cssSize();
    return { lonMin: ctx.view.lon0 - w / 2 * ctx.view.degPerPx / cosk(), lonMax: ctx.view.lon0 + w / 2 * ctx.view.degPerPx / cosk(),
             latMin: ctx.view.lat0 - h / 2 * ctx.view.degPerPx, latMax: ctx.view.lat0 + h / 2 * ctx.view.degPerPx };
  }
  const cosk = (): number => Math.cos(ctx.view.lat0 * Math.PI / 180);

  function rebuild(): void {
    const w = worldSig.value;
    if (!w) { ctx.meta.genSeed = +($("seed") as HTMLInputElement).value | 0 || 1; ctx.meta.genStyle = ($("style") as HTMLSelectElement).value as GenStyle; }
    const t0 = performance.now();
    ctx.grid = buildGridCells(ctx.meta, w ? w.terrainOverrides : [], yearSig.value);
    ctx.elevField = buildElevField(ctx.meta, w ? w.heightOverrides : undefined, ctx.grid, yearSig.value);
    const ms = performance.now() - t0;
    ctx.R!.uploadGrid(ctx.grid, ctx.elevField);   // rebuild 只在渲染器就绪后发生（boot 先建 R）；缺 R=启动即错
    ctx.builtFor = ctx.mapId + "@" + yearSig.value + "@" + gridVerSig.value;
    $("hud").dataset.grid = `${ctx.grid.cols}×${ctx.grid.rows} 网格 ${ms.toFixed(0)} ms`;
    // 寻路上下文随网格重建同步进 Worker（官道格按当年连线重算）
    if (w) ctx.routeClient.setContext({ meta: ctx.meta, grid: ctx.grid, roads: roadCellSet(w.nodes, w.edges, yearSig.value, ctx.grid), world: w, yearNow: yearSig.value });
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
