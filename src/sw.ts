/// <reference lib="webworker" />
// Offline app-shell cache. Backpocket's data lives in IndexedDB (see
// src/data/localStore.ts), not here - this only lets the page itself load
// without a network connection after the first visit.
//
// Built by vite-plugin-pwa (injectManifest) to dist/sw.js - the same URL the
// v1 worker had, so existing registrations update in place. The plugin only
// fills in self.__WB_MANIFEST with the build's files; no Workbox runtime.

export {};
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

const BUILD_FILES = self.__WB_MANIFEST;

function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// One cache per build: a deploy's new worker fills a fresh cache and activate
// deletes the previous one, so old hashed bundles don't pile up forever.
const CACHE_NAME = 'backpocket-shell-v5-' + hashString(JSON.stringify(BUILD_FILES));
const APP_SHELL = ['./', ...BUILD_FILES.map((e) => './' + e.url)];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // One by one, so a single missing/renamed file doesn't fail the install.
      // cache: 'reload' skips the HTTP cache so we never precache a stale page.
      Promise.allSettled(APP_SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })))),
    ).then(() => undefined),
  );
  void self.skipWaiting();
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
  void activated.then(async (upgradingFromV1) => {
    if (!upgradingFromV1) return;
    const windows = await self.clients.matchAll({ type: 'window' });
    windows.forEach((client) => { client.navigate(client.url).catch(() => {}); });
  });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    // Let cross-origin requests (Google Fonts, favicon lookups, Supabase,
    // Gemini) go straight to the network - caching opaque cross-origin
    // responses here would risk serving stale data indefinitely.
    return;
  }

  // Share-sheet launches arrive as navigations to index.html?title=…&text=…&url=…
  // Key page navigations on the path alone so a share hits the cached shell
  // (works offline) instead of missing and storing one cache entry per share.
  const cacheKey: RequestInfo = req.mode === 'navigate' && url.search
    ? url.origin + url.pathname
    : req;

  const putInCache = (res: Response) => {
    if (res.ok) {
      const copy = res.clone();
      void caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy));
    }
    return res;
  };

  // The page and the manifest are network-first, with the cache only as the
  // offline fallback. Serving them cache-first meant the first visit after a
  // deploy got the previous release's page - and its manifest - so installing
  // right then produced an app without the new share_target.
  if (req.mode === 'navigate' || url.pathname.endsWith('.webmanifest')) {
    event.respondWith(
      fetch(req)
        .then(putInCache)
        .catch(() => caches.match(cacheKey).then((cached) => cached || caches.match('./index.html'))
          .then((r) => r || Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(cacheKey).then((cached) => {
      const network = fetch(req)
        .then(putInCache)
        .catch(() => cached || Response.error());
      // Static assets (hashed bundles, icons) are cache-first for instant
      // loads; a background refetch keeps the cache from going stale.
      return cached || network;
    }),
  );
});
