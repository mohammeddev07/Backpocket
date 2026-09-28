// Local (IndexedDB) shapes. Field names mirror the Supabase tables in
// supabase/migrations (camelCase here, snake_case there - see supabaseStore.ts).
// Timestamps are ms since epoch; the server stores timestamptz.

export type Ms = number;

export type PlatformLabel = 'Instagram' | 'YouTube' | 'Facebook' | 'TikTok' | 'X' | 'Link';

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  color: string;
  /** The Inbox: holds links saved without a folder, can't be deleted. */
  isSystem: boolean;
  /** Order among siblings (ascending). */
  position: number;
  createdAt: Ms;
  updatedAt: Ms;
  deletedAt: Ms | null;
}

export type LinkStatus = 'unread' | 'done';

export interface AiMeta {
  source: 'server' | 'byok';
  model: string;
  at: Ms;
  output: unknown;
  /** What happened with the suggestion: moved, suggested, accepted, rejected, skipped. */
  outcome?: string;
  suggestion?: { folderId: string | null; newFolderPath: string | null; reason: string; confidence: number } | null;
}

export interface Link {
  id: string;
  folderId: string;
  url: string;
  platform: PlatformLabel;
  /** Display title. v1's "note" (shown as the card title) migrates here. */
  title: string | null;
  note: string | null;
  /** Caption/text the sharing app sent along with the link. */
  sharedText: string | null;
  thumbnailUrl: string | null;
  tags: string[];
  status: LinkStatus;
  openedAt: Ms | null;
  aiMeta: AiMeta | null;
  createdAt: Ms;
  updatedAt: Ms;
  deletedAt: Ms | null;
}

export interface PlanItem {
  id: string;
  text: string;
  done: boolean;
  linkIds: string[];
}

export interface Plan {
  id: string;
  folderId: string;
  title: string;
  summary: string;
  items: PlanItem[];
  model: string;
  createdAt: Ms;
  updatedAt: Ms;
  deletedAt: Ms | null;
}

export type Kind = 'folders' | 'links' | 'plans';
export interface RowByKind { folders: Folder; links: Link; plans: Plan }
export type AnyRow = Folder | Link | Plan;

export interface Snapshot {
  folders: Folder[];
  links: Link[];
  plans: Plan[];
}

export interface Settings {
  theme: 'light' | 'dark' | null;
  localIconsOnly: boolean;
  /** AI features on/off (only matters when the user has AI access). */
  aiEnabled: boolean;
  aiNoticeSeen: boolean;
  iosHelpShown: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: null,
  localIconsOnly: false,
  aiEnabled: true,
  aiNoticeSeen: false,
  iosHelpShown: false,
};
