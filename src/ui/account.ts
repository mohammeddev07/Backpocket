import { accessToken, currentUser, initAuth, oauthCallbackInfo, onAuthChange, signInWithGoogle, signOut, type AuthUser } from '../cloud/auth';
import { functionUrl } from '../cloud/supabase';
import { CLOUD_CONFIGURED, SUPABASE_ANON_KEY } from '../config';
import { countLive, hasGuestData, mergeGuestIntoAccount } from '../data/accountMerge';
import { freshInboxSnapshot } from '../data/migrate';
import { store } from '../data/store';
import {
  adoptAccount, fetchAccount, installSyncTriggers, linkedUserId, onSyncState, requestSync, setSyncState,
  startSync, stopSync, syncState, unlinkAccount, type SyncState,
} from '../data/sync';
import { isIos, isStandalone } from '../platform';
import { openBackupModal } from './backupModal';
import { byId, plural } from './dom';
import { relativeTime } from './format';
import { closeModal, onModalClose, openModal } from './modal';
import { showToast } from './toast';
import { go } from './view';

// Account: Google sign-in, first-sign-in upload of guest data, sign out,
// account deletion, and the sync status line in the drawer footer.

type AccountListener = (u: AuthUser | null) => void;
const accountListeners: AccountListener[] = [];
/** Other features (AI) react to the signed-in account. */
export function onAccountChange(fn: AccountListener): void { accountListeners.push(fn); }

function initials(u: AuthUser): string {
  const src = u.name || u.email || '?';
  return src.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

// ---- Status line ("Synced · 2 min ago") ----
function renderStatus(s: SyncState = syncState()): void {
  const el = byId('storageNote');
  el.replaceChildren();
  const text = (t: string) => el.appendChild(document.createTextNode(t));
  const action = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'text-btn inline';
    b.textContent = label;
    b.onclick = fn;
    el.append(' · ', b);
  };
  el.dataset.status = s.status;
  switch (s.status) {
    case 'local': text('Stored on this browser'); break;
    case 'signed-out': text('Signed out · changes stay on this device'); break;
    case 'pending-link':
      text(s.message || 'Your local saves aren\'t in your account yet');
      action('Upload', () => { const u = currentUser(); if (u) void connectAccount(u, true); });
      break;
    case 'syncing': text(s.message || 'Syncing…'); break;
    case 'synced': text('Synced · ' + (s.lastSyncedAt ? relativeTime(s.lastSyncedAt) : 'just now')); break;
    case 'offline': text('Offline - changes will sync'); break;
    case 'error': text('Sync paused'); action('Retry', () => requestSync(0)); break;
  }
  if (s.message && s.status === 'error') el.title = s.message; else el.removeAttribute('title');
}

// ---- Drawer + settings account UI ----
function renderAccount(u: AuthUser | null): void {
  const btn = byId('accountBtn');
  btn.hidden = !CLOUD_CONFIGURED;
  const avatar = byId('accountAvatar');
  if (u) {
    avatar.textContent = initials(u);
    byId('accountName').textContent = u.name || u.email || 'Signed in';
    byId('accountSub').textContent = u.email && u.name ? u.email : 'Account & sync';
    btn.setAttribute('aria-label', 'Account: ' + (u.email || u.name || 'signed in'));
  } else {
    avatar.innerHTML = '<svg class="icon"><use href="#i-cloud"/></svg>';
    byId('accountName').textContent = 'Sign in to sync';
    byId('accountSub').textContent = 'Use your saves on every device';
    btn.removeAttribute('aria-label');
  }

  const section = byId('settingsAccount');
  section.hidden = !CLOUD_CONFIGURED;
  const desc = byId('settingsAccountDesc');
  const actions = byId('settingsAccountActions');
  actions.replaceChildren();
  const add = (label: string, fn: () => void, cls = 'btn-ghost') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.onclick = fn;
    actions.appendChild(b);
  };
  if (u) {
    desc.textContent = 'Signed in as ' + (u.email || u.name) + '. Your saves sync across devices.';
    add('Sign out', () => void doSignOut(false));
    add('Sign out and remove from this device', () => void doSignOut(true));
    add('Export (.json)', () => { closeModal(byId('settingsModal')); openBackupModal(); });
    add('Delete my account and cloud data', () => void deleteAccount(), 'btn-ghost danger');
  } else {
    desc.textContent = 'You\'re using Backpocket without an account. Sign in to sync and use AI.';
    add('Continue with Google', () => { closeModal(byId('settingsModal')); openSignIn(); }, 'btn-primary');
  }
}

