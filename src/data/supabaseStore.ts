import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeUrl } from './normalizeUrl';
import type { Folder, Kind, Link, Plan, RowByKind } from './types';

// Row mapping between the local store (camelCase, ms timestamps) and the
// Supabase tables (snake_case, timestamptz), plus the push/pull calls.

const COLUMNS: Record<Kind, string> = {
  folders: 'id,parent_id,name,color,is_system,position,created_at,updated_at,deleted_at,synced_at',
  // Never select the embedding: it's large and only the server uses it.
  links: 'id,folder_id,url,platform,title,title_source,note,shared_text,thumbnail_url,tags,status,opened_at,ai_meta,created_at,updated_at,deleted_at,synced_at',
  plans: 'id,folder_id,title,summary,items,model,created_at,updated_at,deleted_at,synced_at',
};

const iso = (v: number | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());
/** timestamptz -> ms. Trims microseconds, which some engines won't parse. */
export function msFromIso(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(t) ? null : t;
}

type ServerRow = Record<string, unknown>;

export function toServer<K extends Kind>(kind: K, row: RowByKind[K], userId: string): ServerRow {
  const base = {
    id: row.id, user_id: userId,
    created_at: iso(row.createdAt), updated_at: iso(row.updatedAt), deleted_at: iso(row.deletedAt),
  };
  if (kind === 'folders') {
    const f = row as Folder;
    return { ...base, parent_id: f.parentId, name: f.name.slice(0, 200) || 'Untitled', color: f.color, is_system: f.isSystem, position: f.position };
  }
  if (kind === 'links') {
    const l = row as Link;
    return {
      ...base, folder_id: l.folderId, url: l.url, normalized_url: normalizeUrl(l.url), platform: l.platform,
      title: l.title, title_source: l.titleSource, note: l.note, shared_text: l.sharedText,
      thumbnail_url: l.thumbnailUrl, tags: l.tags, status: l.status, opened_at: iso(l.openedAt), ai_meta: l.aiMeta,
    };
  }
  const p = row as Plan;
  return {
    ...base, folder_id: p.folderId, title: p.title, summary: p.summary, model: p.model,
    items: p.items.map((it) => ({ id: it.id, text: it.text, done: it.done, link_ids: it.linkIds })),
  };
}

export function fromServer<K extends Kind>(kind: K, r: ServerRow): RowByKind[K] {
  const base = {
    id: String(r.id),
    createdAt: msFromIso(r.created_at as string) ?? Date.now(),
    updatedAt: msFromIso(r.updated_at as string) ?? 0,
    deletedAt: msFromIso(r.deleted_at as string),
  };
  if (kind === 'folders') {
    return { ...base, parentId: (r.parent_id as string) ?? null, name: String(r.name), color: String(r.color),
      isSystem: !!r.is_system, position: Number(r.position) || 0 } satisfies Folder as RowByKind[K];
  }
  if (kind === 'links') {
    return {
      ...base, folderId: String(r.folder_id), url: String(r.url), platform: (r.platform as Link['platform']) || 'Link',
      title: (r.title as string) ?? null, titleSource: (r.title_source as Link['titleSource']) ?? null,
      note: (r.note as string) ?? null, sharedText: (r.shared_text as string) ?? null,
      thumbnailUrl: (r.thumbnail_url as string) ?? null, tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
      status: r.status === 'done' ? 'done' : 'unread', openedAt: msFromIso(r.opened_at as string),
      aiMeta: (r.ai_meta as Link['aiMeta']) ?? null,
    } satisfies Link as RowByKind[K];
  }
  const items = Array.isArray(r.items) ? (r.items as Array<Record<string, unknown>>) : [];
  return {
    ...base, folderId: String(r.folder_id), title: String(r.title ?? ''), summary: String(r.summary ?? ''),
    model: String(r.model ?? ''),
    items: items.map((it) => ({
      id: String(it.id), text: String(it.text ?? ''), done: !!it.done,
      linkIds: Array.isArray(it.link_ids) ? (it.link_ids as string[]) : [],
    })),
  } satisfies Plan as RowByKind[K];
}

const CHUNK = 200;

export async function upsertRows<K extends Kind>(sb: SupabaseClient, kind: K, rows: RowByKind[K][], userId: string): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => toServer(kind, r, userId));
    const { error } = await sb.from(kind).upsert(chunk, { onConflict: 'id' });
    if (error) throw error;
  }
}

/**
 * Fetches rows changed since `since` (server synced_at), page by page.
 * Returns the newest synced_at seen, to store as the next cursor.
 */
export async function pullSince<K extends Kind>(
  sb: SupabaseClient, kind: K, since: string | null, onPage: (rows: RowByKind[K][]) => void,
): Promise<string | null> {
  const PAGE = 500;
  let cursor = since;
  let newest = since;
  for (let guard = 0; guard < 400; guard++) {
    let q = sb.from(kind).select(COLUMNS[kind]).order('synced_at', { ascending: true }).order('id', { ascending: true }).limit(PAGE);
    if (cursor) q = q.gte('synced_at', cursor);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data || []) as unknown as ServerRow[];
    if (rows.length) {
      onPage(rows.map((r) => fromServer(kind, r)));
      newest = rows[rows.length - 1].synced_at as string;
    }
    if (rows.length < PAGE) break;
    // Next page starts at the last timestamp seen (gte + idempotent apply).
    if (newest === cursor) break;
    cursor = newest;
  }
  return newest;
}
