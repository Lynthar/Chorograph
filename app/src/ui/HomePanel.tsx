/* 开始界面 · 图库（UI 1:1 还原 v0.14 #home/renderHome）：全屏墨蓝底 + 宣纸 .mapcard 网格。
   视图走 libViewSig（来源/条目/当前图），动作经 libActionsSig 回外壳（开图/删除/导入/链接文件夹）；
   「🆕 新建地图」开设置弹层的 create 模式（对齐旧 hmNew→toggleSettings(true,"create")）。 */
import { useRef } from "preact/hooks";
import { calOverlaySig, libActionsSig, libViewSig, openSettings } from "./state.ts";

function fmtTime(ts?: number): string {
  if (!ts) return "—";
  const d = new Date(ts), p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function HomePanel() {
  const v = libViewSig.value;
  const acts = libActionsSig.value;
  const fileRef = useRef<HTMLInputElement>(null);
  const geoRef = useRef<HTMLInputElement>(null);
  if (!v.open) return null;
  return (
    <div id="home" style={{ display: "block" }}>
      <div class="hm-wrap">
        <div class="hm-head">
          <span class="hm-title">舆图</span>
          <span class="hm-sub">分析型世界地图 · 图库</span>
          <span class="sp"></span>
          {v.mapId && <button type="button" class="tbtn" onClick={() => acts?.toggle()}>↩ 返回当前地图 (Esc)</button>}
        </div>
        <div class="hm-actions">
          <button type="button" class="hm-new" onClick={() => openSettings("create")}>🆕 新建地图</button>
          <button type="button" class="tbtn" title="选择一个导出过的 .json，作为一张新地图加入图库" onClick={() => fileRef.current?.click()}>📂 导入 JSON 为新图</button>
          <button type="button" class="tbtn" title="导入 GeoJSON：点落成地点、线落成连线、面落成派系涂域或边界；可新建一张图，也可并入当前地图" onClick={() => geoRef.current?.click()}>🗺 导入 GeoJSON</button>
          <button type="button" class="tbtn" title="以内置示例大陆新开一张地图" onClick={() => acts?.newFromSample()}>📜 从内置示例新建</button>
          <button type="button" class="tbtn" title="自定义架空历法（月名/月长/每日时数）并命名存下，新建地图时可直接选用" onClick={() => { calOverlaySig.value = true; }}>📅 历法</button>
          {v.fsSupported && v.source !== "folder" && (
            <button type="button" class="tbtn" title="链接一个本地文件夹作为图库，直接读写其中的 .json（需 Edge/Chrome 经 localhost 或 https）" onClick={() => acts?.linkFolder()}>📁 链接文件夹</button>
          )}
          {/* GeoJSON 一次只收一个：字段映射弹层是逐文件一份，多选会排出一串弹层 */}
          <input ref={geoRef} type="file" accept=".geojson,.json,application/geo+json,application/json" style={{ display: "none" }}
            onChange={e => {
              const el = e.currentTarget as HTMLInputElement;
              const f = el.files && el.files[0];
              el.value = "";
              if (f) acts?.importGeoFile(f, "lib");
            }} />
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
              <button type="button" class="tbtn" title="切回浏览器图库（存于此浏览器的本地存储）" onClick={() => acts?.backToBrowser()}>💾 切回浏览器图库</button>{" "}
              <button type="button" class="tbtn" title="改链接到另一个文件夹" onClick={() => acts?.linkFolder()}>📁 更换文件夹</button></>
            : <>当前图库：<b>💾 浏览器图库</b>{v.fsSupported
              ? <span class="sub"> — 也可「📁 链接文件夹」把地图存成真正的 .json 文件，随时用其它软件/网盘管理</span>
              : <span class="sub"> —「链接文件夹」需用 Edge/Chrome 经 localhost 或 https 打开（当前环境不支持）</span>}</>}
        </div>
        <div class="hm-grid">
          {v.entries.map(m => {
            const c = m.counts || {};
            return (
              /* 卡片语义（2026-08-26 R4-#5）：原 div role=button 内嵌删除 button＝ARIA 禁止的嵌套
                 交互后代——改 article + 铺满整卡的透明「打开」钮（z 1）＋同级删除钮（z 2），
                 视觉与点击面逐位不变，Tab 序＝打开→删除，读屏各念各的。 */
              <article key={m.id} class="mapcard" title={`打开「${m.name || "未命名"}」`}>
                <button type="button" class="mc-open" aria-label={`打开「${m.name || "未命名"}」`} onClick={() => acts?.open(m.id)}></button>
                {/* 图种角标（2026-08-19 用户点单「一眼分清哪个是战术图」）：**两种都挂**——只给战术图挂
                    等于要用户拿「没有标记」当标记；压在缩略图角上而不是跟在名字后面，才是「一眼」。 */}
                <span class={"mc-kind" + (c.tac ? " tac" : "")}>{c.tac ? "⚔ 战术图" : "🗺 战略图"}</span>
                {m.thumb ? <img class="mc-thumb" src={m.thumb} alt="" /> : <div class="mc-thumb">{c.tac ? "⚔" : "🗺"}</div>}
                <div class="mc-body">
                  <div class="mc-name">{m.name || "未命名"}</div>
                  <div class="mc-sub">{c.tac
                    ? `${c.nodes || 0} 地点 · ${c.units || 0} 部队 · 兵棋战场图`
                    : `${c.nodes || 0} 地点 · ${c.factions || 0} 派系 · ${c.events || 0} 战役`}</div>
                  <div class="mc-sub">更新 {fmtTime(m.updatedAt)}</div>
                </div>
                <button type="button" class="mc-del" title="删除此地图" onClick={e => { e.stopPropagation(); acts?.remove(m.id); }}>🗑</button>
              </article>
            );
          })}
          {!v.entries.length && (v.source === "folder"
            ? <div class="hm-empty">文件夹 <b>{v.folderName}</b> 里还没有地图。<br />点「🆕 新建地图」在此创建一张，或把导出的 .json 放进这个文件夹。</div>
            /* 首启二选一：图库为空＝首次到访（删光地图后重现属合理），给两张大卡代替空态小字 */
            : <div class="hm-choice">
                <button type="button" class="hc" onClick={() => acts?.newFromSample()}>
                  <span class="ic">📜</span>
                  <span class="t">打开示例地图</span>
                  <span class="s">一张内置示例大陆，存入图库后直接打开——四处看看、随意改动</span>
                </button>
                <button type="button" class="hc" onClick={() => openSettings("create")}>
                  <span class="ic">🆕</span>
                  <span class="t">新建地图</span>
                  <span class="s">从头定世界尺寸、纪年历法与地形起伏，开一张自己的图</span>
                </button>
              </div>)}
        </div>
        <div class="hm-foot">默认图库存在<b>此浏览器的本地存储</b>里（每张独立自动存档，打开即回到上次视角与纪年）；也可<b>「📁 链接文件夹」</b>把地图当作真正的 <b>.json 文件</b>直接读写、随其它软件/网盘管理。
          浏览器存档在换电脑/清数据前请用 ⚙ 设置「💾 导出 JSON」逐图备份；删除不可恢复。</div>
      </div>
    </div>
  );
}
