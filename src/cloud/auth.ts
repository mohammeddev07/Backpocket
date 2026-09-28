import type { User } from '@supabase/supabase-js';
import { CLOUD_CONFIGURED } from '../config';
import { getSupabase, hasStoredSession } from './supabase';

// Google sign-in (redirect flow, PKCE) and the current user.

export interface AuthUser { id: string; email: string | null; name: string | null }

type Listener = (u: AuthUser | null) => void;
let user: AuthUser | null = null;
const listeners = new Set<Listener>();

export interface CallbackInfo {
  /** The page was opened by the OAuth redirect (?code=… or ?error=…). */
  isCallback: boolean;
  error: string | null;
  /** The redirect landed in a different browser/app than the one that started it (typical on iOS home-screen apps). */
  wrongBrowser: boolean;
}
let callback: CallbackInfo = { isCallback: false, error: null, wrongBrowser: false };
export function oauthCallbackInfo(): CallbackInfo { return callback; }

const CALLBACK_PARAMS = ['code', 'error', 'error_code', 'error_description', 'state'];

export function currentUser(): AuthUser | null { return user; }
export function onAuthChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function toAuthUser(u: User | null | undefined): AuthUser | null {
  if (!u) return null;
  const meta = (u.user_metadata || {}) as Record<string, unknown>;
  return { id: u.id, email: u.email ?? null, name: (meta.full_name as string) || (meta.name as string) || null };
}

function setUser(next: AuthUser | null): void {
  if (next?.id === user?.id) { user = next; return; }
  user = next;
  // Outside the auth callback: supabase-js warns against awaiting its calls there.
  setTimeout(() => listeners.forEach((fn) => fn(user)), 0);
}

function stripCallbackParams(): void {
  const url = new URL(window.location.href);
  let changed = false;
  for (const k of CALLBACK_PARAMS) if (url.searchParams.has(k)) { url.searchParams.delete(k); changed = true; }
  if (url.hash.includes('access_token') || url.hash.includes('error')) { url.hash = ''; changed = true; }
  if (changed) window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}

/**
 * Loads Supabase only when needed (a saved session or an OAuth redirect) and
 * resolves with the signed-in user, or null for guests.
 */
export async function initAuth(): Promise<AuthUser | null> {
  if (!CLOUD_CONFIGURED) return null;
  const params = new URLSearchParams(window.location.search);
  const isCallback = params.has('code') || params.has('error');
  if (!isCallback && !hasStoredSession()) return null;

  const sb = await getSupabase();
  sb.auth.onAuthStateChange((_event, session) => setUser(toAuthUser(session?.user)));
  const { error } = await sb.auth.initialize();
  const { data } = await sb.auth.getSession();
  user = toAuthUser(data.session?.user);

  if (isCallback) {
    const err = params.get('error_description') || params.get('error') || (error ? error.message : null);
    const wrongBrowser = !!error && (error.name === 'AuthPKCECodeVerifierMissingError' || /code verifier/i.test(error.message));
    callback = { isCallback: true, error: user ? null : err, wrongBrowser: !user && wrongBrowser };
    stripCallbackParams();
  }
  return user;
}

export async function signInWithGoogle(): Promise<void> {
  const sb = await getSupabase();
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      // Back to the app's own URL (…/Backpocket/), which must be listed under
      // Auth → URL Configuration → Redirect URLs.
      redirectTo: window.location.origin + import.meta.env.BASE_URL,
      queryParams: { prompt: 'select_account' },
    },
  });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  const sb = await getSupabase();
  await sb.auth.signOut({ scope: 'local' });
  setUser(null);
}

export async function accessToken(): Promise<string | null> {
  if (!user) return null;
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}
