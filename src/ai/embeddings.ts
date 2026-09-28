import { AI_CONFIG } from '@shared/config.ts';
import { embedDocumentText, textHash } from '@shared/prompts.ts';
import { currentUser } from '../cloud/auth';
import { getSupabase } from '../cloud/supabase';
import { store } from '../data/store';
import { onSyncState, syncState } from '../data/sync';
import { pathLabel } from '../data/tree';
import type { Folder, Link } from '../data/types';
import { domainOf } from '../platform';
import { aiReady, onAiModeChange } from './access';
import { AiError, aiCall } from './client';

// Keeps link embeddings current for semantic search: embeds title + note +
// caption + folder path + tags whenever that text changes, in batches of 20,
// and backfills existing links gently (one batch every few seconds, pausing on
// rate limits). Links must already be synced, since embeddings live on the
// server rows. The server stores a hash of the embedded text, so other
// devices don't re-embed what's already done.

const BATCHES_PER_RUN = 5;
const BATCH_GAP_MS = 8000;

let serverHashes: Map<string, string | null> | null = null;
let hashesForUser: string | null = null;
let running = false;
let pausedUntil = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export function embedTextFor(l: Link, folders: Folder[]): string {
  return embedDocumentText({
    title: l.title, note: l.note, caption: l.sharedText,
    folderPath: pathLabel(folders, l.folderId), tags: l.tags, url: domainOf(l.url),
  });
}

async function loadServerHashes(): Promise<Map<string, string | null>> {
  const sb = await getSupabase();
  const map = new Map<string, string | null>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('links').select('id,embedding_hash').is('deleted_at', null).range(from, from + 999);
    if (error) throw error;
    for (const r of (data || []) as Array<{ id: string; embedding_hash: string | null }>) map.set(r.id, r.embedding_hash);
    if (!data || data.length < 1000) break;
  }
  return map;
}

export function scheduleEmbeddings(delayMs = 10_000): void {
  clearTimeout(timer);
  timer = setTimeout(() => void run(), Math.max(delayMs, pausedUntil - Date.now()));
}

async function run(): Promise<void> {
  const user = currentUser();
  if (running || !user || !aiReady() || syncState().status !== 'synced') return;
  if (Date.now() < pausedUntil) { scheduleEmbeddings(0); return; }
  running = true;
  let more = false;
  try {
    if (!serverHashes || hashesForUser !== user.id) {
      serverHashes = await loadServerHashes();
      hashesForUser = user.id;
    }
    const folders = store.liveFolders();
    // Rows still in the outbox aren't on the server yet; everything else is.
    const pending = new Set((await store.db.outboxAll()).filter((e) => e.kind === 'links').map((e) => e.id));
    const todo = store.liveLinks()
      .filter((l) => !pending.has(l.id))
      .map((l) => ({ id: l.id, text: embedTextFor(l, folders) }))
      .filter((x) => serverHashes!.get(x.id) !== textHash(x.text))
      .sort((a, b) => (store.link(b.id)?.updatedAt || 0) - (store.link(a.id)?.updatedAt || 0));

    for (let b = 0; b < BATCHES_PER_RUN && todo.length; b++) {
      const items = todo.splice(0, AI_CONFIG.embedBatchMax);
      const { updated } = await aiCall('embed', { items });
      for (const it of items) serverHashes.set(it.id, textHash(it.text));
      // Some rows weren't there after all: re-read the server's view next run.
      if (updated < items.length) serverHashes = null;
      if (!serverHashes) break;
      if (todo.length) await new Promise((r) => setTimeout(r, BATCH_GAP_MS));
    }
    more = todo.length > 0;
  } catch (e) {
    const wait = e instanceof AiError && e.code === 'rate_limited' ? (e.retryAfter ?? 60) * 1000 : 5 * 60_000;
    pausedUntil = Date.now() + wait;
    more = true;
  } finally {
    running = false;
    if (more) scheduleEmbeddings(BATCH_GAP_MS);
  }
}

export function initEmbeddings(): void {
  onSyncState((s) => {
    if (s.status === 'synced') scheduleEmbeddings(3000);
    // Forget cached hashes when the account goes away.
    if (s.status === 'local' || s.status === 'signed-out') { serverHashes = null; hashesForUser = null; }
  });
  onAiModeChange(() => scheduleEmbeddings(2000));
  store.subscribe((c) => {
    if (c.kind === 'links' || c.kind === 'folders' || c.kind === 'all') {
      if (c.kind === 'all') serverHashes = null;
      scheduleEmbeddings(15_000);
    }
  });
}
