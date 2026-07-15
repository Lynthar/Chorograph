/* 舆图 Chorograph —— 极简离线 Service Worker。
   产物已内联为单个 index.html，故只需缓存应用外壳（index.html + manifest + icon）。
   文档走网络优先（在线取最新构建，断网回退缓存），其余同源资源缓存优先。
   仅由 main.ts 在 http(s) 生产部署下注册；file:// 与 dev 不注册（见 src/main.ts 末）。 */
const CACHE = "yutu-shell-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    // 文档：网络优先，成功则回填缓存，断网回退缓存的 index.html
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put("./index.html", copy));
        return res;
      }).catch(() => caches.match("./index.html").then(hit => hit || caches.match("./")))
    );
  } else {
    // manifest / icon 等：缓存优先，未命中走网络
    e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
  }
});
