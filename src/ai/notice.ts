import { store } from '../data/store';
import { openSettings } from '../ui/settings';
import { showToast } from '../ui/toast';

export const AI_PRIVACY_NOTE = 'AI features send the link, its caption and your note to Google Gemini.';

/** Shown once, the first time an AI feature runs. */
export function showAiNoticeOnce(): void {
  if (store.settings.aiNoticeSeen) return;
  store.setSettings({ aiNoticeSeen: true });
  showToast(AI_PRIVACY_NOTE, false, [{ label: 'Settings', onClick: openSettings }], 9000);
}