// ---- Sign in ----
export function openSignIn(message?: string): void {
  const hint = byId('iosAuthHint');
  // iOS home-screen apps can hand the OAuth redirect to Safari, whose storage
  // is separate from the app's, so warn before starting.
  if (isIos() && isStandalone()) {
    hint.textContent = 'On iPhone, Google sign-in may finish in Safari instead of this app. If that happens, close Safari, come back here and tap Continue with Google again. If it keeps happening, use Backpocket in Safari and sign in there.';
    hint.hidden = false;
  } else hint.hidden = true;
  const err = byId('accountError');
  err.hidden = !message;
  err.textContent = message || '';
  byId<HTMLButtonElement>('googleSignInBtn').disabled = false;
  openModal(byId('accountModal'));
}

function explainCallbackProblem(): void {
  const cb = oauthCallbackInfo();
  if (!cb.isCallback || !cb.error) return;
  if (cb.wrongBrowser) {
    openSignIn(isIos() && !isStandalone()
      ? 'You started signing in from the Backpocket home-screen app, but it finished here in Safari - on iPhone the two keep separate storage. Go back to the home-screen app and tap Continue with Google again, or tap it below to sign in here in Safari instead.'
      : 'Sign-in finished in a different browser window than the one that started it. Try again from here.');
  } else {
    openSignIn('Sign-in didn\'t complete: ' + cb.error);
  }
}

// ---- First sign-in / account switch ----
function askUpload(localCount: number, added: number, skipped: number): Promise<boolean> {
  byId('uploadTitle').textContent = 'Upload your ' + plural(localCount, 'save') + ' to your account?';
  byId('uploadText').textContent =
    'They\'ll be added to anything already in your account. ' +
    (skipped ? plural(skipped, 'link') + ' already there will be skipped, ' : 'Duplicates are skipped, ') +
    'and folders with the same name are combined' + (added ? ' (' + plural(added, 'new link') + ').' : '.') +
    ' Your copy on this device is kept until the upload finishes.';
  byId('uploadError').hidden = true;
  openModal(byId('uploadModal'));
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => { if (settled) return; settled = true; resolve(v); };
    byId('uploadConfirmBtn').onclick = () => done(true);
    byId('uploadLaterBtn').onclick = () => { done(false); closeModal(byId('uploadModal')); };
    onModalClose(byId('uploadModal'), () => done(false));
  });
}

let connecting = false;
/** Links this device's data with the signed-in account (runs on every sign-in). */
async function connectAccount(u: AuthUser, forcePrompt = false): Promise<void> {
  if (connecting) return;
  connecting = true;
  try {
    const linked = await linkedUserId();
    if (linked === u.id && !forcePrompt) { startSync(u.id); return; }

    setSyncState({ status: 'syncing', message: 'Connecting your account…' });
    const account = await fetchAccount();
    const local = store.snapshot();

    if (linked && linked !== u.id) {
      // This device mirrors a different account. Its data lives in that
      // account's cloud; only unsynced edits would be lost.
      const pending = (await store.db.outboxAll()).length;
      if (pending && !confirm('This device has ' + plural(pending, 'unsynced change') + ' from another account. Switch to ' + (u.email || 'this account') + ' anyway? Those changes will be lost (Backup & import can save a copy first).')) {
        await signOut();
        return;
      }
      await adoptAccount(u.id, account);
      go('all');
      showToast('Signed in as ' + (u.email || 'your account'), true);
      return;
    }

    if (hasGuestData(local)) {
      const merge = mergeGuestIntoAccount(local, account.snapshot, u.id);
      const ok = await askUpload(countLive(local), merge.addedLinks, merge.skippedDuplicates);
      if (!ok) { stopSync('pending-link'); return; }
      const btn = byId<HTMLButtonElement>('uploadConfirmBtn');
      btn.disabled = true;
      btn.textContent = 'Uploading…';
      try {
        await adoptAccount(u.id, account, merge);
        closeModal(byId('uploadModal'));
        go('all');
        showToast('Uploaded ' + plural(merge.addedLinks, 'link') +
          (merge.skippedDuplicates ? ' (' + merge.skippedDuplicates + ' already there)' : ''), true);
      } catch (e) {
        const err = byId('uploadError');
        err.textContent = 'Upload failed - nothing was changed on this device. ' + ((e as Error)?.message || '');
        err.hidden = false;
        stopSync('pending-link', 'Upload failed - your saves are still on this device');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Upload';
      }
      return;
    }

    await adoptAccount(u.id, account);
    go('all');
  } catch (e) {
    setSyncState({ status: 'error', message: (e as Error)?.message });
  } finally {
    connecting = false;
  }
}

