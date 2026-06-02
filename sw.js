// 视频展台 - Service Worker (PWA 离线缓存)

const CACHE_NAME = 'chromecam-v1';

// 需要预缓存的静态资源
const PRECACHE_URLS = [
  'app.html',
  'app.js',
  'styles.css',
  'manifest.json',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png'
];

// 安装：预缓存静态资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    })
  );
  // 立即激活，不等待旧 Service Worker 关闭
  self.skipWaiting();
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  // 立即控制所有客户端
  self.clients.claim();
});

// 拦截网络请求：缓存优先，网络回退
self.addEventListener('fetch', (event) => {
  // 只缓存同源 GET 请求
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((response) => {
        // 只缓存有效响应
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return response;
      }).catch(() => {
        // 离线时返回 fallback
        return new Response('离线，无法加载资源', {
          status: 503,
          statusText: 'Service Unavailable'
        });
      });
    })
  );
});
