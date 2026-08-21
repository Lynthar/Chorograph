/* 产物体积护栏：单文件承诺的告警线（npm run build 末尾自动跑，CI 同享）。
   超限＝构建失败——依赖膨胀/误内联大资源在成品前被拦下；
   有意的功能增长需在此处上调限值（连同原因一并入提交说明）。 */
import { statSync } from "node:fs";

/* 2026-08-12 起限值放到 1MB（作者决定）：此前每批 +3~5KB 都要上调一次，摩擦大于收益。
   护栏自此只当**兜底**（防打包配置出错把依赖整包塞进来这类量级事故），日常的体积观察靠
   每次构建都打印的那行实测值——数字照样天天见，只是不再拦人。⚠ 代价说清楚：它不再是
   「悄悄长胖」的早期警报，真在意就看那行打印。当下 ~431KB / gzip ~153KB，离 1MB 很远。 */
const LIMIT_KB = 1024;
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
