/* 导入弹层（图库页「📥 导入」）：舆图存档 .json 作为新图加入图库，或 GeoJSON 进字段映射弹层。
   两张卡的标题沿用旧入口名，与图内设置的同名入口对得上。 */
import { useRef } from "preact/hooks";
import { useModalFocus } from "./modal.ts";
import { importOpenSig, libActionsSig } from "../app/state.ts";

const close = (): void => { importOpenSig.value = false; };

function ImportCard() {
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(box);
  const acts = libActionsSig.value;
  const fileRef = useRef<HTMLInputElement>(null);
  const geoRef = useRef<HTMLInputElement>(null);
  return (
    <div class="modal" ref={box} role="dialog" aria-modal="true" aria-labelledby="impTitle" tabIndex={-1}>
      <div class="mo-head">
        <span class="t" id="impTitle">📥 导入</span>
        <span class="s">选一种文件</span>
        <button class="x tr" aria-label="关闭" onClick={close}>✕</button>
      </div>
      <div class="mo-body">
        <div class="imp-cards">
          <button type="button" class="imp-card" onClick={() => fileRef.current?.click()}>
            <span class="ic">📂</span>
            <span class="t">导入 JSON 为新图</span>
            <span class="s">舆图导出的 .json 存档，作为新地图加入当前图库；可一次选多个</span>
          </button>
          <button type="button" class="imp-card" onClick={() => geoRef.current?.click()}>
            <span class="ic">🗺</span>
            <span class="t">导入 GeoJSON</span>
            <span class="s">外部地理数据（CHGIS、OpenHistoricalMap 等）：点落成地点、线落成连线、面落成派系涂域或边界。下一步定字段映射，可新建一张图，也可并入当前打开的地图</span>
          </button>
        </div>
        <div class="hint">文件只在本机读取与转换，不会上传。要替换当前图的内容，请在图内 ⚙ 设置里导入。</div>
        <input ref={fileRef} type="file" accept="application/json" multiple style={{ display: "none" }}
          onChange={e => {
            const el = e.currentTarget as HTMLInputElement;
            const fs = Array.from(el.files || []);
            el.value = "";
            if (!fs.length) return;
            close();
            acts?.importFiles(fs);
          }} />
        {/* GeoJSON 一次只收一个：字段映射弹层是逐文件一份，多选会排出一串弹层 */}
        <input ref={geoRef} type="file" accept=".geojson,.json,application/geo+json,application/json" style={{ display: "none" }}
          onChange={e => {
            const el = e.currentTarget as HTMLInputElement;
            const f = el.files && el.files[0];
            el.value = "";
            if (!f) return;
            close();
            acts?.importGeoFile(f, "lib");
          }} />
      </div>
      <div class="mo-foot">
        <button class="bt ghost tr" onClick={close}>取消</button>
      </div>
    </div>
  );
}

export function ImportOverlay() {
  if (!importOpenSig.value) return null;   // 真卸载：useModalFocus 的清理靠它跑
  return (
    <div id="importer" class="scrim open" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <ImportCard />
    </div>
  );
}
