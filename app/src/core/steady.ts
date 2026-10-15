/* 三角网上的河流功率律稳态（m=0.5、n=1）：全图解、影响带重解与画抬升的定树标定。
   ⚠ 跨引擎逐位确定（同 core/gen2）：只用四则与开方，堆的平手按节点号——流向树会把 1 ULP 放大成整片流域翻转。 */

/** 二叉最小堆（键＝高程，平手按节点号）：优先洪泛的次序由它定，平手规则是跨引擎确定性的一部分。满了按倍增长 */
export class Heap {
  k: Float64Array; v: Int32Array; n = 0;
  constructor(n: number) { this.k = new Float64Array(n); this.v = new Int32Array(n); }
  private less(a: number, b: number): boolean { return this.k[a] < this.k[b] || (this.k[a] === this.k[b] && this.v[a] < this.v[b]); }
  private swap(a: number, b: number): void { const tk = this.k[a]; this.k[a] = this.k[b]; this.k[b] = tk; const tv = this.v[a]; this.v[a] = this.v[b]; this.v[b] = tv; }
  push(key: number, val: number): void {
    if (this.n === this.k.length) {
      const k = new Float64Array(2 * this.n + 16), v = new Int32Array(2 * this.n + 16);
      k.set(this.k); v.set(this.v); this.k = k; this.v = v;
    }
    let i = this.n++; this.k[i] = key; this.v[i] = val;
    while (i > 0) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; this.swap(i, p); i = p; }
  }
  pop(): number {
    const v = this.v[0]; this.n--;
    if (this.n > 0) {
      this.k[0] = this.k[this.n]; this.v[0] = this.v[this.n];
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < this.n && this.less(l, m)) m = l;
        if (r < this.n && this.less(r, m)) m = r;
        if (m === i) break; this.swap(i, m); i = m;
      }
    }
    return v;
  }
}

/** 优先洪泛的起点入堆：seen 标好全部源点、键在 key，只放挨着非源点的那些。邻居全是源点的源点弹出时什么也不发现，
    堆按（键, 号）全序弹出，不放它们其余节点的弹出次序逐位不变——整片海就不必过堆；代价是它们不进洪泛序 */
export function pushRim(heap: Heap, seen: Uint8Array, key: Float64Array, nbOff: Int32Array, nb: Int32Array): void {
  for (let i = 0; i < seen.length; i++) {
    if (!seen[i]) continue;
    for (let e = nbOff[i]; e < nbOff[i + 1]; e++) if (!seen[nb[e]]) { heap.push(key[i], i); break; }
  }
}

/** 求解用的图：节点 i 的邻居是 nb[nbOff[i]] .. nb[nbOff[i + 1] − 1]，len 是对应边长（km），area 是节点面积（km²）。
    邻接必须对称（i 列着 j 则 j 列着 i）：lowestTree 按节点自己的邻居取受水者、洪泛按谁的表里有它，不对称时两者对不上 */
export interface SteadyGraph { nbOff: Int32Array; nb: Int32Array; len: Float64Array; area: Float64Array }
/** 一步增高＝U / (K·√max(A, acrit))·边长（U 已乘好高程标度）；out 标出口，出口高程固定为 hOut。
    head＝源头修正：面积大过 acrit 的叶节点（汇流面积＝自身面积）增量再乘 1 + head·(1 − √(acrit / 面积))——格内从分水岭起的那段河源没被解析，
    不补则格越粗山越矮；0＝不修正 */
export interface SteadyInput { U: Float64Array; K: Float64Array; acrit: number; out: Uint8Array; hOut: Float64Array; head: number }
/** 稳态解：流向（出口指自己）、汇流面积（km²）与到下游的边长；converged＝停在流向树不变（或相对容差）上，不是撞上轮数上限 */
export interface SteadyResult { h: Float64Array; rcv: Int32Array; A: Float64Array; rl: Float64Array; iters: number; converged: boolean }
/** maxIt 轮数上限；tol > 0 时 dmax ≤ tol·(hmax − 最低出口) 也算收敛；canon 每轮用规范积分（影响带重解的 base 必须这样解），
    首轮之后的流向树先试 lowestTree、不成再洪泛，与每轮都洪泛逐位同（洪泛序不试：它的积分次序要的是出堆序） */
