/* 画布宿主：画布尺寸、相机取景、地形网格/高程场重建。
   全部经 ctx 共享态工作；rebuild 同步把寻路上下文送进 Worker（官道格按当年连线重算）。 */
import { buildGridCells, roadCellSet, type Grid } from "../core/grid.ts";
import { buildElevField, coarseField, fieldMix, fieldPlusDelta, type ElevField } from "../core/elev.ts";
import { erodeInput, type ErodeInput } from "../core/erode.ts";
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
     补一单。⚠ 过期判据是**每次重建自增的 buildN**，不能用 builtFor 串——实时地形笔刷走
     pointer 的直调 rebuild() 而不 bump gridVerSig，连笔之间 builtFor 一字不变，开图/上一笔时
     发出的侵蚀单（算的是旧世界）落地时会顶掉刚画的内容＝「一松开就回到最初」（河洛实证）。
     ⚠ 等待窗显示不换回粗格场（河洛实证第二回「笔刷一按全图变、松开又变回」）：细分场在屏时
     的重建走 fieldPlusDelta＝旧细分场+粗格增量补丁，远处纹丝不动、笔下即时起落；细分场与它的
     增量基准（fineBase＝该场所出世界的粗格场）+ 几何键三件同担、随侵蚀落地一起换，门关或几何
     变（换图/改图幅）即弃场回粗格。侵蚀输入在 rebuild 里同拍组装（pendInp）——门的判定与显示
     分支必须同源，fireErode 只消费不再自判。 */
  let eroding = false, erodeDirty = false, erodeTimer: ReturnType<typeof setTimeout> | undefined, buildN = 0;
  let pendInp: ErodeInput | null = null, pendCoarse: Float32Array | null = null;   // 最近一次重建的侵蚀单与粗格场
  let fine: ElevField | null = null, fineBase: Float32Array | null = null, fineKey = "";   // 已落地细分场 + 增量基准 + 几何键
  const geomKey = (g: Grid): string =>
    `${ctx.mapId}@${g.bb.lonMin},${g.bb.latMin},${g.bb.lonMax},${g.bb.latMax}@${g.step}@${g.cols}x${g.rows}`;
  function requestErode(): void {
    clearTimeout(erodeTimer);
    erodeTimer = setTimeout(fireErode, 150);
  }
  /* 落地渐变（fieldMix 注有病历：硬切读感像「出错了自己纠正」）：约 0.4s 六帧缓动换场。
     远处两场逐位相同＝渐变只在真变了的区域发生；帧间任何重建（buildN 变）即中止——
     rebuild 已按 fine(=终场)+增量接管显示，动画不许再覆盖它。fine/fineBase 在落地一拍
     **立即**记账（渐变纯属显示），中途重建合成的就是终场。 */
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  const FADE_MS = 380, FADE_STEPS = 6;
  function startFade(to: ElevField): void {
    clearTimeout(fadeTimer);
    const from = ctx.elevField;
    if (!from) {   // 无在屏场（不该发生）＝直接换
      ctx.elevField = to;
      ctx.R!.uploadGrid(ctx.grid!, to);
      if (ctx.repaint) ctx.repaint();
      return;
    }
    const token = buildN;
    let k = 0;
    const tick = (): void => {
      if (buildN !== token || !ctx.grid) return;
      k++;
      const t = k / FADE_STEPS;
      ctx.elevField = fieldMix(from, to, t * t * (3 - 2 * t));   // 末帧 t=1 ＝ to 本身（真场引用）
      ctx.R!.uploadGrid(ctx.grid, ctx.elevField);
      if (ctx.repaint) ctx.repaint();
      if (k < FADE_STEPS) fadeTimer = setTimeout(tick, FADE_MS / FADE_STEPS);
    };
    tick();
  }
  function fireErode(): void {
    if (!ctx.grid || !pendInp) return;   // 无单＝「relief=0 且无涂改」旧粗格路径逐位不变
    if (eroding) { erodeDirty = true; return; }
    eroding = true;
    const token = buildN, baseC = pendCoarse!, key = geomKey(ctx.grid);
    ctx.routeClient.erode(pendInp).then(f => {
      eroding = false;
      if (f && buildN === token && ctx.grid) {   // 其间无任何重建才换场（有＝结果过期作废，新重建已另发单）
        fine = f; fineBase = baseC; fineKey = key;
        startFade(f);
      }
      if (erodeDirty) { erodeDirty = false; fireErode(); }
    });
  }

  function rebuild(): void {
    const w = worldSig.value;
    /* 无世界（程序化预览）时的 genSeed/genStyle 直接用 ctx.meta——它有出厂默认
       （createShellCtx: auto/1234/continent），深链 #seed=/#style= 也已落在同一处。 */
    buildN++;   // 侵蚀令牌：任何一次重建都使在飞的侵蚀单过期（见 requestErode 注）
    const t0 = performance.now();
    ctx.grid = buildGridCells(ctx.meta, w ? w.terrainOverrides : [], yearSig.value);
    const coarse = buildElevField(ctx.meta, w ? w.heightOverrides : undefined, ctx.grid, yearSig.value);
    pendInp = erodeInput(ctx.meta, w ? w.heightOverrides : undefined, ctx.grid, yearSig.value);
    pendCoarse = coarse;
    /* 等待窗显示（见并发闸头注）：同几何细分场在屏＝粗格增量羽化叠上去；否则粗格场
       （开图先出粗帧、门关的旧契约路径、换图/改图幅弃场） */
    const key = geomKey(ctx.grid);
    if (!pendInp || fineKey !== key) { fine = null; fineBase = null; fineKey = ""; }
    ctx.elevField = fine && fineBase ? fieldPlusDelta(fine, fineBase, coarse, ctx.grid) : coarseField(ctx.grid, coarse);
    const ms = performance.now() - t0;
    ctx.R!.uploadGrid(ctx.grid, ctx.elevField);   // rebuild 只在渲染器就绪后发生（boot 先建 R）；缺 R=启动即错
    ctx.builtFor = ctx.mapId + "@" + yearSig.value + "@" + gridVerSig.value;
    $("hud").dataset.grid = `${ctx.grid.cols}×${ctx.grid.rows} 网格 ${ms.toFixed(0)} ms`;
    // 寻路上下文随网格重建同步进 Worker（官道格按当年连线重算）
    if (w) ctx.routeClient.setContext({ meta: ctx.meta, grid: ctx.grid, roads: roadCellSet(w.nodes, w.edges, yearSig.value, ctx.grid), world: w, yearNow: yearSig.value });
    requestErode();   // 有单的图异步细化：谷网算好即整场换真（无细分场在屏时先出的是粗格帧）
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
