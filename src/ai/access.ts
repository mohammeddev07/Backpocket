import { CLOUD_CONFIGURED } from '../config';
import type { AuthUser } from '../cloud/auth';
import { store } from '../data/store';
import { hasByokKey } from './byok';

// Who may use AI, and how:
//  guest       - not signed in: no AI ("Sign in to use AI")
//  server      - allowlisted: calls go through the Edge Function (project key)
//  byok        - not allowlisted, has their own key: browser -> Gemini directly
//  needs-key   - not allowlisted, no key yet: offer "Use your own free Gemini key"
//  unavailable - this build has no Supabase config

export type AiMode = 'unavailable' | 'guest' | 'checking' | 'server' | 'byok' | 'needs-key';

const ACCESS_CACHE_MS = 12 * 3600_000;
const cacheKey = (uid: string) => 'backpocket_ai_access:' + uid;

let mode: AiMode = CLOUD_CONFIGURED ? 'guest' : 'unavailable';
let userId: string | null = null;
const listeners = new Set<(m: AiMode) => void>();

export function aiMode(): AiMode { return mode; }
export function onAiModeChange(fn: (m: AiMode) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function set(next: AiMode): void {
  if (next === mode) return;
  mode = next;
  listeners.forEach((fn) => fn(mode));
}

/** AI can run right now (access + the user's on/off toggle). */
export function aiReady(): boolean {
  return (mode === 'server' || mode === 'byok') && store.settings.aiEnabled;
}

function readCache(uid: string): 'server' | 'not_allowlisted' | null {
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey(uid)) || 'null') as { mode: 'server' | 'not_allowlisted'; at: number } | null;
    return c && Date.now() - c.at < ACCESS_CACHE_MS ? c.mode : null;
  } catch { return null; }
}
function writeCache(uid: string, m: 'server' | 'not_allowlisted'): void {
  try { localStorage.setItem(cacheKey(uid), JSON.stringify({ mode: m, at: Date.now() })); } catch { /* ignore */ }
}

function fromAllowlist(listed: boolean): AiMode {
  return listed ? 'server' : (hasByokKey() ? 'byok' : 'needs-key');
}

/** Re-evaluates access for the signed-in user (cached for 12 h). */
export async function refreshAiAccess(user: AuthUser | null, force = false): Promise<void> {
  if (!CLOUD_CONFIGURED) { set('unavailable'); return; }
  userId = user?.id ?? null;
  if (!user) { set('guest'); return; }
  const cached = force ? null : readCache(user.id);
  if (cached) { set(fromAllowlist(cached === 'server')); return; }
  set('checking');
  try {
    const { serverCall, AiError } = await import('./client');
    try {
      await serverCall('status', {} as Record<string, never>);
      writeCache(user.id, 'server');
      set('server');
    } catch (e) {
      if (e instanceof AiError && e.code === 'not_allowlisted') {
        writeCache(user.id, 'not_allowlisted');
        set(fromAllowlist(false));
      } else {
        // Offline or server trouble: fall back to a key if there is one.
        set(hasByokKey() ? 'byok' : 'needs-key');
      }
    }
  } catch {
    set(hasByokKey() ? 'byok' : 'needs-key');
  }
}

/** The server said 403 not_allowlisted mid-session (e.g. removed from the list). */
export function markNotAllowlisted(): void {
  if (userId) writeCache(userId, 'not_allowlisted');
  set(fromAllowlist(false));
}

/** After the user adds or removes their own key. */
export function byokKeyChanged(): void {
  if (mode === 'guest' || mode === 'unavailable' || mode === 'server') return;
  set(hasByokKey() ? 'byok' : 'needs-key');
}
