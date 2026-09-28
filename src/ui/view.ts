// UI view state (what's selected/filtered) - separate from stored data.

export type SortMode = 'newest' | 'oldest' | 'platform';

export const view = {
  currentFolderId: 'root',
  expanded: new Set<string>(['root']),
  sortMode: 'newest' as SortMode,
  searchQuery: '',
  dateStart: '',
  dateEnd: '',
  selectMode: false,
  selectedIds: new Set<string>(),
  searchEverywhere: false,
  platformFilter: null as string | null,
  saveTargetFolderId: 'root',
  /** Link rows in the last render, so re-renders only animate new ones. */
  shownLinkIds: new Set<string>(),
  /** An inline title edit is open - defer background re-renders. */
  editing: false,
};

export function clearFilters(): void {
  view.searchQuery = '';
  view.dateStart = '';
  view.dateEnd = '';
  view.platformFilter = null;
}

type Renderer = () => void;
const renderers: Record<'tree' | 'main' | 'saveTarget', Renderer> = {
  tree: () => {}, main: () => {}, saveTarget: () => {},
};
export function setRenderer(name: keyof typeof renderers, fn: Renderer): void { renderers[name] = fn; }
export function renderTree(): void { renderers.tree(); }
export function renderMain(): void { renderers.main(); }
export function renderAll(): void { renderers.tree(); renderers.main(); renderers.saveTarget(); }

let scheduled = false;
/** Batches re-renders triggered by store changes into one per microtask. */
export function scheduleRender(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    if (view.editing) { renderers.tree(); return; }
    renderAll();
  });
}
