import { markOpened, setStatus } from '../actions';
import { revisitPickIds } from '../ai/related';
import { currentUser } from '../cloud/auth';
import { APP_CONFIG } from '../config';
import { buildQueue, currentStreak, dayKey, moveId, QUEUE_META_KEY, recordStreakDay, STREAK_META_KEY, topUpQueue, whyNow, type DailyQueue, type Streak } from '../data/queue';
import { store } from '../data/store';
import { pathLabel } from '../data/tree';
import type { Link } from '../data/types';
import { isWebUrl } from '../data/urls';
import { domainOf } from '../platform';
import { onAccountChange } from './account';
import { byId, svgIcon } from './dom';
import { relativeTime } from './format';
import { addListOverride, linkVisual, openLink } from './list';
import { hideToast, showToast } from './toast';
import { renderMain, view } from './view';

// Daily Queue tab: today's five as one focus card and what's up next, a
// progress strip and the catch streak. Picks and streak logic live in
// data/queue.ts; motion timings are the --dur-* tokens in app.css.

let queue: DailyQueue | null = null;
let streak: Streak | undefined;
let loaded = false;

// Render memory, so only real changes animate: entering the tab staggers the
// cards once, a newly done item fills its segment, a streak bump pulses.
let entering = true;
let shownDone: { day: string; n: number } | null = null;
let shownStreak = -1;
let busy = false;
let focusId: string | null = null;
let focusNext = false;
let undoLast: { fn: () => void; until: number } | null = null;
let dragId: string | null = null;

const VIDEO = new Set(['YouTube', 'TikTok', 'Instagram']);
const FB_VIDEO = /fb\.watch|\/(reels?|watch|videos)\b/;
const UNDO_MS = 8000;
const today = () => dayKey(Date.now());
const saveMeta = (key: string, value: unknown) => store.db.setMeta(key, value).catch(() => {});
const isVideo = (l: Link) => VIDEO.has(l.platform) || (l.platform === 'Facebook' && FB_VIDEO.test(l.url));
const openedToday = (l: Link) => l.openedAt != null && dayKey(l.openedAt) === today();
const folderColor = (l: Link) => store.liveFolders().find((f) => f.id === l.folderId)?.color;

/** Today's five, picked on the first look each day. Smart picks upgrade it once, before anything is done or moved. */
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
  if (!n) return 'Finish one today to start a streak';
  return streak?.last === today() ? n + '-day streak' : n + '-day streak. Finish one to keep it going';
}

/**
 * Runs a DOM-changing update, then animates each card from where it was
 * (FLIP, transform and opacity only). A card that changed shape, Up next
 * into the focus spot, glides in from its old place instead of stretching.
 * The microtask lets the store's batched re-render land before measuring.
 * Chosen over view transitions, which cost a dropped frame to snapshot.
 */
function transition(update: () => void): Promise<void> {
  const cards = () => [...document.querySelectorAll<HTMLElement>('.queue [data-qid]')];
  if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) { update(); return Promise.resolve(); }
  const was = new Map(cards().map((el) => [el.dataset.qid!, el.getBoundingClientRect()]));
  update();
  return Promise.resolve().then(() => {
    const root = getComputedStyle(document.documentElement);
    const timing = { duration: parseFloat(root.getPropertyValue('--dur-move')), easing: root.getPropertyValue('--ease').trim() };
    return Promise.all(cards().map((el) => {
      const a = was.get(el.dataset.qid!);
      const b = el.getBoundingClientRect();
      if (!a || (a.left === b.left && a.top === b.top && a.width === b.width)) return null;
      const from = 'translate(' + (a.left - b.left) + 'px, ' + (a.top - b.top) + 'px)';
      const frames = Math.abs(a.width - b.width) > 1
        ? [{ transform: from + ' scale(.94)', opacity: 0 }, { transform: 'none', opacity: 1 }]
        : [{ transform: from }, { transform: 'none' }];
      return el.animate(frames, timing).finished;
    })).then(() => {}, () => {});
  });
}

/** Resolves when the element's own CSS animations finish (at once if there are none). */
function settled(el: Element): Promise<void> {
  return Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)).then(() => {}, () => {});
}

