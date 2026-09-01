/* 数据层测试：IndexedDB 图库 / localStorage 旧档迁移 / 文件夹图库。
   indexedDB 由 fake-indexeddb 提供（纯 JS devDependency，进程内内存实现——node --test
   每个文件独立进程，互不污染）；目录句柄用 40 行内存替身实现 folder.ts 的结构面。 */
import "fake-indexeddb/auto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openLibrary, newMapId, type Library } from "../src/data/library.ts";
import { migrateFromLocalStorage, migrateFolderHandle, type LSLike } from "../src/data/migrate.ts";
import { fcachePatch, fcacheRemove, folderCreate, folderList, folderMtime, folderReadWorld, folderRemove,
  folderReadWorldAt, folderUniqueFilename, folderWriteWorld, type DirHandleLike, type FolderCache, type FolderCacheEntry } from "../src/data/folder.ts";
import { isStaleError, staleError, staleWrite } from "../src/data/guard.ts";
import { openDB, reqP, txDone } from "../src/data/idb.ts";
import { parseTemplates, pickCalendarCfg, removeTemplate, upsertTemplate, type CalTemplate } from "../src/data/calstore.ts";
import { createTabSync, tabMapKey, TAB_WARN_OPEN, TAB_WARN_SAVED, type TabMsg } from "../src/data/tabsync.ts";

let seq = 0;
const freshLib = () => openLibrary("test-db-" + (++seq));
const mkLS = (obj: Record<string, string>): LSLike => ({ getItem: k => (k in obj ? obj[k] : null) });

/* —— 内存目录句柄（folder.ts 结构面的测试替身；_reads 计数用于断言缓存避免重读） —— */
function memDir(name = "地图夹", init: Record<string, string> = {}) {
  let clock = 1000;
  const files: Record<string, string> = { ...init };
  const mt: Record<string, number> = {};
  for (const k of Object.keys(files)) mt[k] = ++clock;
  let reads = 0;
  const fileHandle = (fn: string) => ({
    kind: "file",
    async getFile() { return { lastModified: mt[fn], async text() { reads++; return files[fn]; } }; },
    async createWritable() {
      let buf = "";
      return { async write(d: string) { buf = d; }, async close() { files[fn] = buf; mt[fn] = ++clock; } };
    }
  });
  const dir = {
    name,
    async *entries(): AsyncGenerator<[string, { kind: string }]> {
      for (const fn of Object.keys(files))
        yield fn.endsWith("/") ? [fn.slice(0, -1), { kind: "directory" }] : [fn, fileHandle(fn)];
    },
    async getFileHandle(fn: string, opts?: { create?: boolean }) {
      if (!(fn in files)) {
        if (!opts?.create) throw new Error("NotFound");
        files[fn] = ""; mt[fn] = ++clock;
      }
      return fileHandle(fn);
    },
    async removeEntry(fn: string) { if (!(fn in files)) { const e = new Error("NotFound"); e.name = "NotFoundError"; throw e; } delete files[fn]; },   // 名字对齐真 DOMException（folderRemove 按 name 判幂等）
    _touch(fn: string, content: string) { files[fn] = content; mt[fn] = ++clock; },
    _files: files,
    get _reads() { return reads; }
  };
  return dir as DirHandleLike & typeof dir;
}

