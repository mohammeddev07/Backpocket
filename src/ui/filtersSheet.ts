import { store } from '../data/store';
import { PLATFORMS, platformColor, platformTint } from '../platform';
import { activeFilterCount, allTags, DEFAULT_FILTERS, type ListFilters, type SortMode, type StatusFilter } from '../search/filters';
import { byId, svgIcon } from './dom';
import { closeModal, openModal } from './modal';
import { renderMain, view } from './view';

// The Filters bottom sheet (scope, sort, status, platform, tags, dates) and the
// dismissible chips under the search field that show what's active.

const SORT_LABELS: Record<SortMode, string> = {
  newest: 'Newest first', oldest: 'Oldest first', title: 'Title A–Z', platform: 'By platform',
};

let countFn: () => number = () => 0;
/** list.ts provides the live result count for the "Show N" button. */
export function setResultCounter(fn: () => number): void { countFn = fn; }

function update(patch: Partial<ListFilters>): void {
  view.filters = { ...view.filters, ...patch };
  renderMain();
  renderSheet();
}

function segmented<T extends string>(el: HTMLElement, options: Array<[T, string]>, value: T, onPick: (v: T) => void): void {
  el.replaceChildren();
  for (const [v, label] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(v === value));
    b.tabIndex = v === value ? 0 : -1;
    b.textContent = label;
    b.onclick = () => onPick(v);
    b.onkeydown = (e) => {
      const i = options.findIndex(([x]) => x === v);
      const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? options[(i + 1) % options.length]
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? options[(i - 1 + options.length) % options.length] : null;
      if (next) { e.preventDefault(); onPick(next[0]); setTimeout(() => el.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()); }
    };
    el.appendChild(b);
  }
}

function toggleChip(label: string, pressed: boolean, onClick: () => void, color?: string): HTMLButtonElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip' + (pressed ? ' active' : '');
  chip.setAttribute('aria-pressed', String(pressed));
  chip.textContent = label;
  if (pressed && color) {
    chip.style.background = platformTint(color);
    chip.style.borderColor = platformColor(color);
    chip.style.color = 'var(--ink)';
  }
  chip.onclick = onClick;
  return chip;
}

function renderSheet(): void {
  const f = view.filters;
  byId('scopeGroup').hidden = view.mode !== 'folder';
  segmented(byId('scopeSeg'), [['folder', 'This folder'], ['all', 'All folders']], f.scope, (scope) => update({ scope }));
  segmented<StatusFilter>(byId('statusSeg'), [['any', 'Any'], ['unread', 'Unread'], ['done', 'Done']], f.status, (status) => update({ status }));
  byId<HTMLSelectElement>('sortSelect').value = f.sort;
  byId<HTMLInputElement>('dateStart').value = f.dateStart;
  byId<HTMLInputElement>('dateEnd').value = f.dateEnd;

  const pc = byId('platformChips');
  pc.replaceChildren(...PLATFORMS.map((p) => toggleChip(p, f.platform === p, () => update({ platform: f.platform === p ? null : p }), p)));

  const tags = allTags(store.liveLinks());
  byId('tagGroup').hidden = tags.length === 0;
  byId('tagChips').replaceChildren(...tags.slice(0, 40).map((t) => toggleChip('#' + t, f.tags.includes(t),
    () => update({ tags: f.tags.includes(t) ? f.tags.filter((x) => x !== t) : [...f.tags, t] }))));

  const n = countFn();
  byId('filtersResultCount').textContent = n + ' ' + (n === 1 ? 'result' : 'results');
}

export function openFiltersSheet(): void {
  renderSheet();
  openModal(byId('filtersSheet'));
}

/** Dismissible chips under the search field + the badge on the filter button. */
export function renderActiveFilters(): void {
  const f = view.filters;
  const row = byId('activeFilters');
  row.replaceChildren();
  const chip = (label: string, clear: Partial<ListFilters>) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip active-filter';
    b.setAttribute('aria-label', 'Remove filter: ' + label);
    b.append(document.createTextNode(label), svgIcon('x'));
    b.onclick = () => { view.filters = { ...view.filters, ...clear }; renderMain(); };
    row.appendChild(b);
  };
  if (view.mode === 'folder' && f.scope === 'all') chip('All folders', { scope: 'folder' });
  if (f.status !== 'any') chip(f.status === 'done' ? 'Done' : 'Unread', { status: 'any' });
  if (f.platform) chip(f.platform, { platform: null });
  for (const t of f.tags) chip('#' + t, { tags: f.tags.filter((x) => x !== t) });
  if (f.dateStart || f.dateEnd) chip((f.dateStart || '…') + ' – ' + (f.dateEnd || '…'), { dateStart: '', dateEnd: '' });
  if (f.sort !== 'newest') chip(SORT_LABELS[f.sort], { sort: 'newest' });
  row.hidden = row.children.length === 0;

  const n = activeFilterCount(f) - (view.mode !== 'folder' && f.scope === 'all' ? 1 : 0);
  const badge = byId('filterBadge');
  badge.hidden = n === 0;
  badge.textContent = String(n);
  byId('filterBtn').setAttribute('aria-label', n ? 'Filters, ' + n + ' active' : 'Filters');
}

export function initFiltersSheet(): void {
  byId('filterBtn').onclick = openFiltersSheet;
  byId('filtersDoneBtn').onclick = () => closeModal(byId('filtersSheet'));
  byId('filtersResetBtn').onclick = () => update({ ...DEFAULT_FILTERS });
  byId<HTMLSelectElement>('sortSelect').addEventListener('change', (e) => update({ sort: (e.target as HTMLSelectElement).value as SortMode }));
  byId<HTMLInputElement>('dateStart').addEventListener('change', (e) => update({ dateStart: (e.target as HTMLInputElement).value }));
  byId<HTMLInputElement>('dateEnd').addEventListener('change', (e) => update({ dateEnd: (e.target as HTMLInputElement).value }));
}
