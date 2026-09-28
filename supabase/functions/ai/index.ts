// AI gateway for allowlisted accounts: every call uses the project's Gemini
// key (GEMINI_API_KEY, set with `supabase secrets set`), after checking the
// caller's JWT, the allowlist and the rate limits.
//
// POST { action: 'status' | 'classify' | 'search' | 'plan' | 'embed', ... }
// 401 unauthorized · 403 { code: 'not_allowlisted' } · 429 + Retry-After

import { createSupabaseContext, type SupabaseContext } from 'npm:@supabase/server@1';
import { AI_CONFIG, type AiAction, type CostedAction } from '../_shared/config.ts';
import { embedTexts, GeminiError, generateJson, toVectorLiteral } from '../_shared/gemini.ts';
import { CLASSIFY_SYSTEM, classifyPrompt, embedQueryText, PLAN_SYSTEM, planPrompt, textHash } from '../_shared/prompts.ts';
import {
  CLASSIFY_SCHEMA, PLAN_SCHEMA, validateClassify, validateEmbedItems, validateFilters, validatePlan,
  type ClassifyInput, type FolderContext, type PlanInput, type SearchHit,
} from '../_shared/schemas.ts';
import { HttpError, json, preflight, readJson } from '../_server/http.ts';

const ACTIONS: AiAction[] = ['status', 'classify', 'search', 'plan', 'embed'];

function geminiKey(): string {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) throw new HttpError(500, 'not_configured', 'AI is not configured on the server.');
  return key;
}

const s = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);

function parseClassifyInput(raw: unknown): ClassifyInput {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const url = s(o.url, 4000);
  if (!url) throw new HttpError(400, 'bad_input', 'Missing url.');
  const folders: FolderContext[] = (Array.isArray(o.folders) ? o.folders : []).slice(0, AI_CONFIG.maxFolders)
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as Record<string, unknown>).id === 'string')
    .map((f) => ({
      id: String(f.id).slice(0, 64),
      path: s(f.path, 200) || '',
      examples: (Array.isArray(f.examples) ? f.examples : []).filter((e): e is string => typeof e === 'string')
        .slice(0, AI_CONFIG.maxExamplesPerFolder).map((e) => e.slice(0, 120)),
    }));
  return {
    url, platform: s(o.platform, 20) || 'Link', title: s(o.title, 300), caption: s(o.caption, 2000),
    note: s(o.note, 1000), oembedTitle: s(o.oembedTitle, 300), folders,
  };
}

function parsePlanInput(raw: unknown): PlanInput {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const links = (Array.isArray(o.links) ? o.links : []).slice(0, AI_CONFIG.maxPlanLinks)
    .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object' && typeof (l as Record<string, unknown>).id === 'string')
    .map((l) => ({
      id: String(l.id).slice(0, 64), url: s(l.url, 2000) || '', platform: s(l.platform, 20) || 'Link',
      title: s(l.title, 300), note: s(l.note, 600), caption: s(l.caption, 600),
    }));
  if (links.length < 2) throw new HttpError(400, 'bad_input', 'A plan needs at least 2 links.');
  return { folder: s(o.folder, 200) || 'Folder', links };
}

async function admit(ctx: SupabaseContext, userId: string, action: CostedAction): Promise<void> {
  const L = AI_CONFIG.limits;
  const { data, error } = await ctx.supabaseAdmin.rpc('ai_admit', {
    p_user: userId,
    p_cost: AI_CONFIG.costs[action],
    p_user_capacity: L.user.capacity,
    p_user_refill: L.user.refillPerSec,
    p_global_capacity: L.global.capacity,
    p_global_refill: L.global.refillPerSec,
    p_daily_user: L.dailyPerUser,
    p_daily_global: L.dailyGlobal,
  });
  if (error) throw new HttpError(500, 'limiter_error', 'Rate limiter unavailable.');
  const r = data as { allowed: boolean; reason?: string; retry_after_seconds?: number };
  if (!r.allowed) {
    const retry = Math.max(1, Math.ceil(r.retry_after_seconds || 1));
    const daily = r.reason === 'user_daily' || r.reason === 'global_daily';
    throw new HttpError(429, 'rate_limited',
      daily ? 'Daily AI limit reached. It resets at midnight Pacific time.' : 'Slow down - try again in ' + retry + 's.',
      { 'Retry-After': String(retry) }, { retry_after_seconds: retry, reason: r.reason });
  }
}

