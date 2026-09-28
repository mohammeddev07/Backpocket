import { createFolder, deleteFolderRecursive, inboxId, moveFolder, moveLinks, updateFolder } from '../actions';
import { COLORS } from '../data/migrate';
import { store } from '../data/store';
import { descendantIds } from '../data/tree';
import { byId, plural } from './dom';
import { pickFolder, setPickerButton, setPickerCreateHook } from './folderPicker';
import { closeModal, onModalClose, openModal } from './modal';
import { showToast } from './toast';
import { go, view } from './view';

let editingFolderId: string | null = null;
let selectedColor = COLORS[0];
let parentId: string | null = null;
let onCreated: ((id: string | undefined) => void) | null = null;
let navigateOnCreate = true;

function renderColorPicker(): void {
  const colorPicker = byId('colorPicker');
  colorPicker.replaceChildren();
  COLORS.forEach((c, i) => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'color-swatch' + (c === selectedColor ? ' selected' : '');
    sw.style.background = c;
    sw.setAttribute('aria-label', 'Color ' + (i + 1) + ' of ' + COLORS.length);
    sw.setAttribute('aria-pressed', String(c === selectedColor));
    sw.onclick = () => { selectedColor = c; renderColorPicker(); };
    colorPicker.appendChild(sw);
  });
}

// ---- Folder modal (new / edit) ----
export function openFolderModal(folderId?: string, opts: {
  parentId?: string | null; name?: string; onCreated?: (id: string | undefined) => void;
} = {}): void {
  editingFolderId = folderId || null;
  const f = editingFolderId ? store.folder(editingFolderId) : undefined;
  const isSystem = !!f?.isSystem;
  byId('folderModalTitle').textContent = f ? 'Edit folder' : 'New folder';
  byId('createFolderBtn').textContent = f ? 'Save changes' : 'Create';
  byId('deleteFolderBtn').hidden = !f || isSystem;
  byId('folderParentLabel').hidden = isSystem;
  byId('folderParentBtn').hidden = isSystem;
  const nameInput = byId<HTMLInputElement>('folderName');
  nameInput.disabled = isSystem;

  if (f) {
    nameInput.value = f.name;
    selectedColor = f.color || COLORS[0];
    parentId = f.parentId;
  } else {
    nameInput.value = opts.name || '';
    selectedColor = COLORS[Math.floor(Math.random() * COLORS.length)];
    // Default: inside the folder being viewed (never inside the Inbox).
    const viewing = view.mode === 'folder' ? store.folder(view.folderId) : undefined;
    parentId = opts.parentId !== undefined ? opts.parentId : (viewing && !viewing.isSystem ? viewing.id : null);
  }
  onCreated = opts.onCreated || null;
  navigateOnCreate = !opts.onCreated;
  setPickerButton(byId('folderParentBtn'), parentId);
  renderColorPicker();
  openModal(byId('folderModal'));
  setTimeout(() => (isSystem ? byId('colorPicker').querySelector<HTMLElement>('button') : nameInput)?.focus(), 50);
}

function submitFolderModal(): void {
  const nameInput = byId<HTMLInputElement>('folderName');
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  if (editingFolderId) {
    updateFolder(editingFolderId, { name, color: selectedColor, parentId });
    closeModal(byId('folderModal'));
    showToast('Folder updated', true);
    return;
  }
  const created = createFolder(name, selectedColor, parentId);
  if (parentId) view.expanded.add(parentId);
  const cb = onCreated;
  onCreated = null;
  closeModal(byId('folderModal'));
  if (cb) cb(created.id);
  else if (navigateOnCreate) go('folder', created.id);
}

export function confirmDeleteFolder(folderId: string): void {
  const folder = store.folder(folderId);
  if (!folder || folder.isSystem) return;
  const sub = descendantIds(store.liveFolders(), folderId);
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
  view.expanded.delete(folderId);
  if (removed.includes(view.saveTargetId)) view.saveTargetId = inboxId();
  if (view.mode === 'folder' && removed.includes(view.folderId)) go('all');
  showToast('Deleted "' + folder.name + '"', true);
}

// ---- Move (links and folders) via the folder picker ----
export async function openMoveLinks(ids: string[], onDone?: () => void): Promise<void> {
  const first = store.link(ids[0]);
  const target = await pickFolder({
    title: ids.length > 1 ? 'Move ' + ids.length + ' links to' : 'Move to',
    selectedId: ids.length === 1 ? first?.folderId : null,
  });
  if (!target) return;
  moveLinks(ids, target);
  onDone?.();
  showToast('Moved to ' + (store.folder(target)?.name || 'folder'), true);
}

export async function openMoveFolder(folderId: string): Promise<void> {
  const f = store.folder(folderId);
  if (!f || f.isSystem) return;
  const target = await pickFolder({
    title: 'Move "' + f.name + '" to', selectedId: f.parentId, excludeIds: [folderId],
    allowTopLevel: true, includeInbox: false, allowCreate: false,
  });
  if (target === undefined) return;
  moveFolder(folderId, target);
  if (target) view.expanded.add(target);
  showToast('Moved to ' + (target ? store.folder(target)?.name : 'top level'), true);
}

export function initFolderDialogs(): void {
  const folderModal = byId('folderModal');
  onModalClose(folderModal, () => {
    editingFolderId = null;
    const cb = onCreated;
    onCreated = null;
    cb?.(undefined);
  });
  byId('cancelFolderBtn').onclick = () => closeModal(folderModal);
  byId('createFolderBtn').onclick = submitFolderModal;
  byId('folderName').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') submitFolderModal(); });
  byId('deleteFolderBtn').onclick = () => {
    const id = editingFolderId;
    closeModal(folderModal);
    if (id) confirmDeleteFolder(id);
  };
  byId('folderParentBtn').onclick = async () => {
    const target = await pickFolder({
      title: 'Put the folder inside', selectedId: parentId, excludeIds: editingFolderId ? [editingFolderId] : [],
      allowTopLevel: true, includeInbox: false, allowCreate: false,
    });
    if (target === undefined) return;
    parentId = target;
    setPickerButton(byId('folderParentBtn'), parentId);
  };
  // "+ New folder" inside the picker opens this modal and hands the new id back.
  setPickerCreateHook((parent, done) => openFolderModal(undefined, { parentId: parent, onCreated: done }));
}
