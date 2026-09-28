import { deleteLinks, restoreLinks } from '../actions';
import { COLORS } from '../data/migrate';
import { store } from '../data/store';
import { pathOf } from '../data/tree';
import type { Folder, Link } from '../data/types';
import { domainOf, faviconFor, PLATFORMS, platformColor, platformIconSvg, platformTint } from '../platform';
import { byId, svgIcon } from './dom';
import { openMoveModal } from './folderDialogs';
import { openMenu } from './menu';
import { closeSidebarMobile } from './sidebar';
import { showToast } from './toast';
import { clearFilters, renderAll, renderMain, setRenderer, view, type SortMode } from './view';

const EMPTY_ILLUSTRATION = '<svg viewBox="0 0 52 52" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><path d="M9 10a4 4 0 0 1 4-4h18a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4h-9l-4.5 5-4.5-5H13a4 4 0 0 1-4-4z"/><g transform="translate(12,11)" stroke-width="1.7"><path d="M10 13a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.6 1.6"/><path d="M14 11a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.6-1.6"/></g></svg>';
const NO_MATCH_ILLUSTRATION = '<svg viewBox="0 0 52 52" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><circle cx="23" cy="23" r="13"/><path d="m32.5 32.5 8 8"/></svg>';

export function openLink(link: Link): void {
  window.open(link.url, '_blank', 'noopener,noreferrer');
}

function matchesQuery(link: Link, folder: Folder | undefined, q: string): boolean {
  if (!q) return true;
  if (link.title && link.title.toLowerCase().includes(q)) return true;
  if (link.url.toLowerCase().includes(q)) return true;
  if (folder && folder.name.toLowerCase().includes(q)) return true;
  if (link.platform.toLowerCase().includes(q)) return true;
  if (link.tags.some((t) => t.includes(q))) return true;
  return false;
}

function setCrumb(path: Folder[]): void {
  const crumbEl = byId('crumb');
  crumbEl.replaceChildren();
  if (path.length <= 1) return;
  path.forEach((f, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.textContent = '›';
      crumbEl.appendChild(sep);
    }
    crumbEl.appendChild(document.createTextNode(f.name));
  });
}

function renderLinkMain(main: HTMLElement, link: Link): void {
  main.querySelectorAll('.link-title, .link-url-sub').forEach((el) => el.remove());
  const a = document.createElement('a');
  a.className = 'link-title';
  a.href = link.url; a.target = '_blank'; a.rel = 'noopener noreferrer';

  if (link.title) {
    a.textContent = link.title;
    const domainLine = document.createElement('div');
    domainLine.className = 'link-url-sub';
    domainLine.textContent = domainOf(link.url);
    main.insertBefore(domainLine, main.firstChild);
    main.insertBefore(a, domainLine);
  } else {
    a.classList.add('is-url');
    a.textContent = domainOf(link.url);
    main.insertBefore(a, main.firstChild);
  }
}

