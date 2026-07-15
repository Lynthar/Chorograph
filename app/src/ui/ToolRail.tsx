/* 工具轨：览/测/绘/军 + 层。纯表现层——览测绘军映射到 modeSig/editSubSig
   （railToolOf/setRailTool，状态机语义不动）；军仅战术图可用；「层」切换抽屉的图层面（压过工具面）。
   朱=活动工具（三色分权：金不作选中、朱不作悬停）。 */
import { drawerOpenSig, editSubSig, isTacSig, layersOpenSig, modeSig, railToolOf, setRailTool, type RailTool } from "./state.ts";

const TOOLS: { t: RailTool; g: string; kbd: string; tip: string }[] = [
  { t: "browse", g: "览", kbd: "1", tip: "浏览 · 拖拽平移 / 点击看详情" },
  { t: "measure", g: "测", kbd: "2", tip: "量距 · 行军推演" },
  { t: "draw", g: "绘", kbd: "3", tip: "绘制 · 地点/连线/涂域/地形/布景/标注" },
  { t: "units", g: "军", kbd: "4", tip: "部队 · 战术图兵棋" },
];

export function ToolRail() {
  const active = railToolOf(modeSig.value, editSubSig.value);
  const layersOn = layersOpenSig.value;
  const tac = isTacSig.value;
  return (
    <nav class="rail" aria-label="工具">
      {TOOLS.map(({ t, g, kbd, tip }) => (
        <button key={t} class="rl tr" disabled={t === "units" && !tac}
          aria-pressed={!layersOn && active === t}
          onClick={() => setRailTool(t)}>
          {g}<span class="kbd">{kbd}</span><span class="tip">{tip}<s>{kbd}</s></span>
        </button>
      ))}
      <span class="rl-sep" />
      <button class="rl tr" aria-pressed={layersOn}
        onClick={() => { const on = !layersOpenSig.peek(); layersOpenSig.value = on; if (on) drawerOpenSig.value = true; }}>
        层<span class="tip">图层与预设 · 抽屉切换</span>
      </button>
      <span class="rl-flex" />
    </nav>
  );
}
