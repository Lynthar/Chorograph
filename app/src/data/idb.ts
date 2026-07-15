/* IndexedDB 微封装：只做 事件→Promise 的最小转换，不引第三方。
   （node 测试端由 fake-indexeddb 提供全局 indexedDB，浏览器端用原生。） */

export function openDB(name: string, version: number,
  upgrade: (db: IDBDatabase, oldVersion: number) => void): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const q = indexedDB.open(name, version);
    q.onupgradeneeded = e => upgrade(q.result, e.oldVersion);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
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
