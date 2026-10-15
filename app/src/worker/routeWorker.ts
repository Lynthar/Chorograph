/* 寻路 Worker 入口：A星/可达性移出主线程。
   module worker，相对导入 core——不含裸说明符，无需 import map。 */
import { handleRouteMsg, type RouteCtx, type RouteRequest } from "./routeProto.ts";
import type { NestSol } from "../core/nested.ts";

const st: RouteCtx = {};
/** 嵌套解那份解的数组（都是回执新分配的，交出即不再读） */
const nestBufs = (s: NestSol): ArrayBuffer[] => [s.h.buffer as ArrayBuffer, s.sk.buffer as ArrayBuffer, ...(s.up ? [s.up.idx.buffer as ArrayBuffer, s.up.du.buffer as ArrayBuffer, s.up.kw.buffer as ArrayBuffer] : [])];
const scope = globalThis as unknown as {
  onmessage: ((e: { data: RouteRequest }) => void) | null;
  postMessage(m: unknown, transfer?: ArrayBufferLike[]): void;
};
scope.onmessage = e => {
  const r = handleRouteMsg(st, e.data);
  if (!r) return;
  /* 侵蚀场按 transfer 交回（工作档十余 MB、精修档 70 MB 免一次拷贝）：erodeField 的数组都是独立分配的，
     Worker 侧交出即不再读 */
  if (r.t === "erode") scope.postMessage(r, [r.f.data.buffer]);
  else if (r.t === "carve" && r.carve) scope.postMessage(r, [r.carve.data.buffer]);
  else if (r.t === "uplift") scope.postMessage(r, [r.base.buffer, r.env.buffer, r.cls.buffer, ...(r.basin ? [r.basin.buffer] : []), ...(r.water ? [r.water.at.buffer] : []), ...nestBufs(r.nest)]);
  else if (r.t === "meso") {
    const b = r.nest.base;
    scope.postMessage(r, [r.base.buffer, r.env.buffer, r.cls.buffer, ...(r.sg ? [r.sg.h.buffer, r.sg.rcv.buffer] : []), b.X.buffer, b.Y.buffer, b.fU.buffer, b.fK.buffer, b.fP.buffer, b.fB.buffer, ...nestBufs(r.nest.sol)]);
  }
  else scope.postMessage(r);
};
