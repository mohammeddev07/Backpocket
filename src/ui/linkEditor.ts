import { store } from '../data/store';
import type { Link } from '../data/types';
import { allTags } from '../search/filters';
import { domainOf } from '../platform';
import { byId } from './dom';
import { pickFolder, setPickerButton } from './folderPicker';
import { closeModal, onModalClose, openModal } from './modal';
import { createTagInput, type TagInput } from './tagInput';
import { view } from './view';

// Edit a saved link: title, note, tags, folder and done status.

let editingId: string | null = null;
let folderId = '';
let tagInput: TagInput;
let onDelete: (ids: string[]) => void = () => {};

export function setEditorDeleteHandler(fn: (ids: string[]) => void): void { onDelete = fn; }

export function openLinkEditor(link: Link, focus: 'title' | 'note' | 'tags' = 'title'): void {
  editingId = link.id;
  folderId = link.folderId;
  byId('editUrl').textContent = domainOf(link.url);
  byId<HTMLInputElement>('editTitle').value = link.title || '';
  byId<HTMLTextAreaElement>('editNote').value = link.note || '';
  tagInput.set(link.tags);
  setPickerButton(byId('editFolderBtn'), folderId);
  byId<HTMLInputElement>('editDone').checked = link.status === 'done';
  const cap = byId('editCaptionWrap') as HTMLDetailsElement;
  cap.hidden = !link.sharedText;
  cap.open = false;
  byId('editCaption').textContent = link.sharedText || '';
  view.editing = true;
  openModal(byId('linkModal'));
  setTimeout(() => {
    if (focus === 'tags') tagInput.focus();
    else byId(focus === 'note' ? 'editNote' : 'editTitle').focus();
  }, 60);
}

function save(): void {
  const link = editingId ? store.link(editingId) : undefined;
  if (link) {
    const title = byId<HTMLInputElement>('editTitle').value.trim() || null;
    const titleChanged = title !== link.title;
    store.write('links', [{
      ...link,
      title,
      titleSource: titleChanged ? (title ? 'user' : null) : link.titleSource,
      note: byId<HTMLTextAreaElement>('editNote').value.trim() || null,
      tags: tagInput.get(),
      folderId,
      status: byId<HTMLInputElement>('editDone').checked ? 'done' : 'unread',
    }]);
  }
  closeModal(byId('linkModal'));
}

export function initLinkEditor(): void {
  const modal = byId('linkModal');
  tagInput = createTagInput(byId('editTags'), {
    placeholder: 'Add tags…', label: 'Tags', suggestions: () => allTags(store.liveLinks()),
  });
  onModalClose(modal, () => { editingId = null; view.editing = false; });
  byId('editCancelBtn').onclick = () => closeModal(modal);
  byId('editSaveBtn').onclick = save;
  byId('editTitle').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') save(); });
  byId('editDeleteBtn').onclick = () => {
    const id = editingId;
    closeModal(modal);
    if (id) onDelete([id]);
  };
  byId('editFolderBtn').onclick = async () => {
    const target = await pickFolder({ title: 'Move to', selectedId: folderId });
    if (!target) return;
    folderId = target;
    setPickerButton(byId('editFolderBtn'), folderId);
  };
}