export interface SteadyOpt { maxIt: number; tol: number; canon: boolean }

/** 源头修正的逐节点系数（作叶时乘）；head 为 0＝null，增量逐位同不修正 */
function headOf(G: SteadyGraph, inp: SteadyInput): Float64Array | null {
  if (!(inp.head > 0)) return null;
  const { area } = G, { acrit, head } = inp, f = new Float64Array(area.length).fill(1);
  for (let i = 0; i < area.length; i++) if (area[i] > acrit) f[i] = 1 + head * (1 - Math.sqrt(acrit / area[i]));
  return f;
}

/* —— 规范序与规范积分：A 只由子树结构定，与求解过程无关，子树相同的节点逐位同值 —— */
interface TreeWork { cnt: Int32Array; ch: Int32Array; fill: Int32Array; order: Int32Array; no: number }
const treeWork = (n: number): TreeWork => ({ cnt: new Int32Array(n + 1), ch: new Int32Array(n), fill: new Int32Array(n), order: new Int32Array(n), no: 0 });
/** 根（rcv[i] === i）按号入队、子按号：父必在子前 */
function treeOrder(rcv: Int32Array, w: TreeWork): void {
  const n = rcv.length, { cnt, ch, fill, order } = w;
  cnt.fill(0);
  for (let i = 0; i < n; i++) if (rcv[i] !== i) cnt[rcv[i] + 1]++;
  for (let i = 0; i < n; i++) cnt[i + 1] += cnt[i];
  fill.set(cnt.subarray(0, n));
  for (let i = 0; i < n; i++) if (rcv[i] !== i) ch[fill[rcv[i]]++] = i;
  let no = 0;
  for (let i = 0; i < n; i++) if (rcv[i] === i) order[no++] = i;
  for (let q = 0; q < no; q++) { const i = order[q]; for (let k = cnt[i]; k < cnt[i + 1]; k++) order[no++] = ch[k]; }
  w.no = no;
}
/** 按 treeOrder 积分：逆序积 A（本格面积 + 子节点按号降序逐个相加）、正序积 h；出口取 hOut，其余根不动。返回 [最大改变量, 最高点] */
function canonInt(G: SteadyGraph, inp: SteadyInput, U: Float64Array, rcv: Int32Array, rl: Float64Array, w: TreeWork, h: Float64Array, A: Float64Array, hmax0: number, hf: Float64Array | null): [number, number] {
  const { area } = G, { K, acrit, out, hOut } = inp, { order, no } = w;
  A.set(area);
  for (let q = no - 1; q >= 0; q--) { const i = order[q], j = rcv[i]; if (j !== i) A[j] += A[i]; }
  let dmax = 0, hmax = hmax0;
  for (let q = 0; q < no; q++) {
    const i = order[q], j = rcv[i];
    if (j === i) { if (out[i]) h[i] = hOut[i]; continue; }
    let v = U[i] / (K[i] * Math.sqrt(A[i] > acrit ? A[i] : acrit)) * rl[i];
    if (hf && A[i] === area[i]) v *= hf[i];
    v += h[j];
    const dv = v > h[i] ? v - h[i] : h[i] - v;
    if (dv > dmax) dmax = dv; if (v > hmax) hmax = v;
    h[i] = v;
  }
  return [dmax, hmax];
}

/** 流向树上的汇流面积（km²），与规范积分逐位同：同一棵树不论来自现解还是缓存，面积都是同一份 */
export function treeArea(rcv: Int32Array, area: Float64Array): Float64Array {
  const w = treeWork(rcv.length), A = Float64Array.from(area);
  treeOrder(rcv, w);
  for (let q = w.no - 1; q >= 0; q--) { const i = w.order[q], j = rcv[i]; if (j !== i) A[j] += A[i]; }
  return A;
}

/** 一轮优先洪泛定流向树：出口标进 seen、指自己，其余节点归第一个发现它的出堆邻居（堆按（本格 h, 号）），出堆序写进 order。
    返回出堆个数；够不到出口的节点 seen 为 0，rcv 与 rl 不动 */
