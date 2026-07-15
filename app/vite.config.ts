import { defineConfig, type Plugin, type Connect } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFile } from "node:fs/promises";
import path from "node:path";

/* 构建目标锁 ES2022 + WebGL2 时代浏览器。
   发行产物：vite-plugin-singlefile 把 JS/CSS + 内联 Worker 全量塞进单个 index.html——
   file:// 双击即跑、便于分发与永久归档（依赖腐烂对策：产物自包含）。
   工作位置在本地盘 C: 检出，Vite/rolldown 原生绑定在此正常执行。
   寻路 Worker 经 worker/routeClient.ts 的 `?worker&inline` 内联，产物无外部 worker 文件。 */

const GIF1PX = Buffer.from("R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "base64");
const REPO_ROOT = path.resolve(process.cwd(), "..");   // npm 脚本 cwd=app/，上溯即仓库根

/* dev/preview 工具插件（apply:"serve"，绝不进产物）——提供以下能力：
   · /__hold__?ms=N：延迟 N ms 返回 1px gif，把 load 压后到异步启动（IndexedDB/fetch）完成，
     再让无头 --screenshot 抓图（dev + preview 都提供）。
   · dev 下从仓库根供样例世界（战术夹具等）：Vite dev 页面在 /，app 的 fetch("../X.json")
     解析为 /X.json——按需从仓库根读出，仅 dev；发行默认空白，样例永不打进 build。 */
const holdMiddleware: Connect.NextHandleFunction = (req, res, next) => {
  const u = new URL(req.url || "/", "http://localhost");
  if (u.pathname !== "/__hold__") return next();
  const ms = Math.min(20000, +(u.searchParams.get("ms") || 5000) || 5000);
  setTimeout(() => {
    res.setHeader("content-type", "image/gif");
    res.setHeader("cache-control", "no-store");
    res.end(GIF1PX);
  }, ms);
};
const rootJsonMiddleware: Connect.NextHandleFunction = async (req, res, next) => {
  const u = new URL(req.url || "/", "http://localhost");
  if (!/^\/[^/]+\.json$/.test(u.pathname)) return next();
  // 解码后再校验落点仍在仓库根内：正则只挡字面斜杠，%2e%2e%2f 解码成 ../ 可逃逸（dev-only，仍防之）
  const name = decodeURIComponent(u.pathname).replace(/^\/+/, "");
  const abs = path.resolve(REPO_ROOT, name);
  if (path.dirname(abs) !== REPO_ROOT) return next();   // 只服务仓库根下的顶层 .json，拒绝越级
  try {
    const buf = await readFile(abs);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(buf);
  } catch { next(); }
};
function devTooling(): Plugin {
  return {
    name: "dev-tooling",
    apply: "serve",
    configureServer(server) { server.middlewares.use(holdMiddleware); server.middlewares.use(rootJsonMiddleware); },
    configurePreviewServer(server) { server.middlewares.use(holdMiddleware); }
  };
}

export default defineConfig({
  base: "./",                     // 相对基址：单文件在任意路径/子目录/file:// 下都可用（Pages 子路径部署、离线双击均可）
  build: { target: "es2022" },
  plugins: [viteSingleFile(), devTooling()]
});
