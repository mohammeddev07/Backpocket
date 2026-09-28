import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { isUuid } from './ids';
import { openLocalDb } from './localStore';
import {
  convertV1, ICONS_KEY, LOCAL_SCHEMA_VERSION, migrateFromV1, THEME_KEY, upgradeLocalDb, upgradeSnapshot,
  V1_BACKUP_KEY, V1_KEY, type V1Data,
} from './migrate';

const NOW = 1_760_000_000_000;

const v1Sample: V1Data = {
  schemaVersion: 1,
  folders: [
    { id: 'root', name: 'All saves', parentId: null, color: '#c9cdd6' },
    { id: 'f-job', name: 'Job', parentId: 'root', color: '#f2b8c6' },
    { id: 'f-int', name: 'Interview', parentId: 'f-job', color: '#bcd9b0' },
    { id: 'f-nocolor', name: 'Plain', parentId: 'root' },
  ],
  links: [
    { id: 'l1', url: 'https://www.instagram.com/reel/abc/', folderId: 'f-int', platform: 'Instagram', icon: 'IG', note: 'Mock interview tips', tags: ['career'], savedAt: 1_700_000_000_000 },
    { id: 'l2', url: 'https://vm.tiktok.com/ZM1/', folderId: 'root', platform: null, icon: null, note: null, tags: null, savedAt: 1_700_000_100_000 },
    { id: 'l3', url: 'https://example.com/x', folderId: 'f-job' },
  ],
};

let dbCounter = 0;
const freshDb = () => openLocalDb('test-' + ++dbCounter);

describe('convertV1', () => {
  it('keeps every folder and link with their ids, parents and order', () => {
    const s = convertV1(v1Sample, NOW);
    expect(s.folders.map((f) => [f.id, f.parentId, f.name, f.position])).toEqual([
      ['root', null, 'All saves', 0],
      ['f-job', 'root', 'Job', 1],
      ['f-int', 'f-job', 'Interview', 2],
      ['f-nocolor', 'root', 'Plain', 3],
    ]);
    expect(s.links.map((l) => l.id)).toEqual(['l1', 'l2', 'l3']);
    expect(s.plans).toEqual([]);
  });

  it('maps v1 fields (note is the displayed title) and backfills like v1 did', () => {
    const s = convertV1(v1Sample, NOW);
    const [l1, l2, l3] = s.links;
    expect(l1).toMatchObject({
      url: 'https://www.instagram.com/reel/abc/', folderId: 'f-int', platform: 'Instagram',
      title: 'Mock interview tips', note: null, tags: ['career'], createdAt: 1_700_000_000_000,
      status: 'unread', openedAt: null, deletedAt: null,
    });
    expect(l2).toMatchObject({ platform: 'TikTok', title: null, tags: [] });
    expect(l3).toMatchObject({ platform: 'Link', createdAt: NOW });
    expect(s.folders.find((f) => f.id === 'f-nocolor')!.color).toBe('#f2b8c6');
    expect(s.folders.find((f) => f.id === 'root')!.isSystem).toBe(true);
  });

  it('adds the root folder when a v1 file is missing it', () => {
    const s = convertV1({ folders: [], links: [{ id: 'a', url: 'https://a.example', folderId: 'root' }] }, NOW);
    expect(s.folders).toHaveLength(1);
    expect(s.folders[0].id).toBe('root');
  });
});

