import { deleteLinks, inboxId, markOpened, restoreLinks, setFavorite, setStatus } from '../actions';
import { APP_CONFIG } from '../config';
import { COLORS } from '../data/migrate';
import { store } from '../data/store';
import { pathLabel, pathOf } from '../data/tree';
import type { Folder, Link } from '../data/types';
import { domainOf, faviconFor, platformIconSvg } from '../platform';
import { selectLinks, viewLinks, type ListQuery } from '../search/filters';
import { byId, plural, svgIcon } from './dom';
import { renderActiveFilters, setResultCounter } from './filtersSheet';
import { openMoveLinks } from './folderDialogs';
import { relativeTime, fullDate } from './format';
import { openLinkEditor, setEditorDeleteHandler } from './linkEditor';
import { openMenu, type MenuItem } from './menu';
import { folderMenuItems } from './nav';
import { showToast } from './toast';
import { clearFilters, go, renderMain, setRenderer, view } from './view';

const EMPTY_ILLUSTRATION = '<svg viewBox="0 0 52 52" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><path d="M9 10a4 4 0 0 1 4-4h18a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4h-9l-4.5 5-4.5-5H13a4 4 0 0 1-4-4z"/><g transform="translate(12,11)" stroke-width="1.7"><path d="M10 13a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.6 1.6"/><path d="M14 11a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.6-1.6"/></g></svg>';
const NO_MATCH_ILLUSTRATION = '<svg viewBox="0 0 52 52" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><circle cx="23" cy="23" r="13"/><path d="m32.5 32.5 8 8"/></svg>';

// ---- Extension points (AI suggestions, semantic search, plans) ----
type CardDecorator = (link: Link, main: HTMLElement) => void;
const cardDecorators: CardDecorator[] = [];
export function addCardDecorator(fn: CardDecorator): void { cardDecorators.push(fn); }

/** Extra card-menu items (e.g. "More like this"), shown before Delete. */
const linkMenuExtras: Array<(link: Link) => MenuItem[]> = [];
export function addLinkMenuItems(fn: (link: Link) => MenuItem[]): void { linkMenuExtras.push(fn); }

/** Runs after every list render (e.g. the weekly recap card). */
const renderHooks: Array<() => void> = [];
export function addRenderHook(fn: () => void): void { renderHooks.push(fn); }

type HeaderExtra = (container: HTMLElement) => void;
const headerExtras: HeaderExtra[] = [];
export function addHeaderExtra(fn: HeaderExtra): void { headerExtras.push(fn); }

/** Replaces the card list (e.g. a folder's Plan tab). Returns true if it rendered. */
type ListOverride = (listEl: HTMLElement) => boolean;
let listOverride: ListOverride | null = null;
export function setListOverride(fn: ListOverride | null): void { listOverride = fn; }

/** Extra ranked results (semantic search) merged ahead of keyword matches. */
let extraResults: { query: string; ids: string[] } | null = null;
export function setExtraResults(r: { query: string; ids: string[] } | null): void { extraResults = r; }

export function openLink(link: Link): void {
  window.open(link.url, '_blank', 'noopener,noreferrer');
  markOpened(link.id);
}

export function currentQuery(): ListQuery {
  return {
    mode: view.mode, folderId: view.folderId, query: view.query, filters: view.filters,
    shuffleSeed: view.shuffleSeed, now: Date.now(), revisitMinAgeDays: APP_CONFIG.revisitMinAgeDays,
  };
}

export function visibleLinks(): Link[] {
  if (view.related) return view.related.ids.map((id) => store.link(id)).filter((l): l is Link => !!l && !l.deletedAt);
  const links = store.liveLinks();
  const out = selectLinks(links, store.liveFolders(), currentQuery());
  if (extraResults && extraResults.query === view.query.trim()) {
    // Semantic hits first (in rank order), then any keyword matches not already shown.
    const base = viewLinks(links, currentQuery());
    const byId = new Map(base.map((l) => [l.id, l]));
    const sem = extraResults.ids.map((id) => byId.get(id)).filter((l): l is Link => !!l);
    const seen = new Set(sem.map((l) => l.id));
    return [...sem, ...out.filter((l) => !seen.has(l.id))];
  }
  return out;
}

