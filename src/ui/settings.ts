import { THEME_KEY } from '../data/migrate';
import { store } from '../data/store';
import { byId, svgIcon } from './dom';
import { closeModal, openModal } from './modal';
import { closeSidebarMobile } from './sidebar';
import { renderMain } from './view';

// ---- Theme ----
function currentTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', theme);
  byId('themeToggle').replaceChildren(svgIcon(theme === 'dark' ? 'sun' : 'moon'));
}

export function initTheme(): void {
  const saved = store.settings.theme;
  applyTheme(saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  byId('themeToggle').onclick = () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    store.setSettings({ theme: next });
    // Mirror to localStorage: the inline <head> script reads it before first paint.
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
    if (doc.startViewTransition && !reduceMotion) doc.startViewTransition(() => applyTheme(next));
    else applyTheme(next);
  };
}

// ---- Settings modal ----
export function openSettings(): void {
  openModal(byId('settingsModal'));
  closeSidebarMobile();
}

export function initSettings(): void {
  const settingsModal = byId('settingsModal');
  byId('settingsBtn').onclick = openSettings;
  byId('closeSettingsBtn').onclick = () => closeModal(settingsModal);

  // Privacy: local-icons-only toggle.
  const toggle = byId<HTMLInputElement>('faviconPrivacyToggle');
  toggle.checked = store.settings.localIconsOnly;
  toggle.addEventListener('change', () => {
    store.setSettings({ localIconsOnly: toggle.checked });
    renderMain();
  });
}

// ---- Install ----
// Android lists Backpocket in the share sheet only when Chrome installs it as
// a real app (WebAPK). "Add to home screen → Create shortcut" and Brave's
// home-screen shortcuts never register the share target, so offer Chrome's
// install flow directly, and tell Brave-on-Android users where to install.
interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<unknown> }

export function initInstall(): void {
  const installBtn = byId('installBtn');
  const installHint = byId('installHint');
  let deferredInstall: BeforeInstallPromptEvent | null = null;
  const braveOnAndroid = !!(navigator as Navigator & { brave?: unknown }).brave && /Android/i.test(navigator.userAgent);
  window.addEventListener('beforeinstallprompt', (e) => {
    if (braveOnAndroid) return; // its install is a shortcut - the hint below explains instead
    e.preventDefault();
    deferredInstall = e as BeforeInstallPromptEvent;
    installBtn.hidden = false;
  });
  installBtn.onclick = async () => {
    if (!deferredInstall) return;
    void deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    installBtn.hidden = true;
  };
  window.addEventListener('appinstalled', () => { deferredInstall = null; installBtn.hidden = true; });
  if (braveOnAndroid && !window.matchMedia('(display-mode: standalone)').matches) {
    installHint.textContent = 'To share links into Backpocket from other apps, open this page in Chrome and install it from there. Brave on Android can only add a home-screen shortcut, which Android doesn\'t list in the share menu.';
    installHint.hidden = false;
  }
}
