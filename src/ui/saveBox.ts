import { createLink, moveLinks } from '../actions';
import { store } from '../data/store';
import { flattenTree, pathLabel } from '../data/tree';
import type { Link } from '../data/types';
import { normalizeForCompare, normalizeUrlInput, parseTags } from '../data/urls';
import { usableSharedTitle, type SharedPayload } from '../share/extractSharedUrl';
import { byId } from './dom';
import { openLink } from './list';
import { closeModal, onModalClose, openModal } from './modal';
import { showToast } from './toast';
import { renderAll, setRenderer, view } from './view';

interface PendingSave { url: string; title: string; tags: string[]; folderId: string; existing: Link }
let pendingSave: PendingSave | null = null;

let urlInput: HTMLInputElement;
let noteInput: HTMLInputElement;
let tagsInput: HTMLInputElement;
let noteToggle: HTMLButtonElement;
let urlErrorEl: HTMLElement;

function showDetails(show: boolean, label = '− Hide details'): void {
  noteInput.style.display = show ? 'block' : 'none';
  tagsInput.style.display = show ? 'block' : 'none';
  noteToggle.textContent = show ? label : '+ Add details';
}

function resetSaveForm(): void {
  urlInput.value = ''; noteInput.value = ''; tagsInput.value = '';
  showDetails(false);
  urlErrorEl.hidden = true;
  urlInput.removeAttribute('aria-invalid');
}

function doSave(url: string, title: string, tags: string[], folderId: string): void {
  createLink({ url, folderId, title, tags });
  resetSaveForm();

  const saveBtn = byId('saveBtn');
  const saveBox = byId('saveBox');
  saveBtn.textContent = 'Saved';
  saveBtn.classList.add('saved');
  saveBox.classList.add('success');
  setTimeout(() => {
    saveBtn.textContent = 'Save'; saveBtn.classList.remove('saved');
    saveBox.classList.remove('success');
  }, 1100);

  renderAll();
  showToast('Saved to ' + (store.folder(folderId)?.name || 'folder'), true);
  urlInput.focus();
}

// ---- Duplicate-link detection ----
function openDuplicateModal(pending: PendingSave): void {
  pendingSave = pending;
  const existing = pending.existing;
  byId('dupFolderName').textContent = store.folder(existing.folderId)?.name || '';
  const preview = byId('dupPreview');
  preview.replaceChildren();
  const title = document.createElement('div');
  title.className = 'link-title';
  title.textContent = existing.title || existing.url;
  preview.appendChild(title);
  if (existing.title) {
    const urlLine = document.createElement('div');
    urlLine.className = 'link-url-sub';
    urlLine.textContent = existing.url;
    preview.appendChild(urlLine);
  }
  openModal(byId('duplicateModal'));
}

function onSave(): void {
  const result = normalizeUrlInput(urlInput.value);
  if (result.error !== undefined) {
    urlErrorEl.textContent = result.error;
    urlErrorEl.hidden = false;
    urlInput.setAttribute('aria-invalid', 'true');
    urlInput.focus();
    return;
  }
  urlErrorEl.hidden = true;
  urlInput.removeAttribute('aria-invalid');

  const title = noteInput.value.trim();
  const tags = parseTags(tagsInput.value);
  const folderId = view.saveTargetFolderId;

  const dupKey = normalizeForCompare(result.url);
  const dup = store.liveLinks().find((l) => normalizeForCompare(l.url) === dupKey);
  if (dup) {
    openDuplicateModal({ url: result.url, title, tags, folderId, existing: dup });
    return;
  }
  doSave(result.url, title, tags, folderId);
}

function populateSaveTargetSelect(): void {
  const select = byId<HTMLSelectElement>('saveTargetSelect');
  select.replaceChildren();
  const folders = store.liveFolders();
  for (const { folder } of flattenTree(folders)) {
    const opt = document.createElement('option');
    opt.value = folder.id;
    opt.textContent = pathLabel(folders, folder.id);
    select.appendChild(opt);
  }
  if (!store.folder(view.saveTargetFolderId)) view.saveTargetFolderId = view.currentFolderId;
  select.value = view.saveTargetFolderId;
}

/** Prefills the save form from a share - never saves by itself. */
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
  showDetails(true, '− Hide note');
  const title = usableSharedTitle(payload.title);
  if (title) noteInput.value = title;
  byId('saveBox').scrollIntoView({ block: 'nearest' });
  showToast('Link ready - pick a folder and tap Save', true);
}

export function initSaveBox(): void {
  urlInput = byId<HTMLInputElement>('urlInput');
  noteInput = byId<HTMLInputElement>('noteInput');
  tagsInput = byId<HTMLInputElement>('tagsInput');
  noteToggle = byId<HTMLButtonElement>('noteToggle');
  urlErrorEl = byId('urlError');

  setRenderer('saveTarget', populateSaveTargetSelect);
  byId<HTMLSelectElement>('saveTargetSelect').addEventListener('change', (e) => {
    view.saveTargetFolderId = (e.target as HTMLSelectElement).value;
  });

  noteToggle.onclick = () => {
    const showing = noteInput.style.display !== 'none';
    if (showing) { noteInput.value = ''; tagsInput.value = ''; showDetails(false); }
    else { showDetails(true); noteInput.focus(); }
  };

  byId('saveBtn').onclick = onSave;
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSave(); });
  urlInput.addEventListener('input', () => { urlErrorEl.hidden = true; urlInput.removeAttribute('aria-invalid'); });
  noteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSave(); });
  tagsInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSave(); });

  const dupModal = byId('duplicateModal');
  onModalClose(dupModal, () => { pendingSave = null; });
  byId('dupSaveAnywayBtn').onclick = () => {
    const p = pendingSave;
    closeModal(dupModal);
    if (p) doSave(p.url, p.title, p.tags, p.folderId);
  };
  byId('dupOpenBtn').onclick = () => {
    if (pendingSave) openLink(pendingSave.existing);
    closeModal(dupModal);
  };
  byId('dupMoveBtn').onclick = () => {
    const p = pendingSave;
    closeModal(dupModal);
    if (p) {
      moveLinks([p.existing.id], p.folderId);
      showToast('Moved existing link here', true);
    }
  };
}
