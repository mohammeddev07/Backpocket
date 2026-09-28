import { getSupabase } from '../cloud/supabase';
import type { MergeOutcome } from './accountMerge';
import type { OutboxEntry } from './localStore';
import { INBOX_COLOR, INBOX_NAME } from './migrate';
import { store } from './store';
import { msFromIso, pullSince, upsertRows } from './supabaseStore';
import type { Kind, RowByKind, Snapshot } from './types';

// Offline-first sync. The UI only ever reads/writes the local store; this
// pushes the outbox (rows changed locally) and pulls rows changed on the
// server since the last cursor. Conflicts: last write wins, per row, by
// updated_at (enforced on the server by a trigger, and here on apply).

const KINDS: Kind[] = ['folders', 'links', 'plans'];
/** Re-read this much before the cursor, in case a slow transaction committed late. */
const OVERLAP_MS = 30_000;
const PERIODIC_MS = 90_000;
const META_LINKED = 'linkedUserId';
const cursorKey = (uid: string, kind: Kind) => `syncCursor:${uid}:${kind}`;

export type SyncStatus = 'local' | 'signed-out' | 'pending-link' | 'syncing' | 'synced' | 'offline' | 'error';
export interface SyncState { status: SyncStatus; lastSyncedAt: number | null; message?: string }

