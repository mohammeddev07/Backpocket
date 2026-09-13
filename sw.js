// Minimal offline app-shell cache. Backpocket's actual data lives in
// localStorage (see index.html), not here — this only lets the page itself
// load without a network connection after the first visit.
const CACHE_NAME = 'backpocket-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/favicon-16.png',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
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

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => cached);
      // Cache-first for instant offline loads; a background refetch keeps
      // the cache from going stale on the next online visit.
      return cached || network;
    })
  );
});