async function markDone(link: Link, card: HTMLElement): Promise<void> {
  if (busy) return;
  busy = true;
  // Keyboard and swipe users carry on with the next card (a mouse click shows no ring there).
  const a = document.activeElement;
  focusNext = !a || a === document.body || card.contains(a);
  card.classList.add('is-leaving');
  await settled(card);
  const before = streak;
  // Undo works from the moment Done lands, not only once the cards stop moving (U can be quick).
  const undo = () => {
    undoLast = null;
    focusId = link.id;
    void transition(() => {
      setStatus([link.id], 'unread');
      // Undo shouldn't leave a streak day behind (a no-op if today already counted before this one).
      streak = before;
      void saveMeta(STREAK_META_KEY, before ?? null);
    }).then(() => showToast('Back in your queue', true));
  };
  undoLast = { fn: undo, until: Date.now() + UNDO_MS };
  await transition(() => {
    setStatus([link.id], 'done');
    streak = recordStreakDay(streak, today());
    void saveMeta(STREAK_META_KEY, streak);
    busy = false; // keys work again as soon as the next card is in place, not after the glide
  });
  if (undoLast?.fn !== undo) return; // already undone
  const ids = queue?.ids ?? [];
  const done = ids.filter((id) => store.link(id)?.status === 'done').length;
  showToast('Done. ' + done + ' of ' + ids.length + ' today', true, [{ label: 'Undo', onClick: undo }], UNDO_MS);
}

function startLink(link: Link): void {
  // window.open has to run inside the tap, so only the card's state change animates.
  if (!isWebUrl(link.url)) { openLink(link); return; }
  window.open(link.url, '_blank', 'noopener,noreferrer');
  focusId = link.id;
  void transition(() => markOpened(link.id));
}

function moveCard(id: string, targetId: string): void {
  if (!queue) return;
  const ids = moveId(queue.ids, id, targetId);
  if (ids === queue.ids) return;
  queue = { day: queue.day, ids };
  void saveMeta(QUEUE_META_KEY, queue);
  focusId = id;
  void transition(renderMain);
}

function titleOf(link: Link): string { return link.title || domainOf(link.url); }

function button(cls: string, part: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.dataset.part = part;
  b.onclick = onClick;
  return b;
}

function folderLine(link: Link, cls: string): HTMLElement {
  const p = document.createElement('span');
  p.className = cls;
  const dot = document.createElement('span');
  dot.className = 'queue-dot';
  const c = folderColor(link);
  if (c) dot.style.setProperty('--c', c);
  p.append(dot, pathLabel(store.liveFolders(), link.folderId));
  return p;
}

function visual(link: Link): HTMLElement {
  const v = linkVisual(link);
  v.setAttribute('aria-hidden', 'true');
  return v;
}

/**
 * Card root shared by the focus card and Up next. data-qid lets transition()
 * follow a card to its new spot. Any card is a drop target.
 */
function itemShell<K extends 'article' | 'li'>(tag: K, link: Link, cls: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = cls;
  el.dataset.qid = link.id;
  el.addEventListener('dragover', (e) => { if (dragId && dragId !== link.id) { e.preventDefault(); el.classList.add('is-drop'); } });
  el.addEventListener('dragleave', () => el.classList.remove('is-drop'));
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('is-drop'); if (dragId) moveCard(dragId, link.id); });
  return el;
}

/** Touch: swipe the focus card right to mark it done; short swipes spring back. */
function swipeToDone(card: HTMLElement, link: Link): void {
  let x0 = 0, dx = 0, tracking = false;
  card.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || busy) return;
    x0 = e.clientX; dx = 0; tracking = true;
  });
  card.addEventListener('pointermove', (e) => {
    if (!tracking) return;
    dx = Math.max(0, e.clientX - x0);
    if (dx > 8) { card.classList.add('is-swiping'); card.style.transform = 'translateX(' + dx + 'px)'; }
  });
  const end = () => {
    if (!tracking) return;
    tracking = false;
    card.classList.remove('is-swiping');
    // A swipe that started on a button shouldn't also press it.
    if (dx > 8) card.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); }, { capture: true, once: true });
    // Far enough: carry on off-screen from where the finger let go. Otherwise spring back.
    if (dx > card.offsetWidth * 0.35) { card.classList.add('is-swiped'); void markDone(link, card); }
    else card.style.transform = '';
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', () => { dx = 0; end(); });
}

