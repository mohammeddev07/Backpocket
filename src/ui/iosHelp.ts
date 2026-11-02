import { store } from '../data/store';
import { isIos, isStandalone } from '../platform';
import { byId } from './dom';
import { showToast } from './toast';

// Sharing into Backpocket without the Android share target: an Apple Shortcut
// on iPhone and a bookmarklet on desktop. Both open the app with ?url=…, which
// goes through the same share handling as Android (fill the form, clear the
// params; sort-on-save runs when the link is saved).

/** e.g. https://backpocketapp.pages.dev/?url= */
export function shareEntryUrl(): string {
  return window.location.origin + import.meta.env.BASE_URL + '?url=';
}

export function bookmarkletCode(): string {
  const base = JSON.stringify(shareEntryUrl());
  return 'javascript:(()=>{window.open(' + base +
    '+encodeURIComponent(location.href)+"&title="+encodeURIComponent(document.title),"_blank","noopener")})()';
}

export function initIosHelp(openedFromShare: boolean): void {
  const link = byId<HTMLAnchorElement>('bookmarkletLink');
  link.href = bookmarkletCode();
  // Clicking it here would just open a copy of Backpocket; it's meant to be dragged.
  link.onclick = (e) => { e.preventDefault(); showToast('Drag it to your bookmarks bar', false); };

  // Suggest it once on iPhone/iPad (not when the page was opened by a share).
  if (isIos() && !store.settings.iosHelpShown && !openedFromShare) {
    setTimeout(() => {
      store.setSettings({ iosHelpShown: true });
      showToast(isStandalone() ? 'Save links from other iPhone apps?' : 'Save links from Instagram, TikTok and more?', false,
        [{ label: 'Show me', onClick: () => location.assign(import.meta.env.BASE_URL + 'iphone.html') }], 9000);
    }, 2500);
  }
}
