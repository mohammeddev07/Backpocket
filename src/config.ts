// Client configuration. AI limits and model ids live in
// supabase/functions/_shared/config.ts (shared with the Edge Function).

export const APP_CONFIG = {
  /** "Revisit" shows unopened links saved at least this long ago. */
  revisitMinAgeDays: 7,
  oembedTimeoutMs: 4000,
  /** Existing YouTube/TikTok links to backfill thumbnails for per app load. */
  oembedBackfillPerLoad: 30,
};

// Public by design: the anon key only grants what RLS policies allow.
export const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || '';
export const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || '';
export const CLOUD_CONFIGURED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
