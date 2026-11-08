import { describe, expect, it } from 'vitest';
import { faviconUrl } from './platform';

describe('faviconUrl', () => {
  it('sends only the hostname, never the path or query', () => {
    const u = faviconUrl('https://www.example.com/private/page?token=abc#x', 'duckduckgo');
    expect(u).toBe('https://icons.duckduckgo.com/ip3/www.example.com.ico');
    expect(faviconUrl('https://news.site.org/a/b?c=d', 'google')).toBe('https://www.google.com/s2/favicons?sz=64&domain=news.site.org');
    expect(faviconUrl('http://Blog.Example.COM./post', 'iconhorse')).toBe('https://icon.horse/icon/blog.example.com');
  });

  it('skips addresses with no public site to look up', () => {
    for (const url of ['http://localhost:3000/x', 'http://192.168.1.4/admin', 'http://[::1]/', 'http://intranet/page', 'ftp://example.com/f', 'not a url']) {
      expect(faviconUrl(url, 'duckduckgo')).toBeNull();
    }
  });
});
