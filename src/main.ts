import './styles/app.css';
import { openLocalDb } from './data/localStore';
import { migrateFromV1, upgradeLocalDb } from './data/migrate';
import { storageErrorMessage, store } from './data/store';
import { consumeSharePayload } from './share/extractSharedUrl';
import { initBackupModal } from './ui/backupModal';
import { byId } from './ui/dom';
import { initFolderDialogs, rootFolderId } from './ui/folderDialogs';
import { initList } from './ui/list';
import { setupModalA11y } from './ui/modal';
import { applySharedPayload, initSaveBox } from './ui/saveBox';
import { initInstall, initSettings, initTheme } from './ui/settings';
import { initSidebar } from './ui/sidebar';
import { showToast } from './ui/toast';
import { renderAll, scheduleRender, view } from './ui/view';

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

  const root = rootFolderId();
  view.currentFolderId = root;
  view.saveTargetFolderId = root;
  view.expanded = new Set([root]);

  initTheme();
  initSidebar();
  initFolderDialogs();
  initList();
  initSaveBox();
  initSettings();
  initBackupModal();
  initInstall();
  ['folderModal', 'moveModal', 'duplicateModal', 'backupModal', 'settingsModal']
    .forEach((id) => setupModalA11y(byId(id)));

  renderAll();
  if (shared) applySharedPayload(shared);
  if (warning) showToast(warning, false, undefined, 6000);
}

void boot();

// Registers the offline app-shell worker. Only in production builds (Vite's
// dev server has no sw.js) and only in secure contexts, where it's available.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {});
  });
}
