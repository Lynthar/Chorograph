/* 侵蚀细分场缓存：按「算法代号＋输入内容」寻址（core/erode.erodeKey）存 Worker 算好的场。
   侵蚀是确定性纯函数——命中＝与重算逐位同一结果，开图/撤销/拨回看过的年份即时上真形，
   免去 1~2s 的可见「先粗后细」换场（用户实报读感像「还在施工/出错了」）。
   ⚠ 这是性能层不是数据层：任何失败（无 indexedDB/私隐模式拒开库/配额）一律静默降级为
     「未命中→照旧重算」，不进用户回执——「失败要响」约束的是会丢用户数据的路径，这里丢的
     只是一次省时机会；console.warn 留一条诊断线索（只响一次）。
   ⚠ 独立库 yutu2-fieldcache，不并进 yutu2：图库那边有版本守卫与多标签语义要护，而缓存是
     内容寻址的幂等写（两个标签写同键必同值），无冲突可言，隔离最省心。
   ⚠ **LRU 时间戳单独存 touch 表，绝不写回 fields**（2026-08-31 审查）：IDB 记录是整条覆盖的，
     把 lastUsed 放在场记录里意味着每次命中都要把整份场重写一遍——4K 精修场单条 ~79MB，
     拨年来回扫几趟就是几百兆的无谓写入。touch 一条只有几十字节。
   条目按 lastUsed LRU 封顶（CAP=8 条；单条随档位悬殊：战术工作档 ~10.6MB、4K 静置精修场
   可到 ~79MB＝最坏 ~630MB——量级账在 CLAUDE.md「4K 静置精修」节，超配额由下述清仓兜底）；
   开库时清掉算法代号不同的存货（键前缀即代号，openKeyCursor 不掏兆级的值）；
   配额写失败时整仓清空——省时层绝不挤占数据层的存储余量。 */
import { openDB, reqP, txDone } from "./idb.ts";
import { ERODE_VER } from "../core/erode.ts";
import type { ElevField } from "../core/elev.ts";

const DB = "yutu2-fieldcache";
const VER = 2;                             // 2＝LRU 时间戳拆出 touch 表（见头注）
const STORES = ["fields", "touch"] as const;
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
      const db = await openDB(DB, VER, d => {
        if (!d.objectStoreNames.contains("fields")) d.createObjectStore("fields", { keyPath: "key" }).createIndex("t", "t");
        if (!d.objectStoreNames.contains("touch")) d.createObjectStore("touch", { keyPath: "key" }).createIndex("t", "t");
      });
      /* 开库整理（等它做完再放行首个 get＝测试可判定；量 ≤CAP 条键游标，毫秒级）：
         ① 换代清场——键前缀即算法代号，非当代的场留着会让旧观感还魂；
         ② touch 补账——v1 存货的 lastUsed 还埋在场记录里，这里按「最旧」补一条，
            让它们排在淘汰队首（缓存是可弃的，宁可先让位给本代新算的场）。 */
      const t = db.transaction(STORES, "readwrite");
      const sf = t.objectStore("fields"), st = t.objectStore("touch");
      const live = new Set<string>();
      const qf = sf.openKeyCursor();
      qf.onsuccess = () => {
        const c = qf.result;
        if (!c) {
          const qt = st.openKeyCursor();      // touch 侧同步清理：场没了的键不该继续占淘汰队
          qt.onsuccess = () => {
            const d = qt.result;
            if (!d) { for (const k of live) st.add({ key: k, t: 0 }); return; }   // add＝已有则静默失败，不覆盖真时间戳
            if (!live.has(String(d.key))) st.delete(d.key); else live.delete(String(d.key));
            d.continue();
          };
          return;
        }
        const k = String(c.key);
        if (k.startsWith(ERODE_VER + "-")) live.add(k); else sf.delete(c.key);
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
    const e = await reqP<ElevField | undefined>(
      db.transaction("fields", "readonly").objectStore("fields").get(key));
    if (!e) return null;
    void (async () => {
      try {
        const t = db.transaction("touch", "readwrite");
        t.objectStore("touch").put({ key, t: Date.now() });   // 几十字节；场记录一个字节都不动
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
    const t = db.transaction(STORES, "readwrite");
    t.objectStore("fields").put({ key, data: f.data, shadow: f.shadow, cols: f.cols, rows: f.rows, step: f.step, bb: f.bb });
    t.objectStore("touch").put({ key, t: now });
    await txDone(t);
    const t2 = db.transaction(STORES, "readwrite");
    const s2 = t2.objectStore("fields"), u2 = t2.objectStore("touch");
    let drop = (await reqP(s2.count())) - FIELD_CACHE_CAP;
    if (drop > 0) {
      const q = u2.index("t").openKeyCursor();   // t 升序＝最旧在前；键游标不掏值
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
    /* 配额吃紧的环境里主动清仓让位给图库（写都写不进＝缓存已无意义） */
    try {
      const t = db.transaction(STORES, "readwrite");
      for (const s of STORES) t.objectStore(s).clear();
      await txDone(t);
    } catch { /* 尽力而为 */ }
  }
}
