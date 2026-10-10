import { pathOf } from './tree';
import type { Folder, Link } from './types';

// Weekly recap: what was saved in the last 7 days. The stats version here is
// pure (no AI, no DOM) so the page and the service worker share it; the page
// swaps in an AI-written headline and summary when AI is on.

export const RECAP_META_KEY = 'recap';
/** When the worker last sent the recap as a notification. */
export const RECAP_NOTIFIED_KEY = 'recapNotifiedAt';
export const RECAP_EVERY_MS = 7 * 86_400_000;
/** Quieter weeks don't get a recap. */
export const RECAP_MIN_LINKS = 3;

export interface StoredRecap {
  /** When this recap was made (or the cycle started). */
  at: number;
  headline: string;
  summary: string;
  pickIds: string[];
  dismissed: boolean;
  ai: boolean;
}

export interface WeekStats {
  count: number;
  /** This week's saves, newest first. */
  links: Link[];
  /** Top-level folders with the most saves this week (subfolders count toward their parent), busiest first, max 2. */
  topFolders: string[];
  unopened: Link[];
}

export function weekStats(links: Link[], folders: Folder[], now: number): WeekStats {
  const week = links.filter((l) => !l.deletedAt && now - l.createdAt < RECAP_EVERY_MS).sort((a, b) => b.createdAt - a.createdAt);
  const perFolder = new Map<string, number>();
  for (const l of week) {
    const top = pathOf(folders, l.folderId)[0]?.name || 'Inbox';
    perFolder.set(top, (perFolder.get(top) || 0) + 1);
  }
  const topFolders = [...perFolder.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name]) => name);
  return { count: week.length, links: week, topFolders, unopened: week.filter((l) => l.openedAt == null && l.status !== 'done') };
}

/** Headline, summary and up to 3 picks (oldest unopened first), without AI. */
export function statsRecap(s: WeekStats): Pick<StoredRecap, 'headline' | 'summary' | 'pickIds'> {
  const where = s.topFolders.length === 2 ? 'mostly in ' + s.topFolders[0] + ' and ' + s.topFolders[1]
    : s.topFolders.length === 1 ? 'mostly in ' + s.topFolders[0] : '';
  const open = s.unopened.length === 0 ? 'You\'ve opened every one of them. Nice.'
    : s.unopened.length === 1 ? '1 is still unopened.' : s.unopened.length + ' are still unopened.';
  return {
    headline: 'Your week in saves',
    summary: 'You saved ' + s.count + (s.count === 1 ? ' link' : ' links') + ' this week' + (where ? ', ' + where : '') + '. ' + open,
    pickIds: [...s.unopened].reverse().slice(0, 3).map((l) => l.id),
  };
}

/** True when a new recap is due (7+ days since the last cycle started). */
export function recapDue(last: Pick<StoredRecap, 'at'> | undefined, now: number): boolean {
  return !!last && now - last.at >= RECAP_EVERY_MS;
}
