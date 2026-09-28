import { AI_CONFIG, type AiAction } from '@shared/config.ts';
import type { ClassifyInput, ClassifyOutput, PlanInput, PlanOutput, SearchFilters, SearchHit, EmbedItem } from '@shared/schemas.ts';
import { accessToken } from '../cloud/auth';
import { functionUrl } from '../cloud/supabase';
import { SUPABASE_ANON_KEY } from '../config';
import { aiMode, markNotAllowlisted } from './access';
import { byokCall } from './byok';

// One entry point for AI calls. Allowlisted accounts go through the Edge
// Function (project key, server-side limits); bring-your-own-key users call
// Gemini straight from the browser. Callers don't need to know which.

export type AiErrorCode = 'unavailable' | 'rate_limited' | 'not_allowlisted' | 'bad_key' | 'timeout' | 'offline' | 'failed';

export class AiError extends Error {
  constructor(public code: AiErrorCode, message: string, public retryAfter?: number) {
    super(message);
  }
}

export interface ActionIO {
  status: { in: Record<string, never>; out: { ok: true; model: string } };
  classify: { in: { input: ClassifyInput }; out: { result: ClassifyOutput; model: string } };
  plan: { in: { input: PlanInput }; out: { plan: PlanOutput; model: string } };
  search: { in: { q: string; filters: SearchFilters }; out: { hits: SearchHit[] } };
  embed: { in: { items: EmbedItem[] }; out: { updated: number } };
}

/** Calls the Edge Function (no mode check - used for the access probe too). */
export async function serverCall<A extends AiAction>(action: A, payload: ActionIO[A]['in']): Promise<ActionIO[A]['out']> {
  if (!navigator.onLine) throw new AiError('offline', 'You\'re offline.');
  const token = await accessToken();
  if (!token) throw new AiError('unavailable', 'Sign in to use AI.');
  const ctrl = new AbortController();
  const limit = (AI_CONFIG.timeoutsMs as Record<string, number>)[action] ?? 10_000;
  const timer = setTimeout(() => ctrl.abort(), limit + 3000);
  let res: Response;
  try {
    res = await fetch(functionUrl('ai'), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new AiError((e as Error)?.name === 'AbortError' ? 'timeout' : 'failed', 'AI request failed.');
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({})) as { code?: string; message?: string; retry_after_seconds?: number };
  if (res.ok) return body as ActionIO[A]['out'];
  if (res.status === 429) {
    const retry = Number(res.headers.get('Retry-After')) || body.retry_after_seconds || 30;
    throw new AiError('rate_limited', body.message || 'Slow down - try again in ' + retry + 's.', retry);
  }
  if (res.status === 403 && body.code === 'not_allowlisted') throw new AiError('not_allowlisted', body.message || 'Not allowlisted.');
  if (res.status === 504 || body.code === 'timeout') throw new AiError('timeout', 'AI took too long.');
  throw new AiError('failed', body.message || 'AI request failed (' + res.status + ').');
}

export async function aiCall<A extends Exclude<AiAction, 'status'>>(action: A, payload: ActionIO[A]['in']): Promise<ActionIO[A]['out']> {
  const mode = aiMode();
  if (mode === 'byok') return byokCall(action, payload);
  if (mode !== 'server') throw new AiError('unavailable', 'AI isn\'t available for this account.');
  try {
    return await serverCall(action, payload);
  } catch (e) {
    if (e instanceof AiError && e.code === 'not_allowlisted') markNotAllowlisted();
    throw e;
  }
}

/** "Slow down - try again in Xs" for rate limits; a short message otherwise. */
export function aiErrorMessage(e: unknown): string {
  if (e instanceof AiError) {
    if (e.code === 'rate_limited') return e.retryAfter && e.retryAfter > 3600
      ? 'Daily AI limit reached - try again tomorrow.'
      : 'Slow down - try again in ' + (e.retryAfter ?? 30) + 's';
    if (e.code === 'bad_key') return 'Your Gemini key was rejected. Check it in Settings.';
    if (e.code === 'offline') return 'You\'re offline.';
    if (e.code === 'timeout') return 'AI took too long - try again.';
    return e.message;
  }
  return 'AI request failed.';
}
