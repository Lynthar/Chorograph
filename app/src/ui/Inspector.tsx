/* 检查器：无选中即收起；卡片自带标题行与 ✕（InfoPanel 各卡）。
   「编辑」随时开表单（inspEditSig，不再锁编辑模式；编辑模式下恒开＝旧语义保留）。 */
import { InfoPanel } from "./InfoPanel.tsx";
import { selSig, worldSig } from "./state.ts";

export function Inspector() {
  const open = !!(worldSig.value && selSig.value);
  return (
    <aside class={"insp" + (open ? "" : " closed")}>
      <div class="in-body">
        <InfoPanel />
      </div>
    </aside>
  );
}
