/* 图库开图 · 整屏加载舞台：山河印 + 图名 + 金细进度 + 步骤行。
   语法：进行中一律金、印章朱（品牌位；印分白文/朱文两态随主题，symbol 在 index.html）。
   library.ts 开图流程置 loadStageSig 步进
   0 读取存档 → 1 地势定形(·渲染器) → 2 时段过滤 → 3 泥金落款；置 null 后本组件淡出再卸载。
   ⚠「地势定形」是这一过程的**唯一用户面词**（顶栏胶囊/高程 hint/帮助条目同词）——原「地形烘焙」
   已统一，别再另起名（ARM_NAME 之训：同一件事两个名字就是下一处漂移）。 */
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
  const steps = ["读取存档", "地势定形" + (shown.renderer ? " · " + shown.renderer : ""), "时段过滤", "泥金落款"];
  const step = Math.min(steps.length - 1, shown.step);
  return (
    <div class={"loadstage" + (closing ? " out" : "")}>
      <div class="ls-box">
        <span class="ls-seal sealmark" aria-hidden="true"><svg class="v-solid"><use href="#mk-seal"/></svg><svg class="v-line"><use href="#mk-seal-line"/></svg></span>
        <b class="ls-name">{shown.name}</b>
        <div class="ls-bar"><i style={{ width: (closing ? 100 : STEP_W[step]) + "%" }}></i></div>
        <div class="ls-steps">{steps.map((s, i) => (
          <Fragment key={i}>{i > 0 ? " · " : ""}<span class={i < step ? "done" : i === step ? "now" : ""}>{s}</span></Fragment>
        ))}</div>
      </div>
    </div>
  );
}
