// URL helpers for the save form and duplicate detection.

export type UrlInputResult = { url: string; error?: undefined } | { url?: undefined; error: string };

// Best-effort URL validation using the platform's own parser - accepts bare
// domains (prepends https://) but rejects obvious non-URLs like plain text.
export function normalizeUrlInput(raw: string): UrlInputResult {
  const v = raw.trim();
  if (!v) return { error: 'Paste a link first.' };
  let candidate = v;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = 'https://' + candidate;
  try {
    const u = new URL(candidate);
    if (!u.hostname || !u.hostname.includes('.')) return { error: "That doesn't look like a valid URL." };
    return { url: u.href };
  } catch {
    return { error: "That doesn't look like a valid URL." };
  }
}