describe("IndexedDB 图库", () => {
  it("create → list → getWorld 往返；入库即规范化", async () => {
    const lib = await freshLib();
    const e = await lib.create({ meta: { 名称: "甲图" }, nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }, { id: "e", type: "event", lon: 1, lat: 2 }],
      units: [{ id: "u", kind: "cav", track: [{ t: 2, lon: 0, lat: 0 }, { t: 1, lon: 1, lat: 1 }] }] });
    assert.match(e.id, /^m[a-z0-9]+$/);
    assert.strictEqual(e.name, "甲图");
    assert.deepStrictEqual(e.counts, { nodes: 1, events: 1, factions: 0 });
    const w = await lib.getWorld(e.id);
    assert.ok(Array.isArray(w!.factions), "入库前应过 normalizeWorld");
    assert.deepStrictEqual(w!.units[0].track.map(p => p.t), [1, 2]);
    const ls = await lib.list();
    assert.strictEqual(ls.length, 1);
    assert.strictEqual((await lib.getWorld("不存在")), null);
    lib.close();
  });
  it("列表按 updatedAt 倒序；over 可锁定 id/时间戳", async () => {
    const lib = await freshLib();
    await lib.create({ meta: { 名称: "旧" }, nodes: [] }, { id: "m1", updatedAt: 100 });
    await lib.create({ meta: { 名称: "新" }, nodes: [] }, { id: "m2", updatedAt: 300 });
    await lib.create({ meta: { 名称: "中" }, nodes: [] }, { id: "m3", updatedAt: 200 });
    assert.deepStrictEqual((await lib.list()).map(e => e.name), ["新", "中", "旧"]);
    lib.close();
  });
  it("save 覆写世界并同步 名称/统计/快照，推 updatedAt（可用 at 指定）", async () => {
    const lib = await freshLib();
    const e = await lib.create({ meta: { 名称: "原名" }, nodes: [] }, { updatedAt: 100 });
    await lib.save(e.id, { meta: { 名称: "改名" }, factions: [], nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }], edges: [], decor: [], terrainOverrides: [], units: [] },
      { view: { lon0: 5, lat0: 6, degPerPx: 0.1 }, year: 3100 }, 999);
    const e2 = (await lib.getEntry(e.id))!;
    assert.strictEqual(e2.name, "改名");
    assert.strictEqual(e2.counts.nodes, 1);
    assert.strictEqual(e2.updatedAt, 999);
    assert.deepStrictEqual(e2.view, { lon0: 5, lat0: 6, degPerPx: 0.1 });
    assert.strictEqual(e2.year, 3100);
    lib.close();
  });
  it("patchEntry：undefined 跳过（旧版 upsertEntry 语义）；bump 才推时间", async () => {
    const lib = await freshLib();
    const e = await lib.create({ meta: { 名称: "图" }, nodes: [] }, { updatedAt: 100 });
    await lib.patchEntry(e.id, { thumb: "data:1", year: undefined }, false);
    let e2 = (await lib.getEntry(e.id))!;
    assert.strictEqual(e2.thumb, "data:1");
    assert.ok(!("year" in e2) || e2.year === undefined);
    assert.strictEqual(e2.updatedAt, 100, "bump=false 不动 updatedAt");
    await lib.patchEntry(e.id, { year: 3200 }, true);
    e2 = (await lib.getEntry(e.id))!;
    assert.ok(e2.updatedAt > 100, "bump=true 推 updatedAt");
    await lib.patchEntry("不存在", { year: 1 }, true);   // 静默无事
    lib.close();
  });
  it("remove 同时清世界与条目，lastMap 指向它时一并清", async () => {
    const lib = await freshLib();
    const e = await lib.create({ meta: { 名称: "删我" }, nodes: [] });
    await lib.kvSet("lastMap", e.id);
    await lib.remove(e.id);
    assert.strictEqual(await lib.getWorld(e.id), null);
    assert.strictEqual(await lib.getEntry(e.id), null);
    assert.strictEqual(await lib.kvGet("lastMap"), undefined);
    lib.close();
  });
  it("kv 存取删（含结构化对象）", async () => {
    const lib = await freshLib();
    await lib.kvSet("foldercache", { 夹: { "a.json": { name: "甲" } } });
    assert.deepStrictEqual(await lib.kvGet("foldercache"), { 夹: { "a.json": { name: "甲" } } });
    await lib.kvDel("foldercache");
    assert.strictEqual(await lib.kvGet("foldercache"), undefined);
    lib.close();
  });
  it("newMapId 形如旧版 m 前缀 base36", () => {
    for (let i = 0; i < 20; i++) assert.match(newMapId(), /^m[a-z0-9]{6,}$/);
  });
});

