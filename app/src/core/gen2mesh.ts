/* 生成器 v2 的宏观节点与三角网：每格一个节点、在格内分层抖动并按最小间距拒绝（近似 Poisson 盘），
   图廓外再加一圈影子节点让三角网盖满图幅；三角网是 Delaunay（Bowyer–Watson）。
   ⚠ 跨引擎逐位确定（同 core/gen2）：只用四则、开方、floor 与整数哈希。 */

/** 宏观三角网。真节点 i 落在格 (i % cols, ⌊i / cols⌋) 里；下标 ≥ cols·rows 的是影子节点，取值时换成 src 指的真节点 */
export interface Gen2Mesh {
  cols: number; rows: number;
  /** 节点的格坐标：格 (q, r) 的格心在 (q, r) */
  X: Float64Array; Y: Float64Array;
  src: Int32Array;
  /** 三角形顶点，三个一组、逆时针；adj[3t + k] 是三角形 t 里顶点 k 对边的邻三角形（−1＝凸包外） */
  tri: Int32Array; adj: Int32Array;
  /** 真节点之间的三角网邻接（CSR）：i 的邻居是 nb[nbOff[i]] .. nb[nbOff[i + 1] − 1]，升序 */
  nbOff: Int32Array; nb: Int32Array;
}

/** 最小间距（格）：一格一点时 0.5 格基本都放得下，放不下取离邻点最远的候选 */
const MIN_GAP = 0.5, TRIES = 12;

/** 逐格确定性随机 [0,1)：整数哈希（生成器 v2 全链共用这一份） */
export function cellRand(i: number, seed: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(seed, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 真节点的位置（格坐标）：逐格按行扫，在整格内取候选，只与已放好的左、左上、上、右上四个邻格比间距 */
export function scatter(cols: number, rows: number, seed: number): { X: Float64Array; Y: Float64Array } {
  const n = cols * rows, X = new Float64Array(n), Y = new Float64Array(n);
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
    const i = r * cols + q;
    let bx = q, by = r, bd = -1;
    for (let k = 0; k < TRIES; k++) {
      const x = q - 0.5 + cellRand(2 * (i * TRIES + k), seed), y = r - 0.5 + cellRand(2 * (i * TRIES + k) + 1, seed);
      let d = Infinity;
      for (const j of [q > 0 ? i - 1 : -1, q > 0 && r > 0 ? i - cols - 1 : -1, r > 0 ? i - cols : -1, q + 1 < cols && r > 0 ? i - cols + 1 : -1]) {
        if (j < 0) continue;
        const e = (X[j] - x) * (X[j] - x) + (Y[j] - y) * (Y[j] - y); if (e < d) d = e;
      }
      if (d > bd) { bd = d; bx = x; by = y; }
      if (d >= MIN_GAP * MIN_GAP) break;
    }
    X[i] = bx; Y[i] = by;
  }
  return { X, Y };
}

const orient = (X: Float64Array, Y: Float64Array, a: number, b: number, c: number): number =>
  (X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a]);
/** p 严格落在逆时针三角形 abc 的外接圆内 */
function inCircle(X: Float64Array, Y: Float64Array, a: number, b: number, c: number, p: number): boolean {
  const adx = X[a] - X[p], ady = Y[a] - Y[p], bdx = X[b] - X[p], bdy = Y[b] - Y[p], cdx = X[c] - X[p], cdy = Y[c] - Y[p];
  return (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) - (bdx * bdx + bdy * bdy) * (adx * cdy - cdx * ady) + (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady) > 0;
}

