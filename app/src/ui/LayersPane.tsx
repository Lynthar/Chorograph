/* 层面 · 图层与预设：预设胶囊 + 地文/人文/军事三组图层行（整行可点，显/隐眼标）+ 地文组首的底图样式段控件。
   ⚠ 显示名与分组仅 UI 层映射——core/constants 的 LAYERS id/名/序**平价不动**；
   战术专属层沿旧语义只在战术图出现（带「战术」小签）。 */
import { LAYERS, PRESETS } from "../core/constants.ts";
import { isModern } from "../core/units.ts";
import { applyPreset, isTacSig, layersSig, setTerrainStyle, terrainStyleSig, toggleLayer, worldSig } from "./state.ts";

/** UI 层改名 */
const RENAME: Record<string, string> = {
  spots: "标高点（高点 · 水面）", decor: "布景（点缀 · 手绘/生态笔刷）", politics: "政治 · 派系范围", range: "地点范围圈",
  trade: "商路 · 经济", wall: "工事（壁垒 · 岸线 · 长城）", notes: "标注（自由文本）", events: "事件点", arrows: "作战线（攻/防）",
  units: "部队", trails: "航迹", ranges: "火力圈", vision: "视野圈", radar: "雷达覆盖"
};
/** 行首色块 */
const SW: Record<string, string> = {
  terrain: "#c9b183", contour: "#8b8b7a", spots: "#6e5a3a", decor: "#7a8a5a", graticule: "#9aa4ad",
  politics: "#8a5aa8", range: "#caa45a", road: "#8a6a4a", river: "#5f89b4", trade: "#a86ab8", wall: "#55504a",
  nodes: "#6a5326", labels: "#7a6a48", notes: "#5a6a7a",
  events: "#8a2f22", arrows: "#c0453a", units: "#7a3e2e", trails: "#6b5a3a", ranges: "#b0202a", vision: "#5f89b4", radar: "#3f8f7a"
};
const GROUPS: { t: string; ids: string[] }[] = [
  { t: "地文", ids: ["terrain", "contour", "spots", "decor", "graticule"] },
  { t: "人文", ids: ["politics", "range", "road", "river", "trade", "wall", "nodes", "labels", "notes"] },   // 工事与道路/河流/商路同属线型，故列人文（不设 tacOnly＝长城属战略语汇）
  { t: "军事", ids: ["events", "arrows", "units", "trails", "ranges", "vision", "radar"] },
];

export function LayersPane() {
  const layers = layersSig.value;
  const tac = isTacSig.value;
  const modern = isModern(worldSig.value?.meta);   // 雷达层只在现代战术图出行（overlay 同门：古代图上带了雷达数据也不画）
  const flat = terrainStyleSig.value === "flat";
  const defs = new Map(LAYERS.map(l => [l.id, l]));
  const kmGrid = tac ? "公里网（方里格）" : "经纬网";
  return (
    <>
      <div class="chips">
        {Object.keys(PRESETS).filter(p => p !== "战术" || tac).map(p => (
          <button key={p} class="ch tr" onClick={() => applyPreset(p)}>{p}</button>
        ))}
      </div>
      {GROUPS.map(g => {
        const ids = g.ids.filter(id => { const d = defs.get(id); return d && id in layers && (!d.tacOnly || tac) && (id !== "radar" || modern); });
        if (!ids.length) return null;
        return (
          <div key={g.t}>
            <div class="sec">{g.t}</div>
            {g.t === "地文" && (
              /* 底图样式（会话态）：观感＝晕渲＋揉边界（制图）；推演＝逐格平色（像素颜色＝读数与寻路的那一格）。
                 等高线与经纬网/公里网仍是下面的独立行，推演底图不替它们做主 */
              <div class="seg2" role="group" aria-label="底图样式">
                <button type="button" aria-pressed={!flat} title="观感底图：晕渲、材质与揉化的地类边界——看图作画用"
                  onClick={() => setTerrainStyle("shaded")}>观感底图</button>
                <button type="button" aria-pressed={flat} title={`推演底图：每格按地貌平涂，不揉边界、不晕渲——图上每一格的颜色就是光标读数与寻路读到的那一格；配等高线与${kmGrid}用`}
                  onClick={() => setTerrainStyle("flat")}>推演底图</button>
              </div>
            )}
            <div class="rows">
              {ids.map(id => {
                const d = defs.get(id)!;
                const on = !!layers[id];
                // 战术图 graticule 画的是公里网（overlay.drawKmGrid 分流）,显示名随之——图层 id/存档键不动
                const nm = id === "graticule" ? kmGrid : (RENAME[id] || d.名);
                return (
                  <button key={id} class={"row tr" + (on ? "" : " off")} onClick={() => toggleLayer(id, !on)}>
                    <span class="sw" style={{ background: SW[id] || "#888" }} />
                    <span class="nm">{nm}</span>
                    {d.tacOnly && <span class="tag-tac">战术</span>}
                    <span class="eye">{on ? "显" : "隐"}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}
