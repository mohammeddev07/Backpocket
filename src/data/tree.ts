import type { Folder } from './types';

// Pure folder-tree helpers over the live (non-deleted) folder list.

export function sortSiblings(a: Folder, b: Folder): number {
  return a.position - b.position || a.createdAt - b.createdAt || a.name.localeCompare(b.name);
}

export function childrenOf(folders: readonly Folder[], parentId: string | null): Folder[] {
  return folders.filter((f) => f.parentId === parentId).sort(sortSiblings);
}

export function pathOf(folders: readonly Folder[], id: string | null): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: Folder[] = [];
  const seen = new Set<string>();
  let f = id ? byId.get(id) : undefined;
  while (f && !seen.has(f.id)) {
    seen.add(f.id);
    path.unshift(f);
    f = f.parentId ? byId.get(f.parentId) : undefined;
  }
  return path;
}

export function pathLabel(folders: readonly Folder[], id: string | null, sep = ' › '): string {
  return pathOf(folders, id).map((f) => f.name).join(sep);
}

export function descendantIds(folders: readonly Folder[], id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const f of folders) {
      if (f.parentId === cur && !out.includes(f.id)) { out.push(f.id); stack.push(f.id); }
    }
  }
  return out;
}

export function isDescendantOf(folders: readonly Folder[], candidateId: string, ancestorId: string): boolean {
  return descendantIds(folders, ancestorId).includes(candidateId);
}

/** Depth-first flattening, for indented pickers. */
export function flattenTree(folders: readonly Folder[], parentId: string | null = null, depth = 0,
  out: Array<{ folder: Folder; depth: number }> = []): Array<{ folder: Folder; depth: number }> {
  for (const f of childrenOf(folders, parentId)) {
    out.push({ folder: f, depth });
    flattenTree(folders, f.id, depth + 1, out);
  }
  return out;
}
