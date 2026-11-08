import type { FaviconProvider } from './platform';
import { REVISIT_MIN_AGE_DAYS } from './search/filters';

// Client configuration. AI limits and model ids live in
// supabase/functions/_shared/config.ts (shared with the Edge Function).

export const APP_CONFIG = {
  /** "Revisit" shows unopened links saved at least this long ago. */
  revisitMinAgeDays: REVISIT_MIN_AGE_DAYS,
  oembedTimeoutMs: 4000,
  /** Existing YouTube/TikTok links to backfill thumbnails for per app load. */
  oembedBackfillPerLoad: 30,
  /** Link previews for Instagram, Facebook, X and web links. 'off' stops every Microlink call. */
  previewProvider: 'microlink' as 'microlink' | 'off',
  /** Our own cap on Microlink calls per device per day (its free keyless tier allows ~25 per IP). */
  previewDailyBudget: 20,
  /** Backfilling old links stops while fewer than this many calls are left, so new saves still get previews. */
  previewBackfillReserve: 8,
  /** Existing links without a preview to look up per app load. */
  previewBackfillPerLoad: 3,
  previewTimeoutMs: 6000,
  /** Also fetch YouTube descriptions (for the AI) on new saves while budget lasts. */
  previewDescribeYouTube: true,
  /** Who gets asked for site icons. Only the hostname is ever sent. */
  faviconProvider: 'duckduckgo' as FaviconProvider,
};

// Public by design: the anon key only grants what RLS policies allow.
export const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || '';
export const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || '';
export const CLOUD_CONFIGURED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
