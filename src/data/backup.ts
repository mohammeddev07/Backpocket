import { detectPlatform } from '../platform';
import { isUuid, uid } from './ids';
import { COLORS, convertV1, isV1Data, V1_ROOT_ID } from './migrate';
import { childrenOf } from './tree';
import type { Folder, Link, Plan, Snapshot } from './types';
import { normalizeForCompare } from './urls';

// Backup & import: JSON backups (v2, plus v1 files from the old app) and the
// Netscape bookmarks HTML format every browser can export/import.

export const BACKUP_SCHEMA_VERSION = 2;

export interface BackupFile {
  app: 'backpocket';
  schemaVersion: number;
  exportedAt: string;
  folders: Folder[];
  links: Link[];
  plans: Plan[];
}

export function buildBackup(s: Snapshot, now = new Date()): BackupFile {
  return {
    app: 'backpocket',
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    folders: s.folders,
    links: s.links,
    plans: s.plans,
  };
}

export function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Netscape Bookmark File format. Links in the system folder go at the top
 * level; every other folder becomes a nested <H3> folder.
 */
export function buildBookmarksHtml(s: Snapshot, nowSec = Math.floor(Date.now() / 1000)): string {
  const system = s.folders.find((f) => f.isSystem);
  function renderLinks(folderId: string, indent: string): string {
    return s.links.filter((l) => l.folderId === folderId).map((l) =>
      indent + '<DT><A HREF="' + escapeHtml(l.url) + '" ADD_DATE="' + Math.floor(l.createdAt / 1000) + '">' +
      escapeHtml(l.title || l.url) + '</A>\n').join('');
  }
  function renderFolders(parentId: string | null, depth: number): string {
    const indent = '    '.repeat(depth);
    let html = '';
    for (const child of childrenOf(s.folders, parentId)) {
      if (child.isSystem) continue;
      html += indent + '<DT><H3 ADD_DATE="' + nowSec + '">' + escapeHtml(child.name) + '</H3>\n';
      html += indent + '<DL><p>\n' + renderLinks(child.id, indent + '    ') + renderFolders(child.id, depth + 1) + indent + '</DL><p>\n';
    }
    return html;
  }
  let out = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n';
  if (system) out += renderLinks(system.id, '    ') + renderFolders(system.id, 1);
  out += renderFolders(null, 1);
  out += '</DL><p>\n';
  return out;
}

/** Normalised import: `systemId` is the incoming folder that maps onto our Inbox/root. */
export interface ImportBundle {
  folders: Folder[];
  links: Link[];
  plans: Plan[];
  systemId: string;
}

// Bookmark HTML is old and browsers are lenient about how a folder's <DL>
// nests relative to its <DT><H3> header, so this checks both the "as a
// child" and "as a following sibling" shapes rather than assuming one.
export function parseBookmarksHtml(html: string, now = Date.now()): ImportBundle {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const systemId = uid();
  const folders: Folder[] = [mkFolder(systemId, 'Imported', null, true, 0, now)];
  const links: Link[] = [];

  function findChildDl(el: Element): Element | null {
    const child = el.querySelector(':scope > DL');
    if (child) return child;
    const sib = el.nextElementSibling;
    return sib && sib.tagName === 'DL' ? sib : null;
  }

  function walkDl(dl: Element | null, parentFolderId: string): void {
    if (!dl) return;
    Array.from(dl.children).filter((c) => c.tagName === 'DT').forEach((dt) => {
      const h3 = dt.querySelector(':scope > H3');
      const a = dt.querySelector(':scope > A');
      if (h3) {
        const id = uid();
        folders.push(mkFolder(id, (h3.textContent || 'Imported folder').trim(), parentFolderId, false, folders.length, now,
          COLORS[folders.length % COLORS.length]));
        walkDl(findChildDl(dt) || findChildDl(h3), id);
      } else if (a) {
        const href = a.getAttribute('href');
        if (href) {
          const addDate = a.getAttribute('add_date');
          links.push(mkLink({
            url: href, folderId: parentFolderId, title: (a.textContent || '').trim() || null,
            createdAt: addDate ? parseInt(addDate, 10) * 1000 : now,
          }, now));
        }
      }
    });
  }

  walkDl(doc.querySelector('DL'), systemId);
  return { folders, links, plans: [], systemId };
}

function mkFolder(id: string, name: string, parentId: string | null, isSystem: boolean, position: number, now: number, color = COLORS[0]): Folder {
  return { id, name, parentId, isSystem, position, color, createdAt: now, updatedAt: now, deletedAt: null };
}

