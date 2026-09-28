import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Folder, Kind, Link, Ms, Plan, RowByKind, Snapshot } from './types';

// The v2 local store: IndexedDB, one object store per table plus `meta`
// (settings, migration flags, sync cursors) and `outbox` (rows changed
// locally that still need pushing to Supabase).

export interface OutboxEntry {
  /** `${kind}:${id}` - repeated edits to one row collapse into one entry. */
  key: string;
  kind: Kind;
  id: string;
  at: Ms;
}

interface BackpocketDB extends DBSchema {
  folders: { key: string; value: Folder };
  links: { key: string; value: Link };
  plans: { key: string; value: Plan };
  meta: { key: string; value: unknown };
  outbox: { key: string; value: OutboxEntry };
}

export interface LocalDb {
  /** false when IndexedDB couldn't be opened and data only lives in memory. */
  readonly persistent: boolean;
  loadSnapshot(): Promise<Snapshot>;
  putRows<K extends Kind>(kind: K, rows: RowByKind[K][], outbox?: OutboxEntry[]): Promise<void>;
  /** Atomically replaces every row (and sets the given meta keys). */
  replaceSnapshot(snapshot: Snapshot, meta?: Record<string, unknown>): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  outboxAll(): Promise<OutboxEntry[]>;
  outboxRemove(entries: OutboxEntry[]): Promise<void>;
  outboxClear(): Promise<void>;
}

export const DB_NAME = 'backpocket';
const KINDS: Kind[] = ['folders', 'links', 'plans'];

export async function openLocalDb(name = DB_NAME): Promise<LocalDb> {
  let db: IDBPDatabase<BackpocketDB>;
  try {
    db = await openDB<BackpocketDB>(name, 1, {
      upgrade(d) {
        d.createObjectStore('folders', { keyPath: 'id' });
        d.createObjectStore('links', { keyPath: 'id' });
        d.createObjectStore('plans', { keyPath: 'id' });
        d.createObjectStore('meta');
        d.createObjectStore('outbox', { keyPath: 'key' });
      },
    });
  } catch {
    return memoryDb();
  }

  return {
    persistent: true,
    async loadSnapshot() {
      const tx = db.transaction(KINDS, 'readonly');
      const [folders, links, plans] = await Promise.all([
        tx.objectStore('folders').getAll(),
        tx.objectStore('links').getAll(),
        tx.objectStore('plans').getAll(),
      ]);
      await tx.done;
      return { folders, links, plans };
    },
    async putRows(kind, rows, outbox) {
      const tx = db.transaction([kind, 'outbox'] as Array<Kind | 'outbox'>, 'readwrite');
      const store = tx.objectStore(kind);
      for (const r of rows) void store.put(r as never);
      if (outbox) for (const e of outbox) void tx.objectStore('outbox').put(e);
      await tx.done;
    },
    async replaceSnapshot(snapshot, meta) {
      const tx = db.transaction([...KINDS, 'meta'] as Array<Kind | 'meta'>, 'readwrite');
      for (const k of KINDS) {
        const store = tx.objectStore(k);
        void store.clear();
        for (const r of snapshot[k]) void store.put(r as never);
      }
      if (meta) for (const [key, value] of Object.entries(meta)) void tx.objectStore('meta').put(value, key);
      await tx.done;
    },
    getMeta: (key) => db.get('meta', key) as never,
    async setMeta(key, value) { await db.put('meta', value, key); },
    outboxAll: () => db.getAll('outbox'),
    async outboxRemove(entries) {
      const tx = db.transaction('outbox', 'readwrite');
      // Only drop an entry if it wasn't re-queued (newer `at`) while pushing.
      for (const e of entries) {
        const cur = await tx.store.get(e.key);
        if (cur && cur.at <= e.at) await tx.store.delete(e.key);
      }
      await tx.done;
    },
    async outboxClear() { await db.clear('outbox'); },
  };
}

/** Fallback when IndexedDB is unavailable: works for the session, persists nothing. */
export function memoryDb(): LocalDb {
  const rows: Record<Kind, Map<string, unknown>> = { folders: new Map(), links: new Map(), plans: new Map() };
  const meta = new Map<string, unknown>();
  const outbox = new Map<string, OutboxEntry>();
  return {
    persistent: false,
    async loadSnapshot() {
      return {
        folders: [...rows.folders.values()] as Folder[],
        links: [...rows.links.values()] as Link[],
        plans: [...rows.plans.values()] as Plan[],
      };
    },
    async putRows(kind, list, ob) {
      for (const r of list) rows[kind].set(r.id, structuredClone(r));
      if (ob) for (const e of ob) outbox.set(e.key, e);
    },
    async replaceSnapshot(s, m) {
      for (const k of KINDS) { rows[k].clear(); for (const r of s[k]) rows[k].set(r.id, structuredClone(r)); }
      if (m) for (const [k, v] of Object.entries(m)) meta.set(k, v);
    },
    async getMeta(key) { return meta.get(key) as never; },
    async setMeta(key, value) { meta.set(key, value); },
    async outboxAll() { return [...outbox.values()]; },
    async outboxRemove(entries) {
      for (const e of entries) { const cur = outbox.get(e.key); if (cur && cur.at <= e.at) outbox.delete(e.key); }
    },
    async outboxClear() { outbox.clear(); },
  };
}
