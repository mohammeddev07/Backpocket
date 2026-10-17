import { aiReady, aiSettled } from '../ai/access';
import { aiCall } from '../ai/client';
import { revisitPickIds } from '../ai/related';
import { APP_CONFIG } from '../config';
import {
  isNudgeable, NUDGE_GAP_MS, NUDGE_HISTORY_KEY, NUDGE_META_KEY, NUDGE_NEXT_KEY, NUDGE_SYNC_TAG, nudgeCopy, nudgeNotification, pickForgotten,
  pushNudgeHistory, recentlyNudged, usablePrepared, type NudgeHistoryEntry, type PreparedNudge,
} from '../data/nudge';
import { store } from '../data/store';
import { pathLabel } from '../data/tree';
import type { Link } from '../data/types';
import { domainOf } from '../platform';
import { byId } from './dom';
import { linkVisual, openLink } from './list';
import { showToast } from './toast';

// "Forgotten save" reminders. Two delivery paths, no server:
// - in-app: a nudge toast when Backpocket is opened (every browser);
// - background: Periodic Background Sync wakes the service worker about once
//   a day (Chromium, installed app only; see src/sw.ts). iPhone web apps
//   can't do this without a push server, so they get the in-app nudge only.
//
// With AI on, the link is picked by closeness to recent saves (embeddings,
// no AI call) and the text is written by AI (one call). The next nudge is
// prepared ahead and stored, so the worker can use it too: about one AI call
// per day, only while the app is used.

type Mode = 'background' | 'in-app' | 'blocked';
type SyncRegistration = ServiceWorkerRegistration & {
  periodicSync?: { register(tag: string, o: { minInterval: number }): Promise<void>; unregister(tag: string): Promise<void> };
};

async function registration(): Promise<SyncRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  // getRegistration, not .ready: in dev there's no worker and .ready never settles.
  return (await navigator.serviceWorker.getRegistration().catch(() => undefined)) as SyncRegistration | undefined;
}

const MIN_AGE = () => APP_CONFIG.revisitMinAgeDays;

/** Smart pick (closest to recent saves) when available, else the daily rotation; skips recent nudges. */
async function chooseLink(now: number): Promise<Link | null> {
  const links = store.liveLinks();
  const skip = recentlyNudged(await store.db.getMeta<NudgeHistoryEntry[]>(NUDGE_HISTORY_KEY), now);
  for (const id of await revisitPickIds(MIN_AGE())) {
    const l = store.link(id);
    if (isNudgeable(l, now, MIN_AGE()) && !skip.has(l.id)) return l;
  }
  return pickForgotten(links, now, MIN_AGE(), skip);
}

/** AI-written title + body when AI is on; the built-in templates otherwise (or if AI fails). */
async function writeCopy(link: Link, now: number): Promise<{ title: string; body: string }> {
  if (aiReady()) {
    try {
      const { nudge } = await aiCall('nudge', { input: {
        title: link.title || domainOf(link.url), platform: link.platform,
        days: (now - link.createdAt) / 86_400_000, folder: pathLabel(store.liveFolders(), link.folderId), domain: domainOf(link.url),
      } });
      if (nudge) return nudge;
    } catch { /* fall back to a template */ }
  }
  return nudgeCopy(link, now);
}

let preparing: Promise<PreparedNudge | null> | null = null;
/** Picks and writes the next nudge and stores it for the page or the worker (one at a time). */
function prepareNext(now = Date.now()): Promise<PreparedNudge | null> {
  preparing ??= buildNext(now).finally(() => { preparing = null; });
  return preparing;
}

async function buildNext(now: number): Promise<PreparedNudge | null> {
  const link = await chooseLink(now);
  if (!link) { await store.db.setMeta(NUDGE_NEXT_KEY, null); return null; }
  const prepared = { linkId: link.id, ...(await writeCopy(link, now)), at: now };
  await store.db.setMeta(NUDGE_NEXT_KEY, prepared);
  return prepared;
}

async function ensurePrepared(): Promise<void> {
  if (!store.settings.remindersEnabled) return;
  await aiSettled();
  const p = await store.db.getMeta<PreparedNudge>(NUDGE_NEXT_KEY);
  if (!usablePrepared(p, store.liveLinks(), Date.now(), MIN_AGE())) await prepareNext();
}

// ---- In-app reminder banner ----
let bannerTimer: ReturnType<typeof setTimeout> | undefined;

function hideNudge(): void {
  const el = byId('nudgeBanner');
  clearTimeout(bannerTimer);
  el.classList.remove('show');
  el.style.transform = '';
  setTimeout(() => { if (!el.classList.contains('show')) el.hidden = true; }, 400);
}

/** Auto-hides, but never while the pointer or keyboard focus is on it (time to read and act). */
function armNudgeTimer(ms: number): void {
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(hideNudge, ms);
}

function showNudge(link: Link, copy: { title: string; body: string }): void {
  const el = byId('nudgeBanner');
  byId('nudgeTitle').textContent = copy.title;
  byId('nudgeBody').textContent = copy.body;
  byId('nudgeThumb').replaceChildren(linkVisual(link));
  byId('nudgeOpenBtn').onclick = () => { openLink(link); hideNudge(); };
  el.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  armNudgeTimer(12_000);
  // The banner itself isn't a live region (it holds buttons), so announce it separately.
  const announce = byId('nudgeAnnounce');
  announce.textContent = '';
  setTimeout(() => { announce.textContent = 'Reminder: ' + copy.title + ' ' + copy.body; }, 100);
}