describe("localStorage 旧档迁移", () => {
  const OLD_IDX = [
    { id: "lsA", name: "甲", createdAt: 10, updatedAt: 1000, thumb: "data:a", view: { lon0: 1, lat0: 2, degPerPx: 0.06 }, year: 3100 },
    { id: "lsB", name: "乙", createdAt: 20, updatedAt: 2000 }
  ];
  const WORLDS: Record<string, string> = {
    "yutu.maps.v1": JSON.stringify(OLD_IDX),
    "yutu.map.lsA": JSON.stringify({ meta: { 名称: "甲图" }, nodes: [{ id: "n", type: "city", lon: 1, lat: 2 }] }),
    "yutu.map.lsB": JSON.stringify({ meta: { 名称: "乙图" }, nodes: [] })
  };
  it("全新导入：条目保留旧时间线/缩略图/视角，世界规范化入库；重跑幂等", async () => {
    const lib = await freshLib();
    const r1 = await migrateFromLocalStorage(lib, mkLS(WORLDS));
    assert.deepStrictEqual(r1, { imported: 2, updated: 0, skipped: 0 });
    const es = await lib.list();
    assert.strictEqual(es.length, 2);
    const a = es.find(e => e.srcLS!.id === "lsA")!;
    assert.strictEqual(a.name, "甲图");             // 名称以世界 meta 为准
    assert.strictEqual(a.createdAt, 10);
    assert.strictEqual(a.updatedAt, 1000);
    assert.strictEqual(a.thumb, "data:a");
    assert.deepStrictEqual(a.view, { lon0: 1, lat0: 2, degPerPx: 0.06 });
    assert.strictEqual(a.year, 3100);
    assert.deepStrictEqual(a.srcLS, { id: "lsA", updatedAt: 1000, entryUpdatedAt: 1000 });
    assert.ok(Array.isArray((await lib.getWorld(a.id))!.factions));
    const r2 = await migrateFromLocalStorage(lib, mkLS(WORLDS));
    assert.deepStrictEqual(r2, { imported: 0, updated: 0, skipped: 2 });
    assert.strictEqual((await lib.list()).length, 2);
    lib.close();
  });
  it("旧版又改过且新库未动 → 增量覆入；新库动过 → 保守跳过", async () => {
    const lib = await freshLib();
    await migrateFromLocalStorage(lib, mkLS(WORLDS));
    const bumped = {
      ...WORLDS,
      "yutu.maps.v1": JSON.stringify([{ ...OLD_IDX[0], updatedAt: 5000 }, OLD_IDX[1]]),
      "yutu.map.lsA": JSON.stringify({ meta: { 名称: "甲图改" }, nodes: [] })
    };
    const r = await migrateFromLocalStorage(lib, mkLS(bumped));
    assert.deepStrictEqual(r, { imported: 0, updated: 1, skipped: 1 });
    const a = (await lib.list()).find(e => e.srcLS!.id === "lsA")!;
    assert.strictEqual(a.name, "甲图改");
    assert.strictEqual(a.updatedAt, 5000);
    assert.deepStrictEqual(a.srcLS, { id: "lsA", updatedAt: 5000, entryUpdatedAt: 5000 });
    // 新库侧编辑过（updatedAt 偏离 entryUpdatedAt）→ 即便旧版更新也不覆盖
    await lib.patchEntry(a.id, { name: "本地改名" }, true);
    const again = { ...bumped, "yutu.maps.v1": JSON.stringify([{ ...OLD_IDX[0], updatedAt: 9000 }, OLD_IDX[1]]) };
    const r2 = await migrateFromLocalStorage(lib, mkLS(again));
    assert.deepStrictEqual(r2, { imported: 0, updated: 0, skipped: 2 });
    assert.strictEqual(((await lib.getEntry(a.id))!).name, "本地改名");
    lib.close();
  });
  it("坏档跳过不炸；索引坏 JSON 视为无旧档", async () => {
    const lib = await freshLib();
    const r = await migrateFromLocalStorage(lib, mkLS({
      "yutu.maps.v1": JSON.stringify([{ id: "ok", updatedAt: 1 }, { id: "lost", updatedAt: 2 }, { id: "bad", updatedAt: 3 }]),
      "yutu.map.ok": JSON.stringify({ meta: {}, nodes: [] }),
      "yutu.map.bad": "{烂"
    }));
    assert.deepStrictEqual(r, { imported: 1, updated: 0, skipped: 2 });
    assert.deepStrictEqual(await migrateFromLocalStorage(lib, mkLS({ "yutu.maps.v1": "『非法" })), { imported: 0, updated: 0, skipped: 0 });
    lib.close();
  });
  it("更老的单槽自动存档：无索引时导入一次，幂等", async () => {
    const lib = await freshLib();
    const ls = mkLS({ "yutu.autosave.v1": JSON.stringify({ meta: { 名称: "单槽" }, nodes: [] }) });
    assert.deepStrictEqual(await migrateFromLocalStorage(lib, ls), { imported: 1, updated: 0, skipped: 0 });
    assert.deepStrictEqual(await migrateFromLocalStorage(lib, ls), { imported: 0, updated: 0, skipped: 0 });
    const es = await lib.list();
    assert.strictEqual(es.length, 1);
    assert.strictEqual(es[0].name, "单槽");
    lib.close();
  });
  it("旧文件夹句柄：旧库不存在 → no-op 且不隐式创建", async () => {
    const lib = await freshLib();
    assert.strictEqual(await migrateFolderHandle(lib), false);
    const dbs = await indexedDB.databases();
    assert.ok(!dbs.some(d => d.name === "yutu"), "不应把旧库 yutu 创建出来");
    lib.close();
  });
  it("旧文件夹句柄：存在则拷入新库 kv，已有则不重拷", async () => {
    const old = await openDB("yutu", 1, d => d.createObjectStore("kv"));
    const t = old.transaction("kv", "readwrite");
    t.objectStore("kv").put({ name: "我的地图夹", kind: "directory" }, "libDir");
    await txDone(t);
    old.close();
    const lib = await freshLib();
    assert.strictEqual(await migrateFolderHandle(lib), true);
    assert.deepStrictEqual(await lib.kvGet("libDir"), { name: "我的地图夹", kind: "directory" });
    assert.strictEqual(await migrateFolderHandle(lib), false);
    lib.close();
  });
});

