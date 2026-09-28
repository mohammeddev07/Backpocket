import { detectPlatform } from '../platform';
import type { LocalDb } from './localStore';
import { isUuid, uid } from './ids';
import { DEFAULT_SETTINGS, type Folder, type Link, type Settings, type Snapshot } from './types';

// ---- v1 (single-file app, localStorage) ----
export const V1_KEY = 'backpocket_data_v1';
export const V1_BACKUP_KEY = 'backpocket_data_v1_backup';
export const THEME_KEY = 'backpocket_theme';
export const ICONS_KEY = 'backpocket_local_icons_only';

export const V1_ROOT_ID = 'root';

// Soft, pastel folder-tag palette - decorative dots/swatches only.
export const COLORS = ['#f2b8c6', '#bcd9b0', '#c7c6ee', '#f7d59c', '#a9d8d1', '#e3b8dd'];

export interface V1Folder { id: string; name: string; parentId?: string | null; color?: string }
export interface V1Link {
  id: string; url: string; folderId?: string; platform?: string | null; icon?: string | null;
  note?: string | null; tags?: string[] | null; savedAt?: number;
}
export interface V1Data { folders: V1Folder[]; links: V1Link[]; schemaVersion?: number }

/**
 * Local IndexedDB data version. Bump and add a step to upgradeSnapshot for each change.
 *  2: v1 data copied into IndexedDB as-is (root "All saves" folder holds links).
 *  3: "All saves" becomes a view; root-level links move to a real Inbox folder;
 *     every id is a UUID (they double as Supabase primary keys).
 */
export const LOCAL_SCHEMA_VERSION = 3;
/** The version convertV1/freshSnapshot produce; upgradeSnapshot takes it from there. */
const V1_CONVERTED_VERSION = 2;
export const INBOX_NAME = 'Inbox';
export const INBOX_COLOR = '#c9cdd6';

export function isV1Data(x: unknown): x is V1Data {
  return !!x && typeof x === 'object' &&
    Array.isArray((x as V1Data).folders) && Array.isArray((x as V1Data).links);
}

export function freshSnapshot(now = Date.now()): Snapshot {
  return {
    folders: [{
      id: V1_ROOT_ID, parentId: null, name: 'All saves', color: '#c9cdd6', isSystem: true,
      position: 0, createdAt: now, updatedAt: now, deletedAt: null,
    }],
    links: [],
    plans: [],
  };
}

/** Empty library in the current layout: just an Inbox. */
export function freshInboxSnapshot(now = Date.now(), inboxId = uid()): Snapshot {
  return {
    folders: [{
      id: inboxId, parentId: null, name: INBOX_NAME, color: INBOX_COLOR, isSystem: true,
      position: 0, createdAt: now, updatedAt: now, deletedAt: null,
    }],
    links: [],
    plans: [],
  };
}

/**
 * v1 -> v2 rows. Applies v1's own load-time repairs first (root folder,
 * default colours, savedAt, platform) so the result matches what v1 showed.
 * v1's `note` was displayed as the card title, so it becomes `title`.
 */
export function convertV1(v1: V1Data, now = Date.now()): Snapshot {
  const v1Folders = v1.folders.filter((f) => f && typeof f.id === 'string');
  if (!v1Folders.some((f) => f.id === V1_ROOT_ID)) {
    v1Folders.unshift({ id: V1_ROOT_ID, name: 'All saves', parentId: null, color: '#c9cdd6' });
  }
  const folders: Folder[] = v1Folders.map((f, i) => ({
    id: f.id,
    parentId: f.id === V1_ROOT_ID ? null : (f.parentId ?? null),
    name: typeof f.name === 'string' ? f.name : 'Untitled',
    color: f.color || COLORS[0],
    isSystem: f.id === V1_ROOT_ID,
    position: i,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }));

  const links: Link[] = v1.links
    .filter((l) => l && typeof l.id === 'string' && typeof l.url === 'string')
    .map((l) => {
      const savedAt = typeof l.savedAt === 'number' && l.savedAt > 0 ? l.savedAt : now;
      return {
        id: l.id,
        folderId: l.folderId || V1_ROOT_ID,
        url: l.url,
        platform: (l.platform as Link['platform']) || detectPlatform(l.url),
        title: l.note || null,
        titleSource: l.note ? 'user' : null,
        note: null,
        sharedText: null,
        thumbnailUrl: null,
        tags: Array.isArray(l.tags) ? l.tags.filter((t): t is string => typeof t === 'string') : [],
        status: 'unread',
        openedAt: null,
        aiMeta: null,
        createdAt: savedAt,
        updatedAt: now,
        deletedAt: null,
      };
    });

  return { folders, links, plans: [] };
}

/** Upgrades local data written by an older build, one version step at a time. */
export function upgradeSnapshot(s: Snapshot, from: number, now = Date.now()): Snapshot {
  let out = s;
  if (from < 3) out = toInboxLayout(out, now);
  return out;
}

/**
 * v2 -> v3: the root "All saves" folder becomes the Inbox system folder (links
 * saved at the root stay there), its subfolders become top-level folders, and
 * any non-UUID id (v1's 'root' and its non-secure-context 'id-…' fallback)
 * gets a fresh UUID with every reference remapped. Links pointing at a
 * missing folder are repaired into the Inbox.
 */
