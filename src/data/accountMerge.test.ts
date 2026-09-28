import { describe, expect, it } from 'vitest';
import { mergeGuestIntoAccount } from './accountMerge';
import type { Folder, Link, Snapshot } from './types';

const NOW = 1_760_000_000_000;
const USER = '99999999-9999-4999-8999-999999999999';
const f = (id: string, name: string, parentId: string | null = null, isSystem = false): Folder => ({
  id, name, parentId, isSystem, color: '#fff', position: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
});
const l = (id: string, url: string, folderId: string): Link => ({
  id, folderId, url, platform: 'Link', title: null, titleSource: null, note: null, sharedText: null, thumbnailUrl: null,
  tags: [], status: 'unread', openedAt: null, aiMeta: null, createdAt: 1, updatedAt: 1, deletedAt: null,
});
const snap = (p: Partial<Snapshot>): Snapshot => ({ folders: [], links: [], plans: [], ...p });

describe('mergeGuestIntoAccount', () => {
  const local = snap({
    folders: [f('li', 'Inbox', null, true), f('lj', 'Job'), f('lint', 'Interview', 'lj'), f('lr', 'Recipes')],
    links: [
      l('a', 'https://youtu.be/abc?si=1', 'li'),
      l('b', 'https://instagram.com/reel/x/?igsh=2', 'lint'),
      l('c', 'https://example.com/new', 'lr'),
    ],
  });
  const remote = snap({
    folders: [f(USER, 'Inbox', null, true), f('rj', 'job'), f('rint', 'INTERVIEW', 'rj')],
    links: [l('r1', 'https://www.youtube.com/watch?v=abc', USER)],
  });

  it('maps the Inbox, merges folders by path and skips duplicate URLs', () => {
    const out = mergeGuestIntoAccount(local, remote, USER, NOW);
    expect(out.skippedDuplicates).toBe(1);
    expect(out.addedLinks).toBe(2);
    expect(out.upload.folders.map((x) => x.name)).toEqual(['Recipes']);
    expect(out.upload.links.find((x) => x.id === 'b')!.folderId).toBe('rint');
    expect(out.upload.links.find((x) => x.id === 'c')!.folderId).toBe('lr');
    expect(out.merged.links).toHaveLength(3);
  });

  it('creates the account Inbox (id = user id) when the account is empty', () => {
    const out = mergeGuestIntoAccount(local, snap({}), USER, NOW);
    expect(out.upload.folders.find((x) => x.isSystem)!.id).toBe(USER);
    expect(out.upload.links.find((x) => x.id === 'a')!.folderId).toBe(USER);
    expect(out.upload.folders.find((x) => x.name === 'Interview')!.parentId).toBe('lj');
  });

  it('is idempotent: uploading the same guest data twice adds nothing', () => {
    const first = mergeGuestIntoAccount(local, remote, USER, NOW);
    const second = mergeGuestIntoAccount(local, first.merged, USER, NOW);
    expect(second.addedLinks).toBe(0);
    expect(second.upload.folders).toHaveLength(0);
  });

  it('ignores deleted local rows', () => {
    const out = mergeGuestIntoAccount(snap({ links: [{ ...l('d', 'https://x.example', 'li'), deletedAt: 5 }] }), remote, USER, NOW);
    expect(out.addedLinks).toBe(0);
  });
});
