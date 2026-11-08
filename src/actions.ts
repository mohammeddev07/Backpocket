import { APP_CONFIG } from './config';
import { uid } from './data/ids';
import { FOLDER_COLORS as COLORS, INBOX_COLOR, INBOX_NAME } from './data/migrate';
import { normalizeUrl } from './data/normalizeUrl';
import { fetchOembed, supportsOembed } from './data/oembed';
import {
  currentQuota, fetchMicrolink, isExpiringThumb, PREVIEW_QUOTA_KEY, quotaAllows, quotaBlock, quotaSpend, usesMicrolink, type PreviewInfo,
} from './data/preview';
import { store } from './data/store';
import { childrenOf, descendantIds } from './data/tree';
import type { Folder, Link, LinkStatus } from './data/types';
import { detectPlatform } from './platform';

// Data operations shared by the UI modules. Each one writes through the store
// (which persists, queues for sync and triggers a re-render).

/** The Inbox system folder (created if something removed it). */
export function inbox(): Folder {
  const f = store.liveFolders().find((x) => x.isSystem);
  if (f) return f;
  const now = Date.now();
  return store.write('folders', [{
    id: uid(), parentId: null, name: INBOX_NAME, color: INBOX_COLOR, isSystem: true,
    position: 0, createdAt: now, updatedAt: now, deletedAt: null,
  }])[0];
}
export function inboxId(): string { return inbox().id; }

export interface NewLinkInput {
  url: string;
  folderId: string;
  title?: string | null;
  note?: string | null;
  tags?: string[];
  sharedText?: string | null;
}

