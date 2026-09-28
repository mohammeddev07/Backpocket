import { parseQuery } from '../search/queryParse';
import { byId } from '../ui/dom';
import { setExtraResults } from '../ui/list';
import { showToast } from '../ui/toast';
import { renderMain, view } from '../ui/view';
import { aiMode, aiReady, onAiModeChange } from './access';
import { AiError, aiCall, aiErrorMessage } from './client';
import { showAiNoticeOnce } from './notice';

// Natural-language search. Typing filters instantly with the local keyword
// search (no network); Enter or "Ask" adds semantic matches from the account's
// embeddings. Platform and date phrases are parsed locally, not by an LLM.
// Any failure falls back to the keyword results without a fuss.

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { ids: string[]; at: number }>();
let seq = 0;

function setAskState(state: 'idle' | 'loading'): void {
  const btn = byId<HTMLButtonElement>('askBtn');
  btn.classList.toggle('loading', state === 'loading');
  btn.setAttribute('aria-busy', String(state === 'loading'));
}

function updateAskButton(): void {
  const btn = byId('askBtn');
  btn.hidden = !(aiReady() && view.query.trim().length > 1);
}

export async function askSemantic(): Promise<void> {
  const q = view.query.trim();
  if (!q || !aiReady()) return;
  const key = aiMode() + '|' + q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    setExtraResults({ query: q, ids: hit.ids });
    renderMain();
    return;
  }
  showAiNoticeOnce();
  const mine = ++seq;
  setAskState('loading');
  const { text, filters } = parseQuery(q);
  try {
    const { hits } = await aiCall('search', { q: text || q, filters });
    if (mine !== seq || view.query.trim() !== q) return;
    const ids = hits.map((h) => h.id);
    cache.set(key, { ids, at: Date.now() });
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
    setExtraResults({ query: q, ids });
    renderMain();
  } catch (e) {
    // Keyword results are already on screen; only rate limits are worth a word.
    if (e instanceof AiError && e.code === 'rate_limited') showToast(aiErrorMessage(e), false);
  } finally {
    if (mine === seq) setAskState('idle');
  }
}

export function initSemanticSearch(): void {
  const input = byId<HTMLInputElement>('searchInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); void askSemantic(); }
  });
  input.addEventListener('input', updateAskButton);
  byId('askBtn').onclick = () => void askSemantic();
  onAiModeChange(updateAskButton);
}

/** Drop cached results (e.g. after data changes a lot, or on sign-out). */
export function clearSemanticCache(): void {
  cache.clear();
}
