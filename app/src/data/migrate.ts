/* 旧档迁移：旧版 localStorage 图库 → IndexedDB 图库，单向增量、只读不删。
   设计约束：双实现过渡期旧版还在被使用（同源部署时两边看得见同一份 localStorage）——
   · 迁移绝不写/删 localStorage（旧版继续照常工作）；
   · 幂等可反复跑：条目带 srcLS{id,updatedAt,entryUpdatedAt} 记出身，启动时增量同步；
   · 旧版又改了某图 → 若新库侧没动过（updatedAt 仍等于导入时值）则覆入，动过则保守跳过（新库为准）。 */
import { normalizeWorld } from "../core/world.ts";
import { openDB, reqP } from "./idb.ts";
import type { Library, MapEntry } from "./library.ts";

const IDX_KEY = "yutu.maps.v1";          // 旧版索引
const MAP_PREFIX = "yutu.map.";          // 旧版每图存档槽
const AUTOSAVE_KEY = "yutu.autosave.v1"; // v0.10 之前的单槽自动存档
const AUTOSAVE_SRC = "<autosave>";

/** 迁移只需要读——传 window.localStorage 或测试替身 */
export interface LSLike { getItem(key: string): string | null }

export interface MigrateResult { imported: number; updated: number; skipped: number }

const worldish = (w: unknown): boolean =>
  !!w && typeof w === "object" && !!(w as Record<string, unknown>).meta
  && Array.isArray((w as Record<string, unknown>).nodes);

function parseLS(ls: LSLike, key: string): unknown {
  try { return JSON.parse(ls.getItem(key) || "null"); } catch { return null; }
}

export async function migrateFromLocalStorage(lib: Library, ls: LSLike): Promise<MigrateResult> {
  const res: MigrateResult = { imported: 0, updated: 0, skipped: 0 };
  const idxRaw = parseLS(ls, IDX_KEY);
  const oldIdx: Record<string, unknown>[] = Array.isArray(idxRaw)
    ? idxRaw.filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && typeof (e as Record<string, unknown>).id === "string")
    : [];
  const bySrc = new Map((await lib.list()).filter(e => e.srcLS).map(e => [e.srcLS!.id, e]));

  /* 更老的单槽自动存档：没跑过 v0.10+ 的用户直接从这里接走（旧版索引存在时以索引为准） */
  if (idxRaw == null && !bySrc.has(AUTOSAVE_SRC)) {
    const w = parseLS(ls, AUTOSAVE_KEY);
    if (worldish(w)) {
      const now = Date.now();
      await lib.create(w, { updatedAt: now, srcLS: { id: AUTOSAVE_SRC, updatedAt: 0, entryUpdatedAt: now } });
      res.imported++;
    }
  }

  for (const e of oldIdx) {
    const lsId = e.id as string;
    const w = parseLS(ls, MAP_PREFIX + lsId);
    if (!worldish(w)) { res.skipped++; continue; }   // 存档槽丢失/损坏：不导入（旧版同样打不开它）
    const lsUpd = +(e.updatedAt as number) || 0;
    const prev = bySrc.get(lsId);
    const snap: Partial<MapEntry> = {
      name: ((w as { meta?: { 名称?: string } }).meta || {}).名称 || (e.name as string) || "未命名",
      thumb: (e.thumb as string) ?? null,
      view: e.view as MapEntry["view"], year: e.year as number
    };
    if (!prev) {
      const upd = lsUpd || Date.now();
      await lib.create(w, { ...snap, createdAt: +(e.createdAt as number) || upd, updatedAt: upd,
        srcLS: { id: lsId, updatedAt: lsUpd, entryUpdatedAt: upd } });
      res.imported++;
    } else if (lsUpd > prev.srcLS!.updatedAt && prev.updatedAt === prev.srcLS!.entryUpdatedAt) {
      await lib.save(prev.id, normalizeWorld(w),
        { view: snap.view, year: snap.year, thumb: snap.thumb ?? undefined,
          srcLS: { id: lsId, updatedAt: lsUpd, entryUpdatedAt: lsUpd } }, lsUpd);
      res.updated++;
    } else {
      res.skipped++;   // 已最新，或两边都改过（保新库、不覆盖）
    }
  }
  return res;
}

/** 旧版把「上次链接的文件夹」句柄存在旧库 yutu/kv/libDir——存在则拷到新库（不隐式创建旧库）。 */
export async function migrateFolderHandle(lib: Library): Promise<boolean> {
  try {
    if ((await lib.kvGet("libDir")) !== undefined) return false;
    const dbs = typeof indexedDB.databases === "function" ? await indexedDB.databases() : null;
    if (!dbs || !dbs.some(d => d.name === "yutu")) return false;
    const old = await openDB("yutu", 1, () => {});
    try {
      if (!old.objectStoreNames.contains("kv")) return false;
      const h = await reqP(old.transaction("kv", "readonly").objectStore("kv").get("libDir"));
      if (h === undefined || h === null) return false;
      await lib.kvSet("libDir", h);
      return true;
    } finally { old.close(); }
  } catch { return false; }
}
