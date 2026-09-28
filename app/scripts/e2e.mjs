/* 浏览器冒烟（node scripts/e2e.mjs，CI 与本地共用，零依赖）：
   起本地 HTTP 供 dist/ → 无头 Chrome/Edge 经 CDP 驱动，锁「boot 无声悬死」一类
   node:test 够不着的整链回归：启动到图库 → 「从内置示例新建」建图并打开（create→IDB→
   网格→首帧）→ 顶栏出图名；再走一遍只读分享整链（#ro=1&d= 开图→写入门全关→
   「存入我的图库」接管成可编辑）——那些门全在 .tsx 里，node:test 持不到；全程零未捕获异常、零 console.error、#err 空。
   另锁一条渲染契约：推演底图（#base=flat）下像素颜色＝底栏读数那一格（GL 与 CPU 兜底各走一遍）——
   不是视觉回归（不比截图），只按格采样。兜底路径四条：CPU 观感底图连笔补画＝整幅重画（逐字节）、WebGL 上下文丢失后恢复、
   嵌套形状坏掉的存档不崩、file:// 双击冷启动。先 npm run build 再跑。浏览器可用 E2E_BROWSER 指定。 */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { embedShareHtml, packShare, shareHash } from "../src/core/share.ts";
import { allComposites, terrainProps } from "../src/core/constants.ts";