function focusCard(link: Link): HTMLElement {
  const card = itemShell('article', link, 'queue-focus');
  const started = openedToday(link);
  card.setAttribute('aria-labelledby', 'queueFocusTitle');

  const media = document.createElement('div');
  media.className = 'queue-media';
  media.appendChild(visual(link));
  if (isVideo(link) && !started) {
    const play = button('queue-play', 'play', () => startLink(link));
    play.setAttribute('aria-label', 'Play ' + titleOf(link));
    play.tabIndex = -1; // the Start button is the same action for keyboards
    play.appendChild(svgIcon('play'));
    media.appendChild(play);
  }

  const body = document.createElement('div');
  body.className = 'queue-body';
  const h = document.createElement('h3');
  h.className = 'queue-title';
  h.id = 'queueFocusTitle';
  h.textContent = titleOf(link);
  const why = document.createElement('p');
  why.className = 'queue-why';
  why.textContent = whyNow(link, Date.now(), APP_CONFIG.revisitMinAgeDays);
  body.append(folderLine(link, 'queue-kicker'), h, why);
  const desc = (link.note || link.sharedText || '').trim();
  if (desc && desc !== link.title) {
    const p = document.createElement('p');
    p.className = 'queue-desc';
    p.textContent = desc;
    body.appendChild(p);
  }
  if (link.tags.length) {
    const tags = document.createElement('ul');
    tags.className = 'queue-tags';
    tags.setAttribute('aria-label', 'Tags');
    for (const t of link.tags.slice(0, 4)) {
      const li = document.createElement('li');
      li.textContent = '#' + t;
      tags.appendChild(li);
    }
    body.appendChild(tags);
  }

  const actions = document.createElement('div');
  actions.className = 'queue-actions';
  const done = button(started ? 'queue-start with-icon' : 'btn-ghost with-icon queue-done', 'done', () => void markDone(link, card));
  done.append('Done', svgIcon('check'));
  done.setAttribute('aria-keyshortcuts', 'D');
  const open = button(started ? 'btn-ghost queue-done' : 'queue-start', 'start', () => startLink(link));
  open.textContent = started ? 'Open again' : isVideo(link) ? 'Start watching' : 'Start reading';
  // Once it's been opened, Done is the main thing to do.
  if (started) actions.append(done, open); else actions.append(open, done);
  body.appendChild(actions);
  card.append(media, body);
  swipeToDone(card, link);
  return card;
}

function nextCard(link: Link, i: number): HTMLLIElement {
  const li = itemShell('li', link, 'queue-card');
  li.style.setProperty('--i', String(i + 1));
  li.draggable = true;
  li.addEventListener('dragstart', (e) => {
    dragId = link.id;
    e.dataTransfer?.setData('text/plain', link.url);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    li.classList.add('is-dragging');
  });
  li.addEventListener('dragend', () => { dragId = null; li.classList.remove('is-dragging'); });
  // The preview sits outside the button (a button may only hold text-level
  // content); tapping anywhere on the card still opens the link.
  const open = button('queue-card-open', 'start', () => startLink(link));
  const t = document.createElement('span');
  t.className = 'queue-card-title';
  t.textContent = titleOf(link);
  const meta = document.createElement('span');
  meta.className = 'queue-meta';
  const ago = document.createElement('span');
  ago.textContent = relativeTime(link.createdAt);
  meta.append(folderLine(link, 'queue-folder'), ago);
  open.append(t, meta);
  li.onclick = (e) => { if (!(e.target as Element).closest('button')) startLink(link); };
  const done = button('queue-card-done', 'done', () => void markDone(link, li));
  done.append(svgIcon('check'));
  done.setAttribute('aria-label', 'Mark ' + titleOf(link) + ' as done');
  done.setAttribute('aria-keyshortcuts', 'D');
  li.append(visual(link), open, done);
  return li;
}

