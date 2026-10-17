/// <reference lib="webworker" />
// Offline app-shell cache. Backpocket's data lives in IndexedDB (see
// src/data/localStore.ts), not here - this only lets the page itself load
// without a network connection after the first visit.
//
// Built by vite-plugin-pwa (injectManifest) to dist/sw.js - the same URL the
// v1 worker had, so existing registrations update in place. The plugin only
// fills in self.__WB_MANIFEST with the build's files; no Workbox runtime.

import {
  NUDGE_GAP_MS, NUDGE_HISTORY_KEY, NUDGE_META_KEY, NUDGE_NEXT_KEY, NUDGE_SYNC_TAG, nudgeCopy, nudgeNotification, pickForgotten, pushNudgeHistory,
  recentlyNudged, usablePrepared, type NudgeHistoryEntry, type PreparedNudge,
} from './data/nudge';
import { RECAP_EVERY_MS, RECAP_META_KEY, RECAP_MIN_LINKS, RECAP_NOTIFIED_KEY, recapDue, statsRecap, weekStats, type StoredRecap } from './data/recap';
import type { Folder, Link } from './data/types';
import { REVISIT_MIN_AGE_DAYS } from './search/filters';

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

// Long-lived runtime caches that survive app updates (not tied to a build).
const FONT_CACHE = 'backpocket-fonts-v1';
const THUMB_CACHE = 'backpocket-thumbs-v1';
const RUNTIME_CACHES = [FONT_CACHE, THUMB_CACHE];
const MAX_THUMBS = 400;

const isFontCss = (u: URL) => u.hostname === 'fonts.googleapis.com';
const isFontFile = (u: URL) => u.hostname === 'fonts.gstatic.com';
// YouTube and TikTok thumbnail CDNs (both send CORS headers). TikTok's URLs
// are signed and expire, so a cached copy keeps old cards looking right.
const isThumb = (u: URL) => u.hostname === 'i.ytimg.com' || /(^|\.)tiktokcdn(-[a-z]+)?\.com$/.test(u.hostname);

/** Keeps a runtime cache bounded (oldest entries first). */
async function trimCache(name: string, max: number): Promise<void> {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

/**
 * Cross-origin assets are cached only when the response is a real CORS
 * response (the page requests them with crossorigin="anonymous"). Opaque
 * responses are skipped: they can't be checked for errors and browsers pad
 * their storage cost by megabytes each.
 */
function cacheableCors(res: Response): boolean {
  return res.ok && res.type === 'cors';
}

function cacheFirst(req: Request, cacheName: string, onStore?: () => void): Promise<Response> {
  return caches.open(cacheName).then(async (cache) => {
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (cacheableCors(res)) { void cache.put(req, res.clone()).then(onStore); }
    return res;
  });
}

function staleWhileRevalidate(req: Request, cacheName: string): Promise<Response> {
  return caches.open(cacheName).then(async (cache) => {
    const hit = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (cacheableCors(res)) void cache.put(req, res.clone());
      return res;
    }).catch(() => hit || Response.error());
    return hit || network;
  });
}

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
    await Promise.all(names.filter((n) => n !== CACHE_NAME && !RUNTIME_CACHES.includes(n)).map((n) => caches.delete(n)));
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
    // Web fonts: the CSS may change (stale-while-revalidate); font files are
    // versioned and immutable (cache-first). Thumbnails: cache-first, bounded.
    if (req.mode === 'cors' && isFontCss(url)) { event.respondWith(staleWhileRevalidate(req, FONT_CACHE)); return; }
    if (req.mode === 'cors' && isFontFile(url)) { event.respondWith(cacheFirst(req, FONT_CACHE)); return; }
    if (req.mode === 'cors' && isThumb(url)) {
      event.respondWith(cacheFirst(req, THUMB_CACHE, () => void trimCache(THUMB_CACHE, MAX_THUMBS)));
      return;
    }
    // Everything else cross-origin (favicons, Supabase, Gemini, oEmbed) goes
    // straight to the network: API data must never be served stale from here.
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

