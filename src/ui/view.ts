import { DEFAULT_FILTERS, type ListFilters, type ViewMode } from '../search/filters';

// UI view state (what's selected/filtered) - separate from stored data.

export const view = {
  /** 'all' = All saves, 'folder' = one folder (the Inbox is a folder), 'revisit'. */
  mode: 'all' as ViewMode,
  folderId: '',
  expanded: new Set<string>(),
  query: '',
  filters: { ...DEFAULT_FILTERS } as ListFilters,
  shuffleSeed: 0,
  selectMode: false,
  selectedIds: new Set<string>(),
  saveTargetId: '',
  /** Link rows in the last render, so re-renders only animate new ones. */
  shownLinkIds: new Set<string>(),
  /** A modal/inline edit is open that a background re-render would disturb. */
  editing: false,
};

/** Clears search and filters (sort is kept, like v1 kept it across folders). */
export function clearFilters(): void {
  view.query = '';
  view.filters = { ...DEFAULT_FILTERS, sort: view.filters.sort };
}

type Renderer = () => void;
const renderers: Record<'nav' | 'main' | 'saveTarget', Renderer> = {
  nav: () => {}, main: () => {}, saveTarget: () => {},
};
export function setRenderer(name: keyof typeof renderers, fn: Renderer): void { renderers[name] = fn; }
export function renderTree(): void { renderers.nav(); }
export function renderMain(): void { renderers.main(); }
export function renderAll(): void { renderers.nav(); renderers.main(); renderers.saveTarget(); }

let scheduled = false;
/** Batches re-renders triggered by store changes into one per microtask. */
export function scheduleRender(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    if (view.editing) { renderers.nav(); return; }
    renderAll();
  });
}

let navigateHook: () => void = () => {};
export function onNavigate(fn: () => void): void { navigateHook = fn; }

/** Switch view: All saves, a folder, or Revisit. Resets search and filters. */
export function go(mode: ViewMode, folderId = ''): void {
  view.mode = mode;
  if (mode === 'folder') view.folderId = folderId;
  view.shuffleSeed = 0;
  view.selectMode = false;
  view.selectedIds.clear();
  clearFilters();
  navigateHook();
  renderAll();
}
