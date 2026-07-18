/* 自动保存调度（Azgaar 式「改动即存」）：touch()=标脏 + 600ms 防抖；flush()=立即落盘并等待
   (切图/回库/页面隐藏前调用）。save 回调由外壳提供：浏览器图库 lib.save / 文件夹 folderWriteWorld。
   与旧版 touch/flushSave 同语义，纯调度零依赖。
   失败语义（2026-07 审计「假已保存」修复）：save 抛错 → pending 复位为 true（数据仍脏，UI 回到
   「●未保存」、下次 touch/flush 自然重试）+ onError 回调供外壳可见提示；不再向 setTimeout 泄漏
   未处理 rejection。注意 pending=false 须在 save **之前**置位——save 进行中的新 touch() 不能被吞。 */

export interface Autosave {
  touch(): void;
  flush(): Promise<void>;
  readonly pending: boolean;
  dispose(): void;
}

export function createAutosave(save: () => Promise<void> | void, delayMs = 600, onError?: (e: unknown) => void): Autosave {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let inflight: Promise<void> | null = null;   // 在途 save：flush 须等它（否则「已落盘」谎报）、run 须排队（否则并发写同一文件）
  const run = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    while (inflight) await inflight;           // 串行：慢速写（文件夹库）期间 timer 再触发不并发
    if (!pending) return;                      // 排队期间已被别人写完
    pending = false;
    const p = (async () => {
      try { await save(); }
      catch (e) {
        pending = true;   // 写失败=改动仍未落盘；即便 save 期间有新 touch，true 也是对的
        if (onError) onError(e);
        else console.error("自动保存失败", e);
      }
    })();
    inflight = p;
    try { await p; } finally { if (inflight === p) inflight = null; }
  };
  return {
    touch() {
      pending = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, delayMs);
    },
    async flush() {
      while (inflight) await inflight;         // 先等在途（此前在途中 pending 已复位，flush 会假性早退）
      if (pending) await run();
    },
    get pending() { return pending; },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = false;
    }
  };
}
