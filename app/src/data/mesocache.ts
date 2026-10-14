/* 中尺度稳态缓存：按 core/gen2.mesoKey 内容寻址存稳态解（高程 Float64 + 流向 Int32，整球图约 18 MB），重开图免去 6–30 s 的求解。
   存解本身而不是派生的基底：画抬升的影响带重解要求起点与现算逐位同。同为性能层，任何失败都静默降级为「未命中→照旧现算」。
   独立成库：侵蚀场缓存开库时会清掉不是侵蚀算法代号开头的键。条目按 touch 表的时间戳 LRU 封顶；开库时清掉中尺度代号不同的存货。 */
import { openDB, reqP, txDone } from "./idb.ts";
import { MESO_VER, type Gen2Sg } from "../core/gen2.ts";

const DB = "yutu2-mesocache";
const STORES = ["sg", "touch"] as const;
/** 条目上限：几张图来回切换够用，整球图每条约 18 MB */
export const MESO_CACHE_CAP = 6;

let dbP: Promise<IDBDatabase | null> | null = null;
let warned = false;
const moan = (e: unknown): void => {
  if (!warned) { warned = true; console.warn("中尺度缓存不可用（照常现算，不影响功能）：", e); }
};
const live = (k: string): boolean => k.startsWith("m" + MESO_VER + ":");

function open(): Promise<IDBDatabase | null> {
  if (dbP) return dbP;
  dbP = (async () => {
    if (typeof indexedDB === "undefined") return null;
    try {
      const db = await openDB(DB, 1, d => {
        d.createObjectStore("sg", { keyPath: "key" });
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

/** 取一份稳态解（背拍更新 LRU 时间戳）；未命中或任何故障＝null */
export async function mesoCacheGet(key: string): Promise<Gen2Sg | null> {
  const db = await open();
  if (!db) return null;
  try {
    const e = await reqP<{ h: Float64Array; rcv: Int32Array } | undefined>(db.transaction("sg", "readonly").objectStore("sg").get(key));
    if (!e) return null;
    void (async () => {
      try { const t = db.transaction("touch", "readwrite"); t.objectStore("touch").put({ key, t: Date.now() }); await txDone(t); } catch { /* LRU 次序略旧，无碍 */ }
    })();
    return { h: e.h, rcv: e.rcv };
  } catch (e) { moan(e); return null; }
}

/** 存一份（尽力而为，永不抛）；超 CAP 按时间戳淘汰最旧，写失败整库清空 */
export async function mesoCachePut(key: string, sg: Gen2Sg, now = Date.now()): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const t = db.transaction(STORES, "readwrite");
    t.objectStore("sg").put({ key, h: sg.h, rcv: sg.rcv });
    t.objectStore("touch").put({ key, t: now });
    await txDone(t);
    const t2 = db.transaction(STORES, "readwrite");
    const s2 = t2.objectStore("sg"), u2 = t2.objectStore("touch");
    let drop = (await reqP(s2.count())) - MESO_CACHE_CAP;
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
