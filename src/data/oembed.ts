import type { PlatformLabel } from './types';

// Free title + thumbnail lookups. YouTube and TikTok both serve oEmbed with
// CORS headers, so the browser calls them directly (guests included).
// Instagram/Facebook oEmbed needs an app token, so they keep platform icons.

export interface EmbedInfo { title: string | null; thumbnailUrl: string | null }

export function oembedEndpoint(url: string, platform: PlatformLabel): string | null {
  const q = encodeURIComponent(url);
  if (platform === 'YouTube') return 'https://www.youtube.com/oembed?format=json&url=' + q;
  if (platform === 'TikTok') return 'https://www.tiktok.com/oembed?url=' + q;
  return null;
}

export function supportsOembed(platform: PlatformLabel): boolean {
  return platform === 'YouTube' || platform === 'TikTok';
}

/** Returns null when the provider has no data for this URL (or the call failed). */
export async function fetchOembed(url: string, platform: PlatformLabel, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<EmbedInfo | null> {
  const endpoint = oembedEndpoint(url, platform);
  if (!endpoint) return null;
  const f = opts.fetchImpl || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await f(endpoint, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) return null;
    const data = await res.json() as { title?: unknown; thumbnail_url?: unknown };
    const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 300) : null;
    const thumb = typeof data.thumbnail_url === 'string' && /^https:\/\//.test(data.thumbnail_url) ? data.thumbnail_url : null;
    return { title, thumbnailUrl: thumb };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
