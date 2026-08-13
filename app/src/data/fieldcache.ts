/* 侵蚀细分场缓存：按「算法代号＋输入内容」寻址（core/erode.erodeKey）存 Worker 算好的场。
   侵蚀是确定性纯函数——命中＝与重算逐位同一结果，开图/撤销/拨回看过的年份即时上真形，
   免去 1~2s 的可见「先粗后细」换场（用户实报读感像「还在施工/出错了」）。
   ⚠ 这是性能层不是数据层：任何失败（无 indexedDB/私隐模式拒开库/配额）一律静默降级为
     「未命中→照旧重算」，不进用户回执——「失败要响」约束的是会丢用户数据的路径，这里丢的
     只是一次省时机会；console.warn 留一条诊断线索（只响一次）。
   ⚠ 独立库 yutu2-fieldcache，不并进 yutu2：图库那边有版本守卫与多标签语义要护，而缓存是
     内容寻址的幂等写（两个标签写同键必同值），无冲突可言，隔离最省心。
   条目按 lastUsed LRU 封顶（CAP 条 × 单条 ≤~10.6MB[erode 战术预算 140 万格]≈85MB 上限——
   预算分档批 CAP 随之 20→8，免得战术大条目把 IDB 吃到配额线）；
   开库时清掉算法代号不同的存货（键前缀即代号，openKeyCursor 不掏兆级的值）；
   配额写失败时整仓清空——省时层绝不挤占数据层的存储余量。 */
import { openDB, reqP, txDone } from "./idb.ts";
import { ERODE_VER } from "../core/erode.ts";
import type { ElevField } from "../core/elev.ts";

const DB = "yutu2-fieldcache";
export const FIELD_CACHE_CAP = 8;

let dbP: Promise<IDBDatabase | null> | null = null;
let warned = false;
const moan = (e: unknown): void => {
  if (!warned) { warned = true; console.warn("侵蚀场缓存不可用（照常重算，不影响功能）：", e); }
};

function open(): Promise<IDBDatabase | null> {
  if (dbP) return dbP;
  dbP = (async () => {
    if (typeof indexedDB === "undefined") return null;
    try {
      const db = await openDB(DB, 1, d => {
        if (!d.objectStoreNames.contains("fields")) d.createObjectStore("fields", { keyPath: "key" }).createIndex("t", "t");
      });
      /* 换代清场（等它做完再放行首个 get＝测试可判定；量 ≤CAP 条键游标，毫秒级） */
      const t = db.transaction("fields", "readwrite"), s = t.objectStore("fields");
      const q = s.openKeyCursor();
      q.onsuccess = () => {
        const c = q.result;
        if (!c) return;
        if (!String(c.key).startsWith(ERODE_VER + "-")) s.delete(c.key);
        c.continue();
      };
      await txDone(t);
      return db;
    } catch (e) { moan(e); return null; }
  })();
  return dbP;
}

/** 取（并背拍更新 lastUsed，不占取用延迟）；未命中/任何故障＝null */
export async function fieldCacheGet(key: string): Promise<ElevField | null> {
  const db = await open();
  if (!db) return null;
  try {
    const e = await reqP<{ t: number } & ElevField | undefined>(
      db.transaction("fields", "readonly").objectStore("fields").get(key));
    if (!e) return null;
    void (async () => {
      try {
        const t = db.transaction("fields", "readwrite");
        t.objectStore("fields").put({ ...e, t: Date.now() });
        await txDone(t);
      } catch { /* touch 失败＝LRU 次序略旧，无碍 */ }
    })();
    return { data: e.data, shadow: e.shadow, cols: e.cols, rows: e.rows, step: e.step, bb: e.bb };
  } catch (e) { moan(e); return null; }
}

/** 存（尽力而为，永不抛；now 可注入供测试定 LRU 次序）。超 CAP 按 lastUsed 淘汰最旧。 */
export async function fieldCachePut(key: string, f: ElevField, now = Date.now()): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const t = db.transaction("fields", "readwrite"), s = t.objectStore("fields");
    s.put({ key, t: now, data: f.data, shadow: f.shadow, cols: f.cols, rows: f.rows, step: f.step, bb: f.bb });
    await txDone(t);
    const t2 = db.transaction("fields", "readwrite"), s2 = t2.objectStore("fields");
    let drop = (await reqP(s2.count())) - FIELD_CACHE_CAP;
    if (drop > 0) {
      const q = s2.index("t").openKeyCursor();   // t 升序＝最旧在前；键游标不掏值
      q.onsuccess = () => {
        const c = q.result;
        if (!c || drop <= 0) return;
        s2.delete(c.primaryKey); drop--;
        c.continue();
      };
    }
    await txDone(t2);
  } catch (e) {
    moan(e);
    /* 配额吃紧的环境里主动清仓让位给图库（写都写不进＝缓存已无意义） */
    try { const t = db.transaction("fields", "readwrite"); t.objectStore("fields").clear(); await txDone(t); } catch { /* 尽力而为 */ }
  }
}
