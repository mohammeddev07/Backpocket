import { describe, expect, it } from 'vitest';
import { parseBackupJson, parseBookmarksHtml } from './backup';

describe('imports keep web links only', () => {
  it('JSON backup drops javascript: links and counts them', () => {
    const r = parseBackupJson(JSON.stringify({
      schemaVersion: 2,
      folders: [{ id: 'f', name: 'Inbox', isSystem: true }],
      links: [{ id: 'ok', url: 'https://example.com', folderId: 'f' }, { id: 'bad', url: 'javascript:alert(1)', folderId: 'f' }],
    }));
    if (!('bundle' in r)) throw new Error(r.error);
    expect(r.bundle.links.map((l) => l.url)).toEqual(['https://example.com']);
    expect(r.bundle.skippedUnsafe).toBe(1);
  });

  it('bookmarks HTML skips bookmarklets', () => {
    const b = parseBookmarksHtml('<DL><DT><A HREF="https://example.com">Site</A><DT><A HREF="javascript:void(0)">Bookmarklet</A></DL>');
    expect(b.links.map((l) => l.url)).toEqual(['https://example.com']);
    expect(b.skippedUnsafe).toBe(1);
  });
});
