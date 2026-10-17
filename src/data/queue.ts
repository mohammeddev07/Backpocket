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

/** Marks today as a streak day (once per day). */
export function recordStreakDay(s: Streak | undefined, today: string): Streak {
  if (s?.last === today) return s;
  return { last: today, count: s?.last === dayBefore(today) ? s.count + 1 : 1 };
}

/** The streak as of today: still alive if the last done day was today or yesterday. */
export function currentStreak(s: Streak | undefined, today: string): number {
  return s && (s.last === today || s.last === dayBefore(today)) ? s.count : 0;
}