let state: SyncState = { status: 'local', lastSyncedAt: null };
const listeners = new Set<(s: SyncState) => void>();
export function syncState(): SyncState { return state; }
export function onSyncState(fn: (s: SyncState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function setSyncState(patch: Partial<SyncState>): void {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn(state));
}

let activeUser: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let queued = false;
let failures = 0;

export async function linkedUserId(): Promise<string | null> {
  return (await store.db.getMeta<string | null>(META_LINKED)) ?? null;
}

/** The account's complete data plus the cursors to continue from. */
export interface AccountData { snapshot: Snapshot; cursors: Record<Kind, string | null> }

export async function fetchAccount(): Promise<AccountData> {
  const sb = await getSupabase();
  const snapshot: Snapshot = { folders: [], links: [], plans: [] };
  const cursors = { folders: null, links: null, plans: null } as Record<Kind, string | null>;
  for (const kind of KINDS) {
    cursors[kind] = await pullSince(sb, kind, null, (rows) => { (snapshot[kind] as RowByKind[typeof kind][]).push(...rows); });
  }
  return { snapshot, cursors };
}

async function pushSnapshot(userId: string, s: Snapshot): Promise<void> {
  const sb = await getSupabase();
  // Folders first, so links never reference a folder the server hasn't seen.
  for (const kind of KINDS) await upsertRows(sb, kind, s[kind] as never, userId);
}

/**
 * Makes this device mirror the account. With a merge outcome (guest upload),
 * the new rows are uploaded first and the local data is only replaced once
 * that succeeded - if the upload fails, nothing local changes.
 */
export async function adoptAccount(userId: string, account: AccountData, merge?: MergeOutcome): Promise<void> {
  const snapshot = merge ? merge.merged : account.snapshot;
  const upload: Snapshot = merge ? merge.upload : { folders: [], links: [], plans: [] };
  if (!snapshot.folders.some((f) => f.isSystem && f.deletedAt == null)) {
    const now = Date.now();
    const inbox = { id: userId, parentId: null, name: INBOX_NAME, color: INBOX_COLOR, isSystem: true, position: 0, createdAt: now, updatedAt: now, deletedAt: null };
    snapshot.folders.push(inbox);
    upload.folders.push(inbox);
  }
  await pushSnapshot(userId, upload);
  await store.db.outboxClear();
  await store.replaceAll(snapshot);
  await store.db.setMeta(META_LINKED, userId);
  for (const kind of KINDS) await store.db.setMeta(cursorKey(userId, kind), account.cursors[kind]);
  startSync(userId);
}

/** Forget the account link (sign out and wipe, account deleted). Local rows stay unless replaced. */
export async function unlinkAccount(): Promise<void> {
  const uid = await linkedUserId();
  await store.db.setMeta(META_LINKED, null);
  if (uid) for (const kind of KINDS) await store.db.setMeta(cursorKey(uid, kind), null);
  await store.db.outboxClear();
  store.trackOutbox = false;
}

export function startSync(userId: string): void {
  activeUser = userId;
  store.trackOutbox = true;
  failures = 0;
  requestSync(0);
}

export function stopSync(status: 'local' | 'signed-out' | 'pending-link', message?: string): void {
  activeUser = null;
  clearTimeout(timer);
  setSyncState({ status, message });
}

/** Debounced: many edits in a row become one sync. */
export function requestSync(delayMs = 1500): void {
  if (!activeUser) return;
  clearTimeout(timer);
  timer = setTimeout(() => void run(), delayMs);
}

/** Runs a sync right away, after any sync already in flight (tests, "Retry"). */
export async function syncNow(): Promise<void> {
  clearTimeout(timer);
  if (inflight) await inflight;
  await run();
}

let inflight: Promise<void> | null = null;
function run(): Promise<void> {
  if (!activeUser) return Promise.resolve();
  if (inflight) { queued = true; return inflight; }
  inflight = runOnce().finally(() => {
    inflight = null;
    if (queued) { queued = false; requestSync(300); }
  });
  return inflight;
}

async function runOnce(): Promise<void> {
  if (!navigator.onLine) { setSyncState({ status: 'offline', message: undefined }); return; }
  setSyncState({ status: 'syncing', message: undefined });
  try {
    await push();
    await pull();
    failures = 0;
    setSyncState({ status: 'synced', lastSyncedAt: Date.now(), message: undefined });
  } catch (e) {
    failures++;
    const offline = !navigator.onLine || (e instanceof TypeError && /fetch|network/i.test(e.message));
    setSyncState({ status: offline ? 'offline' : 'error', message: offline ? undefined : (e as Error)?.message });
    // Back off: 15s, 30s, 60s … capped at 5 min.
    if (activeUser) timer = setTimeout(() => void run(), Math.min(300_000, 15_000 * 2 ** (failures - 1)));
  }
}

async function push(): Promise<void> {
  const uid = activeUser!;
  const entries = await store.db.outboxAll();
  if (!entries.length) return;
  const sb = await getSupabase();
  for (const kind of KINDS) {
    const mine = entries.filter((e) => e.kind === kind);
    if (!mine.length) continue;
    const map = store.map(kind);
    const rows = mine.map((e) => map.get(e.id)).filter((r): r is NonNullable<typeof r> => !!r);
    await upsertRows(sb, kind, rows as never, uid);
    await store.db.outboxRemove(mine);
  }
}

async function pull(): Promise<void> {
  const uid = activeUser!;
  const sb = await getSupabase();
  const pending = new Set((await store.db.outboxAll()).map((e) => e.key));
  for (const kind of KINDS) {
    const cursor = await store.db.getMeta<string | null>(cursorKey(uid, kind));
    const cursorMs = msFromIso(cursor);
    const since = cursorMs != null ? new Date(cursorMs - OVERLAP_MS).toISOString() : null;
    const newest = await pullSince(sb, kind, since, (rows) => applyIncoming(kind, rows, pending));
    if (newest && newest !== cursor) await store.db.setMeta(cursorKey(uid, kind), newest);
    if (activeUser !== uid) return; // signed out mid-sync
  }
}

function applyIncoming<K extends Kind>(kind: K, rows: RowByKind[K][], pending: Set<string>): void {
  const map = store.map(kind);
  const accept: RowByKind[K][] = [];
  const requeue: OutboxEntry[] = [];
  for (const r of rows) {
    const cur = map.get(r.id);
    if (!cur || r.updatedAt > cur.updatedAt) accept.push(r);
    // The server holds an older version and nothing is queued: our newer local
    // edit never made it up (e.g. made while signed out) - push it again.
    else if (r.updatedAt < cur.updatedAt && !pending.has(kind + ':' + r.id)) {
      requeue.push({ key: kind + ':' + r.id, kind, id: r.id, at: Date.now() });
    }
  }
  store.applyRemote(kind, accept);
  if (requeue.length) void store.db.putRows(kind, [], requeue).then(() => requestSync(1000));
}

let triggersInstalled = false;
/** Sync on regaining focus, on coming back online, after local edits, and gently while open. */
export function installSyncTriggers(): void {
  if (triggersInstalled) return;
  triggersInstalled = true;
  let lastFocusSync = 0;
  const onFocus = () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastFocusSync < 5000) return;
    lastFocusSync = Date.now();
    requestSync(0);
  };
  window.addEventListener('online', () => requestSync(0));
  window.addEventListener('offline', () => { if (activeUser) setSyncState({ status: 'offline' }); });
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  store.subscribe((c) => { if (!c.remote && c.kind !== 'settings') requestSync(1500); });
  setInterval(() => { if (document.visibilityState === 'visible') requestSync(0); }, PERIODIC_MS);
}