describe("文件夹图库", () => {
  const W = (名称: string) => JSON.stringify({ meta: { 名称 }, nodes: [{ id: "a", type: "city", lon: 1, lat: 2 }] });
  it("folderList：只列 .json 文件；名称/统计读自文件并回写缓存；mtime 未变不重读", async () => {
    const dir = memDir("夹", { "甲.json": W("玄甲图"), "乙.json": W("乙图"), "备注.txt": "x", "子目录/": "" });
    const cache: Record<string, FolderCacheEntry> = {};
    const onCache = (fn: string, p: Partial<FolderCacheEntry>) => { fcachePatch({ 夹: cache }, "夹", fn, p); };
    let ls = await folderList(dir, cache, onCache);
    assert.deepStrictEqual(ls.map(e => e.id).sort(), ["乙.json", "甲.json"]);
    assert.strictEqual(ls.find(e => e.id === "甲.json")!.name, "玄甲图");
    assert.strictEqual(ls.find(e => e.id === "甲.json")!.counts.nodes, 1);
    const readsAfterFirst = dir._reads;
    ls = await folderList(dir, cache, onCache);
    assert.strictEqual(dir._reads, readsAfterFirst, "缓存命中不应再读文件");
    dir._touch("乙.json", W("乙图新"));
    ls = await folderList(dir, cache, onCache);
    assert.strictEqual(dir._reads, readsAfterFirst + 1, "外部改过的文件读一次刷新");
    assert.strictEqual(ls[0].id, "乙.json", "按修改时间倒序");
    assert.strictEqual(ls[0].name, "乙图新");
  });
  it("坏 JSON 不炸：按文件名列出", async () => {
    const dir = memDir("夹", { "烂.json": "{x" });
    const ls = await folderList(dir, {});
    assert.strictEqual(ls.length, 1);
    assert.strictEqual(ls[0].name, "烂");
  });
  it("读写往返：写入 1 空格缩进 JSON；非世界形状读回 null", async () => {
    const dir = memDir();
    const w = { meta: { 名称: "写" }, factions: [], nodes: [], edges: [], decor: [], terrainOverrides: [], units: [] };
    assert.strictEqual((await folderWriteWorld(dir, "写.json", w as never)).ok, true);
    assert.strictEqual(dir._files["写.json"], JSON.stringify(w, null, 1));
    assert.deepStrictEqual(await folderReadWorld(dir, "写.json"), w);
    assert.strictEqual(await folderReadWorld(dir, "没有.json"), null);
    dir._touch("怪.json", JSON.stringify({ foo: 1 }));
    assert.strictEqual(await folderReadWorld(dir, "怪.json"), null);
  });
  it("folderUniqueFilename：冲突追 -2/-3；folderCreate 规范化入盘并回写缓存", async () => {
    const dir = memDir("夹", { "新图.json": "{}" });
    assert.strictEqual(await folderUniqueFilename(dir, "新图"), "新图-2.json");
    const patches: [string, Partial<FolderCacheEntry>][] = [];
    const fn = await folderCreate(dir, { meta: { 名称: "新图" }, nodes: [] }, (f, p) => patches.push([f, p]));
    assert.strictEqual(fn, "新图-2.json");
    const stored = JSON.parse(dir._files[fn!]);
    assert.ok(Array.isArray(stored.factions), "落盘前应过 normalizeWorld");
    assert.strictEqual(patches[0][0], fn);
    assert.strictEqual(patches[0][1].name, "新图");
    const fn2 = await folderCreate(dir, { meta: { 名称: "新图" }, nodes: [] });
    assert.strictEqual(fn2, "新图-3.json");
  });
  it("folderRemove 幂等且报结果（真删/已不在=true，权限失败=false）；文件名净化防目录穿越", async () => {
    const dir = memDir("夹", { "删.json": "{}" });
    assert.strictEqual(await folderRemove(dir, "删.json"), true);
    assert.ok(!("删.json" in dir._files));
    assert.strictEqual(await folderRemove(dir, "删.json"), true, "再删不炸＝幂等达成目的");
    const locked = { ...dir, removeEntry: async () => { const e = new Error("denied"); e.name = "NotAllowedError"; throw e; } };
    assert.strictEqual(await folderRemove(locked as typeof dir, "x.json"), false, "权限失败必须报 false（假删除之防）");
    assert.strictEqual(await folderUniqueFilename(dir, "../越权"), "_越权.json");
  });
  it("fcachePatch/fcacheRemove：按文件夹名分区，undefined 跳过", () => {
    const all: FolderCache = {};
    fcachePatch(all, "夹A", "a.json", { name: "甲", thumb: undefined });
    fcachePatch(all, "夹B", "a.json", { name: "另一个甲" });
    assert.deepStrictEqual(all.夹A["a.json"], { name: "甲" });
    assert.strictEqual(all.夹B["a.json"].name, "另一个甲");
    fcacheRemove(all, "夹A", "a.json");
    assert.deepStrictEqual(all.夹A, {});
    fcacheRemove(all, "没有的夹", "x.json");                 // 不炸
  });
});

/* —— 自动保存调度：flush 须等在途写完（此前在途中 pending 已复位、flush 假性早退——
   切图前 flush 谎报「已落盘」）；慢速写（文件夹库）不并发写同一文件。 —— */
import { createAutosave } from "../src/data/autosave.ts";

describe("自动保存调度", () => {
  const tick = (ms: number) => new Promise(r => setTimeout(r, ms));
  it("flush 等待在途保存完成", async () => {
    let release!: () => void;
    let saves = 0;
    const as = createAutosave(() => new Promise<void>(r => { saves++; release = r; }), 1);
    as.touch();
    await tick(10);                       // 计时器已触发，save 在途且 pending 已复位
    assert.strictEqual(saves, 1);
    let flushed = false;
    const f = as.flush().then(() => { flushed = true; });
    await tick(10);
    assert.strictEqual(flushed, false, "在途未完，flush 不得早退");
    release();
    await f;
    assert.strictEqual(flushed, true);
    assert.strictEqual(as.pending, false);
  });
  it("save 期间的新 touch：flush 等完在途后再补一轮，落盘最终态", async () => {
    let release!: () => void;
    let saves = 0;
    const as = createAutosave(() => new Promise<void>(r => { saves++; release = r; }), 1);
    as.touch();
    await tick(10);                       // save#1 在途
    as.touch();                           // 在途期间又脏了
    const f = as.flush();
    release();                            // 放行 save#1 → flush 应再跑 save#2
    await tick(5);
    release();                            // 放行 save#2
    await f;
    assert.strictEqual(saves, 2);
    assert.strictEqual(as.pending, false);
  });
  it("慢速写不并发（计时器与 flush 串行排队）", async () => {
    let active = 0, maxActive = 0, total = 0;
    const as = createAutosave(async () => {
      active++; maxActive = Math.max(maxActive, active); total++;
      await tick(20);
      active--;
    }, 1);
    as.touch();
    await tick(8);                        // save#1 在途
    as.touch();                           // 新计时器将在 save#1 结束前触发 → 须排队
    await as.flush();
    assert.strictEqual(maxActive, 1, "同一时刻至多一个 save 在途");
    assert.strictEqual(total, 2);
    assert.strictEqual(as.pending, false);
  });
  it("写失败：pending 复位为 true、onError 上报，flush 不吞错", async () => {
    let fail = true;
    const errs: unknown[] = [];
    const as = createAutosave(() => { if (fail) throw new Error("磁盘炸了"); }, 1, e => errs.push(e));
    as.touch();
    await as.flush();
    assert.strictEqual(as.pending, true, "失败=仍脏");
    assert.strictEqual(errs.length, 1);
    fail = false;
    await as.flush();                     // 下次 flush 自然重试成功
    assert.strictEqual(as.pending, false);
  });
});