export function floodTree(G: SteadyGraph, out: Uint8Array, h: Float64Array, rcv: Int32Array, rl: Float64Array, seen: Uint8Array, heap: Heap, order: Int32Array): number {
  const { nbOff, nb, len } = G, n = out.length;
  seen.fill(0); heap.n = 0;
  for (let i = 0; i < n; i++) if (out[i]) { seen[i] = 1; rcv[i] = i; }
  pushRim(heap, seen, h, nbOff, nb);
  let no = 0;
  while (heap.n) {
    const i = heap.pop(); order[no++] = i;
    for (let e = nbOff[i]; e < nbOff[i + 1]; e++) {
      const j = nb[e]; if (seen[j]) continue;
      seen[j] = 1; rcv[j] = i; rl[j] = len[e]; heap.push(h[j], j);
    }
  }
  return no;
}

/**
 * 不走堆的一轮流向树：ids 里每个节点的受水者取 cand 里按（h, 号）最低的邻居，rl 取受水者邻接表里第一条指向它的边。
 * 每个节点都排在这个最低邻之后时，洪泛的出堆序恰是（h, 号）升序、各节点被最低邻发现，结果与这一轮洪泛逐位同。
 * @param ids 这一轮洪泛要定受水者的节点，必须都够得着出口：够不着的洪泛不碰，这里却会给它接上受水者
 * @param cand 洪泛会出堆的节点（null＝ids 的邻居全会出堆）：漏标或多标，受水者就与洪泛不同
 * @param rcv / rl 上一轮的树：受水者没变的节点 rl 不重查
 * @returns false＝有节点不排在最低邻之后（零增量边上的平地），rcv / rl 可能已改了一部分，这一轮必须再洪泛
 */
export function lowestTree(G: SteadyGraph, h: Float64Array, rcv: Int32Array, rl: Float64Array, ids: Int32Array, cand: Uint8Array | null): boolean {
  const { nbOff, nb, len } = G;
  for (let t = 0; t < ids.length; t++) {
    const j = ids[t]; let m = -1, hm = 0;
    for (let e = nbOff[j]; e < nbOff[j + 1]; e++) {
      const k = nb[e]; if (cand && !cand[k]) continue;
      const hk = h[k]; if (m < 0 || hk < hm || (hk === hm && k < m)) { m = k; hm = hk; }
    }
    if (m < 0 || !(hm < h[j] || (hm === h[j] && m < j))) return false;
    if (rcv[j] === m) continue;
    let e = nbOff[m];
    while (e < nbOff[m + 1] && nb[e] !== j) e++;
    if (e === nbOff[m + 1]) return false;   // 邻接不对称：交给洪泛
    rcv[j] = m; rl[j] = len[e];
  }
  return true;
}

/** 全图稳态：每轮自出口优先洪泛（键＝本格 h）定流向树 → 汇流面积 → 自出口沿树积分，到流向树不变（或相对容差）或到上限。
    h0 是初值（出口处被 hOut 覆盖）；够不到出口的节点洪泛序下不碰，规范序下成根、高程不动 */
export function steady(G: SteadyGraph, inp: SteadyInput, h0: Float64Array, opt: SteadyOpt): SteadyResult {
  const { area } = G, { U, K, acrit, out, hOut } = inp, n = area.length;
  const h = Float64Array.from(h0), rcv = new Int32Array(n), prev = new Int32Array(n).fill(-1), rl = new Float64Array(n);
  const order = new Int32Array(n), A = new Float64Array(n), seen = new Uint8Array(n), heap = new Heap(n), tw = opt.canon ? treeWork(n) : null, hf = headOf(G, inp);
  let hs0 = Infinity;
  for (let i = 0; i < n; i++) if (out[i]) { h[i] = hOut[i]; if (hOut[i] < hs0) hs0 = hOut[i]; }
  if (hs0 === Infinity) hs0 = 0;
  let iters = 0, converged = false, live: Int32Array | null = null;   // 规范序：首次洪泛够得着的非出口节点，此后先试 lowestTree
  for (; iters < opt.maxIt; iters++) {
    let no = 0;   // 出堆序只给洪泛序积分用；规范序走 treeOrder
    if (!live || !lowestTree(G, h, rcv, rl, live, null)) {
      no = floodTree(G, out, h, rcv, rl, seen, heap, order);
      if (tw && !live) { const ids: number[] = []; for (let i = 0; i < n; i++) if (seen[i] && !out[i]) ids.push(i); live = Int32Array.from(ids); }
    }
    let dmax = 0, hmax = hs0;
    if (tw) {
      for (let i = 0; i < n; i++) if (!seen[i]) { rcv[i] = i; rl[i] = 0; }
      treeOrder(rcv, tw);
      [dmax, hmax] = canonInt(G, inp, U, rcv, rl, tw, h, A, hs0, hf);
    } else {
      A.set(area);
      for (let o = no - 1; o >= 0; o--) { const i = order[o], j = rcv[i]; if (j !== i) A[j] += A[i]; }
      for (let o = 0; o < no; o++) {
        const i = order[o], j = rcv[i]; if (j === i) continue;
        let v = U[i] / (K[i] * Math.sqrt(A[i] > acrit ? A[i] : acrit)) * rl[i];
        if (hf && A[i] === area[i]) v *= hf[i];
        v += h[j];
        const dv = v > h[i] ? v - h[i] : h[i] - v;
        if (dv > dmax) dmax = dv; if (v > hmax) hmax = v;
        h[i] = v;
      }
    }
    if (opt.tol > 0 && dmax <= opt.tol * (hmax - hs0)) { converged = true; break; }   // 平地上的平手翻转不改高程，到相对容差即停
    let same = true;
    for (let i = 0; i < n; i++) if (rcv[i] !== prev[i]) { same = false; break; }
    if (same) { converged = true; break; }
    prev.set(rcv);
  }
  return { h, rcv, A, rl, iters: Math.min(iters + 1, opt.maxIt), converged };
}