function copyLinkUrl(link: Link): void {
  const done = () => showToast('Link copied', true);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link.url).then(done).catch(() => fallbackCopy(link.url, done));
  } else {
    fallbackCopy(link.url, done);
  }
}
export function fallbackCopy(text: string, done: () => void): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { showToast('Copy failed', false); }
  ta.remove();
}

export function deleteLinksWithUndo(ids: string[]): void {
  const removed = deleteLinks(ids);
  if (!removed.length) return;
  exitSelectMode();
  renderMain();
  showToast(removed.length === 1 ? 'Deleted 1 link' : 'Deleted ' + removed.length + ' links', true, () => restoreLinks(removed));
}

function exitSelectMode(): void {
  view.selectMode = false;
  view.selectedIds.clear();
}
function updateBulkBar(): void {
  const bar = byId('bulkBar');
  bar.hidden = !(view.selectMode && view.selectedIds.size > 0);
  byId('bulkCount').textContent = view.selectedIds.size + ' selected';
}

function linkMenu(link: Link): MenuItem[] {
  return [
    { label: 'Open', onClick: () => openLink(link) },
    { label: 'Edit…', onClick: () => openLinkEditor(link) },
    { label: link.status === 'done' ? 'Mark as unread' : 'Mark as done', onClick: () => setStatus([link.id], link.status === 'done' ? 'unread' : 'done') },
    { label: link.favorite ? 'Remove from favorites' : 'Add to favorites', onClick: () => setFavorite([link.id], !link.favorite) },
    { label: 'Copy link', onClick: () => copyLinkUrl(link) },
    { label: 'Move to…', onClick: () => void openMoveLinks([link.id]) },
    ...linkMenuExtras.flatMap((fn) => fn(link)),
    { separator: true },
    { label: 'Delete', danger: true, onClick: () => deleteLinksWithUndo([link.id]) },
  ];
}

// Sites that get the code-grid tile instead of a hue-from-URL pattern.
const CODE_HOSTS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|stackoverflow\.com|stackexchange\.com|npmjs\.com|codepen\.io|dev\.to|developer\.mozilla\.org|huggingface\.co|vercel\.app|netlify\.app)$/;

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Local stand-in when there's no real thumbnail: a gradient tile in the
 * platform's colours with the title's first letter and a small platform icon.
 * Deterministic per link, drawn with CSS only - nothing is fetched or invented.
 */
export function fallbackTile(link: Link): HTMLElement {
  const tile = document.createElement('div');
  tile.className = 'link-visual tile';
  const host = domainOf(link.url);
  const kind = link.platform !== 'Link' ? link.platform.toLowerCase() : CODE_HOSTS.test(host) ? 'code' : 'link';
  tile.dataset.kind = kind;
  if (kind === 'link') {
    const h = hashStr(host);
    tile.style.setProperty('--tile-h', String(h % 360));
    tile.style.setProperty('--tile-a', (100 + (h >>> 9) % 120) + 'deg');
    tile.style.setProperty('--tile-x', (15 + (h >>> 3) % 70) + '%');
    tile.style.setProperty('--tile-y', (10 + (h >>> 6) % 40) + '%');
  }
  const initial = document.createElement('span');
  initial.className = 'tile-initial';
  initial.setAttribute('aria-hidden', 'true');
  initial.textContent = ((link.title || host).match(/[\p{L}\p{N}]/u)?.[0] || '#').toUpperCase();
  const badge = document.createElement('span');
  badge.className = 'tile-badge';
  // Privacy mode never contacts Google's favicon service; known platforms use
  // their own icon anyway (clearer than a favicon at this size).
  if (store.settings.localIconsOnly || link.platform !== 'Link') badge.innerHTML = platformIconSvg(link.platform);
  else badge.appendChild(faviconFor(link.id, link.url, link.platform));
  tile.append(initial, badge);
  return tile;
}

function linkVisual(link: Link): HTMLElement {
  if (!link.thumbnailUrl || store.settings.localIconsOnly) return fallbackTile(link);
  const wrap = document.createElement('div');
  wrap.className = 'link-visual';
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  // CORS request so the service worker can cache it (see src/sw.ts).
  img.crossOrigin = 'anonymous';
  img.src = link.thumbnailUrl;
  // Never a broken-image icon: swap in the tile, same box.
  img.onerror = () => wrap.replaceWith(fallbackTile(link));
  wrap.appendChild(img);
  return wrap;
}

