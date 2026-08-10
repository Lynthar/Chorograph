/* 产物体积护栏：单文件承诺的告警线（npm run build 末尾自动跑，CI 同享）。
   超限＝构建失败——依赖膨胀/误内联大资源在成品前被拦下；
   有意的功能增长需在此处上调限值（连同原因一并入提交说明）。 */
import { statSync } from "node:fs";

const LIMIT_KB = 426;   // 2026-08-09 侵蚀缓存批+内核提速批 ~421KB（缓存 +3KB＝fieldcache/erodeKey/host；提速 +3KB＝行滑动 fbm/4 叉堆/侵蚀专用 Worker），留 ~5KB 余量（前值 415 系侵蚀真形批所定）
const file = new URL("../dist/index.html", import.meta.url);

let size;
try {
  size = statSync(file).size;
} catch {
  console.error("✗ 体积护栏：找不到 dist/index.html——先 vite build 再跑本脚本");
  process.exit(1);
}
const kb = size / 1024;
if (kb > LIMIT_KB) {
  console.error(`✗ 体积护栏：dist/index.html ${kb.toFixed(1)}KB 超过上限 ${LIMIT_KB}KB——确认增长必要后上调 scripts/checksize.mjs 限值`);
  process.exit(1);
}
console.log(`✓ 体积护栏：dist/index.html ${kb.toFixed(1)}KB ≤ ${LIMIT_KB}KB`);
