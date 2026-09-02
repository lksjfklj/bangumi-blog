
/* 秘封俱乐部 Service Worker v1.1.0
 * 策略：页面导航网络优先（失败回退缓存），静态资源缓存优先（带 hash 已 immutable），/api 一律不缓存。
 * 新增：Web Push 通知展示 + 点击通知跳转。
 * 升级时修改 VERSION 并重新构建即可让旧缓存整体失效。 */
const VERSION = 'v1.1.0';
const CACHE_NAME = 'bangumi-blog-' + VERSION;
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(PRECACHE)).catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域请求（图片代理等）不拦截
  if (url.pathname.startsWith('/api/')) return; // 动态接口永远走网络

  // 页面导航：网络优先，离线时回退缓存的 index.html
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        if (!res.ok) return res;
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put('/index.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 静态资源：缓存优先，未命中时网络并写入缓存（只缓存可哈希的资产）
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/img/'))) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match('/index.html')))
  );
});

// ---------- Web Push 通知 ----------
self.addEventListener('push', (e) => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; } catch (err) { /* 非 JSON 则忽略 */ }
  const title = payload.title || '秘封俱乐部';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icons/icon-192.png',
    badge: payload.badge || '/icons/icon-192.png',
    data: { url: payload.url || '/collection' },
    tag: payload.tag || ('update-' + (payload.url || '')),
    renotify: false
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) { client.navigate(url); return client.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});
