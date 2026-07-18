/* 开图计划（纯函数）：把「打开一张图时 年份/视角 怎么定」从图库 IO 中剥出——
   shell 编排纯函数化第一步，历史时序 bug（图库重开全平原/深链被快照覆盖/坏档 NaN 写坏相机）
   全发生在这段决策上，规则由 openplan.test.ts 逐条锁定：
   · 年份：快照有有限年份且深链没抢（#year）才用；落地方 setWorldState 另按世界范围钳制。
   · 视角：快照 view（lon0 有限）＞ 档内 meta.view（lon0 有限）＞ 不动；lon/lat 一律过 clampView
     （快照/档内值都不可信：lat0 可 NaN、lon0 可超界）；degPerPx：快照路缺省 0.06，
     档内路缺省「保持当前」（以 null 表达，落地方不动它）。
   · 深链 #lon/#lat/#z/#year 只压制首次开图——消费后由落地方复位 dl 标志。
   落地（赋信号/ctx、builtFor 清空、rebuild 兜底）仍在 shell/library.ts 的 setWorld。 */
import { clampView } from "../core/projection.ts";
import { normalizeWorld } from "../core/world.ts";
import type { Meta, World } from "../core/types.ts";

/** 开图快照（浏览器库条目 MapEntry / 文件夹库 FolderCacheEntry 的公共子形） */
export interface OpenSnap {
  view?: { lon0: number; lat0: number; degPerPx?: number } | null;
  year?: number | null;
}

export interface OpenPlan {
  /** normalizeWorld 后的世界（坏档已补齐/过滤） */
  world: World;
  /** 要设的年份；null＝不设（保持当前，由钳制兜底） */
  year: number | null;
  /** 要设的视角；null＝不动相机；degPerPx null＝只动经纬、保持当前缩放 */
  view: { lon0: number; lat0: number; degPerPx: number | null } | null;
}

/* —— 启动分流（boot 的决策半）：深链要素任一在场 ⇒ 直达地图，否则进开始界面。 —— */

/** 深链判定（v0.14 启动语义）：#map/#preset/#sel/#mode/#gentac/#multi/#op/#pts/#lon…/#year 任一在场 */
export function wantsDeepStart(dl: { wantMap: string | null; wantPreset: string | null; wantSel: string | null;
  wantAnalysis: string | null; wantGenTac: string | null; wantMulti: string[] | null; wantOp: number | null;
  wantPts: number[] | null; urlView: boolean; urlYear: boolean }): boolean {
  return !!(dl.wantMap || dl.wantPreset || dl.wantSel || dl.wantAnalysis || dl.wantGenTac
    || dl.wantMulti || dl.wantOp != null || dl.wantPts || dl.urlView || dl.urlYear);
}

/** 深链开哪张：#map 指名（名称或 id）→ 上次打开（lastMap）→ 库里第一张 → 无图 null。
    指名落空时回落 lastMap/首张＝既定语义（深链尽力直达，不因名字打错卡在开始界面）。 */
export function pickBootEntry<T extends { id: string; name?: string }>(
  entries: T[], wantMap: string | null, last: string | null | undefined): T | null {
  return (wantMap && entries.find(e => e.name === wantMap || e.id === wantMap))
    || entries.find(e => e.id === last) || entries[0] || null;
}

export function planOpen(raw: unknown, snap: OpenSnap | null | undefined,
  dl: { urlYear: boolean; urlView: boolean }): OpenPlan {
  const world = normalizeWorld(raw);
  const meta: Meta = world.meta || {};
  const year = snap && !dl.urlYear && isFinite(snap.year as number) ? (snap.year as number) : null;
  let view: OpenPlan["view"] = null;
  if (snap && !dl.urlView && snap.view && isFinite(snap.view.lon0)) {
    const c = clampView({ lon0: snap.view.lon0, lat0: snap.view.lat0 }, meta);
    view = { lon0: c.lon0, lat0: c.lat0, degPerPx: snap.view.degPerPx || 0.06 };
  } else if (!dl.urlView && meta.view && isFinite(meta.view.lon0)) {
    const c = clampView({ lon0: meta.view.lon0, lat0: meta.view.lat0 }, meta);
    view = { lon0: c.lon0, lat0: c.lat0, degPerPx: meta.view.degPerPx0 || null };
  }
  return { world, year, view };
}