/** 宏观三角网：真节点按 scatter 取位，影子节点抖在图廓外那一格靠外的半格里（四角钉死），凸包因此罩住整个图幅 */
export function buildMesh(cols: number, rows: number, seed: number): Gen2Mesh {
  const n = cols * rows, { X: rx, Y: ry } = scatter(cols, rows, seed);
  const gq: number[] = [], gr: number[] = [];
  for (let q = -1; q <= cols; q++) { gq.push(q, q); gr.push(-1, rows); }
  for (let r = 0; r < rows; r++) { gq.push(-1, cols); gr.push(r, r); }
  const g = gq.length, N = n + g, X = new Float64Array(N + 3), Y = new Float64Array(N + 3), src = new Int32Array(N);
  X.set(rx); Y.set(ry);
  for (let i = 0; i < n; i++) src[i] = i;
  for (let k = 0; k < g; k++) {
    const q = gq[k], r = gr[k], i = n + k, u = cellRand(2 * k, seed + 7), v = cellRand(2 * k + 1, seed + 7);
    X[i] = q < 0 ? -1.5 + 0.5 * u : q >= cols ? cols + 0.5 * u : q - 0.5 + u;
    Y[i] = r < 0 ? -1.5 + 0.5 * v : r >= rows ? rows + 0.5 * v : r - 0.5 + v;
    if ((q < 0 || q >= cols) && (r < 0 || r >= rows)) { X[i] = q < 0 ? -1.5 : cols + 0.5; Y[i] = r < 0 ? -1.5 : rows + 0.5; }
    src[i] = Math.max(0, Math.min(rows - 1, r)) * cols + Math.max(0, Math.min(cols - 1, q));
  }
  /* 超三角形：离图幅三倍远（再远外接圆行列式的乘积逼近双精度整数上限），最后连同挨着它的三角形一起删 */
  const M = 3 * (cols + rows), cx = cols / 2, cy = rows / 2;
  X[N] = cx - 2 * M; Y[N] = cy - M; X[N + 1] = cx + 2 * M; Y[N + 1] = cy - M; X[N + 2] = cx; Y[N + 2] = cy + 2 * M;
  const tv: number[] = [N, N + 1, N + 2], ta: number[] = [-1, -1, -1], alive: number[] = [1];
  /* 插入次序：含影子那一圈按格逐行扫——相邻两点挨着，定位从上一个新三角形走过去只要几步 */
  const order: number[] = [];
  for (let r = -1; r <= rows; r++) for (let q = -1; q <= cols; q++) {
    if (q >= 0 && q < cols && r >= 0 && r < rows) { order.push(r * cols + q); continue; }
    for (let k = 0; k < g; k++) if (gq[k] === q && gr[k] === r) { order.push(n + k); break; }
  }
  const bad: number[] = [], stack: number[] = [], isBad = new Uint8Array(16 * (N + 3)), edgeA: number[] = [], edgeB: number[] = [], edgeT: number[] = [];
  const byA = new Int32Array(N + 3).fill(-1), byB = new Int32Array(N + 3).fill(-1);
  let last = 0;
  for (const p of order) {
    /* 定位：可见性行走（Delaunay 三角网上必定终止） */
    let t = last;
    for (let step = 0; ; step++) {
      let moved = false;
      for (let k = 0; k < 3; k++) {
        const a = tv[3 * t + (k + 1) % 3], b = tv[3 * t + (k + 2) % 3];
        if (orient(X, Y, a, b, p) < 0 && ta[3 * t + k] >= 0) { t = ta[3 * t + k]; moved = true; break; }
      }
      if (!moved) break;
      if (step > 4 * (N + 3)) throw new Error("gen2mesh：三角网定位不收敛");
    }
    /* 空腔：外接圆含 p 的三角形，从所在三角形起按邻接扩 */
    bad.length = 0; stack.length = 0; stack.push(t); isBad[t] = 1;
    while (stack.length) {
      const s = stack.pop()!; bad.push(s);
      for (let k = 0; k < 3; k++) {
        const u = ta[3 * s + k];
        if (u >= 0 && !isBad[u] && inCircle(X, Y, tv[3 * u], tv[3 * u + 1], tv[3 * u + 2], p)) { isBad[u] = 1; stack.push(u); }
      }
    }
    edgeA.length = edgeB.length = edgeT.length = 0;
    for (const s of bad) for (let k = 0; k < 3; k++) {
      const u = ta[3 * s + k];
      if (u >= 0 && isBad[u]) continue;
      edgeA.push(tv[3 * s + (k + 1) % 3]); edgeB.push(tv[3 * s + (k + 2) % 3]); edgeT.push(u);
    }
    /* 空腔边界每条边 (a, b) 与 p 连成新三角形 (a, b, p)：对 p 的边接外侧原邻居，另两条边接相邻的新三角形 */
    const base = alive.length;
    for (let e = 0; e < edgeA.length; e++) {
      const a = edgeA[e], b = edgeB[e], u = edgeT[e], nt = base + e;
      tv.push(a, b, p); ta.push(-1, -1, u); alive.push(1);
      byA[a] = nt; byB[b] = nt;
      if (u >= 0) for (let k = 0; k < 3; k++) if (ta[3 * u + k] >= 0 && isBad[ta[3 * u + k]] && tv[3 * u + (k + 1) % 3] === b && tv[3 * u + (k + 2) % 3] === a) { ta[3 * u + k] = nt; break; }
    }
    for (let e = 0; e < edgeA.length; e++) { const nt = base + e; ta[3 * nt] = byA[edgeB[e]]; ta[3 * nt + 1] = byB[edgeA[e]]; }
    for (const s of bad) { alive[s] = 0; isBad[s] = 0; }
    if (isBad.length < alive.length + 16) throw new Error("gen2mesh：三角形数超出预留");
    last = base;
  }
  /* 删超三角形及挨着它的三角形，压紧编号 */
  const T = alive.length, map = new Int32Array(T).fill(-1);
  let m = 0;
  for (let t = 0; t < T; t++) if (alive[t] && tv[3 * t] < N && tv[3 * t + 1] < N && tv[3 * t + 2] < N) map[t] = m++;
  const tri = new Int32Array(3 * m), adj = new Int32Array(3 * m);
  for (let t = 0; t < T; t++) {
    const k = map[t]; if (k < 0) continue;
    for (let j = 0; j < 3; j++) { tri[3 * k + j] = tv[3 * t + j]; const u = ta[3 * t + j]; adj[3 * k + j] = u >= 0 ? map[u] : -1; }
  }
  /* 真节点之间的邻接：每条内边在它 a < b 的那个三角形里数一次 */
  const deg = new Int32Array(n + 1), pa: number[] = [], pb: number[] = [];
  for (let t = 0; t < m; t++) for (let j = 0; j < 3; j++) {
    const a = tri[3 * t + (j + 1) % 3], b = tri[3 * t + (j + 2) % 3];
    if (a < b && b < n) { pa.push(a); pb.push(b); deg[a]++; deg[b]++; }
  }
  const nbOff = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) nbOff[i + 1] = nbOff[i] + deg[i];
  const nb = new Int32Array(nbOff[n]), fill = nbOff.slice(0, n);
  for (let e = 0; e < pa.length; e++) { nb[fill[pa[e]]++] = pb[e]; nb[fill[pb[e]]++] = pa[e]; }
  for (let i = 0; i < n; i++) nb.subarray(nbOff[i], nbOff[i + 1]).sort();
  return { cols, rows, X: X.slice(0, N), Y: Y.slice(0, N), src, tri, adj, nbOff, nb };
}

