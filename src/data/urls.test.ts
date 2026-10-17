import { describe, expect, it } from 'vitest';
import { isWebUrl, normalizeUrlInput } from './urls';

describe('isWebUrl', () => {
  it('accepts http and https only', () => {
    expect(isWebUrl('https://example.com/a')).toBe(true);
    expect(isWebUrl('http://example.com')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'JavaScript://x.com/%0Aalert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'not a url', '']) {
      expect(isWebUrl(bad)).toBe(false);
    }
  });
});

describe('normalizeUrlInput', () => {
  it('adds https to bare domains', () => {
    expect(normalizeUrlInput('example.com/a').url).toBe('https://example.com/a');
  });

  it('refuses script and other non-web links, even dressed up with //host', () => {
    expect(normalizeUrlInput('javascript://evil.com/%0Aalert(document.domain)').error).toMatch(/web links/);
    expect(normalizeUrlInput('ftp://files.example.com/x').error).toMatch(/web links/);
  });
});
