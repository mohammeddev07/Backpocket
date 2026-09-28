import { describe, expect, it, vi } from 'vitest';
import { fetchOembed, oembedEndpoint } from './oembed';

const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

describe('oembed', () => {
  it('only YouTube and TikTok have endpoints', () => {
    expect(oembedEndpoint('https://youtu.be/x', 'YouTube')).toContain('youtube.com/oembed');
    expect(oembedEndpoint('https://www.tiktok.com/@a/video/1', 'TikTok')).toContain('tiktok.com/oembed');
    expect(oembedEndpoint('https://instagram.com/reel/x', 'Instagram')).toBeNull();
  });

  it('returns title and https thumbnail', async () => {
    const fetchImpl = vi.fn(async () => json({ title: ' A video ', thumbnail_url: 'https://i.ytimg.com/vi/x/hq.jpg' }));
    expect(await fetchOembed('https://youtu.be/x', 'YouTube', { fetchImpl })).toEqual({ title: 'A video', thumbnailUrl: 'https://i.ytimg.com/vi/x/hq.jpg' });
  });

  it('rejects non-https thumbnails and handles errors', async () => {
    expect(await fetchOembed('https://youtu.be/x', 'YouTube', { fetchImpl: async () => json({ thumbnail_url: 'javascript:alert(1)' }) }))
      .toEqual({ title: null, thumbnailUrl: null });
    expect(await fetchOembed('https://youtu.be/x', 'YouTube', { fetchImpl: async () => json({}, false) })).toBeNull();
    expect(await fetchOembed('https://youtu.be/x', 'YouTube', { fetchImpl: async () => { throw new Error('offline'); } })).toBeNull();
  });
});
