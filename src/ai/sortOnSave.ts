import { AI_CONFIG } from '@shared/config.ts';
import type { ClassifyOutput, FolderContext } from '@shared/schemas.ts';
import { enrichLink, ensureFolderPath, inboxId, moveLinks } from '../actions';
import { store } from '../data/store';
import { pathLabel } from '../data/tree';
import type { AiMeta, Link } from '../data/types';
import { pickFolder } from '../ui/folderPicker';
import { addCardDecorator } from '../ui/list';
import { onLinkSaved } from '../ui/saveBox';
import { showToast } from '../ui/toast';
import { aiMode, aiReady } from './access';
import { AiError, aiCall, aiErrorMessage } from './client';
import { showAiNoticeOnce } from './notice';

// Sort on save. Saving never waits for AI: the link is stored first (in the
// chosen folder or the Inbox), then this runs in the background and either
// moves it (confident + existing folder), suggests a folder on the card, or
// only fills in an empty title/tags. A folder the user picked is never changed.

/** Folder paths with ids + a few example titles, most recently used first. */
export function folderContext(): FolderContext[] {
  const folders = store.liveFolders().filter((f) => !f.isSystem);
  const links = store.liveLinks().sort((a, b) => b.createdAt - a.createdAt);
  const examples = new Map<string, string[]>();
  const lastUsed = new Map<string, number>();
  for (const l of links) {
    if (!lastUsed.has(l.folderId)) lastUsed.set(l.folderId, l.createdAt);
    const ex = examples.get(l.folderId) || [];
    if (ex.length < AI_CONFIG.maxExamplesPerFolder && l.title) { ex.push(l.title); examples.set(l.folderId, ex); }
  }
  return folders
    .sort((a, b) => (lastUsed.get(b.id) || b.createdAt) - (lastUsed.get(a.id) || a.createdAt))
    .slice(0, AI_CONFIG.maxFolders)
    .map((f) => ({ id: f.id, path: pathLabel(store.liveFolders(), f.id), examples: examples.get(f.id) || [] }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function classifyLink(id: string, explicitFolder: boolean): Promise<void> {
  if (!aiReady()) return;
  showAiNoticeOnce();
  // Give the oEmbed lookup a moment so the model sees the real video title.
  await Promise.race([enrichLink(id), sleep(1500)]);
  const link = store.link(id);
  if (!link) return;

  let result: ClassifyOutput;
  let model: string;
  try {
    ({ result, model } = await aiCall('classify', {
      input: {
        url: link.url, platform: link.platform,
        title: link.titleSource === 'user' ? link.title : null,
        oembedTitle: link.titleSource === 'oembed' ? link.title : null,
        caption: link.sharedText, note: link.note,
        folders: folderContext(),
      },
    }));
  } catch (e) {
    if (e instanceof AiError && e.code === 'rate_limited') showToast(aiErrorMessage(e), false);
    return;
  }
  applyResult(id, result, model, explicitFolder);
}

export function applyResult(id: string, result: ClassifyOutput, model: string, explicitFolder: boolean): void {
  const cur = store.link(id);
  if (!cur) return;
  const inbox = inboxId();
  const patch: Partial<Link> = {};
  // Never overwrite what the user typed.
  if (!cur.title && result.title) { patch.title = result.title; patch.titleSource = 'ai'; }
  if (!cur.tags.length && result.tags.length) patch.tags = result.tags;

  const meta: AiMeta = {
    source: aiMode() === 'byok' ? 'byok' : 'server', model, at: Date.now(), output: result, outcome: 'kept', suggestion: null,
  };
  const target = result.folder_id ? store.folder(result.folder_id) : undefined;
  // The user chose a folder (at save time or since): keep it.
  const stillInInbox = !explicitFolder && cur.folderId === inbox;
  if (stillInInbox && target && !target.isSystem && result.confidence >= AI_CONFIG.autoApplyConfidence) {
    patch.folderId = target.id;
    meta.outcome = 'moved';
  } else if (stillInInbox && ((target && !target.isSystem) || result.new_folder_path)) {
    meta.outcome = 'suggested';
    meta.suggestion = {
      folderId: target && !target.isSystem ? target.id : null,
      newFolderPath: target ? null : result.new_folder_path,
      reason: result.reason, confidence: result.confidence,
    };
  }
  store.patch('links', id, { ...patch, aiMeta: meta });

  if (meta.outcome === 'moved' && target) {
    const path = pathLabel(store.liveFolders(), target.id);
    showToast('Moved to ' + path, true, [
      { label: 'Undo', onClick: () => { moveLinks([id], inbox); setOutcome(id, 'undone'); } },
      { label: 'Change', onClick: () => void changeFolder(id) },
    ], 7000);
  }
}

function setOutcome(id: string, outcome: string): void {
  const l = store.link(id);
  if (l?.aiMeta) store.patch('links', id, { aiMeta: { ...l.aiMeta, outcome } });
}

async function changeFolder(id: string): Promise<void> {
  const target = await pickFolder({ title: 'Move to', selectedId: store.link(id)?.folderId });
  if (!target) return;
  moveLinks([id], target);
  setOutcome(id, 'changed');
}

function acceptSuggestion(link: Link): void {
  const s = link.aiMeta?.suggestion;
  if (!s) return;
  const folder = s.folderId && store.folder(s.folderId) ? store.folder(s.folderId)! : s.newFolderPath ? ensureFolderPath(s.newFolderPath) : null;
  if (!folder) return;
  moveLinks([link.id], folder.id);
  setOutcome(link.id, 'accepted');
  showToast('Moved to ' + pathLabel(store.liveFolders(), folder.id), true, () => { moveLinks([link.id], inboxId()); setOutcome(link.id, 'suggested'); });
}

/** "Suggested: Evolve · ✓ / ✗" chip on Inbox cards. */
function suggestionChip(link: Link, main: HTMLElement): void {
  const meta = link.aiMeta;
  if (!meta || meta.outcome !== 'suggested' || !meta.suggestion || link.folderId !== inboxId()) return;
  const s = meta.suggestion;
  const label = s.folderId ? pathLabel(store.liveFolders(), s.folderId) : (s.newFolderPath || '');
  if (!label) return;
  const wrap = document.createElement('div');
  wrap.className = 'ai-suggest';
  const text = document.createElement('span');
  text.className = 'ai-suggest-text';
  text.textContent = 'Suggested: ' + label + (s.folderId ? '' : ' (new)');
  if (s.reason) text.title = s.reason;
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'ai-suggest-btn';
  yes.textContent = '✓';
  yes.setAttribute('aria-label', 'Move to ' + label);
  yes.onclick = (e) => { e.stopPropagation(); acceptSuggestion(link); };
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'ai-suggest-btn';
  no.textContent = '✗';
  no.setAttribute('aria-label', 'Dismiss suggestion');
  no.onclick = (e) => { e.stopPropagation(); setOutcome(link.id, 'rejected'); };
  wrap.append(text, yes, no);
  main.appendChild(wrap);
}

export function initSortOnSave(): void {
  onLinkSaved(({ link, explicitFolder }) => { void classifyLink(link.id, explicitFolder); });
  addCardDecorator(suggestionChip);
}
