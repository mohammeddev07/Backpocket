// Canonical form of a URL for duplicate detection (and links.normalized_url).
// Two shares of the same reel/video should normalise to the same string even
// when the apps add tracking params or use a short domain.

// Tracking params dropped everywhere.
const TRACKING_PARAMS = new Set([
  'igsh', 'igshid', 'si', 'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid',
  'feature', 'ref', 'ref_src', 'ref_url', 'share_id', 'sharer', 'mibextid', 'rdid', 'rcm',
]);

// Hosts where the query string never identifies the content, so all of it goes.
const DROP_ALL_QUERY = [/(^|\.)instagram\.com$/, /(^|\.)tiktok\.com$/, /(^|\.)threads\.net$/];

function stripHost(host: string): string {
  return host.toLowerCase().replace(/^(www|m|mobile)\./, '');
}

export function normalizeUrl(input: string): string {
  let u: URL;
  try { u = new URL(input.trim()); } catch { return input.trim().toLowerCase(); }

  let host = stripHost(u.hostname);
  let path = u.pathname;
  const params = new URLSearchParams(u.search);

  // YouTube: youtu.be/ID, /shorts/ID, /live/ID and /embed/ID all mean watch?v=ID.
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'music.youtube.com') {
    let id: string | null = null;
    if (host === 'youtu.be') id = path.split('/')[1] || null;
    else {
      const m = path.match(/^\/(shorts|live|embed|v)\/([^/?#]+)/);
      if (m) id = m[2];
      else if (path === '/watch') id = params.get('v');
    }
    if (id) {
      const keep = new URLSearchParams({ v: id });
      const list = params.get('list');
      if (list && !u.pathname.startsWith('/shorts')) keep.set('list', list);
      return 'youtube.com/watch?' + keep.toString();
    }
  }

  if (host === 'twitter.com') host = 'x.com';

  for (const key of [...params.keys()]) {
    const k = key.toLowerCase();
    if (k.startsWith('utm_') || TRACKING_PARAMS.has(k)) params.delete(key);
    // X/Twitter share params (?s=20&t=abc) carry no content.
    else if (host === 'x.com' && (k === 's' || k === 't')) params.delete(key);
  }
  if (DROP_ALL_QUERY.some((re) => re.test(host))) for (const key of [...params.keys()]) params.delete(key);

  path = path.replace(/\/+$/, '');
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const qs = new URLSearchParams(entries).toString();
  return host + path + (qs ? '?' + qs : '');
}