// ---- "Forgotten save" reminders (opt-in, see src/ui/reminders.ts) ----
// Chromium wakes an installed app about once a day for this tag. The worker
// reads IndexedDB directly and only writes reminder bookkeeping (timestamps,
// history, the used-up prepared nudge): the page owns all link edits and sync.
// It prefers the nudge the page prepared (smart pick + AI text); once a week
// it sends the stats recap instead.

interface PeriodicSyncEvent extends ExtendableEvent { readonly tag: string }

function openExistingDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('backpocket');
    // Never create the app's database from here: an empty v1 DB would make
    // the page skip its own upgrade and lose its object stores.
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const read = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

async function nudgeInBackground(): Promise<void> {
  const db = await openExistingDb();
  try {
    const tx = db.transaction(['links', 'folders', 'meta']);
    const meta = tx.objectStore('meta');
    const [links, folders, settings, last, prepared, history, recap, recapNotified] = await Promise.all([
      read(tx.objectStore('links').getAll() as IDBRequest<Link[]>),
      read(tx.objectStore('folders').getAll() as IDBRequest<Folder[]>),
      read(meta.get('settings') as IDBRequest<{ remindersEnabled?: boolean } | undefined>),
      read(meta.get(NUDGE_META_KEY) as IDBRequest<number | undefined>),
      read(meta.get(NUDGE_NEXT_KEY) as IDBRequest<PreparedNudge | undefined>),
      read(meta.get(NUDGE_HISTORY_KEY) as IDBRequest<NudgeHistoryEntry[] | undefined>),
      read(meta.get(RECAP_META_KEY) as IDBRequest<StoredRecap | undefined>),
      read(meta.get(RECAP_NOTIFIED_KEY) as IDBRequest<number | undefined>),
    ]);
    const now = Date.now();
    if (!settings?.remindersEnabled || now - (last || 0) < NUDGE_GAP_MS) return;
    // Someone has the app open: the page shows its own in-app nudge instead.
    const windows = await self.clients.matchAll({ type: 'window' });
    if (windows.some((w) => w.visibilityState === 'visible')) return;

    // Weekly: the stats recap stands in for the day's nudge. The page shows
    // the full card (AI-written when AI is on) next time it's opened.
    if (recapDue(recap, now) && now - (recapNotified || 0) >= RECAP_EVERY_MS) {
      const stats = weekStats(links, folders.filter((f) => !f.deletedAt), now);
      if (stats.count >= RECAP_MIN_LINKS) {
        const { headline, summary } = statsRecap(stats);
        await self.registration.showNotification(headline, nudgeNotification(summary));
        const w = db.transaction('meta', 'readwrite').objectStore('meta');
        w.put(now, NUDGE_META_KEY);
        w.put(now, RECAP_NOTIFIED_KEY);
        return;
      }
    }

    let link: Link | undefined;
    let copy: { title: string; body: string };
    if (usablePrepared(prepared, links, now, REVISIT_MIN_AGE_DAYS)) {
      link = links.find((l) => l.id === prepared.linkId)!;
      copy = prepared;
    } else {
      link = pickForgotten(links, now, REVISIT_MIN_AGE_DAYS, recentlyNudged(history, now)) ?? undefined;
      if (!link) return;
      copy = nudgeCopy(link, now);
    }
    await self.registration.showNotification(copy.title, nudgeNotification(copy.body, link.url));
    const w = db.transaction('meta', 'readwrite').objectStore('meta');
    w.put(now, NUDGE_META_KEY);
    w.put(pushNudgeHistory(history, link.id, now), NUDGE_HISTORY_KEY);
    w.put(null, NUDGE_NEXT_KEY);
  } finally {
    db.close(); // waits for the pending write to finish
  }
}

self.addEventListener('periodicsync', (event) => {
  const e = event as PeriodicSyncEvent;
  if (e.tag === NUDGE_SYNC_TAG) e.waitUntil(nudgeInBackground().catch(() => {}));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'later') return;
  const url = (event.notification.data as { url?: string } | null)?.url;
  // ponytail: opens the saved link directly but doesn't mark it opened (the page
  // owns writes + sync), so it can be picked again; message open clients if that matters.
  event.waitUntil(self.clients.openWindow(url && /^https?:\/\//i.test(url) ? url : './'));
});