function startEditTitle(link: Link, main: HTMLElement): void {
  main.querySelectorAll('.link-title, .link-url-sub').forEach((el) => el.remove());
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'title-edit-input';
  input.value = link.title || '';
  input.placeholder = 'Add a title…';
  input.setAttribute('aria-label', 'Title');
  main.insertBefore(input, main.firstChild);
  view.editing = true;
  input.focus();
  input.select();

  let done = false;
  const finish = (save: boolean) => {
    if (done) return; done = true;
    view.editing = false;
    const updated = save ? store.patch('links', link.id, { title: input.value.trim() || null }) : undefined;
    renderLinkMain(main, updated || link);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
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
  renderAll();
  const label = removed.length === 1 ? 'Deleted 1 link' : 'Deleted ' + removed.length + ' links';
  showToast(label, true, () => restoreLinks(removed));
}

function toggleSelectMode(): void {
  view.selectMode = !view.selectMode;
  view.selectedIds.clear();
  renderMain();
}
export function exitSelectMode(): void {
  view.selectMode = false;
  view.selectedIds.clear();
}
function updateBulkBar(): void {
  const bar = byId('bulkBar');
  if (view.selectMode && view.selectedIds.size > 0) {
    bar.hidden = false;
    byId('bulkCount').textContent = view.selectedIds.size + ' selected';
  } else {
    bar.hidden = true;
  }
}

function buildLinkRow(link: Link, opts: { showFolder?: boolean } = {}): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'link-item';
  li.tabIndex = 0;
  li.setAttribute('role', 'link');
  li.setAttribute('aria-label', 'Open ' + (link.title || link.url));

  let cb: HTMLInputElement | null = null;
  if (view.selectMode) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'select-checkbox';
    box.checked = view.selectedIds.has(link.id);
    box.setAttribute('aria-label', 'Select ' + (link.title || link.url));
    box.onchange = () => {
      if (box.checked) view.selectedIds.add(link.id); else view.selectedIds.delete(link.id);
      updateBulkBar();
    };
    li.appendChild(box);
    cb = box;
  }

  li.addEventListener('click', (e) => {
    if ((e.target as Element).closest('a, button, input')) return;
    if (view.selectMode && cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); return; }
    openLink(link);
  });
  li.addEventListener('keydown', (e) => {
    if (e.target !== li) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (view.selectMode && cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); return; }
      openLink(link);
    }
  });

  const icon = document.createElement('div');
  icon.className = 'link-icon';
  if (store.settings.localIconsOnly) {
    // Privacy mode: never contact Google's favicon service.
    icon.innerHTML = platformIconSvg(link.platform);
  } else {
    icon.appendChild(faviconFor(link.id, link.url, link.platform));
  }

  const main = document.createElement('div');
  main.className = 'link-main';
  renderLinkMain(main, link);

  const meta = document.createElement('div');
  meta.className = 'link-meta';

  if (opts.showFolder) {
    const linkFolder = store.folder(link.folderId);
    if (linkFolder) {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'folder-badge';
      badge.appendChild(svgIcon('folder'));
      badge.appendChild(document.createTextNode(linkFolder.name));
      badge.title = 'Go to ' + linkFolder.name;
      badge.onclick = (e) => {
        e.stopPropagation();
        view.currentFolderId = linkFolder.id;
        view.saveTargetFolderId = linkFolder.id;
        view.searchEverywhere = false;
        clearFilters();
        view.expanded.add(linkFolder.id);
        renderAll();
      };
      meta.appendChild(badge);
    }
  }

  const pill = document.createElement('span');
  pill.className = 'platform-pill';
  pill.style.background = platformTint(link.platform);
  const pillDot = document.createElement('span');
  pillDot.className = 'platform-dot';
  pillDot.style.background = platformColor(link.platform);
  pill.append(pillDot, document.createTextNode(link.platform));
  meta.appendChild(pill);

  link.tags.forEach((t) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.textContent = '#' + t;
    meta.appendChild(chip);
  });

  const d = new Date(link.createdAt);
  const dateEl = document.createElement('span');
  dateEl.className = 'link-date';
  dateEl.textContent = 'Saved ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  meta.appendChild(dateEl);
  main.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'link-actions';
  const kebab = document.createElement('button');
  kebab.type = 'button';
  kebab.className = 'link-kebab';
  kebab.appendChild(svgIcon('dots'));
  kebab.title = 'More actions';
  kebab.setAttribute('aria-label', 'More actions for ' + (link.title || link.url));
  kebab.onclick = (e) => {
    e.stopPropagation();
    openMenu(kebab, [
      { label: 'Open', onClick: () => openLink(link) },
      { label: 'Edit title / note', onClick: () => startEditTitle(link, main) },
      { label: 'Copy link', onClick: () => copyLinkUrl(link) },
      { label: 'Move to…', onClick: () => openMoveModal({ type: 'link', ids: [link.id] }) },
      { separator: true },
      { label: 'Delete', danger: true, onClick: () => deleteLinksWithUndo([link.id]) },
    ]);
  };
  actions.appendChild(kebab);

  li.append(icon, main, actions);
  return li;
}

