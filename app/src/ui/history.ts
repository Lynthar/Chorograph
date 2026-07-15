/* 撤销/重做（快照式，JSON 串存栈，上限 60——与旧实现一致；增量撤销是 兵棋增强的课题）。
   terrKey：判定两份世界的"地形是否相同"——撤销/重做时地形没变就不必重建网格（秒回）。 */
import type { World } from "../core/types.ts";

export const UNDO_MAX = 60;

export function terrKey(w: World): string {
  const m = w.meta || {};
  // genSeed/genStyle：auto 初稿随种子变（旧 key 漏掉——撤销「换一换」曾跳过重建显示陈旧地形）；
  // relief/heightOverrides：高程场输入（在 rebuild 里随网格一并重算）
  return JSON.stringify([m.bbox, m.terrain, m.genSeed, m.genStyle, m.relief, w.terrainOverrides, w.heightOverrides]);
}

export interface History {
  push(w: World): void;
  undo(cur: World): World | null;
  redo(cur: World): World | null;
  dropLast(): void;   // 丢弃最近一步 undo 快照（空笔刷回收：起笔已 push 但整笔无改动）
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
}

export function createHistory(max = UNDO_MAX): History {
  const undo: string[] = [], redo: string[] = [];
  return {
    push(w) {
      try {
        undo.push(JSON.stringify(w));
        if (undo.length > max) undo.shift();
        redo.length = 0;
      } catch { /* 序列化失败=放弃这步撤销，不阻塞编辑 */ }
    },
    undo(cur) {
      if (!undo.length) return null;
      try { redo.push(JSON.stringify(cur)); } catch { /* 同上 */ }
      return JSON.parse(undo.pop()!) as World;
    },
    redo(cur) {
      if (!redo.length) return null;
      try { undo.push(JSON.stringify(cur)); } catch { /* 同上 */ }
      return JSON.parse(redo.pop()!) as World;
    },
    dropLast() { if (undo.length) undo.pop(); },
    canUndo: () => undo.length > 0,
    canRedo: () => redo.length > 0,
    clear() { undo.length = 0; redo.length = 0; }
  };
}
