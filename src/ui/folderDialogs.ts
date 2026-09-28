import { createFolder, deleteFolderRecursive, moveFolder, moveLinks, updateFolder } from '../actions';
import { COLORS } from '../data/migrate';
import { store } from '../data/store';
import { descendantIds, flattenTree, pathLabel } from '../data/tree';
import { byId, plural } from './dom';
import { closeModal, onModalClose, openModal } from './modal';
import { showToast } from './toast';
import { renderAll, view } from './view';

let editingFolderId: string | null = null;
let selectedColor = COLORS[0];

function fillFolderSelect(select: HTMLSelectElement, excluded: string[]): void {
  select.replaceChildren();
  const folders = store.liveFolders();
  for (const { folder } of flattenTree(folders)) {
    if (excluded.includes(folder.id)) continue;
    const opt = document.createElement('option');
    opt.value = folder.id;
    opt.textContent = pathLabel(folders, folder.id);
    select.appendChild(opt);
  }
}

function renderColorPicker(): void {
  const colorPicker = byId('colorPicker');
  colorPicker.replaceChildren();
  COLORS.forEach((c) => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'color-swatch' + (c === selectedColor ? ' selected' : '');
    sw.style.background = c;
    sw.setAttribute('aria-label', 'Color ' + c);
    sw.setAttribute('aria-pressed', String(c === selectedColor));
    sw.onclick = () => { selectedColor = c; renderColorPicker(); };
    colorPicker.appendChild(sw);
  });
}

// ---- Folder modal (new / edit) ----
export function openFolderModal(folderId?: string, opts: { parentId?: string | null; name?: string; onCreated?: (id: string) => void } = {}): void {
  editingFolderId = folderId || null;
  const editing = !!editingFolderId;
  const f = editing ? store.folder(editingFolderId) : undefined;
  const isSystem = !!f?.isSystem;
  byId('folderModalTitle').textContent = editing ? 'Edit folder' : 'New folder';
  byId('createFolderBtn').textContent = editing ? 'Save changes' : 'Create';
  byId('deleteFolderBtn').hidden = !editing || isSystem;
  byId('folderParentLabel').style.display = isSystem ? 'none' : '';
  const parentSelect = byId<HTMLSelectElement>('folderParent');
  parentSelect.style.display = isSystem ? 'none' : '';

  const excluded = editing ? [editingFolderId!, ...descendantIds(store.liveFolders(), editingFolderId!)] : [];
  fillFolderSelect(parentSelect, excluded);
  const nameInput = byId<HTMLInputElement>('folderName');
  if (f) {
    nameInput.value = f.name;
    selectedColor = f.color || COLORS[0];
    parentSelect.value = f.parentId || '';
  } else {
    nameInput.value = opts.name || '';
    selectedColor = COLORS[Math.floor(Math.random() * COLORS.length)];
    parentSelect.value = opts.parentId !== undefined ? (opts.parentId || '') : defaultParentId();
  }
  pendingOnCreated = opts.onCreated || null;
  renderColorPicker();
  openModal(byId('folderModal'));
  setTimeout(() => nameInput.focus(), 50);
}
let pendingOnCreated: ((id: string) => void) | null = null;

/** Where a new folder goes by default: inside the folder being viewed. */
function defaultParentId(): string {
  return view.searchEverywhere ? 'root' : view.currentFolderId;
}

function submitFolderModal(): void {
  const nameInput = byId<HTMLInputElement>('folderName');
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  const parentSelect = byId<HTMLSelectElement>('folderParent');
  const parentId = parentSelect.value || null;
  if (editingFolderId) {
    const f = store.folder(editingFolderId);
    updateFolder(editingFolderId, { name, color: selectedColor, ...(f?.isSystem ? {} : { parentId }) });
    closeModal(byId('folderModal'));
    showToast('Folder updated', true);
  } else {
    const created = createFolder(name, selectedColor, parentId);
    if (parentId) view.expanded.add(parentId);
    const cb = pendingOnCreated;
    closeModal(byId('folderModal'));
    if (cb) { cb(created.id); return; }
    view.currentFolderId = created.id;
    view.saveTargetFolderId = created.id;
    view.searchEverywhere = false;
    renderAll();
  }
}

