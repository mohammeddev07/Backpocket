import { store } from '../data/store';
import { descendantIds, flattenTree, pathLabel } from '../data/tree';
import type { Folder } from '../data/types';
import { COLORS } from '../data/migrate';
import { byId, svgIcon } from './dom';
import { closeModal, onModalClose, openModal } from './modal';

// Searchable, indented folder tree in a bottom sheet. Used by the save box's
// "To" picker, Move to…, the link editor and the folder modal's parent field.

export interface PickOptions {
  title: string;
  selectedId?: string | null;
  /** Folders to hide, with all their subfolders (e.g. a folder can't move into itself). */
  excludeIds?: string[];
  /** Offer "Top level" (returns null). */
  allowTopLevel?: boolean;
  includeInbox?: boolean;
  allowCreate?: boolean;
}

/** Resolves to a folder id, null for "Top level", or undefined when cancelled. */
type Result = string | null | undefined;

let resolver: ((r: Result) => void) | null = null;
let current: PickOptions = { title: '' };
let createHook: ((parentId: string | null, done: (id: string | undefined) => void) => void) | null = null;

/** folderDialogs registers how "+ New folder" opens the folder modal (avoids an import cycle). */
export function setPickerCreateHook(fn: typeof createHook): void { createHook = fn; }

export function folderPath(id: string | null): string {
  return id ? pathLabel(store.liveFolders(), id) : 'Top level';
}

/** Fills a picker button with the folder's colour dot and full path. */
export function setPickerButton(btn: HTMLElement, id: string | null): void {
  const f = id ? store.folder(id) : undefined;
  btn.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'folder-icon';
  dot.style.background = f ? (f.color || COLORS[0]) : 'var(--line)';
  const label = document.createElement('span');
  label.className = 'picker-btn-label';
  label.textContent = folderPath(id);
  btn.append(dot, label, svgIcon('chevron-down'));
  btn.dataset.value = id ?? '';
}

function finish(r: Result): void {
  const res = resolver;
  resolver = null;
  closeModal(byId('pickerModal'));
  res?.(r);
}

function visibleFolders(): Array<{ folder: Folder; depth: number }> {
  const folders = store.liveFolders();
  const hidden = new Set<string>();
  for (const id of current.excludeIds || []) { hidden.add(id); descendantIds(folders, id).forEach((d) => hidden.add(d)); }
  const items = flattenTree(folders).filter(({ folder }) => !hidden.has(folder.id));
  // The Inbox sorts first; it never has subfolders.
  items.sort((a, b) => Number(b.folder.isSystem) - Number(a.folder.isSystem));
  return current.includeInbox === false ? items.filter(({ folder }) => !folder.isSystem) : items;
}

function renderList(): void {
  const list = byId('pickerList');
  const q = byId<HTMLInputElement>('pickerSearch').value.trim().toLowerCase();
  const folders = store.liveFolders();
  list.replaceChildren();

  const option = (id: string | null, name: string, depth: number, color: string, sub?: string) => {
    const li = document.createElement('li');
    li.className = 'picker-item';
    li.setAttribute('role', 'option');
    const selected = (current.selectedId ?? null) === id;
    li.setAttribute('aria-selected', String(selected));
    li.tabIndex = -1;
    li.dataset.id = id ?? '';
    li.style.setProperty('--depth', String(depth));
    const dot = document.createElement('span');
    dot.className = 'folder-icon';
    dot.style.background = color;
    const label = document.createElement('span');
    label.className = 'picker-name';
    label.textContent = name;
    li.append(dot, label);
    if (sub) {
      const s = document.createElement('span');
      s.className = 'picker-path';
      s.textContent = sub;
      li.appendChild(s);
    }
    if (selected) li.appendChild(svgIcon('check'));
    li.onclick = () => finish(id);
    list.appendChild(li);
  };

  if (current.allowTopLevel && (!q || 'top level'.includes(q))) option(null, 'Top level', 0, 'var(--line)');
  for (const { folder, depth } of visibleFolders()) {
    if (q) {
      const path = pathLabel(folders, folder.id);
      if (!path.toLowerCase().includes(q)) continue;
      const parent = folder.parentId ? pathLabel(folders, folder.parentId) : '';
      option(folder.id, folder.name, 0, folder.color || COLORS[0], parent);
    } else {
      option(folder.id, folder.name, depth, folder.color || COLORS[0]);
    }
  }
  if (!list.children.length) {
    const empty = document.createElement('li');
    empty.className = 'picker-empty';
    empty.textContent = 'No folders match.';
    list.appendChild(empty);
  }
  const sel = list.querySelector<HTMLElement>('[aria-selected="true"]') || list.querySelector<HTMLElement>('.picker-item');
  if (sel) sel.tabIndex = 0;
}

export function pickFolder(opts: PickOptions): Promise<Result> {
  if (resolver) finish(undefined);
  current = { includeInbox: true, allowCreate: true, ...opts };
  byId('pickerTitle').textContent = opts.title;
  byId('pickerNewBtn').hidden = !current.allowCreate || !createHook;
  const search = byId<HTMLInputElement>('pickerSearch');
  search.value = '';
  renderList();
  openModal(byId('pickerModal'));
  // Few folders: focus the selected one, not the search (no keyboard pop-up on phones).
  setTimeout(() => {
    const sel = byId('pickerList').querySelector<HTMLElement>('[aria-selected="true"]');
    if (store.liveFolders().length > 12) search.focus();
    else if (sel) { sel.focus(); sel.scrollIntoView({ block: 'nearest' }); }
  }, 60);
  return new Promise((resolve) => { resolver = resolve; });
}

export function initFolderPicker(): void {
  const modal = byId('pickerModal');
  onModalClose(modal, () => { if (resolver) { const r = resolver; resolver = null; r(undefined); } });
  byId('pickerCancelBtn').onclick = () => finish(undefined);
  byId('pickerSearch').addEventListener('input', renderList);
  byId('pickerSearch').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); byId('pickerList').querySelector<HTMLElement>('.picker-item')?.focus(); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = byId('pickerList').querySelector<HTMLElement>('.picker-item');
      if (first) first.click();
    }
  });
  byId('pickerList').addEventListener('keydown', (e) => {
    const items = Array.from(byId('pickerList').querySelectorAll<HTMLElement>('.picker-item'));
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(i + 1, items.length - 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) byId('pickerSearch').focus(); else items[i - 1].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (document.activeElement as HTMLElement)?.click(); }
  });
  byId('pickerNewBtn').onclick = () => {
    if (!createHook) return;
    const res = resolver;
    resolver = null;
    closeModal(modal);
    const sel = current.selectedId;
    const parent = sel && store.folder(sel) && !store.folder(sel)!.isSystem ? sel : null;
    createHook(parent, (id) => res?.(id));
  };
}
