import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toasts: string[] = [];
vi.mock('../ui/toast', () => ({ showToast: (msg: string) => toasts.push(msg) }));
vi.mock('../ui/folderPicker', () => ({ pickFolder: async () => undefined }));
vi.mock('../ui/list', () => ({ addCardDecorator: () => {} }));
vi.mock('../ui/saveBox', () => ({ onLinkSaved: () => {} }));
vi.mock('./notice', () => ({ showAiNoticeOnce: () => {} }));
vi.mock('./access', () => ({ aiMode: () => 'server', aiReady: () => true }));
vi.mock('./client', () => ({ aiCall: async () => ({}), aiErrorMessage: () => '', AiError: class extends Error {} }));

const { store } = await import('../data/store');
const { openLocalDb } = await import('../data/localStore');
const { freshInboxSnapshot } = await import('../data/migrate');
const { createFolder, createLink } = await import('../actions');
const { applyResult } = await import('./sortOnSave');

const INBOX = 'inbox-id';
const out = (p: Record<string, unknown> = {}) => ({
  folder_id: null, new_folder_path: null, title: 'AI title', tags: ['ai'], confidence: 0.9, reason: 'fits', ...p,
});

let dbn = 0;
beforeEach(async () => {
  toasts.length = 0;
  await store.init(await openLocalDb('sort-' + ++dbn));
  await store.replaceAll(freshInboxSnapshot(1, INBOX));
});

describe('sort on save', () => {
  it('auto-moves when confident and the folder exists, with an Undo toast', () => {
    const job = createFolder('Job', '#fff', null);
    const l = createLink({ url: 'https://x.example/1', folderId: INBOX });
    applyResult(l.id, out({ folder_id: job.id, confidence: 0.85 }) as never, 'm', false);
    expect(store.link(l.id)!.folderId).toBe(job.id);
    expect(store.link(l.id)!.aiMeta?.outcome).toBe('moved');
    expect(toasts[0]).toBe('Moved to Job');
  });

  it('only suggests below the confidence threshold (and for new folders)', () => {
    const job = createFolder('Job', '#fff', null);
    const a = createLink({ url: 'https://x.example/2', folderId: INBOX });
    applyResult(a.id, out({ folder_id: job.id, confidence: 0.6 }) as never, 'm', false);
    expect(store.link(a.id)!.folderId).toBe(INBOX);
    expect(store.link(a.id)!.aiMeta?.suggestion?.folderId).toBe(job.id);

    const b = createLink({ url: 'https://x.example/3', folderId: INBOX });
    applyResult(b.id, out({ new_folder_path: 'Recipes › Breakfast', confidence: 0.95 }) as never, 'm', false);
    expect(store.link(b.id)!.folderId).toBe(INBOX);
    expect(store.link(b.id)!.aiMeta?.suggestion?.newFolderPath).toBe('Recipes › Breakfast');
    expect(store.liveFolders().some((f) => f.name === 'Recipes')).toBe(false); // created only on accept
  });

  it('never moves a link the user filed themselves', () => {
    const job = createFolder('Job', '#fff', null);
    const fun = createFolder('Fun', '#fff', null);
    const l = createLink({ url: 'https://x.example/4', folderId: fun.id });
    applyResult(l.id, out({ folder_id: job.id, confidence: 0.99 }) as never, 'm', true);
    expect(store.link(l.id)!.folderId).toBe(fun.id);
    expect(store.link(l.id)!.aiMeta?.outcome).toBe('kept');
  });

  it('never moves a link the user already moved while AI was thinking', () => {
    const job = createFolder('Job', '#fff', null);
    const fun = createFolder('Fun', '#fff', null);
    const l = createLink({ url: 'https://x.example/5', folderId: INBOX });
    store.patch('links', l.id, { folderId: fun.id });
    applyResult(l.id, out({ folder_id: job.id, confidence: 0.99 }) as never, 'm', false);
    expect(store.link(l.id)!.folderId).toBe(fun.id);
  });

  it('fills an empty title/tags but never overwrites what the user typed', () => {
    const typed = createLink({ url: 'https://x.example/6', folderId: INBOX, title: 'Mine', tags: ['me'] });
    applyResult(typed.id, out() as never, 'm', false);
    expect(store.link(typed.id)).toMatchObject({ title: 'Mine', titleSource: 'user', tags: ['me'] });

    const empty = createLink({ url: 'https://x.example/7', folderId: INBOX });
    applyResult(empty.id, out() as never, 'm', false);
    expect(store.link(empty.id)).toMatchObject({ title: 'AI title', titleSource: 'ai', tags: ['ai'] });
  });

  it('ignores a suggestion that points at the Inbox itself', () => {
    const l = createLink({ url: 'https://x.example/8', folderId: INBOX });
    applyResult(l.id, out({ folder_id: INBOX, confidence: 0.99 }) as never, 'm', false);
    expect(store.link(l.id)!.folderId).toBe(INBOX);
    expect(store.link(l.id)!.aiMeta?.outcome).toBe('kept');
  });
});
