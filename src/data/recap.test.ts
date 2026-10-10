import { describe, expect, it } from 'vitest';
import { recapDue, statsRecap, weekStats } from './recap';
import type { Folder, Link } from './types';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 10, 12);
const folder = (id: string, name: string, parentId: string | null = null): Folder =>
  ({ id, parentId, name, color: '#10B981', isSystem: id === 'inbox', position: 0, createdAt: 0, updatedAt: 0, deletedAt: null });
const link = (id: string, folderId: string, ageDays: number, extra: Partial<Link> = {}): Link => ({
  id, folderId, url: 'https://example.com/' + id, platform: 'Link', title: id, titleSource: null, note: null, sharedText: null,
  thumbnailUrl: null, tags: [], status: 'unread', openedAt: null, aiMeta: null, createdAt: NOW - ageDays * DAY, updatedAt: NOW, deletedAt: null, ...extra,
});
const folders = [folder('inbox', 'Inbox'), folder('r', 'Recipes'), folder('t', 'Travel'), folder('b', 'Breakfast', 'r')];

describe('weekStats', () => {
  it('counts only live links from the last 7 days and finds the busiest folders', () => {
    const s = weekStats([
      link('a', 'r', 1), link('b', 'r', 2), link('c', 'b', 3), link('d', 't', 4),
      link('old', 't', 9), link('gone', 't', 1, { deletedAt: NOW }), link('seen', 'r', 1, { openedAt: NOW }),
    ], folders, NOW);
    expect(s.count).toBe(5);
    expect(s.topFolders).toEqual(['Recipes', 'Travel']);
    expect(s.unopened.map((l) => l.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('statsRecap', () => {
  it('summarises the week and picks the oldest unopened first', () => {
    const r = statsRecap(weekStats([link('a', 'r', 1), link('b', 't', 2), link('c', 'r', 5)], folders, NOW));
    expect(r.summary).toBe('You saved 3 links this week, mostly in Recipes and Travel. 3 are still unopened.');
    expect(r.pickIds).toEqual(['c', 'b', 'a']);
  });

  it('praises a fully opened week', () => {
    const r = statsRecap(weekStats([link('a', 'r', 1, { openedAt: NOW })], folders, NOW));
    expect(r.summary).toBe('You saved 1 link this week, mostly in Recipes. You\'ve opened every one of them. Nice.');
    expect(r.pickIds).toEqual([]);
  });
});

describe('recapDue', () => {
  it('is due a week after the last cycle, never before the first one starts', () => {
    expect(recapDue(undefined, NOW)).toBe(false);
    expect(recapDue({ at: NOW - 6 * DAY }, NOW)).toBe(false);
    expect(recapDue({ at: NOW - 7 * DAY }, NOW)).toBe(true);
  });
});
