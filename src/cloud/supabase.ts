import type { SupabaseClient } from '@supabase/supabase-js';
import { CLOUD_CONFIGURED, SUPABASE_ANON_KEY, SUPABASE_URL } from '../config';

// The Supabase client is loaded on demand: guests who never sign in don't
// download or run it. The URL and anon/publishable key are public by design;
// what a signed-in user can touch is enforced by RLS.

export const AUTH_STORAGE_KEY = 'backpocket-auth';

let clientPromise: Promise<SupabaseClient> | null = null;

export function getSupabase(): Promise<SupabaseClient> {
  if (!CLOUD_CONFIGURED) return Promise.reject(new Error('Cloud features are not configured for this build.'));
  clientPromise ??= import('@supabase/supabase-js').then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: AUTH_STORAGE_KEY,
    },
  }));
  return clientPromise;
}

/** A session was saved earlier (so the client is worth loading at startup). */
export function hasStoredSession(): boolean {
  try { return !!localStorage.getItem(AUTH_STORAGE_KEY); } catch { return false; }
}

/** Edge Function URL, e.g. functionUrl('ai'). */
export function functionUrl(name: string): string {
  return SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/' + name;
}
