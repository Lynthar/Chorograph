/* 弹层可达性：模态语义 + 焦点收束（设置 / 帮助两个 .scrim>.modal 共用）。

   缺这套时的实况：弹层挂在 #ovlMount，而它在 #app 的**最末**（前面依次是顶栏 / 工具轨 /
   抽屉 / 检查器 / 时间坞）。打开弹层焦点仍停在被遮罩盖住的触发钮上，按 Tab 会沿 DOM 次序
   穿过整个被盖住的界面——那些钮看不见却可聚焦可回车，键盘用户等于「焦点失踪」；读屏也收不到
   「这是对话框」的宣告。此件补三件事：进场把焦点收进弹层、Tab 在弹层内成环、退场还原焦点。

   分工：role/aria-modal/aria-labelledby 由各弹层自己标在 .modal 上（可及名取标题）；
   Esc 关闭仍在 shell/pointer.ts 全局 keydown 的「弹层优先」分支，此处不重复接管。
   ⚠ 用它的组件必须在弹层关闭时**真正卸载**（父组件 return null、卡片作子组件），
   否则 useEffect 的清理不跑＝监听不摘、焦点不还原。 */
import { useEffect } from "preact/hooks";

/* display:none 的候选（设置弹层里隐藏的 file input、收起的「生成参数」行）由 getClientRects 滤掉 */
const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';
const visible = (n: HTMLElement) => n.getClientRects().length > 0;

export function useModalFocus<T extends HTMLElement>(box: { current: T | null }): void {
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    el.focus();   // 落在容器（tabindex=-1）而非首个控件：读屏先读出标题与正文，也不会把焦点摁在关闭钮上
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
      if (!items.length) { e.preventDefault(); el.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      const at = document.activeElement;
      /* 只在「这一按会跨出弹层」时接管，其余交回浏览器原生次序（同组 radio 只停一个等语义不动）。
         两个弹层的首末恰是普通按钮（关闭 ✕ / 页脚动作），故等值判断可靠；
         进场焦点在容器上时 Shift+Tab 会往弹层**前面**走，一并收进来。 */
      if (e.shiftKey ? (at === first || at === el) : at === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      // 还原到唤起弹层的那个钮；它可能已随界面切走（如图库里新建后图库收起），失联就不强夺焦点
      if (prev && prev.isConnected && visible(prev)) prev.focus();
    };
  }, []);
}
