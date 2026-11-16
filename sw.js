const CACHE_NAME = 'reimbursement-ai-v3';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './gdrive.js',
  './xlsx.full.min.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // 對於 API 請求或外部資源（除了 Google Fonts 外），盡量優先使用網路
  if (event.request.url.includes('generativelanguage.googleapis.com') || event.request.url.includes('apis.google.com')) {
    return; // 不要快取 API 請求
  }

  // 主頁面與程式：有網路時一律抓最新版，離線才用快取（避免改版後手機還停在舊版）
  const u = new URL(event.request.url);
  if (event.request.method === 'GET' && u.origin === self.location.origin && (event.request.mode === 'navigate' || /\.(html|js)$/.test(u.pathname))) {
    event.respondWith(
      fetch(event.request).then((resp) => {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return resp;
      }).catch(() => caches.match(event.request).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        // 如果是有效回應且是 GET 請求，可以考慮動態加入快取
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic' || event.request.method !== 'GET') {
          return networkResponse;
        }
        
        // 複製一份回應，因為回應流只能被讀取一次
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        
        return networkResponse;
      }).catch(() => {
        // 離線且沒有快取時，若是導航請求，回傳 index.html
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
