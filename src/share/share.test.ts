import { describe, expect, it } from 'vitest';
import {
  consumeSharePayload, firstSharedUrl, parseSharePayload, trimSharedUrl, usableSharedTitle,
} from './extractSharedUrl';
// @ts-expect-error - plain JS oracle copied from v1, no types
import { legacyApply, legacyFirst, legacyTrim } from './legacyShare.fixture.js';

const q = (p: Record<string, string>) => '?' + new URLSearchParams(p).toString();

describe('firstSharedUrl', () => {
  const cases: Array<[string, Array<string | null>, string | null]> = [
    ['bare url in url', ['https://www.instagram.com/reel/abc/', null, null], 'https://www.instagram.com/reel/abc/'],
    ['url inside a caption', [null, 'Check out this video https://vm.tiktok.com/ZMabc123/ #fyp', null], 'https://vm.tiktok.com/ZMabc123/'],
    ['vm.tiktok.com short link, bare', [null, 'https://vm.tiktok.com/ZMh7Q2x9/', null], 'https://vm.tiktok.com/ZMh7Q2x9/'],
    ['trailing period', [null, 'Read this: https://example.com/a.', null], 'https://example.com/a'],
    ['trailing !?', [null, 'wow https://example.com/post!?', null], 'https://example.com/post'],
    ['trailing ellipsis and curly quote', [null, '“see https://example.com/x…”', null], 'https://example.com/x'],
    ['wrapped in parens', [null, 'video (https://youtu.be/dQw4w9WgXcQ)', null], 'https://youtu.be/dQw4w9WgXcQ'],
    ['balanced parens kept', [null, 'https://en.wikipedia.org/wiki/Foo_(bar)', null], 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ['balanced parens kept then period', [null, 'see https://en.wikipedia.org/wiki/Foo_(bar).', null], 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ['unbalanced bracket dropped', [null, '[https://example.com/a]', null], 'https://example.com/a'],
    ['no url at all', [null, 'just some words', 'a title'], null],
    ['empty values', [null, '', ''], null],
    ['hostname without a dot is rejected', [null, 'http://localhost/x', null], null],
    ['skips invalid match and takes the next', [null, 'http://nodot and https://ok.example/p', null], 'https://ok.example/p'],
    ['ftp is ignored', [null, 'ftp://files.example.com/a', null], null],
    ['url param beats text', ['https://a.example/1', 'https://b.example/2', null], 'https://a.example/1'],
    ['text beats title', [null, 'https://b.example/2', 'https://c.example/3'], 'https://b.example/2'],
    ['falls back to title', [null, 'no link', 'Title https://c.example/3'], 'https://c.example/3'],
    ['angle brackets end the url', [null, '<https://example.com/a>', null], 'https://example.com/a'],
    ['youtube share with si param', [null, 'https://youtu.be/abc?si=XYZ', null], 'https://youtu.be/abc?si=XYZ'],
    ['uppercase scheme', [null, 'HTTPS://EXAMPLE.COM/Path', null], 'https://example.com/Path'],
  ];
  for (const [name, values, expected] of cases) {
    it(name, () => {
      expect(firstSharedUrl(values)).toBe(expected);
      expect(legacyFirst(values)).toBe(expected);
    });
  }
});

describe('trimSharedUrl matches v1', () => {
  const samples = [
    'https://x.com/a.', 'https://x.com/a)', 'https://x.com/(a)', 'https://x.com/a))', 'https://x.com/a…”',
    'https://x.com/a]', 'https://x.com/[a]', 'https://x.com/a}', 'https://x.com/a;:', "https://x.com/a'",
    'https://x.com/a»', 'https://x.com/', 'https://x.com/a?b=(c)', 'https://x.com/a?b=(c))',
  ];
  for (const s of samples) it(s, () => expect(trimSharedUrl(s)).toBe(legacyTrim(s)));
});

describe('parseSharePayload', () => {
  it('returns null for normal loads', () => {
    expect(parseSharePayload('')).toBeNull();
    expect(parseSharePayload('?foo=bar')).toBeNull();
  });

  it('strips only the share params and keeps others', () => {
    const p = parseSharePayload('?utm=1&text=' + encodeURIComponent('hi https://a.example/x') + '&keep=2');
    expect(p?.url).toBe('https://a.example/x');
    expect(p?.cleanedSearch).toBe('?utm=1&keep=2');
  });

  it('empty params still count as a share (shows the no-link error)', () => {
    const p = parseSharePayload('?text=');
    expect(p).not.toBeNull();
    expect(p?.url).toBeNull();
    expect(p?.cleanedSearch).toBe('');
  });

  it('agrees with v1 on url, note and remaining query', () => {
    const inputs = [
      q({ title: 'Cool reel', text: 'https://www.instagram.com/reel/C1/?igsh=abc' }),
      q({ title: 'https://youtu.be/x', text: 'https://youtu.be/x' }),
      q({ text: 'Watch (https://www.youtube.com/watch?v=1).' }),
      q({ url: 'not a url', text: 'nor this', title: 'Nope' }),
      q({ title: '  Spaced  ', url: 'https://example.com/a,' }),
      '?a=1&url=' + encodeURIComponent('https://example.com'),
    ];
    for (const s of inputs) {
      const legacy = legacyApply(s);
      const p = parseSharePayload(s)!;
      const note = p.url ? usableSharedTitle(p.title) : '';
      expect({ url: p.url, note, search: p.cleanedSearch }).toEqual(legacy);
    }
  });
});

describe('consumeSharePayload', () => {
  it('clears share params with history.replaceState, keeping path, other params and hash', () => {
    window.history.replaceState(null, '', '/Backpocket/index.html?text=' +
      encodeURIComponent('see https://vm.tiktok.com/ZM1/') + '&x=1#h');
    const p = consumeSharePayload(window);
    expect(p?.url).toBe('https://vm.tiktok.com/ZM1/');
    expect(window.location.pathname).toBe('/Backpocket/index.html');
    expect(window.location.search).toBe('?x=1');
    expect(window.location.hash).toBe('#h');
    expect(consumeSharePayload(window)).toBeNull();
  });
});
