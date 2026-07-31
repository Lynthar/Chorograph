/* 层面 · 图层与预设：预设胶囊 + 地文/人文/军事三组图层行（整行可点，显/隐眼标）。
   ⚠ 显示名与分组仅 UI 层映射——core/constants 的 LAYERS id/名/序**平价不动**；
   战术专属层沿旧语义只在战术图出现（带「战术」小签）。 */
import { LAYERS, PRESETS } from "../core/constants.ts";
import { applyPreset, isTacSig, layersSig, toggleLayer } from "./state.ts";

/** UI 层改名 */
const RENAME: Record<string, string> = {
  decor: "布景（点缀 · 手绘/生态笔刷）", politics: "政治 · 派系范围", range: "地点范围圈",
  trade: "商路 · 经济", wall: "工事（壁垒 · 岸线 · 长城）", notes: "标注（自由文本）", events: "事件点", arrows: "作战线（攻/防）",
  units: "部队", trails: "航迹", ranges: "火力圈", vision: "视野圈"
};
/** 行首色块 */
const SW: Record<string, string> = {
  terrain: "#c9b183", contour: "#8b8b7a", decor: "#7a8a5a", graticule: "#9aa4ad",
  politics: "#8a5aa8", range: "#caa45a", road: "#8a6a4a", river: "#5f89b4", trade: "#a86ab8", wall: "#55504a",
  nodes: "#6a5326", labels: "#7a6a48", notes: "#5a6a7a",
  events: "#8a2f22", arrows: "#c0453a", units: "#7a3e2e", trails: "#6b5a3a", ranges: "#b0202a", vision: "#5f89b4"
};
const GROUPS: { t: string; ids: string[] }[] = [
  { t: "地文", ids: ["terrain", "contour", "decor", "graticule"] },
  { t: "人文", ids: ["politics", "range", "road", "river", "trade", "wall", "nodes", "labels", "notes"] },   // 工事与道路/河流/商路同属线型，故列人文（不设 tacOnly＝长城属战略语汇）
  { t: "军事", ids: ["events", "arrows", "units", "trails", "ranges", "vision"] },
];

export function LayersPane() {
  const layers = layersSig.value;
  const tac = isTacSig.value;
  const defs = new Map(LAYERS.map(l => [l.id, l]));
  return (
    <>
      <div class="chips">
        {Object.keys(PRESETS).filter(p => p !== "战术" || tac).map(p => (
          <button key={p} class="ch tr" onClick={() => applyPreset(p)}>{p}</button>
        ))}
      </div>
      {GROUPS.map(g => {
        const ids = g.ids.filter(id => { const d = defs.get(id); return d && id in layers && (!d.tacOnly || tac); });
        if (!ids.length) return null;
        return (
          <div key={g.t}>
            <div class="sec">{g.t}</div>
            <div class="rows">
              {ids.map(id => {
                const d = defs.get(id)!;
                const on = !!layers[id];
                // 战术图 graticule 画的是公里网（overlay.drawKmGrid 分流）,显示名随之——图层 id/存档键不动
                const nm = id === "graticule" && tac ? "公里网（方里格）" : (RENAME[id] || d.名);
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
