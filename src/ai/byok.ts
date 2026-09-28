import { AI_CONFIG, type AiAction } from '@shared/config.ts';
import { embedTexts, GeminiError, generateJson, toVectorLiteral } from '@shared/gemini.ts';
import { CLASSIFY_SYSTEM, classifyPrompt, embedQueryText, PLAN_SYSTEM, planPrompt, textHash } from '@shared/prompts.ts';
import { CLASSIFY_SCHEMA, PLAN_SCHEMA, validateClassify, validateFilters, validatePlan, type SearchHit } from '@shared/schemas.ts';
import { take, type Bucket } from '@shared/tokenBucket.ts';
import { currentUser } from '../cloud/auth';
import { getSupabase } from '../cloud/supabase';
import type { ActionIO } from './client';

// Bring your own key: the user's free Gemini key lives only in this browser
// (localStorage) and calls go straight from the browser to Google - never
// through our server, never on the project's quota. A local token bucket with
// the same limits as the server keeps a runaway loop from burning their quota.

const KEY = 'backpocket_gemini_key';
const BUCKET = 'backpocket_byok_bucket';
const DAILY = 'backpocket_byok_daily';

export function getByokKey(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
export function hasByokKey(): boolean { return !!getByokKey(); }
export function setByokKey(key: string | null): void {
  try { if (key) localStorage.setItem(KEY, key.trim()); else localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** Checks the key with a free metadata call (no generation quota used). */
export async function validateByokKey(key: string): Promise<boolean> {
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + AI_CONFIG.model, {
      headers: { 'x-goog-api-key': key.trim() },
    });
    return res.ok;
  } catch {
    return false;
  }
}

function pacificDay(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/** Local mirror of the server's admission check. */
function admitLocally(cost: number): void {
  let bucket: Bucket | null = null;
  try { bucket = JSON.parse(localStorage.getItem(BUCKET) || 'null'); } catch { bucket = null; }
  const r = take(bucket, cost, AI_CONFIG.limits.user, Date.now());
  let daily = { day: pacificDay(), count: 0 };
  try {
    const d = JSON.parse(localStorage.getItem(DAILY) || 'null');
    if (d && d.day === daily.day) daily = d;
  } catch { /* fresh */ }
  if (!r.allowed) {
    localStorage.setItem(BUCKET, JSON.stringify(r.bucket));
    throw new GeminiError('rate_limited', 'Slow down.', 429, r.retryAfterSeconds);
  }
  if (daily.count >= AI_CONFIG.limits.dailyPerUser) throw new GeminiError('rate_limited', 'Daily limit reached.', 429, 6 * 3600);
  localStorage.setItem(BUCKET, JSON.stringify(r.bucket));
  localStorage.setItem(DAILY, JSON.stringify({ day: daily.day, count: daily.count + 1 }));
}

// Query embeddings are reused for repeated searches (same key, same text).
const queryCache = new Map<string, number[]>();

export async function byokCall<A extends Exclude<AiAction, 'status'>>(action: A, payload: ActionIO[A]['in']): Promise<ActionIO[A]['out']> {
  const { AiError } = await import('./client');
  const apiKey = getByokKey();
  if (!apiKey) throw new AiError('unavailable', 'Add your Gemini key in Settings.');
  if (!navigator.onLine) throw new AiError('offline', 'You\'re offline.');
  try {
    if (action === 'classify') {
      const { input } = payload as ActionIO['classify']['in'];
      admitLocally(AI_CONFIG.costs.classify);
      const raw = await generateJson({ apiKey, system: CLASSIFY_SYSTEM, prompt: classifyPrompt(input), schema: CLASSIFY_SCHEMA, timeoutMs: AI_CONFIG.timeoutsMs.classify, maxOutputTokens: 512 });
      return { result: validateClassify(raw, new Set(input.folders.map((f) => f.id))), model: AI_CONFIG.model } as ActionIO[A]['out'];
    }
    if (action === 'plan') {
      const { input } = payload as ActionIO['plan']['in'];
      admitLocally(AI_CONFIG.costs.plan);
      const raw = await generateJson({ apiKey, system: PLAN_SYSTEM, prompt: planPrompt(input), schema: PLAN_SCHEMA, timeoutMs: AI_CONFIG.timeoutsMs.plan, maxOutputTokens: 4096 });
      return { plan: validatePlan(raw, new Set(input.links.map((l) => l.id))), model: AI_CONFIG.model } as ActionIO[A]['out'];
    }

    // Semantic search and embeddings need the account's rows in Supabase.
    const user = currentUser();
    if (!user) throw new AiError('unavailable', 'Sign in to use AI search.');
    const sb = await getSupabase();

    if (action === 'embed') {
      const { items } = payload as ActionIO['embed']['in'];
      if (!items.length) return { updated: 0 } as ActionIO[A]['out'];
      admitLocally(AI_CONFIG.costs.embed);
      const vectors = await embedTexts({ apiKey, texts: items.map((i) => i.text), timeoutMs: AI_CONFIG.timeoutsMs.embed });
      const { data, error } = await sb.rpc('set_link_embeddings', {
        items: items.map((it, i) => ({ id: it.id, embedding: toVectorLiteral(vectors[i]), hash: textHash(it.text) })),
      });
      if (error) throw new AiError('failed', 'Could not store embeddings.');
      return { updated: (data as number) ?? 0 } as ActionIO[A]['out'];
    }

    const { q, filters } = payload as ActionIO['search']['in'];
    const text = embedQueryText(q);
    let vector = queryCache.get(text);
    if (!vector) {
      admitLocally(AI_CONFIG.costs.search);
      [vector] = await embedTexts({ apiKey, texts: [text], timeoutMs: AI_CONFIG.timeoutsMs.search });
      queryCache.set(text, vector);
      if (queryCache.size > 50) queryCache.delete(queryCache.keys().next().value!);
    }
    const { data, error } = await sb.rpc('match_links', {
      query_embedding: toVectorLiteral(vector), match_user: user.id,
      filters: validateFilters(filters), match_count: AI_CONFIG.searchResults,
    });
    if (error) throw new AiError('failed', 'Search failed.');
    const hits = ((data || []) as SearchHit[]).filter((h) => h.similarity >= AI_CONFIG.minSimilarity);
    return { hits } as ActionIO[A]['out'];
  } catch (e) {
    if (e instanceof GeminiError) {
      const code = e.code === 'rate_limited' ? 'rate_limited' : e.code === 'bad_key' ? 'bad_key' : e.code === 'timeout' ? 'timeout' : 'failed';
      throw new AiError(code, e.message, e.retryAfter);
    }
    throw e;
  }
}
