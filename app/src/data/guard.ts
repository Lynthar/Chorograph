/* 陈旧写入守卫：图库写入是「整份覆盖」——两处开着同一张图，后写的一方会把先写的改动
   整份吃掉。多标签提醒（tabsync.ts）只在两边**都开着**时喊话，对方标签已关闭时的陈旧覆盖
   拦不住；此处补的是真正的闸门。基准＝本标签上次见到的版本号（浏览器库＝条目 updatedAt，
   文件夹库＝文件 lastModified，两者同型故判据共用一份）。

   判据只有一条：**读到了库里的当前版本号，且与本标签上次见到的不同**。其余一律放行——
   · 无基准（迁移写入／旧会话）＝不知情，不知情不该拦；
   · 读不到当前版本（条目被删／文件被删／句柄权限故障）＝没有「别人写过」的证据，放行并把
     它写回去。对用户＝把还在内存里的图恢复回图库，比留一个写不进去的死局有用。
   这条「无证据不拦」使守卫**不必区分 NotFoundError 与权限故障**——File System Access 的
   错误分类跨平台不可靠（node 测试替身更给不出 DOMException），按证据判定则既无平台依赖，
   也不会把一次故障误报成冲突。

   ⚠ 两半边的强度不同，别当同一种保证：浏览器库在 IDB **同事务**内读比写＝真原子；文件夹库
   没有事务，是「读 mtime → 比 → 写」，两步之间有 TOCTOU 窗口。后者挡不住毫秒级对写，挡的是
   现实里真会发生的那类——另一标签／另一台机器／网盘同步在你这次编辑之前写过同一个文件。
   ⚠ 文件夹库那半边还有一层**版本号本身的粒度**：`lastModified` 的精度由文件系统给（NTFS 细、
   FAT/exFAT 粗到 2 秒、部分网盘同步回写只保到秒），同一粒度内的两次写在守卫眼里版本号相同＝
   放行。这是那半边的固有强度上限、不是缺陷（浏览器库的 `updatedAt` 是 `Date.now()`，无此问题）。 */

/** 冲突现场：base=本标签上次见到的版本，cur=库里现在的版本 */
export interface StaleInfo { base: number; cur: number }

/** 陈旧写入判据：库里现在的版本与本标签上次见到的不同（两者都读得到才算数） */
export function staleWrite(base: number | null | undefined, cur: number | null | undefined): boolean {
  return base != null && cur != null && base !== cur;
}

/** 守卫拦下的写入——与配额／权限等真故障区分开，外壳据此弹冲突弹层而非「保存失败」红字 */
export function staleError(info: StaleInfo): Error & { stale: StaleInfo } {
  const e = new Error("这张图在别处被改过　写入已中止　以免覆盖对方的改动") as Error & { stale: StaleInfo };
  e.stale = info;
  return e;
}

export function isStaleError(e: unknown): e is Error & { stale: StaleInfo } {
  const s = (e as { stale?: unknown } | null)?.stale as StaleInfo | undefined;
  return !!s && typeof s.base === "number" && typeof s.cur === "number";
}