describe("多标签提醒（tabsync 协议）", () => {
  const mk = (tab: string) => {
    const posts: TabMsg[] = [], warns: string[] = [];
    const s = createTabSync(tab, m => posts.push(m), t => warns.push(t));
    return { s, posts, warns };
  };
  it("开图即打招呼；换图重置「已提醒」，回图库(null)不打招呼", () => {
    const a = mk("A");
    a.s.setMap("browser:m1");
    assert.deepStrictEqual(a.posts, [{ t: "open", map: "browser:m1", tab: "A" }]);
    a.s.setMap("browser:m1");                     // 同图重复设置＝不重复广播
    assert.strictEqual(a.posts.length, 1);
    a.s.setMap(null);                             // 回图库：不广播
    assert.strictEqual(a.posts.length, 1);
    a.s.setMap("browser:m2");
    assert.deepStrictEqual(a.posts[1], { t: "open", map: "browser:m2", tab: "A" });
  });
  it("同图互认：open 得到 here 回应，两边各提醒一次", () => {
    const a = mk("A"), b = mk("B");
    a.s.setMap("browser:m1"); b.s.setMap("browser:m1");
    b.s.receive(a.posts[0]);                      // B 收到 A 的 open
    assert.deepStrictEqual(b.warns, [TAB_WARN_OPEN]);
    assert.deepStrictEqual(b.posts[1], { t: "here", map: "browser:m1", tab: "B" });
    a.s.receive(b.posts[1]);                      // A 收到 B 的 here
    assert.deepStrictEqual(a.warns, [TAB_WARN_OPEN]);
    a.s.receive(b.posts[1]);                      // 重复不再提醒
    assert.strictEqual(a.warns.length, 1);
  });
  it("对方保存＝本地显示已过期，提醒一次即止（自动保存每笔都广播，不去重会刷屏）", () => {
    const a = mk("A"), b = mk("B");
    a.s.setMap("browser:m1"); b.s.setMap("browser:m1");
    a.s.saved(); a.s.saved(); a.s.saved();
    const saves = a.posts.filter(m => m.t === "saved");
    assert.strictEqual(saves.length, 3, "本端每次落盘都广播");
    for (const m of saves) b.s.receive(m);
    assert.deepStrictEqual(b.warns, [TAB_WARN_SAVED], "对端只提醒一次");
  });
  it("他图/自己/畸形消息一律忽略", () => {
    const a = mk("A");
    a.s.setMap("browser:m1");
    a.s.receive({ t: "open", map: "browser:m9", tab: "B" });        // 另一张图
    a.s.receive({ t: "saved", map: "folder:m1", tab: "B" });        // 同名不同来源
    a.s.receive({ t: "open", map: "browser:m1", tab: "A" });        // 自己（BroadcastChannel 本不回送，防万一）
    for (const bad of [null, 1, "x", {}, { t: "open" }, { t: "zz", map: "browser:m1", tab: "B" }]) a.s.receive(bad);
    assert.deepStrictEqual(a.warns, []);
    assert.strictEqual(a.posts.length, 1, "只有最初那条 open");
  });
  it("未开图时收到任何广播都不提醒", () => {
    const a = mk("A");
    a.s.receive({ t: "open", map: "browser:m1", tab: "B" });
    a.s.receive({ t: "saved", map: "browser:m1", tab: "B" });
    assert.deepStrictEqual(a.warns, []);
    assert.deepStrictEqual(a.posts, []);
  });
  it("tabMapKey：来源前缀区分两套图库；无图＝null", () => {
    assert.strictEqual(tabMapKey("browser", "m1"), "browser:m1");
    assert.strictEqual(tabMapKey("folder", "m1"), "folder:m1");
    assert.strictEqual(tabMapKey("browser", null), null);
  });
});

