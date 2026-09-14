/* 单飞行闸：同一时刻至多一单在飞；飞行中再来只记 dirty，落地后补发一次。
   腿账 / 视域 / 侵蚀工作档 / 静置精修四处编排共用——各抄一份时「拒绝也要放闸」「dirty 要补发」两条各漏各的。 */

export interface Flight<A extends unknown[]> {
  /** 发单：空闲即同步跑 run；飞行中只记 dirty，这单落地后补发一次（补发＝调 refire，不带参数） */
  fire(...args: A): void;
  /** 撤掉记下的 dirty（令牌作废、活没了）：飞行中的那单照旧落地，由调用方自己的令牌拦 */
  clearDirty(): void;
}

/** run 自己处理业务上的拒绝（提示、回退、撤胶囊）并返回 promise；闸只保证：无论成败都放闸、有 dirty 就补发。
    run 同步抛或落地代码抛＝记录后照样放闸——卡死 busy 就是这条车道永哑。 */
export function singleFlight<A extends unknown[]>(run: (...args: A) => Promise<unknown>, refire: () => void): Flight<A> {
  let busy = false, dirty = false;
  const done = (): void => { busy = false; if (dirty) { dirty = false; refire(); } };
  return {
    fire(...args) {
      if (busy) { dirty = true; return; }
      busy = true;
      new Promise<unknown>(res => res(run(...args))).then(done, e => { console.error("单飞行闸：落地代码抛错，已放闸", e); done(); });
    },
    clearDirty() { dirty = false; }
  };
}