function strip(done: number, total: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'queue-progress';
  const bar = document.createElement('div');
  bar.className = 'queue-strip';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Today\'s queue');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(total));
  bar.setAttribute('aria-valuenow', String(done));
  bar.setAttribute('aria-valuetext', done + ' of ' + total + ' done today');
  const grew = shownDone?.day === today() && done > shownDone.n;
  for (let i = 0; i < total; i++) {
    const seg = document.createElement('span');
    seg.className = 'queue-seg' + (i < done ? ' is-done' : '') + (grew && i === done - 1 ? ' is-new' : '');
    bar.appendChild(seg);
  }
  const label = document.createElement('p');
  label.className = 'queue-count';
  label.setAttribute('aria-hidden', 'true'); // the progressbar already says it
  label.textContent = done + ' of ' + total + ' done today';
  wrap.append(bar, label);
  return wrap;
}

function restingState(title: string, text: string, cls = ''): HTMLElement {
  const box = document.createElement('div');
  box.className = 'empty queue-rest ' + cls;
  const art = document.createElement('div');
  art.className = 'empty-illustration';
  art.appendChild(svgIcon('flame'));
  const t = document.createElement('h3');
  t.className = 'empty-title';
  t.tabIndex = -1; // focus lands here after the last Done
  t.textContent = title;
  const p = document.createElement('p');
  p.textContent = text;
  box.append(art, t, p);
  return box;
}

function skeleton(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'queue-skeleton';
  box.setAttribute('aria-hidden', 'true');
  box.innerHTML = '<div class="queue-skel queue-skel-focus"></div><div class="queue-skel-row">'
    + '<div class="queue-skel"></div>'.repeat(4) + '</div>';
  return box;
}

function offlineNote(): HTMLElement {
  const p = document.createElement('p');
  p.className = 'queue-offline';
  p.append(svgIcon('cloud'), 'You\'re offline. Links need a connection to open.'
    + (currentUser() ? ' Done items sync when you\'re back.' : ''));
  return p;
}

function keysHint(): HTMLElement {
  const p = document.createElement('p');
  p.className = 'queue-keys';
  p.innerHTML = '<span><kbd>J</kbd> <kbd>K</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>D</kbd> done</span>'
    + '<span><kbd>U</kbd> undo</span><span><kbd>Shift</kbd> <kbd>J</kbd> <kbd>K</kbd> reorder</span>';
  return p;
}

function sectionTitle(text: string, tag: 'h2' | 'h3' = 'h2'): HTMLElement {
  const h = document.createElement(tag);
  h.className = 'section-title';
  h.textContent = text;
  return h;
}

type FocusMemo = { id: string | null; part: string } | null;

/** Which control had focus inside the queue, so a re-render can put it back. */
function focusMemo(listEl: HTMLElement): FocusMemo {
  if (focusId) return { id: focusId, part: 'start' };
  if (focusNext) { focusNext = false; return { id: null, part: 'start' }; }
  const a = document.activeElement as HTMLElement | null;
  if (!a || !listEl.contains(a)) return null;
  return { id: a.closest<HTMLElement>('[data-qid]')?.dataset.qid ?? null, part: a.dataset.part || 'start' };
}

function restoreFocus(listEl: HTMLElement, memo: FocusMemo): void {
  focusId = null;
  if (!memo) return;
  const item = memo.id ? listEl.querySelector<HTMLElement>('[data-qid="' + memo.id + '"]') : null;
  const target = item?.querySelector<HTMLElement>('[data-part="' + memo.part + '"]')
    ?? item?.querySelector<HTMLElement>('[data-part="start"]')
    // The item left (done): carry on with the new focus card, or the cleared message.
    ?? listEl.querySelector<HTMLElement>('.queue-focus .queue-actions > :first-child, .queue-rest .empty-title');
  target?.focus({ preventScroll: true });
}