/** 格坐标 (x, y) 处的插值：I 写三个真节点（影子已换成 src）、W 写对应的重心权。
    @param hint 从这个三角形开始走（逐格扫描时传上一格的返回值，几步就到）
    @returns 点所在的三角形。行走撞上凸包的凹处时退回逐个三角形查；点在凸包外返回 −1，取最近的顶点、权 1（图幅内的点不会落到这里） */
export function meshLocate(m: Gen2Mesh, x: number, y: number, hint: number, I: Int32Array, W: Float64Array): number {
  const { X, Y, tri, adj } = m, T = tri.length / 3;
  const out = (a: number, b: number): boolean => (X[b] - X[a]) * (y - Y[a]) - (Y[b] - Y[a]) * (x - X[a]) < 0;
  let t = hint >= 0 && hint < T ? hint : 0;
  for (let step = 0; step < 4 * T; step++) {
    let next = -2;
    for (let k = 0; k < 3; k++) {
      if (!out(tri[3 * t + (k + 1) % 3], tri[3 * t + (k + 2) % 3])) continue;
      next = adj[3 * t + k];
      if (next >= 0) break;
    }
    if (next === -2) return weigh(m, t, x, y, I, W);
    if (next < 0) break;
    t = next;
  }
  for (let s = 0; s < T; s++) if (!out(tri[3 * s], tri[3 * s + 1]) && !out(tri[3 * s + 1], tri[3 * s + 2]) && !out(tri[3 * s + 2], tri[3 * s])) return weigh(m, s, x, y, I, W);
  let best = 0, bd = Infinity;
  for (let i = 0; i < X.length; i++) { const d = (X[i] - x) * (X[i] - x) + (Y[i] - y) * (Y[i] - y); if (d < bd) { bd = d; best = i; } }
  I[0] = I[1] = I[2] = m.src[best]; W[0] = 1; W[1] = W[2] = 0;
  return -1;
}
function weigh(m: Gen2Mesh, t: number, x: number, y: number, I: Int32Array, W: Float64Array): number {
  const { X, Y, tri, src } = m, a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
  const det = (X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a]);
  const wb = ((x - X[a]) * (Y[c] - Y[a]) - (y - Y[a]) * (X[c] - X[a])) / det, wc = ((X[b] - X[a]) * (y - Y[a]) - (Y[b] - Y[a]) * (x - X[a])) / det;
  I[0] = src[a]; I[1] = src[b]; I[2] = src[c]; W[0] = 1 - wb - wc; W[1] = wb; W[2] = wc;
  return t;
}
