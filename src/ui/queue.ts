import { setStatus } from '../actions';
import { revisitPickIds } from '../ai/related';
import { currentUser } from '../cloud/auth';
import { APP_CONFIG } from '../config';
import { buildQueue, currentStreak, dayKey, QUEUE_META_KEY, recordStreakDay, STREAK_META_KEY, topUpQueue, type DailyQueue, type Streak } from '../data/queue';
import { store } from '../data/store';
import { pathLabel } from '../data/tree';
import type { Link } from '../data/types';
import { domainOf } from '../platform';
import { onAccountChange } from './account';
import { byId, svgIcon } from './dom';
import { relativeTime } from './format';
import { addListOverride, linkVisual, openLink } from './list';
import { showToast } from './toast';
import { renderMain, view } from './view';

// Daily Queue tab: a greeting with the catch streak, today's focus save and
// what's up next. Picks and streak logic live in data/queue.ts.

let queue: DailyQueue | null = null;
let streak: Streak | undefined;
let loaded = false;

const VIDEO = new Set(['YouTube', 'TikTok', 'Instagram']);
const today = () => dayKey(Date.now());
const saveMeta = (key: string, value: unknown) => store.db.setMeta(key, value).catch(() => {});

/** Today's five, picked on the first look each day. Smart picks upgrade it once, before anything is done. */
function ensureToday(): DailyQueue {
  const day = today();
  if (queue && queue.day === day) {
    const ids = topUpQueue(queue.ids, store.liveLinks(), Date.now(), APP_CONFIG.revisitMinAgeDays);
    if (ids.join() !== queue.ids.join()) { queue = { day, ids }; void saveMeta(QUEUE_META_KEY, queue); }
    return queue;
  }
  const picked: DailyQueue = { day, ids: buildQueue(store.liveLinks(), Date.now(), APP_CONFIG.revisitMinAgeDays) };
  queue = picked;
  void saveMeta(QUEUE_META_KEY, picked);
  void revisitPickIds(APP_CONFIG.revisitMinAgeDays).then((ids) => {
    if (!ids.length || queue !== picked || picked.ids.some((id) => store.link(id)?.status === 'done')) return;
    queue = { day, ids: buildQueue(store.liveLinks(), Date.now(), APP_CONFIG.revisitMinAgeDays, ids) };
    void saveMeta(QUEUE_META_KEY, queue);
    if (view.mode === 'queue') renderMain();
  });
  return picked;
}

function streakText(): string {
  const n = currentStreak(streak, today());
  return n ? n + '-day catch streak' : 'Finish one today to start a streak';
}

function markDone(link: Link, card: HTMLElement): void {
  card.classList.add('is-leaving');
  setTimeout(() => {
    setStatus([link.id], 'done');
    streak = recordStreakDay(streak, today());
    void saveMeta(STREAK_META_KEY, streak);
    showToast('Done! ' + streakText(), true, () => setStatus([link.id], 'unread'));
  }, 260);
}

function titleOf(link: Link): string { return link.title || domainOf(link.url); }

function metaLine(link: Link): HTMLElement {
  const p = document.createElement('p');
  p.className = 'queue-meta';
  p.textContent = pathLabel(store.liveFolders(), link.folderId) + ' · ' + relativeTime(link.createdAt);
  return p;
}

function doneButton(link: Link, card: HTMLElement, cls: string, label: boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  if (label) b.append('Done', svgIcon('check'));
  else { b.append(svgIcon('check')); b.setAttribute('aria-label', 'Mark ' + titleOf(link) + ' as done'); }
  b.onclick = () => markDone(link, card);
  return b;
}

