/* 测面 · 量距/行军读数：语义同旧 Measure/Route——
   量距=逐段大圆/平面直线累计；行军=A* 当年道路与地形、各速度档耗时、沿途地形拆分、途经。
   无路径错误就地（朱框）并给两条出路：换军种 / 去涂地形。 */
import { SPEEDS, terrainProps } from "../core/constants.ts";
import { distKm } from "../core/geo.ts";
import { measureLegs } from "../core/route.ts";
import { fmtKm } from "../core/util.ts";
import type { Arm, Meta } from "../core/types.ts";
import { armSig, modeSig, routeBusySig, routePtsSig, routeResSig, setMode, setRailTool, editSubSig, worldSig } from "./state.ts";

function Measure({ meta }: { meta: Meta }) {
  const pts = routePtsSig.value;
  const flat = meta.worldModel === "flat";
  const { legs, total } = measureLegs(meta, pts);
  return (
    <>
      {legs.length > 0 && (
        <div class="mtable">
          {legs.map((L, i) => (
            <div key={i} class="mr">
              <span class="l">{pts[i].node ? pts[i].node!.名称 : `${pts[i].lon}°,${pts[i].lat}°`} → {pts[i + 1].node ? pts[i + 1].node!.名称 : `${pts[i + 1].lon}°,${pts[i + 1].lat}°`}</span>
              <span class="v">{fmtKm(L.km)}</span>
            </div>
          ))}
          {pts.length >= 2 && <div class="mr hd"><span class="l">合计 · {flat ? "平面直线" : "球面大圆"}</span><span class="v">{fmtKm(total)}</span></div>}
        </div>
      )}
      {pts.length === 1 && <div class="hint">已设第 1 点，继续点击…</div>}
      {pts.length > 0 && <button class="ghostbt tr" onClick={() => { routePtsSig.value = []; }}>清除重来</button>}
      <div class="hint">连续点击加点（<b>吸附地点</b>）· 右键撤销上一点 · 逐段按{flat ? "平面直线" : "球面大圆"}计算</div>
    </>
  );
}

function Route({ meta }: { meta: Meta }) {
  const pts = routePtsSig.value;
  const arm = armSig.value;
  const res = routeResSig.value;
  const busy = routeBusySig.value;
  const [A, B] = pts;
  const straight = A && B ? distKm(meta, A.lon, A.lat, B.lon, B.lat) : null;
  return (
    <>
      <div class="seg2" id="armSeg">
        {([["land", "陆军"], ["water", "水军"], ["air", "飞行"]] as [Arm, string][]).map(([a, label]) => (
          <button key={a} aria-pressed={arm === a} onClick={() => { armSig.value = a; }}>{label}</button>
        ))}
      </div>
      <div class="kv2">
        <b>起</b><span>{A ? (A.node ? A.node.名称 : `${A.lon}°,${A.lat}°`) : "（点地图选起点）"}</span>
        <b>终</b><span>{B ? (B.node ? B.node.名称 : `${B.lon}°,${B.lat}°`) : "（点地图选终点）"}</span>
        {straight != null && <><b>直线</b><span class="num">{fmtKm(straight)}</span></>}
      </div>
      {busy && <div class="hint">算路中…</div>}
      {!busy && res && res.fail && (
        <>
          <div class="err"><b>该军种无可行路径。</b>水/山阻隔？换军种，或用「绘 → 形」涂通一条地形。</div>
          <div style={{ display: "flex", gap: "5px" }}>
            {arm !== "land" && <button class="ghostbt tr" onClick={() => { armSig.value = "land"; }}>换 陆军</button>}
            <button class="ghostbt tr" onClick={() => { setRailTool("draw"); editSubSig.value = "terrain"; }}>去涂地形</button>
          </div>
        </>
      )}
      {!busy && res && !res.fail && straight != null && (() => {
        const d = res.dist != null ? res.dist : straight;
        const terr = res.report ? Object.entries(res.report.terr).sort((a, b) => b[1] - a[1]) : [];
        return (
          <>
            <div class="kv2">
              <b>行程</b><span class="num">{fmtKm(d)} {res.arm === "air" ? "· 直飞" : `· 迂回 ×${(d / straight).toFixed(2)}`}</span>
            </div>
            <div class="mtable">
              <div class="mr hd"><span class="l">各速度档耗时</span><span class="v">A* · 当年道路</span></div>
              {(SPEEDS[res.arm] || SPEEDS.land).map(s => (
                <div key={s.名} class="mr"><span class="l">{s.名} {s.v} km/日</span><span class="v">{Math.ceil(d / s.v)} 日</span></div>
              ))}
            </div>
            {terr.length > 0 && (
              <div class="mtable">
                <div class="mr hd"><span class="l">沿途地形</span><span class="v">官道减半</span></div>
                {terr.map(([t, km]) => (
                  <div key={t} class="mr"><span class="l">{terrainProps(t).名}</span><span class="v">{Math.round(km)} km</span></div>
                ))}
              </div>
            )}
            {res.report && res.report.via.length > 0 && <div class="hint">途经：{res.report.via.map(n => n.名称 || n.id).join(" → ")}</div>}
          </>
        );
      })()}
      {pts.length > 0 && <button class="ghostbt tr" onClick={() => { routePtsSig.value = []; }}>清除重来</button>}
      <div class="hint">点地图上两处（优先吸附到地点）· 军种决定可否翻山/渡水/直飞</div>
    </>
  );
}

export function MeasurePane() {
  const world = worldSig.value;
  if (!world) return null;
  const mode = modeSig.value;
  const cur = mode === "route" ? "route" : "measure";
  return (
    <>
      <div class="seg2" id="seg-ms">
        <button aria-pressed={cur === "measure"} onClick={() => setMode("measure")}>量距</button>
        <button aria-pressed={cur === "route"} onClick={() => setMode("route")}>行军</button>
      </div>
      {cur === "measure" ? <Measure meta={world.meta} /> : <Route meta={world.meta} />}
    </>
  );
}
