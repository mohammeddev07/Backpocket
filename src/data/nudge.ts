import { isRevisitCandidate } from '../search/filters';
import type { Link } from './types';

// "Forgotten save" reminders: which link to nag about, and what to say.
// Pure and DOM-free so the service worker (periodic background sync) and
// the page (in-app nudge) share it.

export const NUDGE_META_KEY = 'nudgeAt';
/** The next nudge, prepared while the app was open (smart pick + AI text), for the page or the worker to use. */
export const NUDGE_NEXT_KEY = 'nudgeNext';
/** Recently nudged links, so the same one doesn't come up day after day. */
export const NUDGE_HISTORY_KEY = 'nudgeHistory';
export const NUDGE_SYNC_TAG = 'bp-nudge';
/** At most one nudge per this window, across the page and the worker. */
export const NUDGE_GAP_MS = 20 * 3_600_000;
const DAY = 86_400_000;

/**
 * System notification look, shared by the page (test nudge) and the worker:
 * the app icon, the monochrome status-bar badge Android needs, and Open/Later
 * buttons when the nudge is about a link. Paths are relative to the worker scope.
 */
export function nudgeNotification(body: string, url?: string): NotificationOptions {
  return {
    body, tag: NUDGE_SYNC_TAG, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png',
    data: url ? { url } : {},
    ...(url ? { actions: [{ action: 'open', title: 'Open it' }, { action: 'later', title: 'Later' }] } : {}),
  } as NotificationOptions;
}

export interface PreparedNudge { linkId: string; title: string; body: string; at: number }
export interface NudgeHistoryEntry { id: string; at: number }

export const isNudgeable = (l: Link | undefined, now: number, minAgeDays: number): l is Link =>
  !!l && !l.deletedAt && isRevisitCandidate(l, now, minAgeDays);

/**
 * One unopened, not-done link at least `minAgeDays` old; rotates daily.
 * Links in `skip` (recently nudged) are avoided unless nothing else is left.
 */
export function pickForgotten(links: Link[], now: number, minAgeDays: number, skip: ReadonlySet<string> = new Set()): Link | null {
  const all = links.filter((l) => isNudgeable(l, now, minAgeDays)).sort((a, b) => a.createdAt - b.createdAt);
  const pool = all.filter((l) => !skip.has(l.id));
  const from = pool.length ? pool : all;
  return from.length ? from[Math.floor(now / DAY) % from.length]! : null;
}

/** Ids nudged within the last `days` days. */
export function recentlyNudged(history: NudgeHistoryEntry[] | undefined, now: number, days = 7): Set<string> {
  return new Set((history || []).filter((h) => now - h.at < days * DAY).map((h) => h.id));
}

/** Adds a nudge to the history, keeping only the last 30 days. */
export function pushNudgeHistory(history: NudgeHistoryEntry[] | undefined, id: string, now: number): NudgeHistoryEntry[] {
  return [...(history || []).filter((h) => now - h.at < 30 * DAY && h.id !== id), { id, at: now }].slice(-60);
}

/** A prepared nudge is usable while its link is still forgotten and it isn't stale. */
export function usablePrepared(p: PreparedNudge | undefined, links: Link[], now: number, minAgeDays: number): p is PreparedNudge {
  return !!p && now - p.at < 3 * DAY && isNudgeable(links.find((l) => l.id === p.linkId), now, minAgeDays);
}

type Copy = [title: string, body: string];
const GENERIC: Copy[] = [
  ['Your order is getting cold', '{t} has been sitting in your pocket for {d}.'],
  ['Knock knock', "It's {t}. You said you'd come back. That was {d} ago."],
  ['Still circling the block', "{t} is {d} out and hasn't been picked up yet."],
  ['Order up!', '{t} has been ready for {d}. Come and get it.'],
  ['We saved you a seat', '{t} has been waiting {d}. Five minutes, tops?'],
  ['Your pocket is buzzing', "{t} would like a word. It's been {d}."],
];
const BY_PLATFORM: Partial<Record<Link['platform'], Copy[]>> = {
  YouTube: [['Press play, maybe?', '{t} has been buffering in your pocket for {d}.']],
  Instagram: [['That reel misses you', "You've left {t} on read for {d}."]],
  TikTok: [['Your For You page called', 'It wants you to finally watch {t}. {d} and counting.']],
  X: [['The thread is unravelling', '{t} is still waiting, {d} later.']],
  Facebook: [['Remember this one?', '{t}. Saved {d} ago, never opened.']],
};

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** Notification title + body for a link. Deterministic per link and day. */
export function nudgeCopy(link: Link, now: number): { title: string; body: string } {
  const raw = (link.title || hostOf(link.url)).trim();
  const name = '“' + (raw.length > 60 ? raw.slice(0, 57).trimEnd() + '…' : raw) + '”';
  const days = Math.max(1, Math.floor((now - link.createdAt) / DAY));
  const pool = [...(BY_PLATFORM[link.platform] || []), ...GENERIC];
  let h = Math.floor(now / DAY);
  for (let i = 0; i < link.id.length; i++) h = (h * 31 + link.id.charCodeAt(i)) >>> 0;
  const [title, body] = pool[h % pool.length]!;
  return { title, body: body.replace('{t}', name).replace('{d}', days + (days === 1 ? ' day' : ' days')) };
}

/** Every template, for tests. */
export const ALL_NUDGE_COPY: Copy[] = [...GENERIC, ...Object.values(BY_PLATFORM).flat()];
