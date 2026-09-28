import { createLink, findDuplicate, inboxId } from '../actions';
import { store } from '../data/store';
import { pathLabel } from '../data/tree';
import type { Link } from '../data/types';
import { normalizeUrlInput } from '../data/urls';
import { allTags } from '../search/filters';
import { usableSharedTitle, type SharedPayload } from '../share/extractSharedUrl';
import { byId } from './dom';
import { pickFolder, setPickerButton } from './folderPicker';
import { openLink } from './list';
import { createTagInput, type TagInput } from './tagInput';
import { showToast } from './toast';
import { setRenderer, view } from './view';

export interface SavedEvent {
  link: Link;
  /** The user picked a folder other than the Inbox - AI must never move it. */
  explicitFolder: boolean;
}
type SaveHook = (e: SavedEvent) => void;
const saveHooks: SaveHook[] = [];
/** Runs after a link is saved (AI sort-on-save). Saving never waits for these. */
export function onLinkSaved(fn: SaveHook): void { saveHooks.push(fn); }

let urlInput: HTMLInputElement;
let titleInput: HTMLInputElement;
let noteInput: HTMLInputElement;
let tagInput: TagInput;
let urlErrorEl: HTMLElement;
/** Caption that came with a share, saved as sharedText. */
let pendingSharedText: string | null = null;
/** The user chose the target folder themselves (vs. the default for the view). */
let targetChosen = false;
let dupFor: string | null = null;

function showDetails(show: boolean): void {
  byId('saveDetails').hidden = !show;
  const toggle = byId('noteToggle');
  toggle.textContent = show ? '− Hide details' : '+ Add details';
  toggle.setAttribute('aria-expanded', String(show));
}

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
  tagInput.set([]);
  pendingSharedText = null;
  showDetails(false);
  clearError();
  hideDup();
}

/** Default "To" folder: the folder being viewed, otherwise the Inbox. */
function defaultTarget(): string {
  if (view.mode === 'folder' && store.folder(view.folderId)) return view.folderId;
  return inboxId();
}

function renderTarget(): void {
  if (!targetChosen || !store.folder(view.saveTargetId)) view.saveTargetId = defaultTarget();
  setPickerButton(byId('saveTargetBtn'), view.saveTargetId);
  byId('saveTargetBtn').setAttribute('aria-label', 'Save to folder: ' + pathLabel(store.liveFolders(), view.saveTargetId));
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

  const saveBtn = byId('saveBtn');
  const saveBox = byId('saveBox');
  saveBtn.textContent = 'Saved';
  saveBtn.classList.add('saved');
  saveBox.classList.add('success');
  setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.classList.remove('saved'); saveBox.classList.remove('success'); }, 1100);

  showToast('Saved to ' + pathLabel(store.liveFolders(), link.folderId), true);
  for (const h of saveHooks) {
    try { h({ link, explicitFolder }); } catch (e) { console.error(e); }
  }
}

function showDup(existing: Link, url: string): void {
  dupFor = url;
  byId('dupFolderName').textContent = pathLabel(store.liveFolders(), existing.folderId);
  byId('dupNotice').hidden = false;
  (byId('dupOpenBtn') as HTMLButtonElement).onclick = () => { openLink(existing); resetSaveForm(); };
}

function onSave(force = false): void {
  const result = normalizeUrlInput(urlInput.value);
  if (result.error !== undefined) { showError(result.error); urlInput.focus(); return; }
  clearError();
  const dup = findDuplicate(result.url);
  if (dup && !force) { showDup(dup, result.url); return; }
  doSave(result.url);
  urlInput.focus();
}

/** Prefills the save form from a share (Android share target, iOS Shortcut, bookmarklet). */
export function applySharedPayload(payload: SharedPayload): void {
  if (!payload.url) {
    urlErrorEl.hidden = false;
    urlInput.setAttribute('aria-invalid', 'true');
    // Fill the alert after it's visible so screen readers announce it on load.
    requestAnimationFrame(() => {
      urlErrorEl.textContent = 'No link found in what was shared. Copy the link from the other app and paste it here.';
    });
    return;
  }
  urlInput.value = payload.url;
  const title = usableSharedTitle(payload.title);
  if (title) titleInput.value = title;
  // Keep the caption the app sent (minus a bare URL) for search and AI.
  const caption = [payload.title, payload.text, payload.urlParam]
    .filter((s) => s && s !== payload.url && !/^https?:\/\/\S+$/i.test(s)).join('\n').trim();
  pendingSharedText = caption ? caption.slice(0, 2000) : null;
  showDetails(true);
  byId('saveBox').scrollIntoView({ block: 'nearest' });
  const dup = findDuplicate(payload.url);
  if (dup) showDup(dup, payload.url);
  else showToast('Link ready - pick a folder and tap Save', true);
}

export function initSaveBox(): void {
  urlInput = byId<HTMLInputElement>('urlInput');
  titleInput = byId<HTMLInputElement>('titleInput');
  noteInput = byId<HTMLInputElement>('noteInput');
  urlErrorEl = byId('urlError');
  tagInput = createTagInput(byId('tagsInput'), {
    placeholder: 'Tags (optional)', label: 'Tags', suggestions: () => allTags(store.liveLinks()), onSubmit: () => onSave(),
  });

  setRenderer('saveTarget', renderTarget);
  byId('saveTargetBtn').onclick = async () => {
    const target = await pickFolder({ title: 'Save to', selectedId: view.saveTargetId });
    if (!target) return;
    view.saveTargetId = target;
    targetChosen = target !== defaultTarget();
    renderTarget();
  };

  byId('noteToggle').onclick = () => {
    const show = byId('saveDetails').hidden === true;
    showDetails(show);
    if (show) titleInput.focus();
  };

  byId('saveBtn').onclick = () => onSave();
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onSave(); } });
  urlInput.addEventListener('input', () => { clearError(); if (dupFor) hideDup(); });
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSave(); });
  noteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSave(); });

  byId('dupSaveAnywayBtn').onclick = () => onSave(true);
  byId('dupDismissBtn').onclick = hideDup;
}

/** Called on navigation: the default target follows the view unless the user picked one. */
export function resetSaveTarget(): void {
  targetChosen = false;
}