function renderQueue(listEl: HTMLElement): void {
  const first = currentUser()?.name?.trim().split(/\s+/)[0];
  byId('folderTitle').textContent = first ? 'Hey ' + first + '!' : 'Hey there!';
  const n = currentStreak(streak, today());
  const pill = document.createElement('span');
  pill.className = 'streak-pill' + (loaded && shownStreak >= 0 && n > shownStreak ? ' is-up' : '');
  pill.append(svgIcon('flame'), streakText());
  byId('folderCount').replaceChildren(pill);
  if (loaded) shownStreak = n;

  const memo = focusMemo(listEl);
  listEl.replaceChildren();
  const section = document.createElement('section');
  section.className = 'queue' + (entering ? ' is-entering' : '');
  section.setAttribute('aria-labelledby', 'queueHeading');
  const head = document.createElement('div');
  head.className = 'queue-head';
  const h2 = sectionTitle('Daily Queue');
  h2.id = 'queueHeading';
  head.appendChild(h2);
  section.appendChild(head);
  listEl.appendChild(section);

  if (!loaded) {
    section.setAttribute('aria-busy', 'true');
    section.appendChild(skeleton());
    return;
  }
  entering = false;

  const items = ensureToday().ids.map((id) => store.link(id)).filter((l): l is Link => !!l);
  const left = items.filter((l) => l.status !== 'done');
  const done = items.length - left.length;
  if (items.length) head.appendChild(strip(done, items.length));
  if (!navigator.onLine) section.appendChild(offlineNote());

  if (!items.length) {
    section.appendChild(store.liveLinks().length
      ? restingState('All caught up', 'You\'ve finished every save. New ones show up here.')
      : restingState('Nothing to catch up on yet', 'Save a link and it shows up here.'));
  } else if (!left.length) {
    const days = currentStreak(streak, today());
    const just = shownDone?.day === today() && shownDone.n < items.length;
    const streakLine = days > 1 ? 'Your streak is now ' + days + ' days. ' : days ? 'That starts your streak. ' : '';
    section.appendChild(restingState('That\'s today\'s five', streakLine + 'New picks tomorrow.', 'queue-complete' + (just ? ' is-new' : '')));
  } else {
    section.appendChild(focusCard(left[0]));
    if (left.length > 1) {
      section.appendChild(sectionTitle('Up next', 'h3'));
      const ul = document.createElement('ul');
      ul.className = 'queue-next';
      ul.append(...left.slice(1).map(nextCard));
      section.appendChild(ul);
    }
    section.appendChild(keysHint());
  }
  shownDone = { day: today(), n: done };
  restoreFocus(listEl, memo);
}

// ---- Keyboard: J/K move, Enter opens, D done, U undo, Shift+J/K reorder ----

function typingOrBlocked(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement;
  return e.ctrlKey || e.metaKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
    || !!document.querySelector('.modal-backdrop.show, .dropdown-menu');
}

function onKey(e: KeyboardEvent): void {
  if (view.mode !== 'queue' || typingOrBlocked(e)) return;
  const key = e.key.toLowerCase();
  if (key === 'u' && undoLast && Date.now() < undoLast.until) { undoLast.fn(); hideToast(); e.preventDefault(); return; }
  const items = [...document.querySelectorAll<HTMLElement>('.queue [data-qid]')];
  if (!items.length || busy) return;
  const cur = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-qid]') ?? null;
  const idx = cur ? items.indexOf(cur) : -1;
  const at = (i: number) => items[Math.max(0, Math.min(items.length - 1, i))];
  if (key === 'j' || key === 'k') {
    const step = key === 'j' ? 1 : -1;
    if (e.shiftKey && cur) { const target = at(idx + step); if (target !== cur) moveCard(cur.dataset.qid!, target.dataset.qid!); }
    else at(idx < 0 ? 0 : idx + step).querySelector<HTMLElement>('[data-part="start"]')?.focus();
  } else if (key === 'd') {
    (cur ?? items[0]).querySelector<HTMLElement>('[data-part="done"]')?.click();
  } else if (key === 'enter' && !(e.target as Element).closest('button, a')) {
    (cur ?? items[0]).querySelector<HTMLElement>('[data-part="start"]')?.click();
  } else return;
  e.preventDefault();
}

export function initQueue(): void {
  addListOverride((listEl) => {
    if (view.mode !== 'queue') { entering = true; return false; }
    renderQueue(listEl);
    return true;
  });
  onAccountChange(() => { if (view.mode === 'queue') renderMain(); });
  document.addEventListener('keydown', onKey);
  const rerender = () => { if (view.mode === 'queue') renderMain(); };
  window.addEventListener('online', rerender);
  window.addEventListener('offline', rerender);
  void Promise.all([store.db.getMeta<DailyQueue>(QUEUE_META_KEY), store.db.getMeta<Streak>(STREAK_META_KEY)]).then(([q, s]) => {
    queue = q ?? null;
    streak = s;
    loaded = true;
    if (view.mode === 'queue') renderMain();
  });
}