const DIST = path.resolve(import.meta.dirname, "../dist");
const MIME = { ".html": "text/html; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".js": "text/javascript", ".json": "application/json" };
const DEADLINE = Date.now() + 300_000;   // 含 CPU 兜底整幅重画与侵蚀落定的等待
const fail = (msg) => { console.error("✗ e2e：" + msg); process.exit(1); };
if (!existsSync(path.join(DIST, "index.html"))) fail("dist/index.html 不存在——先 npm run build");

/* —— 静态服务（只认 dist 里真实存在的文件名，杜绝路径穿越）—— */
let sharedHtml = "";   // 由走查本体在导出那一步填（真 dist 产物 + 内嵌数据）
/* 嵌套形状坏掉的存档（外部手编 / 旧版导出）：派系涂域是字符串、涂域层 cells 是对象、事件的作战线里有 null */
const BAD_NESTED = JSON.stringify({
  meta: { 名称: "坏档测", worldModel: "sphere", planetRadiusKm: 10000, kmPerDeg: 111,
    terrain: "sample", bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 } },
  factions: [{ id: "f1", 名称: "甲", color: "#aa3333", paint: "oops" }, { id: "f2", 名称: "乙", color: "#3333aa", paint: [{ cells: {} }] }],
  nodes: [{ id: "e1", type: "event", evtype: "battle", lon: 108, lat: 36, 名称: "会战", year: 3107, arrows: [null] }],
  edges: [], decor: [], terrainOverrides: []
});
const server = createServer((req, res) => {
  const name = (req.url || "/").split("?")[0].replace(/^\/+/, "") || "index.html";
  if (name === "shared.html") { res.writeHead(200, { "content-type": MIME[".html"] }); res.end(sharedHtml); return; }
  if (name === "bad-nested.json") { res.writeHead(200, { "content-type": MIME[".json"] }); res.end(BAD_NESTED); return; }
  const file = path.join(DIST, path.basename(name));
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

/* —— 起无头浏览器（端口 0＝随机，从 stderr 解析 DevTools ws 地址）—— */
const candidates = [
  process.env.E2E_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "google-chrome", "chromium-browser", "chromium", "msedge"
].filter(Boolean);
const bin = candidates.find(c => c.includes("/") || c.includes("\\") ? existsSync(c) : true);
const prof = mkdtempSync(path.join(tmpdir(), "yutu-e2e-"));
const br = spawn(bin, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${prof}`,
  "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--window-size=1280,800",
  "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
const cleanup = () => { try { br.kill(); } catch { /* 已退出 */ } server.close(); };
process.on("exit", cleanup);
const wsUrl = await new Promise((res, rej) => {
  let buf = "";
  br.stderr.on("data", d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
  br.on("exit", () => rej(new Error("浏览器未启动（" + bin + "）")));
  // 60s 而非 20s：CI 冷 runner 上浏览器首启动曾偷偷超过 20s，红的是机器不是产品
  setTimeout(() => rej(new Error("等 DevTools 端口超时")), 60_000);
}).catch(e => fail(e.message));

/* —— CDP：直接连浏览器端点，再 attach 首个 page target（flatten 会话） —— */
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(fail("WebSocket 连不上 " + wsUrl)); });
let seq = 0; const waits = new Map(); const errors = [];
let sessionId = null;
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
  if (m.method === "Runtime.exceptionThrown") errors.push("异常：" + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
    errors.push("console.error：" + m.params.args.map(a => a.value ?? a.description ?? "").join(" "));
  if (m.method === "Page.javascriptDialogOpening") {
    dialogs.push(m.params.message);
    ws.send(JSON.stringify({ id: ++seq, method: "Page.handleJavaScriptDialog", params: { accept: true }, sessionId }));
  }
  /* file:// 下浏览器按跨源拦 manifest（协议本身不许，PWA 只在 http(s) 成立）：不是应用的错 */
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon|manifest\.webmanifest/.test((m.params.entry.url || "") + m.params.entry.text))
    errors.push("log：" + m.params.entry.text);
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  waits.set(id, { res, rej });
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
});
const targets = (await send("Target.getTargets")).targetInfos.filter(t => t.type === "page");
sessionId = null;
const att = await send("Target.attachToTarget", { targetId: targets[0].targetId, flatten: true });
sessionId = att.sessionId;
await send("Runtime.enable"); await send("Page.enable"); await send("Log.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });   // 窗口被判遮挡＝visibilityState hidden、rAF 停摆，等重画的步骤会假超时
const dialogs = [];   // alert/confirm 会把页面挂住：记下文案、自动确认

const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const until = async (label, expr) => {
  while (Date.now() < DEADLINE) {
    if (await evalJs(expr)) return;
    await new Promise(r => setTimeout(r, 250));
  }
  fail("等待超时：" + label + "（现值 " + JSON.stringify(await evalJs(expr)) + "）");
};

/* —— 走查本体 —— */
await send("Page.navigate", { url: `${origin}/?b=${Math.random().toString(36).slice(2)}` });   // 独一 buster：同 URL 导航是 same-document
await until("启动落到图库", `!!document.querySelector('#home .hm-actions')`);
await evalJs(`document.querySelector('#home .hm-actions button[title^="以内置示例"]').click()`);
await until("示例图建成并打开（顶栏出图名）", `(t => t && t !== '—')(document.getElementById('crumbName')?.textContent)`);
await until("画布有尺寸", `(c => c && c.width > 0 && c.height > 0)(document.getElementById('map'))`);
/* —— 推演底图逐格一致：像素颜色＝底栏读数那一格。撒点合成 pointermove 读 #ftCoord 的地貌名，
   同一帧 drawImage(#map) 取像素（帧循环的 rAF 先于本帧注册，故先重画后取样），与 terrainProps.color 比。
   观感底图有意把地类边界揉开最多约一格半，推演底图是把这条差异收回零的那一档——GL 与 CPU 兜底各验一遍。 —— */
const mapName = await evalJs(`document.getElementById('crumbName').textContent`);
const nameColor = new Map(allComposites().map(c => { const p = terrainProps(c); return [p.名, p.color]; }));
const hexRGB = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const FLAT_SAMPLE = `(async () => {
  const cv = document.getElementById('map'), r = cv.getBoundingClientRect(), sx = cv.width / r.width, sy = cv.height / r.height, pts = [];
  for (let y = 40; y < r.height - 60; y += 23) for (let x = 30; x < r.width - 30; x += 29) pts.push([x, y]);
  const names = pts.map(([x, y]) => {
    cv.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerType: 'mouse' }));
    const segs = document.getElementById('ftCoord').textContent.split('｜').map(s => s.trim()), last = segs[segs.length - 1];
    return segs.length >= 2 && !/^高程|^经纬度/.test(last) ? last : null;   // 图幅外没有地貌段
  });
  return await new Promise(res => requestAnimationFrame(() => {
    const off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height;
    const g = off.getContext('2d'); g.drawImage(cv, 0, 0);
    res(JSON.stringify(pts.map(([x, y], i) => ({ n: names[i], c: Array.from(g.getImageData(Math.round(x * sx), Math.round(y * sy), 1, 1).data.slice(0, 3)) }))));
  }));
})()`;
for (const [label, extra] of [["GL", ""], ["CPU 兜底", "&force=cpu"]]) {
  await send("Page.navigate", { url: `${origin}/?b=${Math.random().toString(36).slice(2)}#map=${encodeURIComponent(mapName)}&base=flat${extra}` });
  await until(`推演底图（${label}）开图`, `document.getElementById('crumbName')?.textContent === ${JSON.stringify(mapName)} && (c => c && c.width > 0)(document.getElementById('map'))`);
  await new Promise(r => setTimeout(r, 800));   // 首帧落地
  const rows = JSON.parse(await evalJs(FLAT_SAMPLE)).filter(r => r.n && nameColor.has(r.n));
  const bad = rows.filter(r => { const e = hexRGB(nameColor.get(r.n)); return Math.max(...e.map((v, i) => Math.abs(v - r.c[i]))) > 2; });
  if (rows.length < 100) errors.push(`推演底图（${label}）图内采样点不足 ${rows.length}，走查没覆盖到画布`);
  if (bad.length) errors.push(`推演底图（${label}）${bad.length}/${rows.length} 个采样点的颜色不是读数那一格的（如 ${bad[0].n} 期望 ${nameColor.get(bad[0].n)} 实得 rgb(${bad[0].c})）`);
}
/* —— CPU 兜底的观感底图连笔：笔刷只补画变了的那片，补画结果须与同一输入的整幅重画逐字节相同。
   整幅重画靠拨「地形立体感」逼出（增益进瓦片键），拨回原档再比；两次拨动都要看到画面真变了，否则比对不成立 —— */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MAP_PIX = `(() => { const m = document.getElementById('map'), r = document.getElementById('canvasWrap').getBoundingClientRect();
  const w = Math.round(r.width * devicePixelRatio), h = Math.round(r.height * devicePixelRatio), c = document.createElement('canvas');
  c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(m, 0, 0); return g.getImageData(0, 0, w, h).data; })()`;
