import { describe, expect, it } from 'vitest';
import { buildQueue, currentStreak, dayKey, recordStreakDay } from './queue';
import type { Link } from './types';

const NOW = new Date(2026, 9, 16, 9, 0).getTime();
const DAY = 86_400_000;
const link = (id: string, p: Partial<Link> = {}): Link => ({
  id, folderId: 'inbox', url: 'https://example.com/' + id, platform: 'Link', title: null, titleSource: null, note: null,
  sharedText: null, thumbnailUrl: null, tags: [], status: 'unread', openedAt: null, aiMeta: null,
  createdAt: NOW, updatedAt: NOW, deletedAt: null, ...p,
});

describe('buildQueue', () => {
  const links = [
    link('old1', { createdAt: NOW - 30 * DAY }),
    link('old2', { createdAt: NOW - 20 * DAY }),
    link('new1', { createdAt: NOW - DAY }),
    link('seen', { createdAt: NOW - 40 * DAY, openedAt: NOW - DAY }),
    link('done', { createdAt: NOW - 50 * DAY, status: 'done' }),
    link('gone', { createdAt: NOW - 50 * DAY, deletedAt: NOW }),
  ];

  it('forgotten first, then unopened, then opened; never done or deleted', () => {
    const q = buildQueue(links, NOW, 7);
    expect(q.slice(0, 2).sort()).toEqual(['old1', 'old2']);
    expect(q.slice(2)).toEqual(['new1', 'seen']);
  });

  it('smart picks lead, and the size is capped', () => {
    expect(buildQueue(links, NOW, 7, ['seen', 'done'], 2)).toEqual(['seen', expect.stringMatching(/^old/)]);
  });

  it('is stable within a day', () => {
    const many = Array.from({ length: 20 }, (_, i) => link('l' + i, { createdAt: NOW - (10 + i) * DAY }));
    expect(buildQueue(many, NOW, 7)).toEqual(buildQueue(many, NOW + 3 * 3600_000, 7));
  });
});

describe('streak', () => {
  const today = dayKey(NOW);
  const yesterday = dayKey(NOW - DAY);

  it('counts consecutive days once each', () => {
    let s = recordStreakDay(undefined, yesterday);
    s = recordStreakDay(s, today);
    s = recordStreakDay(s, today);
    expect(s).toEqual({ last: today, count: 2 });
  });

  it('a missed day starts over', () => {
    expect(recordStreakDay({ last: dayKey(NOW - 3 * DAY), count: 9 }, today)).toEqual({ last: today, count: 1 });
  });

  it('is still alive until the end of the day after', () => {
    expect(currentStreak({ last: yesterday, count: 4 }, today)).toBe(4);
    expect(currentStreak({ last: dayKey(NOW - 2 * DAY), count: 4 }, today)).toBe(0);
    expect(currentStreak(undefined, today)).toBe(0);
  });
});
