/* 寻路 Worker 入口：A星/可达性移出主线程。
   module worker，相对导入 core——不含裸说明符，无需 import map。 */
import { handleRouteMsg, type RouteCtx, type RouteRequest } from "./routeProto.ts";

const st: RouteCtx = {};
const scope = globalThis as unknown as {
  onmessage: ((e: { data: RouteRequest }) => void) | null;
  postMessage(m: unknown): void;
};
scope.onmessage = e => {
  const r = handleRouteMsg(st, e.data);
  if (r) scope.postMessage(r);
};
