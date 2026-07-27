/* 多标签提醒（BroadcastChannel 协议层）：同一浏览器里两个标签开着**同一张图**时互相告知。
   起因：图库写入是「整份覆盖」（library.save 无条件 put 整个 world），两边各自保存会**互相静默
   吃掉**对方的改动——2026-07-27 双标签实测：A 加的地点在 B 保存后从库里消失，全程零提示。
   ⚠ **只提醒不拦截**（用户拍板）：对方标签已关闭时的陈旧覆盖依然会发生；提醒的作用是
   「别让这个局面发生」，不是「发生了兜住」。真要兜住得在 save 里加版本守卫（另账）。
   本模块不碰 DOM——BroadcastChannel 的创建与 onmessage 接线在外壳，这里只有协议与纯判定，
   便于 node:test 锁语义（同 worker/routeProto.ts 之例）。 */

export type TabMsg =
  | { t: "open"; map: string; tab: string }     // 我打开了这张图
  | { t: "here"; map: string; tab: string }     // 回应：我也开着这张图
  | { t: "saved"; map: string; tab: string };   // 我刚把这张图写进了图库

/** 图键带来源前缀：浏览器图库的 id 与文件夹图库的文件名各成一套，别互相误认 */
export const tabMapKey = (source: string, mapId: string | null): string | null => mapId ? source + ":" + mapId : null;

export const TAB_WARN_OPEN = "这张图在另一个标签页也开着　两边各自保存会互相覆盖";
export const TAB_WARN_SAVED = "这张图刚在另一个标签页被保存　这里显示的已不是最新";

export interface TabWarned { open: boolean; saved: boolean }
export interface TabView { tab: string; map: string | null; warned: TabWarned }

/** 广播消息的形状校验（同源但仍可能来自旧版本页面／别的功能） */
export function isTabMsg(v: unknown): v is TabMsg {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (m.t === "open" || m.t === "here" || m.t === "saved") && typeof m.map === "string" && typeof m.tab === "string";
}

/** 收到一条广播该做什么（纯函数）：他图与自己一律忽略；open 要回应 here 让对方也知道。
    每类提醒**每张图只弹一次**——自动保存每次编辑都会广播 saved，不去重就成刷屏。 */
export function onTabMsg(st: TabView, m: TabMsg): { reply?: TabMsg; warn?: string; warned: TabWarned } {
  if (!st.map || m.map !== st.map || m.tab === st.tab) return { warned: st.warned };
  if (m.t === "saved")
    return { warn: st.warned.saved ? undefined : TAB_WARN_SAVED, warned: { ...st.warned, saved: true } };
  const reply = m.t === "open" ? { t: "here" as const, map: st.map, tab: st.tab } : undefined;
  return { reply, warn: st.warned.open ? undefined : TAB_WARN_OPEN, warned: { ...st.warned, open: true } };
}

export interface TabSync {
  /** 开图/换图/回图库（null）：换图即重置「已提醒」并向别的标签打招呼 */
  setMap(map: string | null): void;
  /** 本标签刚把当前图写进图库 */
  saved(): void;
  /** 收到广播（raw 未校验） */
  receive(raw: unknown): void;
}

export function createTabSync(tab: string, post: (m: TabMsg) => void, warn: (text: string) => void): TabSync {
  const st: TabView = { tab, map: null, warned: { open: false, saved: false } };
  return {
    setMap(map) {
      if (map === st.map) return;
      st.map = map;
      st.warned = { open: false, saved: false };
      if (map) post({ t: "open", map, tab });
    },
    saved() { if (st.map) post({ t: "saved", map: st.map, tab }); },
    receive(raw) {
      if (!isTabMsg(raw)) return;
      const act = onTabMsg(st, raw);
      st.warned = act.warned;
      if (act.reply) post(act.reply);
      if (act.warn) warn(act.warn);
    }
  };
}