function mkLink(p: { url: string; folderId: string; title: string | null; createdAt: number }, now: number): Link {
  return {
    id: uid(), folderId: p.folderId, url: p.url, platform: detectPlatform(p.url), title: p.title, note: null,
    sharedText: null, thumbnailUrl: null, tags: [], status: 'unread', openedAt: null, aiMeta: null,
    createdAt: p.createdAt || now, updatedAt: now, deletedAt: null,
  };
}

export function detectImportFormat(filename: string, text: string): 'json' | 'html' | null {
  if (/\.json$/i.test(filename)) return 'json';
  if (/\.html?$/i.test(filename)) return 'html';
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return 'json';
  if (trimmed.startsWith('<')) return 'html';
  return null;
}

function validateEntries(obj: { folders: unknown[]; links: unknown[] }): string | null {
  for (const f of obj.folders as Array<{ id?: unknown; name?: unknown }>) {
    if (!f || typeof f.id !== 'string' || typeof f.name !== 'string') return 'A folder entry is missing an id or name.';
  }
  for (const l of obj.links as Array<{ id?: unknown; url?: unknown }>) {
    if (!l || typeof l.id !== 'string' || typeof l.url !== 'string') return 'A link entry is missing an id or url.';
  }
  return null;
}

/** Parses a .json backup (v1 or v2). */
export function parseBackupJson(text: string, now = Date.now()): { bundle: ImportBundle } | { error: string } {
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return { error: 'That file is not valid JSON.' }; }
  if (!obj || typeof obj !== 'object') return { error: 'Not a valid JSON object.' };
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.folders)) return { error: 'Missing or invalid "folders" list.' };
  if (!Array.isArray(o.links)) return { error: 'Missing or invalid "links" list.' };
  const entryError = validateEntries(o as { folders: unknown[]; links: unknown[] });
  if (entryError) return { error: entryError };

  if (typeof o.schemaVersion === 'number' && o.schemaVersion >= 2) {
    const folders = (o.folders as Folder[]).filter((f) => f.deletedAt == null).map((f, i) => ({
      ...mkFolder(f.id, f.name, f.parentId ?? null, !!f.isSystem, typeof f.position === 'number' ? f.position : i, now, f.color || COLORS[0]),
      createdAt: f.createdAt || now,
    }));
    let system = folders.find((f) => f.isSystem);
    if (!system) {
      system = mkFolder(uid(), 'Imported', null, true, 0, now);
      folders.unshift(system);
    }
    const systemId = system.id;
    const links = (o.links as Link[]).filter((l) => l.deletedAt == null).map((l) => ({
      ...mkLink({ url: l.url, folderId: l.folderId || systemId, title: l.title ?? null, createdAt: l.createdAt || now }, now),
      id: l.id, note: l.note ?? null, sharedText: l.sharedText ?? null, thumbnailUrl: l.thumbnailUrl ?? null,
      tags: Array.isArray(l.tags) ? l.tags : [], status: l.status === 'done' ? 'done' as const : 'unread' as const,
      openedAt: l.openedAt ?? null, platform: l.platform || detectPlatform(l.url),
    }));
    const plans = Array.isArray(o.plans)
      ? (o.plans as Plan[]).filter((p) => p && typeof p.id === 'string' && Array.isArray(p.items) && p.deletedAt == null)
      : [];
    return { bundle: { folders, links, plans, systemId } };
  }

  if (!isV1Data(o)) return { error: 'Missing or invalid "folders" list.' };
  if (!o.folders.some((f) => f.id === V1_ROOT_ID)) return { error: 'Backup is missing the root "All saves" folder.' };
  const s = convertV1(o, now);
  return { bundle: { ...s, systemId: V1_ROOT_ID } };
}

export interface ImportTarget {
  /** Our system folder (Inbox / All saves): the incoming system folder maps onto it. */
  systemId: string;
  /** Where incoming top-level folders go (null = top level). */
  topParentId: string | null;
}

export interface MergeResult {
  folders: Folder[];
  links: Link[];
  plans: Plan[];
  addedFolders: number;
  addedLinks: number;
  skippedDup: number;
}

/**
 * Adds imported folders/links alongside what's already here. Folder ids that
 * collide with an existing one (or aren't UUIDs) are regenerated and every
 * reference remapped, so an import never overwrites an existing folder.
 * Links that exactly match an existing one (same folder, same normalized URL)
 * are skipped rather than duplicated.
 */
