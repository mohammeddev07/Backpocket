import { createLink, findDuplicate, inboxId } from '../actions';
import { APP_CONFIG } from '../config';
import { fetchOembed, supportsOembed } from '../data/oembed';
import { store } from '../data/store';
import { pathLabel } from '../data/tree';
import type { Link } from '../data/types';
import { normalizeUrlInput } from '../data/urls';
import { detectPlatform, domainOf } from '../platform';
import { allTags } from '../search/filters';
import { usableSharedTitle, type SharedPayload } from '../share/extractSharedUrl';
import { byId } from './dom';
import { pickFolder, setPickerButton } from './folderPicker';
import { fallbackTile, openLink } from './list';
import { closeModal, openModal } from './modal';
import { createTagInput, type TagInput } from './tagInput';
import { showToast } from './toast';
import { setRenderer, view } from './view';

// The "Save to Backpocket" sheet: opened by the + tab, a paste anywhere, a
// share from another app, or the empty-state button.

export interface SavedEvent {
  link: Link;
  /** The user picked a folder other than the Inbox - AI must never move it. */
  explicitFolder: boolean;
}
type SaveHook = (e: SavedEvent) => void;
const saveHooks: SaveHook[] = [];
/** Runs after a link is saved (AI sort-on-save). Saving never waits for these. */
export function onLinkSaved(fn: SaveHook): void { saveHooks.push(fn); }

let sheet: HTMLElement;
let urlInput: HTMLInputElement;
let titleInput: HTMLInputElement;
let noteInput: HTMLTextAreaElement;
let tagInput: TagInput;
let urlErrorEl: HTMLElement;
/** Caption that came with a share, saved as sharedText. */
let pendingSharedText: string | null = null;
/** The user chose the target folder themselves (vs. the default for the view). */
let targetChosen = false;
let dupFor: string | null = null;

function hideDup(): void {
  byId('dupNotice').hidden = true;
  dupFor = null;
}

function showError(msg: string): void {
  urlErrorEl.textContent = msg;
  urlErrorEl.hidden = false;
  urlInput.setAttribute('aria-invalid', 'true');
}
function clearError(): void {
  urlErrorEl.hidden = true;
  urlInput.removeAttribute('aria-invalid');
}

function resetSaveForm(): void {
  urlInput.value = ''; titleInput.value = ''; noteInput.value = '';
  titleInput.placeholder = 'Give it a name (optional)';
  tagInput.set([]);
  pendingSharedText = null;
  clearError();
  hideDup();
  renderPreview();
}

// ---- Preview: the link's thumbnail (YouTube/TikTok oEmbed) or its local tile ----
let previewToken = 0;
let previewTimer = 0;

function renderPreview(): void {
  const box = byId('savePreview');
  const source = byId('saveSource');
  const token = ++previewToken;
  const parsed = normalizeUrlInput(urlInput.value);
  box.hidden = source.hidden = !parsed.url;
  if (!parsed.url) { box.replaceChildren(); return; }
  const url = parsed.url;
  const platform = detectPlatform(url);
  source.textContent = 'Saving link from ' + (platform !== 'Link' ? platform : domainOf(url));
  box.classList.toggle('is-tall', platform === 'Instagram' || platform === 'TikTok');
  // A stand-in row just for drawing the tile; it is never stored.
  const stub = { id: 'preview', url, platform, title: titleInput.value.trim() || null } as Link;
  box.replaceChildren(fallbackTile(stub));
  if (!supportsOembed(platform) || store.settings.localIconsOnly || !navigator.onLine) return;
  void fetchOembed(url, platform, { timeoutMs: APP_CONFIG.oembedTimeoutMs }).then((info) => {
    if (token !== previewToken || !info) return;
    if (info.title) titleInput.placeholder = info.title;
    if (!info.thumbnailUrl) return;
    const wrap = document.createElement('div');
    wrap.className = 'link-visual';
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = info.thumbnailUrl;
    img.onload = () => { if (token === previewToken) box.replaceChildren(wrap); };
    wrap.appendChild(img);
  });
}

/** Default "To" folder: the folder being viewed, otherwise the Inbox. */
function defaultTarget(): string {
  if (view.mode === 'folder' && store.folder(view.folderId)) return view.folderId;
  return inboxId();
}

function renderTarget(): void {
  if (!targetChosen || !store.folder(view.saveTargetId)) view.saveTargetId = defaultTarget();
  setPickerButton(byId('saveTargetBtn'), view.saveTargetId);
}

