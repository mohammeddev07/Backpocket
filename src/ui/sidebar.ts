import { inboxId, moveFolderUpDown, reorderFolder, updateFolder } from '../actions';
import { APP_CONFIG } from '../config';
import { COLORS } from '../data/migrate';
import { store } from '../data/store';
import { childrenOf, isDescendantOf } from '../data/tree';
import type { Folder } from '../data/types';
import { isRevisitCandidate } from '../search/filters';
import { byId, svgIcon } from './dom';
import { confirmDeleteFolder, openFolderModal, openMoveFolder } from './folderDialogs';
import { openMenu, type MenuItem } from './menu';
import { go, renderTree, setRenderer, view } from './view';

let treeEl: HTMLElement;
let draggedFolderId: string | null = null;

/** Extra folder-menu items registered by later features (e.g. "Make a plan"). */
const extraFolderItems: Array<(f: Folder) => MenuItem[]> = [];
export function addFolderMenuItems(fn: (f: Folder) => MenuItem[]): void { extraFolderItems.push(fn); }

function linkCounts(): { byFolder: Map<string, number>; total: number; revisit: number } {
  const byFolder = new Map<string, number>();
  const links = store.liveLinks();
  const now = Date.now();
  let revisit = 0;
  for (const l of links) {
    byFolder.set(l.folderId, (byFolder.get(l.folderId) || 0) + 1);
    if (isRevisitCandidate(l, now, APP_CONFIG.revisitMinAgeDays)) revisit++;
  }
  return { byFolder, total: links.length, revisit };
}

function recursiveCount(folderId: string, counts: Map<string, number>, folders: Folder[]): number {
  let n = counts.get(folderId) || 0;
  for (const c of folders) if (c.parentId === folderId) n += recursiveCount(c.id, counts, folders);
  return n;
}

// ---- LIBRARY views: All saves, Inbox, Revisit ----
function renderViews(counts: ReturnType<typeof linkCounts>): void {
  const nav = byId('viewNav');
  nav.replaceChildren();
  const inbox = inboxId();
  const items: Array<{ label: string; icon: string; count: number; active: boolean; onClick: () => void }> = [
    { label: 'All saves', icon: 'layers', count: counts.total, active: view.mode === 'all', onClick: () => go('all') },
    { label: 'Inbox', icon: 'inbox', count: counts.byFolder.get(inbox) || 0, active: view.mode === 'folder' && view.folderId === inbox, onClick: () => go('folder', inbox) },
    { label: 'Revisit', icon: 'clock', count: counts.revisit, active: view.mode === 'revisit', onClick: () => go('revisit') },
  ];
  for (const it of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'folder-row nav-row' + (it.active ? ' active' : '');
    if (it.active) btn.setAttribute('aria-current', 'page');
    const name = document.createElement('span');
    name.className = 'folder-name';
    name.textContent = it.label;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = it.count ? String(it.count) : '';
    btn.append(svgIcon(it.icon), name, count);
    btn.onclick = () => { it.onClick(); closeSidebarMobile(); };
    li.appendChild(btn);
    nav.appendChild(li);
  }
}

function buildLevel(parentId: string | null, counts: Map<string, number>, folders: Folder[]): HTMLUListElement {
  const ul = document.createElement('ul');
  ul.setAttribute('role', 'group');
  ul.className = parentId ? 'tree-sub' : 'tree-root';
  childrenOf(folders, parentId).filter((f) => !f.isSystem).forEach((folder) => ul.appendChild(buildFolderLi(folder, counts, folders)));
  return ul;
}

// ---- Folder-tree keyboard navigation (ARIA treeview pattern, roving tabindex) ----
function getVisibleTreeItems(): HTMLElement[] {
  return Array.from(treeEl.querySelectorAll<HTMLElement>('[role="treeitem"]'));
}
function focusTreeItem(el: HTMLElement): void {
  getVisibleTreeItems().forEach((it) => { it.tabIndex = -1; });
  el.tabIndex = 0;
  el.focus();
}
function focusTreeItemById(id: string): void {
  const el = treeEl.querySelector<HTMLElement>('[data-folder-id="' + CSS.escape(id) + '"]');
  if (el) focusTreeItem(el);
}
function handleTreeKeydown(e: KeyboardEvent, folder: Folder, li: HTMLElement, hasKids: boolean): void {
  if (e.target !== li) return;
  // Tree items nest, so stop the key reaching ancestor treeitems' listeners.
  e.stopPropagation();
  const items = getVisibleTreeItems();
  const idx = items.indexOf(li);
  if (e.key === 'ArrowDown') { e.preventDefault(); if (items[idx + 1]) focusTreeItem(items[idx + 1]); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (items[idx - 1]) focusTreeItem(items[idx - 1]); }
  else if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (hasKids && !view.expanded.has(folder.id)) { view.expanded.add(folder.id); renderTree(); focusTreeItemById(folder.id); }
    else if (hasKids && items[idx + 1]) focusTreeItem(items[idx + 1]);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (hasKids && view.expanded.has(folder.id)) { view.expanded.delete(folder.id); renderTree(); focusTreeItemById(folder.id); }
    else if (folder.parentId) focusTreeItemById(folder.parentId);
  } else if (e.key === 'Home') { e.preventDefault(); if (items[0]) focusTreeItem(items[0]); }
  else if (e.key === 'End') { e.preventDefault(); if (items[items.length - 1]) focusTreeItem(items[items.length - 1]); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.querySelector<HTMLElement>('.folder-row')!.click(); }
}

