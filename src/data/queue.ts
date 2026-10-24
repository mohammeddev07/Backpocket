import { isRevisitCandidate, shuffle } from '../search/filters';
import type { Link } from './types';

// Daily Queue: five saves a day (one focus, four up next), picked once per
// local day and kept in IndexedDB meta, plus a streak of days with at least
// one queue item done. Pure, so it's unit-tested.

export const QUEUE_META_KEY = 'queue';
export const STREAK_META_KEY = 'queueStreak';
export const QUEUE_SIZE = 5;

export interface DailyQueue { day: string; ids: string[] }
export interface Streak { last: string | null; count: number }

const pad = (n: number) => String(n).padStart(2, '0');
/** Local calendar day, e.g. "2026-10-16". */
export function dayKey(now: number): string {
  const d = new Date(now);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function dayBefore(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d - 1).getTime());
}
function seedOf(day: string): number {
  let h = 0;
  for (const c of day) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return h || 1;
}

/**
 * Today's picks among unfinished saves: `preferIds` first (smart picks), then
 * forgotten ones (old, never opened), then other unopened, then opened but not
 * done. Each tier is shuffled with the day as seed, so the order is stable all day.
 */
export function buildQueue(links: Link[], now: number, minAgeDays: number, preferIds: string[] = [], size = QUEUE_SIZE): string[] {
  const open = links.filter((l) => l.deletedAt == null && l.status !== 'done');
  const seed = seedOf(dayKey(now));
  const openIds = new Set(open.map((l) => l.id));
  const forgotten = open.filter((l) => isRevisitCandidate(l, now, minAgeDays));
  const unopened = open.filter((l) => l.openedAt == null && !isRevisitCandidate(l, now, minAgeDays));
  const opened = open.filter((l) => l.openedAt != null);
  const ordered = [
    ...preferIds.filter((id) => openIds.has(id)),
    ...[forgotten, unopened, opened].flatMap((tier) => shuffle(tier.sort((a, b) => a.createdAt - b.createdAt), seed).map((l) => l.id)),
  ];
  return [...new Set(ordered)].slice(0, size);
}

/**
 * Keeps today's queue at the daily size: drops deleted links and fills any gap
 * (e.g. it was picked before anything was saved). Done links stay, so clearing
 * the five doesn't pull in more.
 */
export function topUpQueue(ids: string[], links: Link[], now: number, minAgeDays: number, size = QUEUE_SIZE): string[] {
  const live = new Set(links.filter((l) => l.deletedAt == null).map((l) => l.id));
  const kept = ids.filter((id) => live.has(id));
  if (kept.length >= size) return kept;
  const extra = buildQueue(links, now, minAgeDays, [], size).filter((id) => !kept.includes(id));
  return [...kept, ...extra].slice(0, size);
}

/** Marks today as a streak day (once per day). */
export function recordStreakDay(s: Streak | undefined, today: string): Streak {
  if (s?.last === today) return s;
  return { last: today, count: s?.last === dayBefore(today) ? s.count + 1 : 1 };
}

/** The streak as of today: still alive if the last done day was today or yesterday. */
export function currentStreak(s: Streak | undefined, today: string): number {
  return s && (s.last === today || s.last === dayBefore(today)) ? s.count : 0;
}

/** Moves `id` into `targetId`'s place (drag and drop, Shift+J/K). */
export function moveId(ids: string[], id: string, targetId: string): string[] {
  const to = ids.indexOf(targetId);
  if (id === targetId || to < 0 || !ids.includes(id)) return ids;
  const out = ids.filter((x) => x !== id);
  out.splice(to, 0, id);
  return out;
}

const DAY_MS = 86_400_000;

/** "3 weeks ago" style, for sentences (relativeTime's "3w ago" is for meta rows). */
export function agoWords(ts: number, now: number): string {
  const days = Math.floor((now - ts) / DAY_MS);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 14) return days + ' days ago';
  if (days < 60) return Math.floor(days / 7) + ' weeks ago';
  if (days < 730) return Math.floor(days / 30) + ' months ago';
  return Math.floor(days / 365) + ' years ago';
}

/** One line on why this save is up today, from the same signals the picker uses. */
export function whyNow(link: Link, now: number, minAgeDays: number): string {
  if (link.openedAt != null) {
    return dayKey(link.openedAt) === dayKey(now)
      ? 'You opened this today. Mark it done when you finish.'
      : 'You opened this ' + agoWords(link.openedAt, now) + '. Finish it off.';
  }
  return 'Saved ' + agoWords(link.createdAt, now) + (isRevisitCandidate(link, now, minAgeDays) ? ' and never opened' : '');
}