/* —— 陈旧写入守卫（多标签提醒之外的真闸门：对方标签已关闭时的覆盖也拦得住） —— */
describe("陈旧写入守卫（guard）", () => {
  const mkWorld = (名称: string) =>
    ({ meta: { 名称 }, factions: [], nodes: [], edges: [], decor: [], terrainOverrides: [], units: [] }) as never;

  it("判据：无基准或读不到当前版本一律放行，读到且不同才算陈旧", () => {
    assert.strictEqual(staleWrite(null, 5), false, "不知情不该拦");
    assert.strictEqual(staleWrite(undefined, 5), false);
    assert.strictEqual(staleWrite(5, null), false, "没有「别人写过」的证据就放行");
    assert.strictEqual(staleWrite(5, 5), false);
    assert.strictEqual(staleWrite(5, 6), true);
  });

  it("浏览器库：基准过期＝中止且一字不写（world 与条目都保持对方那一版）", async () => {
    const lib = await freshLib();
    const e = await lib.create(mkWorld("甲"));
    const base = e.updatedAt;
    const cur = await lib.save(e.id, mkWorld("乙"), {}, base + 1000);      // 另一处写入
    await assert.rejects(
      () => lib.save(e.id, mkWorld("丙"), {}, undefined, base),            // 本标签拿旧基准写
      (err: unknown) => isStaleError(err) && err.stale.base === base && err.stale.cur === cur);
    assert.strictEqual((await lib.getWorld(e.id))!.meta.名称, "乙", "world 不得被写");
    assert.strictEqual((await lib.getEntry(e.id))!.name, "乙", "条目不得被写");
  });

  it("浏览器库：save 返回的新版本可直接当基准，连续保存不会自己拦自己", async () => {
    const lib = await freshLib();
    const e = await lib.create(mkWorld("甲"));
    let v = e.updatedAt;
    for (let i = 0; i < 3; i++) v = await lib.save(e.id, mkWorld("甲" + i), {}, v + 10, v);
    assert.strictEqual((await lib.getEntry(e.id))!.updatedAt, v);
    assert.strictEqual((await lib.getEntry(e.id))!.name, "甲2");
  });

  it("浏览器库：条目已被删则连条目一并重建（原先只写 maps＝列表里看不见的孤儿）", async () => {
    const lib = await freshLib();
    const e = await lib.create(mkWorld("甲"));
    await lib.remove(e.id);
    const v = await lib.save(e.id, mkWorld("甲"), {}, undefined, e.updatedAt);   // 带基准也放行
    const ent = await lib.getEntry(e.id);
    assert.ok(ent, "条目须被重建");
    assert.strictEqual(ent!.name, "甲");
    assert.strictEqual(ent!.updatedAt, v);
    assert.strictEqual((await lib.list()).length, 1, "图须回到列表里");
  });

  it("文件夹库：mtime 变过即中止且不写盘；拿当前版本作基准即可写入", async () => {
    const dir = memDir();
    const r1 = await folderWriteWorld(dir, "甲.json", mkWorld("甲"));
    assert.strictEqual(r1.ok, true);
    const base = r1.mtime!;
    dir._touch("甲.json", JSON.stringify({ meta: { 名称: "别处写的" } }));       // 另一处写过
    await assert.rejects(() => folderWriteWorld(dir, "甲.json", mkWorld("丙"), base), isStaleError);
    assert.match(dir._files["甲.json"], /别处写的/, "一字不写");
    const cur = await folderMtime(dir, "甲.json");
    const r2 = await folderWriteWorld(dir, "甲.json", mkWorld("丙"), cur);
    assert.strictEqual(r2.ok, true);
    assert.notStrictEqual(r2.mtime, cur, "落盘后须返回新版本，否则下次守卫拿旧值比新文件＝自己拦自己");
  });

  it("文件夹库：文件已不存在＝读不到版本→放行并写回（把内存里的图恢复回图库）", async () => {
    const dir = memDir();
    const r = await folderWriteWorld(dir, "乙.json", mkWorld("乙"), 12345);
    assert.strictEqual(r.ok, true);
    assert.match(dir._files["乙.json"], /乙/);
  });

  /* 自动保存的错误分流全押在 isStaleError 上：判错一次，一次普通的存储故障就会被路由进一个
     不可关闭、且三个动作全都答非所问的弹层。实现稳但没测就没锁。 */
  it("isStaleError 负例：存储故障/普通异常/杂值一律不得当成守卫拦下", () => {
    for (const e of [new Error("QuotaExceededError"), null, undefined, "stale", 42, {},
                     { stale: null }, { stale: {} }, { stale: { base: 1 } }, { stale: { base: "1", cur: 2 } }])
      assert.strictEqual(isStaleError(e), false, JSON.stringify(e));
    assert.strictEqual(isStaleError(staleError({ base: 1, cur: 2 })), true);
  });

  it("文件夹库：写成功但版本读不回＝{ok:true,mtime:null}（守卫自愿下岗，不能报成写失败）", async () => {
    const dir = memDir();
    const orig = dir.getFileHandle.bind(dir);
    let wrote = false;
    // 写入照常成功，写完之后的那次读 mtime 失败（权限在写后被收回是真会发生的一类）
    (dir as unknown as Record<string, unknown>).getFileHandle = async (fn: string, opts?: { create?: boolean }) => {
      if (wrote) throw new Error("NotAllowedError");
      const h = await orig(fn, opts);
      if (opts?.create) wrote = true;
      return h;
    };
    const r = await folderWriteWorld(dir, "丁.json", mkWorld("丁"));
    assert.strictEqual(r.ok, true, "写成功就是写成功——不能因为读不回版本而报失败");
    assert.strictEqual(r.mtime, null, "版本未知须如实为 null，下次即不做守卫");
    assert.match(dir._files["丁.json"], /丁/);
  });

  it("浏览器库：守卫中止过一次后，同一个 lib 实例仍能正常读写（abort 不得毒化连接）", async () => {
    const lib = await freshLib();
    const e = await lib.create(mkWorld("甲"));
    await lib.save(e.id, mkWorld("乙"), {}, e.updatedAt + 1000);
    await assert.rejects(() => lib.save(e.id, mkWorld("丙"), {}, undefined, e.updatedAt), isStaleError);
    const cur = (await lib.getEntry(e.id))!.updatedAt;                       // 拦下后照样读得到
    const v = await lib.save(e.id, mkWorld("丁"), {}, cur + 1000, cur);      // 接受新基准后照样写得进
    assert.strictEqual((await lib.getWorld(e.id))!.meta.名称, "丁");
    assert.strictEqual((await lib.getEntry(e.id))!.updatedAt, v);
  });

  it("浏览器库：getWorldAt 一趟读出世界与条目（守卫基准与内存快照同源）", async () => {
    const lib = await freshLib();
    const e = await lib.create(mkWorld("甲"));
    const got = await lib.getWorldAt(e.id);
    assert.strictEqual(got.world!.meta.名称, "甲");
    assert.strictEqual(got.entry!.updatedAt, e.updatedAt);
    const miss = await lib.getWorldAt("没这张");
    assert.deepStrictEqual([miss.world, miss.entry], [null, null], "缺图＝两样都 null＝基准落 null＝放行");
  });

  it("文件夹库：folderReadWorldAt 的内容与 mtime 出自同一个 File", async () => {
    const dir = memDir();
    const w1 = await folderWriteWorld(dir, "戊.json", mkWorld("戊"));
    const got = await folderReadWorldAt(dir, "戊.json");
    assert.strictEqual(got.world!.meta.名称, "戊");
    assert.strictEqual(got.mtime, w1.mtime);
    dir._touch("戊.json", JSON.stringify(mkWorld("别处写的")));
    const got2 = await folderReadWorldAt(dir, "戊.json");
    assert.strictEqual(got2.world!.meta.名称, "别处写的");
    assert.notStrictEqual(got2.mtime, got.mtime, "读到新内容就该读到新版本，绝不能配成旧版本");
    assert.deepStrictEqual(await folderReadWorldAt(dir, "没这个.json"), { world: null, mtime: null });
  });
});

