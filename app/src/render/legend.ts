/* 图例块（2026-07 特化·相位批）：只画进导出 PNG,不上画布。内容自动取图内**当刻**实际出现的——
   在场派系、在场部队的兵种与状态徽章、图上用到的可靠性档位;全空=不画。
   ⚠ 四行同一口径「这一帧真出现的」(2026-07-29 收口:原兵种取全体部队、状态取全时段用过的,
   于是长平相位0 的图例里列着 t7 才入场的辎重)。代价=各帧图例高矮不一,如实即可。
   右下角锚、宣纸底衬同比例尺;色调恒定不随主题（同「出图垫纸色」裁决:产物不随主题变）。
   坐标系=CSS 像素（调用方先按 DPR scale,同 drawOverlay 之约）。 */
import { CERTAINTY, CERTAINTY_ORDER, UNIT_KINDS, UNIT_STATUS } from "../core/constants.ts";
import { activeAt } from "../core/time.ts";
import { tget } from "../core/util.ts";
import { unitPos, unitStatusAt } from "../core/units.ts";
import { drawStatusBadge } from "./units.ts";
import type { World } from "../core/types.ts";

const ROW = 17, PADX = 9, PADY = 8, SW = 22, MARGIN = 12;

/** reserveBottom=右下角已被屏幕角标注占去的高度（pinnedStackH）——图例据此上抬让位。 */
export function drawLegend(g: CanvasRenderingContext2D, world: World, T: number, cssW: number, cssH: number,
  reserveBottom = 0): void {
  const facs = (world.factions || []).filter(f => activeAt(f, T));
  const live = (world.units || []).filter(u => unitPos(u, T));   // 未入场/已离场的部队不进图例
  const kinds = [...new Set(live.map(u => u.kind))].filter(k => tget(UNIT_KINDS, k));
  const stats = [...new Set(live.map(u => unitStatusAt(u, T) || ""))].filter(s => tget(UNIT_STATUS, s));
  const rows: { label: string; draw: (x: number, y: number) => void }[] = [];
  for (const f of facs) rows.push({ label: f.名称 || f.id, draw: (x, y) => {
    g.fillStyle = f.color || "#888"; g.fillRect(x, y - 5, 14, 10);
    g.strokeStyle = "rgba(60,48,30,.5)"; g.lineWidth = 1; g.strokeRect(x, y - 5, 14, 10);
  } });
  for (const k of kinds) rows.push({ label: UNIT_KINDS[k].名, draw: (x, y) => {   // 迷你单位框（同 drawUnitSymbol 形制;兵种不属派系=灰边）
    g.fillStyle = "rgba(24,26,30,.78)"; g.strokeStyle = "#6b6b6b"; g.lineWidth = 1.3;
    g.fillRect(x, y - 5.5, 16, 11); g.strokeRect(x, y - 5.5, 16, 11);
    g.fillStyle = "#f2ede2"; g.font = "bold 8px system-ui,sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(UNIT_KINDS[k].glyph, x + 8, y + 0.5);
  } });
  for (const s of stats) rows.push({ label: UNIT_STATUS[s].名, draw: (x, y) => drawStatusBadge(g, x + 7, y, s, UNIT_STATUS[s].color) });
  /* 可靠性（柱B）：图内真出现的档位才列——「诚实性」要在图上说得出，读图人才知道虚线不是别的意思 */
  const certs = CERTAINTY_ORDER.filter(k =>
    (world.nodes || []).some(n => n.certainty === k && activeAt(n, T)) ||
    (world.edges || []).some(e => e.certainty === k && activeAt(e, T)));
  for (const k of certs) rows.push({ label: CERTAINTY[k].名, draw: (x, y) => {
    g.save();
    g.globalAlpha = CERTAINTY[k].alpha;
    g.strokeStyle = "#4a4238"; g.lineWidth = 1.6; g.setLineDash(CERTAINTY[k].edgeDash); g.lineCap = "butt";
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + 16, y); g.stroke(); g.setLineDash([]);
    if (CERTAINTY[k].query) {
      g.font = "bold 9px system-ui,sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillStyle = "#3a2f1d"; g.fillText("?", x + 8, y - 6);
    }
    g.restore();
  } });
  if (!rows.length) return;
  g.save();
  g.font = "11px system-ui,sans-serif";
  let wMax = 0;
  for (const r of rows) wMax = Math.max(wMax, g.measureText(r.label).width);
  const W = PADX * 2 + SW + wMax, H = PADY * 2 + rows.length * ROW;
  const x0 = cssW - W - MARGIN, y0 = Math.max(MARGIN, cssH - H - MARGIN - reserveBottom);
  g.fillStyle = "rgba(246,239,220,.85)"; g.fillRect(x0, y0, W, H);
  g.strokeStyle = "rgba(90,74,38,.5)"; g.lineWidth = 1; g.strokeRect(x0, y0, W, H);
  rows.forEach((r, i) => {
    const y = y0 + PADY + i * ROW + ROW / 2;
    r.draw(x0 + PADX, y);
    g.fillStyle = "#3a2f1d"; g.font = "11px system-ui,sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";   // 行样绘制可能改字体/对齐——每行画标签前复位
    g.fillText(r.label, x0 + PADX + SW, y);
  });
  g.restore();
}
