/* 帧内标签避让场：地名/标注/部队三方共用一个占位格局（先占先得，每个世界拷贝一场）。
   语义：tryPlace＝试位（撞则调用方换候选位/弃标）、claim＝无条件占位（标注「作者摆哪是哪」、
   选中标签强制显示时也要登记，让后来者绕开）。碰撞余量 +2/+1 与旧 drawNodes.collide 逐位一致；
   网格哈希把全量互撞降为邻格查询（数百标签的 O(n²) 尾巴剪掉）。 */

export interface LabelRect { x: number; y: number; w: number; h: number }

export interface LabelField {
  /** 空位则占并返回 true；撞位返回 false */
  tryPlace(r: LabelRect): boolean;
  /** 无条件占位（不检查冲突） */
  claim(r: LabelRect): void;
}

export function createLabelField(cell = 96): LabelField {
  const grid = new Map<string, LabelRect[]>();
  const keysOf = (r: LabelRect): string[] => {
    const out: string[] = [];
    for (let gx = Math.floor((r.x - 2) / cell); gx <= Math.floor((r.x + r.w + 2) / cell); gx++)
      for (let gy = Math.floor((r.y - 1) / cell); gy <= Math.floor((r.y + r.h + 1) / cell); gy++)
        out.push(gx + "," + gy);
    return out;
  };
  const hits = (r: LabelRect): boolean => {
    for (const k of keysOf(r)) {
      const bucket = grid.get(k);
      if (!bucket) continue;
      for (const q of bucket)
        if (!(r.x + r.w + 2 < q.x || q.x + q.w + 2 < r.x || r.y + r.h + 1 < q.y || q.y + q.h + 1 < r.y)) return true;
    }
    return false;
  };
  const put = (r: LabelRect): void => {
    for (const k of keysOf(r)) { const b = grid.get(k); if (b) b.push(r); else grid.set(k, [r]); }
  };
  return {
    tryPlace(r) { if (hits(r)) return false; put(r); return true; },
    claim(r) { put(r); }
  };
}