/* —— 侵蚀场缓存（data/fieldcache）：内容寻址、LRU 封顶、换代清场 —— */
import { fieldCacheGet, fieldCachePut, FIELD_CACHE_CAP } from "../src/data/fieldcache.ts";
import { ERODE_VER } from "../src/core/erode.ts";
import type { ElevField } from "../src/core/elev.ts";

describe("侵蚀场缓存（data/fieldcache）", () => {
  const mkField = (tag: number): ElevField => ({
    bb: { lonMin: 100, lonMax: 104, latMin: 30, latMax: 34 }, step: 0.25, cols: 16, rows: 16,
    data: new Float32Array(256).fill(tag), shadow: new Float32Array(256).fill(tag / 2)
  });

  /* ⚠ 本测须最先触碰缓存模块（open 是模块级记忆化，换代清场只在首开时跑一次）：
     先用同名同版的裸 IDB 预埋一条旧代键与一条当代键，再经模块首开触发清场。 */
  it("换代清场：键前缀非当代的存货首开即清，当代键保留（清完才放行 get）", async () => {
    const raw = await openDB("yutu2-fieldcache", 1, d => {
      if (!d.objectStoreNames.contains("fields")) d.createObjectStore("fields", { keyPath: "key" }).createIndex("t", "t");
    });
    const f = mkField(7);
    const t = raw.transaction("fields", "readwrite");
    t.objectStore("fields").put({ key: "e旧代-xx-yy", t: 1, ...f });
    t.objectStore("fields").put({ key: ERODE_VER + "-keep-1", t: 2, ...f });
    await txDone(t);
    raw.close();
    const kept = await fieldCacheGet(ERODE_VER + "-keep-1");
    assert.ok(kept, "当代键必须活过清场");
    assert.strictEqual(await fieldCacheGet("e旧代-xx-yy"), null, "旧算法代的场绝不可再命中（观感还魂）");
  });

  it("存取往返：场逐位一致（数据/遮蔽/几何），未命中＝null", async () => {
    const f = mkField(3);
    f.data[5] = 0.123; f.shadow![9] = 0.9;
    await fieldCachePut(ERODE_VER + "-rt", f);
    const got = await fieldCacheGet(ERODE_VER + "-rt");
    assert.ok(got);
    assert.deepStrictEqual(got!.data, f.data);
    assert.deepStrictEqual(got!.shadow, f.shadow);
    assert.deepStrictEqual([got!.cols, got!.rows, got!.step, got!.bb], [f.cols, f.rows, f.step, f.bb]);
    assert.strictEqual(await fieldCacheGet(ERODE_VER + "-没存过"), null);
  });

  it("LRU 封顶：超 CAP 按 lastUsed 淘汰最旧、新条与近用条保留", async () => {
    const over = 3;
    for (let i = 0; i < FIELD_CACHE_CAP + over; i++)
      await fieldCachePut(ERODE_VER + "-lru-" + i, mkField(i), 10_000 + i);   // now 注入＝次序确定
    for (let i = 0; i < FIELD_CACHE_CAP + over; i++) {
      const got = await fieldCacheGet(ERODE_VER + "-lru-" + i);
      /* 前面「换代清场/往返」两测留下的当代条目更旧＝先被顶掉，故此处只断言相对次序：
         最旧的 over 批次里至少头一条已被淘汰、最新的恒在 */
      if (i === 0) assert.strictEqual(got, null, "最旧一条必被淘汰");
      if (i >= over + 2) assert.ok(got, `近用条不该被淘汰：lru-${i}`);
    }
  });

  /* 2026-08-31 审查：LRU 时间戳原先埋在场记录里，而 IDB 是整条覆盖——一次命中就把整份场
     （4K 精修档 ~79MB）重写一遍。断言的是**结构**：场记录里不许再有 t，刷新只落在 touch 表。
     ⚠ 必须排在 LRU 封顶测之后：本测留下的条目恒为全场最新，会挤掉那一测赖以计数的槽位。 */
  it("命中只刷新 touch 表，场记录里不留 LRU 时间戳（否则每次命中重写整份场）", async () => {
    // 哨兵时间戳取「未来」：本测之前每一次命中都已把存活条目背拍刷成 Date.now()，
    // 用过去时刻存进去会当场被淘汰；未来值既保证不被淘汰，又能凭「变了」证明命中真写了 touch。
    const key = ERODE_VER + "-touch", putT = Date.now() + 5_000;
    await fieldCachePut(key, mkField(4), putT);
    const raw = await openDB("yutu2-fieldcache", 2, () => {});
    const rec = await reqP<Record<string, unknown> | undefined>(
      raw.transaction("fields", "readonly").objectStore("fields").get(key));
    assert.ok(rec, "刚存的场应在");
    assert.strictEqual(rec!.t, undefined, "场记录不得携带 LRU 时间戳");
    assert.ok(await fieldCacheGet(key), "应命中");
    await new Promise(r => setTimeout(r, 30));   // touch 是背拍写
    const tk = await reqP<{ t: number } | undefined>(
      raw.transaction("touch", "readonly").objectStore("touch").get(key));
    assert.ok(tk && tk.t > 0 && tk.t !== putT, `命中应把 touch 时间戳刷成真实时钟，实得 ${JSON.stringify(tk)}`);
    raw.close();
  });
});

