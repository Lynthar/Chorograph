/* 数据层测试：IndexedDB 图库 / localStorage 旧档迁移 / 文件夹图库。
   indexedDB 由 fake-indexeddb 提供（纯 JS devDependency，进程内内存实现——node --test
   每个文件独立进程，互不污染）；目录句柄用 40 行内存替身实现 folder.ts 的结构面。 */
import "fake-indexeddb/auto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openLibrary, newMapId, type Library } from "../src/data/library.ts";
import { migrateFromLocalStorage, migrateFolderHandle, type LSLike } from "../src/data/migrate.ts";
import { fcachePatch, fcacheRemove, folderCreate, folderList, folderReadWorld, folderRemove,
  folderUniqueFilename, folderWriteWorld, type DirHandleLike, type FolderCache, type FolderCacheEntry } from "../src/data/folder.ts";
import { openDB, reqP, txDone } from "../src/data/idb.ts";

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
    async removeEntry(fn: string) { if (!(fn in files)) throw new Error("NotFound"); delete files[fn]; },
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
    assert.strictEqual(await folderWriteWorld(dir, "写.json", w as never), true);
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
  it("folderRemove 幂等；文件名净化防目录穿越", async () => {
    const dir = memDir("夹", { "删.json": "{}" });
    await folderRemove(dir, "删.json");
    assert.ok(!("删.json" in dir._files));
    await folderRemove(dir, "删.json");                     // 再删不炸
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