/** 带的闭包与出口：并进桥（base 里上游有带、下游又回带的带外节点）；出口＝带外且沿 base 流向不再进带的节点 */
function closeBand(rcv: Int32Array, band: Uint8Array, w: TreeWork): { inB: Uint8Array; esc: Uint8Array } {
  const n = rcv.length, { order, no } = w, up = Uint8Array.from(band), enters = new Uint8Array(n);
  for (let q = no - 1; q >= 0; q--) { const i = order[q], j = rcv[i]; if (j !== i && up[i]) up[j] = 1; }
  for (let q = 0; q < no; q++) { const i = order[q], j = rcv[i]; if (j !== i && (band[j] || enters[j])) enters[i] = 1; }
  const inB = Uint8Array.from(band), esc = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!band[i] && up[i] && enters[i]) inB[i] = 1;
  for (let q = 0; q < no; q++) { const i = order[q], j = rcv[i]; if (!inB[i] && (j === i || esc[j])) esc[i] = 1; }
  return { inB, esc };
}

/**
 * 影响带重解：带外流向冻结在 base，带内自「出口邻点 + 带内出口」优先洪泛重定流向，每轮重积 A 与 h，到带内流向不变或到 maxIt。
 * @param base 同一张图、同一组 K / acrit / 出口上用规范积分（`canon: true`）解出的稳态——洪泛序积分的解会让下面「逐位同 base」静默失效
 * @param band 影响带（抬升权重的支撑加余量）：必须罩住 U 与 base 那份不同的每个节点，否则带外的 U 变了流向却冻结，解不是稳态。
 *   桥（base 里上游有带、下游又回到带的带外节点）由本函数并进带，带内的水因此只流向不再回带的带外节点，不成回路
 * @param from 起解的状态（缺省 base）：只能是同一个 base、同一条带上本函数的返回值——带外流向与 base 不同就会被当成冻结的真值
 * @returns 整图的解与并过桥的带：带外流向与 base 逐位同；不在带的上游、也不在带的下游链上的节点 h 与 A 逐位同 base
 * @throws 带内有节点够不到出口（带外无路可去、带内又无出口）
 */