function renderPlatformChips(): void {
  const el = byId('platformChips');
  el.replaceChildren();
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'chip' + (view.platformFilter ? '' : ' active');
  all.textContent = 'All platforms';
  all.onclick = () => { view.platformFilter = null; renderMain(); };
  el.appendChild(all);
  PLATFORMS.forEach((p) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    const active = view.platformFilter === p;
    chip.className = 'chip' + (active ? ' active' : '');
    chip.textContent = p;
    if (active) {
      chip.style.background = platformTint(p);
      chip.style.borderColor = platformColor(p);
      chip.style.color = 'var(--ink)';
    }
    chip.onclick = () => { view.platformFilter = (view.platformFilter === p) ? null : p; renderMain(); };
    el.appendChild(chip);
  });
}

function buildClearFiltersBtn(className: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = 'Clear filters';
  btn.onclick = () => { clearFilters(); renderMain(); };
  return btn;
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

function render(): void {
  byId<HTMLInputElement>('searchInput').value = view.searchQuery;
  byId<HTMLSelectElement>('sortSelect').value = view.sortMode;
  byId<HTMLInputElement>('dateStart').value = view.dateStart;
  byId<HTMLInputElement>('dateEnd').value = view.dateEnd;
  const selectBtn = byId('selectToggleBtn');
  selectBtn.textContent = view.selectMode ? 'Done selecting' : 'Select';
  selectBtn.setAttribute('aria-pressed', String(view.selectMode));
  byId<HTMLSelectElement>('searchScopeSelect').value = view.searchEverywhere ? 'all' : 'folder';

  let folder = store.folder(view.currentFolderId);
  if (!folder) {
    folder = store.liveFolders().find((f) => f.isSystem)!;
    view.currentFolderId = folder.id;
  }
  const folderTitleEl = byId('folderTitle');
  const crumbEl = byId('crumb');
  folderTitleEl.replaceChildren();
  if (view.searchEverywhere) {
    crumbEl.replaceChildren();
    folderTitleEl.appendChild(document.createTextNode('All bookmarks'));
  } else {
    setCrumb(pathOf(store.liveFolders(), folder.id));
    // The system folder isn't a user-colored folder, so only real folders get a dot.
    if (!folder.isSystem) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = folder.color || COLORS[0];
      folderTitleEl.appendChild(dot);
    }
    folderTitleEl.appendChild(document.createTextNode(folder.name));
  }

  // "All saves" (root) is a smart view over everything, not just links filed
  // directly under it - so it aggregates like global search does, tagging each
  // card with its actual folder.
  const isRootAll = !view.searchEverywhere && folder.isSystem;
  const all = store.liveLinks();
  const sourceLinks = (view.searchEverywhere || isRootAll) ? all : all.filter((l) => l.folderId === view.currentFolderId);
  byId('folderCount').textContent = sourceLinks.length + (sourceLinks.length === 1 ? ' saved link' : ' saved links');
  const linksListEl = byId('linksList');
  linksListEl.replaceChildren();
  const previouslyShown = view.shownLinkIds;
  view.shownLinkIds = new Set();

  const toolbar = byId('listToolbar'), filterPanel = byId('filterPanel'), chips = byId('platformChips'), resultCount = byId('resultCount');
  if (sourceLinks.length === 0) {
    toolbar.style.display = 'none';
    filterPanel.style.display = 'none';
    chips.style.display = 'none';
    resultCount.style.display = 'none';
    byId('bulkBar').hidden = true;
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'btn-ghost';
    cta.textContent = 'Save your first link';
    cta.onclick = () => { closeSidebarMobile(); byId('urlInput').focus(); };
    linksListEl.appendChild(emptyState(EMPTY_ILLUSTRATION, 'Your next good find belongs here',
      (view.searchEverywhere || isRootAll)
        ? 'Save your first link and it\'ll show up here, searchable across every folder.'
        : 'Paste a link above - from Instagram, YouTube, Facebook, or anywhere else.', cta));
    return;
  }
  toolbar.style.display = '';
  filterPanel.style.display = '';
  chips.style.display = '';
  renderPlatformChips();

  const foldersById = new Map(store.liveFolders().map((f) => [f.id, f]));
  let links = sourceLinks.slice();
  const q = view.searchQuery.trim().toLowerCase();
  if (q) links = links.filter((l) => matchesQuery(l, foldersById.get(l.folderId), q));
  if (view.platformFilter) links = links.filter((l) => l.platform === view.platformFilter);
  if (view.dateStart) {
    const startTs = new Date(view.dateStart + 'T00:00:00').getTime();
    links = links.filter((l) => l.createdAt >= startTs);
  }
  if (view.dateEnd) {
    const endTs = new Date(view.dateEnd + 'T23:59:59.999').getTime();
    links = links.filter((l) => l.createdAt <= endTs);
  }
  if (view.sortMode === 'oldest') links.sort((a, b) => a.createdAt - b.createdAt);
  else if (view.sortMode === 'platform') links.sort((a, b) => a.platform.localeCompare(b.platform) || b.createdAt - a.createdAt);
  else links.sort((a, b) => b.createdAt - a.createdAt);

  const filtersActive = !!(q || view.dateStart || view.dateEnd || view.platformFilter);
  resultCount.replaceChildren();
  if (filtersActive) {
    resultCount.style.display = '';
    resultCount.appendChild(document.createTextNode(links.length + (links.length === 1 ? ' result · ' : ' results · ')));
    resultCount.appendChild(buildClearFiltersBtn('clear-filters-btn'));
  } else {
    resultCount.style.display = 'none';
  }

  if (links.length === 0) {
    const clearBtn = buildClearFiltersBtn('btn-ghost');
    clearBtn.style.marginTop = '14px';
    linksListEl.appendChild(emptyState(NO_MATCH_ILLUSTRATION, 'No matches', 'Nothing fits the current filters.', clearBtn));
    return;
  }

  // Rows already on screen don't replay the entrance animation, so typing in
  // search or toggling a filter doesn't make the whole list flash. New rows
  // stagger in, capped so long lists don't take seconds to appear.
  let entering = 0;
  links.forEach((link) => {
    const row = buildLinkRow(link, { showFolder: view.searchEverywhere || isRootAll });
    if (previouslyShown.has(link.id)) row.style.animation = 'none';
    else row.style.animationDelay = (Math.min(entering++, 8) * 0.025) + 's';
    view.shownLinkIds.add(link.id);
    linksListEl.appendChild(row);
  });

  updateBulkBar();
}