describe("历法模板库 data/calstore（2026-08-19：图库页存模具，建图时整份拷进 meta）", () => {
  it("pickCalendarCfg 只留认得的键，坏值当没给（模板是本机自由数据）", () => {
    assert.deepStrictEqual(pickCalendarCfg({ months: 10, dpm: 36, era: " 启 ", junk: 1, __proto__: { x: 1 } } as never),
      { months: 10, dpm: 36, era: "启" });
    assert.deepStrictEqual(pickCalendarCfg({ monthLens: ["x", 31, 0, 28] } as never), { monthLens: [31, 28] });
    assert.deepStrictEqual(pickCalendarCfg({ hoursPerDay: 10, minutesPerHour: 100 } as never),
      { hoursPerDay: 10, minutesPerHour: 100 });
    assert.deepStrictEqual(pickCalendarCfg({ hoursPerDay: 24, minutesPerHour: 60, eras: [{ name: "开元", from: 100 }] } as never),
      {}, "与缺省同值不落盘；已退役的旧键（年号/时段）一并当没给");
    assert.deepStrictEqual(pickCalendarCfg({ kind: "earth", months: 10 } as never), { kind: "earth" }, "earth 不读其余键，同 calOf");
    assert.deepStrictEqual(pickCalendarCfg("坏" as never), {});
  });

  it("parseTemplates：缺 id/名称的跳过、cfg 过筛、非数组返空", () => {
    const l = parseTemplates([{ id: "a", 名称: "纪元历", cfg: { months: 10, junk: 2 } }, { 名称: "无 id" }, { id: "b" }, 7]);
    assert.deepStrictEqual(l, [{ id: "a", 名称: "纪元历", cfg: { months: 10 } }]);
    assert.deepStrictEqual(parseTemplates(null), []);
    assert.deepStrictEqual(parseTemplates({ 0: { id: "a", 名称: "x" } }), [], "对象不是数组＝没有模板");
  });

  it("upsert 就地替换保次序、remove 按 id", () => {
    const a: CalTemplate = { id: "a", 名称: "甲", cfg: {} }, b: CalTemplate = { id: "b", 名称: "乙", cfg: {} };
    const l = upsertTemplate(upsertTemplate([], a), b);
    assert.deepStrictEqual(l.map(t => t.id), ["a", "b"]);
    const l2 = upsertTemplate(l, { id: "a", 名称: "甲改", cfg: { era: "启" } });
    assert.deepStrictEqual(l2.map(t => t.名称), ["甲改", "乙"], "改名不该把它挪到末尾");
    assert.deepStrictEqual(removeTemplate(l2, "a").map(t => t.id), ["b"]);
    assert.deepStrictEqual(l.map(t => t.名称), ["甲", "乙"], "纯函数：原数组不动");
  });
});
