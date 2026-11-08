import { describe, expect, it } from 'vitest';
import {
  currentQuota, fetchMicrolink, isCacheableThumb, isExpiringThumb, microlinkEndpoint, parseMicrolink,
  quotaAllows, quotaBlock, quotaSpend, usesMicrolink,
} from './preview';

const ok = (data: Record<string, unknown>) => ({ status: 'success', data });

describe('parseMicrolink', () => {
  it('keeps a real post', () => {
    expect(parseMicrolink(ok({
      title: '  Chef Ana on Instagram:\n "Five-minute pasta"  ',
      description: 'The quickest weeknight dinner.',
      image: { url: 'https://scontent.cdninstagram.com/v/t51/abc.jpg?oe=1' },
      logo: { url: 'https://static.cdninstagram.com/logo.png' },
    }))).toEqual({
      title: 'Chef Ana on Instagram: "Five-minute pasta"',
      description: 'The quickest weeknight dinner.',
      thumbnailUrl: 'https://scontent.cdninstagram.com/v/t51/abc.jpg?oe=1',
    });
  });

  it('drops login-wall filler', () => {
    expect(parseMicrolink(ok({
      title: 'Instagram', description: 'Create an account or log in to Instagram - share what you are into.',
      image: { url: 'https://static.cdninstagram.com/logo.png' }, logo: { url: 'https://static.cdninstagram.com/logo.png' },
    }))).toBeNull();
    expect(parseMicrolink(ok({ title: 'Facebook - log in or sign up', description: 'See posts, photos and more on Facebook.' }))).toBeNull();
    expect(parseMicrolink(ok({ title: 'Log in or sign up to view' }))).toBeNull();
  });

  it('keeps the useful half of a partial reply', () => {
    expect(parseMicrolink(ok({ title: 'Facebook', image: { url: 'https://scontent.fbcdn.net/v/p.jpg' } })))
      .toEqual({ title: null, description: null, thumbnailUrl: 'https://scontent.fbcdn.net/v/p.jpg' });
    expect(parseMicrolink(ok({ title: 'How to bake bread', description: 'How to bake bread' })))
      .toEqual({ title: 'How to bake bread', description: null, thumbnailUrl: null });
  });

  it('rejects failures, non-https images and junk', () => {
    expect(parseMicrolink({ status: 'fail', data: {} })).toBeNull();
    expect(parseMicrolink(null)).toBeNull();
    expect(parseMicrolink(ok({ image: { url: 'http://insecure.example/x.jpg' } }))).toBeNull();
    expect(parseMicrolink(ok({ title: 'x'.repeat(500) }))?.title).toHaveLength(300);
  });
});

describe('daily budget', () => {
  const now = new Date(2026, 10, 8, 15, 0).getTime();

  it('starts fresh each day and counts calls', () => {
    let q = currentQuota(undefined, now);
    expect(q).toMatchObject({ used: 0, blockedUntil: 0 });
    q = quotaSpend(quotaSpend(q));
    expect(quotaAllows(q, now, 2)).toBe(false);
    expect(quotaAllows(q, now, 3)).toBe(true);
    expect(currentQuota(q, now + 86_400_000).used).toBe(0);
  });

  it('blocks until local midnight after a 429', () => {
    const q = quotaBlock(currentQuota(null, now), now);
    expect(quotaAllows(q, now, 20)).toBe(false);
    const midnight = new Date(2026, 10, 9, 0, 0).getTime();
    expect(q.blockedUntil).toBe(midnight);
    expect(quotaAllows(currentQuota(q, midnight + 1), midnight + 1, 20)).toBe(true);
  });
});

describe('fetchMicrolink', () => {
  const res = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('reports a rate limit', async () => {
    const r = await fetchMicrolink('https://x.com/a/status/1', { fetchImpl: () => res(429, { status: 'fail', code: 'ERATE' }) });
    expect(r).toEqual({ info: null, rateLimited: true, failed: false });
  });

  it('treats network errors as retryable and 4xx as "no data"', async () => {
    expect((await fetchMicrolink('https://a.b', { fetchImpl: () => Promise.reject(new Error('offline')) })).failed).toBe(true);
    expect(await fetchMicrolink('https://a.b', { fetchImpl: () => res(400, { status: 'fail' }) }))
      .toEqual({ info: null, rateLimited: false, failed: false });
  });

  it('asks without credentials or referrer', async () => {
    let seen: RequestInit | undefined;
    let seenUrl = '';
    await fetchMicrolink('https://example.com/p?q=1', {
      fetchImpl: (u, init) => { seenUrl = String(u); seen = init; return res(200, ok({ title: 'Hi' })); },
    });
    expect(seenUrl).toBe(microlinkEndpoint('https://example.com/p?q=1'));
    expect(seen).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  });
});

describe('platform and thumbnail helpers', () => {
  it('routes only platforms without oEmbed to Microlink', () => {
    expect(['Instagram', 'Facebook', 'X', 'Link'].every((p) => usesMicrolink(p as never))).toBe(true);
    expect(usesMicrolink('YouTube')).toBe(false);
    expect(usesMicrolink('TikTok')).toBe(false);
  });

  it('knows which thumbnails expire and which are cached', () => {
    expect(isExpiringThumb('https://scontent-lhr8-1.cdninstagram.com/v/x.jpg')).toBe(true);
    expect(isExpiringThumb('https://scontent.xx.fbcdn.net/v/x.jpg')).toBe(true);
    expect(isExpiringThumb('https://i.ytimg.com/vi/a/hqdefault.jpg')).toBe(false);
    expect(isCacheableThumb(new URL('https://i.ytimg.com/vi/a/hqdefault.jpg'))).toBe(true);
    expect(isCacheableThumb(new URL('https://p16-sign.tiktokcdn-us.com/x.jpg'))).toBe(true);
    expect(isCacheableThumb(new URL('https://scontent.cdninstagram.com/x.jpg'))).toBe(false);
  });
});
