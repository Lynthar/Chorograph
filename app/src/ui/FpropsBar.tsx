/* 浮动工具属性条 fprops：画布顶部居中。
   绘·涂域/地形/布景＝笔刷/印章大小 + 橡皮(E) +（涂域）平滑；量距/行军＝合计读数 + 操作提示。
   数值与抽屉/快捷键（[ ] E Alt+滚轮）同信号联动；军属性条随 再议。 */
import { measureLegs } from "../core/route.ts";
import { fmtKm } from "../core/util.ts";
import { BRUSH_NOTCHES, brushActualKm, brushRadiusCells, fmtBrushKm } from "../core/brush.ts";
import { brushEraseSig, brushSizeSig, brushSmoothSig, decorEraseSig, decorSizeSig, editSubSig, modeSig, routePtsSig, routeResSig, terrainAxisSig, worldSig } from "./state.ts";

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
  /* 读数报**实际**涂宽与格数（2026-08-12 物理档位批）：档位是名义尺度，落到图上恒是奇数格——
     名义不足一格时退化成单格。报实际＝滑杆推不动时一眼看得出是格粒度封着（战略图地形格恒
     1°≈111km，前十余档必然同落一格），不必猜是不是坏了。 */
  const R = brushRadiusCells(world.meta, sub, size), across = 2 * R + 1;
  return (
    <div class="fprops" id="fprops">
      <span class="fl">{sub === "terrain" ? ({ lf: "地貌", eco: "生态", height: "高程" } as Record<string, string>)[terrainAxisSig.value] : ({ paint: "涂域", decor: "布景" } as Record<string, string>)[sub]}</span>
      {sub === "decor" ? (
        /* 布景：单一大小滑杆随模式切换（橡皮=通用擦除，模式钮在抽屉印章 chips 旁）；不再放独立扫除滑杆与橡皮钮 */
        erase ? (
          <>
            <span class="fl">橡皮半径</span>
            <input type="range" min={1} max={12} step={1} value={decorEraseSig.value}
              onInput={e => { decorEraseSig.value = +(e.currentTarget as HTMLInputElement).value; }} />
            <output class="fk">{decorEraseSig.value}</output>
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
          <input type="range" min={1} max={BRUSH_NOTCHES} step={1} value={size}
            onInput={e => { brushSizeSig.value = +(e.currentTarget as HTMLInputElement).value; }} />
          <output class="fk">{fmtBrushKm(brushActualKm(world.meta, sub, R))}</output>
          <span class="fl">{across} 格</span>
          {sub === "paint" && (
            <>
              <span class="fl">平滑</span>
              <input type="range" min={0} max={3} step={1} value={smooth}
                onInput={e => { brushSmoothSig.value = +(e.currentTarget as HTMLInputElement).value; }} />
              <output class="fk">{smooth}</output>
            </>
          )}
          <span class="fsep" />
          <button class="ftg tr" aria-pressed={erase} onClick={() => { brushEraseSig.value = !brushEraseSig.peek(); }}>{sub === "terrain" && terrainAxisSig.value === "height" ? "下切 (E)" : "橡皮 (E)"}</button>
        </>
      )}
      <span class="fl"><kbd style={{ font: "10px var(--f-mono)" }}>Alt</kbd>+滚轮调大小</span>
    </div>
  );
}