export function steadyBand(G: SteadyGraph, inp: SteadyInput, base: SteadyResult, band: Uint8Array, maxIt: number, from: SteadyResult = base): SteadyResult & { band: Uint8Array } {
  const { nbOff, nb, len, area } = G, { U, K, acrit, out, hOut } = inp, n = area.length, tw = treeWork(n), hf = headOf(G, inp);
  treeOrder(base.rcv, tw);
  const { inB, esc } = closeBand(base.rcv, band, tw);
  const ids: number[] = [], roots: number[] = [], seeds: number[] = [], isSeed = new Uint8Array(n), inD = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (inB[i] && !out[i]) ids.push(i);
  for (const i of ids) for (let e = nbOff[i]; e < nbOff[i + 1]; e++) { const j = nb[e]; if (esc[j] || (inB[j] && out[j])) isSeed[j] = 1; }   // 不挨带内陆地的出口发现不了谁，不进堆
  for (let i = 0; i < n; i++) if (isSeed[i]) { seeds.push(i); if (inB[i]) roots.push(i); }
  /* 每轮只重积受影响的节点：出口邻点往下的带外链（含链尾的根）、挨着带内陆地的带内出口与带内节点；其余节点的 A 恒等于 base。
     次序父在子前：带外链按 base 的规范序，带内节点按本轮出堆序（lowestTree 定树的轮次按自 F0 沿新流向的广度序） */
  for (const s of seeds) if (!inB[s]) for (let j = s; !inD[j]; j = base.rcv[j]) { inD[j] = 1; if (base.rcv[j] === j) break; }
  const F0: number[] = [];
  for (let q = 0; q < tw.no; q++) if (inD[tw.order[q]]) F0.push(tw.order[q]);
  for (const i of roots) F0.push(i);
  const nA = F0.length + ids.length, ax = new Int32Array(n).fill(-1);
  F0.forEach((i, k) => { ax[i] = k; }); ids.forEach((i, k) => { ax[i] = F0.length + k; });
  /* 带外的子节点（base 的子里不在带内的）固定不变，按号升序存；带内的子每轮按新流向分组 */
  const sOff = new Int32Array(nA + 1), sKid: number[] = [];
  for (let k = 0; k < nA; k++) {
    const i = k < F0.length ? F0[k] : ids[k - F0.length];
    for (let t = tw.cnt[i]; t < tw.cnt[i + 1]; t++) if (!inB[tw.ch[t]]) sKid.push(tw.ch[t]);
    sOff[k + 1] = sKid.length;
  }
  const rcv = Int32Array.from(from.rcv), rl = Float64Array.from(from.rl), h = Float64Array.from(from.h), A = Float64Array.from(from.A);
  const prev = new Int32Array(ids.length).fill(-1), seen = new Uint8Array(n), heap = new Heap(ids.length + seeds.length);
  const ford = new Int32Array(ids.length), bOff = new Int32Array(nA + 1), bPos = new Int32Array(nA), bKid = new Int32Array(ids.length);
  const idA = Int32Array.from(ids), cand = Uint8Array.from(isSeed);   // 带内洪泛出堆的是种子与带内节点
  for (const i of ids) cand[i] = 1;
  let iters = 0, converged = false;
  for (; iters < maxIt; iters++) {
    const fast = iters > 0 && lowestTree(G, h, rcv, rl, idA, cand);
    let nf = 0;
    if (!fast) {
      for (const i of ids) seen[i] = 0;
      heap.n = 0;
      for (const s of seeds) { seen[s] = 1; heap.push(h[s], s); }
      while (heap.n) {
        const i = heap.pop();
        if (!isSeed[i]) ford[nf++] = i;
        for (let e = nbOff[i]; e < nbOff[i + 1]; e++) {
          const j = nb[e]; if (!inB[j] || out[j] || seen[j]) continue;
          seen[j] = 1; rcv[j] = i; rl[j] = len[e]; heap.push(h[j], j);
        }
      }
      if (nf < ids.length) throw new Error("影响带重解：带内有节点够不到出口");
    }
    bOff.fill(0);
    for (const i of ids) bOff[ax[rcv[i]] + 1]++;
    for (let k = 0; k < nA; k++) bOff[k + 1] += bOff[k];
    bPos.set(bOff.subarray(0, nA));
    for (const i of ids) bKid[bPos[ax[rcv[i]]]++] = i;
    if (fast) for (let q = 0; q < F0.length + nf; q++) {   // 受水者都是种子（在 F0）或带内节点、且严格排在前面：广度序罩住全部带内节点
      const k = ax[q < F0.length ? F0[q] : ford[q - F0.length]];
      for (let t = bOff[k]; t < bOff[k + 1]; t++) ford[nf++] = bKid[t];
    }
    /* A＝本格面积 + 子节点按号降序逐个相加（与规范积分逐位同），子在父前；h 父在子前 */
    for (let q = F0.length + nf - 1; q >= 0; q--) {
      const j = q < F0.length ? F0[q] : ford[q - F0.length], k = ax[j];
      let a = area[j], t = sOff[k + 1] - 1, u = bOff[k + 1] - 1;
      while (t >= sOff[k] || u >= bOff[k]) {
        if (u < bOff[k] || (t >= sOff[k] && sKid[t] > bKid[u])) a += A[sKid[t--]]; else a += A[bKid[u--]];
      }
      A[j] = a;
    }
    for (let q = 0; q < F0.length + nf; q++) {
      const i = q < F0.length ? F0[q] : ford[q - F0.length], j = rcv[i];
      if (j === i) { if (out[i]) h[i] = hOut[i]; continue; }
      let v = U[i] / (K[i] * Math.sqrt(A[i] > acrit ? A[i] : acrit)) * rl[i];
      if (hf && A[i] === area[i]) v *= hf[i];
      h[i] = v + h[j];
    }
    let same = true;
    for (let k = 0; k < ids.length; k++) if (rcv[ids[k]] !== prev[k]) { same = false; prev[k] = rcv[ids[k]]; }
    if (same) { converged = true; break; }
  }
  treeOrder(rcv, tw);   // 带上游与下游链旁支的 h 随之平移：末了整图积一遍
  canonInt(G, inp, U, rcv, rl, tw, h, A, 0, hf);
  return { h, rcv, A, rl, iters: Math.min(iters + 1, maxIt), converged, band: inB };
}

