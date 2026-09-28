import { uid } from './data/ids';
import { COLORS } from './data/migrate';
import { store } from './data/store';
import { childrenOf, descendantIds } from './data/tree';
import type { Folder, Link } from './data/types';
import { detectPlatform } from './platform';

// Data operations shared by the UI modules. Each one writes through the store
// (which persists, queues for sync and triggers a re-render).

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
    folderId: input.folderId,
    url: input.url,
    platform: detectPlatform(input.url),
    title: input.title || null,
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
  return store.write('links', [link])[0];
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

export function updateFolder(id: string, patch: { name?: string; color?: string; parentId?: string | null }): void {
  const f = store.folder(id);
  if (!f) return;
  const next: Folder = { ...f, ...patch };
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
  store.softDelete('links', linkIds);
  store.softDelete('folders', ids);
  return ids;
}

function renumber(list: Folder[]): void {
  store.write('folders', list.map((f, i) => ({ ...f, position: i })).filter((f, i) => list[i].position !== f.position || list[i].parentId !== f.parentId));
}

export function moveFolderUpDown(id: string, dir: -1 | 1): void {
  const f = store.folder(id);
  if (!f) return;
  const sibs = childrenOf(store.liveFolders(), f.parentId);
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
  if (!dragged || !target) return;
  const sibs = childrenOf(store.liveFolders(), target.parentId).filter((s) => s.id !== draggedId);
  const at = sibs.findIndex((s) => s.id === targetId) + (where === 'after' ? 1 : 0);
  const moved = { ...dragged, parentId: target.parentId, position: -1 };
  sibs.splice(at, 0, moved);
  store.write('folders', sibs.map((s, i) => ({ ...s, position: i }))
    .filter((s) => s.id === draggedId || store.folder(s.id)!.position !== s.position));
}
