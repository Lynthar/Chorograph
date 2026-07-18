/* 军面 · 部队列表：战术图列全部部队——兵种徽章（派系色）+ 名称 + 兵力·速度；
   点击＝选中（检查器出卡）并飞到当前时刻位置。「＋ 新增部队」＝先入列表（未入场，track 空），
   在检查器改名设属性，再按住列表项拖到地图放置（HTML5 DnD→画布 drop 落首航点）；画布点击恒为选择。
   ⚠超速标记只在选中部队的检查器卡里给出（可达性预算只算选中部队，见 boot 的 unitLegs effect）。 */
import { unitKind, unitPos, unitSpeed } from "../core/units.ts";
import { addUnitUnplaced } from "./editops.ts";
import { flyReqSig, isTacSig, mutateWorld, selSig, showToast, worldSig, yearSig } from "./state.ts";

export function UnitsPane() {
  const world = worldSig.value!;
  const tac = isTacSig.value;
  const sel = selSig.value;
  const T = yearSig.value;
  if (!tac) {
    return (
      <div class="empty"><span class="ph">军</span><b>部队为战术图专属</b>
        <p>打开某场战役的战术图后，部队在此列出（战役事件卡 →「⚔ 打开战术图」）。</p></div>
    );
  }
  const units = world.units || [];
  return (
    <>
      <div class="sec">部队<span class="cnt">{units.length}</span>
        <button type="button" class="mini tr" title="新增未入场部队：先在检查器改名/设属性，再按住列表项拖到地图上放置"
          onClick={() => {
            let uid: string | null = null;
            mutateWorld(w => { uid = addUnitUnplaced(w, `未命名部队 ${(w.units || []).length + 1}`).id; });
            if (uid) selSig.value = { kind: "unit", id: uid };
            showToast("已新增未入场部队——按住列表项拖到地图放置", { undo: true });
          }}>＋ 新增部队</button></div>
      {units.length === 0 && (
        <div class="empty"><span class="ph">军</span><b>还没有部队</b>
          <p>点上方「＋ 新增部队」先入列表（未入场），再按住列表项<b>拖到地图上</b>放置；按住图上部队拖动＝记录当日位置（先把时间轴拖到目标日）。</p></div>
      )}
      {units.length > 0 && (
        <div class="rows">
          {units.map(u => {
            const k = unitKind(u);
            const f = u.faction ? world.factions.find(x => x.id === u.faction) : null;
            const isSel = !!(sel && sel.kind === "unit" && sel.id === u.id);
            const strength = u.strength != null ? String(u.strength).trim() : "";
            const unplaced = !(u.track || []).length;
            return (
              <button key={u.id} class={"unit tr" + (isSel ? " sel" : "")} draggable={unplaced}
                title={unplaced ? "按住拖到地图上＝放置（落当前时刻首航点）" : undefined}
                onDragStart={e => {
                  if (!unplaced || !e.dataTransfer) return;
                  e.dataTransfer.setData("text/unit-id", u.id);
                  e.dataTransfer.effectAllowed = "copy";
                  selSig.value = { kind: "unit", id: u.id };
                }}
                onClick={() => {
                  selSig.value = { kind: "unit", id: u.id };
                  const p = unitPos(u, T);
                  if (p) flyReqSig.value = { lon: p.lon, lat: p.lat };
                }}>
                <span class="bs" style={{ background: (f && f.color) || "#6a5326" }}>{k ? k.glyph : "旅"}</span>
                <span class="un"><b>{u.名称 || "未命名部队"}</b>
                  <span>{strength ? strength + " · " : ""}{unitSpeed(u)} km/日{unplaced ? " · 未入场·拖入地图放置" : ` · ${u.track.length} 航点`}</span></span>
              </button>
            );
          })}
        </div>
      )}
      <div class="hint">航点 track＝[{"{"}日t, 经, 纬, 状态{"}"}] · 位置按航点<b>插值回放</b> · 选中后可拖圈上手柄调火力/视野 · <b>Shift+拖</b>＝框选部队</div>
    </>
  );
}
