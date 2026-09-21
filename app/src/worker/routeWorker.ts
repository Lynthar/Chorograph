/* 寻路 Worker 入口：A星/可达性移出主线程。
   module worker，相对导入 core——不含裸说明符，无需 import map。 */
import { handleRouteMsg, type RouteCtx, type RouteRequest } from "./routeProto.ts";

const st: RouteCtx = {};
const scope = globalThis as unknown as {
  onmessage: ((e: { data: RouteRequest }) => void) | null;
  postMessage(m: unknown, transfer?: ArrayBufferLike[]): void;
};
scope.onmessage = e => {
  const r = handleRouteMsg(st, e.data);
  if (!r) return;
  /* 侵蚀场按 transfer 交回（工作档十余 MB、精修档 70 MB 免一次拷贝）：erodeField 的数组都是独立分配的，
     Worker 侧交出即不再读 */
  if (r.t === "erode") scope.postMessage(r, r.f.shadow ? [r.f.data.buffer, r.f.shadow.buffer] : [r.f.data.buffer]);
  else scope.postMessage(r);
};
