import { pathLabel } from '../data/tree';
import type { Folder, Link } from '../data/types';

// Which links the list shows: view (All saves / a folder / Revisit), keyword
// search and the Filters sheet. Pure, so it's unit-tested.

export type ViewMode = 'all' | 'folder' | 'revisit';
export type SortMode = 'newest' | 'oldest' | 'platform' | 'title';
export type StatusFilter = 'any' | 'unread' | 'done';

export interface ListFilters {
  /** In a folder view: just this folder, or search everything. */
  scope: 'folder' | 'all';
  sort: SortMode;
  platform: string | null;
  tags: string[];
  status: StatusFilter;
  dateStart: string;
  dateEnd: string;
}

export const DEFAULT_FILTERS: ListFilters = {
  scope: 'folder', sort: 'newest', platform: null, tags: [], status: 'any', dateStart: '', dateEnd: '',
};

export interface ListQuery {
  mode: ViewMode;
  folderId: string;
  query: string;
  filters: ListFilters;
  /** Non-zero: Revisit order is shuffled with this seed. */
  shuffleSeed: number;
  now: number;
  revisitMinAgeDays: number;
}

export function activeFilterCount(f: ListFilters): number {
  return (f.scope !== 'folder' ? 1 : 0) + (f.sort !== 'newest' ? 1 : 0) + (f.platform ? 1 : 0) +
    f.tags.length + (f.status !== 'any' ? 1 : 0) + (f.dateStart || f.dateEnd ? 1 : 0);
}

export function isRevisitCandidate(l: Link, now: number, minAgeDays: number): boolean {
  return l.openedAt == null && l.status !== 'done' && now - l.createdAt >= minAgeDays * 86_400_000;
}

/** Every whitespace-separated term must appear in one of the searchable fields. */
export function keywordMatch(l: Link, folderPath: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).map((t) => t.replace(/^#/, '')).filter(Boolean);
  if (!terms.length) return true;
  const hay = [l.title, l.note, l.sharedText, l.url, l.platform, folderPath, ...l.tags]
    .filter(Boolean).join('\n').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

// Small seeded PRNG (mulberry32) so a shuffle stays put across re-renders.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle<T>(arr: T[], seed: number): T[] {
  const out = arr.slice();
  const r = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Links in the current view before search/filters (for counts and empty states). */
export function viewLinks(links: Link[], q: Pick<ListQuery, 'mode' | 'folderId' | 'filters' | 'now' | 'revisitMinAgeDays'>): Link[] {
  if (q.mode === 'revisit') return links.filter((l) => isRevisitCandidate(l, q.now, q.revisitMinAgeDays));
  if (q.mode === 'folder' && q.filters.scope === 'folder') return links.filter((l) => l.folderId === q.folderId);
  return links;
}

export function selectLinks(links: Link[], folders: Folder[], q: ListQuery): Link[] {
  let out = viewLinks(links, q);
  const f = q.filters;
  if (q.query.trim()) {
    const paths = new Map<string, string>();
    const pathFor = (id: string) => {
      if (!paths.has(id)) paths.set(id, pathLabel(folders, id));
      return paths.get(id)!;
    };
    out = out.filter((l) => keywordMatch(l, pathFor(l.folderId), q.query));
  }
  if (f.platform) out = out.filter((l) => l.platform === f.platform);
  if (f.tags.length) out = out.filter((l) => f.tags.every((t) => l.tags.includes(t)));
  if (f.status !== 'any') out = out.filter((l) => l.status === f.status);
  if (f.dateStart) {
    const startTs = new Date(f.dateStart + 'T00:00:00').getTime();
    out = out.filter((l) => l.createdAt >= startTs);
  }
  if (f.dateEnd) {
    const endTs = new Date(f.dateEnd + 'T23:59:59.999').getTime();
    out = out.filter((l) => l.createdAt <= endTs);
  }

  if (q.mode === 'revisit' && q.shuffleSeed) return shuffle(out.sort((a, b) => a.createdAt - b.createdAt), q.shuffleSeed);
  const sort = q.mode === 'revisit' && f.sort === 'newest' ? 'oldest' : f.sort;
  if (sort === 'oldest') out.sort((a, b) => a.createdAt - b.createdAt);
  else if (sort === 'platform') out.sort((a, b) => a.platform.localeCompare(b.platform) || b.createdAt - a.createdAt);
  else if (sort === 'title') out.sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url));
  else out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export function allTags(links: Link[]): string[] {
  const counts = new Map<string, number>();
  for (const l of links) for (const t of l.tags) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}
