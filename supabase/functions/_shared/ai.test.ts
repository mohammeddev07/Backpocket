import { describe, expect, it, vi } from 'vitest';
import { AI_CONFIG } from './config.ts';
import { embedTexts, GeminiError, generateJson, toVectorLiteral } from './gemini.ts';
import { classifyPrompt, embedDocumentText, embedQueryText, textHash } from './prompts.ts';
import { CLASSIFY_SCHEMA, validateClassify, validatePlan } from './schemas.ts';
import { take, type Bucket } from './tokenBucket.ts';

const USER = AI_CONFIG.limits.user;

describe('token bucket', () => {
  it('allows a burst of 5, then refills one token every 6 s', () => {
    let b: Bucket | null = null;
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      const r = take(b, 1, USER, 0);
      b = r.bucket;
      if (r.allowed) allowed++;
    }
    expect(allowed).toBe(5);
    const denied = take(b, 1, USER, 0);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retryAfterSeconds).toBe(6);
    expect(take(b, 1, USER, 6000).allowed).toBe(true);
  });

  it('a storm across a minute boundary cannot beat the bucket (99 at 0:59, 99 at 1:00)', () => {
    let b: Bucket | null = null;
    let allowed = 0;
    for (const t of [59_000, 60_000]) {
      for (let i = 0; i < 99; i++) {
        const r = take(b, 1, USER, t);
        b = r.bucket;
        if (r.allowed) allowed++;
      }
    }
    expect(allowed).toBe(5);
  });

  it('never allows more than ~15 in any 60 s window, whatever the timing', () => {
    let b: Bucket | null = null;
    const times: number[] = [];
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let t = 0; t < 300_000; t += Math.floor(rand() * 900)) {
      const r = take(b, 1, USER, t);
      b = r.bucket;
      if (r.allowed) times.push(t);
    }
    let worst = 0;
    for (let i = 0; i < times.length; i++) {
      let j = i;
      while (j < times.length && times[j] - times[i] < 60_000) j++;
      worst = Math.max(worst, j - i);
    }
    expect(worst).toBeLessThanOrEqual(15);
    expect(worst).toBeGreaterThanOrEqual(14);
  });

  it('plans cost 3 tokens', () => {
    const r1 = take(null, 3, USER, 0);
    const r2 = take(r1.bucket, 3, USER, 0);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(false);
  });
});

describe('validators', () => {
  it('only accepts an existing folder id and never both folder and new path', () => {
    const ids = new Set(['f1']);
    expect(validateClassify({ folder_id: 'f1', new_folder_path: 'X', title: 't', tags: [], confidence: 0.9, reason: '' }, ids))
      .toMatchObject({ folder_id: 'f1', new_folder_path: null });
    expect(validateClassify({ folder_id: 'made-up', new_folder_path: 'Recipes > Breakfast', confidence: 2 }, ids))
      .toMatchObject({ folder_id: null, new_folder_path: 'Recipes › Breakfast', confidence: 1 });
  });

  it('cleans tags', () => {
    expect(validateClassify({ tags: ['#Chess', 'Chess', 'opening theory', 'a', 'b', 'c'] }, new Set()).tags)
      .toEqual(['chess', 'opening-theory', 'a', 'b']);
  });

  it('keeps plan link references to real links only', () => {
    const plan = validatePlan({ title: 'T', summary: 'S', items: [{ text: 'Do it', link_ids: ['a', 'zzz', 'a'] }, { text: '', link_ids: [] }] }, new Set(['a']));
    expect(plan.items).toEqual([{ text: 'Do it', link_ids: ['a'] }]);
  });
});

describe('prompts', () => {
  it('lists folders with ids, paths and examples', () => {
    const p = classifyPrompt({ url: 'https://x.example', platform: 'TikTok', caption: 'hi', folders: [{ id: 'f1', path: 'Job › Interview', examples: ['Mock answers'] }] });
    expect(p).toContain('- f1 | Job › Interview | e.g. "Mock answers"');
    expect(p).toContain('caption shared with it: hi');
  });

  it('embedding texts follow the gemini-embedding-2 task format', () => {
    expect(embedQueryText('chess opening')).toBe('task: search result | query: chess opening');
    expect(embedDocumentText({ title: 'Sicilian', note: 'try it', tags: ['chess'] })).toBe('title: Sicilian | text: try it · #chess');
    expect(embedDocumentText({})).toBe('title: none | text: none');
  });

  it('hash is stable and changes with the text', () => {
    expect(textHash('abc')).toBe(textHash('abc'));
    expect(textHash('abc')).not.toBe(textHash('abd'));
  });
});

describe('gemini client', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body }) as Response;

  it('sends structured output + minimal thinking and parses the JSON text', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ok({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] }));
    const out = await generateJson({ apiKey: 'k', system: 'sys', prompt: 'p', schema: CLASSIFY_SCHEMA, timeoutMs: 1000, fetchImpl });
    expect(out).toEqual({ a: 1 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    const body = JSON.parse(String(init!.body));
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(body.generationConfig.responseFormat.text.mimeType).toBe('APPLICATION_JSON');
    expect(body.systemInstruction.parts[0].text).toBe('sys');
    expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
  });

  it('maps 429 to rate_limited with the retry delay', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, headers: new Headers(), json: async () => ({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }] } }) }) as Response;
    await expect(generateJson({ apiKey: 'k', system: '', prompt: '', schema: {}, timeoutMs: 1000, fetchImpl }))
      .rejects.toMatchObject({ code: 'rate_limited', retryAfter: 12 });
  });

  it('times out', async () => {
    const fetchImpl = (_u: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const err = (await generateJson({ apiKey: "k", system: "", prompt: "", schema: {}, timeoutMs: 10, fetchImpl }).catch((e: unknown) => e)) as GeminiError;
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.code).toBe('timeout');
  });

  it('embeds each text separately at 768 dimensions', async () => {
    const v = Array(768).fill(0.1);
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ok({ embeddings: [{ values: v }, { values: v }] }));
    const out = await embedTexts({ apiKey: 'k', texts: ['a', 'b'], timeoutMs: 1000, fetchImpl });
    expect(out).toHaveLength(2);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]!.body));
    expect(body.requests[0]).toEqual({ model: 'models/gemini-embedding-2', content: { parts: [{ text: 'a' }] }, embedContentConfig: { outputDimensionality: 768 } });
    expect(toVectorLiteral([0.1234567, 1])).toBe('[0.123457,1]');
  });
});
