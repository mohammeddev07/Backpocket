// Minimal offline app-shell cache. Backpocket's actual data lives in
// localStorage (see index.html), not here — this only lets the page itself
// load without a network connection after the first visit.
const CACHE_NAME = 'backpocket-shell-v3';
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
  const activated = (async () => {
    const names = await caches.keys();
    // The v1 worker served the page cache-first, so anyone upgrading from it
    // is looking at the old page right now: it links manifest.json (no
    // share_target) and has none of the new code, so it can't refresh itself.
    // Installing from it would create an app missing from the share sheet.
    // Once we control those windows, reload them to get the current page.
    // Later versions already link manifest.webmanifest, so their windows are
    // left alone (a reload there could drop a shared link mid-edit).
    const upgradingFromV1 = names.includes('backpocket-shell-v1');
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
    return upgradingFromV1;
  })();
  event.waitUntil(activated);
  // Reload outside waitUntil: the reload's own fetch is held until this worker
  // finishes activating, so waiting on it inside waitUntil deadlocks the page.
  activated.then(async (upgradingFromV1) => {
    if (!upgradingFromV1) return;
    const windows = await self.clients.matchAll({ type: 'window' });
    windows.forEach((client) => client.navigate(client.url).catch(() => {}));
  });
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

  const putInCache = (res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy));
    }
    return res;
  };

  // The page and the manifest are network-first, with the cache only as the
  // offline fallback. Serving them cache-first meant the first visit after a
  // deploy got the previous release's page — and its manifest — so installing
  // right then produced an app without the new share_target.
  if (req.mode === 'navigate' || url.pathname.endsWith('.webmanifest')) {
    event.respondWith(
      fetch(req)
        .then(putInCache)
        .catch(() => caches.match(cacheKey).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(cacheKey).then((cached) => {
      const network = fetch(req)
        .then(putInCache)
        .catch(() => cached);
      // Static assets (icons) are cache-first for instant loads; a background
      // refetch keeps the cache from going stale on the next online visit.
      return cached || network;
    })
  );
});