function buildLinkRow(link: Link, opts: { showFolder: boolean; folders: Folder[] }): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'link-item' + (link.status === 'done' ? ' is-done' : '');
  li.dataset.id = link.id;

  let cb: HTMLInputElement | null = null;
  if (view.selectMode) {
    cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'select-checkbox';
    cb.checked = view.selectedIds.has(link.id);
    cb.setAttribute('aria-label', 'Select ' + (link.title || domainOf(link.url)));
    cb.onchange = () => {
      if (cb!.checked) view.selectedIds.add(link.id); else view.selectedIds.delete(link.id);
      li.classList.toggle('selected', cb!.checked);
      updateBulkBar();
    };
    li.classList.toggle('selected', cb.checked);
    li.appendChild(cb);
  }

  li.addEventListener('click', (e) => {
    if ((e.target as Element).closest('a, button, input, .ai-suggest')) return;
    if (view.selectMode && cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); return; }
    openLink(link);
  });

  const main = document.createElement('div');
  main.className = 'link-main';

  // The title is the real link (keyboard + screen readers), so the card isn't
  // a nested interactive "role=link" wrapped around other buttons.
  const a = document.createElement('a');
  a.className = 'link-title' + (link.title ? '' : ' is-url');
  a.href = link.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = link.title || domainOf(link.url);
  a.addEventListener('click', (e) => {
    if (view.selectMode && cb) { e.preventDefault(); cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); return; }
    markOpened(link.id);
  });
  main.appendChild(a);

  const meta = document.createElement('div');
  meta.className = 'link-meta';
  const bits: Node[] = [];
  if (link.favorite) {
    const star = document.createElement('span');
    star.className = 'link-fav';
    star.append(svgIcon('star'));
    star.title = 'Favorite';
    const label = document.createElement('span');
    label.className = 'visually-hidden';
    label.textContent = 'Favorite';
    star.appendChild(label);
    bits.push(star);
  }
  if (opts.showFolder) {
    const f = store.folder(link.folderId);
    if (f) {
      const crumb = document.createElement('button');
      crumb.type = 'button';
      crumb.className = 'folder-badge';
      const label = document.createElement('span');
      label.textContent = pathLabel(opts.folders, f.id);
      crumb.style.setProperty('--folder-color', f.isSystem ? 'var(--ink-faint)' : (f.color || COLORS[0]));
      crumb.append(svgIcon(f.isSystem ? 'inbox' : 'folder'), label);
      crumb.setAttribute('aria-label', 'Go to folder ' + label.textContent);
      crumb.onclick = (e) => { e.stopPropagation(); go('folder', f.id); };
      bits.push(crumb);
    }
  } else if (link.title) {
    const d = document.createElement('span');
    d.className = 'link-domain';
    d.textContent = domainOf(link.url);
    bits.push(d);
  }
  const date = document.createElement('time');
  date.className = 'link-date';
  date.dateTime = new Date(link.createdAt).toISOString();
  date.title = 'Saved ' + fullDate(link.createdAt);
  date.textContent = relativeTime(link.createdAt);
  bits.push(date);
  if (link.status === 'done') {
    const done = document.createElement('span');
    done.className = 'link-done';
    done.append(svgIcon('check'), document.createTextNode('Done'));
    bits.push(done);
  }
  bits.forEach((b, i) => {
    if (i > 0) { const sep = document.createElement('span'); sep.className = 'meta-sep'; sep.textContent = '·'; sep.setAttribute('aria-hidden', 'true'); meta.appendChild(sep); }
    meta.appendChild(b);
  });
  main.appendChild(meta);
  if (link.tags.length) {
    const tags = document.createElement('div');
    tags.className = 'link-tags';
    for (const t of link.tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = '#' + t;
      tags.appendChild(chip);
    }
    main.appendChild(tags);
  }
  for (const d of cardDecorators) d(link, main);

  const kebab = document.createElement('button');
  kebab.type = 'button';
  kebab.className = 'link-kebab';
  kebab.appendChild(svgIcon('dots'));
  kebab.setAttribute('aria-label', 'More actions for ' + (link.title || domainOf(link.url)));
  kebab.onclick = (e) => { e.stopPropagation(); openMenu(kebab, linkMenu(link)); };

  li.append(linkVisual(link), main, kebab);
  return li;
}