function buildFolderLi(folder: Folder, counts: Map<string, number>, folders: Folder[]): HTMLLIElement {
  const li = document.createElement('li');
  const hasKids = folders.some((f) => f.parentId === folder.id);
  const isOpen = view.expanded.has(folder.id);
  const isActive = view.mode === 'folder' && folder.id === view.folderId;

  li.setAttribute('role', 'treeitem');
  li.setAttribute('aria-selected', String(isActive));
  li.setAttribute('aria-label', folder.name);
  if (hasKids) li.setAttribute('aria-expanded', String(isOpen));
  li.dataset.folderId = folder.id;
  li.tabIndex = -1;
  li.addEventListener('keydown', (e) => handleTreeKeydown(e, folder, li, hasKids));

  const row = document.createElement('div');
  row.className = 'folder-row' + (isActive ? ' active' : '');

  const caret = document.createElement('button');
  caret.type = 'button';
  caret.tabIndex = -1;
  caret.className = 'caret' + (isOpen ? ' rot' : '') + (!hasKids ? ' hidden' : '');
  caret.setAttribute('aria-label', (isOpen ? 'Collapse ' : 'Expand ') + folder.name);
  caret.appendChild(svgIcon('chevron'));
  caret.onclick = (e) => {
    e.stopPropagation();
    if (view.expanded.has(folder.id)) view.expanded.delete(folder.id); else view.expanded.add(folder.id);
    renderTree();
  };

  const icon = document.createElement('span');
  icon.className = 'folder-icon';
  icon.style.background = folder.color || COLORS[0];

  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = folder.name;

  const count = document.createElement('span');
  count.className = 'count';
  const n = recursiveCount(folder.id, counts, folders);
  count.textContent = n ? String(n) : '';

  const kebab = document.createElement('button');
  kebab.type = 'button';
  kebab.tabIndex = -1;
  kebab.className = 'folder-kebab';
  kebab.appendChild(svgIcon('dots'));
  kebab.setAttribute('aria-label', 'Folder actions for ' + folder.name);
  kebab.onclick = (e) => { e.stopPropagation(); openMenu(kebab, folderMenuItems(folder)); };

  row.append(caret, icon, name, count, kebab);
  row.onclick = () => {
    if (hasKids) view.expanded.add(folder.id);
    go('folder', folder.id);
    closeSidebarMobile();
  };

  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    draggedFolderId = folder.id;
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', folder.id);
  });
  row.addEventListener('dragend', () => { draggedFolderId = null; });
  const zone = (e: DragEvent) => {
    const rect = row.getBoundingClientRect();
    const relY = (e.clientY - rect.top) / rect.height;
    return relY < 0.25 ? 'before' : relY > 0.75 ? 'after' : 'inside';
  };
  row.addEventListener('dragover', (e) => {
    if (!draggedFolderId || draggedFolderId === folder.id) return;
    if (isDescendantOf(store.liveFolders(), folder.id, draggedFolderId)) return; // would create a cycle
    e.preventDefault();
    row.classList.remove('drop-before', 'drop-after', 'drop-inside');
    row.classList.add('drop-' + zone(e));
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-inside'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drop-before', 'drop-after', 'drop-inside');
    const dragged = draggedFolderId;
    draggedFolderId = null;
    if (!dragged || dragged === folder.id || isDescendantOf(store.liveFolders(), folder.id, dragged)) return;
    const z = zone(e);
    if (z === 'inside') { updateFolder(dragged, { parentId: folder.id }); view.expanded.add(folder.id); }
    else reorderFolder(dragged, folder.id, z);
  });

  li.appendChild(row);
  if (hasKids && isOpen) li.appendChild(buildLevel(folder.id, counts, folders));
  return li;
}

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

// ---- Mobile drawer ----
export function closeSidebarMobile(): void {
  byId('sidebar').classList.remove('open');
  byId('scrim').classList.remove('show');
  byId('menuBtn').setAttribute('aria-expanded', 'false');
}

export function initSidebar(): void {
  treeEl = byId('tree');
  setRenderer('nav', () => {
    const counts = linkCounts();
    renderViews(counts);
    const folders = store.liveFolders();
    treeEl.replaceChildren(...Array.from(buildLevel(null, counts.byFolder, folders).children));
    byId('treeEmpty').hidden = folders.some((f) => !f.isSystem);
    // Roving tabindex: exactly one tree item is tabbable.
    const items = getVisibleTreeItems();
    const active = items.find((it) => it.getAttribute('aria-selected') === 'true') || items[0];
    if (active) active.tabIndex = 0;
  });
  byId('menuBtn').onclick = () => {
    byId('sidebar').classList.add('open');
    byId('scrim').classList.add('show');
    byId('menuBtn').setAttribute('aria-expanded', 'true');
    setTimeout(() => byId('sidebarCloseBtn').focus(), 50);
  };
  byId('sidebarCloseBtn').onclick = () => { closeSidebarMobile(); byId('menuBtn').focus(); };
  byId('scrim').onclick = closeSidebarMobile;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && byId('sidebar').classList.contains('open')) { closeSidebarMobile(); byId('menuBtn').focus(); }
  });
  byId('newFolderTopBtn').onclick = () => openFolderModal();
}