function doSave(url: string): void {
  const folderId = view.saveTargetId || inboxId();
  const link = createLink({
    url, folderId,
    title: titleInput.value.trim() || null,
    note: noteInput.value.trim() || null,
    tags: tagInput.get(),
    sharedText: pendingSharedText,
  });
  const explicitFolder = folderId !== inboxId();
  resetSaveForm();
  closeModal(sheet);
  showToast('Saved to ' + pathLabel(store.liveFolders(), link.folderId), true);
  for (const h of saveHooks) {
    try { h({ link, explicitFolder }); } catch (e) { console.error(e); }
  }
}

function showDup(existing: Link, url: string): void {
  dupFor = url;
  byId('dupFolderName').textContent = pathLabel(store.liveFolders(), existing.folderId);
  byId('dupNotice').hidden = false;
  byId('dupOpenBtn').onclick = () => { openLink(existing); resetSaveForm(); closeModal(sheet); };
}

function onSave(force = false): void {
  const result = normalizeUrlInput(urlInput.value);
  if (result.error !== undefined) { showError(result.error); urlInput.focus(); return; }
  clearError();
  const dup = findDuplicate(result.url);
  if (dup && !force) { showDup(dup, result.url); return; }
  doSave(result.url);
}

/** Opens the sheet, optionally with a link already filled in. */
export function openSaveSheet(url?: string): void {
  if (url) { urlInput.value = url; clearError(); hideDup(); }
  renderTarget();
  renderPreview();
  // Empty: type or paste the link. Filled: the link is the point, so no
  // keyboard pops up over the preview; Save is one tap away.
  urlInput.toggleAttribute('autofocus', !urlInput.value);
  byId('saveBtn').toggleAttribute('autofocus', !!urlInput.value);
  openModal(sheet);
  const parsed = normalizeUrlInput(urlInput.value);
  const dup = parsed.url ? findDuplicate(parsed.url) : undefined;
  if (dup) showDup(dup, parsed.url!);
}

/** Prefills the sheet from a share (Android share target, iOS Shortcut, bookmarklet). */
export function applySharedPayload(payload: SharedPayload): void {
  if (!payload.url) {
    openSaveSheet();
    // Fill the alert after it's visible so screen readers announce it.
    requestAnimationFrame(() => showError('No link found in what was shared. Copy the link from the other app and paste it here.'));
    return;
  }
  const title = usableSharedTitle(payload.title);
  if (title) titleInput.value = title;
  // Keep the caption the app sent (minus a bare URL) for search and AI.
  const caption = [payload.title, payload.text, payload.urlParam]
    .filter((s) => s && s !== payload.url && !/^https?:\/\/\S+$/i.test(s)).join('\n').trim();
  pendingSharedText = caption ? caption.slice(0, 2000) : null;
  openSaveSheet(payload.url);
}

export function initSaveBox(): void {
  sheet = byId('saveSheet');
  urlInput = byId<HTMLInputElement>('urlInput');
  titleInput = byId<HTMLInputElement>('titleInput');
  noteInput = byId<HTMLTextAreaElement>('noteInput');
  urlErrorEl = byId('urlError');
  tagInput = createTagInput(byId('tagsInput'), {
    placeholder: '+ Add tag', label: 'Tags', suggestions: () => allTags(store.liveLinks()), onSubmit: () => onSave(),
  });

  setRenderer('saveTarget', renderTarget);
  byId('saveTargetBtn').onclick = async () => {
    const target = await pickFolder({ title: 'Save to', selectedId: view.saveTargetId });
    if (!target) return;
    view.saveTargetId = target;
    targetChosen = target !== defaultTarget();
    renderTarget();
  };

  byId('tabAddBtn').onclick = () => openSaveSheet();
  byId('saveCloseBtn').onclick = () => closeModal(sheet);
  byId('saveBtn').onclick = () => onSave();
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onSave(); } });
  urlInput.addEventListener('input', () => {
    clearError();
    if (dupFor) hideDup();
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(renderPreview, 300);
  });
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSave(); });

  byId('dupSaveAnywayBtn').onclick = () => onSave(true);
  byId('dupDismissBtn').onclick = hideDup;
}

/** Called on navigation: the default target follows the view unless the user picked one. */
export function resetSaveTarget(): void {
  targetChosen = false;
}
