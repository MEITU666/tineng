/* 体能系统 v4.1 Service Worker（零外部依赖，白名单内才缓存）
   策略：
   - 页面（导航 / index.html）：network-first，失败回退缓存
   - GitHub API（api.github.com）响应：network-first，失败回退缓存（v4.1 Gist 通道已移除）
   - icon.svg / manifest.json：cache-first
   白名单之外的请求一律不拦截、不缓存 */
const CACHE = 'tineng-cache-v6';
const ASSETS = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  const sameOrigin = url.origin === self.location.origin;
  const isIconManifest = sameOrigin && /\/(icon\.svg|manifest\.json)$/.test(url.pathname);
  const isPage = sameOrigin && (req.mode === 'navigate' || url.pathname.endsWith('/index.html'));
  const isWhitelistApi = url.hostname === 'api.github.com'; // v4.1：Gist 通道已移除（令牌直存本机）

  if (isIconManifest) { e.respondWith(cacheFirst(req)); return; }
  if (isPage || isWhitelistApi) { e.respondWith(networkFirst(req)); return; }
  /* 其余请求直接放行，交给浏览器默认行为 */
});

async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) c.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const c = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(req) || await c.match('./index.html');
    if (hit) return hit;
    return new Response(JSON.stringify({ offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
