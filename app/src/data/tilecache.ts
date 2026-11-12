/* 分块精修的块缓存：按 core/tiles.tileKey 内容寻址存块心（每块约 1 MB，一张大陆级图一百多块）。
   与侵蚀场缓存分库：块的写入量大，配额出事只清本库，不连累整场缓存；同为性能层，任何失败都静默降级为「未命中→照旧重算」。
   条目按 touch 表的时间戳 LRU 封顶；开库时清掉算法代号或块代号不同的存货。 */
import { openDB, reqP, txDone } from "./idb.ts";
import { ERODE_VER } from "../core/erode.ts";
import { TILE_VER } from "../core/tiles.ts";

const DB = "yutu2-tilecache";
const STORES = ["tiles", "touch"] as const;
/** 条目上限：约七张大陆级图的块（每块约 1 MB）。开图要等全图的块到齐，放不下的图每次重开都得重算一分钟 */
export const TILE_CACHE_CAP = 1024;

let dbP: Promise<IDBDatabase | null> | null = null;
let warned = false;
const moan = (e: unknown): void => {
  if (!warned) { warned = true; console.warn("分块精修缓存不可用（照常重算，不影响功能）：", e); }
};
const live = (k: string): boolean => k.startsWith(ERODE_VER + "-") && k.endsWith("~t" + TILE_VER);

function open(): Promise<IDBDatabase | null> {
  if (dbP) return dbP;
  dbP = (async () => {
    if (typeof indexedDB === "undefined") return null;
    try {
      const db = await openDB(DB, 1, d => {
        d.createObjectStore("tiles", { keyPath: "key" });
        d.createObjectStore("touch", { keyPath: "key" }).createIndex("t", "t");
      });
      const t = db.transaction(STORES, "readwrite");
      for (const s of STORES) {
        const q = t.objectStore(s).openKeyCursor();
        q.onsuccess = () => { const c = q.result; if (!c) return; if (!live(String(c.key))) t.objectStore(s).delete(c.key); c.continue(); };
      }
      await txDone(t);
      return db;
    } catch (e) { moan(e); return null; }
  })();
  return dbP;
}

/** 取一块（背拍更新 LRU 时间戳）；未命中或任何故障＝null */
export async function tileCacheGet(key: string): Promise<Float32Array | null> {
  const db = await open();
  if (!db) return null;
  try {
    const e = await reqP<{ data: Float32Array } | undefined>(db.transaction("tiles", "readonly").objectStore("tiles").get(key));
    if (!e) return null;
    void (async () => {
      try { const t = db.transaction("touch", "readwrite"); t.objectStore("touch").put({ key, t: Date.now() }); await txDone(t); } catch { /* LRU 次序略旧，无碍 */ }
    })();
    return e.data;
  } catch (e) { moan(e); return null; }
}

/** 存一块（尽力而为，永不抛）；超 CAP 按时间戳淘汰最旧，写失败整库清空 */
export async function tileCachePut(key: string, data: Float32Array, now = Date.now()): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const t = db.transaction(STORES, "readwrite");
    t.objectStore("tiles").put({ key, data });
    t.objectStore("touch").put({ key, t: now });
    await txDone(t);
    const t2 = db.transaction(STORES, "readwrite");
    const s2 = t2.objectStore("tiles"), u2 = t2.objectStore("touch");
    let drop = (await reqP(s2.count())) - TILE_CACHE_CAP;
    if (drop > 0) {
      const q = u2.index("t").openKeyCursor();
      q.onsuccess = () => {
        const c = q.result;
        if (!c || drop <= 0) return;
        s2.delete(c.primaryKey); u2.delete(c.primaryKey); drop--;
        c.continue();
      };
    }
    await txDone(t2);
  } catch (e) {
    moan(e);
    try { const t = db.transaction(STORES, "readwrite"); for (const s of STORES) t.objectStore(s).clear(); await txDone(t); } catch { /* 尽力而为 */ }
  }
}
