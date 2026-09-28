import {
  buildBackup, buildBookmarksHtml, detectImportFormat, mergeImport, parseBackupJson, parseBookmarksHtml,
  replaceImport, type ImportBundle, type ImportTarget,
} from '../data/backup';
import { inboxId } from '../actions';
import { store } from '../data/store';
import type { Kind } from '../data/types';
import { byId, plural } from './dom';
import { closeModal, onModalClose, openModal } from './modal';
import { showToast } from './toast';
import { go, renderAll } from './view';

let pendingImport: ImportBundle | null = null;

export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const today = () => new Date().toISOString().slice(0, 10);

export function exportBackup(): void {
  downloadFile('backpocket-backup-' + today() + '.json', JSON.stringify(buildBackup(store.snapshot()), null, 2), 'application/json');
}

function exportBookmarks(): void {
  downloadFile('backpocket-bookmarks-' + today() + '.html', buildBookmarksHtml(store.snapshot()), 'text/html');
}

/** Where imports land: loose links go to the Inbox, folders to the top level. */
export function importTarget(): ImportTarget {
  return { systemId: inboxId(), topParentId: null };
}

function showImportError(msg: string): void {
  const err = byId('importError');
  err.textContent = msg;
  err.hidden = false;
  byId('backupSummarySection').hidden = true;
}

function resetImportUi(): void {
  pendingImport = null;
  byId<HTMLInputElement>('importFileInput').value = '';
  byId('importError').hidden = true;
  byId('backupSummarySection').hidden = true;
}

function showImportSummary(incoming: ImportBundle): void {
  byId('importError').hidden = true;
  const incomingFolders = incoming.folders.filter((f) => f.id !== incoming.systemId).length;
  const currentFolders = store.liveFolders().filter((f) => !f.isSystem).length;
  const currentLinks = store.liveLinks().length;
  byId('importSummaryText').textContent =
    'Found ' + plural(incoming.links.length, 'link') + ' and ' + plural(incomingFolders, 'folder') + ' in this file. ' +
    'Your library currently has ' + plural(currentLinks, 'link') + ' and ' + plural(currentFolders, 'folder') + '. ' +
    'Merge adds these alongside what you have; Replace wipes your current library first.';
  byId('backupSummarySection').hidden = false;
}

function writeAll(rows: { folders: unknown[]; links: unknown[]; plans: unknown[] }): void {
  // Folders first so links never point at a folder that isn't stored yet.
  (['folders', 'links', 'plans'] as Kind[]).forEach((k) => store.write(k, rows[k] as never));
}

export function openBackupModal(): void {
  resetImportUi();
  openModal(byId('backupModal'));
}

export function initBackupModal(): void {
  const backupModal = byId('backupModal');
  onModalClose(backupModal, resetImportUi);
  byId('backupBtn').onclick = openBackupModal;
  byId('closeBackupBtn').onclick = () => closeModal(backupModal);
  byId('exportJsonBtn').onclick = exportBackup;
  byId('exportHtmlBtn').onclick = exportBookmarks;

  byId<HTMLInputElement>('importFileInput').addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result);
      const format = detectImportFormat(file.name, text);
      let incoming: ImportBundle;
      if (format === 'json') {
        const r = parseBackupJson(text);
        if ('error' in r) { showImportError(r.error); return; }
        incoming = r.bundle;
      } else if (format === 'html') {
        try { incoming = parseBookmarksHtml(text); } catch { showImportError('Could not read that bookmarks file.'); return; }
        if (incoming.links.length === 0) { showImportError('No bookmarks found in that file.'); return; }
      } else {
        showImportError('Unrecognized file - use a .json backup or a browser bookmarks .html export.');
        return;
      }
      pendingImport = incoming;
      showImportSummary(incoming);
    };
    reader.onerror = () => showImportError('Could not read that file.');
    reader.readAsText(file);
  });

  byId('importMergeBtn').onclick = () => {
    if (!pendingImport) return;
    const result = mergeImport(store.snapshot(), pendingImport, importTarget());
    writeAll(result);
    closeModal(backupModal);
    renderAll();
    showToast('Merged ' + result.addedLinks + ' links, ' + result.addedFolders + ' folders' +
      (result.skippedDup ? ' (' + result.skippedDup + ' duplicates skipped)' : ''), true);
  };
  byId('importReplaceBtn').onclick = () => {
    if (!pendingImport) return;
    if (!confirm('Replace your entire library with this backup? This cannot be undone.')) return;
    writeAll(replaceImport(store.snapshot(), pendingImport, importTarget()));
    closeModal(backupModal);
    go('all');
    showToast('Library replaced from backup', true);
  };
}