let handledUserId: string | null | undefined;
async function onUser(u: AuthUser | null): Promise<void> {
  const id = u?.id ?? null;
  if (id === handledUserId) return;
  handledUserId = id;
  renderAccount(u);
  accountListeners.forEach((fn) => fn(u));
  if (!u) {
    stopSync((await linkedUserId()) ? 'signed-out' : 'local');
    return;
  }
  await connectAccount(u);
}

// ---- Sign out / delete ----
async function doSignOut(removeLocal: boolean): Promise<void> {
  if (removeLocal) {
    const pending = (await store.db.outboxAll()).length;
    const msg = pending
      ? plural(pending, 'change') + ' haven\'t synced yet and will be lost. Sign out and remove everything from this device?'
      : 'Sign out and remove your saves from this device? They stay in your account.';
    if (!confirm(msg)) return;
  }
  await signOut();
  if (removeLocal) {
    await unlinkAccount();
    await store.replaceAll(freshInboxSnapshot());
    go('all');
    stopSync('local');
  }
  closeModal(byId('settingsModal'));
  showToast(removeLocal ? 'Signed out and removed from this device' : 'Signed out', true);
}

async function deleteAccount(): Promise<void> {
  const u = currentUser();
  if (!u) return;
  if (!confirm('Delete your Backpocket account and everything stored in the cloud? This can\'t be undone.')) return;
  if (!confirm('Last check: permanently delete the account ' + (u.email || '') + ' and all its cloud data?')) return;
  try {
    const token = await accessToken();
    const res = await fetch(functionUrl('delete-account'), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) throw new Error('the server said ' + res.status);
  } catch (e) {
    showToast('Couldn\'t delete the account - ' + ((e as Error)?.message || 'try again'), false, undefined, 6000);
    return;
  }
  const keep = confirm('Your account is deleted. Keep a copy of your saves on this device (without an account)?');
  await unlinkAccount();
  if (!keep) await store.replaceAll(freshInboxSnapshot());
  await signOut().catch(() => {});
  closeModal(byId('settingsModal'));
  go('all');
  stopSync('local');
  showToast('Account deleted', true);
}

export async function initAccount(): Promise<void> {
  renderStatus();
  onSyncState(renderStatus);
  setInterval(() => { if (syncState().status === 'synced') renderStatus(); }, 30_000);
  renderAccount(null);
  if (!CLOUD_CONFIGURED) return;

  byId('accountBtn').onclick = () => {
    if (currentUser()) { openModal(byId('settingsModal')); return; }
    openSignIn();
  };
  byId('accountCloseBtn').onclick = () => closeModal(byId('accountModal'));
  byId('googleSignInBtn').onclick = async () => {
    const btn = byId<HTMLButtonElement>('googleSignInBtn');
    btn.disabled = true;
    try { await signInWithGoogle(); } catch (e) {
      btn.disabled = false;
      const err = byId('accountError');
      err.textContent = navigator.onLine ? 'Couldn\'t start sign-in: ' + ((e as Error)?.message || 'unknown error') : 'You\'re offline. Connect to the internet to sign in.';
      err.hidden = false;
    }
  };

  installSyncTriggers();
  // A device already linked to an account keeps queueing edits even while
  // signed out, so they upload on the next sign-in.
  if (await linkedUserId()) { store.trackOutbox = true; setSyncState({ status: 'signed-out' }); }

  try {
    const u = await initAuth();
    onAuthChange((next) => void onUser(next));
    explainCallbackProblem();
    await onUser(u);
  } catch (e) {
    setSyncState({ status: 'error', message: (e as Error)?.message });
  }
}
