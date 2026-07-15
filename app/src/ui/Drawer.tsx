/* 上下文抽屉：随工具轨分面——览=事件时间线／测=量距行军读数／绘=stgrid 子工具／
   军=部队列表／层=图层预设+图例（压过工具面）。起各面为设计重做件（EventsPane/MeasurePane/
   DrawPane/UnitsPane/LayersPane）；图例暂沿旧静态内容。
   抽屉收起后画布左缘出「抽屉」竖页签（DrawerTab，挂 #cvTabMount）。 */
import { EventsPane } from "./EventsPane.tsx";
import { MeasurePane } from "./MeasurePane.tsx";
import { DrawPane } from "./DrawPane.tsx";
import { UnitsPane } from "./UnitsPane.tsx";
import { LayersPane } from "./LayersPane.tsx";
import { drawerOpenSig, editSubSig, layersOpenSig, modeSig, railToolOf, worldSig, type RailTool } from "./state.ts";

const TITLES: Record<RailTool | "layers", [string, string]> = {
  browse: ["览", "事件时间线"],
  measure: ["测", "量距与行军"],
  draw: ["绘", "子工具"],
  units: ["军", "部队"],
  layers: ["层", "图层与预设"],
};

const NoWorld = () => <div class="hint">（先从「⌂ 图库」打开一张地图）</div>;

/** 图例（自旧版 index.html #legendBox 原样迁入，静态内容；文案随 帮助重写再校） */
function Legend() {
  return (
    <details id="legendBox">
      <summary>图例</summary>
      <div class="lgrow"><span class="lgs">★</span>都城　<span class="lgs">◉</span>主要城市</div>
      <div class="lgrow"><span class="lgs">●</span>城市　<span class="lgs">○</span>城镇</div>
      <div class="lgrow"><span class="lgs">·</span>乡村　<span class="lgs">▲</span>要塞</div>
      <div class="lgrow"><span class="lgs">⚓</span>港口(标签前缀)　<span class="lgs">═</span>渡口</div>
      <div class="lgrow"><span class="lgs">▽</span>事件点　<span class="lgs">◆</span>资源点</div>
      <div class="lgrow"><span class="lgs">✦</span>特殊地点</div>
      <div class="lgrow"><span class="lgs" style={{ borderTop: "4px double #7a5a30", height: 0 }} />道路(双线)
        <span class="lgs" style={{ borderTop: "3px solid #3f7fc4", height: 0 }} />河流</div>
      <div class="lgrow"><span class="lgs" style={{ borderTop: "3px dotted #a03aa0", height: 0 }} />商路(紫点线)</div>
      <div class="lgrow"><span class="lgs" style={{ color: "#b0202a" }}>➤</span>攻势线　<span class="lgs" style={{ color: "#b0202a" }}>⊥</span>防线(齿=正面)</div>
      <div class="sub">作战线在事件当年或选中该事件点时显示；事件点未发生=淡显。</div>
      <div class="lgrow"><span class="lgs" style={{ color: "#5c4022" }}>◌</span>等高线(示意高程)　<span class="lgs" style={{ color: "#667" }}>◯</span>地点范围(虚线圈)</div>
      <div class="sub" style={{ marginTop: "4px" }}>派系范围三档：<b>涂绘疆域</b>(绘→涂域笔刷,最优先)＞据点凸包(实线)＞影响范围(虚线,显式指定)。记号描边色=当年归属；灰=中立。远景只显都城/州府，标签自动避让；放大自动高清重绘地形。生态点缀随地形自动配套。</div>
    </details>
  );
}

export function Drawer() {
  const open = drawerOpenSig.value;
  const key: RailTool | "layers" = layersOpenSig.value ? "layers" : railToolOf(modeSig.value, editSubSig.value);
  const world = worldSig.value;
  const [t, s] = TITLES[key];
  return (
    <aside class={"drawer" + (open ? "" : " closed")}>
      <div class="dw-head">
        <span class="t">{t}</span><span class="s">{s}</span>
        <button class="fold tr" aria-label="收起抽屉" title="收起抽屉" onClick={() => { drawerOpenSig.value = false; }}>⟨</button>
      </div>
      <div class="dw-body">
        {key === "layers" && <><LayersPane /><Legend /></>}
        {key === "browse" && (world ? <EventsPane /> : <NoWorld />)}
        {key === "measure" && (world ? <MeasurePane /> : <NoWorld />)}
        {key === "draw" && (world ? <DrawPane /> : <NoWorld />)}
        {key === "units" && (world ? <UnitsPane /> : <NoWorld />)}
      </div>
    </aside>
  );
}

/** 抽屉收起后的重开页签（挂画布区 #cvTabMount，绝对定位于画布左缘） */
export function DrawerTab() {
  if (drawerOpenSig.value) return null;
  return <button class="dw-open-tab tr" onClick={() => { drawerOpenSig.value = true; }}>抽屉</button>;
}