export function confirmDeleteFolder(folderId: string): void {
  const folder = store.folder(folderId);
  if (!folder || folder.isSystem) return;
  const folders = store.liveFolders();
  const sub = descendantIds(folders, folderId);
  const ids = new Set([folderId, ...sub]);
  const totalLinks = store.liveLinks().filter((l) => ids.has(l.folderId)).length;
  if (totalLinks > 0 || sub.length > 0) {
    const parts: string[] = [];
    if (totalLinks > 0) parts.push(plural(totalLinks, 'link'));
    if (sub.length > 0) parts.push(plural(sub.length, 'subfolder'));
    const ok = confirm('Delete "' + folder.name + '" and everything inside it (' + parts.join(' and ') + ')? This can\'t be undone.');
    if (!ok) return;
  }
  const removed = deleteFolderRecursive(folderId);
  if (removed.includes(view.currentFolderId)) view.currentFolderId = rootFolderId();
  if (removed.includes(view.saveTargetFolderId)) view.saveTargetFolderId = rootFolderId();
  view.expanded.delete(folderId);
  renderAll();
  showToast('Deleted "' + folder.name + '"', true);
}

export function rootFolderId(): string {
  return store.liveFolders().find((f) => f.isSystem)?.id || 'root';
}

// ---- Move modal (links and folders) ----
type MoveContext = { type: 'folder' | 'link'; ids: string[]; onDone?: () => void };
let moveContext: MoveContext | null = null;

export function openMoveModal(ctx: MoveContext): void {
  moveContext = ctx;
  byId('moveModalTitle').textContent = ctx.type === 'folder'
    ? 'Move folder'
    : (ctx.ids.length > 1 ? 'Move ' + ctx.ids.length + ' links' : 'Move link');
  const excluded = ctx.type === 'folder' ? [ctx.ids[0], ...descendantIds(store.liveFolders(), ctx.ids[0])] : [];
  const select = byId<HTMLSelectElement>('moveTargetSelect');
  fillFolderSelect(select, excluded);
  select.value = ctx.type === 'folder'
    ? (store.folder(ctx.ids[0])?.parentId || rootFolderId())
    : (store.link(ctx.ids[0])?.folderId || view.currentFolderId);
  openModal(byId('moveModal'));
  setTimeout(() => select.focus(), 50);
}

function confirmMove(): void {
  if (!moveContext) return;
  const targetId = byId<HTMLSelectElement>('moveTargetSelect').value;
  const dest = store.folder(targetId);
  if (!dest) return;
  const ctx = moveContext;
  if (ctx.type === 'folder') {
    moveFolder(ctx.ids[0], targetId);
    view.expanded.add(targetId);
  } else {
    moveLinks(ctx.ids, targetId);
  }
  closeModal(byId('moveModal'));
  ctx.onDone?.();
  showToast('Moved to ' + dest.name, true);
}

export function initFolderDialogs(): void {
  const folderModal = byId('folderModal');
  onModalClose(folderModal, () => { editingFolderId = null; pendingOnCreated = null; });
  byId('cancelFolderBtn').onclick = () => closeModal(folderModal);
  byId('createFolderBtn').onclick = submitFolderModal;
  byId('folderName').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') submitFolderModal(); });
  byId('deleteFolderBtn').onclick = () => {
    const id = editingFolderId;
    closeModal(folderModal);
    if (id) confirmDeleteFolder(id);
  };

  const moveModal = byId('moveModal');
  onModalClose(moveModal, () => { moveContext = null; });
  byId('cancelMoveBtn').onclick = () => closeModal(moveModal);
  byId('confirmMoveBtn').onclick = confirmMove;
}
