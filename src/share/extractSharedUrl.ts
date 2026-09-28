// Android share sheet (Web Share Target - see share_target in
// public/manifest.webmanifest) and the iOS Shortcut / bookmarklet, which open
// the same ?url=&text=&title= link.
//
// Apps disagree on where the link goes: Chrome maps Android's EXTRA_TEXT to
// `text`, so Instagram/YouTube/Facebook usually send a bare URL there,
// TikTok/X often wrap it in a caption ("Check out … https://…"), and only
// some apps fill `url`. Check all three and take the first valid http(s) link.
//
// Ported unchanged from the v1 single-file app; share.test.ts checks it
// against a verbatim copy of the original.

export const SHARE_PARAMS = ['url', 'text', 'title'] as const;
const URL_IN_TEXT = /https?:\/\/[^\s<>"]+/gi;
const TRAILING_PUNCT = /[.,;:!?'’”»…]$/;
const CLOSER_TO_OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

// Trim prose punctuation the regex swallowed ("…at https://x.com/a." or
// "(https://…)") while keeping balanced parens like /wiki/Foo_(bar).
export function trimSharedUrl(s: string): string {
  for (;;) {
    const last = s.slice(-1);
    const opener = CLOSER_TO_OPENER[last];
    if (TRAILING_PUNCT.test(last)) { s = s.slice(0, -1); continue; }
    if (opener && s.split(opener).length < s.split(last).length) { s = s.slice(0, -1); continue; }
    return s;
  }
}

export function firstSharedUrl(values: ReadonlyArray<string | null | undefined>): string | null {
  for (const value of values) {
    if (!value) continue;
    for (const m of value.matchAll(URL_IN_TEXT)) {
      try {
        const u = new URL(trimSharedUrl(m[0]));
        if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.')) return u.href;
      } catch { /* not a URL - try the next match */ }
    }
  }
  return null;
}

export interface SharedPayload {
  /** First valid http(s) URL found in url, text, then title - or null. */
  url: string | null;
  /** The shared `title`, trimmed. */
  title: string;
  /** The shared `text`, trimmed (often a caption wrapping the link). */
  text: string;
  /** location.search with only the share params removed ('' or '?a=b'). */
  cleanedSearch: string;
}

/** Parses share params out of a query string. Returns null for normal loads. */
export function parseSharePayload(search: string): SharedPayload | null {
  const params = new URLSearchParams(search);
  if (!SHARE_PARAMS.some((k) => params.has(k))) return null;

  const title = (params.get('title') || '').trim();
  const text = (params.get('text') || '').trim();
  const url = firstSharedUrl(SHARE_PARAMS.map((k) => params.get(k)));

  // Drop the share params so reload/back doesn't re-apply them; keep anything else.
  SHARE_PARAMS.forEach((k) => params.delete(k));
  const qs = params.toString();
  return { url, title, text, cleanedSearch: qs ? '?' + qs : '' };
}

/**
 * Reads the share params from the current location and removes them from the
 * address bar with history.replaceState. Returns null when the page wasn't
 * opened from a share.
 */
export function consumeSharePayload(win: Window = window): SharedPayload | null {
  const payload = parseSharePayload(win.location.search);
  if (!payload) return null;
  win.history.replaceState(win.history.state, '',
    win.location.pathname + payload.cleanedSearch + win.location.hash);
  return payload;
}

/** v1 rule: a shared title becomes the note/title unless it's just a bare URL. */
export function usableSharedTitle(title: string): string {
  return title && !/^https?:\/\/\S+$/i.test(title) ? title : '';
}
