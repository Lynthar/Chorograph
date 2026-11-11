/* 界面偏好弹层：本机偏好（存 localStorage、不入存档、所有地图共用），图库页与图内设置两处进。
   从设置弹层进来时叠在它上面，关掉回到设置。 */
import { useRef } from "preact/hooks";
import { useModalFocus } from "./modal.ts";
import { prefsOpenSig, RELIEF_STEPS, setUiPrefs, uiPrefsSig } from "../app/state.ts";

const close = (): void => { prefsOpenSig.value = false; };

function PrefsCard() {
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(box);
  const uiP = uiPrefsSig.value;
  return (
    <div class="modal" ref={box} role="dialog" aria-modal="true" aria-labelledby="prefsTitle" tabIndex={-1}>
      <div class="mo-head">
        <span class="t" id="prefsTitle">⚙ 界面偏好</span>
        <span class="s">本机偏好 · 不入存档 · 所有地图共用</span>
        <button class="x tr" aria-label="关闭" onClick={close}>✕</button>
      </div>
      <div class="mo-body">
        <h4>界面</h4>
        <div class="setrow"><label id="sw_theme_lab">主题</label>
          <div class="seg" role="group" aria-labelledby="sw_theme_lab">
            <button type="button" class={"tbtn" + (uiP.theme === "light" ? " on" : "")} aria-pressed={uiP.theme === "light"} onClick={() => setUiPrefs({ theme: "light" })}>亮 · 素笺</button>
            <button type="button" class={"tbtn" + (uiP.theme === "dark" ? " on" : "")} aria-pressed={uiP.theme === "dark"} onClick={() => setUiPrefs({ theme: "dark" })}>暗 · 漆</button>
          </div>
        </div>
        <div class="setrow"><label id="sw_den_lab">密度</label>
          <div class="seg" role="group" aria-labelledby="sw_den_lab">
            <button type="button" class={"tbtn" + (uiP.den === "loose" ? " on" : "")} aria-pressed={uiP.den === "loose"} onClick={() => setUiPrefs({ den: "loose" })}>浏览 · 松</button>
            <button type="button" class={"tbtn" + (uiP.den === "tight" ? " on" : "")} aria-pressed={uiP.den === "tight"} onClick={() => setUiPrefs({ den: "tight" })}>兵棋 · 紧</button>
          </div>
          <span class="sub">紧凑档让侧栏同屏多放几行</span>
        </div>
        <div class="setrow"><label id="sw_shade_lab">山影深浅</label>
          <div class="seg" role="group" aria-labelledby="sw_shade_lab">
            {RELIEF_STEPS.map(n => (
              <button type="button" class={"tbtn" + (uiP.relief === n ? " on" : "")} aria-pressed={uiP.relief === n}
                title="山坡明暗按此倍数加深或减淡（×1 已含随比例尺的坡度夸张）；屏幕与出图同用"
                onClick={() => setUiPrefs({ relief: n })}>{n === 1 ? "×1 默认" : `×${n}`}</button>
            ))}
          </div>
          <span class="sub">只改山坡明暗，不改高程</span>
        </div>
        <h4>出图</h4>
        <div class="setrow"><label id="sw_scale_lab">出图清晰度</label>
          <div class="seg" role="group" aria-labelledby="sw_scale_lab">
            {[1, 2, 3, 4].map(n => (
              <button type="button" class={"tbtn" + (uiP.exportScale === n ? " on" : "")} aria-pressed={uiP.exportScale === n}
                title={n === 1 ? "按屏幕原样导出" : `像素密度放大 ${n} 倍导出（取景不变；PNG 记录物理尺寸，打印大小恒等于屏上所见）`}
                onClick={() => setUiPrefs({ exportScale: n })}>{n === 1 ? "×1 屏幕" : n === 4 ? "×4 印刷" : `×${n}`}</button>
            ))}
          </div>
        </div>
        <div class="setrow" role="group" aria-labelledby="sw_legend_lab"><label id="sw_legend_lab">出图图例</label>
          <label><input type="checkbox" checked={uiP.legend !== false}
            onChange={e => setUiPrefs({ legend: (e.currentTarget as HTMLInputElement).checked })} /> 战术图导出附图例块（派系·兵种·状态，右下角）</label>
        </div>
      </div>
      <div class="mo-foot">
        <button class="bt ghost tr" onClick={close}>关闭</button>
      </div>
    </div>
  );
}

export function PrefsOverlay() {
  if (!prefsOpenSig.value) return null;   // 真卸载：useModalFocus 的清理靠它跑
  return (
    <div id="prefs" class="scrim open" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <PrefsCard />
    </div>
  );
}
