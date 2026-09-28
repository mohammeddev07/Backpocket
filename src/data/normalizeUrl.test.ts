import { describe, expect, it } from 'vitest';
import { normalizeUrl } from './normalizeUrl';

describe('normalizeUrl', () => {
  const same: Array<[string, string]> = [
    ['https://www.instagram.com/reel/C1abc/?igsh=xyz123', 'https://instagram.com/reel/C1abc'],
    ['https://instagram.com/reel/C1abc/?utm_source=ig_web_copy_link&igshid=1', 'https://www.instagram.com/reel/C1abc/'],
    ['https://youtu.be/dQw4w9WgXcQ?si=AbCdEf', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share', 'https://youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://youtube.com/shorts/dQw4w9WgXcQ?si=1', 'https://youtu.be/dQw4w9WgXcQ'],
    ['https://www.tiktok.com/@user/video/123?is_from_webapp=1&sender_device=pc', 'https://tiktok.com/@user/video/123'],
    ['https://twitter.com/jack/status/20?s=20&t=abc', 'https://x.com/jack/status/20'],
    ['http://example.com/a/?utm_medium=x&b=2&a=1', 'https://example.com/a?a=1&b=2'],
    ['https://example.com/a#section', 'https://example.com/a'],
  ];
  for (const [a, b] of same) {
    it(`${a} == ${b}`, () => expect(normalizeUrl(a)).toBe(normalizeUrl(b)));
  }

  it('produces a readable canonical form', () => {
    expect(normalizeUrl('https://youtu.be/dQw4w9WgXcQ?si=x')).toBe('youtube.com/watch?v=dQw4w9WgXcQ');
    expect(normalizeUrl('https://www.instagram.com/reel/C1abc/?igsh=x')).toBe('instagram.com/reel/C1abc');
  });

  const different: Array<[string, string]> = [
    ['https://youtube.com/watch?v=aaa', 'https://youtube.com/watch?v=bbb'],
    ['https://example.com/search?q=cats', 'https://example.com/search?q=dogs'],
    ['https://vm.tiktok.com/ZM1/', 'https://vm.tiktok.com/ZM2/'],
  ];
  for (const [a, b] of different) {
    it(`${a} != ${b}`, () => expect(normalizeUrl(a)).not.toBe(normalizeUrl(b)));
  }

  it('keeps a YouTube playlist on watch URLs', () => {
    expect(normalizeUrl('https://www.youtube.com/watch?v=a&list=PL1&index=2')).toBe('youtube.com/watch?v=a&list=PL1');
  });

  it('falls back to a trimmed lowercase string for non-URLs', () => {
    expect(normalizeUrl('  Not A URL ')).toBe('not a url');
  });
});