function emptyState(illustration: string, title: string, desc: string, action?: HTMLElement): HTMLElement {
  const empty = document.createElement('div');
  empty.className = 'empty';
  const art = document.createElement('div');
  art.className = 'empty-illustration';
  art.innerHTML = illustration;
  const t = document.createElement('p');
  t.className = 'empty-title';
  t.textContent = title;
  const p = document.createElement('p');
  p.textContent = desc;
  empty.append(art, t, p);
  if (action) empty.appendChild(action);
  return empty;
}

function ghostButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn-ghost';
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function renderHeader(folders: Folder[]): void {
  const titleEl = byId('folderTitle');
  const crumbEl = byId('crumb');
  const actions = byId('headerActions');
  titleEl.replaceChildren();
  crumbEl.replaceChildren();
  actions.replaceChildren();

  if (view.mode === 'folder') {
    let folder = store.folder(view.folderId);
    if (!folder) { view.mode = 'all'; return renderHeader(folders); }
    // Folders sit under Library; the Inbox has its own tab.
    const crumbs = folder.isSystem ? [] : [
      { name: 'Library', open: () => go('all') },
      ...pathOf(folders, folder.id).slice(0, -1).map((p) => ({ name: p.name, open: () => go('folder', p.id) })),
    ];
    crumbs.forEach((c, i) => {
      if (i > 0) { const s = document.createElement('span'); s.textContent = '›'; s.setAttribute('aria-hidden', 'true'); crumbEl.appendChild(s); }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'crumb-link';
      b.textContent = c.name;
      b.onclick = c.open;
      crumbEl.appendChild(b);
    });
    if (!folder.isSystem) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = folder.color || COLORS[0];
      titleEl.appendChild(dot);
    }
    titleEl.appendChild(document.createTextNode(folder.name));
    const kebab = document.createElement('button');
    kebab.type = 'button';
    kebab.className = 'icon-btn';
    kebab.setAttribute('aria-label', 'Folder actions for ' + folder.name);
    kebab.appendChild(svgIcon('dots'));
    const items = folderMenuItems(folder);
    if (items.length) { kebab.onclick = () => openMenu(kebab, folderMenuItems(folder!)); actions.appendChild(kebab); }
  } else if (view.mode === 'revisit') {
    titleEl.textContent = 'Revisit';
    const shuffleBtn = document.createElement('button');
    shuffleBtn.type = 'button';
    shuffleBtn.className = 'btn-ghost with-icon';
    shuffleBtn.append(svgIcon('shuffle'), document.createTextNode('Shuffle'));
    shuffleBtn.onclick = () => { view.shuffleSeed = Math.floor(Math.random() * 2 ** 31) + 1; renderMain(); };
    actions.appendChild(shuffleBtn);
  } else {
    titleEl.textContent = view.mode === 'favorites' ? 'Favorites' : 'Library';
  }
  for (const extra of headerExtras) extra(actions);
}

