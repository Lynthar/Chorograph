/* 工具轨：览/测/绘/军 + 层。纯表现层——览测绘军映射到 modeSig/editSubSig
   （railToolOf/setRailTool，状态机语义不动）；军仅战术图可用；「层」切换抽屉的图层面（压过工具面）。
   朱=活动工具（三色分权：金不作选中、朱不作悬停）。
   图标：单色剪影内联 SVG（24 视框，fill:currentColor→随按钮 dim/hover/朱 自动变色，发行单文件内联）。
   眼睛=览、两脚规=测、毛笔=绘、军旗=军、三叠图页=层。 */
import { drawerOpenSig, editSubSig, isTacSig, layersOpenSig, modeSig, railToolOf, setRailTool, type RailTool } from "./state.ts";

type IconName = RailTool | "layers";

function RailIcon({ n }: { n: IconName }) {
  switch (n) {
    case "browse":  // 眼睛（高、圆、大）
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true">
          <path d="M2.5 12Q12 -1 21.5 12Q12 25 2.5 12Z M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8Z M12 10.1a1.9 1.9 0 1 0 0 3.8a1.9 1.9 0 1 0 0-3.8Z" />
        </svg>
      );
    case "measure":  // 圆规（枢轴环 + 顶钮 + 两条张开的粗腿）
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true">
          <path d="M12 4a2.7 2.7 0 1 0 0 5.4a2.7 2.7 0 1 0 0-5.4Z M12 5.6a1.1 1.1 0 1 0 0 2.2a1.1 1.1 0 1 0 0-2.2Z" />
          <path d="M10.7 1.6H13.3V4.4H10.7Z M11.4 8.8L9.3 9.4L4.2 21L5.4 21.6Z M12.6 8.8L14.7 9.4L19.8 21L18.6 21.6Z" />
        </svg>
      );
    case "draw":  // 铅笔（绘制/编辑；橡皮端 + 箍 + 笔杆 + 削尖）
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M21.06 6.06L18.86 8.26L15.74 5.14L17.94 2.94Z" />
          <path d="M18.36 8.76L9.06 18.06L4.5 19.5L5.94 14.94L15.24 5.64Z" />
        </svg>
      );
    case "units":  // 军旗
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M6.9 2.25a1.75 1.75 0 1 0 0 3.5a1.75 1.75 0 1 0 0-3.5Z M6.1 5H7.7V20.2a0.8 0.8 0 0 1-1.6 0Z M7.7 6H18.2Q18.8 6 18.5 6.55L15.9 9.6L18.5 12.65Q18.8 13.2 18.2 13.2H7.7Z" />
        </svg>
      );
    case "layers":  // 三叠图页
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M11 2H22V13H20V4H11Z" />
          <path d="M7 6H18V17H16V8H7Z" />
          <path d="M5.4 10H11.6A2.4 2.4 0 0 1 14 12.4V18.6A2.4 2.4 0 0 1 11.6 21H5.4A2.4 2.4 0 0 1 3 18.6V12.4A2.4 2.4 0 0 1 5.4 10Z" />
        </svg>
      );
  }
}

const TOOLS: { t: RailTool; lab: string; kbd: string; tip: string }[] = [
  { t: "browse", lab: "浏览", kbd: "1", tip: "浏览 · 拖拽平移 / 点击看详情" },
  { t: "measure", lab: "量距", kbd: "2", tip: "量距 · 行军推演" },
  { t: "draw", lab: "绘制", kbd: "3", tip: "绘制 · 地点/连线/涂域/地形/布景/标注" },
  { t: "units", lab: "部队", kbd: "4", tip: "部队 · 战术图兵棋" },
];

export function ToolRail() {
  const active = railToolOf(modeSig.value, editSubSig.value);
  const layersOn = layersOpenSig.value;
  const tac = isTacSig.value;
  return (
    <nav class="rail" aria-label="工具">
      {TOOLS.map(({ t, lab, kbd, tip }) => (
        <button key={t} class="rl tr" disabled={t === "units" && !tac}
          aria-pressed={!layersOn && active === t} aria-label={lab}
          onClick={() => setRailTool(t)}>
          <RailIcon n={t} /><span class="kbd">{kbd}</span><span class="tip">{tip}<s>{kbd}</s></span>
        </button>
      ))}
      <span class="rl-sep" />
      <button class="rl tr" aria-pressed={layersOn} aria-label="图层"
        onClick={() => { const on = !layersOpenSig.peek(); layersOpenSig.value = on; if (on) drawerOpenSig.value = true; }}>
        <RailIcon n="layers" /><span class="tip">图层与预设 · 抽屉切换</span>
      </button>
      <span class="rl-flex" />
    </nav>
  );
}
