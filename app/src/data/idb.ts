/* IndexedDB 微封装：只做 事件→Promise 的最小转换，不引第三方。
   （node 测试端由 fake-indexeddb 提供全局 indexedDB，浏览器端用原生。） */

export function openDB(name: string, version: number,
  upgrade: (db: IDBDatabase, oldVersion: number) => void): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const q = indexedDB.open(name, version);
    q.onupgradeneeded = e => upgrade(q.result, e.oldVersion);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
    /* ⚠ 升版时老标签还握着旧连接＝blocked：不接这一条，promise 永不 settle，boot 就停在
       `await openLibrary()` 上无声悬死——连「图库不可用，退回直读示例」的兜底都到不了。
       拒绝掉才有话可说。（实测过一次真悬死：另一个标签持着连接时整页停在空白。） */
    q.onblocked = () => rej(new Error("图库被其它标签页占用——请关掉本站的其它标签再打开"));
  });
}

/** 单个请求 → Promise */
export function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

/** 事务收尾 → Promise（abort 也算失败） */
export function txDone(t: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
