/* 两轴地形（重构 A）Phase 1 地基：LANDFORM×ECO 表 + terrainProps/parseComposite/flatten/canon。
   核心不变式——8 个 canonical 旧复合串经 terrainProps 逐位复现旧四表（保 cellCost/黄金基准）。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TERRAIN, TERRAIN_ORDER, TERRAIN_ECO, ELEV, TINT,
  LANDFORM, ECO, LEGACY_TO_COMPOSITE,
  parseComposite, canonComposite, flattenTerrain, terrainProps, isValidTerrain
} from "../src/core/constants.ts";
import type { TerrainId } from "../src/core/types.ts";

describe("两轴地形 · 8 旧类逐位复现", () => {
  for (const t of TERRAIN_ORDER) {
    it(`terrainProps(${t}) 与旧四表逐位一致`, () => {
      const composite = LEGACY_TO_COMPOSITE[t];
      // 复合串与旧 id 两种入参都应复现
      for (const cell of [composite, t]) {
        const p = terrainProps(cell);
        assert.equal(p.名, t === "marsh" ? "沼泽" : TERRAIN[t].名, "名（水泽→沼泽 显示名重命名，其余同旧）");
        assert.equal(p.land, TERRAIN[t].land, "land（cellCost 逐位）");
        assert.equal(p.color, TERRAIN[t].color, "color");
        assert.deepEqual(p.tint, TINT[t] || null, "tint");
        assert.equal(p.elev, ELEV[t], "elev（不经浮点分解，逐位）");
        assert.deepEqual(p.scatter, TERRAIN_ECO[t] || [], "生态散布");
        assert.equal(p.water, t === "water" || t === "marsh" || t === "coast", "水军可行");
      }
    });
  }
});

describe("两轴地形 · 复合解析与 flatten", () => {
  it("parseComposite 拆分与缺省", () => {
    assert.deepEqual(parseComposite("plain"), ["plain", "none"]);
    assert.deepEqual(parseComposite("hill/forest"), ["hill", "forest"]);
    assert.deepEqual(parseComposite("plain/marsh"), ["plain", "marsh"]);
    assert.deepEqual(parseComposite(""), ["plain", "none"]);       // 空串防御
    assert.deepEqual(parseComposite("bogus/nope"), ["plain", "none"]); // 非法回退
  });
  it("canonComposite 归一（eco=none 省略）", () => {
    assert.equal(canonComposite("plain/none"), "plain");
    assert.equal(canonComposite("hill/forest"), "hill/forest");
    assert.equal(canonComposite("plain"), "plain");
  });
  it("flattenTerrain 复合→旧8类，且旧类映射可往返", () => {
    for (const t of TERRAIN_ORDER) assert.equal(flattenTerrain(LEGACY_TO_COMPOSITE[t]), t, `${t} 往返`);
    // 生态优先取旧同名
    assert.equal(flattenTerrain("hill/forest"), "forest");
    assert.equal(flattenTerrain("mountain/desert"), "desert");
    // 无旧对应生态（草原）落到地貌
    assert.equal(flattenTerrain("plain/grassland"), "plain");
    assert.equal(flattenTerrain("hill/grassland"), "hill");
  });
});

describe("两轴地形 · 新组合按 LANDFORM×ECO 计算", () => {
  it("plain/grassland（新生态）", () => {
    const p = terrainProps("plain/grassland");
    assert.equal(p.land, LANDFORM.plain.land * ECO.grassland.costMul);   // 1.05
    assert.equal(p.water, false);
    assert.equal(p.color, ECO.grassland.color);
    assert.equal(p.elev, LANDFORM.plain.elev + ECO.grassland.elevBias);
  });
  it("hill/forest（森林覆盖丘陵）代价高于平原森林、继承丘陵高程", () => {
    const hf = terrainProps("hill/forest"), pf = terrainProps("plain/forest");
    assert.ok(hf.land > pf.land, "丘陵森林更难行");
    assert.equal(hf.tint, ECO.forest.tint, "生态色调随森林");
    assert.ok(hf.elev > pf.elev, "高程随丘陵抬升");
    assert.equal(hf.water, false);
  });
  it("water/marsh 与 coast 水军可涉", () => {
    assert.equal(terrainProps("water").water, true);
    assert.equal(terrainProps("coast").water, true);
    assert.equal(terrainProps("mountain/marsh").water, true, "沼泽生态使水军可涉");
    assert.equal(terrainProps("hill/forest").water, false);
  });
});

describe("两轴地形 · 表完整性", () => {
  it("每个 Ecotype 与 Landform 都有条目", () => {
    for (const k of ["plain", "coast", "hill", "mountain", "water"] as const) assert.ok(LANDFORM[k], `LANDFORM.${k}`);
    for (const k of ["none", "forest", "grassland", "marsh", "desert"] as const) assert.ok(ECO[k], `ECO.${k}`);
  });
  it("LEGACY_TO_COMPOSITE 覆盖全部旧 8 类", () => {
    for (const t of TERRAIN_ORDER as TerrainId[]) assert.ok(LEGACY_TO_COMPOSITE[t], t);
  });
});

describe("两轴地形 · isValidTerrain 白名单（P5 落盘校验）", () => {
  it("旧 8 类、纯地貌、合法复合通过", () => {
    for (const t of TERRAIN_ORDER) assert.ok(isValidTerrain(t), t);
    assert.ok(isValidTerrain("plain/forest"));
    assert.ok(isValidTerrain("hill/grassland"));
    assert.ok(isValidTerrain("mountain"));
    assert.ok(isValidTerrain("water/marsh"));
  });
  it("畸形复合拒绝", () => {
    assert.ok(!isValidTerrain("bogus"));
    assert.ok(!isValidTerrain("plain/bogus"));
    assert.ok(!isValidTerrain("forest/plain"));        // forest 不是地貌
    assert.ok(!isValidTerrain("plain/forest/extra"));  // 三段非法
  });
});
