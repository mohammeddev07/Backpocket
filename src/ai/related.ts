import { AI_CONFIG } from '@shared/config.ts';
import { currentUser } from '../cloud/auth';
import { getSupabase } from '../cloud/supabase';
import { store } from '../data/store';
import { pathLabel } from '../data/tree';
import type { Link } from '../data/types';
import { domainOf } from '../platform';
import { addLinkMenuItems, deleteLinksWithUndo } from '../ui/list';
import { showToast } from '../ui/toast';
import { go, renderMain, view } from '../ui/view';
import { aiReady } from './access';

// Features built on the embeddings the app already stores - database lookups
// only, no AI calls: "More like this", near-duplicate warnings after a save,
// and smarter reminder picks. Embeddings live on the account's rows, so all
// of this needs a signed-in account with AI on; otherwise it stays hidden.

interface Neighbour { id: string; similarity: number }

export function relatedAvailable(): boolean {
  return !!currentUser() && aiReady();
}

async function rpc(name: 'related_links' | 'revisit_picks', args: Record<string, unknown>): Promise<Neighbour[]> {
  const sb = await getSupabase();
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return (data || []) as Neighbour[];
}

const titleOf = (l: Link) => l.title || domainOf(l.url);

// ---- "More like this" ----
export async function showRelated(link: Link): Promise<void> {
  let ids: string[];
  try {
    const hits = await rpc('related_links', { p_link: link.id, match_count: 20 });
    ids = hits.filter((h) => h.similarity >= AI_CONFIG.relatedMinSimilarity).map((h) => h.id);
  } catch {
    showToast('Couldn\'t look for similar saves right now.', false);
    return;
  }
  go('all');
  view.related = { id: link.id, title: titleOf(link).slice(0, 40), ids };
  renderMain();
  window.scrollTo({ top: 0 });
}

// ---- Near-duplicate warning, right after a new save is embedded ----
const FRESH_MS = 15 * 60_000;
const checked = new Set<string>();

/** Called with the links whose embeddings were just stored. Warns about the first near-twin. */
export async function checkNewForDuplicates(ids: string[]): Promise<void> {
  if (!relatedAvailable()) return;
  const now = Date.now();
  const fresh = ids.map((id) => store.link(id))
    .filter((l): l is Link => !!l && !l.deletedAt && now - l.createdAt < FRESH_MS && !checked.has(l.id));
  for (const link of fresh) {
    checked.add(link.id);
    let top: Neighbour | undefined;
    try { [top] = await rpc('related_links', { p_link: link.id, match_count: 1 }); } catch { return; }
    const twin = top && top.similarity >= AI_CONFIG.duplicateSimilarity ? store.link(top.id) : undefined;
    if (!twin || twin.deletedAt) continue;
    const where = pathLabel(store.liveFolders(), twin.folderId);
    showToast('Looks like you already saved this: “' + titleOf(twin).slice(0, 50) + '” in ' + where + '.', false, [
      { label: 'Compare', onClick: () => void showRelated(link) },
      { label: 'Delete new', onClick: () => deleteLinksWithUndo([link.id]) },
    ], 9000);
    return; // one warning at a time
  }
}

// ---- Smarter reminder picks ----
/** Forgotten saves ranked by closeness to recent saves; [] when unavailable. */
export async function revisitPickIds(minAgeDays: number): Promise<string[]> {
  if (!relatedAvailable()) return [];
  try {
    return (await rpc('revisit_picks', { p_min_age_days: minAgeDays, match_count: 10 })).map((h) => h.id);
  } catch {
    return [];
  }
}

export function initRelated(): void {
  addLinkMenuItems((link) => relatedAvailable() ? [{ label: 'More like this', onClick: () => void showRelated(link) }] : []);
}