/** 影响带余量（km）：小于它，画的山的形状随余量变——带内无处改道的河被迫翻山或切穿 */
export const BAND_MARGIN_KM = 400;

/** 影响带：沿三角网到 src 中任一节点的路程 ≤ marginKm 的节点（多源 Dijkstra，边长取 len） */
export function bandOf(G: SteadyGraph, src: Uint8Array, marginKm: number): Uint8Array {
  const { nbOff, nb, len } = G, n = src.length, d = new Float64Array(n).fill(Infinity), band = new Uint8Array(n), heap = new Heap(n + nb.length);
  for (let i = 0; i < n; i++) if (src[i]) { d[i] = 0; heap.push(0, i); }
  while (heap.n) {
    const i = heap.pop();
    if (band[i]) continue;
    band[i] = 1;
    for (let e = nbOff[i]; e < nbOff[i + 1]; e++) {
      const j = nb[e], v = d[i] + len[e];
      if (v <= marginKm && v < d[j]) { d[j] = v; heap.push(v, j); }
    }
  }
  return band;
}

/** 一个抬升区：U 加 s·w（idx / w 是权重的支撑与权重）；peak 是量「区内最高点」的节点，target 是那一点要到的 h + peakAdd。
    stencil（可缺）把第 p 个量峰点的 h 换成邻点加权和 Σ w·h（CSR：节点 at[off[p]..off[p+1])）——收尾要平滑时，量的就是平滑后的峰 */
export interface UpliftRegion { idx: Int32Array; w: Float64Array; peak: Int32Array; target: number; stencil?: { off: Int32Array; at: Int32Array; w: Float64Array } }
/** 标定链：带内重解几轮（首轮从 base 起、此后接着上一轮的解，系数取上一棵树上的闭式解）· 区间耦合的 Gauss–Seidel 遍数 */
const CAL_ROUNDS = 3, CAL_SWEEPS = 4;

/** 流向树固定时 h 对各区系数是仿射的：在这棵树上闭式求「区内最高点恰到目标」的最小系数，区内已到目标的取 0。
    inB 是并过桥的带：带内节点沿树出带后的高程与系数无关，只沿带内节点积分即与整图积分逐位同 */
