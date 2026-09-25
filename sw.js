// Minimal offline app-shell cache. Backpocket's actual data lives in
// localStorage (see index.html), not here — this only lets the page itself
// load without a network connection after the first visit.
const CACHE_NAME = 'backpocket-shell-v2';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/favicon-16.png',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {}) // don't fail install over one missing/renamed asset
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    // Let cross-origin requests (Google Fonts, favicon lookups) go straight
    // to the network — caching opaque cross-origin responses here would risk
    // serving stale fonts/icons indefinitely.
    return;
  }

  // Share-sheet launches arrive as navigations to index.html?title=…&text=…&url=…
  // Key page navigations on the path alone so a share hits the cached shell
  // (works offline) instead of missing and storing one cache entry per share.
  const cacheKey = req.mode === 'navigate' && url.search
    ? url.origin + url.pathname
    : req;

  event.respondWith(
    caches.match(cacheKey).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy));
          }
          return res;
        })
        .catch(() => cached);
      // Cache-first for instant offline loads; a background refetch keeps
      // the cache from going stale on the next online visit.
      return cached || network;
    })
  );
});
