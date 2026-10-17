// URL helpers for the save form and duplicate detection.

export type UrlInputResult = { url: string; error?: undefined } | { url?: undefined; error: string };

/**
 * Only web links are saved or opened. javascript:, data:, file: and friends
 * would run or load things inside the app (bookmark exports are full of
 * javascript: bookmarklets), so they're refused on the way in and out.
 */
export function isWebUrl(url: string): boolean {
  try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
}

// Best-effort URL validation using the platform's own parser - accepts bare
// domains (prepends https://) but rejects obvious non-URLs like plain text.
export function normalizeUrlInput(raw: string): UrlInputResult {
  const v = raw.trim();
  if (!v) return { error: 'Paste a link first.' };
  let candidate = v;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = 'https://' + candidate;
  try {
    const u = new URL(candidate);
    if (!isWebUrl(u.href)) return { error: 'Only web links (starting with http or https) can be saved.' };
    if (!u.hostname || !u.hostname.includes('.')) return { error: "That doesn't look like a valid URL." };
    return { url: u.href };
  } catch {
    return { error: "That doesn't look like a valid URL." };
  }
}
