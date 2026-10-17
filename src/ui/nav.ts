import { inboxId, moveFolderUpDown } from '../actions';
import { store } from '../data/store';
import { childrenOf } from '../data/tree';
import type { Folder } from '../data/types';
import { byId, plural } from './dom';
import { confirmDeleteFolder, openFolderModal, openMoveFolder } from './folderDialogs';
import { type MenuItem } from './menu';
import { closeModal, openModal } from './modal';
import { go, setRenderer, view } from './view';

// App navigation: the bottom tab bar and the avatar sheet (account, settings,
// backup, sync status). Also the folder menu shared by folder headers.

/** Extra folder-menu items registered by later features (e.g. "Make a plan"). */
const extraFolderItems: Array<(f: Folder) => MenuItem[]> = [];
export function addFolderMenuItems(fn: (f: Folder) => MenuItem[]): void { extraFolderItems.push(fn); }

export function folderMenuItems(folder: Folder): MenuItem[] {
  if (folder.isSystem) return extraFolderItems.flatMap((fn) => fn(folder));
  const siblings = childrenOf(store.liveFolders(), folder.parentId).filter((f) => !f.isSystem);
  const idx = siblings.findIndex((s) => s.id === folder.id);
  const items: MenuItem[] = [
    { label: 'Edit folder', onClick: () => openFolderModal(folder.id) },
    { label: 'New subfolder', onClick: () => openFolderModal(undefined, { parentId: folder.id }) },
  ];
  items.push(...extraFolderItems.flatMap((fn) => fn(folder)));
  if (idx > 0) items.push({ label: 'Move up', onClick: () => moveFolderUpDown(folder.id, -1) });
  if (idx < siblings.length - 1) items.push({ label: 'Move down', onClick: () => moveFolderUpDown(folder.id, 1) });
  items.push({ label: 'Move to…', onClick: () => openMoveFolder(folder.id) });
  items.push({ separator: true });
  items.push({ label: 'Delete folder', danger: true, onClick: () => confirmDeleteFolder(folder.id) });
  return items;
}

function renderTabbar(): void {
  const inbox = inboxId();
  const inInbox = view.mode === 'folder' && view.folderId === inbox;
  const active = inInbox ? 'tabInbox' : view.mode === 'revisit' ? 'tabRevisit' : view.mode === 'queue' ? 'tabQueue' : 'tabLibrary';
  for (const id of ['tabInbox', 'tabQueue', 'tabLibrary', 'tabRevisit']) {
    if (id === active) byId(id).setAttribute('aria-current', 'page');
    else byId(id).removeAttribute('aria-current');
  }
  const n = store.liveLinks().filter((l) => l.folderId === inbox).length;
  const badge = byId('tabInboxBadge');
  badge.hidden = !n;
  badge.textContent = n > 99 ? '99+' : String(n);
  byId('tabInbox').setAttribute('aria-label', n ? 'Inbox, ' + plural(n, 'link') : 'Inbox');
}

export function initNav(): void {
  setRenderer('nav', renderTabbar);
  byId('tabInbox').onclick = () => go('folder', inboxId());
  byId('tabQueue').onclick = () => go('queue');
  byId('tabLibrary').onclick = () => go('all');
  byId('tabRevisit').onclick = () => go('revisit');

  const sheet = byId('meSheet');
  const meBtn = byId('meBtn');
  meBtn.onclick = () => openModal(sheet);
  // Every action in the sheet opens something else (or acts in place), so the
  // sheet steps aside first and hands focus back to the avatar for later.
  sheet.querySelector('[role="dialog"]')!.addEventListener('click', (e) => {
    if (!(e.target as Element).closest('button')) return;
    closeModal(sheet);
    meBtn.focus();
  }, true);
}
