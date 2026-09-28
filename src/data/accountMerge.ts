import { INBOX_COLOR, INBOX_NAME } from './migrate';
import { normalizeUrl } from './normalizeUrl';
import { pathOf } from './tree';
import type { Folder, Link, Plan, Snapshot } from './types';

// First sign-in on a device that has guest data: fold it into the account.
//  * the local Inbox maps onto the account's Inbox (whose id is the user id)
//  * folders merge by path ("Job › Interview" matches case-insensitively)
//  * links already in the account (same normalized URL) are skipped
// Pure, so it's unit-tested; sync.ts does the uploading.

export interface MergeOutcome {
  /** New rows to upload to the account. */
  upload: Snapshot;
  /** What the local store should contain afterwards (account + uploads). */
  merged: Snapshot;
  addedLinks: number;
  skippedDuplicates: number;
}

const live = <T extends { deletedAt: number | null }>(rows: T[]) => rows.filter((r) => r.deletedAt == null);
const pathKey = (folders: Folder[], id: string) => pathOf(folders, id).map((f) => f.name.trim().toLowerCase()).join('\u0000');

export function mergeGuestIntoAccount(local: Snapshot, remote: Snapshot, userId: string, now = Date.now()): MergeOutcome {
  const upload: Snapshot = { folders: [], links: [], plans: [] };
  const remoteFolders = live(remote.folders);

  let inbox = remoteFolders.find((f) => f.isSystem);
  if (!inbox) {
    inbox = {
      id: userId, parentId: null, name: INBOX_NAME, color: INBOX_COLOR, isSystem: true,
      position: 0, createdAt: now, updatedAt: now, deletedAt: null,
    };
    upload.folders.push(inbox);
  }

  const localFolders = live(local.folders);
  const localInbox = localFolders.find((f) => f.isSystem);
  const folderMap = new Map<string, string>();
  if (localInbox) folderMap.set(localInbox.id, inbox.id);

  const remoteByPath = new Map(remoteFolders.filter((f) => !f.isSystem).map((f) => [pathKey(remoteFolders, f.id), f.id]));
  // Parents before children, so a child's parent is already mapped.
  const ordered = localFolders.filter((f) => !f.isSystem)
    .sort((a, b) => pathOf(localFolders, a.id).length - pathOf(localFolders, b.id).length);
  const takenIds = new Set(remote.folders.map((f) => f.id));
  for (const f of ordered) {
    const key = pathKey(localFolders, f.id);
    const existing = remoteByPath.get(key);
    if (existing) { folderMap.set(f.id, existing); continue; }
    const id = takenIds.has(f.id) ? crypto.randomUUID() : f.id;
    const parentId = f.parentId ? (folderMap.get(f.parentId) ?? null) : null;
    folderMap.set(f.id, id);
    remoteByPath.set(key, id);
    upload.folders.push({ ...f, id, parentId: parentId === inbox.id ? null : parentId, isSystem: false, updatedAt: now });
  }

  const remoteByUrl = new Map(live(remote.links).map((l) => [normalizeUrl(l.url), l.id]));
  const takenLinkIds = new Set(remote.links.map((l) => l.id));
  const linkMap = new Map<string, string>();
  let skippedDuplicates = 0;
  for (const l of live(local.links)) {
    const key = normalizeUrl(l.url);
    const existing = remoteByUrl.get(key);
    if (existing) { skippedDuplicates++; linkMap.set(l.id, existing); continue; }
    const id = takenLinkIds.has(l.id) ? crypto.randomUUID() : l.id;
    linkMap.set(l.id, id);
    remoteByUrl.set(key, id);
    const nl: Link = { ...l, id, folderId: folderMap.get(l.folderId) ?? inbox.id, updatedAt: now };
    upload.links.push(nl);
  }

  const takenPlanIds = new Set(remote.plans.map((p) => p.id));
  for (const p of live(local.plans)) {
    const folderId = folderMap.get(p.folderId);
    if (!folderId) continue;
    const np: Plan = {
      ...p, id: takenPlanIds.has(p.id) ? crypto.randomUUID() : p.id, folderId, updatedAt: now,
      items: p.items.map((it) => ({ ...it, linkIds: it.linkIds.map((x) => linkMap.get(x) ?? x) })),
    };
    upload.plans.push(np);
  }

  return {
    upload,
    merged: {
      folders: [...remote.folders, ...upload.folders],
      links: [...remote.links, ...upload.links],
      plans: [...remote.plans, ...upload.plans],
    },
    addedLinks: upload.links.length,
    skippedDuplicates,
  };
}

/** Does this device hold anything worth offering to upload? */
export function hasGuestData(s: Snapshot): boolean {
  return live(s.links).length > 0 || live(s.folders).some((f) => !f.isSystem) || live(s.plans).length > 0;
}

export function countLive(s: Snapshot): number {
  return live(s.links).length;
}
