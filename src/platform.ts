import type { PlatformLabel } from './data/types';

// Substring checks carried over from v1 (so existing links keep the same label).
export function detectPlatform(url: string): PlatformLabel {
  const u = url.toLowerCase();
  if (u.includes('instagram.com')) return 'Instagram';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
  if (u.includes('facebook.com') || u.includes('fb.watch')) return 'Facebook';
  if (u.includes('tiktok.com')) return 'TikTok';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'X';
  return 'Link';
}

export const PLATFORMS: PlatformLabel[] = ['Instagram', 'YouTube', 'Facebook', 'TikTok', 'X', 'Link'];

const PLATFORM_COLORS: Record<PlatformLabel, string> = {
  Instagram: '#c1387e', YouTube: '#d1372e', Facebook: '#3266a8',
  TikTok: '#1f9e9e', X: 'var(--platform-x)', Link: '#8b93a1',
};
export function platformColor(label: string): string {
  return PLATFORM_COLORS[label as PlatformLabel] || PLATFORM_COLORS.Link;
}
// color-mix (not hex+alpha) so theme-dependent colours like var(--platform-x) tint too.
export function platformTint(label: string): string {
  return 'color-mix(in srgb, ' + platformColor(label) + ' 14%, transparent)';
}

const PLATFORM_ICONS: Record<PlatformLabel, string> = {
  Instagram: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1"/></svg>',
  YouTube: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"><rect x="2.5" y="5.5" width="19" height="13" rx="3.5"/><path d="M10.5 9.5v5l4.5-2.5z" fill="currentColor" stroke="none"/></svg>',
  Facebook: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M15 8.5h-2a2 2 0 0 0-2 2V21M9 13h4M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"/></svg>',
  TikTok: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4v10.5a3.5 3.5 0 1 1-3.5-3.5M14 4a4.5 4.5 0 0 0 4.5 4.5V10A6.5 6.5 0 0 1 14 8.2"/></svg>',
  X: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l16 16M20 4 4 20"/></svg>',
  Link: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7a5 5 0 0 1 0-10h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8"/></svg>',
};
export function platformIconSvg(label: string): string {
  return PLATFORM_ICONS[label as PlatformLabel] || PLATFORM_ICONS.Link;
}

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

// Re-use already-loaded favicon <img>s across re-renders. Fresh <img>s blink
// empty for a frame while they decode, even from cache, so every search
// keystroke made the icon column flicker.
const faviconCache = new Map<string, HTMLImageElement>();
export function faviconFor(linkId: string, url: string, platform: string): HTMLImageElement {
  const src = 'https://www.google.com/s2/favicons?sz=64&domain_url=' + encodeURIComponent(url);
  const key = linkId + ' ' + src;
  const cached = faviconCache.get(key);
  if (cached && cached.complete && cached.naturalWidth > 0) return cached;
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.onerror = () => {
    faviconCache.delete(key);
    const fallback = document.createElement('span');
    fallback.innerHTML = platformIconSvg(platform);
    if (fallback.firstChild) img.replaceWith(fallback.firstChild);
  };
  img.src = src;
  faviconCache.set(key, img);
  return img;
}

// ---- Device detection (used for iOS share help and the OAuth standalone check) ----
export function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac; touch points give it away.
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