function toInboxLayout(s: Snapshot, now: number): Snapshot {
  const folderIds = new Map<string, string>();
  const fid = (id: string) => {
    if (!folderIds.has(id)) folderIds.set(id, isUuid(id) ? id : uid());
    return folderIds.get(id)!;
  };
  let system = s.folders.find((f) => f.isSystem && f.deletedAt == null) || s.folders.find((f) => f.id === V1_ROOT_ID);
  const folders: Folder[] = s.folders.map((f) => ({ ...f, id: fid(f.id) }));
  if (!system) {
    const inbox: Folder = {
      id: uid(), parentId: null, name: INBOX_NAME, color: INBOX_COLOR, isSystem: true,
      position: 0, createdAt: now, updatedAt: now, deletedAt: null,
    };
    folders.unshift(inbox);
    system = inbox;
  }
  const oldSystemId = system.id;
  const inboxId = fid(oldSystemId);
  const live = new Set<string>();
  for (const f of folders) {
    if (f.id === inboxId) {
      Object.assign(f, { name: INBOX_NAME, parentId: null, isSystem: true, color: INBOX_COLOR, position: 0, updatedAt: now, deletedAt: null });
    } else {
      f.isSystem = false;
      if (f.parentId === oldSystemId || f.parentId == null) f.parentId = null;
      else f.parentId = fid(f.parentId);
      f.updatedAt = now;
    }
    if (f.deletedAt == null) live.add(f.id);
  }
  // Parents that no longer exist: lift the folder to the top level.
  for (const f of folders) if (f.parentId && !live.has(f.parentId)) f.parentId = null;

  const linkIds = new Map<string, string>();
  const links: Link[] = s.links.map((l) => {
    const id = isUuid(l.id) ? l.id : uid();
    linkIds.set(l.id, id);
    const folderId = folderIds.has(l.folderId) ? folderIds.get(l.folderId)! : l.folderId;
    return {
      ...l, id,
      folderId: live.has(folderId) ? folderId : inboxId,
      titleSource: l.titleSource ?? (l.title ? 'user' : null),
      updatedAt: now,
    };
  });
  const plans = s.plans.map((p) => ({
    ...p,
    folderId: folderIds.get(p.folderId) || p.folderId,
    items: p.items.map((it) => ({ ...it, linkIds: it.linkIds.map((x) => linkIds.get(x) || x) })),
  }));
  return { folders, links, plans };
}

/** Applies upgradeSnapshot to the stored data if it was written by an older build. */
export async function upgradeLocalDb(db: LocalDb, now = Date.now()): Promise<void> {
  const from = (await db.getMeta<number>('schemaVersion')) ?? LOCAL_SCHEMA_VERSION;
  if (from >= LOCAL_SCHEMA_VERSION) return;
  const upgraded = upgradeSnapshot(await db.loadSnapshot(), from, now);
  await db.replaceSnapshot(upgraded, { schemaVersion: LOCAL_SCHEMA_VERSION });
}

function readSettingsFromLocalStorage(ls: Storage): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  try {
    const theme = ls.getItem(THEME_KEY);
    if (theme === 'light' || theme === 'dark') settings.theme = theme;
    settings.localIconsOnly = ls.getItem(ICONS_KEY) === 'true';
  } catch { /* storage blocked - defaults */ }
  return settings;
}

export type MigrationStatus = 'already' | 'migrated' | 'fresh' | 'corrupt';
export interface MigrationResult { status: MigrationStatus; warning?: string }

/**
 * Runs once: copies v1 localStorage data (and theme/icon prefs) into the v2
 * IndexedDB store. The raw v1 JSON is kept under backpocket_data_v1_backup
 * (and in IndexedDB meta, in case localStorage is too full for a second copy).
 * The v1 key itself is left untouched.
 */
export async function migrateFromV1(ls: Storage | null, db: LocalDb, now = Date.now()): Promise<MigrationResult> {
  if (await db.getMeta('v1MigratedAt')) return { status: 'already' };

  let raw: string | null = null;
  try { raw = ls ? ls.getItem(V1_KEY) : null; } catch { raw = null; }
  const settings = ls ? readSettingsFromLocalStorage(ls) : { ...DEFAULT_SETTINGS };
  const meta: Record<string, unknown> = { v1MigratedAt: now, schemaVersion: V1_CONVERTED_VERSION, settings };

  if (raw === null) {
    await db.replaceSnapshot(freshSnapshot(now), meta);
    return { status: 'fresh' };
  }

  try {
    if (ls && ls.getItem(V1_BACKUP_KEY) === null) ls.setItem(V1_BACKUP_KEY, raw);
  } catch { /* quota - the IndexedDB copy below still exists */ }
  meta.v1Raw = raw;

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!isV1Data(parsed)) {
    await db.replaceSnapshot(freshSnapshot(now), meta);
    return {
      status: 'corrupt',
      warning: 'Your saved data looked corrupted, so we started fresh and kept a backup copy in storage. Use Import if you have an exported backup.',
    };
  }

  await db.replaceSnapshot(convertV1(parsed, now), meta);
  return { status: 'migrated' };
}
