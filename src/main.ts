import './styles/app.css';
import { backfillThumbnails } from './actions';
import { openLocalDb } from './data/localStore';
import { migrateFromV1, upgradeLocalDb } from './data/migrate';
import { storageErrorMessage, store } from './data/store';
import { consumeSharePayload, firstSharedUrl } from './share/extractSharedUrl';
import { initAi } from './ai';
import { initAccount } from './ui/account';
import { initBackupModal } from './ui/backupModal';
import { byId } from './ui/dom';
import { initFiltersSheet } from './ui/filtersSheet';
import { initFolderDialogs } from './ui/folderDialogs';
import { initFolderPicker } from './ui/folderPicker';
import { initLinkEditor } from './ui/linkEditor';
import { initList } from './ui/list';
import { setupModalA11y } from './ui/modal';
import { applySharedPayload, initSaveBox, resetSaveTarget } from './ui/saveBox';
import { initIosHelp } from './ui/iosHelp';
import { initInstall, initSettings, initTheme } from './ui/settings';
import { initSidebar } from './ui/sidebar';
import { showToast } from './ui/toast';
import { go, onNavigate, renderAll, scheduleRender } from './ui/view';

const MODALS = ['folderModal', 'pickerModal', 'filtersSheet', 'linkModal', 'backupModal', 'settingsModal', 'accountModal', 'uploadModal', 'byokModal', 'iosHelpModal'];

async function boot(): Promise<void> {
  // Read the share params first, so they're cleared from the address bar
  // even if something below is slow.
  const shared = consumeSharePayload(window);

  let ls: Storage | null = null;
  try { ls = window.localStorage; } catch { ls = null; }

  const db = await openLocalDb();
  let warning: string | undefined;
  if (!db.persistent) warning = "Browser storage is unavailable (private browsing?) - changes won't be saved this session.";
  try {
    const result = await migrateFromV1(ls, db);
    if (result.warning) warning = result.warning;
    await upgradeLocalDb(db);
  } catch (e) {
    warning = "Couldn't load your saved data - " + storageErrorMessage(e);
  }
  await store.init(db);
  store.onPersistError = (e) => showToast("Couldn't save - " + storageErrorMessage(e), false);
  store.subscribe(scheduleRender);

  // Ask the browser not to evict our IndexedDB under storage pressure.
  if (db.persistent && navigator.storage?.persist) navigator.storage.persist().catch(() => {});

  initTheme();
  initFolderPicker();
  initSidebar();
  initFolderDialogs();
  initFiltersSheet();
  initLinkEditor();
  initList();
  initSaveBox();
  initSettings();
  initBackupModal();
  initInstall();
  initIosHelp(!!shared);
  MODALS.forEach((id) => setupModalA11y(byId(id)));
  onNavigate(resetSaveTarget);
  initDesktopShortcuts();

  go('all');
  renderAll();
  if (shared) applySharedPayload(shared);
  if (warning) showToast(warning, false, undefined, 6000);
  setTimeout(() => void backfillThumbnails(), 1500);
  // AI + account + sync load after the first render: guests never wait on them.
  initAi();
  void initAccount();
}

// Web affordances: "/" jumps to search, and pasting a link anywhere outside a
// text field drops it into the save box. Both stand down while a dialog is open.
function initDesktopShortcuts(): void {
  const typing = (t: EventTarget | null) =>
    t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement ||
    (t instanceof HTMLElement && t.isContentEditable);
  const dialogOpen = () => !!document.querySelector('.modal-backdrop.show');

  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || dialogOpen()) return;
    const search = byId<HTMLInputElement>('searchInput');
    if (search.offsetParent === null) return; // toolbar hidden (e.g. plan view)
    e.preventDefault();
    search.focus();
    search.select();
  });

  document.addEventListener('paste', (e) => {
    if (typing(e.target) || dialogOpen()) return;
    const url = firstSharedUrl([e.clipboardData?.getData('text')]);
    if (!url) return;
    e.preventDefault();
    const input = byId<HTMLInputElement>('urlInput');
    input.value = url;
    input.dispatchEvent(new Event('input'));
    input.focus();
  });
}

void boot();

// Registers the offline app-shell worker. Only in production builds (Vite's
// dev server has no sw.js) and only in secure contexts, where it's available.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {});
  });
}