const pixHash = () => evalJs(`(() => { const d = ${MAP_PIX}; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) | 0; return h; })()`);
const erodeQuiet = async (label) => {   // 顶栏侵蚀胶囊连续 8 s 不在演算（盖住 6 s 静置精修窗）
  let since = Date.now();
  while (Date.now() < DEADLINE) {
    if (/侵蚀计算中|侵蚀精修中/.test(await evalJs(`document.getElementById('ftData')?.textContent || ''`))) since = Date.now();
    else if (Date.now() - since > 8000) return;
    await sleep(250);
  }
  fail("等待超时：" + label + "（侵蚀一直在演算）");
};
const waitRepaint = async (label, h0) => {
  for (let t = Date.now(); Date.now() - t < 20000; await sleep(250)) if (await pixHash() !== h0) return;
  errors.push(`${label}：画面没有重画，补画比对不成立`);
};
await send("Page.navigate", { url: `${origin}/?b=${Math.random().toString(36).slice(2)}#map=${encodeURIComponent(mapName)}&force=cpu` });
await until("CPU 观感底图开图", `document.getElementById('crumbName')?.textContent === ${JSON.stringify(mapName)} && (c => c && c.width > 0)(document.getElementById('map'))`);
await erodeQuiet("CPU 开图落定");
/* 比对要有区分力：示例大陆缺省无起伏（大片平台，窗边算错也看不出）→ 开「自然」；侵蚀计算选「仅底图」——
   缺省档收笔后侵蚀落地会整幅重画，最后上屏的就不是补画了 */
await evalJs(`document.getElementById('btnSettings').click()`);
await until("设置弹层（地势起伏）", `!!document.getElementById('sw_relief')`);
await evalJs(`(() => { document.getElementById('sw_relief').value = '0.7'; document.querySelector('input[name="sw_erode"][value="base"]').click(); [...document.querySelectorAll('button')].find(b => b.textContent.includes('应用到当前世界')).click(); })()`);
await until("起伏已应用", `!document.getElementById('sw_relief')`);
await erodeQuiet("起伏落定");
await evalJs(`document.querySelector('.rail .rl[aria-label="绘制"]').click()`);
await until("绘制面板", `!!document.getElementById('stgrid')`);
await evalJs(`[...document.querySelectorAll('#stgrid .st')].find(b => b.textContent.includes('地形')).click()`);
await until("地形子工具", `[...document.querySelectorAll('.seg2 button')].some(b => b.textContent.includes('高程'))`);
await evalJs(`[...document.querySelectorAll('.seg2 button')].find(b => b.textContent.includes('高程')).click()`);
const hPre = await pixHash();
await evalJs(`(async () => {
  const r = document.getElementById('canvasWrap').getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const m = document.getElementById('map');
  const fire = (type, x, y, buttons) => m.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: 0, buttons }));
  fire('pointerdown', cx - 120, cy, 1);
  for (let i = 1; i <= 24; i++) { await new Promise(res => setTimeout(res, 16)); fire('pointermove', cx - 120 + i * 10, cy + (i % 2) * 3, 1); }
  fire('pointerup', cx + 120, cy, 0);
})()`);
await erodeQuiet("连笔后落定");
if (await pixHash() === hPre) errors.push("CPU 观感底图连笔后画面没变（笔刷没落下或补画没上屏）");
await evalJs(`window.__patched = ${MAP_PIX}; 1`);
await evalJs(`document.getElementById('btnSettings').click()`);
await until("设置弹层", `document.querySelectorAll('[aria-labelledby="sw_shade_lab"] button').length > 1`);
const shade = (label) => evalJs(`[...document.querySelectorAll('[aria-labelledby="sw_shade_lab"] button')].find(b => b.textContent.startsWith(${JSON.stringify(label)})).click()`);
const h1 = await pixHash(); await shade("×1.5"); await waitRepaint("拨到 ×1.5", h1);
const h2 = await pixHash(); await shade("×1 默认"); await waitRepaint("拨回 ×1", h2);
await sleep(500);
const diff = await evalJs(`(() => { const a = window.__patched, b = ${MAP_PIX}; if (a.length !== b.length) return -1; let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; })()`);
if (diff !== 0) errors.push(`CPU 连笔补画与整幅重画不一致：${diff < 0 ? "画布尺寸变了" : diff + " 个通道值不同"}`);
await evalJs(`document.querySelector('.x[aria-label="关闭"]')?.click()`);

