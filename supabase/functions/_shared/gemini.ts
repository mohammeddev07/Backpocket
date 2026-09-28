// Minimal Gemini REST client (generateContent + batchEmbedContents), shared
// by the Edge Function and the browser. Uses only fetch/AbortController.
// Docs: https://ai.google.dev/api/generate-content, https://ai.google.dev/api/embeddings

import { AI_CONFIG } from './config.ts';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export type GeminiErrorCode = 'timeout' | 'rate_limited' | 'bad_key' | 'blocked' | 'bad_output' | 'upstream';

export class GeminiError extends Error {
  constructor(public code: GeminiErrorCode, message: string, public status = 0, public retryAfter?: number) {
    super(message);
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function post(url: string, apiKey: string, body: unknown, timeoutMs: number, fetchImpl: FetchLike): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new GeminiError('timeout', 'Gemini took too long.');
    throw new GeminiError('upstream', 'Could not reach Gemini.');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const err = (data.error || {}) as { message?: string; status?: string; details?: Array<Record<string, unknown>> };
    if (res.status === 429) {
      const retry = err.details?.find((d) => String(d['@type'] || '').includes('RetryInfo'))?.retryDelay as string | undefined;
      const secs = retry ? Math.ceil(parseFloat(retry)) : Number(res.headers.get('Retry-After')) || 30;
      throw new GeminiError('rate_limited', 'Gemini rate limit reached.', 429, secs);
    }
    const badKey = res.status === 401 || res.status === 403 || /API_KEY|api key/i.test((err.status || '') + ' ' + (err.message || ''));
    throw new GeminiError(badKey ? 'bad_key' : 'upstream', err.message || 'Gemini error ' + res.status, res.status);
  }
  return data;
}

export interface GenerateOptions {
  apiKey: string;
  system: string;
  prompt: string;
  schema: object;
  timeoutMs: number;
  model?: string;
  maxOutputTokens?: number;
  fetchImpl?: FetchLike;
}

/** Structured-output call: returns the parsed JSON object. */
export async function generateJson(o: GenerateOptions): Promise<unknown> {
  const model = o.model || AI_CONFIG.model;
  const data = await post(`${BASE}/models/${model}:generateContent`, o.apiKey, {
    systemInstruction: { parts: [{ text: o.system }] },
    contents: [{ role: 'user', parts: [{ text: o.prompt }] }],
    generationConfig: {
      responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: o.schema } },
      thinkingConfig: { thinkingLevel: AI_CONFIG.thinkingLevel },
      maxOutputTokens: o.maxOutputTokens ?? 2048,
    },
  }, o.timeoutMs, o.fetchImpl || fetch) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
  };
  if (data.promptFeedback?.blockReason) throw new GeminiError('blocked', 'Gemini declined this request.');
  const text = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiError('bad_output', 'Gemini returned malformed JSON.');
  }
}

/** One embedding per text (batchEmbedContents keeps them separate, in order). */
export async function embedTexts(o: { apiKey: string; texts: string[]; timeoutMs: number; fetchImpl?: FetchLike }): Promise<number[][]> {
  if (!o.texts.length) return [];
  const model = 'models/' + AI_CONFIG.embeddingModel;
  const data = await post(`${BASE}/${model}:batchEmbedContents`, o.apiKey, {
    requests: o.texts.map((text) => ({
      model,
      content: { parts: [{ text }] },
      embedContentConfig: { outputDimensionality: AI_CONFIG.embeddingDims },
    })),
  }, o.timeoutMs, o.fetchImpl || fetch) as { embeddings?: Array<{ values?: number[] }> };
  const out = (data.embeddings || []).map((e) => e.values || []);
  if (out.length !== o.texts.length || out.some((v) => v.length !== AI_CONFIG.embeddingDims)) {
    throw new GeminiError('bad_output', 'Unexpected embedding response.');
  }
  return out;
}

/** pgvector literal for PostgREST/RPC parameters. */
export function toVectorLiteral(v: number[]): string {
  return '[' + v.map((x) => (Number.isFinite(x) ? +x.toFixed(6) : 0)).join(',') + ']';
}
