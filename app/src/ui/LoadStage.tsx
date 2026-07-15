/* 图库开图 · 整屏加载舞台：朱印「舆」+ 图名 + 金细进度 + 步骤行。
   语法：进行中一律金、印章朱（品牌位）。library.ts 开图流程置 loadStageSig 步进
   0 读取存档 → 1 地形烘焙(·渲染器) → 2 时段过滤 → 3 泥金落款；置 null 后本组件淡出再卸载。 */
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import { loadStageSig, type LoadStageState } from "./state.ts";

const STEP_W = [10, 45, 78, 94];   // 各步骤进度条宽 %（无真实进度源，按流水线阶段走）

export function LoadStage() {
  const st = loadStageSig.value;
  const [shown, setShown] = useState<LoadStageState | null>(null);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (st) { setShown(st); setClosing(false); return; }
    if (!shown) return;
    setClosing(true);
    const t = setTimeout(() => { setShown(null); setClosing(false); }, 200);
    return () => clearTimeout(t);
  }, [st]);
  if (!shown) return null;
  const steps = ["读取存档", "地形烘焙" + (shown.renderer ? " · " + shown.renderer : ""), "时段过滤", "泥金落款"];
  const step = Math.min(steps.length - 1, shown.step);
  return (
    <div class={"loadstage" + (closing ? " out" : "")}>
      <div class="ls-box">
        <span class="ls-seal">舆</span>
        <b class="ls-name">{shown.name}</b>
        <div class="ls-bar"><i style={{ width: (closing ? 100 : STEP_W[step]) + "%" }}></i></div>
        <div class="ls-steps">{steps.map((s, i) => (
          <Fragment key={i}>{i > 0 ? " · " : ""}<span class={i < step ? "done" : i === step ? "now" : ""}>{s}</span></Fragment>
        ))}</div>
      </div>
    </div>
  );
}
