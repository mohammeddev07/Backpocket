// Request/response shapes for the AI features, the JSON Schemas sent to
// Gemini as structured output, and validators that clamp what comes back.
// Shared by the Edge Function and the browser (bring-your-own-key) client.

import { AI_CONFIG } from './config.ts';

// ---- Sort on save ----
export interface FolderContext { id: string; path: string; examples: string[] }
export interface ClassifyInput {
  url: string;
  platform: string;
  title?: string | null;
  caption?: string | null;
  note?: string | null;
  oembedTitle?: string | null;
  folders: FolderContext[];
}
export interface ClassifyOutput {
  folder_id: string | null;
  new_folder_path: string | null;
  title: string;
  tags: string[];
  confidence: number;
  reason: string;
}

export const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    folder_id: { type: ['string', 'null'], description: 'id of the best existing folder, or null' },
    new_folder_path: { type: ['string', 'null'], description: 'path for a new folder like "Recipes › Breakfast", or null' },
    title: { type: 'string', description: 'short descriptive title, max 80 characters' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', description: 'why, in under 12 words' },
  },
  required: ['folder_id', 'new_folder_path', 'title', 'tags', 'confidence', 'reason'],
  additionalProperties: false,
  propertyOrdering: ['folder_id', 'new_folder_path', 'confidence', 'title', 'tags', 'reason'],
};

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clamp01 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
export const cleanTag = (t: string) => t.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 30);

/** Keeps only an existing folder id; trims everything else to sane sizes. */
export function validateClassify(raw: unknown, folderIds: ReadonlySet<string>): ClassifyOutput {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const folderId = typeof o.folder_id === 'string' && folderIds.has(o.folder_id) ? o.folder_id : null;
  const path = !folderId && typeof o.new_folder_path === 'string' && o.new_folder_path.trim()
    ? o.new_folder_path.split(/\s*[›>/]\s*/).map((p) => p.trim().slice(0, 60)).filter(Boolean).slice(0, 3).join(' › ')
    : null;
  return {
    folder_id: folderId,
    new_folder_path: path || null,
    title: str(o.title, 120),
    tags: Array.isArray(o.tags) ? [...new Set(o.tags.filter((t): t is string => typeof t === 'string').map(cleanTag).filter(Boolean))].slice(0, 4) : [],
    confidence: clamp01(o.confidence),
    reason: str(o.reason, 140),
  };
}

// ---- Folder -> plan ----
export interface PlanLinkInput { id: string; title?: string | null; note?: string | null; caption?: string | null; url: string; platform: string }
export interface PlanInput { folder: string; links: PlanLinkInput[] }
export interface PlanOutput { title: string; summary: string; items: Array<{ text: string; link_ids: string[] }> }

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'plan title, max 60 characters' },
    summary: { type: 'string', description: 'one or two sentences' },
    items: {
      type: 'array',
      minItems: 5,
      maxItems: 15,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'one concrete, actionable step' },
          link_ids: { type: 'array', items: { type: 'string' }, description: 'ids of the saved links this step comes from' },
        },
        required: ['text', 'link_ids'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'summary', 'items'],
  additionalProperties: false,
  propertyOrdering: ['title', 'summary', 'items'],
};

export function validatePlan(raw: unknown, linkIds: ReadonlySet<string>): PlanOutput {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(o.items) ? o.items : [];
  return {
    title: str(o.title, 80) || 'Plan',
    summary: str(o.summary, 600),
    items: items.slice(0, 15).map((it) => {
      const r = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
      const ids = Array.isArray(r.link_ids) ? r.link_ids.filter((x): x is string => typeof x === 'string' && linkIds.has(x)) : [];
      return { text: str(r.text, 300), link_ids: [...new Set(ids)] };
    }).filter((it) => it.text),
  };
}

// ---- Embeddings / search ----
export interface EmbedItem { id: string; text: string }
export interface SearchFilters { platform?: string; after?: string; before?: string }
export interface SearchHit { id: string; similarity: number }

export function validateEmbedItems(raw: unknown): EmbedItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, AI_CONFIG.embedBatchMax)
    .filter((x): x is EmbedItem => !!x && typeof x.id === 'string' && typeof x.text === 'string')
    .map((x) => ({ id: x.id, text: x.text.slice(0, AI_CONFIG.maxEmbedChars) }));
}

export function validateFilters(raw: unknown): SearchFilters {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: SearchFilters = {};
  if (typeof o.platform === 'string' && /^[A-Za-z]{1,20}$/.test(o.platform)) out.platform = o.platform;
  for (const k of ['after', 'before'] as const) {
    if (typeof o[k] === 'string' && !Number.isNaN(Date.parse(o[k] as string))) out[k] = new Date(o[k] as string).toISOString();
  }
  return out;
}
