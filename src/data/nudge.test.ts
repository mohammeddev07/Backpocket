import { describe, expect, it } from 'vitest';
import { ALL_NUDGE_COPY, nudgeCopy, nudgeNotification, pickForgotten, pushNudgeHistory, recentlyNudged, usablePrepared } from './nudge';
import type { Link } from './types';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 9, 12);

function link(id: string, ageDays: number, extra: Partial<Link> = {}): Link {
  return {
    id, folderId: 'inbox', url: 'https://example.com/' + id, platform: 'Link', title: 'Title ' + id, titleSource: null,
    note: null, sharedText: null, thumbnailUrl: null, tags: [], status: 'unread', openedAt: null, aiMeta: null,
    createdAt: NOW - ageDays * DAY, updatedAt: NOW, deletedAt: null, ...extra,
  };
}

describe('pickForgotten', () => {
  it('only nags about old, unopened, unfinished, live links', () => {
    const links = [
      link('fresh', 2),
      link('opened', 30, { openedAt: NOW - DAY }),
      link('done', 30, { status: 'done' }),
      link('deleted', 30, { deletedAt: NOW }),
      link('forgotten', 30),
    ];
    expect(pickForgotten(links, NOW, 7)?.id).toBe('forgotten');
    expect(pickForgotten(links.slice(0, 4), NOW, 7)).toBeNull();
  });

  it('rotates through candidates day by day', () => {
    const links = [link('a', 10), link('b', 20)];
    const today = pickForgotten(links, NOW, 7)!.id;
    const tomorrow = pickForgotten(links, NOW + DAY, 7)!.id;
    expect(today).not.toBe(tomorrow);
  });
});

describe('nudgeCopy', () => {
  it('names the link and how long it has waited', () => {
    const { title, body } = nudgeCopy(link('x', 9, { title: 'One-pan lemon orzo' }), NOW);
    expect(title.length).toBeGreaterThan(0);
    expect(body).toContain('“One-pan lemon orzo”');
    expect(body).toContain('9 days');
  });

  it('falls back to the domain and truncates long titles', () => {
    expect(nudgeCopy(link('y', 8, { title: null, url: 'https://www.nytimes.com/a' }), NOW).body).toContain('nytimes.com');
    expect(nudgeCopy(link('z', 8, { title: 'w'.repeat(200) }), NOW).body).toContain('…');
  });

  it('uses singular for one day and never an em or en dash', () => {
    expect(nudgeCopy(link('s', 1), NOW).body).toMatch(/\b1 day\b/);
    for (const [t, b] of ALL_NUDGE_COPY) expect(t + b).not.toMatch(/[–—]/);
  });
});

describe('nudge history and prepared nudges', () => {
  it('skips recently nudged links unless nothing else is left', () => {
    const links = [link('a', 10), link('b', 20)];
    expect(pickForgotten(links, NOW, 7, new Set(['a']))?.id).toBe('b');
    expect(pickForgotten(links, NOW, 7, new Set(['a', 'b']))).not.toBeNull();
  });

  it('remembers a week of nudges and forgets after 30 days', () => {
    let h = pushNudgeHistory(undefined, 'a', NOW - 40 * DAY);
    h = pushNudgeHistory(h, 'b', NOW - 3 * DAY);
    h = pushNudgeHistory(h, 'c', NOW);
    expect(h.map((e) => e.id)).toEqual(['b', 'c']);
    expect([...recentlyNudged(h, NOW)]).toEqual(['b', 'c']);
    expect([...recentlyNudged(h, NOW, 1)]).toEqual(['c']);
  });

  it('only uses a prepared nudge while its link is still forgotten and fresh', () => {
    const links = [link('a', 10), link('opened', 10, { openedAt: NOW - DAY })];
    const p = (linkId: string, ageDays = 0) => ({ linkId, title: 't', body: 'b', at: NOW - ageDays * DAY });
    expect(usablePrepared(p('a'), links, NOW, 7)).toBe(true);
    expect(usablePrepared(p('opened'), links, NOW, 7)).toBe(false);
    expect(usablePrepared(p('a', 4), links, NOW, 7)).toBe(false);
    expect(usablePrepared(undefined, links, NOW, 7)).toBe(false);
  });
});

describe('nudgeNotification', () => {
  it('always carries the app icon and status-bar badge; Open/Later only for a link', () => {
    const withLink = nudgeNotification('body', 'https://example.com') as NotificationOptions & { actions?: unknown[] };
    expect(withLink).toMatchObject({ icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', data: { url: 'https://example.com' } });
    expect(withLink.actions).toHaveLength(2);
    expect((nudgeNotification('recap') as { actions?: unknown[] }).actions).toBeUndefined();
  });
});
