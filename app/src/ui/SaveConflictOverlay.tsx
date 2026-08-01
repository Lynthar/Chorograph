/* 陈旧写入冲突弹层：守卫（data/guard.ts）拦下写入后由外壳置位 saveConflictSig 弹出。

   ⚠ 有意**不可关闭**——没有 ✕、点遮罩不关、Esc 不关（shell/pointer.ts 的 keydown 在此弹层
   置位时整段让位，不接管也不放行地图快捷键）。这不是提示而是待决断的数据完整性事件：改动
   还困在内存里、自动保存已暂停，关掉弹层只会让人以为没事。两个真出口必须选一个，
   「先导出 JSON」是辅助动作（导完仍要选）。

   动作全部来自信号里的回调（同 toast 的 action 之规）：组件不碰库 IO。 */
import { useRef } from "preact/hooks";
import { saveConflictSig } from "./state.ts";
import { useModalFocus } from "./modal.ts";

/* 只给时分会说出错话——守卫自己列举的场景就含「另一台机器／网盘同步」，完全可能差好几天。
   同一天省日期（读着轻），跨天才补上「几月几日」。 */
const when = (t: number, now = Date.now()): string => {
  const d = new Date(t), p = (x: number) => String(x).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? hm : `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
};

/* 卡片单独成件：弹层关就整件卸载，useModalFocus 的清理（摘监听 / 还原焦点）才跑得到 */
function ConflictCard({ c }: { c: NonNullable<typeof saveConflictSig.value> }) {
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(box);
  return (
    <div class="modal" style={{ width: "520px" }} ref={box}
      role="dialog" aria-modal="true" aria-labelledby="conflictTitle" tabIndex={-1}>
      <div class="mo-head">
        <span class="t" id="conflictTitle">保存被中止</span>
        <span class="s">这张图在别处被改过</span>
      </div>
      <div class="mo-body">
        <div>
          图库里的「{c.name}」已在 <b>{when(c.cur)}</b> 被另一处写入（本处打开时是 {when(c.base)} 那一版）。
          你在这里的改动<b>还没落盘</b>——直接存下去会把对方那一版整份覆盖，所以写入已中止、自动保存已暂停。
        </div>
        {/* 两条各自成行：挤成一段时第二条的「＝」会被折到行首，正是要对照着读的地方最难读 */}
        <div class="sub">另存为副本＝两边的改动都留住（当前这份存成新图，原图保持对方那一版）。</div>
        <div class="sub">仍然覆盖＝以你这一版为准，对方在别处的改动就此丢失。</div>
      </div>
      <div class="mo-foot">
        <button class="bt danger-ghost" onClick={c.onOverwrite}>仍然覆盖</button>
        <button class="bt ghost" onClick={c.onExport}>先导出 JSON</button>
        <span class="sp" />
        <button class="bt zhu" onClick={c.onCopy}>另存为副本</button>
      </div>
    </div>
  );
}

export function SaveConflictOverlay() {
  const c = saveConflictSig.value;
  if (!c) return null;
  return <div id="saveConflict" class="scrim open"><ConflictCard c={c} /></div>;
}