/* —— WebGL 上下文丢失后恢复（GPU 进程崩溃、驱动重置、后台回收）：恢复后地形重新出图，不留白屏、不报错 —— */
await send("Page.navigate", { url: `${origin}/?b=${Math.random().toString(36).slice(2)}#map=${encodeURIComponent(mapName)}` });
await until("GL 开图", `document.getElementById('crumbName')?.textContent === ${JSON.stringify(mapName)} && (c => c && c.width > 0)(document.getElementById('map'))`);
await sleep(1000);
const lost = await evalJs(`(async () => {
  const gl = document.getElementById('map').getContext('webgl2'); if (!gl) return 'nogl';
  const ext = gl.getExtension('WEBGL_lose_context'); if (!ext) return 'noext';
  ext.loseContext(); await new Promise(r => setTimeout(r, 300));
  if (!gl.isContextLost()) return 'notlost';
  ext.restoreContext(); await new Promise(r => setTimeout(r, 1500));
  return gl.isContextLost() ? 'stilllost' : 'ok';
})()`);
if (lost !== "ok" && lost !== "nogl" && lost !== "noext") errors.push("WebGL 上下文丢失/恢复走查未完成：" + lost);
const glNote = lost === "nogl" || lost === "noext" ? `（本机${lost === "nogl" ? "无 WebGL2" : "无 WEBGL_lose_context"}，丢失恢复一步跳过）` : "";
if (lost === "ok") {
  const colors = await evalJs(`(() => { const d = ${MAP_PIX}, s = new Set(); for (let i = 0; i < d.length; i += 400) s.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]); return s.size; })()`);
  if (colors < 20) errors.push(`WebGL 恢复后地形没重新出图（画面只有 ${colors} 种颜色）`);
}

/* —— 嵌套形状坏掉的存档：开得起来或明确拒开，都不许抛异常、不许留红条 —— */
await send("Page.navigate", { url: `${origin}/?b=${Math.random().toString(36).slice(2)}#sample=bad-nested.json` });
for (let t = Date.now(); ; await sleep(250)) {
  if (dialogs.length || await evalJs(`document.getElementById('crumbName')?.textContent === '坏档测'`)) break;
  if (Date.now() - t > 30000) break;
}
await sleep(1500);
const badOpened = await evalJs(`document.getElementById('crumbName')?.textContent === '坏档测'`);
if (!badOpened && !dialogs.some(t => /坏档测|bad-nested/.test(t))) errors.push("嵌套坏档既没开图也没有拒开回执");

