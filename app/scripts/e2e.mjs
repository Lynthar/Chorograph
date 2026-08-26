/* 浏览器冒烟（node scripts/e2e.mjs，CI 与本地共用，零依赖）：
   起本地 HTTP 供 dist/ → 无头 Chrome/Edge 经 CDP 驱动，锁「boot 无声悬死」一类
   node:test 够不着的整链回归：启动到图库 → 「从内置示例新建」建图并打开（create→IDB→
   网格→首帧）→ 顶栏出图名；全程零未捕获异常、零 console.error、#err 空。
   不是视觉回归（不比像素）；先 npm run build 再跑。浏览器可用 E2E_BROWSER 指定。 */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const DIST = path.resolve(import.meta.dirname, "../dist");
const MIME = { ".html": "text/html; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".js": "text/javascript", ".json": "application/json" };
const DEADLINE = Date.now() + 90_000;
const fail = (msg) => { console.error("✗ e2e：" + msg); process.exit(1); };
if (!existsSync(path.join(DIST, "index.html"))) fail("dist/index.html 不存在——先 npm run build");

/* —— 静态服务（只认 dist 里真实存在的文件名，杜绝路径穿越）—— */
const server = createServer((req, res) => {
  const name = (req.url || "/").split("?")[0].replace(/^\/+/, "") || "index.html";
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
  "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--window-size=1280,800", "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
const cleanup = () => { try { br.kill(); } catch { /* 已退出 */ } server.close(); };
process.on("exit", cleanup);
const wsUrl = await new Promise((res, rej) => {
  let buf = "";
  br.stderr.on("data", d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
  br.on("exit", () => rej(new Error("浏览器未启动（" + bin + "）")));
  setTimeout(() => rej(new Error("等 DevTools 端口超时")), 20_000);
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
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon/.test(m.params.entry.url || ""))
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

const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
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
const err = await evalJs(`document.getElementById('err')?.textContent || ''`);
if (err) errors.push("#err 非空：" + err);
if (errors.length) { console.error("✗ e2e 冒烟失败：\n  " + errors.join("\n  ")); process.exit(1); }
console.log("✓ e2e 冒烟：启动→图库→示例建图→开图渲染，零错误");
process.exit(0);
