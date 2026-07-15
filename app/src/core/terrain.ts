/* 程序化地形初稿（纯函数）：给定 (lon, lat) + meta（种子/风格/范围）即定。
   四种模式：auto=程序化生成 / plain=空白平原 / island=四海环岛 / sample=内置示例大陆。
   ⚠ 判定阈值与旧实现逐位一致（黄金基准锁定）；手绘涂改(terrainOverrides)叠加在初稿之上，不在本模块。 */
import { fbm } from "./noise.ts";
import { LEGACY_TO_COMPOSITE } from "./constants.ts";
import { DEFAULT_BBOX, type Meta, type TerrainId } from "./types.ts";

/* 程序化生成（meta.terrain==="auto"）：分形噪声高程场 + 径向落水掩膜（陆地居中、四周环海）
   + 独立湿度场 → 判定地形类型。风格 continent=单块大陆 / archipelago=群岛（更碎、海平面更高）。 */
export function genTerrainAt(meta: Meta | undefined, lon: number, lat: number): TerrainId {
  const m = meta || {}, bb = m.bbox || DEFAULT_BBOX;
  const seed = ((m.genSeed as number) | 0) || 1, isle = m.genStyle === "archipelago";
  // seed → 噪声采样相位偏移（错开不同世界的噪声，实现"换一块大陆"）
  const sx = (seed % 233) * 0.371 + 13.7, sy = (Math.floor(seed / 233) % 233) * 0.531 + 7.13;
  const u = (lon - bb.lonMin) / ((bb.lonMax - bb.lonMin) || 1), v = (lat - bb.latMin) / ((bb.latMax - bb.latMin) || 1);
  const F = isle ? 7.0 : 4.2;   // 群岛特征更碎
  // 高程：三个倍频叠加（粗轮廓+中细节+细碎）
  let h = 0.55 * fbm(u * F + sx, v * F + sy)
        + 0.30 * fbm(u * F * 2.3 + sx * 1.7 + 40, v * F * 2.3 + sy * 1.3 + 40)
        + 0.15 * fbm(u * F * 4.9 + sx + 80, v * F * 4.9 + sy + 80);
  // 径向落水掩膜：中心高、边缘低（群岛掩膜更强）
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2, d = Math.min(1, Math.sqrt(dx * dx + dy * dy) / 1.18);
  h = h * (1.12 - (isle ? 1.05 : 0.86) * d * d);
  h = Math.max(0, Math.min(1, (h - 0.06) * 1.35));
  const SEA = isle ? 0.44 : 0.40;
  if (h < SEA) return "water";
  if (h < SEA + 0.035) return "coast";
  if (h > 0.77) return "mountain";
  if (h > 0.61) return "hill";
  // 低地/中地：由独立湿度场决定 荒漠/平原/森林/水泽
  let mo = 0.6 * fbm(u * 3.1 + sx * 0.7 + 120, v * 3.1 + sy * 0.9 + 120)
         + 0.4 * fbm(u * 6.3 + sx + 160, v * 6.3 + sy + 160);
  mo = Math.max(0, Math.min(1, (mo - 0.15) * 1.6));
  // 河网/湿地：脊线噪声细带，仅低地（读作蜿蜒河流/沿河湿地）
  const chan = 1 - Math.abs(2 * fbm(u * 3.6 + sx + 200, v * 3.6 + sy + 200) - 1);
  if (h < SEA + 0.16 && chan > 0.9) return "marsh";
  if (mo < 0.28) return "desert";
  if (mo > 0.68 && h < SEA + 0.12) return "marsh";
  if (mo > 0.5) return "forest";
  return "plain";
}

/* 四海环岛：边缘落水 + 噪声起伏 */
export function islandTerrainAt(meta: Meta | undefined, lon: number, lat: number): TerrainId {
  const bb = (meta && meta.bbox) || DEFAULT_BBOX;
  const ex = Math.min(lon - bb.lonMin, bb.lonMax - lon) / (bb.lonMax - bb.lonMin);
  const ey = Math.min(lat - bb.latMin, bb.latMax - lat) / (bb.latMax - bb.latMin);
  const edge = Math.min(ex, ey) + (fbm(lon * 0.3 + 5, lat * 0.3 + 2) - 0.5) * 0.07;
  return edge < 0.075 ? "water" : (edge < 0.125 ? "coast" : "plain");
}

/* 内置示例大陆（依方位给初稿；一块居中大陆、四周环海，纯演示） */
export function sampleTerrainAt(lon: number, lat: number): TerrainId {
  if (lon <= 86) return "water";                          // 西部外洋
  if (lon >= 129) return "water";                         // 东海
  const LA = lat + (fbm(lon * 0.35 + 9, lat * 0.35 + 3) - 0.5) * 5;  // 纬向分界加噪声
  if (LA >= 49) return "mountain";                        // 极北群峰
  if (LA >= 45) return "hill";                            // 北方边境丘陵
  if (lon <= 97 && LA >= 34) return "mountain";           // 西部山地
  if (lon <= 90 && LA < 34) return "coast";               // 西陲沿海
  if (LA <= 25) return "marsh";                           // 南方水乡
  if (LA <= 28 && lon >= 116) return "marsh";             // 东南水泽
  if (lon >= 124 && LA >= 30 && LA <= 38) return "coast"; // 东部沿海
  if (lon >= 110 && lon <= 122 && lat >= 30 && lat <= 42) return "plain"; // 中部平原
  if (LA >= 42) return "hill";
  return "plain";
}

/* 地形初稿统一入口：按 meta.terrain 分派（缺省=示例式），输出**复合串**。
   内部分类器仍产旧 8 类、经 LEGACY_TO_COMPOSITE 重贴为复合（"forest"→"plain/forest"…）；
   plain/coast/hill/mountain/water 映射为自身（不变），只有 forest/desert/marsh 变复合。
   flatten(输出)===旧类 → 逐格分类平价保持（auto 不产新组合，新组合只从手绘来）。 */
export function seedTerrain(meta: Meta | undefined, lon: number, lat: number): string {
  const mode = (meta || {}).terrain || "sample";
  const t: TerrainId = mode === "plain" ? "plain"
    : mode === "auto" ? genTerrainAt(meta, lon, lat)
    : mode === "island" ? islandTerrainAt(meta, lon, lat)
    : sampleTerrainAt(lon, lat);
  return LEGACY_TO_COMPOSITE[t];
}