function exactScale(G: SteadyGraph, inp: SteadyInput, tree: SteadyResult, inB: Uint8Array, regions: UpliftRegion[], peakAdd: Float64Array, s0: Float64Array, tw: TreeWork): Float64Array {
  const n = G.area.length, R = regions.length, { U, K, acrit, out } = inp, { rcv, rl, A } = tree, P: number[] = [], bo: number[] = [], hf = headOf(G, inp), area = G.area;
  const SO: number[] = [0], SA: number[] = [], SW: number[] = [];   // 各量峰点的模板（没给模板＝自己、权 1）
  for (const r of regions) r.peak.forEach((i, p) => {
    P.push(i);
    if (r.stencil) for (let t = r.stencil.off[p]; t < r.stencil.off[p + 1]; t++) { SA.push(r.stencil.at[t]); SW.push(r.stencil.w[t]); }
    else { SA.push(i); SW.push(1); }
    SO.push(SA.length);
  });
  const meas = (arr: Float64Array, p: number): number => { let v = 0; for (let t = SO[p]; t < SO[p + 1]; t++) v += SW[t] * arr[SA[t]]; return v; };
  treeOrder(rcv, tw);
  for (let q = 0; q < tw.no; q++) { const i = tw.order[q]; if (inB[i] && !out[i]) bo.push(i); }
  const inc = (W: Float64Array, i: number): number => {
    const v = W[i] / (K[i] * Math.sqrt(A[i] > acrit ? A[i] : acrit)) * rl[i];
    return hf && A[i] === area[i] ? v * hf[i] : v;
  };
  const c = Float64Array.from(tree.h), hq = new Float64Array(n), wq = new Float64Array(n), g: Float64Array[] = [];
  for (const i of bo) c[i] = c[rcv[i]] + inc(U, i);
  for (const r of regions) {
    for (let t = 0; t < r.idx.length; t++) wq[r.idx[t]] = r.w[t];
    for (const i of bo) hq[i] = hq[rcv[i]] + inc(wq, i);
    g.push(Float64Array.from(P, (_, p) => meas(hq, p)));
    for (let t = 0; t < r.idx.length; t++) wq[r.idx[t]] = 0;
  }
  const s = Float64Array.from(s0);
  for (let sweep = 0; sweep < CAL_SWEEPS; sweep++) for (let k = 0, p0 = 0; k < R; p0 += regions[k].peak.length, k++) {
    const T = regions[k].target; let best = Infinity, hit = false;
    for (let p = p0; p < p0 + regions[k].peak.length; p++) {
      let a = meas(c, p) + peakAdd[P[p]];
      for (let q = 0; q < R; q++) if (q !== k) a += s[q] * g[q][p];
      if (a >= T) hit = true; else if (g[k][p] > 0) best = Math.min(best, (T - a) / g[k][p]);
    }
    s[k] = hit || best === Infinity ? 0 : best;
  }
  return s;
}
const upliftU = (U: Float64Array, regions: UpliftRegion[], s: Float64Array): Float64Array => {
  const o = Float64Array.from(U);
  regions.forEach((r, k) => { for (let t = 0; t < r.idx.length; t++) o[r.idx[t]] += s[k] * r.w[t]; });
  return o;
};

/**
 * 画抬升：解 U + Σ s_k·w_k 下的影响带稳态，各区系数 s_k 定到「区内最高点（h + peakAdd）恰到目标」。
 * 标定链写死、同输入同输出：base 的树上闭式求 s →（带内重解定树 → 新树上闭式求 s）× CAL_ROUNDS，终解取最后一棵树上的闭式解。
 * @param base / band 同 steadyBand；band 必须罩住每个区的 idx
 * @returns 解、各区系数与并过桥的带：区内最高点到目标（浮点舍入内）；不抬就已到目标的区系数为 0
 */
export function upliftSolve(G: SteadyGraph, inp: SteadyInput, base: SteadyResult, band: Uint8Array, regions: UpliftRegion[], peakAdd: Float64Array, maxIt: number): SteadyResult & { s: Float64Array; band: Uint8Array } {
  const tw = treeWork(G.area.length);
  treeOrder(base.rcv, tw);
  const { inB } = closeBand(base.rcv, band, tw);
  let s = exactScale(G, inp, base, inB, regions, peakAdd, new Float64Array(regions.length), tw), S: SteadyResult & { band: Uint8Array } | null = null, iters = 0;
  for (let r = 0; r < CAL_ROUNDS; r++) {
    S = steadyBand(G, { ...inp, U: upliftU(inp.U, regions, s) }, base, band, maxIt, S ?? base);
    iters += S.iters;
    s = exactScale(G, inp, S, inB, regions, peakAdd, s, tw);
  }
  const T = S!, h = Float64Array.from(T.h), A = new Float64Array(G.area.length);
  treeOrder(T.rcv, tw);
  canonInt(G, inp, upliftU(inp.U, regions, s), T.rcv, T.rl, tw, h, A, 0, headOf(G, inp));
  return { h, rcv: T.rcv, A, rl: T.rl, iters, converged: T.converged, s, band: T.band };
}
