/* 应用外壳入口（单一真源；起外壳拆分为 src/shell/* 模块，本文件只负责装配）。
   装配链：ctx（共享可变态）→ parseDeepLink（URL 直达）→ host（画布宿主）→
   libio（图库 IO/自动保存）→ startApp（启动编排：渲染器/组件挂载/启动流程/effects/
   chrome 接线/指针交互/帧循环）。全链路 tsc 严格检查（原 @ts-nocheck 已随 摘除）。 */
import "./ui/tokens.css";
import { createRouteClient } from "./worker/routeClient.ts";
import { createShellCtx } from "./shell/ctx.ts";
import { parseDeepLink } from "./shell/deeplink.ts";
import { createHost } from "./shell/host.ts";
import { createLibraryIO } from "./shell/library.ts";
import { startApp } from "./shell/boot.ts";
import { $ } from "./shell/dom.ts";

const canvas = $("map") as HTMLCanvasElement, ov = $("ov") as HTMLCanvasElement;
/* 全局兜底可见出口（审计「沉默失败」主线最后一道网）：未捕获异常/未处理 Promise 拒绝 → #err 错误条 */
const errLine = (m: string): void => { try { const el = $("err"); if (el) el.textContent = "⚠ " + m; } catch {} };
addEventListener("error", e => { if (e.error != null) errLine(String((e.error && e.error.message) || e.error)); });
addEventListener("unhandledrejection", e => { errLine(String((e.reason && e.reason.message) || e.reason || "未知异步错误")); });
const ctx = createShellCtx(canvas, ov, createRouteClient());   // 共享可变态集中于 ctx（DPR·meta·view·grid·R·图库…）
const dl = parseDeepLink(ctx);   // URL 直达：即时副作用落地，want* 延迟量由启动流程消费
const host = createHost(ctx);
const libio = createLibraryIO(ctx, dl, host);

try {
  await startApp(ctx, dl, host, libio);
} catch (e) { $("err").textContent = String((e as Error).message || e); }

/* PWA：仅生产构建 + http(s) 下注册离线 Service Worker（file:// 与 dev 跳过，避免 HMR 干扰）。 */
if (import.meta.env.PROD && "serviceWorker" in navigator && location.protocol.startsWith("http")) {
  addEventListener("load", () => { navigator.serviceWorker.register("./sw.js").catch(() => {}); });
}
