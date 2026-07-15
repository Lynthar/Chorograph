/* 军面 · 部队列表：战术图列全部部队——兵种徽章（派系色）+ 名称 + 兵力·速度；
   点击＝选中（检查器出卡）并飞到当前时刻位置。新建/拖动航点在画布（军工具已激活）。
   ⚠超速标记只在选中部队的检查器卡里给出（可达性预算只算选中部队，见 boot 的 unitLegs effect）。 */
import { unitKind, unitPos, unitSpeed } from "../core/units.ts";
import { flyReqSig, isTacSig, selSig, worldSig, yearSig } from "./state.ts";

export function UnitsPane() {
  const world = worldSig.value!;
  const tac = isTacSig.value;
  const sel = selSig.value;
  const T = yearSig.value;
  if (!tac) {
    return (
      <div class="empty"><span class="ph">军</span><b>部队为战术图专属</b>
        <p>打开某场战役的战术地图后，部队在此列出（战役事件卡 →「⚔ 打开战术图」）。</p></div>
    );
  }
  const units = world.units || [];
  return (
    <>
      <div class="sec">部队<span class="cnt">{units.length}</span></div>
      {units.length === 0 && (
        <div class="empty"><span class="ph">军</span><b>还没有部队</b>
          <p>在地图空白处点一下即可新建部队；按住部队拖动＝记录当日位置（先把时间坞拖到目标日）。</p></div>
      )}
      {units.length > 0 && (
        <div class="rows">
          {units.map(u => {
            const k = unitKind(u);
            const f = u.faction ? world.factions.find(x => x.id === u.faction) : null;
            const isSel = !!(sel && sel.kind === "unit" && sel.id === u.id);
            const strength = u.strength != null ? String(u.strength).trim() : "";
            return (
              <button key={u.id} class={"unit tr" + (isSel ? " sel" : "")}
                onClick={() => {
                  selSig.value = { kind: "unit", id: u.id };
                  const p = unitPos(u, T);
                  if (p) flyReqSig.value = { lon: p.lon, lat: p.lat };
                }}>
                <span class="bs" style={{ background: (f && f.color) || "#6a5326" }}>{k ? k.glyph : "旅"}</span>
                <span class="un"><b>{u.名称 || "未命名部队"}</b>
                  <span>{strength ? strength + " · " : ""}{unitSpeed(u)} km/日{(u.track || []).length ? ` · ${u.track.length} 航点` : " · 未入场"}</span></span>
              </button>
            );
          })}
        </div>
      )}
      <div class="hint">航点 track＝[{"{"}日t, 经, 纬, 状态{"}"}] · 位置按航点<b>插值回放</b> · 选中后可拖圈上手柄调火力/视野</div>
    </>
  );
}
