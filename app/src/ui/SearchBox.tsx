/* 顶栏搜索（UI 1:1 还原 v0.14 bindSearch/searchAll/gotoResult）：搜地点(名称/link)/派系/命名连线，
   下拉 .sd-item 最多 9 项，回车跳第一项；选中后视角飞过去（经 flyReqSig），
   事件跳到战役当年、别的年代的地点跳到其存在年代。 */
import { signal } from "@preact/signals";
import { EDGE_STYLE, NODE_STYLE } from "../core/constants.ts";
import { activeAt } from "../core/time.ts";
import { flyReqSig, selSig, worldSig, yearSig } from "./state.ts";
import type { Edge, Faction, World, WorldNode } from "../core/types.ts";

type Hit =
  | { kind: "node"; ref: WorldNode; label: string; sub: string }
  | { kind: "faction"; ref: Faction; label: string; sub: string }
  | { kind: "edge"; ref: Edge; idx: number; label: string; sub: string };

const itemsSig = signal<Hit[]>([]);

function searchAll(w: World | null, q: string): Hit[] {
  q = (q || "").trim().toLowerCase();
  if (!w || !q) return [];
  const R: Hit[] = [];
  w.nodes.forEach(n => {
    if ((n.名称 || "").toLowerCase().includes(q) || (n.link || "").toLowerCase().includes(q))
      R.push({ kind: "node", ref: n, label: n.名称 || n.id, sub: (NODE_STYLE[n.type as string] || {}).名 || "" });
  });
  w.factions.forEach(f => {
    if ((f.名称 || "").toLowerCase().includes(q))
      R.push({ kind: "faction", ref: f, label: f.名称 || f.id, sub: "派系" });
  });
  w.edges.forEach((e, i) => {
    if (e.名称 && e.名称.toLowerCase().includes(q))
      R.push({ kind: "edge", ref: e, idx: i, label: e.名称, sub: (EDGE_STYLE[e.type] || {}).名 || "" });
  });
  return R.slice(0, 9);
}

function gotoResult(w: World, r: Hit): void {
  if (r.kind === "node") {
    const n = r.ref;
    flyReqSig.value = { lon: n.lon, lat: n.lat, degPerPx: 0.045, ifAbove: 0.05 };
    selSig.value = { kind: "node", id: n.id };
    if (n.type === "event" && n.year != null) yearSig.value = n.year;                       // 搜到战役→跳到战役当年
    else if (!activeAt(n, yearSig.peek()) && n.since != null) yearSig.value = n.since;      // 别的年代的地点→跳到它存在的年代
  } else if (r.kind === "edge") {
    const a = w.nodes.find(n => n.id === r.ref.from), b = w.nodes.find(n => n.id === r.ref.to);
    if (a && b) flyReqSig.value = { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 };
    selSig.value = { kind: "edge", idx: r.idx };
  } else {
    selSig.value = { kind: "faction", id: r.ref.id };
  }
}

const ICO: Record<string, string> = { node: "●", faction: "⬢", edge: "〰" };

export function SearchBox() {
  const items = itemsSig.value;
  const close = () => { itemsSig.value = []; };
  const go = (r: Hit, box: HTMLInputElement | null) => {
    const w = worldSig.peek();
    if (w) gotoResult(w, r);
    close();
    if (box) { box.value = ""; box.blur(); }
  };
  return (
    <>
      <input id="searchBox" type="text" placeholder="🔎 搜地点/派系/战役/河流" autocomplete="off"
        onInput={e => { itemsSig.value = searchAll(worldSig.peek(), (e.currentTarget as HTMLInputElement).value); }}
        onKeyDown={e => {
          const box = e.currentTarget as HTMLInputElement;
          // 输入法组字中：回车/Esc 是确认/取消候选词，不应触发搜索跳转或关闭（中文用户高频操作）
          if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) { e.stopPropagation(); return; }
          if (e.key === "Enter" && itemsSig.peek().length) go(itemsSig.peek()[0], box);
          if (e.key === "Escape") { close(); box.blur(); }
          e.stopPropagation();
        }}
        onBlur={() => setTimeout(close, 150)} />
      <span class="sk-hint" aria-hidden="true">{/Mac|iP/.test(navigator.platform) ? "⌘K" : "Ctrl K"}</span>
      <div id="searchDrop" style={{ display: items.length ? "block" : "none" }}>
        {items.map((r, i) => (
          <div key={i} class="sd-item"
            onMouseDown={e => { e.preventDefault(); go(r, document.getElementById("searchBox") as HTMLInputElement); }}>
            <span class="sd-k">{ICO[r.kind]}</span>{r.label}<span class="sub" style={{ float: "right" }}>{r.sub}</span>
          </div>
        ))}
      </div>
    </>
  );
}