/* —— 只读分享整链：链接自带整张图 → 写入门全关 → 接管成可编辑 —— */
const SHARED = JSON.stringify({
  meta: { 名称: "只读分享测", worldModel: "sphere", planetRadiusKm: 10000, kmPerDeg: 111,
    terrain: "sample", bbox: { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 } },
  factions: [], nodes: [{ id: "n1", type: "city", lon: 108, lat: 36, 名称: "甲城" },
    { id: "e1", type: "event", evtype: "battle", lon: 108, lat: 36, 名称: "会战", year: 3107 }],
  edges: [], decor: [], terrainOverrides: []
});
const hash = shareHash(await packShare(SHARED), { lon: 108, lat: 36, z: 0.06, year: 3107 });
/* 带持久副作用的深链参数撞只读：#gentac 曾先 create 子图再被父图编辑门拦下＝读者一点开链接图库就多一张、当前图换成子图 */
await send("Page.navigate", { url: `${origin}/?b=${Math.random().toString(36).slice(2)}${hash}&gentac=${encodeURIComponent("会战")}&dia=20` });
await until("只读 + gentac：仍停在分享的那张图", `document.getElementById('crumbName')?.textContent === '只读分享测' && /只读/.test(document.getElementById('ftData')?.textContent || '')`);
await until("只读 + gentac：给了回执", `/不能从它生成战术图/.test(document.querySelector('.toast')?.textContent || '')`);
await send("Page.navigate", { url: `${origin}/?b=${Math.random().toString(36).slice(2)}${hash}` });
await until("只读链接直达那张图", `document.getElementById('crumbName')?.textContent === '只读分享测'`);
await until("顶栏报只读", `/只读/.test(document.getElementById('ftData')?.textContent || '')`);
const gates = await evalJs(`JSON.stringify({
  adopt: getComputedStyle(document.getElementById('btnAdopt')).display !== 'none',
  home: getComputedStyle(document.getElementById('btnHome')).display !== 'none',
  rail: document.querySelectorAll('.rail .rl').length,
  canvas: (c => !!c && c.width > 0)(document.getElementById('map'))
})`);
const g = JSON.parse(gates);
if (!g.adopt) errors.push("只读页没出「存入我的图库」");
if (g.home) errors.push("只读页不该留图库入口");
if (g.rail !== 3) errors.push("只读工具轨应只剩览/测/层三条，实得 " + g.rail);
if (!g.canvas) errors.push("只读页画布未渲染");
await evalJs(`document.getElementById('btnAdopt').click()`);
await until("接管后回到可编辑（图库入口重现）",
  `getComputedStyle(document.getElementById('btnHome')).display !== 'none' && document.querySelectorAll('.rail .rl').length === 5`);
await until("接管后已入库（顶栏不再报只读）", `!/只读/.test(document.getElementById('ftData')?.textContent || '')`);
if (!await evalJs(`location.hash === ''`)) errors.push("接管后应清掉 #d=/#ro=（否则刷新又回只读那份）");

/* 导出的只读网页（真 dist 产物 + 内嵌数据）能不能开——单测用的是合成产物，
   而这条正是真产物才有的形状：它把 share.ts 的源码也内联了进去。 */
sharedHtml = embedShareHtml(readFileSync(path.join(DIST, "index.html"), "utf8"), SHARED);
await send("Page.navigate", { url: `${origin}/shared.html?b=${Math.random().toString(36).slice(2)}` });
await until("导出的只读网页能开", `document.getElementById('crumbName')?.textContent === '只读分享测'`);
if (!await evalJs(`/只读/.test(document.getElementById('ftData')?.textContent || '')`)) errors.push("内嵌数据的网页应恒只读");

/* —— file:// 双击冷启动（离线单文件的主场景）：启动到图库、示例建图开图，零异常 —— */
{
  const e0 = await evalJs(`document.getElementById('err')?.textContent || ''`);
  if (e0) errors.push("#err 非空（http 段）：" + e0);
}
await send("Page.navigate", { url: pathToFileURL(path.join(DIST, "index.html")).href + `?b=${Math.random().toString(36).slice(2)}` });
await until("file:// 启动落到图库", `!!document.querySelector('#home .hm-actions')`);
await evalJs(`document.querySelector('#home .hm-actions button[title^="以内置示例"]').click()`);
await until("file:// 示例建图并打开", `(t => t && t !== '—')(document.getElementById('crumbName')?.textContent) && (c => c && c.width > 0)(document.getElementById('map'))`);

const err = await evalJs(`document.getElementById('err')?.textContent || ''`);
if (err) errors.push("#err 非空：" + err);
if (errors.length) { console.error("✗ e2e 冒烟失败：\n  " + errors.join("\n  ")); process.exit(1); }
console.log("✓ e2e 冒烟：启动→图库→示例建图→开图渲染、推演底图逐格一致（GL/CPU）、CPU 连笔补画＝整幅重画、WebGL 丢失后恢复、嵌套坏档不崩、只读链接→写入门→接管、导出的只读网页能开、file:// 冷启动，零错误" + glNote + (dialogs.length ? `（对话框 ${dialogs.length} 个：${dialogs.map(t => t.split("\n")[0]).join(" / ")}）` : ""));
process.exit(0);