function focusCard(link: Link): HTMLElement {
  const card = document.createElement('article');
  card.className = 'queue-focus';
  const video = VIDEO.has(link.platform);

  const media = document.createElement('div');
  media.className = 'queue-media';
  const overlay = document.createElement('div');
  overlay.className = 'queue-overlay';
  const h = document.createElement('h3');
  h.className = 'queue-title';
  h.textContent = titleOf(link);
  overlay.appendChild(h);
  media.append(linkVisual(link), overlay);
  if (video) {
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'queue-play';
    play.setAttribute('aria-label', 'Play ' + titleOf(link));
    play.appendChild(svgIcon('play'));
    play.onclick = () => openLink(link);
    media.appendChild(play);
  }

  const body = document.createElement('div');
  body.className = 'queue-body';
  const desc = (link.note || link.sharedText || '').trim();
  if (desc && desc !== link.title) {
    const p = document.createElement('p');
    p.className = 'queue-desc';
    p.textContent = desc;
    body.appendChild(p);
  }
  body.appendChild(metaLine(link));
  const actions = document.createElement('div');
  actions.className = 'queue-actions';
  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'queue-start';
  start.textContent = video ? 'Start watching' : 'Start reading';
  start.onclick = () => openLink(link);
  actions.append(start, doneButton(link, card, 'btn-ghost with-icon queue-done', true));
  body.appendChild(actions);
  card.append(media, body);
  return card;
}

function nextCard(link: Link): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'queue-card';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'queue-card-open';
  const t = document.createElement('span');
  t.className = 'queue-card-title';
  t.textContent = titleOf(link);
  open.append(linkVisual(link), t, metaLine(link));
  open.onclick = () => openLink(link);
  li.append(open, doneButton(link, li, 'queue-card-done', false));
  return li;
}

function restingState(title: string, text: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'empty queue-rest';
  const art = document.createElement('div');
  art.className = 'empty-illustration';
  art.appendChild(svgIcon('flame'));
  const t = document.createElement('p');
  t.className = 'empty-title';
  t.textContent = title;
  const p = document.createElement('p');
  p.textContent = text;
  box.append(art, t, p);
  return box;
}

function sectionTitle(text: string): HTMLElement {
  const h = document.createElement('h2');
  h.className = 'section-title';
  h.textContent = text;
  return h;
}

function renderQueue(listEl: HTMLElement): void {
  const first = currentUser()?.name?.trim().split(/\s+/)[0];
  byId('folderTitle').textContent = first ? 'Hey ' + first + '!' : 'Hey there!';
  const pill = document.createElement('span');
  pill.className = 'streak-pill';
  pill.append(svgIcon('flame'), streakText());
  byId('folderCount').replaceChildren(pill);
  listEl.replaceChildren();
  if (!loaded) return;

  const items = ensureToday().ids.map((id) => store.link(id)).filter((l): l is Link => !!l);
  const left = items.filter((l) => l.status !== 'done');
  const section = document.createElement('section');
  section.className = 'queue';
  const head = document.createElement('div');
  head.className = 'queue-head';
  head.appendChild(sectionTitle('Daily Queue'));
  if (items.length) {
    const progress = document.createElement('p');
    progress.className = 'queue-progress';
    progress.textContent = (items.length - left.length) + ' of ' + items.length + ' done';
    head.appendChild(progress);
  }
  section.appendChild(head);

  if (!items.length) {
    section.appendChild(restingState('Nothing to catch up on', 'Save a few links and Backpocket lines up five a day for you here.'));
  } else if (!left.length) {
    section.appendChild(restingState('Queue cleared', 'That was today\'s five. Come back tomorrow for a fresh set.'));
  } else {
    section.appendChild(focusCard(left[0]));
    if (left.length > 1) {
      section.appendChild(sectionTitle('Up next'));
      const ul = document.createElement('ul');
      ul.className = 'queue-next';
      ul.append(...left.slice(1).map(nextCard));
      section.appendChild(ul);
    }
  }
  listEl.appendChild(section);
}

export function initQueue(): void {
  addListOverride((listEl) => {
    if (view.mode !== 'queue') return false;
    renderQueue(listEl);
    return true;
  });
  onAccountChange(() => { if (view.mode === 'queue') renderMain(); });
  void Promise.all([store.db.getMeta<DailyQueue>(QUEUE_META_KEY), store.db.getMeta<Streak>(STREAK_META_KEY)]).then(([q, s]) => {
    queue = q ?? null;
    streak = s;
    loaded = true;
    if (view.mode === 'queue') renderMain();
  });
}
