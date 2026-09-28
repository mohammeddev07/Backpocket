import type { LocalDb, OutboxEntry } from './localStore';
import {
  DEFAULT_SETTINGS, type Folder, type Kind, type Link, type Plan, type RowByKind, type Settings, type Snapshot,
} from './types';

export interface Change { kind: Kind | 'settings' | 'all'; ids: string[]; remote: boolean }
type Listener = (c: Change) => void;

// In-memory copy of the local database. The UI reads from here synchronously
// and every write goes to IndexedDB in the background (the same shape v1 had
// with localStorage, so screens don't wait on storage).
export class Store {
  folders = new Map<string, Folder>();
  links = new Map<string, Link>();
  plans = new Map<string, Plan>();
  settings: Settings = { ...DEFAULT_SETTINGS };
  /** Queue local writes for sync (only while signed in to a linked account). */
  trackOutbox = false;
  onPersistError: (e: unknown) => void = () => {};
  private listeners = new Set<Listener>();
  private _db: LocalDb | null = null;

  get db(): LocalDb {
    if (!this._db) throw new Error('store not initialised');
    return this._db;
  }

  async init(db: LocalDb): Promise<void> {
    this._db = db;
    this.setSnapshot(await db.loadSnapshot());
    const saved = await db.getMeta<Partial<Settings>>('settings');
    this.settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  }

  private setSnapshot(s: Snapshot): void {
    this.folders = new Map(s.folders.map((f) => [f.id, f]));
    this.links = new Map(s.links.map((l) => [l.id, l]));
    this.plans = new Map(s.plans.map((p) => [p.id, p]));
  }

  snapshot(includeDeleted = false): Snapshot {
    const keep = <T extends { deletedAt: number | null }>(r: T) => includeDeleted || r.deletedAt == null;
    return {
      folders: [...this.folders.values()].filter(keep),
      links: [...this.links.values()].filter(keep),
      plans: [...this.plans.values()].filter(keep),
    };
  }

  map<K extends Kind>(kind: K): Map<string, RowByKind[K]> {
    return this[kind] as unknown as Map<string, RowByKind[K]>;
  }

  liveFolders(): Folder[] { return [...this.folders.values()].filter((f) => f.deletedAt == null); }
  liveLinks(): Link[] { return [...this.links.values()].filter((l) => l.deletedAt == null); }
  livePlans(): Plan[] { return [...this.plans.values()].filter((p) => p.deletedAt == null); }
  folder(id: string | null | undefined): Folder | undefined {
    const f = id ? this.folders.get(id) : undefined;
    return f && f.deletedAt == null ? f : undefined;
  }
  link(id: string): Link | undefined {
    const l = this.links.get(id);
    return l && l.deletedAt == null ? l : undefined;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(c: Change): void { this.listeners.forEach((fn) => fn(c)); }

  /** Local write: stamps updatedAt, persists, queues for sync, notifies. */
  write<K extends Kind>(kind: K, rows: RowByKind[K][]): RowByKind[K][] {
    if (!rows.length) return [];
    const now = Date.now();
    const map = this.map(kind);
    const stamped = rows.map((r) => {
      const prev = map.get(r.id);
      // Strictly increasing, so last-write-wins can't tie with our own older edit.
      return { ...r, updatedAt: Math.max(now, (prev?.updatedAt ?? 0) + 1) } as RowByKind[K];
    });
    for (const r of stamped) map.set(r.id, r);
    const outbox: OutboxEntry[] | undefined = this.trackOutbox
      ? stamped.map((r) => ({ key: kind + ':' + r.id, kind, id: r.id, at: now }))
      : undefined;
    this.db.putRows(kind, stamped, outbox).catch((e) => this.onPersistError(e));
    this.emit({ kind, ids: stamped.map((r) => r.id), remote: false });
    return stamped;
  }

  patch<K extends Kind>(kind: K, id: string, patch: Partial<RowByKind[K]>): RowByKind[K] | undefined {
    const cur = this.map(kind).get(id);
    if (!cur) return undefined;
    return this.write(kind, [{ ...cur, ...patch }])[0];
  }

  softDelete(kind: Kind, ids: string[]): void {
    const now = Date.now();
    const map = this.map(kind);
    const rows = ids.map((id) => map.get(id)).filter((r): r is NonNullable<typeof r> => !!r && r.deletedAt == null);
    this.write(kind, rows.map((r) => ({ ...r, deletedAt: now })) as never);
  }

  restore(kind: Kind, ids: string[]): void {
    const map = this.map(kind);
    const rows = ids.map((id) => map.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
    this.write(kind, rows.map((r) => ({ ...r, deletedAt: null })) as never);
  }

  /** Rows from the server: stored as-is (already stamped), never re-queued. */
  applyRemote<K extends Kind>(kind: K, rows: RowByKind[K][]): void {
    if (!rows.length) return;
    const map = this.map(kind);
    for (const r of rows) map.set(r.id, r);
    this.db.putRows(kind, rows).catch((e) => this.onPersistError(e));
    this.emit({ kind, ids: rows.map((r) => r.id), remote: true });
  }

  /** Replace everything (import "Replace", sign-out wipe, account switch). */
  async replaceAll(s: Snapshot): Promise<void> {
    this.setSnapshot(s);
    await this.db.replaceSnapshot(s);
    this.emit({ kind: 'all', ids: [], remote: false });
  }

  setSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    this.db.setMeta('settings', this.settings).catch((e) => this.onPersistError(e));
    this.emit({ kind: 'settings', ids: [], remote: false });
  }
}

export const store = new Store();

export function storageErrorMessage(e: unknown): string {
  const err = e as { name?: string; code?: number } | null;
  if (err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014)) {
    return 'storage is full - try exporting a backup (Backup & import) and removing some old links.';
  }
  return 'browser storage is unavailable right now.';
}
