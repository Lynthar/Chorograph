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
/* 键盘高亮项：每次重算候选都归零（否则换个词还沿用旧下标）。原先只有「回车＝第一项」，
   看得见 9 条却只够得着 1 条——鼠标能点第五项，键盘不能。 */
const activeSig = signal(0);

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
  const items = itemsSig.value, active = activeSig.value;
  const close = () => { itemsSig.value = []; activeSig.value = 0; };
  const go = (r: Hit, box: HTMLInputElement | null) => {
    const w = worldSig.peek();
    if (w) gotoResult(w, r);
    close();
    if (box) { box.value = ""; box.blur(); }
  };
  return (
    <>
      <input id="searchBox" type="text" placeholder="🔎 搜地点/派系/战役/河流" autocomplete="off"
        role="combobox" aria-expanded={items.length > 0} aria-controls="searchDrop" aria-autocomplete="list"
        aria-activedescendant={items.length ? `sd-${active}` : undefined}
        onInput={e => {
          itemsSig.value = searchAll(worldSig.peek(), (e.currentTarget as HTMLInputElement).value);
          activeSig.value = 0;
        }}
        onKeyDown={e => {
          const box = e.currentTarget as HTMLInputElement;
          // 输入法组字中：回车/Esc/上下键都是候选词操作（选字、翻页），一概不截（中文用户高频操作）
          if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) { e.stopPropagation(); return; }
          const n = itemsSig.peek().length;
          if (n && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();   // 否则光标窜到输入框首/末
            activeSig.value = (activeSig.peek() + (e.key === "ArrowDown" ? 1 : n - 1)) % n;   // 上下成环
          }
          else if (e.key === "Enter" && n) go(itemsSig.peek()[Math.min(activeSig.peek(), n - 1)], box);
          else if (e.key === "Escape") { close(); box.blur(); }
          e.stopPropagation();
        }}
        onBlur={() => setTimeout(close, 150)} />
      <span class="sk-hint" aria-hidden="true">{/Mac|iP/.test(navigator.platform) ? "⌘K" : "Ctrl K"}</span>
      <div id="searchDrop" role="listbox" aria-label="搜索结果" style={{ display: items.length ? "block" : "none" }}>
        {items.map((r, i) => (
          <div key={i} id={`sd-${i}`} role="option" aria-selected={i === active}
            class={"sd-item" + (i === active ? " on" : "")}
            onMouseDown={e => { e.preventDefault(); go(r, document.getElementById("searchBox") as HTMLInputElement); }}>
            <span class="sd-k">{ICO[r.kind]}</span>{r.label}<span class="sub" style={{ float: "right" }}>{r.sub}</span>
          </div>
        ))}
      </div>
    </>
  );
}
