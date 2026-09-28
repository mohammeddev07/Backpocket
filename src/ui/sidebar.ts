import { moveFolderUpDown, reorderFolder, updateFolder } from '../actions';
import { store } from '../data/store';
import { childrenOf, isDescendantOf } from '../data/tree';
import type { Folder } from '../data/types';
import { COLORS } from '../data/migrate';
import { byId, svgIcon } from './dom';
import { openMenu, type MenuItem } from './menu';
import { clearFilters, renderAll, renderTree, setRenderer, view } from './view';
import { confirmDeleteFolder, openFolderModal, openMoveModal } from './folderDialogs';

let treeEl: HTMLElement;
let draggedFolderId: string | null = null;

function recursiveLinkCount(folderId: string): number {
  const folders = store.liveFolders();
  const ids = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
  }
  return store.liveLinks().filter((l) => ids.has(l.folderId)).length;
}

export function selectFolder(id: string): void {
  view.currentFolderId = id;
  view.saveTargetFolderId = id;
  view.searchEverywhere = false;
  clearFilters();
  renderAll();
}

function buildLevel(parentId: string | null): HTMLUListElement {
  const ul = document.createElement('ul');
  ul.setAttribute('role', 'group');
  ul.style.margin = '0'; ul.style.padding = '0'; ul.style.borderLeft = 'none'; ul.style.listStyle = 'none';
  childrenOf(store.liveFolders(), parentId).forEach((folder) => ul.appendChild(buildFolderLi(folder)));
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
  // Tree items nest, so a keydown bubbles through every ancestor treeitem's
  // listener too; stop it so only the focused item handles the key.
  e.stopPropagation();
  const items = getVisibleTreeItems();
  const idx = items.indexOf(li);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (items[idx + 1]) focusTreeItem(items[idx + 1]);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (items[idx - 1]) focusTreeItem(items[idx - 1]);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (hasKids && !view.expanded.has(folder.id)) {
      view.expanded.add(folder.id);
      renderTree();
      focusTreeItemById(folder.id);
    } else if (hasKids && items[idx + 1]) {
      focusTreeItem(items[idx + 1]);
    }
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (hasKids && view.expanded.has(folder.id)) {
      view.expanded.delete(folder.id);
      renderTree();
      focusTreeItemById(folder.id);
    } else if (folder.parentId) {
      focusTreeItemById(folder.parentId);
    }
  } else if (e.key === 'Home') {
    e.preventDefault();
    if (items[0]) focusTreeItem(items[0]);
  } else if (e.key === 'End') {
    e.preventDefault();
    if (items[items.length - 1]) focusTreeItem(items[items.length - 1]);
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    li.querySelector<HTMLElement>('.folder-row')!.click();
  }
}

function buildFolderLi(folder: Folder): HTMLLIElement {
  const li = document.createElement('li');
  const kids = childrenOf(store.liveFolders(), folder.id);
  const hasKids = kids.length > 0;
  const isOpen = view.expanded.has(folder.id);
  const isActive = folder.id === view.currentFolderId && !view.searchEverywhere;

  li.setAttribute('role', 'treeitem');
  li.setAttribute('aria-selected', String(isActive));
  if (hasKids) li.setAttribute('aria-expanded', String(isOpen));
  li.setAttribute('data-folder-id', folder.id);
  li.tabIndex = isActive ? 0 : -1;
  li.addEventListener('keydown', (e) => handleTreeKeydown(e, folder, li, hasKids));

  const row = document.createElement('div');
  row.className = 'folder-row' + (isActive ? ' active' : '');

  const caret = document.createElement('span');
  caret.className = 'caret' + (isOpen ? ' rot' : '') + (!hasKids ? ' hidden' : '');
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
  count.textContent = String(recursiveLinkCount(folder.id) || '');

  const kebab = document.createElement('button');
  kebab.type = 'button';
  kebab.className = 'folder-kebab';
  kebab.appendChild(svgIcon('dots'));
  kebab.setAttribute('aria-label', 'Folder actions for ' + folder.name);
  kebab.onclick = (e) => {
    e.stopPropagation();
    openMenu(kebab, folderMenuItems(folder));
  };

  row.append(caret, icon, name, count, kebab);
  row.onclick = () => {
    if (hasKids) view.expanded.add(folder.id);
    selectFolder(folder.id);
    closeSidebarMobile();
  };

  // Drag-and-drop nesting/reorder. The system folder can't be dragged but can
  // still be a drop target.
  row.draggable = !folder.isSystem;
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
  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-before', 'drop-after', 'drop-inside');
  });
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drop-before', 'drop-after', 'drop-inside');
    const dragged = draggedFolderId;
    draggedFolderId = null;
    if (!dragged || dragged === folder.id) return;
    if (isDescendantOf(store.liveFolders(), folder.id, dragged)) return;
    const z = zone(e);
    if (z === 'inside') {
      updateFolder(dragged, { parentId: folder.id });
      view.expanded.add(folder.id);
    } else {
      reorderFolder(dragged, folder.id, z);
    }
  });

  li.appendChild(row);
  if (hasKids && isOpen) li.appendChild(buildLevel(folder.id));
  return li;
}

export function folderMenuItems(folder: Folder): MenuItem[] {
  const siblings = childrenOf(store.liveFolders(), folder.parentId);
  const idx = siblings.findIndex((s) => s.id === folder.id);
  const items: MenuItem[] = [{ label: 'Edit folder', onClick: () => openFolderModal(folder.id) }];
  if (idx > 0) items.push({ label: 'Move up', onClick: () => moveFolderUpDown(folder.id, -1) });
  if (idx < siblings.length - 1) items.push({ label: 'Move down', onClick: () => moveFolderUpDown(folder.id, 1) });
  if (!folder.isSystem) {
    items.push({ label: 'Move to…', onClick: () => openMoveModal({ type: 'folder', ids: [folder.id] }) });
    items.push({ separator: true });
    items.push({ label: 'Delete folder', danger: true, onClick: () => confirmDeleteFolder(folder.id) });
  }
  return items;
}

// ---- Mobile drawer ----
export function closeSidebarMobile(): void {
  byId('sidebar').classList.remove('open');
  byId('scrim').classList.remove('show');
}

export function initSidebar(): void {
  treeEl = byId('tree');
  setRenderer('tree', () => {
    treeEl.replaceChildren(buildLevel(null));
  });
  byId('menuBtn').onclick = () => { byId('sidebar').classList.add('open'); byId('scrim').classList.add('show'); };
  byId('sidebarCloseBtn').onclick = closeSidebarMobile;
  byId('scrim').onclick = closeSidebarMobile;
  byId('newFolderTopBtn').onclick = () => openFolderModal();
}
