/* 撤销/重做（分域快照，上限 60）：语义仍是"每步一份完整世界"，但串化时把「地形域」
   （terrainOverrides/heightOverrides——战术图与重涂改档的体积大头）与其余「对象域」分开；
   入栈时地形串与栈顶逐字相等 ⇒ 改存栈顶同一份（新串沦为临时垃圾被回收），
   于是连续 N 步对象编辑只多存 N 份小对象域 + 1 份地形串，不再是 N 份整档。
   接口与快照式完全一致；stats() 仅诊断/测试用。
   terrKey：判定两份世界的"地形是否相同"——撤销/重做时地形没变就不必重建网格（秒回）。 */
import type { Meta, World } from "../core/types.ts";

export const UNDO_MAX = 60;

/** meta 里进网格与派生场的每一个输入：网格（bbox/terrain/genSeed/genStyle/gridN/worldModel/mapKind）、
    高程与水面（relief/outside/elevUnitM）、侵蚀的物理尺度与档（kmPerDeg/planetRadiusKm/erode）。撤销判「地形没变」与
    host 判「类型网格可复用」同一张单子——漏一个＝改那项设置后派生场沿用旧值（outside 曾漏：撤销「图幅外」后水面仍是 320 m）。 */
export function terrMetaKey(m: Meta): string {
  return JSON.stringify([m.bbox, m.terrain, m.genSeed, m.genStyle, m.relief, m.outside, m.gridN, m.worldModel, m.mapKind,
    m.elevUnitM, m.kmPerDeg, m.planetRadiusKm, m.erode]);
}
export function terrKey(w: World): string {
  return terrMetaKey(w.meta || {}) + JSON.stringify([w.terrainOverrides, w.heightOverrides]);
}

/** 地形域键（体积大头且多数编辑步不动）；其余键全归对象域 */
const TERR_KEYS: readonly string[] = ["terrainOverrides", "heightOverrides"];

interface Snap { t: string; o: string }

/** 拆域串化；地形串与栈顶相等则复用栈顶那份（键的有无按原样保留＝与整档串化同语义） */
function encode(w: World, prev: Snap | undefined): Snap {
  const tObj: Record<string, unknown> = {}, oObj: Record<string, unknown> = {};
  for (const k of Object.keys(w)) ((TERR_KEYS.includes(k) ? tObj : oObj) as Record<string, unknown>)[k] = (w as unknown as Record<string, unknown>)[k];
  let t = JSON.stringify(tObj);
  if (prev && prev.t === t) t = prev.t;
  return { t, o: JSON.stringify(oObj) };
}
function decode(s: Snap): World {
  return { ...JSON.parse(s.o), ...JSON.parse(s.t) } as World;
}

export interface History {
  /** 压入 w 的快照；序列化失败＝放弃这步撤销并返 false */
  push(w: World): boolean;
  undo(cur: World): World | null;
  redo(cur: World): World | null;
  dropLast(): void;   // 丢弃最近一步 undo 快照（空笔刷回收：起笔已 push 但整笔无改动）
  /** 弹出最近一步 undo 快照：cur 与它不同＝返还原的世界（编辑中途抛错时回滚用），相同返 null */
  revert(cur: World): World | null;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
  /** 诊断：栈内快照数与实际驻留字节（相邻共享的地形串只计一次） */
  stats(): { steps: number; bytes: number };
}

export function createHistory(max = UNDO_MAX): History {
  const undo: Snap[] = [], redo: Snap[] = [];
  const put = (arr: Snap[], w: World): void => { arr.push(encode(w, arr[arr.length - 1])); };
  const retained = (arr: Snap[]): number =>
    arr.reduce((a, s, i) => a + s.o.length + (i > 0 && arr[i - 1].t === s.t ? 0 : s.t.length), 0);
  return {
    push(w) {
      try {
        put(undo, w);
        if (undo.length > max) undo.shift();
        redo.length = 0;
        return true;
      } catch { return false; /* 序列化失败=放弃这步撤销，不阻塞编辑 */ }
    },
    undo(cur) {
      if (!undo.length) return null;
      try { put(redo, cur); } catch { /* 同上 */ }
      return decode(undo.pop()!);
    },
    redo(cur) {
      if (!redo.length) return null;
      try { put(undo, cur); } catch { /* 同上 */ }
      return decode(redo.pop()!);
    },
    dropLast() { if (undo.length) undo.pop(); },
    revert(cur) {
      const s = undo.pop();
      if (!s) return null;
      try { const c = encode(cur, s); if (c.t === s.t && c.o === s.o) return null; } catch { /* 串不出来＝按改过处理 */ }
      return decode(s);
    },
    canUndo: () => undo.length > 0,
    canRedo: () => redo.length > 0,
    clear() { undo.length = 0; redo.length = 0; },
    stats() { return { steps: undo.length + redo.length, bytes: retained(undo) + retained(redo) }; }
  };
}