export function initList(): void {
  setRenderer('main', render);

  const searchInput = byId<HTMLInputElement>('searchInput');
  const dateStartInput = byId<HTMLInputElement>('dateStart');
  const dateEndInput = byId<HTMLInputElement>('dateEnd');
  searchInput.addEventListener('input', () => { view.searchQuery = searchInput.value; renderMain(); });
  byId<HTMLSelectElement>('sortSelect').addEventListener('change', (e) => { view.sortMode = (e.target as HTMLSelectElement).value as SortMode; renderMain(); });
  dateStartInput.addEventListener('change', () => { view.dateStart = dateStartInput.value; renderMain(); });
  dateEndInput.addEventListener('change', () => { view.dateEnd = dateEndInput.value; renderMain(); });
  byId('clearDateBtn').addEventListener('click', () => {
    view.dateStart = ''; view.dateEnd = '';
    dateStartInput.value = ''; dateEndInput.value = '';
    renderMain();
  });
  byId<HTMLSelectElement>('searchScopeSelect').addEventListener('change', (e) => {
    view.searchEverywhere = (e.target as HTMLSelectElement).value === 'all';
    renderAll();
  });
  const filterToggleBtn = byId('filterToggleBtn');
  const filterPanel = byId('filterPanel');
  filterToggleBtn.onclick = () => {
    const open = filterPanel.hidden;
    filterPanel.hidden = !open;
    filterToggleBtn.setAttribute('aria-expanded', String(open));
  };

  byId('selectToggleBtn').onclick = toggleSelectMode;
  byId('bulkCancelBtn').onclick = () => { exitSelectMode(); renderMain(); };
  byId('bulkDeleteBtn').onclick = () => deleteLinksWithUndo([...view.selectedIds]);
  byId('bulkMoveBtn').onclick = () => {
    if (view.selectedIds.size === 0) return;
    openMoveModal({ type: 'link', ids: [...view.selectedIds], onDone: exitSelectMode });
  };
}