function initNudgeBanner(): void {
  const el = byId('nudgeBanner');
  byId('nudgeLaterBtn').onclick = hideNudge;
  byId('nudgeCloseBtn').onclick = hideNudge;
  el.addEventListener('mouseenter', () => clearTimeout(bannerTimer));
  el.addEventListener('focusin', () => clearTimeout(bannerTimer));
  el.addEventListener('mouseleave', () => armNudgeTimer(5000));
  el.addEventListener('focusout', () => armNudgeTimer(5000));
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideNudge(); });
  // Swipe it up (or sideways on desktop) to dismiss, like a system banner.
  let start: { x: number; y: number } | null = null;
  el.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('button')) return;
    start = { x: e.clientX, y: e.clientY };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dy = Math.min(0, e.clientY - start.y);
    el.style.transform = `translate(var(--nudge-x), ${dy}px)`;
  });
  const end = (e: PointerEvent) => {
    if (!start) return;
    const dy = e.clientY - start.y;
    start = null;
    if (dy < -40) hideNudge(); else el.style.transform = '';
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

let nudging = false;
/** In-app nudge on open/return, at most once per NUDGE_GAP_MS (shared with the worker). */
export async function maybeNudge(): Promise<void> {
  if (nudging || !store.settings.remindersEnabled || document.visibilityState !== 'visible') return;
  if (document.querySelector('.modal-backdrop.show')) return;
  nudging = true;
  try {
    const now = Date.now();
    const last = (await store.db.getMeta<number>(NUDGE_META_KEY)) || 0;
    if (now - last < NUDGE_GAP_MS) return;
    await aiSettled();
    let p = await store.db.getMeta<PreparedNudge>(NUDGE_NEXT_KEY);
    if (!usablePrepared(p, store.liveLinks(), now, MIN_AGE())) p = await prepareNext(now) ?? undefined;
    const link = p && store.link(p.linkId);
    if (!p || !link) return;
    await store.db.setMeta(NUDGE_META_KEY, now);
    await store.db.setMeta(NUDGE_HISTORY_KEY, pushNudgeHistory(await store.db.getMeta(NUDGE_HISTORY_KEY), link.id, now));
    await store.db.setMeta(NUDGE_NEXT_KEY, null);
    showNudge(link, p);
    // Have tomorrow's ready, so a background notification can use it too.
    setTimeout(() => void ensurePrepared(), 30_000);
  } finally {
    nudging = false;
  }
}

/** Turns background delivery on/off. Only prompts for permission when `prompt` (a user tap). */
async function setBackground(on: boolean, prompt: boolean): Promise<Mode> {
  // Ask before any await so the browser still sees the tap as the trigger.
  const asked = on && prompt && 'Notification' in window && Notification.permission === 'default'
    ? Notification.requestPermission() : null;
  const reg = await registration();
  if (!on) { await reg?.periodicSync?.unregister(NUDGE_SYNC_TAG).catch(() => {}); return 'in-app'; }
  if (!('Notification' in window)) return 'in-app';
  if (asked) await asked;
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted' || !reg?.periodicSync) return 'in-app';
  try {
    const state = await navigator.permissions.query({ name: 'periodic-background-sync' as PermissionName });
    if (state.state !== 'granted') return 'in-app';
    await reg.periodicSync.register(NUDGE_SYNC_TAG, { minInterval: 12 * 3_600_000 });
    return 'background';
  } catch {
    return 'in-app';
  }
}

const STATUS: Record<Mode, string> = {
  background: 'On. Expect about one nudge a day, even when Backpocket is closed. Your device decides the exact timing.',
  'in-app': 'On. Nudges appear when you open Backpocket. Notifications while it\'s closed need the installed app in Chrome on Android or a computer.',
  blocked: 'On, inside the app only. Notifications are blocked for this site in your browser settings.',
};

function renderStatus(mode: Mode): void {
  byId('remindersStatus').textContent = store.settings.remindersEnabled ? STATUS[mode] : '';
}

async function sendTest(): Promise<void> {
  const now = Date.now();
  const links = store.liveLinks();
  const link = await chooseLink(now)
    ?? [...links].filter((l) => l.status !== 'done').sort((a, b) => a.createdAt - b.createdAt)[0]
    ?? links[0];
  if (!link) { showToast('Nothing in your pocket yet. Save something and we\'ll nag you about it later.', false); return; }
  const btn = byId<HTMLButtonElement>('remindersTestBtn');
  btn.disabled = true;
  try {
    const copy = await writeCopy(link, now);
    const reg = await registration();
    if (reg && 'Notification' in window && Notification.permission === 'granted') {
      await reg.showNotification(copy.title, nudgeNotification(copy.body, link.url));
      showToast('Test nudge sent. Check your notifications.', true);
    } else {
      showNudge(link, copy);
    }
  } finally {
    btn.disabled = false;
  }
}

export function initReminders(): void {
  initNudgeBanner();
  const toggle = byId<HTMLInputElement>('remindersToggle');
  toggle.checked = store.settings.remindersEnabled;
  toggle.addEventListener('change', async () => {
    store.setSettings({ remindersEnabled: toggle.checked });
    renderStatus('in-app'); // until the permission prompt is answered
    renderStatus(await setBackground(toggle.checked, true));
    if (toggle.checked) void ensurePrepared();
  });
  byId('remindersTestBtn').onclick = () => void sendTest();
  // Re-arm background sync on load (no prompt), and nudge when returning to the app.
  void setBackground(store.settings.remindersEnabled, false).then(renderStatus);
  document.addEventListener('visibilitychange', () => void maybeNudge());
  setTimeout(() => void ensurePrepared(), 12_000);
}