export function mergeImport(current: Snapshot, incoming: ImportBundle, target: ImportTarget, now = Date.now()): MergeResult {
  const existingIds = new Set(current.folders.map((f) => f.id));
  const idMap = new Map<string, string>([[incoming.systemId, target.systemId]]);
  const newFolders: Folder[] = [];
  for (const f of incoming.folders) {
    if (f.id === incoming.systemId) continue;
    const newId = existingIds.has(f.id) || !isUuid(f.id) || idMap.has(f.id) ? uid() : f.id;
    idMap.set(f.id, newId);
    newFolders.push({ ...f, id: newId, isSystem: false, createdAt: f.createdAt || now, updatedAt: now, deletedAt: null });
  }
  const topSiblings = current.folders.filter((f) => f.parentId === target.topParentId);
  let pos = topSiblings.length ? Math.max(...topSiblings.map((f) => f.position)) + 1 : 0;
  for (const nf of newFolders) {
    const mapped = nf.parentId ? idMap.get(nf.parentId) : undefined;
    if (mapped && mapped !== target.systemId) nf.parentId = mapped;
    else { nf.parentId = target.topParentId; nf.position = pos++; }
  }

  let addedLinks = 0, skippedDup = 0;
  const newLinks: Link[] = [];
  const linkIdMap = new Map<string, string>();
  const existingByKey = new Map(current.links.map((l) => [l.folderId + '\n' + normalizeForCompare(l.url), l.id]));
  for (const l of incoming.links) {
    const folderId = idMap.get(l.folderId) || target.systemId;
    const key = folderId + '\n' + normalizeForCompare(l.url);
    const existing = existingByKey.get(key);
    if (existing) { skippedDup++; linkIdMap.set(l.id, existing); continue; }
    const id = uid();
    existingByKey.set(key, id);
    linkIdMap.set(l.id, id);
    newLinks.push({ ...l, id, folderId, updatedAt: now, deletedAt: null });
    addedLinks++;
  }

  // Plans come along only when their folder did (not for the system folder).
  const plans: Plan[] = incoming.plans
    .filter((p) => idMap.has(p.folderId) && p.folderId !== incoming.systemId)
    .map((p) => ({
      ...p, id: uid(), folderId: idMap.get(p.folderId)!, updatedAt: now, deletedAt: null,
      items: p.items.map((it) => ({ ...it, linkIds: it.linkIds.map((x) => linkIdMap.get(x)).filter((x): x is string => !!x) })),
    }));

  return { folders: newFolders, links: newLinks, plans, addedFolders: newFolders.length, addedLinks, skippedDup };
}

/**
 * Rows to write for "Replace everything": every current row soft-deleted
 * (so the deletion syncs), then the incoming rows. The incoming system folder
 * maps onto ours; non-UUID ids get fresh UUIDs.
 */
export function replaceImport(current: Snapshot, incoming: ImportBundle, target: ImportTarget, now = Date.now()): Snapshot {
  const idMap = new Map<string, string>([[incoming.systemId, target.systemId]]);
  const fid = (id: string) => {
    if (!idMap.has(id)) idMap.set(id, isUuid(id) ? id : uid());
    return idMap.get(id)!;
  };
  const keepIds = new Set<string>();
  const folders: Folder[] = incoming.folders.filter((f) => f.id !== incoming.systemId).map((f) => {
    const id = fid(f.id);
    keepIds.add(id);
    const parent = f.parentId && f.parentId !== incoming.systemId ? fid(f.parentId) : target.topParentId;
    return { ...f, id, parentId: parent, isSystem: false, updatedAt: now, deletedAt: null };
  });
  const linkIdMap = new Map<string, string>();
  const links: Link[] = incoming.links.map((l) => {
    const id = isUuid(l.id) ? l.id : uid();
    linkIdMap.set(l.id, id);
    keepIds.add(id);
    return { ...l, id, folderId: fid(l.folderId), updatedAt: now, deletedAt: null };
  });
  const plans: Plan[] = incoming.plans.map((p) => {
    const id = isUuid(p.id) ? p.id : uid();
    keepIds.add(id);
    return {
      ...p, id, folderId: fid(p.folderId), updatedAt: now, deletedAt: null,
      items: p.items.map((it) => ({ ...it, linkIds: it.linkIds.map((x) => linkIdMap.get(x) || x) })),
    };
  });
  const gone = <T extends { id: string; deletedAt: number | null }>(rows: T[]) =>
    rows.filter((r) => !keepIds.has(r.id) && r.deletedAt == null).map((r) => ({ ...r, deletedAt: now, updatedAt: now }));
  return {
    folders: [...gone(current.folders.filter((f) => !f.isSystem)), ...folders],
    links: [...gone(current.links), ...links],
    plans: [...gone(current.plans), ...plans],
  };
}
