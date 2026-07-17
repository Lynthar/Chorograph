/* 开始界面 · 地图库（UI 1:1 还原 v0.14 #home/renderHome）：全屏墨蓝底 + 宣纸 .mapcard 网格。
   视图走 libViewSig（来源/条目/当前图），动作经 libActionsSig 回外壳（开图/删除/导入/链接文件夹）；
   「🆕 新建地图」开设置弹层的 create 模式（对齐旧 hmNew→toggleSettings(true,"create")）。 */
import { useRef } from "preact/hooks";
import { libActionsSig, libViewSig, openSettings } from "./state.ts";

function fmtTime(ts?: number): string {
  if (!ts) return "—";
  const d = new Date(ts), p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function HomePanel() {
  const v = libViewSig.value;
  const acts = libActionsSig.value;
  const fileRef = useRef<HTMLInputElement>(null);
  if (!v.open) return null;
  return (
    <div id="home" style={{ display: "block" }}>
      <div class="hm-wrap">
        <div class="hm-head">
          <span class="hm-title">舆图</span>
          <span class="hm-sub">分析型世界地图 · 地图库</span>
          <span class="sp"></span>
          {v.mapId && <button type="button" class="tbtn" onClick={() => acts?.toggle()}>↩ 返回当前地图 (Esc)</button>}
        </div>
        <div class="hm-actions">
          <button type="button" class="hm-new" onClick={() => openSettings("create")}>🆕 新建地图</button>
          <button type="button" class="tbtn" title="选择一个导出过的 .json，作为一张新地图加入图库" onClick={() => fileRef.current?.click()}>📂 导入 JSON 为新图</button>
          <button type="button" class="tbtn" title="以内置示例大陆新开一张地图" onClick={() => acts?.newFromSample()}>📜 从内置示例新建</button>
          {v.fsSupported && v.source !== "folder" && (
            <button type="button" class="tbtn" title="链接一个本地文件夹作为图库，直接读写其中的 .json（需 Edge/Chrome 经 localhost 或 https）" onClick={() => acts?.linkFolder()}>📁 链接文件夹</button>
          )}
          <input ref={fileRef} type="file" accept="application/json" multiple style={{ display: "none" }}
            onChange={e => {
              const el = e.currentTarget as HTMLInputElement;
              const fs = Array.from(el.files || []);
              if (fs.length) acts?.importFiles(fs);
              el.value = "";
            }} />
        </div>
        <div class="hm-source">
          {v.source === "folder"
            ? <>当前图库：<b>📁 {v.folderName}</b> <span class="sub">实时读写此文件夹里的 .json</span>{" "}
              <button type="button" class="tbtn" title="切回浏览器本地存储图库" onClick={() => acts?.backToBrowser()}>💾 切回浏览器存档</button>{" "}
              <button type="button" class="tbtn" title="改链接到另一个文件夹" onClick={() => acts?.linkFolder()}>📁 更换文件夹</button></>
            : <>当前图库：<b>💾 浏览器本地存储</b>{v.fsSupported
              ? <span class="sub"> — 也可「📁 链接文件夹」把地图存成真正的 .json 文件，随时用其它软件/网盘管理</span>
              : <span class="sub"> —「链接文件夹」需用 Edge/Chrome 经 localhost 或 https 打开（当前环境不支持）</span>}</>}
        </div>
        <div class="hm-grid">
          {v.entries.map(m => {
            const c = m.counts || {};
            return (
              <div key={m.id} class="mapcard" title={`打开「${m.name || "未命名"}」`} role="button" tabIndex={0}
                onClick={() => acts?.open(m.id)}
                onKeyDown={e => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); acts?.open(m.id); } }}>
                {m.thumb ? <img class="mc-thumb" src={m.thumb} alt="" /> : <div class="mc-thumb">🗺</div>}
                <div class="mc-body">
                  <div class="mc-name">{m.name || "未命名"}{c.tac ? <> <span class="tag" style={{ background: "#8a2f2f" }}>⚔ 战术</span></> : null}</div>
                  <div class="mc-sub">{c.tac
                    ? `${c.nodes || 0} 地点 · ${c.units || 0} 部队 · 兵棋战场图`
                    : `${c.nodes || 0} 地点 · ${c.factions || 0} 派系 · ${c.events || 0} 战役`}</div>
                  <div class="mc-sub">更新 {fmtTime(m.updatedAt)}</div>
                </div>
                <button type="button" class="mc-del" title="删除此地图" onClick={e => { e.stopPropagation(); acts?.remove(m.id); }}>🗑</button>
              </div>
            );
          })}
          {!v.entries.length && (
            <div class="hm-empty">{v.source === "folder"
              ? <>文件夹 <b>{v.folderName}</b> 里还没有地图。<br />点「🆕 新建地图」在此创建一张，或把导出的 .json 放进这个文件夹。</>
              : <>图库还是空的。<br />点上方「🆕 新建地图」开一张，或「📜 从内置示例新建」看看样例。</>}</div>
          )}
        </div>
        <div class="hm-foot">默认图库存在<b>此浏览器的本地存储</b>里（每张独立自动存档，打开即回到上次视角与纪年）；也可<b>「📁 链接文件夹」</b>把地图当作真正的 <b>.json 文件</b>直接读写、随其它软件/网盘管理。
          浏览器存档在换电脑/清数据前请用 ⚙ 设置「💾 导出 JSON」逐图备份；删除不可恢复。</div>
      </div>
    </div>
  );
}