function errorResponse(req: Request, e: unknown): Response {
  if (e instanceof HttpError) {
    return json(req, { code: e.code, message: e.message, ...e.extra }, e.status, e.headers);
  }
  if (e instanceof GeminiError) {
    if (e.code === 'rate_limited') {
      const retry = e.retryAfter || 30;
      return json(req, { code: 'rate_limited', reason: 'upstream', message: 'AI is busy - try again in ' + retry + 's.', retry_after_seconds: retry }, 429, { 'Retry-After': String(retry) });
    }
    if (e.code === 'timeout') return json(req, { code: 'timeout', message: 'AI took too long.' }, 504);
    if (e.code === 'bad_key') return json(req, { code: 'not_configured', message: 'AI is not configured on the server.' }, 500);
    return json(req, { code: 'upstream_error', message: e.message }, 502);
  }
  console.error('ai function error', e);
  return json(req, { code: 'internal', message: 'Something went wrong.' }, 500);
}

export default {
  async fetch(req: Request): Promise<Response> {
    const pre = preflight(req);
    if (pre) return pre;
    if (req.method !== 'POST') return json(req, { code: 'method_not_allowed' }, 405);
    try {
      const { data: ctx, error } = await createSupabaseContext(req, { auth: 'user', cors: 'disabled' });
      if (error || !ctx?.userClaims) throw new HttpError(401, 'unauthorized', 'Sign in to use AI.');
      const userId = ctx.userClaims.id;
      const body = (await readJson(req, AI_CONFIG.maxBodyBytes)) as Record<string, unknown>;
      const action = body.action as AiAction;
      if (!ACTIONS.includes(action)) throw new HttpError(400, 'bad_action', 'Unknown action.');

      const email = (ctx.userClaims.email || '').trim().toLowerCase();
      const { data: listed, error: listError } = email
        ? await ctx.supabaseAdmin.from('ai_allowlist').select('email').eq('email', email).maybeSingle()
        : { data: null, error: null };
      if (listError) throw new HttpError(500, 'allowlist_error', 'Could not check AI access.');
      if (!listed) throw new HttpError(403, 'not_allowlisted', 'This account isn\'t set up to use the shared AI key.');

      if (action === 'status') return json(req, { ok: true, model: AI_CONFIG.model });

      await admit(ctx, userId, action);
      const apiKey = geminiKey();

      if (action === 'classify') {
        const input = parseClassifyInput(body.input);
        const raw = await generateJson({
          apiKey, system: CLASSIFY_SYSTEM, prompt: classifyPrompt(input), schema: CLASSIFY_SCHEMA,
          timeoutMs: AI_CONFIG.timeoutsMs.classify, maxOutputTokens: 512,
        });
        return json(req, { result: validateClassify(raw, new Set(input.folders.map((f) => f.id))), model: AI_CONFIG.model });
      }

      if (action === 'plan') {
        const input = parsePlanInput(body.input);
        const raw = await generateJson({
          apiKey, system: PLAN_SYSTEM, prompt: planPrompt(input), schema: PLAN_SCHEMA,
          timeoutMs: AI_CONFIG.timeoutsMs.plan, maxOutputTokens: 4096,
        });
        return json(req, { plan: validatePlan(raw, new Set(input.links.map((l) => l.id))), model: AI_CONFIG.model });
      }

      if (action === 'embed') {
        const items = validateEmbedItems(body.items);
        if (!items.length) return json(req, { updated: 0 });
        const vectors = await embedTexts({ apiKey, texts: items.map((i) => i.text), timeoutMs: AI_CONFIG.timeoutsMs.embed });
        const { data, error: rpcError } = await ctx.supabase.rpc('set_link_embeddings', {
          items: items.map((it, i) => ({ id: it.id, embedding: toVectorLiteral(vectors[i]), hash: textHash(it.text) })),
        });
        if (rpcError) throw new HttpError(500, 'db_error', 'Could not store embeddings.');
        return json(req, { updated: data ?? 0 });
      }

      // search
      const q = s(body.q, AI_CONFIG.maxQueryChars);
      if (!q) return json(req, { hits: [] });
      const [vector] = await embedTexts({ apiKey, texts: [embedQueryText(q)], timeoutMs: AI_CONFIG.timeoutsMs.search });
      const { data, error: rpcError } = await ctx.supabase.rpc('match_links', {
        query_embedding: toVectorLiteral(vector),
        match_user: userId,
        filters: validateFilters(body.filters),
        match_count: AI_CONFIG.searchResults,
      });
      if (rpcError) throw new HttpError(500, 'db_error', 'Search failed.');
      const hits = ((data || []) as SearchHit[]).filter((h) => h.similarity >= AI_CONFIG.minSimilarity);
      return json(req, { hits });
    } catch (e) {
      return errorResponse(req, e);
    }
  },
};
