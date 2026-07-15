/* 浮动工具属性条 fprops：画布顶部居中。
   绘·涂域/地形/布景＝笔刷/印章大小 + 橡皮(E) +（涂域）平滑；量距/行军＝合计读数 + 操作提示。
   数值与抽屉/快捷键（[ ] E Alt+滚轮）同信号联动；军属性条随 再议。 */
import { measureLegs } from "../core/route.ts";
import { fmtKm } from "../core/util.ts";
import { brushEraseSig, brushSizeSig, brushSmoothSig, decorSizeSig, editSubSig, modeSig, routePtsSig, routeResSig, terrainHeightSig, worldSig } from "./state.ts";

export function FpropsBar() {
  const mode = modeSig.value, sub = editSubSig.value;
  const world = worldSig.value;
  if (!world) return null;
  if (mode === "measure" || mode === "route") {
    const pts = routePtsSig.value;
    const res = routeResSig.value;
    const total = mode === "measure" ? measureLegs(world.meta, pts).total : (res && !res.fail && res.dist != null ? res.dist : null);
    return (
      <div class="fprops" id="fprops">
        <span class="fl">{mode === "measure" ? "量距" : "行军"}</span>
        {total != null && total > 0 && <span class="fk">{fmtKm(total)}</span>}
        <span class="fsep" />
        <span class="fl">{mode === "measure" ? "右键撤点 · 吸附地点" : "两点算路 · 第三次点击重新开始"}</span>
      </div>
    );
  }
  if (!(mode === "edit" && (sub === "paint" || sub === "terrain" || sub === "decor"))) return null;
  const erase = brushEraseSig.value, size = brushSizeSig.value, smooth = brushSmoothSig.value, scale = decorSizeSig.value;
  return (
    <div class="fprops" id="fprops">
      <span class="fl">{({ paint: "涂域", terrain: "地形", decor: "布景" } as Record<string, string>)[sub]}</span>
      {sub === "decor" ? (
        /* 布景：单一大小滑杆随模式切换（橡皮=通用擦除，模式钮在抽屉印章 chips 旁）；不再放独立扫除滑杆与橡皮钮 */
        erase ? (
          <>
            <span class="fl">橡皮半径</span>
            <input type="range" min={1} max={12} step={1} value={size}
              onInput={e => { brushSizeSig.value = +(e.currentTarget as HTMLInputElement).value; }} />
            <output class="fk">{size}</output>
          </>
        ) : (
          <>
            <span class="fl">印章大小</span>
            <input type="range" min={0.5} max={2.5} step={0.1} value={scale}
              onInput={e => { decorSizeSig.value = +(e.currentTarget as HTMLInputElement).value; }} />
            <output class="fk">{scale.toFixed(1)}</output>
          </>
        )
      ) : (
        <>
          <span class="fl">笔刷</span>
          <input type="range" min={1} max={12} step={1} value={size}
            onInput={e => { brushSizeSig.value = +(e.currentTarget as HTMLInputElement).value; }} />
          <output class="fk">{size}</output>
          {sub === "paint" && (
            <>
              <span class="fl">平滑</span>
              <input type="range" min={0} max={3} step={1} value={smooth}
                onInput={e => { brushSmoothSig.value = +(e.currentTarget as HTMLInputElement).value; }} />
              <output class="fk">{smooth}</output>
            </>
          )}
          <span class="fsep" />
          <button class="ftg tr" aria-pressed={erase} onClick={() => { brushEraseSig.value = !brushEraseSig.peek(); }}>{sub === "terrain" && terrainHeightSig.value ? "下切 (E)" : "橡皮 (E)"}</button>
        </>
      )}
      <span class="fl"><kbd style={{ font: "10px var(--f-mono)" }}>Alt</kbd>+滚轮调大小</span>
    </div>
  );
}