describe('upgradeSnapshot v2 -> v3 (Inbox)', () => {
  const up = () => upgradeSnapshot(convertV1(v1Sample, NOW), 2, NOW);

  it('turns the root folder into the Inbox and lifts its subfolders to the top level', () => {
    const s = up();
    const inbox = s.folders.find((f) => f.isSystem)!;
    expect(inbox.name).toBe('Inbox');
    expect(inbox.parentId).toBeNull();
    expect(s.folders.filter((f) => f.isSystem)).toHaveLength(1);
    const job = s.folders.find((f) => f.name === 'Job')!;
    expect(job.parentId).toBeNull();
    expect(s.folders.find((f) => f.name === 'Interview')!.parentId).toBe(job.id);
  });

  it('keeps root-level links in the Inbox and every other link in its folder', () => {
    const s = up();
    const inbox = s.folders.find((f) => f.isSystem)!;
    const byUrl = (u: string) => s.links.find((l) => l.url === u)!;
    expect(byUrl('https://vm.tiktok.com/ZM1/').folderId).toBe(inbox.id);
    expect(byUrl('https://www.instagram.com/reel/abc/').folderId).toBe(s.folders.find((f) => f.name === 'Interview')!.id);
    expect(s.links).toHaveLength(3);
  });

  it('gives every folder and link a UUID', () => {
    const s = up();
    expect([...s.folders, ...s.links].every((r) => isUuid(r.id))).toBe(true);
  });

  it('repairs links whose folder is missing into the Inbox', () => {
    const s = upgradeSnapshot(convertV1({ ...v1Sample, links: [{ id: 'x', url: 'https://a.example', folderId: 'gone' }] }, NOW), 2, NOW);
    expect(s.links[0].folderId).toBe(s.folders.find((f) => f.isSystem)!.id);
  });

  it('upgradeLocalDb runs once after the v1 migration', async () => {
    localStorage.clear();
    localStorage.setItem(V1_KEY, JSON.stringify(v1Sample));
    const db = await freshDb();
    await migrateFromV1(localStorage, db, NOW);
    await upgradeLocalDb(db, NOW);
    const snap = await db.loadSnapshot();
    expect(snap.folders.find((f) => f.isSystem)!.name).toBe('Inbox');
    expect(await db.getMeta('schemaVersion')).toBe(LOCAL_SCHEMA_VERSION);
    await upgradeLocalDb(db, NOW + 1);
    expect((await db.loadSnapshot()).folders).toHaveLength(snap.folders.length);
  });
});

describe('migrateFromV1', () => {
  beforeEach(() => localStorage.clear());

  it('copies v1 data into IndexedDB and keeps a raw backup; v1 key untouched', async () => {
    const raw = JSON.stringify(v1Sample);
    localStorage.setItem(V1_KEY, raw);
    localStorage.setItem(THEME_KEY, 'dark');
    localStorage.setItem(ICONS_KEY, 'true');
    const db = await freshDb();

    expect(await migrateFromV1(localStorage, db, NOW)).toEqual({ status: 'migrated' });

    const snap = await db.loadSnapshot();
    expect(snap.links).toHaveLength(3);
    expect(snap.folders).toHaveLength(4);
    expect(localStorage.getItem(V1_BACKUP_KEY)).toBe(raw);
    expect(localStorage.getItem(V1_KEY)).toBe(raw);
    expect(await db.getMeta('v1Raw')).toBe(raw);
    expect(await db.getMeta('settings')).toMatchObject({ theme: 'dark', localIconsOnly: true });
  });

  it('runs only once and never overwrites an existing backup', async () => {
    localStorage.setItem(V1_KEY, JSON.stringify(v1Sample));
    localStorage.setItem(V1_BACKUP_KEY, 'older backup');
    const db = await freshDb();
    await migrateFromV1(localStorage, db, NOW);
    expect(localStorage.getItem(V1_BACKUP_KEY)).toBe('older backup');

    // A later v1 write (e.g. an old tab) doesn't re-import over v2 data.
    localStorage.setItem(V1_KEY, JSON.stringify({ folders: [], links: [] }));
    expect(await migrateFromV1(localStorage, db, NOW + 1)).toEqual({ status: 'already' });
    expect((await db.loadSnapshot()).links).toHaveLength(3);
  });

  it('starts fresh for new users', async () => {
    const db = await freshDb();
    expect(await migrateFromV1(localStorage, db, NOW)).toEqual({ status: 'fresh' });
    const snap = await db.loadSnapshot();
    expect(snap.folders.map((f) => f.id)).toEqual(['root']);
    expect(localStorage.getItem(V1_BACKUP_KEY)).toBeNull();
  });

  it('keeps corrupt v1 data as the backup and starts fresh with a warning', async () => {
    localStorage.setItem(V1_KEY, '{not json');
    const db = await freshDb();
    const r = await migrateFromV1(localStorage, db, NOW);
    expect(r.status).toBe('corrupt');
    expect(r.warning).toMatch(/corrupted/);
    expect(localStorage.getItem(V1_BACKUP_KEY)).toBe('{not json');
    expect((await db.loadSnapshot()).links).toHaveLength(0);
  });
});
