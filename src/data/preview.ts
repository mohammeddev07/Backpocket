import type { PlatformLabel } from './types';

// Link previews from Microlink (https://microlink.io) for the platforms with
// no CORS oEmbed: Instagram, Facebook, X and plain web links. Only the free,
// keyless endpoint is used. It can't bill anyone; when its daily quota (25
// per IP) runs out it answers 429. We stay below that with our own daily
// budget and stop for the day on the first 429.
// Pure (no DOM), so the service worker can import the thumbnail helpers.

export interface PreviewInfo { title: string | null; description: string | null; thumbnailUrl: string | null }

/** IndexedDB meta key for the daily budget. */
export const PREVIEW_QUOTA_KEY = 'previewQuota';
export interface PreviewQuota { day: string; used: number; blockedUntil: number }

export const DESCRIPTION_MAX = 1000;

export function usesMicrolink(platform: PlatformLabel): boolean {
  return platform === 'Instagram' || platform === 'Facebook' || platform === 'X' || platform === 'Link';
}

export function microlinkEndpoint(url: string): string {
  // Turn off the extras: they cost Microlink time and we'd throw them away.
  return 'https://api.microlink.io/?url=' + encodeURIComponent(url) +
    '&palette=false&audio=false&video=false&iframe=false&screenshot=false';
}

// ---- Daily budget ----
export function localDay(now: number): string {
  const d = new Date(now);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function nextMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** Normalises whatever was stored (or nothing) to today's counter. */
export function currentQuota(stored: unknown, now: number): PreviewQuota {
  const q = stored as Partial<PreviewQuota> | null | undefined;
  const day = localDay(now);
  const blockedUntil = typeof q?.blockedUntil === 'number' && q.blockedUntil > now ? q.blockedUntil : 0;
  const used = q?.day === day && typeof q.used === 'number' && q.used >= 0 ? q.used : 0;
  return { day, used, blockedUntil };
}

export function quotaAllows(q: PreviewQuota, now: number, budget: number): boolean {
  return q.blockedUntil <= now && q.used < budget;
}

export function quotaSpend(q: PreviewQuota): PreviewQuota {
  return { ...q, used: q.used + 1 };
}

/** After a 429: no more calls until local midnight. */
export function quotaBlock(q: PreviewQuota, now: number): PreviewQuota {
  return { ...q, blockedUntil: nextMidnight(now) };
}

// ---- Parsing ----
const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

// What Instagram/Facebook/X serve to logged-out visitors instead of the post.
const GENERIC_TITLES = new Set([
  'instagram', 'facebook', 'x', 'twitter', 'log in', 'login', 'log in or sign up to view',
  'facebook - log in or sign up', 'log into facebook', 'instagram photos and videos',
  'x. it’s what’s happening / x', "x. it's what's happening / x", 'page not found', 'error',
]);
const GENERIC_DESCRIPTION = /^(see posts, photos and more on facebook|create an account or log in to instagram|log in to facebook|from breaking news and entertainment to sports and politics)/i;

export function isGenericTitle(title: string): boolean {
  const t = title.toLowerCase().replace(/[•|]/g, ' ').replace(/\s+/g, ' ').trim();
  return GENERIC_TITLES.has(t) || /^(log in|sign up)\b/.test(t);
}

/** The useful parts of a Microlink reply, or null when it only had login-wall filler. */
export function parseMicrolink(json: unknown): PreviewInfo | null {
  const o = json as { status?: unknown; data?: Record<string, unknown> } | null;
  if (!o || o.status !== 'success' || !o.data || typeof o.data !== 'object') return null;
  const d = o.data;
  let title = clean(d.title, 300);
  if (title && isGenericTitle(title)) title = null;
  let description = clean(d.description, DESCRIPTION_MAX);
  if (description && GENERIC_DESCRIPTION.test(description)) description = null;
  if (description && title && description === title) description = null;
  const image = (d.image as { url?: unknown } | null)?.url;
  const logo = (d.logo as { url?: unknown } | null)?.url;
  // A site's logo standing in for the post's image is not a thumbnail.
  const thumbnailUrl = typeof image === 'string' && /^https:\/\//.test(image) && image !== logo ? image : null;
  if (!title && !description && !thumbnailUrl) return null;
  return { title, description, thumbnailUrl };
}

export interface MicrolinkResult { info: PreviewInfo | null; rateLimited: boolean; failed: boolean }

/** Never throws. `failed` means a network error or timeout (worth retrying later); a clean "no data" is not a failure. */
export async function fetchMicrolink(url: string, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<MicrolinkResult> {
  const f = opts.fetchImpl || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 6000);
  try {
    const res = await f(microlinkEndpoint(url), { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (res.status === 429) return { info: null, rateLimited: true, failed: false };
    if (res.status >= 500) return { info: null, rateLimited: false, failed: true };
    const body = await res.json().catch(() => null) as { code?: unknown } | null;
    if (body && body.code === 'ERATE') return { info: null, rateLimited: true, failed: false };
    return { info: res.ok ? parseMicrolink(body) : null, rateLimited: false, failed: false };
  } catch {
    return { info: null, rateLimited: false, failed: true };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Thumbnails ----
/** Hosts the service worker caches; they send CORS headers, so <img> asks with crossOrigin. */
export function isCacheableThumb(u: URL): boolean {
  return u.hostname === 'i.ytimg.com' || /(^|\.)tiktokcdn(-[a-z]+)?\.com$/.test(u.hostname);
}

/** Instagram/Facebook image links are signed and stop working after a while. */
export function isExpiringThumb(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return /(^|\.)cdninstagram\.com$/.test(h) || /(^|\.)fbcdn\.net$/.test(h);
  } catch {
    return false;
  }
}
