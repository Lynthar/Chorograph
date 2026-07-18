/* 外壳共享可变态：原 main.ts 顶层散置的 let 集中为单一 ctx 对象，
   host/library/pointer/frame/boot 各 shell 模块经同一引用协作（原地读写，无副本无广播）。
   刻意不进 signals（对齐 ui/state.ts 头注）：相机 view / 网格 grid 拖拽与 rAF 每帧读写，
   普通对象直读；低频 UI 态才走 signals。 */
import type { Meta } from "../core/types.ts";
import type { Grid } from "../core/grid.ts";
import type { ViewState } from "../core/projection.ts";
import type { TerrainRenderer } from "../render/renderer.ts";
import type { Library } from "../data/library.ts";
import type { DirHandleLike, FolderCache } from "../data/folder.ts";
import type { RouteClient } from "../worker/routeClient.ts";

/** File System Access 目录句柄（权限方法 TS lib.dom 未收录，结构化补声明；实体来自
    showDirectoryPicker / IndexedDB 持久化的句柄，folder.ts 各函数按 DirHandleLike 消费）。 */
export interface FolderHandle extends DirHandleLike {
  queryPermission(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

export interface ShellCtx {
  readonly canvas: HTMLCanvasElement;
  readonly ov: HTMLCanvasElement;
  readonly routeClient: RouteClient;
  /** 设备像素比。resize 时重读——浏览器缩放/拖到不同 DPI 屏后 devicePixelRatio 会变，常量则地图发虚 */
  DPR: number;
  /** 当前世界 meta；无世界数据时=程序化兜底参数。世界对象整体更换（撤销/导入替换）时由 boot 的 effect 同步引用 */
  meta: Meta;
  /** 相机（对象身份稳定，各模块原地改字段） */
  readonly view: ViewState;
  grid: Grid | null;
  /** 每格高程场（起伏+高程涂改；底栏光标高程共用） */
  elevField: Float32Array | null;
  /** 地形渲染器（boot 创建；无 WebGL2 自动退 CPU 瓦片） */
  R: TerrainRenderer | null;
  /** `${mapId}@${year}@${gridVer}`——年份/换图/地形改动重建网格的去重键 */
  builtFor: string | null;
  /** 同步重画一帧（frame 启动时挂入；host.resize 设完画布尺寸立即调用——
      设 canvas 宽高即清屏，若等下一帧 rAF 补画，检查器滑开/收起期间 ResizeObserver 逐帧清屏＝空白帧闪烁） */
  repaint: (() => void) | null;
  /* —— 图库+ 自动保存共享态 —— */
  lib: Library | null;
  mapId: string | null;
  source: "browser" | "folder";
  folderDir: FolderHandle | null;
  fcache: FolderCache;
  /** 启动提示（旧档迁移/文件夹重授权），底栏 ☂ 显示 */
  bootNote: string;
  savedAt: Date | null;
  saveErr: { message?: unknown } | null;
  /** 开始界面（地图库）可见 */
  libOpen: boolean;
}

export function createShellCtx(canvas: HTMLCanvasElement, ov: HTMLCanvasElement, routeClient: RouteClient): ShellCtx {
  return {
    canvas, ov, routeClient,
    DPR: Math.max(1, devicePixelRatio || 1),
    meta: { terrain: "auto", genSeed: 1234, genStyle: "continent" },
    view: { lon0: 106, lat0: 38, degPerPx: 0.06 },
    grid: null, elevField: null, R: null, builtFor: null, repaint: null,
    lib: null, mapId: null, source: "browser", folderDir: null, fcache: {},
    bootNote: "", savedAt: null, saveErr: null, libOpen: false
  };
}
