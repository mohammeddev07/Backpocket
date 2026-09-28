import { IOS_SHORTCUT_URL } from '../config';
import { store } from '../data/store';
import { isIos, isStandalone } from '../platform';
import { byId } from './dom';
import { fallbackCopy } from './list';
import { closeModal, openModal } from './modal';
import { showToast } from './toast';

// Sharing into Backpocket without the Android share target: an Apple Shortcut
// on iPhone and a bookmarklet on desktop. Both open the app with ?url=…, which
// goes through the same share handling as Android (fill the form, clear the
// params; sort-on-save runs when the link is saved).

/** e.g. https://mohammeddev07.github.io/Backpocket/?url= */
export function shareEntryUrl(): string {
  return window.location.origin + import.meta.env.BASE_URL + '?url=';
}

export function bookmarkletCode(): string {
  const base = JSON.stringify(shareEntryUrl());
  return 'javascript:(()=>{window.open(' + base +
    '+encodeURIComponent(location.href)+"&title="+encodeURIComponent(document.title),"_blank","noopener")})()';
}

function copy(text: string, what: string): void {
  const done = () => showToast(what + ' copied', true);
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}

export function openIosHelp(): void {
  store.setSettings({ iosHelpShown: true });
  byId('iosOpenUrl').textContent = shareEntryUrl();
  const ready = byId('iosShortcutReady');
  ready.hidden = !IOS_SHORTCUT_URL;
  if (IOS_SHORTCUT_URL) byId<HTMLAnchorElement>('iosShortcutLink').href = IOS_SHORTCUT_URL;
  byId('iosStepsLabel').textContent = IOS_SHORTCUT_URL ? 'Or build it yourself (about 2 minutes):' : 'Build it once (about 2 minutes):';
  openModal(byId('iosHelpModal'));
}

export function initIosHelp(openedFromShare: boolean): void {
  byId('iosHelpBtn').onclick = () => { closeModal(byId('settingsModal')); openIosHelp(); };
  byId('iosHelpCloseBtn').onclick = () => closeModal(byId('iosHelpModal'));
  byId('iosCopyUrlBtn').onclick = () => copy(shareEntryUrl(), 'Link');

  const link = byId<HTMLAnchorElement>('bookmarkletLink');
  link.href = bookmarkletCode();
  // Clicking it here would just open a copy of Backpocket; it's meant to be dragged.
  link.onclick = (e) => { e.preventDefault(); showToast('Drag it to your bookmarks bar', false); };
  byId('bookmarkletCopyBtn').onclick = () => copy(bookmarkletCode(), 'Bookmarklet');

  // Suggest it once on iPhone/iPad (not when the page was opened by a share).
  if (isIos() && !store.settings.iosHelpShown && !openedFromShare) {
    setTimeout(() => {
      store.setSettings({ iosHelpShown: true });
      showToast(isStandalone() ? 'Save links from other iPhone apps?' : 'Save links from Instagram, TikTok and more?', false,
        [{ label: 'Show me', onClick: openIosHelp }], 9000);
    }, 2500);
  }
}