function render(): void {
  const folders = store.liveFolders();
  renderHeader(folders);
  const searchInput = byId<HTMLInputElement>('searchInput');
  if (document.activeElement !== searchInput) searchInput.value = view.query;
  byId<HTMLSelectElement>('sortSelect').value = view.filters.sort;
  const selectBtn = byId('selectToggleBtn');
  selectBtn.setAttribute('aria-pressed', String(view.selectMode));
  selectBtn.setAttribute('aria-label', view.selectMode ? 'Done selecting' : 'Select links');
  renderActiveFilters();
  if (view.related) {
    const row = byId('activeFilters');
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip active-filter';
    chip.setAttribute('aria-label', 'Stop showing saves similar to ' + view.related.title);
    chip.append(document.createTextNode('Similar to \u201C' + view.related.title + '\u201D'), svgIcon('x'));
    chip.onclick = () => { view.related = null; renderMain(); };
    row.prepend(chip);
    row.hidden = false;
  }

  const q = currentQuery();
  const inView = viewLinks(store.liveLinks(), q);
  const countEl = byId('folderCount');
  countEl.textContent = view.mode === 'revisit'
    ? plural(inView.length, 'unopened link') + ' saved over ' + APP_CONFIG.revisitMinAgeDays + ' days ago'
    : plural(inView.length, 'saved link');

  const listEl = byId('linksList');
  if (listOverride && listOverride(listEl)) { byId('listToolbar').hidden = true; byId('resultCount').hidden = true; updateBulkBar(); runRenderHooks(); return; }
  byId('listToolbar').hidden = false;
  listEl.replaceChildren();
  const previouslyShown = view.shownLinkIds;
  view.shownLinkIds = new Set();

  if (store.liveLinks().length === 0 || (inView.length === 0 && !view.query && view.mode !== 'folder')) {
    byId('resultCount').hidden = true;
    const cta = ghostButton('Save your first link', () => { byId('urlInput').focus(); });
    listEl.appendChild(view.mode === 'revisit'
      ? emptyState(EMPTY_ILLUSTRATION, 'Nothing to revisit', 'Links you haven\'t opened for ' + APP_CONFIG.revisitMinAgeDays + ' days show up here.')
      : view.mode === 'favorites' && store.liveLinks().length
      ? emptyState(EMPTY_ILLUSTRATION, 'No favorites yet', 'Open a save\'s menu and pick Add to favorites to keep it here.')
      : emptyState(EMPTY_ILLUSTRATION, 'Your next good find belongs here', 'Save your first link and it\'ll show up here, searchable across every folder.', cta));
    updateBulkBar();
    runRenderHooks();
    return;
  }

  const links = visibleLinks();
  const filtered = !!view.query.trim() || links.length !== inView.length || !!view.related;
  const resultCount = byId('resultCount');
  resultCount.hidden = !filtered;
  const semantic = !!extraResults && extraResults.query === view.query.trim();
  resultCount.textContent = view.related ? plural(links.length, 'similar save')
    : filtered ? plural(links.length, 'result') + (semantic ? ' · including AI matches' : '') : '';

  if (links.length === 0) {
    if (view.related) {
      listEl.appendChild(emptyState(NO_MATCH_ILLUSTRATION, 'Nothing similar yet', 'New saves take a minute to be analysed, and some just don\'t have a twin yet.',
        ghostButton('Back to all saves', () => { view.related = null; renderMain(); })));
    } else if (!filtered && view.mode === 'folder') {
      const isInbox = view.folderId === inboxId();
      listEl.appendChild(emptyState(EMPTY_ILLUSTRATION, isInbox ? 'Inbox zero' : 'Nothing here yet',
        isInbox ? 'Links saved without a folder land here.' : 'Paste a link above to save it into this folder.'));
    } else {
      listEl.appendChild(emptyState(NO_MATCH_ILLUSTRATION, 'No matches', 'Nothing fits your search and filters.',
        ghostButton('Clear search and filters', () => { clearFilters(); renderMain(); })));
    }
    updateBulkBar();
    runRenderHooks();
    return;
  }

  const showFolder = view.mode !== 'folder' || view.filters.scope === 'all';
  // Rows already on screen don't replay the entrance animation, so typing in
  // search doesn't make the whole list flash. New rows stagger in, capped.
  let entering = 0;
  const frag = document.createDocumentFragment();
  for (const link of links) {
    const row = buildLinkRow(link, { showFolder, folders });
    if (previouslyShown.has(link.id)) row.style.animation = 'none';
    else row.style.animationDelay = (Math.min(entering++, 8) * 0.02) + 's';
    view.shownLinkIds.add(link.id);
    frag.appendChild(row);
  }
  listEl.appendChild(frag);
  updateBulkBar();
  runRenderHooks();
}

function runRenderHooks(): void {
  for (const fn of renderHooks) fn();
}

export function initList(): void {
  setRenderer('main', render);
  setResultCounter(() => visibleLinks().length);
  setEditorDeleteHandler(deleteLinksWithUndo);

  const searchInput = byId<HTMLInputElement>('searchInput');
  searchInput.addEventListener('input', () => { view.query = searchInput.value; setExtraResults(null); renderMain(); });

  byId('selectToggleBtn').onclick = () => {
    view.selectMode = !view.selectMode;
    view.selectedIds.clear();
    renderMain();
  };
  byId('bulkCancelBtn').onclick = () => { exitSelectMode(); renderMain(); };
  byId('bulkDeleteBtn').onclick = () => deleteLinksWithUndo([...view.selectedIds]);
  byId('bulkDoneBtn').onclick = () => {
    const ids = [...view.selectedIds];
    setStatus(ids, 'done');
    exitSelectMode();
    showToast('Marked ' + plural(ids.length, 'link') + ' as done', true, () => setStatus(ids, 'unread'));
  };
  byId('bulkMoveBtn').onclick = () => {
    if (view.selectedIds.size === 0) return;
    void openMoveLinks([...view.selectedIds], () => { exitSelectMode(); renderMain(); });
  };
}
