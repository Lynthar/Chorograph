/* 浏览器图库：IndexedDB 取代旧版 localStorage——配额从 ~5MB 提到磁盘级，
   世界对象结构化存储（不再字符串化）。数据布局沿袭旧版「索引 + 每图存档槽」的拆分：
   · maps  ：id → 完整世界对象（打开地图才读）
   · meta  ：id → 图库卡片条目（列表页只读这张小表）
   · kv    ：杂项（lastMap / 文件夹句柄 / 文件夹缓存 …）
   库名 yutu2——旧版占用 "yutu"(v1) 存文件夹句柄，同源并存期间不可动它（版本升级会把旧版打崩）。 */
import { normalizeWorld, countsOf, type MapCounts } from "../core/world.ts";
import type { World } from "../core/types.ts";
import { openDB, reqP, txDone } from "./idb.ts";

export const LIB_DB = "yutu2";

/** 图库条目（旧版 yutu.maps.v1 索引条目的直接后继；srcLS 记录其 localStorage 出身，供增量迁移判重） */
export interface MapEntry {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  counts: MapCounts;
  thumb?: string | null;
  view?: { lon0: number; lat0: number; degPerPx: number };
  year?: number;
  srcLS?: { id: string; updatedAt: number; entryUpdatedAt: number };
}

/** 保存时一并落的快照字段（视角/纪年/缩略图；迁移另带 srcLS） */
export type EntrySnap = Partial<Pick<MapEntry, "view" | "year" | "thumb" | "srcLS">>;

export interface Library {
  list(): Promise<MapEntry[]>;
  getEntry(id: string): Promise<MapEntry | null>;
  getWorld(id: string): Promise<World | null>;
  /** 世界规范化后入库；over 可指定 id/时间戳等（迁移用），undefined 值忽略。存储失败（配额等）抛异常。 */
  create(world: unknown, over?: Partial<MapEntry>): Promise<MapEntry>;
  /** 覆写世界并同步条目（名称/统计自动取自世界）；at 可指定 updatedAt（迁移保留旧时间线用） */
  save(id: string, world: World, snap?: EntrySnap, at?: number): Promise<void>;
  /** 打补丁到条目（undefined 值忽略——与旧版 upsertEntry 同语义）；bump=推更新时间 */
  patchEntry(id: string, patch: Partial<MapEntry>, bump: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  kvGet<T = unknown>(k: string): Promise<T | undefined>;
  kvSet(k: string, v: unknown): Promise<void>;
  kvDel(k: string): Promise<void>;
  close(): void;
}

export function newMapId(): string {
  return "m" + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
}

/** 只覆盖有值的键（undefined 跳过） */
function applyDefined<T extends object>(dst: T, patch: Partial<T>): T {
  for (const k in patch) if (patch[k] !== undefined) (dst as Record<string, unknown>)[k] = patch[k];
  return dst;
}

export async function openLibrary(dbName: string = LIB_DB): Promise<Library> {
  const db = await openDB(dbName, 1, d => {
    if (!d.objectStoreNames.contains("maps")) d.createObjectStore("maps");
    if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "id" });
    if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
  });

  const lib: Library = {
    async list() {
      const all = await reqP<MapEntry[]>(db.transaction("meta", "readonly").objectStore("meta").getAll());
      return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    async getEntry(id) {
      return (await reqP(db.transaction("meta", "readonly").objectStore("meta").get(id))) as MapEntry ?? null;
    },
    async getWorld(id) {
      return (await reqP(db.transaction("maps", "readonly").objectStore("maps").get(id))) as World ?? null;
    },
    async create(world, over = {}) {
      const w = normalizeWorld(world);
      const now = Date.now();
      const entry = applyDefined<MapEntry>({
        id: newMapId(), name: (w.meta && w.meta.名称) || "未命名",
        createdAt: now, updatedAt: now, counts: countsOf(w), thumb: null
      }, over);
      const t = db.transaction(["maps", "meta"], "readwrite");
      t.objectStore("maps").put(w, entry.id);
      t.objectStore("meta").put(entry);
      await txDone(t);
      return entry;
    },
    async save(id, world, snap = {}, at) {
      const t = db.transaction(["maps", "meta"], "readwrite");
      t.objectStore("maps").put(world, id);
      const metaStore = t.objectStore("meta");
      const e = (await reqP(metaStore.get(id))) as MapEntry | undefined;
      if (e) {
        e.name = (world.meta && world.meta.名称) || "未命名";
        e.counts = countsOf(world);
        applyDefined(e, snap);
        e.updatedAt = at ?? Date.now();
        metaStore.put(e);
      }
      await txDone(t);
    },
    async patchEntry(id, patch, bump) {
      const t = db.transaction("meta", "readwrite");
      const store = t.objectStore("meta");
      const e = (await reqP(store.get(id))) as MapEntry | undefined;
      if (!e) return;
      applyDefined(e, patch);
      if (bump) e.updatedAt = Date.now();
      store.put(e);
      await txDone(t);
    },
    async remove(id) {
      const t = db.transaction(["maps", "meta", "kv"], "readwrite");
      t.objectStore("maps").delete(id);
      t.objectStore("meta").delete(id);
      const kv = t.objectStore("kv");
      if ((await reqP(kv.get("lastMap"))) === id) kv.delete("lastMap");
      await txDone(t);
    },
    async kvGet(k) { return (await reqP(db.transaction("kv", "readonly").objectStore("kv").get(k))) as never; },
    async kvSet(k, v) {
      const t = db.transaction("kv", "readwrite");
      t.objectStore("kv").put(v, k);
      await txDone(t);
    },
    async kvDel(k) {
      const t = db.transaction("kv", "readwrite");
      t.objectStore("kv").delete(k);
      await txDone(t);
    },
    close() { db.close(); }
  };
  return lib;
}
