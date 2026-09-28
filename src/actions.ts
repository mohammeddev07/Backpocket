import { APP_CONFIG } from './config';
import { uid } from './data/ids';
import { COLORS, INBOX_COLOR, INBOX_NAME } from './data/migrate';
import { normalizeUrl } from './data/normalizeUrl';
import { fetchOembed, supportsOembed } from './data/oembed';
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
  void enrichLink(saved.id);
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

// ---- oEmbed title + thumbnail (YouTube, TikTok) ----
const enriching = new Set<string>();

/**
 * Looks up the oEmbed title/thumbnail for a link and caches them on it. The
 * title only fills an empty one - never what the user typed. An empty string
 * thumbnail marks "tried, nothing there" so it isn't retried every load.
 */
export async function enrichLink(id: string): Promise<void> {
  const link = store.link(id);
  if (!link || enriching.has(id) || !supportsOembed(link.platform) || link.thumbnailUrl != null) return;
  if (store.settings.localIconsOnly || !navigator.onLine) return;
  enriching.add(id);
  try {
    const info = await fetchOembed(link.url, link.platform, { timeoutMs: APP_CONFIG.oembedTimeoutMs });
    const cur = store.link(id);
    if (!cur) return;
    if (!info && !navigator.onLine) return; // went offline mid-call: retry later
    const patch: Partial<Link> = { thumbnailUrl: info?.thumbnailUrl || '' };
    if (info?.title && !cur.title) { patch.title = info.title; patch.titleSource = 'oembed'; }
    store.patch('links', id, patch);
  } finally {
    enriching.delete(id);
  }
}

/** Fills thumbnails for existing YouTube/TikTok links, a few at a time. */
export async function backfillThumbnails(): Promise<void> {
  const todo = store.liveLinks()
    .filter((l) => supportsOembed(l.platform) && l.thumbnailUrl == null)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, APP_CONFIG.oembedBackfillPerLoad);
  for (const l of todo) {
    if (store.settings.localIconsOnly || !navigator.onLine) return;
    await enrichLink(l.id);
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
