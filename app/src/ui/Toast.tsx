/* toast：底部居中（时间坞上方），停留 2.6s；成功绿点/错误朱点；
   「撤销」金键＝把时间倒回去（undoWorld）；action＝逃生门（如保存失败→立即导出）。 */
import { useEffect, useState } from "preact/hooks";
import { toastSig, undoWorld } from "./state.ts";

export function Toast() {
  const msg = toastSig.value;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!msg) return;
    setShown(true);
    const t = setTimeout(() => setShown(false), 2600);
    return () => clearTimeout(t);
  }, [msg && msg.token]);
  if (!msg) return null;
  return (
    <div class={"toast" + (msg.err ? " err" : "") + (shown ? " show" : "")}>
      <span class="okdot" />
      <span class="msg">{msg.text}</span>
      {msg.undo && <span class="und" onClick={() => { undoWorld(); setShown(false); }}>撤销</span>}
      {msg.action && <span class="und" onClick={() => { msg.action!.run(); setShown(false); }}>{msg.action.label}</span>}
    </div>
  );
}
