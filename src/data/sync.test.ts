import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// In-memory stand-in for Supabase/PostgREST with the same last-write-wins
// rule as the bp_sync_row trigger (older updated_at is ignored; every
// accepted write gets a fresh synced_at).
type Row = Record<string, unknown> & { id: string };
class FakeServer {
  tables: Record<string, Map<string, Row>> = { folders: new Map(), links: new Map(), plans: new Map() };
  private tick = Date.parse('2026-01-01T00:00:00Z');
  nextSynced(): string { this.tick += 1000; return new Date(this.tick).toISOString(); }
  write(table: string, row: Row): void {
    const t = this.tables[table];
    const cur = t.get(row.id);
    if (cur && String(row.updated_at) < String(cur.updated_at)) return;
    t.set(row.id, { ...cur, ...row, synced_at: this.nextSynced() });
  }
  from(table: string) {
    const server = this;
    let since: string | null = null;
    let limit = 1000;
    const builder = {
      upsert(rows: Row[]) { rows.forEach((r) => server.write(table, r)); return Promise.resolve({ error: null }); },
      select() { return builder; },
      order() { return builder; },
      limit(n: number) { limit = n; return builder; },
      gte(_col: string, v: string) { since = v; return builder; },
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        const data = [...server.tables[table].values()]
          .filter((r) => !since || String(r.synced_at) >= since)
          .sort((a, b) => String(a.synced_at).localeCompare(String(b.synced_at)))
          .slice(0, limit);
        resolve({ data, error: null });
      },
    };
    return builder;
  }
}
const server = new FakeServer();
vi.mock('../cloud/supabase', () => ({ getSupabase: async () => server }));

const { store } = await import('./store');
const { openLocalDb } = await import('./localStore');
const { adoptAccount, fetchAccount, syncNow } = await import('./sync');
const { freshInboxSnapshot } = await import('./migrate');
const { toServer } = await import('./supabaseStore');

const USER = '99999999-9999-4999-8999-999999999999';
const LINK_ID = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  await store.init(await openLocalDb('sync-test'));
  await store.replaceAll(freshInboxSnapshot(1, 'guest-inbox'));
  await adoptAccount(USER, await fetchAccount());
});

const link = (p: Record<string, unknown> = {}) => ({
  id: LINK_ID, folderId: USER, url: 'https://youtu.be/abc', platform: 'YouTube' as const, title: 'Local title',
  titleSource: 'user' as const, note: null, sharedText: null, thumbnailUrl: null, tags: ['x'], status: 'unread' as const,
  openedAt: null, aiMeta: null, createdAt: 1000, updatedAt: 1000, deletedAt: null, ...p,
});

describe('sync engine', () => {
  it('an empty account gets an Inbox whose id is the user id', () => {
    expect(server.tables.folders.get(USER)?.is_system).toBe(true);
    expect(store.liveFolders().map((f) => f.id)).toEqual([USER]);
  });

  it('pushes local writes from the outbox', async () => {
    store.write('links', [link()]);
    await syncNow();
    const row = server.tables.links.get(LINK_ID)!;
    expect(row.title).toBe('Local title');
    expect(row.normalized_url).toBe('youtube.com/watch?v=abc');
    expect(await store.db.outboxAll()).toHaveLength(0);
  });

  it('pulls a newer edit made on another device', async () => {
    const cur = server.tables.links.get(LINK_ID)!;
    server.write('links', { ...cur, title: 'Edited elsewhere', updated_at: new Date(Date.now() + 60_000).toISOString() });
    await syncNow();
    expect(store.link(LINK_ID)!.title).toBe('Edited elsewhere');
  });

  it('last write wins: an older remote edit never overwrites a newer local one', async () => {
    store.patch('links', LINK_ID, { title: 'Newest local' });
    const local = store.link(LINK_ID)!;
    // Another device pushes an edit stamped before ours; the server keeps ours.
    server.write('links', { ...server.tables.links.get(LINK_ID)!, title: 'Stale', updated_at: new Date(local.updatedAt - 5).toISOString() });
    await syncNow();
    expect(store.link(LINK_ID)!.title).toBe('Newest local');
    expect(server.tables.links.get(LINK_ID)!.title).toBe('Newest local');
  });

  it('deletes are soft and sync', async () => {
    store.softDelete('links', [LINK_ID]);
    await syncNow();
    expect(server.tables.links.get(LINK_ID)!.deleted_at).not.toBeNull();
    expect(store.link(LINK_ID)).toBeUndefined();
  });

  it('re-pushes a newer local row the server missed (no outbox entry)', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    server.write('links', toServer('links', link({ id, title: 'server copy', updatedAt: 2000 }), USER) as Row);
    // A newer local version that never got queued (e.g. edited while signed out).
    store.applyRemote('links', [link({ id, title: 'local newer', updatedAt: Date.now() + 120_000 })]);
    await syncNow(); // pull notices the server copy is older and re-queues ours
    await vi.waitFor(async () => expect((await store.db.outboxAll()).some((e) => e.id === id)).toBe(true));
    await syncNow();
    expect(server.tables.links.get(id)!.title).toBe('local newer');
  });

  it('two devices converge: a device joining later sees the same data', async () => {
    const other = await fetchAccount();
    const live = other.snapshot.links.filter((l) => l.deletedAt == null).map((l) => [l.id, l.title]);
    const mine = store.liveLinks().map((l) => [l.id, l.title]);
    expect(live.sort()).toEqual(mine.sort());
  });
});
