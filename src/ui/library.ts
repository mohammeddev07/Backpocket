import { inboxId } from '../actions';
import { APP_CONFIG } from '../config';
import { COLORS } from '../data/migrate';
import { store } from '../data/store';
import { childrenOf, descendantIds } from '../data/tree';
import type { Folder } from '../data/types';
import { isRevisitCandidate } from '../search/filters';
import { byId, plural, svgIcon } from './dom';
import { openFolderModal } from './folderDialogs';
import { addRenderHook } from './list';
import { openMenu } from './menu';
import { folderMenuItems } from './nav';
import { go, view } from './view';

// Library chrome around the link list: the view chips (All, Inbox, Revisit,
// Favorites), the folder card grid, and the list/grid layout toggle.

function renderChips(): void {
  const row = byId('viewChips');
  const inbox = inboxId();
  const inInbox = view.mode === 'folder' && view.folderId === inbox;
  // Inside a user folder the crumb leads back instead.
  row.hidden = view.mode === 'folder' && !inInbox;
  if (row.hidden) return;
  const links = store.liveLinks();
  const now = Date.now();
  const chips = [
    { label: 'All', n: links.length, active: view.mode === 'all', onClick: () => go('all') },
    { label: 'Inbox', n: links.filter((l) => l.folderId === inbox).length, active: inInbox, onClick: () => go('folder', inbox) },
    { label: 'Revisit', n: links.filter((l) => isRevisitCandidate(l, now, APP_CONFIG.revisitMinAgeDays)).length, active: view.mode === 'revisit', onClick: () => go('revisit') },
    { label: 'Favorites', n: links.filter((l) => l.favorite).length, active: view.mode === 'favorites', onClick: () => go('favorites') },
  ];
  row.replaceChildren(...chips.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (c.active ? ' active' : '');
    if (c.active) b.setAttribute('aria-current', 'page');
    const count = document.createElement('span');
    count.className = 'chip-count';
    count.textContent = String(c.n);
    b.append(c.label + ' ', count);
    b.onclick = c.onClick;
    return b;
  }));
}

function folderCard(folder: Folder, count: number): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'folder-card';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'folder-card-btn';
  open.style.setProperty('--folder-color', folder.color || COLORS[0]);
  const name = document.createElement('span');
  name.className = 'folder-card-name';
  name.textContent = folder.name;
  const n = document.createElement('span');
  n.className = 'folder-card-count';
  n.textContent = plural(count, 'save');
  open.append(svgIcon('folder'), name, n);
  open.onclick = () => go('folder', folder.id);

  const kebab = document.createElement('button');
  kebab.type = 'button';
  kebab.className = 'folder-card-kebab';
  kebab.setAttribute('aria-label', 'Folder actions for ' + folder.name);
  kebab.appendChild(svgIcon('dots'));
  kebab.onclick = () => openMenu(kebab, folderMenuItems(folder));
  li.append(open, kebab);
  return li;
}

function newFolderCard(parentId: string | null): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'folder-card is-new';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'folder-card-btn';
  b.append(svgIcon('plus'), document.createTextNode(parentId ? 'New subfolder' : 'New folder'));
  b.onclick = () => openFolderModal(undefined, { parentId });
  li.appendChild(b);
  return li;
}

function renderFolders(): void {
  const section = byId('folderSection');
  const inUserFolder = view.mode === 'folder' && !store.folder(view.folderId)?.isSystem;
  const parentId = inUserFolder ? view.folderId : null;
  const browsing = !view.query.trim() && !view.related && !view.selectMode && !byId('listToolbar').hidden;
  const folders = store.liveFolders();
  const kids = childrenOf(folders, parentId).filter((f) => !f.isSystem);
  // Library always offers "New folder"; a folder only shows its grid when it has subfolders.
  section.hidden = !browsing || !(view.mode === 'all' || (inUserFolder && kids.length));
  if (section.hidden) return;
  byId('folderSectionTitle').textContent = inUserFolder ? 'Folders' : 'My folders';

  const direct = new Map<string, number>();
  for (const l of store.liveLinks()) direct.set(l.folderId, (direct.get(l.folderId) || 0) + 1);
  const total = (id: string) => [id, ...descendantIds(folders, id)].reduce((n, x) => n + (direct.get(x) || 0), 0);
  byId('folderGrid').replaceChildren(...kids.map((f) => folderCard(f, total(f.id))), newFolderCard(parentId));
}

function renderLayoutToggle(): void {
  const grid = store.settings.libraryLayout === 'grid';
  byId('layoutToggleBtn').setAttribute('aria-pressed', String(grid));
  byId('linksList').classList.toggle('is-grid', grid);
}

export function initLibrary(): void {
  addRenderHook(() => { renderChips(); renderFolders(); renderLayoutToggle(); });
  byId('layoutToggleBtn').onclick = () => {
    store.setSettings({ libraryLayout: store.settings.libraryLayout === 'grid' ? 'list' : 'grid' });
  };
}
