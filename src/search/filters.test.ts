import { describe, expect, it } from 'vitest';
import type { Folder, Link } from '../data/types';
import { activeFilterCount, DEFAULT_FILTERS, keywordMatch, selectLinks, shuffle, type ListQuery } from './filters';

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;
const folder = (id: string, name: string, parentId: string | null = null): Folder => ({
  id, name, parentId, color: '#fff', isSystem: id === 'inbox', position: 0, createdAt: 0, updatedAt: 0, deletedAt: null,
});
const link = (id: string, p: Partial<Link> = {}): Link => ({
  id, folderId: 'inbox', url: 'https://example.com/' + id, platform: 'Link', title: null, titleSource: null, note: null,
  sharedText: null, thumbnailUrl: null, tags: [], status: 'unread', openedAt: null, aiMeta: null,
  createdAt: NOW, updatedAt: NOW, deletedAt: null, ...p,
});

const folders = [folder('inbox', 'Inbox'), folder('job', 'Job'), folder('int', 'Interview', 'job')];
const links = [
  link('a', { folderId: 'int', title: 'Mock interview answers', tags: ['career'], platform: 'Instagram', createdAt: NOW - 3 * DAY }),
  link('b', { folderId: 'job', title: 'Resume tips', platform: 'YouTube', createdAt: NOW - 20 * DAY, openedAt: NOW - DAY }),
  link('c', { title: 'Chess opening trap', sharedText: 'the sicilian #chess', platform: 'TikTok', createdAt: NOW - 30 * DAY }),
  link('d', { title: 'Done thing', status: 'done', createdAt: NOW - 40 * DAY }),
];
const q = (p: Partial<ListQuery> = {}): ListQuery => ({
  mode: 'all', folderId: 'inbox', query: '', filters: { ...DEFAULT_FILTERS }, shuffleSeed: 0, now: NOW, revisitMinAgeDays: 7, ...p,
});
const ids = (ls: Link[]) => ls.map((l) => l.id);

describe('selectLinks', () => {
  it('All saves shows everything, newest first', () => {
    expect(ids(selectLinks(links, folders, q()))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a folder view shows only that folder unless scope is all', () => {
    expect(ids(selectLinks(links, folders, q({ mode: 'folder', folderId: 'job' })))).toEqual(['b']);
    expect(ids(selectLinks(links, folders, q({ mode: 'folder', folderId: 'job', filters: { ...DEFAULT_FILTERS, scope: 'all' } })))).toHaveLength(4);
  });

  it('Revisit shows old, unopened, unfinished links, oldest first', () => {
    expect(ids(selectLinks(links, folders, q({ mode: 'revisit' })))).toEqual(['c']);
  });

  it('keyword search covers title, caption, tags and folder path (all terms)', () => {
    expect(ids(selectLinks(links, folders, q({ query: 'sicilian' })))).toEqual(['c']);
    expect(ids(selectLinks(links, folders, q({ query: 'job interview' })))).toEqual(['a']);
    expect(ids(selectLinks(links, folders, q({ query: '#career' })))).toEqual(['a']);
    expect(ids(selectLinks(links, folders, q({ query: 'nothing-matches' })))).toEqual([]);
  });

  it('applies platform, tag, status and date filters', () => {
    const f = (p: Partial<typeof DEFAULT_FILTERS>) => q({ filters: { ...DEFAULT_FILTERS, ...p } });
    expect(ids(selectLinks(links, folders, f({ platform: 'TikTok' })))).toEqual(['c']);
    expect(ids(selectLinks(links, folders, f({ tags: ['career'] })))).toEqual(['a']);
    expect(ids(selectLinks(links, folders, f({ status: 'done' })))).toEqual(['d']);
    expect(ids(selectLinks(links, folders, f({ sort: 'oldest' })))).toEqual(['d', 'c', 'b', 'a']);
  });

  it('shuffle is deterministic per seed and keeps every item', () => {
    const a = shuffle([1, 2, 3, 4, 5, 6], 42);
    expect(shuffle([1, 2, 3, 4, 5, 6], 42)).toEqual(a);
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('helpers', () => {
  it('counts active filters', () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...DEFAULT_FILTERS, platform: 'X', tags: ['a', 'b'], status: 'done' })).toBe(4);
  });
  it('keywordMatch with empty query matches', () => {
    expect(keywordMatch(links[0], '', '  ')).toBe(true);
  });
});
