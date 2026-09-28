import { aiMode, aiReady, byokKeyChanged, onAiModeChange, refreshAiAccess } from '../ai/access';
import { getByokKey, setByokKey, validateByokKey } from '../ai/byok';
import { AI_PRIVACY_NOTE } from '../ai/notice';
import { currentUser } from '../cloud/auth';
import { store } from '../data/store';
import { openSignIn } from './account';
import { byId } from './dom';
import { closeModal, openModal } from './modal';
import { showToast } from './toast';
import { renderMain } from './view';

// AI settings (status, on/off, privacy note, bring-your-own-key) and the
// gate every AI entry point goes through.

/**
 * True when AI can run now. Otherwise explains why and offers the next step:
 * guests are asked to sign in, non-allowlisted users are offered their own key.
 */
export function requireAi(what: string): boolean {
  if (aiReady()) return true;
  const mode = aiMode();
  if (mode === 'unavailable') showToast('AI isn\'t set up for this copy of Backpocket.', false);
  else if (mode === 'guest') openSignIn('Sign in to use AI to ' + what + '.');
  else if (mode === 'needs-key') openByokModal();
  else if (mode === 'checking') showToast('Checking AI access… try again in a moment.', false);
  else if (!store.settings.aiEnabled) showToast('AI is turned off in Settings.', false, [{ label: 'Settings', onClick: () => openModal(byId('settingsModal')) }]);
  return false;
}

function statusText(): string {
  switch (aiMode()) {
    case 'unavailable': return 'Not available in this build.';
    case 'guest': return 'Sign in to use AI sorting, search and plans.';
    case 'checking': return 'Checking access…';
    case 'server': return 'On for your account (shared key).';
    case 'byok': return 'Using your own Gemini key, stored only on this device.';
    case 'needs-key': return 'Your account isn\'t on the shared AI list. You can use your own free Gemini key.';
  }
}

function renderAiSettings(): void {
  const mode = aiMode();
  const section = byId('settingsAi');
  section.hidden = mode === 'unavailable';
  byId('aiStatusText').textContent = statusText();
  byId('aiPrivacyNote').textContent = AI_PRIVACY_NOTE;
  const toggle = byId<HTMLInputElement>('aiEnabledToggle');
  toggle.checked = store.settings.aiEnabled;
  byId('aiToggleRow').hidden = !(mode === 'server' || mode === 'byok');
  byId('aiRecheckBtn').hidden = mode === 'guest' || mode === 'unavailable';
  const actions = byId('aiActions');
  actions.replaceChildren();
  const add = (label: string, fn: () => void, cls = 'btn-ghost') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.onclick = fn;
    actions.appendChild(b);
  };
  if (mode === 'guest') add('Sign in', () => { closeModal(byId('settingsModal')); openSignIn(); }, 'btn-primary');
  if (mode === 'needs-key') add('Use your own free Gemini key', openByokModal, 'btn-primary');
  if (mode === 'byok') {
    add('Change key', openByokModal);
    add('Remove key', () => { setByokKey(null); byokKeyChanged(); renderAiSettings(); showToast('Key removed from this device', true); }, 'btn-ghost danger');
  }
}

export function openByokModal(): void {
  const input = byId<HTMLInputElement>('byokInput');
  input.value = getByokKey() || '';
  byId('byokError').hidden = true;
  openModal(byId('byokModal'));
}

async function saveByok(): Promise<void> {
  const input = byId<HTMLInputElement>('byokInput');
  const key = input.value.trim();
  const err = byId('byokError');
  if (!/^[A-Za-z0-9_-]{20,}$/.test(key)) {
    err.textContent = 'That doesn\'t look like a Gemini API key.';
    err.hidden = false;
    return;
  }
  const btn = byId<HTMLButtonElement>('byokSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  const ok = await validateByokKey(key);
  btn.disabled = false;
  btn.textContent = 'Save key';
  if (!ok) {
    err.textContent = navigator.onLine ? 'Google didn\'t accept that key. Check it in AI Studio and try again.' : 'You\'re offline - connect to check the key.';
    err.hidden = false;
    return;
  }
  setByokKey(key);
  store.setSettings({ aiEnabled: true });
  byokKeyChanged();
  closeModal(byId('byokModal'));
  showToast('Key saved on this device - AI is on', true);
}

export function initAiUi(): void {
  byId<HTMLInputElement>('aiEnabledToggle').addEventListener('change', (e) => {
    store.setSettings({ aiEnabled: (e.target as HTMLInputElement).checked });
    renderMain();
  });
  byId('byokSaveBtn').onclick = () => void saveByok();
  byId('byokCancelBtn').onclick = () => closeModal(byId('byokModal'));
  byId('byokInput').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void saveByok(); });
  byId('aiRecheckBtn').onclick = () => void refreshAiAccess(currentUser(), true);
  onAiModeChange(() => { renderAiSettings(); renderMain(); });
  store.subscribe((c) => { if (c.kind === 'settings') renderAiSettings(); });
  renderAiSettings();
}
