/* GeoJSON 导入弹层：扫描统计摆在最上，字段映射逐行给下拉，落点二选一。
   自动猜只是省事——外部数据的键名五花八门，改得动才是正事，故每一项都能改。 */
import { useRef, useState } from "preact/hooks";
import { GEO_LINE_TYPES, guessMapping, guessNodeType, type GeoLineType, type GeoMapping } from "../core/geojson.ts";
import { EDGE_STYLE, NODE_CATS, NODE_CAT_ORDER, NODE_STYLE } from "../core/constants.ts";
import { useModalFocus } from "./modal.ts";
import { geoImportSig, type GeoImportReq } from "./state.ts";

/** 某个属性键的前几个互异值（类型映射与派系分组的行内提示用）。
    只扫前 SCAN_HEAD 个要素：这行提示每次改选都重算，为它遍历六万条要素不值得。 */
const SCAN_HEAD = 2000;
function distinctValues(req: GeoImportReq, key: string, cap: number, kind?: "point"): string[] {
  if (!key) return [];
  const out: string[] = [];
  const fs = req.scan.features;
  for (let i = 0; i < fs.length && i < SCAN_HEAD && out.length < cap; i++) {
    if (kind && fs[i].kind !== kind) continue;   // 地点类型只由点要素说了算，线与面的同名属性值映过来没有意义
    const v = String(fs[i].props[key] == null ? "" : fs[i].props[key]).trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

function GeoImportCard({ req }: { req: GeoImportReq }) {
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(box);
  const [map, setMap] = useState<GeoMapping>(() => guessMapping(req.scan));
  const [target, setTarget] = useState<"new" | "merge">(req.canMerge ? req.defaultTarget : "new");
  const set = (p: Partial<GeoMapping>): void => { setMap(m => ({ ...m, ...p })); };
  const close = (): void => { geoImportSig.value = null; };

  const c = req.scan.counts;
  const sampleOf = (key: string): string => {
    const k = req.scan.keys.find(x => x.key === key);
    return k ? "例：" + k.sample : "";
  };
  /* 普通函数直接返回节点，不做成组件：组件写在这里每次 setState 都是新标识，
     Preact 会整块卸载重挂——改一项下拉，正在操作的那个就丢焦点。 */
  const keyRow = (label: string, val: string, onPick: (v: string) => void, hint?: string) => (
    <div class="setrow">
      <label>{label}</label>
      <select value={val} onChange={e => onPick((e.currentTarget as HTMLSelectElement).value)}>
        <option value="" selected={val === ""}>— 不用 —</option>
        {req.scan.keys.map(k => <option value={k.key} selected={val === k.key}>{k.key}</option>)}
      </select>
      <span class="sub">{hint != null ? hint : sampleOf(val)}</span>
    </div>
  );

  const typeVals = distinctValues(req, map.type, 3, "point");
  const groupVals = distinctValues(req, map.group, 4);
  const wantPaint = map.polyAs !== "outline", wantOutline = map.polyAs !== "paint";

  return (
    <div class="modal" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="gjTitle">
      <div class="mo-head">
        <span class="t" id="gjTitle">导入 GeoJSON</span>
        <span class="s">{req.srcName}</span>
        <span class="x" role="button" tabIndex={0} title="关闭" onClick={close}>✕</span>
      </div>
      <div class="mo-body">
        <div class="setrow">
          <label>要素</label>
          <b>{c.point + c.line + c.poly}</b>
          <span class="sub">点 {c.point} · 线 {c.line} · 面 {c.poly}
            {req.scan.skipped ? ` · 跳过 ${req.scan.skipped}` : ""}
            {req.scan.truncated ? " · ⚠ 超出规模已截断" : ""}</span>
        </div>

        <div class="mo-sec">落点</div>
        <div class="setrow">
          <label>导入到</label>
          <div class="seg">
            <button type="button" class={"tbtn" + (target === "new" ? " on" : "")} onClick={() => setTarget("new")}>🆕 新建一张图</button>
            {req.canMerge && (
              <button type="button" class={"tbtn" + (target === "merge" ? " on" : "")} onClick={() => setTarget("merge")}>
                ↳ 并入《{req.curName}》
              </button>
            )}
          </div>
        </div>
        <div class="setrow">
          <label></label>
          <span class="sub">{target === "new"
            ? "按要素范围新开一张图（地形留白，可再自己涂）"
            : "并进当前地图，算一步撤销；落在图幅外的要素照样收下"}</span>
        </div>

        <div class="mo-sec">字段映射</div>
        {keyRow("名称", map.name, v => set({ name: v }))}
        {keyRow("地点类型", map.type, v => set({ type: v }), typeVals.length
          ? typeVals.map(v => `${v}→${NODE_STYLE[guessNodeType(v, map.typeDefault)].名}`).join("　")
          : "不用则一律按下面的缺省类型")}
        <div class="setrow">
          <label>缺省类型</label>
          <select value={map.typeDefault} onChange={e => set({ typeDefault: (e.currentTarget as HTMLSelectElement).value })}>
            {NODE_CAT_ORDER.map(ck => (
              <optgroup label={NODE_CATS[ck].名}>
                {NODE_CATS[ck].types.map(t => (
                  <option value={t} selected={map.typeDefault === t}>{NODE_STYLE[t].名}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <span class="sub">类型认不出来时落成它</span>
        </div>
        {keyRow("起年", map.since, v => set({ since: v }))}
        {keyRow("讫年", map.until, v => set({ until: v }))}

        <div class="mo-sec">几何落成什么</div>
        <div class="setrow">
          <label>线</label>
          <select value={map.lineType} onChange={e => set({ lineType: (e.currentTarget as HTMLSelectElement).value as GeoLineType })}>
            {GEO_LINE_TYPES.map(k => <option value={k} selected={map.lineType === k}>{EDGE_STYLE[k].名}</option>)}
          </select>
          <span class="sub">{c.line ? `${c.line} 条线要素` : "本文件没有线要素"}　道路与商路要挂两端地点，导进来的线只能落这两种</span>
        </div>
        <div class="setrow">
          <label>面</label>
          <div class="seg">
            <button type="button" class={"tbtn" + (map.polyAs === "paint" ? " on" : "")} onClick={() => set({ polyAs: "paint" })}>涂域</button>
            <button type="button" class={"tbtn" + (map.polyAs === "outline" ? " on" : "")} onClick={() => set({ polyAs: "outline" })}>边界折线</button>
            <button type="button" class={"tbtn" + (map.polyAs === "both" ? " on" : "")} onClick={() => set({ polyAs: "both" })}>两者都要</button>
          </div>
          <span class="sub">{c.poly ? `${c.poly} 个面要素` : "本文件没有面要素"}</span>
        </div>
        {wantPaint && (
          keyRow("派系分组", map.group, v => set({ group: v }), groupVals.length
            ? `${groupVals.join("、")}${groupVals.length >= 4 ? "…" : ""}　同名派系会复用`
            : "不用则全部涂给一个「导入的疆域」派系")
        )}
        {wantOutline && (
          <div class="setrow">
            <label>边界线型</label>
            <select value={map.outlineType} onChange={e => set({ outlineType: (e.currentTarget as HTMLSelectElement).value as GeoLineType })}>
              {GEO_LINE_TYPES.map(k => <option value={k} selected={map.outlineType === k}>{EDGE_STYLE[k].名}</option>)}
            </select>
            <span class="sub">每个环落一条自由折线</span>
          </div>
        )}
        <div class="setrow">
          <label>折线抽稀</label>
          <input type="checkbox" id="gj_simp" checked={map.simplify}
            onChange={e => set({ simplify: (e.currentTarget as HTMLInputElement).checked })} />
          <label for="gj_simp" style={{ width: "auto", fontWeight: 400 }} class="sub">
            按半格容差删掉看不出的中间点——真实河网与海岸线动辄几万点，抽稀后开图快得多
          </label>
        </div>
      </div>
      <div class="mo-foot">
        <button class="bt ghost tr" onClick={close}>关闭</button>
        <span class="sp" />
        <button class="bt zhu tr" onClick={() => { req.onApply(map, target); close(); }}>✔ 导入</button>
      </div>
    </div>
  );
}

export function GeoImportOverlay() {
  const req = geoImportSig.value;
  if (!req) return null;   // 真卸载：useModalFocus 的清理靠它跑（同历法/帮助弹层之训）
  return (
    <div id="geoimport" class="scrim open" onClick={e => { if (e.target === e.currentTarget) geoImportSig.value = null; }}>
      <GeoImportCard req={req} />
    </div>
  );
}