export function createLink(input: NewLinkInput): Link {
  const now = Date.now();
  const link: Link = {
    id: uid(),
    folderId: store.folder(input.folderId) ? input.folderId : inboxId(),
    url: input.url,
    platform: detectPlatform(input.url),
    title: input.title || null,
    titleSource: input.title ? 'user' : null,
    note: input.note || null,
    sharedText: input.sharedText || null,
    thumbnailUrl: null,
    tags: input.tags || [],
    status: 'unread',
    openedAt: null,
    aiMeta: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const saved = store.write('links', [link])[0];
  void enrichLink(saved.id).then(() => describeVideo(saved.id));
  return saved;
}

/** An existing live link with the same normalized URL, if any. */
export function findDuplicate(url: string): Link | undefined {
  const key = normalizeUrl(url);
  return store.liveLinks().find((l) => normalizeUrl(l.url) === key);
}

export function deleteLinks(ids: string[]): string[] {
  const live = ids.filter((id) => store.link(id));
  store.softDelete('links', live);
  return live;
}

export function restoreLinks(ids: string[]): void {
  store.restore('links', ids);
}

export function moveLinks(ids: string[], folderId: string): void {
  const rows = ids.map((id) => store.link(id)).filter((l): l is Link => !!l && l.folderId !== folderId);
  store.write('links', rows.map((l) => ({ ...l, folderId })));
}

export function markOpened(id: string): void {
  store.patch('links', id, { openedAt: Date.now() });
}

export function setStatus(ids: string[], status: LinkStatus): void {
  const rows = ids.map((id) => store.link(id)).filter((l): l is Link => !!l && l.status !== status);
  store.write('links', rows.map((l) => ({ ...l, status })));
}

export function setFavorite(ids: string[], favorite: boolean): void {
  const rows = ids.map((id) => store.link(id)).filter((l): l is Link => !!l && !!l.favorite !== favorite);
  store.write('links', rows.map((l) => ({ ...l, favorite })));
}

// ---- Previews: title, description and thumbnail ----
// YouTube/TikTok use their own oEmbed (free, no quota). Everything else asks
// Microlink's free keyless API, which allows about 25 calls a day per IP; we
// spend at most previewDailyBudget of them and stop for the day on a 429.
// Results are cached three ways so a link is looked up once: on the link row
// itself (which syncs, so other devices reuse it), for this session by URL
// (the save box's lookup is reused by the save), and from any other saved
// link with the same URL.
const enriching = new Set<string>();
const previewMemo = new Map<string, Promise<PreviewInfo | null | undefined>>();
let quotaChain: Promise<unknown> = Promise.resolve();

export function previewsOff(): boolean {
  return store.settings.localIconsOnly || APP_CONFIG.previewProvider === 'off' || !navigator.onLine;
}

/** Reserves one Microlink call, leaving `reserve` of today's budget unused. */
function takeMicrolinkCall(reserve: number): Promise<boolean> {
  const run = quotaChain.then(async () => {
    const now = Date.now();
    const q = currentQuota(await store.db.getMeta(PREVIEW_QUOTA_KEY), now);
    if (!quotaAllows(q, now, APP_CONFIG.previewDailyBudget - reserve)) return false;
    await store.db.setMeta(PREVIEW_QUOTA_KEY, quotaSpend(q));
    return true;
  });
  const safe = run.catch(() => false);
  quotaChain = safe;
  return safe;
}

function blockMicrolinkForToday(): void {
  quotaChain = quotaChain.then(async () => {
    const now = Date.now();
    await store.db.setMeta(PREVIEW_QUOTA_KEY, quotaBlock(currentQuota(await store.db.getMeta(PREVIEW_QUOTA_KEY), now), now));
  }).catch(() => {});
}

/**
 * Microlink preview for a URL. null = Microlink had nothing useful; undefined =
 * we didn't get to ask (budget used up, offline, error), so try again later.
 */
export function lookupMicrolink(url: string, opts: { background?: boolean } = {}): Promise<PreviewInfo | null | undefined> {
  const key = normalizeUrl(url);
  const memo = previewMemo.get(key);
  if (memo) return memo;
  const run = (async () => {
    if (previewsOff()) return undefined;
    if (!(await takeMicrolinkCall(opts.background ? APP_CONFIG.previewBackfillReserve : 0))) return undefined;
    const r = await fetchMicrolink(url, { timeoutMs: APP_CONFIG.previewTimeoutMs });
    if (r.rateLimited) blockMicrolinkForToday();
    return r.rateLimited || r.failed ? undefined : r.info;
  })();
  previewMemo.set(key, run);
  // Only keep answers; a skipped or failed lookup may be retried.
  void run.then((v) => { if (v === undefined && previewMemo.get(key) === run) previewMemo.delete(key); });
  return run;
}

/** Preview for a URL that isn't saved yet (the save box). Microlink answers are reused by the save. */
export async function previewForUrl(url: string, platform: Link['platform']): Promise<PreviewInfo | null> {
  if (previewsOff()) return null;
  if (supportsOembed(platform)) {
    const info = await fetchOembed(url, platform, { timeoutMs: APP_CONFIG.oembedTimeoutMs });
    return info && { ...info, description: null };
  }
  return usesMicrolink(platform) ? (await lookupMicrolink(url)) ?? null : null;
}

/** Another saved link with the same URL that already has its preview. */
function previewFromTwin(link: Link): PreviewInfo | null {
  const key = normalizeUrl(link.url);
  const twin = store.liveLinks().find((l) => l.id !== link.id && l.thumbnailUrl != null && normalizeUrl(l.url) === key);
  if (!twin) return null;
  return {
    title: twin.titleSource === 'oembed' ? twin.title : null,
    description: twin.description ?? null,
    thumbnailUrl: twin.thumbnailUrl,
  };
}

async function fetchPreviewFor(link: Link, opts: { background?: boolean; fresh?: boolean }): Promise<PreviewInfo | null | undefined> {
  if (!opts.fresh) {
    const twin = previewFromTwin(link);
    if (twin) return twin;
  }
  if (supportsOembed(link.platform)) {
    const info = await fetchOembed(link.url, link.platform, { timeoutMs: APP_CONFIG.oembedTimeoutMs });
    if (!info && !navigator.onLine) return undefined; // went offline mid-call: retry later
    return info ? { ...info, description: null } : null;
  }
  if (!usesMicrolink(link.platform)) return null;
  return lookupMicrolink(link.url, opts);
}

/**
 * Looks up a link's preview and caches it on the link. The title only fills an
 * empty one, never what the user typed. An empty-string thumbnail marks "tried,
 * nothing there" so it isn't retried every load. `fresh` re-asks even if a
 * thumbnail is stored (Instagram/Facebook image links expire).
 */
export async function enrichLink(id: string, opts: { background?: boolean; fresh?: boolean } = {}): Promise<void> {
  const link = store.link(id);
  if (!link || enriching.has(id) || (link.thumbnailUrl != null && !opts.fresh) || previewsOff()) return;
  enriching.add(id);
  try {
    const info = await fetchPreviewFor(link, opts);
    const cur = store.link(id);
    if (!cur || info === undefined) return;
    const patch: Partial<Link> = {};
    const thumb = info?.thumbnailUrl || '';
    if (cur.thumbnailUrl !== thumb) patch.thumbnailUrl = thumb;
    if (info?.title && !cur.title) { patch.title = info.title; patch.titleSource = 'oembed'; }
    if (info?.description && !cur.description) patch.description = info.description;
    if (Object.keys(patch).length) store.patch('links', id, patch);
  } finally {
    enriching.delete(id);
  }
}

/**
 * YouTube's oEmbed has no description, which is what tells the AI what a
 * video is about. New YouTube saves ask Microlink for it while budget lasts.
 */
async function describeVideo(id: string): Promise<void> {
  const link = store.link(id);
  if (!APP_CONFIG.previewDescribeYouTube || !link || link.platform !== 'YouTube' || link.description) return;
  const info = await lookupMicrolink(link.url, { background: true });
  const cur = store.link(id);
  if (cur && info?.description && !cur.description) store.patch('links', id, { description: info.description });
}

const refreshed = new Set<string>();
/** A stored Instagram/Facebook image stopped loading: ask for a fresh link, once per session. */
export function refreshThumbnail(id: string): void {
  const link = store.link(id);
  if (!link?.thumbnailUrl || !isExpiringThumb(link.thumbnailUrl) || refreshed.has(id)) return;
  refreshed.add(id);
  void enrichLink(id, { background: true, fresh: true });
}

/** Fills previews for existing links, a few at a time, newest first. */
export async function backfillThumbnails(): Promise<void> {
  const missing = store.liveLinks().filter((l) => l.thumbnailUrl == null).sort((a, b) => b.createdAt - a.createdAt);
  const todo = [
    ...missing.filter((l) => supportsOembed(l.platform)).slice(0, APP_CONFIG.oembedBackfillPerLoad),
    ...missing.filter((l) => usesMicrolink(l.platform)).slice(0, APP_CONFIG.previewBackfillPerLoad),
  ];
  for (const l of todo) {
    if (previewsOff()) return;
    await enrichLink(l.id, { background: true });
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ---- Folders ----
function nextPosition(parentId: string | null): number {
  const sibs = childrenOf(store.liveFolders(), parentId);
  return sibs.length ? Math.max(...sibs.map((f) => f.position)) + 1 : 0;
}

export function createFolder(name: string, color: string, parentId: string | null): Folder {
  const now = Date.now();
  const folder: Folder = {
    id: uid(), parentId, name, color: color || COLORS[0], isSystem: false,
    position: nextPosition(parentId), createdAt: now, updatedAt: now, deletedAt: null,
  };
  return store.write('folders', [folder])[0];
}

/** Finds or creates a folder path like "Job › Interview" (used by AI suggestions). */
export function ensureFolderPath(path: string): Folder {
  const parts = path.split(/\s*[›>/]\s*/).map((p) => p.trim()).filter(Boolean);
  let parentId: string | null = null;
  let folder: Folder | undefined;
  for (const name of parts) {
    folder = childrenOf(store.liveFolders(), parentId).find((f) => !f.isSystem && f.name.toLowerCase() === name.toLowerCase());
    if (!folder) folder = createFolder(name, COLORS[Math.floor(Math.random() * COLORS.length)], parentId);
    parentId = folder.id;
  }
  return folder || inbox();
}

export function updateFolder(id: string, patch: { name?: string; color?: string; parentId?: string | null }): void {
  const f = store.folder(id);
  if (!f) return;
  const next: Folder = { ...f, ...patch };
  if (f.isSystem) { next.parentId = null; next.name = f.name; }
  if (patch.parentId !== undefined && patch.parentId !== f.parentId) next.position = nextPosition(patch.parentId);
  store.write('folders', [next]);
}

export function moveFolder(id: string, parentId: string | null): void {
  updateFolder(id, { parentId });
}

/** Soft-deletes a folder, its subfolders and every link inside them. */
export function deleteFolderRecursive(id: string): string[] {
  const ids = [id, ...descendantIds(store.liveFolders(), id)];
  const linkIds = store.liveLinks().filter((l) => ids.includes(l.folderId)).map((l) => l.id);
  const planIds = store.livePlans().filter((p) => ids.includes(p.folderId)).map((p) => p.id);
  store.softDelete('links', linkIds);
  store.softDelete('plans', planIds);
  store.softDelete('folders', ids);
  return ids;
}

function renumber(list: Folder[]): void {
  store.write('folders', list.map((f, i) => ({ ...f, position: i })).filter((f, i) => list[i].position !== f.position));
}

export function moveFolderUpDown(id: string, dir: -1 | 1): void {
  const f = store.folder(id);
  if (!f) return;
  const sibs = childrenOf(store.liveFolders(), f.parentId).filter((s) => !s.isSystem);
  const i = sibs.findIndex((s) => s.id === id);
  const j = i + dir;
  if (j < 0 || j >= sibs.length) return;
  [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
  renumber(sibs);
}

/** Drag-and-drop: place `draggedId` before/after `targetId`, as its sibling. */
export function reorderFolder(draggedId: string, targetId: string, where: 'before' | 'after'): void {
  const dragged = store.folder(draggedId);
  const target = store.folder(targetId);
  if (!dragged || !target || target.isSystem) return;
  const sibs = childrenOf(store.liveFolders(), target.parentId).filter((s) => s.id !== draggedId && !s.isSystem);
  const at = sibs.findIndex((s) => s.id === targetId) + (where === 'after' ? 1 : 0);
  sibs.splice(at, 0, { ...dragged, parentId: target.parentId, position: -1 });
  store.write('folders', sibs.map((s, i) => ({ ...s, position: i }))
    .filter((s) => s.id === draggedId || store.folder(s.id)!.position !== s.position));
}
