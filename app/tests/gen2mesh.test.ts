/* 生成器 v2 的宏观三角网（core/gen2mesh）：Delaunay、方向、拓扑、确定性、图幅内处处可定位。
   尺寸取缺省战略图的宏观格（139×118）与一张细长图幅。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMesh, meshLocate, type Gen2Mesh } from "../src/core/gen2mesh.ts";

const CASES: [number, number, number][] = [[139, 118, 217], [200, 9, 31]];
const meshes = CASES.map(([c, r, s]) => buildMesh(c, r, s));

const orient = (m: Gen2Mesh, a: number, b: number, c: number): number => (m.X[b] - m.X[a]) * (m.Y[c] - m.Y[a]) - (m.Y[b] - m.Y[a]) * (m.X[c] - m.X[a]);

describe("宏观三角网", () => {
  it("每个三角形逆时针，且是 Delaunay：任一邻三角形的对顶点都不严格落在它的外接圆内", () => {
    for (const m of meshes) {
      const { X, Y, tri, adj } = m, T = tri.length / 3;
      let cw = 0, viol = 0;
      for (let t = 0; t < T; t++) {
        const a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
        if (orient(m, a, b, c) <= 0) cw++;
        for (let k = 0; k < 3; k++) {
          const u = adj[3 * t + k]; if (u < 0) continue;
          let p = -1; for (let j = 0; j < 3; j++) { const v = tri[3 * u + j]; if (v !== a && v !== b && v !== c) p = v; }
          const adx = X[a] - X[p], ady = Y[a] - Y[p], bdx = X[b] - X[p], bdy = Y[b] - Y[p], cdx = X[c] - X[p], cdy = Y[c] - Y[p];
          const det = (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) - (bdx * bdx + bdy * bdy) * (adx * cdy - cdx * ady) + (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady);
          if (det > 1e-9) viol++;
        }
      }
      assert.strictEqual(cw, 0, "有非逆时针的三角形");
      assert.strictEqual(viol, 0, `${viol} 处违反 Delaunay`);
    }
  });
  it("拓扑：三角形数＝2·顶点 − 边界顶点 − 2，邻接互指，真节点经邻接连成一片", () => {
    for (const m of meshes) {
      const { tri, adj, X, cols, rows, nbOff } = m, T = tri.length / 3;
      let border = 0, back = 0;
      for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
        const u = adj[3 * t + k];
        if (u < 0) { border++; continue; }
        if (![0, 1, 2].some(j => adj[3 * u + j] === t)) back++;
      }
      assert.strictEqual(T, 2 * X.length - border - 2);
      assert.strictEqual(back, 0, "邻接不互指");
      const seen = new Uint8Array(cols * rows), st = [0]; seen[0] = 1; let k = 1;
      while (st.length) { const i = st.pop()!; for (let e = nbOff[i]; e < nbOff[i + 1]; e++) { const j = m.nb[e]; if (!seen[j]) { seen[j] = 1; k++; st.push(j); } } }
      assert.strictEqual(k, cols * rows, "真节点的邻接图不连通");
    }
  });
  it("同参两次逐位相同", () => {
    const [c, r, s] = CASES[0], a = meshes[0], b = buildMesh(c, r, s);
    assert.deepStrictEqual([a.X, a.Y, a.tri, a.adj, a.nb], [b.X, b.Y, b.tri, b.adj, b.nb]);
  });
  it("图幅内处处可定位：逐行扫细格中心（每行从上一行开头的三角形起步），权非负、和为 1", () => {
    for (const m of meshes) {
      const I = new Int32Array(3), W = new Float64Array(3), sub = 9;
      let rowHint = 0, miss = 0, bad = 0;
      for (let y = 0; y < m.rows * sub; y++) {
        let hint = rowHint;
        for (let x = 0; x < m.cols * sub; x++) {
          const t = meshLocate(m, -0.5 + (x + 0.5) / sub, -0.5 + (y + 0.5) / sub, hint, I, W);
          if (t < 0) { miss++; continue; }
          if (x === 0) rowHint = t;
          hint = t;
          if (W[0] < -1e-9 || W[1] < -1e-9 || W[2] < -1e-9 || Math.abs(W[0] + W[1] + W[2] - 1) > 1e-9) bad++;
        }
      }
      assert.strictEqual(miss, 0, `${miss} 个点没定位到`);
      assert.strictEqual(bad, 0, `${bad} 个点的权不对`);
    }
  });
});
