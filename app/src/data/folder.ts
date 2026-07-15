/* 文件夹图库：把本地文件夹当图库，实时读写其中的 .json。
   与旧版差异仅两点：① 不再碰全局 state——目录句柄/缓存全部显式传参（node 可用替身测试）；
   ② 每文件夹缓存改存新库 kv（键 foldercache），不再占 localStorage。语义逐条对齐旧实现：
   缓存按 mtime 失效、名称/统计从文件刷新、缩略图只能开图后生成故沿用旧缓存、列表按修改时间倒序。
   句柄类型用结构化接口而非 lib.dom 类型——浏览器真句柄天然满足，测试端 40 行内存替身即可。 */
import { normalizeWorld, countsOf, type MapCounts } from "../core/world.ts";
import { safeName } from "../core/util.ts";
import type { World } from "../core/types.ts";

/* —— File System Access 句柄的最小结构面 —— */
export interface FileLike { lastModified: number; text(): Promise<string> }
export interface WritableLike { write(data: string): Promise<void>; close(): Promise<void> }
export interface FileHandleLike { getFile(): Promise<FileLike>; createWritable(): Promise<WritableLike> }
export interface DirHandleLike {
  name: string;
  entries(): AsyncIterable<[string, { kind: string }]>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string): Promise<void>;
}

/** 环境支持检测（Edge/Chrome 且 localhost/https；file:// 与 Firefox/Safari 无此 API） */
export function fsSupported(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

/* —— 每文件夹缓存（文件夹名 → 文件名 → 元数据）；纯函数原地改，落库由调用方负责 —— */
export interface FolderCacheEntry {
  name?: string; counts?: MapCounts; thumb?: string;
  view?: { lon0: number; lat0: number; degPerPx: number }; year?: number; mtime?: number;
}
export type FolderCache = Record<string, Record<string, FolderCacheEntry>>;

export function fcachePatch(all: FolderCache, dirName: string, fn: string, patch: Partial<FolderCacheEntry>): FolderCache {
  const d = all[dirName] || (all[dirName] = {});
  const e = d[fn] || (d[fn] = {});
  for (const k in patch) if (patch[k as keyof FolderCacheEntry] !== undefined)
    (e as Record<string, unknown>)[k] = patch[k as keyof FolderCacheEntry];
  return all;
}
export function fcacheRemove(all: FolderCache, dirName: string, fn: string): FolderCache {
  if (all[dirName]) delete all[dirName][fn];
  return all;
}

/** 文件夹里的一张图（列表条目）；id=文件名 */
export interface FolderMapEntry {
  id: string; name: string; counts: MapCounts | Record<string, never>;
  thumb?: string; view?: FolderCacheEntry["view"]; year?: number; updatedAt: number;
}

/** 列目录：仅 .json 文件；缓存命中且 mtime 未变则不读文件，否则读一次刷新名称+统计。 */
export async function folderList(dir: DirHandleLike, cache: Record<string, FolderCacheEntry>,
  onCache?: (fn: string, patch: Partial<FolderCacheEntry>) => void): Promise<FolderMapEntry[]> {
  const out: FolderMapEntry[] = [];
  try {
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== "file" || !/\.json$/i.test(name)) continue;
      let file: FileLike | null = null;
      try { file = await (h as unknown as FileHandleLike).getFile(); } catch { continue; }
      const c = cache[name] || {};
      const ent: FolderMapEntry = { id: name, name: c.name || name.replace(/\.json$/i, ""),
        counts: c.counts || {}, thumb: c.thumb, view: c.view, year: c.year, updatedAt: file.lastModified };
      if (c.mtime !== file.lastModified || !c.counts) {   // 文件被外部改过/无缓存→读一次刷新（缩略图沿用旧缓存）
        try {
          const w = JSON.parse(await file.text());
          if (w && w.meta && Array.isArray(w.nodes)) {
            ent.name = w.meta.名称 || ent.name;
            ent.counts = countsOf(w);
            onCache?.(name, { name: ent.name, counts: ent.counts as MapCounts, mtime: file.lastModified });
          }
        } catch { /* 坏 JSON：按文件名列出，打开时再报错 */ }
      }
      out.push(ent);
    }
  } catch { /* 句柄失效/权限被收回：返回已收集部分 */ }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function folderReadWorld(dir: DirHandleLike, fn: string): Promise<World | null> {
  try {
    const h = await dir.getFileHandle(fn);
    const w = JSON.parse(await (await h.getFile()).text());
    if (w && w.meta && Array.isArray(w.nodes)) return w as World;
  } catch { /* 缺文件/坏 JSON → null */ }
  return null;
}

export async function folderWriteWorld(dir: DirHandleLike, fn: string, world: World): Promise<boolean> {
  try {
    const h = await dir.getFileHandle(fn, { create: true });
    const ws = await h.createWritable();
    await ws.write(JSON.stringify(world, null, 1));
    await ws.close();
    return true;
  } catch { return false; }
}

export async function folderUniqueFilename(dir: DirHandleLike, base: unknown): Promise<string> {
  const name = safeName(base);
  let fn = name + ".json", i = 2;
  const exists = async (f: string) => { try { await dir.getFileHandle(f); return true; } catch { return false; } };
  while (await exists(fn)) { fn = name + "-" + i + ".json"; i++; }
  return fn;
}

/** 新建：规范化 → 不重名落盘 → 回写缓存；失败返回 null（权限/磁盘） */
export async function folderCreate(dir: DirHandleLike, world: unknown,
  onCache?: (fn: string, patch: Partial<FolderCacheEntry>) => void): Promise<string | null> {
  const w = normalizeWorld(world);
  const fn = await folderUniqueFilename(dir, (w.meta && w.meta.名称) || "新地图");
  if (!(await folderWriteWorld(dir, fn, w))) return null;
  onCache?.(fn, { name: (w.meta && w.meta.名称) || fn, counts: countsOf(w), mtime: Date.now() });
  return fn;
}

export async function folderRemove(dir: DirHandleLike, fn: string): Promise<void> {
  try { await dir.removeEntry(fn); } catch { /* 已被外部删除=达成目的 */ }
}
